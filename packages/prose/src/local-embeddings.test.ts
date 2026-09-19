/**
 * The deterministic local embedding backend.
 *
 * Determinism is the whole contract here, so it is tested as a property rather than assumed: identical
 * input yields identical bytes, Unicode forms that should be equal are equal, and the failure modes
 * (oversized input, dimension mismatch) are refusals rather than silent truncation.
 */
import { describe, expect, it } from 'vitest';
import {
  contentHashOf,
  cosineSimilarity,
  DEFAULT_MAX_CHARS,
  EmbeddingDimensionMismatchError,
  EmbeddingInputTooLargeError,
  LOCAL_EMBEDDING_DIMENSION,
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_PROVIDER,
  LOCAL_EMBEDDING_VERSION,
  LocalDeterministicEmbedder,
  normalizeForEmbedding,
  tokenize,
} from './local-embeddings.js';

const embedder = new LocalDeterministicEmbedder();

describe('local deterministic embeddings', () => {
  it('is deterministic across repeated calls and fresh instances', () => {
    const text = 'Do-yoon looked at his hand. It was not shaking.';
    const a = embedder.embed(text);
    const b = embedder.embed(text);
    const c = new LocalDeterministicEmbedder().embed(text);
    expect(a.values).toEqual(b.values);
    expect(a.values).toEqual(c.values);
    // Byte-stable, not merely close: the stored vector must be reproducible exactly.
    expect(JSON.stringify(a.values)).toBe(JSON.stringify(c.values));
  });

  it('carries its full identity and a content hash', () => {
    const v = embedder.embed('the hall went quiet');
    expect(v.provider).toBe(LOCAL_EMBEDDING_PROVIDER);
    expect(v.modelId).toBe(LOCAL_EMBEDDING_MODEL);
    expect(v.version).toBe(LOCAL_EMBEDDING_VERSION);
    expect(v.dimension).toBe(LOCAL_EMBEDDING_DIMENSION);
    expect(v.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v.contentHash).toBe(contentHashOf('the hall went quiet'));
  });

  it('has the documented fixed dimension regardless of input length', () => {
    for (const text of ['', 'one', 'a much longer sentence with a good many words in it']) {
      expect(embedder.embed(text).values).toHaveLength(LOCAL_EMBEDDING_DIMENSION);
    }
  });

  it('is L2-normalized, so similarity is a dot product', () => {
    const v = embedder.embed('registration is on the left');
    const norm = Math.sqrt(v.values.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
    // Self-similarity is 1 for any non-empty text.
    expect(cosineSimilarity(v.values, v.values)).toBeCloseTo(1, 5);
  });

  it('an empty document is the zero vector, not a NaN', () => {
    const v = embedder.embed('   ');
    expect(v.values.every((x) => x === 0)).toBe(true);
    expect(cosineSimilarity(v.values, v.values)).toBe(0);
  });

  it('is stable across Unicode normalization forms', () => {
    // The same name in NFC and NFD must embed identically, or a decomposed query would silently miss.
    const nfc = 'Seo\u00e1'.normalize('NFC');
    const nfd = 'Seo\u00e1'.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    expect(embedder.embed(nfc).values).toEqual(embedder.embed(nfd).values);
    expect(normalizeForEmbedding(nfd)).toBe(normalizeForEmbedding(nfc));
  });

  it('is case-insensitive', () => {
    expect(embedder.embed('Porter Registration').values).toEqual(
      embedder.embed('porter registration').values,
    );
  });

  it('tokenizes on Unicode letters, not ASCII word characters', () => {
    // A romanized name with a diacritic must not be split apart or dropped.
    expect(tokenize('Kang Seo-ha, F-rank')).toEqual(['kang', 'seo', 'ha', 'f', 'rank']);
    expect(tokenize('Amélie')).toEqual(['amélie']);
  });

  it('ranks lexical overlap above unrelated text', () => {
    const query = embedder.embed('porter registration desk');
    const related = embedder.embed('Porter registration is on the left of the desk.');
    const unrelated = embedder.embed('The dragon slept beneath the mountain for an age.');
    expect(cosineSimilarity(query.values, related.values)).toBeGreaterThan(
      cosineSimilarity(query.values, unrelated.values),
    );
  });

  it('embeds a batch in order and preserves per-item results', () => {
    const texts = ['first document', 'second document', 'third document'];
    const batch = embedder.embedBatch(texts);
    expect(batch).toHaveLength(3);
    for (const [i, text] of texts.entries()) {
      expect(batch[i]?.values).toEqual(embedder.embed(text).values);
    }
  });

  it('refuses oversized input rather than truncating it into a misleading vector', () => {
    const huge = 'x'.repeat(DEFAULT_MAX_CHARS + 1);
    expect(() => embedder.embed(huge)).toThrow(EmbeddingInputTooLargeError);
    expect(() => embedder.embed('short', { maxChars: 2 })).toThrow(/exceeds the limit/);
  });

  it('honours cancellation before doing the work, and between batch items', () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(() => embedder.embed('anything', { signal: aborted.signal })).toThrow(/cancelled/);
    expect(() => embedder.embedBatch(['a', 'b'], { signal: aborted.signal })).toThrow(/cancelled/);
  });

  it('refuses to compare vectors of different dimensions', () => {
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(EmbeddingDimensionMismatchError);
  });

  it('similarity is symmetric and deterministic', () => {
    const a = embedder.embed('the officer said');
    const b = embedder.embed('the officer nodded');
    expect(cosineSimilarity(a.values, b.values)).toBe(cosineSimilarity(b.values, a.values));
  });
});
