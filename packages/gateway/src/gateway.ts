/**
 * The model gateway (docs/06-system/07). The only path to a provider. Per call: Guard → budget reservation →
 * route → provider → truncation / structured-output validation with bounded repair → output-language check
 * for manuscript roles (discard + regenerate once + reroute) → audit record. Idempotent by key: a completed
 * call is returned from the audit store without new spend.
 */
import { createHash } from 'node:crypto';
import { checkOutputLanguage, toNfcText } from '@yeonjae/prose';
import {
  METRIC,
  METRIC_HELP,
  type Metrics,
  safeLabelValue,
  uuidv7,
  validatorFor,
  type Uuid,
} from '@yeonjae/domain';
import {
  cancellationErrorOf,
  composeCancellation,
  isAuthoritativeCancellation,
  isCancellationError,
  raceCancellation,
  watchDurableCancellation,
  type CancellationHandle,
  type CancellationInput,
  type CancellationReason,
  type RemoteCancellationStatus,
  type TimerFns,
} from './cancellation.js';
import { classifyProviderFailure, isRetryable, type FailureClass } from './failures.js';
import { guardRequest, type GuardContext } from './guard.js';
import { DEFAULT_PARAMS } from './mock-provider.js';
import {
  GatewayError,
  type FinishReason,
  type GatewayRequest,
  type GatewayResponse,
  type ModelClass,
  type ModelParams,
  type Provider,
  type ProviderResponse,
} from './types.js';

export interface RouteEntry {
  readonly modelId: string;
  readonly provider: string;
  readonly priority: number;
  readonly family: string;
  readonly priceInPerMTokCents: number;
  readonly priceOutPerMTokCents: number;
  readonly maxContextTokens: number;
  readonly supportsJsonSchema: boolean;
}

export type RoutingTable = Readonly<Record<ModelClass, readonly RouteEntry[]>>;

export interface BudgetLedger {
  /** Reserve `cents`; throw GatewayError('BUDGET_EXHAUSTED') when the scope cannot afford it. */
  reserve(
    scope: { projectId: string; jobId: string; workspaceId?: string | undefined },
    cents: number,
  ): Promise<{ release(actualCents: number): Promise<void> }>;
}

/**
 * Rate admission in front of a paid attempt.
 *
 * Declared here as a structural interface, satisfied by `PgProviderAdmission` in `@yeonjae/db`, so the
 * gateway depends on the SHAPE of shared enforcement and not on the database package. `grant.release()`
 * frees the concurrency lease; the window count is deliberately not refundable.
 */
export interface ProviderAdmissionControl {
  admit(req: {
    workspaceId?: string | undefined;
    provider: string;
    modelId: string;
    requestId: string;
    tokens?: number | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{
    readonly admitted: boolean;
    readonly reason: string;
    readonly retryAfterMs: number;
    readonly waitedMs: number;
    release(): Promise<void>;
  }>;
}

export interface AuditRecord {
  readonly id: Uuid;
  readonly idempotency_key: string;
  readonly activity_id?: string | undefined;
  readonly role: string;
  readonly prompt_version_id: string;
  readonly prompt_hash: string;
  readonly pack_id: string;
  readonly pack_hash: string;
  readonly production_policy_version: string;
  readonly narrative_identity_version_id?: string | undefined;
  readonly narrative_block_hash?: string | undefined;
  readonly output_language_contract_hash?: string | undefined;
  readonly tradition_contract_hash?: string | undefined;
  readonly output_language_check?:
    | { performed: boolean; passed?: boolean | undefined; english_confidence?: number | undefined }
    | undefined;
  readonly model_id: string;
  readonly model_class: ModelClass;
  readonly provider: string;
  readonly params: ModelParams;
  readonly usage: ProviderResponse['usage'];
  readonly cost_cents: number;
  readonly latency_ms: number;
  readonly attempt: number;
  readonly status: 'succeeded' | 'failed' | 'fallback_succeeded' | 'budget_blocked' | 'cancelled';
  readonly finish_reason: FinishReason;
  readonly schema_valid: boolean;
  readonly repair_attempts: number;
  readonly fallback_from_model_id?: string | undefined;
  readonly error?: { class: string; message: string } | undefined;
  /**
   * Truthful cancellation provenance (Phase 4 active-request cancellation). Present only on a call that
   * was cancelled, so an existing non-cancelled record is byte-identical to what it was before.
   *
   * `usage_status` is the field that keeps this honest: aborting a socket is not evidence that zero
   * tokens were produced or that nothing will be billed, so unknown usage is recorded as `unknown` and
   * never coerced to a comfortable zero.
   */
  readonly cancellation?:
    | {
        readonly reason: CancellationReason;
        readonly outcome:
          CancellationReason | 'provider_failed' | 'late_result_discarded' | 'cancel_too_late';
        readonly remote_cancellation: RemoteCancellationStatus;
        /** `reported` when the provider returned usage anyway; `unknown` when it did not. Never 0. */
        readonly usage_status: 'reported' | 'unknown';
        /** `unknown` unless the provider reported usage we could price. Never presented as zero. */
        readonly billing_status: 'known' | 'unknown';
        readonly requested_at?: string | undefined;
        readonly aborted_at?: string | undefined;
        readonly response_discarded: boolean;
        /** True when the abort happened before any provider request was issued. */
        readonly before_first_attempt: boolean;
      }
    | undefined;
  /**
   * Attempt-level provenance (B-4-2). `attempt_records` carries one entry per ACTUAL provider attempt, so
   * a fallback that succeeded on route 2 still shows why route 1 was abandoned. Cost is attributed per
   * attempt and the summed `cost_cents` stays the authoritative total, so no attempt is double-charged.
   */
  readonly attempt_records?:
    | readonly {
        readonly attempt: number;
        readonly model_id: string;
        readonly provider: string;
        readonly outcome: 'succeeded' | 'failed';
        readonly failure_class?: string | undefined;
        readonly error_class?: string | undefined;
        readonly cost_cents: number;
        readonly usage: ProviderResponse['usage'];
        readonly latency_ms: number;
      }[]
    | undefined;
  /** Prompt and output text are never logged in plaintext; only hashes and sizes live on the record. */
  readonly input_hash: string;
  readonly output_hash?: string | undefined;
  readonly output: { text?: string | undefined; json?: unknown } | undefined;
  readonly created_at: string;
}

export interface AuditStore {
  findByIdempotencyKey(key: string): Promise<AuditRecord | undefined>;
  append(record: AuditRecord): Promise<void>;
}

export class MemoryAuditStore implements AuditStore {
  readonly records: AuditRecord[] = [];
  async findByIdempotencyKey(key: string): Promise<AuditRecord | undefined> {
    return this.records.find(
      (r) => r.idempotency_key === key && r.status !== 'failed' && r.status !== 'budget_blocked',
    );
  }
  async append(record: AuditRecord): Promise<void> {
    this.records.push(record);
  }
}

export class MemoryBudget implements BudgetLedger {
  private spent = new Map<string, number>();
  constructor(private readonly hardLimitCents: number) {}
  async reserve(scope: { projectId: string }, cents: number) {
    const key = scope.projectId;
    const used = this.spent.get(key) ?? 0;
    if (used + cents > this.hardLimitCents) {
      throw new GatewayError(
        'BUDGET_EXHAUSTED',
        `project ${key}: ${used} + ${cents} cents exceeds hard limit ${this.hardLimitCents}`,
      );
    }
    this.spent.set(key, used + cents);
    return {
      release: async (actual: number) => {
        this.spent.set(key, (this.spent.get(key) ?? 0) - cents + actual);
      },
    };
  }
  spentCents(projectId: string): number {
    return this.spent.get(projectId) ?? 0;
  }
}

export interface GatewayOptions {
  readonly providers: ReadonlyMap<string, Provider>;
  readonly routing: RoutingTable;
  readonly budget: BudgetLedger;
  readonly audit: AuditStore;
  /**
   * Shared rate/concurrency admission. Optional in the TYPE so the many single-process test gateways
   * stay valid, but the worker's production path supplies it and refuses to start without it.
   */
  readonly admission?: ProviderAdmissionControl | undefined;
  /**
   * Where to record operational counters.
   *
   * Optional so every existing single-purpose test gateway stays valid, and passed in rather than
   * module-global so a test can assert on exactly the emissions of the call it made.
   */
  readonly metrics?: Metrics | undefined;
  readonly guardContext?: GuardContext | undefined;
  /** Minimum English confidence for manuscript roles (policy.output_language.min_english_confidence). */
  readonly minEnglishConfidence?: number | undefined;
  readonly allowlistTerms?: readonly string[] | undefined;
  readonly clock?: (() => Date) | undefined;
  /** Per-call token estimate for reservation; defaults to prompt estimate + max_tokens. */
  readonly tokensPerWord?: number | undefined;
  /** Injectable timers so a test can drive a deadline or a poll interval without sleeping. */
  readonly timers?: TimerFns | undefined;
  /** Poll cadence for the durable cancellation observer. Defaults to `DURABLE_CANCEL_POLL_MS`. */
  readonly cancelPollMs?: number | undefined;
}

/**
 * Per-call cancellation wiring. Every field is optional, so an existing caller that supplies none keeps
 * exactly the previous behaviour — the compatibility property the non-cancelled regression tests assert.
 */
export interface GatewayCallOptions {
  /**
   * Upstream signals to honour, each labelled with what it MEANS. Labelling at the source is what lets
   * the audit distinguish an operator's cancel from a Temporal activity cancellation from a shutdown.
   */
  readonly cancellation?: readonly CancellationInput[] | undefined;
  /** Deadline for the whole call. Fires as `timeout`, which is a fault and not an operator decision. */
  readonly timeoutMs?: number | undefined;
  /**
   * Durable intent probe, polled while a provider request is in flight. This is what makes a durable
   * `jobs.control = 'cancel'` reach an ALREADY-RUNNING provider call instead of only the next step.
   */
  readonly isDurablyCancelled?: (() => Promise<boolean>) | undefined;
  readonly durableCancelReason?: CancellationReason | undefined;
}

function sha(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function costCents(route: RouteEntry, usage: ProviderResponse['usage']): number {
  return (
    (usage.input * route.priceInPerMTokCents + usage.output * route.priceOutPerMTokCents) /
    1_000_000
  );
}

/**
 * Is this error a budget refusal, whichever ledger raised it?
 *
 * Structural on `code` so both `GatewayError('BUDGET_EXHAUSTED')` and `@yeonjae/db`'s
 * `BudgetExhaustedError` are recognized without a cross-package import.
 */
export function isBudgetExhausted(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'BUDGET_EXHAUSTED'
  );
}

export class Gateway {
  constructor(private readonly opts: GatewayOptions) {}

  /**
   * Record one counter, with labels bounded at the call site.
   *
   * Every label value passes through `safeLabelValue`, so a value that is not a closed enum collapses
   * to `other` rather than becoming a new time series. The registry enforces the same rule, but doing
   * it here as well makes the intent visible where the label is chosen: nothing derived from a request,
   * a tenant, a prompt or an exception message may become a label.
   */
  private count(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const metrics = this.opts.metrics;
    if (!metrics) return;
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) safe[k] = safeLabelValue(v);
    metrics.increment(name, METRIC_HELP[name] ?? '', safe);
  }

  private observe(
    name: string,
    seconds: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    const metrics = this.opts.metrics;
    if (!metrics) return;
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) safe[k] = safeLabelValue(v);
    metrics.observe(name, METRIC_HELP[name] ?? '', seconds, safe);
  }

  private routesFor(cls: ModelClass, excludeFamily?: string): RouteEntry[] {
    const routes = [...this.opts.routing[cls]].sort((a, b) => a.priority - b.priority);
    return excludeFamily ? routes.filter((r) => r.family !== excludeFamily) : routes;
  }

  async call(req: GatewayRequest, options: GatewayCallOptions = {}): Promise<GatewayResponse> {
    // 0. idempotency: a completed call is replayed, never re-spent
    const prior = await this.opts.audit.findByIdempotencyKey(req.idempotencyKey);
    if (prior) return this.fromAudit(prior, true);

    /**
     * The cancellation handle for this call, and the bounded observer that feeds it.
     *
     * Composed BEFORE the Guard and the budget reservation so a cancel that is already durable costs
     * nothing: the first `throwIfCancelled` below fires with zero provider invocations and zero spend.
     *
     * Both are disposed in the `finally` of the attempt loop, on every exit path — success, provider
     * failure, timeout and cancellation all release the listeners and the poll timer.
     */
    const handle = composeCancellation(options.cancellation ?? [], {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(this.opts.timers ? { setTimer: this.opts.timers } : {}),
    });
    const watcher = options.isDurablyCancelled
      ? watchDurableCancellation({
          handle,
          isCancelled: options.isDurablyCancelled,
          ...(options.durableCancelReason ? { reason: options.durableCancelReason } : {}),
          ...(this.opts.cancelPollMs !== undefined ? { intervalMs: this.opts.cancelPollMs } : {}),
          ...(this.opts.timers ? { timers: this.opts.timers } : {}),
        })
      : undefined;
    const release = (): void => {
      watcher?.dispose();
      handle.dispose();
    };

    try {
      return await this.execute(req, handle);
    } finally {
      release();
    }
  }

  private async execute(req: GatewayRequest, handle: CancellationHandle): Promise<GatewayResponse> {
    /**
     * Read through a function so every check is a FRESH evaluation.
     *
     * A listener flips `signal.aborted` asynchronously, which TypeScript's control-flow analysis cannot
     * see: after one `if (handle.signal.aborted)` it narrows the property to `false` and reports every
     * later check as statically unreachable — the same narrowing trap the workflow's signal flags and the
     * SSE stream's write-after-disconnect both document.
     */
    const cancelled = (): boolean => handle.signal.aborted;
    const cancelRequestedAt = (): string | undefined =>
      handle.reason() !== undefined
        ? (this.opts.clock ?? (() => new Date()))().toISOString()
        : undefined;

    // 1. Guard (fail closed)
    const guard = guardRequest(req, this.opts.guardContext);

    // 2. route + budget reservation
    const routes = this.routesFor(req.modelClass);
    if (routes.length === 0)
      throw new GatewayError('PROVIDER_FAILED', `no route for model class ${req.modelClass}`);
    const params: ModelParams = { ...DEFAULT_PARAMS, ...(req.params ?? {}) };
    const primary = routes[0];
    if (!primary) throw new GatewayError('PROVIDER_FAILED', 'no primary route');

    /**
     * Cancellation observed BEFORE the budget reservation and before the first attempt.
     *
     * Ordering is the point: reserving budget and then aborting would leave a reservation to unwind, and
     * a cancelled call that never contacted a provider must record zero attempts, zero cost and
     * `before_first_attempt: true` — the "cancel before start makes no provider call" invariant.
     */
    if (cancelled()) {
      const err = cancellationErrorOf(handle);
      /**
       * Cancelled BEFORE the budget reservation, so this path never reaches `settleCancelled`.
       *
       * It still has to emit, or the cheapest and most desirable cancellation -- the one that costs
       * nothing because no provider was contacted -- would be the one the metrics never showed. There
       * is no settlement counter here precisely because there was no reservation to settle.
       */
      this.count(METRIC.cancellationRequests, { source: err.reason });
      this.count(METRIC.cancellationObservations, { phase: 'before_first_attempt' });
      this.count(METRIC.remoteCancellation, { state: err.remoteCancellation });
      this.count(METRIC.unknownCost, { scope_kind: 'job' });
      await this.opts.audit.append(
        this.cancelledRecord(req, guard, primary, params, {
          error: err,
          actualCost: 0,
          attempt: 0,
          attemptRecords: [],
          repairAttempts: 0,
          beforeFirstAttempt: true,
          requestedAt: cancelRequestedAt(),
        }),
      );
      throw err;
    }

    const predicted = costCents(primary, {
      input: req.pack.tokenEstimate,
      output: params.max_tokens,
      cached: 0,
    });
    const reservation = await this.opts.budget
      // The workspace ceiling is passed through so a shared ledger can enforce it; `MemoryBudget`
      // ignores it, which is why the previous single-scope call site kept working.
      .reserve(
        { projectId: req.projectId, jobId: req.jobId, workspaceId: req.workspaceId },
        predicted,
      )
      .catch(async (err: unknown) => {
        /**
         * Recognize a budget refusal by its CODE, not by its class.
         *
         * `MemoryBudget` raises `GatewayError('BUDGET_EXHAUSTED')`, but the shared ledger lives in
         * `@yeonjae/db` and raises its own `BudgetExhaustedError` carrying the same code — it cannot
         * import this class without inverting the package dependency. Matching on the class alone meant
         * a shared-budget refusal produced no `budget_blocked` audit row, which is the one durable
         * record an operator needs to tell "refused by policy" from "crashed".
         */
        if (isBudgetExhausted(err)) {
          this.count(METRIC.budgetReservations, { scope_kind: 'job', outcome: 'refused' });
          // The same refusal the audit row records as `budget_blocked`, so metric and audit agree.
          this.count(METRIC.budgetBlocks, { scope_kind: 'job' });
          await this.opts.audit.append(
            this.record(
              req,
              guard,
              primary,
              params,
              undefined,
              0,
              'budget_blocked',
              'stop',
              false,
              0,
              {
                class: 'BUDGET_EXHAUSTED',
                message: err instanceof Error ? err.message : String(err),
              },
            ),
          );
        }
        throw err;
      });

    this.count(METRIC.budgetReservations, { scope_kind: 'job', outcome: 'reserved' });

    let attempt = 0;
    let repairAttempts = 0;
    let fallbackFrom: string | undefined;
    let lastError: { class: string; message: string } | undefined;
    let languageFailures = 0;
    let routeIdx = 0;
    let actualCost = 0;
    let lastFailureClass: FailureClass | undefined;
    const attemptRecords: NonNullable<AuditRecord['attempt_records']>[number][] = [];
    const validator = req.outputSchemaRef ? validatorFor(req.outputSchemaRef) : undefined;
    /** Usage a provider reported for an attempt that was then discarded by a cancellation race. */
    let discardedUsage: ProviderResponse['usage'] | undefined;
    let responseDiscarded = false;

    /**
     * Settle the call as cancelled: one audit row, the reservation released at ACTUAL cost, and the
     * cancellation error rethrown. Called from every point where the handle has fired.
     */
    const settleCancelled = async (
      err: unknown,
      route: RouteEntry,
      beforeFirstAttempt: boolean,
    ): Promise<never> => {
      const cancelled = isCancellationError(err) ? err : cancellationErrorOf(handle);
      await this.opts.audit.append(
        this.cancelledRecord(req, guard, route, params, {
          error: cancelled,
          actualCost,
          attempt,
          attemptRecords,
          repairAttempts,
          beforeFirstAttempt,
          requestedAt: cancelRequestedAt(),
          responseDiscarded,
          ...(discardedUsage ? { discardedUsage } : {}),
          ...(fallbackFrom ? { fallbackFrom } : {}),
        }),
      );
      // Released at ACTUAL cost, never at the prediction: a cancelled call must not leave phantom spend
      // reserved against the project, and must not refund spend that genuinely happened.
      await reservation.release(actualCost);
      this.count(METRIC.cancellationRequests, { source: cancelled.reason });
      this.count(METRIC.cancellationObservations, {
        phase: beforeFirstAttempt ? 'before_first_attempt' : 'in_flight',
      });
      // The getter, not the raw field: it defaults to `unknown` rather than to a claim.
      this.count(METRIC.remoteCancellation, { state: cancelled.remoteCancellation });
      // Truthful accounting: a cancelled call whose usage the provider never reported settles as
      // UNKNOWN, never as a comfortable zero (ADR-0049). The counter says the same thing.
      if (cancelled.detail.usage === undefined) {
        this.count(METRIC.unknownCost, { scope_kind: 'job' });
        this.count(METRIC.budgetSettlements, { scope_kind: 'job', outcome: 'unknown' });
      } else {
        this.count(METRIC.budgetSettlements, { scope_kind: 'job', outcome: 'known' });
      }
      throw cancelled;
    };

    try {
      while (routeIdx < routes.length && attempt < 4) {
        const route = routes[routeIdx];
        if (!route) break;
        const provider = this.opts.providers.get(route.provider);
        if (!provider)
          throw new GatewayError('PROVIDER_FAILED', `provider ${route.provider} not configured`);
        /**
         * The gate before EVERY attempt.
         *
         * This single check is what makes "no retry after cancellation", "no repair after cancellation"
         * and "no fallback after cancellation" one property rather than three: retry, bounded repair and
         * route fallback are all expressed in this repository as another iteration of this loop, so
         * refusing to start an iteration refuses all three at once.
         */
        if (cancelled())
          // `before_first_attempt` is read from the recorded attempts rather than the counter: it is the
          // same fact (no provider was contacted yet) stated in terms of the durable evidence.
          await settleCancelled(cancellationErrorOf(handle), route, attemptRecords.length === 0);
        attempt++;
        /**
         * SHARED RATE ADMISSION, immediately before the paid call and inside the attempt loop.
         *
         * Placing it here rather than once per `call()` is what makes retry, bounded repair and route
         * fallback each require their OWN admission: all three are expressed as another iteration of
         * this loop, so every provider attempt passes through exactly one admission decision. The
         * request id carries the attempt number and the route, so a redelivered attempt re-reads its own
         * decision (idempotent) while a genuine retry earns a fresh one.
         */
        let grant: Awaited<ReturnType<ProviderAdmissionControl['admit']>> | undefined;
        if (this.opts.admission) {
          grant = await this.opts.admission.admit({
            workspaceId: req.workspaceId,
            provider: route.provider,
            modelId: route.modelId,
            requestId: `${req.idempotencyKey}:${String(attempt)}:${route.modelId}`,
            tokens: req.pack.tokenEstimate + params.max_tokens,
            signal: handle.signal,
          });
          this.observe(METRIC.rateWaitSeconds, grant.waitedMs / 1000, {
            operation_class: 'provider_call',
          });
          this.count(METRIC.rateAdmission, {
            operation_class: 'provider_call',
            reason: grant.reason,
            outcome: grant.admitted ? 'admitted' : 'refused',
          });
          if (grant.admitted) {
            this.count(METRIC.concurrencyAcquired, { provider: route.provider });
          } else if (grant.reason === 'concurrency_exhausted') {
            this.count(METRIC.concurrencySaturated, { provider: route.provider });
          }
          if (!grant.admitted) {
            /**
             * Refused. This is not a provider fault, so it must not be rerouted to a second paid model
             * and must not be repaired — doing either would turn one refused call into more spend. The
             * reservation is released at actual cost by the outer `catch`, and the audit row records the
             * refusal with no usage, because no request was issued.
             */
            const rateError = new GatewayError(
              'RATE_LIMITED',
              `shared rate limit refused ${route.provider}/${route.modelId} (${grant.reason}); retry after ${String(grant.retryAfterMs)} ms`,
            );
            attemptRecords.push({
              attempt,
              model_id: route.modelId,
              provider: route.provider,
              outcome: 'failed',
              failure_class: 'rate_limited',
              error_class: 'RATE_LIMITED',
              cost_cents: 0,
              usage: { input: 0, output: 0, cached: 0 },
              latency_ms: 0,
            });
            await this.opts.audit.append(
              this.record(
                req,
                guard,
                route,
                params,
                undefined,
                actualCost,
                'failed',
                'error',
                false,
                repairAttempts,
                { class: 'RATE_LIMITED', message: rateError.message },
                fallbackFrom,
                undefined,
                undefined,
                attempt,
                attemptRecords,
              ),
            );
            await reservation.release(actualCost);
            throw rateError;
          }
        }
        let res: ProviderResponse;
        try {
          /**
           * The provider receives the composed signal AND the call is raced against it.
           *
           * Both are necessary. The signal lets a cooperative adapter abort its own socket promptly; the
           * race guarantees the gateway stops waiting even for an adapter that ignores the signal, which
           * is the difference between "cancellation is supported" and "cancellation is hoped for".
           *
           * `raceCancellation` also consumes a late settlement, so a provider that answers after the
           * abort produces a discarded result rather than an unhandled rejection or a double settle.
           */
          res = await raceCancellation(
            provider.complete(
              {
                modelId: route.modelId,
                system: req.pack.renderedSystem,
                user: req.pack.renderedUser,
                params,
                trace: {
                  role: req.role,
                  activityId: req.activityId,
                  idempotencyKey: req.idempotencyKey,
                },
              },
              handle.signal,
            ),
            handle,
            (outcome) => {
              // A late SUCCESS is discarded (its content must never be persisted or reach canon) but its
              // usage is preserved truthfully, because tokens the provider reported were really produced.
              // A late FAILURE must not overwrite the authoritative cancellation.
              responseDiscarded = true;
              // A provider answered AFTER an authoritative cancellation. Counted where the discard
              // actually happens, so the metric cannot disagree with the audit record.
              this.count(METRIC.lateResponses, { outcome: outcome.ok ? 'success' : 'failure' });
              this.count(METRIC.discardedArtifacts, { reason: 'late_response' });
              if (outcome.ok) discardedUsage = outcome.value.usage;
            },
          );
        } catch (err) {
          if (isCancellationError(err)) {
            /**
             * A cancellation is settled here and never classified as a provider failure: an operator's
             * decision is not a fault, and must not be rerouted, repaired or retried.
             *
             * The attempt is still recorded first. It really happened — a request went to a provider —
             * and dropping it would leave the call's `attempt` counter without a matching attribution,
             * which is exactly the reconciliation `verifyCostInvariants` checks. Its cost is whatever the
             * provider reported (usually nothing), never an invented figure.
             */
            attemptRecords.push({
              attempt,
              model_id: route.modelId,
              provider: route.provider,
              outcome: 'failed',
              failure_class: 'cancelled',
              error_class: 'CANCELLED',
              cost_cents: 0,
              usage: err.detail.usage ?? { input: 0, output: 0, cached: 0 },
              latency_ms: 0,
            });
            await settleCancelled(err, route, false);
          }
          // Fallback is authorized ONLY for a policy-retryable failure. A rejected request, an auth
          // failure, a content refusal or an unrecognized fault stops here: re-sending the same bytes to
          // the next paid model would multiply spend without any prospect of a different answer.
          const failureClass = classifyProviderFailure(err);
          lastFailureClass = failureClass;
          lastError = {
            class: 'PROVIDER_FAILED',
            message: err instanceof Error ? err.message : String(err),
          };
          attemptRecords.push({
            attempt,
            model_id: route.modelId,
            provider: route.provider,
            outcome: 'failed',
            failure_class: failureClass,
            error_class: 'PROVIDER_FAILED',
            cost_cents: 0,
            usage: { input: 0, output: 0, cached: 0 },
            latency_ms: 0,
          });
          this.count(METRIC.providerAttempts, {
            provider: route.provider,
            model_class: req.modelClass,
            status: 'failed',
          });
          if (!isRetryable(failureClass)) break;
          // Only a retryable class reaches here, which is exactly when a further attempt is
          // authorized -- so this is the honest place to count a retry and a route fallback.
          this.count(METRIC.retries, { reason: failureClass });
          this.count(METRIC.fallbacks, { reason: failureClass });
          fallbackFrom = route.modelId;
          routeIdx++;
          continue;
        } finally {
          /**
           * The concurrency lease covers the provider request and nothing more.
           *
           * Releasing in a `finally` on the attempt itself is what makes success, provider failure,
           * timeout and cancellation all give the slot back — and `release()` is idempotent and safe
           * after expiry, so a lease reclaimed by its deadline while this attempt was still running
           * cannot be double-released. A process that dies here strands nothing permanently: the
           * lease's own deadline reclaims it.
           */
          if (grant) await grant.release();
        }
        const attemptCost = costCents(route, res.usage);
        actualCost += attemptCost;

        const noteAttempt = (outcome: 'succeeded' | 'failed', errorClass?: string): void => {
          attemptRecords.push({
            attempt,
            model_id: route.modelId,
            provider: route.provider,
            outcome,
            ...(errorClass ? { error_class: errorClass } : {}),
            cost_cents: attemptCost,
            usage: res.usage,
            latency_ms: res.latencyMs,
          });
        };

        // 3. truncation
        if (res.finishReason === 'length') {
          lastError = { class: 'TRUNCATED', message: 'provider stopped at max_tokens' };
          noteAttempt('failed', 'TRUNCATED');
          if (attempt < 2) continue; // one regeneration on the same route
          routeIdx++;
          continue;
        }

        // 4. structured output
        let json: unknown = res.json;
        let schemaValid = true;
        if (validator || req.outputSchemaRef) {
          if (json === undefined && res.text !== undefined) {
            try {
              json = JSON.parse(stripFences(res.text));
            } catch {
              json = undefined;
            }
          }
          if (json === undefined) {
            schemaValid = false;
          } else if (validator) {
            const v = validator(json);
            schemaValid = v.ok;
          }
          if (!schemaValid) {
            repairAttempts++;
            this.count(METRIC.repairs, { reason: 'schema_invalid' });
            lastError = { class: 'SCHEMA_INVALID', message: 'structured output did not validate' };
            noteAttempt('failed', 'SCHEMA_INVALID');
            if (repairAttempts <= 2) continue; // bounded repair = regenerate on the same route
            routeIdx++;
            continue;
          }
        }

        // 5. output-language check for manuscript roles (OUTPUT-EN-001)
        let languageCheck: GatewayResponse['outputLanguageCheck'] = { performed: false };
        if (req.manuscriptProducing) {
          const prose = extractProse(json, res.text);
          const check = checkOutputLanguage(toNfcText(prose), {
            minConfidence: this.opts.minEnglishConfidence ?? 0.99,
            allowlist: this.opts.allowlistTerms ?? [],
          });
          languageCheck = {
            performed: true,
            passed: check.passed,
            englishConfidence: check.english_confidence,
          };
          if (!check.passed) {
            languageFailures++;
            lastError = {
              class: 'OUTPUT_LANGUAGE_FAILED',
              message: `English confidence ${check.english_confidence}; offending: ${check.offending_segments.map((s) => s.paragraph_id).join(',')}`,
            };
            noteAttempt('failed', 'OUTPUT_LANGUAGE_FAILED');
            // discard; regenerate once on the same route, then reroute to the alternate P-class model
            if (languageFailures === 1) continue;
            fallbackFrom = route.modelId;
            routeIdx++;
            continue;
          }
        }

        // 6. success → audit
        noteAttempt('succeeded');
        const status =
          fallbackFrom && fallbackFrom !== route.modelId ? 'fallback_succeeded' : 'succeeded';
        const output = { text: res.text, json };
        const record = this.record(
          req,
          guard,
          route,
          params,
          res,
          actualCost,
          status,
          res.finishReason,
          schemaValid,
          repairAttempts,
          undefined,
          fallbackFrom,
          languageCheck,
          output,
          attempt,
          attemptRecords,
        );
        await this.opts.audit.append(record);
        await reservation.release(actualCost);
        this.count(METRIC.providerAttempts, {
          provider: route.provider,
          model_class: req.modelClass,
          status: 'succeeded',
        });
        this.count(METRIC.budgetSettlements, { scope_kind: 'job', outcome: 'known' });
        return this.fromAudit(record, false);
      }
      // exhausted
      const failRoute = routes[Math.min(routeIdx, routes.length - 1)] ?? primary;
      await this.opts.audit.append(
        this.record(
          req,
          guard,
          failRoute,
          params,
          undefined,
          actualCost,
          'failed',
          'error',
          false,
          repairAttempts,
          lastError ?? { class: 'PROVIDER_FAILED', message: 'exhausted routes' },
          fallbackFrom,
          undefined,
          undefined,
          attempt,
          attemptRecords,
        ),
      );
      await reservation.release(actualCost);
      const cls = (lastError?.class ?? 'PROVIDER_FAILED') as GatewayError['code'];
      // The surfaced error names the classification that stopped the call, so an operator can tell a
      // refused request from an exhausted set of retryable routes. Causal detail only; never prose.
      throw new GatewayError(
        cls,
        lastFailureClass
          ? `${lastError?.message ?? 'all routes failed'} [failure_class=${lastFailureClass}]`
          : (lastError?.message ?? 'all routes failed'),
      );
    } catch (err) {
      if (!(err instanceof GatewayError)) {
        await reservation.release(actualCost);
      }
      throw err;
    }
  }

  private record(
    req: GatewayRequest,
    guard: ReturnType<typeof guardRequest>,
    route: RouteEntry,
    params: ModelParams,
    res: ProviderResponse | undefined,
    cost: number,
    status: AuditRecord['status'],
    finish: FinishReason,
    schemaValid: boolean,
    repairAttempts: number,
    error?: { class: string; message: string },
    fallbackFrom?: string,
    languageCheck?: GatewayResponse['outputLanguageCheck'],
    output?: { text?: string | undefined; json?: unknown },
    attempt = 1,
    attemptRecords?: AuditRecord['attempt_records'],
  ): AuditRecord {
    const now = (this.opts.clock ?? (() => new Date()))();
    const outText =
      output?.text ?? (output?.json !== undefined ? JSON.stringify(output.json) : undefined);
    return {
      id: uuidv7(now.getTime()),
      idempotency_key: req.idempotencyKey,
      activity_id: req.activityId,
      role: req.role,
      prompt_version_id: req.promptVersionId,
      prompt_hash: req.promptHash,
      pack_id: req.pack.id,
      pack_hash: req.pack.hash,
      production_policy_version: req.productionPolicyVersion,
      narrative_identity_version_id: req.narrativeIdentityRef?.identityVersionId,
      narrative_block_hash: guard.blockHash,
      output_language_contract_hash: guard.outputLanguageContractHash,
      tradition_contract_hash: guard.traditionContractHash,
      output_language_check: languageCheck?.performed
        ? {
            performed: true,
            passed: languageCheck.passed,
            english_confidence: languageCheck.englishConfidence,
          }
        : { performed: false },
      model_id: route.modelId,
      model_class: req.modelClass,
      provider: route.provider,
      params,
      usage: res?.usage ?? { input: 0, output: 0, cached: 0 },
      cost_cents: cost,
      latency_ms: res?.latencyMs ?? 0,
      attempt,
      status,
      finish_reason: finish,
      schema_valid: schemaValid,
      repair_attempts: repairAttempts,
      fallback_from_model_id: fallbackFrom,
      error,
      ...(attemptRecords && attemptRecords.length > 0 ? { attempt_records: attemptRecords } : {}),
      input_hash: sha(`${req.pack.renderedSystem}\u0000${req.pack.renderedUser}`),
      output_hash: outText !== undefined ? sha(outText) : undefined,
      output,
      created_at: now.toISOString(),
    };
  }

  /**
   * The audit row for a cancelled call.
   *
   * TRUTHFULNESS IS THE ONLY DESIGN RULE HERE. Three things are deliberately NOT inferred:
   *
   *  * remote state — `remote_cancellation` comes from the adapter's own verdict and defaults to
   *    `unknown`. Nothing claims the provider stopped computing without a positive acknowledgement.
   *  * usage — usage the provider actually reported (including on a discarded late success) is recorded;
   *    usage it never reported is `unknown`, not zero. A missing token count and a real zero are
   *    different facts and only one of them is safe to sum.
   *  * billing — `billing_status` is `known` only when priced usage exists. An aborted socket is not
   *    evidence that nothing will be billed.
   *
   * Cost stays integer-safe: it reuses the same `costCents` arithmetic as every other row, so the
   * millicent reconciliation in `@yeonjae/db`'s cost accounting continues to balance.
   */
  private cancelledRecord(
    req: GatewayRequest,
    guard: ReturnType<typeof guardRequest>,
    route: RouteEntry,
    params: ModelParams,
    input: {
      readonly error: unknown;
      readonly actualCost: number;
      readonly attempt: number;
      readonly attemptRecords: NonNullable<AuditRecord['attempt_records']>;
      readonly repairAttempts: number;
      readonly beforeFirstAttempt: boolean;
      readonly requestedAt?: string | undefined;
      readonly responseDiscarded?: boolean | undefined;
      readonly discardedUsage?: ProviderResponse['usage'] | undefined;
      readonly fallbackFrom?: string | undefined;
    },
  ): AuditRecord {
    const cancelled = isCancellationError(input.error) ? input.error : undefined;
    const reason: CancellationReason = cancelled?.reason ?? 'operator_cancelled';
    const now = (this.opts.clock ?? (() => new Date()))();
    const reportedUsage = input.discardedUsage ?? cancelled?.detail.usage;
    // Only usage the provider genuinely reported is priced. A cancelled call with no reported usage
    // carries the cost already accrued by earlier completed attempts and nothing invented for this one.
    const cost = reportedUsage
      ? input.actualCost + costCents(route, reportedUsage)
      : input.actualCost;
    const base = this.record(
      req,
      guard,
      route,
      params,
      undefined,
      cost,
      'cancelled',
      'error',
      false,
      input.repairAttempts,
      {
        class: 'CANCELLED',
        // Reason only: no prompt, prose, provider payload or header ever reaches an audit message.
        message: `call cancelled (${reason})`,
      },
      input.fallbackFrom,
      undefined,
      undefined,
      input.attempt,
      input.attemptRecords,
    );
    return {
      ...base,
      // Usage on the row itself stays the observed value; `usage_status` below states whether it is real.
      ...(reportedUsage ? { usage: reportedUsage } : {}),
      cancellation: {
        reason,
        outcome: input.responseDiscarded
          ? 'late_result_discarded'
          : isAuthoritativeCancellation(reason)
            ? reason
            : 'timeout',
        remote_cancellation: cancelled?.remoteCancellation ?? 'unknown',
        usage_status: reportedUsage ? 'reported' : 'unknown',
        billing_status: reportedUsage ? 'known' : 'unknown',
        ...(input.requestedAt ? { requested_at: input.requestedAt } : {}),
        aborted_at: cancelled?.detail.abortedAt ?? now.toISOString(),
        response_discarded: input.responseDiscarded ?? false,
        before_first_attempt: input.beforeFirstAttempt,
      },
    };
  }

  private fromAudit(r: AuditRecord, replayed: boolean): GatewayResponse {
    return {
      llmCallId: r.id,
      modelId: r.model_id,
      provider: r.provider,
      output: r.output ?? {},
      finishReason: r.finish_reason,
      usage: r.usage,
      costCents: r.cost_cents,
      latencyMs: r.latency_ms,
      schemaValid: r.schema_valid,
      attempts: r.attempt,
      outputLanguageCheck: r.output_language_check?.performed
        ? {
            performed: true,
            passed: r.output_language_check.passed ?? false,
            englishConfidence: r.output_language_check.english_confidence ?? 0,
          }
        : { performed: false },
      replayed,
    };
  }
}

function stripFences(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (m?.[1] ?? text).trim();
}

/** Manuscript roles return prose inside JSON (`text`, `new_text`, seam patches); collect every prose field. */
export function extractProse(json: unknown, text: string | undefined): string {
  const parts: string[] = [];
  const walk = (v: unknown, key?: string) => {
    if (typeof v === 'string') {
      if (key === 'text' || key === 'new_text' || key === 'title') parts.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
    }
  };
  walk(json);
  if (parts.length === 0 && text) parts.push(text);
  return parts.join('\n\n');
}
