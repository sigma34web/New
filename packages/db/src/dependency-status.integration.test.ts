/**
 * Per-dependency status reporting, against real PostgreSQL 16.
 *
 * The states are easy to produce and easy to get subtly wrong, so each one is driven to explicitly:
 * normal, degraded, unavailable, intentionally disabled, starting, draining, recovery, and several at
 * once. The two rules that carry the feature — a required component failing readiness, an optional one
 * never doing so — are asserted separately from the probes that produce them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Metrics } from '@yeonjae/domain';
import {
  DEPENDENCIES,
  DEPENDENCY_CODES,
  DEPENDENCY_NAMES,
  DEPENDENCY_STATES,
  dependencyReport,
  dependencyStatus,
  MAX_DETAIL_LENGTH,
  mergeReadiness,
  readiness,
  safeDetail,
  summarize,
  type DependencyName,
  type DependencyStatus,
  type Pool,
} from './index.js';
import { databaseUrl, freshDatabase } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

const stateOf = (components: readonly DependencyStatus[], name: DependencyName): string =>
  components.find((c) => c.name === name)?.state ?? 'absent';
const codeOf = (components: readonly DependencyStatus[], name: DependencyName): string =>
  components.find((c) => c.name === name)?.code ?? 'absent';

describe('dependency status: pure reporting rules', () => {
  it('declares every component exactly once, with a stable name and a purpose', () => {
    expect(DEPENDENCIES.map((d) => d.name).sort()).toEqual([...DEPENDENCY_NAMES].sort());
    for (const dep of DEPENDENCIES) expect(dep.purpose.length).toBeGreaterThan(10);
  });

  it('a REQUIRED component that is not serving fails readiness', () => {
    for (const state of ['unavailable', 'starting', 'draining'] as const) {
      const report = summarize([dependencyStatus('postgres', state, 'UNREACHABLE', 'down')]);
      expect(report.ready, `required postgres in ${state} must fail readiness`).toBe(false);
    }
  });

  it('an OPTIONAL component that is degraded or unavailable never fails readiness', () => {
    for (const state of ['degraded', 'unavailable'] as const) {
      const report = summarize([
        dependencyStatus('postgres', 'up', 'OK', 'fine'),
        dependencyStatus('retrieval', state, 'PARTIALLY_AVAILABLE', 'thin'),
      ]);
      expect(report.ready).toBe(true);
      expect(report.degraded).toBe(true);
    }
  });

  it('an intentionally DISABLED component is neither an error nor a degradation', () => {
    // The distinction that makes the field usable: switching something off must not look like a fault.
    const report = summarize([
      dependencyStatus('postgres', 'up', 'OK', 'fine'),
      dependencyStatus('workflow', 'disabled', 'DISABLED_BY_CONFIG', 'off'),
    ]);
    expect(report.ready).toBe(true);
    expect(report.degraded).toBe(false);
  });

  it('a disabled component is never reported as required', () => {
    // Otherwise a worker, for which `api` is not observable, would fail its own readiness.
    expect(
      dependencyStatus('api', 'disabled', 'DISABLED_BY_CONFIG', 'not this process').required,
    ).toBe(false);
    expect(dependencyStatus('api', 'up', 'OK', 'serving').required).toBe(true);
  });

  it('draining is reported separately from readiness, because a draining process is still LIVE', () => {
    const report = summarize([
      dependencyStatus('postgres', 'up', 'OK', 'fine'),
      dependencyStatus('api', 'draining', 'DRAINING', 'refusing new work'),
    ]);
    expect(report.draining).toBe(true);
    expect(report.ready).toBe(false);
  });

  it('simultaneous failures are all reported, not just the first', () => {
    const report = summarize([
      dependencyStatus('postgres', 'unavailable', 'UNREACHABLE', 'down'),
      dependencyStatus('limiter', 'degraded', 'CAPACITY_EXHAUSTED', 'full'),
      dependencyStatus('budget', 'degraded', 'CAPACITY_EXHAUSTED', 'full'),
      dependencyStatus('telemetry', 'disabled', 'DISABLED_BY_CONFIG', 'off'),
    ]);
    expect(report.ready).toBe(false);
    expect(report.totals.unavailable).toBe(1);
    expect(report.totals.degraded).toBe(2);
    expect(report.totals.disabled).toBe(1);
  });

  it('components are returned in a stable order', () => {
    const names = summarize([
      dependencyStatus('worker', 'up', 'OK', 'x'),
      dependencyStatus('api', 'up', 'OK', 'x'),
    ]).components.map((c) => c.name);
    expect(names).toEqual(['api', 'worker']);
  });

  // --- the redaction boundary --------------------------------------------------------------------

  it('strips connection strings, quotes, newlines and angle brackets from an explanation', () => {
    const detail = safeDetail(
      'failed: postgres://user:hunter2@db.internal:5432/app\n at <anonymous> "SELECT * FROM users"',
    );
    expect(detail).not.toContain('hunter2');
    expect(detail).not.toContain('postgres://');
    expect(detail).not.toContain('db.internal');
    expect(detail).not.toContain('"');
    expect(detail).not.toContain('<');
    expect(detail).not.toContain('\n');
  });

  it('bounds every explanation', () => {
    expect(safeDetail('x'.repeat(10_000)).length).toBeLessThanOrEqual(MAX_DETAIL_LENGTH);
    expect(
      dependencyStatus('postgres', 'up', 'OK', 'y'.repeat(9_000)).detail.length,
    ).toBeLessThanOrEqual(MAX_DETAIL_LENGTH);
  });

  it('a probe that throws becomes a closed-set status, never an exception message', async () => {
    const report = await dependencyReport({
      probes: {
        postgres: () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
        },
      },
    });
    const postgres = report.components.find((c) => c.name === 'postgres');
    expect(postgres?.state).toBe('unavailable');
    expect(postgres?.code).toBe('PROBE_FAILED');
    expect(JSON.stringify(report)).not.toContain('hunter2');
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
  });

  it('a probe that never settles is bounded by its own deadline', async () => {
    const report = await dependencyReport({
      timeoutMs: 20,
      probes: { postgres: () => new Promise<never>(() => undefined) },
    });
    expect(report.components.find((c) => c.name === 'postgres')?.code).toBe('PROBE_TIMEOUT');
  });

  it('every produced code and state belongs to its declared closed set', async () => {
    const report = await dependencyReport({ env: {} });
    for (const component of report.components) {
      expect(DEPENDENCY_STATES).toContain(component.state);
      expect(DEPENDENCY_CODES).toContain(component.code);
    }
  });

  it('the report is bounded to the declared component list', async () => {
    const report = await dependencyReport({ env: {} });
    expect(report.components).toHaveLength(DEPENDENCY_NAMES.length);
  });
});

run('dependency status: probes against real PostgreSQL 16', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = await freshDatabase();
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('reports a healthy, fully migrated database as up', async () => {
    const report = await dependencyReport({
      db: pool,
      self: 'api',
      env: { YEONJAE_PROVIDER_MODE: 'replay' },
    });
    expect(stateOf(report.components, 'postgres')).toBe('up');
    expect(stateOf(report.components, 'api')).toBe('up');
    expect(stateOf(report.components, 'recovery')).toBe('up');
    expect(report.ready).toBe(true);
  });

  it('reports the provider simulator as up in a simulated mode and DISABLED in live mode', async () => {
    const simulated = await dependencyReport({
      db: pool,
      env: { YEONJAE_PROVIDER_MODE: 'replay' },
    });
    expect(stateOf(simulated.components, 'provider_simulator')).toBe('up');

    const live = await dependencyReport({ db: pool, env: { YEONJAE_PROVIDER_MODE: 'live' } });
    expect(stateOf(live.components, 'provider_simulator')).toBe('disabled');
    // Live mode is a configuration, not a fault, so it must not degrade the whole report.
    expect(live.ready).toBe(true);
  });

  it('reports an unrecognised provider mode as unavailable rather than guessing', async () => {
    const report = await dependencyReport({ db: pool, env: { YEONJAE_PROVIDER_MODE: 'chatgpt' } });
    expect(codeOf(report.components, 'provider_simulator')).toBe('PROVIDER_MODE_INVALID');
  });

  it('reports the workflow backend as intentionally disabled when none is configured', async () => {
    const report = await dependencyReport({ db: pool, env: {} });
    expect(stateOf(report.components, 'workflow')).toBe('disabled');
    expect(codeOf(report.components, 'workflow')).toBe('DISABLED_BY_CONFIG');
  });

  it('reports the workflow backend as up when one is configured and step state is readable', async () => {
    const report = await dependencyReport({
      db: pool,
      env: { TEMPORAL_ADDRESS: '127.0.0.1:7233' },
    });
    expect(stateOf(report.components, 'workflow')).toBe('up');
  });

  it('reports the limiter and budget as disabled when no policy exists', async () => {
    const report = await dependencyReport({ db: pool, env: {} });
    expect(stateOf(report.components, 'limiter')).toBe('disabled');
    expect(stateOf(report.components, 'budget')).toBe('disabled');
    // No policy is a deployment choice; it must not make a fresh deployment look degraded.
    expect(report.degraded).toBe(false);
  });

  it('reports telemetry as up with a registry and draining while shutting down', async () => {
    const up = await dependencyReport({ db: pool, metrics: new Metrics(), env: {} });
    expect(stateOf(up.components, 'telemetry')).toBe('up');

    const draining = await dependencyReport({
      db: pool,
      metrics: new Metrics(),
      lifecycle: 'draining',
      env: {},
    });
    expect(stateOf(draining.components, 'telemetry')).toBe('draining');
  });

  it('reports the STARTING and DRAINING states of this process', async () => {
    const starting = await dependencyReport({ db: pool, self: 'worker', lifecycle: 'starting' });
    expect(stateOf(starting.components, 'worker')).toBe('starting');
    // A starting REQUIRED process is not ready; a starting worker is optional, so the report holds.
    expect(codeOf(starting.components, 'worker')).toBe('STARTING');

    const draining = await dependencyReport({ db: pool, self: 'api', lifecycle: 'draining' });
    expect(stateOf(draining.components, 'api')).toBe('draining');
    expect(draining.draining).toBe(true);
    expect(draining.ready).toBe(false);
  });

  it('honours an explicitly disabled component without probing it', async () => {
    const report = await dependencyReport({ db: pool, disabled: ['retrieval', 'embeddings'] });
    expect(stateOf(report.components, 'retrieval')).toBe('disabled');
    expect(stateOf(report.components, 'embeddings')).toBe('disabled');
    expect(report.ready).toBe(true);
  });

  it('reports an unreachable database as an unavailable REQUIRED component', async () => {
    const report = await dependencyReport({
      probes: {
        postgres: () =>
          Promise.resolve(
            dependencyStatus(
              'postgres',
              'unavailable',
              'UNREACHABLE',
              'the database is not reachable',
            ),
          ),
      },
    });
    expect(report.ready).toBe(false);
    expect(codeOf(report.components, 'postgres')).toBe('UNREACHABLE');
  });

  it('records bounded metrics by component name and state only', async () => {
    const metrics = new Metrics();
    await dependencyReport({ db: pool, metrics, env: {} });
    const rendered = metrics.render();
    expect(rendered).toContain('yeonjae_dependency_status_total');
    // No identifier, no detail string: a metric label is a time series on an unauthenticated endpoint.
    expect(rendered).not.toContain('postgres://');
    expect(rendered).not.toContain(pool.options.connectionString ?? '@@@never@@@');
  });

  it('merging with readiness can only make the verdict STRICTER', async () => {
    const base = await readiness(pool);
    const healthy = await dependencyReport({ db: pool, self: 'api' });
    expect(mergeReadiness(base, healthy).ready).toBe(base.ready);

    const broken = await dependencyReport({
      probes: {
        postgres: () =>
          Promise.resolve(dependencyStatus('postgres', 'unavailable', 'UNREACHABLE', 'down')),
      },
    });
    expect(mergeReadiness(base, broken).ready).toBe(false);
  });

  it('a recovered dependency restores readiness', async () => {
    // Down, then up, through the same code path: a report that could not recover would be useless.
    const down = await dependencyReport({
      probes: {
        postgres: () =>
          Promise.resolve(dependencyStatus('postgres', 'unavailable', 'UNREACHABLE', 'down')),
      },
    });
    expect(down.ready).toBe(false);
    const recovered = await dependencyReport({ db: pool, self: 'api' });
    expect(recovered.ready).toBe(true);
  });

  it('exposes no credential, connection string or SQL anywhere in the report', async () => {
    const text = JSON.stringify(await dependencyReport({ db: pool, self: 'api', env: {} }));
    for (const forbidden of [
      'postgres://',
      'password',
      'SELECT ',
      'yeonjae:yeonjae',
      'at Object.',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
