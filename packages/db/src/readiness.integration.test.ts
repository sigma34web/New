/**
 * Readiness checks (Workstream D).
 *
 * `/ready` previously ran `SELECT 1`, which proves the pool can reach *a* database and nothing else.
 * Every case here drives a failure that `SELECT 1` reports as healthy: a database behind on migrations,
 * a database ahead of the code, a tampered ledger, and an application role that has quietly been given
 * superuser or BYPASSRLS.
 *
 * The role case is the one worth the most: it is the misconfiguration that makes every tenant-isolation
 * test in this repository pass for the wrong reason while isolation does not exist.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAppRole,
  checkMigrations,
  checkProviderMode,
  createPool,
  expectedMigrations,
  migrate,
  migrationsDir,
  readiness,
  resetDatabase,
  type Pool,
} from './index.js';
import { databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

run('readiness fails for the reasons that matter (Workstream D)', () => {
  let pool: Pool;

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    pool = createPool({ connectionString: url, max: 4 });
  }, 120_000);

  beforeEach(async () => {
    await resetDatabase(pool);
    await migrate(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('is ready when the schema matches the build', async () => {
    const report = await readiness(pool);
    expect(report.ready).toBe(true);
    expect(report.degraded).toBe(false);
    expect(report.checks.map((c) => c.name)).toEqual(['database', 'migrations', 'app_role']);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('refuses readiness when the database is behind the build', async () => {
    // The deployment-ordering failure: the app rolled forward before the migration job finished. With
    // SELECT 1 this instance would take traffic and fail on the first real request.
    const all = readdirSync(migrationsDir())
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const behind = all.at(-1);
    if (behind === undefined) throw new Error('no migrations');
    await pool.query('DELETE FROM schema_migrations WHERE name = $1', [behind]);

    const check = await checkMigrations(pool);
    expect(check.status).toBe('fail');
    expect(check.missing).toEqual([behind]);
    expect(check.detail).toMatch(/not applied/);
    expect((await readiness(pool)).ready).toBe(false);
  });

  it('refuses readiness when the schema is AHEAD of the build', async () => {
    // A rollback that left the database in front of the code. Writing rows a newer schema's invariants
    // were meant to constrain is worse than refusing traffic.
    await pool.query(
      `INSERT INTO schema_migrations (name, hash) VALUES ('9999_from_the_future.sql', 'deadbeef')`,
    );
    const check = await checkMigrations(pool);
    expect(check.status).toBe('fail');
    expect(check.unknown).toEqual(['9999_from_the_future.sql']);
    expect(check.detail).toMatch(/ahead of the code/);
  });

  it('refuses readiness when an applied migration no longer matches its recorded hash', async () => {
    const [first] = [...expectedMigrations().keys()];
    if (first === undefined) throw new Error('no migrations');
    await pool.query('UPDATE schema_migrations SET hash = $2 WHERE name = $1', [first, 'tampered']);
    const check = await checkMigrations(pool);
    expect(check.status).toBe('fail');
    expect(check.hashMismatches).toEqual([first]);
  });

  it('refuses readiness against an empty or foreign database without leaking the driver error', async () => {
    await pool.query('DROP TABLE IF EXISTS schema_migrations');
    const check = await checkMigrations(pool);
    expect(check.status).toBe('fail');
    expect(check.applied).toBe(0);
    // Readiness answers a load balancer; it must not become a diagnostic channel.
    expect(check.detail).not.toMatch(/relation|syntax|postgres:|password/i);
  });

  it('refuses readiness when the application role could bypass row-level security', async () => {
    // The misconfiguration that voids every isolation guarantee while the app looks perfectly healthy.
    await pool.query('ALTER ROLE yeonjae_app BYPASSRLS');
    try {
      const check = await checkAppRole(pool);
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/bypassrls/);
      expect(check.detail).toMatch(/voids row-level security/);
      expect((await readiness(pool)).ready).toBe(false);
    } finally {
      await pool.query('ALTER ROLE yeonjae_app NOBYPASSRLS');
    }
  });

  it('refuses readiness when the application role is a superuser', async () => {
    await pool.query('ALTER ROLE yeonjae_app SUPERUSER');
    try {
      const check = await checkAppRole(pool);
      expect(check.status).toBe('fail');
      expect(check.detail).toMatch(/superuser/);
    } finally {
      await pool.query('ALTER ROLE yeonjae_app NOSUPERUSER');
    }
  });

  it('validates the provider mode without ever defaulting to a paid provider', () => {
    expect(checkProviderMode({}).status).toBe('fail');
    expect(checkProviderMode({ YEONJAE_PROVIDER_MODE: '' }).status).toBe('fail');
    expect(checkProviderMode({ YEONJAE_PROVIDER_MODE: 'anything' }).status).toBe('fail');
    expect(checkProviderMode({ YEONJAE_PROVIDER_MODE: 'replay' }).status).toBe('pass');
    expect(checkProviderMode({ YEONJAE_PROVIDER_MODE: 'synthetic' }).status).toBe('pass');
  });

  it('requires a provider mode only where the process needs one', async () => {
    const withMode = await readiness(pool, {
      requireProviderMode: true,
      env: { YEONJAE_PROVIDER_MODE: 'replay' },
    });
    expect(withMode.ready).toBe(true);
    const withoutMode = await readiness(pool, { requireProviderMode: true, env: {} });
    expect(withoutMode.ready).toBe(false);
    // A read-only API instance is not required to name a provider.
    expect((await readiness(pool, { requireProviderMode: false })).ready).toBe(true);
  });

  it('reports an optional dependency as DEGRADED rather than failing readiness', async () => {
    // The distinction that stops an orchestrator killing healthy processes during a provider outage: a
    // missing optional dependency degrades, it does not make the instance unfit to serve.
    const report = await readiness(pool, {
      optional: [
        { name: 'temporal', probe: async () => false },
        { name: 'artifact_store', probe: async () => true },
      ],
    });
    expect(report.ready).toBe(true);
    expect(report.degraded).toBe(true);
    expect(report.checks.find((c) => c.name === 'temporal')?.status).toBe('degraded');
    expect(report.checks.find((c) => c.name === 'artifact_store')?.status).toBe('pass');
  });

  it('treats an optional probe that throws as degraded, not as a crash', async () => {
    const report = await readiness(pool, {
      optional: [
        {
          name: 'flaky',
          probe: async () => {
            throw new Error('probe exploded');
          },
        },
      ],
    });
    expect(report.ready).toBe(true);
    expect(report.checks.find((c) => c.name === 'flaky')?.status).toBe('degraded');
    // The thrown message must not reach the response.
    expect(JSON.stringify(report)).not.toContain('probe exploded');
  });

  it('exposes no credential, connection string or manuscript content', async () => {
    const serialized = JSON.stringify(
      await readiness(pool, { requireProviderMode: true, env: { YEONJAE_PROVIDER_MODE: 'mock' } }),
    );
    for (const pattern of [/postgres(ql)?:\/\//, /password/i, /yeonjae:yeonjae/, /secret/i]) {
      expect(serialized).not.toMatch(pattern);
    }
  });

  it('counts the migrations this build ships, hashed from disk', () => {
    const expected = expectedMigrations();
    const onDisk = readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql'));
    expect(expected.size).toBe(onDisk.length);
    for (const [, hash] of expected) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a migrations directory that matches the ledger exactly', async () => {
    // Guards the comparison itself: a copy of the real directory must be accepted, so a failure above
    // means a genuine mismatch rather than a path or hashing bug.
    const dir = mkdtempSync(join(tmpdir(), 'yeonjae-ready-'));
    try {
      for (const f of readdirSync(migrationsDir()).filter((n) => n.endsWith('.sql'))) {
        writeFileSync(join(dir, f), readFileSync(join(migrationsDir(), f)));
      }
      const check = await checkMigrations(pool, dir);
      expect(check.status).toBe('pass');
      expect(check.missing).toEqual([]);
      expect(check.unknown).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
