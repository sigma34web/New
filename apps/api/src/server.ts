/**
 * The Yeonjae Studio operator API (Checkpoint 7).
 *
 * Shape of this file: every route is a thin, validated, authorized adapter over a service that already
 * exists and is already tested. The API deliberately contains NO canon, selection or workflow logic — the
 * invariants of Checkpoints 2–6 (accepted-only canon, atomic commits, winner-only propagation, budget
 * checks, replay-only providers) live in `packages/*` and must keep holding whether a request arrives over
 * HTTP or through the CLI. Duplicating any of that here would create a second, weaker enforcement path.
 *
 * Every request therefore follows the same spine:
 *   authenticate → verify membership → open an RLS-scoped connection → validate input → call a service
 *   → serialize a safe response, with errors rendered as RFC 9457 problem documents.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  activateEmbeddingSetForOperator,
  budgetReport,
  BUDGET_SCOPE_KINDS,
  COST_DIMENSIONS,
  costSummary,
  createAliasForOperator,
  createSession,
  embeddingSetReport,
  entitiesOfType,
  gcEligible,
  isTerminalStatus,
  jobControlOf,
  jobEventsAfter,
  leaseOccupancy,
  listCommits,
  manuscriptVersionsOf,
  needsAttention,
  OperatorMutationError,
  OPERATOR_ALIAS_KINDS,
  OPERATION_CLASSES,
  rateLimitStatus as operatorRateLimitStatus,
  queryString,
  readiness,
  dependencyReport,
  mergeReadiness,
  requestJobControl,
  retrievalDiagnostics,
  revokeSession,
  rollbackEmbeddingSetForOperator,
  setAliasActiveForOperator,
  thesaurusListing,
  timelinesOf,
  verifyPassword,
  workspacesOf,
  type Client,
  type Pool,
} from '@yeonjae/db';
import { exportAccepted, workflowIdFor, workflowStatus } from '@yeonjae/workflows';
import {
  authenticate,
  CSRF_HEADER,
  inScope,
  requireRole,
  requireWorkspace,
  SESSION_COOKIE,
  WORKSPACE_HEADER,
  type Principal,
  type WorkspaceScope,
} from './auth.js';
import { withIdempotency } from './idempotency.js';
import {
  CONTENT_TYPES,
  exportContent,
  exportOr404,
  parseTypography,
  persistExport,
  persistFailedExport,
  renderExport,
  safeFilename,
  type ExportRow,
} from './export.js';
import { requireVerb } from './verbs.js';
import { registerResourceRoutes } from './resource-routes.js';
import { registerProductRoutes } from './product-routes.js';
import { contentHashOf } from '@yeonjae/prose';
import type { LifecycleCoordinator } from '@yeonjae/domain';
import {
  correct as correctCanonOp,
  correctionView,
  impactView,
  parseCorrectionBody,
  parseRollbackBody,
  regeneration as regenerationCanonOp,
  retcon as retconCanonOp,
  rollback as rollbackCanonOp,
} from './canon-ops.js';
import { type CorrectionResult } from './canon-deps.js';
import { logLine, METRIC, METRIC_HELP, Metrics, traceIdFrom } from './observability.js';
import { clientIdentity, rateLimited, RateLimiter, scopeFor } from './rate-limit.js';
import { corsFor, corsPolicyFrom, corsPreflightDenied, type CorsPolicy } from './cors.js';
import { parseLastEventId, SSE_HEADERS, streamJobEvents, type SseSink } from './sse.js';
import { ApiError, PROBLEM_CONTENT_TYPE, toProblem } from './problem.js';
import {
  asObject,
  encodeCursor,
  FieldErrors,
  parsePage,
  requireEnum,
  requireInt,
  requireString,
  requireUuid,
} from './validate.js';

export interface ApiOptions {
  readonly pool: Pool;
  /**
   * Cookies are marked `Secure` unless this is explicitly false for local HTTP development. It defaults to
   * secure, so forgetting to configure a deployment cannot downgrade the cookie.
   */
  readonly secureCookies?: boolean | undefined;
  readonly logger?: boolean | undefined;
  /** Shared metric registry. Injectable so a test can read counters and a deployment can share one. */
  readonly metrics?: Metrics | undefined;
  /** Where structured JSON log lines go. Defaults to stdout. */
  readonly logSink?: ((line: string) => void) | undefined;
  /**
   * Shared rate limiter. Injectable so a test can drive its clock, and so several Fastify instances in one
   * process share one window set.
   */
  readonly rateLimiter?: RateLimiter | undefined;
  /**
   * Addresses of proxies whose `X-Forwarded-For` may be believed.
   *
   * EMPTY BY DEFAULT, and that default is the security property: a deployment that forgets to configure
   * this gets limits keyed on the socket address, never on attacker-controlled header content.
   */
  readonly trustedProxies?: readonly string[] | undefined;
  /**
   * Exact origins permitted to make credentialed cross-origin requests.
   *
   * Absent or empty means DENY ALL cross-origin requests, which leaves same-origin traffic untouched. A
   * deployment that forgets to configure this is strict rather than broken.
   */
  readonly corsOrigins?: readonly string[] | undefined;
  /**
   * Process lifecycle coordinator (Workstream C).
   *
   * Injected rather than constructed here because the coordinator's whole purpose is to span the
   * process: `main.ts` owns the signal handlers and the resources that must close, and a test needs to
   * drive drain directly. When absent the API behaves exactly as before — always accepting, always
   * ready — so the many suites that build an app without a lifecycle are unaffected.
   */
  readonly lifecycle?: LifecycleCoordinator | undefined;
}

/** Maximum JSON body. A bounded body is the cheapest defence against memory-exhaustion requests. */
const BODY_LIMIT_BYTES = 1_000_000;

/** Per-request observability state, keyed by Fastify's request id and deleted when the response ends. */
interface ObservedRequest {
  readonly traceId: string | undefined;
  readonly startedAt: bigint;
}

export function buildApi(options: ApiOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: BODY_LIMIT_BYTES,
    // Fastify generates request ids; ours are UUIDs so they can be quoted in problem documents and matched
    // against structured logs and workflow traces.
    genReqId: () => randomUUID(),
    disableRequestLogging: true,
  });
  const pool = options.pool;
  const secure = options.secureCookies ?? true;
  const metrics = options.metrics ?? new Metrics();
  /**
   * Where structured log lines go.
   *
   * Injectable so the redaction tests can capture exactly what would be written rather than inferring it,
   * and so a deployment can ship lines somewhere other than stdout without the log format changing.
   */
  const emit = options.logSink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const observed = new Map<string, ObservedRequest>();
  const limiter = options.rateLimiter ?? new RateLimiter();
  const trustedProxies = options.trustedProxies ?? [];
  // Validated at construction, so an invalid origin fails at startup naming the exact value rather than
  // being silently dropped into a deployment that denies everything and looks configured.
  const corsPolicy: CorsPolicy = corsPolicyFrom(options.corsOrigins ?? []);
  const lifecycle = options.lifecycle;
  /**
   * Requests admitted by the drain gate, by request id.
   *
   * A SET rather than a counter so the release in `onResponse` is idempotent: Fastify can complete a
   * request through several paths (normal reply, error reply, client disconnect), and a bare decrement
   * would eventually drift below the true count and let a drain finish while work was still running.
   */
  const inFlight = new Set<string>();

  app.addHook('onRequest', async (req, reply) => {
    /**
     * CORS first, because a preflight carries no credentials and must be answerable before authentication.
     *
     * A denied cross-origin request is not failed here: it is answered WITHOUT CORS headers, and the
     * browser refuses it. That is the right layer — a 403 from this hook would be indistinguishable from
     * an authorization failure and would confirm that the origin was evaluated at all. Only a denied
     * PREFLIGHT gets an explicit 403, because a preflight has no other purpose and a silent 200 would be
     * more confusing than a clear refusal in dev tools.
     */
    const cors = corsFor(corsPolicy, { method: req.method, origin: headerOf(req, 'origin') });
    for (const [name, value] of Object.entries(cors.headers)) reply.header(name, value);
    if (cors.denied)
      metrics.increment(METRIC.corsDenied, METRIC_HELP[METRIC.corsDenied] ?? '', {
        method: req.method,
      });

    // Security headers on every response, including errors.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    reply.header('x-request-id', req.id);
    // Correlation: an inbound W3C `traceparent` is adopted only if it genuinely parses, so a client
    // cannot inject arbitrary text into logs or the `llm_calls` audit through the header. A request with
    // no usable trace id gets none rather than a fabricated one.
    const traceId = traceIdFrom(headerOf(req, 'traceparent'));
    if (traceId) reply.header('x-trace-id', traceId);
    observed.set(req.id, { traceId, startedAt: process.hrtime.bigint() });

    /**
     * Rate limiting, before authentication.
     *
     * Deliberately BEFORE the auth check: the login endpoint's cost is a scrypt verification, so a
     * limiter that ran after authentication would still pay for every guess and could not stop credential
     * stuffing. Health, readiness and metrics are exempt because throttling a probe would make a load
     * balancer eject a healthy instance under exactly the load the limit exists to survive.
     */
    const route = req.routeOptions.url ?? 'unmatched';
    if (route === '/health' || route === '/ready' || route === '/metrics') return;

    /**
     * Drain gate (Workstream C).
     *
     * Placed after the probe exemption above and before authentication, because during a drain the
     * answer must not depend on who is asking: a draining instance refuses NEW work from everyone,
     * while probes keep answering so an orchestrator can still observe the transition.
     *
     * 503 with `retry-after` is the honest answer — the work was not attempted and retrying elsewhere
     * (or here, later) will succeed. Requests already in flight are unaffected; they are exactly what
     * the drain deadline exists to let finish.
     */
    if (lifecycle && !lifecycle.beginWork()) {
      metrics.increment(METRIC.drainRefusals, METRIC_HELP[METRIC.drainRefusals] ?? '', {
        state: lifecycle.current(),
      });
      reply.header('retry-after', '5');
      throw new ApiError(
        'SERVICE_DRAINING',
        'This instance is shutting down and is not accepting new requests.',
      );
    }
    // Counted as in-flight only once the gate admitted it; `onResponse` below releases it.
    if (lifecycle) inFlight.add(req.id);

    const identity = clientIdentity(
      { socketAddress: req.ip, forwardedFor: headerOf(req, 'x-forwarded-for') },
      { trustedProxies },
    );
    const scope = scopeFor(req.method, route);
    const verdict = limiter.check(scope, identity);
    if (!verdict.allowed) {
      metrics.increment(METRIC.rateLimited, METRIC_HELP[METRIC.rateLimited] ?? '', { scope });
      reply.header('retry-after', String(verdict.retryAfterSeconds));
      throw rateLimited(verdict.retryAfterSeconds);
    }
  });

  /**
   * One structured line per completed request, plus latency and outcome metrics.
   *
   * The fields go through `logFields`, which is default-deny: a field nobody allowlisted is dropped rather
   * than logged. `routeOptions.url` is the route PATTERN (`/v1/projects/:projectId`), never the resolved
   * path — a resolved path would put tenant identifiers into a metric label and explode its cardinality.
   */
  app.addHook('onResponse', async (req, reply) => {
    const seen = observed.get(req.id);
    observed.delete(req.id);
    // Release the drain slot exactly once, whatever path completed the request.
    if (lifecycle && inFlight.delete(req.id)) lifecycle.endWork();
    const route = req.routeOptions.url ?? 'unmatched';
    const durationNs = seen ? Number(process.hrtime.bigint() - seen.startedAt) : 0;
    const durationMs = Math.round(durationNs / 1e6);
    metrics.increment(METRIC.requests, METRIC_HELP[METRIC.requests] ?? '', {
      route,
      method: req.method,
      status: String(reply.statusCode),
    });
    metrics.observe(
      METRIC.requestLatency,
      METRIC_HELP[METRIC.requestLatency] ?? '',
      durationNs / 1e9,
      { route },
    );
    if (reply.statusCode === 401 || reply.statusCode === 403)
      metrics.increment(METRIC.authFailures, METRIC_HELP[METRIC.authFailures] ?? '', {
        status: String(reply.statusCode),
      });
    emit(
      logLine(
        {
          level: reply.statusCode >= 500 ? 'error' : 'info',
          msg: 'request completed',
          request_id: req.id,
          ...(seen?.traceId ? { trace_id: seen.traceId } : {}),
        },
        { route, method: req.method, status_code: reply.statusCode, duration_ms: durationMs },
      ),
    );
  });

  app.setErrorHandler((err, req, reply) => {
    const problem = toProblem(err, req.id);
    // The real error is logged against the request id; only the safe document goes to the client.
    if (problem.status >= 500) req.log.error({ err, request_id: req.id }, 'request failed');
    reply.status(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  app.setNotFoundHandler((req, reply) => {
    const problem = toProblem(new ApiError('NOT_FOUND', 'No such route.'), req.id);
    reply.status(404).type(PROBLEM_CONTENT_TYPE).send(problem);
  });

  // ---- health and readiness -------------------------------------------------------------------------
  // Liveness answers "is the process up"; readiness answers "can it serve", which requires the database.
  /**
   * Preflight.
   *
   * A wildcard OPTIONS route, because a browser preflights the exact path it intends to call and those
   * paths are all of `/v1/*`. It answers 204 with the allow headers the hook already set for a permitted
   * origin, and 403 when the origin is not allowlisted — a preflight has no other purpose, so an explicit
   * refusal is more legible in dev tools than a silent 204 the browser then rejects.
   */
  app.options('/*', async (req, reply) => {
    const cors = corsFor(corsPolicy, { method: 'OPTIONS', origin: headerOf(req, 'origin') });
    if (cors.denied) throw corsPreflightDenied();
    return reply.status(204).send();
  });

  /**
   * Liveness.
   *
   * Deliberately NOT readiness: a draining process is still alive and must keep saying so, or an
   * orchestrator would kill it mid-request instead of letting it finish. It reports `stopping` while
   * draining — informative without ever becoming the signal to terminate — and only a stopped process
   * fails liveness.
   */
  app.get('/health', async (_req, reply) => {
    if (!lifecycle) return { status: 'ok', state: 'running' };
    const state = lifecycle.current();
    if (!lifecycle.live()) return reply.status(503).send({ status: 'stopped', state });
    return { status: 'ok', state: state === 'draining' ? 'stopping' : state };
  });

  /**
   * Prometheus metrics.
   *
   * Deliberately unauthenticated and deliberately safe to be so: the registry renders metric names, the
   * label allowlist's output and numbers, with no identifiers of tenants, users or manuscripts. It is a
   * scrape target, and requiring a session on it would mean shipping credentials to the scraper.
   *
   * SCOPE, stated honestly: these are PER-PROCESS counters. They reset when the process restarts and are
   * scraped per instance, so a multi-instance deployment relies on the scraper to aggregate. Nothing here
   * is a distributed counter.
   */
  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render()),
  );
  app.get('/ready', async (_req, reply) => {
    /**
     * Draining fails readiness IMMEDIATELY and without touching the database.
     *
     * Checked before the dependency probe on purpose: the answer during a drain is already decided, and
     * a probe that first waited on a query would widen exactly the window in which a load balancer can
     * still route new work into a process that is shutting down.
     */
    if (lifecycle && !lifecycle.ready()) {
      return reply.status(503).send({ status: 'draining', state: lifecycle.current(), checks: [] });
    }
    /**
     * Readiness is more than "the pool can reach a database".
     *
     * `SELECT 1` passes against a database that is behind on migrations, ahead of this build, carrying a
     * tampered ledger, or whose application role has quietly been granted BYPASSRLS — and in every one
     * of those states this instance must NOT take traffic, because the failure would otherwise surface
     * as a broken request or, worse, as silently absent tenant isolation.
     *
     * The check list is returned so an operator can see WHICH dependency is unhappy. It carries no
     * credential, no connection string and no tenant data (asserted in the db package's tests).
     */
    const report = await readiness(pool);
    /**
     * Per-dependency states, merged into the verdict.
     *
     * `readiness()` stays the authority on schema and role state — that is the contract the load
     * balancer was built on — and the dependency report ADDS per-component states with their declared
     * requiredness. The verdict is the AND of the two, so this can only make readiness stricter: a
     * required component that is unavailable now fails, and an optional one that is degraded or
     * intentionally disabled reports `degraded` without taking the instance out of service.
     */
    const deps = await dependencyReport({
      db: pool,
      self: 'api',
      lifecycle: lifecycle?.current() ?? 'running',
      metrics,
    });
    const verdict = mergeReadiness(report, deps);
    if (verdict.ready) {
      return {
        status: verdict.degraded ? 'degraded' : 'ready',
        checks: report.checks,
        // Names, states and safe explanations only: the same bounded shape the checks already use.
        dependencies: deps.components,
      };
    }
    return reply.status(503).type(PROBLEM_CONTENT_TYPE).send({
      type: 'urn:yeonjae:error:INTERNAL_ERROR',
      title: 'Not ready',
      status: 503,
      detail: 'One or more readiness checks failed.',
      code: 'INTERNAL_ERROR',
      request_id: _req.id,
      checks: report.checks,
      dependencies: deps.components,
    });
  });

  // ---- authentication -------------------------------------------------------------------------------
  app.post('/v1/auth/login', async (req, reply) => {
    const body = asObject(req.body);
    const email = requireString(body, 'email', { max: 320 });
    const password = requireString(body, 'password', { max: 1024, nfc: false });
    const user = await verifyPassword(pool, email, password);
    // One message for every failure mode, so the endpoint is not an account-existence oracle.
    if (!user) throw new ApiError('INVALID_CREDENTIALS', 'The email or password is incorrect.');
    const session = await createSession(pool, { userId: user.id });
    reply.header(
      'set-cookie',
      [
        `${SESSION_COOKIE}=${encodeURIComponent(session.token)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        secure ? 'Secure' : '',
        `Max-Age=${Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)}`,
      ]
        .filter(Boolean)
        .join('; '),
    );
    return {
      user: { id: user.id, email: user.email, display_name: user.display_name },
      // The CSRF token is returned in the body (not a cookie) so a cross-site request cannot obtain it.
      csrf_token: session.csrfToken,
      workspaces: await workspacesOf(pool, user.id),
    };
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const principal = await authenticate(pool, toRequestLike(req));
    if (principal.session) await revokeSession(pool, principal.session.id);
    reply.header(
      'set-cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`,
    );
    return { status: 'logged_out' };
  });

  app.get('/v1/me', async (req) => {
    const principal = await authenticate(pool, toRequestLike(req));
    return {
      user: {
        id: principal.user.id,
        email: principal.user.email,
        display_name: principal.user.display_name,
      },
      via: principal.via,
      workspaces: await workspacesOf(pool, principal.user.id),
    };
  });

  // ---- projects -------------------------------------------------------------------------------------
  app.get('/v1/projects', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const page = parsePage(req.query as Record<string, unknown>);
    return inScope(pool, scope, async (c) => {
      // RLS already restricts to the workspace; ordering by id keeps the cursor stable and deterministic.
      const rows = await c.query<{
        id: string;
        title: string;
        status: string;
        canon_version: number;
        quality_tier: string;
        operating_mode: string;
      }>(
        `SELECT id, title, status, canon_version, quality_tier, operating_mode
           FROM projects
          WHERE ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2`,
        [page.after ?? null, page.limit + 1],
      );
      return pageOf(rows.rows, page.limit, (r) => r.id);
    });
  });

  app.post('/v1/projects', async (req, reply) => {
    const scope = await scoped(pool, req);
    // Creating a project spends nothing yet, but it is a write: viewers may not.
    requireRole(scope, 'editor');
    const body = asObject(req.body);
    const title = requireString(body, 'title', { max: 200 });
    const tier =
      body.quality_tier === undefined
        ? 'standard'
        : requireEnum(
            body.quality_tier,
            ['economy', 'standard', 'premium'] as const,
            'body.quality_tier',
          );
    const mode =
      body.operating_mode === undefined
        ? 'assisted'
        : requireEnum(
            body.operating_mode,
            ['assisted', 'semi_auto', 'autopilot'] as const,
            'body.operating_mode',
          );

    const outcome = await inScope(pool, scope, async (c) =>
      withIdempotency(
        c,
        {
          workspaceId: scope.workspaceId,
          key: headerOf(req, 'idempotency-key'),
          method: 'POST',
          route: '/v1/projects',
          body: req.body,
        },
        async () => {
          const created = await createProjectScoped(c, {
            workspaceId: scope.workspaceId,
            title,
            qualityTier: tier,
            operatingMode: mode,
          });
          await audit(c, scope, {
            action: 'project.create',
            targetKind: 'project',
            targetId: created.projectId,
            requestId: req.id,
            detail: { title },
          });
          return { status: 201, body: created };
        },
      ),
    );
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get('/v1/projects/:projectId', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      const project = await projectOr404(c, projectId);
      const chapters = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chapters WHERE project_id = $1 AND status = 'accepted'`,
        [projectId],
      );
      const spend = await c.query<{ cents: string }>(
        `SELECT coalesce(sum(cost_cents), 0)::text AS cents FROM llm_calls WHERE project_id = $1`,
        [projectId],
      );
      return {
        ...project,
        accepted_chapters: Number(chapters.rows[0]?.n ?? '0'),
        spend_cents: Number(spend.rows[0]?.cents ?? '0'),
      };
    });
  });

  // ---- chapters and review --------------------------------------------------------------------------
  app.get('/v1/projects/:projectId/chapters', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const rows = await c.query<{
        number: number;
        status: string;
        accepted_version_id: string | null;
      }>(
        'SELECT number, status, accepted_version_id FROM chapters WHERE project_id = $1 ORDER BY number',
        [projectId],
      );
      return { items: rows.rows };
    });
  });

  app.get('/v1/projects/:projectId/chapters/:number', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const params = req.params as { projectId?: string; number?: string };
    const projectId = requireUuid(params.projectId, 'params.projectId');
    const number = requireInt(params.number, 'params.number', { min: 1, max: 10_000 });
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const chapter = await c.query<{
        id: string;
        status: string;
        accepted_version_id: string | null;
      }>(
        'SELECT id, status, accepted_version_id FROM chapters WHERE project_id = $1 AND number = $2',
        [projectId, number],
      );
      const row = chapter.rows[0];
      if (!row)
        throw new ApiError('NOT_FOUND', `Chapter ${number} does not exist in this project.`);
      const versions = await manuscriptVersionsOf(c, row.id);
      return {
        chapter_no: number,
        chapter_id: row.id,
        status: row.status,
        accepted_version_id: row.accepted_version_id,
        // The accepted/working/rejected distinction is carried explicitly so a UI can never render a
        // rejected or losing candidate as canonical.
        versions: versions.map((v) => ({
          id: v.id,
          version_no: v.version_no,
          status: v.status,
          origin: v.origin,
          content_hash: v.content_hash,
          is_accepted: v.id === row.accepted_version_id,
        })),
      };
    });
  });

  // ---- canon inspectors -----------------------------------------------------------------------------
  app.get('/v1/projects/:projectId/canon/commits', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const commits = await listCommits(c, projectId);
      return {
        items: commits.map((commit) => ({
          version: commit.version,
          source: commit.source,
          item_counts: commit.item_counts,
          created_at: commit.created_at,
        })),
      };
    });
  });

  app.get('/v1/projects/:projectId/canon/entities', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const type = (req.query as { type?: string }).type;
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const entities = await entitiesOfType(c, projectId, type ?? 'character');
      return { items: entities };
    });
  });

  app.get('/v1/projects/:projectId/canon/timeline', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const timelines = await timelinesOf(c, projectId);
      const events = await c.query<{
        id: string;
        summary: string;
        frame: string;
        clock_start: unknown;
        timeline_id: string;
      }>(
        `SELECT id, summary, frame, clock_start, timeline_id FROM events
          WHERE project_id = $1 ORDER BY clock_ord, id LIMIT 500`,
        [projectId],
      );
      return { timelines, events: events.rows };
    });
  });

  // ---- canon inspectors: facts, promises, evidence, dependencies, stale -----------------------------
  //
  // All read-only, all `viewer`, all through the RLS-scoped connection. Each is a paginated projection of
  // canon the operator UI's inspector screens need; none of them can return unaccepted text, because none
  // of them reads manuscript bodies at all — they return canon items, references and counts.

  app.get('/v1/projects/:projectId/canon/facts', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const query = req.query as { entity?: string; attribute?: string };
    const page = parsePage(query);
    // Optional filters are validated when present rather than interpolated: an unvalidated `entity` would
    // be a parameter either way, but a malformed one should be a 422 naming the field, not an empty page.
    const entity = query.entity === undefined ? null : requireUuid(query.entity, 'query.entity');
    const attribute =
      query.attribute === undefined ? null : requireString(query, 'attribute', { max: 200 });
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const rows = await c.query<{
        id: string;
        entity_id: string;
        attribute: string;
        key: string | null;
        value_text: string | null;
        frame: string;
        confidence: number;
        locked: boolean;
        asserted_at_version: number;
        retracted_at_version: number | null;
      }>(
        // `locked` and the retraction version travel with each fact so an inspector can render a locked
        // fact and a retracted one distinctly instead of showing every row as live canon.
        `SELECT id, entity_id, attribute, key, value_text, frame, confidence, locked,
                asserted_at_version, retracted_at_version
           FROM facts
          WHERE project_id = $1
            AND ($2::uuid IS NULL OR entity_id = $2::uuid)
            AND ($3::text IS NULL OR attribute = $3::text)
            AND ($4::uuid IS NULL OR id > $4::uuid)
          ORDER BY id
          LIMIT $5`,
        [projectId, entity, attribute, page.after ?? null, page.limit + 1],
      );
      return pageOf(rows.rows, page.limit, (r) => r.id);
    });
  });

  app.get('/v1/projects/:projectId/canon/promises', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const query = req.query as { status?: string };
    const page = parsePage(query);
    const status =
      query.status === undefined
        ? null
        : requireEnum(
            query.status,
            ['open', 'partially_paid', 'paid', 'broken', 'abandoned', 'rescheduled'] as const,
            'query.status',
          );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const rows = await c.query<{
        id: string;
        type: string;
        statement: string;
        status: string;
        importance: string;
        due_min_chapter: number | null;
        due_max_chapter: number | null;
      }>(
        `SELECT id, type, statement, status, importance, due_min_chapter, due_max_chapter
           FROM promises
          WHERE project_id = $1
            AND ($2::text IS NULL OR status = $2::text)
            AND ($3::uuid IS NULL OR id > $3::uuid)
          ORDER BY id
          LIMIT $4`,
        [projectId, status, page.after ?? null, page.limit + 1],
      );
      return pageOf(rows.rows, page.limit, (r) => r.id);
    });
  });

  /**
   * Evidence for one canon fact.
   *
   * Evidence spans DO quote manuscript text — that is what evidence is — so this route is the one canon
   * inspector that can surface prose. It is therefore restricted to spans whose manuscript version is
   * ACCEPTED: an evidence row pointing at a working or quarantined draft must not become a way to read
   * unaccepted text through the canon API. The join is what enforces it, not a filter applied afterwards.
   */
  app.get('/v1/projects/:projectId/canon/facts/:factId/evidence', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const params = req.params as { projectId?: string; factId?: string };
    const projectId = requireUuid(params.projectId, 'params.projectId');
    const factId = requireUuid(params.factId, 'params.factId');
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const fact = await c.query<{ id: string }>(
        'SELECT id FROM facts WHERE id = $1 AND project_id = $2',
        [factId, projectId],
      );
      if (!fact.rows[0]) throw new ApiError('NOT_FOUND', 'No such canon fact.');
      const rows = await c.query<{
        manuscript_version_id: string;
        chapter_no: number | null;
        paragraph_id: string | null;
        quote: string;
        start_cp: number;
        end_cp: number;
      }>(
        `SELECT s.manuscript_version_id, s.chapter_no, s.paragraph_id, s.quote,
                s.start_cp, s.end_cp
           FROM fact_evidence fe
           JOIN evidence_spans s ON s.id = fe.evidence_span_id
           JOIN manuscript_versions m ON m.id = s.manuscript_version_id
          WHERE fe.fact_id = $1 AND m.status = 'accepted'
          ORDER BY s.chapter_no NULLS LAST, s.start_cp`,
        [factId],
      );
      return { fact_id: factId, items: rows.rows };
    });
  });

  app.get('/v1/projects/:projectId/canon/dependencies', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const query = req.query as { materiality?: string };
    const page = parsePage(query);
    const materiality =
      query.materiality === undefined
        ? null
        : requireEnum(query.materiality, ['material', 'contextual'] as const, 'query.materiality');
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const rows = await c.query<{
        id: string;
        dependent_kind: string;
        dependent_id: string;
        canon_item_kind: string;
        canon_item_ref: string;
        materiality: string;
        basis: string;
        canon_version_read: number;
      }>(
        `SELECT id, dependent_kind, dependent_id, canon_item_kind, canon_item_ref,
                materiality, basis, canon_version_read
           FROM dependency_edges
          WHERE project_id = $1
            AND ($2::text IS NULL OR materiality = $2::text)
            AND ($3::uuid IS NULL OR id > $3::uuid)
          ORDER BY id
          LIMIT $4`,
        [projectId, materiality, page.after ?? null, page.limit + 1],
      );
      return pageOf(rows.rows, page.limit, (r) => r.id);
    });
  });

  /**
   * Stale artifacts: what a canon change invalidated, and what it merely suggests reviewing.
   *
   * The two lists are returned separately because the data architecture's material/contextual split is the
   * whole point (ADR-0032): a material dependent is genuinely stale, a contextual one is a suggestion. A
   * single merged list would present a suggestion as an invalidation and push operators toward needless
   * regeneration.
   */
  app.get('/v1/projects/:projectId/canon/stale', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const staleChapters = await c.query<{ number: number; status: string }>(
        `SELECT number, status FROM chapters
          WHERE project_id = $1 AND status IN ('stale', 'retconned', 'superseded')
          ORDER BY number`,
        [projectId],
      );
      // The accepted versions belonging to those chapters. Staleness is recorded on the CHAPTER
      // (`chapters.status`), not on the immutable version row — a manuscript version never mutates, so it
      // has no staleness field to read. Listing its id lets an operator jump straight to the artifact.
      const staleVersions = await c.query<{ id: string; chapter_no: number }>(
        `SELECT ch.accepted_version_id AS id, ch.number AS chapter_no
           FROM chapters ch
          WHERE ch.project_id = $1
            AND ch.status IN ('stale', 'retconned', 'superseded')
            AND ch.accepted_version_id IS NOT NULL
          ORDER BY ch.number
          LIMIT 500`,
        [projectId],
      );
      return {
        stale_chapters: staleChapters.rows,
        stale_versions: staleVersions.rows,
        // Named explicitly so a client cannot mistake review suggestions for invalidations.
        note: 'stale entries are material invalidations; contextual dependents appear under /canon/dependencies?materiality=contextual as review suggestions only',
      };
    });
  });

  // ---- costs, budgets and spend ---------------------------------------------------------------------
  //
  // Cost data is derived from the append-only `llm_calls` audit, which records hashes, sizes and cents —
  // never prompt bodies or outputs. A cost dashboard therefore cannot leak prose by construction.
  app.get('/v1/projects/:projectId/costs', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const groupBy = requireEnum(
      (req.query as { group_by?: string }).group_by ?? 'role',
      ['role', 'model', 'chapter'] as const,
      'query.group_by',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      // The grouping column is chosen from a closed set above and mapped here, so no client string ever
      // reaches the SQL text.
      const column =
        groupBy === 'role' ? 'role' : groupBy === 'model' ? 'model_class' : 'activity_id';
      const rows = await c.query<{
        group_key: string | null;
        calls: string;
        cost_cents: string;
        input_tokens: string;
        output_tokens: string;
      }>(
        // Token counts live inside the audit's `usage` jsonb rather than as columns, so they are summed
        // out of it. A missing or non-numeric entry contributes 0 instead of failing the whole dashboard.
        `SELECT ${column} AS group_key,
                count(*)::text AS calls,
                coalesce(sum(cost_cents), 0)::text AS cost_cents,
                coalesce(sum((usage->>'input_tokens')::bigint), 0)::text AS input_tokens,
                coalesce(sum((usage->>'output_tokens')::bigint), 0)::text AS output_tokens
           FROM llm_calls
          WHERE project_id = $1
          GROUP BY ${column}
          ORDER BY coalesce(sum(cost_cents), 0) DESC, ${column}
          LIMIT 200`,
        [projectId],
      );
      const total = rows.rows.reduce((sum, r) => sum + Number(r.cost_cents), 0);
      return {
        group_by: groupBy,
        total_cost_cents: total,
        items: rows.rows.map((r) => ({
          group_key: r.group_key,
          calls: Number(r.calls),
          cost_cents: Number(r.cost_cents),
          input_tokens: Number(r.input_tokens),
          output_tokens: Number(r.output_tokens),
        })),
      };
    });
  });

  /**
   * Attempt-level cost and provenance summary (B-4-6).
   *
   * The `/costs` route above answers "what did this cost, grouped by role/model/chapter". It cannot
   * answer "how many provider attempts was that, and did a retry or a fallback happen" — because that
   * lives in migration 0011's per-attempt provenance rather than in the call row. This route reads both
   * together through the shared accounting module, so a dashboard figure traces to audit rows rather
   * than being recomputed in the browser.
   *
   * Every number is an integer count of cents with the currency and unit stated, and the summary labels
   * its BASIS. `recorded_replay` is the only basis this deployment can produce: it is what the gateway
   * observed from replay/mock providers, not a provider invoice, and the field exists so a reader cannot
   * mistake one for the other.
   */
  app.get('/v1/projects/:projectId/cost-attempts', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const query = req.query as { dimension?: string; since?: string; until?: string };
    const dimension = requireEnum(query.dimension ?? 'role', COST_DIMENSIONS, 'query.dimension');
    // A malformed timestamp is a client error, not something to silently ignore: a dashboard that
    // quietly dropped its filter would show a total for the wrong window.
    const parseWhen = (value: string | undefined, field: string): Date | undefined => {
      if (value === undefined || value === '') return undefined;
      const when = new Date(value);
      if (Number.isNaN(when.getTime())) {
        const errors = new FieldErrors();
        errors.add(field, 'iso8601');
        errors.throwIfAny(`${field} must be an ISO 8601 timestamp.`);
      }
      return when;
    };
    const since = parseWhen(query.since, 'query.since');
    const until = parseWhen(query.until, 'query.until');

    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const summary = await costSummary(c, projectId, dimension, { since, until });
      return {
        dimension: summary.dimension,
        basis: summary.basis,
        currency: summary.currency,
        unit: summary.unit,
        // Both forms are returned deliberately. `*_millicents` is the exact integer a client should
        // compare or sum; `*_cents` is the human-facing decimal derived from it and is FRACTIONAL for
        // sub-cent calls, which real replay-priced calls are. Returning only the cents figure invited
        // exactly the truncation this route was corrected for.
        total_cost_millicents: summary.total_cost_millicents,
        total_cost_cents: summary.total_cost_cents,
        calls: summary.calls,
        // Actual provider attempts behind those calls: greater than `calls` whenever a retry happened.
        attempts: summary.attempts,
        window: { since: since?.toISOString() ?? null, until: until?.toISOString() ?? null },
        items: summary.items,
      };
    });
  });

  app.get('/v1/projects/:projectId/budgets', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      const project = await projectOr404(c, projectId);
      const spend = await c.query<{ cents: string }>(
        'SELECT coalesce(sum(cost_cents), 0)::text AS cents FROM llm_calls WHERE project_id = $1',
        [projectId],
      );
      return {
        project_id: projectId,
        quality_tier: project.quality_tier,
        spend_cents: Number(spend.rows[0]?.cents ?? '0'),
        // The authoritative limits live in the pinned Production Policy, not in a mutable API field
        // (ADR-0041). Reporting the pinned version rather than a copied number is what keeps the
        // "numbers live in one place" rule true of the API as well.
        production_policy_version: project.production_policy_version,
      };
    });
  });

  // ---- canon operator actions: correction, retcon, regeneration preview, rollback -------------------
  //
  // The API plan specifies these as colon verbs on the canon resource. They are the authorized HTTP
  // surface over `packages/canon`'s already-tested services; this layer validates, authorizes, audits and
  // serializes, and enforces no canon rule of its own.
  //
  // ONE route for all three verbs, dispatched through `requireVerb`, for the reason `verbs.ts` documents:
  // Fastify reads `/v1/projects/:projectId/canon:retcon` as a parameter literally named `projectId:retcon`,
  // so registering `:correct`, `:retcon` and `:rollback` separately makes the second and third collide —
  // and before that error surfaces the FIRST registration silently answers all three. A request to
  // `:rollback` executing the correction handler would be an authorization hazard (rollback is owner-only),
  // which is precisely why the verb is parsed and matched against a closed allowlist instead.
  //
  // Role policy: a dry run is a READ of consequences and needs `viewer`. Committing a correction needs
  // `editor`. A retcon rewrites established history and a rollback retracts a commit, so both need
  // `owner` — the bar the UI plan's "destructive actions require confirmation" principle implies.
  const CANON_VERBS = ['correct', 'retcon', 'rollback'] as const;

  app.post('/v1/projects/:projectId/:canonAction', async (req, reply) => {
    const params = req.params as { projectId?: string; canonAction?: string };
    const { id, verb } = requireVerb(params.canonAction, CANON_VERBS);
    // The captured segment is `canon:<verb>`; anything else on this pattern is a different resource and
    // must not be served here. A static sibling route (`/exports`) still wins in Fastify's router, so this
    // guard only rejects genuinely unknown paths.
    if (id !== 'canon') throw new ApiError('NOT_FOUND', 'No such route.');
    const scope = await scoped(pool, req);
    const projectId = requireUuid(params.projectId, 'params.projectId');

    // Rollback takes a different body shape from correction/retcon, so it is parsed separately.
    if (verb === 'rollback') {
      const { expectedCanonVersion, dryRun } = parseRollbackBody(req.body);
      requireRole(scope, dryRun ? 'viewer' : 'owner');
      await inScope(pool, scope, async (c) => projectOr404(c, projectId));

      if (dryRun) {
        const result = await rollbackCanonOp(
          { pool },
          {
            projectId,
            expectedCanonVersion,
            dryRun: true,
            actor: actorOf(scope, 'api:canon:rollback'),
          },
        );
        return reply.status(200).send({
          ...correctionView(result),
          // Whether the latest commit CAN be rolled back, and why not when it cannot. MVP policy is
          // latest-only and a rollback of a rollback is refused; both decisions live in SQL.
          rollbackable: result.rollbackable,
          reason: result.reason ?? null,
        });
      }

      const outcome = await inScope(pool, scope, async (c) =>
        withIdempotency(
          c,
          {
            workspaceId: scope.workspaceId,
            key: headerOf(req, 'idempotency-key'),
            method: 'POST',
            route: '/v1/projects/:projectId/canon:rollback',
            body: req.body,
          },
          async () => {
            const result = await rollbackCanonOp(
              { pool },
              {
                projectId,
                expectedCanonVersion,
                dryRun: false,
                actor: actorOf(scope, 'api:canon:rollback'),
              },
            );
            await audit(c, scope, {
              action: 'canon.rollback',
              targetKind: 'canon_commit',
              targetId: result.commitId ?? undefined,
              projectId,
              requestId: req.id,
              detail: {
                canon_version: result.canonVersion,
                stale_marked: result.staleMarked.length,
                review_suggested: result.reviewSuggested.length,
              },
            });
            return {
              status: 200,
              body: { ...correctionView(result), rollbackable: result.rollbackable },
            };
          },
        ),
      );
      return reply.status(outcome.status).send(outcome.body);
    }

    const request = parseCorrectionBody(req.body);
    const isRetcon = verb === 'retcon';
    requireRole(scope, request.dryRun ? 'viewer' : isRetcon ? 'owner' : 'editor');
    // The project is resolved through an RLS-scoped read FIRST, so a cross-workspace project id is a 404
    // before any service call, and the service never sees another tenant's identifier.
    await inScope(pool, scope, async (c) => projectOr404(c, projectId));

    const via = isRetcon ? 'api:canon:retcon' : 'api:canon:correct';
    const runOp = async (): Promise<CorrectionResult> =>
      isRetcon
        ? retconCanonOp({ pool }, { projectId, request, actor: actorOf(scope, via) })
        : correctCanonOp({ pool }, { projectId, request, actor: actorOf(scope, via) });

    if (request.dryRun) {
      // A dry run writes nothing: no idempotency record, and no audit entry for a change that did not
      // happen. `planned ≠ happened` is an invariant of this system, and the audit log is where it shows.
      const result = await runOp();
      return reply.status(200).send(correctionView(result));
    }

    const outcome = await inScope(pool, scope, async (c) =>
      withIdempotency(
        c,
        {
          workspaceId: scope.workspaceId,
          key: headerOf(req, 'idempotency-key'),
          method: 'POST',
          route: isRetcon
            ? '/v1/projects/:projectId/canon:retcon'
            : '/v1/projects/:projectId/canon:correct',
          body: req.body,
        },
        async () => {
          const result = await runOp();
          await audit(c, scope, {
            action: isRetcon ? 'canon.retcon' : 'canon.correct',
            targetKind: request.itemKind,
            targetId: request.itemId,
            projectId,
            requestId: req.id,
            // Safe metadata only: what changed and how far it reached, never the corrected value itself.
            detail: {
              canon_version: result.canonVersion,
              commit_id: result.commitId ?? null,
              stale_marked: result.staleMarked.length,
              review_suggested: result.reviewSuggested.length,
              ...(isRetcon
                ? { affected_accepted_chapters: result.impact.affectedAcceptedChapters.length }
                : {}),
            },
          });
          return { status: 200, body: correctionView(result) };
        },
      ),
    );
    return reply.status(outcome.status).send(outcome.body);
  });

  // Regeneration preview is a pure read: it reports which later chapters were written against the canon
  // this chapter committed, and marks nothing. A GET is therefore the honest method.
  app.get('/v1/projects/:projectId/chapters/:number/regeneration-preview', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const params = req.params as { projectId?: string; number?: string };
    const projectId = requireUuid(params.projectId, 'params.projectId');
    const chapterNo = requireInt(params.number, 'params.number', { min: 1, max: 10_000 });
    await inScope(pool, scope, async (c) => projectOr404(c, projectId));
    const report = await regenerationCanonOp({ pool }, { projectId, chapterNo });
    return { chapter_no: chapterNo, impact: impactView(report) };
  });
  // ---- jobs -----------------------------------------------------------------------------------------
  app.get('/v1/projects/:projectId/jobs', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const rows = await c.query<{
        id: string;
        kind: string;
        status: string;
        current_step: string | null;
        control: string;
        spend_cents: string;
        error: Record<string, unknown> | null;
      }>(
        `SELECT id, kind, status, current_step, control, spend_cents::text AS spend_cents, error
           FROM jobs WHERE project_id = $1 ORDER BY created_at DESC, id LIMIT 100`,
        [projectId],
      );
      return { items: rows.rows };
    });
  });

  app.get('/v1/jobs/:jobId', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const jobId = requireUuid((req.params as { jobId?: string }).jobId, 'params.jobId');
    return inScope(pool, scope, async (c) => {
      const job = await jobRowOr404(c, jobId);
      const steps = await c.query<{
        step: string;
        status: string;
        attempt: number;
        error: Record<string, unknown> | null;
      }>(
        `SELECT step, status, attempt, error FROM job_steps WHERE job_id = $1
          ORDER BY started_at, id`,
        [jobId],
      );
      return {
        ...job,
        attention: needsAttention(job.status),
        terminal: isTerminalStatus(job.status),
        steps: steps.rows,
      };
    });
  });

  // Pause / resume / cancel. These are intents: the runtime observes them at a checkpoint boundary, so no
  // step is torn in half and a cancelled run leaves nothing partial in canon (packages/db/job-control.ts).
  //
  // One route serves all three verbs because Fastify reads `/:jobId\\:pause` as a single parameter named
  // `jobId:pause`; registering the three patterns separately makes the first silently answer all of them,
  // which would run the pause handler (editor) for a cancel request (owner). See ./verbs.ts.
  app.post('/v1/jobs/:jobAction', async (req, reply) => {
    const { id, verb: action } = requireVerb((req.params as { jobAction?: string }).jobAction, [
      'pause',
      'resume',
      'cancel',
    ] as const);
    const scope = await scoped(pool, req);
    // Cancelling discards work that has already been paid for, so it is an owner operation; pause and
    // resume are ordinary production control an editor performs.
    requireRole(scope, action === 'cancel' ? 'owner' : 'editor');
    const jobId = requireUuid(id, 'params.jobId');
    const outcome = await inScope(pool, scope, async (c) =>
      withIdempotency(
        c,
        {
          workspaceId: scope.workspaceId,
          key: headerOf(req, 'idempotency-key'),
          method: 'POST',
          route: `/v1/jobs/:jobId:${action}`,
          body: req.body ?? null,
        },
        async () => {
          const job = await jobRowOr404(c, jobId);
          const result = await requestJobControl(c, {
            jobId,
            control: action === 'resume' ? 'run' : action,
            actorUserId: scope.principal.user.id,
          });
          await audit(c, scope, {
            action: `job.${action}`,
            targetKind: 'job',
            targetId: jobId,
            projectId: job.project_id,
            requestId: req.id,
            detail: { applied: result.applied, reason: result.reason ?? null },
          });
          // Counted with the same truthfulness the response carries: a refused control is an
          // `applied=false` outcome, not an absence of signal.
          metrics.increment(METRIC.jobControl, METRIC_HELP[METRIC.jobControl] ?? '', {
            // `action` is validated against a closed list above, so it is already bounded.
            control: action,
            outcome: result.applied ? 'applied' : 'refused',
          });
          return {
            // A refused request is reported truthfully rather than as a silent success: the client is
            // told the job is terminal / not paused / already requested, and can act on it.
            status: result.applied ? 202 : 200,
            body: {
              job_id: jobId,
              status: result.job.status,
              control: jobControlOf(result.job),
              applied: result.applied,
              reason: result.reason ?? null,
            },
          };
        },
      ),
    );
    return reply.status(outcome.status).send(outcome.body);
  });

  /**
   * Job progress as server-sent events, replayed from the persisted `job_events` log.
   *
   * Every poll runs in its own RLS-scoped transaction rather than holding one open for the stream's
   * lifetime: a long-lived transaction would pin a connection and an old snapshot, and would therefore
   * never observe the events it exists to deliver.
   */
  app.get('/v1/jobs/:jobId/events', async (req, reply) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const jobId = requireUuid((req.params as { jobId?: string }).jobId, 'params.jobId');
    const fromSeq = parseLastEventId(headerOf(req, 'last-event-id'));

    // Authorize and confirm visibility before a single byte of stream is written, so an unauthorized or
    // foreign job produces a normal problem document instead of a half-open event stream.
    await inScope(pool, scope, async (c) => jobRowOr404(c, jobId));

    metrics.increment(METRIC.sseConnections, METRIC_HELP[METRIC.sseConnections] ?? '');
    reply.raw.writeHead(200, { ...SSE_HEADERS, 'x-request-id': req.id });
    const sink: SseSink = {
      write: (chunk) => {
        reply.raw.write(chunk);
      },
      end: () => {
        reply.raw.end();
      },
      // Re-read the socket state on every call: the client can vanish between two frames.
      isClosed: () => reply.raw.writableEnded || reply.raw.destroyed || req.raw.destroyed,
    };
    const result = await streamJobEvents({
      sink,
      fromSeq,
      readEvents: (afterSeq, limit) =>
        inScope(pool, scope, async (c) => jobEventsAfter(c, { jobId, afterSeq, limit })),
    });
    if (!sink.isClosed()) reply.raw.end();
    // `parseLastEventId` returns 0 when the client sent no cursor, so a REPLAY is `fromSeq > 0` --
    // an undefined check is always true here and would count every fresh stream as a replay.
    if (fromSeq > 0) {
      metrics.increment(
        METRIC.sseReplays,
        METRIC_HELP[METRIC.sseReplays] ?? '',
        {},
        result.delivered,
      );
    }
    req.log.debug({ request_id: req.id, ...result }, 'sse stream finished');
    return reply;
  });

  app.get('/v1/projects/:projectId/workflows/:chapterNo/status', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const params = req.params as { projectId?: string; chapterNo?: string };
    const projectId = requireUuid(params.projectId, 'params.projectId');
    const chapterNo = requireInt(params.chapterNo, 'params.chapterNo', { min: 1, max: 10_000 });
    // Verify project visibility in scope first, so a foreign project id cannot be probed through the
    // workflow-status read.
    await inScope(pool, scope, async (c) => projectOr404(c, projectId));
    const status = await workflowStatus(pool, workflowIdFor(projectId, chapterNo));
    return status;
  });

  // ---- operator diagnostics and controls (Workstream A) ---------------------------------------------
  //
  // These routes are a thin adapter over `operator.ts`, which is the SAME application layer the
  // `operator:*` CLI commands call. Keeping one layer under both surfaces is what stops the CLI and the
  // API from answering the same operational question differently.
  //
  // Role policy, applied uniformly below:
  //   * a diagnostic is a READ and requires `viewer`;
  //   * embedding-set activation and rollback change what every subsequent retrieval reads, and the
  //     thesaurus mutations change how queries resolve, so all of them require `owner` and are AUDITED.
  //
  // Scope never comes from the payload. Every route derives the workspace from the authenticated
  // principal and resolves the project through `projectOr404` inside the RLS scope FIRST, so a project id
  // from another workspace is a 404 before any service sees it.

  app.get('/v1/operator/rate-limits', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const query = req.query as Record<string, unknown>;
    const operationClass = requireEnum(
      (query.operation_class as string | undefined) ?? 'provider_call',
      OPERATION_CLASSES,
      'query.operation_class',
    );
    const projectId = queryString(query.project_id)
      ? requireUuid(queryString(query.project_id), 'query.project_id')
      : undefined;
    return inScope(pool, scope, async (c) => {
      if (projectId) await projectOr404(c, projectId);
      return operatorRateLimitStatus(c, {
        workspaceId: scope.workspaceId,
        projectId,
        operationClass,
      });
    });
  });

  app.get('/v1/operator/leases', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const query = req.query as Record<string, unknown>;
    const projectId = queryString(query.project_id)
      ? requireUuid(queryString(query.project_id), 'query.project_id')
      : undefined;
    return inScope(pool, scope, async (c) => {
      if (projectId) await projectOr404(c, projectId);
      return leaseOccupancy(c, { projectId, limit: query.limit });
    });
  });

  app.get('/v1/operator/budgets', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const query = req.query as Record<string, unknown>;
    const scopeKind = requireEnum(
      (query.scope_kind as string | undefined) ?? 'workspace',
      BUDGET_SCOPE_KINDS,
      'query.scope_kind',
    );
    // A workspace-scoped budget is ALWAYS the caller's own workspace, taken from the auth context. A
    // project-scoped one must name a project that is visible in that scope. Neither accepts an arbitrary
    // scope id from the query, which is what stops this route from reading another tenant's budget.
    return inScope(pool, scope, async (c) => {
      if (scopeKind === 'workspace')
        return budgetReport(c, { scopeKind, scopeId: scope.workspaceId });
      const projectId = requireUuid(queryString(query.project_id), 'query.project_id');
      await projectOr404(c, projectId);
      return budgetReport(c, { scopeKind: 'project', scopeId: projectId });
    });
  });

  app.get('/v1/projects/:projectId/operator/embedding-set', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      return embeddingSetReport(c, { projectId, hashOf: contentHashOf });
    });
  });

  app.get('/v1/projects/:projectId/operator/embedding-sets/gc-eligible', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const query = req.query as Record<string, unknown>;
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      return gcEligible(c, { projectId, keep: Number(query.keep ?? 1), limit: query.limit });
    });
  });

  app.get('/v1/projects/:projectId/operator/thesaurus', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const query = req.query as Record<string, unknown>;
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      return thesaurusListing(c, {
        projectId,
        limit: query.limit,
        includeInactive: query.include_inactive === 'true',
      });
    });
  });

  app.get('/v1/projects/:projectId/operator/retrieval', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const query = req.query as Record<string, unknown>;
    const q = requireString(query, 'q', { max: 500 });
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      return retrievalDiagnostics(c, { projectId, query: q, limit: query.limit });
    });
  });

  // ---- operator mutations (Workstream B) -------------------------------------------------------------
  //
  // Every route below changes what the system does next, so all of them share one policy:
  //
  //   * OWNER ONLY. Activating an embedding set changes what every subsequent retrieval reads, and a
  //     thesaurus edit changes how queries resolve. Those are the same class of consequence as a canon
  //     rollback, which is already owner-gated.
  //   * AUDITED, on success and on refusal. A refused mutation is exactly as interesting as a successful
  //     one when reconstructing what an operator attempted, so both append to `audit_log`. The detail is
  //     the SAFE payload the service layer returns, never raw error text.
  //   * SCOPE FROM THE AUTH CONTEXT. The project is resolved through `projectOr404` inside the RLS scope
  //     before any service sees it, so a cross-tenant id is a 404 rather than a refusal that confirms it.
  //   * ONE TRANSACTION where the mutation and its audit row must agree. `inScope` runs both against the
  //     same scoped client, so an audit row cannot survive a rolled-back mutation.

  /** Map the service layer's closed code set onto problem documents. */
  function operatorProblem(err: unknown): never {
    if (err instanceof OperatorMutationError) {
      if (err.code === 'NOT_FOUND') throw new ApiError('NOT_FOUND', err.message);
      if (err.code === 'ALIAS_INVALID') throw new ApiError('VALIDATION_FAILED', err.message);
      // Everything else is a precondition the caller can resolve and retry: 409, not 500.
      throw new ApiError('CONFLICT', err.message, { data: { reason: err.code } });
    }
    throw err;
  }

  /**
   * Run an owner-gated mutation, auditing both outcomes.
   *
   * The refusal audit is written in its OWN transaction, because the mutation's transaction is being
   * rolled back — writing the refusal inside it would roll the evidence back too, which is precisely
   * when an audit trail matters most.
   */
  async function operatorMutation<T>(
    req: FastifyRequest,
    action: string,
    projectId: string,
    run: (
      c: Client,
      scope: WorkspaceScope,
    ) => Promise<{ result: T; audit: Readonly<Record<string, unknown>> }>,
  ): Promise<T> {
    const scope = await scoped(pool, req);
    requireRole(scope, 'owner');
    try {
      return await inScope(pool, scope, async (c) => {
        await projectOr404(c, projectId);
        // `scope` is passed through rather than re-resolved inside the callback: calling `scoped`
        // again here would take a SECOND connection from the pool while this one is held, which
        // deadlocks a small pool and surfaced as a 500.
        const outcome = await run(c, scope);
        await audit(c, scope, {
          action,
          projectId,
          targetKind: 'operator',
          requestId: req.id,
          detail: { outcome: 'succeeded', ...outcome.audit },
        });
        return outcome.result;
      });
    } catch (err) {
      if (err instanceof OperatorMutationError) {
        await inScope(pool, scope, async (c) => {
          await audit(c, scope, {
            action,
            projectId,
            targetKind: 'operator',
            requestId: req.id,
            // The CODE only: raw error text could carry detail that does not belong in an audit row.
            detail: { outcome: 'refused', reason: err.code },
          });
        });
      }
      return operatorProblem(err);
    }
  }

  app.post(
    '/v1/projects/:projectId/operator/embedding-sets/:setId/activate',
    async (req, reply) => {
      const params = req.params as { projectId?: string; setId?: string };
      const projectId = requireUuid(params.projectId, 'params.projectId');
      const setId = requireUuid(params.setId, 'params.setId');
      const result = await operatorMutation(
        req,
        'operator.embedding_set.activate',
        projectId,
        (c) => activateEmbeddingSetForOperator(c, { projectId, setId }),
      );
      return reply.status(200).send(result);
    },
  );

  app.post('/v1/projects/:projectId/operator/embedding-sets/rollback', async (req, reply) => {
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const result = await operatorMutation(req, 'operator.embedding_set.rollback', projectId, (c) =>
      rollbackEmbeddingSetForOperator(c, { projectId }),
    );
    return reply.status(200).send(result);
  });

  app.post('/v1/projects/:projectId/operator/thesaurus', async (req, reply) => {
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const result = await operatorMutation(
      req,
      'operator.thesaurus.create',
      projectId,
      async (c, scope) => {
        /**
         * Body validation happens INSIDE the authorized callback.
         *
         * Validating before `operatorMutation` authenticated the caller meant an anonymous request with
         * a malformed body got 422 — telling an unauthenticated stranger about the request schema, and
         * answering something other than "who are you?" to a request that had no business being parsed.
         */
        const body = asObject(req.body);
        const surface = requireString(body, 'surface', { max: 200 });
        const kind = requireEnum(body.kind ?? 'alias', OPERATOR_ALIAS_KINDS, 'body.kind');
        const entityId = body.entity_id
          ? requireUuid(queryString(body.entity_id), 'body.entity_id')
          : undefined;
        // The entity must be visible in THIS project: an alias pointing at another project's entity
        // would be a cross-project write dressed up as a thesaurus edit.
        if (entityId) {
          const found = await c.query<{ id: string }>(
            'SELECT id FROM entities WHERE id = $1 AND project_id = $2',
            [entityId, projectId],
          );
          if (!found.rows[0])
            throw new OperatorMutationError('NOT_FOUND', 'The entity does not exist.');
        }
        return createAliasForOperator(c, {
          workspaceId: scope.workspaceId,
          projectId,
          surface,
          kind,
          entityId,
        });
      },
    );
    return reply.status(201).send(result);
  });

  app.post(
    '/v1/projects/:projectId/operator/thesaurus/:aliasId/:aliasAction',
    async (req, reply) => {
      const params = req.params as { projectId?: string; aliasId?: string; aliasAction?: string };
      const projectId = requireUuid(params.projectId, 'params.projectId');
      /**
       * The action is parsed BEFORE the mutation runs because it names the audit action, but the alias id
       * is validated inside the authorized callback for the same reason the body is: an unauthenticated
       * caller must be told "who are you?", not "your id is malformed".
       */
      const action = requireEnum(
        params.aliasAction,
        ['deactivate', 'reactivate'] as const,
        'params.aliasAction',
      );
      const result = await operatorMutation(req, `operator.thesaurus.${action}`, projectId, (c) => {
        const aliasId = requireUuid(params.aliasId, 'params.aliasId');
        return setAliasActiveForOperator(c, {
          projectId,
          aliasId,
          active: action === 'reactivate',
        });
      });
      return reply.status(200).send(result);
    },
  );

  // ---- exports (accepted content only) --------------------------------------------------------------
  app.get('/v1/projects/:projectId/exports/preview', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const project = await inScope(pool, scope, async (c) => projectOr404(c, projectId));
    // `exportAccepted` is the Checkpoint 5 service: it reads accepted versions only. The API does not
    // re-implement the accepted-only rule, it reuses the one that is already proven.
    const result = await exportAccepted(pool, { projectId, title: project.title });
    return {
      chapters: result.chapters.map((chapter) => ({
        chapter_no: chapter.chapter_no,
        words: chapter.words,
        manuscript_version_id: chapter.manuscript_version_id,
        content_hash: chapter.content_hash,
        canon_version: chapter.canon_version,
      })),
      code_points: result.text.length,
    };
  });

  // ---- export lifecycle (accepted content only) -----------------------------------------------------
  app.post('/v1/projects/:projectId/exports', async (req, reply) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'editor');
    const projectId = requireUuid(
      (req.params as { projectId?: string }).projectId,
      'params.projectId',
    );
    const body = asObject(req.body);
    const format = requireEnum(body.format, ['txt', 'docx'] as const, 'body.format');
    const chapters = parseChapterScope(body.chapters);
    const typography = parseTypography(
      body.options === undefined ? undefined : asObject(body.options, 'body.options'),
    );

    const outcome = await inScope(pool, scope, async (c) =>
      withIdempotency(
        c,
        {
          workspaceId: scope.workspaceId,
          key: headerOf(req, 'idempotency-key'),
          method: 'POST',
          route: '/v1/projects/:projectId/exports',
          body: req.body,
        },
        async () => {
          const project = await projectOr404(c, projectId);
          const scopeJson = { chapters: chapters ?? 'all_accepted' };
          const optionsJson = {
            paragraph_style: typography.paragraphStyle,
            locale: typography.locale,
            include_chapter_headings: typography.includeChapterHeadings,
          };
          let rendered;
          try {
            rendered = await renderExport(pool, {
              projectId,
              title: project.title,
              format,
              typography,
              ...(chapters ? { chapters } : {}),
            });
          } catch (err) {
            // A chapter that is not accepted is a legitimate, typed refusal. It is recorded so the operator
            // can see that the export was attempted and why it did not happen — but in a SEPARATE scoped
            // transaction, because this one is about to roll back as the error propagates. Writing the
            // record here would roll it back with everything else, leaving a silent refusal.
            const wf = err as { code?: string; detail?: string };
            await inScope(pool, scope, async (failureClient) => {
              const row = await persistFailedExport(failureClient, {
                workspaceId: scope.workspaceId,
                projectId,
                requestedBy: scope.principal.user.id,
                format,
                scope: scopeJson,
                options: optionsJson,
                error: { code: wf.code ?? 'INTERNAL', detail: wf.detail ?? 'export failed' },
              });
              await audit(failureClient, scope, {
                action: 'export.request',
                targetKind: 'export',
                targetId: row.id,
                projectId,
                requestId: req.id,
                detail: { format, status: 'failed', code: wf.code ?? 'INTERNAL' },
              });
            });
            metrics.increment(METRIC.exports, METRIC_HELP[METRIC.exports] ?? '', {
              format,
              status: 'failed',
            });
            throw err;
          }
          metrics.increment(METRIC.exports, METRIC_HELP[METRIC.exports] ?? '', {
            format,
            status: 'ready',
          });
          const row = await persistExport(c, {
            workspaceId: scope.workspaceId,
            projectId,
            requestedBy: scope.principal.user.id,
            format,
            scope: scopeJson,
            options: optionsJson,
            rendered,
          });
          await audit(c, scope, {
            action: 'export.request',
            targetKind: 'export',
            targetId: row.id,
            projectId,
            requestId: req.id,
            detail: { format, chapters: rendered.chapterNumbers.length },
          });
          return { status: 201, body: exportView(row) };
        },
      ),
    );
    return reply.status(outcome.status).send(outcome.body);
  });

  app.get('/v1/projects/:projectId/exports/:exportId', async (req) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const params = req.params as { projectId?: string; exportId?: string };
    const projectId = requireUuid(params.projectId, 'params.projectId');
    const exportId = requireUuid(params.exportId, 'params.exportId');
    return inScope(pool, scope, async (c) => {
      await projectOr404(c, projectId);
      const row = await exportOr404(c, exportId);
      // An export id from another project in the same workspace must not resolve under this project.
      if (row.project_id !== projectId)
        throw new ApiError('NOT_FOUND', 'The export does not exist.');
      return exportView(row);
    });
  });

  /**
   * Download an export's bytes. The request names an export ID; there is no filesystem path anywhere in it,
   * so traversal is impossible rather than merely filtered, and the filename in Content-Disposition is
   * derived from the project title through an ASCII-only slug.
   */
  app.get('/v1/projects/:projectId/exports/:exportId/content', async (req, reply) => {
    const scope = await scoped(pool, req);
    requireRole(scope, 'viewer');
    const params = req.params as { projectId?: string; exportId?: string };
    const projectId = requireUuid(params.projectId, 'params.projectId');
    const exportId = requireUuid(params.exportId, 'params.exportId');
    const { project, row, content } = await inScope(pool, scope, async (c) => {
      const found = await projectOr404(c, projectId);
      const result = await exportContent(c, exportId);
      if (result.row.project_id !== projectId)
        throw new ApiError('NOT_FOUND', 'The export does not exist.');
      return { project: found, ...result };
    });
    await inScope(pool, scope, async (c) =>
      audit(c, scope, {
        action: 'export.download',
        targetKind: 'export',
        targetId: exportId,
        projectId,
        requestId: req.id,
        detail: { format: row.format, bytes: content.byteLength },
      }),
    );
    return reply
      .header('content-type', CONTENT_TYPES[row.format])
      .header(
        'content-disposition',
        `attachment; filename="${safeFilename(project.title, row.format)}"`,
      )
      .header('x-content-hash', row.content_hash ?? '')
      .send(content);
  });

  // The operator-editable resource families (API plan §1) live in their own module for size; they share
  // this file's authentication, scoping, audit and pagination helpers rather than re-deriving them, so
  // there is exactly one implementation of each rule.
  registerResourceRoutes(app, {
    pool,
    scoped: (req) => scoped(pool, req),
    inScope: (scope, fn) => inScope(pool, scope, fn),
    projectOr404,
    audit,
    pageOf,
    headerOf,
  });

  // The credential-free product surfaces (dependency status, preview, quality checks, export
  // preparation, batches) follow the same pattern and share the same helpers.
  registerProductRoutes(app, {
    pool,
    scoped: (req) => scoped(pool, req),
    inScope: (scope, fn) => inScope(pool, scope, fn),
    projectOr404,
    audit,
    headerOf,
    metrics,
    lifecycle,
  });

  return app;
}

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

function headerOf(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function toRequestLike(req: FastifyRequest) {
  return {
    method: req.method,
    headers: req.headers as Readonly<Record<string, string | string[] | undefined>>,
  };
}

/** Authenticate and authorize in one step; every workspace-scoped route starts here. */
async function scoped(pool: Pool, req: FastifyRequest): Promise<WorkspaceScope> {
  const principal: Principal = await authenticate(pool, toRequestLike(req));
  return requireWorkspace(pool, principal, headerOf(req, WORKSPACE_HEADER));
}

/**
 * Read a project inside the RLS scope. A project in another workspace is simply not visible, so this
 * returns the same 404 as a project that does not exist — an id must not be a cross-tenant probe.
 */
async function projectOr404(
  c: Client,
  projectId: string,
): Promise<{
  id: string;
  title: string;
  status: string;
  canon_version: number;
  quality_tier: string;
  operating_mode: string;
  production_policy_version: string;
}> {
  const r = await c.query<{
    id: string;
    title: string;
    status: string;
    canon_version: number;
    quality_tier: string;
    operating_mode: string;
    production_policy_version: string;
  }>(
    `SELECT id, title, status, canon_version, quality_tier, operating_mode, production_policy_version
       FROM projects WHERE id = $1`,
    [projectId],
  );
  const row = r.rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'The project does not exist.');
  return row;
}

/**
 * Read a job inside the RLS scope. A job belonging to another workspace is invisible, so this answers the
 * same 404 as a job that does not exist — a job id must not be a cross-tenant existence probe.
 */
async function jobRowOr404(
  c: Client,
  jobId: string,
): Promise<{
  id: string;
  project_id: string;
  kind: string;
  status: string;
  control: string;
  current_step: string | null;
  spend_cents: string;
  error: Record<string, unknown> | null;
  created_at: Date;
  finished_at: Date | null;
}> {
  const r = await c.query<{
    id: string;
    project_id: string;
    kind: string;
    status: string;
    control: string;
    current_step: string | null;
    spend_cents: string;
    error: Record<string, unknown> | null;
    created_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, project_id, kind, status, control, current_step, spend_cents::text AS spend_cents,
            error, created_at, finished_at
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  const row = r.rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'The job does not exist.');
  return row;
}

/** Project creation inside the caller's RLS scope (so the row cannot land in another workspace). */
async function createProjectScoped(
  c: Client,
  input: { workspaceId: string; title: string; qualityTier: string; operatingMode: string },
): Promise<{ projectId: string; mainTimelineId: string }> {
  const project = await c.query<{ id: string }>(
    `INSERT INTO projects (workspace_id, title, quality_tier, operating_mode)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.workspaceId, input.title, input.qualityTier, input.operatingMode],
  );
  const projectId = project.rows[0]?.id;
  if (!projectId) throw new ApiError('INTERNAL_ERROR', 'The project could not be created.');
  const timeline = await c.query<{ id: string }>(
    `INSERT INTO timelines (workspace_id, project_id, name, kind) VALUES ($1, $2, 'main', 'main')
     RETURNING id`,
    [input.workspaceId, projectId],
  );
  const mainTimelineId = timeline.rows[0]?.id;
  if (!mainTimelineId)
    throw new ApiError('INTERNAL_ERROR', 'The project timeline could not be created.');
  return { projectId, mainTimelineId };
}

/**
 * The actor a canon operation is attributed to.
 *
 * The user id comes from the authenticated principal, never from the request body: provenance that a caller
 * could set would make the canon commit's actor record worthless as an audit trail. `via` names the exact
 * route so a commit can be traced back to the surface that produced it (API vs CLI vs workflow).
 */
function actorOf(scope: WorkspaceScope, via: string): { userId: string; via: string } {
  return { userId: scope.principal.user.id, via };
}

/** Append a privileged/destructive action to the audit log. Safe metadata only. */ async function audit(
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
): Promise<void> {
  await c.query(
    `INSERT INTO audit_log (workspace_id, project_id, actor_user_id, action, target_kind, target_id, request_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      scope.workspaceId,
      input.projectId ?? null,
      scope.principal.user.id,
      input.action,
      input.targetKind ?? null,
      input.targetId ?? null,
      input.requestId,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

/** Validate an optional explicit chapter scope. An empty array is a client error, not "everything". */
function parseChapterScope(value: unknown): readonly number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0)
    throw new ApiError(
      'VALIDATION_FAILED',
      'body.chapters must be a non-empty array of chapter numbers.',
      {
        errors: [{ path: 'body.chapters', message: 'non-empty array of integers' }],
      },
    );
  if (value.length > 500)
    throw new ApiError('VALIDATION_FAILED', 'body.chapters may name at most 500 chapters.', {
      errors: [{ path: 'body.chapters', message: 'at most 500 entries' }],
    });
  // `value` arrives as `any[]` from JSON. Each entry is checked to be a number here rather than handed to
  // requireInt untyped, so a nested object or array cannot reach the coercion.
  const numbers = (value as unknown[]).map((entry, i) => {
    if (typeof entry !== 'number')
      throw new ApiError('VALIDATION_FAILED', 'body.chapters must contain chapter numbers.', {
        errors: [{ path: `body.chapters[${i}]`, message: 'must be an integer' }],
      });
    return requireInt(entry, `body.chapters[${i}]`, { min: 1, max: 10_000 });
  });
  // Deterministic order regardless of how the client listed them, and no duplicate chapter in the output.
  return [...new Set(numbers)].sort((a, b) => a - b);
}

/** The safe public view of an export. `content` is never serialized into JSON. */
function exportView(row: ExportRow): Record<string, unknown> {
  return {
    id: row.id,
    project_id: row.project_id,
    format: row.format,
    status: row.status,
    canon_version: row.canon_version,
    chapter_numbers: row.chapter_numbers,
    content_hash: row.content_hash,
    byte_size: row.byte_size,
    error: row.error,
    created_at: row.created_at,
    completed_at: row.completed_at,
    download_path:
      row.status === 'ready' ? `/v1/projects/${row.project_id}/exports/${row.id}/content` : null,
  };
}

/** Cursor page envelope with a deterministic next cursor. */
function pageOf<T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => string,
): { items: readonly T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const hasMore = rows.length > limit;
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor(keyOf(last)) : null,
  };
}

export { CSRF_HEADER, SESSION_COOKIE, WORKSPACE_HEADER };
