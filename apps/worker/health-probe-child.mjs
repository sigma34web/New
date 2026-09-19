/**
 * A child process that runs the worker's real health surface and lifecycle coordinator.
 *
 * Runs the REAL `startWorkerHealthServer` and `LifecycleCoordinator` against a real database, but
 * deliberately not the Temporal worker: this suite is about signals, probes and resource teardown,
 * and a Temporal dependency would make every case a test of Temporal's availability instead.
 *
 * It reports state as JSON lines so the parent synchronises on what the child actually did, never on
 * elapsed time.
 */
import { createPool } from '../../packages/db/dist/client.js';
import { LifecycleCoordinator } from '../../packages/domain/dist/lifecycle-drain.js';
import { startWorkerHealthServer } from './dist/health.js';

const say = (event, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ event, ...extra })}\n`);
};

const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 2 });
const lifecycle = new LifecycleCoordinator({
  deadlineMs: Number(process.env.YEONJAE_DRAIN_DEADLINE_MS ?? '2000'),
  telemetryFlushMs: Number(process.env.YEONJAE_TELEMETRY_FLUSH_MS ?? '500'),
});

if (process.env.YEONJAE_TELEMETRY_HANGS === '1') {
  lifecycle.setTelemetryFlush(() => new Promise(() => {}));
} else if (process.env.YEONJAE_TELEMETRY_FAILS === '1') {
  lifecycle.setTelemetryFlush(() => Promise.reject(new Error('exporter down')));
}

const health = await startWorkerHealthServer({ pool, lifecycle, port: 0 });
lifecycle.register({ name: 'health', close: () => health.close() });
if (process.env.YEONJAE_CLOSE_FAILS === '1') {
  lifecycle.register({
    name: 'temporal',
    close: () => Promise.reject(new TypeError('connection reset')),
  });
}
lifecycle.register({ name: 'pool', close: () => pool.end() });

if (process.env.YEONJAE_SHUTDOWN_DURING_STARTUP !== '1') lifecycle.markRunning();
// Simulated work, so a test can drain a BUSY process. Taken AFTER markRunning: beginWork correctly
// refuses while the coordinator is still 'starting', which silently made these cases drain as idle.
if (process.env.YEONJAE_HOLD_WORK === '1' && !lifecycle.beginWork()) {
  say('error', { message: 'could not take work' });
}
let signals = 0;
const shutdown = () => {
  signals += 1;
  say('signal', { count: signals });
  void lifecycle.drain().then((result) => {
    say('drained', {
      outcome: result.outcome,
      exitCode: result.exitCode,
      abandoned: result.abandoned,
      closed: result.closed,
      closeFailures: result.closeFailures.map((f) => f.name),
      telemetryFlushed: result.telemetryFlushed,
      signals,
    });
    process.exit(result.exitCode);
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Announced only AFTER the handlers are installed.
 *
 * The parent signals as soon as it sees this line, so announcing earlier left a window in which
 * SIGINT hit Node's default disposition and killed the process outright -- no drain, no exit code.
 * That is a real startup race, not a test artifact: a supervisor can signal a process the instant it
 * reports itself up.
 */
say('listening', { port: health.port });

// Release simulated work on request, so a test can prove the drain waited for it.
process.on('message', (msg) => {
  if (msg === 'release') {
    lifecycle.endWork();
    say('work_released');
  }
});

// Keep the process alive on its own terms; the health server's handle already does this, but an
// explicit unref'd interval makes the intent obvious.
setInterval(() => {}, 1_000).unref();
