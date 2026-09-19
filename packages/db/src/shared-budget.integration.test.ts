/**
 * Shared budget reservations (migration 0015).
 *
 * The case that motivates the whole module is `reserves at most the hard limit when two workers race`:
 * with `MemoryBudget` each process kept its own `Map`, so two workers each believed they owned the entire
 * budget and the hard limit could be spent N times over. That test fails against the old design by
 * construction, because the old design had nowhere for the second worker to look.
 *
 * The other cases that carry real weight are the money-truthfulness ones: an unknown cost must never be
 * booked as zero, a settled reservation must be immutable, and settling twice must not double-charge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  budgetStatus,
  centsToMillicents,
  committedMillicents,
  createPool,
  findBudgetPolicy,
  migrate,
  release,
  reserve,
  resetDatabase,
  settle,
  upsertBudgetPolicy,
  withTransaction,
  type BudgetPolicyRow,
  type Pool,
} from './index.js';
import { databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

const T0 = new Date('2026-02-01T00:00:00.000Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

run('shared budget enforcement over Postgres (migration 0015)', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let policy: BudgetPolicyRow;

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    pool = createPool({ connectionString: url, max: 6 });
    await resetDatabase(pool);
    await migrate(pool);
  }, 120_000);

  beforeEach(async () => {
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('budget-' || canon.uuid_v7()::text) RETURNING id`,
    );
    workspaceId = ws.rows[0]?.id ?? '';
    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version)
       VALUES ($1, 'budget', 'policy/standard@1') RETURNING id`,
      [workspaceId],
    );
    projectId = project.rows[0]?.id ?? '';
    // 1,000 cents = 1,000,000 millicents.
    policy = await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      hardLimitMillicents: centsToMillicents(1_000),
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  // -------------------------------------------------------------------------------------------------
  // reservation and the hard limit
  // -------------------------------------------------------------------------------------------------

  it('reserves within the limit and refuses one unit over it', async () => {
    const ok = await reserve(pool, {
      policyId: policy.id,
      requestId: 'r1',
      estimatedMillicents: 999_999,
      ttlSeconds: 300,
      now: at(0),
    });
    expect(ok?.state).toBe('reserved');

    // Exactly at the boundary: the remaining 1 millicent is affordable.
    const boundary = await reserve(pool, {
      policyId: policy.id,
      requestId: 'r2',
      estimatedMillicents: 1,
      ttlSeconds: 300,
      now: at(0),
    });
    expect(boundary?.state).toBe('reserved');

    // One unit over: refused, and refusal is a return value so the caller records budget_blocked and
    // makes no provider call rather than having to parse an error.
    const over = await reserve(pool, {
      policyId: policy.id,
      requestId: 'r3',
      estimatedMillicents: 1,
      ttlSeconds: 300,
      now: at(0),
    });
    expect(over).toBeUndefined();
  });

  it('reserves at most the hard limit when two workers race for it', async () => {
    // THE case MemoryBudget could not express. Each worker asks for 60% of the budget in its own
    // transaction; both would succeed if each kept its own in-process tally.
    const half = 600_000;
    const results = await Promise.all([
      withTransaction(pool, (client) =>
        reserve(client, {
          policyId: policy.id,
          requestId: 'worker-a',
          estimatedMillicents: half,
          ttlSeconds: 300,
          now: at(0),
        }),
      ),
      withTransaction(pool, (client) =>
        reserve(client, {
          policyId: policy.id,
          requestId: 'worker-b',
          estimatedMillicents: half,
          ttlSeconds: 300,
          now: at(0),
        }),
      ),
    ]);
    expect(results.filter((r) => r !== undefined).length).toBe(1);
    expect(await committedMillicents(pool, policy.id, at(0))).toBe(half);
  });

  it('re-reads its own reservation on retry instead of reserving twice', async () => {
    const first = await reserve(pool, {
      policyId: policy.id,
      requestId: 'idem',
      estimatedMillicents: 400_000,
      ttlSeconds: 300,
      now: at(0),
    });
    const retry = await reserve(pool, {
      policyId: policy.id,
      requestId: 'idem',
      estimatedMillicents: 400_000,
      ttlSeconds: 300,
      now: at(1_000),
    });
    expect(retry?.id).toBe(first?.id);
    // A double reservation would have committed 800,000.
    expect(await committedMillicents(pool, policy.id, at(1_000))).toBe(400_000);
  });

  it('reclaims a reservation whose worker died, so budget is not stranded forever', async () => {
    await reserve(pool, {
      policyId: policy.id,
      requestId: 'abandoned',
      estimatedMillicents: 900_000,
      ttlSeconds: 60,
      now: at(0),
    });
    // While live, it genuinely blocks further spend.
    expect(
      await reserve(pool, {
        policyId: policy.id,
        requestId: 'blocked',
        estimatedMillicents: 200_000,
        ttlSeconds: 60,
        now: at(30_000),
      }),
    ).toBeUndefined();

    // Past its deadline the estimate stops counting, without the dead worker doing anything.
    expect(await committedMillicents(pool, policy.id, at(61_000))).toBe(0);
    expect(
      await reserve(pool, {
        policyId: policy.id,
        requestId: 'after-expiry',
        estimatedMillicents: 200_000,
        ttlSeconds: 60,
        now: at(61_000),
      }),
    ).toBeDefined();
  });

  it('rolls back a reservation when its transaction rolls back', async () => {
    await expect(
      withTransaction(pool, async (client) => {
        await reserve(client, {
          policyId: policy.id,
          requestId: 'rb',
          estimatedMillicents: 500_000,
          ttlSeconds: 300,
          now: at(0),
        });
        throw new Error('activity failed after reserving');
      }),
    ).rejects.toThrow('activity failed after reserving');
    expect(await committedMillicents(pool, policy.id, at(0))).toBe(0);
  });

  // -------------------------------------------------------------------------------------------------
  // settlement truthfulness
  // -------------------------------------------------------------------------------------------------

  it('settles at the actual cost when the provider reported usage', async () => {
    await reserve(pool, {
      policyId: policy.id,
      requestId: 'settle-known',
      estimatedMillicents: 500_000,
      ttlSeconds: 300,
      now: at(0),
    });
    const settled = await settle(pool, {
      policyId: policy.id,
      requestId: 'settle-known',
      actualMillicents: 123_456,
      costKnown: true,
      now: at(1_000),
    });
    expect({ state: settled.state, amount: Number(settled.settled_millicents) }).toEqual({
      state: 'settled',
      amount: 123_456,
    });
    // Exact integer millicents: no floating-point drift anywhere in the path.
    expect(await committedMillicents(pool, policy.id, at(1_000))).toBe(123_456);
  });

  it('keeps the estimate and marks the row unknown when usage was never reported', async () => {
    // The cancelled-call case from ADR-0049. Booking an unknown cost as zero would make a cancelled
    // call look free, which is precisely the false zero migration 0012 refuses for llm_calls.
    await reserve(pool, {
      policyId: policy.id,
      requestId: 'settle-unknown',
      estimatedMillicents: 250_000,
      ttlSeconds: 300,
      now: at(0),
    });
    const settled = await settle(pool, {
      policyId: policy.id,
      requestId: 'settle-unknown',
      actualMillicents: 0,
      costKnown: false,
      now: at(1_000),
    });
    expect(settled.cost_known).toBe(false);
    expect(Number(settled.settled_millicents)).toBe(250_000);
    expect(await committedMillicents(pool, policy.id, at(1_000))).toBe(250_000);

    const status = await budgetStatus(pool, policy, at(1_000));
    // The unknown settlement stays visible and countable, rather than disappearing into a zero.
    expect(status.unknownCostSettlements).toBe(1);
  });

  it('does not double-charge when settlement is delivered twice', async () => {
    await reserve(pool, {
      policyId: policy.id,
      requestId: 'double',
      estimatedMillicents: 300_000,
      ttlSeconds: 300,
      now: at(0),
    });
    const first = await settle(pool, {
      policyId: policy.id,
      requestId: 'double',
      actualMillicents: 100_000,
      costKnown: true,
      now: at(1_000),
    });
    const second = await settle(pool, {
      policyId: policy.id,
      requestId: 'double',
      actualMillicents: 999_000,
      costKnown: true,
      now: at(2_000),
    });
    // The second delivery returns the FIRST outcome; it does not overwrite or add.
    expect(second.id).toBe(first.id);
    expect(Number(second.settled_millicents)).toBe(100_000);
    expect(await committedMillicents(pool, policy.id, at(2_000))).toBe(100_000);
  });

  it('refuses to rewrite or delete a settled reservation, even on the owner connection', async () => {
    // Defence in depth, exactly as ADR-0050 requires: the grant protects the request path, the trigger
    // binds raw SQL and the owner.
    await reserve(pool, {
      policyId: policy.id,
      requestId: 'immutable',
      estimatedMillicents: 100_000,
      ttlSeconds: 300,
      now: at(0),
    });
    await settle(pool, {
      policyId: policy.id,
      requestId: 'immutable',
      actualMillicents: 50_000,
      costKnown: true,
      now: at(1_000),
    });
    await expect(
      pool.query(
        `UPDATE budget_reservations SET settled_millicents = 0
          WHERE policy_id = $1 AND request_id = 'immutable'`,
        [policy.id],
      ),
    ).rejects.toThrow(/BUDGET_SETTLED_IMMUTABLE/);
    await expect(
      pool.query(
        `DELETE FROM budget_reservations WHERE policy_id = $1 AND request_id = 'immutable'`,
        [policy.id],
      ),
    ).rejects.toThrow(/BUDGET_SETTLED_IMMUTABLE/);
    expect(await committedMillicents(pool, policy.id, at(2_000))).toBe(50_000);
  });

  it('releases a reservation that spent nothing, and refuses to un-charge a settled one', async () => {
    // Cancellation before the first attempt: the reservation must come back, or a cancelled run would
    // permanently consume budget it never spent.
    await reserve(pool, {
      policyId: policy.id,
      requestId: 'cancel-before',
      estimatedMillicents: 700_000,
      ttlSeconds: 300,
      now: at(0),
    });
    expect(
      await release(pool, { policyId: policy.id, requestId: 'cancel-before', now: at(10) }),
    ).toBe(true);
    expect(await committedMillicents(pool, policy.id, at(10))).toBe(0);
    // Idempotent: a cancellation path that runs twice is a no-op the second time.
    expect(
      await release(pool, { policyId: policy.id, requestId: 'cancel-before', now: at(20) }),
    ).toBe(false);

    await reserve(pool, {
      policyId: policy.id,
      requestId: 'already-spent',
      estimatedMillicents: 100_000,
      ttlSeconds: 300,
      now: at(0),
    });
    await settle(pool, {
      policyId: policy.id,
      requestId: 'already-spent',
      actualMillicents: 100_000,
      costKnown: true,
      now: at(30),
    });
    // A settled charge is not reversible by a late cancellation.
    expect(
      await release(pool, { policyId: policy.id, requestId: 'already-spent', now: at(40) }),
    ).toBe(false);
    expect(await committedMillicents(pool, policy.id, at(40))).toBe(100_000);
  });

  it('rejects a settlement for a reservation that does not exist', async () => {
    // A duplicate provider callback for a request nobody reserved must fail loudly, not invent a charge.
    await expect(
      settle(pool, {
        policyId: policy.id,
        requestId: 'never-reserved',
        actualMillicents: 1_000,
        costKnown: true,
        now: at(0),
      }),
    ).rejects.toThrow(/BUDGET_RESERVATION_UNKNOWN/);
  });

  // -------------------------------------------------------------------------------------------------
  // scopes, status and isolation
  // -------------------------------------------------------------------------------------------------

  it('keeps separate scopes independent', async () => {
    const jobPolicy = await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'job',
      scopeId: `job-${projectId}`,
      hardLimitMillicents: 10_000,
    });
    // Exhaust the job budget; the project budget is untouched.
    expect(
      await reserve(pool, {
        policyId: jobPolicy.id,
        requestId: 'j1',
        estimatedMillicents: 10_000,
        ttlSeconds: 300,
        now: at(0),
      }),
    ).toBeDefined();
    expect(
      await reserve(pool, {
        policyId: jobPolicy.id,
        requestId: 'j2',
        estimatedMillicents: 1,
        ttlSeconds: 300,
        now: at(0),
      }),
    ).toBeUndefined();
    expect(
      await reserve(pool, {
        policyId: policy.id,
        requestId: 'p1',
        estimatedMillicents: 500_000,
        ttlSeconds: 300,
        now: at(0),
      }),
    ).toBeDefined();
  });

  it('reports a truthful status including soft-limit breach and exhaustion', async () => {
    const withSoft = await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'provider_model',
      scopeId: `replay:model-a:${projectId}`,
      hardLimitMillicents: 1_000,
      softLimitMillicents: 500,
    });
    await reserve(pool, {
      policyId: withSoft.id,
      requestId: 's1',
      estimatedMillicents: 600,
      ttlSeconds: 300,
      now: at(0),
    });
    const mid = await budgetStatus(pool, withSoft, at(0));
    expect({
      committed: mid.committedMillicents,
      remaining: mid.remainingMillicents,
      soft: mid.softLimitBreached,
      exhausted: mid.exhausted,
      outstanding: mid.outstandingReservations,
    }).toEqual({ committed: 600, remaining: 400, soft: true, exhausted: false, outstanding: 1 });

    await reserve(pool, {
      policyId: withSoft.id,
      requestId: 's2',
      estimatedMillicents: 400,
      ttlSeconds: 300,
      now: at(0),
    });
    const full = await budgetStatus(pool, withSoft, at(0));
    expect({ remaining: full.remainingMillicents, exhausted: full.exhausted }).toEqual({
      remaining: 0,
      exhausted: true,
    });
  });

  it('refuses to reserve against a disabled policy rather than silently allowing spend', async () => {
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      hardLimitMillicents: centsToMillicents(1_000),
      enabled: false,
    });
    const disabled = await findBudgetPolicy(pool, 'project', projectId);
    expect(disabled?.enabled).toBe(false);
    await expect(
      reserve(pool, {
        policyId: policy.id,
        requestId: 'disabled',
        estimatedMillicents: 1,
        ttlSeconds: 300,
        now: at(0),
      }),
    ).rejects.toThrow(/BUDGET_POLICY_DISABLED/);
  });

  it('isolates reservations across workspaces under RLS', async () => {
    // The reservation ledger is workspace-owned, so one tenant must not see or spend another's.
    const otherWs = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('budget-other-' || canon.uuid_v7()::text) RETURNING id`,
    );
    const otherWorkspaceId = otherWs.rows[0]?.id ?? '';
    await reserve(pool, {
      policyId: policy.id,
      requestId: 'mine',
      estimatedMillicents: 1_000,
      ttlSeconds: 300,
      now: at(0),
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', otherWorkspaceId]);
      await client.query('SET LOCAL ROLE yeonjae_app');
      const seen = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM budget_reservations',
      );
      expect(seen.rows[0]?.n).toBe('0');
      const policies = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM budget_policies WHERE scope_id = $1',
        [projectId],
      );
      expect(policies.rows[0]?.n).toBe('0');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('grants the application role no DELETE on the reservation ledger', async () => {
    // ADR-0050: accounting history is not deletable by the request path.
    const grants = await pool.query<{ privilege_type: string }>(
      `SELECT DISTINCT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'budget_reservations' AND grantee = 'yeonjae_app'
        ORDER BY privilege_type`,
    );
    expect(grants.rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});
