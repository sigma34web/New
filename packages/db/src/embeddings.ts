/**
 * Versioned embedding sets and vector storage (migration 0016).
 *
 * The lifecycle this implements: create INACTIVE → generate (resumable, idempotent) → verify complete →
 * activate ATOMICALLY → optionally roll back. The ordering is the safety property: a set is never
 * reachable by retrieval until it is complete, and activation is one transaction so a reader cannot
 * observe a project with two active sets or none.
 *
 * Similarity is computed in SQL over `double precision[]` because pgvector is not installed. That is a
 * sequential scan — correct and bounded, right for fixtures and development, and explicitly not a
 * production ANN index.
 */
import { METRIC, METRIC_HELP, type Metrics, safeLabelValue } from '@yeonjae/domain';
import { type Client, type Pool } from './client.js';

type Queryable = Pool | Client;

export type EmbeddingSetStatus = 'building' | 'active' | 'retired';
export type EmbeddingPurpose = 'retrieval' | 'dedup' | 'experiment';

export interface EmbeddingSetRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly provider: string;
  readonly model_id: string;
  readonly model_version: string;
  readonly config: Record<string, unknown>;
  readonly dimension: number;
  readonly purpose: EmbeddingPurpose;
  readonly status: EmbeddingSetStatus;
  readonly source_content_hash: string | null;
  readonly item_count: number;
  readonly failed_count: number;
  readonly activated_at: Date | null;
  readonly retired_at: Date | null;
  readonly replaced_set_id: string | null;
  readonly created_at: Date;
}

/** Create a set in `building` status. A new set is NEVER born active: it has no vectors yet. */
export async function createEmbeddingSet(
  db: Queryable,
  input: {
    workspaceId: string;
    projectId: string;
    provider: string;
    modelId: string;
    modelVersion: string;
    dimension: number;
    purpose?: EmbeddingPurpose | undefined;
    config?: Record<string, unknown> | undefined;
    sourceContentHash?: string | undefined;
  },
): Promise<EmbeddingSetRow> {
  const r = await db.query<EmbeddingSetRow>(
    `INSERT INTO embedding_sets
       (workspace_id, project_id, provider, model_id, model_version, dimension, purpose, config,
        source_content_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, coalesce($7, 'retrieval'), coalesce($8, '{}'::jsonb), $9, 'building')
     RETURNING *`,
    [
      input.workspaceId,
      input.projectId,
      input.provider,
      input.modelId,
      input.modelVersion,
      input.dimension,
      input.purpose ?? null,
      input.config === undefined ? null : JSON.stringify(input.config),
      input.sourceContentHash ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('embedding set insert returned no row');
  return row;
}

export async function getEmbeddingSet(
  db: Queryable,
  setId: string,
): Promise<EmbeddingSetRow | undefined> {
  const r = await db.query<EmbeddingSetRow>('SELECT * FROM embedding_sets WHERE id = $1', [setId]);
  return r.rows[0];
}

/** The set retrieval should read. `undefined` means no vector source, which is a degradation, not a fault. */
export async function activeEmbeddingSet(
  db: Queryable,
  projectId: string,
  purpose: EmbeddingPurpose = 'retrieval',
): Promise<EmbeddingSetRow | undefined> {
  const r = await db.query<EmbeddingSetRow>(
    `SELECT * FROM embedding_sets
      WHERE project_id = $1 AND purpose = $2 AND status = 'active'`,
    [projectId, purpose],
  );
  return r.rows[0];
}

/**
 * Write one vector. Idempotent by (set, document), which is what makes generation RESUMABLE: re-running
 * after an interruption updates the rows it already wrote instead of duplicating them.
 */
export async function putEmbedding(
  db: Queryable,
  input: {
    workspaceId: string;
    projectId: string;
    embeddingSetId: string;
    searchDocumentId: string;
    embedding: readonly number[];
    contentHash: string;
    /** Bounded backend label, e.g. the embedder's provider name. */
    backend?: string | undefined;
    metrics?: Metrics | undefined;
  },
): Promise<{ inserted: boolean }> {
  const r = await db.query<{ inserted: boolean }>(
    `INSERT INTO embedding_vectors
       (workspace_id, project_id, embedding_set_id, search_document_id, embedding, dimension, content_hash)
     VALUES ($1, $2, $3, $4, $5::double precision[], $6, $7)
     ON CONFLICT (embedding_set_id, search_document_id) DO UPDATE
       SET embedding = excluded.embedding,
           dimension = excluded.dimension,
           content_hash = excluded.content_hash
     RETURNING (xmax = 0) AS inserted`,
    [
      input.workspaceId,
      input.projectId,
      input.embeddingSetId,
      input.searchDocumentId,
      [...input.embedding],
      input.embedding.length,
      input.contentHash,
    ],
  );
  const inserted = r.rows[0]?.inserted ?? false;
  input.metrics?.increment(
    METRIC.embeddingsGenerated,
    METRIC_HELP[METRIC.embeddingsGenerated] ?? '',
    {
      backend: safeLabelValue(input.backend ?? 'local_deterministic'),
      // A resumed run UPDATES rather than inserts; counting them apart is what makes the counter
      // usable for progress instead of merely for volume.
      outcome: inserted ? 'inserted' : 'updated',
    },
  );
  // item_count is maintained here rather than by trigger so a resumed run does not inflate it.
  if (inserted) {
    await db.query('UPDATE embedding_sets SET item_count = item_count + 1 WHERE id = $1', [
      input.embeddingSetId,
    ]);
  }
  return { inserted };
}

/** Record that an item could not be embedded. A set with failures is refused at activation. */
export async function recordEmbeddingFailure(
  db: Queryable,
  setId: string,
  count = 1,
  metrics?: Metrics,
): Promise<void> {
  await db.query('UPDATE embedding_sets SET failed_count = failed_count + $2 WHERE id = $1', [
    setId,
    count,
  ]);
  metrics?.increment(
    METRIC.embeddingsGenerated,
    METRIC_HELP[METRIC.embeddingsGenerated] ?? '',
    { backend: 'local_deterministic', outcome: 'failed' },
    count,
  );
}

export async function clearEmbeddingFailures(db: Queryable, setId: string): Promise<void> {
  await db.query('UPDATE embedding_sets SET failed_count = 0 WHERE id = $1', [setId]);
}

export interface CompletenessReport {
  readonly expected: number;
  readonly embedded: number;
  readonly missingDocumentIds: readonly string[];
  /** Documents whose text changed since they were embedded. */
  readonly staleDocumentIds: readonly string[];
  readonly complete: boolean;
}

/**
 * Is this set complete and current for its project's accepted documents?
 *
 * Reports missing and STALE items separately, because they need different actions: a missing item needs
 * generation, while a stale one means the source changed and the set describes text that no longer
 * exists. Activating either would make retrieval quietly wrong rather than loudly broken.
 */
export async function embeddingSetCompleteness(
  db: Queryable,
  setId: string,
  currentHashOf: (text: string) => string,
): Promise<CompletenessReport> {
  const set = await getEmbeddingSet(db, setId);
  if (!set) throw new Error('embedding set does not exist');
  const docs = await db.query<{ id: string; text: string }>(
    'SELECT id, text FROM search_documents WHERE project_id = $1 ORDER BY id',
    [set.project_id],
  );
  const vectors = await db.query<{ search_document_id: string; content_hash: string }>(
    'SELECT search_document_id, content_hash FROM embedding_vectors WHERE embedding_set_id = $1',
    [setId],
  );
  const byDoc = new Map(vectors.rows.map((v) => [v.search_document_id, v.content_hash]));
  const missing: string[] = [];
  const stale: string[] = [];
  for (const doc of docs.rows) {
    const hash = byDoc.get(doc.id);
    if (hash === undefined) {
      missing.push(doc.id);
      continue;
    }
    if (hash !== currentHashOf(doc.text)) stale.push(doc.id);
  }
  return {
    expected: docs.rows.length,
    embedded: vectors.rows.length,
    missingDocumentIds: missing,
    staleDocumentIds: stale,
    complete: missing.length === 0 && stale.length === 0 && docs.rows.length > 0,
  };
}

/** Atomic activation. One transaction, so a reader never observes partial activation. */
export async function activateEmbeddingSet(
  db: Queryable,
  setId: string,
  now: Date = new Date(),
): Promise<EmbeddingSetRow> {
  const r = await db.query<EmbeddingSetRow>('SELECT * FROM canon.activate_embedding_set($1, $2)', [
    setId,
    now.toISOString(),
  ]);
  const row = r.rows[0];
  if (!row) throw new Error('activate_embedding_set returned no row');
  return row;
}

export async function rollbackEmbeddingSet(
  db: Queryable,
  projectId: string,
  purpose: EmbeddingPurpose = 'retrieval',
  now: Date = new Date(),
  metrics?: Metrics,
): Promise<EmbeddingSetRow> {
  const r = await db.query<EmbeddingSetRow>(
    'SELECT * FROM canon.rollback_embedding_set($1, $2, $3)',
    [projectId, purpose, now.toISOString()],
  );
  const row = r.rows[0];
  if (!row) throw new Error('rollback_embedding_set returned no row');
  metrics?.increment(
    METRIC.embeddingSetActivations,
    METRIC_HELP[METRIC.embeddingSetActivations] ?? '',
    { outcome: 'rolled_back' },
  );
  return row;
}

/** Sets eligible for garbage collection. Reports only; nothing is destroyed automatically. */
export async function gcEligibleEmbeddingSets(
  db: Queryable,
  projectId: string,
  keep = 1,
): Promise<{ id: string; purpose: string; itemCount: number }[]> {
  const r = await db.query<{ id: string; purpose: string; item_count: number }>(
    'SELECT * FROM canon.gc_eligible_embedding_sets($1, $2)',
    [projectId, keep],
  );
  return r.rows.map((x) => ({ id: x.id, purpose: x.purpose, itemCount: x.item_count }));
}

export interface VectorHit {
  readonly searchDocumentId: string;
  readonly similarity: number;
}

/**
 * Nearest documents to a query vector, within ONE embedding set.
 *
 * Scoped to a set rather than a project, so a switch of the active set changes results atomically and a
 * retired set's vectors can never leak into a current answer. Ties break on document id, so the order is
 * total and the same query always returns the same list.
 */
export async function vectorSearch(
  db: Queryable,
  input: {
    embeddingSetId: string;
    query: readonly number[];
    limit?: number | undefined;
    /** Never read beyond the previous accepted chapter. */
    chapterMax?: number | undefined;
    timelineId?: string | undefined;
  },
): Promise<VectorHit[]> {
  const params: unknown[] = [input.embeddingSetId, [...input.query]];
  const where = ['v.embedding_set_id = $1'];
  if (input.chapterMax !== undefined) {
    params.push(input.chapterMax);
    where.push(`(d.chapter_no IS NULL OR d.chapter_no <= $${String(params.length)})`);
  }
  if (input.timelineId !== undefined) {
    params.push(input.timelineId);
    where.push(`(d.timeline_id IS NULL OR d.timeline_id = $${String(params.length)})`);
  }
  params.push(input.limit ?? 20);
  const r = await db.query<{ search_document_id: string; similarity: number }>(
    // Cosine similarity of two L2-normalized vectors is their dot product. Rounded, so a tie is a tie
    // regardless of the order PostgreSQL happened to sum in.
    `WITH q AS (SELECT $2::double precision[] AS vec)
     SELECT v.search_document_id,
            round((
              SELECT coalesce(sum(a.val * b.val), 0)
                FROM unnest(v.embedding) WITH ORDINALITY AS a(val, i)
                JOIN unnest((SELECT vec FROM q)) WITH ORDINALITY AS b(val, i) USING (i)
            )::numeric, 6)::float8 AS similarity
       FROM embedding_vectors v
       JOIN search_documents d ON d.id = v.search_document_id
      WHERE ${where.join(' AND ')}
      ORDER BY similarity DESC, v.search_document_id ASC
      LIMIT $${String(params.length)}`,
    params,
  );
  return r.rows.map((x) => ({ searchDocumentId: x.search_document_id, similarity: x.similarity }));
}
