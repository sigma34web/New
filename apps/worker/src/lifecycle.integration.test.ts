/**
 * Worker health, readiness and bounded draining, driven by REAL signals against REAL child processes.
 *
 * An in-process test cannot exercise what matters here: a signal handler, a process that must exit,
 * an exit code an orchestrator reads, or the claim that nothing leaked. Every case below spawns the
 * worker's actual health surface and lifecycle coordinator and then sends it a signal.
 *
 * There are no sleeps used as synchronization. The parent waits on JSON state lines the child prints
 * and on HTTP probe responses.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODE } from '@yeonjae/domain';
import { createPool, migrate, type Pool } from '@yeonjae/db';
import { databaseUrl } from '@yeonjae/db/testkit';

const run = databaseUrl() ? describe : describe.skip;

const CHILD = new URL('../health-probe-child.mjs', import.meta.url).pathname;

interface Line {
  readonly event: string;
  readonly [key: string]: unknown;
}

/** A spawned worker health process that reports its state as JSON lines. */
class Probe {
  readonly lines: Line[] = [];
  private readonly waiters: { match: (l: Line) => boolean; resolve: (l: Line) => void }[] = [];
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly exitWaiters: (() => void)[] = [];
  private stderrText = '';
  private readonly child: ChildProcess;

  constructor(env: Record<string, string>) {
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

  release(): void {
    this.child.send('release');
  }

  private exitState(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exited;
  }

  async waitForExit(timeoutMs = 20_000): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    if (this.exited) return this.exited;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`child did not exit; stderr: ${this.stderrText.slice(0, 1500)}`));
      }, timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
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

async function probeHttp(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  return { status: res.status, body: await res.json() };
}

run('worker lifecycle: health, readiness, drain and shutdown', () => {
  const probes: Probe[] = [];
  let pool: Pool;

  const start = (env: Record<string, string> = {}): Probe => {
    const probe = new Probe({
      DATABASE_URL: databaseUrl() ?? '',
      YEONJAE_PROVIDER_MODE: 'replay',
      ...env,
    });
    probes.push(probe);
    return probe;
  };

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    pool = createPool({ connectionString: url, max: 2 });
    await migrate(pool);
    await pool.end();
  }, 120_000);

  afterEach(async () => {
    for (const p of probes.splice(0)) await p.dispose();
  });

  it('serves liveness and readiness, and readiness names the checks it ran', async () => {
    const probe = start();
    const started = await probe.waitFor('listening');
    const port = Number(started.port);

    const live = await probeHttp(port, '/health');
    expect(live.status).toBe(200);
    expect((live.body as { status: string }).status).toBe('ok');

    const ready = await probeHttp(port, '/ready');
    expect(ready.status).toBe(200);
    const body = ready.body as { status: string; checks: { name: string }[] };
    expect(body.status).toBe('ready');
    // An operator needs to know WHICH dependency is unhappy, so the names are reported.
    expect(body.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['database', 'migrations', 'app_role']),
    );
  }, 60_000);

  it('exposes no credential, connection string or configuration value on the probes', async () => {
    const probe = start();
    const port = Number((await probe.waitFor('listening')).port);
    const ready = await probeHttp(port, '/ready');
    const serialized = JSON.stringify(ready.body);
    const url = databaseUrl() ?? '';
    expect(serialized).not.toContain(url);
    expect(serialized).not.toContain('postgres://');
    expect(serialized).not.toContain('password');
    // Not even the host: a probe endpoint is not a configuration dump.
    expect(serialized).not.toContain('127.0.0.1:5432');
  }, 60_000);

  it('answers 404 for anything that is not a probe', async () => {
    const probe = start();
    const port = Number((await probe.waitFor('listening')).port);
    const other = await probeHttp(port, '/metrics');
    expect(other.status).toBe(404);
  }, 60_000);

  it('is not ready before startup completes, while remaining live', async () => {
    const probe = start({ YEONJAE_SHUTDOWN_DURING_STARTUP: '1' });
    const port = Number((await probe.waitFor('listening')).port);
    const ready = await probeHttp(port, '/ready');
    expect(ready.status).toBe(503);
    expect((ready.body as { status: string }).status).toBe('draining');
    // Liveness stays true: the process is initializing, not broken, and must not be restarted.
    const live = await probeHttp(port, '/health');
    expect(live.status).toBe(200);
  }, 60_000);

  it('drains cleanly on SIGTERM and exits 0', async () => {
    const probe = start();
    await probe.waitFor('listening');
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('clean');
    expect(drained.closed).toEqual(['health', 'pool']);
    const exit = await probe.waitForExit();
    expect(exit.code).toBe(EXIT_CODE.clean);
  }, 60_000);

  it('drains cleanly on SIGINT', async () => {
    const probe = start();
    await probe.waitFor('listening');
    probe.signal('SIGINT');
    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('clean');
    expect((await probe.waitForExit()).code).toBe(EXIT_CODE.clean);
  }, 60_000);

  it('treats two signals arriving together as one shutdown', async () => {
    const probe = start();
    await probe.waitFor('listening');
    probe.signal('SIGTERM');
    probe.signal('SIGINT');
    const drained = await probe.waitFor('drained');
    // Both signals were observed, and exactly one drain ran: closing a pool twice would throw.
    expect(Number(drained.signals)).toBeGreaterThanOrEqual(1);
    expect(drained.closed).toEqual(['health', 'pool']);
    expect((await probe.waitForExit()).code).toBe(EXIT_CODE.clean);
  }, 60_000);

  it('fails readiness immediately once draining, while liveness stays true', async () => {
    // Work is held open, so the drain is genuinely in progress while the probes are taken.
    const probe = start({ YEONJAE_HOLD_WORK: '1', YEONJAE_DRAIN_DEADLINE_MS: '10000' });
    const port = Number((await probe.waitFor('listening')).port);
    probe.signal('SIGTERM');
    await probe.waitFor('signal');

    const ready = await probeHttp(port, '/ready');
    expect(ready.status).toBe(503);
    expect((ready.body as { status: string }).status).toBe('draining');
    const live = await probeHttp(port, '/health');
    expect(live.status).toBe(200);
    // In-flight work is reported, which is what tells an operator why the drain is still running.
    expect((ready.body as { in_flight: number }).in_flight).toBe(1);

    probe.release();
    await probe.waitFor('work_released');
    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('clean');
    expect(drained.abandoned).toBe(0);
  }, 60_000);

  it('enforces the drain deadline and reports a distinguishable exit code', async () => {
    // Work that is never released: only the deadline can end this drain.
    const probe = start({ YEONJAE_HOLD_WORK: '1', YEONJAE_DRAIN_DEADLINE_MS: '300' });
    await probe.waitFor('listening');
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.outcome).toBe('deadline_exceeded');
    expect(drained.abandoned).toBe(1);
    const exit = await probe.waitForExit();
    // Distinguishable from a clean drain, so an orchestrator can alert on deploys that time out.
    expect(exit.code).toBe(EXIT_CODE.deadline_exceeded);
    expect(exit.code).not.toBe(EXIT_CODE.clean);
  }, 60_000);

  it('does not let a hung telemetry flush hold the shutdown open', async () => {
    const probe = start({ YEONJAE_TELEMETRY_HANGS: '1', YEONJAE_TELEMETRY_FLUSH_MS: '200' });
    await probe.waitFor('listening');
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.telemetryFlushed).toBe(false);
    // Lost metrics are not worth failing a shutdown over, so the drain is still clean.
    expect(drained.outcome).toBe('clean');
    expect((await probe.waitForExit()).code).toBe(EXIT_CODE.clean);
  }, 60_000);

  it('survives a failing telemetry flush', async () => {
    const probe = start({ YEONJAE_TELEMETRY_FAILS: '1' });
    await probe.waitFor('listening');
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.telemetryFlushed).toBe(false);
    expect(drained.outcome).toBe('clean');
  }, 60_000);

  it('closes the remaining resources when one close fails, and reports it', async () => {
    const probe = start({ YEONJAE_CLOSE_FAILS: '1' });
    await probe.waitFor('listening');
    probe.signal('SIGTERM');
    const drained = await probe.waitFor('drained');
    expect(drained.closeFailures).toEqual(['temporal']);
    // The pool still closed: an early throw would have stranded database connections open.
    expect(drained.closed).toEqual(['health', 'pool']);
    expect(drained.outcome).toBe('dependency_failure');
    expect((await probe.waitForExit()).code).toBe(EXIT_CODE.dependency_failure);
  }, 60_000);

  it('leaves no listening socket, no database backend and no process behind', async () => {
    const probe = start();
    const port = Number((await probe.waitFor('listening')).port);
    const pid = probe.pid;
    probe.signal('SIGTERM');
    await probe.waitForExit();

    // The process is gone...
    expect(pid).toBeDefined();
    let alive = true;
    try {
      // Signal 0 checks existence without delivering anything.
      process.kill(pid ?? -1, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);

    // ...its port is free...
    await expect(probeHttp(port, '/health')).rejects.toThrow();

    // ...and it left no database backend behind.
    const checker = createPool({ connectionString: databaseUrl() ?? '', max: 1 });
    try {
      const r = await checker.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND state = 'idle' AND application_name = ''`,
      );
      expect(Number(r.rows[0]?.n ?? '0')).toBe(0);
    } finally {
      await checker.end();
    }
  }, 60_000);
});
