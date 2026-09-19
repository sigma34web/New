/**
 * A deterministic local embedding backend (ADR-0035's provider-neutral interface, ADR-0045's deferral).
 *
 * WHAT THIS IS, STATED FIRST. This is a hashed-feature ("hashing trick") text embedder: it needs no
 * network, no downloaded model and no credentials, and the same text always yields the same vector on
 * any machine. It exists so the whole versioned-embedding and hybrid-retrieval path can be BUILT and
 * TESTED deterministically before a paid embedding provider is available.
 *
 * WHAT THIS IS NOT. It is not a semantic model. It captures lexical overlap, not meaning: two
 * paraphrases with no shared words are not close in this space. Fixture recall measured against it is
 * evidence that the PIPELINE works, never evidence of production retrieval quality. Any claim of the
 * latter would need a real embedding provider, which is external work.
 *
 * Determinism comes from three deliberate choices: a fixed dimension, integer feature hashing with a
 * fixed algorithm (SHA-256, so the bucket for a token is stable across processes and Node versions),
 * and L2 normalization with rounded components so a float sum order cannot change the stored bytes.
 */
import { createHash } from 'node:crypto';

/** Identity of this backend. Persisted with every vector so a set's provenance is unambiguous. */
export const LOCAL_EMBEDDING_PROVIDER = 'local_deterministic';
export const LOCAL_EMBEDDING_MODEL = 'hashed-lexical-256';
/** Bumped whenever the arithmetic changes, so old vectors are never mixed with new ones. */
export const LOCAL_EMBEDDING_VERSION = '1.0.0';
/** Documented fixed dimension. */
export const LOCAL_EMBEDDING_DIMENSION = 256;

/** Components are rounded to this many decimals so the vector is byte-stable. */
const PRECISION = 1e6;

export interface EmbeddingVector {
  readonly values: readonly number[];
  readonly dimension: number;
  readonly provider: string;
  readonly modelId: string;
  readonly version: string;
  /** Hash of the NORMALIZED input, so stale-source detection compares like with like. */
  readonly contentHash: string;
}

export interface EmbedOptions {
  readonly signal?: AbortSignal | undefined;
  /** Refuse oversized input rather than silently truncating a document into a misleading vector. */
  readonly maxChars?: number | undefined;
}

export const DEFAULT_MAX_CHARS = 200_000;

export class EmbeddingInputTooLargeError extends Error {
  readonly code = 'EMBEDDING_INPUT_TOO_LARGE' as const;
  constructor(chars: number, limit: number) {
    super(`embedding input of ${String(chars)} characters exceeds the limit of ${String(limit)}`);
    this.name = 'EmbeddingInputTooLargeError';
  }
}

/**
 * Normalize text before tokenizing.
 *
 * NFC first (ADR-0030: all text is NFC at the boundary), then case folding, so the same name written
 * with composed and decomposed Hangul or accents produces identical vectors. This is the property that
 * makes Unicode stability testable rather than hoped for.
 */
export function normalizeForEmbedding(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/**
 * Tokenize on Unicode letter/number boundaries.
 *
 * Uses property escapes rather than `\w`, which is ASCII-only and would discard romanized diacritics and
 * every non-Latin script — a silent quality loss that would look like a retrieval bug much later.
 */
export function tokenize(text: string): string[] {
  return normalizeForEmbedding(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Stable bucket and sign for one feature. */
function featureOf(token: string): { bucket: number; sign: number } {
  const digest = createHash('sha256').update(token, 'utf8').digest();
  // Two independent bytes ranges: one selects the bucket, one the sign. Signed hashing keeps unrelated
  // collisions from systematically inflating similarity.
  const bucket = digest.readUInt32BE(0) % LOCAL_EMBEDDING_DIMENSION;
  const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
  return { bucket, sign };
}

export function contentHashOf(text: string): string {
  return `sha256:${createHash('sha256').update(normalizeForEmbedding(text), 'utf8').digest('hex')}`;
}

/**
 * A local, deterministic embedder.
 *
 * Cancellation is checked between items of a batch and before the work of a single item, so a cancelled
 * generation stops promptly and leaves no partial vector behind for a caller to misread as complete.
 */
export class LocalDeterministicEmbedder {
  readonly provider = LOCAL_EMBEDDING_PROVIDER;
  readonly modelId = LOCAL_EMBEDDING_MODEL;
  readonly version = LOCAL_EMBEDDING_VERSION;
  readonly dimension = LOCAL_EMBEDDING_DIMENSION;

  embed(text: string, opts: EmbedOptions = {}): EmbeddingVector {
    if (opts.signal?.aborted === true) throw new Error('embedding cancelled');
    const limit = opts.maxChars ?? DEFAULT_MAX_CHARS;
    if (text.length > limit) throw new EmbeddingInputTooLargeError(text.length, limit);

    const raw = new Array<number>(LOCAL_EMBEDDING_DIMENSION).fill(0);
    const tokens = tokenize(text);
    for (const token of tokens) {
      const { bucket, sign } = featureOf(token);
      // Sublinear term weighting: a word repeated fifty times should not dominate a document's vector.
      raw[bucket] = (raw[bucket] ?? 0) + sign;
    }
    // Dampen magnitudes before normalizing, so long and short documents are comparable.
    const damped = raw.map((v) => (v === 0 ? 0 : Math.sign(v) * Math.log1p(Math.abs(v))));
    const norm = Math.sqrt(damped.reduce((sum, v) => sum + v * v, 0));
    const values =
      norm === 0 ? damped : damped.map((v) => Math.round((v / norm) * PRECISION) / PRECISION);

    return {
      values,
      dimension: LOCAL_EMBEDDING_DIMENSION,
      provider: this.provider,
      modelId: this.modelId,
      version: this.version,
      contentHash: contentHashOf(text),
    };
  }

  /** Batch embedding. Order-preserving and cancellation-aware. */
  embedBatch(texts: readonly string[], opts: EmbedOptions = {}): EmbeddingVector[] {
    const out: EmbeddingVector[] = [];
    for (const text of texts) {
      if (opts.signal?.aborted === true) throw new Error('embedding cancelled');
      out.push(this.embed(text, opts));
    }
    return out;
  }
}

export class EmbeddingDimensionMismatchError extends Error {
  readonly code = 'EMBEDDING_DIMENSION_MISMATCH' as const;
  constructor(a: number, b: number) {
    super(`cannot compare a ${String(a)}-dimension vector with a ${String(b)}-dimension vector`);
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/**
 * Cosine similarity of two normalized vectors, in [-1, 1].
 *
 * Refuses a dimension mismatch rather than comparing a prefix: silently comparing vectors from two
 * different embedding models would produce plausible-looking nonsense, which is the worst failure mode
 * available here.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new EmbeddingDimensionMismatchError(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  // Rounded so a deterministic tie stays a tie regardless of summation order.
  return Math.round(dot * PRECISION) / PRECISION;
}
