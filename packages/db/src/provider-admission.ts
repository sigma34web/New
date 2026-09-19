/**
 * Shared provider admission: the control that sits in front of every paid attempt (migration 0015).
 *
 * WHY THIS EXISTS. `rate-limits.ts` gave the database the two primitives — a fixed-window counter and an
 * expiring concurrency lease — but nothing in the gateway consulted them, so the only limiter in front of
 * a provider was the per-process one in `apps/api`, which limits nothing once the worker runs twice. This
 * module is the adapter that makes the shared controls reachable from a single call site in the gateway.
 *
 * Two decisions are worth stating because they are not arbitrary:
 *
 *   - THE LEASE IS TAKEN BEFORE THE WINDOW COUNT. A fixed-window admission cannot be un-consumed, while a
 *     lease can be released. Acquiring the un-undoable resource second means a refusal unwinds exactly,
 *     which is the "partial acquisition unwinds safely" property; the reverse order would burn rate
 *     allowance on a call that never ran.
 *   - AN UNCONFIGURED SCOPE IS UNLIMITED, NOT REFUSED. A limiter with no policy must not brick the worker.
 *     Whether shared enforcement is *required at all* is a startup decision (see `apps/worker/src/deps.ts`),
 *     which is the right place for it: failing closed there names a misconfiguration, whereas failing
 *     closed here would only mean "nobody wrote a policy row yet".
 *
 * The gateway's interface is restated locally rather than imported, for the same reason `SharedBudget`
 * restates `BudgetLedger`: the dependency runs gateway → db, never the other way.
 */
import { METRIC, METRIC_HELP, type Metrics } from '@yeonjae/domain';
import { type Client, type Pool } from './client.js';
import {
  acquireSlot,
  releaseSlot,
  resolveRateLimitPolicy,
  scopeKeyFor,
  waitForAdmission,
  type Clock,
  type OperationClass,
} from './rate-limits.js';

type Queryable = Pool | Client;

/** Why a call was admitted or refused. Closed set, so it is safe as a metric label. */
export type AdmissionReason =
  | 'unlimited'
  | 'admitted'
  | 'admitted_replay'
  | 'rejected_replay'
  | 'request_limit'
  | 'token_limit'
  | 'concurrency_exhausted';

export interface AdmissionGrant {
  readonly admitted: boolean;
  readonly reason: AdmissionReason;
  /** Exact milliseconds until the window reopens; 0 when the refusal is not time-based. */
  readonly retryAfterMs: number;
  readonly waitedMs: number;
  /** Idempotent, safe after expiry, and safe to call on a refused grant. */
  release(): Promise<void>;
}

export interface AdmissionRequest {
  readonly workspaceId?: string | undefined;
  readonly provider: string;
  readonly modelId: string;
  /**
   * Stable per ATTEMPT, not per call: a retry is a second request against the provider and must earn its
   * own admission, while a redelivered attempt with the same id re-reads its own decision instead of
   * consuming a second slot.
   */
  readonly requestId: string;
  readonly tokens?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** What the gateway depends on. `NoOpAdmission` and `PgProviderAdmission` both satisfy it. */
export interface ProviderAdmission {
  admit(req: AdmissionRequest): Promise<AdmissionGrant>;
}

const NOOP_RELEASE = (): Promise<void> => Promise.resolve();

function unlimited(): AdmissionGrant {
  return {
    admitted: true,
    reason: 'unlimited',
    retryAfterMs: 0,
    waitedMs: 0,
    release: NOOP_RELEASE,
  };
}

/**
 * Explicit "no shared limiting", for isolated unit tests that construct a gateway without a database.
 *
 * It is a NAMED class rather than an `undefined` default so that a test which wants no limiter says so,
 * and so a production path that somehow ended up here is visible by type rather than by absence.
 */
export class NoOpAdmission implements ProviderAdmission {
  async admit(): Promise<AdmissionGrant> {
    return unlimited();
  }
}

export class PgProviderAdmission implements ProviderAdmission {
  constructor(
    private readonly db: Queryable,
    private readonly opts: {
      readonly clock?: Clock | undefined;
      /** Identifies the holder of a concurrency lease, so a dead process's slot is attributable. */
      readonly holder: string;
      readonly operationClass?: OperationClass | undefined;
      readonly leaseTtlSeconds?: number | undefined;
      /** Bounded: a caller must never block forever behind a saturated limit. */
      readonly maxWaitMs?: number | undefined;
      readonly sleep?: ((ms: number) => Promise<void>) | undefined;
      readonly metrics?: Metrics | undefined;
    },
  ) {}

  private count(name: string, labels: Readonly<Record<string, string>>): void {
    this.opts.metrics?.increment(name, METRIC_HELP[name] ?? '', labels);
  }

  private now(): Date {
    return (this.opts.clock ?? (() => new Date()))();
  }

  async admit(req: AdmissionRequest): Promise<AdmissionGrant> {
    const operationClass = this.opts.operationClass ?? 'provider_call';
    const scope = {
      ...(req.workspaceId !== undefined ? { workspaceId: req.workspaceId } : {}),
      provider: req.provider,
      modelId: req.modelId,
      operationClass,
    };
    const policy = await resolveRateLimitPolicy(this.db, scope);
    if (!policy) return unlimited();

    const scopeKey = scopeKeyFor(policy, scope);
    const clock: Clock = this.opts.clock ?? ((): Date => new Date());

    // The releasable resource first, so a refusal below unwinds completely.
    let slotHeld = false;
    if (policy.max_concurrent !== null) {
      const slot = await acquireSlot(this.db, policy, {
        scopeKey,
        requestId: req.requestId,
        holder: this.opts.holder,
        ttlSeconds: this.opts.leaseTtlSeconds ?? 300,
        now: this.now(),
      });
      if (!slot) {
        return {
          admitted: false,
          reason: 'concurrency_exhausted',
          retryAfterMs: 0,
          waitedMs: 0,
          release: NOOP_RELEASE,
        };
      }
      slotHeld = true;
    }

    const releaseSlotOnce = async (): Promise<void> => {
      if (!slotHeld) return;
      slotHeld = false;
      const released = await releaseSlot(this.db, policy, {
        scopeKey,
        requestId: req.requestId,
        now: this.now(),
      });
      // `false` means the row was no longer live: the lease had already been reclaimed by its
      // deadline while this caller still believed it held the slot. That is a real operational
      // signal (a call outlived its lease) and it is the only place it is observable.
      this.count(released ? METRIC.concurrencyAcquired : METRIC.leaseExpired, {
        provider: req.provider,
        ...(released ? { outcome: 'released' } : { reason: 'expired_before_release' }),
      });
    };

    let decision;
    try {
      decision = await waitForAdmission(this.db, policy, {
        scopeKey,
        requestId: req.requestId,
        ...(req.tokens !== undefined ? { tokens: req.tokens } : {}),
        clock,
        maxWaitMs: this.opts.maxWaitMs ?? 0,
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...(this.opts.sleep !== undefined ? { sleep: this.opts.sleep } : {}),
      });
    } catch (err) {
      // A cancelled or failed wait must not strand the lease it already holds.
      await releaseSlotOnce();
      throw err;
    }

    if (!decision.admitted) {
      await releaseSlotOnce();
      return {
        admitted: false,
        reason: decision.reason,
        retryAfterMs: decision.retryAfterMs,
        waitedMs: decision.waitedMs,
        release: NOOP_RELEASE,
      };
    }

    return {
      admitted: true,
      reason: decision.reason,
      retryAfterMs: 0,
      waitedMs: decision.waitedMs,
      release: releaseSlotOnce,
    };
  }
}
