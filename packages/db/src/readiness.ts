/**
 * Readiness checks that fail for the reasons that actually matter.
 *
 * `/ready` used to run `SELECT 1`. That proves the pool can reach *a* database, which is the smallest
 * possible fraction of "this instance can safely serve traffic". Every check below exists because the
 * failure it catches would otherwise present as working:
 *
 *   - MIGRATIONS BEHIND. The code expects tables and functions a stale database does not have, so the
 *     first real request fails instead of the health check. A deployment that rolls forward the app
 *     before the migration job finishes must be caught here, not by a user.
 *   - SCHEMA AHEAD. The database has migrations this build does not know about, which is a rollback that
 *     left the schema in front of the code. Serving traffic then risks writing rows the newer schema's
 *     invariants are meant to constrain.
 *   - LEDGER TAMPERED. An applied migration's recorded hash no longer matches the file, so this
 *     database's schema is not the one this build was tested against.
 *   - ROLE ASSUMPTIONS VIOLATED. If the application role is missing, or is a superuser, or can bypass
 *     RLS, then every tenant-isolation guarantee in ADR-0050 is void while the app looks perfectly
 *     healthy. This is the check that would have caught a misconfigured cluster.
 *
 * LIVENESS vs READINESS is kept distinct on purpose: liveness must NOT fail because an optional external
 * dependency is down, or a transient provider outage would cause an orchestrator to kill healthy
 * processes and turn a degraded system into an outage.
 */
import { METRIC, METRIC_HELP, type Metrics, safeLabelValue } from '@yeonjae/domain';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Client, type Pool } from './client.js';
import { migrationsDir } from './migrate.js';

type Queryable = Pool | Client;

export type CheckStatus = 'pass' | 'degraded' | 'fail';

export interface ReadinessCheck {
  readonly name: string;
  readonly status: CheckStatus;
  /**
   * A short, safe explanation.
   *
   * Never a raw driver error, a connection string or a credential: readiness answers a load balancer,
   * and an error channel that echoes internals is an information-disclosure surface.
   */
  readonly detail: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  /** True when everything required passes but something optional is degraded. */
  readonly degraded: boolean;
  readonly checks: readonly ReadinessCheck[];
}

/** The migrations this build ships, with their content hashes. */
export function expectedMigrations(dir: string = migrationsDir()): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    out.set(
      file,
      createHash('sha256')
        .update(readFileSync(join(dir, file), 'utf8'))
        .digest('hex'),
    );
  }
  return out;
}

export interface MigrationReadiness {
  readonly status: CheckStatus;
  readonly detail: string;
  readonly applied: number;
  readonly expected: number;
  readonly latestApplied: string | undefined;
  readonly missing: readonly string[];
  /** Applied migrations this build does not know about: the schema is AHEAD of the code. */
  readonly unknown: readonly string[];
  readonly hashMismatches: readonly string[];
}

/** Compare the database's migration ledger with the migrations this build ships. */
export async function checkMigrations(
  db: Queryable,
  dir: string = migrationsDir(),
): Promise<MigrationReadiness> {
  const expected = expectedMigrations(dir);
  let rows: { name: string; hash: string }[];
  try {
    const r = await db.query<{ name: string; hash: string }>(
      'SELECT name, hash FROM schema_migrations ORDER BY name',
    );
    rows = r.rows;
  } catch {
    // No ledger at all: an empty or foreign database. Not ready, and not a diagnostic dump.
    return {
      status: 'fail',
      detail: 'the migration ledger is unreadable; the database may be empty or not ours',
      applied: 0,
      expected: expected.size,
      latestApplied: undefined,
      missing: [...expected.keys()],
      unknown: [],
      hashMismatches: [],
    };
  }

  const appliedByName = new Map(rows.map((r) => [r.name, r.hash] as const));
  const missing = [...expected.keys()].filter((n) => !appliedByName.has(n));
  const unknown = [...appliedByName.keys()].filter((n) => !expected.has(n));
  const hashMismatches = [...expected.entries()]
    .filter(([n, h]) => appliedByName.has(n) && appliedByName.get(n) !== h)
    .map(([n]) => n);

  const status: CheckStatus =
    missing.length > 0 || unknown.length > 0 || hashMismatches.length > 0 ? 'fail' : 'pass';
  const detail =
    missing.length > 0
      ? `${String(missing.length)} migration(s) not applied; run the migration job before serving`
      : unknown.length > 0
        ? `${String(unknown.length)} applied migration(s) unknown to this build; the schema is ahead of the code`
        : hashMismatches.length > 0
          ? `${String(hashMismatches.length)} applied migration(s) no longer match their recorded hash`
          : `schema matches this build (${String(expected.size)} migrations)`;

  return {
    status,
    detail,
    applied: rows.length,
    expected: expected.size,
    latestApplied: rows.at(-1)?.name,
    missing,
    unknown,
    hashMismatches,
  };
}

export const APP_ROLE_NAME = 'yeonjae_app';

/**
 * Verify the database role assumptions every isolation guarantee depends on.
 *
 * A superuser or BYPASSRLS application role voids RLS silently: the app keeps working, and tenant
 * isolation stops existing. Refusing to become ready is the only way that failure is visible.
 */
export async function checkAppRole(db: Queryable): Promise<ReadinessCheck> {
  const r = await db.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = $1`,
    [APP_ROLE_NAME],
  );
  const row = r.rows[0];
  if (row === undefined) {
    return {
      name: 'app_role',
      status: 'fail',
      detail: `the request-scoped role ${APP_ROLE_NAME} does not exist`,
    };
  }
  const violations = [
    row.rolsuper ? 'superuser' : undefined,
    row.rolbypassrls ? 'bypassrls' : undefined,
    row.rolcreatedb ? 'createdb' : undefined,
    row.rolcreaterole ? 'createrole' : undefined,
  ].filter((v): v is string => v !== undefined);
  return violations.length === 0
    ? { name: 'app_role', status: 'pass', detail: `${APP_ROLE_NAME} is unprivileged` }
    : {
        name: 'app_role',
        status: 'fail',
        // Naming the attribute is safe and actionable; it is a role property, not a secret.
        detail: `${APP_ROLE_NAME} holds ${violations.join(', ')}, which voids row-level security`,
      };
}

/** Provider modes the runtime accepts. A missing or unknown mode must not default to a paid provider. */
export const PROVIDER_MODES = ['mock', 'replay', 'synthetic', 'live'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

/**
 * Validate the configured provider mode.
 *
 * The worker already refuses to start without `YEONJAE_PROVIDER_MODE`, and this is the same rule stated
 * as a readiness check: an instance whose provider mode is absent or unrecognised must not take traffic,
 * because the only safe default (refuse) is indistinguishable from a broken deployment at request time.
 */
export function checkProviderMode(env: NodeJS.ProcessEnv = process.env): ReadinessCheck {
  const mode = env.YEONJAE_PROVIDER_MODE;
  if (mode === undefined || mode === '') {
    return {
      name: 'provider_mode',
      status: 'fail',
      detail: 'YEONJAE_PROVIDER_MODE is not set; refusing to guess a provider',
    };
  }
  if (!PROVIDER_MODES.includes(mode as ProviderMode)) {
    return {
      name: 'provider_mode',
      status: 'fail',
      detail: `YEONJAE_PROVIDER_MODE is not one of ${PROVIDER_MODES.join(', ')}`,
    };
  }
  return { name: 'provider_mode', status: 'pass', detail: `provider mode ${mode}` };
}

export interface ReadinessOptions {
  readonly migrationsDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Optional dependencies whose absence DEGRADES rather than fails readiness — a Temporal namespace or
   * an artifact store this instance does not strictly need to answer reads.
   */
  readonly optional?:
    readonly { readonly name: string; readonly probe: () => Promise<boolean> }[] | undefined;
  /** Whether provider mode is required for this process. The API can read without one; a worker cannot. */
  readonly requireProviderMode?: boolean | undefined;
  /** Where to record readiness failures, by BOUNDED check name. */
  readonly metrics?: Metrics | undefined;
}

/**
 * Record failures by check NAME, never by detail.
 *
 * The detail string is operator-facing prose that can name a migration file or a role attribute; as a
 * metric label it would be unbounded cardinality. The check name is a closed set, so it is the label.
 * `migration` and `app_role` failures additionally raise their own counters, because those two states
 * mean "do not serve traffic" rather than "something is slow".
 */
function recordReadiness(metrics: Metrics | undefined, checks: readonly ReadinessCheck[]): void {
  if (!metrics) return;
  for (const check of checks) {
    if (check.status !== 'fail') continue;
    metrics.increment(METRIC.readinessFailures, METRIC_HELP[METRIC.readinessFailures] ?? '', {
      check: safeLabelValue(check.name),
    });
    if (check.name === 'migrations') {
      metrics.increment(METRIC.migrationMismatch, METRIC_HELP[METRIC.migrationMismatch] ?? '', {
        reason: 'schema_state',
      });
    }
    if (check.name === 'app_role') {
      metrics.increment(
        METRIC.roleAssumptionFailures,
        METRIC_HELP[METRIC.roleAssumptionFailures] ?? '',
        { reason: 'unsafe_role' },
      );
    }
  }
}

/** Run every readiness check and summarise. Safe to expose: no credentials, no connection strings. */
export async function readiness(
  db: Queryable,
  opts: ReadinessOptions = {},
): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];

  try {
    await db.query('SELECT 1');
    checks.push({ name: 'database', status: 'pass', detail: 'reachable' });
  } catch {
    // A failed connection short-circuits: every later check would fail for the same reason, and the
    // detail must not echo the driver error.
    const failed: ReadinessCheck[] = [
      { name: 'database', status: 'fail', detail: 'the database is not reachable' },
    ];
    recordReadiness(opts.metrics, failed);
    return { ready: false, degraded: false, checks: failed };
  }

  const migrations = await checkMigrations(db, opts.migrationsDir);
  checks.push({ name: 'migrations', status: migrations.status, detail: migrations.detail });
  checks.push(await checkAppRole(db));

  if (opts.requireProviderMode === true) {
    checks.push(checkProviderMode(opts.env));
  }

  for (const dep of opts.optional ?? []) {
    try {
      const ok = await dep.probe();
      checks.push({
        name: dep.name,
        status: ok ? 'pass' : 'degraded',
        detail: ok ? 'reachable' : 'unavailable; serving in degraded mode',
      });
    } catch {
      checks.push({ name: dep.name, status: 'degraded', detail: 'probe failed; degraded' });
    }
  }

  recordReadiness(opts.metrics, checks);
  return {
    ready: !checks.some((c) => c.status === 'fail'),
    degraded: checks.some((c) => c.status === 'degraded'),
    checks,
  };
}
