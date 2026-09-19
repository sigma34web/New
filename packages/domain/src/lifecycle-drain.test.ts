/**
 * Bounded drain and shutdown.
 *
 * Time is injected everywhere: a drain test that waits on a wall clock is slow, flaky, or both. The
 * deadline cases advance a fake clock rather than sleeping, so they assert the boundary exactly.
 */
import { describe, expect, it } from 'vitest';
import { METRIC, Metrics } from './metrics.js';
import { EXIT_CODE, LifecycleCoordinator, type Closeable } from './lifecycle-drain.js';

/** A controllable clock plus a sleep that advances it, so a poll loop makes progress instantly. */
function fakeTime(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
} {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function closeable(name: string, onClose?: () => void | Promise<void>): Closeable {
  return {
    name,
    close: async () => {
      await onClose?.();
    },
  };
}

describe('lifecycle drain', () => {
  it('is ready and accepting only while running', () => {
    const c = new LifecycleCoordinator({ deadlineMs: 100 });
    expect(c.current()).toBe('starting');
    // Not ready before startup completes: a process mid-initialization must not receive traffic.
    expect(c.ready()).toBe(false);
    expect(c.acceptingWork()).toBe(false);
    c.markRunning();
    expect(c.ready()).toBe(true);
    expect(c.live()).toBe(true);
  });

  it('fails readiness the instant drain begins, while liveness stays true', async () => {
    const time = fakeTime();
    const c = new LifecycleCoordinator({ deadlineMs: 10_000, now: time.now, sleep: time.sleep });
    c.markRunning();
    // Hold one request open, so the drain is genuinely in progress when it is observed. An IDLE
    // drain runs to completion in one turn, which would make this assert the stopped state instead
    // of the draining one.
    c.beginWork();
    const drain = c.drain();
    // The window a load balancer needs: not ready, still alive, still serving what it holds.
    expect(c.ready()).toBe(false);
    expect(c.live()).toBe(true);
    expect(c.current()).toBe('draining');
    c.endWork();
    await drain;
    expect(c.live()).toBe(false);
    expect(c.current()).toBe('stopped');
  });

  it('refuses new work once draining', async () => {
    const time = fakeTime();
    const c = new LifecycleCoordinator({ deadlineMs: 50, now: time.now, sleep: time.sleep });
    c.markRunning();
    expect(c.beginWork()).toBe(true);
    c.endWork();
    const drain = c.drain();
    expect(c.beginWork()).toBe(false);
    await drain;
  });

  it('lets in-flight work finish before closing anything', async () => {
    const time = fakeTime();
    const closeOrder: string[] = [];
    const c = new LifecycleCoordinator({ deadlineMs: 10_000, now: time.now, sleep: time.sleep });
    c.markRunning();
    c.register(closeable('pool', () => closeOrder.push('pool')));
    expect(c.beginWork()).toBe(true);

    let finished = false;
    const drain = c.drain().then((r) => {
      finished = true;
      return r;
    });
    await Promise.resolve();
    // The pool must still be open while work is outstanding.
    expect(closeOrder).toEqual([]);
    expect(finished).toBe(false);
    c.endWork();
    const result = await drain;
    expect(result.outcome).toBe('clean');
    expect(result.abandoned).toBe(0);
    expect(closeOrder).toEqual(['pool']);
  });

  it('enforces the deadline and cancels what is still running', async () => {
    const time = fakeTime();
    let cancelled = 0;
    const c = new LifecycleCoordinator({ deadlineMs: 200, now: time.now, sleep: time.sleep });
    c.markRunning();
    c.onForceCancel(() => {
      cancelled += 1;
    });
    c.beginWork();
    c.beginWork();
    // Work never finishes; the deadline is what ends the drain.
    const result = await c.drain();
    expect(result.outcome).toBe('deadline_exceeded');
    expect(result.abandoned).toBe(2);
    expect(result.exitCode).toBe(EXIT_CODE.deadline_exceeded);
    // Remaining work is cancelled through the existing path, not abandoned silently.
    expect(cancelled).toBe(1);
  });

  it('is idempotent: two signals produce one shutdown and one close of each resource', async () => {
    const time = fakeTime();
    let closes = 0;
    const c = new LifecycleCoordinator({ deadlineMs: 50, now: time.now, sleep: time.sleep });
    c.markRunning();
    c.register(
      closeable('pool', () => {
        closes += 1;
      }),
    );
    // SIGINT from a terminal and SIGTERM from an orchestrator, arriving together.
    const [a, b] = await Promise.all([c.drain(), c.drain()]);
    expect(closes).toBe(1);
    // Both callers observe the same result rather than racing parallel shutdowns.
    expect(a).toBe(b);
  });

  it('closes every resource even when one throws, and reports the failure', async () => {
    const time = fakeTime();
    const closed: string[] = [];
    const c = new LifecycleCoordinator({ deadlineMs: 50, now: time.now, sleep: time.sleep });
    c.markRunning();
    c.register(closeable('temporal', () => Promise.reject(new TypeError('connection reset'))));
    c.register(closeable('pool', () => closed.push('pool')));
    const result = await c.drain();
    // The later resource still closed: an early throw would have stranded the database pool open.
    expect(closed).toEqual(['pool']);
    expect(result.closed).toEqual(['pool']);
    expect(result.closeFailures).toEqual([{ name: 'temporal', reason: 'TypeError' }]);
    expect(result.outcome).toBe('dependency_failure');
    // The reported reason is the error CLASS, never its message: a driver message can carry a DSN.
    expect(JSON.stringify(result)).not.toContain('connection reset');
  });

  it('bounds the telemetry flush so a hung backend cannot hold a deploy open', async () => {
    const time = fakeTime();
    const c = new LifecycleCoordinator({
      deadlineMs: 50,
      telemetryFlushMs: 100,
      now: time.now,
      sleep: time.sleep,
    });
    c.markRunning();
    // Never resolves. Without the bound, the drain would never finish.
    c.setTelemetryFlush(() => new Promise<void>(() => undefined));
    const result = await c.drain();
    expect(result.telemetryFlushed).toBe(false);
    // And the drain still completed cleanly: lost metrics are not worth failing a shutdown over.
    expect(result.outcome).toBe('clean');
  });

  it('a failing telemetry flush does not fail the shutdown', async () => {
    const time = fakeTime();
    const c = new LifecycleCoordinator({ deadlineMs: 50, now: time.now, sleep: time.sleep });
    c.markRunning();
    c.setTelemetryFlush(() => Promise.reject(new Error('exporter down')));
    const result = await c.drain();
    expect(result.telemetryFlushed).toBe(false);
    expect(result.outcome).toBe('clean');
  });

  it('records a successful flush', async () => {
    const time = fakeTime();
    const c = new LifecycleCoordinator({ deadlineMs: 50, now: time.now, sleep: time.sleep });
    c.markRunning();
    c.setTelemetryFlush(() => Promise.resolve());
    const result = await c.drain();
    expect(result.telemetryFlushed).toBe(true);
  });

  it('drains cleanly when shutdown arrives during startup, before running', async () => {
    const time = fakeTime();
    let closes = 0;
    const c = new LifecycleCoordinator({ deadlineMs: 50, now: time.now, sleep: time.sleep });
    // Never marked running: a signal during initialization must still close what was opened.
    c.register(
      closeable('pool', () => {
        closes += 1;
      }),
    );
    const result = await c.drain();
    expect(result.outcome).toBe('clean');
    expect(closes).toBe(1);
  });

  it('drains cleanly when idle', async () => {
    const time = fakeTime();
    const c = new LifecycleCoordinator({ deadlineMs: 1_000, now: time.now, sleep: time.sleep });
    c.markRunning();
    const result = await c.drain();
    expect(result.outcome).toBe('clean');
    expect(result.abandoned).toBe(0);
    // An idle drain must not burn its whole deadline waiting for nothing.
    expect(result.durationMs).toBeLessThan(1_000);
  });

  it('distinguishes outcomes by exit code', () => {
    expect(EXIT_CODE.clean).toBe(0);
    expect(new Set(Object.values(EXIT_CODE)).size).toBe(Object.keys(EXIT_CODE).length);
  });

  it('records drain transitions as metrics', async () => {
    const time = fakeTime();
    const metrics = new Metrics();
    const c = new LifecycleCoordinator({
      deadlineMs: 50,
      now: time.now,
      sleep: time.sleep,
      metrics,
    });
    c.markRunning();
    await c.drain();
    expect(metrics.total(METRIC.workflowStates, { state: 'draining' })).toBe(1);
    expect(metrics.total(METRIC.workflowStates, { state: 'stopped' })).toBe(1);
  });
});
