/**
 * Registry coverage: every declared metric must be accounted for.
 *
 * WHY THIS EXISTS. The previous tranche declared a full catalogue of operational metrics, validated
 * them against the alert and dashboard templates, and then incremented almost none of them from a
 * production path. Everything looked instrumented and almost nothing was. A test that only checked
 * "the name exists" could not tell the difference, so this one reads the SOURCE and classifies each
 * metric by where it is actually emitted.
 *
 * The classification is deliberately explicit rather than inferred: a metric that is genuinely
 * template-only has to be listed as such, which makes "nobody wired this yet" a decision somebody
 * wrote down instead of a silent gap.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { METRIC, METRIC_HELP } from './metrics.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Source roots that count as PRODUCTION paths. Test files are excluded on purpose. */
const PRODUCTION_ROOTS = ['apps/api/src', 'apps/worker/src', 'apps/cli/src', 'packages'];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
      continue;
    }
    if (!full.endsWith('.ts')) continue;
    acc.push(full);
  }
  return acc;
}

const allFiles = PRODUCTION_ROOTS.flatMap((r) => sourceFiles(join(root, r)));
const isTest = (f: string): boolean => /\.test\.ts$|testkit\.ts$|-harness\.ts$/.test(f);
const productionText = allFiles
  .filter((f) => !isTest(f) && !f.endsWith('metrics.ts'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');
const testText = allFiles
  .filter(isTest)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/**
 * Metrics with no production call site YET, each with the reason.
 *
 * Keeping this list short is the point. An entry here is a claim that the metric is either emitted by
 * something outside these source roots, or that the subsystem it measures does not exist yet — and the
 * test below fails if an entry becomes stale, so the list cannot rot into an excuse.
 */
const NOT_YET_EMITTED: Readonly<Record<string, string>> = {
  // Emitted by the recovery tooling in tools/, which runs as a drill rather than in a served path.
  [METRIC.backupOutcomes]: 'emitted by the local recovery drill tooling',
  [METRIC.restoreOutcomes]: 'emitted by the local recovery drill tooling',
  // Requires Temporal task-queue introspection, which the local workflow mode does not expose.
  [METRIC.queueDepth]: 'needs Temporal task-queue introspection; not available in local mode',
  [METRIC.activityAttempts]: 'needs Temporal activity interceptors; local mode runs steps directly',
  // The pool does not surface a saturation event; measuring it needs a pg-pool wrapper.
  [METRIC.dbPoolSaturation]: 'pg-pool exposes no saturation event to hook',
  // Fencing lives in the SQL assertion, which raises rather than returning a countable outcome.
  [METRIC.staleWorkerRejections]: 'raised by canon.assert_lease_fence inside the protected write',
  [METRIC.leaseLoss]: 'raised by canon.assert_lease_fence inside the protected write',
  // Reservation expiry is a passive deadline: nothing runs at the moment it lapses.
  [METRIC.reservationExpired]: 'a passive TTL; no code runs at the instant it lapses',
};

describe('metric registry coverage', () => {
  it('every metric name is unique, namespaced and documented', () => {
    const names = Object.values(METRIC);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^yeonjae_[a-z0-9_]+$/);
      expect(METRIC_HELP[name], `${name} has no help text`).toBeDefined();
    }
  });

  it('every metric is either emitted by a production path or explicitly listed as not yet wired', () => {
    const unwired: string[] = [];
    for (const [key, name] of Object.entries(METRIC)) {
      const referenced = productionText.includes(`METRIC.${key}`);
      if (referenced) continue;
      if (name in NOT_YET_EMITTED) continue;
      unwired.push(`${key} (${name})`);
    }
    expect(
      unwired,
      `these metrics have no production call site and no recorded reason:\n  ${unwired.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the not-yet-wired list contains no stale entries', () => {
    const byName = new Map(Object.entries(METRIC).map(([k, v]) => [v, k]));
    for (const name of Object.keys(NOT_YET_EMITTED)) {
      const key = byName.get(name);
      expect(key, `${name} is listed as unwired but is not a declared metric`).toBeDefined();
      // If somebody wires it, the entry must be removed — otherwise the list silently overstates the gap.
      expect(
        productionText.includes(`METRIC.${String(key)}`),
        `${name} IS emitted now; remove it from NOT_YET_EMITTED`,
      ).toBe(false);
    }
  });

  it('the core operational metrics are emitted by production code, not only by tests', () => {
    // These are the ones the previous tranche declared and never wired. Naming them individually
    // means a regression that drops a call site fails here rather than going unnoticed.
    const required = [
      'rateAdmission',
      'rateWaitSeconds',
      'concurrencyAcquired',
      'concurrencySaturated',
      'leaseExpired',
      'budgetReservations',
      'budgetSettlements',
      'unknownCost',
      'retries',
      'repairs',
      'fallbacks',
      'providerAttempts',
      'cancellationRequests',
      'cancellationObservations',
      'remoteCancellation',
      'lateResponses',
      'discardedArtifacts',
      'readinessFailures',
      'migrationMismatch',
      'roleAssumptionFailures',
      'embeddingsGenerated',
      'embeddingSetActivations',
      'retrievalLatency',
      'retrievalResults',
      'thesaurusExpansions',
    ];
    for (const key of required) {
      expect(productionText, `METRIC.${key} has no production call site`).toContain(
        `METRIC.${key}`,
      );
    }
  });

  it('no metric is emitted ONLY from a test, which would prove nothing about production', () => {
    for (const [key, name] of Object.entries(METRIC)) {
      if (name in NOT_YET_EMITTED) continue;
      const inTests = testText.includes(`METRIC.${key}`);
      if (!inTests) continue;
      expect(productionText.includes(`METRIC.${key}`), `METRIC.${key} appears only in tests`).toBe(
        true,
      );
    }
  });
});
