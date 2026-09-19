/**
 * Metric label hygiene (Phase 4 automated readiness).
 *
 * The defect this suite pins: the registry used to filter labels with `isLoggableKey`, the LOG allowlist,
 * which permits any `*_id` suffix. That is right for a log line and wrong for a metric — a label is a
 * time series, so `workspace_id` as a label is unbounded cardinality AND a tenant identifier published
 * on a deliberately unauthenticated `/metrics` endpoint. The assertions below are about what CANNOT
 * appear, because that is the property that was violated.
 */
import { describe, expect, it } from 'vitest';
import {
  isLoggableKey,
  isMetricLabel,
  METRIC,
  METRIC_HELP,
  METRIC_LABEL_OTHER,
  Metrics,
  safeLabelValue,
} from './observability.js';

describe('metric label allowlist', () => {
  it('refuses identifier labels that the LOG allowlist would accept', () => {
    for (const key of [
      'workspace_id',
      'project_id',
      'job_id',
      'request_id',
      'llm_call_id',
      'user_id',
      'pack_hash',
      'prompt_hash',
    ]) {
      // Safe in a log line...
      expect(isLoggableKey(key)).toBe(true);
      // ...and never a metric label.
      expect(isMetricLabel(key)).toBe(false);
    }
  });

  it('accepts only bounded dimensions', () => {
    for (const key of ['route', 'status', 'reason', 'provider', 'operation_class', 'outcome']) {
      expect(isMetricLabel(key)).toBe(true);
    }
    for (const key of ['prompt', 'manuscript', 'text', 'detail', 'message', 'error', 'url']) {
      expect(isMetricLabel(key)).toBe(false);
    }
  });

  it('drops identifier labels from a rendered series rather than publishing them', () => {
    const m = new Metrics();
    m.increment(METRIC.rateAdmission, 'help', {
      reason: 'request_limit',
      workspace_id: '0191b2a0-0000-7000-8000-000000000000',
      project_id: '0191b2a0-0000-7000-8000-000000000001',
    });
    const text = m.render();
    expect(text).toContain('reason="request_limit"');
    expect(text).not.toContain('workspace_id');
    expect(text).not.toContain('0191b2a0');
  });

  it('collapses an arbitrary exception string to a bounded value', () => {
    const m = new Metrics();
    // The shape of the leak this prevents: a database error naming tables, or a provider URL.
    m.increment(METRIC.readinessFailures, 'help', {
      reason: 'relation "canon.llm_calls" does not exist at character 42',
    });
    m.increment(METRIC.readinessFailures, 'help', {
      reason: 'https://api.example.com/v1/chat?key=abc',
    });
    const text = m.render();
    expect(text).toContain(`reason="${METRIC_LABEL_OTHER}"`);
    expect(text).not.toContain('llm_calls');
    expect(text).not.toContain('api.example.com');
    // Both collapsed into ONE series, which is the cardinality property.
    expect(m.total(METRIC.readinessFailures, { reason: METRIC_LABEL_OTHER })).toBe(2);
  });

  it('keeps cardinality bounded under adversarial input', () => {
    const m = new Metrics();
    for (let i = 0; i < 500; i++) {
      m.increment(METRIC.rateAdmission, 'help', {
        reason: `unbounded-value-${String(i)}-${'x'.repeat(80)}`,
      });
    }
    const series = m
      .render()
      .split('\n')
      .filter((l) => l.startsWith(METRIC.rateAdmission) && !l.startsWith('#'));
    expect(series).toHaveLength(1);
  });

  it('preserves a route PATTERN, which is bounded and must stay readable', () => {
    expect(safeLabelValue('/v1/projects/:projectId')).toBe('/v1/projects/:projectId');
    // A resolved path with an id is still bounded in shape, so the call site (not this check) is what
    // guarantees patterns are used; the test records that expectation explicitly.
    expect(safeLabelValue('UNAUTHENTICATED')).toBe('UNAUTHENTICATED');
  });

  it('is idempotent under duplicate initialization', () => {
    const m = new Metrics();
    m.increment(METRIC.fallbacks, 'first help', { reason: 'retryable_provider' });
    m.increment(METRIC.fallbacks, 'second help', { reason: 'retryable_provider' });
    const help = m
      .render()
      .split('\n')
      .filter((l) => l.startsWith(`# HELP ${METRIC.fallbacks}`));
    expect(help).toHaveLength(1);
    expect(m.total(METRIC.fallbacks, { reason: 'retryable_provider' })).toBe(2);
  });

  it('every declared metric name is documented and uniquely named', () => {
    const names = Object.values(METRIC);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(METRIC_HELP[name], `${name} has no help text`).toBeDefined();
      // Prometheus naming: a namespaced, snake_case name with a unit or `_total` suffix.
      expect(name).toMatch(/^yeonjae_[a-z0-9_]+$/);
    }
  });

  it('names carry honest units: counters end _total, histograms end in a unit', () => {
    const histograms = [METRIC.requestLatency, METRIC.rateWaitSeconds, METRIC.retrievalLatency];
    for (const h of histograms) expect(h).toMatch(/_seconds$/);
    const gauges = [METRIC.queueDepth];
    for (const name of Object.values(METRIC)) {
      if (histograms.includes(name as never) || gauges.includes(name as never)) continue;
      expect(name, `${name} is a counter and should end _total`).toMatch(/_total$/);
    }
  });

  it('renders no manuscript, prompt or credential content even when handed some', () => {
    const m = new Metrics();
    m.increment(METRIC.embeddingsGenerated, 'help', {
      backend: 'local_deterministic',
      text: 'The device cried out, and the hall went quiet.',
      prompt: 'You are a writer',
      api_key: 'sk-not-a-real-key',
    });
    const text = m.render();
    expect(text).toContain('backend="local_deterministic"');
    expect(text).not.toContain('device cried out');
    expect(text).not.toContain('You are a writer');
    expect(text).not.toContain('sk-not-a-real-key');
  });

  it('survives repeated startup and disposal without accumulating series', () => {
    for (let i = 0; i < 20; i++) {
      const m = new Metrics();
      m.increment(METRIC.readinessFailures, 'help', { check: 'database' });
      expect(m.total(METRIC.readinessFailures, { check: 'database' })).toBe(1);
    }
  });
});
