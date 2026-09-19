/**
 * The metric registry, extracted so every package can emit (Phase 4 automated readiness).
 *
 * WHY IT MOVED. The registry lived in `apps/api`, which meant the gateway, the worker and the retrieval
 * layer could not reach it: a package cannot import from an app. The result was a registry full of
 * declared-but-never-incremented names — the metrics existed on paper and no production path emitted
 * them. Moving it to this leaf package is what makes the call sites possible at all.
 *
 * `apps/api/src/observability.ts` re-exports everything here, so every existing import keeps working
 * and the log-redaction code stays where it is.
 *
 * Scope is unchanged and still worth stating: these are PER-PROCESS counters. They reset on restart and
 * are scraped per instance, so a multi-instance deployment relies on the scraper to aggregate. Nothing
 * here is a distributed counter.
 */

/** Lowercase a key for allowlist comparison. Local copy so this package has no dependencies. */
function normalizeKey(key: string): string {
  return key.toLowerCase();
}

export type MetricKind = 'counter' | 'histogram';

/**
 * Label names a METRIC may carry. Deliberately much narrower than `isLoggableKey`.
 *
 * WHY A SECOND, STRICTER ALLOWLIST. The registry previously filtered labels with the log allowlist,
 * which permits any `*_id` suffix — correct for a log line, wrong for a metric. A metric label becomes a
 * distinct TIME SERIES, so `workspace_id` or `job_id` as a label is two defects at once: unbounded
 * cardinality that degrades the scraper, and a tenant identifier published on an endpoint that is
 * deliberately unauthenticated. Every name below is a closed enum or a bounded dimension; no identifier,
 * no hash, no free text, and nothing derived from user input.
 */
const ALLOWED_METRIC_LABELS: readonly string[] = [
  'activity',
  'backend',
  'check',
  'code',
  'component',
  'control',
  'dimension',
  'format',
  'kind',
  'method',
  'mode',
  'model_class',
  'operation_class',
  'outcome',
  'phase',
  'provider',
  'purpose',
  'reason',
  'result',
  'role',
  'route',
  'scope',
  'scope_kind',
  'source',
  'stage',
  'state',
  'status',
  'status_class',
  'step',
  'target_kind',
  'verb',
];

/** Whether a name may be a metric LABEL. Strict allowlist: an unknown name is not a label. */
export function isMetricLabel(key: string): boolean {
  return ALLOWED_METRIC_LABELS.includes(normalizeKey(key));
}

/**
 * Values a label may take, bounded per label name.
 *
 * A closed name is not enough on its own: `reason` is a safe NAME, but an arbitrary exception string as
 * its value would still be unbounded cardinality and a leak channel (a database error carries table and
 * column names; a provider error can carry a URL). So a value outside the known set collapses to
 * `other`, which keeps the series bounded and the signal honest.
 */
/**
 * A route PATTERN (`/v1/projects/:projectId`) is a bounded value and must stay readable, so a leading
 * slash and `:` placeholders are permitted. A resolved path is never passed here — that is the call
 * site's responsibility and the reason tenant ids cannot become label values.
 */
const LABEL_VALUE_PATTERN = /^[a-z0-9/][a-z0-9_.:/-]{0,63}$/;

export const METRIC_LABEL_OTHER = 'other';

export function safeLabelValue(value: string): string {
  // The VALUE is preserved as written when it is bounded and safe, rather than case-folded: an existing
  // enum like `UNAUTHENTICATED` is already a closed value, and rewriting it would silently rename series
  // that dashboards and the current tests refer to. The check is what matters, not the transformation.
  return LABEL_VALUE_PATTERN.test(value.toLowerCase()) ? value : METRIC_LABEL_OTHER;
}

interface MetricSeries {
  readonly kind: MetricKind;
  readonly help: string;
  /** Counter total, or histogram sum, keyed by serialized labels. */
  readonly values: Map<string, { sum: number; count: number; buckets: Map<number, number> }>;
}

/** Latency buckets in seconds, matching the plan's `llm_latency_seconds` histogram intent. */
export const BUCKETS: readonly number[] = [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 300];

/**
 * An in-process metric registry.
 *
 * Scope is stated plainly because it is a real limitation, not an implementation detail: these are
 * per-process counters. They reset on restart and are per-instance, so a multi-instance deployment needs a
 * scraper that aggregates across instances (which is how Prometheus works anyway). Nothing here claims to
 * be a distributed counter.
 */
export class Metrics {
  private readonly series = new Map<string, MetricSeries>();

  /** Register (idempotently) and return a series. */
  private seriesFor(name: string, kind: MetricKind, help: string): MetricSeries {
    const existing = this.series.get(name);
    if (existing) return existing;
    const created: MetricSeries = { kind, help, values: new Map() };
    this.series.set(name, created);
    return created;
  }

  /**
   * Serialize labels deterministically.
   *
   * Label VALUES are passed through `safeValue` and bounded, because a label is rendered into the metrics
   * endpoint's text output: an unbounded value there is both a cardinality explosion and a leak channel.
   */
  private static labelKey(labels: Readonly<Record<string, string>>): string {
    const entries = Object.entries(labels)
      // The STRICT metric allowlist, not the log one: a metric label is a time series, so an `*_id`
      // would be both unbounded cardinality and a tenant identifier on an unauthenticated endpoint.
      .filter(([k]) => isMetricLabel(k))
      .map(([k, v]) => [k, safeLabelValue(v)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(',');
  }

  increment(
    name: string,
    help: string,
    labels: Readonly<Record<string, string>> = {},
    by = 1,
  ): void {
    const s = this.seriesFor(name, 'counter', help);
    const key = Metrics.labelKey(labels);
    const cur = s.values.get(key);
    s.values.set(key, {
      sum: (cur?.sum ?? 0) + by,
      count: (cur?.count ?? 0) + 1,
      buckets: cur?.buckets ?? new Map<number, number>(),
    });
  }

  observe(
    name: string,
    help: string,
    seconds: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    const s = this.seriesFor(name, 'histogram', help);
    const key = Metrics.labelKey(labels);
    const cur = s.values.get(key);
    const buckets = new Map<number, number>(cur?.buckets ?? []);
    for (const b of BUCKETS) if (seconds <= b) buckets.set(b, (buckets.get(b) ?? 0) + 1);
    s.values.set(key, {
      sum: (cur?.sum ?? 0) + seconds,
      count: (cur?.count ?? 0) + 1,
      buckets,
    });
  }

  /** Read one counter total, for tests and for readiness reporting. */
  total(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.series.get(name)?.values.get(Metrics.labelKey(labels))?.sum ?? 0;
  }

  /** Render Prometheus text format. Contains only metric names, safe labels and numbers. */
  render(): string {
    const lines: string[] = [];
    for (const [name, s] of [...this.series.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`# HELP ${name} ${s.help}`);
      lines.push(`# TYPE ${name} ${s.kind}`);
      for (const [key, v] of [...s.values.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const labelPart = key ? `{${key}}` : '';
        if (s.kind === 'counter') {
          lines.push(`${name}${labelPart} ${v.sum}`);
          continue;
        }
        for (const b of BUCKETS) {
          const inner = key ? `${key},le="${b}"` : `le="${b}"`;
          lines.push(`${name}_bucket{${inner}} ${v.buckets.get(b) ?? 0}`);
        }
        const infInner = key ? `${key},le="+Inf"` : 'le="+Inf"';
        lines.push(`${name}_bucket{${infInner}} ${v.count}`);
        lines.push(`${name}_sum${labelPart} ${v.sum}`);
        lines.push(`${name}_count${labelPart} ${v.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** The metric names this system records, named once so producers and dashboards cannot drift apart. */
export const METRIC = {
  requests: 'yeonjae_http_requests_total',
  requestLatency: 'yeonjae_http_request_duration_seconds',
  authFailures: 'yeonjae_auth_failures_total',
  rateLimited: 'yeonjae_rate_limited_total',
  canonCommits: 'yeonjae_canon_commits_total',
  leaseLoss: 'yeonjae_lease_loss_total',
  jobControl: 'yeonjae_job_control_total',
  sseConnections: 'yeonjae_sse_connections_total',
  sseReplays: 'yeonjae_sse_replayed_events_total',
  exports: 'yeonjae_exports_total',
  budgetBlocks: 'yeonjae_budget_blocks_total',
  providerAttempts: 'yeonjae_provider_attempts_total',
  corsDenied: 'yeonjae_cors_denied_total',
  /**
   * Shared-enforcement, retrieval and recovery signals (Phase 4 automated readiness).
   *
   * Named here rather than at each call site so producers, dashboards and alert rules cannot drift
   * apart — the alert templates under `ops/` are validated against this object.
   */
  rateAdmission: 'yeonjae_rate_admission_total',
  rateWaitSeconds: 'yeonjae_rate_admission_wait_seconds',
  concurrencyAcquired: 'yeonjae_concurrency_acquired_total',
  concurrencySaturated: 'yeonjae_concurrency_saturated_total',
  leaseExpired: 'yeonjae_lease_expired_total',
  budgetReservations: 'yeonjae_budget_reservations_total',
  budgetSettlements: 'yeonjae_budget_settlements_total',
  reservationExpired: 'yeonjae_budget_reservations_expired_total',
  unknownCost: 'yeonjae_unknown_cost_settlements_total',
  retries: 'yeonjae_provider_retries_total',
  repairs: 'yeonjae_provider_repairs_total',
  fallbacks: 'yeonjae_provider_fallbacks_total',
  cancellationRequests: 'yeonjae_cancellation_requests_total',
  cancellationObservations: 'yeonjae_cancellation_observations_total',
  remoteCancellation: 'yeonjae_remote_cancellation_total',
  lateResponses: 'yeonjae_late_responses_total',
  discardedArtifacts: 'yeonjae_discarded_artifacts_total',
  staleWorkerRejections: 'yeonjae_stale_worker_rejections_total',
  workflowStates: 'yeonjae_workflow_state_transitions_total',
  activityAttempts: 'yeonjae_activity_attempts_total',
  queueDepth: 'yeonjae_queue_depth',
  dbPoolSaturation: 'yeonjae_db_pool_saturation_total',
  readinessFailures: 'yeonjae_readiness_failures_total',
  drainRefusals: 'yeonjae_drain_refusals_total',
  migrationMismatch: 'yeonjae_migration_mismatch_total',
  roleAssumptionFailures: 'yeonjae_role_assumption_failures_total',
  embeddingsGenerated: 'yeonjae_embeddings_generated_total',
  embeddingSetActivations: 'yeonjae_embedding_set_activations_total',
  retrievalLatency: 'yeonjae_retrieval_duration_seconds',
  retrievalResults: 'yeonjae_retrieval_results_total',
  thesaurusExpansions: 'yeonjae_thesaurus_expansions_total',
  backupOutcomes: 'yeonjae_backup_outcomes_total',
  restoreOutcomes: 'yeonjae_restore_outcomes_total',
  credentialRotations: 'yeonjae_credential_rotations_total',
  /**
   * Credential-free product surfaces (dependency status, preview, quality checks, export, batch).
   *
   * Every label these carry is a closed set (component name, state, rule severity, outcome), so the
   * series stay bounded on an unauthenticated `/metrics` endpoint.
   */
  dependencyStatus: 'yeonjae_dependency_status_total',
  previewOperations: 'yeonjae_preview_operations_total',
  typographyFindings: 'yeonjae_typography_findings_total',
  platformFindings: 'yeonjae_platform_format_findings_total',
  exportPackages: 'yeonjae_export_packages_total',
  batchOperations: 'yeonjae_batch_operations_total',
  batchItems: 'yeonjae_batch_items_total',
} as const;

export const METRIC_HELP: Readonly<Record<string, string>> = {
  [METRIC.requests]: 'HTTP requests by route, method and status class.',
  [METRIC.requestLatency]: 'HTTP request duration in seconds by route.',
  [METRIC.authFailures]: 'Authentication and authorization failures by code.',
  [METRIC.rateLimited]: 'Requests refused by a rate limit, by scope.',
  [METRIC.canonCommits]: 'Canon commits by source.',
  [METRIC.leaseLoss]: 'Lease-loss refusals by reason.',
  [METRIC.jobControl]: 'Job control requests by control and outcome.',
  [METRIC.sseConnections]: 'SSE job-event streams opened.',
  [METRIC.sseReplays]: 'Job events replayed from a Last-Event-ID.',
  [METRIC.exports]: 'Export requests by format and status.',
  [METRIC.budgetBlocks]: 'Calls refused by the budget guard.',
  [METRIC.providerAttempts]: 'Provider attempts by model class and status.',
  [METRIC.corsDenied]: 'Cross-origin requests refused by the origin allowlist.',
  [METRIC.rateAdmission]: 'Shared rate-admission decisions by operation class and reason.',
  [METRIC.rateWaitSeconds]: 'Time a caller waited for shared rate admission, in seconds.',
  [METRIC.concurrencyAcquired]: 'Shared concurrency leases acquired by provider.',
  [METRIC.concurrencySaturated]: 'Attempts refused because shared concurrency was exhausted.',
  [METRIC.leaseExpired]: 'Leases reclaimed by deadline rather than released by their holder.',
  [METRIC.budgetReservations]: 'Shared budget reservations by scope kind and outcome.',
  [METRIC.budgetSettlements]: 'Shared budget settlements by scope kind and outcome.',
  [METRIC.reservationExpired]: 'Budget reservations reclaimed after their TTL.',
  [METRIC.unknownCost]: 'Settlements whose real cost the provider never reported.',
  [METRIC.retries]: 'Provider attempts retried, by failure class.',
  [METRIC.repairs]: 'Bounded structured-output repair attempts.',
  [METRIC.fallbacks]: 'Route fallbacks by reason.',
  [METRIC.cancellationRequests]: 'Cancellation requests by source.',
  [METRIC.cancellationObservations]: 'Cancellations observed by a running call, by phase.',
  [METRIC.remoteCancellation]: 'Remote cancellation states reported by a provider.',
  [METRIC.lateResponses]: 'Provider responses that arrived after an authoritative cancellation.',
  [METRIC.discardedArtifacts]: 'Artifacts discarded rather than committed, by reason.',
  [METRIC.staleWorkerRejections]: 'Writes refused because the worker held a stale fencing token.',
  [METRIC.workflowStates]: 'Workflow state transitions by state.',
  [METRIC.activityAttempts]: 'Activity attempts by activity and outcome.',
  [METRIC.queueDepth]: 'Work items waiting, by kind.',
  [METRIC.dbPoolSaturation]: 'Occasions a database pool had no connection available.',
  [METRIC.readinessFailures]: 'Readiness check failures by check name.',
  [METRIC.drainRefusals]: 'Requests refused because the process is draining, by lifecycle state.',
  [METRIC.migrationMismatch]: 'Readiness refusals caused by a migration-state mismatch.',
  [METRIC.roleAssumptionFailures]: 'Failures to assume the expected least-privilege database role.',
  [METRIC.embeddingsGenerated]: 'Embeddings generated by backend and outcome.',
  [METRIC.embeddingSetActivations]: 'Embedding-set activations and rollbacks by outcome.',
  [METRIC.retrievalLatency]: 'Retrieval duration in seconds by mode.',
  [METRIC.retrievalResults]: 'Retrieval result counts by mode.',
  [METRIC.thesaurusExpansions]: 'Query-term expansions produced by the thesaurus, by kind.',
  [METRIC.backupOutcomes]: 'Local backup attempts by outcome.',
  [METRIC.restoreOutcomes]: 'Local restore drills by outcome.',
  [METRIC.credentialRotations]: 'Credential rotation events by kind and outcome.',
  [METRIC.dependencyStatus]: 'Declared dependency states by component and state.',
  [METRIC.previewOperations]: 'Regeneration-preview operations by verb and outcome.',
  [METRIC.typographyFindings]: 'Deterministic typography findings by severity.',
  [METRIC.platformFindings]: 'Offline platform-format findings by severity.',
  [METRIC.exportPackages]: 'Deterministic export packages prepared, by outcome.',
  [METRIC.batchOperations]: 'Bounded batch operations by operation and outcome.',
  [METRIC.batchItems]: 'Batch items processed by operation and outcome.',
};
