/**
 * Shared provider admission (the adapter the gateway calls before every paid attempt).
 *
 * The properties under test are the ones that only fail when the process count is greater than one, plus
 * the unwind behaviour that keeps a refusal from stranding resources. Time is injected; there is no
 * `sleep()` here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  migrate,
  NoOpAdmission,
  PgProviderAdmission,
  rateLimitCounters,
  resetDatabase,
  scopeKeyFor,
  type Pool,
  type RateLimitPolicyRow,
} from './index.js';
import { databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

const T0 = new Date('2026-02-01T00:00:00.000Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

run('shared provider admission', () => {
  let pool: Pool;
  let workspaceId: string;

  const makePolicy = async (input: {
    maxRequests?: number | null | undefined;
    maxConcurrent?: number | null | undefined;
    maxTokens?: number | null | undefined;
    windowSeconds?: number | undefined;
  }): Promise<RateLimitPolicyRow> => {
    const r = await pool.query<RateLimitPolicyRow>(
      `INSERT INTO rate_limit_policies
         (workspace_id, provider, model_id, operation_class, window_seconds,
          max_requests, max_tokens, max_concurrent, burst_requests)
       VALUES ($1, 'replay', NULL, 'provider_call', $2, $3, $4, $5, 0) RETURNING *`,
      [
        workspaceId,
        input.windowSeconds ?? 60,
        input.maxRequests === undefined ? 2 : input.maxRequests,
        input.maxTokens === undefined ? null : input.maxTokens,
        input.maxConcurrent === undefined ? null : input.maxConcurrent,
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

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM rate_limit_slots');
    await pool.query('DELETE FROM rate_limit_windows');
    await pool.query('DELETE FROM rate_limit_policies');
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('admission') RETURNING id`,
    );
    const id = ws.rows[0]?.id;
    if (!id) throw new Error('workspace insert returned no row');
    workspaceId = id;
  });

  const controller = (holder: string, now: () => Date): PgProviderAdmission =>
    new PgProviderAdmission(pool, { holder, clock: now, maxWaitMs: 0 });

  it('an unconfigured scope is unlimited rather than refused', async () => {
    const grant = await controller('w1', () => T0).admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'req-1',
    });
    expect(grant.admitted).toBe(true);
    expect(grant.reason).toBe('unlimited');
    // Releasing an unlimited grant is a no-op, not an error.
    await expect(grant.release()).resolves.toBeUndefined();
  });

  it('refuses past the request limit and reports the exact reopen delay', async () => {
    await makePolicy({ maxRequests: 2 });
    const c = controller('w1', () => T0);
    for (const id of ['a', 'b']) {
      const ok = await c.admit({
        workspaceId,
        provider: 'replay',
        modelId: 'replay-p',
        requestId: id,
      });
      expect(ok.admitted).toBe(true);
      await ok.release();
    }
    const refused = await c.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'c',
    });
    expect(refused.admitted).toBe(false);
    expect(refused.reason).toBe('request_limit');
    expect(refused.retryAfterMs).toBe(60_000);
  });

  it('two independent controllers share one limit', async () => {
    await makePolicy({ maxRequests: 1 });
    const first = await controller('w1', () => T0).admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'p1',
    });
    expect(first.admitted).toBe(true);
    // A DIFFERENT holder, as a second worker would be. An in-process limiter would admit this.
    const second = await controller('w2', () => T0).admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'p2',
    });
    expect(second.admitted).toBe(false);
  });

  it('a redelivered request re-reads its own decision instead of consuming a second admission', async () => {
    const policy = await makePolicy({ maxRequests: 2 });
    const c = controller('w1', () => T0);
    const scopeKey = scopeKeyFor(policy, {
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      operationClass: 'provider_call',
    });
    const once = await c.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'dup',
    });
    await once.release();
    const again = await c.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'dup',
    });
    expect(again.admitted).toBe(true);
    expect(again.reason).toBe('admitted_replay');
    const counters = await rateLimitCounters(pool, policy, { scopeKey, now: T0 });
    expect(counters.requests).toBe(1);
  });

  it('refuses when concurrency is exhausted and leaves no window allowance spent', async () => {
    const policy = await makePolicy({ maxRequests: 100, maxConcurrent: 1 });
    const c = controller('w1', () => T0);
    const scopeKey = scopeKeyFor(policy, {
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      operationClass: 'provider_call',
    });
    const held = await c.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'held',
    });
    expect(held.admitted).toBe(true);
    const blocked = await controller('w2', () => T0).admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'blocked',
    });
    expect(blocked.admitted).toBe(false);
    expect(blocked.reason).toBe('concurrency_exhausted');
    // The refusal consumed NO rate allowance: the lease is taken before the un-undoable counter.
    const counters = await rateLimitCounters(pool, policy, { scopeKey, now: T0 });
    expect(counters.requests).toBe(1);
    await held.release();
    const after = await controller('w2', () => T0).admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'after',
    });
    expect(after.admitted).toBe(true);
  });

  it('unwinds the concurrency lease when the rate window refuses', async () => {
    const policy = await makePolicy({ maxRequests: 1, maxConcurrent: 4 });
    const c = controller('w1', () => T0);
    const scopeKey = scopeKeyFor(policy, {
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      operationClass: 'provider_call',
    });
    const first = await c.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'one',
    });
    await first.release();
    const refused = await c.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'two',
    });
    expect(refused.admitted).toBe(false);
    expect(refused.reason).toBe('request_limit');
    // Partial acquisition unwound: no live slot is stranded by the refused call.
    const counters = await rateLimitCounters(pool, policy, { scopeKey, now: T0 });
    expect(counters.liveSlots).toBe(0);
  });

  it('releases the lease when a cancelled wait aborts, stranding nothing', async () => {
    const policy = await makePolicy({ maxRequests: 0, maxConcurrent: 2 });
    const scopeKey = scopeKeyFor(policy, {
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      operationClass: 'provider_call',
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      new PgProviderAdmission(pool, {
        holder: 'w1',
        clock: () => T0,
        maxWaitMs: 60_000,
      }).admit({
        workspaceId,
        provider: 'replay',
        modelId: 'replay-p',
        requestId: 'cancelled',
        signal: aborted.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    const counters = await rateLimitCounters(pool, policy, { scopeKey, now: T0 });
    expect(counters.liveSlots).toBe(0);
  });

  it('a dead holder cannot strand a slot permanently: the lease expires', async () => {
    const policy = await makePolicy({ maxRequests: 100, maxConcurrent: 1 });
    const scopeKey = scopeKeyFor(policy, {
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      operationClass: 'provider_call',
    });
    // A worker takes a slot with a short TTL and then "dies": it never releases.
    const dead = new PgProviderAdmission(pool, {
      holder: 'dead-worker',
      clock: () => T0,
      leaseTtlSeconds: 30,
      maxWaitMs: 0,
    });
    const held = await dead.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'stranded',
    });
    expect(held.admitted).toBe(true);

    const blockedNow = await controller('survivor', () => at(1_000)).admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 's1',
    });
    expect(blockedNow.admitted).toBe(false);

    // Past the lease deadline the survivor proceeds; recovery needs no cleanup pass and no sleep.
    const afterExpiry = await controller('survivor', () => at(31_000)).admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 's2',
    });
    expect(afterExpiry.admitted).toBe(true);
    const counters = await rateLimitCounters(pool, policy, { scopeKey, now: at(31_000) });
    expect(counters.liveSlots).toBe(1);
  });

  it('a token ceiling refuses an oversized call', async () => {
    await makePolicy({ maxRequests: 100, maxTokens: 1_000 });
    const grant = await controller('w1', () => T0).admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'big',
      tokens: 5_000,
    });
    expect(grant.admitted).toBe(false);
    expect(grant.reason).toBe('token_limit');
  });

  it('one workspace cannot consume another workspace allowance', async () => {
    await makePolicy({ maxRequests: 1 });
    const other = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('other') RETURNING id`,
    );
    const otherId = other.rows[0]?.id;
    if (!otherId) throw new Error('workspace insert returned no row');
    const c = controller('w1', () => T0);
    const mine = await c.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'mine',
    });
    expect(mine.admitted).toBe(true);
    const refusedMine = await c.admit({
      workspaceId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'mine-2',
    });
    expect(refusedMine.admitted).toBe(false);
    // The neighbour's own allowance is untouched by my exhaustion.
    const theirs = await c.admit({
      workspaceId: otherId,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: 'theirs',
    });
    expect(theirs.admitted).toBe(true);
  });

  it('NoOpAdmission is an explicit opt-out, not a silent default', async () => {
    await makePolicy({ maxRequests: 0 });
    const grant = await new NoOpAdmission().admit();
    expect(grant.admitted).toBe(true);
    expect(grant.reason).toBe('unlimited');
  });
});
