/**
 * The credential-free product surfaces through the real HTTP boundary.
 *
 * The service layers are tested directly elsewhere; what this suite proves is the part only the
 * boundary can prove: that authentication and the graded role policy hold, that a cross-tenant target
 * is a 404 rather than a 403 that confirms the resource exists, that responses are bounded and
 * redacted, and that the audit trail records what an operator attempted.
 *
 * Everything runs against the deterministic replay fixture: no credentials, no provider, no spend.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createProject,
  createUser,
  createWorkspace,
  migrate,
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

run('API: credential-free product surfaces', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let seeded: SeededProject;
  let owner: Actor;
  let editor: Actor;
  let viewer: Actor;
  let otherWorkspaceId: string;
  let otherProjectId: string;
  let counter = 0;

  const key = (): string => `api-product-${String(++counter)}`;

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

  const post = (
    url: string,
    actor: Actor,
    payload: unknown = {},
    extra: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers(actor), ...extra },
      payload,
    });

  const get = (url: string, actor: Actor): Promise<LightMyRequestResponse> =>
    app.inject({ method: 'GET', url, headers: headers(actor) });

  async function makeMember(email: string, role: 'viewer' | 'editor' | 'owner'): Promise<Actor> {
    const user = await createUser(pool, {
      email,
      displayName: role,
      password: `${role}-password-1`,
    });
    await addMember(pool, { workspaceId: seeded.workspaceId, userId: user.id, role });
    return login(email, `${role}-password-1`);
  }

  const createdPreview = async (): Promise<{ id: string; text: string }> => {
    const res = await post(
      `/v1/projects/${seeded.projectId}/previews`,
      editor,
      { chapter_no: 1, instruction: 'tighten the pacing' },
      { 'idempotency-key': key() },
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ preview: { id: string }; proposed_text: string }>();
    return { id: body.preview.id, text: body.proposed_text };
  };

  beforeAll(async () => {
    pool = await freshDatabase();
    app = buildApi({ pool, secureCookies: false, rateLimiter: RateLimiter.disabled() });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
    seeded = await seedAcceptedChapterOne(pool);
    owner = await makeMember('owner@example.test', 'owner');
    editor = await makeMember('editor@example.test', 'editor');
    viewer = await makeMember('viewer@example.test', 'viewer');
    otherWorkspaceId = await createWorkspace(pool, 'other-tenant');
    otherProjectId = (await createProject(pool, { workspaceId: otherWorkspaceId, title: 'Other' }))
      .projectId;
  }, 180_000);

  // --- dependency status ---------------------------------------------------------------------------

  it('reports per-dependency status to an authenticated viewer', async () => {
    const res = await get('/v1/operator/dependencies', viewer);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      ready: boolean;
      components: { name: string; state: string; required: boolean; detail: string }[];
    }>();
    expect(body.ready).toBe(true);
    expect(body.components.map((c) => c.name)).toContain('postgres');
    for (const component of body.components) expect(component.detail.length).toBeLessThan(200);
  });

  it('refuses dependency status to an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/operator/dependencies' });
    expect(res.statusCode).toBe(401);
  });

  it('the unauthenticated /ready keeps its contract and adds bounded dependency states', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; checks: unknown[]; dependencies: unknown[] }>();
    expect(body.checks.length).toBeGreaterThan(0);
    expect(body.dependencies.length).toBeGreaterThan(0);
    // No credential or connection string on an unauthenticated endpoint.
    expect(res.body).not.toContain('postgres://');
    expect(res.body).not.toContain('password');
  });

  // --- regeneration preview -------------------------------------------------------------------------

  it('creates a preview as an editor and leaves accepted content unchanged', async () => {
    const before = await pool.query<{ text: string }>(
      'SELECT text FROM manuscript_versions WHERE id = $1',
      [seeded.acceptedVersionId],
    );
    const preview = await createdPreview();
    expect(preview.text.length).toBeGreaterThan(0);
    const after = await pool.query<{ text: string }>(
      'SELECT text FROM manuscript_versions WHERE id = $1',
      [seeded.acceptedVersionId],
    );
    expect(after.rows[0]?.text).toBe(before.rows[0]?.text);
  });

  it('refuses preview creation to a viewer and to an unauthenticated caller', async () => {
    const asViewer = await post(`/v1/projects/${seeded.projectId}/previews`, viewer, {
      chapter_no: 1,
      instruction: 'x',
    });
    expect(asViewer.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/previews`,
      payload: { chapter_no: 1, instruction: 'x' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('a redelivered request with the same idempotency key returns the same preview', async () => {
    const k = key();
    const payload = { chapter_no: 1, instruction: 'dup' };
    const first = await post(`/v1/projects/${seeded.projectId}/previews`, editor, payload, {
      'idempotency-key': k,
    });
    const second = await post(`/v1/projects/${seeded.projectId}/previews`, editor, payload, {
      'idempotency-key': k,
    });
    expect(first.statusCode).toBe(201);
    expect(second.json<{ preview: { id: string } }>().preview.id).toBe(
      first.json<{ preview: { id: string } }>().preview.id,
    );
  });

  it('accepting a preview requires OWNER, and produces a working version', async () => {
    const preview = await createdPreview();
    const asEditor = await post(
      `/v1/projects/${seeded.projectId}/previews/${preview.id}/accept`,
      editor,
    );
    expect(asEditor.statusCode).toBe(403);

    const asOwner = await post(
      `/v1/projects/${seeded.projectId}/previews/${preview.id}/accept`,
      owner,
    );
    expect(asOwner.statusCode, asOwner.body).toBe(200);
    const body = asOwner.json<{ manuscript_version_id: string }>();
    const version = await pool.query<{ status: string }>(
      'SELECT status FROM manuscript_versions WHERE id = $1',
      [body.manuscript_version_id],
    );
    expect(version.rows[0]?.status).toBe('working');
  });

  it('discarding and cancelling need only editor, and a resolved preview cannot be resolved twice', async () => {
    const discardable = await createdPreview();
    expect(
      (await post(`/v1/projects/${seeded.projectId}/previews/${discardable.id}/discard`, editor))
        .statusCode,
    ).toBe(200);
    const again = await post(
      `/v1/projects/${seeded.projectId}/previews/${discardable.id}/discard`,
      editor,
    );
    expect(again.statusCode).toBe(409);

    const cancellable = await createdPreview();
    expect(
      (await post(`/v1/projects/${seeded.projectId}/previews/${cancellable.id}/cancel`, editor))
        .statusCode,
    ).toBe(200);
  });

  it('a preview under another tenant’s project is a 404, not a 403', async () => {
    const preview = await createdPreview();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/projects/${otherProjectId}/previews/${preview.id}`,
      headers: headers(viewer),
    });
    // A 403 would confirm the project exists in another tenant.
    expect(res.statusCode).toBe(404);
  });

  it('audits preview creation and acceptance with hashes, never with the proposed text', async () => {
    const preview = await createdPreview();
    await post(`/v1/projects/${seeded.projectId}/previews/${preview.id}/accept`, owner);
    const rows = await pool.query<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM audit_log WHERE action LIKE 'preview.%' ORDER BY created_at`,
    );
    expect(rows.rows.map((r) => r.action)).toEqual(['preview.create', 'preview.accept']);
    const serialized = JSON.stringify(rows.rows);
    expect(serialized).toContain('sha256:');
    expect(serialized).not.toContain(preview.text.slice(0, 40));
  });

  it('rejects a malformed preview request with a validation problem document', async () => {
    const res = await post(`/v1/projects/${seeded.projectId}/previews`, editor, {
      chapter_no: 'one',
      instruction: 'x',
    });
    // 422 is this API's validation status (problem.ts), not 400.
    expect(res.statusCode).toBe(422);
  });

  // --- quality checks ---------------------------------------------------------------------------------

  it('runs typography checks and never claims to replace human review', async () => {
    const res = await get(`/v1/projects/${seeded.projectId}/quality/typography`, viewer);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ chapters: { chapter_no: number }[]; does_not_replace: string }>();
    expect(body.chapters.length).toBeGreaterThan(0);
    expect(body.does_not_replace).toBe('bilingual human review');
  });

  it('lists platform profiles and runs an offline format check that never claims acceptance', async () => {
    const profiles = await get('/v1/quality/platform-profiles', viewer);
    expect(profiles.statusCode).toBe(200);
    expect(profiles.json<{ profiles: unknown[] }>().profiles.length).toBeGreaterThan(0);

    const res = await post(`/v1/projects/${seeded.projectId}/quality/platform-format`, viewer, {
      platform_id: 'generic',
      rules_version: '1.0',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ external_acceptance: string }>().external_acceptance).toBe('not_verified');
  });

  it('refuses an unknown platform or rules version with a validation problem', async () => {
    for (const payload of [
      { platform_id: 'nowhere', rules_version: '1.0' },
      { platform_id: 'generic', rules_version: '9.9' },
    ]) {
      const res = await post(
        `/v1/projects/${seeded.projectId}/quality/platform-format`,
        viewer,
        payload,
      );
      expect(res.statusCode, res.body).toBe(422);
    }
  });

  // --- export preparation ---------------------------------------------------------------------------------

  it('prepares a deterministic export package and states that nothing was published', async () => {
    const res = await post(`/v1/projects/${seeded.projectId}/export-packages`, editor, {
      platform_id: 'generic',
      rules_version: '1.0',
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ logical_hash: string; published: boolean; manifest: unknown }>();
    expect(body.logical_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.published).toBe(false);

    const again = await post(`/v1/projects/${seeded.projectId}/export-packages`, editor, {
      platform_id: 'generic',
      rules_version: '1.0',
    });
    // Reproducible through the boundary, not merely inside the service.
    expect(again.json<{ logical_hash: string }>().logical_hash).toBe(body.logical_hash);
  });

  it('an export package carries no credential, prompt or internal URL', async () => {
    const res = await post(`/v1/projects/${seeded.projectId}/export-packages`, editor, {
      platform_id: 'generic',
      rules_version: '1.0',
      metadata: { author: 'Yeonjae Studio' },
    });
    for (const forbidden of ['postgres://', 'password', 'api_key', 'system_prompt', '127.0.0.1']) {
      expect(res.body).not.toContain(forbidden);
    }
  });

  it('refuses export preparation to a viewer', async () => {
    const res = await post(`/v1/projects/${seeded.projectId}/export-packages`, viewer, {
      platform_id: 'generic',
      rules_version: '1.0',
    });
    expect(res.statusCode).toBe(403);
  });

  // --- batches --------------------------------------------------------------------------------------------

  it('runs a bounded batch and returns per-item results', async () => {
    const res = await post(
      `/v1/projects/${seeded.projectId}/batches`,
      editor,
      { operation: 'typography_check', items: [{ ref: '1' }] },
      { 'idempotency-key': key() },
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ items: { ref: string; code: string }[]; status: string }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.ref).toBe('1');
  });

  it('refuses an oversized batch at the boundary', async () => {
    const res = await post(`/v1/projects/${seeded.projectId}/batches`, editor, {
      operation: 'typography_check',
      items: Array.from({ length: 200 }, (_, i) => ({ ref: String(i) })),
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('BATCH_TOO_LARGE');
  });

  it('refuses a cross-tenant item inside an otherwise valid batch, per item', async () => {
    const res = await post(
      `/v1/projects/${seeded.projectId}/batches`,
      editor,
      {
        operation: 'typography_check',
        items: [{ ref: '1' }, { ref: '1', project_id: otherProjectId }],
      },
      { 'idempotency-key': key() },
    );
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ items: { code: string; retryable: boolean }[] }>();
    expect(body.items[1]?.code).toBe('CROSS_TENANT');
    // Never automatically retried: it was refused on purpose.
    expect(body.items[1]?.retryable).toBe(false);
  });

  it('audits a batch as a SAFE summary of counts, not per-item content', async () => {
    await post(
      `/v1/projects/${seeded.projectId}/batches`,
      editor,
      { operation: 'typography_check', items: [{ ref: '1' }] },
      { 'idempotency-key': key() },
    );
    const rows = await pool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_log WHERE action = 'batch.run'`,
    );
    expect(rows.rows).toHaveLength(1);
    const detail = rows.rows[0]?.detail ?? {};
    expect(Object.keys(detail).sort()).toEqual([
      'failed',
      'operation',
      'requested',
      'status',
      'succeeded',
    ]);
  });

  it('refuses batches to a viewer and to an unauthenticated caller', async () => {
    const asViewer = await post(`/v1/projects/${seeded.projectId}/batches`, viewer, {
      operation: 'typography_check',
      items: [{ ref: '1' }],
    });
    expect(asViewer.statusCode).toBe(403);
    const anonymous = await app.inject({
      method: 'POST',
      url: `/v1/projects/${seeded.projectId}/batches`,
      payload: { operation: 'typography_check', items: [{ ref: '1' }] },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
