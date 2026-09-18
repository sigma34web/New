/**
 * Bounded, tenant-safe batch operations.
 *
 * WHY BATCHING IS DANGEROUS AND THEREFORE NARROW. A batch is an authorization amplifier: one request
 * that touches N things is one authorization decision that had better have been made N times. Every
 * rule below exists because the naive version of this feature gets one of them wrong.
 *
 *   * SIZE IS CAPPED, in the handler AND in the schema (migration 0018's CHECK). A cap enforced only
 *     in a handler is a cap a second caller does not have.
 *   * EVERY ITEM IS AUTHORIZED INDEPENDENTLY. The batch's project is not evidence about an item's
 *     project. An item naming another tenant's content is REFUSED, and — importantly — refusing it
 *     does not fail the whole batch, because an attacker could otherwise use one poisoned item to
 *     deny service to a legitimate batch.
 *   * ONLY NON-DESTRUCTIVE OPERATIONS. Every supported operation reads, checks or prepares. Nothing
 *     here accepts content, moves canon or deletes anything.
 *   * RETRY IS EARNED, NOT ASSUMED. An item is retryable only if its failure was transient. An
 *     authorization refusal and a permanent validation failure are never retryable, so an automatic
 *     retry cannot re-attempt something that was deliberately refused.
 *   * IDEMPOTENCY IS THE SAME SHAPE AS EVERYWHERE ELSE. `(workspace_id, request_key)` is unique, so a
 *     duplicated submission — including two concurrent ones — resolves to ONE batch and one set of
 *     results, and the work is not done or charged twice.
 */
import { METRIC, METRIC_HELP, type Metrics, safeLabelValue } from '@yeonjae/domain';
import { inClientTransaction, type Client } from './client.js';

/** The hard ceiling. Mirrored by a CHECK constraint in migration 0018. */
export const MAX_BATCH_ITEMS = 50;

export const BATCH_OPERATIONS = [
  'typography_check',
  'platform_format_check',
  'preview_prepare',
  'export_prepare',
  'retry_failed_job',
] as const;
export type BatchOperation = (typeof BATCH_OPERATIONS)[number];

export type BatchStatus = 'running' | 'completed' | 'partially_failed' | 'failed' | 'cancelled';
export type ItemOutcome = 'succeeded' | 'failed' | 'skipped' | 'refused' | 'cancelled';

/**
 * Closed per-item refusal codes, each classified as retryable or not.
 *
 * The classification is DATA rather than a conditional at the call site, because "which failures may
 * be retried" is a security decision and it must be reviewable in one place.
 */
export const ITEM_CODES = {
  OK: { retryable: false },
  NOT_FOUND: { retryable: false },
  FORBIDDEN: { retryable: false },
  CROSS_TENANT: { retryable: false },
  VALIDATION_FAILED: { retryable: false },
  DUPLICATE_ITEM: { retryable: false },
  CHECK_FAILED: { retryable: false },
  CANCELLED: { retryable: false },
  BUDGET_EXHAUSTED: { retryable: false },
  RATE_LIMITED: { retryable: true },
  TRANSIENT_FAILURE: { retryable: true },
  TIMEOUT: { retryable: true },
} as const;
export type ItemCode = keyof typeof ITEM_CODES;

export function isRetryable(code: ItemCode): boolean {
  return ITEM_CODES[code].retryable;
}

export const BATCH_ERROR_CODES = [
  'BATCH_EMPTY',
  'BATCH_TOO_LARGE',
  'BATCH_UNKNOWN_OPERATION',
  'BATCH_NOT_FOUND',
  'BATCH_CANCELLED',
  'BATCH_RATE_LIMITED',
  'BATCH_BUDGET_EXHAUSTED',
  'BATCH_INVALID_REQUEST',
] as const;
export type BatchErrorCode = (typeof BATCH_ERROR_CODES)[number];

export class BatchError extends Error {
  constructor(
    readonly code: BatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BatchError';
  }
}

export interface BatchItemRequest {
  /** What the item names. A chapter number, an export target: bounded text, never a payload. */
  readonly ref: string;
  /** The project the CALLER claims this item belongs to. Verified, never trusted. */
  readonly projectId: string;
}

export interface BatchItemResult {
  readonly position: number;
  readonly ref: string;
  readonly outcome: ItemOutcome;
  readonly code: ItemCode;
  readonly retryable: boolean;
  /** A bounded summary: counts and codes only. */
  readonly detail: Record<string, unknown>;
}

export interface BatchResult {
  readonly batch_id: string;
  readonly operation: BatchOperation;
  readonly status: BatchStatus;
  readonly requested: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly items: readonly BatchItemResult[];
  /** True when this call returned an EXISTING batch rather than running one. */
  readonly duplicate: boolean;
  readonly retryable_items: readonly number[];
}

/** Bound every per-item detail: an unbounded result is how a batch response becomes a leak channel. */
export const MAX_DETAIL_KEYS = 12;
export const MAX_DETAIL_VALUE_LENGTH = 200;

export function boundedDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (Object.keys(out).length >= MAX_DETAIL_KEYS) break;
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, MAX_DETAIL_VALUE_LENGTH);
    else if (Array.isArray(value))
      out[key] = value
        .slice(0, MAX_DETAIL_KEYS)
        .map((v) => (typeof v === 'string' ? v.slice(0, 64) : typeof v === 'number' ? v : null))
        .filter((v) => v !== null);
    // Anything else (an object, a function, an Error) is dropped: those are how exception text and
    // provider payloads escape into a response.
  }
  return out;
}

/** What a batch runner does to ONE already-authorized item. */
export type ItemRunner = (item: {
  readonly ref: string;
  readonly projectId: string;
  readonly position: number;
}) => Promise<{ code: ItemCode; detail?: Record<string, unknown> | undefined }>;

export interface RunBatchInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly operation: string;
  readonly requestKey: string;
  readonly items: readonly BatchItemRequest[];
  readonly run: ItemRunner;
  readonly userId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly metrics?: Metrics | undefined;
  /**
   * All-or-nothing semantics.
   *
   * Default is PER-ITEM: a batch of independent read-only checks has no reason to discard 49 valid
   * results because one item was not found. `atomic: true` is available for callers that genuinely
   * need it, and then a single failure records the whole batch as `failed` and no item is reported as
   * succeeded.
   */
  readonly atomic?: boolean | undefined;
  readonly now?: Date | undefined;
}

function record(
  metrics: Metrics | undefined,
  metric: string,
  operation: string,
  outcome: string,
): void {
  metrics?.increment(metric, METRIC_HELP[metric] ?? '', {
    operation_class: safeLabelValue(operation),
    outcome: safeLabelValue(outcome),
  });
}

/**
 * Run a bounded batch.
 *
 * Items run SEQUENTIALLY on purpose: a batch that fans out concurrently would multiply its own effect
 * on the shared limiter and the shared budget, which is precisely the pressure a limiter exists to
 * control. Bounded size plus sequential execution keeps a batch's cost predictable.
 */
export async function runBatch(client: Client, input: RunBatchInput): Promise<BatchResult> {
  const operation = BATCH_OPERATIONS.find((o) => o === input.operation);
  if (!operation)
    throw new BatchError('BATCH_UNKNOWN_OPERATION', 'that batch operation is not supported');
  if (input.requestKey.trim() === '' || input.requestKey.length > 255)
    throw new BatchError('BATCH_INVALID_REQUEST', 'the request key is missing or too long');
  if (input.items.length === 0) throw new BatchError('BATCH_EMPTY', 'the batch has no items');
  if (input.items.length > MAX_BATCH_ITEMS)
    throw new BatchError(
      'BATCH_TOO_LARGE',
      `a batch may contain at most ${String(MAX_BATCH_ITEMS)} items`,
    );
  for (const item of input.items) {
    if (item.ref.length === 0 || item.ref.length > 200)
      throw new BatchError('BATCH_INVALID_REQUEST', 'an item reference is empty or too long');
  }

  // Idempotency: an existing batch under this key is returned verbatim, including its item results.
  const prior = await client.query<{ id: string }>(
    'SELECT id FROM batch_operations WHERE workspace_id = $1 AND request_key = $2',
    [input.workspaceId, input.requestKey],
  );
  const priorId = prior.rows[0]?.id;
  if (priorId !== undefined) {
    record(input.metrics, METRIC.batchOperations, operation, 'duplicate');
    return { ...(await readBatch(client, priorId)), duplicate: true };
  }

  const created = await client.query<{ id: string }>(
    `INSERT INTO batch_operations
       (workspace_id, project_id, operation, request_key, status, item_count, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'running', $5, $6)
     ON CONFLICT (workspace_id, request_key) DO NOTHING
     RETURNING id`,
    [
      input.workspaceId,
      input.projectId,
      operation,
      input.requestKey,
      input.items.length,
      input.userId ?? null,
    ],
  );
  const batchId = created.rows[0]?.id;
  if (batchId === undefined) {
    // A CONCURRENT duplicate won the unique key. The other request owns the work; this one reports
    // its result rather than doing it again.
    const raced = await client.query<{ id: string }>(
      'SELECT id FROM batch_operations WHERE workspace_id = $1 AND request_key = $2',
      [input.workspaceId, input.requestKey],
    );
    const winner = raced.rows[0]?.id;
    if (winner === undefined)
      throw new BatchError('BATCH_NOT_FOUND', 'the batch could not be created');
    record(input.metrics, METRIC.batchOperations, operation, 'duplicate');
    return { ...(await readBatch(client, winner)), duplicate: true };
  }

  const results: BatchItemResult[] = [];
  const seen = new Set<string>();
  let cancelled = false;

  for (const [position, item] of input.items.entries()) {
    if (input.signal?.aborted === true || cancelled) {
      cancelled = true;
      results.push({
        position,
        ref: item.ref,
        outcome: 'cancelled',
        code: 'CANCELLED',
        retryable: false,
        detail: {},
      });
      continue;
    }

    // A duplicate item is REFUSED rather than run twice: running it twice would double the work and,
    // for any operation that reserves budget, double the charge.
    const key = `${item.projectId}\u0000${item.ref}`;
    if (seen.has(key)) {
      results.push({
        position,
        ref: item.ref,
        outcome: 'refused',
        code: 'DUPLICATE_ITEM',
        retryable: false,
        detail: {},
      });
      continue;
    }
    seen.add(key);

    // PER-ITEM AUTHORIZATION. An item naming a different project than the batch is refused here, and
    // the item's project is additionally re-read under RLS so a project from another workspace is
    // invisible rather than merely mismatched.
    if (item.projectId !== input.projectId) {
      const visible = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM projects WHERE id = $1',
        [item.projectId],
      );
      const sameTenant = Number(visible.rows[0]?.n ?? '0') > 0;
      results.push({
        position,
        ref: item.ref,
        outcome: 'refused',
        // A project in another WORKSPACE is CROSS_TENANT; one in the same workspace but a different
        // project is FORBIDDEN. Neither is retryable, and neither reveals which of the two it was to
        // an unauthorized caller beyond the code itself.
        code: sameTenant ? 'FORBIDDEN' : 'CROSS_TENANT',
        retryable: false,
        detail: {},
      });
      continue;
    }

    let outcome: BatchItemResult;
    try {
      const ran = await input.run({ ref: item.ref, projectId: item.projectId, position });
      outcome = {
        position,
        ref: item.ref,
        outcome: ran.code === 'OK' ? 'succeeded' : 'failed',
        code: ran.code,
        retryable: isRetryable(ran.code),
        detail: boundedDetail(ran.detail ?? {}),
      };
    } catch {
      // The thrown value is never inspected: an exception message is exactly the unbounded,
      // potentially sensitive text a batch result must not carry.
      outcome = {
        position,
        ref: item.ref,
        outcome: 'failed',
        code: 'TRANSIENT_FAILURE',
        retryable: true,
        detail: {},
      };
    }
    results.push(outcome);

    if (input.atomic === true && outcome.outcome !== 'succeeded') {
      // Atomic semantics: stop immediately and report the remainder as skipped rather than pretending
      // they were attempted.
      for (let i = position + 1; i < input.items.length; i++) {
        results.push({
          position: i,
          ref: input.items[i]?.ref ?? '',
          outcome: 'skipped',
          code: 'CANCELLED',
          retryable: false,
          detail: {},
        });
      }
      break;
    }
  }

  const atomicFailure = input.atomic === true && results.some((r) => r.outcome !== 'succeeded');
  const succeeded = atomicFailure ? 0 : results.filter((r) => r.outcome === 'succeeded').length;
  const failed = results.length - succeeded;
  const status: BatchStatus = cancelled
    ? 'cancelled'
    : atomicFailure || succeeded === 0
      ? 'failed'
      : failed === 0
        ? 'completed'
        : 'partially_failed';

  await inClientTransaction(client, async (tx) => {
    for (const result of results) {
      await tx.query(
        `INSERT INTO batch_items
           (batch_id, workspace_id, project_id, position, item_ref, outcome, code, retryable, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          batchId,
          input.workspaceId,
          input.projectId,
          result.position,
          result.ref,
          atomicFailure && result.outcome === 'succeeded' ? 'skipped' : result.outcome,
          result.code,
          result.retryable,
          JSON.stringify(result.detail),
        ],
      );
    }
    await tx.query(
      `UPDATE batch_operations
          SET status = $2, succeeded = $3, failed = $4, finished_at = $5
        WHERE id = $1`,
      [batchId, status, succeeded, failed, input.now ?? new Date()],
    );
  });

  record(input.metrics, METRIC.batchOperations, operation, status);
  for (const result of results) record(input.metrics, METRIC.batchItems, operation, result.outcome);

  return {
    batch_id: batchId,
    operation,
    status,
    requested: input.items.length,
    succeeded,
    failed,
    items: atomicFailure
      ? results.map((r) => (r.outcome === 'succeeded' ? { ...r, outcome: 'skipped' as const } : r))
      : results,
    duplicate: false,
    retryable_items: results.filter((r) => r.retryable).map((r) => r.position),
  };
}

/** Read a batch and its items back. Bounded by the batch's own size ceiling. */
export async function readBatch(client: Client, batchId: string): Promise<BatchResult> {
  const batch = await client.query<{
    id: string;
    operation: BatchOperation;
    status: BatchStatus;
    item_count: number;
    succeeded: number;
    failed: number;
  }>(
    'SELECT id, operation, status, item_count, succeeded, failed FROM batch_operations WHERE id = $1',
    [batchId],
  );
  const row = batch.rows[0];
  if (!row) throw new BatchError('BATCH_NOT_FOUND', 'the batch does not exist');
  const items = await client.query<{
    position: number;
    item_ref: string;
    outcome: ItemOutcome;
    code: ItemCode | null;
    retryable: boolean;
    detail: Record<string, unknown>;
  }>(
    `SELECT position, item_ref, outcome, code, retryable, detail
       FROM batch_items WHERE batch_id = $1 ORDER BY position LIMIT $2`,
    [batchId, MAX_BATCH_ITEMS],
  );
  const mapped = items.rows.map((i) => ({
    position: i.position,
    ref: i.item_ref,
    outcome: i.outcome,
    code: i.code ?? 'OK',
    retryable: i.retryable,
    detail: i.detail,
  }));
  return {
    batch_id: row.id,
    operation: row.operation,
    status: row.status,
    requested: row.item_count,
    succeeded: row.succeeded,
    failed: row.failed,
    items: mapped,
    duplicate: false,
    retryable_items: mapped.filter((i) => i.retryable).map((i) => i.position),
  };
}

/**
 * Retry only the ELIGIBLE failed items of a completed batch.
 *
 * "Eligible" means the original failure was classified retryable. A refusal — forbidden, cross-tenant,
 * validation, duplicate — is never retried, because retrying it would be an automatic second attempt
 * at something the system deliberately declined.
 */
export async function retryEligible(
  client: Client,
  input: {
    readonly workspaceId: string;
    readonly projectId: string;
    readonly batchId: string;
    readonly requestKey: string;
    readonly run: ItemRunner;
    readonly metrics?: Metrics | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<BatchResult> {
  const original = await readBatch(client, input.batchId);
  const eligible = original.items.filter((i) => i.retryable);
  if (eligible.length === 0)
    throw new BatchError('BATCH_INVALID_REQUEST', 'the batch has no retry-eligible items');
  return runBatch(client, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    operation: original.operation,
    requestKey: input.requestKey,
    items: eligible.map((i) => ({ ref: i.ref, projectId: input.projectId })),
    run: input.run,
    metrics: input.metrics,
    signal: input.signal,
  });
}
