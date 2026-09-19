# ADR-0050: The application role holds only the privileges its write paths use, and append-only tables are protected at both the trigger and the grant layer

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** engineering agent (Phase 4 hardening, database least-privilege tranche)
- **Relates to:** ADR-0021 (Postgres as system of record), ADR-0048 (atomic lease fencing),
  ADR-0049 (active request cancellation), migrations `0006_identity_rls_api.sql`,
  `0007_app_role_least_privilege.sql`, `0013_llm_calls_audit_grants.sql`,
  `0014_append_only_least_privilege.sql`, `docs/08-delivery/11-deployment-and-incident-runbooks.md`

## Context

Migration 0006 established the security model this ADR completes: a single non-superuser, `NOBYPASSRLS`
role `yeonjae_app` that the request path switches to with `SET LOCAL ROLE`, `FORCE ROW LEVEL SECURITY` on
every workspace-owned table, and policies that resolve the tenant from a transaction-local
`app.workspace_id`. That design is sound and nothing here changes it.

What 0006 also did was `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public`, plus a
matching `ALTER DEFAULT PRIVILEGES` for future tables. Every narrowing since has been **table-by-table and
reactive**:

- 0007 revoked what a request-scoped connection must never touch — `users`, `sessions`,
  `schema_migrations`, the prompt registry, `api_keys` issuance, `workspace_members` administration — and
  narrowed the default privileges for future tables to `SELECT`.
- 0013 revoked `UPDATE, DELETE` on `llm_calls`, because independent review found that 0012's own comment
  and the ADR-0049 text derived from it asserted "INSERT/SELECT only for `yeonjae_app`" while the catalog
  reported `DELETE, INSERT, SELECT, UPDATE`.

0013 was the right repair, and it was the second instance of the same defect. That is the signal this ADR
responds to: the defect was never specific to `llm_calls`. It is **structural**, because 0006 granted DML
everywhere and only the tables someone happened to name were ever narrowed. A repository-wide audit of the
privilege model at base `30cb62af` confirmed it, straight from the catalog:

```sql
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
  FROM information_schema.role_table_grants
 WHERE grantee = 'yeonjae_app' AND table_schema = 'public'
   AND privilege_type IN ('UPDATE','DELETE')
 GROUP BY table_name;
-- 48 tables
```

Among those 48 were `audit_log`, `job_events`, `workflow_artifacts`, `context_packs`,
`active_constraint_sets` and every canon-history table — each of which carries a `BEFORE` trigger that
refuses the very command the role was granted, and none of which has a single `UPDATE` or `DELETE` call
site anywhere in the repository.

The audit also found two defects the table-by-table passes could not have surfaced, because they are not
about tables at all:

1. **Every `canon` function was executable by `PUBLIC`.** PostgreSQL grants `EXECUTE` to `PUBLIC` by
   default. 0006/0008/0010/0011/0012 all added explicit `yeonjae_app` grants, which is exactly why the
   intent reads correctly in the migration text — but the default `PUBLIC` grant was never revoked. So
   `canon.commit_delta`, `canon.rollback_latest`, `canon.quarantine_version` and the lease functions were
   callable by *every* role in the cluster, including any future reporting or maintenance role created
   with nothing but `CONNECT`. Verified: `has_function_privilege('public', oid, 'EXECUTE')` was true for
   all 41 `canon` functions.
2. **The role held more on sequences than `nextval` needs.** The only sequence in the schema belongs to
   `job_events`, an append-only audit stream. `setval` on it would let a request-scoped connection rewind
   the stream so future `seq` values collide with rows already written.

## Decision

**1. The application role is a non-owner, non-superuser, `NOBYPASSRLS` role, and it owns no protected
table.** This is inherited from 0006 and is load-bearing for everything else: `FORCE ROW LEVEL SECURITY`
applies policies to a table's owner, but a table owner can still `ALTER TABLE ... DISABLE TRIGGER`.
Because `yeonjae_app` owns nothing, it cannot disable an append-only guard to get around a revocation.
Tests must therefore exercise a genuine non-owner connection; a test performed as the owner proves nothing
about the request path.

**2. Every table is classified by its mutation model, and the grant follows the classification.**

| Class | Legitimate mutation | Grants to `yeonjae_app` |
| --- | --- | --- |
| Append-only / immutable (`audit_log`, `job_events`, `workflow_artifacts`, `context_packs`, `active_constraint_sets`, `llm_calls`) | `INSERT` only | `INSERT, SELECT` |
| Canon history (`facts`, `events`, `propositions`, their evidence/participant join tables, `canon_commits`, …) | `INSERT` + `UPDATE` inside `canon.commit_delta`; retraction sets `retracted_at_version`, never deletes | `INSERT, SELECT, UPDATE` |
| Function-managed (`target_leases`) | the lease functions | `INSERT, SELECT, UPDATE` |
| Trigger-guarded documents (`identity_documents`, `plan_documents`, `concept_selections`, …) | `INSERT` + guarded `UPDATE` | `INSERT, SELECT, UPDATE` |
| Mutable application state (`jobs`, `chapters`, `projects`, `manuscript_versions`, `search_documents`, …) | ordinary DML through its module | as its write path requires |
| Identity / ledger (`users`, `sessions`, `schema_migrations`, prompt registry) | the unscoped owner path | none, or `SELECT` only (0007) |

**3. Append-only means both layers, and the two layers are independent.** The trigger is the only control
that binds raw SQL, the owner connection, and a restore from a doctored dump. The grant is the only control
that makes the *request path* unable to even attempt the write. Neither substitutes for the other, and
neither is allowed to be the sole control. Migration 0014 revokes the redundant grants and leaves every
trigger in place; the regression suite asserts both halves for each table, so dropping either one fails.

**4. Trusted mutation stays `SECURITY INVOKER`, and we do not convert direct access into `SECURITY
DEFINER` to work around a revocation.** Every function in `canon` is `SECURITY INVOKER` and this ADR keeps
it that way. The consequence is deliberate and must be understood before tightening anything further:
`canon.commit_delta` closes fact validity, retracts propositions and supersedes manuscript versions **with
the caller's privileges**, so revoking `UPDATE` on canon-history tables would break canon commits. That is
precisely why 0014 revokes `DELETE` there and retains `UPDATE`. A `SECURITY DEFINER` wrapper would let us
revoke `UPDATE` as well, but it would move the tenant boundary from the policy engine into hand-written
parameter validation inside the function — strictly more dangerous, for a privilege that the append-only
and no-delete triggers already constrain.

**5. `EXECUTE` is granted to named roles, never to `PUBLIC`, for existing and future functions.** 0014
revokes `PUBLIC` `EXECUTE` across the `canon` schema and sets the schema's default privileges so a future
function is not born `PUBLIC`-executable. The two policy helpers (`canon.workspace_visible`,
`canon.current_workspace`) get an explicit grant first, because every RLS policy calls them as the
querying role and they previously relied on the `PUBLIC` grant.

**6. Default privileges are as narrow as the narrowest object of their class.** Future tables are
`SELECT`-only (0007), future sequences are `USAGE`-only and future `canon` functions are
`yeonjae_app`-only (0014). A migration adding a workspace-owned table grants its DML explicitly, next to
the RLS policy it also has to add. This is what stops the model rotting the way it did between 0006 and
0013.

**7. Security metadata is a restore invariant.** A logical dump/restore that reproduces rows and schema but
loses `FORCE RLS`, a policy, a trigger's enabled state or a grant has silently removed the security model.
The drill therefore asserts the security metadata and then re-executes both a legitimate application
operation and a forbidden direct mutation in the restored database.

## Consequences

- The request-scoped role can no longer attempt to rewrite the operator audit trail, the job event stream,
  the workflow artifact record, a Context Pack manifest, a content-addressed Active Constraint Set, or to
  delete canon history. Each of those attempts previously reached a trigger; now it does not reach the
  table.
- No behaviour changes. Every revoked privilege had no call site and was already refused by a trigger for
  every caller, which is why the full deterministic suite passes unchanged.
- Cancellation and accounting (ADR-0049) are unaffected in substance and strengthened in depth: a cancelled
  attempt still records its audit row through `INSERT`, and the false-zero rewrite that 0012's trigger
  refuses is now also unreachable by privilege. `usage_status`/`billing_status = unknown` remain
  first-class and representable.
- A future migration that needs `UPDATE` on an append-only table must say so explicitly and will fail the
  regression suite until the trigger, the grant and this ADR are reconciled. That is the intended cost.

## Alternatives rejected

- **Rely on the triggers alone.** They already refuse every caller, so the grants are provably redundant —
  which is the argument *for* removing them, not against. A grant that contradicts its own trigger is the
  gap that becomes a real hole the day someone has a legitimate reason to narrow that trigger, and it makes
  the documentation false in the meantime. This is the exact reasoning review applied in 0013.
- **Blanket-revoke `UPDATE` and `DELETE` from all 48 tables.** This breaks canon commits, lease renewal,
  job status transitions, idempotency settlement and quarantine, because those paths are `SECURITY INVOKER`
  and legitimately mutate rows. Each revocation in 0014 is backed by a call-site trace plus an
  unconditional trigger; tables without both keep their grants.
- **Wrap canon mutation in `SECURITY DEFINER` so `UPDATE` can be revoked too.** Rejected under decision 4:
  it relocates the tenant boundary out of the policy engine into hand-written checks.
- **A committed expected-privilege manifest.** Rejected as the primary mechanism: an exact ACL snapshot is
  environment-sensitive (owner role names, cluster defaults) and would fail for local developers whose role
  names differ. The regression suite instead asserts the *properties* — exact privilege sets per class, no
  `PUBLIC` `EXECUTE`, safe defaults — which is portable and fails for the right reasons.

## Limitations (honest scope)

- Everything here is verified against a **local PostgreSQL 16** instance and in fork CI's `postgres:16`
  service. No staging or production database was touched, no credential was rotated, and no deployed
  infrastructure was exercised.
- The restore drill is a **local deterministic logical dump/restore**. It is not a staging restore, not a
  production restore, and not point-in-time recovery.
- Role attributes are asserted for `yeonjae_app` as the migrations create it. A deployment that provisions
  roles by another path must assert the same attributes there; this ADR does not prove anything about a
  cluster it has not seen.
- `pg_dump` does not emit `ALTER DEFAULT PRIVILEGES` for a non-superuser grantor in every configuration, so
  the drill asserts default privileges only where they are portable, and the authoritative check on them is
  the migration-time test.
- Phase 4 remains incomplete. This tranche adds no live-provider evidence of any kind.
