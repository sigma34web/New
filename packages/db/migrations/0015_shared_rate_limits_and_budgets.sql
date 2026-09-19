-- 0015_shared_rate_limits_and_budgets.sql — make rate limiting and budget enforcement
-- multi-instance-safe by moving both from process memory into Postgres.
--
-- WHY. Two controls that the system presents as protections are, at 0014, per-process only, and both say
-- so in their own source:
--
--   1. `apps/api/src/rate-limit.ts` is an in-memory sliding window: "LIMITS ARE PER-PROCESS AND SAID TO
--      BE. … N instances permit roughly N× the configured rate." Honest, and not a limiter once the API
--      runs more than once. Worse, it constrains nothing at all on the PROVIDER side: the thing worth
--      limiting is paid model traffic, and the gateway has no limiter in front of it.
--   2. `MemoryBudget` in `packages/gateway/src/gateway.ts` is the only `BudgetLedger` implementation. It
--      keeps spend in a `Map`, so it resets on restart and two workers each believe they own the whole
--      budget. A hard limit that two processes can each spend in full is not a hard limit.
--
-- Both are fixed the same way, and for the same reason the lease in 0008 lives in the database: a
-- guarantee two processes must share has to be enforced where they both look, by a constraint rather than
-- by an application check between a read and a write.
--
-- DESIGN NOTES that are load-bearing rather than incidental:
--
--   * FIXED WINDOWS, NOT A ROLLING LOG. A row per (scope, window start) counts admissions in that window.
--     This is O(1) per decision and needs no cleanup pass to stay correct, where a request log would grow
--     without bound and need pruning to be affordable. The cost is the usual fixed-window burst at a
--     boundary, which is why `burst` is explicit and separately configurable instead of pretending the
--     window is smooth.
--   * CONCURRENCY SLOTS ARE LEASES, NOT COUNTERS. A crashed worker must not hold a slot forever, so a
--     slot is a row with a deadline the holder renews, exactly like 0008's target lease. An abandoned slot
--     expires and is reclaimed; it is never decremented by a process that may already be dead.
--   * TIME IS A PARAMETER. Every function takes `p_now` so tests can drive window rollover and expiry
--     deterministically instead of sleeping. Callers in production pass `now()`.
--   * IDEMPOTENCY BY REQUEST ID. A retried activity delivery must not consume a second admission or a
--     second slot, so admission and slot acquisition are keyed by the caller's request id and re-answer
--     the original decision.
--   * RESERVATIONS EXPIRE. A budget reservation is not a permanent debit: a worker that dies between
--     reserving and settling would otherwise strand the money forever. A reservation has a deadline,
--     after which it no longer counts against the budget, and settling it is idempotent.
--   * INTEGER MILLICENTS. Money is `bigint` millicents (ADR: `COST_SCALE = 1000`), never floating point.
--   * UNKNOWN IS NOT ZERO. Settlement records `cost_known`; an unknown final cost keeps the reservation's
--     estimate as the amount and marks the row unknown, so a cancelled call whose billing is genuinely
--     unknown can never be silently settled at zero. This is the same rule 0012/0013 enforce for
--     `llm_calls`, applied to the budget ledger.
--
-- ROLLBACK. Forward-only (data architecture §15). Reverting means a new migration that drops these
-- tables; they hold only ephemeral coordination and reservation state, never canon, so dropping them
-- loses no history. Existing migrations are untouched.

-- ---------------------------------------------------------------------------------------------------------
-- 1. rate limit policies and fixed-window counters
-- ---------------------------------------------------------------------------------------------------------

-- A policy is addressed by a scope tuple. NULL means "any", so one policy can cover a provider across all
-- workspaces while a more specific policy covers one workspace's use of one model.
CREATE TABLE rate_limit_policies (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  -- NULL workspace_id = a global (provider-wide) policy. Workspace-scoped rows are RLS-visible only to
  -- their workspace; global rows are readable by everyone, which is why this table is read-only to the
  -- application role and written by migrations/operators.
  workspace_id uuid REFERENCES workspaces(id),
  provider text,
  model_id text,
  -- What kind of work is being limited. 'provider_call' is the paid one that matters most.
  operation_class text NOT NULL CHECK (operation_class IN
    ('provider_call', 'embedding_call', 'job_start', 'api_read', 'api_mutation')),
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  -- Requests per window. NULL = not limited on this axis.
  max_requests integer CHECK (max_requests IS NULL OR max_requests >= 0),
  -- Estimated tokens per window, so a few enormous calls cannot slip through a request-count limit.
  max_tokens bigint CHECK (max_tokens IS NULL OR max_tokens >= 0),
  -- Simultaneous in-flight calls. NULL = not limited on this axis.
  max_concurrent integer CHECK (max_concurrent IS NULL OR max_concurrent >= 0),
  -- Extra admissions allowed above max_requests within one window, spent before the window resets.
  burst_requests integer NOT NULL DEFAULT 0 CHECK (burst_requests >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- At most one policy per exact scope tuple. NULLS NOT DISTINCT so two "any provider" rows collide
  -- rather than silently both applying.
  UNIQUE NULLS NOT DISTINCT (workspace_id, provider, model_id, operation_class)
);

CREATE INDEX rate_limit_policies_lookup_idx
  ON rate_limit_policies (operation_class, provider, model_id) WHERE enabled;

-- One row per (policy, scope key, window start). `scope_key` is the resolved identity the limit applies
-- to, so a workspace-scoped policy counts per workspace rather than globally.
CREATE TABLE rate_limit_windows (
  policy_id uuid NOT NULL REFERENCES rate_limit_policies(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  window_start timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  tokens bigint NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  -- Observability, not control: how many admissions were refused in this window.
  rejected integer NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  PRIMARY KEY (policy_id, scope_key, window_start)
);

CREATE INDEX rate_limit_windows_start_idx ON rate_limit_windows (window_start);

-- Admission decisions, keyed by the caller's request id so a retry re-reads its own answer instead of
-- consuming a second admission.
CREATE TABLE rate_limit_admissions (
  policy_id uuid NOT NULL REFERENCES rate_limit_policies(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  request_id text NOT NULL,
  window_start timestamptz NOT NULL,
  admitted boolean NOT NULL,
  tokens bigint NOT NULL DEFAULT 0,
  decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, scope_key, request_id)
);

-- Concurrency slots as expiring leases. A dead holder's slot is reclaimed by deadline, never by a
-- decrement from a process that may no longer exist.
CREATE TABLE rate_limit_slots (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  policy_id uuid NOT NULL REFERENCES rate_limit_policies(id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  -- The caller's request id: acquiring twice with the same id returns the same slot (idempotent), and
  -- releasing twice is a no-op.
  request_id text NOT NULL,
  holder text NOT NULL,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  CONSTRAINT rate_limit_slots_deadline CHECK (expires_at > acquired_at)
);

-- One live slot per (policy, scope, request): the uniqueness is what makes acquisition idempotent under
-- concurrency rather than dependent on a read-then-write.
CREATE UNIQUE INDEX rate_limit_slots_live_request_uniq
  ON rate_limit_slots (policy_id, scope_key, request_id) WHERE released_at IS NULL;
CREATE INDEX rate_limit_slots_live_idx
  ON rate_limit_slots (policy_id, scope_key) WHERE released_at IS NULL;
CREATE INDEX rate_limit_slots_expiry_idx ON rate_limit_slots (expires_at) WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------------------------------------
-- 2. shared budgets and reservations
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE budget_policies (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  -- What the limit is attached to. 'job' budgets are created per run; 'workspace' spans everything.
  scope_kind text NOT NULL CHECK (scope_kind IN ('workspace', 'project', 'job', 'provider_model')),
  -- The scope's identity as text: a uuid for workspace/project/job, 'provider:model' for the last.
  scope_id text NOT NULL,
  -- Money is integer millicents, never floating point.
  hard_limit_millicents bigint NOT NULL CHECK (hard_limit_millicents >= 0),
  -- Optional advisory threshold for alerting; enforcement uses the hard limit only.
  soft_limit_millicents bigint CHECK (soft_limit_millicents IS NULL OR soft_limit_millicents >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_kind, scope_id),
  CONSTRAINT budget_soft_below_hard
    CHECK (soft_limit_millicents IS NULL OR soft_limit_millicents <= hard_limit_millicents)
);

CREATE TABLE budget_reservations (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  policy_id uuid NOT NULL REFERENCES budget_policies(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  -- The caller's idempotency key. A retried activity re-reads its own reservation.
  request_id text NOT NULL,
  estimated_millicents bigint NOT NULL CHECK (estimated_millicents >= 0),
  -- Set at settlement. NULL while the reservation is outstanding.
  settled_millicents bigint CHECK (settled_millicents IS NULL OR settled_millicents >= 0),
  -- FALSE means "the provider did not tell us what this cost". The estimate stands as the amount and the
  -- row is marked unknown; zero is NOT an allowed substitute (same rule as llm_calls, migration 0012).
  cost_known boolean,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'released', 'expired')),
  reserved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  CONSTRAINT budget_reservations_deadline CHECK (expires_at > reserved_at),
  -- A settled row must say whether its cost is known, and an unsettled row must not claim to be settled.
  CONSTRAINT budget_settlement_complete CHECK (
    (state = 'settled' AND settled_millicents IS NOT NULL AND cost_known IS NOT NULL
       AND settled_at IS NOT NULL)
    OR (state <> 'settled' AND settled_millicents IS NULL AND cost_known IS NULL))
);

CREATE UNIQUE INDEX budget_reservations_request_uniq ON budget_reservations (policy_id, request_id);
CREATE INDEX budget_reservations_outstanding_idx
  ON budget_reservations (policy_id) WHERE state = 'reserved';
CREATE INDEX budget_reservations_expiry_idx
  ON budget_reservations (expires_at) WHERE state = 'reserved';

-- A settled reservation is accounting history: it must not be rewritten or deleted afterwards. The
-- trigger is the layer that binds raw SQL and the owner connection (ADR-0050 decision 3).
CREATE OR REPLACE FUNCTION canon.budget_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state = 'settled' THEN
      PERFORM canon.raise_code(
        'BUDGET_SETTLED_IMMUTABLE', 'a settled budget reservation is never deleted');
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.state = 'settled' THEN
    -- A false zero after the fact is exactly the defect migration 0012 exists to prevent.
    PERFORM canon.raise_code(
      'BUDGET_SETTLED_IMMUTABLE', 'a settled budget reservation is never rewritten');
  END IF;
  IF NEW.request_id <> OLD.request_id OR NEW.policy_id <> OLD.policy_id
     OR NEW.estimated_millicents <> OLD.estimated_millicents THEN
    PERFORM canon.raise_code(
      'BUDGET_RESERVATION_IMMUTABLE', 'policy, request id and estimate are fixed at reservation');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER budget_reservation_guard
  BEFORE UPDATE OR DELETE ON budget_reservations
  FOR EACH ROW EXECUTE FUNCTION canon.budget_reservation_guard();

-- ---------------------------------------------------------------------------------------------------------
-- 3. RLS (ADR-0050: a workspace-owned table enables and forces RLS, and grants its DML explicitly)
-- ---------------------------------------------------------------------------------------------------------

ALTER TABLE budget_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY budget_policies_workspace_isolation ON budget_policies
  USING (canon.workspace_visible(workspace_id)) WITH CHECK (canon.workspace_visible(workspace_id));

ALTER TABLE budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY budget_reservations_workspace_isolation ON budget_reservations
  USING (canon.workspace_visible(workspace_id)) WITH CHECK (canon.workspace_visible(workspace_id));

-- Rate-limit policies carry a NULLABLE workspace_id because a provider-wide limit belongs to no single
-- tenant. A global row must stay visible to every tenant (it constrains them all), while a
-- workspace-scoped row must not leak across tenants.
ALTER TABLE rate_limit_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_limit_policies_visibility ON rate_limit_policies
  USING (workspace_id IS NULL OR canon.workspace_visible(workspace_id))
  WITH CHECK (workspace_id IS NULL OR canon.workspace_visible(workspace_id));

-- The counter/admission/slot tables are keyed by policy and an opaque scope key rather than by workspace,
-- and they are written only through the trusted functions below. RLS is enabled with a policy that
-- chains to the policy row, so a tenant cannot read another tenant's counters for a workspace-scoped
-- policy while global counters stay readable.
ALTER TABLE rate_limit_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_limit_windows_visibility ON rate_limit_windows
  USING (EXISTS (SELECT 1 FROM rate_limit_policies p WHERE p.id = rate_limit_windows.policy_id))
  WITH CHECK (EXISTS (SELECT 1 FROM rate_limit_policies p WHERE p.id = rate_limit_windows.policy_id));

ALTER TABLE rate_limit_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_limit_admissions_visibility ON rate_limit_admissions
  USING (EXISTS (SELECT 1 FROM rate_limit_policies p WHERE p.id = rate_limit_admissions.policy_id))
  WITH CHECK (EXISTS (SELECT 1 FROM rate_limit_policies p WHERE p.id = rate_limit_admissions.policy_id));

ALTER TABLE rate_limit_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_slots FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_limit_slots_visibility ON rate_limit_slots
  USING (EXISTS (SELECT 1 FROM rate_limit_policies p WHERE p.id = rate_limit_slots.policy_id))
  WITH CHECK (EXISTS (SELECT 1 FROM rate_limit_policies p WHERE p.id = rate_limit_slots.policy_id));

-- ---------------------------------------------------------------------------------------------------------
-- 4. grants (ADR-0050: follow the mutation model; no blanket DML)
-- ---------------------------------------------------------------------------------------------------------

-- Policies are operator/migration state: the request path reads them to make a decision and never edits
-- them, so a compromised request connection cannot raise its own limit or its own budget.
GRANT SELECT ON rate_limit_policies TO yeonjae_app;
GRANT SELECT ON budget_policies TO yeonjae_app;

-- Counters and reservations are written by the application through the trusted functions below, which are
-- SECURITY INVOKER (ADR-0050 decision 4), so the role needs the DML those functions perform. DELETE is
-- granted nowhere: reclamation marks rows expired rather than removing accounting history.
GRANT SELECT, INSERT, UPDATE ON rate_limit_windows TO yeonjae_app;
GRANT SELECT, INSERT ON rate_limit_admissions TO yeonjae_app;
GRANT SELECT, INSERT, UPDATE ON rate_limit_slots TO yeonjae_app;
GRANT SELECT, INSERT, UPDATE ON budget_reservations TO yeonjae_app;

-- 0014 narrowed sequence defaults to USAGE; these tables use uuid_v7 defaults and need no sequence.

-- ---------------------------------------------------------------------------------------------------------
-- 5. rate limit admission
-- ---------------------------------------------------------------------------------------------------------

-- Resolve the most specific enabled policy for a call. Specificity order: workspace+model beats
-- workspace+provider beats workspace beats global, and a named provider/model beats "any".
CREATE OR REPLACE FUNCTION canon.resolve_rate_limit_policy(
  p_workspace_id uuid,
  p_provider text,
  p_model_id text,
  p_operation_class text
) RETURNS rate_limit_policies
LANGUAGE sql STABLE
AS $$
  SELECT * FROM rate_limit_policies p
   WHERE p.enabled
     AND p.operation_class = p_operation_class
     AND (p.workspace_id IS NULL OR p.workspace_id = p_workspace_id)
     AND (p.provider IS NULL OR p.provider = p_provider)
     AND (p.model_id IS NULL OR p.model_id = p_model_id)
   ORDER BY (p.workspace_id IS NOT NULL) DESC,
            (p.model_id IS NOT NULL) DESC,
            (p.provider IS NOT NULL) DESC,
            p.id
   LIMIT 1;
$$;

-- Try to admit one request. Returns the decision, the window it applied to, and how long to wait before
-- retrying when refused.
--
-- `p_now` is a parameter so tests drive window rollover and boundaries exactly rather than sleeping.
CREATE OR REPLACE FUNCTION canon.rate_limit_admit(
  p_policy_id uuid,
  p_scope_key text,
  p_request_id text,
  p_tokens bigint,
  p_now timestamptz
-- The OUT column is deliberately named `window_started_at` rather than `window_start`: a RETURNS TABLE
-- column shares the function's namespace with table columns, so naming it `window_start` makes every
-- reference to rate_limit_windows.window_start ambiguous inside the body.
) RETURNS TABLE (admitted boolean, retry_after_ms integer, window_started_at timestamptz, reason text)
LANGUAGE plpgsql
AS $$
DECLARE
  pol rate_limit_policies;
  w_start timestamptz;
  w rate_limit_windows;
  prior rate_limit_admissions;
  allowance integer;
  v_reason text := 'admitted';
  v_ok boolean := true;
BEGIN
  SELECT * INTO pol FROM rate_limit_policies WHERE id = p_policy_id;
  IF pol.id IS NULL THEN
    RAISE EXCEPTION 'RATE_LIMIT_POLICY_UNKNOWN: no policy %', p_policy_id
      USING HINT = 'RATE_LIMIT_POLICY_UNKNOWN';
  END IF;
  IF p_tokens < 0 THEN
    RAISE EXCEPTION 'RATE_LIMIT_TOKENS_INVALID: tokens must not be negative'
      USING HINT = 'RATE_LIMIT_TOKENS_INVALID';
  END IF;

  -- Idempotency first: a retried delivery must re-read its own decision, not consume another admission.
  SELECT * INTO prior FROM rate_limit_admissions
   WHERE policy_id = p_policy_id AND scope_key = p_scope_key AND request_id = p_request_id;
  IF prior.request_id IS NOT NULL THEN
    RETURN QUERY SELECT prior.admitted, 0, prior.window_start,
                        CASE WHEN prior.admitted THEN 'admitted_replay' ELSE 'rejected_replay' END;
    RETURN;
  END IF;

  -- Truncate to the window grid so every instance agrees on the boundary without coordinating.
  w_start := to_timestamp(
    floor(extract(epoch FROM p_now) / pol.window_seconds) * pol.window_seconds);

  -- INSERT ... ON CONFLICT DO UPDATE then lock: the row exists and is held for the rest of this
  -- transaction, so two instances deciding at once serialize on it rather than both reading a stale count.
  INSERT INTO rate_limit_windows (policy_id, scope_key, window_start)
  VALUES (p_policy_id, p_scope_key, w_start)
  ON CONFLICT (policy_id, scope_key, window_start) DO NOTHING;

  SELECT * INTO w FROM rate_limit_windows rw
   WHERE rw.policy_id = p_policy_id AND rw.scope_key = p_scope_key AND rw.window_start = w_start
   FOR UPDATE;

  allowance := coalesce(pol.max_requests, 2147483647);
  IF pol.max_requests IS NOT NULL THEN
    allowance := pol.max_requests + pol.burst_requests;
    IF w.requests + 1 > allowance THEN
      v_ok := false;
      v_reason := 'request_limit';
    END IF;
  END IF;

  IF v_ok AND pol.max_tokens IS NOT NULL AND w.tokens + p_tokens > pol.max_tokens THEN
    v_ok := false;
    v_reason := 'token_limit';
  END IF;

  IF v_ok THEN
    UPDATE rate_limit_windows rw
       SET requests = rw.requests + 1, tokens = rw.tokens + p_tokens
     WHERE rw.policy_id = p_policy_id AND rw.scope_key = p_scope_key AND rw.window_start = w_start;
  ELSE
    UPDATE rate_limit_windows rw SET rejected = rw.rejected + 1
     WHERE rw.policy_id = p_policy_id AND rw.scope_key = p_scope_key AND rw.window_start = w_start;
  END IF;

  INSERT INTO rate_limit_admissions
    (policy_id, scope_key, request_id, window_start, admitted, tokens, decided_at)
  VALUES (p_policy_id, p_scope_key, p_request_id, w_start, v_ok, p_tokens, p_now);

  RETURN QUERY SELECT
    v_ok,
    CASE WHEN v_ok THEN 0
         -- Wait exactly until the next window opens: no polling storm, no guessed backoff.
         ELSE greatest(0, ceil(extract(epoch FROM
                (w_start + make_interval(secs => pol.window_seconds)) - p_now) * 1000)::integer)
    END,
    w_start,
    v_reason;
END $$;

-- ---------------------------------------------------------------------------------------------------------
-- 6. concurrency slots
-- ---------------------------------------------------------------------------------------------------------

-- Acquire one in-flight slot, or return nothing when the policy's concurrency is exhausted. Expired slots
-- are reclaimed here rather than by a background sweeper, so correctness does not depend on a cron job.
CREATE OR REPLACE FUNCTION canon.rate_limit_acquire_slot(
  p_policy_id uuid,
  p_scope_key text,
  p_request_id text,
  p_holder text,
  p_ttl_seconds integer,
  p_now timestamptz
) RETURNS rate_limit_slots
LANGUAGE plpgsql
AS $$
DECLARE
  pol rate_limit_policies;
  existing rate_limit_slots;
  live integer;
  result rate_limit_slots;
BEGIN
  SELECT * INTO pol FROM rate_limit_policies WHERE id = p_policy_id;
  IF pol.id IS NULL THEN
    RAISE EXCEPTION 'RATE_LIMIT_POLICY_UNKNOWN: no policy %', p_policy_id
      USING HINT = 'RATE_LIMIT_POLICY_UNKNOWN';
  END IF;
  IF p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'RATE_LIMIT_TTL_INVALID: ttl must be positive'
      USING HINT = 'RATE_LIMIT_TTL_INVALID';
  END IF;

  -- Reclaim abandoned slots first: a worker killed mid-call must not hold capacity forever.
  UPDATE rate_limit_slots SET released_at = p_now
   WHERE policy_id = p_policy_id AND scope_key = p_scope_key
     AND released_at IS NULL AND expires_at <= p_now;

  -- Idempotent re-acquisition: the same request id gets its own slot back, with the deadline extended.
  SELECT * INTO existing FROM rate_limit_slots
   WHERE policy_id = p_policy_id AND scope_key = p_scope_key AND request_id = p_request_id
     AND released_at IS NULL
   FOR UPDATE;
  IF existing.id IS NOT NULL THEN
    UPDATE rate_limit_slots
       SET expires_at = p_now + make_interval(secs => p_ttl_seconds)
     WHERE id = existing.id
     RETURNING * INTO result;
    RETURN result;
  END IF;

  IF pol.max_concurrent IS NOT NULL THEN
    -- Lock the policy row so two acquirers cannot both count the same free capacity. This is the
    -- serialization point for the "two workers race for the final slot" case.
    PERFORM 1 FROM rate_limit_policies WHERE id = p_policy_id FOR SHARE;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_policy_id::text || '/' || p_scope_key, 0));
    SELECT count(*) INTO live FROM rate_limit_slots
     WHERE policy_id = p_policy_id AND scope_key = p_scope_key AND released_at IS NULL;
    IF live >= pol.max_concurrent THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO rate_limit_slots
    (policy_id, scope_key, request_id, holder, acquired_at, expires_at)
  VALUES (p_policy_id, p_scope_key, p_request_id, p_holder, p_now,
          p_now + make_interval(secs => p_ttl_seconds))
  RETURNING * INTO result;
  RETURN result;
END $$;

-- Release is idempotent and safe for a cancelled request: a cancellation path that runs twice, or runs
-- after the slot already expired, must not error and must not release someone else's slot.
CREATE OR REPLACE FUNCTION canon.rate_limit_release_slot(
  p_policy_id uuid,
  p_scope_key text,
  p_request_id text,
  p_now timestamptz
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE rate_limit_slots SET released_at = p_now
   WHERE policy_id = p_policy_id AND scope_key = p_scope_key AND request_id = p_request_id
     AND released_at IS NULL;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END $$;

-- ---------------------------------------------------------------------------------------------------------
-- 7. budget reservation and settlement
-- ---------------------------------------------------------------------------------------------------------

-- Outstanding + settled spend against a policy, excluding reservations whose deadline has passed.
CREATE OR REPLACE FUNCTION canon.budget_committed_millicents(
  p_policy_id uuid,
  p_now timestamptz
) RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(sum(
    CASE
      WHEN r.state = 'settled' THEN r.settled_millicents
      -- An outstanding reservation counts at its estimate until it settles or expires.
      WHEN r.state = 'reserved' AND r.expires_at > p_now THEN r.estimated_millicents
      ELSE 0
    END), 0)::bigint
  FROM budget_reservations r WHERE r.policy_id = p_policy_id;
$$;

-- Reserve estimated spend, or refuse when the hard limit cannot afford it.
--
-- Returns the reservation row on success and nothing on refusal, so the caller distinguishes the two
-- without parsing an error. Refusal is the "no spend after hard-budget exhaustion" guarantee.
CREATE OR REPLACE FUNCTION canon.budget_reserve(
  p_policy_id uuid,
  p_request_id text,
  p_estimated_millicents bigint,
  p_ttl_seconds integer,
  p_now timestamptz
) RETURNS budget_reservations
LANGUAGE plpgsql
AS $$
DECLARE
  pol budget_policies;
  existing budget_reservations;
  committed bigint;
  result budget_reservations;
BEGIN
  SELECT * INTO pol FROM budget_policies WHERE id = p_policy_id;
  IF pol.id IS NULL THEN
    RAISE EXCEPTION 'BUDGET_POLICY_UNKNOWN: no budget policy %', p_policy_id
      USING HINT = 'BUDGET_POLICY_UNKNOWN';
  END IF;
  IF p_estimated_millicents < 0 THEN
    RAISE EXCEPTION 'BUDGET_ESTIMATE_INVALID: estimate must not be negative'
      USING HINT = 'BUDGET_ESTIMATE_INVALID';
  END IF;
  IF p_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'BUDGET_TTL_INVALID: ttl must be positive' USING HINT = 'BUDGET_TTL_INVALID';
  END IF;

  -- Idempotency: a retried activity re-reads its own reservation instead of reserving twice.
  SELECT * INTO existing FROM budget_reservations
   WHERE policy_id = p_policy_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    RETURN existing;
  END IF;

  -- Serialize reservations against this policy. Without this, two workers both read the same committed
  -- total and both reserve, which is exactly how MemoryBudget let N processes each spend the full budget.
  PERFORM pg_advisory_xact_lock(hashtextextended('budget:' || p_policy_id::text, 0));

  -- Expire stale reservations so a dead worker's estimate does not strand budget permanently.
  UPDATE budget_reservations SET state = 'expired'
   WHERE policy_id = p_policy_id AND state = 'reserved' AND expires_at <= p_now;

  committed := canon.budget_committed_millicents(p_policy_id, p_now);
  IF NOT pol.enabled THEN
    RAISE EXCEPTION 'BUDGET_POLICY_DISABLED: budget policy % is disabled', p_policy_id
      USING HINT = 'BUDGET_POLICY_DISABLED';
  END IF;
  IF committed + p_estimated_millicents > pol.hard_limit_millicents THEN
    -- Refused: the caller records `budget_blocked` and makes no provider call.
    RETURN NULL;
  END IF;

  INSERT INTO budget_reservations
    (policy_id, workspace_id, request_id, estimated_millicents, reserved_at, expires_at)
  VALUES (p_policy_id, pol.workspace_id, p_request_id, p_estimated_millicents, p_now,
          p_now + make_interval(secs => p_ttl_seconds))
  RETURNING * INTO result;
  RETURN result;
END $$;

-- Settle a reservation with the actual cost.
--
-- `p_cost_known = false` means the provider did not report usage. The reservation's ESTIMATE stands as the
-- amount and the row is marked unknown, because booking an unknown cost as zero is the false-zero defect
-- migration 0012 exists to prevent. Settlement is idempotent: the second call returns the first outcome
-- rather than double-settling.
CREATE OR REPLACE FUNCTION canon.budget_settle(
  p_policy_id uuid,
  p_request_id text,
  p_actual_millicents bigint,
  p_cost_known boolean,
  p_now timestamptz
) RETURNS budget_reservations
LANGUAGE plpgsql
AS $$
DECLARE
  existing budget_reservations;
  amount bigint;
  result budget_reservations;
BEGIN
  SELECT * INTO existing FROM budget_reservations
   WHERE policy_id = p_policy_id AND request_id = p_request_id
   FOR UPDATE;
  IF existing.id IS NULL THEN
    RAISE EXCEPTION 'BUDGET_RESERVATION_UNKNOWN: no reservation % on policy %',
      p_request_id, p_policy_id USING HINT = 'BUDGET_RESERVATION_UNKNOWN';
  END IF;

  -- Already settled: return the original settlement. Double settlement would double-charge.
  IF existing.state = 'settled' THEN
    RETURN existing;
  END IF;

  IF p_cost_known AND p_actual_millicents < 0 THEN
    RAISE EXCEPTION 'BUDGET_ACTUAL_INVALID: actual cost must not be negative'
      USING HINT = 'BUDGET_ACTUAL_INVALID';
  END IF;

  -- Unknown cost keeps the estimate. It is never replaced by zero.
  amount := CASE WHEN p_cost_known THEN p_actual_millicents ELSE existing.estimated_millicents END;

  UPDATE budget_reservations
     SET state = 'settled', settled_millicents = amount, cost_known = p_cost_known, settled_at = p_now
   WHERE id = existing.id
   RETURNING * INTO result;
  RETURN result;
END $$;

-- Release a reservation that never spent anything — a cancellation before the first attempt, or a call
-- refused by the Guard. Idempotent, and refuses to un-charge a settled row.
CREATE OR REPLACE FUNCTION canon.budget_release(
  p_policy_id uuid,
  p_request_id text,
  p_now timestamptz
) RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE budget_reservations SET state = 'released'
   WHERE policy_id = p_policy_id AND request_id = p_request_id AND state = 'reserved';
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated > 0;
END $$;

GRANT EXECUTE ON FUNCTION canon.resolve_rate_limit_policy(uuid, text, text, text) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.rate_limit_admit(uuid, text, text, bigint, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION
  canon.rate_limit_acquire_slot(uuid, text, text, text, integer, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.rate_limit_release_slot(uuid, text, text, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.budget_committed_millicents(uuid, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.budget_reserve(uuid, text, bigint, integer, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.budget_settle(uuid, text, bigint, boolean, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.budget_release(uuid, text, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.budget_reservation_guard() TO yeonjae_app;

-- ADR-0050 decision 5: EXECUTE is granted to named roles, never to PUBLIC. PostgreSQL grants PUBLIC
-- EXECUTE by default, so every function CREATEd above was born PUBLIC-executable and the explicit grants
-- sat on top of it — the exact defect 0014 repaired for the functions that existed then. 0014's
-- ALTER DEFAULT PRIVILEGES covers objects created by a NEW grantor/session default, not functions created
-- by this migration's owner in the same schema, so the revocation has to be repeated here. The
-- append-only-privileges and restore-drill suites both assert "no canon function is PUBLIC-executable",
-- which is what caught this.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA canon FROM PUBLIC;

COMMENT ON TABLE rate_limit_windows IS
  'Fixed-window rate-limit counters shared by every instance (migration 0015). Decisions are made by '
  'canon.rate_limit_admit, which locks the window row so concurrent instances serialize rather than both '
  'reading a stale count. Time is a parameter so tests drive boundaries deterministically.';
COMMENT ON TABLE rate_limit_slots IS
  'In-flight concurrency slots as expiring leases (migration 0015). A slot has a deadline so a worker '
  'killed mid-call cannot hold capacity forever; acquisition and release are idempotent by request id, so '
  'a cancelled request leaks no reservation and a duplicate release is a no-op.';
COMMENT ON TABLE budget_reservations IS
  'Shared budget reservations in integer millicents (migration 0015), replacing the per-process '
  'MemoryBudget so N workers cannot each spend the whole budget. Settlement is idempotent and records '
  'cost_known: an unknown final cost keeps the reservation estimate and is never booked as zero, the same '
  'rule migration 0012 enforces for llm_calls. A settled row is immutable by trigger and by grant.';
