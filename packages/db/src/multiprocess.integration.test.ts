/**
 * Multi-process coordination: the properties that are invisible to a single-process test.
 *
 * Every case here runs at least two GENUINE OS processes against one database. That combination is the
 * point: the coordination under test (the last concurrency slot, two reservations that must not both
 * win, a holder that dies) is exactly what a single event loop cannot exercise, and what the previous
 * tranche recorded as still open.
 *
 * Isolation is per-DATABASE, created fresh here, which is how the inherited shared-database reset race
 * is resolved: with no shared mutable namespace there is nothing left to race over, and the fix needs no
 * sleeps and no blind retries.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { budgetStatus, findBudgetPolicy, upsertBudgetPolicy } from './shared-budget.js';
import { rateLimitCounters, scopeKeyFor } from './rate-limits.js';
import {
  ChildContext,
  createIsolatedDatabase,
  processAlive,
  type IsolatedDatabase,
} from './multiprocess-harness.js';
import { databaseUrl } from './testkit.js';
import { type Pool, type RateLimitPolicyRow } from './index.js';

const run = databaseUrl() ? describe : describe.skip;

const CHILD = new URL('../multiprocess-child.mjs', import.meta.url).pathname;

/** Proof that real contexts ran, asserted at the end so a silent skip cannot pass as success. */
const evidence = {
  contexts: new Set<string>(),
  pids: new Set<number>(),
  scenarios: [] as string[],
};

run('multi-process coordination', () => {
  let db: IsolatedDatabase;
  let pool: Pool;
  let workspaceId: string;
  const children: ChildContext[] = [];

  const spawnChild = (id: string, env: Record<string, string>): ChildContext => {
    const child = new ChildContext(id, CHILD, { DATABASE_URL: db.url, ...env });
    children.push(child);
    evidence.contexts.add(id);
    if (child.pid !== undefined) evidence.pids.add(child.pid);
    return child;
  };

  /** Let a holding child proceed, by writing the row it polls for. No sleep, no signal guessing. */
  const releaseChildren = async (token = 'release'): Promise<void> => {
    await pool.query('INSERT INTO mp_signals (token) VALUES ($1) ON CONFLICT DO NOTHING', [token]);
  };

  const makeRatePolicy = async (input: {
    maxRequests?: number | null;
    maxConcurrent?: number | null;
  }): Promise<RateLimitPolicyRow> => {
    const r = await pool.query<RateLimitPolicyRow>(
      `INSERT INTO rate_limit_policies
         (workspace_id, provider, model_id, operation_class, window_seconds,
          max_requests, max_tokens, max_concurrent, burst_requests)
       VALUES ($1, 'replay', NULL, 'provider_call', 3600, $2, NULL, $3, 0) RETURNING *`,
      [workspaceId, input.maxRequests ?? null, input.maxConcurrent ?? null],
    );
    const row = r.rows[0];
    if (!row) throw new Error('policy insert returned no row');
    return row;
  };

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    db = await createIsolatedDatabase(url, 'multiproc');
    pool = db.pool;
    // The child-release channel. A table rather than a file or a signal, so the coordination is
    // observable in the same place as everything else the test asserts.
    await pool.query('CREATE TABLE mp_signals (token text PRIMARY KEY)');
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('multiproc') RETURNING id`,
    );
    const wsId = ws.rows[0]?.id;
    if (!wsId) throw new Error('workspace insert returned no row');
    workspaceId = wsId;
    const pr = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version)
       VALUES ($1, 'multiproc', 'standard.v1') RETURNING id`,
      [workspaceId],
    );
    if (!pr.rows[0]?.id) throw new Error('project insert returned no row');
  }, 180_000);

  afterEach(async () => {
    for (const child of children.splice(0)) await child.dispose();
    await pool.query('DELETE FROM mp_signals');
    await pool.query('DELETE FROM rate_limit_slots');
    await pool.query('DELETE FROM rate_limit_windows');
    await pool.query('DELETE FROM rate_limit_policies');
  });

  afterAll(async () => {
    await db.drop();
    // The no-skip guard: this suite's whole value is that separate contexts really ran.
    expect(evidence.contexts.size).toBeGreaterThanOrEqual(2);
    expect(evidence.pids.size).toBeGreaterThanOrEqual(2);
    expect(evidence.scenarios.length).toBeGreaterThanOrEqual(6);
  }, 60_000);

  it('two processes race for the final concurrency slot and exactly one wins', async () => {
    const policy = await makeRatePolicy({ maxRequests: 1000, maxConcurrent: 1 });
    const a = spawnChild('slot-a', {
      YEONJAE_CHILD_ROLE: 'admission',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_REQUEST_ID: 'slot-a',
      YEONJAE_HOLD: '1',
    });
    // Wait for A to be genuinely HOLDING the slot before B tries, so the race has a definite winner
    // rather than a timing-dependent one.
    await a.waitFor('holding');
    const b = spawnChild('slot-b', {
      YEONJAE_CHILD_ROLE: 'admission',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_REQUEST_ID: 'slot-b',
    });
    const verdict = await b.waitFor('admitted');
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toBe('concurrency_exhausted');

    await releaseChildren();
    await a.waitFor('released');
    await a.waitForExit();

    const scopeKey = scopeKeyFor(policy, {
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      operationClass: 'provider_call',
    });
    const counters = await rateLimitCounters(pool, policy, { scopeKey, now: new Date() });
    expect(counters.liveSlots).toBe(0);
    evidence.scenarios.push('final-slot-race');
  }, 60_000);

  it('a killed holder strands nothing: its lease expires and another process continues', async () => {
    const policy = await makeRatePolicy({ maxRequests: 1000, maxConcurrent: 1 });
    const doomed = spawnChild('doomed', {
      YEONJAE_CHILD_ROLE: 'admission',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_REQUEST_ID: 'doomed',
      YEONJAE_HOLD: '1',
    });
    await doomed.waitFor('holding');
    const pid = doomed.pid;
    // SIGKILL: no cleanup handler runs, which is the whole point — a decrement would be lost here.
    doomed.kill('SIGKILL');
    const exit = await doomed.waitForExit();
    expect(exit.signal).toBe('SIGKILL');
    expect(processAlive(pid)).toBe(false);

    const scopeKey = scopeKeyFor(policy, {
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      operationClass: 'provider_call',
    });
    // The slot is still held by the dead process, which is correct: a deadline, not a lost decrement.
    const stillHeld = await rateLimitCounters(pool, policy, { scopeKey, now: new Date() });
    expect(stillHeld.liveSlots).toBe(1);
    // Past the deadline it is reclaimable, with no cleanup pass and no sleep in this test.
    const future = new Date(Date.now() + 400_000);
    const afterExpiry = await rateLimitCounters(pool, policy, { scopeKey, now: future });
    expect(afterExpiry.liveSlots).toBe(0);
    evidence.scenarios.push('killed-holder-lease-expiry');
  }, 60_000);

  it('two 60% budget reservations cannot both win', async () => {
    const localProject = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version)
       VALUES ($1, 'race-60', 'standard.v1') RETURNING id`,
      [workspaceId],
    );
    const raceProject = localProject.rows[0]?.id;
    if (!raceProject) throw new Error('project insert returned no row');
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: raceProject,
      hardLimitMillicents: 100_000,
    });
    const first = spawnChild('budget-a', {
      YEONJAE_CHILD_ROLE: 'budget',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_PROJECT_ID: raceProject,
      YEONJAE_CENTS: '60',
      YEONJAE_HOLD: '1',
    });
    await first.waitFor('reserved');
    const second = spawnChild('budget-b', {
      YEONJAE_CHILD_ROLE: 'budget',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_PROJECT_ID: raceProject,
      YEONJAE_CENTS: '60',
    });
    const refusal = await second.waitFor('refused');
    expect(refusal.code).toBe('BUDGET_EXHAUSTED');
    // And the loser reserved nothing: one outstanding reservation, not two.
    const policy = await findBudgetPolicy(pool, 'project', raceProject);
    if (!policy) throw new Error('no policy');
    const status = await budgetStatus(pool, policy, new Date());
    expect(status.outstandingReservations).toBe(1);
    await releaseChildren();
    evidence.scenarios.push('two-60pct-reservations');
  }, 60_000);

  it('a duplicate request id across processes consumes one admission, not two', async () => {
    const policy = await makeRatePolicy({ maxRequests: 5, maxConcurrent: null });
    const scopeKey = scopeKeyFor(policy, {
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      operationClass: 'provider_call',
    });
    // The at-least-once delivery case: the SAME logical request handled by two processes.
    const a = spawnChild('dup-a', {
      YEONJAE_CHILD_ROLE: 'admission',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_REQUEST_ID: 'shared-request-id',
    });
    await a.waitFor('released');
    const b = spawnChild('dup-b', {
      YEONJAE_CHILD_ROLE: 'admission',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_REQUEST_ID: 'shared-request-id',
    });
    const replay = await b.waitFor('admitted');
    expect(replay.admitted).toBe(true);
    expect(replay.reason).toBe('admitted_replay');
    const counters = await rateLimitCounters(pool, policy, { scopeKey, now: new Date() });
    expect(counters.requests).toBe(1);
    evidence.scenarios.push('duplicate-delivery-one-admission');
  }, 60_000);

  it('a duplicate settlement from a second process does not double-charge', async () => {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version)
       VALUES ($1, 'dup-settle', 'standard.v1') RETURNING id`,
      [workspaceId],
    );
    const dupProject = created.rows[0]?.id;
    if (!dupProject) throw new Error('project insert returned no row');
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: dupProject,
      hardLimitMillicents: 1_000_000,
    });
    for (const id of ['settle-a', 'settle-b']) {
      const child = spawnChild(id, {
        YEONJAE_CHILD_ROLE: 'budget',
        YEONJAE_WORKSPACE_ID: workspaceId,
        YEONJAE_PROJECT_ID: dupProject,
        YEONJAE_JOB_ID: dupProject,
        YEONJAE_CENTS: '30',
        YEONJAE_SETTLE: '1',
      });
      await child.waitFor('settled');
      await child.waitForExit();
    }
    const policy = await findBudgetPolicy(pool, 'project', dupProject);
    if (!policy) throw new Error('no policy');
    const status = await budgetStatus(pool, policy, new Date());
    // Two processes, two settlements, and the committed total is exactly the sum of real work —
    // no reservation left outstanding and no charge applied twice.
    expect(status.outstandingReservations).toBe(0);
    expect(status.committedMillicents).toBe(60_000);
    evidence.scenarios.push('duplicate-settlement');
  }, 60_000);

  it('a process that dies after reserving leaves an expiring reservation, not a permanent hold', async () => {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version)
       VALUES ($1, 'dead-reserve', 'standard.v1') RETURNING id`,
      [workspaceId],
    );
    const deadProject = created.rows[0]?.id;
    if (!deadProject) throw new Error('project insert returned no row');
    await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: deadProject,
      hardLimitMillicents: 100_000,
    });
    const doomed = spawnChild('reserve-then-die', {
      YEONJAE_CHILD_ROLE: 'budget',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_PROJECT_ID: deadProject,
      YEONJAE_CENTS: '60',
      YEONJAE_HOLD: '1',
    });
    await doomed.waitFor('holding');
    doomed.kill('SIGKILL');
    await doomed.waitForExit();

    const policy = await findBudgetPolicy(pool, 'project', deadProject);
    if (!policy) throw new Error('no policy');
    // Right now the reservation still counts: the estimate is held, which is the safe direction.
    const now = await budgetStatus(pool, policy, new Date());
    expect(now.outstandingReservations).toBe(1);
    // After its TTL it no longer blocks new work, so a dead worker cannot freeze a project's budget.
    const later = await budgetStatus(pool, policy, new Date(Date.now() + 1_000_000));
    expect(later.outstandingReservations).toBe(0);
    evidence.scenarios.push('dead-process-reservation-expiry');
  }, 60_000);

  it('leaks no child process, and the isolated database has no leftover connections', async () => {
    const child = spawnChild('cleanup', {
      YEONJAE_CHILD_ROLE: 'admission',
      YEONJAE_WORKSPACE_ID: workspaceId,
      YEONJAE_REQUEST_ID: 'cleanup',
    });
    await child.waitFor('exiting');
    const exit = await child.waitForExit();
    expect(exit.code).toBe(0);
    expect(processAlive(child.pid)).toBe(false);
    // The child closed its pool: no backend of its own is left on this database.
    const backends = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND application_name NOT LIKE 'vitest%'`,
    );
    expect(Number(backends.rows[0]?.n ?? '0')).toBe(0);
    evidence.scenarios.push('no-leaked-process-or-connection');
  }, 60_000);
});
