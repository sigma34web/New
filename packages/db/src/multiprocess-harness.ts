/**
 * A harness for tests that need GENUINELY SEPARATE execution contexts.
 *
 * WHY THIS EXISTS. Every coordination property that matters here — the last concurrency slot, two
 * reservations that must not both win, a worker dying while holding a lease — is invisible to a
 * single-process test. The repository's vitest configuration sets `fileParallelism: false` because the
 * integration suites share one database, so the inherited advice was "multi-process tests need the
 * shared-database reset race fixed first". This module fixes it by construction.
 *
 * THE RESET RACE, AND WHY THE FIX IS ISOLATION RATHER THAN RETRIES. `resetDatabase` drops the `public`
 * and `canon` schemas. Two contexts pointed at one database will therefore delete each other's tables
 * mid-test, and no amount of sleeping or retrying makes that correct — it only makes the failure rarer,
 * which is worse. So each context gets its OWN DATABASE, created from the same migrations: there is no
 * shared mutable namespace left to race over, and the coordination under test happens where it really
 * happens in production (inside one database, between separate processes) rather than between test
 * harnesses.
 *
 * Children are real `node` processes, not workers on a shared loop: a test that must kill a participant
 * after it has acquired a resource needs a participant that can actually die.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createPool, type Pool } from './client.js';
import { migrate } from './migrate.js';

/** Parsed connection parts, so a per-test database name can be substituted into the URL. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function adminUrl(url: string): string {
  // `postgres` always exists and is never the database being created or dropped.
  return withDatabase(url, 'postgres');
}

/**
 * A database created for one test, plus its teardown.
 *
 * The name carries a random suffix rather than a counter so two concurrently running FILES cannot
 * collide either — the isolation property must not depend on the runner's scheduling.
 */
export interface IsolatedDatabase {
  readonly url: string;
  readonly name: string;
  readonly pool: Pool;
  drop(): Promise<void>;
}

export async function createIsolatedDatabase(
  baseUrl: string,
  label = 'mp',
): Promise<IsolatedDatabase> {
  const name = `yeonjae_${label}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = createPool({ connectionString: adminUrl(baseUrl), max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(baseUrl, name);
  const pool = createPool({ connectionString: url, max: 8 });
  await migrate(pool);
  return {
    url,
    name,
    pool,
    drop: async (): Promise<void> => {
      await pool.end();
      const dropper = createPool({ connectionString: adminUrl(baseUrl), max: 1 });
      try {
        // FORCE terminates leftover backends, so a child that died mid-query cannot block teardown and
        // leave a database behind for the next run to trip over.
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** One line of structured output from a child context. Free-form text is never parsed as a signal. */
export interface ChildEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

/**
 * A child execution context: a real OS process that reports progress as JSON lines.
 *
 * The API is deliberately event-driven rather than time-driven. `waitFor` resolves on an event the child
 * PRINTED, so a test synchronises on the child genuinely having reached a state — no sleeps, and no
 * assumption about how fast a process starts.
 */
export class ChildContext {
  private readonly events: ChildEvent[] = [];
  private readonly waiters: {
    match: (e: ChildEvent) => boolean;
    resolve: (e: ChildEvent) => void;
  }[] = [];
  private readonly child: ChildProcess;
  private stderrText = '';
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private readonly exitWaiters: (() => void)[] = [];

  constructor(
    readonly id: string,
    script: string,
    env: Readonly<Record<string, string>>,
  ) {
    this.child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env, YEONJAE_CHILD_ID: id },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    this.child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        let parsed: ChildEvent | undefined;
        try {
          parsed = JSON.parse(line) as ChildEvent;
        } catch {
          continue; // Not a signal line; ignored rather than guessed at.
        }
        this.events.push(parsed);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const w = this.waiters[i];
          if (w?.match(parsed) === true) {
            this.waiters.splice(i, 1);
            w.resolve(parsed);
          }
        }
      }
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrText += chunk.toString('utf8');
    });
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const w of this.exitWaiters.splice(0)) w();
    });
  }

  get pid(): number | undefined {
    return this.child.pid ?? undefined;
  }

  get stderr(): string {
    return this.stderrText;
  }

  seen(): readonly ChildEvent[] {
    return this.events;
  }

  /** Resolve when the child has reported `event`, including one it reported already. */
  async waitFor(event: string, timeoutMs = 20_000): Promise<ChildEvent> {
    const already = this.events.find((e) => e.event === event);
    if (already) return already;
    return new Promise<ChildEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `child ${this.id} never reported '${event}'; saw [${this.events
              .map((e) => e.event)
              .join(', ')}]; stderr: ${this.stderrText.slice(0, 2000)}`,
          ),
        );
      }, timeoutMs);
      this.waiters.push({
        match: (e) => e.event === event,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }

  private exitState(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exited;
  }

  /** Kill without a chance to clean up: the "process death" case, not a graceful shutdown. */
  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.child.kill(signal);
  }

  async waitForExit(timeoutMs = 20_000): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    if (this.exited) return this.exited;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`child ${this.id} did not exit within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Read through a method so the check is a FRESH evaluation. The field is assigned by the 'exit'
    // listener registered in the constructor, which TypeScript's control-flow analysis cannot see: after
    // the `if (this.exited)` above it narrows the property to undefined and calls this branch dead.
    const exited = this.exitState();
    if (!exited) throw new Error(`child ${this.id} exit was not recorded`);
    return exited;
  }

  /** Teardown that is safe to call twice and on an already-dead child. */
  async dispose(): Promise<void> {
    if (!this.exited) {
      this.child.kill('SIGKILL');
      try {
        await this.waitForExit(5_000);
      } catch {
        // A child that cannot be reaped must not fail the test's cleanup; the assertion that no
        // process leaked is made separately and explicitly.
      }
    }
    this.child.stdout?.removeAllListeners();
    this.child.stderr?.removeAllListeners();
    this.child.removeAllListeners();
  }
}

/** Is the process still alive? Used by the no-leak assertions, which must not merely assume. */
export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
