/**
 * API entry point. Configuration comes from the environment by NAME only; no secret is ever defaulted to a
 * usable value, so a missing variable fails loudly instead of starting an insecure server.
 *
 * The process lifecycle mirrors the worker's (Workstream C): the same `LifecycleCoordinator` runs the
 * running → draining → stopped machine, so "stop taking work, finish what you have, close once, never
 * hang" cannot drift between the two processes.
 */
import { configFromEnv, createPool } from '@yeonjae/db';
import { EXIT_CODE, LifecycleCoordinator, Metrics } from '@yeonjae/domain';
import { buildApi } from './server.js';
import { corsPolicyFromEnv } from './cors.js';

const pool = createPool(configFromEnv());
const metrics = new Metrics();
/**
 * The drain budget. Bounded and configurable for the same reason the worker's is: long enough for an
 * ordinary request to finish, short enough that one stuck request cannot hold a deploy open.
 */
const lifecycle = new LifecycleCoordinator({
  deadlineMs: Number(process.env.YEONJAE_DRAIN_DEADLINE_MS ?? '15000'),
  telemetryFlushMs: Number(process.env.YEONJAE_TELEMETRY_FLUSH_MS ?? '2000'),
  metrics,
});

const app = buildApi({
  pool,
  metrics,
  lifecycle,
  // Secure cookies unless explicitly disabled for local HTTP development.
  secureCookies: process.env.YEONJAE_INSECURE_COOKIES !== 'true',
  // Cross-origin browser access is DENIED unless origins are listed. An invalid entry throws here, at
  // startup, naming the value — a silently dropped typo would produce a deployment that looks configured
  // and refuses every browser request.
  corsOrigins: corsPolicyFromEnv().origins,
  // Proxies whose X-Forwarded-For may be believed for rate-limit identity. Empty means the socket address
  // is used, which is safe but coarse behind a load balancer.
  trustedProxies: (process.env.YEONJAE_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
  logger: true,
});

/**
 * Signal handlers are installed BEFORE the socket is listening.
 *
 * Until a handler exists, SIGTERM and SIGINT carry Node's default disposition — immediate termination,
 * no drain, no exit code — and an orchestrator can signal the instant it sees the process. Installing
 * them here closes that window. `drain()` is idempotent by construction, so two signals arriving
 * together (SIGINT from a terminal plus SIGTERM from a supervisor) produce ONE shutdown and the second
 * observes the first one's result rather than starting a parallel close.
 */
const onSignal = (): void => {
  void lifecycle.drain().then((result) => {
    process.exitCode = result.exitCode;
  });
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

/**
 * Resources close in DEPENDENCY ORDER: the HTTP server first, so nothing new arrives while the pool is
 * being torn down, then the pool, which in-flight requests may still need on their way out.
 */
lifecycle.register({ name: 'http', close: () => app.close() });
lifecycle.register({
  name: 'pool',
  close: async () => {
    await pool.end();
  },
});

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '127.0.0.1';
try {
  await app.listen({ port, host });
  // Announced as running only once the socket is actually accepting: marking it earlier would make
  // readiness true for a server that cannot yet answer.
  lifecycle.markRunning();
} catch (err) {
  // A port that cannot be bound is a configuration failure, not a transient dependency outage, and it
  // gets its own exit code so an orchestrator does not restart-loop a misconfiguration.
  console.error(err instanceof Error ? err.message : String(err));
  await lifecycle.drain();
  process.exit(EXIT_CODE.configuration_failure);
}
