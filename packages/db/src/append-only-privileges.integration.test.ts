/**
 * Least privilege on append-only, immutable and canon-history tables (migration 0014).
 *
 * `app-role-privileges.integration.test.ts` pins the tables 0007 and 0013 narrowed. This suite covers the
 * rest of the model, which the repository-wide audit at 30cb62af found still held UPDATE and DELETE on 48
 * tables because 0006 granted DML on ALL TABLES and only the tables 0007/0013 named were ever revoked.
 *
 * The point of every case here is DEFENCE IN DEPTH plus TRUTHFULNESS, which is why each one checks two
 * different layers and why the positive path is checked alongside the negative one:
 *
 *   - the grant is gone, verified at a real request-scoped connection (SQLSTATE 42501), not merely absent
 *     from a catalogue view;
 *   - the trigger still refuses the same command for the OWNER connection, so narrowing the grant did not
 *     become the only control;
 *   - the legitimate write path still works, so this is least privilege and not a regression.
 *
 * Every negative case here was PERMITTED at 30cb62af. They are regression tests for real findings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createPool, migrate, resetDatabase, type Client, type Pool } from './index.js';
import { databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

/** PostgreSQL's SQLSTATE for "permission denied for table". */
const INSUFFICIENT_PRIVILEGE = '42501';

interface Attempt {
  readonly permitted: boolean;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * Run one statement as the request-scoped role inside a transaction that is ALWAYS rolled back, so a
 * statement that turns out to be permitted cannot corrupt the rest of the suite. The workspace context is
 * set too, so a refusal is attributable to the grant rather than to a closed RLS policy.
 */
async function asAppRole(
  pool: Pool,
  sql: string,
  opts: { workspaceId?: string | undefined } = {},
): Promise<Attempt> {
  const client: Client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (opts.workspaceId !== undefined) {
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', opts.workspaceId]);
    }
    await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
    await client.query(sql);
    return { permitted: true };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { permitted: false, code: e.code, message: e.message };
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** The exact grant set held by the request-scoped role on one table, as the catalogue reports it. */
async function grantsOn(pool: Pool, table: string): Promise<string[]> {
  const r = await pool.query<{ privilege_type: string }>(
    `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2
      ORDER BY privilege_type`,
    [table, APP_ROLE],
  );
  return r.rows.map((row) => row.privilege_type);
}

/** Tables whose only legitimate mutation is INSERT: a trigger refuses UPDATE and DELETE for everyone. */
const APPEND_ONLY_TABLES = [
  'audit_log',
  'job_events',
  'workflow_artifacts',
  'context_packs',
  'active_constraint_sets',
  // 0013 already narrowed this one; it is included so a later migration cannot re-widen it unnoticed.
  'llm_calls',
] as const;

/**
 * Canon history. Rows are retracted with `UPDATE ... SET retracted_at_version` inside
 * canon.commit_delta, never deleted, and two triggers refuse DELETE/TRUNCATE for every caller. UPDATE is
 * retained deliberately: commit_delta is SECURITY INVOKER, so it closes and retracts rows with the
 * caller's privileges.
 */
const CANON_HISTORY_TABLES = [
  'canon_commits',
  'facts',
  'fact_evidence',
  'events',
  'event_evidence',
  'event_participants',
  'knowledge_states',
  'knowledge_evidence',
  'relationship_states',
  'relationship_evidence',
  'propositions',
  'proposition_truths',
  'promise_events',
  'promise_evidence',
] as const;

run('least privilege on append-only and canon-history tables (migration 0014)', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    pool = createPool({ connectionString: url, max: 4 });
    await resetDatabase(pool);
    await migrate(pool);
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('append-only-audit') RETURNING id`,
    );
    workspaceId = ws.rows[0]?.id ?? '';
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version)
       VALUES ($1, 'privilege audit', 'policy/standard@1') RETURNING id`,
      [workspaceId],
    );
    projectId = project.rows[0]?.id ?? '';
  }, 120_000);

  afterAll(async () => {
    // The pool must be ended even if a case above threw, or vitest keeps the process alive.
    await pool.end();
  });

  // -------------------------------------------------------------------------------------------------
  // A. exact privileges
  // -------------------------------------------------------------------------------------------------

  it('grants the scoped role exactly INSERT and SELECT on every append-only table', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      expect({ table, grants: await grantsOn(pool, table) }).toEqual({
        table,
        grants: ['INSERT', 'SELECT'],
      });
    }
  });

  it('leaves no UPDATE or DELETE grant on any table whose trigger refuses it unconditionally', async () => {
    // The audit's own query, kept as an assertion: any FUTURE migration that re-widens one of these
    // tables fails here rather than shipping a grant that contradicts its own trigger.
    const r = await pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT DISTINCT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = 'public'
          AND privilege_type IN ('UPDATE', 'DELETE')
          AND table_name = ANY($2)
        ORDER BY table_name, privilege_type`,
      [APP_ROLE, [...APPEND_ONLY_TABLES]],
    );
    expect(r.rows).toEqual([]);
  });

  it('removes DELETE from canon history while retaining the UPDATE that commit_delta needs', async () => {
    for (const table of CANON_HISTORY_TABLES) {
      const grants = await grantsOn(pool, table);
      expect({ table, hasDelete: grants.includes('DELETE') }).toEqual({ table, hasDelete: false });
      // Retained on purpose. canon.commit_delta is SECURITY INVOKER: without UPDATE, closing a fact's
      // validity or retracting a proposition would fail for the application role.
      expect({ table, hasUpdate: grants.includes('UPDATE') }).toEqual({ table, hasUpdate: true });
    }
  });

  it('holds USAGE but not SELECT or setval on the append-only event sequence', async () => {
    // setval would let a request-scoped connection rewind the job event stream and collide future seq
    // values with rows already written.
    const r = await pool.query<{ usage: boolean; select: boolean; update: boolean }>(
      `SELECT has_sequence_privilege($1, 'job_events_id_seq', 'USAGE')  AS usage,
              has_sequence_privilege($1, 'job_events_id_seq', 'SELECT') AS select,
              has_sequence_privilege($1, 'job_events_id_seq', 'UPDATE') AS update`,
      [APP_ROLE],
    );
    expect(r.rows[0]).toEqual({ usage: true, select: false, update: false });
  });

  it('grants canon function EXECUTE to the application role and to no one else', async () => {
    // PostgreSQL grants EXECUTE to PUBLIC by default, so every explicit GRANT in 0006-0012 sat on top of
    // a grant that made canon.commit_delta, canon.rollback_latest and the lease functions executable by
    // every role in the cluster.
    const r = await pool.query<{ proname: string; public_exec: boolean; app_exec: boolean }>(
      `SELECT p.proname,
              has_function_privilege('public', p.oid, 'EXECUTE')  AS public_exec,
              has_function_privilege($1, p.oid, 'EXECUTE')        AS app_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'canon' ORDER BY p.proname`,
      [APP_ROLE],
    );
    expect(r.rows.length).toBeGreaterThan(30);
    expect(r.rows.filter((row) => row.public_exec)).toEqual([]);
    // Every canon function the application legitimately calls must remain callable.
    expect(r.rows.filter((row) => !row.app_exec)).toEqual([]);
  });

  it('gives future canon functions and public sequences safe default privileges', async () => {
    const r = await pool.query<{ sch: string; objtype: string; acl: string }>(
      `SELECT coalesce(n.nspname, '(global)') AS sch, d.defaclobjtype::text AS objtype,
              array_to_string(d.defaclacl, ' ') AS acl
         FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
        ORDER BY 1, 2`,
    );
    const canonFunctions = r.rows.find((row) => row.sch === 'canon' && row.objtype === 'f');
    // A future canon function must not be born executable by PUBLIC.
    expect(canonFunctions?.acl).toContain(`${APP_ROLE}=X`);
    expect(canonFunctions?.acl).not.toMatch(/(^|\s)=X/);
    const sequences = r.rows.find((row) => row.sch === 'public' && row.objtype === 'S');
    expect(sequences?.acl).toBe(`${APP_ROLE}=U/yeonjae`);
  });

  // -------------------------------------------------------------------------------------------------
  // B. append-only behaviour, both layers
  // -------------------------------------------------------------------------------------------------

  it('refuses a scoped UPDATE or DELETE on every append-only table with a permission error', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      const update = await asAppRole(pool, `UPDATE ${table} SET workspace_id = workspace_id`, {
        workspaceId,
      });
      expect({ table, ...update }).toMatchObject({
        table,
        permitted: false,
        code: INSUFFICIENT_PRIVILEGE,
      });
      const del = await asAppRole(pool, `DELETE FROM ${table}`, { workspaceId });
      expect({ table, ...del }).toMatchObject({
        table,
        permitted: false,
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
  });

  it('refuses a scoped TRUNCATE on every append-only table', async () => {
    // TRUNCATE is never granted, so it fails on privilege; the statement-level canon triggers are the
    // backstop for an owner connection.
    for (const table of APPEND_ONLY_TABLES) {
      const attempt = await asAppRole(pool, `TRUNCATE ${table}`, { workspaceId });
      expect({ table, ...attempt }).toMatchObject({
        table,
        permitted: false,
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
  });

  it('still refuses UPDATE and DELETE on the owner connection, so the grant is not the only control', async () => {
    // This is the defence-in-depth half. If a later migration re-grants UPDATE for a legitimate reason,
    // the trigger must still refuse, and this case is what proves the trigger was not quietly dropped.
    const seeded = await pool.query<{ id: string }>(
      `INSERT INTO audit_log (workspace_id, project_id, action, target_kind, target_id)
       VALUES ($1, $2, 'privilege.audit', 'project', $3) RETURNING id`,
      [workspaceId, projectId, projectId],
    );
    const id = seeded.rows[0]?.id ?? '';
    await expect(
      pool.query(`UPDATE audit_log SET action = 'forged' WHERE id = $1`, [id]),
    ).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    await expect(pool.query('DELETE FROM audit_log WHERE id = $1', [id])).rejects.toThrow(
      /AUDIT_APPEND_ONLY/,
    );
    const after = await pool.query<{ action: string }>(
      'SELECT action FROM audit_log WHERE id = $1',
      [id],
    );
    expect(after.rows[0]?.action).toBe('privilege.audit');
  });

  it('cannot disable an append-only trigger to get around the revocation', async () => {
    // ALTER TABLE ... DISABLE TRIGGER requires ownership. The scoped role is deliberately not the owner,
    // which is what stops the tests in other suites (which run as the owner) from being a false proof.
    for (const [table, trigger] of [
      ['audit_log', 'audit_log_append_only'],
      ['job_events', 'job_events_append_only'],
      ['workflow_artifacts', 'workflow_artifacts_append_only'],
    ] as const) {
      const attempt = await asAppRole(pool, `ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
      expect({ table, permitted: attempt.permitted }).toEqual({ table, permitted: false });
    }
  });

  it('leaves no partial change behind when a forbidden mutation aborts a multi-statement transaction', async () => {
    // A permission denial must abort the whole unit of work, not commit the statements before it.
    const client: Client = await pool.connect();
    let denied: string | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      await client.query(
        `INSERT INTO audit_log (workspace_id, project_id, action, target_kind, target_id)
         VALUES ($1, $2, 'privilege.atomic', 'project', $3)`,
        [workspaceId, projectId, projectId],
      );
      await client.query(`UPDATE audit_log SET action = 'forged'`);
      await client.query('COMMIT');
    } catch (err) {
      denied = (err as { code?: string }).code;
      await client.query('ROLLBACK').catch(() => undefined);
    } finally {
      client.release();
    }
    expect(denied).toBe(INSUFFICIENT_PRIVILEGE);
    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'privilege.atomic'`,
    );
    // The INSERT that preceded the denial must be gone too.
    expect(rows.rows[0]?.n).toBe('0');
  });

  // -------------------------------------------------------------------------------------------------
  // C. the legitimate path still works (this is least privilege, not a regression)
  // -------------------------------------------------------------------------------------------------

  it('still lets the scoped role append an audit row and a job event', async () => {
    const audit = await asAppRole(
      pool,
      `INSERT INTO audit_log (workspace_id, project_id, action, target_kind, target_id)
       VALUES ('${workspaceId}', '${projectId}', 'privilege.allowed', 'project', '${projectId}')`,
      { workspaceId },
    );
    expect(audit).toEqual({ permitted: true });

    const job = await pool.query<{ id: string }>(
      `INSERT INTO jobs (workspace_id, project_id, kind, status, production_policy_version)
       VALUES ($1, $2, 'produce_chapter', 'running', 'policy/standard@1') RETURNING id`,
      [workspaceId, projectId],
    );
    const event = await asAppRole(
      pool,
      `INSERT INTO job_events (workspace_id, project_id, job_id, seq, kind, payload, terminal)
       VALUES ('${workspaceId}', '${projectId}', '${job.rows[0]?.id ?? ''}', 1, 'started',
               '{}'::jsonb, false)`,
      { workspaceId },
    );
    expect(event).toEqual({ permitted: true });
  });

  it('still lets the scoped role read the tables it can no longer rewrite', async () => {
    for (const table of APPEND_ONLY_TABLES) {
      const read = await asAppRole(pool, `SELECT count(*) FROM ${table}`, { workspaceId });
      expect({ table, ...read }).toEqual({ table, permitted: true });
    }
  });

  // -------------------------------------------------------------------------------------------------
  // D. tenant isolation is unaffected by the narrower grants
  // -------------------------------------------------------------------------------------------------

  it('fails closed on an append-only insert with a missing or foreign workspace context', async () => {
    const other = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('append-only-other') RETURNING id`,
    );
    const otherWorkspace = other.rows[0]?.id ?? '';
    const insert = `INSERT INTO audit_log (workspace_id, project_id, action, target_kind, target_id)
                    VALUES ('${workspaceId}', '${projectId}', 'privilege.cross', 'project', '${projectId}')`;

    // No context at all: the policy cannot prove the workspace, so the write is refused.
    const noContext = await asAppRole(pool, insert);
    expect(noContext.permitted).toBe(false);
    // Another tenant's context: refused by the POLICY, not by the grant. PostgreSQL reports an RLS
    // violation under the same SQLSTATE 42501 as a missing privilege, so the layer that refused has to be
    // told apart by the message — otherwise this case would still pass if the INSERT grant were revoked
    // too, and it would stop proving that tenant isolation is what blocks a cross-tenant append.
    const foreign = await asAppRole(pool, insert, { workspaceId: otherWorkspace });
    expect(foreign.permitted).toBe(false);
    expect(foreign.message).toMatch(/row-level security policy/);
    expect(foreign.message).not.toMatch(/permission denied/);
    // And the row was never written under either attempt.
    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'privilege.cross'`,
    );
    expect(rows.rows[0]?.n).toBe('0');
  });
});
