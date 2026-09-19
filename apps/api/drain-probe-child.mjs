/**
 * A child process that runs the REAL API server with the REAL lifecycle coordinator (Workstream C).
 *
 * Why a child process rather than an in-process test: a signal handler, a process that must actually
 * exit, the exit code an orchestrator reads, and "nothing leaked" are all claims that cannot be made
 * from inside the process under test. This child runs `buildApi` exactly as `main.ts` does and reports
 * its state as JSON lines, so the parent synchronises on what the child DID rather than on elapsed
 * time — there are no sleeps used for coordination anywhere in this suite.
 *
 * Fault injection is by environment variable so each failure mode (telemetry hangs, telemetry fails,
 * a close that throws, partial initialization, a signal during startup) is a real process in that
 * state rather than a mock.
 */
import { createPool } from '../../packages/db/dist/client.js';
import { LifecycleCoordinator } from '../../packages/domain/dist/lifecycle-drain.js';
import { Metrics } from '../../packages/domain/dist/metrics.js';
import { buildApi } from './dist/server.js';

const say = (event, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ event, ...extra })}\n`);
};

const pool = createPool({ connectionString: process.env.DATABASE_URL, max: 2 });
const metrics = new Metrics();
const lifecycle = new LifecycleCoordinator({
  deadlineMs: Number(process.env.YEONJAE_DRAIN_DEADLINE_MS ?? '2000'),
  telemetryFlushMs: Number(process.env.YEONJAE_TELEMETRY_FLUSH_MS ?? '500'),
  metrics,
});

if (process.env.YEONJAE_TELEMETRY_HANGS === '1') {
  lifecycle.setTelemetryFlush(() => new Promise(() => {}));
} else if (process.env.YEONJAE_TELEMETRY_FAILS === '1') {
  lifecycle.setTelemetryFlush(() => Promise.reject(new Error('exporter down')));
} else if (process.env.YEONJAE_TELEMETRY_OK === '1') {
  lifecycle.setTelemetryFlush(() => Promise.resolve());
}

const app = buildApi({
  pool,
  secureCookies: false,
  metrics,
  lifecycle,
});

// A resource whose close() throws, to prove one failing close never strands the others open.
if (process.env.YEONJAE_CLOSE_FAILS === '1') {
  lifecycle.register({
    name: 'broken',
    close: () => Promise.reject(new TypeError('connection reset')),
  });
}
lifecycle.register({ name: 'http', close: () => app.close() });
lifecycle.register({ name: 'pool', close: () => pool.end() });

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

// Partial initialization: handlers exist and resources are registered, but the process never becomes
// ready. A signal here must still drain and close cleanly rather than hang or skip teardown.
if (process.env.YEONJAE_SHUTDOWN_DURING_STARTUP === '1') {
  say('listening', { port: 0, partial: true });
} else {
  await app.listen({ port: 0, host: '127.0.0.1' });
  lifecycle.markRunning();
  const address = app.server.address();
  /**
   * Announced only AFTER the handlers are installed and the socket is accepting.
   *
   * The parent signals the moment it sees this line; announcing earlier would leave a window in which
   * SIGINT hits Node's default disposition and kills the process outright, with no drain and no exit
   * code. That is a real startup race, not a test artifact.
   */
  say('listening', { port: typeof address === 'object' && address ? address.port : 0 });
}

process.on('message', (msg) => {
  if (msg === 'release') {
    lifecycle.endWork();
    say('work_released');
  }
  if (msg === 'hold') {
    // Simulated in-flight work the drain must wait for, taken through the same counter real requests
    // use.
    say(lifecycle.beginWork() ? 'work_held' : 'work_refused');
  }
});

setInterval(() => {}, 1_000).unref();
