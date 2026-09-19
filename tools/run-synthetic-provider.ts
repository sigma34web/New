/**
 * Run the deterministic synthetic provider on a fixed port, for the local topology.
 *
 * This is a TEST DOUBLE. Its scenario header lets a caller choose failures, resets and late responses
 * at will, so it binds loopback by default and must never be published to an untrusted network.
 * Exercising the system against it is evidence about the system's transport, retry, cancellation and
 * accounting paths — and evidence of nothing at all about a real provider.
 */
import { startSyntheticProviderMain } from '../packages/gateway/src/synthetic-provider-main.js';

const port = Number(process.env.YEONJAE_SYNTHETIC_PORT ?? '8090');
const host = process.env.YEONJAE_SYNTHETIC_HOST ?? '127.0.0.1';

const running = await startSyntheticProviderMain({ port, host });
console.log(`synthetic provider (deterministic simulator, NOT a real provider) on ${running.url}`);

const shutdown = (): void => {
  void running.close().then(() => {
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
