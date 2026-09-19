/**
 * A standalone entry point for the deterministic synthetic provider.
 *
 * WHY IT EXISTS. `SyntheticProviderService` was built for in-process tests: it binds an EPHEMERAL port
 * on loopback, which is exactly right for a test and useless for a local topology where another
 * container has to find it. This wrapper gives it a fixed, configured address so the local stack can
 * point a worker at it.
 *
 * WHAT IT IS NOT. A deterministic simulator. Pointing the system at this and observing success is
 * evidence about the SYSTEM's transport, retry, cancellation and accounting paths, and evidence of
 * nothing whatsoever about a real provider. It must never be published to an untrusted network: it is
 * a test double, and its scenario header lets a caller choose failures at will.
 */
import { createServer, type Server } from 'node:http';
import { SyntheticProviderService } from './synthetic-provider-service.js';

export interface SyntheticMainOptions {
  readonly port: number;
  /** Loopback by default: a test double should not be reachable off-host unless asked for. */
  readonly host?: string | undefined;
}

/**
 * Start the simulator behind a fixed port by proxying to its ephemeral listener.
 *
 * Proxying rather than changing the service's own `listen` keeps every existing test's assumption
 * intact (an ephemeral port per test, no port collisions when suites run together) while giving the
 * topology the stable address it needs.
 */
export async function startSyntheticProviderMain(
  opts: SyntheticMainOptions,
): Promise<{ url: string; close: () => Promise<void> }> {
  const service = new SyntheticProviderService();
  const upstream = await service.start();
  const target = new URL(upstream);

  const proxy: Server = createServer((req, res) => {
    // Node's IncomingHttpHeaders allows string[] (set-cookie), which `fetch` will not accept. Flatten
    // rather than cast: a cast here would be a type-level lie that fails at runtime on one header.
    const headers: Record<string, string> = { host: target.host };
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        try {
          const body = Buffer.concat(chunks);
          const response = await fetch(new URL(req.url ?? '/', upstream), {
            method: req.method ?? 'GET',
            headers,
            ...(body.length > 0 ? { body } : {}),
          });
          res.statusCode = response.status;
          for (const [k, v] of response.headers.entries()) {
            if (k.toLowerCase() === 'content-encoding') continue;
            res.setHeader(k, v);
          }
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch {
          // A proxy failure must look like a transport fault, not a silent hang.
          res.statusCode = 502;
          res.end();
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      proxy.removeListener('error', reject);
      resolve();
    });
  });

  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${String(opts.port)}`,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        proxy.close(() => {
          resolve();
        });
      });
      await service.close();
    },
  };
}
