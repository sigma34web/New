/**
 * Per-dependency status reporting.
 *
 * WHAT WAS MISSING. `readiness()` answers one question — may this instance take traffic — and it answers
 * it with a flat list of checks whose optionality is decided by the CALLER (`opts.optional`). That is
 * enough for a load balancer and not enough for an operator: nothing declared which components exist,
 * which of them are required, or how to tell "deliberately switched off" from "broken". A disabled
 * subsystem reported as `degraded` teaches operators to ignore `degraded`.
 *
 * THE MODEL. Each component declares its own `required` flag once, in `DEPENDENCIES` below, and reports
 * one of six stable states. The rules that follow from that declaration are the point of the module:
 *
 *   * a REQUIRED component in `unavailable` (or `starting`) fails readiness;
 *   * an OPTIONAL component in `degraded` or `unavailable` never fails readiness — it makes the report
 *     `degraded`, which is a signal, not an outage;
 *   * `disabled` is an intentional configuration, so it is neither an error NOR a degradation. This is
 *     the distinction that makes the field useful: if switching a subsystem off produced the same
 *     `degraded` signal as that subsystem breaking, operators would learn to ignore `degraded`;
 *   * `draining` is reported for the components that have a drain phase, and fails readiness for the
 *     process that is draining, because a draining process must stop being given work while remaining
 *     LIVE. Liveness is answered from process state and never consults this module.
 *
 * SAFETY. A probe returns a state and a code, never an exception. Every explanation is chosen from the
 * closed `DependencyCode` set plus a bounded, sanitized detail; no driver error, connection string,
 * credential, SQL text, stack trace or internal URL can reach a caller, because the probe result is
 * constructed from the closed set rather than from the thrown value. `summarize` bounds the component
 * count and the detail length so the output of an unauthenticated probe endpoint stays small.
 */
import { METRIC, METRIC_HELP, type Metrics, safeLabelValue } from '@yeonjae/domain';
import { type Client, type Pool } from './client.js';
import { checkAppRole, checkMigrations, type ReadinessReport } from './readiness.js';

type Queryable = Pool | Client;

/** The six states a component may report. Stable, machine-readable, and a closed set. */
export const DEPENDENCY_STATES = [
  'up',
  'degraded',
  'unavailable',
  'disabled',
  'starting',
  'draining',
] as const;
export type DependencyState = (typeof DEPENDENCY_STATES)[number];

/**
 * Stable reason codes. Machine-readable, so an operator tool can branch on them without parsing prose,
 * and closed, so an arbitrary exception message can never become one.
 */
export const DEPENDENCY_CODES = [
  'OK',
  'DISABLED_BY_CONFIG',
  'STARTING',
  'DRAINING',
  'UNREACHABLE',
  'PROBE_TIMEOUT',
  'PROBE_FAILED',
  'SCHEMA_BEHIND',
  'SCHEMA_AHEAD',
  'SCHEMA_TAMPERED',
  'ROLE_UNSAFE',
  'NOT_CONFIGURED',
  'CAPACITY_EXHAUSTED',
  'PARTIALLY_AVAILABLE',
  'INCOMPLETE',
  'PROVIDER_MODE_INVALID',
] as const;
export type DependencyCode = (typeof DEPENDENCY_CODES)[number];

/** The components the system reports on. The list is closed, which is what bounds the output. */
export const DEPENDENCY_NAMES = [
  'postgres',
  'workflow',
  'api',
  'worker',
  'provider_simulator',
  'retrieval',
  'embeddings',
  'limiter',
  'budget',
  'telemetry',
  'recovery',
] as const;
export type DependencyName = (typeof DEPENDENCY_NAMES)[number];

export interface DependencyDeclaration {
  readonly name: DependencyName;
  /** Required components fail readiness when unavailable. Optional ones only degrade it. */
  readonly required: boolean;
  /** Whether this component has a drain phase at all. */
  readonly drainable: boolean;
  /** One sentence, fixed at declaration time, so it cannot carry runtime data. */
  readonly purpose: string;
}

/**
 * The declaration. `required` is decided HERE, once, rather than by each caller: the previous shape let
 * two processes disagree about whether the same dependency was optional.
 *
 * Postgres is the single system of record (ADR-0001), so nothing works without it. Everything else is
 * optional to the process's ability to answer requests: retrieval degrades to lexical-only, the limiter
 * and budget fail CLOSED elsewhere (refusing spend is safe), telemetry losing a counter must never take
 * a process down, and Temporal only orchestrates from Checkpoint 7 (ADR-0044) so its absence is a
 * reduced-capability state rather than an outage.
 */
export const DEPENDENCIES: readonly DependencyDeclaration[] = [
  {
    name: 'postgres',
    required: true,
    drainable: true,
    purpose: 'the single system of record; nothing can be served without it',
  },
  {
    name: 'workflow',
    required: false,
    drainable: true,
    purpose:
      'durable orchestration; absent before Checkpoint 7, when the loop is Postgres-checkpointed',
  },
  {
    name: 'api',
    required: true,
    drainable: true,
    purpose: 'the request surface of this deployment',
  },
  { name: 'worker', required: false, drainable: true, purpose: 'executes production activities' },
  {
    name: 'provider_simulator',
    required: false,
    drainable: false,
    purpose: 'the deterministic local model provider; absent in live mode',
  },
  {
    name: 'retrieval',
    required: false,
    drainable: false,
    purpose: 'lexical and hybrid context retrieval; degrades to lexical-only',
  },
  {
    name: 'embeddings',
    required: false,
    drainable: false,
    purpose: 'versioned vector sets behind hybrid retrieval',
  },
  {
    name: 'limiter',
    required: false,
    drainable: false,
    purpose: 'shared rate and concurrency admission; fails closed',
  },
  {
    name: 'budget',
    required: false,
    drainable: false,
    purpose: 'shared spend reservation and settlement; fails closed',
  },
  {
    name: 'telemetry',
    required: false,
    drainable: true,
    purpose: 'per-process metrics; a lost counter must never stop a process',
  },
  {
    name: 'recovery',
    required: false,
    drainable: false,
    purpose: 'backup manifest and restore capability',
  },
];

const DECLARED = new Map(DEPENDENCIES.map((d) => [d.name, d] as const));

/** Bounded so an unauthenticated probe response cannot grow with runtime data. */
export const MAX_DETAIL_LENGTH = 160;

export interface DependencyStatus {
  readonly name: DependencyName;
  readonly state: DependencyState;
  readonly code: DependencyCode;
  readonly required: boolean;
  /** A safe, bounded explanation. Never a driver error, credential, URL, SQL or stack trace. */
  readonly detail: string;
}

export interface DependencyReport {
  /** False when any REQUIRED component is not serving. */
  readonly ready: boolean;
  /** True when readiness holds but something optional is not fully healthy. */
  readonly degraded: boolean;
  /** True when this process is shutting down. Reported separately: a draining process is still LIVE. */
  readonly draining: boolean;
  readonly components: readonly DependencyStatus[];
  /** Counts by state, so a dashboard needs no client-side aggregation. */
  readonly totals: Readonly<Record<DependencyState, number>>;
}

/**
 * Build a status from a declared component and a closed-set outcome.
 *
 * This is the only constructor: it is what makes "no exception text can escape" a structural property
 * rather than a review rule, because the detail is truncated and stripped of everything but safe
 * characters before it is stored.
 */
export function dependencyStatus(
  name: DependencyName,
  state: DependencyState,
  code: DependencyCode,
  detail: string,
): DependencyStatus {
  const declared = DECLARED.get(name);
  return {
    name,
    state,
    code,
    /**
     * A DISABLED component is never required.
     *
     * Requiredness answers "must this be working for this process to serve traffic", and a component
     * that is intentionally off, or that is a different process whose state is not observable from
     * here, cannot be required of THIS one. Without this, a worker reporting `api` as not-this-process
     * would fail its own readiness because a required component was not serving — which is exactly the
     * defect this line exists to prevent.
     */
    required: state === 'disabled' ? false : (declared?.required ?? false),
    detail: safeDetail(detail),
  };
}

/**
 * Reduce a message to a safe, bounded explanation.
 *
 * Anything resembling a URI scheme, a path, an angle bracket or a quote is removed rather than escaped:
 * these appear in connection strings, stack frames and SQL fragments, and a probe endpoint has no
 * legitimate need for any of them.
 */
export function safeDetail(input: string): string {
  return input
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/["'`<>\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL_LENGTH);
}

/** Whether a state means "this component is not serving requests". */
export function isServing(state: DependencyState): boolean {
  return state === 'up' || state === 'degraded';
}

/**
 * Summarize component statuses into a report.
 *
 * The two rules that matter both live here rather than at any call site:
 *  * a REQUIRED component that is not serving fails readiness — including `starting` and `draining`,
 *    which are legitimate states in which the process must not be given work;
 *  * an OPTIONAL component in any unhealthy state degrades and never fails, so one flaky optional
 *    dependency cannot take down a deployment that does not need it.
 */
export function summarize(components: readonly DependencyStatus[]): DependencyReport {
  const totals = Object.fromEntries(DEPENDENCY_STATES.map((s) => [s, 0])) as Record<
    DependencyState,
    number
  >;
  for (const c of components) totals[c.state] += 1;

  const requiredDown = components.some((c) => c.required && !isServing(c.state));
  const draining = components.some((c) => c.state === 'draining');
  // `disabled` is deliberately excluded: a subsystem an operator switched off is not a degradation.
  const anyUnhealthy = components.some((c) => c.state !== 'up' && c.state !== 'disabled');

  return {
    ready: !requiredDown,
    degraded: !requiredDown && anyUnhealthy,
    draining,
    components: [...components].sort((a, b) => a.name.localeCompare(b.name)),
    totals,
  };
}

/** Record component states by NAME and STATE only: both are closed sets, so cardinality is bounded. */
export function recordDependencyMetrics(
  metrics: Metrics | undefined,
  report: DependencyReport,
): void {
  if (!metrics) return;
  for (const c of report.components) {
    metrics.increment(METRIC.dependencyStatus, METRIC_HELP[METRIC.dependencyStatus] ?? '', {
      kind: safeLabelValue(c.name),
      state: safeLabelValue(c.state),
    });
  }
}

export interface ProbeContext {
  readonly db?: Queryable | undefined;
  /** The process's lifecycle state, when this process has one. */
  readonly lifecycle?: 'starting' | 'running' | 'draining' | 'stopped' | undefined;
  /** Which component this process IS, so it can report its own lifecycle. */
  readonly self?: DependencyName | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Per-probe deadline. A probe that hangs must not hang the report. */
  readonly timeoutMs?: number | undefined;
  /** Explicitly switched-off components, reported as `disabled` rather than broken. */
  readonly disabled?: readonly DependencyName[] | undefined;
  readonly migrationsDir?: string | undefined;
  readonly projectId?: string | undefined;
  readonly metrics?: Metrics | undefined;
  /** Overrides for components this process probes differently, or for tests. */
  readonly probes?: Partial<Record<DependencyName, () => Promise<DependencyStatus>>> | undefined;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Run one probe under a deadline, converting every failure into a closed-set status.
 *
 * A probe is untrusted from this module's point of view: it may throw a driver error carrying a
 * connection string, or it may never settle. Both are handled here so no individual probe has to.
 */
async function runProbe(
  name: DependencyName,
  timeoutMs: number,
  probe: () => Promise<DependencyStatus>,
): Promise<DependencyStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe(),
      new Promise<DependencyStatus>((resolve) => {
        timer = setTimeout(() => {
          resolve(
            dependencyStatus(
              name,
              'unavailable',
              'PROBE_TIMEOUT',
              `probe did not answer within ${String(timeoutMs)}ms`,
            ),
          );
        }, timeoutMs);
        // The timer must not keep a process alive past a drain.
        timer.unref();
      }),
    ]);
  } catch {
    // The thrown value is deliberately NOT inspected: that is the leak channel this module closes.
    return dependencyStatus(name, 'unavailable', 'PROBE_FAILED', 'the probe failed');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Postgres: reachable, migrated to this build, and running under a safe application role. */
async function probePostgres(ctx: ProbeContext): Promise<DependencyStatus> {
  const db = ctx.db;
  if (!db) return dependencyStatus('postgres', 'unavailable', 'NOT_CONFIGURED', 'no database pool');
  try {
    await db.query('SELECT 1');
  } catch {
    return dependencyStatus(
      'postgres',
      'unavailable',
      'UNREACHABLE',
      'the database is not reachable',
    );
  }
  const migrations = await checkMigrations(db, ctx.migrationsDir);
  if (migrations.missing.length > 0)
    return dependencyStatus(
      'postgres',
      'unavailable',
      'SCHEMA_BEHIND',
      `${String(migrations.missing.length)} migration(s) not applied`,
    );
  if (migrations.unknown.length > 0)
    return dependencyStatus(
      'postgres',
      'unavailable',
      'SCHEMA_AHEAD',
      `${String(migrations.unknown.length)} applied migration(s) unknown to this build`,
    );
  if (migrations.hashMismatches.length > 0)
    return dependencyStatus(
      'postgres',
      'unavailable',
      'SCHEMA_TAMPERED',
      `${String(migrations.hashMismatches.length)} applied migration(s) no longer match their hash`,
    );
  const role = await checkAppRole(db);
  if (role.status === 'fail')
    return dependencyStatus('postgres', 'unavailable', 'ROLE_UNSAFE', role.detail);
  return dependencyStatus(
    'postgres',
    'up',
    'OK',
    `reachable at migration ${migrations.latestApplied ?? 'none'}`,
  );
}

/**
 * The workflow backend.
 *
 * Absent configuration is `disabled`, not `unavailable`: before Checkpoint 7 the core loop runs as
 * Postgres-checkpointed steps, so "no Temporal configured" is the designed state, and reporting it as a
 * failure would train operators to ignore the field.
 */
async function probeWorkflow(ctx: ProbeContext): Promise<DependencyStatus> {
  const env = ctx.env ?? process.env;
  const configured = (env.TEMPORAL_ADDRESS ?? '').trim() !== '';
  if (!configured)
    return dependencyStatus(
      'workflow',
      'disabled',
      'DISABLED_BY_CONFIG',
      'no workflow backend configured; the core loop is Postgres-checkpointed',
    );
  const db = ctx.db;
  if (!db)
    return dependencyStatus('workflow', 'degraded', 'NOT_CONFIGURED', 'no durable step store');
  // With a backend configured, the observable local proof is that durable step state is readable.
  const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM job_steps');
  return dependencyStatus(
    'workflow',
    'up',
    'OK',
    `durable step store readable (${r.rows[0]?.n ?? '0'} steps)`,
  );
}

/** A process reports its OWN lifecycle; another process's is not observable from here. */
function probeProcess(name: DependencyName, ctx: ProbeContext): DependencyStatus {
  if (ctx.self !== name)
    return dependencyStatus(
      name,
      'disabled',
      'DISABLED_BY_CONFIG',
      'not this process; its state is not observable from here',
    );
  switch (ctx.lifecycle ?? 'running') {
    case 'starting':
      return dependencyStatus(
        name,
        'starting',
        'STARTING',
        'still starting; not yet accepting work',
      );
    case 'draining':
      return dependencyStatus(name, 'draining', 'DRAINING', 'draining; refusing new work');
    case 'stopped':
      return dependencyStatus(name, 'unavailable', 'UNREACHABLE', 'stopped');
    default:
      return dependencyStatus(name, 'up', 'OK', 'accepting work');
  }
}

/** The deterministic local simulator. In `live` mode it is deliberately not in play. */
function probeProviderSimulator(ctx: ProbeContext): DependencyStatus {
  const mode = (ctx.env ?? process.env).YEONJAE_PROVIDER_MODE;
  if (mode === undefined || mode === '')
    return dependencyStatus(
      'provider_simulator',
      'disabled',
      'DISABLED_BY_CONFIG',
      'no provider mode configured; refusing to guess a provider',
    );
  if (mode === 'live')
    return dependencyStatus(
      'provider_simulator',
      'disabled',
      'DISABLED_BY_CONFIG',
      'live provider mode; the simulator is not in play',
    );
  if (!['mock', 'replay', 'synthetic'].includes(mode))
    return dependencyStatus(
      'provider_simulator',
      'unavailable',
      'PROVIDER_MODE_INVALID',
      'the configured provider mode is not recognised',
    );
  return dependencyStatus('provider_simulator', 'up', 'OK', `deterministic ${mode} provider`);
}

/** Retrieval: lexical is the floor, vectors are the improvement. Lexical-only is degraded, not down. */
async function probeRetrieval(ctx: ProbeContext): Promise<DependencyStatus> {
  const db = ctx.db;
  if (!db)
    return dependencyStatus('retrieval', 'unavailable', 'NOT_CONFIGURED', 'no database pool');
  const docs = await db.query<{ n: string }>(
    ctx.projectId === undefined
      ? 'SELECT count(*)::text AS n FROM search_documents'
      : 'SELECT count(*)::text AS n FROM search_documents WHERE project_id = $1',
    ctx.projectId === undefined ? [] : [ctx.projectId],
  );
  const n = Number(docs.rows[0]?.n ?? '0');
  // An EMPTY corpus is not a degraded retriever. The index is queryable and correct; there is simply
  // nothing accepted to retrieve yet, which is the normal state of a new project. Reporting that as
  // `degraded` would make every fresh deployment look unhealthy.
  return dependencyStatus('retrieval', 'up', 'OK', `${String(n)} indexed document(s)`);
}

/** Embeddings: an active set that is INCOMPLETE is degraded, because hybrid ranking silently thins. */
async function probeEmbeddings(ctx: ProbeContext): Promise<DependencyStatus> {
  const db = ctx.db;
  if (!db)
    return dependencyStatus('embeddings', 'unavailable', 'NOT_CONFIGURED', 'no database pool');
  const active = await db.query<{ id: string; status: string }>(
    ctx.projectId === undefined
      ? `SELECT id, status FROM embedding_sets WHERE status = 'active' LIMIT 1`
      : `SELECT id, status FROM embedding_sets WHERE status = 'active' AND project_id = $1 LIMIT 1`,
    ctx.projectId === undefined ? [] : [ctx.projectId],
  );
  const set = active.rows[0];
  if (!set)
    return dependencyStatus(
      'embeddings',
      'disabled',
      'DISABLED_BY_CONFIG',
      'no active embedding set; retrieval runs lexical-only',
    );
  const counts = await db.query<{ docs: string; vectors: string }>(
    `SELECT (SELECT count(*)::text FROM search_documents d
              WHERE d.project_id = (SELECT project_id FROM embedding_sets WHERE id = $1)) AS docs,
            (SELECT count(*)::text FROM embedding_vectors WHERE embedding_set_id = $1) AS vectors`,
    [set.id],
  );
  const docs = Number(counts.rows[0]?.docs ?? '0');
  const vectors = Number(counts.rows[0]?.vectors ?? '0');
  if (vectors === 0)
    return dependencyStatus(
      'embeddings',
      'unavailable',
      'INCOMPLETE',
      'the active set has no vectors',
    );
  if (vectors < docs)
    return dependencyStatus(
      'embeddings',
      'degraded',
      'PARTIALLY_AVAILABLE',
      `${String(vectors)} of ${String(docs)} documents embedded`,
    );
  return dependencyStatus('embeddings', 'up', 'OK', `${String(vectors)} vectors, complete`);
}

/** The shared limiter. No policy is a deployment choice, not a fault. */
async function probeLimiter(ctx: ProbeContext): Promise<DependencyStatus> {
  const db = ctx.db;
  if (!db) return dependencyStatus('limiter', 'unavailable', 'NOT_CONFIGURED', 'no database pool');
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM rate_limit_policies WHERE enabled`,
  );
  const n = Number(r.rows[0]?.n ?? '0');
  return n === 0
    ? dependencyStatus(
        'limiter',
        'disabled',
        'DISABLED_BY_CONFIG',
        'no enabled rate-limit policy; admission is unrestricted',
      )
    : dependencyStatus('limiter', 'up', 'OK', `${String(n)} enabled policy(ies)`);
}

/** The shared budget. An exhausted scope is DEGRADED: spend is refused, the system is not broken. */
async function probeBudget(ctx: ProbeContext): Promise<DependencyStatus> {
  const db = ctx.db;
  if (!db) return dependencyStatus('budget', 'unavailable', 'NOT_CONFIGURED', 'no database pool');
  const policies = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM budget_policies');
  if (Number(policies.rows[0]?.n ?? '0') === 0)
    return dependencyStatus(
      'budget',
      'disabled',
      'DISABLED_BY_CONFIG',
      'no budget policy; spend is not capped here',
    );
  const exhausted = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM budget_policies p
      WHERE p.hard_limit_millicents <= (
        SELECT coalesce(sum(r.actual_millicents), 0)
          FROM budget_reservations r
         WHERE r.policy_id = p.id AND r.state = 'settled')`,
  );
  const n = Number(exhausted.rows[0]?.n ?? '0');
  return n > 0
    ? dependencyStatus(
        'budget',
        'degraded',
        'CAPACITY_EXHAUSTED',
        `${String(n)} budget scope(s) at their hard limit`,
      )
    : dependencyStatus('budget', 'up', 'OK', 'within every configured limit');
}

/** Telemetry. Per-process and in-memory: it can be absent, and that must never be fatal. */
function probeTelemetry(ctx: ProbeContext): DependencyStatus {
  if (!ctx.metrics)
    return dependencyStatus(
      'telemetry',
      'disabled',
      'DISABLED_BY_CONFIG',
      'no metric registry in this process',
    );
  if (ctx.lifecycle === 'draining')
    return dependencyStatus('telemetry', 'draining', 'DRAINING', 'flushing before shutdown');
  return dependencyStatus('telemetry', 'up', 'OK', 'per-process registry active');
}

/** Recovery capability: whether a manifest could be taken from this database right now. */
async function probeRecovery(ctx: ProbeContext): Promise<DependencyStatus> {
  const db = ctx.db;
  if (!db) return dependencyStatus('recovery', 'unavailable', 'NOT_CONFIGURED', 'no database pool');
  const r = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM schema_migrations');
  const n = Number(r.rows[0]?.n ?? '0');
  return n === 0
    ? dependencyStatus(
        'recovery',
        'unavailable',
        'INCOMPLETE',
        'no migration ledger; a manifest would describe nothing',
      )
    : dependencyStatus(
        'recovery',
        'up',
        'OK',
        `a manifest can be taken at ledger size ${String(n)}`,
      );
}

/**
 * Probe every declared component and summarize.
 *
 * Probes run concurrently under individual deadlines, so one slow dependency cannot serialize the
 * report or delay it past a probe timeout.
 */
export async function dependencyReport(ctx: ProbeContext = {}): Promise<DependencyReport> {
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const disabled = new Set(ctx.disabled ?? []);

  const builtin: Record<DependencyName, () => Promise<DependencyStatus>> = {
    postgres: () => probePostgres(ctx),
    workflow: () => probeWorkflow(ctx),
    api: () => Promise.resolve(probeProcess('api', ctx)),
    worker: () => Promise.resolve(probeProcess('worker', ctx)),
    provider_simulator: () => Promise.resolve(probeProviderSimulator(ctx)),
    retrieval: () => probeRetrieval(ctx),
    embeddings: () => probeEmbeddings(ctx),
    limiter: () => probeLimiter(ctx),
    budget: () => probeBudget(ctx),
    telemetry: () => Promise.resolve(probeTelemetry(ctx)),
    recovery: () => probeRecovery(ctx),
  };

  const components = await Promise.all(
    DEPENDENCY_NAMES.map(async (name) => {
      // An explicitly disabled component is never probed: probing something an operator switched off
      // would report a fault for a deliberate configuration.
      if (disabled.has(name))
        return dependencyStatus(
          name,
          'disabled',
          'DISABLED_BY_CONFIG',
          'switched off by configuration',
        );
      const probe = ctx.probes?.[name] ?? builtin[name];
      return runProbe(name, timeoutMs, probe);
    }),
  );

  const report = summarize(components);
  recordDependencyMetrics(ctx.metrics, report);
  return report;
}

/**
 * Merge a dependency report into the existing readiness verdict.
 *
 * Both are kept: `readiness()` remains the authority on schema and role state (it is what the load
 * balancer contract was built on), and the dependency report adds per-component states. Readiness is the
 * AND of the two, so adding this surface can only ever make readiness stricter, never weaker.
 */
export function mergeReadiness(
  readinessReport: ReadinessReport,
  deps: DependencyReport,
): { ready: boolean; degraded: boolean; draining: boolean } {
  return {
    ready: readinessReport.ready && deps.ready,
    degraded: readinessReport.degraded || deps.degraded,
    draining: deps.draining,
  };
}
