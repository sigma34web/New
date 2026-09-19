/**
 * Bounded process lifecycle: running → draining → stopped.
 *
 * WHY A SHARED STATE MACHINE. The API and the worker both need the same behaviour — stop accepting
 * work, let in-flight work finish within a deadline, close shared resources exactly once, and never
 * hang — and both would otherwise grow their own subtly different version of it. The parts that differ
 * (what "accepting work" means) are injected; the parts that must not differ live here.
 *
 * Three properties are the whole point, and each is a real failure mode:
 *
 *   * READINESS FAILS THE INSTANT DRAIN BEGINS, before anything closes. A load balancer needs to stop
 *     sending work while the process can still serve what it already has; failing readiness only after
 *     the pool closed would send traffic to a process that can no longer answer it.
 *   * THE DEADLINE IS ENFORCED. A drain that waits indefinitely for a stuck request is an outage
 *     during every deploy, so the deadline fires and remaining work is cancelled through the existing
 *     cancellation path rather than abandoned.
 *   * SHUTDOWN IS IDEMPOTENT. Two signals arrive together far more often than anyone expects
 *     (SIGINT from a terminal plus SIGTERM from an orchestrator), and closing a pool twice throws.
 */
import { METRIC, METRIC_HELP, type Metrics } from './metrics.js';

export type LifecycleState = 'starting' | 'running' | 'draining' | 'stopped';

/** Why the process stopped. Distinguishable exit codes depend on this being a closed set. */
export type StopOutcome =
  'clean' | 'deadline_exceeded' | 'dependency_failure' | 'configuration_failure';

/** Exit codes, so an operator and an orchestrator can tell these apart without parsing logs. */
export const EXIT_CODE: Readonly<Record<StopOutcome, number>> = {
  clean: 0,
  configuration_failure: 78, // EX_CONFIG
  dependency_failure: 69, // EX_UNAVAILABLE
  deadline_exceeded: 75, // EX_TEMPFAIL: work was still running when the deadline fired
};

export interface Closeable {
  readonly name: string;
  /** Must be safe to call once. The coordinator guarantees it is not called twice. */
  close(): Promise<void>;
}

export interface DrainOptions {
  /** How long in-flight work may take before it is cancelled. */
  readonly deadlineMs: number;
  /** Bounded separately: a telemetry backend must never be able to hang a shutdown. */
  readonly telemetryFlushMs?: number | undefined;
  readonly metrics?: Metrics | undefined;
  /** Injected so tests drive the deadline instead of sleeping. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface DrainResult {
  readonly outcome: StopOutcome;
  readonly exitCode: number;
  /** Work still running when the deadline fired, and therefore cancelled. */
  readonly abandoned: number;
  readonly closed: readonly string[];
  /** Resources whose close() threw. Recorded, never swallowed, and never fatal to the drain. */
  readonly closeFailures: readonly { name: string; reason: string }[];
  readonly telemetryFlushed: boolean;
  readonly durationMs: number;
}

/**
 * Coordinates one process's shutdown.
 *
 * `inFlight` is a count rather than a set of promises on purpose: the coordinator must work for the
 * API (requests it does not own) and the worker (activities Temporal owns) alike, and neither hands
 * over an awaitable it is safe to hold.
 */
export class LifecycleCoordinator {
  private state: LifecycleState = 'starting';
  private inFlight = 0;
  private readonly closeables: Closeable[] = [];
  private drainPromise: Promise<DrainResult> | undefined;
  private readonly cancelHandlers: (() => void)[] = [];
  private telemetryFlush: (() => Promise<void>) | undefined;

  constructor(private readonly opts: DrainOptions) {}

  private now(): number {
    // Monotonic by default: a wall clock can step backwards and make a deadline fire early or never.
    return (this.opts.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n)))();
  }

  markRunning(): void {
    if (this.state === 'starting') this.state = 'running';
  }

  current(): LifecycleState {
    return this.state;
  }

  /** True only while the process should receive NEW work. */
  acceptingWork(): boolean {
    return this.state === 'running';
  }

  /**
   * Readiness, as a probe endpoint should report it.
   *
   * A draining process is deliberately NOT ready while remaining perfectly alive: that pair is what
   * tells an orchestrator to stop routing without killing the process mid-request.
   */
  ready(): boolean {
    return this.state === 'running';
  }

  /** Liveness stays true until the process actually stops, and never depends on a dependency probe. */
  live(): boolean {
    return this.state !== 'stopped';
  }

  register(closeable: Closeable): void {
    this.closeables.push(closeable);
  }

  onForceCancel(handler: () => void): void {
    this.cancelHandlers.push(handler);
  }

  setTelemetryFlush(flush: () => Promise<void>): void {
    this.telemetryFlush = flush;
  }

  /** Called when work starts. Returns false when the process is draining and must refuse it. */
  beginWork(): boolean {
    if (!this.acceptingWork()) return false;
    this.inFlight += 1;
    return true;
  }

  endWork(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  inFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Drain and stop.
   *
   * Idempotent by returning the SAME promise to every caller, so two signals produce one shutdown and
   * the second caller observes the first one's result instead of starting a parallel close.
   */
  drain(): Promise<DrainResult> {
    if (this.drainPromise) return this.drainPromise;
    /**
     * The state flips SYNCHRONOUSLY, before the first await.
     *
     * Doing it inside the async body would leave a window in which `drain()` has been called and
     * `ready()` still answers true -- which is precisely the window a load balancer would use to send
     * one more request into a process that is shutting down.
     */
    this.state = 'draining';
    this.count(METRIC.workflowStates, { state: 'draining' });
    this.drainPromise = this.runDrain();
    return this.drainPromise;
  }

  private async runDrain(): Promise<DrainResult> {
    const started = this.now();

    const sleep =
      this.opts.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          // Never let the drain's own timer be the thing keeping the process alive.
          if (typeof timer.unref === 'function') timer.unref();
        }));

    // Wait for in-flight work, bounded. Polls rather than awaits, because the work is owned elsewhere.
    const step = Math.max(1, Math.min(25, this.opts.deadlineMs));
    while (this.inFlight > 0 && this.now() - started < this.opts.deadlineMs) {
      await sleep(step);
    }

    const abandoned = this.inFlight;
    if (abandoned > 0) {
      // The deadline fired. Remaining work is CANCELLED through the existing cancellation path, so a
      // provider request in flight is aborted and its cost recorded as unknown rather than abandoned
      // silently.
      for (const handler of this.cancelHandlers) handler();
    }

    let telemetryFlushed = false;
    if (this.telemetryFlush) {
      // Bounded independently: a telemetry backend must never hold a deploy open.
      const flushBudget = this.opts.telemetryFlushMs ?? 2_000;
      telemetryFlushed = await Promise.race([
        this.telemetryFlush().then(
          () => true,
          // A failed flush loses metrics, which is not worth failing a shutdown over.
          () => false,
        ),
        sleep(flushBudget).then(() => false),
      ]);
    }

    const closed: string[] = [];
    const closeFailures: { name: string; reason: string }[] = [];
    for (const closeable of this.closeables) {
      try {
        await closeable.close();
        closed.push(closeable.name);
      } catch (err) {
        // Recorded and carried on: one resource refusing to close must not strand the others open,
        // which is exactly what an early `throw` here would do.
        closeFailures.push({
          name: closeable.name,
          reason: err instanceof Error ? err.name : 'unknown',
        });
      }
    }

    this.state = 'stopped';
    const outcome: StopOutcome =
      abandoned > 0
        ? 'deadline_exceeded'
        : closeFailures.length > 0
          ? 'dependency_failure'
          : 'clean';
    this.count(METRIC.workflowStates, { state: 'stopped' });
    return {
      outcome,
      exitCode: EXIT_CODE[outcome],
      abandoned,
      closed,
      closeFailures,
      telemetryFlushed,
      durationMs: this.now() - started,
    };
  }

  private count(name: string, labels: Readonly<Record<string, string>>): void {
    this.opts.metrics?.increment(name, METRIC_HELP[name] ?? '', labels);
  }
}
