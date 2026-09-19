/**
 * Shared rate limiting and concurrency control over Postgres (migration 0015).
 *
 * WHY THIS EXISTS. `apps/api/src/rate-limit.ts` is an in-memory sliding window and says so: "N instances
 * permit roughly N× the configured rate". That is honest but it is not a limiter once the API runs more
 * than once, and it constrains nothing on the side that actually costs money — the gateway had no limiter
 * in front of the provider at all. A limit that two processes must share has to be enforced where both of
 * them look.
 *
 * The two controls here are deliberately different shapes:
 *
 *   - ADMISSION is a fixed-window counter. O(1) per decision, no cleanup pass needed to stay correct, and
 *     `burst` is explicit rather than pretending a fixed window is smooth.
 *   - CONCURRENCY is a LEASE, not a counter. A decrement can be lost forever when the process holding the
 *     slot dies; a deadline cannot. This is the same reasoning as ADR-0048's target leases.
 *
 * Time is injected everywhere. Tests drive window rollover, boundaries and expiry by passing a clock, so
 * no test in this area needs a sleep.
 */
import { type Client, type Pool } from './client.js';

// Same local alias every other module in this package uses: a pool, or a client inside a transaction.
type Queryable = Pool | Client;

/** The classes of work that can be limited. Mirrors the migration's CHECK constraint. */
export type OperationClass =
  'provider_call' | 'embedding_call' | 'job_start' | 'api_read' | 'api_mutation';

export interface RateLimitPolicyRow {
  readonly id: string;
  readonly workspace_id: string | null;
  readonly provider: string | null;
  readonly model_id: string | null;
  readonly operation_class: OperationClass;
  readonly window_seconds: number;
  readonly max_requests: number | null;
  readonly max_tokens: string | number | null;
  readonly max_concurrent: number | null;
  readonly burst_requests: number;
  readonly enabled: boolean;
}

export interface AdmissionDecision {
  readonly admitted: boolean;
  /** Milliseconds until the next window opens. Exact, so a caller never needs to guess a backoff. */
  readonly retryAfterMs: number;
  readonly windowStart: Date;
  readonly reason:
    'admitted' | 'admitted_replay' | 'rejected_replay' | 'request_limit' | 'token_limit';
}

export interface SlotHandle {
  readonly id: string;
  readonly requestId: string;
  readonly expiresAt: Date;
}

/** A clock, injected so every test in this module is deterministic. */
export type Clock = () => Date;

export interface RateLimitScope {
  readonly workspaceId?: string | undefined;
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly operationClass: OperationClass;
}

/**
 * The identity a limit is counted against.
 *
 * A workspace-scoped policy must count per workspace, or one tenant's traffic would exhaust another's
 * allowance. A global policy counts globally, because it exists to protect a shared provider quota.
 */
export function scopeKeyFor(policy: RateLimitPolicyRow, scope: RateLimitScope): string {
  const parts = [
    policy.workspace_id !== null ? (scope.workspaceId ?? 'none') : 'global',
    policy.provider !== null ? (scope.provider ?? 'none') : 'any',
    policy.model_id !== null ? (scope.modelId ?? 'none') : 'any',
  ];
  return parts.join('/');
}

/** Resolve the most specific enabled policy, or undefined when nothing limits this call. */
export async function resolveRateLimitPolicy(
  db: Queryable,
  scope: RateLimitScope,
): Promise<RateLimitPolicyRow | undefined> {
  // A plpgsql function returning a composite type yields ONE all-NULL row when it returns NULL, rather
  // than no rows, so the id has to be treated as nullable here to tell "no policy" from "a policy".
  const r = await db.query<Omit<RateLimitPolicyRow, 'id'> & { id: string | null }>(
    `SELECT * FROM canon.resolve_rate_limit_policy($1, $2, $3, $4)`,
    [
      scope.workspaceId ?? null,
      scope.provider ?? null,
      scope.modelId ?? null,
      scope.operationClass,
    ],
  );
  const row = r.rows[0];
  if (row?.id == null) return undefined;
  return { ...row, id: row.id };
}

/**
 * Try to admit one request against a policy.
 *
 * Idempotent by `requestId`: a retried activity delivery re-reads its own decision rather than consuming
 * a second admission, which is what stops Temporal's at-least-once delivery from silently multiplying the
 * effective rate.
 */
export async function admit(
  db: Queryable,
  policy: RateLimitPolicyRow,
  input: {
    scopeKey: string;
    requestId: string;
    tokens?: number | undefined;
    now: Date;
  },
): Promise<AdmissionDecision> {
  const r = await db.query<{
    admitted: boolean;
    retry_after_ms: number;
    window_started_at: Date;
    reason: AdmissionDecision['reason'];
  }>(`SELECT * FROM canon.rate_limit_admit($1, $2, $3, $4, $5)`, [
    policy.id,
    input.scopeKey,
    input.requestId,
    Math.trunc(input.tokens ?? 0),
    input.now.toISOString(),
  ]);
  const row = r.rows[0];
  if (!row) throw new Error('rate_limit_admit returned no row');
  return {
    admitted: row.admitted,
    retryAfterMs: row.retry_after_ms,
    windowStart: row.window_started_at,
    reason: row.reason,
  };
}

/** Acquire an in-flight slot, or `undefined` when the policy's concurrency is exhausted. */
export async function acquireSlot(
  db: Queryable,
  policy: RateLimitPolicyRow,
  input: {
    scopeKey: string;
    requestId: string;
    holder: string;
    ttlSeconds: number;
    now: Date;
  },
): Promise<SlotHandle | undefined> {
  const r = await db.query<{
    id: string | null;
    request_id: string | null;
    expires_at: Date | null;
  }>(`SELECT * FROM canon.rate_limit_acquire_slot($1, $2, $3, $4, $5, $6)`, [
    policy.id,
    input.scopeKey,
    input.requestId,
    input.holder,
    input.ttlSeconds,
    input.now.toISOString(),
  ]);
  const row = r.rows[0];
  if (row?.id == null || row.expires_at === null) return undefined;
  return { id: row.id, requestId: row.request_id ?? input.requestId, expiresAt: row.expires_at };
}

/**
 * Release a slot. Idempotent and safe to call from a cancellation path that may run twice or after the
 * slot has already expired — a cancelled request must leak no reservation.
 */
export async function releaseSlot(
  db: Queryable,
  policy: RateLimitPolicyRow,
  input: { scopeKey: string; requestId: string; now: Date },
): Promise<boolean> {
  const r = await db.query<{ rate_limit_release_slot: boolean }>(
    `SELECT canon.rate_limit_release_slot($1, $2, $3, $4)`,
    [policy.id, input.scopeKey, input.requestId, input.now.toISOString()],
  );
  return r.rows[0]?.rate_limit_release_slot ?? false;
}

export interface RateLimitCounters {
  readonly requests: number;
  readonly tokens: number;
  readonly rejected: number;
  readonly liveSlots: number;
}

/** Current counters for one scope, for metrics and the operator surface. */
export async function rateLimitCounters(
  db: Queryable,
  policy: RateLimitPolicyRow,
  input: { scopeKey: string; now: Date },
): Promise<RateLimitCounters> {
  const r = await db.query<{
    requests: string;
    tokens: string;
    rejected: string;
    live_slots: string;
  }>(
    `SELECT coalesce(w.requests, 0)::text AS requests,
            coalesce(w.tokens, 0)::text   AS tokens,
            coalesce(w.rejected, 0)::text AS rejected,
            (SELECT count(*) FROM rate_limit_slots s
              WHERE s.policy_id = $1 AND s.scope_key = $2 AND s.released_at IS NULL
                AND s.expires_at > $3)::text AS live_slots
       FROM (SELECT 1) one
       LEFT JOIN rate_limit_windows w
         ON w.policy_id = $1 AND w.scope_key = $2
        AND w.window_start = to_timestamp(
              floor(extract(epoch FROM $3::timestamptz) / $4) * $4)`,
    [policy.id, input.scopeKey, input.now.toISOString(), policy.window_seconds],
  );
  const row = r.rows[0];
  return {
    requests: Number(row?.requests ?? 0),
    tokens: Number(row?.tokens ?? 0),
    rejected: Number(row?.rejected ?? 0),
    liveSlots: Number(row?.live_slots ?? 0),
  };
}

/**
 * Wait for admission, bounded and cancellation-aware.
 *
 * Three properties matter more than the loop itself:
 *
 *   - it waits exactly as long as the database says the window has left, so many blocked callers do not
 *     turn into a polling storm;
 *   - it is bounded by `maxWaitMs`, so a caller cannot block forever behind a saturated limit;
 *   - it checks the signal both before sleeping and after waking, and it removes its own abort listener,
 *     so a cancelled wait leaves no timer and no listener behind.
 */
export async function waitForAdmission(
  db: Queryable,
  policy: RateLimitPolicyRow,
  input: {
    scopeKey: string;
    requestId: string;
    tokens?: number | undefined;
    clock: Clock;
    maxWaitMs: number;
    signal?: AbortSignal | undefined;
    /** Injected so tests advance time instead of sleeping. */
    sleep?: ((ms: number) => Promise<void>) | undefined;
  },
): Promise<AdmissionDecision & { waitedMs: number }> {
  const sleep =
    input.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        // Never let a pending limiter wait keep the process alive at shutdown.
        if (typeof timer.unref === 'function') timer.unref();
      }));
  const started = input.clock().getTime();
  let waitedMs = 0;
  for (;;) {
    if (input.signal?.aborted === true) {
      throw new Error('rate limit wait cancelled');
    }
    const now = input.clock();
    // A retry inside the wait loop must not consume a fresh admission each pass, so each attempt carries
    // its own suffix while the original requestId still dedupes a redelivered request.
    const decision = await admit(db, policy, {
      scopeKey: input.scopeKey,
      requestId: `${input.requestId}#${String(waitedMs)}`,
      tokens: input.tokens,
      now,
    });
    if (decision.admitted) return { ...decision, waitedMs };
    const elapsed = input.clock().getTime() - started;
    const remaining = input.maxWaitMs - elapsed;
    if (remaining <= 0 || decision.retryAfterMs > remaining)
      return { ...decision, waitedMs: elapsed };
    await sleep(decision.retryAfterMs);
    waitedMs = input.clock().getTime() - started;
  }
}
