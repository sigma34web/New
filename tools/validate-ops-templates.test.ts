/**
 * Static validation of the deployment, alert and dashboard templates.
 *
 * WHY THIS IS A TEST RATHER THAN A DOCUMENT. No container runtime and no monitoring system exist here,
 * so these templates cannot be executed. That leaves exactly two options: write them and hope, or make
 * the checkable parts checkable. This suite does the latter — it parses the YAML and JSON, walks the
 * service dependency graph, and validates every metric reference and every label against the registry
 * in `apps/api/src/observability.ts`. A rule naming a metric that does not exist, or a label the
 * allowlist would silently drop, fails here instead of producing a dashboard of empty panels later.
 *
 * WHAT IT DOES NOT PROVE. That any image builds, that any container runs, or that any alert ever fires.
 * Those require a runtime and a monitoring system, and are recorded as external work.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMetricLabel, METRIC, METRIC_HELP } from '../apps/api/src/observability.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8');

const KNOWN_METRICS = new Set<string>(Object.values(METRIC));

interface AlertRule {
  name: string;
  severity: string;
  metric: string;
  labels?: string[];
  expr: string;
  for: string;
  runbook: string;
  summary: string;
}
interface AlertFile {
  rules: AlertRule[];
  inhibition: { when: string; suppress: string[] }[];
}
interface Panel {
  title: string;
  metric: string;
  labels?: string[];
}
interface DashboardFile {
  dashboards: { name: string; panels: Panel[] }[];
  slos: { name: string; objective: string; window: string; metric: string; status: string }[];
}

const alerts = JSON.parse(read('ops/alerts.json')) as AlertFile;
const dashboards = JSON.parse(read('ops/dashboards.json')) as DashboardFile;
const compose = read('deploy/compose.yaml');
const dockerfile = read('deploy/Dockerfile');
const dockerignore = read('deploy/.dockerignore');

/**
 * A deliberately small YAML reader for the shapes this compose file uses.
 *
 * The repository has no YAML dependency and adding one to validate one file would be a poor trade. The
 * checks below are structural (keys, nesting, lists), which indentation-aware line parsing covers; a
 * malformed file shows up as a missing key rather than passing silently.
 */
function composeServices(text: string): Map<string, string> {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'services:');
  expect(start, 'compose.yaml has no services block').toBeGreaterThan(-1);
  const services = new Map<string, string>();
  let current: string | undefined;
  let buffer: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^[a-z]/.test(line)) break; // next top-level key
    const match = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      if (current !== undefined) services.set(current, buffer.join('\n'));
      current = match[1];
      buffer = [];
      continue;
    }
    if (current !== undefined) buffer.push(line);
  }
  if (current !== undefined) services.set(current, buffer.join('\n'));
  return services;
}

const services = composeServices(compose);

describe('deployment templates (static validation only; never built or run)', () => {
  it('declares every service the local topology needs', () => {
    for (const name of ['postgres', 'temporal', 'migrate', 'synthetic-provider', 'api', 'worker']) {
      expect([...services.keys()], `compose is missing ${name}`).toContain(name);
    }
  });

  it('every dependency names a service that exists, with an explicit condition', () => {
    for (const [name, body] of services) {
      const depends = /depends_on:\n((?: {6}.*\n?)+)/.exec(body);
      if (!depends?.[1]) continue;
      const block = depends[1];
      const referenced = [...block.matchAll(/^ {6}([a-z][a-z0-9-]*):/gm)].map((m) => m[1]);
      for (const dep of referenced) {
        expect([...services.keys()], `${name} depends on unknown service ${String(dep)}`).toContain(
          dep,
        );
      }
      // A bare `depends_on` only orders STARTUP, which is not the same as readiness: the API must wait
      // for migrations to COMPLETE, not merely to have been launched.
      expect(block, `${name} depends_on lacks a condition`).toMatch(/condition:/);
    }
  });

  it('runs migrations as a one-shot job, so replicas cannot race the ledger', () => {
    const migrate = services.get('migrate') ?? '';
    expect(migrate).toMatch(/restart: 'no'/);
    const api = services.get('api') ?? '';
    expect(api).toMatch(/service_completed_successfully/);
    const worker = services.get('worker') ?? '';
    expect(worker).toMatch(/service_completed_successfully/);
  });

  it('publishes only the API to the host', () => {
    for (const [name, body] of services) {
      if (name === 'api') {
        expect(body).toMatch(/ports:/);
        continue;
      }
      // A development stack that publishes its database or its provider simulator is one firewall
      // mistake away from being reachable.
      expect(body, `${name} must not publish a host port`).not.toMatch(/^\s+ports:/m);
    }
  });

  it('gives no credential-shaped value a usable default', () => {
    // `$${VAR}` is an ESCAPED reference: compose passes it through for the container's own shell to
    // expand (the pg_isready healthcheck), so it is not a compose-level default and the negative
    // lookbehind keeps it out of this check.
    const required = [...compose.matchAll(/(?<!\$)\$\{([A-Z_]+)(:[?-][^}]*)?\}/g)];
    expect(required.length).toBeGreaterThan(0);
    for (const [, name, suffix] of required) {
      if (name === undefined) continue;
      if (!/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|USER/.test(name)) continue;
      // `:?` fails the run when unset; `:-` would silently supply a default, which is how a
      // development password becomes a production password.
      expect(suffix ?? '', `${name} must not have a default value`).toMatch(/^:\?/);
    }
  });

  it('never lets the worker default to a provider mode', () => {
    const worker = services.get('worker') ?? '';
    expect(worker).toMatch(/YEONJAE_PROVIDER_MODE: \$\{YEONJAE_PROVIDER_MODE:\?/);
    // And shared enforcement is pinned, not defaulted: a topology that quietly ran per-process
    // protection would undo the whole point of the shared limiter.
    expect(worker).toMatch(/YEONJAE_ENFORCEMENT_MODE: shared/);
  });

  it('runs more than one worker, since shared enforcement only matters then', () => {
    expect(services.get('worker') ?? '').toMatch(/replicas: 2/);
  });

  it('gives every long-running service a health check or a documented reason', () => {
    for (const name of ['postgres', 'temporal', 'api']) {
      expect(services.get(name) ?? '', `${name} has no healthcheck`).toMatch(/healthcheck:/);
    }
  });

  it('checks health against routes the server actually serves', () => {
    const paths = [...compose.matchAll(/127\.0\.0\.1:8080(\/[a-z]*)/g)].map((m) => m[1]);
    paths.push(...[...dockerfile.matchAll(/127\.0\.0\.1:8080(\/[a-z]*)/g)].map((m) => m[1]));
    expect(paths.length).toBeGreaterThan(0);
    const served = readFileSync(`${root}apps/api/src/server.ts`, 'utf8');
    for (const path of paths) {
      // The defect this caught while being written: a `/readyz` healthcheck against a server that
      // serves `/ready`, which would have reported every container unhealthy.
      expect(served, `no route serves ${String(path)}`).toContain(`app.get('${String(path)}'`);
    }
  });

  it('bounds shutdown so a deploy cannot hang on a draining process', () => {
    for (const name of ['api', 'worker']) {
      expect(services.get(name) ?? '', `${name} has no stop_grace_period`).toMatch(
        /stop_grace_period: \d+s/,
      );
    }
  });

  it('persists the database, so a restart does not discard canon', () => {
    expect(services.get('postgres') ?? '').toMatch(/postgres-data:\/var\/lib\/postgresql\/data/);
    expect(compose).toMatch(/^volumes:\n {2}postgres-data:/m);
  });

  it('embeds no secret in any template', () => {
    const suspicious =
      /(sk-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|password\s*[:=]\s*['"][^'"$]{3,})/i;
    for (const [label, text] of [
      ['compose.yaml', compose],
      ['Dockerfile', dockerfile],
      ['alerts.json', read('ops/alerts.json')],
      ['dashboards.json', read('ops/dashboards.json')],
    ] as const) {
      expect(suspicious.test(text), `${label} appears to embed a secret`).toBe(false);
    }
  });

  it('keeps .env out of the build context', () => {
    // The ORDER does not matter to Docker; what matters is that `.env` is ignored and the example is
    // re-included. Asserting a line index made this test brittle against a comment edit.
    expect(dockerignore.split('\n').map((l) => l.trim())).toContain('.env');
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^!\.env\.example$/m);
  });
});

describe('Dockerfile (static validation only; never built)', () => {
  it('is multi-stage, with every FROM naming a stage that exists', () => {
    const stages = [...dockerfile.matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gm)];
    const defined = new Set<string>();
    for (const [, image, alias] of stages) {
      if (image !== undefined && /^[a-z][a-z0-9-]*$/.test(image)) {
        expect(defined, `FROM ${image} precedes its stage`).toContain(image);
      }
      if (alias !== undefined) defined.add(alias);
    }
    expect(defined.size).toBeGreaterThanOrEqual(3);
    for (const stage of ['deps', 'build', 'runtime']) expect(defined).toContain(stage);
  });

  it('copies build output from a build stage rather than rebuilding in the runtime image', () => {
    expect(dockerfile).toMatch(/COPY --from=build/);
  });

  it('installs from the frozen lockfile', () => {
    expect(dockerfile).toMatch(/pnpm install --frozen-lockfile/);
    // The lockfile must be copied before the install, or the install resolves whatever is newest.
    const copyIdx = dockerfile.indexOf('pnpm-lock.yaml');
    const installIdx = dockerfile.indexOf('pnpm install --frozen-lockfile');
    expect(copyIdx).toBeGreaterThan(-1);
    expect(copyIdx).toBeLessThan(installIdx);
  });

  it('runs as a non-root user, declared after the files it owns are copied', () => {
    const userIdx = dockerfile.lastIndexOf('USER ');
    expect(userIdx).toBeGreaterThan(-1);
    expect(dockerfile.slice(userIdx)).not.toMatch(/USER root/);
    expect(dockerfile).toMatch(/--chown=yeonjae:yeonjae/);
    expect(dockerfile.indexOf('--chown=yeonjae')).toBeLessThan(userIdx);
  });

  it('exposes only the API port', () => {
    const exposed = [...dockerfile.matchAll(/^EXPOSE\s+(\d+)/gm)].map((m) => Number(m[1]));
    expect(exposed).toEqual([8080]);
  });

  it('references workspace packages that exist', () => {
    const copied = [
      ...dockerfile.matchAll(/^COPY\s+((?:apps|packages)\/[a-z-]+)\/package\.json/gm),
    ];
    expect(copied.length).toBeGreaterThan(5);
    for (const [, dir] of copied) {
      expect(() => readFileSync(`${root}${String(dir)}/package.json`, 'utf8')).not.toThrow();
    }
  });

  it('names commands that exist in the workspace', () => {
    const filters = [...compose.matchAll(/'--filter',\s*'(@yeonjae\/[a-z]+)'/g)].map((m) => m[1]);
    filters.push(
      ...[...dockerfile.matchAll(/"--filter",\s*"(@yeonjae\/[a-z]+)"/g)].map((m) => m[1]),
    );
    const names = new Set<string>();
    for (const dir of ['apps/api', 'apps/worker', 'apps/cli', 'apps/web', 'packages/db']) {
      names.add(
        (JSON.parse(readFileSync(`${root}${dir}/package.json`, 'utf8')) as { name: string }).name,
      );
    }
    for (const filter of filters) {
      if (filter === undefined) continue;
      expect(names, `compose/Dockerfile filters unknown package ${filter}`).toContain(filter);
    }
  });

  it('references root scripts that exist', () => {
    const root_pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
      scripts: Record<string, string>;
    };
    const runs = [...compose.matchAll(/'pnpm',\s*'run',\s*'([a-z:-]+)'/g)].map((m) => m[1]);
    expect(runs.length).toBeGreaterThan(0);
    for (const script of runs) {
      if (script === undefined) continue;
      expect(Object.keys(root_pkg.scripts), `no root script ${script}`).toContain(script);
    }
  });
});

describe('alert templates (validated against the metric registry; not deployed)', () => {
  it('has unique rule names', () => {
    const names = alerts.rules.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every rule names a metric that exists and is documented', () => {
    for (const rule of alerts.rules) {
      expect(KNOWN_METRICS, `${rule.name} references unknown metric ${rule.metric}`).toContain(
        rule.metric,
      );
      expect(METRIC_HELP[rule.metric], `${rule.metric} has no help text`).toBeDefined();
    }
  });

  it('every rule label survives the metric label allowlist', () => {
    for (const rule of alerts.rules) {
      for (const label of rule.labels ?? []) {
        // A label the registry drops would make the rule match everything or nothing, silently.
        expect(isMetricLabel(label), `${rule.name} uses non-allowlisted label ${label}`).toBe(true);
      }
    }
  });

  it('every rule carries a severity, a duration and a runbook that exists', () => {
    for (const rule of alerts.rules) {
      expect(['critical', 'warning', 'info']).toContain(rule.severity);
      expect(rule.for).toMatch(/^\d+[mhd]$/);
      const [path, anchor] = rule.runbook.split('#');
      expect(path, `${rule.name} has no runbook path`).toBeDefined();
      const doc = readFileSync(`${root}${String(path)}`, 'utf8');
      // The anchor must exist too: a runbook link that lands on the wrong section is a link an
      // operator follows at 3am and learns nothing from.
      const heading = String(anchor).replace(/-/g, '[ -]');
      expect(
        new RegExp(`^#{2,4} .*${heading}`, 'im').test(doc),
        `${rule.name} runbook anchor #${String(anchor)} not found in ${String(path)}`,
      ).toBe(true);
    }
  });

  it('covers every operational area the tranche instrumented', () => {
    const covered = alerts.rules.map((r) => r.name).join(' ');
    for (const area of [
      'Availability',
      'Readiness',
      'Migration',
      'UnsafeDatabaseRole',
      'Queue',
      'ProviderFailure',
      'Retries',
      'Fallback',
      'RateAdmissionRejections',
      'RateAdmissionWait',
      'Concurrency',
      'Budget',
      'UnknownBilling',
      'Cancellation',
      'LateResponses',
      'StaleWorker',
      'LeaseLoss',
      'DatabasePool',
      'Embedding',
      'Retrieval',
      'RestoreDrill',
      'OutputLanguage',
      'Evaluator',
    ]) {
      expect(covered, `no alert covers ${area}`).toContain(area);
    }
  });

  it('inhibition references only rules that exist', () => {
    const names = new Set(alerts.rules.map((r) => r.name));
    for (const entry of alerts.inhibition) {
      expect(names).toContain(entry.when);
      for (const suppressed of entry.suppress) expect(names).toContain(suppressed);
      // A rule that suppressed itself would silence the incident it is reporting.
      expect(entry.suppress).not.toContain(entry.when);
    }
  });
});

describe('dashboard and SLO templates (validated; not deployed)', () => {
  it('every panel names a real metric with allowlisted labels', () => {
    for (const dashboard of dashboards.dashboards) {
      for (const panel of dashboard.panels) {
        expect(KNOWN_METRICS, `${panel.title} references unknown ${panel.metric}`).toContain(
          panel.metric,
        );
        for (const label of panel.labels ?? []) {
          expect(isMetricLabel(label), `${panel.title} uses dropped label ${label}`).toBe(true);
        }
      }
    }
  });

  it('no panel or rule groups by a tenant identifier', () => {
    const everyLabel = [
      ...alerts.rules.flatMap((r) => r.labels ?? []),
      ...dashboards.dashboards.flatMap((d) => d.panels.flatMap((p) => p.labels ?? [])),
    ];
    for (const label of everyLabel) {
      // /metrics is unauthenticated by design, so a per-tenant panel would mean publishing tenant ids.
      expect(label).not.toMatch(/workspace|project|job|request|user|_id$/);
    }
  });

  it('dashboard names are unique and panels are non-empty', () => {
    const names = dashboards.dashboards.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const dashboard of dashboards.dashboards) {
      expect(dashboard.panels.length, `${dashboard.name} has no panels`).toBeGreaterThan(0);
    }
  });

  it('every SLO is labelled with an honest calibration status', () => {
    for (const slo of dashboards.slos) {
      expect(KNOWN_METRICS).toContain(slo.metric);
      // No SLO may claim to be met: nothing here has been observed in a deployment.
      expect(['uncalibrated', 'enforced_by_construction', 'local_only']).toContain(slo.status);
    }
  });

  it('states plainly that none of this is deployed', () => {
    for (const text of [read('ops/alerts.json'), read('ops/dashboards.json')]) {
      expect(text).toMatch(/NOT DEPLOYED/);
    }
    expect(dockerfile).toMatch(/NEVER BUILT OR RUN/);
    expect(compose).toMatch(/NEVER EXECUTED/);
  });
});
