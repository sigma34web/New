/**
 * The worker's PRODUCTION path uses shared enforcement.
 *
 * This suite exists because the previous tranche built the shared limiter and the shared ledger and then
 * did not connect them: the gateway the worker actually constructed still held a `MemoryBudget`. A test
 * that exercises `SharedBudget` directly cannot catch that — it passes either way. So the assertions here
 * are deliberately about the OBSERVABLE EFFECT of the object the real factory built: a second
 * "process" sees the first one's spend, and a refusal is durable in the database rather than in a `Map`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  budgetStatus,
  createPool,
  findBudgetPolicy,
  migrate,
  resetDatabase,
  upsertBudgetPolicy,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl } from '@yeonjae/db/testkit';
import {
  assertSharedEnforcementAvailable,
  enforcementModeFromEnv,
  productionDeps,
} from './deps.js';

const run = databaseUrl() ? describe : describe.skip;

run('worker production path: shared enforcement', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    pool = createPool({ connectionString: url, max: 6 });
    await resetDatabase(pool);
    await migrate(pool);
    // The factory requires a replay recording; the fixture one the CLI and workflows already use.
    process.env.YEONJAE_PROVIDER_MODE = 'replay';
    process.env.YEONJAE_REPLAY_FILE = new URL(
      '../../../examples/fixture/ch01/replay.ch01.json',
      import.meta.url,
    ).pathname;
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    delete process.env.YEONJAE_ENFORCEMENT_MODE;
  });

  beforeEach(async () => {
    delete process.env.YEONJAE_ENFORCEMENT_MODE;
    // Nothing is deleted between cases: a SETTLED reservation is immutable by design (0015), and a
    // cleanup that tried to remove one would be testing against a fiction. Each case gets a fresh
    // workspace and project instead, so the scopes never collide.
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('enforce') RETURNING id`,
    );
    const wsId = ws.rows[0]?.id;
    if (!wsId) throw new Error('workspace insert returned no row');
    workspaceId = wsId;
    const pr = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version)
       VALUES ($1, 'enforcement', 'standard.v1') RETURNING id`,
      [workspaceId],
    );
    const prId = pr.rows[0]?.id;
    if (!prId) throw new Error('project insert returned no row');
    projectId = prId;
  });

  it('defaults to shared enforcement when the mode is unset', () => {
    delete process.env.YEONJAE_ENFORCEMENT_MODE;
    expect(enforcementModeFromEnv({})).toBe('shared');
  });

  it('refuses to start on an unrecognized enforcement mode instead of degrading silently', () => {
    expect(() => enforcementModeFromEnv({ YEONJAE_ENFORCEMENT_MODE: 'memory' })).toThrow(
      /must be 'shared' or 'isolated_test'/,
    );
    // The specific accident this prevents: a typo must not yield in-process protection.
    expect(() => enforcementModeFromEnv({ YEONJAE_ENFORCEMENT_MODE: 'Shared' })).toThrow();
  });

  it('isolated_test is the ONLY way to reach in-process protection, and it must be explicit', () => {
    expect(enforcementModeFromEnv({ YEONJAE_ENFORCEMENT_MODE: 'isolated_test' })).toBe(
      'isolated_test',
    );
  });

  it('accepts a migrated database as able to enforce shared limits', async () => {
    await expect(assertSharedEnforcementAvailable(pool)).resolves.toBeUndefined();
  });

  it('fails closed when shared enforcement is required but the primitives are absent', async () => {
    // Simulate a database behind migration 0015 by hiding one function the limiter depends on.
    await pool.query('BEGIN');
    try {
      await pool.query(
        'DROP FUNCTION canon.rate_limit_admit(uuid, text, text, bigint, timestamptz)',
      );
      await expect(assertSharedEnforcementAvailable(pool)).rejects.toThrow(
        /shared enforcement is required but unavailable/,
      );
    } finally {
      await pool.query('ROLLBACK');
    }
    // And the check passes again once the primitive is back, so it is testing presence, not a constant.
    await expect(assertSharedEnforcementAvailable(pool)).resolves.toBeUndefined();
  });

  it('the gateway the production factory builds reserves against the DATABASE ledger', async () => {
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      hardLimitMillicents: 500_000,
    });
    const deps = productionDeps(pool, { enforcement: 'shared' })({ workspaceId, projectId });
    const reservation = await depsBudget(deps).reserve(
      { projectId, jobId: projectId, workspaceId },
      100,
    );
    const during = await statusOf(pool, projectId);
    expect(during.outstandingReservations).toBe(1);
    await reservation.release(100);
    const after = await statusOf(pool, projectId);
    expect(after.outstandingReservations).toBe(0);
    expect(after.committedMillicents).toBe(100_000);
  });

  it('two production gateways built as separate processes share one project budget', async () => {
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      // Room for one 60%-of-limit reservation, not two. With MemoryBudget both would be admitted.
      hardLimitMillicents: 100_000,
    });
    const first = productionDeps(pool, { enforcement: 'shared' })({ workspaceId, projectId });
    const second = productionDeps(pool, { enforcement: 'shared' })({ workspaceId, projectId });
    await depsBudget(first).reserve({ projectId, jobId: projectId, workspaceId }, 60);
    await expect(
      depsBudget(second).reserve({ projectId, jobId: projectId, workspaceId }, 60),
    ).rejects.toThrow(/cannot afford/);
  });

  it('isolated_test protection is per-process, which is exactly why it is not the default', async () => {
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      hardLimitMillicents: 100_000,
    });
    const first = productionDeps(pool, { enforcement: 'isolated_test' })({
      workspaceId,
      projectId,
    });
    const second = productionDeps(pool, { enforcement: 'isolated_test' })({
      workspaceId,
      projectId,
    });
    // Both succeed past the shared ceiling: an in-memory ledger cannot see the other process.
    await depsBudget(first).reserve({ projectId, jobId: projectId, workspaceId }, 60);
    await expect(
      depsBudget(second).reserve({ projectId, jobId: projectId, workspaceId }, 60),
    ).resolves.toBeDefined();
    // And nothing was written to the shared ledger, so the mode is unmistakable from the database.
    const status = await statusOf(pool, projectId);
    expect(status.outstandingReservations).toBe(0);
    expect(status.committedMillicents).toBe(0);
  });

  it('unknown cost is settled as unknown, never as zero', async () => {
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      hardLimitMillicents: 500_000,
    });
    const deps = productionDeps(pool, { enforcement: 'shared' })({ workspaceId, projectId });
    const reservation = await depsBudget(deps).reserve(
      { projectId, jobId: projectId, workspaceId },
      40,
    );
    // The cancelled-call path: the provider may have produced tokens we cannot price.
    await reservation.release(0, { costKnown: false });
    const status = await statusOf(pool, projectId);
    expect(status.unknownCostSettlements).toBe(1);
    // The estimate is retained rather than booked as a comfortable zero.
    expect(status.committedMillicents).toBe(40_000);
  });

  it('settlement is idempotent under duplicate delivery', async () => {
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      hardLimitMillicents: 500_000,
    });
    const deps = productionDeps(pool, { enforcement: 'shared' })({ workspaceId, projectId });
    const reservation = await depsBudget(deps).reserve(
      { projectId, jobId: projectId, workspaceId },
      25,
    );
    await reservation.release(25);
    await reservation.release(25);
    await reservation.release(25);
    const status = await statusOf(pool, projectId);
    expect(status.committedMillicents).toBe(25_000);
  });
});

/**
 * Reach the ledger the factory installed.
 *
 * The gateway keeps its options private, which is right — but this suite's entire purpose is to assert
 * which ledger the PRODUCTION factory chose, so it reads the constructed object rather than re-deriving
 * what it thinks the factory should have done.
 */
/** Read the project's shared-ledger status via its policy row. */
async function statusOf(pool: Pool, projectId: string) {
  const policy = await findBudgetPolicy(pool, 'project', projectId);
  if (!policy) throw new Error('no project budget policy');
  return budgetStatus(pool, policy, new Date());
}

function depsBudget(deps: { gateway: unknown }): {
  reserve(
    scope: { projectId: string; jobId: string; workspaceId?: string | undefined },
    cents: number,
  ): Promise<{ release(actual: number, opts?: { costKnown?: boolean }): Promise<void> }>;
} {
  const opts = (deps.gateway as { opts: { budget: unknown } }).opts;
  return opts.budget as ReturnType<typeof depsBudget>;
}
