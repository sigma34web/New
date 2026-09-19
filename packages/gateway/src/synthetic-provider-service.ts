/**
 * A deterministic local HTTP provider simulator.
 *
 * WHY THIS EXISTS. `MockProvider` and `ReplayProvider` are in-process: they return values, so every test
 * that uses them proves things about the gateway's LOGIC while skipping the part that actually breaks in
 * production — the network boundary. A socket that resets mid-body, headers that arrive without a body, a
 * 429 carrying `Retry-After`, a response that keeps streaming after the client gave up, a body larger than
 * the adapter is willing to buffer: none of those can be expressed by returning a value.
 *
 * So this is a real `node:http` server that speaks a small JSON completion protocol, driven by explicit
 * scenarios. It contacts nothing, needs no credentials, and holds no fixtures beyond what a test hands it.
 *
 * DETERMINISM RULES, because a simulator that needs timing to be right is worse than no simulator:
 *
 *   - scenarios are selected by an explicit header, never by chance;
 *   - "mid-stream" and "after headers" are expressed with BARRIERS a test releases, not with delays;
 *   - every started response either completes or is destroyed before `close()` resolves, so no test leaks
 *     a socket into the next one;
 *   - each instance binds port 0 and is independent, so suites can run in parallel.
 *
 * Recorded requests keep hashes and sizes, never prompt or manuscript text: the same rule the real audit
 * follows (NFR-A.1), applied here so a simulator log cannot become an accidental content store.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

/** The scenario a request should be answered with. Selected by the `x-synthetic-scenario` header. */
export type SyntheticScenario =
  | 'ok'
  | 'ok_stream'
  | 'usage_missing'
  | 'usage_partial'
  | 'malformed_json'
  | 'schema_violation'
  | 'rate_limited'
  | 'server_error'
  | 'bad_gateway'
  | 'unavailable'
  | 'delayed_headers'
  | 'delayed_body'
  | 'connection_reset'
  | 'reset_mid_body'
  | 'oversized_body'
  | 'late_success'
  | 'remote_cancel_ack'
  | 'remote_cancel_unsupported';

export const SYNTHETIC_SCENARIO_HEADER = 'x-synthetic-scenario';

/** What the simulator recorded about one request. Hashes and sizes only — never prompt text. */
export interface SyntheticRequestRecord {
  readonly scenario: SyntheticScenario;
  readonly modelId: string;
  readonly systemHash: string;
  readonly userHash: string;
  readonly systemBytes: number;
  readonly userBytes: number;
  readonly idempotencyKey: string | undefined;
  /**
   * True when the client closed the connection before the response finished.
   *
   * Mutable on purpose: whether the client hung up is only knowable after the response ends, so a test
   * asserting "the caller gave up while the provider was still working" has to read the value the socket
   * ended with rather than the value at request time.
   */
  clientAborted: boolean;
}

export interface SyntheticProviderOptions {
  /**
   * Bytes the simulator will emit for `oversized_body`. Small by default so a test asserting the
   * adapter's limit does not have to move megabytes.
   */
  readonly oversizedBytes?: number | undefined;
}

/**
 * A barrier a test releases explicitly.
 *
 * This is the whole reason the delayed/mid-stream scenarios are deterministic: the server waits for the
 * test to say "now", instead of the test waiting for a duration it hopes is long enough.
 */
export class Barrier {
  private resolve: (() => void) | undefined;
  private readonly promise: Promise<void>;
  private released = false;
  constructor() {
    this.promise = new Promise<void>((res) => {
      this.resolve = res;
    });
  }
  wait(): Promise<void> {
    return this.released ? Promise.resolve() : this.promise;
  }
  release(): void {
    if (this.released) return;
    this.released = true;
    this.resolve?.();
  }
}

interface LiveResponse {
  readonly res: ServerResponse;
  readonly req: IncomingMessage;
}

/**
 * The simulator. One instance per test; `close()` is safe to call more than once and always leaves no
 * listening socket, no open response and no pending barrier behind.
 */
export class SyntheticProviderService {
  private server: Server | undefined;
  private port = 0;
  private readonly records: SyntheticRequestRecord[] = [];
  private readonly live = new Set<LiveResponse>();
  private readonly barriers = new Map<string, Barrier>();
  private readonly cancelled = new Set<string>();
  private failuresRemaining = new Map<SyntheticScenario, number>();

  constructor(private readonly opts: SyntheticProviderOptions = {}) {}

  /** Start listening on an ephemeral port. */
  async start(): Promise<string> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | null;
    if (address === null) throw new Error('synthetic provider did not bind');
    this.port = address.port;
    return this.baseUrl();
  }

  baseUrl(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  /**
   * A barrier the server will wait on before continuing a `delayed_*`, `reset_mid_body` or `late_success`
   * response. Named so one test can hold several requests independently.
   */
  barrier(name: string): Barrier {
    const existing = this.barriers.get(name);
    if (existing) return existing;
    const created = new Barrier();
    this.barriers.set(name, created);
    return created;
  }

  /** Fail the next `count` requests for a scenario, then succeed. Drives retry and fallback tests. */
  failNext(scenario: SyntheticScenario, count: number): void {
    this.failuresRemaining.set(scenario, count);
  }

  requests(): readonly SyntheticRequestRecord[] {
    return this.records;
  }

  /**
   * Resolve once at least `count` requests have been received.
   *
   * This is the barrier a test needs before aborting an in-flight call: without it the abort races
   * dispatch, and a `while (requests.length === 0) await Promise.resolve()` spin does NOT help, because
   * microtask draining never lets the server's I/O callbacks run — it just wedges the event loop.
   */
  async waitForRequests(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.records.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `synthetic provider saw ${String(this.records.length)} of ${String(count)} requests`,
        );
      }
      // setImmediate yields to the I/O phase, which is what actually lets the request be accepted.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /**
   * Resolve once the client has been observed hanging up on request `index`.
   *
   * The hang-up is delivered as a socket event, so it becomes visible strictly after the abort — a test
   * that reads `clientAborted` immediately after calling `abort()` reads it too early.
   */
  async waitForClientAbort(index = 0, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.records[index]?.clientAborted === true) return;
      if (Date.now() > deadline) throw new Error('synthetic provider saw no client hang-up');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Whether the client asked the REMOTE side to stop, and whether this simulator acknowledged it. */
  remoteCancelRequested(idempotencyKey: string): boolean {
    return this.cancelled.has(idempotencyKey);
  }

  /**
   * Stop listening and destroy anything still in flight.
   *
   * Barriers are released first: a response blocked on a barrier would otherwise keep its handler alive
   * and the close would hang, which is exactly the kind of leak that turns one flaky suite into a stuck
   * CI job.
   */
  async close(): Promise<void> {
    for (const barrier of this.barriers.values()) barrier.release();
    for (const entry of this.live) {
      entry.res.destroy();
      entry.req.destroy();
    }
    this.live.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // Idle keep-alive sockets would otherwise hold the close open.
      server.closeAllConnections();
    });
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const entry: LiveResponse = { req, res };
    this.live.add(entry);
    try {
      const url = new URL(req.url ?? '/', this.baseUrl());

      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // An explicit remote-cancellation endpoint, so a test can distinguish "we closed the socket" from
      // "the provider acknowledged a stop request" — the distinction ADR-0049 refuses to blur.
      if (url.pathname === '/v1/cancel' && req.method === 'POST') {
        const body = await this.readBody(req);
        const parsed = JSON.parse(body) as { idempotencyKey?: string; supported?: boolean };
        const key = parsed.idempotencyKey ?? '';
        if (parsed.supported === false) {
          res.writeHead(501, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ remote_cancellation: 'unsupported' }));
          return;
        }
        this.cancelled.add(key);
        this.barrier(`cancel:${key}`).release();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ remote_cancellation: 'acknowledged' }));
        return;
      }

      if (url.pathname !== '/v1/complete' || req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      const raw = await this.readBody(req);
      const body = JSON.parse(raw) as {
        modelId?: string;
        system?: string;
        user?: string;
        idempotencyKey?: string;
      };
      const header = req.headers[SYNTHETIC_SCENARIO_HEADER];
      const requested = (Array.isArray(header) ? header[0] : header) ?? 'ok';
      let scenario = requested as SyntheticScenario;

      // `failNext` turns a fault into a transient one, which is what a retry test needs: the same
      // request must succeed once the injected failures are used up.
      const remaining = this.failuresRemaining.get(scenario) ?? 0;
      if (remaining > 0) {
        this.failuresRemaining.set(scenario, remaining - 1);
      } else if (this.failuresRemaining.has(scenario)) {
        scenario = 'ok';
      }

      const system = body.system ?? '';
      const user = body.user ?? '';
      const idempotencyKey = body.idempotencyKey;
      const record: SyntheticRequestRecord = {
        scenario,
        modelId: body.modelId ?? 'unknown',
        // Hashes and sizes only: a simulator log must not become a content store.
        systemHash: createHash('sha256').update(system).digest('hex'),
        userHash: createHash('sha256').update(user).digest('hex'),
        systemBytes: Buffer.byteLength(system),
        userBytes: Buffer.byteLength(user),
        idempotencyKey,
        clientAborted: false,
      };
      this.records.push(record);
      // The hang-up can arrive at any point during the response, so the record is updated in place.
      req.on('aborted', () => {
        record.clientAborted = true;
      });
      res.on('close', () => {
        if (!res.writableEnded) record.clientAborted = true;
      });

      await this.respond(scenario, { res, body, idempotencyKey });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulator_error', detail: (err as Error).message }));
      } else {
        res.destroy();
      }
    } finally {
      this.live.delete(entry);
    }
  }

  private okPayload(modelId: string, text: string, usage: unknown): string {
    return JSON.stringify({
      modelId,
      provider: 'synthetic',
      providerRequestId: `syn-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`,
      text,
      finishReason: 'stop',
      usage,
    });
  }

  private async respond(
    scenario: SyntheticScenario,
    ctx: {
      res: ServerResponse;
      body: { modelId?: string; system?: string; user?: string };
      idempotencyKey: string | undefined;
    },
  ): Promise<void> {
    const { res } = ctx;
    const modelId = ctx.body.modelId ?? 'synthetic-model';
    // Deterministic by construction: the output is a function of the input, like MockProvider.
    const text = `synthetic completion for ${createHash('sha256')
      .update(`${ctx.body.system ?? ''}\u0000${ctx.body.user ?? ''}`)
      .digest('hex')
      .slice(0, 16)}`;
    const usage = { input: 120, output: 48, cached: 0 };
    const json = (code: number, payload: string, headers: Record<string, string> = {}): void => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(payload);
    };

    switch (scenario) {
      case 'ok':
        json(200, this.okPayload(modelId, text, usage));
        return;

      case 'ok_stream': {
        // Chunked, so the adapter's assembly path is exercised rather than a single buffered write.
        res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
        const payload = this.okPayload(modelId, text, usage);
        const mid = Math.floor(payload.length / 2);
        res.write(payload.slice(0, mid));
        res.end(payload.slice(mid));
        return;
      }

      case 'usage_missing':
        // A provider that reports nothing. The accounting path must treat this as UNKNOWN, not zero.
        json(200, this.okPayload(modelId, text, undefined));
        return;

      case 'usage_partial':
        // Output tokens only. Still not a complete picture, and must not be completed by guessing.
        json(200, this.okPayload(modelId, text, { output: 48 }));
        return;

      case 'malformed_json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"modelId":"synthetic-model","text":"unterminated');
        return;

      case 'schema_violation':
        // Valid JSON, wrong shape: `text` is not a string. The adapter must reject rather than coerce.
        json(200, JSON.stringify({ modelId, provider: 'synthetic', text: { not: 'a string' } }));
        return;

      case 'rate_limited':
        json(429, JSON.stringify({ error: 'rate_limited' }), {
          'retry-after': '2',
          'x-ratelimit-remaining': '0',
        });
        return;

      case 'server_error':
        json(500, JSON.stringify({ error: 'internal' }));
        return;
      case 'bad_gateway':
        json(502, JSON.stringify({ error: 'bad_gateway' }));
        return;
      case 'unavailable':
        json(503, JSON.stringify({ error: 'unavailable' }), { 'retry-after': '1' });
        return;

      case 'delayed_headers': {
        // Nothing is sent until the test releases the barrier: a hung provider, deterministically.
        await this.barrier('headers').wait();
        json(200, this.okPayload(modelId, text, usage));
        return;
      }

      case 'delayed_body': {
        // Headers arrive, the body does not. This is the shape a read timeout has to survive.
        res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
        res.write('{"modelId":"');
        await this.barrier('body').wait();
        res.end(`${modelId}","provider":"synthetic","text":${JSON.stringify(text)},
                 "finishReason":"stop","usage":${JSON.stringify(usage)}}`);
        return;
      }

      case 'connection_reset':
        // No response at all: the socket dies before headers.
        res.destroy();
        return;

      case 'reset_mid_body': {
        res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
        res.write('{"modelId":"synthetic-model","text":"partial');
        await this.barrier('reset').wait();
        res.destroy();
        return;
      }

      case 'oversized_body': {
        const size = this.opts.oversizedBytes ?? 256 * 1024;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ modelId, provider: 'synthetic', text: 'x'.repeat(size) }));
        return;
      }

      case 'late_success': {
        // The provider finishes AFTER the client gave up. Held on a barrier so the test controls the
        // ordering exactly: this is the "late response must be discarded" case from ADR-0049.
        await this.barrier(`late:${ctx.idempotencyKey ?? 'any'}`).wait();
        if (res.writableEnded || res.destroyed) return;
        json(200, this.okPayload(modelId, text, usage));
        return;
      }

      case 'remote_cancel_ack': {
        // Waits for an explicit /v1/cancel for this key, then reports that the remote side stopped.
        await this.barrier(`cancel:${ctx.idempotencyKey ?? 'any'}`).wait();
        json(
          200,
          JSON.stringify({
            modelId,
            provider: 'synthetic',
            text: undefined,
            finishReason: 'error',
            // Usage after a remote cancel is genuinely unknown, and says so.
            usage: undefined,
            remote_cancellation: 'acknowledged',
          }),
        );
        return;
      }

      case 'remote_cancel_unsupported':
        json(
          200,
          JSON.stringify({
            modelId,
            provider: 'synthetic',
            text,
            finishReason: 'stop',
            usage,
            remote_cancellation: 'unsupported',
          }),
        );
        return;

      default:
        json(400, JSON.stringify({ error: 'unknown_scenario', scenario }));
    }
  }
}
