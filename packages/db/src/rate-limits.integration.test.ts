/**
 * Shared rate limiting and concurrency control (migration 0015).
 *
 * Every case here drives time with an injected clock and synchronises concurrency with real database
 * transactions. There is no `sleep()` anywhere in this file: a limiter test that waits on wall-clock time
 * is either slow or flaky, and usually both.
 *
 * The cases that matter most are the ones the previous in-memory limiter could not even express: two
 * connections racing for the last concurrency slot, a worker dying while holding one, and a redelivered
 * request not consuming a second admission.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireSlot,
  admit,
  createPool,
  migrate,
  rateLimitCounters,
  releaseSlot,
  resolveRateLimitPolicy,
  resetDatabase,
  scopeKeyFor,
  waitForAdmission,
  withTransaction,
  type Pool,
  type RateLimitPolicyRow,
} from './index.js';
import { databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

/** A fixed base instant, so every window boundary in this suite is arithmetic rather than timing. */
const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

run('shared rate limiting over Postgres (migration 0015)', () => {
  let pool: Pool;
  let workspaceId: string;

  const makePolicy = async (input: {
    operationClass?: string | undefined;
    provider?: string | null | undefined;
    modelId?: string | null | undefined;
    workspaceScoped?: boolean | undefined;
    windowSeconds?: number | undefined;
    maxRequests?: number | null | undefined;
    maxTokens?: number | null | undefined;
    maxConcurrent?: number | null | undefined;
    burst?: number | undefined;
  }): Promise<RateLimitPolicyRow> => {
    const r = await pool.query<RateLimitPolicyRow>(
      `INSERT INTO rate_limit_policies
         (workspace_id, provider, model_id, operation_class, window_seconds,
          max_requests, max_tokens, max_concurrent, burst_requests)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        input.workspaceScoped === true ? workspaceId : null,
        input.provider === undefined ? 'replay' : input.provider,
        input.modelId === undefined ? null : input.modelId,
        input.operationClass ?? 'provider_call',
        input.windowSeconds ?? 60,
        input.maxRequests === undefined ? 2 : input.maxRequests,
        input.maxTokens === undefined ? null : input.maxTokens,
        input.maxConcurrent === undefined ? null : input.maxConcurrent,
        input.burst ?? 0,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error('policy insert returned no row');
    return row;
  };

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    pool = createPool({ connectionString: url, max: 6 });
    await resetDatabase(pool);
    await migrate(pool);
  }, 120_000);

  beforeEach(async () => {
    // Policies and counters only: re-migrating per case would dominate the runtime.
    await pool.query('DELETE FROM rate_limit_policies');
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('rate-limit-' || canon.uuid_v7()::text) RETURNING id`,
    );
    workspaceId = ws.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await pool.end();
  });

  // -------------------------------------------------------------------------------------------------
  // admission
  // -------------------------------------------------------------------------------------------------

  it('admits up to the limit and then refuses with an exact retry-after', async () => {
    const policy = await makePolicy({ windowSeconds: 60, maxRequests: 2 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });

    const first = await admit(pool, policy, { scopeKey: key, requestId: 'r1', now: at(0) });
    const second = await admit(pool, policy, { scopeKey: key, requestId: 'r2', now: at(1_000) });
    const third = await admit(pool, policy, { scopeKey: key, requestId: 'r3', now: at(2_000) });

    expect([first.admitted, second.admitted, third.admitted]).toEqual([true, true, false]);
    expect(third.reason).toBe('request_limit');
    // The window opened at T0 and lasts 60 s; the refusal happened 2 s in, so exactly 58 s remain. An
    // exact answer is what lets a caller wait once instead of polling.
    expect(third.retryAfterMs).toBe(58_000);
  });

  it('rolls over at the window boundary and not one millisecond early', async () => {
    const policy = await makePolicy({ windowSeconds: 60, maxRequests: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });

    expect(
      (await admit(pool, policy, { scopeKey: key, requestId: 'a', now: at(0) })).admitted,
    ).toBe(true);
    // 59.999 s: still inside the first window.
    expect(
      (await admit(pool, policy, { scopeKey: key, requestId: 'b', now: at(59_999) })).admitted,
    ).toBe(false);
    // 60.000 s: the next window. The boundary is the assertion.
    expect(
      (await admit(pool, policy, { scopeKey: key, requestId: 'c', now: at(60_000) })).admitted,
    ).toBe(true);
  });

  it('spends burst capacity above the steady limit, then refuses', async () => {
    const policy = await makePolicy({ maxRequests: 1, burst: 2 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    const outcomes: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push(
        (await admit(pool, policy, { scopeKey: key, requestId: `b${String(i)}`, now: at(i) }))
          .admitted,
      );
    }
    // 1 steady + 2 burst = 3 admissions, then refusal.
    expect(outcomes).toEqual([true, true, true, false]);
  });

  it('limits estimated tokens independently of request count', async () => {
    const policy = await makePolicy({ maxRequests: 100, maxTokens: 1_000 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });

    const ok = await admit(pool, policy, {
      scopeKey: key,
      requestId: 't1',
      tokens: 900,
      now: at(0),
    });
    const refused = await admit(pool, policy, {
      scopeKey: key,
      requestId: 't2',
      tokens: 200,
      now: at(0),
    });
    expect(ok.admitted).toBe(true);
    // A few enormous calls must not slip through a request-count limit.
    expect({ admitted: refused.admitted, reason: refused.reason }).toEqual({
      admitted: false,
      reason: 'token_limit',
    });
  });

  it('re-answers a redelivered request instead of consuming a second admission', async () => {
    // Temporal delivers activities at least once. Without this, a redelivery would silently multiply the
    // effective rate — the limiter would be counting deliveries, not requests.
    const policy = await makePolicy({ maxRequests: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });

    const first = await admit(pool, policy, { scopeKey: key, requestId: 'dup', now: at(0) });
    const replay = await admit(pool, policy, { scopeKey: key, requestId: 'dup', now: at(5_000) });
    expect(first.admitted).toBe(true);
    expect({ admitted: replay.admitted, reason: replay.reason }).toEqual({
      admitted: true,
      reason: 'admitted_replay',
    });
    const counters = await rateLimitCounters(pool, policy, { scopeKey: key, now: at(5_000) });
    expect(counters.requests).toBe(1);
  });

  it('counts rejections for observability without admitting them', async () => {
    const policy = await makePolicy({ maxRequests: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    await admit(pool, policy, { scopeKey: key, requestId: 'x1', now: at(0) });
    await admit(pool, policy, { scopeKey: key, requestId: 'x2', now: at(0) });
    await admit(pool, policy, { scopeKey: key, requestId: 'x3', now: at(0) });
    const counters = await rateLimitCounters(pool, policy, { scopeKey: key, now: at(0) });
    expect({ requests: counters.requests, rejected: counters.rejected }).toEqual({
      requests: 1,
      rejected: 2,
    });
  });

  // -------------------------------------------------------------------------------------------------
  // isolation between scopes
  // -------------------------------------------------------------------------------------------------

  it('isolates limits by provider, by model and by workspace', async () => {
    const perProvider = await makePolicy({ provider: 'replay', maxRequests: 1 });
    const key = scopeKeyFor(perProvider, { provider: 'replay', operationClass: 'provider_call' });
    await admit(pool, perProvider, { scopeKey: key, requestId: 'p1', now: at(0) });
    expect(
      (await admit(pool, perProvider, { scopeKey: key, requestId: 'p2', now: at(0) })).admitted,
    ).toBe(false);

    // A different provider resolves to a different policy entirely, so it is unaffected.
    const other = await makePolicy({ provider: 'mock', maxRequests: 1 });
    const otherKey = scopeKeyFor(other, { provider: 'mock', operationClass: 'provider_call' });
    expect(
      (await admit(pool, other, { scopeKey: otherKey, requestId: 'p3', now: at(0) })).admitted,
    ).toBe(true);

    // A workspace-scoped policy counts per workspace: the scope key differs, so tenant B is unaffected
    // by tenant A exhausting its own allowance.
    const scoped = await makePolicy({ workspaceScoped: true, provider: 'shared', maxRequests: 1 });
    const keyA = scopeKeyFor(scoped, {
      workspaceId,
      provider: 'shared',
      operationClass: 'provider_call',
    });
    const keyB = scopeKeyFor(scoped, {
      workspaceId: '00000000-0000-0000-0000-0000000000bb',
      provider: 'shared',
      operationClass: 'provider_call',
    });
    expect(keyA).not.toBe(keyB);
    await admit(pool, scoped, { scopeKey: keyA, requestId: 'w1', now: at(0) });
    expect(
      (await admit(pool, scoped, { scopeKey: keyA, requestId: 'w2', now: at(0) })).admitted,
    ).toBe(false);
    expect(
      (await admit(pool, scoped, { scopeKey: keyB, requestId: 'w3', now: at(0) })).admitted,
    ).toBe(true);
  });

  it('resolves the most specific policy for a call', async () => {
    await makePolicy({ provider: null, modelId: null, maxRequests: 5 });
    const specific = await makePolicy({
      workspaceScoped: true,
      provider: 'replay',
      modelId: 'model-a',
      maxRequests: 1,
    });
    const resolved = await resolveRateLimitPolicy(pool, {
      workspaceId,
      provider: 'replay',
      modelId: 'model-a',
      operationClass: 'provider_call',
    });
    expect(resolved?.id).toBe(specific.id);

    // Nothing matches an operation class with no policy, and "no policy" must mean "not limited"
    // rather than "refused".
    const none = await resolveRateLimitPolicy(pool, {
      workspaceId,
      provider: 'replay',
      operationClass: 'api_read',
    });
    expect(none).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------------
  // concurrency slots
  // -------------------------------------------------------------------------------------------------

  it('grants slots up to the concurrency limit and refuses the next', async () => {
    const policy = await makePolicy({ maxRequests: null, maxConcurrent: 2 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    const acquire = (id: string): Promise<unknown> =>
      acquireSlot(pool, policy, {
        scopeKey: key,
        requestId: id,
        holder: 'w1',
        ttlSeconds: 60,
        now: at(0),
      });
    expect(await acquire('s1')).toBeDefined();
    expect(await acquire('s2')).toBeDefined();
    expect(await acquire('s3')).toBeUndefined();

    // Releasing frees exactly one slot.
    expect(
      await releaseSlot(pool, policy, { scopeKey: key, requestId: 's1', now: at(1_000) }),
    ).toBe(true);
    expect(await acquire('s4')).toBeDefined();
  });

  it('gives only one of two concurrent transactions the final slot', async () => {
    // The real race. Both transactions open, both look for free capacity, and the database — not an
    // application check between a read and a write — decides. Synchronisation is the transactions
    // themselves: the second blocks on the advisory lock until the first commits.
    const policy = await makePolicy({ maxRequests: null, maxConcurrent: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });

    const results = await Promise.all([
      withTransaction(pool, (client) =>
        acquireSlot(client, policy, {
          scopeKey: key,
          requestId: 'race-a',
          holder: 'worker-a',
          ttlSeconds: 60,
          now: at(0),
        }),
      ),
      withTransaction(pool, (client) =>
        acquireSlot(client, policy, {
          scopeKey: key,
          requestId: 'race-b',
          holder: 'worker-b',
          ttlSeconds: 60,
          now: at(0),
        }),
      ),
    ]);
    const granted = results.filter((r) => r !== undefined);
    expect(granted.length).toBe(1);

    const live = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM rate_limit_slots
        WHERE policy_id = $1 AND released_at IS NULL`,
      [policy.id],
    );
    expect(live.rows[0]?.n).toBe('1');
  });

  it('reclaims a slot whose holder died, by deadline rather than by decrement', async () => {
    // A decrement can be lost forever when the process holding the slot is killed. A deadline cannot.
    const policy = await makePolicy({ maxRequests: null, maxConcurrent: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    await acquireSlot(pool, policy, {
      scopeKey: key,
      requestId: 'dead-worker',
      holder: 'killed',
      ttlSeconds: 30,
      now: at(0),
    });
    // Still held 29 s later: capacity is genuinely in use.
    expect(
      await acquireSlot(pool, policy, {
        scopeKey: key,
        requestId: 'next',
        holder: 'w2',
        ttlSeconds: 30,
        now: at(29_000),
      }),
    ).toBeUndefined();
    // Past the deadline the abandoned slot is reclaimed without any action from the dead process.
    expect(
      await acquireSlot(pool, policy, {
        scopeKey: key,
        requestId: 'next',
        holder: 'w2',
        ttlSeconds: 30,
        now: at(31_000),
      }),
    ).toBeDefined();
  });

  it('is idempotent for duplicate acquisition and duplicate release', async () => {
    const policy = await makePolicy({ maxRequests: null, maxConcurrent: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    const first = await acquireSlot(pool, policy, {
      scopeKey: key,
      requestId: 'idem',
      holder: 'w',
      ttlSeconds: 60,
      now: at(0),
    });
    const again = await acquireSlot(pool, policy, {
      scopeKey: key,
      requestId: 'idem',
      holder: 'w',
      ttlSeconds: 60,
      now: at(1_000),
    });
    // The same request gets its own slot back with the deadline extended — it does not consume a second.
    expect(again?.id).toBe(first?.id);
    expect(again?.expiresAt.getTime()).toBeGreaterThan(first?.expiresAt.getTime() ?? 0);

    expect(
      await releaseSlot(pool, policy, { scopeKey: key, requestId: 'idem', now: at(2_000) }),
    ).toBe(true);
    // A cancellation path that runs twice must not error and must not release someone else's slot.
    expect(
      await releaseSlot(pool, policy, { scopeKey: key, requestId: 'idem', now: at(3_000) }),
    ).toBe(false);
  });

  it('leaves no slot reserved when a cancelled request releases it', async () => {
    const policy = await makePolicy({ maxRequests: null, maxConcurrent: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    await acquireSlot(pool, policy, {
      scopeKey: key,
      requestId: 'cancelled',
      holder: 'w',
      ttlSeconds: 60,
      now: at(0),
    });
    await releaseSlot(pool, policy, { scopeKey: key, requestId: 'cancelled', now: at(10) });
    const counters = await rateLimitCounters(pool, policy, { scopeKey: key, now: at(10) });
    expect(counters.liveSlots).toBe(0);
  });

  it('rolls back an admission when its transaction rolls back', async () => {
    // The limiter must not charge an admission to a unit of work that never happened.
    const policy = await makePolicy({ maxRequests: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    await expect(
      withTransaction(pool, async (client) => {
        await admit(client, policy, { scopeKey: key, requestId: 'rb', now: at(0) });
        throw new Error('caller failed after admission');
      }),
    ).rejects.toThrow('caller failed after admission');

    const counters = await rateLimitCounters(pool, policy, { scopeKey: key, now: at(0) });
    expect(counters.requests).toBe(0);
    expect(
      (await admit(pool, policy, { scopeKey: key, requestId: 'after', now: at(0) })).admitted,
    ).toBe(true);
  });

  // -------------------------------------------------------------------------------------------------
  // bounded, cancellation-aware waiting
  // -------------------------------------------------------------------------------------------------

  it('waits exactly until the next window rather than polling, then succeeds', async () => {
    const policy = await makePolicy({ windowSeconds: 10, maxRequests: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    await admit(pool, policy, { scopeKey: key, requestId: 'fill', now: at(0) });

    let current = at(1_000);
    const sleeps: number[] = [];
    const result = await waitForAdmission(pool, policy, {
      scopeKey: key,
      requestId: 'waiter',
      clock: () => current,
      maxWaitMs: 60_000,
      // The "sleep" advances the injected clock: deterministic, and no real time passes.
      sleep: async (ms) => {
        sleeps.push(ms);
        current = new Date(current.getTime() + ms);
      },
    });
    expect(result.admitted).toBe(true);
    // One wait, of exactly the window's remaining 9 s. More than one entry would be a polling loop.
    expect(sleeps).toEqual([9_000]);
  });

  it('gives up within its bound instead of waiting forever', async () => {
    const policy = await makePolicy({ windowSeconds: 3_600, maxRequests: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    await admit(pool, policy, { scopeKey: key, requestId: 'fill', now: at(0) });

    let current = at(0);
    const result = await waitForAdmission(pool, policy, {
      scopeKey: key,
      requestId: 'impatient',
      clock: () => current,
      maxWaitMs: 1_000,
      sleep: async (ms) => {
        current = new Date(current.getTime() + ms);
      },
    });
    // The window has an hour left and the caller allowed one second: refuse rather than block.
    expect(result.admitted).toBe(false);
  });

  it('abandons the wait when the request is cancelled', async () => {
    const policy = await makePolicy({ windowSeconds: 600, maxRequests: 1 });
    const key = scopeKeyFor(policy, { provider: 'replay', operationClass: 'provider_call' });
    await admit(pool, policy, { scopeKey: key, requestId: 'fill', now: at(0) });

    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForAdmission(pool, policy, {
        scopeKey: key,
        requestId: 'cancelled-wait',
        clock: () => at(0),
        maxWaitMs: 60_000,
        signal: controller.signal,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/cancelled/);
  });
});
