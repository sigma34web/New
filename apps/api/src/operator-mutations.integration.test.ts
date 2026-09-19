/**
 * Audited, owner-gated operator mutations (Workstream B).
 *
 * The read surface answers questions; these routes change what the system does next, and that changes
 * what has to be proved. Activating an embedding set redirects every subsequent retrieval, and a
 * thesaurus edit changes how queries resolve, so each case below targets a way a mutation boundary
 * typically goes wrong:
 *
 *  * AUTHORIZATION IS GRADED, not binary. A viewer and an editor must both be refused; only an owner may
 *    proceed. A surface that merely checked "authenticated" would let any member repoint retrieval.
 *  * A CROSS-TENANT TARGET IS A 404. Same rule as the reads: a 403 would confirm the resource exists.
 *  * THE DATABASE'S PRECONDITIONS SURVIVE THE BOUNDARY. An incomplete embedding set must be refused
 *    through HTTP exactly as migration 0016 refuses it, with a stable code rather than a 500.
 *  * REPEATS ARE SAFE. A redelivered activation or deactivation must converge, not flap or fail.
 *  * AUDIT IS WRITTEN FOR BOTH OUTCOMES and carries no forbidden data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createEntity,
  createEmbeddingSet,
  createUser,
  createWorkspace,
  migrate,
  putEmbedding,
  recordEmbeddingFailure,
  resetDatabase,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApi } from './server.js';
import { RateLimiter } from './rate-limit.js';
import { CSRF_HEADER, WORKSPACE_HEADER } from './auth.js';
import { seedAcceptedChapterOne, type SeededProject } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

interface Actor {
  readonly cookie: string;
  readonly csrf: string;
  readonly userId: string;
}

run('API: operator mutations (Workstream B)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let seeded: SeededProject;
  let owner: Actor;
  let editor: Actor;
  let viewer: Actor;
  let otherWorkspaceId: string;
  let otherProjectId: string;

  async function login(email: string, password: string): Promise<Actor> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const body = res.json<{ csrf_token: string; user: { id: string } }>();
    return { userId: body.user.id, cookie: String(raw).split(';')[0] ?? '', csrf: body.csrf_token };
  }

  function headers(actor: Actor, workspaceId = seeded.workspaceId): Record<string, string> {
    return { cookie: actor.cookie, [WORKSPACE_HEADER]: workspaceId, [CSRF_HEADER]: actor.csrf };
  }

  async function post(
    url: string,
    actor: Actor,
    payload: unknown = {},
    workspaceId = seeded.workspaceId,
  ): Promise<LightMyRequestResponse> {
    return app.inject({ method: 'POST', url, headers: headers(actor, workspaceId), payload });
  }

  async function makeMember(email: string, role: 'viewer' | 'editor' | 'owner'): Promise<Actor> {
    const user = await createUser(pool, {
      email,
      displayName: role,
      password: `${role}-password-1`,
    });
    await addMember(pool, { workspaceId: seeded.workspaceId, userId: user.id, role });
    return login(email, `${role}-password-1`);
  }

  /** A complete, activatable set: one vector, no failures. */
  async function completeSet(): Promise<string> {
    const set = await createEmbeddingSet(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      provider: 'local',
      modelId: 'deterministic',
      modelVersion: '1.0.0',
      dimension: 8,
    });
    const doc = await pool.query<{ id: string }>(
      'SELECT id FROM search_documents WHERE project_id = $1 LIMIT 1',
      [seeded.projectId],
    );
    const documentId = doc.rows[0]?.id;
    if (!documentId) throw new Error('the seeded project has no search document to embed');
    await putEmbedding(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      embeddingSetId: set.id,
      searchDocumentId: documentId,
      embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      contentHash: 'deadbeef',
    });
    return set.id;
  }

  async function auditRows(action: string): Promise<{ action: string; detail: unknown }[]> {
    const r = await pool.query<{ action: string; detail: unknown }>(
      'SELECT action, detail FROM audit_log WHERE action = $1 ORDER BY created_at',
      [action],
    );
    return r.rows;
  }

  beforeAll(async () => {
    pool = await freshDatabase();
    app = buildApi({ pool, secureCookies: false, rateLimiter: RateLimiter.disabled() });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    seeded = await seedAcceptedChapterOne(pool);
    owner = await makeMember('mut-owner@example.com', 'owner');
    editor = await makeMember('mut-editor@example.com', 'editor');
    viewer = await makeMember('mut-viewer@example.com', 'viewer');

    otherWorkspaceId = await createWorkspace(pool, 'Other Mutation Tenant');
    const otherProject = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title) VALUES ($1, 'Other Mutation Project') RETURNING id`,
      [otherWorkspaceId],
    );
    otherProjectId = otherProject.rows[0]?.id ?? '';
  }, 300_000);

  // ---- authorization -------------------------------------------------------------------------------

  it('refuses every mutation without authentication', async () => {
    const urls = [
      `/v1/projects/${seeded.projectId}/operator/embedding-sets/rollback`,
      `/v1/projects/${seeded.projectId}/operator/thesaurus`,
    ];
    for (const url of urls) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('UNAUTHENTICATED');
    }
  });

  it('refuses a viewer and an editor, and admits only an owner', async () => {
    const setId = await completeSet();
    const url = `/v1/projects/${seeded.projectId}/operator/embedding-sets/${setId}/activate`;

    for (const actor of [viewer, editor]) {
      const res = await post(url, actor);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('FORBIDDEN');
    }
    const allowed = await post(url, owner);
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(allowed.json<{ status: string }>().status).toBe('active');
  });

  // ---- tenant and project isolation ----------------------------------------------------------------

  it('hides another workspace’s project behind a 404 on every mutation', async () => {
    for (const url of [
      `/v1/projects/${otherProjectId}/operator/embedding-sets/rollback`,
      `/v1/projects/${otherProjectId}/operator/thesaurus`,
    ]) {
      const res = await post(url, owner, { surface: 'Probe' });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
      expect(res.body).not.toContain(otherWorkspaceId);
    }
  });

  it('refuses an embedding set that belongs to another project', async () => {
    const foreign = await createEmbeddingSet(pool, {
      workspaceId: otherWorkspaceId,
      projectId: otherProjectId,
      provider: 'local',
      modelId: 'deterministic',
      modelVersion: '1.0.0',
      dimension: 8,
    });
    const res = await post(
      `/v1/projects/${seeded.projectId}/operator/embedding-sets/${foreign.id}/activate`,
      owner,
    );
    expect(res.statusCode, res.body).toBe(404);
  });

  it('refuses an alias pointing at an entity in another project', async () => {
    const foreignEntity = await createEntity(pool, {
      workspaceId: otherWorkspaceId,
      projectId: otherProjectId,
      type: 'character',
      displayName: 'Foreign Character',
    });
    const res = await post(`/v1/projects/${seeded.projectId}/operator/thesaurus`, owner, {
      surface: 'Borrowed Name',
      entity_id: foreignEntity,
    });
    expect(res.statusCode, res.body).toBe(404);
  });

  // ---- embedding-set preconditions -----------------------------------------------------------------

  it('refuses to activate an empty set with a stable code, not a 500', async () => {
    const empty = await createEmbeddingSet(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      provider: 'local',
      modelId: 'deterministic',
      modelVersion: '1.0.0',
      dimension: 8,
    });
    const res = await post(
      `/v1/projects/${seeded.projectId}/operator/embedding-sets/${empty.id}/activate`,
      owner,
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('EMBEDDING_SET_EMPTY');
  });

  it('refuses to activate an incomplete set', async () => {
    const setId = await completeSet();
    // One recorded failure is enough: migration 0016 refuses any set with failed_count > 0.
    await recordEmbeddingFailure(pool, setId, 1);
    const res = await post(
      `/v1/projects/${seeded.projectId}/operator/embedding-sets/${setId}/activate`,
      owner,
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('EMBEDDING_SET_INCOMPLETE');
  });

  it('is idempotent: activating the active set again converges instead of flapping', async () => {
    const setId = await completeSet();
    const url = `/v1/projects/${seeded.projectId}/operator/embedding-sets/${setId}/activate`;
    const first = await post(url, owner);
    expect(first.statusCode, first.body).toBe(200);
    const second = await post(url, owner);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<{ set_id: string; status: string }>()).toMatchObject({
      set_id: setId,
      status: 'active',
    });
    // Exactly one set is active, which is the invariant the partial unique index protects.
    const active = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM embedding_sets WHERE project_id = $1 AND status = 'active'`,
      [seeded.projectId],
    );
    expect(active.rows[0]?.n).toBe('1');
  });

  it('refuses a rollback when there is no previous set to restore', async () => {
    const res = await post(
      `/v1/projects/${seeded.projectId}/operator/embedding-sets/rollback`,
      owner,
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json<{ data: { reason: string } }>().data.reason).toBe('NO_ROLLBACK_TARGET');
  });

  // ---- thesaurus -----------------------------------------------------------------------------------

  it('creates an alias and reports it through the read surface', async () => {
    const entityId = await createEntity(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      type: 'character',
      displayName: 'Titled Character',
    });
    const res = await post(`/v1/projects/${seeded.projectId}/operator/thesaurus`, owner, {
      surface: 'The Unbroken Blade',
      kind: 'title',
      entity_id: entityId,
    });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json<{ alias_id: string; surface: string; active: boolean }>();
    expect(created.active).toBe(true);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/projects/${seeded.projectId}/operator/thesaurus`,
      headers: headers(owner),
    });
    const body = listed.json<{ items: { alias_id: string }[] }>();
    expect(body.items.map((i) => i.alias_id)).toContain(created.alias_id);
  });

  it('marks a surface ambiguous when it resolves to a second entity, on BOTH rows', async () => {
    const first = await createEntity(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      type: 'character',
      displayName: 'First Character',
    });
    const second = await createEntity(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      type: 'character',
      displayName: 'Second Character',
    });
    const url = `/v1/projects/${seeded.projectId}/operator/thesaurus`;
    const a = await post(url, owner, { surface: 'Shared Name', entity_id: first });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json<{ ambiguous: boolean }>().ambiguous).toBe(false);

    const b = await post(url, owner, { surface: 'Shared Name', entity_id: second });
    expect(b.statusCode, b.body).toBe(201);
    expect(b.json<{ ambiguous: boolean }>().ambiguous).toBe(true);

    // The FIRST row became ambiguous too: ambiguity is a property of the surface, not of the newcomer.
    const rows = await pool.query<{ ambiguous: boolean }>(
      'SELECT ambiguous FROM name_aliases WHERE project_id = $1 AND surface = $2',
      [seeded.projectId, 'Shared Name'],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.ambiguous)).toBe(true);
  });

  it('deactivates and reactivates an alias, idempotently', async () => {
    const entityId = await createEntity(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      type: 'character',
      displayName: 'Retiring Character',
    });
    const created = await post(`/v1/projects/${seeded.projectId}/operator/thesaurus`, owner, {
      surface: 'Retired Title',
      entity_id: entityId,
    });
    const aliasId = created.json<{ alias_id: string }>().alias_id;
    const base = `/v1/projects/${seeded.projectId}/operator/thesaurus/${aliasId}`;

    const off = await post(`${base}/deactivate`, owner);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json<{ active: boolean }>().active).toBe(false);

    // Repeating it is a no-op rather than an error, so a duplicate delivery is a non-event.
    const offAgain = await post(`${base}/deactivate`, owner);
    expect(offAgain.statusCode, offAgain.body).toBe(200);
    expect(offAgain.json<{ active: boolean }>().active).toBe(false);

    const on = await post(`${base}/reactivate`, owner);
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json<{ active: boolean }>().active).toBe(true);
  });

  it('refuses an unknown alias action rather than guessing', async () => {
    const entityId = await createEntity(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      type: 'character',
      displayName: 'Acted Character',
    });
    const created = await post(`/v1/projects/${seeded.projectId}/operator/thesaurus`, owner, {
      surface: 'Some Name',
      entity_id: entityId,
    });
    const aliasId = created.json<{ alias_id: string }>().alias_id;
    const res = await post(
      `/v1/projects/${seeded.projectId}/operator/thesaurus/${aliasId}/destroy`,
      owner,
    );
    expect(res.statusCode, res.body).toBe(422);
  });

  it('enforces migration 0017’s entity rule with a stable code rather than a 500', async () => {
    const url = `/v1/projects/${seeded.projectId}/operator/thesaurus`;
    // A non-terminology alias must name an entity.
    const missing = await post(url, owner, { surface: 'Nameless Title', kind: 'title' });
    expect(missing.statusCode, missing.body).toBe(422);
    expect(missing.json<{ code: string }>().code).toBe('VALIDATION_FAILED');

    // And a terminology entry must NOT name one.
    const entityId = await createEntity(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      type: 'character',
      displayName: 'Terminology Holder',
    });
    const extra = await post(url, owner, {
      surface: 'Qi Circulation',
      kind: 'terminology',
      entity_id: entityId,
    });
    expect(extra.statusCode, extra.body).toBe(422);

    // The valid terminology form is accepted.
    const ok = await post(url, owner, { surface: 'Qi Circulation', kind: 'terminology' });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  // ---- input validation ----------------------------------------------------------------------------

  it('refuses a malformed body, an oversized surface and an unknown kind', async () => {
    const url = `/v1/projects/${seeded.projectId}/operator/thesaurus`;
    for (const payload of [
      {},
      { surface: '' },
      { surface: 'x'.repeat(5_000) },
      { surface: 'Valid', kind: 'not-a-kind' },
      { surface: 'Valid', entity_id: 'not-a-uuid' },
    ]) {
      const res = await post(url, owner, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
    }
  });

  // ---- audit ---------------------------------------------------------------------------------------

  it('audits a successful mutation with safe detail only', async () => {
    const setId = await completeSet();
    await post(`/v1/projects/${seeded.projectId}/operator/embedding-sets/${setId}/activate`, owner);
    const rows = await auditRows('operator.embedding_set.activate');
    expect(rows).toHaveLength(1);
    const detail = rows[0]?.detail as Record<string, unknown>;
    expect(detail.outcome).toBe('succeeded');
    expect(detail.set_id).toBe(setId);
    const text = JSON.stringify(detail);
    for (const forbidden of ['postgres://', 'password', 'Bearer ', 'sk-']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('audits a REFUSED mutation, recording the code rather than raw error text', async () => {
    const empty = await createEmbeddingSet(pool, {
      workspaceId: seeded.workspaceId,
      projectId: seeded.projectId,
      provider: 'local',
      modelId: 'deterministic',
      modelVersion: '1.0.0',
      dimension: 8,
    });
    const res = await post(
      `/v1/projects/${seeded.projectId}/operator/embedding-sets/${empty.id}/activate`,
      owner,
    );
    expect(res.statusCode).toBe(409);
    const rows = await auditRows('operator.embedding_set.activate');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ outcome: 'refused', reason: 'EMBEDDING_SET_EMPTY' });
  });

  it('writes no audit row for a refusal the caller was never authorized to attempt', async () => {
    const setId = await completeSet();
    await post(
      `/v1/projects/${seeded.projectId}/operator/embedding-sets/${setId}/activate`,
      viewer,
    );
    // An authorization failure is recorded by the auth layer's own metrics and logs; writing a
    // project-scoped audit row for it would let any member append to the project's audit trail.
    expect(await auditRows('operator.embedding_set.activate')).toHaveLength(0);
  });
});
