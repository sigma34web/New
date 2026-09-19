/**
 * Versioned backup manifests (Workstream C).
 *
 * The inherited drill proves a logical dump can be restored and that the restored database still holds
 * its security invariants. What it does NOT answer is the question an operator actually faces in an
 * incident: *is this artifact on disk the one I think it is, is it intact, and may this build of the
 * application restore it at all?* A backup without that metadata is an untested assumption.
 *
 * A manifest is therefore a small, self-describing, side-car document, and every field exists to refuse
 * a specific bad restore:
 *
 *  * `manifest_version` — so a future format change is REFUSED by an old reader instead of being
 *    misparsed. An unknown major version is unsupported, never "probably fine".
 *  * `migration_version` / `migration_count` — so a dump from a SCHEMA NEWER than this build is refused
 *    rather than restored into an application that cannot understand it, and an ancient schema below the
 *    supported floor is refused rather than silently half-migrated.
 *  * `checksum` — so a corrupted or truncated artifact fails BEFORE it touches a database, which is the
 *    only point at which failing is cheap.
 *  * `artifact_bytes` — a truncation that preserved a stale checksum is still caught by the size.
 *  * `database_identifier` — a SAFE label, so a manifest cannot be paired with the wrong artifact.
 *  * `secrets_excluded` — an explicit, checkable statement that the backup carries no credentials, so
 *    "backups contain no secrets" is a property of the format rather than a claim in a runbook.
 *
 * Nothing here writes a secret: the manifest deliberately has no field for a connection string,
 * password or provider key, and `assertNoSecrets` re-checks that a manifest about to be written does not
 * smuggle one through its free-text fields.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Pool } from './client.js';

/**
 * The manifest format version.
 *
 * Compatibility is decided on the MAJOR component only: a reader accepts a manifest whose major matches
 * and whose minor is less than or equal to its own, because a minor bump may only ADD optional fields.
 */
export const MANIFEST_VERSION = '1.0';

/** The oldest schema this build can restore. Below it, a restore would need migrations that no longer exist. */
export const MIN_SUPPORTED_MIGRATION = '0001';

export type BackupMethod = 'pg_dump_custom' | 'pg_basebackup' | 'pg_dump_plain';

export interface BackupManifest {
  readonly manifest_version: string;
  readonly created_at: string;
  readonly method: BackupMethod;
  /** A SAFE identifier: a database name or drill id, never a connection string. */
  readonly database_identifier: string;
  readonly artifact_name: string;
  readonly artifact_bytes: number;
  readonly checksum_algorithm: 'sha256';
  readonly checksum: string;
  /** The highest migration applied when the backup was taken. */
  readonly migration_version: string;
  readonly migration_count: number;
  readonly postgres_version: string;
  readonly compatibility: {
    readonly min_application_migration: string;
    readonly requires_extensions: readonly string[];
  };
  readonly restore_prerequisites: readonly string[];
  /** An explicit, checkable statement rather than an assumption. */
  readonly secrets_excluded: true;
}

export type ManifestFailureCode =
  | 'MANIFEST_MISSING'
  | 'MANIFEST_MALFORMED'
  | 'MANIFEST_VERSION_UNSUPPORTED'
  | 'ARTIFACT_MISSING'
  | 'CHECKSUM_MISMATCH'
  | 'ARTIFACT_TRUNCATED'
  | 'ARTIFACT_MISASSOCIATED'
  | 'SCHEMA_NEWER_THAN_APPLICATION'
  | 'SCHEMA_UNSUPPORTED_OLD'
  | 'SECRETS_NOT_EXCLUDED';

export interface ManifestVerdict {
  readonly ok: boolean;
  readonly failures: readonly { code: ManifestFailureCode; detail: string }[];
  readonly manifest: BackupManifest | undefined;
}

function fail(code: ManifestFailureCode, detail: string): ManifestVerdict {
  return { ok: false, failures: [{ code, detail }], manifest: undefined };
}

/** sha256 of a file, streamed so a large artifact is never held in memory. */
export async function checksumOf(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      resolve();
    });
  });
  return hash.digest('hex');
}

/**
 * Parse and structurally validate a manifest document.
 *
 * Kept separate from artifact verification so a malformed manifest is distinguishable from a good
 * manifest describing a bad artifact — different causes with different remedies.
 */
export function parseManifest(raw: unknown): ManifestVerdict {
  if (raw === null || typeof raw !== 'object')
    return fail('MANIFEST_MALFORMED', 'the manifest is not a JSON object');
  const m = raw as Record<string, unknown>;

  const version = m.manifest_version;
  if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version))
    return fail('MANIFEST_MALFORMED', 'manifest_version is missing or not "<major>.<minor>"');
  const compatible = versionSupported(version);
  if (!compatible)
    return fail(
      'MANIFEST_VERSION_UNSUPPORTED',
      `manifest version ${version} is not supported by this build (${MANIFEST_VERSION})`,
    );

  const required: readonly (keyof BackupManifest)[] = [
    'created_at',
    'method',
    'database_identifier',
    'artifact_name',
    'artifact_bytes',
    'checksum_algorithm',
    'checksum',
    'migration_version',
    'migration_count',
    'postgres_version',
    'secrets_excluded',
  ];
  for (const key of required)
    if (m[key] === undefined || m[key] === null)
      return fail('MANIFEST_MALFORMED', `field "${key}" is missing`);

  if (m.checksum_algorithm !== 'sha256')
    return fail('MANIFEST_MALFORMED', 'checksum_algorithm must be "sha256"');
  if (typeof m.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(m.checksum))
    return fail('MANIFEST_MALFORMED', 'checksum must be a 64-character hex sha256 digest');
  if (
    typeof m.artifact_bytes !== 'number' ||
    !Number.isInteger(m.artifact_bytes) ||
    m.artifact_bytes < 0
  )
    return fail('MANIFEST_MALFORMED', 'artifact_bytes must be a non-negative integer');
  if (Number.isNaN(Date.parse(String(m.created_at))))
    return fail('MANIFEST_MALFORMED', 'created_at must be an ISO-8601 timestamp');
  // A manifest that does not ASSERT secret exclusion is refused rather than assumed safe.
  if (m.secrets_excluded !== true)
    return fail('SECRETS_NOT_EXCLUDED', 'the manifest does not assert that secrets are excluded');

  return { ok: true, failures: [], manifest: raw as unknown as BackupManifest };
}

/** Major must match; minor may not exceed this build's. */
export function versionSupported(version: string): boolean {
  const [major, minor] = version.split('.').map((p) => Number(p));
  const [ourMajor, ourMinor] = MANIFEST_VERSION.split('.').map((p) => Number(p));
  if (major === undefined || minor === undefined) return false;
  if (ourMajor === undefined || ourMinor === undefined) return false;
  return major === ourMajor && minor <= ourMinor;
}

export interface VerifyInput {
  readonly manifest: unknown;
  /** Path to the artifact the manifest claims to describe. */
  readonly artifactPath: string;
  /** The highest migration this build knows about. A backup ahead of it cannot be restored. */
  readonly applicationMigration: string;
  /** Skip the (streamed) checksum when only structural checks are wanted. */
  readonly skipChecksum?: boolean | undefined;
}

/**
 * Verify a manifest against the artifact it describes and against this build.
 *
 * Checks run cheapest-first and STOP at the first failure, so the reported cause is the real one rather
 * than a cascade: an artifact that is missing has no meaningful checksum, and a truncated artifact would
 * otherwise report both a size and a checksum failure for one underlying fault.
 */
export async function verifyBackup(input: VerifyInput): Promise<ManifestVerdict> {
  const parsed = parseManifest(input.manifest);
  if (!parsed.ok || !parsed.manifest) return parsed;
  const manifest = parsed.manifest;

  // Schema compatibility, before touching the artifact at all.
  if (compareMigration(manifest.migration_version, input.applicationMigration) > 0)
    return fail(
      'SCHEMA_NEWER_THAN_APPLICATION',
      `the backup is at migration ${manifest.migration_version}, newer than this build's ${input.applicationMigration}`,
    );
  if (compareMigration(manifest.migration_version, MIN_SUPPORTED_MIGRATION) < 0)
    return fail(
      'SCHEMA_UNSUPPORTED_OLD',
      `the backup is at migration ${manifest.migration_version}, below the supported floor ${MIN_SUPPORTED_MIGRATION}`,
    );

  let size: number;
  try {
    size = (await stat(input.artifactPath)).size;
  } catch {
    return fail('ARTIFACT_MISSING', 'the artifact named by the manifest does not exist');
  }

  // A manifest paired with a DIFFERENT artifact is a distinct fault from corruption, and naming it
  // correctly is what stops an operator from hunting a disk problem that does not exist.
  if (!input.artifactPath.endsWith(manifest.artifact_name))
    return fail(
      'ARTIFACT_MISASSOCIATED',
      `the manifest describes "${manifest.artifact_name}" but was given a different artifact`,
    );

  if (size !== manifest.artifact_bytes)
    return fail(
      size < manifest.artifact_bytes ? 'ARTIFACT_TRUNCATED' : 'CHECKSUM_MISMATCH',
      `the artifact is ${String(size)} bytes; the manifest records ${String(manifest.artifact_bytes)}`,
    );

  if (input.skipChecksum !== true) {
    const actual = await checksumOf(input.artifactPath);
    if (actual !== manifest.checksum)
      return fail('CHECKSUM_MISMATCH', 'the artifact checksum does not match the manifest');
  }

  return { ok: true, failures: [], manifest };
}

/** Compare zero-padded migration ids ("0009" < "0017"). */
export function compareMigration(a: string, b: string): number {
  const na = Number(a.slice(0, 4));
  const nb = Number(b.slice(0, 4));
  if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
  return na === nb ? 0 : na < nb ? -1 : 1;
}

/**
 * Refuse to write a manifest that carries a secret.
 *
 * The format has no field for one, so this guards the free-text fields an operator or script could fill
 * in — an identifier pasted from a connection string being the realistic accident.
 */
export function assertNoSecrets(manifest: BackupManifest): void {
  const suspect = [
    manifest.database_identifier,
    manifest.artifact_name,
    ...manifest.restore_prerequisites,
  ].join('\n');
  const patterns: readonly [RegExp, string][] = [
    [/postgres(ql)?:\/\//i, 'a connection URL'],
    [/password\s*=/i, 'a password assignment'],
    [/\bPG(PASSWORD|PASSFILE)\b/, 'a libpq password variable'],
    [/\bsk-[A-Za-z0-9]{8,}/, 'an API-key-shaped token'],
  ];
  for (const [pattern, what] of patterns)
    if (pattern.test(suspect))
      throw new Error(`the backup manifest would contain ${what}; manifests never carry secrets`);
}

/**
 * Build a manifest for an artifact that has already been written.
 *
 * The migration state is READ FROM THE DATABASE the backup was taken from rather than from the
 * repository's migration directory: the point of the field is to describe the dump, and a build whose
 * checkout has moved on would otherwise stamp a version the artifact does not actually contain.
 */
export async function buildManifest(
  pool: Pool,
  input: {
    artifactPath: string;
    artifactName: string;
    method: BackupMethod;
    databaseIdentifier: string;
    restorePrerequisites?: readonly string[] | undefined;
    now?: Date | undefined;
  },
): Promise<BackupManifest> {
  // `schema_migrations` records the migration FILE NAME; the manifest wants the numeric prefix, which is
  // the part that orders and compares.
  const applied = await pool.query<{ version: string; count: string }>(
    `SELECT coalesce(max(left(name, 4)), '0000') AS version, count(*)::text AS count
       FROM schema_migrations`,
  );
  const serverVersion = await pool.query<{ v: string }>('SHOW server_version');
  const extensions = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`,
  );
  const size = (await stat(input.artifactPath)).size;
  const manifest: BackupManifest = {
    manifest_version: MANIFEST_VERSION,
    created_at: (input.now ?? new Date()).toISOString(),
    method: input.method,
    database_identifier: input.databaseIdentifier,
    artifact_name: input.artifactName,
    artifact_bytes: size,
    checksum_algorithm: 'sha256',
    checksum: await checksumOf(input.artifactPath),
    migration_version: applied.rows[0]?.version ?? '0000',
    migration_count: Number(applied.rows[0]?.count ?? '0'),
    postgres_version: serverVersion.rows[0]?.v ?? 'unknown',
    compatibility: {
      min_application_migration: MIN_SUPPORTED_MIGRATION,
      requires_extensions: extensions.rows.map((r) => r.extname),
    },
    restore_prerequisites: input.restorePrerequisites ?? [
      'an empty target database',
      'the application role must exist before privileges are restored',
    ],
    secrets_excluded: true,
  };
  assertNoSecrets(manifest);
  return manifest;
}
