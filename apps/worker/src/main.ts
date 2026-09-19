/**
 * The durable orchestration worker entry point (Checkpoint 7).
 *
 * `YEONJAE_PROVIDER_MODE` decides how model calls are routed and there is deliberately no default that
 * reaches a paid provider: an unset mode is a startup error, not an implicit "go live". That is the same
 * rule the gateway already enforces for the CLI (no silent live calls), stated at the process boundary so
 * a misconfigured deployment fails before it can spend anything.
 */
import { NativeConnection, Worker } from '@temporalio/worker';
import { EXIT_CODE, LifecycleCoordinator, Metrics } from '@yeonjae/domain';
import { createActivities, poolFromEnv } from './activities.js';
import { CHAPTER_TASK_QUEUE } from './contracts.js';
import { startWorkerHealthServer } from './health.js';
import {
  assertSharedEnforcementAvailable,
  enforcementModeFromEnv,
  productionDeps,
} from './deps.js';

async function main(): Promise<void> {
  // Validate configuration BEFORE opening any connection. Connecting first meant a worker with no
  // provider mode failed with a Temporal transport error, which names the wrong problem entirely — and in
  // an environment where Temporal happened to be reachable it would have proceeded to build a gateway
  // from unvalidated configuration.
  const pool = poolFromEnv();
  const enforcement = enforcementModeFromEnv();
  const metrics = new Metrics();
  /**
   * The drain budget. Bounded and configurable, because the right value is a deployment decision:
   * long enough for a chapter step to finish, short enough that a deploy is not held open by one
   * stuck activity.
   */
  const lifecycle = new LifecycleCoordinator({
    deadlineMs: Number(process.env.YEONJAE_DRAIN_DEADLINE_MS ?? '30000'),
    telemetryFlushMs: Number(process.env.YEONJAE_TELEMETRY_FLUSH_MS ?? '2000'),
    metrics,
  });
  /**
   * Fail closed when shared enforcement is required but unavailable.
   *
   * Checked before the Temporal connection, for the same reason the provider mode is: a worker that
   * cannot enforce a shared budget must not accept work at all, and discovering that after it has taken
   * a task would mean the first refusal is a spent call rather than a startup error.
   */
  if (enforcement === 'shared') {
    try {
      await assertSharedEnforcementAvailable(pool);
    } catch (err) {
      // A configuration failure gets its OWN exit code, so an orchestrator can tell "this will never
      // start" from "a dependency is temporarily down" and stop restart-looping a misconfiguration.
      await pool.end();
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(EXIT_CODE.configuration_failure);
    }
  }
  const makeDeps = productionDeps(pool, { enforcement, metrics });

  /**
   * Signal handlers are installed BEFORE anything announces this process as up.
   *
   * A supervisor can signal a process the instant it sees a listening socket, and until a handler
   * exists SIGTERM and SIGINT carry Node's default disposition: immediate termination, with no drain
   * and no exit code. Registering here rather than after the Temporal connection closes that window.
   * `shutdownRef` exists only because the handler must be installed before the resources it drains.
   */
  const shutdownRef: { fn: () => void } = {
    fn: () => {
      void lifecycle.drain().then((result) => {
        process.exitCode = result.exitCode;
      });
    },
  };
  const onSignal = (): void => {
    shutdownRef.fn();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // The health surface comes up BEFORE the Temporal connection, so a worker that cannot reach
  // Temporal is observable as unhealthy rather than invisible.
  const health = await startWorkerHealthServer({
    pool,
    lifecycle,
    port: Number(process.env.YEONJAE_WORKER_HEALTH_PORT ?? '0'),
  });

  const address = process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? CHAPTER_TASK_QUEUE,
    workflowsPath: new URL('./workflows.js', import.meta.url).pathname,
    activities: createActivities({ pool, makeDeps }),
  });

  /**
   * Resources close in DEPENDENCY ORDER: the health surface first (nothing should probe a process
   * that is already tearing down its pool), then Temporal, then the database last, because the other
   * two may need a query on the way out.
   */
  lifecycle.register({ name: 'health', close: () => health.close() });
  lifecycle.register({
    name: 'temporal',
    close: async () => {
      await connection.close();
    },
  });
  lifecycle.register({
    name: 'pool',
    close: async () => {
      await pool.end();
    },
  });
  // On a forced deadline, tell Temporal to stop polling and abandon what it still holds.
  lifecycle.onForceCancel(() => {
    worker.shutdown();
  });

  // Now that the Temporal worker exists, upgrade the handler to stop its polling as well. The
  // pre-registered handler above already drained correctly; this only adds the Temporal half.
  shutdownRef.fn = () => {
    // Temporal stops accepting new tasks immediately; the coordinator decides how long the existing
    // ones get. `drain()` is idempotent by construction, which is what makes two signals arriving
    // together a non-event rather than a double close.
    worker.shutdown();
    void lifecycle.drain().then((result) => {
      process.exitCode = result.exitCode;
    });
  };

  lifecycle.markRunning();
  try {
    await worker.run();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = EXIT_CODE.dependency_failure;
  } finally {
    // Drain in a `finally` so a crashing worker still closes its health server, Temporal connection
    // and pool. Leaking any of them keeps the process alive and, for the pool, holds shared database
    // connections the rest of the deployment needs.
    const result = await lifecycle.drain();
    process.exitCode ??= result.exitCode;
  }
}

await main();
