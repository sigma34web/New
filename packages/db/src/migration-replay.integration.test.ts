/**
 * Migration-chain properties that the privilege model depends on (ADR-0050).
 *
 * A privilege repair is only worth as much as the migration runner's guarantees. These cases prove the
 * three that matter for 0014 and were not covered elsewhere: a second invocation of the runner is a no-op
 * rather than a re-REVOKE, a modified historical migration is refused by the existing content-hash
 * protection rather than replayed, and a clean install converges on exactly the same privilege state as an
 * upgrade from an older schema — which is the scenario a revocation migration can silently get wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ROLE, createPool, migrate, migrationsDir, resetDatabase, type Pool } from './index.js';
import { databaseUrl } from './testkit.js';

const run = databaseUrl() ? describe : describe.skip;

/** The security-relevant state of the database, as a single comparable string. */
async function securityFingerprint(pool: Pool): Promise<string> {
  const r = await pool.query<{ fingerprint: string }>(
    `SELECT
       (SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
          SELECT DISTINCT table_name || ':' || privilege_type AS t
            FROM information_schema.role_table_grants
           WHERE grantee = $1 AND table_schema = 'public') s)
       || '|' ||
       (SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
          SELECT p.proname
                 || ':app=' || has_function_privilege($1, p.oid, 'EXECUTE')::text
                 || ':public=' || has_function_privilege('public', p.oid, 'EXECUTE')::text AS t
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'canon') s)
       || '|' ||
       (SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
          SELECT c.relname || ':rls=' || c.relrowsecurity::text
                 || ':force=' || c.relforcerowsecurity::text AS t
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r') s)
       || '|' ||
       (SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
          SELECT c.relname
                 || ':U=' || has_sequence_privilege($1, c.oid, 'USAGE')::text
                 || ':S=' || has_sequence_privilege($1, c.oid, 'SELECT')::text
                 || ':W=' || has_sequence_privilege($1, c.oid, 'UPDATE')::text AS t
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind = 'S' AND n.nspname = 'public') s)
       AS fingerprint`,
    [APP_ROLE],
  );
  return r.rows[0]?.fingerprint ?? '';
}

run('migration chain replay, content-hash protection and clean-install convergence', () => {
  let pool: Pool;

  beforeAll(async () => {
    const url = databaseUrl();
    if (!url) throw new Error('DATABASE_URL not set');
    pool = createPool({ connectionString: url, max: 4 });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
  });

  it('applies the whole chain on a clean database and skips everything on a second run', async () => {
    // The chain's length and its newest filename are read from disk rather than pinned: pinning them
    // makes every later migration fail this case for no reason, which is how the first version of this
    // test broke the moment 0015 landed.
    const files = readdirSync(migrationsDir())
      .filter((f) => f.endsWith('.sql'))
      .sort();
    await resetDatabase(pool);
    const first = await migrate(pool);
    expect(first.applied).toEqual(files);
    expect(first.skipped).toEqual([]);
    // Applied in name order, and the privilege repair is still part of the chain: a renumbering mistake
    // or a lost migration fails here.
    expect(first.applied).toContain('0014_append_only_least_privilege.sql');

    const before = await securityFingerprint(pool);
    const second = await migrate(pool);
    // Idempotency: a second invocation must re-run nothing at all, not merely be harmless.
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(first.applied.length);
    expect(await securityFingerprint(pool)).toBe(before);

    // A third invocation too, since a revocation migration that re-ran would still look idempotent once.
    const third = await migrate(pool);
    expect(third.applied).toEqual([]);
    expect(await securityFingerprint(pool)).toBe(before);
  }, 180_000);

  it('converges on the same privilege state whether installed clean or upgraded from the prior schema', async () => {
    // The property a revocation migration can silently get wrong: REVOKE only removes what an earlier
    // migration granted, so a clean install that never held the privilege and an upgrade that did must
    // still end up identical. "Prior schema" means everything except the NEWEST migration, computed
    // from disk so this stays true as the chain grows.
    const dir = migrationsDir();
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const newest = all.at(-1);
    if (newest === undefined) throw new Error('no migrations found');
    const upToPrior = all.slice(0, -1);
    expect(upToPrior.length).toBe(all.length - 1);

    // Upgrade path: apply the chain as it stood before 0014, then apply the full chain on top.
    const staged = mkdtempSync(join(tmpdir(), 'yeonjae-migrations-'));
    try {
      for (const f of upToPrior) writeFileSync(join(staged, f), readFileSync(join(dir, f)));
      await resetDatabase(pool);
      await migrate(pool, staged);
      const priorFingerprint = await securityFingerprint(pool);
      const upgrade = await migrate(pool);
      expect(upgrade.applied).toEqual([newest]);
      const upgraded = await securityFingerprint(pool);
      // The upgrade must actually change the security state, or the migration is a no-op.
      expect(upgraded).not.toBe(priorFingerprint);

      await resetDatabase(pool);
      await migrate(pool);
      expect(await securityFingerprint(pool)).toBe(upgraded);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  }, 180_000);

  it('refuses a historical migration that was modified after being applied', async () => {
    // The forward-only guarantee. Without it, editing 0007 or 0013 to re-grant a privilege would pass
    // silently on an existing database while a clean install got the narrower state.
    const dir = migrationsDir();
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const staged = mkdtempSync(join(tmpdir(), 'yeonjae-tamper-'));
    try {
      for (const f of all) writeFileSync(join(staged, f), readFileSync(join(dir, f)));
      await resetDatabase(pool);
      await migrate(pool, staged);

      const victim = '0013_llm_calls_audit_grants.sql';
      writeFileSync(
        join(staged, victim),
        `${readFileSync(join(staged, victim), 'utf8')}\n-- tampered\n`,
      );
      await expect(migrate(pool, staged)).rejects.toThrow(/was modified after being applied/);

      // And the rejection must not have half-applied anything: the ledger still matches the originals.
      const ledger = await pool.query<{ name: string; hash: string }>(
        'SELECT name, hash FROM schema_migrations ORDER BY name',
      );
      expect(ledger.rows.length).toBe(all.length);
      const { createHash } = await import('node:crypto');
      for (const row of ledger.rows) {
        const expected = createHash('sha256')
          .update(readFileSync(join(dir, row.name), 'utf8'))
          .digest('hex');
        expect({ name: row.name, hash: row.hash }).toEqual({ name: row.name, hash: expected });
      }
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  }, 180_000);

  it('rolls a failing migration back completely, leaving no partial grant behind', async () => {
    // A migration runs inside one transaction. If a later statement fails, an earlier REVOKE in the same
    // file must not survive — otherwise a failed deploy leaves the database in a state no migration
    // describes.
    const dir = migrationsDir();
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const staged = mkdtempSync(join(tmpdir(), 'yeonjae-failing-'));
    try {
      for (const f of all) writeFileSync(join(staged, f), readFileSync(join(dir, f)));
      await resetDatabase(pool);
      await migrate(pool, staged);
      const before = await securityFingerprint(pool);

      writeFileSync(
        join(staged, '0015_deliberately_failing.sql'),
        [
          'REVOKE SELECT ON audit_log FROM yeonjae_app;',
          'SELECT 1 / 0;', // fails, after the revoke
        ].join('\n'),
      );
      await expect(migrate(pool, staged)).rejects.toThrow();

      expect(await securityFingerprint(pool)).toBe(before);
      const recorded = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM schema_migrations WHERE name = '0015_deliberately_failing.sql'`,
      );
      expect(recorded.rows[0]?.n).toBe('0');
    } finally {
      rmSync(staged, { recursive: true, force: true });
      // Leave the shared database on the real chain for any suite that follows.
      await resetDatabase(pool);
      await migrate(pool);
    }
  }, 180_000);
});
