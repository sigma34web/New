/**
 * Bounded deterministic performance smoke tests (Workstream D).
 *
 * These are NOT benchmarks and they are not capacity measurements. They exist to catch CATASTROPHIC
 * regressions — an accidental O(n²), a missing index, a per-call re-read of the whole corpus — on
 * representative local paths, and nothing finer than that.
 *
 * The design follows from that purpose:
 *
 *  * CEILINGS ARE DELIBERATELY BROAD. A threshold tight enough to be interesting on one machine is a
 *    flake on another; each bound here is far above the observed local cost, so a failure means
 *    something structural changed rather than that the runner was busy.
 *  * TIMING IS MONOTONIC (`performance.now`), never wall-clock, so an NTP step cannot fabricate a
 *    regression or hide one.
 *  * WORKLOADS ARE FIXED AND DETERMINISTIC. Same fixture, same size, every run — a smoke test whose
 *    input varied would be measuring the input.
 *  * THERE IS A WARM-UP where a first call would otherwise measure module loading or plan caching.
 *  * OUTPUT SIZE IS BOUNDED where unbounded growth is the actual risk (metric registry cardinality).
 *
 * The environment is recorded with every result, because a duration without the machine that produced
 * it is not evidence of anything. Local results are never production throughput.
 */
import { describe, expect, it } from 'vitest';
import { cpus, arch, platform, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { boundedLimit } from './operator-diagnostics.js';
import {
  checksumOf,
  compareMigration,
  parseManifest,
  verifyBackup,
  MANIFEST_VERSION,
} from './backup-manifest.js';
import { contentHashOf, LocalDeterministicEmbedder, measure, toNfcText } from '@yeonjae/prose';
import { METRIC, METRIC_HELP, Metrics } from '@yeonjae/domain';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One recorded measurement. */
interface Sample {
  readonly name: string;
  readonly iterations: number;
  readonly total_ms: number;
  readonly per_op_ms: number;
  readonly ceiling_ms: number;
}

const samples: Sample[] = [];

/**
 * Time `iterations` of `fn` after a warm-up, and assert a broad per-operation ceiling.
 *
 * The assertion is on the MEAN rather than on any single call: one scheduling hiccup on a shared CI
 * runner must not fail a smoke test, while a structural regression moves the mean past a ceiling that
 * sits an order of magnitude above normal.
 */
function bench(name: string, iterations: number, ceilingMs: number, fn: (i: number) => void): void {
  for (let i = 0; i < Math.min(iterations, 20); i++) fn(i);
  const started = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const total = performance.now() - started;
  const perOp = total / iterations;
  samples.push({
    name,
    iterations,
    total_ms: Math.round(total * 1000) / 1000,
    per_op_ms: Math.round(perOp * 1_000_000) / 1_000_000,
    ceiling_ms: ceilingMs,
  });
  expect(
    perOp,
    `${name}: ${perOp.toFixed(4)}ms/op exceeded the ${String(ceilingMs)}ms ceiling`,
  ).toBeLessThan(ceilingMs);
}

async function benchAsync(
  name: string,
  iterations: number,
  ceilingMs: number,
  fn: (i: number) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < Math.min(iterations, 5); i++) await fn(i);
  const started = performance.now();
  for (let i = 0; i < iterations; i++) await fn(i);
  const total = performance.now() - started;
  const perOp = total / iterations;
  samples.push({
    name,
    iterations,
    total_ms: Math.round(total * 1000) / 1000,
    per_op_ms: Math.round(perOp * 1_000_000) / 1_000_000,
    ceiling_ms: ceilingMs,
  });
  expect(
    perOp,
    `${name}: ${perOp.toFixed(4)}ms/op exceeded the ${String(ceilingMs)}ms ceiling`,
  ).toBeLessThan(ceilingMs);
}

describe('performance smoke: bounded local paths (Workstream D)', () => {
  const FIXTURE_TEXT =
    'Seo-ha counted the exits before the door closed. Three. That was one more than yesterday, ' +
    'and yesterday had already been a mistake she was still paying for.';

  it('NFC normalization and the length model stay linear on a fixed paragraph', () => {
    bench('prose.toNfcText', 2_000, 1, () => {
      toNfcText(FIXTURE_TEXT);
    });
    bench('prose.measure', 2_000, 2, () => {
      measure(toNfcText(FIXTURE_TEXT));
    });
  });

  it('content hashing stays bounded', () => {
    bench('prose.contentHashOf', 5_000, 0.5, () => {
      contentHashOf(FIXTURE_TEXT);
    });
  });

  it('deterministic embedding generation stays bounded, including in batches', () => {
    const embedder = new LocalDeterministicEmbedder();
    bench('embeddings.single', 1_000, 2, () => {
      embedder.embed(FIXTURE_TEXT);
    });
    // A batch must not cost materially more per item than a single call; if it does, something is
    // re-initializing per item.
    const batch = Array.from({ length: 32 }, (_, i) => `${FIXTURE_TEXT} #${String(i)}`);
    bench('embeddings.batch32', 100, 64, () => {
      for (const text of batch) embedder.embed(text);
    });
  });

  it('metric rendering stays bounded and the registry does not grow without limit', () => {
    const metrics = new Metrics();
    // Deliberately hammer ONE metric with a bounded label set: the registry must stay small. Unbounded
    // growth here is the cardinality failure the metric design exists to prevent.
    for (let i = 0; i < 5_000; i++) {
      metrics.increment(METRIC.providerAttempts, METRIC_HELP[METRIC.providerAttempts] ?? '', {
        outcome: i % 2 === 0 ? 'succeeded' : 'failed',
      });
    }
    bench('metrics.render', 200, 25, () => {
      metrics.render();
    });
    const rendered = metrics.render();
    const lines = rendered.split('\n').filter((l) => l && !l.startsWith('#'));
    // Two outcomes from 5,000 increments: a registry that grew per-call would be orders of magnitude
    // larger, and that is exactly the regression this bound catches.
    expect(lines.length).toBeLessThan(50);
    expect(rendered.length).toBeLessThan(20_000);
  });

  it('operator limit clamping stays constant-time', () => {
    bench('operator.boundedLimit', 20_000, 0.05, (i) => {
      boundedLimit(i % 7 === 0 ? '10000' : i);
    });
  });

  it('migration comparison stays constant-time', () => {
    bench('recovery.compareMigration', 20_000, 0.05, () => {
      compareMigration('0009', '0017');
    });
  });

  it('backup manifest validation stays bounded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yeonjae-perf-'));
    const artifactPath = join(dir, 'source.dump');
    // A 1 MiB deterministic artifact: large enough that a non-streaming checksum would show up.
    const content = Buffer.alloc(1024 * 1024, 'y');
    writeFileSync(artifactPath, content);
    const manifest = {
      manifest_version: MANIFEST_VERSION,
      created_at: '2026-01-01T00:00:00.000Z',
      method: 'pg_dump_custom',
      database_identifier: 'yeonjae_perf_source',
      artifact_name: 'source.dump',
      artifact_bytes: content.byteLength,
      checksum_algorithm: 'sha256',
      checksum: await checksumOf(artifactPath),
      migration_version: '0017',
      migration_count: 17,
      postgres_version: '16',
      compatibility: { min_application_migration: '0001', requires_extensions: [] },
      restore_prerequisites: [],
      secrets_excluded: true,
    };

    bench('recovery.parseManifest', 2_000, 0.5, () => {
      parseManifest(manifest);
    });
    // Checksumming 1 MiB repeatedly: the ceiling is broad, but a change that read the file into memory
    // per chunk, or hashed it more than once, would still cross it.
    await benchAsync('recovery.verifyBackup(1MiB)', 20, 200, async () => {
      const verdict = await verifyBackup({
        manifest,
        artifactPath,
        applicationMigration: '0017',
      });
      expect(verdict.ok).toBe(true);
    });
  });

  it('records the environment and every sample, so a duration is interpretable', () => {
    const cpuList = cpus();
    const report = {
      kind: 'performance_smoke',
      // Stated here as well as in the module header: these are local smoke results, not capacity.
      disclaimer:
        'Local bounded smoke results on a shared sandbox. These are NOT production throughput, ' +
        'latency or capacity figures, and they do not model concurrency.',
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        cpu_model: cpuList[0]?.model ?? 'unknown',
        cpu_count: cpuList.length,
        total_memory_bytes: totalmem(),
        postgres: process.env.DATABASE_URL ? 'configured' : 'not used by this suite',
      },
      fixture: {
        paragraph_chars: FIXTURE_TEXT.length,
        embedding_batch: 32,
        manifest_artifact_bytes: 1024 * 1024,
      },
      samples,
      recorded_at: new Date().toISOString(),
    };
    mkdirSync('coverage', { recursive: true });
    writeFileSync(
      'coverage/perf-smoke-report.json',
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    // The suite is only meaningful if it actually measured the paths above.
    expect(samples.length).toBeGreaterThanOrEqual(9);
    for (const s of samples) expect(s.per_op_ms).toBeLessThan(s.ceiling_ms);
  });
});
