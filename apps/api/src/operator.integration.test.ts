/**
 * Operator diagnostics and controls over the wire (Workstream A).
 *
 * The library functions behind these routes are already tested in `@yeonjae/db`. What is NOT proved there,
 * and is what this suite exists for, is everything the HTTP boundary adds:
 *
 *  * AUTHENTICATION IS NOT OPTIONAL. An operator route reports capacity, occupancy and budget state. Left
 *    unauthenticated it is a free reconnaissance surface, so every route is checked for a 401 problem
 *    document rather than data.
 *  * A FOREIGN PROJECT IS A 404, NOT A 403. The distinction matters: 403 would confirm the project exists,
 *    turning an id into a cross-tenant existence probe. The response must also not echo the other
 *    tenant's identifiers back.
 *  * SCOPE COMES FROM THE AUTH CONTEXT. The budget route is the sharp case — it takes a `scope_kind`, and
 *    a workspace-scoped read must report the CALLER's workspace no matter what the query says.
 *  * LISTS ARE BOUNDED. A caller-supplied limit is clamped rather than honoured, so no query can ask for
 *    an unbounded diagnostic payload.
 *  * MALFORMED INPUT IS REFUSED with a stable machine-readable code, not coerced into a default that
 *    silently answers a different question.
 *  * NOTHING SENSITIVE CROSSES THE BOUNDARY: no connection strings, no raw scope keys, no document text.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  boundedLimit,
  createUser,
  createWorkspace,
  MAX_OPERATOR_LIMIT,
  migrate,
  resetDatabase,
  upsertBudgetPolicy,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import type { FastifyInstance } from 'fastify';
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

run('API: operator diagnostics and controls (Workstream A)', () => {
  let pool: Pool;
  let app: FastifyInstance;
  let seeded: SeededProject;
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

  function authed(actor: Actor, workspaceId = seeded.workspaceId): Record<string, string> {
    return { cookie: actor.cookie, [WORKSPACE_HEADER]: workspaceId, [CSRF_HEADER]: actor.csrf };
  }

  async function get(url: string, actor: Actor = viewer) {
    return app.inject({ method: 'GET', url, headers: authed(actor) });
  }

  /** Every operator read route, for the blanket authentication and isolation checks. */
  function operatorUrls(projectId: string): readonly string[] {
    return [
      `/v1/projects/${projectId}/operator/embedding-set`,
      `/v1/projects/${projectId}/operator/embedding-sets/gc-eligible`,
      `/v1/projects/${projectId}/operator/thesaurus`,
      `/v1/projects/${projectId}/operator/retrieval?q=test`,
    ];
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

    const viewerUser = await createUser(pool, {
      email: 'operator-viewer@example.com',
      displayName: 'Operator Viewer',
      password: 'viewer-password-1',
    });
    await addMember(pool, {
      workspaceId: seeded.workspaceId,
      userId: viewerUser.id,
      role: 'viewer',
    });
    viewer = await login('operator-viewer@example.com', 'viewer-password-1');

    otherWorkspaceId = await createWorkspace(pool, 'Other Operator Tenant');
    const otherProject = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, title) VALUES ($1, 'Other Operator Project') RETURNING id`,
      [otherWorkspaceId],
    );
    otherProjectId = otherProject.rows[0]?.id ?? '';
  }, 300_000);

  // ---- authentication ------------------------------------------------------------------------------

  it('refuses every operator route without authentication', async () => {
    const urls = [
      ...operatorUrls(seeded.projectId),
      '/v1/operator/rate-limits',
      '/v1/operator/leases',
      '/v1/operator/budgets',
    ];
    for (const url of urls) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('UNAUTHENTICATED');
    }
  });

  // ---- tenant isolation ----------------------------------------------------------------------------

  it('hides another workspace’s project behind a 404 on every project-scoped operator route', async () => {
    for (const url of operatorUrls(otherProjectId)) {
      const res = await get(url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(404);
      // A 404 that quoted the other tenant's ids would leak exactly what the 404 exists to hide.
      expect(res.body).not.toContain(otherWorkspaceId);
      expect(res.body).not.toContain(otherProjectId);
    }
  });

  it('refuses a workspace header the caller is not a member of', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/operator/leases',
      headers: authed(viewer, otherWorkspaceId),
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('NOT_A_MEMBER');
  });

  it('reports the caller’s own workspace budget regardless of any id in the query', async () => {
    await upsertBudgetPolicy(pool, {
      workspaceId: seeded.workspaceId,
      scopeKind: 'workspace',
      scopeId: seeded.workspaceId,
      hardLimitMillicents: 500_000,
      softLimitMillicents: 100_000,
    });
    // The other tenant gets a deliberately different limit, so borrowing its scope would be visible.
    await upsertBudgetPolicy(pool, {
      workspaceId: otherWorkspaceId,
      scopeKind: 'workspace',
      scopeId: otherWorkspaceId,
      hardLimitMillicents: 999_999,
    });

    const res = await get(`/v1/operator/budgets?scope_kind=workspace&scope_id=${otherWorkspaceId}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ scope_id: string; hard_limit_millicents: number }>();
    expect(body.scope_id).toBe(seeded.workspaceId);
    expect(body.hard_limit_millicents).toBe(500_000);
  });

  it('refuses a project-scoped budget read for a project in another workspace', async () => {
    const res = await get(`/v1/operator/budgets?scope_kind=project&project_id=${otherProjectId}`);
    expect(res.statusCode, res.body).toBe(404);
  });

  // ---- truthful reporting --------------------------------------------------------------------------

  it('reports a scope with no budget policy as “no policy”, never as an unlimited budget', async () => {
    const res = await get('/v1/operator/budgets?scope_kind=workspace');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      policy_id: string | null;
      hard_limit_millicents: number | null;
      remaining_millicents: number | null;
      exhausted: boolean;
    }>();
    expect(body.policy_id).toBeNull();
    expect(body.hard_limit_millicents).toBeNull();
    expect(body.remaining_millicents).toBeNull();
    expect(body.exhausted).toBe(false);
  });

  it('reports limiter counters without echoing the raw scope key', async () => {
    const res = await get('/v1/operator/rate-limits?operation_class=provider_call');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ scope_key_digest: string | null; requests: number }>();
    expect(body.requests).toBeGreaterThanOrEqual(0);
    // The scope key is composed from tenant identifiers; only a digest may cross the boundary.
    if (body.scope_key_digest !== null) {
      expect(body.scope_key_digest).toMatch(/^[0-9a-f]{16}$/);
      expect(res.body).not.toContain(seeded.workspaceId);
    }
  });

  it('reports an absent active embedding set as absent rather than failing', async () => {
    const res = await get(`/v1/projects/${seeded.projectId}/operator/embedding-set`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ set_id: string | null; completeness: unknown }>();
    expect(body.set_id).toBeNull();
    expect(body.completeness).toBeNull();
  });

  it('returns retrieval diagnostics without returning document text', async () => {
    const res = await get(
      `/v1/projects/${seeded.projectId}/operator/retrieval?q=${encodeURIComponent('the')}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      mode: string;
      hits: readonly Record<string, unknown>[];
      diagnostics: Record<string, unknown>;
    }>();
    expect(['hybrid', 'lexical_only', 'vector_only']).toContain(body.mode);
    // A diagnostic reports ranking, never passages: `text` would make this an unaudited content read.
    for (const hit of body.hits) expect(hit).not.toHaveProperty('text');
  });

  // ---- bounding and pagination ---------------------------------------------------------------------

  it('clamps a caller-supplied limit instead of honouring it', () => {
    expect(boundedLimit(10_000)).toBe(MAX_OPERATOR_LIMIT);
    expect(boundedLimit('10000')).toBe(MAX_OPERATOR_LIMIT);
    expect(boundedLimit(-5)).toBe(1);
    expect(boundedLimit(0)).toBe(1);
    expect(boundedLimit('not-a-number')).toBe(20);
    expect(boundedLimit(undefined)).toBe(20);
    expect(boundedLimit(7)).toBe(7);
  });

  it('bounds every operator list response and reports whether it truncated', async () => {
    for (const url of [
      '/v1/operator/leases?limit=10000',
      `/v1/projects/${seeded.projectId}/operator/thesaurus?limit=10000`,
      `/v1/projects/${seeded.projectId}/operator/embedding-sets/gc-eligible?limit=10000`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      const body = res.json<{ limit: number; returned: number; truncated: boolean }>();
      expect(body.limit).toBeLessThanOrEqual(MAX_OPERATOR_LIMIT);
      expect(body.returned).toBeLessThanOrEqual(body.limit);
      expect(typeof body.truncated).toBe('boolean');
    }
  });

  // ---- malformed input -----------------------------------------------------------------------------

  it('refuses an unknown operation class with a stable code rather than defaulting', async () => {
    const res = await get('/v1/operator/rate-limits?operation_class=not-a-class');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
  });

  it('refuses an unknown budget scope kind', async () => {
    const res = await get('/v1/operator/budgets?scope_kind=everything');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
  });

  it('refuses a malformed project id rather than treating it as a wildcard', async () => {
    const res = await get('/v1/operator/leases?project_id=not-a-uuid');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
  });

  it('requires a query for the retrieval diagnostic', async () => {
    const res = await get(`/v1/projects/${seeded.projectId}/operator/retrieval`);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('VALIDATION_FAILED');
  });

  it('never exposes a connection string or raw SQL in an operator response', async () => {
    for (const url of [
      '/v1/operator/leases',
      '/v1/operator/rate-limits',
      `/v1/projects/${seeded.projectId}/operator/thesaurus`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
      expect(res.body).not.toContain('postgres://');
      expect(res.body).not.toContain('SELECT ');
      expect(res.body.toLowerCase()).not.toContain('password');
    }
  });
});
