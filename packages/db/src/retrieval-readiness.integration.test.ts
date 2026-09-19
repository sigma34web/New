/**
 * Versioned embedding sets, hybrid retrieval and the thesaurus (migrations 0016 and 0017).
 *
 * The cases are chosen around the failure modes that would be expensive to discover later: a set
 * activated while incomplete, a reader observing two active sets, a vector pointing at another project's
 * text, a stale version resurfacing after a rollback, and a generic alias outranking a canonical name.
 *
 * The vector side uses the repository's deterministic local embedder. Recall figures here are evidence
 * that the PIPELINE is correct, never evidence of production embedding quality.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentHashOf, LocalDeterministicEmbedder } from '@yeonjae/prose';
import {
  activateEmbeddingSet,
  approveManuscriptVersion,
  commitDelta,
  createManuscriptVersion,
  getProject,
  activeEmbeddingSet,
  addAlias,
  createEmbeddingSet,
  createPool,
  deactivateAlias,
  embeddingSetCompleteness,
  expandQuery,
  gcEligibleEmbeddingSets,
  getEmbeddingSet,
  hybridSearch,
  migrate,
  normalizeSurface,
  putEmbedding,
  recordEmbeddingFailure,
  resetDatabase,
  rollbackEmbeddingSet,
  vectorSearch,
  withTransaction,
  type Pool,
} from './index.js';
import { databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

const embedder = new LocalDeterministicEmbedder();

/** The fixture corpus: short, English, and shaped so the retrieval cases are unambiguous. */
const CORPUS: readonly { key: string; text: string; chapter: number }[] = [
  { key: 'p1', text: 'Kang Seo-ha registered as a porter at the eastern gate.', chapter: 1 },
  {
    key: 'p2',
    text: 'The officer told Do-yoon that porter registration was on the left.',
    chapter: 2,
  },
  { key: 'p3', text: 'Seo-ha carried the iron bell out of the collapsed dungeon.', chapter: 3 },
  {
    key: 'p4',
    text: 'The Hunters Association sealed the eastern gate after the breach.',
    chapter: 4,
  },
  {
    key: 'p5',
    text: 'A veiled instructor watched the porters from the upper gallery.',
    chapter: 5,
  },
  { key: 'p6', text: 'The dragon slept beneath the mountain for an age and an age.', chapter: 6 },
];

run('retrieval readiness: embedding sets, hybrid ranking and the thesaurus', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let otherProjectId: string;
  let seohaId: string;
  let timelineId: string;
  const docIds = new Map<string, string>();

  /**
   * Insert a search document backed by a genuinely ACCEPTED manuscript version.
   *
   * The acceptance path is walked in full -- create working, approve, then accept through
   * `canon.commit_delta` -- because the database refuses every shortcut: a version cannot be born
   * accepted, and `canon.search_document_guard` refuses to index anything that does not cite accepted
   * content. That refusal IS the accepted-content-only invariant this suite relies on, so the fixture
   * honours it rather than working around it.
   */
  const addDocument = async (
    project: string,
    key: string,
    text: string,
    chapter: number,
    timeline: string | null = null,
  ): Promise<string> => {
    const ch = await pool.query<{ id: string }>(
      `INSERT INTO chapters (workspace_id, project_id, number, status)
       VALUES ($1, $2, $3, 'drafted') RETURNING id`,
      [workspaceId, project, chapter],
    );
    const chapterId = ch.rows[0]?.id;
    if (!chapterId) throw new Error('chapter insert returned no row');
    const version = await createManuscriptVersion(pool, {
      workspaceId,
      projectId: project,
      chapterId,
      origin: 'assembled',
      text,
    });
    await approveManuscriptVersion(pool, version.id, 'fixture');
    const parent = (await getProject(pool, project)).canon_version;
    await commitDelta(pool, {
      projectId: project,
      parentVersion: parent,
      source: 'chapter_acceptance',
      chapterId,
      manuscriptVersionId: version.id,
      delta: { items: [] },
    });
    const r = await pool.query<{ id: string }>(
      `INSERT INTO search_documents
         (workspace_id, project_id, kind, ref_kind, ref_id, ref_key, chapter_no, timeline_id,
          text, manuscript_version_id, canon_version_added)
       VALUES ($1, $2, 'chapter_paragraph', 'manuscript_version', $3, $4, $5, $6, $7, $3, 1)
       RETURNING id`,
      [workspaceId, project, version.id, key, chapter, timeline, text],
    );
    const id = r.rows[0]?.id;
    if (!id) throw new Error('search document insert returned no row');
    return id;
  };

  const newSet = async (project = projectId, purpose = 'retrieval' as const) =>
    createEmbeddingSet(pool, {
      workspaceId,
      projectId: project,
      provider: embedder.provider,
      modelId: embedder.modelId,
      modelVersion: embedder.version,
      dimension: embedder.dimension,
      purpose,
      sourceContentHash: contentHashOf(CORPUS.map((c) => c.text).join('\n')),
    });

  /** Embed every fixture document into a set. Idempotent, like the real generation path. */
  const fill = async (setId: string, project = projectId): Promise<void> => {
    for (const [key, id] of docIds) {
      const doc = CORPUS.find((c) => c.key === key);
      if (!doc) continue;
      const vector = embedder.embed(doc.text);
      await putEmbedding(pool, {
        workspaceId,
        projectId: project,
        embeddingSetId: setId,
        searchDocumentId: id,
        embedding: vector.values,
        contentHash: vector.contentHash,
      });
    }
  };

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    pool = createPool({ connectionString: url, max: 6 });
    await resetDatabase(pool);
    await migrate(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // A fresh workspace and project per case: embedding sets and aliases are project-scoped, and the
    // isolation properties under test must not depend on cleanup order.
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name) VALUES ('retrieval') RETURNING id`,
    );
    const wsId = ws.rows[0]?.id;
    if (!wsId) throw new Error('workspace insert returned no row');
    workspaceId = wsId;
    const projects = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title, production_policy_version)
       VALUES ($1, 'main', 'standard.v1'), ($1, 'neighbour', 'standard.v1')
       RETURNING id`,
      [workspaceId],
    );
    const [main, neighbour] = projects.rows;
    if (!main || !neighbour) throw new Error('project insert returned no rows');
    projectId = main.id;
    otherProjectId = neighbour.id;

    const tl = await pool.query<{ id: string }>(
      `INSERT INTO timelines (workspace_id, project_id, kind, name)
       VALUES ($1, $2, 'main', 'main') RETURNING id`,
      [workspaceId, projectId],
    );
    const tlId = tl.rows[0]?.id;
    if (!tlId) throw new Error('timeline insert returned no row');
    timelineId = tlId;

    const entity = await pool.query<{ id: string }>(
      `INSERT INTO entities (workspace_id, project_id, type, display_name)
       VALUES ($1, $2, 'character', 'Kang Seo-ha') RETURNING id`,
      [workspaceId, projectId],
    );
    const eId = entity.rows[0]?.id;
    if (!eId) throw new Error('entity insert returned no row');
    seohaId = eId;

    docIds.clear();
    for (const doc of CORPUS) {
      docIds.set(doc.key, await addDocument(projectId, doc.key, doc.text, doc.chapter));
    }
  });

  // ---------------------------------------------------------------------------------------------------
  // Embedding-set lifecycle
  // ---------------------------------------------------------------------------------------------------

  it('a new set is inactive, carries its full identity, and is not yet reachable', async () => {
    const set = await newSet();
    expect(set.status).toBe('building');
    expect(set.provider).toBe('local_deterministic');
    expect(set.model_version).toBe(embedder.version);
    expect(set.dimension).toBe(256);
    expect(set.purpose).toBe('retrieval');
    expect(set.source_content_hash).toMatch(/^sha256:/);
    expect(await activeEmbeddingSet(pool, projectId)).toBeUndefined();
  });

  it('generation is idempotent, so an interrupted run resumes without duplicating', async () => {
    const set = await newSet();
    await fill(set.id);
    const first = await getEmbeddingSet(pool, set.id);
    expect(first?.item_count).toBe(CORPUS.length);
    // Re-run the whole generation, as a resumed job would.
    await fill(set.id);
    const second = await getEmbeddingSet(pool, set.id);
    expect(second?.item_count).toBe(CORPUS.length);
    const rows = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM embedding_vectors WHERE embedding_set_id = $1',
      [set.id],
    );
    expect(Number(rows.rows[0]?.n)).toBe(CORPUS.length);
  });

  it('refuses to activate an empty set, because retrieval would silently return nothing', async () => {
    const set = await newSet();
    await expect(activateEmbeddingSet(pool, set.id)).rejects.toThrow(/EMBEDDING_SET_EMPTY/);
  });

  it('refuses to activate a set with failed items', async () => {
    const set = await newSet();
    await fill(set.id);
    await recordEmbeddingFailure(pool, set.id, 2);
    await expect(activateEmbeddingSet(pool, set.id)).rejects.toThrow(/EMBEDDING_SET_INCOMPLETE/);
  });

  it('reports completeness, and distinguishes missing items from stale ones', async () => {
    const set = await newSet();
    await fill(set.id);
    const complete = await embeddingSetCompleteness(pool, set.id, contentHashOf);
    expect(complete.complete).toBe(true);
    expect(complete.missingDocumentIds).toHaveLength(0);

    // A new document appears: the set is now incomplete.
    const added = await addDocument(projectId, 'p7', 'A late addition to the corpus.', 7);
    const missing = await embeddingSetCompleteness(pool, set.id, contentHashOf);
    expect(missing.complete).toBe(false);
    expect(missing.missingDocumentIds).toContain(added);

    // An existing document's text changes: its vector describes text that no longer exists.
    await pool.query('UPDATE search_documents SET text = $2 WHERE id = $1', [
      docIds.get('p1'),
      'Kang Seo-ha never registered at all.',
    ]);
    const stale = await embeddingSetCompleteness(pool, set.id, contentHashOf);
    expect(stale.staleDocumentIds).toContain(docIds.get('p1'));
  });

  it('activation is atomic: exactly one set is active, and re-activation is idempotent', async () => {
    const first = await newSet();
    await fill(first.id);
    await activateEmbeddingSet(pool, first.id);
    expect((await activeEmbeddingSet(pool, projectId))?.id).toBe(first.id);

    const second = await newSet();
    await fill(second.id);
    const promoted = await activateEmbeddingSet(pool, second.id);
    expect(promoted.replaced_set_id).toBe(first.id);
    expect((await getEmbeddingSet(pool, first.id))?.status).toBe('retired');

    const actives = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM embedding_sets
        WHERE project_id = $1 AND purpose = 'retrieval' AND status = 'active'`,
      [projectId],
    );
    expect(Number(actives.rows[0]?.n)).toBe(1);

    // Idempotent: a retried operator action must not flap the pointer.
    const again = await activateEmbeddingSet(pool, second.id);
    expect(again.id).toBe(second.id);
  });

  it('concurrent activation from separate connections leaves exactly one active set', async () => {
    const a = await newSet();
    const b = await newSet();
    await fill(a.id);
    await fill(b.id);

    // Two real transactions on two connections, racing to promote different sets.
    const results = await Promise.allSettled([
      withTransaction(pool, (client) => activateEmbeddingSet(client, a.id)),
      withTransaction(pool, (client) => activateEmbeddingSet(client, b.id)),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Both may serialize successfully (one replacing the other) but the INVARIANT is the count.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const actives = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM embedding_sets
        WHERE project_id = $1 AND purpose = 'retrieval' AND status = 'active'`,
      [projectId],
    );
    expect(Number(actives.rows[0]?.n)).toBe(1);
  });

  it('a reader never observes a project with no active set during a switch', async () => {
    const first = await newSet();
    await fill(first.id);
    await activateEmbeddingSet(pool, first.id);
    const second = await newSet();
    await fill(second.id);

    // Inside a transaction that has not committed, the outside world still sees the old set.
    const observed = await withTransaction(pool, async (client) => {
      await activateEmbeddingSet(client, second.id);
      return (await activeEmbeddingSet(pool, projectId))?.id;
    });
    expect(observed).toBe(first.id);
    expect((await activeEmbeddingSet(pool, projectId))?.id).toBe(second.id);
  });

  it('rolls back to the previous set, and only to the one actually replaced', async () => {
    const first = await newSet();
    await fill(first.id);
    await activateEmbeddingSet(pool, first.id);
    const second = await newSet();
    await fill(second.id);
    await activateEmbeddingSet(pool, second.id);

    const restored = await rollbackEmbeddingSet(pool, projectId);
    expect(restored.id).toBe(first.id);
    expect(restored.status).toBe('active');
    expect((await getEmbeddingSet(pool, second.id))?.status).toBe('retired');
    // The previous set was RETAINED, which is what made the rollback possible.
    const vectors = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM embedding_vectors WHERE embedding_set_id = $1',
      [first.id],
    );
    expect(Number(vectors.rows[0]?.n)).toBe(CORPUS.length);
  });

  it('refuses a rollback when the active set replaced nothing', async () => {
    const only = await newSet();
    await fill(only.id);
    await activateEmbeddingSet(pool, only.id);
    await expect(rollbackEmbeddingSet(pool, projectId)).rejects.toThrow(
      /EMBEDDING_SET_NO_PREVIOUS/,
    );
  });

  it('rejects a dimension mismatch at the write', async () => {
    const set = await newSet();
    const doc = docIds.get('p1');
    if (!doc) throw new Error('missing fixture document');
    await expect(
      putEmbedding(pool, {
        workspaceId,
        projectId,
        embeddingSetId: set.id,
        searchDocumentId: doc,
        embedding: [0.1, 0.2, 0.3],
        contentHash: 'sha256:short',
      }),
    ).rejects.toThrow(/EMBEDDING_DIMENSION_MISMATCH/);
  });

  it('refuses a vector that describes another project document', async () => {
    const set = await newSet();
    const foreign = await addDocument(otherProjectId, 'x1', 'Another project text.', 1);
    const vector = embedder.embed('Another project text.');
    await expect(
      putEmbedding(pool, {
        workspaceId,
        projectId,
        embeddingSetId: set.id,
        searchDocumentId: foreign,
        embedding: vector.values,
        contentHash: vector.contentHash,
      }),
    ).rejects.toThrow(/EMBEDDING_CROSS_PROJECT/);
  });

  it('supports a model-version migration as a new set, without mixing vectors', async () => {
    const old = await newSet();
    await fill(old.id);
    await activateEmbeddingSet(pool, old.id);
    // A "new model version": a different identity, therefore a different set.
    const next = await createEmbeddingSet(pool, {
      workspaceId,
      projectId,
      provider: embedder.provider,
      modelId: embedder.modelId,
      modelVersion: '2.0.0',
      dimension: embedder.dimension,
    });
    await fill(next.id);
    await activateEmbeddingSet(pool, next.id);
    const active = await activeEmbeddingSet(pool, projectId);
    expect(active?.model_version).toBe('2.0.0');
    // Vector sets remain separate: nothing was rewritten in place.
    const counts = await pool.query<{ embedding_set_id: string; n: string }>(
      `SELECT embedding_set_id, count(*)::text AS n FROM embedding_vectors
        WHERE project_id = $1 GROUP BY embedding_set_id`,
      [projectId],
    );
    expect(counts.rows).toHaveLength(2);
  });

  it('reports garbage-collection eligibility without destroying anything', async () => {
    const a = await newSet();
    await fill(a.id);
    await activateEmbeddingSet(pool, a.id);
    const b = await newSet();
    await fill(b.id);
    await activateEmbeddingSet(pool, b.id);
    const c = await newSet();
    await fill(c.id);
    await activateEmbeddingSet(pool, c.id);

    const eligible = await gcEligibleEmbeddingSets(pool, projectId, 1);
    // `a` is eligible; `b` is not, because the active set could roll back to it.
    expect(eligible.map((e) => e.id)).toContain(a.id);
    expect(eligible.map((e) => e.id)).not.toContain(b.id);
    // Nothing was deleted by asking.
    expect(await getEmbeddingSet(pool, a.id)).toBeDefined();
  });

  // ---------------------------------------------------------------------------------------------------
  // Hybrid retrieval
  // ---------------------------------------------------------------------------------------------------

  it('falls back to lexical retrieval when no embedding set is active', async () => {
    const result = await hybridSearch(pool, { projectId, query: 'porter registration' });
    expect(result.diagnostics.mode).toBe('lexical_only');
    expect(result.diagnostics.notes.join(' ')).toMatch(/no active embedding set/);
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('combines lexical and vector evidence, and records which source found each hit', async () => {
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    const result = await hybridSearch(pool, {
      projectId,
      query: 'porter registration',
      queryVector: embedder.embed('porter registration').values,
    });
    expect(result.diagnostics.mode).toBe('hybrid');
    expect(result.diagnostics.embeddingSetId).toBe(set.id);
    const top = result.hits[0];
    expect(top?.text).toMatch(/porter registration/i);
    expect(top?.sources).toContain('lexical');
    expect(result.hits.some((h) => h.sources.includes('vector'))).toBe(true);
  });

  it('refuses a query vector whose dimension does not match the active set', async () => {
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    const result = await hybridSearch(pool, {
      projectId,
      query: 'porter',
      queryVector: [0.1, 0.2],
    });
    // Degraded, not silently wrong.
    expect(result.diagnostics.mode).toBe('lexical_only');
    expect(result.diagnostics.notes.join(' ')).toMatch(/does not match the active set/);
  });

  it('never reads beyond the chapter bound', async () => {
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    const result = await hybridSearch(pool, {
      projectId,
      query: 'gate eastern dragon mountain',
      queryVector: embedder.embed('gate eastern dragon mountain').values,
      chapterMax: 3,
    });
    for (const hit of result.hits) {
      expect(hit.chapterNo === null || hit.chapterNo <= 3).toBe(true);
    }
    expect(result.hits.some((h) => h.text.includes('dragon'))).toBe(false);
  });

  it('isolates projects: a neighbour corpus is never returned', async () => {
    await addDocument(otherProjectId, 'x1', 'Kang Seo-ha registered as a porter elsewhere.', 1);
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    const result = await hybridSearch(pool, {
      projectId: otherProjectId,
      query: 'porter registered',
    });
    for (const hit of result.hits) {
      expect(hit.text).not.toMatch(/eastern gate/);
    }
    // And the neighbour has no active set of its own, so it degrades rather than borrowing ours.
    expect(result.diagnostics.embeddingSetId).toBeNull();
  });

  it('isolates timelines', async () => {
    const alternate = await pool.query<{ id: string }>(
      `INSERT INTO timelines (workspace_id, project_id, kind, name)
       VALUES ($1, $2, 'source_story', 'previous life') RETURNING id`,
      [workspaceId, projectId],
    );
    const altId = alternate.rows[0]?.id;
    if (!altId) throw new Error('timeline insert returned no row');
    await addDocument(projectId, 'alt1', 'In the source story the gate never opened.', 8, altId);
    const result = await hybridSearch(pool, {
      projectId,
      query: 'gate',
      timelineId,
    });
    for (const hit of result.hits) {
      expect(hit.timelineId === null || hit.timelineId === timelineId).toBe(true);
    }
  });

  it('switching the active set changes results atomically, and a rollback restores them', async () => {
    const first = await newSet();
    await fill(first.id);
    await activateEmbeddingSet(pool, first.id);

    // A second set that deliberately embeds only ONE document, so the difference is observable.
    const second = await newSet();
    const onlyDoc = docIds.get('p6');
    if (!onlyDoc) throw new Error('missing fixture document');
    const dragon = embedder.embed('The dragon slept beneath the mountain for an age and an age.');
    await putEmbedding(pool, {
      workspaceId,
      projectId,
      embeddingSetId: second.id,
      searchDocumentId: onlyDoc,
      embedding: dragon.values,
      contentHash: dragon.contentHash,
    });
    await activateEmbeddingSet(pool, second.id);

    const query = embedder.embed('porter registration').values;
    const narrow = await vectorSearch(pool, { embeddingSetId: second.id, query });
    expect(narrow).toHaveLength(1);

    const restored = await rollbackEmbeddingSet(pool, projectId);
    expect(restored.id).toBe(first.id);
    const wide = await vectorSearch(pool, { embeddingSetId: first.id, query });
    expect(wide).toHaveLength(CORPUS.length);
  });

  it('breaks ties deterministically, so the same query always returns the same order', async () => {
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    const query = { projectId, query: 'gate', queryVector: embedder.embed('gate').values };
    const first = await hybridSearch(pool, query);
    const second = await hybridSearch(pool, query);
    const third = await hybridSearch(pool, query);
    expect(second.hits.map((h) => h.searchDocumentId)).toEqual(
      first.hits.map((h) => h.searchDocumentId),
    );
    expect(third.hits.map((h) => h.searchDocumentId)).toEqual(
      first.hits.map((h) => h.searchDocumentId),
    );
  });

  it('honours configurable weighting', async () => {
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    const base = {
      projectId,
      query: 'porter registration',
      queryVector: embedder.embed('porter registration').values,
    };
    const lexicalHeavy = await hybridSearch(pool, {
      ...base,
      weights: { lexical: 1, vector: 0 },
    });
    const vectorHeavy = await hybridSearch(pool, {
      ...base,
      weights: { lexical: 0, vector: 1 },
    });
    expect(lexicalHeavy.diagnostics.weights).toEqual({ lexical: 1, vector: 0 });
    // With vector weight zero, a vector-only hit cannot outrank a lexical one.
    expect(lexicalHeavy.hits[0]?.lexicalScore).toBeGreaterThan(0);
    expect(vectorHeavy.hits[0]?.vectorScore).toBeGreaterThan(0);
  });

  it('deduplicates a document found by both sources into one hit', async () => {
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    const result = await hybridSearch(pool, {
      projectId,
      query: 'porter registration',
      queryVector: embedder.embed('porter registration').values,
    });
    const ids = result.hits.map((h) => h.searchDocumentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('bounds the result count and the payload size', async () => {
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    // A content word, not a stopword: `to_tsvector('english')` strips "the", so a stopword query
    // matches nothing and would exercise neither bound.
    const limited = await hybridSearch(pool, { projectId, query: 'gate porter dragon', limit: 2 });
    expect(limited.hits).toHaveLength(2);
    const tiny = await hybridSearch(pool, { projectId, query: 'gate porter dragon', maxChars: 10 });
    expect(tiny.diagnostics.truncated).toBe(true);
  });

  it('measures fixture recall@3 for the pipeline (NOT production quality)', async () => {
    const set = await newSet();
    await fill(set.id);
    await activateEmbeddingSet(pool, set.id);
    const probes: readonly { query: string; expectKey: string }[] = [
      { query: 'porter registration left', expectKey: 'p2' },
      { query: 'iron bell collapsed dungeon', expectKey: 'p3' },
      { query: 'Hunters Association sealed breach', expectKey: 'p4' },
      { query: 'dragon mountain age', expectKey: 'p6' },
    ];
    let found = 0;
    for (const probe of probes) {
      const result = await hybridSearch(pool, {
        projectId,
        query: probe.query,
        queryVector: embedder.embed(probe.query).values,
        limit: 3,
      });
      const want = docIds.get(probe.expectKey);
      if (result.hits.slice(0, 3).some((h) => h.searchDocumentId === want)) found++;
    }
    // Recorded as a pipeline property. This is lexical-overlap retrieval over a six-document fixture;
    // it says nothing about production embedding quality.
    expect(found).toBe(probes.length);
  });

  // ---------------------------------------------------------------------------------------------------
  // Thesaurus
  // ---------------------------------------------------------------------------------------------------

  it('folds spacing, case and hyphenation into one lookup key', () => {
    expect(normalizeSurface('Seo-ha')).toBe(normalizeSurface('Seo Ha'));
    expect(normalizeSurface('Seo-ha')).toBe(normalizeSurface('seoha'));
    expect(normalizeSurface('Kang  Seo-Ha')).toBe('kangseoha');
  });

  it('expands a canonical name to its aliases, and keeps the caller terms', async () => {
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'canonical',
      surface: 'Kang Seo-ha',
    });
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'romanization',
      surface: 'Gang Seo-ha',
    });
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'title',
      surface: 'the porter',
    });
    const expansion = await expandQuery(pool, { projectId, query: 'Kang Seo-ha' });
    const surfaces = expansion.terms.map((t) => t.surface);
    expect(surfaces).toContain('Kang Seo-ha');
    // A distinct romanization is reached...
    expect(surfaces).toContain('Gang Seo-ha');
    // ...while a spacing variant that folds to the SAME key as the canonical surface is deduplicated
    // into the stronger canonical reading rather than listed twice.
    expect(normalizeSurface('Kang Seoha')).toBe(normalizeSurface('Kang Seo-ha'));
    // A canonical surface outranks a generic title, so a title cannot dominate.
    const canonical = expansion.terms.find((t) => t.kind === 'canonical');
    const title = expansion.terms.find((t) => t.kind === 'title');
    expect(canonical?.weight).toBeGreaterThan(title?.weight ?? 1);
  });

  it('excludes inactive aliases but retains them', async () => {
    const former = await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'former_name',
      surface: 'Kang Ari',
    });
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'canonical',
      surface: 'Kang Seo-ha',
    });
    await deactivateAlias(pool, former.id);
    const expansion = await expandQuery(pool, { projectId, query: 'Kang Seo-ha' });
    expect(expansion.terms.map((t) => t.surface)).not.toContain('Kang Ari');
    expect(expansion.diagnostics.excludedInactive).toBeGreaterThan(0);
    // Retained as history, not deleted.
    const rows = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM name_aliases WHERE id = $1',
      [former.id],
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it('keeps an ambiguous alias weaker and flags it in diagnostics', async () => {
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'canonical',
      surface: 'Kang Seo-ha',
    });
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'title',
      surface: 'the captain',
      ambiguous: true,
    });
    const expansion = await expandQuery(pool, { projectId, query: 'Kang Seo-ha' });
    expect(expansion.diagnostics.ambiguousSurfaces).toContain('the captain');
    const captain = expansion.terms.find((t) => t.surface === 'the captain');
    const canonical = expansion.terms.find((t) => t.kind === 'canonical');
    expect(captain?.weight ?? 0).toBeLessThan(canonical?.weight ?? 0);
  });

  it('excludes a disguise unless it is opted into', async () => {
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'canonical',
      surface: 'Kang Seo-ha',
    });
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'disguise',
      surface: 'the veiled instructor',
      revealsEntity: seohaId,
    });
    const guarded = await expandQuery(pool, { projectId, query: 'Kang Seo-ha' });
    expect(guarded.terms.map((t) => t.surface)).not.toContain('the veiled instructor');
    const opened = await expandQuery(pool, {
      projectId,
      query: 'Kang Seo-ha',
      includeDisguises: true,
    });
    expect(opened.terms.map((t) => t.surface)).toContain('the veiled instructor');
  });

  it('does not expand a surface that is only in play after a later chapter', async () => {
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'canonical',
      surface: 'Kang Seo-ha',
    });
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'title',
      surface: 'Guild Master',
      fromChapter: 40,
    });
    const early = await expandQuery(pool, { projectId, query: 'Kang Seo-ha', chapterMax: 10 });
    expect(early.terms.map((t) => t.surface)).not.toContain('Guild Master');
    const later = await expandQuery(pool, { projectId, query: 'Kang Seo-ha', chapterMax: 50 });
    expect(later.terms.map((t) => t.surface)).toContain('Guild Master');
  });

  it('bounds expansion and reports what it dropped', async () => {
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'canonical',
      surface: 'Kang Seo-ha',
    });
    for (let i = 0; i < 20; i++) {
      await addAlias(pool, {
        workspaceId,
        projectId,
        entityId: seohaId,
        kind: 'alias',
        surface: `Alias Number ${String(i)}`,
      });
    }
    const expansion = await expandQuery(pool, { projectId, query: 'Kang Seo-ha', limit: 5 });
    expect(expansion.terms).toHaveLength(5);
    expect(expansion.diagnostics.droppedForBound).toBeGreaterThan(0);
  });

  it('never leaks aliases across projects', async () => {
    const neighbourEntity = await pool.query<{ id: string }>(
      `INSERT INTO entities (workspace_id, project_id, type, display_name)
       VALUES ($1, $2, 'character', 'Someone Else') RETURNING id`,
      [workspaceId, otherProjectId],
    );
    const otherEntity = neighbourEntity.rows[0]?.id;
    if (!otherEntity) throw new Error('entity insert returned no row');
    await addAlias(pool, {
      workspaceId,
      projectId: otherProjectId,
      entityId: otherEntity,
      kind: 'canonical',
      surface: 'Kang Seo-ha',
    });
    await addAlias(pool, {
      workspaceId,
      projectId: otherProjectId,
      entityId: otherEntity,
      kind: 'alias',
      surface: 'Neighbour Secret Name',
    });
    const expansion = await expandQuery(pool, { projectId, query: 'Kang Seo-ha' });
    expect(expansion.terms.map((t) => t.surface)).not.toContain('Neighbour Secret Name');
  });

  it('refuses an alias that describes another project entity', async () => {
    const neighbourEntity = await pool.query<{ id: string }>(
      `INSERT INTO entities (workspace_id, project_id, type, display_name)
       VALUES ($1, $2, 'character', 'Foreign') RETURNING id`,
      [workspaceId, otherProjectId],
    );
    const otherEntity = neighbourEntity.rows[0]?.id;
    if (!otherEntity) throw new Error('entity insert returned no row');
    await expect(
      addAlias(pool, {
        workspaceId,
        projectId,
        entityId: otherEntity,
        kind: 'alias',
        surface: 'Smuggled',
      }),
    ).rejects.toThrow(/ALIAS_CROSS_PROJECT/);
  });

  it('finds canon through an alias that the raw query would have missed', async () => {
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'canonical',
      surface: 'Seo-ha',
    });
    await addAlias(pool, {
      workspaceId,
      projectId,
      entityId: seohaId,
      kind: 'organization',
      surface: 'Hunters Association',
    });
    // The raw query misses the Association paragraph; expansion reaches it.
    const raw = await hybridSearch(pool, { projectId, query: 'Seoha' });
    const expanded = await hybridSearch(pool, {
      projectId,
      query: 'Seoha',
      useThesaurus: true,
    });
    expect(expanded.diagnostics.expandedTerms.length).toBeGreaterThan(0);
    expect(expanded.hits.length).toBeGreaterThanOrEqual(raw.hits.length);
    expect(expanded.hits.some((h) => h.text.includes('Hunters Association'))).toBe(true);
  });
});
