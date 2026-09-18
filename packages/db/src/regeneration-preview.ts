/**
 * Deterministic regeneration previews.
 *
 * THE PROBLEM THIS SOLVES. Regenerating an accepted chapter is a destructive-looking action with no
 * undo at the reader's end, and until now there was no way to see WHAT a regeneration would produce
 * before committing to it. `regenerationPreview` in `packages/canon` reports which later chapters the
 * change would affect, which is impact, not content. This module produces the content itself, off to
 * one side, where it can be read and then accepted or thrown away.
 *
 * THE GUARANTEE THAT MATTERS. A preview cannot alter accepted canon or manuscript data. That is
 * structural, not procedural: everything this module writes goes into `regeneration_previews`, which
 * migration 0018 gives no write path into `manuscript_versions`, `chapters` or any canon table; the
 * table's own triggers make a resolved preview immutable; and `acceptPreview` performs an ORDINARY
 * manuscript-version write through the existing path rather than mutating anything in place. A preview
 * that reached acceptance is therefore indistinguishable, downstream, from a normal new draft — which
 * is exactly right, because it must still pass every gate a normal draft passes.
 *
 * WHY THE PROVENANCE FIELDS ARE MANDATORY. A proposal a reader cannot reproduce is a proposal a reader
 * has to take on trust. The row records the source version, the source content hash, the deterministic
 * seed, the simulator configuration, the context and retrieval summaries and the proposal's own hash,
 * so the same inputs can be replayed and compared.
 *
 * COST IS SIMULATED AND SAYS SO. `estimated_millicents` comes from the local simulator's token estimate
 * and the model's configured rate. It is never a provider charge, it is never booked as spend, and the
 * reserve/settle/release cycle it drives runs against the SHARED budget so a preview cannot quietly
 * spend outside the accounting every other call obeys.
 */
import { createHash } from 'node:crypto';
import { METRIC, METRIC_HELP, type Metrics, safeLabelValue } from '@yeonjae/domain';
import {
  asCanonError,
  inClientTransaction,
  rethrowCanon,
  type Client,
  type Pool,
} from './client.js';
import { acceptedChapter } from './retrieval.js';
import { createManuscriptVersion } from './repo.js';
import { release, reserve, settle } from './shared-budget.js';

type Queryable = Pool | Client;

export const PREVIEW_STATUSES = ['ready', 'accepted', 'discarded', 'cancelled', 'failed'] as const;
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

/** Closed refusal codes. A caller branches on these; no exception text is ever exposed. */
export const PREVIEW_ERROR_CODES = [
  'CHAPTER_NOT_FOUND',
  'SOURCE_NOT_ACCEPTED',
  'PREVIEW_NOT_FOUND',
  'PREVIEW_STALE',
  'PREVIEW_TERMINAL',
  'PREVIEW_CROSS_PROJECT',
  'SIMULATOR_FAILED',
  'BUDGET_EXHAUSTED',
  'CANCELLED',
  'INVALID_REQUEST',
] as const;
export type PreviewErrorCode = (typeof PREVIEW_ERROR_CODES)[number];

export class PreviewError extends Error {
  constructor(
    readonly code: PreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewError';
  }
}

export interface PreviewRow {
  id: string;
  workspace_id: string;
  project_id: string;
  chapter_id: string;
  source_manuscript_version_id: string;
  source_content_hash: string;
  request_key: string;
  status: PreviewStatus;
  simulator: Record<string, unknown>;
  seed: string | number;
  context_summary: Record<string, unknown>;
  retrieval_summary: Record<string, unknown>;
  proposed_text: string | null;
  proposed_content_hash: string | null;
  estimated_millicents: string | number;
  failure_code: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

/** The safe view. `proposed_text` is included deliberately — it is the point — but nothing else is. */
export interface PreviewView {
  readonly id: string;
  readonly project_id: string;
  readonly chapter_id: string;
  readonly status: PreviewStatus;
  readonly source_manuscript_version_id: string;
  readonly source_content_hash: string;
  readonly proposed_content_hash: string | null;
  readonly seed: number;
  readonly simulator: Record<string, unknown>;
  readonly context_summary: Record<string, unknown>;
  readonly retrieval_summary: Record<string, unknown>;
  readonly estimated_millicents: number;
  readonly cost_basis: 'simulated';
  readonly failure_code: string | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export function previewView(row: PreviewRow): PreviewView {
  return {
    id: row.id,
    project_id: row.project_id,
    chapter_id: row.chapter_id,
    status: row.status,
    source_manuscript_version_id: row.source_manuscript_version_id,
    source_content_hash: row.source_content_hash,
    proposed_content_hash: row.proposed_content_hash,
    seed: Number(row.seed),
    simulator: row.simulator,
    context_summary: row.context_summary,
    retrieval_summary: row.retrieval_summary,
    estimated_millicents: Number(row.estimated_millicents),
    // Stated in the payload, so no consumer can render this as a provider charge.
    cost_basis: 'simulated',
    failure_code: row.failure_code,
    created_at: row.created_at.toISOString(),
    resolved_at: row.resolved_at?.toISOString() ?? null,
  };
}

export function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text.normalize('NFC'), 'utf8').digest('hex')}`;
}

/**
 * A deterministic seed from the inputs that define the proposal.
 *
 * Derived rather than random: two identical requests must produce the same proposal, which is what
 * makes a duplicate delivery genuinely idempotent rather than merely deduplicated after the fact.
 */
export function seedFor(input: {
  projectId: string;
  chapterId: string;
  sourceContentHash: string;
  instruction: string;
}): number {
  const digest = createHash('sha256')
    .update(
      `${input.projectId}\u0000${input.chapterId}\u0000${input.sourceContentHash}\u0000${input.instruction}`,
    )
    .digest();
  // 48 bits: comfortably inside a safe integer and inside PostgreSQL's bigint.
  return digest.readUIntBE(0, 6);
}

/** The deterministic local generator a preview may use. No network, no provider, no credential. */
export interface PreviewSimulator {
  readonly name: string;
  readonly version: string;
  /** Must be a pure function of its arguments: the same inputs always produce the same text. */
  generate(input: {
    readonly sourceText: string;
    readonly instruction: string;
    readonly seed: number;
  }): string;
  /** A simulated token estimate. Used for the cost estimate; never a provider-reported number. */
  estimateTokens?(text: string): number;
}

/**
 * The default simulator: a deterministic, obviously-local transformation.
 *
 * It is intentionally simple and intentionally NOT an imitation of model output. Its purpose is to
 * exercise the preview lifecycle — provenance, hashing, staleness, budget, acceptance — with content
 * that is reproducible byte for byte. Real regenerated prose requires a live provider, which this
 * tranche does not have and does not pretend to.
 */
export class DeterministicPreviewSimulator implements PreviewSimulator {
  readonly name = 'deterministic_local';
  readonly version = '1.0';

  generate(input: { sourceText: string; instruction: string; seed: number }): string {
    const paragraphs = input.sourceText
      .normalize('NFC')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    // A stable per-paragraph rewrite keyed by the seed: reversible to inspect, deterministic to verify.
    const rewritten = paragraphs.map((paragraph, i) => {
      const marker = ((input.seed + i) % 997).toString(36);
      return `${paragraph} [simulated revision ${marker}]`;
    });
    return `${rewritten.join('\n\n')}\n`.normalize('NFC');
  }

  estimateTokens(text: string): number {
    // The same rough estimator the mock provider uses: four characters per token.
    return Math.ceil(text.length / 4);
  }
}

export interface CreatePreviewInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly chapterNo: number;
  readonly instruction: string;
  /** Idempotency key. The same key in the same workspace always resolves to the same preview. */
  readonly requestKey: string;
  readonly simulator?: PreviewSimulator | undefined;
  readonly userId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Millicents per 1,000 simulated tokens. Configuration, not a provider price list. */
  readonly millicentsPerKiloToken?: number | undefined;
  /** When set, the estimate is reserved against this shared budget policy before generating. */
  readonly budgetPolicyId?: string | undefined;
  readonly metrics?: Metrics | undefined;
  readonly contextSummary?: Record<string, unknown> | undefined;
  readonly retrievalSummary?: Record<string, unknown> | undefined;
  readonly now?: Date | undefined;
}

export interface CreatePreviewResult {
  readonly preview: PreviewView;
  /** The proposed text. Returned to the caller; never written to accepted storage. */
  readonly proposed_text: string;
  /** The accepted text it is proposed to replace, so a caller can present the change. */
  readonly source_text: string;
  /** True when this call returned an EXISTING preview rather than creating one. */
  readonly duplicate: boolean;
}

const DEFAULT_RATE_MILLICENTS_PER_KTOKEN = 200;

function record(metrics: Metrics | undefined, verb: string, outcome: string): void {
  metrics?.increment(METRIC.previewOperations, METRIC_HELP[METRIC.previewOperations] ?? '', {
    verb: safeLabelValue(verb),
    outcome: safeLabelValue(outcome),
  });
}

/**
 * Create (or return) a regeneration preview.
 *
 * Runs inside the caller's RLS scope: a `chapterNo` belonging to another tenant is invisible rather
 * than merely refused, and the database's own scope trigger is the second line of that defence.
 */
export async function createPreview(
  client: Client,
  input: CreatePreviewInput,
): Promise<CreatePreviewResult> {
  if (input.requestKey.trim() === '' || input.requestKey.length > 255)
    throw new PreviewError('INVALID_REQUEST', 'the request key is missing or too long');
  if (input.instruction.length > 2_000)
    throw new PreviewError('INVALID_REQUEST', 'the instruction is too long');
  if (input.signal?.aborted ?? false)
    throw new PreviewError('CANCELLED', 'the request was cancelled');

  // Idempotency FIRST: a duplicate delivery must not re-run the simulator, re-reserve budget or
  // create a second proposal.
  const existing = await client.query<PreviewRow>(
    'SELECT * FROM regeneration_previews WHERE workspace_id = $1 AND request_key = $2',
    [input.workspaceId, input.requestKey],
  );
  const prior = existing.rows[0];
  if (prior) {
    record(input.metrics, 'create', 'duplicate');
    const source = await acceptedChapter(client, prior.project_id, input.chapterNo);
    return {
      preview: previewView(prior),
      proposed_text: prior.proposed_text ?? '',
      source_text: source.state === 'accepted' ? source.chapter.version.text : '',
      duplicate: true,
    };
  }

  const lookup = await acceptedChapter(client, input.projectId, input.chapterNo);
  if (lookup.state === 'missing') {
    record(input.metrics, 'create', 'chapter_not_found');
    throw new PreviewError('CHAPTER_NOT_FOUND', 'the chapter does not exist in this project');
  }
  if (lookup.state !== 'accepted') {
    // A preview of unaccepted content would propose replacing something that is not canon yet, which
    // is the ordinary drafting path, not a preview.
    record(input.metrics, 'create', 'not_accepted');
    throw new PreviewError('SOURCE_NOT_ACCEPTED', 'the chapter has no accepted version to preview');
  }

  const sourceText = lookup.chapter.version.text;
  const sourceHash = hashText(sourceText);
  const seed = seedFor({
    projectId: input.projectId,
    chapterId: lookup.chapter.chapterId,
    sourceContentHash: sourceHash,
    instruction: input.instruction,
  });

  const simulator = input.simulator ?? new DeterministicPreviewSimulator();
  const rate = input.millicentsPerKiloToken ?? DEFAULT_RATE_MILLICENTS_PER_KTOKEN;
  const estimateTokens =
    simulator.estimateTokens?.bind(simulator) ?? ((t: string) => Math.ceil(t.length / 4));
  const estimated = Math.ceil((estimateTokens(sourceText) * 2 * rate) / 1000);

  // Budget is reserved BEFORE the work and released if the work does not happen, exactly as the
  // provider path does. A preview that generated first and accounted afterwards could exceed a limit.
  let reserved = false;
  if (input.budgetPolicyId !== undefined) {
    const hold = await reserve(client, {
      policyId: input.budgetPolicyId,
      requestId: `preview:${input.workspaceId}:${input.requestKey}`,
      estimatedMillicents: estimated,
      ttlSeconds: 300,
      now: input.now ?? new Date(),
    });
    if (!hold) {
      record(input.metrics, 'create', 'budget_exhausted');
      throw new PreviewError('BUDGET_EXHAUSTED', 'the shared budget refused this preview');
    }
    reserved = true;
  }

  const releaseHold = async (): Promise<void> => {
    if (!reserved || input.budgetPolicyId === undefined) return;
    await release(client, {
      policyId: input.budgetPolicyId,
      requestId: `preview:${input.workspaceId}:${input.requestKey}`,
      now: input.now ?? new Date(),
    });
  };

  if (input.signal?.aborted ?? false) {
    await releaseHold();
    record(input.metrics, 'create', 'cancelled');
    throw new PreviewError('CANCELLED', 'the request was cancelled');
  }

  let proposed: string;
  try {
    proposed = simulator.generate({ sourceText, instruction: input.instruction, seed });
    if (proposed.trim() === '') throw new Error('empty');
  } catch {
    // A simulator failure releases the hold rather than settling it: nothing was produced, so
    // committing the estimate would overstate spend.
    await releaseHold();
    record(input.metrics, 'create', 'simulator_failed');
    throw new PreviewError(
      'SIMULATOR_FAILED',
      'the deterministic simulator did not produce output',
    );
  }

  if (input.signal?.aborted ?? false) {
    await releaseHold();
    record(input.metrics, 'create', 'cancelled');
    throw new PreviewError('CANCELLED', 'the request was cancelled');
  }

  let row: PreviewRow;
  try {
    const inserted = await client.query<PreviewRow>(
      `INSERT INTO regeneration_previews (
         workspace_id, project_id, chapter_id, source_manuscript_version_id, source_content_hash,
         request_key, status, simulator, seed, context_summary, retrieval_summary,
         proposed_text, proposed_content_hash, estimated_millicents, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'ready', $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (workspace_id, request_key) DO NOTHING
       RETURNING *`,
      [
        input.workspaceId,
        input.projectId,
        lookup.chapter.chapterId,
        lookup.chapter.version.id,
        sourceHash,
        input.requestKey,
        JSON.stringify({
          name: simulator.name,
          version: simulator.version,
          rate_millicents_per_ktoken: rate,
        }),
        seed,
        JSON.stringify(
          input.contextSummary ?? { source_paragraphs: sourceText.split(/\n\s*\n/).length },
        ),
        JSON.stringify(input.retrievalSummary ?? { mode: 'none', items: 0 }),
        proposed.normalize('NFC'),
        hashText(proposed),
        estimated,
        input.userId ?? null,
      ],
    );
    const created = inserted.rows[0];
    if (!created) {
      // A CONCURRENT duplicate won the unique key. The other request's proposal is authoritative and
      // this one's reservation is released: two concurrent duplicates must not both be charged.
      await releaseHold();
      const raced = await client.query<PreviewRow>(
        'SELECT * FROM regeneration_previews WHERE workspace_id = $1 AND request_key = $2',
        [input.workspaceId, input.requestKey],
      );
      const winner = raced.rows[0];
      if (!winner) throw new PreviewError('INVALID_REQUEST', 'the preview could not be created');
      record(input.metrics, 'create', 'duplicate');
      return {
        preview: previewView(winner),
        proposed_text: winner.proposed_text ?? '',
        source_text: sourceText,
        duplicate: true,
      };
    }
    row = created;
  } catch (err) {
    await releaseHold();
    const canon = asCanonError(err);
    if (canon?.code === 'PREVIEW_CROSS_PROJECT')
      throw new PreviewError(
        'PREVIEW_CROSS_PROJECT',
        'the preview names another project’s content',
      );
    if (err instanceof PreviewError) throw err;
    return rethrowCanon(err);
  }

  // The work happened, so the hold SETTLES at the simulated amount. `costKnown` is true because a
  // deterministic local estimate is exactly known — it is simply not a provider charge.
  if (input.budgetPolicyId !== undefined) {
    await settle(client, {
      policyId: input.budgetPolicyId,
      requestId: `preview:${input.workspaceId}:${input.requestKey}`,
      actualMillicents: estimated,
      costKnown: true,
      now: input.now ?? new Date(),
    });
  }

  record(input.metrics, 'create', 'created');
  return {
    preview: previewView(row),
    proposed_text: proposed,
    source_text: sourceText,
    duplicate: false,
  };
}

export async function getPreview(
  db: Queryable,
  previewId: string,
): Promise<PreviewRow | undefined> {
  const r = await db.query<PreviewRow>('SELECT * FROM regeneration_previews WHERE id = $1', [
    previewId,
  ]);
  return r.rows[0];
}

export interface ResolvePreviewInput {
  readonly previewId: string;
  readonly projectId: string;
  readonly userId?: string | undefined;
  readonly metrics?: Metrics | undefined;
  readonly now?: Date | undefined;
}

export interface AcceptPreviewResult {
  readonly preview: PreviewView;
  /** The NEW working manuscript version the acceptance created. It still faces every normal gate. */
  readonly manuscript_version_id: string;
  readonly version_no: number;
}

/**
 * Accept a preview.
 *
 * What acceptance does, precisely: it writes a NEW working manuscript version carrying the proposed
 * text, and marks the preview `accepted`. It does NOT overwrite the accepted version, does not touch
 * canon, and does not skip approval — the new version enters the ordinary lifecycle at `working` and
 * must pass the same gates as any other draft. Anything stronger would be a way to put unreviewed text
 * into canon, which is the one thing a preview must never enable.
 *
 * Staleness is checked inside the transaction against the CURRENT accepted version: a preview computed
 * against text that has since changed proposes a replacement for content that no longer exists.
 */
export async function acceptPreview(
  pool: Pool,
  scopeRunner: <T>(fn: (c: Client) => Promise<T>) => Promise<T>,
  input: ResolvePreviewInput,
): Promise<AcceptPreviewResult> {
  /**
   * The refusal outcome, carried OUT of the transaction rather than recorded inside it.
   *
   * Recording "this preview is stale" inside the transaction that then rolls back would roll the
   * record back too, leaving the preview `ready` and therefore re-acceptable against content it no
   * longer matches. The transaction is used for the WRITE path only; a refusal is committed
   * separately, afterwards.
   */
  let refusal:
    | { code: 'SOURCE_NOT_ACCEPTED' | 'PREVIEW_STALE'; status: 'failed' | 'discarded'; id: string }
    | undefined;

  const attempt = async (): Promise<AcceptPreviewResult> =>
    scopeRunner(async (client) =>
      inClientTransaction(client, async (tx) => {
        const row = await lockedPreview(tx, input);
        const current = await tx.query<{ text: string }>(
          `SELECT mv.text
             FROM chapters c
             JOIN manuscript_versions mv ON mv.id = c.accepted_version_id
            WHERE c.id = $1`,
          [row.chapter_id],
        );
        const accepted = current.rows[0];
        if (!accepted) {
          refusal = { code: 'SOURCE_NOT_ACCEPTED', status: 'failed', id: row.id };
          throw new PreviewError(
            'SOURCE_NOT_ACCEPTED',
            'the chapter no longer has an accepted version',
          );
        }
        if (hashText(accepted.text) !== row.source_content_hash) {
          refusal = { code: 'PREVIEW_STALE', status: 'discarded', id: row.id };
          throw new PreviewError(
            'PREVIEW_STALE',
            'the source content changed after this preview was created',
          );
        }

        // The EXISTING version-creation service, not a second insert: it is what computes the length
        // model, normalizes to NFC and content-addresses the text, and a parallel insert here would be
        // a second write path with its own drift.
        const created = await createManuscriptVersion(tx, {
          workspaceId: row.workspace_id,
          projectId: row.project_id,
          chapterId: row.chapter_id,
          origin: 'revision',
          text: row.proposed_text ?? '',
          parentVersionId: row.source_manuscript_version_id,
        });
        const resolved = await markResolved(tx, row.id, 'accepted', null, input.now);
        record(input.metrics, 'accept', 'accepted');
        return {
          preview: previewView(resolved),
          manuscript_version_id: created.id,
          version_no: created.version_no,
        };
      }),
    );

  try {
    return await attempt();
  } catch (err) {
    const pending = refusal;
    if (pending) {
      // A stale proposal must not remain acceptable, so the resolution is committed on its own.
      await scopeRunner(async (c) =>
        markResolved(c, pending.id, pending.status, pending.code, input.now).catch(
          // Already resolved by a concurrent caller: that is the same outcome, not a new failure.
          () => undefined,
        ),
      );
      record(
        input.metrics,
        'accept',
        pending.code === 'PREVIEW_STALE' ? 'stale' : 'source_not_accepted',
      );
    }
    throw err;
  }
}

/** Discard a preview. The row is retained: what was proposed and rejected is history. */
export async function discardPreview(
  client: Client,
  input: ResolvePreviewInput,
): Promise<PreviewView> {
  const row = await lockedPreview(client, input);
  const resolved = await markResolved(client, row.id, 'discarded', null, input.now);
  record(input.metrics, 'discard', 'discarded');
  return previewView(resolved);
}

/** Cancel a preview. Distinct from discard: the operator stopped it rather than judged it. */
export async function cancelPreview(
  client: Client,
  input: ResolvePreviewInput,
): Promise<PreviewView> {
  const row = await lockedPreview(client, input);
  const resolved = await markResolved(client, row.id, 'cancelled', 'CANCELLED', input.now);
  record(input.metrics, 'cancel', 'cancelled');
  return previewView(resolved);
}

async function lockedPreview(client: Client, input: ResolvePreviewInput): Promise<PreviewRow> {
  const r = await client.query<PreviewRow>(
    'SELECT * FROM regeneration_previews WHERE id = $1 FOR UPDATE',
    [input.previewId],
  );
  const row = r.rows[0];
  // RLS already makes another tenant's preview invisible; the project check additionally stops a
  // preview from one project being resolved through another project's route in the same workspace.
  if (row?.project_id !== input.projectId)
    throw new PreviewError('PREVIEW_NOT_FOUND', 'the preview does not exist');
  if (row.status !== 'ready')
    throw new PreviewError('PREVIEW_TERMINAL', `the preview is already ${row.status}`);
  return row;
}

async function markResolved(
  client: Client,
  previewId: string,
  status: Exclude<PreviewStatus, 'ready'>,
  failureCode: string | null,
  now: Date | undefined,
): Promise<PreviewRow> {
  const r = await client.query<PreviewRow>(
    `UPDATE regeneration_previews
        SET status = $2, failure_code = $3, resolved_at = $4
      WHERE id = $1 AND status = 'ready'
      RETURNING *`,
    [previewId, status, failureCode, now ?? new Date()],
  );
  const row = r.rows[0];
  if (!row) throw new PreviewError('PREVIEW_TERMINAL', 'the preview was already resolved');
  return row;
}

export interface PreviewListing {
  readonly items: readonly PreviewView[];
  readonly truncated: boolean;
}

/** List previews for a project. Bounded, newest first, and never returning proposal text in bulk. */
export async function listPreviews(
  db: Queryable,
  q: { projectId: string; limit: number },
): Promise<PreviewListing> {
  const limit = Math.min(Math.max(1, q.limit), 100);
  const r = await db.query<PreviewRow>(
    `SELECT * FROM regeneration_previews WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [q.projectId, limit + 1],
  );
  return {
    items: r.rows.slice(0, limit).map(previewView),
    truncated: r.rows.length > limit,
  };
}
