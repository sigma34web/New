/**
 * Backup manifest validation (Workstream C).
 *
 * Every case here is a restore that MUST be refused. The reason to enumerate them rather than test a
 * happy path plus "some invalid input" is that each failure has a different remedy, and a validator that
 * collapses them into one error sends an operator to the wrong place during an incident: a truncated
 * artifact is a storage problem, a mis-associated manifest is an operator mistake, and a newer schema is
 * a deploy-order problem.
 *
 * These are pure filesystem/CPU tests: no database and no credentials are involved.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoSecrets,
  checksumOf,
  compareMigration,
  MANIFEST_VERSION,
  parseManifest,
  verifyBackup,
  versionSupported,
  type BackupManifest,
} from './backup-manifest.js';

describe('backup manifests (Workstream C)', () => {
  let dir: string;
  let artifactPath: string;
  const ARTIFACT = 'source.dump';
  const CONTENT = 'PGDMP-deterministic-fixture-content';

  async function manifestFor(overrides: Partial<BackupManifest> = {}): Promise<BackupManifest> {
    return {
      manifest_version: MANIFEST_VERSION,
      created_at: '2026-01-01T00:00:00.000Z',
      method: 'pg_dump_custom',
      database_identifier: 'yeonjae_drill_source',
      artifact_name: ARTIFACT,
      artifact_bytes: Buffer.byteLength(CONTENT, 'utf8'),
      checksum_algorithm: 'sha256',
      checksum: await checksumOf(artifactPath),
      migration_version: '0017',
      migration_count: 17,
      postgres_version: '16.14',
      compatibility: { min_application_migration: '0001', requires_extensions: [] },
      restore_prerequisites: ['an empty target database'],
      secrets_excluded: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yeonjae-manifest-'));
    artifactPath = join(dir, ARTIFACT);
    writeFileSync(artifactPath, CONTENT, 'utf8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a valid manifest describing an intact artifact', async () => {
    const verdict = await verifyBackup({
      manifest: await manifestFor(),
      artifactPath,
      applicationMigration: '0017',
    });
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('refuses a checksum mismatch', async () => {
    const manifest = await manifestFor({ checksum: 'f'.repeat(64) });
    const verdict = await verifyBackup({ manifest, artifactPath, applicationMigration: '0017' });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('CHECKSUM_MISMATCH');
  });

  it('refuses a truncated artifact, and names truncation rather than corruption', async () => {
    const manifest = await manifestFor();
    truncateSync(artifactPath, 5);
    const verdict = await verifyBackup({ manifest, artifactPath, applicationMigration: '0017' });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('ARTIFACT_TRUNCATED');
  });

  it('refuses a missing manifest', () => {
    const verdict = parseManifest(undefined);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('MANIFEST_MALFORMED');
  });

  it('refuses a malformed manifest, naming the missing field', () => {
    const verdict = parseManifest({ manifest_version: '1.0' });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('MANIFEST_MALFORMED');
    expect(verdict.failures[0]?.detail).toContain('created_at');
  });

  it('refuses an unsupported manifest version rather than guessing at the format', async () => {
    const verdict = parseManifest(await manifestFor({ manifest_version: '2.0' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('MANIFEST_VERSION_UNSUPPORTED');
  });

  it('accepts an older compatible minor version but refuses a newer minor', () => {
    expect(versionSupported('1.0')).toBe(true);
    expect(versionSupported('1.9')).toBe(false);
    expect(versionSupported('0.9')).toBe(false);
    expect(versionSupported('nonsense')).toBe(false);
  });

  it('refuses a backup whose schema is newer than the application', async () => {
    const manifest = await manifestFor({ migration_version: '0021' });
    const verdict = await verifyBackup({ manifest, artifactPath, applicationMigration: '0017' });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('SCHEMA_NEWER_THAN_APPLICATION');
  });

  it('refuses a backup below the supported schema floor', async () => {
    const manifest = await manifestFor({ migration_version: '0000' });
    const verdict = await verifyBackup({ manifest, artifactPath, applicationMigration: '0017' });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('SCHEMA_UNSUPPORTED_OLD');
  });

  it('refuses a manifest paired with the wrong artifact', async () => {
    const other = join(dir, 'other.dump');
    writeFileSync(other, CONTENT, 'utf8');
    const manifest = await manifestFor();
    const verdict = await verifyBackup({
      manifest,
      artifactPath: other,
      applicationMigration: '0017',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('ARTIFACT_MISASSOCIATED');
  });

  it('refuses a missing artifact', async () => {
    const manifest = await manifestFor();
    const verdict = await verifyBackup({
      manifest,
      artifactPath: join(dir, 'absent.dump'),
      applicationMigration: '0017',
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('ARTIFACT_MISSING');
  });

  it('refuses a manifest that does not assert secret exclusion', async () => {
    const manifest = await manifestFor();
    const without = { ...manifest, secrets_excluded: false };
    const verdict = parseManifest(without);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.code).toBe('SECRETS_NOT_EXCLUDED');
  });

  it('refuses to build a manifest that would carry a credential', async () => {
    const manifest = await manifestFor({
      database_identifier: 'postgres://user:hunter2@localhost:5432/db',
    });
    expect(() => {
      assertNoSecrets(manifest);
    }).toThrow(/connection URL/);

    const withPassword = await manifestFor({ restore_prerequisites: ['PGPASSWORD must be set'] });
    expect(() => {
      assertNoSecrets(withPassword);
    }).toThrow(/libpq password variable/);
  });

  it('is repeatable: verifying the same artifact twice gives the same verdict', async () => {
    const manifest = await manifestFor();
    const first = await verifyBackup({ manifest, artifactPath, applicationMigration: '0017' });
    const second = await verifyBackup({ manifest, artifactPath, applicationMigration: '0017' });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
  });

  it('orders migration ids numerically, not lexically', () => {
    expect(compareMigration('0009', '0017')).toBe(-1);
    expect(compareMigration('0017', '0017')).toBe(0);
    expect(compareMigration('0021', '0017')).toBe(1);
  });
});
