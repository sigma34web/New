/**
 * The credential-free product surfaces: dependency status, regeneration preview, quality checks,
 * deterministic export preparation, and bounded batch operations.
 *
 * Registered from `server.ts` and sharing its helpers for the reason `resource-routes.ts` already
 * states: authentication, scoping, auditing and pagination must have exactly one implementation, so
 * they arrive as `deps` rather than being re-derived here. Nothing in this file enforces a rule the
 * service layer does not already own — it validates input, applies the ROLE policy, and serializes.
 *
 * ROLE POLICY, stated once:
 *   * dependency status and every check are READS → `viewer`;
 *   * creating a preview, preparing an export and running a batch produce work and consume budget →
 *     `editor`;
 *   * ACCEPTING a preview puts new text into the manuscript lifecycle, which is the same class of
 *     consequence as approving a chapter → `owner`. Discarding and cancelling are `editor`, because
 *     throwing away a proposal is not a privileged act.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  acceptPreview,
  BatchError,
  cancelPreview,
  createPreview,
  acceptedChapter,
  dependencyReport,
  discardPreview,
  getPreview,
  listPreviews,
  MAX_BATCH_ITEMS,
  PreviewError,
  previewView,
  readiness,
  runBatch,
  retryEligible,
  mergeReadiness,
  type Client,
  type ItemCode,
  type Pool,
} from '@yeonjae/db';
import {
  checkPlatformFormat,
  checkTypography,
  PLATFORM_PROFILES,
  PlatformProfileError,
  resolveProfile,
  typographySummary,
} from '@yeonjae/prose';
import {
  exportAccepted,
  ExportRefusedError,
  prepareExport,
  verifyExportPackage,
} from '@yeonjae/workflows';
import { METRIC, METRIC_HELP, type Metrics } from '@yeonjae/domain';
import { requireRole, type WorkspaceScope } from './auth.js';
import { ApiError } from './problem.js';
import { withIdempotency } from './idempotency.js';
import { asObject, requireEnum, requireInt, requireString, requireUuid } from './validate.js';

export interface ProductRouteDeps {
  readonly pool: Pool;
  readonly scoped: (req: FastifyRequest) => Promise<WorkspaceScope>;
  readonly inScope: <T>(scope: WorkspaceScope, fn: (c: Client) => Promise<T>) => Promise<T>;
  readonly projectOr404: (c: Client, projectId: string) => Promise<{ id: string; title: string }>;
  readonly audit: (
    c: Client,
    scope: WorkspaceScope,
    input: {
      action: string;
      targetKind?: string | undefined;
      targetId?: string | undefined;
      projectId?: string | undefined;
      requestId: string;
      detail?: Record<string, unknown> | undefined;
    },
  ) => Promise<void>;
  readonly headerOf: (req: FastifyRequest, name: string) => string | undefined;
  readonly metrics: Metrics;
  readonly lifecycle?:
    | { current: () => 'starting' | 'running' | 'draining' | 'stopped'; ready: () => boolean }
    | undefined;
}

/** Translate the service layers' closed code sets into problem documents. */
function productProblem(err: unknown): never {
  if (err instanceof PreviewError) {
    if (err.code === 'PREVIEW_NOT_FOUND' || err.code === 'CHAPTER_NOT_FOUND')
      throw new ApiError('NOT_FOUND', err.message);
    if (err.code === 'INVALID_REQUEST') throw new ApiError('VALIDATION_FAILED', err.message);
    // Everything else is a precondition the caller can resolve: 409, never a 500 with internals.
    throw new ApiError('CONFLICT', err.message, { data: { reason: err.code } });
  }
  if (err instanceof BatchError) {
    if (err.code === 'BATCH_NOT_FOUND') throw new ApiError('NOT_FOUND', err.message);
    throw new ApiError('VALIDATION_FAILED', err.message, { data: { reason: err.code } });
  }
  if (err instanceof ExportRefusedError)
    throw new ApiError('CONFLICT', err.message, { data: { reason: err.code } });
  if (err instanceof PlatformProfileError)
    throw new ApiError('VALIDATION_FAILED', err.message, { data: { reason: err.code } });
  throw err;
}

export function registerProductRoutes(app: FastifyInstance, deps: ProductRouteDeps): void {
  const { pool, scoped, inScope, projectOr404, audit, headerOf, metrics } = deps;

  const projectIdOf = (req: FastifyRequest): string =>
    requireUuid((req.params as { projectId?: string }).projectId, 'params.projectId');

  // ---- dependency status -------------------------------------------------------------------------
  //
  // Unauthenticated `/ready` keeps answering with check names and states only (that contract belongs
  // to a load balancer). This route is the AUTHENTICATED operator view: the same component states,
  // plus their declared requiredness and their safe explanations.

  app.get('/v1/operator/dependencies', async (req) => {
    const scope = await scoped(req);
    requireRole(scope, 'viewer');
    const report = await dependencyReport({
      db: pool,
      self: 'api',
      lifecycle: deps.lifecycle?.current() ?? 'running',
      metrics,
    });
    return {
      ready: report.ready,
      degraded: report.degraded,
      draining: report.draining,
      totals: report.totals,
      components: report.components,
    };
  });

  // ---- regeneration preview ------------------------------------------------------------------------

  app.post('/v1/projects/:projectId/previews', async (req, reply) => {
    const scope = await scoped(req);
    requireRole(scope, 'editor');
    const projectId = projectIdOf(req);
    const body = asObject(req.body);
    const chapterNo = requireInt(
      typeof body.chapter_no === 'number' || typeof body.chapter_no === 'string'
        ? body.chapter_no
        : undefined,
      'body.chapter_no',
      { min: 1, max: 100_000 },
    );
    const instruction = requireString(body, 'instruction', { max: 2_000 });
    // The idempotency header doubles as the preview's request key, so a retried POST resolves to the
    // same proposal rather than generating a second one.
    const requestKey =
      headerOf(req, 'idempotency-key') ?? `${projectId}:${String(chapterNo)}:${instruction}`;

    const outcome = await inScope(scope, async (c) =>
      withIdempotency(
        c,
        {
          workspaceId: scope.workspaceId,
          key: headerOf(req, 'idempotency-key'),
          method: 'POST',
          route: '/v1/projects/:projectId/previews',
          body: req.body,
        },
        async () => {
          await projectOr404(c, projectId);
          try {
            const result = await createPreview(c, {
              workspaceId: scope.workspaceId,
              projectId,
              chapterNo,
              instruction,
              requestKey,
              userId: scope.principal.user.id,
              metrics,
            });
            await audit(c, scope, {
              action: 'preview.create',
              targetKind: 'regeneration_preview',
              targetId: result.preview.id,
              projectId,
              requestId: req.id,
              // Hashes and counts, never the proposed text: an audit row is not a content store.
              detail: {
                chapter_no: chapterNo,
                duplicate: result.duplicate,
                source_content_hash: result.preview.source_content_hash,
                proposed_content_hash: result.preview.proposed_content_hash,
                estimated_millicents: result.preview.estimated_millicents,
                cost_basis: 'simulated',
              },
            });
            return {
              status: result.duplicate ? 200 : 201,
              body: {
                preview: result.preview,
                proposed_text: result.proposed_text,
                source_text: result.source_text,
                duplicate: result.duplicate,
              },
            };
          } catch (err) {
            return productProblem(err);
          }
        },
      ),
    );
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get('/v1/projects/:projectId/previews', async (req) => {
    const scope = await scoped(req);
    requireRole(scope, 'viewer');
    const projectId = projectIdOf(req);
    const limit = Number((req.query as { limit?: string }).limit ?? '20');
    return inScope(scope, async (c) => {
      await projectOr404(c, projectId);
      return listPreviews(c, { projectId, limit: Number.isFinite(limit) ? limit : 20 });
    });
  });

  app.get('/v1/projects/:projectId/previews/:previewId', async (req) => {
    const scope = await scoped(req);
    requireRole(scope, 'viewer');
    const projectId = projectIdOf(req);
    const previewId = requireUuid(
      (req.params as { previewId?: string }).previewId,
      'params.previewId',
    );
    return inScope(scope, async (c) => {
      await projectOr404(c, projectId);
      const row = await getPreview(c, previewId);
      // A preview from another project in the same workspace must not resolve under this project.
      if (row?.project_id !== projectId)
        throw new ApiError('NOT_FOUND', 'The preview does not exist.');
      return { preview: previewView(row), proposed_text: row.proposed_text };
    });
  });

  /**
   * Resolve a preview.
   *
   * One route for all three verbs, dispatched from the path segment, matching the shape `canon:*`
   * already uses. `accept` is owner-gated because it introduces new text into the manuscript
   * lifecycle; `discard` and `cancel` throw a proposal away and need only `editor`.
   */
  app.post('/v1/projects/:projectId/previews/:previewId/:previewAction', async (req, reply) => {
    const params = req.params as { previewId?: string; previewAction?: string };
    const action = requireEnum(
      params.previewAction,
      ['accept', 'discard', 'cancel'] as const,
      'params.previewAction',
    );
    const scope = await scoped(req);
    requireRole(scope, action === 'accept' ? 'owner' : 'editor');
    const projectId = projectIdOf(req);
    const previewId = requireUuid(params.previewId, 'params.previewId');

    try {
      if (action === 'accept') {
        const result = await acceptPreview(pool, (fn) => inScope(scope, fn), {
          previewId,
          projectId,
          userId: scope.principal.user.id,
          metrics,
        });
        await inScope(scope, async (c) => {
          await audit(c, scope, {
            action: 'preview.accept',
            targetKind: 'regeneration_preview',
            targetId: previewId,
            projectId,
            requestId: req.id,
            detail: {
              manuscript_version_id: result.manuscript_version_id,
              version_no: result.version_no,
              // Accepting a preview creates a WORKING version: it still faces every normal gate.
              status: 'working',
            },
          });
        });
        return await reply.status(200).send(result);
      }

      const resolved = await inScope(scope, async (c) => {
        await projectOr404(c, projectId);
        const view =
          action === 'discard'
            ? await discardPreview(c, {
                previewId,
                projectId,
                userId: scope.principal.user.id,
                metrics,
              })
            : await cancelPreview(c, {
                previewId,
                projectId,
                userId: scope.principal.user.id,
                metrics,
              });
        await audit(c, scope, {
          action: `preview.${action}`,
          targetKind: 'regeneration_preview',
          targetId: previewId,
          projectId,
          requestId: req.id,
          detail: { status: view.status },
        });
        return view;
      });
      return await reply.status(200).send({ preview: resolved });
    } catch (err) {
      return productProblem(err);
    }
  });

  // ---- deterministic quality checks ----------------------------------------------------------------

  app.get('/v1/projects/:projectId/quality/typography', async (req) => {
    const scope = await scoped(req);
    requireRole(scope, 'viewer');
    const projectId = projectIdOf(req);
    const query = req.query as { chapter_no?: string };
    const chapterNo = query.chapter_no === undefined ? undefined : Number(query.chapter_no);
    const project = await inScope(scope, async (c) => projectOr404(c, projectId));

    const accepted = await exportAccepted(pool, {
      projectId,
      chapters: chapterNo === undefined ? undefined : [chapterNo],
      format: 'text',
      title: project.title,
    });
    const results = (
      await Promise.all(
        accepted.chapters.map(async (chapter) => ({
          chapter_no: chapter.chapter_no,
          ...typographySummary(checkTypography(await bodyOf(pool, projectId, chapter.chapter_no))),
        })),
      )
    ).sort((a, b) => a.chapter_no - b.chapter_no);
    for (const result of results) {
      metrics.increment(METRIC.typographyFindings, METRIC_HELP[METRIC.typographyFindings] ?? '', {
        outcome: result.passed ? 'passed' : 'failed',
      });
    }
    return {
      project_id: projectId,
      chapters: results,
      passed: results.every((r) => r.passed),
      // Restated on the wire so no client can present a mechanical pass as a quality verdict.
      does_not_replace: 'bilingual human review',
    };
  });

  app.get('/v1/quality/platform-profiles', async (req) => {
    const scope = await scoped(req);
    requireRole(scope, 'viewer');
    return {
      profiles: PLATFORM_PROFILES.map((p) => ({
        platform_id: p.platform_id,
        rules_version: p.rules_version,
        display_name: p.display_name,
      })),
    };
  });

  app.post('/v1/projects/:projectId/quality/platform-format', async (req) => {
    const scope = await scoped(req);
    requireRole(scope, 'viewer');
    const projectId = projectIdOf(req);
    const body = asObject(req.body);
    const platformId = requireString(body, 'platform_id', { max: 64 });
    const rulesVersion = requireString(body, 'rules_version', { max: 16 });
    const identifier =
      body.identifier === undefined ? undefined : requireString(body, 'identifier', { max: 128 });
    const project = await inScope(scope, async (c) => projectOr404(c, projectId));

    try {
      const profile = resolveProfile(platformId, rulesVersion);
      const accepted = await exportAccepted(pool, {
        projectId,
        format: 'text',
        title: project.title,
      });
      const result = checkPlatformFormat(profile, {
        metadata: safeMetadata(body.metadata, project.title),
        chapters: await Promise.all(
          accepted.chapters.map(async (c) => ({
            chapter_no: c.chapter_no,
            text: await bodyOf(pool, projectId, c.chapter_no),
          })),
        ),
        manifestFields: [
          'manifest_version',
          'project_id',
          'chapters',
          'content_hash',
          'external_identifier',
        ],
        identifier,
        totalBytes: Buffer.byteLength(accepted.text),
      });
      metrics.increment(METRIC.platformFindings, METRIC_HELP[METRIC.platformFindings] ?? '', {
        outcome: result.passed ? 'passed' : 'failed',
      });
      return result;
    } catch (err) {
      return productProblem(err);
    }
  });

  // ---- deterministic export preparation -------------------------------------------------------------

  app.post('/v1/projects/:projectId/export-packages', async (req, reply) => {
    const scope = await scoped(req);
    requireRole(scope, 'editor');
    const projectId = projectIdOf(req);
    const body = asObject(req.body);
    const platformId = requireString(body, 'platform_id', { max: 64 });
    const rulesVersion = requireString(body, 'rules_version', { max: 16 });
    const identifier =
      body.identifier === undefined ? undefined : requireString(body, 'identifier', { max: 128 });
    const project = await inScope(scope, async (c) => projectOr404(c, projectId));

    try {
      const prepared = await prepareExport(pool, {
        projectId,
        title: project.title,
        metadata: safeMetadata(body.metadata, project.title),
        platformId,
        rulesVersion,
        identifier,
      });
      metrics.increment(METRIC.exportPackages, METRIC_HELP[METRIC.exportPackages] ?? '', {
        outcome: 'prepared',
      });
      await inScope(scope, async (c) => {
        await audit(c, scope, {
          action: 'export.package.prepare',
          targetKind: 'export',
          projectId,
          requestId: req.id,
          detail: {
            chapters: prepared.manifest.chapters.length,
            logical_hash: prepared.logical_hash,
            platform_id: platformId,
            published: false,
          },
        });
      });
      // The manifest and hashes only. The package bytes are not returned by this route: an export is
      // prepared locally and downloaded through the existing export-content path, never published.
      return await reply.status(201).send({
        manifest: prepared.manifest,
        logical_hash: prepared.logical_hash,
        prepared_at: prepared.prepared_at,
        total_bytes: prepared.total_bytes,
        files: prepared.files.map((f) => ({ path: f.path, hash: f.hash })),
        published: false,
      });
    } catch (err) {
      metrics.increment(METRIC.exportPackages, METRIC_HELP[METRIC.exportPackages] ?? '', {
        outcome: 'refused',
      });
      return productProblem(err);
    }
  });

  // ---- bounded batch operations ---------------------------------------------------------------------

  app.post('/v1/projects/:projectId/batches', async (req, reply) => {
    const scope = await scoped(req);
    requireRole(scope, 'editor');
    const projectId = projectIdOf(req);
    const body = asObject(req.body);
    const operation = requireString(body, 'operation', { max: 64 });
    const rawItems = body.items;
    if (!Array.isArray(rawItems))
      throw new ApiError('VALIDATION_FAILED', 'body.items must be an array.');
    if (rawItems.length > MAX_BATCH_ITEMS)
      throw new ApiError(
        'VALIDATION_FAILED',
        `A batch may contain at most ${String(MAX_BATCH_ITEMS)} items.`,
        {
          data: { reason: 'BATCH_TOO_LARGE', max_items: MAX_BATCH_ITEMS },
        },
      );
    const requestKey =
      headerOf(req, 'idempotency-key') ?? `${projectId}:${operation}:${String(rawItems.length)}`;

    const items = rawItems.map((raw) => {
      const item = asObject(raw);
      return {
        ref: requireString(item, 'ref', { max: 200 }),
        // An item may CLAIM a project; the service verifies it and refuses a mismatch per item.
        projectId:
          item.project_id === undefined
            ? projectId
            : requireUuid(
                typeof item.project_id === 'string' ? item.project_id : undefined,
                'body.items[].project_id',
              ),
      };
    });

    try {
      const result = await inScope(scope, async (c) => {
        await projectOr404(c, projectId);
        const project = await projectOr404(c, projectId);
        const batch = await runBatch(c, {
          workspaceId: scope.workspaceId,
          projectId,
          operation,
          requestKey,
          items,
          userId: scope.principal.user.id,
          metrics,
          run: itemRunnerFor(pool, operation, project.title),
        });
        await audit(c, scope, {
          action: 'batch.run',
          targetKind: 'batch_operation',
          targetId: batch.batch_id,
          projectId,
          requestId: req.id,
          // A SAFE summary: counts and status, never per-item content.
          detail: {
            operation: batch.operation,
            status: batch.status,
            requested: batch.requested,
            succeeded: batch.succeeded,
            failed: batch.failed,
          },
        });
        return batch;
      });
      return await reply.status(result.duplicate ? 200 : 201).send(result);
    } catch (err) {
      return productProblem(err);
    }
  });

  app.post('/v1/projects/:projectId/batches/:batchId/retry', async (req, reply) => {
    const scope = await scoped(req);
    requireRole(scope, 'editor');
    const projectId = projectIdOf(req);
    const batchId = requireUuid((req.params as { batchId?: string }).batchId, 'params.batchId');
    const requestKey = headerOf(req, 'idempotency-key') ?? `retry:${batchId}`;
    try {
      const result = await inScope(scope, async (c) => {
        const project = await projectOr404(c, projectId);
        const retried = await retryEligible(c, {
          workspaceId: scope.workspaceId,
          projectId,
          batchId,
          requestKey,
          metrics,
          run: itemRunnerFor(pool, 'typography_check', project.title),
        });
        await audit(c, scope, {
          action: 'batch.retry',
          targetKind: 'batch_operation',
          targetId: retried.batch_id,
          projectId,
          requestId: req.id,
          detail: {
            source_batch_id: batchId,
            retried: retried.requested,
            succeeded: retried.succeeded,
            failed: retried.failed,
          },
        });
        return retried;
      });
      return await reply.status(200).send(result);
    } catch (err) {
      return productProblem(err);
    }
  });
}

/**
 * The per-item work a batch performs.
 *
 * Only non-destructive operations are wired: a typography check and a platform-format check over one
 * accepted chapter. Both read accepted content through the same service the single-item routes use,
 * so a batch cannot reach content a single request could not.
 */
function itemRunnerFor(
  pool: Pool,
  operation: string,
  title: string,
): (item: { ref: string; projectId: string; position: number }) => Promise<{
  code: ItemCode;
  detail?: Record<string, unknown> | undefined;
}> {
  return async (item) => {
    const chapterNo = Number(item.ref);
    if (!Number.isInteger(chapterNo) || chapterNo < 1)
      return { code: 'VALIDATION_FAILED', detail: {} };
    const accepted = await exportAccepted(pool, {
      projectId: item.projectId,
      chapters: [chapterNo],
      format: 'text',
      title,
    });
    if (accepted.chapters.length === 0) return { code: 'NOT_FOUND', detail: {} };
    const text = await bodyOf(pool, item.projectId, chapterNo);

    if (operation === 'platform_format_check') {
      const result = checkPlatformFormat(resolveProfile('generic', '1.0'), {
        metadata: { title },
        chapters: [{ chapter_no: chapterNo, text }],
        manifestFields: ['manifest_version', 'project_id', 'chapters', 'content_hash'],
      });
      return {
        code: result.passed ? 'OK' : 'CHECK_FAILED',
        detail: { errors: result.errors, warnings: result.warnings },
      };
    }

    const summary = typographySummary(checkTypography(text));
    return {
      code: summary.passed ? 'OK' : 'CHECK_FAILED',
      detail: { errors: summary.errors, warnings: summary.warnings, codes: summary.codes },
    };
  };
}

/**
 * One chapter's ACCEPTED text.
 *
 * Resolved through `acceptedChapter`, not by splitting the assembled export document on its heading
 * markers: a chapter whose own prose contains the string `Chapter N` would be silently truncated
 * there, and a check run over a truncated chapter is a check that passed for the wrong reason.
 */
async function bodyOf(pool: Pool, projectId: string, chapterNo: number): Promise<string> {
  const lookup = await acceptedChapter(pool, projectId, chapterNo);
  return lookup.state === 'accepted' ? lookup.chapter.version.text : '';
}

/**
 * Accept only bounded string metadata from a request body.
 *
 * A caller must not be able to push arbitrary structure into a manifest: anything that is not a short
 * string is dropped rather than coerced, and the project's own title always wins over a supplied one.
 */
function safeMetadata(raw: unknown, title: string): Record<string, string> {
  const out: Record<string, string> = { title };
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 20)) {
    if (key === 'title') continue;
    if (typeof value !== 'string') continue;
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) continue;
    out[key] = value.slice(0, 500);
  }
  return out;
}

export { safeMetadata, verifyExportPackage, mergeReadiness, readiness };
