/**
 * Hybrid retrieval: lexical ranking plus deterministic local vector similarity, over accepted content
 * only (ADR-0011, ADR-0045, migrations 0016 and 0017).
 *
 * THE RANKING DECISION. Lexical `ts_rank_cd` and cosine similarity are not on the same scale, so they
 * cannot be added directly — doing so would let whichever side happens to produce larger numbers decide
 * every result. Each side is therefore normalized to [0, 1] against the BEST hit of its own list, then
 * combined with explicit weights. This is deliberately a simple, inspectable rule rather than a learned
 * one: an operator reviewing a continuity miss needs to be able to explain the ordering.
 *
 * WHAT IS NOT CLAIMED. The vector side uses the repository's deterministic local embedder, which captures
 * lexical overlap and not meaning. Fixture recall measured here is evidence that the PIPELINE — isolation,
 * accepted-only filtering, active-set switching, weighting, tie-breaking — behaves correctly. It is not
 * evidence of production retrieval quality, which needs a real embedding provider.
 */
import { METRIC, METRIC_HELP, type Metrics, safeLabelValue } from '@yeonjae/domain';
import { activeEmbeddingSet, vectorSearch, type EmbeddingPurpose } from './embeddings.js';
import { lexicalSearch, type SearchHit } from './retrieval.js';
import { expandQuery, type Expansion } from './thesaurus.js';
import { type Client, type Pool } from './client.js';

type Queryable = Pool | Client;

export type RetrievalMode = 'hybrid' | 'lexical_only' | 'vector_only';

export interface HybridHit {
  readonly searchDocumentId: string;
  readonly kind: SearchHit['kind'];
  readonly refId: string;
  readonly refKey: string;
  readonly chapterNo: number | null;
  readonly timelineId: string | null;
  readonly text: string;
  readonly manuscriptVersionId: string | null;
  readonly canonVersionAdded: number;
  readonly lexicalScore: number;
  readonly vectorScore: number;
  readonly score: number;
  /** Which sources found this document, for provenance in a context pack. */
  readonly sources: readonly ('lexical' | 'vector')[];
}

export interface HybridDiagnostics {
  readonly mode: RetrievalMode;
  readonly lexicalHits: number;
  readonly vectorHits: number;
  readonly embeddingSetId: string | null;
  readonly embeddingSetStale: boolean;
  readonly expansion: Expansion['diagnostics'] | null;
  readonly expandedTerms: readonly string[];
  readonly weights: { readonly lexical: number; readonly vector: number };
  readonly notes: readonly string[];
  readonly truncated: boolean;
}

export interface HybridResult {
  readonly hits: readonly HybridHit[];
  readonly diagnostics: HybridDiagnostics;
}

export interface HybridQuery {
  readonly projectId: string;
  readonly query: string;
  /** A query vector from the SAME model as the active set; omit to force the lexical path. */
  readonly queryVector?: readonly number[] | undefined;
  readonly timelineId?: string | undefined;
  readonly chapterMax?: number | undefined;
  readonly kinds?: readonly SearchHit['kind'][] | undefined;
  readonly limit?: number | undefined;
  readonly purpose?: EmbeddingPurpose | undefined;
  readonly weights?: { readonly lexical?: number; readonly vector?: number } | undefined;
  /** Expand query terms through the project thesaurus. */
  readonly useThesaurus?: boolean | undefined;
  readonly includeDisguises?: boolean | undefined;
  /** Bound the result payload, so an operator endpoint cannot return an unbounded body. */
  readonly maxChars?: number | undefined;
  /** Where to record retrieval counters. Optional so unit callers need not supply one. */
  readonly metrics?: Metrics | undefined;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_WEIGHTS = { lexical: 0.5, vector: 0.5 } as const;

/** Normalize a score list against its own best value, so two scales become comparable. */
function normalized(values: readonly number[]): (v: number) => number {
  const best = values.reduce((m, v) => Math.max(m, v), 0);
  if (best <= 0) return () => 0;
  return (v) => Math.round((v / best) * 1e6) / 1e6;
}

/**
 * Run hybrid retrieval.
 *
 * Degrades rather than fails: with no active embedding set, or no query vector, the vector side is
 * skipped and the mode reported as `lexical_only`. That is the documented degradation ladder — an
 * optional source's absence must not block a pack.
 */
export async function hybridSearch(db: Queryable, q: HybridQuery): Promise<HybridResult> {
  const notes: string[] = [];
  // Monotonic: a wall-clock delta can go backwards across an NTP step and produce a negative latency.
  const startedAt = process.hrtime.bigint();
  const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const weights = {
    lexical: q.weights?.lexical ?? DEFAULT_WEIGHTS.lexical,
    vector: q.weights?.vector ?? DEFAULT_WEIGHTS.vector,
  };

  let expansion: Expansion | undefined;
  let queryText = q.query;
  if (q.useThesaurus === true) {
    expansion = await expandQuery(db, {
      projectId: q.projectId,
      query: q.query,
      ...(q.chapterMax !== undefined ? { chapterMax: q.chapterMax } : {}),
      ...(q.includeDisguises !== undefined ? { includeDisguises: q.includeDisguises } : {}),
    });
    // OR-ed, because expansion exists to widen recall; the weighting below is what keeps a weak alias
    // from outranking a canonical match.
    queryText = expansion.terms.map((t) => t.surface).join(' ');
  }

  const lexical = await lexicalSearch(db, {
    projectId: q.projectId,
    query: queryText,
    mode: 'any',
    ...(q.timelineId !== undefined ? { timelineId: q.timelineId } : {}),
    ...(q.chapterMax !== undefined ? { chapterMax: q.chapterMax } : {}),
    ...(q.kinds !== undefined ? { kinds: q.kinds } : {}),
    // Over-fetch so the fusion below has candidates to rank rather than a pre-truncated list.
    limit: Math.min(limit * 4, MAX_LIMIT * 2),
  });

  const set = await activeEmbeddingSet(db, q.projectId, q.purpose ?? 'retrieval');
  let vectorHits: { searchDocumentId: string; similarity: number }[] = [];
  let mode: RetrievalMode = 'lexical_only';
  if (!set) {
    notes.push('no active embedding set: lexical retrieval only');
  } else if (!q.queryVector) {
    notes.push('no query vector supplied: lexical retrieval only');
  } else if (q.queryVector.length !== set.dimension) {
    // Refused rather than truncated: comparing a query vector against a different model's set would
    // produce confident nonsense.
    notes.push(
      `query vector dimension ${String(q.queryVector.length)} does not match the active set's ${String(set.dimension)}: lexical retrieval only`,
    );
  } else {
    vectorHits = await vectorSearch(db, {
      embeddingSetId: set.id,
      query: q.queryVector,
      ...(q.chapterMax !== undefined ? { chapterMax: q.chapterMax } : {}),
      ...(q.timelineId !== undefined ? { timelineId: q.timelineId } : {}),
      limit: Math.min(limit * 4, MAX_LIMIT * 2),
    });
    mode = lexical.length > 0 ? 'hybrid' : 'vector_only';
  }

  // Documents the vector side found that the lexical side did not: they still need their metadata, and
  // the query must not be allowed to reach unaccepted text through this path either.
  const lexicalById = new Map(lexical.map((h) => [h.id, h]));
  const missingIds = vectorHits.map((v) => v.searchDocumentId).filter((id) => !lexicalById.has(id));
  const extra =
    missingIds.length > 0
      ? await db.query<SearchHit>(
          `SELECT d.id, d.kind, d.ref_kind, d.ref_id, d.ref_key, d.chapter_no, d.clock_ord,
                  d.timeline_id, d.entity_ids, d.importance, d.text, d.manuscript_version_id,
                  d.canon_version_added, 0::float8 AS rank
             FROM search_documents d
            WHERE d.id = ANY($1::uuid[]) AND d.project_id = $2
            ORDER BY d.id`,
          [missingIds, q.projectId],
        )
      : { rows: [] as SearchHit[] };

  const documents = new Map<string, SearchHit>();
  for (const hit of [...lexical, ...extra.rows]) documents.set(hit.id, hit);

  const lexicalScale = normalized(lexical.map((h) => h.rank));
  // Cosine similarity can be negative; only the positive half is evidence of relatedness.
  const vectorScale = normalized(vectorHits.map((v) => Math.max(0, v.similarity)));
  const vectorById = new Map(vectorHits.map((v) => [v.searchDocumentId, v.similarity]));

  const fused: HybridHit[] = [];
  for (const [id, doc] of documents) {
    const lexicalScore = lexicalById.has(id) ? lexicalScale(doc.rank) : 0;
    const raw = vectorById.get(id);
    const vectorScore = raw === undefined ? 0 : vectorScale(Math.max(0, raw));
    const sources: ('lexical' | 'vector')[] = [];
    if (lexicalById.has(id)) sources.push('lexical');
    if (raw !== undefined) sources.push('vector');
    fused.push({
      searchDocumentId: id,
      kind: doc.kind,
      refId: doc.ref_id,
      refKey: doc.ref_key,
      chapterNo: doc.chapter_no,
      timelineId: doc.timeline_id,
      text: doc.text,
      manuscriptVersionId: doc.manuscript_version_id,
      canonVersionAdded: doc.canon_version_added,
      lexicalScore,
      vectorScore,
      score:
        Math.round((weights.lexical * lexicalScore + weights.vector * vectorScore) * 1e6) / 1e6,
      sources,
    });
  }

  // A TOTAL order: score, then chapter, then document id. Every component is deterministic, so the same
  // corpus and query always produce the same list — including when scores tie exactly.
  fused.sort(
    (a, b) =>
      b.score - a.score ||
      (a.chapterNo ?? Number.MAX_SAFE_INTEGER) - (b.chapterNo ?? Number.MAX_SAFE_INTEGER) ||
      a.searchDocumentId.localeCompare(b.searchDocumentId),
  );

  // Bound the payload by characters as well as by count, so a handful of long paragraphs cannot produce
  // an unbounded response body.
  const maxChars = q.maxChars ?? 200_000;
  const hits: HybridHit[] = [];
  let chars = 0;
  let truncated = false;
  for (const hit of fused.slice(0, limit)) {
    chars += hit.text.length;
    if (chars > maxChars) {
      truncated = true;
      break;
    }
    hits.push(hit);
  }
  if (fused.length > limit) truncated = true;

  if (q.metrics) {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const label = { mode: safeLabelValue(mode) };
    q.metrics.observe(
      METRIC.retrievalLatency,
      METRIC_HELP[METRIC.retrievalLatency] ?? '',
      seconds,
      label,
    );
    // The COUNT of results, not the results: a result count cannot reconstruct prose.
    q.metrics.increment(
      METRIC.retrievalResults,
      METRIC_HELP[METRIC.retrievalResults] ?? '',
      label,
      hits.length,
    );
    if (mode === 'lexical_only') {
      q.metrics.increment(METRIC.retrievalResults, METRIC_HELP[METRIC.retrievalResults] ?? '', {
        mode: 'lexical_fallback',
      });
    }
    if (expansion) {
      q.metrics.increment(
        METRIC.thesaurusExpansions,
        METRIC_HELP[METRIC.thesaurusExpansions] ?? '',
        { kind: 'query' },
        expansion.terms.length,
      );
    }
  }

  return {
    hits,
    diagnostics: {
      mode,
      lexicalHits: lexical.length,
      vectorHits: vectorHits.length,
      embeddingSetId: set?.id ?? null,
      /**
       * The active set has items it could not embed, so it does not describe the whole corpus.
       *
       * Reported rather than fatal: a partially-covering set still answers better than no vector
       * source, and the caller needs to know that a miss may be absence of coverage rather than
       * absence of canon. Full stale-SOURCE detection (comparing each document's current hash) is
       * `embeddingSetCompleteness`, which reads every document and is too heavy for a query path.
       */
      embeddingSetStale: set !== undefined && set.failed_count > 0,
      expansion: expansion?.diagnostics ?? null,
      expandedTerms: expansion?.terms.map((t) => t.surface) ?? [],
      weights,
      notes,
      truncated,
    },
  };
}
