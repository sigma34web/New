/**
 * The disposable backup/restore drill, actually executed (B-4-3).
 *
 * This suite runs `pg_dump`/`pg_restore` against real, local, disposable PostgreSQL 16 databases that it
 * creates and destroys itself. It is the only evidence in the repository that a logical backup of a
 * fully-migrated multi-tenant database restores with its schema, its RLS policies, its immutable chains
 * and its attempt-level provenance intact.
 *
 * It proves a LOGICAL restore and nothing more. PITR, staging restores, production restores, off-site
 * backup and RTO/RPO are not exercised here and the report records that explicitly.
 *
 * Requires DATABASE_URL. A skipped run is not evidence, so `pnpm drill:restore` refuses to start without
 * it and CI reads the durable report rather than trusting the suite's exit code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  logicalToolsAvailable,
  runRestoreDrill,
  type RestoreDrillReport,
} from './restore-drill.js';
import { writeRestoreDrillReport } from './restore-report.js';
import { databaseUrl } from './testkit.js';

const url = databaseUrl();
const run = url && logicalToolsAvailable() ? describe : describe.skip;

run('B-4-3 disposable logical backup and restore drill', () => {
  let report: RestoreDrillReport;
  // `run` is `describe.skip` unless `url` is set, so inside this block it is always a string. Capturing
  // it once keeps that narrowing explicit rather than repeating an assertion at the call site.
  const adminUrl = url ?? '';

  beforeAll(async () => {
    report = await runRestoreDrill({
      adminUrl,
      acknowledgeDestructive: true,
      drillId: `ci${Date.now().toString(36)}`,
    });
  }, 300_000);

  afterAll(() => {
    // The durable report is the artifact CI reads. Written from afterAll so it exists even when an
    // assertion below fails: evidence of a FAILED drill is still evidence, and hiding it would let a
    // broken restore present as "the suite did not run".
    writeRestoreDrillReport(report);
  });

  it('completed against a real PostgreSQL 16 server', () => {
    expect(report.postgres_version.startsWith('16.')).toBe(true);
    expect(report.duration_ms).toBeGreaterThan(0);
  });

  it('restored the full migration chain through 0011', () => {
    expect(report.migration_version >= '0011').toBe(true);
    expect(report.migration_count).toBeGreaterThanOrEqual(11);
  });

  it('produced an identical logical checksum on the restored database', () => {
    expect(report.target_checksum).toBe(report.source_checksum);
  });

  it('left the source database completely unchanged', () => {
    expect(report.source_checksum_after).toBe(report.source_checksum);
    expect(report.source_unchanged).toBe(true);
  });

  it.each([
    'migration_count_matches',
    'migration_0011_present',
    'tables_restored',
    'indexes_restored',
    'triggers_restored',
    'rls_policies_restored',
    'rls_forced_on_tenant_tables',
    'row_counts_match_by_workspace',
    'canon_versions_contiguous',
    'manuscript_content_hashes_intact',
    'evidence_offsets_and_hashes_intact',
    'accepted_pointer_only_accepted',
    'quarantine_preserved_and_excluded',
    'job_terminal_event_exactly_once',
    'job_checkpoints_restored',
    'attempt_provenance_restored',
    'cost_totals_match_by_workspace',
    'derived_rows_have_no_orphans',
    'sequences_do_not_collide',
    'rls_cross_workspace_isolation_enforced',
    // Security metadata preserved through dump/restore (ADR-0050). Row counts and a matching checksum
    // would all still pass if the restore had dropped a grant, re-enabled a disabled trigger, lost
    // FORCE RLS on one table or handed EXECUTE back to PUBLIC.
    'table_grants_preserved',
    'sequence_grants_preserved',
    'function_execute_grants_preserved',
    'function_security_and_search_path_preserved',
    'policy_definitions_preserved',
    'rls_and_force_rls_preserved',
    'trigger_definitions_and_enabled_state_preserved',
    'table_owners_preserved',
    'schema_privileges_preserved',
    'app_role_remains_unprivileged',
    'no_public_execute_after_restore',
    // Security BEHAVIOUR in the restored database, as the real non-owner role. Metadata can look right
    // while the restored database behaves wrongly, so the drill re-executes the legitimate append and
    // every forbidden direct mutation rather than inferring them from the catalogue.
    'restored_legitimate_audit_append_succeeds',
    'restored_audit_update_refused',
    'restored_audit_delete_refused',
    'restored_job_event_update_refused',
    'restored_canon_commit_delete_refused',
    'restored_llm_call_cost_rewrite_refused',
    'logical_checksum_matches',
    'source_database_unchanged',
  ])('verified invariant %s on the restored database', (id) => {
    const invariant = report.invariants.find((i) => i.id === id);
    expect(invariant, `invariant ${id} was not reported`).toBeDefined();
    expect(invariant?.outcome, `${id} observed ${invariant?.observed ?? 'nothing'}`).toBe('passed');
  });

  it('passed overall', () => {
    expect(report.passed).toBe(true);
  });

  it('does not claim PITR, staging, production or off-site coverage', () => {
    expect(report.scope).toEqual({
      method: 'logical_dump_restore',
      pitr_tested: false,
      staging_restore_tested: false,
      production_restore_tested: false,
      offsite_backup_tested: false,
      rto_rpo_measured: false,
    });
  });

  it('carries no prose and no credential-shaped content', () => {
    const serialized = JSON.stringify(report);
    for (const pattern of [
      /\b(sk|pk)-[A-Za-z0-9]{8,}/,
      /bearer\s+[A-Za-z0-9._-]{12,}/i,
      /BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/,
      // A complete connection URL would carry a host and possibly a password.
      /postgres(ql)?:\/\//,
    ]) {
      expect(serialized).not.toMatch(pattern);
    }
    // Invariant ids and observed values are machine-readable tokens, never sentences.
    for (const invariant of report.invariants) {
      expect(invariant.id).toMatch(/^[a-z0-9_]+$/);
      expect(invariant.observed.length).toBeLessThanOrEqual(120);
    }
  });
});
