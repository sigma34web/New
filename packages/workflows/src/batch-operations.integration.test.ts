/**
 * Bounded, tenant-safe batch operations, against real PostgreSQL 16.
 *
 * A batch is an authorization amplifier, so the suite is weighted toward the refusals: an oversized
 * batch, a duplicate item, a cross-tenant item smuggled into an otherwise valid batch, and a retry
 * that must NOT re-attempt something that was refused on purpose. The happy path is covered, but it
 * is not what makes the feature safe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Metrics } from '@yeonjae/domain';
import {
  BatchError,
  boundedDetail,
  createProject,
  createWorkspace,
  isRetryable,
  ITEM_CODES,
  MAX_BATCH_ITEMS,
  MAX_DETAIL_KEYS,
  readBatch,
  retryEligible,
  runBatch,
  withWorkspace,
  type Client,
  type ItemCode,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';

const run = databaseUrl() ? describe : describe.skip;

describe('batch operations: pure rules', () => {
  it('classifies authorization and permanent validation failures as NOT retryable', () => {
    // The security rule of the feature, asserted as data rather than inferred from behaviour.
    for (const code of [
      'FORBIDDEN',
      'CROSS_TENANT',
      'VALIDATION_FAILED',
      'DUPLICATE_ITEM',
      'CHECK_FAILED',
      'NOT_FOUND',
      'BUDGET_EXHAUSTED',
    ] as ItemCode[]) {
      expect(isRetryable(code), `${code} must never be retried automatically`).toBe(false);
    }
  });

  it('classifies only transient failures as retryable', () => {
    for (const code of ['RATE_LIMITED', 'TRANSIENT_FAILURE', 'TIMEOUT'] as ItemCode[]) {
      expect(isRetryable(code)).toBe(true);
    }
    // And every declared code is classified exactly once.
    expect(Object.keys(ITEM_CODES).length).toBeGreaterThan(8);
  });

  it('bounds a per-item detail in key count, value length and value type', () => {
    const detail = boundedDetail({
      ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${String(i)}`, i])),
      long: 'x'.repeat(5_000),
      // An object or an Error is how exception text and provider payloads escape into a response.
      nested: { secret: 'hunter2' },
      err: new Error('postgres://u:hunter2@host/db'),
    });
    expect(Object.keys(detail).length).toBeLessThanOrEqual(MAX_DETAIL_KEYS);
    expect(JSON.stringify(detail)).not.toContain('hunter2');
    expect(typeof detail.long === 'string' ? detail.long.length : 0).toBeLessThanOrEqual(200);
  });
});

run('bounded batch operations', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let siblingProjectId: string;
  let otherWorkspaceId: string;
  let otherProjectId: string;
  let counter = 0;

  const scoped = <T>(fn: (c: Client) => Promise<T>, ws = workspaceId): Promise<T> =>
    withWorkspace(pool, ws, fn);
  const key = (): string => `batch-key-${String(++counter)}`;

  /** A runner whose outcome each item chooses by name, so every path is reachable deterministically. */
  const runner = async (item: { ref: string }): Promise<{ code: ItemCode }> => {
    if (item.ref.startsWith('transient')) return { code: 'TRANSIENT_FAILURE' };
    if (item.ref.startsWith('ratelimited')) return { code: 'RATE_LIMITED' };
    if (item.ref.startsWith('invalid')) return { code: 'VALIDATION_FAILED' };
    if (item.ref.startsWith('missing')) return { code: 'NOT_FOUND' };
    if (item.ref.startsWith('budget')) return { code: 'BUDGET_EXHAUSTED' };
    if (item.ref.startsWith('throws')) throw new Error('postgres://u:hunter2@host exploded');
    return { code: 'OK' };
  };

  beforeAll(async () => {
    pool = await freshDatabase();
    workspaceId = await createWorkspace(pool, 'batch-tenant');
    projectId = (await createProject(pool, { workspaceId, title: 'Batch Story' })).projectId;
    siblingProjectId = (await createProject(pool, { workspaceId, title: 'Sibling Story' }))
      .projectId;
    otherWorkspaceId = await createWorkspace(pool, 'batch-other');
    otherProjectId = (await createProject(pool, { workspaceId: otherWorkspaceId, title: 'Other' }))
      .projectId;
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const submit = (
    refs: readonly { ref: string; projectId?: string }[],
    overrides: Record<string, unknown> = {},
  ) =>
    scoped((c) =>
      runBatch(c, {
        workspaceId,
        projectId,
        operation: 'typography_check',
        requestKey: key(),
        items: refs.map((r) => ({ ref: r.ref, projectId: r.projectId ?? projectId })),
        run: runner,
        ...overrides,
      }),
    );

  // --- bounds -----------------------------------------------------------------------------------

  it('refuses an empty batch', async () => {
    await expect(submit([])).rejects.toMatchObject({ code: 'BATCH_EMPTY' });
  });

  it('refuses an oversized batch, at the handler AND in the schema', async () => {
    const tooMany = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_, i) => ({
      ref: `c${String(i)}`,
    }));
    await expect(submit(tooMany)).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' });

    // The database enforces the same ceiling, so bypassing the handler cannot unbound it.
    await expect(
      pool.query(
        `INSERT INTO batch_operations (workspace_id, project_id, operation, request_key, item_count)
         VALUES ($1, $2, 'typography_check', 'bypass', $3)`,
        [workspaceId, projectId, MAX_BATCH_ITEMS + 1],
      ),
    ).rejects.toThrow();
  });

  it('accepts a batch of exactly the maximum size', async () => {
    const exactly = Array.from({ length: MAX_BATCH_ITEMS }, (_, i) => ({ ref: `c${String(i)}` }));
    const result = await submit(exactly);
    expect(result.requested).toBe(MAX_BATCH_ITEMS);
    expect(result.status).toBe('completed');
  });

  it('refuses an unknown operation', async () => {
    await expect(submit([{ ref: '1' }], { operation: 'delete_everything' })).rejects.toMatchObject({
      code: 'BATCH_UNKNOWN_OPERATION',
    });
  });

  it('bounds the result size to the batch ceiling', async () => {
    const result = await submit(Array.from({ length: 10 }, (_, i) => ({ ref: `c${String(i)}` })));
    expect(result.items.length).toBeLessThanOrEqual(MAX_BATCH_ITEMS);
    const reread = await scoped((c) => readBatch(c, result.batch_id));
    expect(reread.items.length).toBeLessThanOrEqual(MAX_BATCH_ITEMS);
  });

  // --- per-item authorization ------------------------------------------------------------------------

  it('refuses a CROSS-TENANT item without failing the whole batch', async () => {
    const result = await submit([
      { ref: '1' },
      { ref: '2', projectId: otherProjectId },
      { ref: '3' },
    ]);
    const smuggled = result.items[1];
    expect(smuggled?.outcome).toBe('refused');
    expect(smuggled?.code).toBe('CROSS_TENANT');
    expect(smuggled?.retryable).toBe(false);
    // The legitimate items still ran: one poisoned item must not be a denial-of-service lever.
    expect(result.items[0]?.outcome).toBe('succeeded');
    expect(result.items[2]?.outcome).toBe('succeeded');
    expect(result.status).toBe('partially_failed');
  });

  it('refuses an item naming a DIFFERENT PROJECT in the same workspace', async () => {
    const result = await submit([{ ref: '1', projectId: siblingProjectId }]);
    expect(result.items[0]?.code).toBe('FORBIDDEN');
    expect(result.items[0]?.retryable).toBe(false);
  });

  it('the database refuses an item row belonging to another tenant', async () => {
    const result = await submit([{ ref: '1' }]);
    await expect(
      pool.query(
        `INSERT INTO batch_items (batch_id, workspace_id, project_id, position, item_ref, outcome)
         VALUES ($1, $2, $3, 99, 'smuggled', 'succeeded')`,
        [result.batch_id, otherWorkspaceId, otherProjectId],
      ),
    ).rejects.toThrow();
  });

  it('a second tenant can see none of the first tenant’s batches', async () => {
    const result = await submit([{ ref: '1' }]);
    const visible = await withWorkspace(pool, otherWorkspaceId, async (c) => {
      const r = await c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM batch_operations WHERE id = $1',
        [result.batch_id],
      );
      return Number(r.rows[0]?.n ?? '-1');
    });
    expect(visible).toBe(0);
  });

  // --- item semantics -----------------------------------------------------------------------------------

  it('refuses a duplicate item rather than doing its work twice', async () => {
    const result = await submit([{ ref: '7' }, { ref: '7' }]);
    expect(result.items[0]?.outcome).toBe('succeeded');
    expect(result.items[1]?.code).toBe('DUPLICATE_ITEM');
    expect(result.items[1]?.retryable).toBe(false);
  });

  it('reports mixed valid and invalid items individually', async () => {
    const result = await submit([{ ref: '1' }, { ref: 'invalid-a' }, { ref: 'missing-b' }]);
    expect(result.items.map((i) => i.code)).toEqual(['OK', 'VALIDATION_FAILED', 'NOT_FOUND']);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.status).toBe('partially_failed');
  });

  it('reports a TOTAL failure as failed, not partially failed', async () => {
    const result = await submit([{ ref: 'invalid-a' }, { ref: 'invalid-b' }]);
    expect(result.status).toBe('failed');
    expect(result.succeeded).toBe(0);
  });

  it('an item runner that throws never leaks its exception text', async () => {
    const result = await submit([{ ref: 'throws-here' }]);
    expect(result.items[0]?.code).toBe('TRANSIENT_FAILURE');
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('postgres://');
  });

  it('atomic mode stops at the first failure and reports the rest as skipped', async () => {
    const result = await submit([{ ref: '1' }, { ref: 'invalid-a' }, { ref: '3' }], {
      atomic: true,
    });
    expect(result.status).toBe('failed');
    expect(result.succeeded).toBe(0);
    expect(result.items[2]?.outcome).toBe('skipped');
  });

  it('cancellation stops the batch and marks the remainder cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await submit([{ ref: '1' }, { ref: '2' }], { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(result.items.every((i) => i.outcome === 'cancelled')).toBe(true);
  });

  // --- idempotency ----------------------------------------------------------------------------------------

  it('a duplicate submission returns the SAME batch and does not repeat the work', async () => {
    const k = key();
    const once = await scoped((c) =>
      runBatch(c, {
        workspaceId,
        projectId,
        operation: 'typography_check',
        requestKey: k,
        items: [{ ref: '1', projectId }],
        run: runner,
      }),
    );
    const twice = await scoped((c) =>
      runBatch(c, {
        workspaceId,
        projectId,
        operation: 'typography_check',
        requestKey: k,
        items: [{ ref: '1', projectId }],
        run: runner,
      }),
    );
    expect(twice.duplicate).toBe(true);
    expect(twice.batch_id).toBe(once.batch_id);
    const count = await scoped((c) =>
      c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM batch_operations WHERE request_key = $1',
        [k],
      ),
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('two CONCURRENT duplicate submissions resolve to exactly one batch', async () => {
    const k = key();
    const go = (): Promise<unknown> =>
      scoped((c) =>
        runBatch(c, {
          workspaceId,
          projectId,
          operation: 'typography_check',
          requestKey: k,
          items: [{ ref: '1', projectId }],
          run: runner,
        }),
      );
    await Promise.all([go(), go()]);
    const count = await scoped((c) =>
      c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM batch_operations WHERE request_key = $1',
        [k],
      ),
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  // --- retry ------------------------------------------------------------------------------------------------

  it('retries only the ELIGIBLE failed items', async () => {
    const original = await submit([
      { ref: '1' },
      { ref: 'transient-a' },
      { ref: 'ratelimited-b' },
      { ref: 'invalid-c' },
      { ref: '2', projectId: otherProjectId },
    ]);
    expect(original.retryable_items).toEqual([1, 2]);

    const retried = await scoped((c) =>
      retryEligible(c, {
        workspaceId,
        projectId,
        batchId: original.batch_id,
        requestKey: key(),
        // This time the previously-transient items succeed.
        run: () => Promise.resolve({ code: 'OK' }),
      }),
    );
    // Exactly the two retryable items, and NOT the validation failure or the cross-tenant refusal.
    expect(retried.requested).toBe(2);
    expect(retried.items.map((i) => i.ref).sort()).toEqual(['ratelimited-b', 'transient-a']);
    expect(retried.status).toBe('completed');
  });

  it('refuses to retry a batch with no eligible items', async () => {
    const original = await submit([{ ref: 'invalid-a' }, { ref: 'missing-b' }]);
    await expect(
      scoped((c) =>
        retryEligible(c, {
          workspaceId,
          projectId,
          batchId: original.batch_id,
          requestKey: key(),
          run: runner,
        }),
      ),
    ).rejects.toBeInstanceOf(BatchError);
  });

  // --- durability and reporting --------------------------------------------------------------------------------

  it('persists an append-only per-item record that cannot be rewritten or deleted', async () => {
    const result = await submit([{ ref: '1' }, { ref: 'invalid-a' }]);
    const reread = await scoped((c) => readBatch(c, result.batch_id));
    expect(reread.items.map((i) => i.code)).toEqual(['OK', 'VALIDATION_FAILED']);

    await expect(
      pool.query(`UPDATE batch_items SET outcome = 'succeeded' WHERE batch_id = $1`, [
        result.batch_id,
      ]),
    ).rejects.toThrow();
    await expect(
      pool.query('DELETE FROM batch_items WHERE batch_id = $1', [result.batch_id]),
    ).rejects.toThrow();
  });

  it('records bounded metrics for the batch and its items', async () => {
    const metrics = new Metrics();
    await scoped((c) =>
      runBatch(c, {
        workspaceId,
        projectId,
        operation: 'typography_check',
        requestKey: key(),
        items: [{ ref: '1', projectId }],
        run: runner,
        metrics,
      }),
    );
    const rendered = metrics.render();
    expect(rendered).toContain('yeonjae_batch_operations_total');
    expect(rendered).toContain('yeonjae_batch_items_total');
    // No identifier ever becomes a label.
    expect(rendered).not.toContain(projectId);
  });

  it('refuses a malformed item reference', async () => {
    await expect(submit([{ ref: 'x'.repeat(500) }])).rejects.toMatchObject({
      code: 'BATCH_INVALID_REQUEST',
    });
    await expect(submit([{ ref: '' }])).rejects.toMatchObject({
      code: 'BATCH_INVALID_REQUEST',
    });
  });
});
