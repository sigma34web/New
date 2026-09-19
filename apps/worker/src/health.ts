/**
 * The worker's liveness and readiness surface.
 *
 * WHY AN HTTP SERVER IN A WORKER. The worker has no inbound API, so until now it had no way to tell an
 * orchestrator whether it was healthy — a worker that had lost its database or was running against a
 * mismatched schema looked identical to a healthy one. A tiny loopback server is the smallest thing
 * that speaks the protocol every orchestrator already probes, and it exposes nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT EXPOSE. No tenant data, no configuration values, no connection string,
 * no credential and no error text from a driver. Readiness returns check NAMES and statuses, which is
 * what an operator needs to know which dependency is unhappy, and nothing that would make an
 * unauthenticated probe endpoint a disclosure channel.
 */
import { createServer, type Server } from 'node:http';
import { type LifecycleCoordinator } from '@yeonjae/domain';
import {
  dependencyReport,
  mergeReadiness,
  readiness,
  type DependencyReport,
  type Pool,
  type ReadinessReport,
} from '@yeonjae/db';

export interface WorkerHealthOptions {
  readonly pool: Pool;
  readonly lifecycle: LifecycleCoordinator;
  readonly port?: number | undefined;
  /** Loopback by default: a health surface has no reason to be reachable off-host. */
  readonly host?: string | undefined;
}

export interface WorkerHealthServer {
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Evaluate worker readiness.
 *
 * Stricter than the API's on one point that matters: `requireProviderMode` is true, because a worker
 * with no explicit provider mode must never accept work — it is the process that spends money.
 */
export async function workerReadiness(
  pool: Pool,
  lifecycle: LifecycleCoordinator,
): Promise<{
  ready: boolean;
  draining: boolean;
  report: ReadinessReport;
  dependencies: DependencyReport;
}> {
  const report = await readiness(pool, { requireProviderMode: true });
  /**
   * Per-component states, reported alongside the checks.
   *
   * The worker names itself as `self`, so its own lifecycle (starting, running, draining) is reported
   * as the `worker` component's state rather than inferred by a reader. A required component that is
   * unavailable fails readiness through `mergeReadiness`; an optional one that is degraded or
   * intentionally disabled does not, which is the distinction this surface previously could not make.
   */
  const dependencies = await dependencyReport({
    db: pool,
    self: 'worker',
    lifecycle: lifecycle.current(),
  });
  const merged = mergeReadiness(report, dependencies);
  return {
    // Draining fails readiness even when every dependency is healthy: the process is on its way out
    // and must stop being given work, which is a different question from whether it is broken.
    ready: merged.ready && lifecycle.ready(),
    draining: !lifecycle.ready(),
    report,
    dependencies,
  };
}

export async function startWorkerHealthServer(
  opts: WorkerHealthOptions,
): Promise<WorkerHealthServer> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '/';
      const send = (status: number, body: unknown): void => {
        const text = JSON.stringify(body);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
          // A probe response must never be cached: a stale "ready" is worse than no answer.
          'cache-control': 'no-store',
        });
        res.end(text);
      };

      if (url.startsWith('/health')) {
        /**
         * Liveness. Deliberately answers from process state alone.
         *
         * If liveness consulted the database, a database blip would make every orchestrator RESTART
         * every worker at once — turning a recoverable dependency outage into a thundering herd. A
         * live-but-not-ready process is the correct state for that situation.
         */
        send(opts.lifecycle.live() ? 200 : 503, {
          status: opts.lifecycle.live() ? 'ok' : 'stopped',
          state: opts.lifecycle.current(),
        });
        return;
      }
      if (url.startsWith('/ready')) {
        try {
          const verdict = await workerReadiness(opts.pool, opts.lifecycle);
          send(verdict.ready ? 200 : 503, {
            status: verdict.ready ? 'ready' : verdict.draining ? 'draining' : 'not_ready',
            in_flight: opts.lifecycle.inFlightCount(),
            // Names and statuses only; the detail strings come from the readiness module, which is
            // itself asserted to carry no credential or connection string.
            checks: verdict.report.checks,
            // Same bounded shape: component name, state, code, requiredness and a safe explanation.
            dependencies: verdict.dependencies.components,
            degraded: verdict.dependencies.degraded,
          });
        } catch {
          // A readiness probe that throws must answer 503, not hang the probe.
          send(503, { status: 'not_ready', checks: [], dependencies: [] });
        }
        return;
      }
      send(404, { status: 'not_found' });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        // Destroy idle keep-alive sockets, or a probe client holding one open would delay shutdown
        // past the drain deadline for no useful reason.
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
