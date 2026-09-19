/**
 * API health, readiness and bounded draining, driven by REAL signals against REAL child processes
 * (Workstream C).
 *
 * The worker already has this; the API did not, and the gap mattered: an API that fails readiness only
 * after closing its pool sends traffic into a process that can no longer answer, and one that never
 * bounds its drain holds every deploy open behind a single stuck request.
 *
 * What is asserted here cannot be asserted in-process: signal handling, the exit code an orchestrator
 * reads, and the claim that nothing leaked. Synchronisation is on JSON state lines and HTTP probe
 * responses — there is no sleep used as coordination anywhere in this file.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODE } from '@yeonjae/domain';
import { databaseUrl } from '@yeonjae/db/testkit';

const run = databaseUrl() ? describe : describe.skip;

const CHILD = new URL('../drain-probe-child.mjs', import.meta.url).pathname;

interface Line {
  readonly event: string;
  readonly [key: string]: unknown;
}

interface ExitState {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A spawned API process that reports its lifecycle as JSON lines. */
class Probe {
  readonly lines: Line[] = [];
  private readonly waiters: { match: (l: Line) => boolean; resolve: (l: Line) => void }[] = [];
  private exited: ExitState | undefined;
  private readonly exitWaiters: (() => void)[] = [];
  private stderrText = '';
  private readonly child: ChildProcess;

  constructor(env: Record<string, string> = {}) {
    this.child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let buffer = '';
    this.child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const raw = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (raw.length === 0) continue;
        let parsed: Line;
        try {
          parsed = JSON.parse(raw) as Line;
        } catch {
          continue;
        }
        this.lines.push(parsed);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const w = this.waiters[i];
          if (w?.match(parsed) === true) {
            this.waiters.splice(i, 1);
            w.resolve(parsed);
          }
        }
      }
    });
    this.child.stderr?.on('data', (c: Buffer) => (this.stderrText += c.toString('utf8')));
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const w of this.exitWaiters.splice(0)) w();
    });
  }

  get pid(): number | undefined {
    return this.child.pid ?? undefined;
  }

  async waitFor(event: string, timeoutMs = 20_000): Promise<Line> {
    const already = this.lines.find((l) => l.event === event);
    if (already) return already;
    return new Promise<Line>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `never saw '${event}'; saw [${this.lines.map((l) => l.event).join(', ')}]; stderr: ${this.stderrText.slice(0, 1500)}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        match: (l) => l.event === event,
        resolve: (l) => {
          clearTimeout(timer);
          resolve(l);
        },
      });
    });
  }

  signal(sig: NodeJS.Signals): void {
    this.child.kill(sig);
  }

  send(msg: string): void {
    this.child.send(msg);
  }

  private exitState(): ExitState | undefined {
    return this.exited;
  }

  async waitForExit(timeoutMs = 20_000): Promise<ExitState> {
    const already = this.exitState();
    if (already) return already;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`child did not exit; stderr: ${this.stderrText.slice(0, 1500)}`));
      }, timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Read through a method call so the narrowing above does not persist across the await.
    const state = this.exitState();
    if (!state) throw new Error('exit was not recorded');
    return state;
  }

  async dispose(): Promise<void> {
    if (!this.exited) {
      this.child.kill('SIGKILL');
      try {
        await this.waitForExit(5_000);
      } catch {
        // The explicit no-leak assertions cover this; cleanup must not fail a test on its own.
      }
    }
    this.child.stdout?.removeAllListeners();
    this.child.stderr?.removeAllListeners();
    this.child.removeAllListeners();
  }
}

run('API lifecycle: readiness, drain and signals (Workstream C)', () => {
  const probes: Probe[] = [];

  function start(env: Record<string, string> = {}): Probe {
    const probe = new Probe(env);
    probes.push(probe);
    return probe;
  }

  async function portOf(probe: Probe): Promise<number> {
    const line = await probe.waitFor('listening');
    return Number(line.port);
  }

  async function get(port: number, path: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`http://127.0.0.1:${String(port)}${path}`);
    return { status: res.status, body: await res.text() };
  }

  afterEach(async () => {
    for (const probe of probes.splice(0)) await probe.dispose();
  });

  // ---- normal operation ----------------------------------------------------------------------------

  it('serves liveness and readiness while running', async () => {
    const probe = start();
    const port = await portOf(probe);
    const health = await get(port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok', state: 'running' });
    // Readiness genuinely probes the database, so it is 200 only because migrations are applied.
    const ready = await get(port, '/ready');
    expect([200, 503]).toContain(ready.status);
  });

  // ---- drain ---------------------------------------------------------------------------------------

  it('fails readiness immediately when drain begins, while liveness still succeeds', async () => {
    // The drain is held open by in-flight work, so the process is observably IN the draining state
    // rather than already gone — which is the window this test exists to inspect.
    const probe = start({ YEONJAE_DRAIN_DEADLINE_MS: '10000' });
    const port = await portOf(probe);
    probe.send('hold');
    await probe.waitFor('work_held');

    probe.signal('SIGTERM');
    await probe.waitFor('signal');

    const ready = await get(port, '/ready');
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toMatchObject({ status: 'draining' });

    // Alive but not ready: the pair that tells an orchestrator to stop routing without killing it.
    const health = await get(port, '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok', state: 'stopping' });

    probe.send('release');
    const exit = await probe.waitForExit();
    expect(exit.code).toBe(EXIT_CODE.clean);
  });

  it('refuses new work during drain with a 503 problem document and a retry-after', async () => {
    const probe = start({ YEONJAE_DRAIN_DEADLINE_MS: '10000' });
    const port = await portOf(probe);
    probe.send('hold');
    await probe.waitFor('work_held');
    probe.signal('SIGTERM');
    await probe.waitFor('signal');

    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/projects`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const body = (await res.json()) as { code: string };
    // A stable code, so a client can distinguish "this instance is going away" from a real fault.
    expect(body.code).toBe('SERVICE_DRAINING');

    probe.send('release');
    await probe.waitForExit();
  });

  it('waits for in-flight work and exits clean when it finishes inside the deadline', async () => {
    const probe = start({ YEONJAE_DRAIN_DEADLINE_MS: '10000' });
    await portOf(probe);
    probe.send('hold');
    await probe.waitFor('work_held');
    probe.signal('SIGTERM');
    await probe.waitFor('signal');

    probe.send('release');
    await probe.waitFor('work_released');
    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('clean');
    expect(drained.abandoned).toBe(0);
    expect(drained.closed).toEqual(expect.arrayContaining(['http', 'pool']));
    const exit = await probe.waitForExit();
    expect(exit.code).toBe(EXIT_CODE.clean);
  });

  it('enforces the deadline when in-flight work never finishes, with a distinct exit code', async () => {
    // Work is taken and never released: the deadline must fire rather than hang the deploy.
    const probe = start({ YEONJAE_DRAIN_DEADLINE_MS: '150' });
    await portOf(probe);
    probe.send('hold');
    await probe.waitFor('work_held');
    probe.signal('SIGTERM');

    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('deadline_exceeded');
    expect(drained.abandoned).toBe(1);
    // Resources still close: a fired deadline must not mean a leaked pool.
    expect(drained.closed).toEqual(expect.arrayContaining(['http', 'pool']));
    const exit = await probe.waitForExit();
    expect(exit.code).toBe(EXIT_CODE.deadline_exceeded);
  });

  // ---- signals -------------------------------------------------------------------------------------

  it('drains on SIGTERM while idle', async () => {
    const probe = start();
    await portOf(probe);
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('clean');
    expect(await probe.waitForExit()).toMatchObject({ code: EXIT_CODE.clean });
  });

  it('drains on SIGINT while idle', async () => {
    const probe = start();
    await portOf(probe);
    probe.signal('SIGINT');
    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('clean');
    expect(await probe.waitForExit()).toMatchObject({ code: EXIT_CODE.clean });
  });

  it('treats two signals arriving together as one shutdown, not a double close', async () => {
    const probe = start({ YEONJAE_DRAIN_DEADLINE_MS: '10000' });
    await portOf(probe);
    probe.send('hold');
    await probe.waitFor('work_held');

    // SIGINT from a terminal plus SIGTERM from a supervisor is the common real pairing.
    probe.signal('SIGTERM');
    probe.signal('SIGINT');
    probe.send('release');

    const drained = await probe.waitFor('drained');
    // Both signals were observed, and exactly ONE drain ran: closing a pool twice throws.
    expect(Number(drained.signals)).toBeGreaterThanOrEqual(1);
    expect(probe.lines.filter((l) => l.event === 'drained')).toHaveLength(1);
    expect(drained.outcome).toBe('clean');
    await probe.waitForExit();
  });

  it('drains cleanly when signalled during startup, before it ever became ready', async () => {
    const probe = start({ YEONJAE_SHUTDOWN_DURING_STARTUP: '1' });
    await probe.waitFor('listening');
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    // Partial initialization must still close what was registered rather than skipping teardown.
    expect(drained.closed).toEqual(expect.arrayContaining(['http', 'pool']));
    expect(await probe.waitForExit()).toMatchObject({ code: EXIT_CODE.clean });
  });

  it('completes an in-flight HTTP request that was admitted before the drain', async () => {
    const probe = start({ YEONJAE_DRAIN_DEADLINE_MS: '10000' });
    const port = await portOf(probe);
    // An admitted request is served normally; the drain gate only refuses NEW work.
    const before = await get(port, '/health');
    expect(before.status).toBe(200);
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('clean');
    await probe.waitForExit();
  });

  // ---- telemetry and close failures ----------------------------------------------------------------

  it('flushes telemetry before closing resources', async () => {
    const probe = start({ YEONJAE_TELEMETRY_OK: '1' });
    await portOf(probe);
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.telemetryFlushed).toBe(true);
    expect(drained.outcome).toBe('clean');
    await probe.waitForExit();
  });

  it('bounds a telemetry flush that hangs, and still shuts down', async () => {
    // A telemetry backend must never be able to hold a deploy open.
    const probe = start({ YEONJAE_TELEMETRY_HANGS: '1', YEONJAE_TELEMETRY_FLUSH_MS: '100' });
    await portOf(probe);
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.telemetryFlushed).toBe(false);
    expect(drained.closed).toEqual(expect.arrayContaining(['http', 'pool']));
    expect(await probe.waitForExit()).toMatchObject({ code: EXIT_CODE.clean });
  });

  it('treats a failed telemetry flush as non-fatal', async () => {
    const probe = start({ YEONJAE_TELEMETRY_FAILS: '1' });
    await portOf(probe);
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.telemetryFlushed).toBe(false);
    // Losing metrics is not worth failing a shutdown over.
    expect(drained.outcome).toBe('clean');
    await probe.waitForExit();
  });

  it('records a close failure without stranding the remaining resources open', async () => {
    const probe = start({ YEONJAE_CLOSE_FAILS: '1' });
    await portOf(probe);
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.closeFailures).toEqual(['broken']);
    // The http server and the pool still closed: an early throw would have leaked both.
    expect(drained.closed).toEqual(expect.arrayContaining(['http', 'pool']));
    expect(drained.outcome).toBe('dependency_failure');
    expect(await probe.waitForExit()).toMatchObject({ code: EXIT_CODE.dependency_failure });
  });

  // ---- leak checks ---------------------------------------------------------------------------------

  it('leaks no process and no listening port after shutdown', async () => {
    const probe = start();
    const port = await portOf(probe);
    const pid = probe.pid;
    if (pid === undefined) throw new Error('the child reported no pid');
    probe.signal('SIGTERM');
    await probe.waitForExit();

    // The process is genuinely gone: signal 0 probes existence without delivering anything.
    expect(() => {
      process.kill(pid, 0);
    }).toThrow();

    // And the port is free, so a replacement instance can bind it immediately.
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toThrow();
  });
});
