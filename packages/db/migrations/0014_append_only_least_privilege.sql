-- 0014_append_only_least_privilege.sql — finish the least-privilege pass 0007 and 0013 started.
--
-- WHY. Migration 0013 repaired `llm_calls`: its comment and ADR-0049 claimed "INSERT/SELECT only for
-- yeonjae_app", the catalog said DELETE/INSERT/SELECT/UPDATE, and 0013 revoked the difference. That repair
-- was correct but table-scoped. A repository-wide audit of the privilege model at 30cb62af found the SAME
-- defect class on every other append-only, immutable and canon-history table, because 0006 granted DML on
-- ALL TABLES and only the tables 0007/0013 happened to name were ever narrowed.
--
-- Catalog evidence at 30cb62af (yeonjae_app, schema public):
--
--   SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type)
--     FROM information_schema.role_table_grants
--    WHERE grantee = 'yeonjae_app' AND privilege_type IN ('UPDATE','DELETE') GROUP BY 1;
--   -- 48 tables, including audit_log, job_events, workflow_artifacts, context_packs,
--   -- active_constraint_sets and every canon-history table.
--
-- Two classes of confirmed defect are repaired here. In BOTH the privilege is redundant: a BEFORE trigger
-- already refuses the command for every caller (verified directly, including as superuser), and the
-- repository has NO runtime call site that issues it. So this is defence in depth and truthfulness, not a
-- behaviour change — exactly the reasoning 0013 applied to one table, applied to the rest of the model.
--
-- What is deliberately NOT revoked, and why, is recorded in ADR-0050 §"retained privileges". In short:
-- UPDATE on canon-history tables is required because canon.commit_delta is SECURITY INVOKER and closes,
-- retracts and supersedes rows with the CALLER's privileges; DELETE on manuscript_versions,
-- search_documents and summaries is required by canon.quarantine_version, canon.reindex_project and the
-- de-accept cleanup trigger; mutable application state (jobs, chapters, projects, leases, idempotency
-- keys…) keeps the DML its documented write paths use.
--
-- ROLLBACK. Forward-only (data architecture §15). This migration only REVOKEs privileges and narrows
-- default privileges, so re-applying it is idempotent and reverting it means writing a new migration that
-- re-grants; no data moves either way.

-- ---------------------------------------------------------------------------------------------------------
-- 1. append-only and immutable tables: INSERT + SELECT only
-- ---------------------------------------------------------------------------------------------------------
-- Each of these carries a BEFORE UPDATE OR DELETE trigger whose function refuses unconditionally
-- (canon.audit_append_only / canon.acs_immutable both PERFORM canon.raise_code and never return a row), and
-- no TS or SQL call site updates or deletes them. The grant was pure excess authority: it let a
-- request-scoped connection ATTEMPT to rewrite the operator audit trail, the job event stream, the
-- workflow artifact record, a Context Pack manifest or a content-addressed Active Constraint Set.
REVOKE UPDATE, DELETE ON audit_log FROM yeonjae_app;
REVOKE UPDATE, DELETE ON job_events FROM yeonjae_app;
REVOKE UPDATE, DELETE ON workflow_artifacts FROM yeonjae_app;
REVOKE UPDATE, DELETE ON context_packs FROM yeonjae_app;
REVOKE UPDATE, DELETE ON active_constraint_sets FROM yeonjae_app;

-- ---------------------------------------------------------------------------------------------------------
-- 2. canon history: never deleted, only retracted inside a commit
-- ---------------------------------------------------------------------------------------------------------
-- canon.canon_write_guard raises CANON_DELETE_FORBIDDEN for TG_OP = 'DELETE' before it checks anything
-- else, and a second FOR EACH STATEMENT trigger (canon.canon_no_delete_stmt) refuses DELETE *and* TRUNCATE.
-- Retraction is `UPDATE ... SET retracted_at_version` inside canon.commit_delta, never a DELETE, so DELETE
-- has no legitimate caller. UPDATE is retained: commit_delta runs SECURITY INVOKER.
REVOKE DELETE ON canon_commits FROM yeonjae_app;
REVOKE DELETE ON facts FROM yeonjae_app;
REVOKE DELETE ON fact_evidence FROM yeonjae_app;
REVOKE DELETE ON events FROM yeonjae_app;
REVOKE DELETE ON event_evidence FROM yeonjae_app;
REVOKE DELETE ON event_participants FROM yeonjae_app;
REVOKE DELETE ON knowledge_states FROM yeonjae_app;
REVOKE DELETE ON knowledge_evidence FROM yeonjae_app;
REVOKE DELETE ON relationship_states FROM yeonjae_app;
REVOKE DELETE ON relationship_evidence FROM yeonjae_app;
REVOKE DELETE ON propositions FROM yeonjae_app;
REVOKE DELETE ON proposition_truths FROM yeonjae_app;
REVOKE DELETE ON promise_events FROM yeonjae_app;
REVOKE DELETE ON promise_evidence FROM yeonjae_app;

-- ---------------------------------------------------------------------------------------------------------
-- 3. function EXECUTE: named grantees only, never PUBLIC
-- ---------------------------------------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE to PUBLIC by default. 0006/0008/0010/0011/0012 added explicit yeonjae_app
-- grants on top, which is why the intent reads correctly in the migrations — but the PUBLIC grant was never
-- removed, so `canon.commit_delta`, `canon.rollback_latest`, `canon.quarantine_version` and the lease
-- functions were executable by EVERY role in the cluster, including any future reporting or maintenance
-- role added with nothing but CONNECT. Verified at 30cb62af:
--
--   SELECT proname, has_function_privilege('public', oid, 'EXECUTE') FROM pg_proc ... -- all true
--
-- Revoking PUBLIC leaves the explicit grants in place, so the application role is unaffected. The two
-- policy helpers get an explicit grant first: they had NO explicit grant and were reachable only through
-- PUBLIC, and every RLS policy in 0006 calls canon.workspace_visible as the querying role.
GRANT EXECUTE ON FUNCTION canon.workspace_visible(uuid) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.current_workspace() TO yeonjae_app;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA canon FROM PUBLIC;

-- Future functions in canon must not inherit PUBLIC EXECUTE either, so this cannot silently rot again the
-- way the table grants did between 0006 and 0013.
ALTER DEFAULT PRIVILEGES IN SCHEMA canon REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA canon GRANT EXECUTE ON FUNCTIONS TO yeonjae_app;

-- ---------------------------------------------------------------------------------------------------------
-- 4. sequences: no future DML-by-default beyond what a serial INSERT needs
-- ---------------------------------------------------------------------------------------------------------
-- job_events.id is fed by nextval('job_events_id_seq'), which needs USAGE only; SELECT (currval/lastval)
-- and UPDATE (setval) are not used anywhere — verified by searching the repository for all three. 0006's
-- `GRANT USAGE, SELECT` and its matching default privilege are therefore wider than the write path. setval
-- on the audit sequence would let a request-scoped connection rewind the event stream so the next insert
-- collides with an id already written; the restore drill's `sequences_do_not_collide` invariant exists
-- because that failure mode is real.
REVOKE SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM yeonjae_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, UPDATE ON SEQUENCES FROM yeonjae_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO yeonjae_app;

-- ---------------------------------------------------------------------------------------------------------
-- 5. record the security boundary on the objects themselves
-- ---------------------------------------------------------------------------------------------------------
-- 0013 added this comment style to llm_calls after review found the docs contradicting the catalog. The
-- same claim now has to be true, and stay checkable, on every table in group 1.
COMMENT ON TABLE audit_log IS
  'Append-only operator audit trail (NFR-A.1). Two layers: the audit_log_append_only trigger (migration '
  '0002) refuses UPDATE and DELETE for every caller including the owner and raw SQL, and yeonjae_app holds '
  'only INSERT and SELECT (migration 0014).';
COMMENT ON TABLE job_events IS
  'Append-only job event stream. Two layers: the job_events_append_only trigger refuses UPDATE and DELETE '
  'for every caller, and yeonjae_app holds only INSERT and SELECT (migration 0014). Ordering comes from '
  'the per-job seq column; the surrogate id comes from job_events_id_seq, to which the role holds USAGE '
  'but not setval.';
COMMENT ON TABLE workflow_artifacts IS
  'Append-only durable workflow artifact record (checkpoint evidence). Two layers: the '
  'workflow_artifacts_append_only trigger refuses UPDATE and DELETE for every caller, and yeonjae_app '
  'holds only INSERT and SELECT (migration 0014).';
COMMENT ON TABLE context_packs IS
  'Append-only Context Pack manifest snapshots (ADR-0010/0045). A pack is content-addressed by pack_hash: '
  'build a new one rather than editing. Two layers: the context_packs_append_only trigger and '
  'INSERT/SELECT-only grants for yeonjae_app (migration 0014).';
COMMENT ON TABLE active_constraint_sets IS
  'Immutable content-addressed Active Constraint Sets. Two layers: the acs_immutable trigger refuses '
  'UPDATE and DELETE for every caller, and yeonjae_app holds only INSERT and SELECT (migration 0014).';
COMMENT ON TABLE canon_commits IS
  'Append-only canon commit ledger. Rows are written by canon.commit_delta and never deleted: the '
  'canon_commits_no_delete statement trigger refuses DELETE and TRUNCATE, and yeonjae_app no longer holds '
  'DELETE (migration 0014). UPDATE is retained because commit_delta is SECURITY INVOKER and backfills '
  'inverse/item_counts within the same transaction.';
