/**
 * Connection helpers. One pool per process; every unit of work runs inside `withTransaction` so canon writes
 * are atomic and session settings (canon.in_commit) never leak between statements.
 */
import pg from 'pg';

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export interface DbConfig {
  readonly connectionString: string;
  readonly max?: number | undefined;
}

export function createPool(config: DbConfig): Pool {
  return new pg.Pool({ connectionString: config.connectionString, max: config.max ?? 8 });
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return { connectionString: url };
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` in a transaction on an ALREADY-SCOPED client.
 *
 * `withTransaction` takes a pool and checks out its own connection, which is wrong for anything
 * running inside `withWorkspace`: a fresh connection has none of the caller's RLS scope, so the work
 * would silently execute unscoped. This variant reuses the caller's connection and therefore its
 * scope, which is what every request-scoped multi-statement write needs.
 */
export async function inClientTransaction<T>(
  client: Client,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

/** Postgres raises canon errors as P0001 with the code in HINT; surface them as typed errors. */
export class CanonDbError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CanonDbError';
  }
}

export function asCanonError(err: unknown): CanonDbError | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: string; hint?: string; message?: string };
  if (e.code === 'P0001' && e.hint) {
    const msg = e.message ?? '';
    return new CanonDbError(
      e.hint,
      msg.startsWith(`${e.hint}: `) ? msg.slice(e.hint.length + 2) : msg,
    );
  }
  if (e.code === '23P01')
    return new CanonDbError('VALIDITY_OVERLAP', e.message ?? 'exclusion constraint violated');
  return undefined;
}

export function rethrowCanon(err: unknown): never {
  throw asCanonError(err) ?? err;
}
