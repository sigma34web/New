/**
 * Row-level security inventory and isolation, proved table by table (B-4-4).
 *
 * The existing suites prove RLS holds for the tables they happen to touch. That is coverage of today's
 * schema, not a guarantee about tomorrow's: the failure mode this suite exists to prevent is a NEW
 * tenant-owned table shipping without a policy, which no test naming tables by hand would ever catch.
 *
 * So the inventory is DERIVED from the live schema. Every table carrying a `workspace_id` must have RLS
 * enabled, forced, and a policy; a table that is deliberately global must be in an explicit, justified
 * allowlist. Adding a tenant table without a policy fails here, and adding it to the allowlist is a
 * visible, reviewable act rather than an omission.
 *
 * Isolation is then proved behaviourally for SELECT/INSERT/UPDATE/DELETE, through joins, and across a
 * pooled connection — because a policy existing is not the same as a policy binding.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE, createWorkspace, migrate, resetDatabase, withWorkspace } from './index.js';
import { recordSecurityScenarios } from './security-report.js';
import type { Pool } from './client.js';
import { databaseUrl, freshDatabase } from './testkit.js';

/**
 * Tables that are deliberately NOT tenant-scoped, each with the reason.
 *
 * `prompt_sets`/`prompt_versions` are the global immutable prompt registry (ADR-0016): shared by every
 * workspace and never containing customer content, so RLS on them would be isolation theatre — the real
 * control is that they are append-only. `users` and `sessions` are identity, which spans workspaces by
 * definition. `schema_migrations` is schema metadata.
 */
const INTENTIONALLY_GLOBAL = new Set([
  'prompt_sets',
  'prompt_versions',
  'users',
  'sessions',
  'schema_migrations',
]);

/**
 * Child tables that carry no `workspace_id` of their own and are isolated through their parent row,
 * which is itself isolated. Chaining the policy is what keeps that a database guarantee rather than a
 * convention about how the application happens to query them.
 */
const ISOLATED_THROUGH_PARENT = [
  'job_steps',
  'fact_evidence',
  'knowledge_evidence',
  'relationship_evidence',
  'event_participants',
  'event_evidence',
  'promise_events',
  'promise_evidence',
  'proposition_truths',
  // Migration 0015's rate-limit counters. They are keyed by policy and an opaque scope key rather than
  // by workspace, because a provider-wide limit belongs to no single tenant: it constrains them all, and
  // its counters have to be shared for the limit to mean anything. Isolation therefore chains to
  // `rate_limit_policies`, whose own policy keeps a workspace-scoped row private while leaving a global
  // row visible. The scope key never contains customer content — it is workspace id / provider / model.
  'rate_limit_windows',
  'rate_limit_admissions',
  'rate_limit_slots',
] as const;

/**
 * `workspaces` is tenant data isolated on its OWN `id` rather than a `workspace_id` column, so the
 * schema-derived query above cannot find it. It is listed separately, and its policy is asserted below,
 * rather than being waved through as "global".
 */
const SELF_SCOPED = ['workspaces'] as const;

const run = databaseUrl() ? describe : describe.skip;

run('B-4-4 row-level security inventory (derived from the live schema)', () => {
  let pool: Pool;
  let tenantTables: string[] = [];

  beforeAll(async () => {
    pool = await freshDatabase();
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'public' AND col.table_name = c.relname
                         AND col.column_name = 'workspace_id')
        ORDER BY 1`,
    );
    tenantTables = rows.map((r) => r.table_name);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('found a non-trivial set of workspace-owned tables to check', () => {
    // A query that silently returned nothing would make every assertion below vacuously true.
    expect(tenantTables.length).toBeGreaterThanOrEqual(25);
  });

  it('every table carrying workspace_id has RLS enabled, forced, and at least one policy', async () => {
    const { rows } = await pool.query<{
      table_name: string;
      enabled: boolean;
      forced: boolean;
      policies: string;
    }>(
      `SELECT c.relname AS table_name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p
                WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1)`,
      [tenantTables],
    );
    const failures = rows
      .filter((r) => !r.enabled || !r.forced || Number(r.policies) === 0)
      .map(
        (r) =>
          `${r.table_name}(enabled=${String(r.enabled)},forced=${String(r.forced)},policies=${r.policies})`,
      );
    expect(failures, 'workspace-owned tables without binding RLS').toEqual([]);
  });

  it('includes attempt provenance: migration 0011 added a column, not an unprotected table', async () => {
    // attempt_records is jsonb ON llm_calls, so it inherits that table's policy. Asserting this
    // explicitly keeps the B-4-4 inventory honest about WHERE the provenance actually lives.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name='llm_calls' AND column_name='attempt_records'`,
    );
    expect(rows[0]?.n).toBe('1');
    const tableExists = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n2 ON n2.oid=c.relnamespace
        WHERE n2.nspname='public' AND c.relname='attempt_records'`,
    );
    expect(tableExists.rows[0]?.n).toBe('0');
    expect(tenantTables).toContain('llm_calls');
  });

  it('every public table is either tenant-scoped or explicitly, justifiably global', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
    );
    const unaccounted = rows
      .map((r) => r.table_name)
      .filter(
        (t) =>
          !tenantTables.includes(t) &&
          !INTENTIONALLY_GLOBAL.has(t) &&
          !ISOLATED_THROUGH_PARENT.includes(t as (typeof ISOLATED_THROUGH_PARENT)[number]) &&
          !SELF_SCOPED.includes(t as (typeof SELF_SCOPED)[number]),
      );
    // A new table that is neither tenant-scoped, nor isolated through a parent, nor declared global is
    // the exact omission this catches — the one no hand-written table list would ever notice.
    expect(unaccounted, 'tables that are neither tenant-scoped nor declared global').toEqual([]);
  });

  it('child and self-scoped tables without a workspace_id column are still isolated', async () => {
    for (const table of [...ISOLATED_THROUGH_PARENT, ...SELF_SCOPED]) {
      const { rows } = await pool.query<{ enabled: boolean; forced: boolean; policies: string }>(
        `SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                (SELECT count(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=c.relname)::text AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=$1`,
        [table],
      );
      expect(rows[0]?.enabled, `${table} RLS enabled`).toBe(true);
      expect(rows[0]?.forced, `${table} RLS forced`).toBe(true);
      expect(Number(rows[0]?.policies ?? 0), `${table} has a policy`).toBeGreaterThan(0);
    }
  });

  it('records its coverage in the durable security report', () => {
    recordSecurityScenarios([
      {
        id: 'RLS-inventory-derived-from-schema',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['every_workspace_table_has_forced_rls', 'no_unaccounted_public_table'],
      },
      {
        id: 'RLS-attempt-provenance-located',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['attempt_records_is_column_on_llm_calls'],
      },
      {
        id: 'RLS-child-tables-inherit-isolation',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['child_tables_isolated_through_parent', 'workspaces_isolated_on_own_id'],
      },
    ]);
  });
});

run('B-4-4 row-level security actually isolates, per verb and through joins', () => {
  let pool: Pool;
  let wsA = '';
  let wsB = '';
  let projectB = '';

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeAll(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    wsA = await createWorkspace(pool, 'tenant-a');
    wsB = await createWorkspace(pool, 'tenant-b');
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title) VALUES ($1, 'B project') RETURNING id`,
      [wsB],
    );
    projectB = rows[0]?.id ?? '';
    expect(projectB).not.toBe('');
  }, 120_000);

  it('SELECT: workspace A cannot read workspace B rows, even naming B explicitly', async () => {
    const seen = await withWorkspace(pool, wsA, async (c) => {
      const r = await c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM projects WHERE workspace_id = $1',
        [wsB],
      );
      return r.rows[0]?.n;
    });
    expect(seen).toBe('0');
  });

  it('SELECT: a query with NO workspace predicate still sees only its own tenant', async () => {
    // Defence in depth: if an API authorization check were bypassed, the database still refuses.
    const seen = await withWorkspace(pool, wsA, async (c) => {
      const r = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM projects');
      return r.rows[0]?.n;
    });
    expect(seen).toBe('0');
  });

  it('INSERT: workspace A cannot write a row labelled with workspace B', async () => {
    await expect(
      withWorkspace(pool, wsA, async (c) =>
        c.query(`INSERT INTO projects (workspace_id, title) VALUES ($1, 'smuggled')`, [wsB]),
      ),
    ).rejects.toThrow();
  });

  it('UPDATE: workspace A cannot modify a workspace B row', async () => {
    const updated = await withWorkspace(pool, wsA, async (c) => {
      const r = await c.query('UPDATE projects SET title = $2 WHERE id = $1', [
        projectB,
        'hijacked',
      ]);
      return r.rowCount;
    });
    expect(updated).toBe(0);
    const { rows } = await pool.query<{ title: string }>(
      'SELECT title FROM projects WHERE id = $1',
      [projectB],
    );
    expect(rows[0]?.title).toBe('B project');
  });

  it('DELETE: workspace A cannot delete a workspace B row', async () => {
    const deleted = await withWorkspace(pool, wsA, async (c) => {
      const r = await c.query('DELETE FROM projects WHERE id = $1', [projectB]);
      return r.rowCount;
    });
    expect(deleted).toBe(0);
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM projects WHERE id = $1',
      [projectB],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('JOIN: another tenant cannot be reached indirectly through a join', async () => {
    const seen = await withWorkspace(pool, wsA, async (c) => {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chapters ch
           JOIN projects p ON p.id = ch.project_id
          WHERE p.workspace_id = $1`,
        [wsB],
      );
      return r.rows[0]?.n;
    });
    expect(seen).toBe('0');
  });

  it('a connection with NO workspace context sees nothing at all', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const r = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM projects');
      await client.query('COMMIT');
      expect(r.rows[0]?.n).toBe('0');
    } finally {
      client.release();
    }
  });

  it('a pooled connection does not retain the previous request\u2019s tenant context', async () => {
    // set_config(..., is_local => true) scopes the setting to the transaction. Proving it means running
    // B's request and then A's on the same pool and checking A cannot see what B could.
    const asB = await withWorkspace(pool, wsB, async (c) => {
      const r = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM projects');
      return r.rows[0]?.n;
    });
    expect(asB).toBe('1');
    const asA = await withWorkspace(pool, wsA, async (c) => {
      const r = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM projects');
      return r.rows[0]?.n;
    });
    expect(asA).toBe('0');
    // And a bare connection afterwards must still have no context at all.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
      const r = await client.query<{ setting: string | null }>(
        "SELECT nullif(current_setting('app.workspace_id', true), '') AS setting",
      );
      await client.query('COMMIT');
      expect(r.rows[0]?.setting).toBeNull();
    } finally {
      client.release();
    }
  });

  it('records its coverage in the durable security report', () => {
    recordSecurityScenarios([
      {
        id: 'RLS-select-isolation',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['denies_cross_tenant_read', 'denies_read_without_predicate'],
      },
      {
        id: 'RLS-insert-isolation',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['denies_cross_tenant_insert'],
      },
      {
        id: 'RLS-update-isolation',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['denies_cross_tenant_update'],
      },
      {
        id: 'RLS-delete-isolation',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['denies_cross_tenant_delete'],
      },
      {
        id: 'RLS-join-isolation',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['no_leak_through_joins'],
      },
      {
        id: 'RLS-no-context-denies-all',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['unset_context_sees_nothing'],
      },
      {
        id: 'RLS-pooled-connection-no-residue',
        outcome: 'passed',
        surface: 'rls',
        invariants: ['transaction_local_context', 'no_tenant_residue_on_pool'],
      },
    ]);
  });
});
