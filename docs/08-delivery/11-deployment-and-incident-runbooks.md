# Deployment and Incident Runbooks

Operational procedures for the Checkpoint 7 surfaces that **exist today**: `apps/api`, `apps/worker` and
`apps/cli` over PostgreSQL 16, with Temporal orchestration and replay-only provider routing.

**Truthfulness rules for this document (ADR-0043).** Every command here has been run against this
repository. Where a procedure is designed but not exercised, it says so explicitly. This document makes **no
claim** of live-provider validation, calibrated evaluator quality, long-form model quality, or production
readiness — none of those has been demonstrated. `docs/08-delivery/09-progress.md` remains the single
authority on what has been built and what has run; the scope outline in
`docs/08-delivery/06-operations-runbooks-outline.md` lists runbooks that remain unwritten because the
systems they describe (object storage, KMS, OAuth, live providers) do not exist yet.

`apps/web` does not exist, so every "web" procedure below is marked not applicable rather than described
speculatively.

---

## 1. Prerequisites and supported versions

| Component | Version | Where it is pinned |
| --- | --- | --- |
| Node | 22 LTS (`>=22.12.0`) | `.nvmrc`, `package.json` `engines` |
| pnpm | 10 (`10.26.0`) | `package.json` `packageManager` |
| Python | 3.12 with `jsonschema` | planning validator only (`tools/validate-planning-package.py`) |
| PostgreSQL | **16** with `btree_gist` (bundled) | `packages/db/migrations`, CI service image `postgres:16` |
| Temporal | SDK `@temporalio/*` 1.24 | `apps/worker/package.json` |

Verified in this workspace: PostgreSQL **16.14**, Node 22, pnpm 10.26.0, Python 3.12.3.

```bash
corepack enable
pnpm install --frozen-lockfile
```

The lockfile is authoritative. `--frozen-lockfile` is what CI runs; an install that would change the
lockfile is a configuration error, not something to resolve locally.

---

## 2. PostgreSQL 16 setup

`btree_gist` is required (the canon tables use exclusion constraints so overlapping validity intervals are
impossible) and ships with PostgreSQL 16, so no external extension source is needed.

```bash
# A development database and an owner role.
createdb yeonjae
psql -c "CREATE ROLE yeonjae LOGIN PASSWORD '<from secret manager>'"
psql -c "ALTER DATABASE yeonjae OWNER TO yeonjae"

export DATABASE_URL=postgres://yeonjae:<password>@127.0.0.1:5432/yeonjae
pnpm cli db:migrate
```

### 2.1 Database roles and RLS

Migration `0006_identity_rls_api.sql` creates the role the application runs as:

```sql
CREATE ROLE yeonjae_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
```

All three attributes matter, and two of them are the whole point:

- **`NOSUPERUSER`** — a superuser bypasses row-level security entirely, so running the application as one
  would silently disable every workspace-isolation policy while leaving the policies visibly "enabled".
- **`NOBYPASSRLS`** — the explicit form of the same guarantee.

Every workspace-owned table has `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`; the forced
form is required because a table's owner is otherwise exempt from its own policies. The application `SET
ROLE`s to `yeonjae_app` per request and sets the workspace context transaction-locally, so the scope cannot
leak between pooled requests.

`packages/db/src/app-role-privileges.integration.test.ts` asserts these properties, including that the role
is not a superuser — because that is exactly the misconfiguration that would make every other isolation test
pass for the wrong reason.

The role is also **not the owner** of any protected table, which is what stops it disabling an append-only
trigger to get around a revocation, and its grants follow each table's mutation model rather than a blanket
`GRANT ... ON ALL TABLES` (ADR-0050, migration `0014`):

| Table class | Grants to `yeonjae_app` | Second layer |
| --- | --- | --- |
| Append-only / immutable (`audit_log`, `job_events`, `workflow_artifacts`, `context_packs`, `active_constraint_sets`, `llm_calls`) | `INSERT`, `SELECT` | `BEFORE UPDATE OR DELETE` trigger refusing every caller, including the owner and raw SQL |
| Canon history (`facts`, `events`, `propositions`, evidence/participant joins, `canon_commits`) | `INSERT`, `SELECT`, `UPDATE` | `canon_write_guard` (writes only inside `canon.commit_delta`) plus a statement trigger refusing `DELETE`/`TRUNCATE`. `UPDATE` is retained because `commit_delta` is `SECURITY INVOKER` |
| Identity / ledger (`users`, `sessions`, `schema_migrations`, prompt registry) | none, or `SELECT` only | the unscoped owner path performs these operations (migration `0007`) |

`EXECUTE` on `canon` functions is granted to named roles only — never `PUBLIC` — and future `canon`
functions, future sequences and future tables inherit narrow default privileges so the model cannot widen
silently. `packages/db/src/append-only-privileges.integration.test.ts` asserts every one of these
properties at a real request-scoped connection, and
`packages/db/src/migration-replay.integration.test.ts` asserts that a clean install and an upgrade
converge on the same privilege state.

### 2.2 Migrations

Forward-only and content-hashed. The runner records each file's SHA-256 and **refuses to start** if an
already-applied migration's content changed, so an edited past migration is a loud failure rather than a
silent divergence between environments.

| Migration | Adds |
| --- | --- |
| `0001_canon_core` | canon schema, evidence trigger (code-point offsets), canon write guards, `btree_gist` exclusions |
| `0002_gateway_audit` | append-only `llm_calls`, immutable `prompt_versions`, `jobs` / `job_steps` |
| `0003_context_retrieval` | `summaries`, `search_documents` (accepted-only triggers), ACS and context packs |
| `0004_workflows` | `jobs.workflow_id` / idempotency / pins, `workflow_artifacts`, `dependency_edges` |
| `0005_candidate_selection` | `candidate_selections` — the durable N-candidate decision |
| `0006_identity_rls_api` | users, membership, sessions, API keys, RLS everywhere, `yeonjae_app`, API idempotency keys, job control, `job_events`, `exports` |
| `0007_app_role_least_privilege` | narrowed grants after the privilege audit |
| `0008_target_leases` | fenced target leases (TTL + monotone fence) |
| `0009_lease_fence_assertion` | `canon.assert_lease_fence` — the in-transaction fence assertion (ADR-0048) |
| `0010_operator_resources` | operator-authored resources (identity/plan documents, concept selections, register profiles, directions, reviews) with their shape and lock triggers |
| `0011_attempt_provenance` | per-attempt provenance on `llm_calls` (`canon.assert_attempt_records`) |
| `0012_cancellation_provenance` | cancellation provenance on `llm_calls`; `unknown` usage/billing is first-class and a false zero is refused (ADR-0049) |
| `0013_llm_calls_audit_grants` | made the append-only claim true at the GRANT layer for `llm_calls` (`UPDATE`/`DELETE` revoked from `yeonjae_app`) and tightened the cancellation trigger |
| `0014_append_only_least_privilege` | the same repair across the rest of the model (ADR-0050): `INSERT`/`SELECT` only on `audit_log`, `job_events`, `workflow_artifacts`, `context_packs`, `active_constraint_sets`; `DELETE` revoked from canon history; `EXECUTE` revoked from `PUBLIC` across `canon`; `job_events` sequence narrowed to `USAGE`; narrow default privileges for future sequences and `canon` functions |
| `0015_shared_rate_limits_and_budgets` | shared rate limiting and budget enforcement: `rate_limit_policies` / `rate_limit_windows` / `rate_limit_admissions` / `rate_limit_slots` (fixed-window admission, concurrency as an expiring lease, idempotent by request id, time injected for deterministic tests) and `budget_policies` / `budget_reservations` (integer millicents, expiring reservations, idempotent settlement, `cost_known` so an unknown cost is never booked as zero, settled rows immutable by trigger) |

**Readiness is a deployment gate, not a ping.** `/ready` refuses traffic when migrations are behind, when
the schema is *ahead* of the build, when an applied migration's recorded hash no longer matches the file,
or when `yeonjae_app` has been granted `SUPERUSER`/`BYPASSRLS` — the last of which voids every isolation
guarantee in ADR-0050 while the application looks healthy. Deploy order is therefore: run the migration
job, wait for `/ready`, then shift traffic. Liveness deliberately does **not** fail when an optional
dependency is down; those report `degraded`, so an orchestrator cannot turn a provider outage into an
outage of its own by restarting healthy processes.

Clean-database verification (what CI does on every push):

```bash
export DATABASE_URL=postgres://yeonjae:yeonjae@127.0.0.1:5432/yeonjae_test
pnpm cli db:migrate     # 0001 → 0009 on an empty database
pnpm test               # integration suites reset and re-migrate per file
```

---

## 3. Temporal

### 3.1 Development and tests

**No Temporal server and no credentials are needed for `pnpm test`.** The worker suites run against
Temporal's time-skipping test server, which the SDK downloads and runs locally. That is deliberate: the
restart, replay, duplicate-start, pause, cancel and lease-loss proofs must be runnable in CI without paid
infrastructure, and CI asserts they actually executed rather than skipped (see §10).

To run a real server locally:

```bash
temporal server start-dev            # listens on 127.0.0.1:7233
export TEMPORAL_ADDRESS=127.0.0.1:7233
export TEMPORAL_NAMESPACE=default
```

### 3.2 Deployment

Not exercised: this repository has never been deployed. What the code requires is:

- reachable `TEMPORAL_ADDRESS` and an existing `TEMPORAL_NAMESPACE`;
- the task queue `TEMPORAL_TASK_QUEUE` (defaults to the built-in `CHAPTER_TASK_QUEUE`), matched between the
  worker and whoever starts workflows;
- workers whose workflow code is compatible with in-flight histories. Workflow code is deterministic and
  replayed from history on recovery, so a rollout that changes workflow control flow needs Temporal
  versioning. `apps/worker/src/orchestration.integration.test.ts` includes a deterministic history-replay
  test; use it as the gate before any workflow-code change ships.

---

## 4. Environment variables

Names only — values live in the secret manager (`.env` is git-ignored; AGENTS.md rule 5). `.env.example`
lists the full planned set; the variables the code reads **today** are:

| Variable | Used by | Required | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | api, worker, cli, tests | **yes** | No default. `configFromEnv` throws when unset. |
| `PORT` / `HOST` | api | no | Default `8080` / `127.0.0.1`. |
| `YEONJAE_INSECURE_COOKIES` | api | no | `true` disables the `Secure` cookie flag for local HTTP. **Never set in production** — the default is secure precisely so that forgetting to configure a deployment cannot downgrade the cookie. |
| `YEONJAE_PROVIDER_MODE` | worker | **yes** | `replay` or `mock`. There is **no default**: an unset mode is a startup error, not an implicit "go live". |
| `YEONJAE_REPLAY_FILE` | worker, cli | for replay | Path to a recorded fixture. |
| `YEONJAE_BUDGET_CENTS` | worker, cli | no | Per-run budget ceiling for the gateway's budget guard. |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` / `TEMPORAL_TASK_QUEUE` | worker | no | Defaults `127.0.0.1:7233` / `default` / `CHAPTER_TASK_QUEUE`. |

### 4.1 Provider modes — replay, mock, live

| Mode | Behaviour | Spend |
| --- | --- | --- |
| `replay` | Every model call is served from a recorded fixture, bound by prompt hash and activity id. A call with no recording **fails**; it does not fall through to a provider. | none |
| `mock` | Deterministic synthetic responses with fault injection, for failure-path tests. | none |
| live | **Not implemented.** No provider credential path is wired into the worker. | n/a |

This is the load-bearing cost control, so it is enforced at the process boundary rather than trusted to
configuration review: the worker validates the mode **before opening any connection** and exits non-zero
naming the missing variable. CI asserts that refusal on every push.

```bash
# Verified in this workspace:
$ pnpm --filter @yeonjae/worker start      # with YEONJAE_PROVIDER_MODE unset
# → exit 1, stderr names YEONJAE_PROVIDER_MODE
```

---

## 5. Startup, shutdown and probes

### 5.1 Order

**Start:** PostgreSQL → migrations → Temporal → worker → API. Migrations before the worker and API because
both assume the current schema; the worker before the API so a workflow start has somewhere to go.

**Stop:** API → worker → PostgreSQL. The API first so no new work arrives; the worker second so in-flight
activities finish. The worker handles `SIGINT`/`SIGTERM` with `worker.shutdown()`, which stops polling and
drains running activities before closing its connection and pool.

A worker killed mid-run loses nothing: `produceChapter` keeps Postgres step checkpoints, so a restarted run
replays completed steps and re-spends nothing, and its target lease expires on its TTL so the chapter is not
blocked forever.

### 5.2 Probes

| Probe | Endpoint | Meaning |
| --- | --- | --- |
| Liveness | `GET /health` | The process is up. Answers `{"status":"ok"}` without touching the database, so a database outage does not cause a restart loop. |
| Readiness | `GET /ready` | The process can **serve**: it executes `SELECT 1`. Returns `503` with an RFC 9457 document when the database is unreachable, and never echoes the database error — readiness is a boolean to a load balancer, not a diagnostic channel. |
| Metrics | `GET /metrics` | Prometheus text format. Unauthenticated by design: it renders metric names, allowlisted labels and numbers only, with no tenant, user or manuscript data. |

```bash
$ curl -fsS localhost:8080/health   # {"status":"ok"}
$ curl -fsS localhost:8080/ready    # {"status":"ready"}
$ curl -s -o /dev/null -w '%{http_code}' localhost:8080/v1/projects   # 401
```

That last check is part of CI: an unauthenticated protected route must answer `401` with a problem document,
never data.

---

## 6. Local reproducible development

```bash
corepack enable
pnpm install --frozen-lockfile
export DATABASE_URL=postgres://yeonjae:yeonjae@127.0.0.1:5432/yeonjae_test

pnpm check            # the exact CI sequence
pnpm cli db:migrate
pnpm cli project:create "local"
pnpm cli chapter:produce <projectId> 1     # replay-only; no spend
```

`pnpm check` runs: generated-types freshness → typecheck → lint → format check → unit and PostgreSQL
integration tests → planning validation → contrast validation. Without `DATABASE_URL` the integration
suites **skip visibly**; a run with no database is not evidence of anything.

---

## 7. Production deployment outline

Not exercised — this is the shape the code implies, not a validated procedure.

1. Build: `pnpm install --frozen-lockfile && pnpm build`.
2. Apply migrations with a role that may DDL (`DATABASE_MIGRATION_URL` in `.env.example` exists for this
   separation); run the application as `yeonjae_app`, which cannot bypass RLS.
3. Roll out the worker first, with `YEONJAE_PROVIDER_MODE` set explicitly.
4. Roll out the API behind a load balancer using `/health` for liveness and `/ready` for readiness.
5. Smoke test: produce the fixture chapter with the replay provider and confirm acceptance.
6. Scrape `/metrics` per instance (see the per-process caveat in §12).

---

## 8. Backup, restore and rollback

### 8.1 Backup

PostgreSQL is the single system of record (ADR-0002); Temporal history is recovery metadata, not truth.
Losing the Temporal namespace loses no committed state — a re-started run resumes from its Postgres
checkpoints. So back up PostgreSQL with PITR and treat Temporal as reconstructible.

### 8.2 Restore

**Evidence classification (read this before citing anything below as proof).**

| Procedure | Status |
| --- | --- |
| Local **disposable** logical restore drill (`pnpm drill:restore`) | **executed**, automated, verified in CI |
| Staging restore | **not executed** — no staging environment exists |
| Production restore | **not executed** — no production environment exists |
| Point-in-time recovery (PITR) | **not executed** — no WAL archive is configured |
| Off-site backup verification | **not executed** |
| RTO/RPO measurement | **not measured** |

Only the first row is evidence. The drill's machine-readable report records the same distinction in its
`scope` block, and `tools/run-restore-drill.mjs` fails if the report ever starts claiming otherwise.

#### 8.2.1 The executed drill

`pnpm drill:restore` creates its own disposable databases, applies every migration through `0014`, seeds
representative multi-tenant data through the **real** lifecycle (`createManuscriptVersion` →
`approveManuscriptVersion` → `commitDelta`, plus a quarantined rejected draft), captures a custom-format
`pg_dump`, restores it with `pg_restore` into a second disposable database, and verifies 40 invariants.

```bash
# Requires a local PostgreSQL 16 and DATABASE_URL. The drill never touches the database in that URL;
# it uses the connection only to CREATE and DROP its own `yeonjae_drill_<id>_{source,restored}`.
DATABASE_URL=postgres://yeonjae:***@127.0.0.1:5432/yeonjae_test pnpm drill:restore
```

Verified invariants: migration count and version, tables/indexes/triggers restored, RLS policy count,
`FORCE ROW LEVEL SECURITY` still set, per-workspace row counts, canon version contiguity, manuscript
content hashes, evidence code-point offsets and quote hashes, accepted-only pointers, quarantine preserved
and excluded, exactly one terminal job event, job checkpoints, attempt-level provider provenance
(migration `0011`), per-workspace cost totals, derived-row orphans, sequence non-collision, **cross-workspace
RLS still enforced in the restored database**, whole-database logical checksum equality, and the source
database unchanged.

Since ADR-0050 the drill also treats the **security model** as a restore invariant, because rows, schema
and a matching checksum would all still pass if the restore had lost a grant, re-enabled a disabled
trigger, dropped `FORCE RLS` on one table, changed a function's security mode or handed `EXECUTE` back to
`PUBLIC`. It compares source-to-target: table grants, sequence grants, function `EXECUTE` grants (including
whether `PUBLIC` holds any), function security modes and `search_path` settings, full policy definitions,
per-table `RLS`/`FORCE RLS`, trigger definitions with their enabled state, table owners and schema
privileges — then asserts the application role is still `NOSUPERUSER`/`NOBYPASSRLS` and that no `canon`
function is `PUBLIC`-executable.

It then re-executes **behaviour** in the restored database as the real non-owner role, because metadata can
look correct while the database behaves wrongly: the legitimate audit append must still succeed, and a
direct `audit_log` update or delete, a `job_events` update, a `canon_commits` delete and an `llm_calls`
cost rewrite must each still be refused.

#### 8.2.2 Target verification — do this before any destructive step

The drill refuses a target that is not provably safe, and a human following this runbook should apply the
same rules (`packages/db/src/restore-safety.ts` is the executable form):

1. The host must be **local**. A remote or managed host is refused outright.
2. The database **name** must carry a word-delimited disposable marker (`disposable`, `drill`, `scratch`,
   `throwaway`).
3. The name must not contain a protected word (`prod`, `production`, `staging`, `live`, `main`, `master`,
   `primary`, `customer`, `tenant`) — even alongside a disposable marker. Ambiguity resolves to refusal.
4. Destruction requires an **explicit acknowledgement** separate from supplying the URL.
5. Only databases **created by this drill** are dropped.
6. **`NODE_ENV` is never consulted.** It describes what a process believes about itself, not what database
   it is pointed at.

```bash
# Confirm the target before doing anything destructive. Never paste a full URL into a shared channel.
psql "$TARGET_URL" -tAc "select current_database(), inet_server_addr(), version()"
```

#### 8.2.3 Abort conditions

Abort — do not continue — if any of these hold: the target name is unexpected; `current_database()` does
not match the intended name; the host is not local; the source dump is smaller than expected or
`pg_dump` exited non-zero; the restore reports any error with `--exit-on-error`; or any post-restore check
below returns rows.

#### 8.2.4 Post-restore verification (manual form of the automated checks)

```sql
-- Every project's canon_version must equal its highest commit version.
SELECT p.id, p.canon_version, max(c.version) AS max_commit
  FROM projects p LEFT JOIN canon_commits c ON c.project_id = p.id
 GROUP BY p.id, p.canon_version
HAVING p.canon_version <> coalesce(max(c.version), 0);

-- Every accepted chapter must point at a manuscript version that is itself accepted.
SELECT ch.id FROM chapters ch
  JOIN manuscript_versions m ON m.id = ch.accepted_version_id
 WHERE ch.status = 'accepted' AND m.status <> 'accepted';

-- Content hashes must still match the stored text (the `sha256:` prefix is part of the stored value).
SELECT id FROM manuscript_versions
 WHERE content_hash <> 'sha256:' || encode(sha256(convert_to(text, 'UTF8')), 'hex');

-- Evidence offsets are Unicode code-point offsets into NFC text (ADR-0030) and must still address the quote.
SELECT e.id FROM evidence_spans e JOIN manuscript_versions m ON m.id = e.manuscript_version_id
 WHERE substring(m.text FROM e.start_cp + 1 FOR e.end_cp - e.start_cp) <> e.quote;

-- Row-level security must survive the restore: policies present AND forced.
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relrowsecurity AND NOT c.relforcerowsecurity;

-- No live lease should outlive its deadline after a restore.
SELECT id, holder_workflow_id, expires_at FROM target_leases
 WHERE released_at IS NULL AND expires_at <= now();
```

All but the last should return zero rows. Stale leases are self-healing (an expired lease may be stolen),
so the last query is informational.

#### 8.2.5 Cleanup, evidence retention and redaction

Drop only what the restore created, after the verification above has passed. Retain the drill report
(`coverage/restore-drill-report.json`) as the evidence artifact: it contains identifiers, counts,
checksums and outcomes only. **Never** retain or paste a complete connection URL, a password, or dump
bytes — a logical dump of real data is customer manuscript content. Redact host and credential material
before sharing any output; the tooling does this by construction (`describeTarget`, `redactConnectionUrl`).

#### 8.2.6 Escalation

Escalate to the data owner before touching any database that is not local and disposable. A restore
against staging or production is out of scope for this runbook and for the tooling in this repository.


### 8.3 Application rollback

Code rolls back; **migrations do not**. Forward-only is a deliberate constraint (data architecture §15), so
reverting a schema change means writing a new migration. Before rolling code back, check whether the newer
schema is compatible with the older code — `0009` adds a function and grants nothing away, so older code
simply does not call it; `0007` narrowed grants, so older code that relied on a wider grant would fail.

### 8.4 Failed migration

The runner wraps each file in a transaction, so a failed migration leaves no partial schema and is not
recorded as applied.

1. Read the error; it names the file.
2. Fix the **new** migration, or add another one. Never edit an applied file: the hash check will refuse it
   with "migration … was modified after being applied", which is the intended outcome.
3. Re-run `pnpm cli db:migrate`. Already-applied files are skipped by hash.

If a file was applied and later edited, the runner refuses to proceed. Recover by restoring the original
content and expressing the change as a new migration.

---

## 8A. Secret rotation

**Evidence classification.** Configuration *boundaries* are tested (`apps/api/src/secret-boundaries.test.ts`,
15 tests): a missing or malformed secret fails closed, no path defaults a secret into existence, and no
secret reaches a log field, a rendered log line, a metric label or an error message. **A live credential
rotation has not been executed** — this repository has no deployment environment, no secret manager and no
credentials. The procedures below are written to be followed by an operator who has those things; nothing
here claims a rotation occurred.

### 8A.1 Rules that apply to every rotation

- Rotate **one** secret at a time and verify before starting the next.
- Never paste a secret value into a terminal that is logged, a ticket, a chat channel or a PR.
- Never echo a complete connection URL; use the redacted form (`user@host:port/database`).
- A failed boot after a rotation is the **designed** outcome of a wrong value — read the startup error,
  which names the missing variable and never its value.
- Keep the old value retrievable until the new one is verified. Destroying the old value first turns a
  reversible mistake into an outage.

### 8A.2 Session/auth secret (`SESSION_SECRET`)

Sessions are stored as **hashes** of high-entropy random tokens (`packages/db/src/identity.ts`), so there
is no signing key whose rotation silently invalidates a cookie's integrity — rotating the session secret
invalidates sessions by design.

1. Generate the new value in the secret manager. Do not generate it on a developer machine.
2. Deploy with the new value. **Expect every existing session to be rejected**; users re-authenticate.
3. Verify: an unauthenticated request to a protected route returns `401` with an RFC 9457 problem
   document and no token material (CI asserts this shape on every push).
4. Abort condition: if any request succeeds with a pre-rotation cookie, stop and investigate — an accepted
   old credential after cutover is the failure this rotation exists to prevent.

An overlap window is deliberately **not** implemented. Dual-secret acceptance is the mechanism by which an
old credential keeps working after cutover, and for a token-hash scheme it buys nothing that a brief
re-authentication does not.

### 8A.3 Database credentials (`DATABASE_URL`, `DATABASE_MIGRATION_URL`)

The application role (`yeonjae_app`) is deliberately least-privilege (migration `0007`) and is **not** the
migration role. Rotate the password, not the role.

1. In PostgreSQL: `ALTER ROLE yeonjae_app PASSWORD '<new value from the secret manager>'`. Run this from a
   session whose history is not persisted.
2. Update `DATABASE_URL` in the secret manager and restart the API and worker.
3. Verify: `/ready` returns success (it performs a real query), and `pnpm cli db:migrate` reports only
   skipped migrations.
4. Abort condition: `/ready` fails after restart. Roll back the secret value; the old password is still
   valid until it is explicitly changed again.
5. Restart safety: accepted work is not duplicated by a restart. The chapter loop is Postgres-checkpointed
   and idempotent per step (`job_steps.idempotency_key`), and acceptance is a single atomic canon commit —
   a worker that restarts mid-run resumes from its checkpoint rather than re-accepting.

### 8A.4 Provider credentials (`LLM_PROVIDER_*_API_KEY`)

No live provider is configured; the worker refuses to start without an explicit
`YEONJAE_PROVIDER_MODE`, and the only implemented mode is `replay`, which cannot make a network call.
There is therefore **no provider credential in use to rotate today**. When a live mode exists:

1. Add the new key alongside the old one in the secret manager.
2. Deploy; confirm `yeonjae_provider_attempts_total` shows successful attempts on the new key.
3. Revoke the old key at the provider, then remove it from the secret manager.
4. Verify no provider error message reaches a log or a response body carrying key material — the gateway's
   failure classifier returns a fixed enum member and never echoes the provider's text.

### 8A.5 Object storage and KMS (`OBJECT_STORAGE_*`, `KMS_KEY_REF`)

Not applicable today: no object storage and no KMS integration exist
(`docs/08-delivery/06-operations-runbooks-outline.md`). The variable names are reserved in `.env.example`
and asserted present by the secret-boundary suite so the runbook and the configuration cannot drift apart.

### 8A.6 What a real rotation still requires

A deployment environment, a secret manager, provider accounts and an operator with authority over them.
None exist in this repository, so `docs/08-delivery/09-progress.md` keeps "real credential rotation" open.

---

## 9. Incident runbooks

### 9.1 Provider outage

Symptom: model calls fail; `yeonjae_provider_attempts_total` rises with failure statuses.

The gateway classifies failures by meaning: provider and network faults retry with backoff, while
validation, policy, budget and selection refusals are **non-retryable**, because the same input fails the
same way and retrying only burns budget while delaying an operator decision. A run that exhausts retries
settles as `needs_attention` — a state requiring a decision, not a crash.

Actions: confirm the failure class from the job's persisted error; leave retries to the policy; pause
further starts if the outage is broad (§9.4); do not raise retry limits to push through an outage.

Today this is reachable only via `mock` fault injection, since no live provider is wired.

### 9.2 Temporal outage or worker restart

In-flight work is safe by construction. A restarted worker replays workflow history, and the chapter
pipeline replays its Postgres step checkpoints, so **no completed step is re-executed and no provider call
is duplicated** — proved by a restart test that asserts the model-call count equals a clean run's.

Actions: restart workers; confirm `/ready` on the API; verify no duplicate spend with

```sql
SELECT idempotency_key, count(*) FROM llm_calls
 WHERE project_id = $1 GROUP BY idempotency_key HAVING count(*) > 1;
```

Zero rows is correct: the gateway's idempotency key makes a retried step reuse its recorded call.

### 9.3 Lost or fenced lease

Symptom: a run stops with `LEASE_LOST`; `yeonjae_lease_loss_total` increments with a reason.

| Reason | Meaning | Action |
| --- | --- | --- |
| `fenced_out` | **Another run owns the target now.** | None on this run — it stopped correctly. Find the live holder and let it finish. |
| `expired` | The holder's deadline lapsed (usually a stalled worker). | Investigate why the worker stopped heartbeating; the target is free to re-acquire. |
| `released` | Cleanup already ran and nobody else holds the target. | Safe to restart the run. |
| `missing` | The lease row does not exist. | A configuration or client error; the run presented a lease it never held. |

`LEASE_LOST` is **non-retryable** by classification: another worker owns the target, so a retry would only
re-attempt a forbidden mutation. It is also safe by construction — the fence is asserted **inside** the
transaction of every protected mutation (ADR-0048), so a fenced-out worker cannot approve, accept or commit
canon even if it passed an earlier ownership check.

```sql
-- Who holds a chapter right now.
SELECT holder_workflow_id, fence, expires_at FROM target_leases
 WHERE project_id = $1 AND target_kind = 'chapter' AND target_id = $2
   AND released_at IS NULL AND expires_at > now();
```

**Limitation, stated plainly:** fencing guarantees the *result* of a fenced-out worker's work cannot become
canon. It does not abort an in-flight provider call, so that worker may already have spent money on a call
that was in flight when it lost the lease.

### 9.4 Stuck, paused or cancelled job

Control is a durable **intent**. A **pause** is observed at checkpoint boundaries, never inside a unit of
work — which is what makes it safe: the next step has not begun, so nothing is torn in half and no partial
canon exists. A **cancel** is observed at those boundaries *and* reaches a provider request that is
already running (Phase 4 item 7a), so an operator no longer waits for the current model call to finish.

```bash
curl -X POST .../v1/jobs/<jobId>:pause    -H 'cookie: …' -H 'x-csrf-token: …'
curl -X POST .../v1/jobs/<jobId>:resume   -H 'cookie: …' -H 'x-csrf-token: …'
curl -X POST .../v1/jobs/<jobId>:cancel   -H 'cookie: …' -H 'x-csrf-token: …'
```

Cancellation is **owner-only** (pause and resume are editor operations), authorized by the same
membership-derived, RLS-scoped checks as every other protected job mutation, and idempotent: repeating it —
or racing two requests — changes nothing, emits no duplicate event and duplicates no cost. A terminal job
accepts nothing and answers `applied: false` with a reason rather than a silent success.

A cancel that loses the race with the atomic commit is reported `too_late` and the job settles `completed`.
It is **not** relabelled: a job marked `cancelled` while canon advanced would be a self-contradictory state,
and the ignored request is recorded in the job's history instead.

**Reading a cancelled provider call.** A cancelled call writes one `llm_calls` row with
`status = 'cancelled'` and a `cancellation` object. Five fields matter when an operator asks "what did that
cost, and did it stop?":

```bash
psql "$DATABASE_URL" -c "SELECT created_at, model_id, cost_cents,
    cancellation->>'reason'              AS reason,
    cancellation->>'remote_cancellation' AS remote,
    cancellation->>'usage_status'        AS usage,
    cancellation->>'billing_status'      AS billing,
    cancellation->>'response_discarded'  AS discarded
  FROM llm_calls WHERE status = 'cancelled' AND project_id = '<projectId>' ORDER BY created_at DESC;"
```

* `reason` is one of `operator_cancelled`, `timeout`, `activity_cancelled`, `worker_shutdown`,
  `lease_lost`. The **first** cause to fire wins, so an operator's own action is never reported as a
  provider fault because a deadline expired a moment later. An operator cancellation is never retried,
  repaired or rerouted to another model.
* `remote` answers **only what is known**: `acknowledged` (the provider positively confirmed the
  cancellation), `unsupported` (no remote cancellation exists for that adapter), or `unknown`. **Do not
  read anything other than `acknowledged` as "the provider stopped working."** Aborting our request closes
  our socket; it is not evidence about the provider's compute. Every provider in this repository today is
  deterministic and cannot acknowledge, so expect `unsupported` or `unknown`.
* `usage` / `billing` are `reported`/`known` only when the provider actually returned usage. Otherwise both
  are `unknown` — **not zero**. A cancelled call with `billing_status = unknown` may still appear on a
  future invoice; reconcile it from the invoice, not from this row. `cost_cents` is exact for the usage that
  was reported and is never inflated by a guess.
* `discarded` records that a response arrived after the abort. Its content is thrown away and can never
  reach an artifact or canon; only its usage is kept.

Cancellation provenance is append-only (migration 0002's trigger, still enforced): it cannot be rewritten
after the fact by any caller, including raw SQL.

A job that looks stuck: read its `current_step` and `job_steps`. A `running` step whose lease has expired is
a dead worker (§9.3), not a hung job.

### 9.5 Stale canon conflict

Symptom: a correction, retcon or rollback returns `409 CANON_STALE`.

This is the optimistic version check doing its job: canon moved between the operator's impact report and
their decision, so the consequences they approved are no longer the real ones. **Do not retry blindly.**
Re-read the dry-run impact report, confirm the new consequences, and resubmit with the new
`expected_canon_version`.

The API requires `expected_canon_version` on every committing call rather than defaulting it to current,
because a default would reduce the check to comparing a value with itself.

### 9.6 Canon repair (correction / retcon / rollback)

Always dry-run first — a dry run writes nothing at all, not even an audit row claiming a change:

```bash
POST /v1/projects/{id}/canon:correct   {"item_kind":"fact","item_id":"…","new_value":{…},
                                        "justification":"…","dry_run":true}
```

Read `material` (these become **stale**) against `contextual` (these are **review suggestions** and were not
invalidated). Then commit with `expected_canon_version` from the report. A retcon additionally requires
`confirmed: true`, and rollback is **latest-only** — a rollback of a rollback is refused in SQL.

Nothing is deleted: superseding closes the prior row's validity and links the new row to it, so the old
value and its evidence stay readable at their original canon version.

### 9.7 Budget exhaustion

Symptom: a run pauses with `BUDGET_EXHAUSTED`; `yeonjae_budget_blocks_total` increments.

The budget guard is a **pre-call** check, so the refusal happens before spend, at an activity boundary. It is
classified non-retryable on purpose: an automatic retry would hide a decision that belongs to an operator.
Raise `YEONJAE_BUDGET_CENTS` (or the project's limit) deliberately and resume; the workflow continues from
its checkpoint without re-spending completed steps. Thresholds come from the pinned Production Policy
(ADR-0041), not from a mutable API field.

### 9.8 Rate limiting or abuse incident

Symptom: clients receive `429 RATE_LIMITED`; `yeonjae_rate_limited_total{scope}` rises.

Per-scope sliding-window limits, keyed on client identity and enforced **before** authentication — a
limiter after the auth check would still pay for a scrypt verification on every guess, so it could not stop
credential stuffing.

| Scope | Default | Covers |
| --- | --- | --- |
| `auth` | 10 / min | `/v1/auth/*` — tightest, because each attempt costs a scrypt verification |
| `job` | 20 / min | job control and production starts (each can spend money) |
| `mutation` | 60 / min | all other writes |
| `stream` | 30 / min | SSE job-event streams |
| `read` | 300 / min | inspectors and lists; loose enough for a polling operator UI |

`/health`, `/ready` and `/metrics` are **exempt**: throttling a probe would make a load balancer eject a
healthy instance under exactly the load the limiter exists to survive.

**Client identity is not taken from a header by default.** `X-Forwarded-For` is believed only when the
deployment names its trusted proxies (`trustedProxies`), and then only the rightmost *untrusted* hop is
used. Configure it when running behind a load balancer; leaving it empty is safe but coarse, since every
request behind the proxy shares the proxy's address.

Triage: read the scope from the metric label to learn what is being hammered. A rise in `auth` with
`yeonjae_auth_failures_total` is credential stuffing — the limiter is doing its job; consider blocking at the
edge if it persists. A rise in `read` is usually a misbehaving client polling too fast.

**Limitation, stated plainly: the window store is in-memory and per-process.** It resets on restart and is
not shared between instances, so N instances permit roughly N× the configured rate. For a hard global limit,
enforce at the edge (load balancer or WAF) as well. This is deliberately not called distributed rate
limiting.

### 9.9 SSE disconnection and replay

Job events are an append-only log with a monotone sequence, so a reconnect is a **resume**, not a restart.
A client reconnects with `Last-Event-ID` and receives only events after that id, in order, with duplicates
suppressed. A malformed `Last-Event-ID` is **rejected** rather than silently restarting the stream — a
silent restart would replay events the client already acted on.

Actions: confirm the client sends `Last-Event-ID`; check `yeonjae_sse_replays`; verify the terminal event
exists, since a completed run emits one so a client can distinguish "finished" from "idle".

```sql
SELECT seq, kind FROM job_events WHERE job_id = $1 ORDER BY seq;
```

### 9.10 Credential or session compromise

Sessions and API keys are stored **hashed**, with expiry and revocation. Revoke immediately:

```sql
UPDATE sessions  SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL;
UPDATE api_keys  SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL;
```

Revocation is effective on the next request: authentication reads the row every time rather than trusting a
self-contained token. Password verifiers are salted scrypt with per-row parameters, so rotating parameters
does not invalidate existing rows.

Then: rotate `SESSION_SECRET` (forces re-login), review `audit_log` for the actor's actions, and check
`yeonjae_auth_failures_total` for the surrounding pattern. Logs cannot help an attacker here — passwords,
verifiers, session and key values and hashes, CSRF tokens, cookies and authorization headers are all
excluded by the default-deny log serializer, with tests that assert it.

### 9.11 Export incident

Exports are **accepted-only** and materialized in the database; there are no user-supplied filesystem paths
and downloads are authorized per request. Working, rejected, quarantined and losing candidates are excluded
by the same acceptance path production uses, and the export test proves it by planting all three.

If an export contains unexpected text, the question is whether a version was wrongly accepted — not whether
the exporter filtered correctly. Check the chapter's accepted version and its commit.

### 9.12 Logs and metrics triage

Logs are line-delimited JSON, one record per request, correlated by `request_id` and (when the client sent a
valid `traceparent`) `trace_id`. The `x-request-id` response header carries the id an operator should quote.

```bash
# Everything for one request.
jq 'select(.request_id == "…")' < api.log
# Error-level requests.
jq 'select(.level == "error")' < api.log
```

**What is deliberately absent, and why searching for it is futile:** redaction is default-deny, so a field
that is not on the allowlist is dropped rather than logged. There is no prompt text, manuscript prose,
password, verifier, session or key value, CSRF token, cookie, authorization header, provider credential or
database connection string in any log line. Diagnose from ids, hashes, counts and status codes; when that is
not enough, query the database directly with the ids from the log.

Metrics: request counts and latency, auth failures, canon commits, lease loss, job control, SSE connections
and replays, exports, budget blocks and provider attempts.

---

## 10. CI as the standing verification

`ci.yml` runs on every push and PR with a PostgreSQL 16 service, and includes two guards that exist
specifically so a **skipped** suite cannot be reported as a passing one:

- *"Integration tests actually ran (DATABASE_URL present)"* — the integration suites skip visibly without a
  database, so their silence must be distinguishable from success.
- *"Durable orchestration tests actually ran (worker + Temporal test server)"* — greps the JUnit output for
  the orchestration suite, because it is the only proof of restart, replay and duplicate-start behaviour.

Also enforced: generated-types freshness, typecheck, lint, format, contrast regression (no credentials, no
provider calls), CLI smoke against a migrated database, API startup smoke (unauthenticated `/v1/projects`
must be `401`), worker startup smoke (**must refuse** to start without `YEONJAE_PROVIDER_MODE`), the
dependency-audit gate (high and critical advisories fail; exceptions need a justified, expiring allowlist
entry) and Gitleaks.

---

## 10A. Bilingual reviewer round (B-4-5c) — operator procedure

This is the **externally blocked** half of B-4-5. The tooling exists and is tested
(`packages/eval/src/review-packet.ts`); what has never happened is the round itself. This section is the
operator procedure for when reviewers are actually available. **Executing it requires people. Nothing here
may be simulated, and no step below may be performed by an agent on a reviewer's behalf.**

### 10A.1 Preconditions, all verifiable before contacting anybody

| Precondition | How to verify | Current state |
| --- | --- | --- |
| Corpus is at or above the review size | `pnpm validate:contrast` prints the set count; the protocol needs ≥ 30 passages | 100 sets — satisfied |
| Contrast regression is green at the exact head | `pnpm validate:contrast` → `PASSED`, 0 skipped | satisfied |
| Corpus hash is pinned in the result document | `corpus hash` line of the same output | satisfied |
| Three reviewer identities exist, assigned by a human | operator record outside this repository | **not satisfied — no reviewer has been contacted** |

Record the corpus hash before generating packets. A round whose packets were cut from a different corpus
than the one under calibration proves nothing, and the hash is the only thing that detects it afterward.

### 10A.2 Generate

There is **no CLI command for this round**: `packages/eval/src/review-packet.ts` is a library, and nothing
in `package.json` wraps it. An operator runs it through `tsx` against the loaded corpus. The exact
signatures matter, because calling them wrongly is the easiest way to waste a reviewer's time:

```ts
// tsx scratch/round.mts — one pair per set: the positive target against its Western-drift sibling.
import { loadCorpus } from './packages/eval/src/corpus.js';
import { generatePackets } from './packages/eval/src/review-packet.js';

const corpus = loadCorpus(); // record corpus.hash with the round
const pairs = corpus.sets.map((s) => ({
  setId: s.id,
  genre: s.genre,
  narrativeFunction: s.function,
  left:  { setId: s.id, genre: s.genre, narrativeFunction: s.function,
           variantClass: 'kwn_english',     text: s.variants.kwn_english },
  right: { setId: s.id, genre: s.genre, narrativeFunction: s.function,
           variantClass: 'western_english', text: s.variants.western_english },
}));
const { packets, manifests } = generatePackets(pairs, { seed: '<recorded-seed>' });
```

`generatePackets(pairs, { seed })` returns one packet per reviewer slot plus one private manifest each.
Neither packets nor manifests are written to disk by the tooling — the operator chooses where they go, and
they must not go to the same place.

- The **seed** must be recorded with the round. It is the only way to regenerate the exact packet a
  reviewer saw, and a round that cannot be regenerated cannot be audited.
- Each reviewer gets an independent item order and an independent A/B side assignment, so neither a
  neighbour's packet nor a positional habit leaks the answer.
- A packet carries **no** model id, provider, route, variant class or prompt version — a packet object
  exposes only `packetId`, `reviewerSlot`, `seed`, `protocol`, `items`, `contentHash`, `assignmentHash`
  and `status`, and an item only `itemId`, `genre`, `narrativeFunction`, `a` and `b`. Verify before
  sending by checking those key sets, not by grepping the prose: the passages themselves legitimately
  contain words like "model" and "route".
- Generation **refuses** to produce a short packet rather than silently weakening the protocol.
- Ship the packets. **Keep the manifests.** The manifest is the answer key; sending it to a reviewer voids
  the round.

### 10A.3 Collect

Every response is a human rating on both scales — "natural English" and "reads as a Korean webnovel of
this genre" — as an integer from 1 to 5, plus free comments. `importResponses` is **fail-closed and
accepts nothing partial**: it rejects a response for an item the packet does not contain, a duplicate
response, a missing or empty reviewer identity, merged reviewer identities in one packet, a rating outside
1–5 or non-integer, a missing scale, an incomplete set, and a packet whose content hash no longer matches.
On any problem it returns zero accepted responses, because an agreement figure computed over partially
reviewed data is worse than none.

Do not "fix" a rejected import by editing the responses. Find out what actually happened: crossed packets,
an altered packet, or a reviewer who did not finish.

### 10A.4 Report and decide

`reviewReport(packets, responsesByReviewer)` takes **all** reviewers' packets and a
`Map<reviewerId, ReviewResponse[]>` of already-imported responses — not a single packet and not a raw
array, because inter-rater agreement is undefined for one reviewer. It compares items across reviewers by
SET rather than by item id, since each packet has its own ids and its own side assignment. It computes
pairwise Spearman per scale with average-rank tie handling, and returns `NaN` rather than a fabricated
number when a reviewer's series has no variance. `recommendThresholds` then
reports whether the protocol's preconditions are met — fewer than three reviewers, fewer than 30 passages,
or any scale whose minimum pairwise Spearman is below 0.8 are returned as explicit blockers.

**What the tooling will never do, by construction:** a generated packet is `status: 'generated'` and
nothing in the module can advance it; `reviewReport` returns `calibration: 'uncalibrated'` and
`requires_human_approval: true` unconditionally; and `recommendThresholds` returns a recommendation with
its blockers, never a threshold value and never `contrast_calibrated`. Moving a threshold is a human
decision recorded as a reviewed change to the pinned Production Policy (ADR-0041), backed by accepted
human evidence. Until that happens, evaluators stay **uncalibrated** (ADR-0029) and B-4-5 stays
incomplete.

### 10A.5 What a completed round does not establish

A passing round calibrates the judges against three human reviewers on this corpus. It is not evidence of
live-model prose quality, it does not validate any live provider, and it does not close any other Phase 4
item.

---

## 11. Not applicable / not yet written

| Topic | Status |
| --- | --- |
| `apps/web` startup, build and deployment | **Does not exist.** Outstanding Checkpoint 7 scope. |
| Object storage, KMS, OAuth, live providers | Named in `.env.example` as planned; no code path reads them. |
| Secret rotation for provider keys | No provider credential path exists to rotate. |
| Threshold calibration | Evaluators are **uncalibrated**; contrast validation is deterministic replay agreement only (ADR-0029). The bilingual reviewer round that would calibrate them has an operator procedure in §10A and **has never been executed** — no reviewer has been contacted and no human judgment exists. |
| Tenant offboarding, PITR restore, deploy rollout | Designed in `06-operations-runbooks-outline.md`; **never exercised**. |

---

## 12. Honest limitations

- **Metrics are per-process.** Counters reset on restart and are scraped per instance; aggregation is the
  scraper's job. Nothing here is a distributed counter.
- **No live-provider validation.** Every test replays a frozen fixture. This repository is not evidence of
  live-model prose quality, cost accuracy or latency.
- **Evaluators are uncalibrated.** Contrast validation proves deterministic agreement with a frozen corpus,
  not that the judges match human reviewers.
- **No production deployment has occurred.** §7, §8.2 and §8.3 are derived from the code, not from
  operational experience.
- **Fencing does not abort in-flight spend** (§9.3). Losing a lease now also aborts the local provider
  request (Phase 4 item 7a), but see the next point: aborting our request is not the same as stopping the
  provider's work or its billing.
- **Remote cancellation is unconfirmed.** Cancellation reliably aborts the LOCAL request and reliably
  prevents any further attempt, repair or fallback. Whether the provider stopped generating, and what it
  will bill, is recorded as `unknown`/`unsupported` rather than assumed (§9.4). Confirming remote
  cancellation needs a live provider API and **has not been done**.
- **Rate limiting is per-process** (§9.8): it resets on restart and is not shared between instances.
- **Vector retrieval is an interface only** — no embedder exists (ADR-0045).

## 13. Alert response

One section per alert in `ops/alerts.json`. Every rule links here, and
`tools/validate-ops-templates.test.ts` fails if a link lands on a heading that does not exist — a runbook
link an operator follows at 3am and learns nothing from is worse than no link.

**These alerts are not deployed.** No monitoring system observes them. Each section below is the response
*procedure*; the thresholds are starting values for an environment that does not exist yet.

### API availability

More than 5% of `/v1` requests are failing. Read `/ready` first: if a dependency check is unhappy, follow
that check's section instead — availability is the symptom. Otherwise read the structured logs for the
failing route pattern (never the resolved path; it carries tenant ids). Roll back the most recent deploy
before debugging if the onset correlates with it.

### Readiness

A readiness check is failing, so this instance should not take traffic and, if the platform honours the
probe, is not receiving any. `/ready` names the failing check. Fail closed is deliberate: a degraded
optional dependency should show as `degraded` while a required one refuses readiness outright.

### Migration mismatch

Schema state does not match this build. **Do not "fix" this by running migrations against a database a
newer build depends on.** Determine which direction the drift runs: a database behind this build needs the
migration job; a database ahead of it means this build is stale and must be rolled forward, not the schema
back. Migrations are forward-only (§2.2), and this alert fires at `for: 0m` because waiting cannot make it
safer.

### Unsafe role

The application role is not the expected least-privilege role, or has acquired attributes it must not have
(§2.1, ADR-0050). Treat as a potential isolation failure: tenant separation depends on RLS applying to this
role, and `BYPASSRLS` silently removes it. Stop serving traffic from the affected instance before
investigating.

### Queue delay

Work is accumulating faster than the workers drain it. Check whether the workers are alive, whether they
are blocked on shared rate admission or budget (those have their own alerts and inhibit this one), and
whether a poison work item is being retried indefinitely.

### Provider failures

A provider is failing a large share of attempts. Confirm from the attempt provenance whether the failures
are retryable (transport, throttling, provider-side) or non-retryable (rejected request, auth, content
refusal). Only the first class authorizes fallback; a non-retryable failure rerouted to a second paid model
multiplies spend with no prospect of a different answer.

### Retries

Retries are well above baseline, which means spend is rising without more output. Correlate with provider
failures. Sustained retry with no accompanying provider-failure alert suggests a request-shape problem
rather than a provider problem.

### Fallback

Calls are being rerouted to secondary models, so cost per chapter is rising and prose is coming from a
model the style contracts were not primarily tuned against. Check the primary route's health before raising
limits.

### Rate rejection

The shared limiter is refusing a large share of calls. This is the limiter working, not failing. Decide
deliberately whether the policy is too tight or the offered load too high; raising a shared limit affects
every tenant that shares it.

### Rate wait

Callers are queuing behind the shared rate limit. Bounded by construction (`maxWaitMs`), so this is a
throughput signal, not a hang.

### Concurrency

Shared concurrency is exhausted and work is waiting on leases. Look for leases held by dead processes: they
expire by deadline rather than being lost, so a spike of expirations alongside this alert points at workers
dying mid-call.

### Budget rejection

Work is being refused for budget, so production has stopped for that scope. This is the control doing its
job. Raising a limit is a spend decision and belongs to the product owner, not to an on-call responder.

### Unknown billing

Calls are settling with unknown cost, so the recorded spend figure understates reality. This is truthful by
construction (ADR-0049): an unknown cost keeps its reservation estimate and is never booked as zero.
Reconcile against a provider invoice when one exists — which is external work.

### Cancellation delay

Cancellations are not reaching running calls promptly, which means paid work continues after a stop. Note
what cancellation does and does not prove: it aborts the local request and prevents any further attempt,
repair or fallback; whether the provider stopped generating is recorded as `unknown` unless a real provider
acknowledges it.

### Late responses

Providers are answering after cancellation. The results are discarded and never reach canon, so this is an
informational signal about provider behaviour rather than a fault.

### Stale worker

Workers are being fenced out, so a partitioned or slow worker is attempting stale writes. The fence is
refusing them atomically with the write it protects (ADR-0048); investigate why the worker believes it
still holds the lease.

### Lease loss

Workers are losing target leases mid-work. Correlate with pauses, restarts and database latency.

### Pool saturation

A database pool is running out of connections. Check for a query holding a connection far longer than
expected before raising pool size; a larger pool against a saturated database makes things worse.

### Embedding failure

Embedding generation is failing. A set with failed items **cannot be activated** (migration 0016), so the
current active set stays in place and retrieval continues on it — the failure delays a new set rather than
breaking retrieval.

### Retrieval failure

Retrieval is mostly returning nothing, so continuity checks are running blind. Check whether an active
embedding set exists for the project, whether the query vector's dimension matches it, and whether the
lexical index has been rebuilt. Retrieval degrades to lexical-only rather than failing, so "no active set"
is a likely and recoverable cause.

### Restore drill

No restore drill has succeeded recently, so recovery is unverified. Run the local drill (§8.2.1). A local
logical dump/restore is **not** a staging or production restore and not PITR.

### Output language

Manuscript roles are producing non-English output, which fails the project's governing invariant
(ADR-0026). The gateway discards and regenerates once, then reroutes; sustained failures mean a prompt,
identity block or model change has regressed and should be rolled back.

### Evaluator regression

Evaluators are rejecting far more than baseline. Compare prompt versions and the pinned Production Policy
version before concluding that quality dropped. Evaluator thresholds are **uncalibrated** (ADR-0029): a
change in rejection rate may mean the judges moved, not the prose.
