/**
 * Deterministic local export preparation.
 *
 * WHAT THIS PRODUCES. A reproducible, self-describing package: an ordered set of accepted chapters,
 * bounded metadata, the typography and platform-format results that were run over exactly those
 * chapters, local assets, and a versioned manifest whose hashes cover all of it. It is written to a
 * local directory and NEVER uploaded, published or transmitted — there is no network call anywhere in
 * this module, which is what makes "we did not publish" a structural property rather than a promise.
 *
 * REPRODUCIBILITY IS THE HARD PART, and three decisions carry it:
 *
 *  1. ORDERING IS TOTAL AND EXPLICIT. Chapters by number, assets by filename, manifest keys emitted in
 *     a fixed order, finding arrays already sorted by their own modules. Nothing depends on a map's
 *     insertion order or a query's incidental row order.
 *  2. TIMESTAMPS ARE OUTSIDE THE HASH. A package taken twice from identical state must hash
 *     identically, and a wall clock guarantees it will not. `prepared_at` is recorded for operators in
 *     a separate envelope field and is explicitly excluded from `logical_hash`, which is the hash the
 *     reproducibility check compares. Recording no timestamp at all would be worse — an operator needs
 *     to know when a package was taken.
 *  3. THE HASH COVERS LOGICAL CONTENT, NOT BYTES ON DISK. File metadata (mtime, mode, directory entry
 *     order) is not part of the logical package, so it cannot make two equivalent exports differ.
 *
 * SECURITY. The manifest and the package carry accepted manuscript text, chapter metadata and check
 * results — and nothing else. Prompts, provider responses, `llm_calls` rows, connection strings,
 * credentials, internal URLs and operational state are never read by this module, and
 * `assertNoSensitiveContent` re-checks the assembled package before it is written, so a future field
 * addition cannot quietly introduce a leak.
 *
 * ARCHIVE SAFETY. Every path in the package is validated against `safeEntryPath` before it is written
 * or recorded: no absolute path, no `..` segment, no drive letter, no backslash, no leading separator.
 * An export is also an ingestion surface for whoever extracts it later, so a path that escapes the
 * package root is refused at creation time rather than trusted at extraction time.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkPlatformFormat,
  checkTypography,
  resolveProfile,
  type typographySummary,
  type PlatformCheckResult,
  type PlatformProfile,
  type TypographyResult,
} from '@yeonjae/prose';
import { acceptedChapter, type Pool } from '@yeonjae/db';
import { exportAccepted } from './chapter-production.js';

export const EXPORT_MANIFEST_VERSION = '1.0';
export const EXPORT_FORMATS = ['plain_text_package'] as const;
export type ExportPackageFormat = (typeof EXPORT_FORMATS)[number];

/** Refusal codes. Closed, machine-readable, and never carrying an exception message. */
export const EXPORT_REFUSALS = [
  'NO_ACCEPTED_CHAPTERS',
  'CHAPTER_MISSING',
  'METADATA_INVALID',
  'TYPOGRAPHY_FAILED',
  'PLATFORM_FORMAT_FAILED',
  'WARNINGS_NOT_PERMITTED',
  'STALE_STATE',
  'UNSAFE_PATH',
  'ASSET_CORRUPT',
  'CANCELLED',
  'UNKNOWN_PROFILE',
] as const;
export type ExportRefusal = (typeof EXPORT_REFUSALS)[number];

export class ExportRefusedError extends Error {
  constructor(
    readonly code: ExportRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ExportRefusedError';
  }
}

export interface ExportAsset {
  readonly filename: string;
  readonly content: string;
  /** The hash the caller believes this asset has. A mismatch is corruption and is refused. */
  readonly expectedHash?: string | undefined;
}

export interface ExportPolicy {
  /**
   * Whether warnings may ship. Errors never may.
   *
   * Documented policy rather than a bare boolean at the call site: an export that silently tolerated
   * warnings would make the warning severity meaningless.
   */
  readonly allowWarnings: boolean;
  /** Recorded in the manifest so a reader can see under which policy the package was accepted. */
  readonly policyNote: string;
}

export const DEFAULT_EXPORT_POLICY: ExportPolicy = {
  allowWarnings: true,
  policyNote: 'warnings are recorded and permitted; error-severity findings block the export',
};

export interface PrepareExportInput {
  readonly projectId: string;
  readonly title: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly chapters?: readonly number[] | undefined;
  readonly platformId: string;
  readonly rulesVersion: string;
  readonly identifier?: string | undefined;
  readonly assets?: readonly ExportAsset[] | undefined;
  readonly policy?: ExportPolicy | undefined;
  readonly extraProfiles?: readonly PlatformProfile[] | undefined;
  /** The canon version the caller believes is current. A newer one means the request is stale. */
  readonly expectedCanonVersion?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Where to write. Omitted means "prepare in memory and verify, write nothing". */
  readonly outputDir?: string | undefined;
  /** Recorded, never hashed. Injected so tests do not depend on a wall clock. */
  readonly now?: Date | undefined;
}

export interface ExportManifestChapter {
  readonly chapter_no: number;
  readonly manuscript_version_id: string;
  readonly version_no: number;
  readonly canon_version: number;
  readonly words: number;
  readonly content_hash: string;
  readonly filename: string;
}

export interface ExportManifest {
  readonly manifest_version: string;
  readonly export_format: ExportPackageFormat;
  readonly project_id: string;
  readonly canon_version: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly external_identifier: string | null;
  readonly chapters: readonly ExportManifestChapter[];
  readonly assets: readonly { filename: string; content_hash: string; bytes: number }[];
  readonly typography: ReturnType<typeof typographySummary> & {
    per_chapter: readonly { chapter_no: number; errors: number; warnings: number }[];
  };
  readonly platform_format: {
    readonly platform_id: string;
    readonly rules_version: string;
    readonly passed: boolean;
    readonly errors: number;
    readonly warnings: number;
    readonly codes: readonly string[];
    readonly external_acceptance: 'not_verified';
  };
  readonly policy: ExportPolicy;
  /** Hash over the logical content. Excludes every timestamp, so two identical exports match. */
  readonly content_hash: string;
}

export interface PreparedExport {
  readonly manifest: ExportManifest;
  /** Path → file content, in a stable order. The whole package, before anything is written. */
  readonly files: readonly { path: string; content: string; hash: string }[];
  /** Recorded for operators; deliberately NOT part of any hash. */
  readonly prepared_at: string;
  /** The reproducibility hash: recompute it from identical input and it must match. */
  readonly logical_hash: string;
  readonly typography: readonly { chapter_no: number; result: TypographyResult }[];
  readonly platform: PlatformCheckResult;
  readonly written_to: string | null;
  readonly total_bytes: number;
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Refuse any path that could escape the package root.
 *
 * Checked at PREPARATION time, not at extraction time: a package is handed to other tools, and the
 * only moment this system controls is the moment the path is chosen.
 */
export function safeEntryPath(path: string): string {
  const bad =
    path === '' ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '') ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(path);
  if (bad) throw new ExportRefusedError('UNSAFE_PATH', 'an export path is not safe');
  return path;
}

/** Deterministic, lowercase, collision-resistant chapter filenames. */
export function chapterFilename(chapterNo: number): string {
  return `chapters/chapter-${String(chapterNo).padStart(4, '0')}.txt`;
}

/**
 * Patterns that must never appear in a package.
 *
 * This is a defence in depth: nothing in this module reads a credential, a prompt or a provider
 * response, so a match here means a future change introduced a field that should not exist.
 */
const SENSITIVE_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'connection string', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s"']*:[^\s"'@]*@/i },
  { name: 'postgres url', re: /\bpostgres(?:ql)?:\/\//i },
  { name: 'password field', re: /"(?:password|secret|token|api_key|apikey)"\s*:/i },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{16,}/ },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'prompt payload', re: /"(?:system_prompt|prompt_text|provider_response)"\s*:/i },
];

export function assertNoSensitiveContent(text: string): void {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.re.test(text))
      throw new ExportRefusedError(
        'METADATA_INVALID',
        `the package would contain a ${pattern.name}`,
      );
  }
}

/** Serialize with keys in sorted order at every level: JSON key order must not affect a hash. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, x]) => [k, sort(x)]),
      );
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true)
    throw new ExportRefusedError('CANCELLED', 'the export was cancelled');
}

/**
 * Prepare a reproducible export package.
 *
 * Accepted content only: the chapter bodies come from `exportAccepted`, which is the Checkpoint 5
 * service that resolves each chapter through `acceptedChapter`. This module adds no second, weaker
 * accepted-only gate — a duplicate gate is a gate that can disagree with the real one.
 */
export async function prepareExport(
  pool: Pool,
  input: PrepareExportInput,
): Promise<PreparedExport> {
  assertNotCancelled(input.signal);
  const policy = input.policy ?? DEFAULT_EXPORT_POLICY;

  let profile: PlatformProfile;
  try {
    profile = resolveProfile(input.platformId, input.rulesVersion, input.extraProfiles ?? []);
  } catch {
    // The underlying error is a configuration refusal with its own code; it is re-raised as an
    // export refusal so a caller has ONE error taxonomy to handle.
    throw new ExportRefusedError('UNKNOWN_PROFILE', 'the platform profile could not be resolved');
  }

  if (input.title.trim() === '')
    throw new ExportRefusedError('METADATA_INVALID', 'the export title is empty');
  for (const [key, value] of Object.entries(input.metadata)) {
    if (typeof value !== 'string' || value.includes('\u0000'))
      throw new ExportRefusedError('METADATA_INVALID', `metadata field ${key} is not safe text`);
  }

  /**
   * Asset validation runs BEFORE any content is read.
   *
   * Both are input defects, and a caller who passed an unsafe path deserves to be told that rather
   * than a platform-format verdict about content they did not ask about yet. Running the cheap,
   * purely-local checks first also means a malformed request costs no database work.
   */
  const assets = [...(input.assets ?? [])].sort((a, b) => (a.filename < b.filename ? -1 : 1));
  const assetEntries = assets.map((asset) => {
    const path = safeEntryPath(`assets/${asset.filename}`);
    const hash = sha256(asset.content);
    if (asset.expectedHash !== undefined && asset.expectedHash !== hash)
      throw new ExportRefusedError(
        'ASSET_CORRUPT',
        `asset ${asset.filename} failed its hash check`,
      );
    return { path, content: asset.content, hash, bytes: Buffer.byteLength(asset.content) };
  });
  if (new Set(assetEntries.map((a) => a.path)).size !== assetEntries.length)
    throw new ExportRefusedError('ASSET_CORRUPT', 'two assets share a filename');

  let accepted;
  try {
    accepted = await exportAccepted(pool, {
      projectId: input.projectId,
      chapters: input.chapters,
      format: 'text',
      title: input.title,
    });
  } catch (err) {
    // `exportAccepted` raises its own typed refusal for a chapter that is not accepted. It is
    // re-raised in THIS module's taxonomy so a caller has one error vocabulary to handle.
    const code = (err as { code?: string }).code ?? '';
    if (code === 'CHAPTER_NOT_ACCEPTED' || code === 'CHAPTER_NOT_FOUND')
      throw new ExportRefusedError(
        'CHAPTER_MISSING',
        'a requested chapter has no accepted version',
      );
    throw err;
  }
  assertNotCancelled(input.signal);

  if (accepted.chapters.length === 0)
    throw new ExportRefusedError(
      'NO_ACCEPTED_CHAPTERS',
      'the project has no accepted chapters to export',
    );

  // A caller that named chapters must get exactly those chapters: silently exporting fewer would
  // produce a package that looks complete and is not.
  if (input.chapters !== undefined) {
    const got = new Set(accepted.chapters.map((c) => c.chapter_no));
    const missing = input.chapters.filter((n) => !got.has(n));
    if (missing.length > 0)
      throw new ExportRefusedError(
        'CHAPTER_MISSING',
        `${String(missing.length)} requested chapter(s) are not accepted`,
      );
  }

  const canonVersion = Math.max(...accepted.chapters.map((c) => c.canon_version));
  if (input.expectedCanonVersion !== undefined && input.expectedCanonVersion !== canonVersion)
    throw new ExportRefusedError(
      'STALE_STATE',
      'the project canon moved since this export was requested',
    );

  // Chapters in a total, explicit order.
  const ordered = [...accepted.chapters].sort((a, b) => a.chapter_no - b.chapter_no);
  const bodies = new Map<number, string>();
  for (const chapter of ordered) {
    /**
     * Each chapter's text is resolved through `acceptedChapter` — the SAME accepted-only gate
     * `exportAccepted` itself uses — rather than by splitting the assembled document on its heading
     * markers. Splitting is what the API's preview route does, and it is wrong the moment a chapter's
     * own prose contains the string `Chapter N`: the body is silently truncated there. A package that
     * shipped a truncated chapter would pass every hash check, because the hash would be of the
     * truncated text.
     */
    const lookup = await acceptedChapter(pool, input.projectId, chapter.chapter_no);
    if (lookup.state !== 'accepted')
      throw new ExportRefusedError(
        'CHAPTER_MISSING',
        `chapter ${String(chapter.chapter_no)} is no longer accepted`,
      );
    bodies.set(chapter.chapter_no, lookup.chapter.version.text);
  }

  // --- checks -------------------------------------------------------------------------------------
  const typography = ordered.map((chapter) => ({
    chapter_no: chapter.chapter_no,
    result: checkTypography(bodies.get(chapter.chapter_no) ?? ''),
  }));
  assertNotCancelled(input.signal);

  const platform = checkPlatformFormat(profile, {
    metadata: { ...input.metadata, title: input.title },
    chapters: ordered.map((c) => ({
      chapter_no: c.chapter_no,
      text: bodies.get(c.chapter_no) ?? '',
    })),
    assets: [...(input.assets ?? [])]
      .map((a) => ({ filename: a.filename, bytes: Buffer.byteLength(a.content), present: true }))
      .sort((a, b) => (a.filename < b.filename ? -1 : 1)),
    manifestFields: [
      'manifest_version',
      'project_id',
      'chapters',
      'content_hash',
      'external_identifier',
    ],
    identifier: input.identifier,
    totalBytes: accepted.text.length,
  });

  const typographyErrors = typography.reduce((n, t) => n + t.result.counts.error, 0);
  const typographyWarnings = typography.reduce((n, t) => n + t.result.counts.warning, 0);
  if (typographyErrors > 0)
    throw new ExportRefusedError(
      'TYPOGRAPHY_FAILED',
      `${String(typographyErrors)} typography error(s) block this export`,
    );
  if (!platform.passed)
    throw new ExportRefusedError(
      'PLATFORM_FORMAT_FAILED',
      `${String(platform.errors)} platform-format error(s) block this export`,
    );
  if (!policy.allowWarnings && typographyWarnings + platform.warnings > 0)
    throw new ExportRefusedError(
      'WARNINGS_NOT_PERMITTED',
      'the configured policy does not permit warnings',
    );

  // --- manifest ------------------------------------------------------------------------------------
  const chapterEntries = ordered.map((chapter) => ({
    chapter: chapter,
    path: safeEntryPath(chapterFilename(chapter.chapter_no)),
    content: `${(bodies.get(chapter.chapter_no) ?? '').replace(/\n+$/, '')}\n`,
  }));

  const manifestWithoutHash = {
    manifest_version: EXPORT_MANIFEST_VERSION,
    export_format: 'plain_text_package' as const,
    project_id: input.projectId,
    canon_version: canonVersion,
    metadata: Object.fromEntries(
      Object.entries({ ...input.metadata, title: input.title }).sort(([a], [b]) =>
        a < b ? -1 : 1,
      ),
    ),
    external_identifier: input.identifier ?? null,
    chapters: chapterEntries.map((e) => ({
      chapter_no: e.chapter.chapter_no,
      manuscript_version_id: e.chapter.manuscript_version_id,
      version_no: e.chapter.version_no,
      canon_version: e.chapter.canon_version,
      words: e.chapter.words,
      content_hash: sha256(e.content),
      filename: e.path,
    })),
    assets: assetEntries.map((a) => ({
      filename: a.path,
      content_hash: a.hash,
      bytes: a.bytes,
    })),
    typography: {
      ...mergeTypography(typography),
      per_chapter: typography.map((t) => ({
        chapter_no: t.chapter_no,
        errors: t.result.counts.error,
        warnings: t.result.counts.warning,
      })),
    },
    platform_format: {
      platform_id: platform.platform_id,
      rules_version: platform.rules_version,
      passed: platform.passed,
      errors: platform.errors,
      warnings: platform.warnings,
      codes: [...new Set(platform.findings.map((f) => f.code))].sort(),
      external_acceptance: platform.external_acceptance,
    },
    policy,
  };

  // The manifest's own hash covers everything above it, so a manifest cannot be edited without
  // detection and a chapter cannot be swapped without changing it.
  const contentHash = sha256(canonicalJson(manifestWithoutHash));
  const manifest: ExportManifest = { ...manifestWithoutHash, content_hash: contentHash };

  const files = [
    ...chapterEntries.map((e) => ({ path: e.path, content: e.content, hash: sha256(e.content) })),
    ...assetEntries.map((a) => ({ path: a.path, content: a.content, hash: a.hash })),
    {
      path: 'manifest.json',
      content: `${canonicalJson(manifest)}\n`,
      hash: sha256(`${canonicalJson(manifest)}\n`),
    },
  ].sort((a, b) => (a.path < b.path ? -1 : 1));

  for (const file of files) assertNoSensitiveContent(file.content);

  // The reproducibility hash: every path and every content hash, in sorted order. Timestamps and
  // filesystem metadata are absent by construction.
  const logicalHash = sha256(files.map((f) => `${f.path}\u0000${f.hash}`).join('\n'));
  const totalBytes = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);

  assertNotCancelled(input.signal);

  let writtenTo: string | null = null;
  if (input.outputDir !== undefined) {
    writtenTo = writePackage(input.outputDir, files);
  }

  return {
    manifest,
    files,
    prepared_at: (input.now ?? new Date()).toISOString(),
    logical_hash: logicalHash,
    typography,
    platform,
    written_to: writtenTo,
    total_bytes: totalBytes,
  };
}

function mergeTypography(
  per: readonly { chapter_no: number; result: TypographyResult }[],
): ReturnType<typeof typographySummary> {
  return {
    passed: per.every((p) => p.result.passed),
    errors: per.reduce((n, p) => n + p.result.counts.error, 0),
    warnings: per.reduce((n, p) => n + p.result.counts.warning, 0),
    infos: per.reduce((n, p) => n + p.result.counts.info, 0),
    codes: [...new Set(per.flatMap((p) => p.result.findings.map((f) => f.code)))].sort(),
  };
}

/**
 * Write the package.
 *
 * The output directory is emptied first so a second run cannot inherit a stale file from the first —
 * a leftover chapter from an earlier, larger export would silently ship.
 */
function writePackage(
  outputDir: string,
  files: readonly { path: string; content: string }[],
): string {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  for (const file of files) {
    const safe = safeEntryPath(file.path);
    const full = join(outputDir, safe);
    mkdirSync(join(outputDir, safe.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(full, file.content, 'utf8');
  }
  return outputDir;
}

export interface ExportVerdict {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

/**
 * Verify a written package against its own manifest.
 *
 * Reads the files back from disk rather than trusting the in-memory result: that is the only way this
 * catches a truncated write, an edited chapter or an added file.
 */
export function verifyExportPackage(dir: string, manifest: ExportManifest): ExportVerdict {
  const failures: string[] = [];
  const read = (path: string): string => readFileSync(path, 'utf8');

  if (manifest.manifest_version !== EXPORT_MANIFEST_VERSION)
    failures.push('unsupported manifest version');

  const rehash = sha256(
    canonicalJson(
      Object.fromEntries(Object.entries(manifest).filter(([k]) => k !== 'content_hash')),
    ),
  );
  if (rehash !== manifest.content_hash)
    failures.push('the manifest hash does not match its content');

  for (const chapter of manifest.chapters) {
    try {
      const actual = sha256(read(join(dir, safeEntryPath(chapter.filename))));
      if (actual !== chapter.content_hash)
        failures.push(`chapter ${String(chapter.chapter_no)} does not match its recorded hash`);
    } catch {
      failures.push(`chapter ${String(chapter.chapter_no)} is missing from the package`);
    }
  }
  for (const asset of manifest.assets) {
    try {
      const actual = sha256(read(join(dir, safeEntryPath(asset.filename))));
      if (actual !== asset.content_hash) failures.push('an asset does not match its recorded hash');
    } catch {
      failures.push('an asset is missing from the package');
    }
  }

  // An UNEXPECTED file is a failure too: a package with an extra file is not the package the
  // manifest describes, and that is exactly how something unwanted ships.
  const declared = new Set([
    'manifest.json',
    ...manifest.chapters.map((c) => c.filename),
    ...manifest.assets.map((a) => a.filename),
  ]);
  for (const found of listFiles(dir)) {
    if (!declared.has(found))
      failures.push('the package contains a file the manifest does not declare');
  }

  return { ok: failures.length === 0, failures: [...new Set(failures)].sort() };
}

function listFiles(dir: string, prefix = '', acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) listFiles(full, rel, acc);
    else acc.push(rel);
  }
  return acc;
}
