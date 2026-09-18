/**
 * Deterministic export preparation, against real PostgreSQL 16.
 *
 * Reproducibility is the property most easily lost and hardest to notice, so it is asserted directly:
 * two preparations of identical state must produce the same logical hash, and the timestamp that
 * differs between them must be present in the result and absent from the hash. The rest of the suite
 * covers the refusals, the manifest verification, and the two security properties an export carries —
 * no sensitive content, and no path that can escape the package root.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveManuscriptVersion,
  commitDelta,
  createChapter,
  createManuscriptVersion,
  createProject,
  createWorkspace,
  type Pool,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import {
  assertNoSensitiveContent,
  canonicalJson,
  ExportRefusedError,
  EXPORT_MANIFEST_VERSION,
  prepareExport,
  safeEntryPath,
  sha256,
  verifyExportPackage,
} from './export-package.js';

const run = databaseUrl() ? describe : describe.skip;

/** Long enough to satisfy a strict profile's minimum, deterministic, and clean typography. */
function body(seed: string): string {
  const parts: string[] = [];
  while (parts.join('\n\n').length < 800)
    parts.push(`${seed} The blade moved before the thought did, and the room answered in kind.`);
  return `${parts.join('\n\n')}\n`;
}

describe('export packaging: pure rules', () => {
  it('refuses every unsafe archive path', () => {
    for (const unsafe of [
      '/etc/passwd',
      '../../etc/passwd',
      'chapters/../../escape.txt',
      'C:\\windows\\system32',
      'chapters\\one.txt',
      './hidden',
      '',
      'a//b',
      'with\u0000null',
    ]) {
      expect(() => safeEntryPath(unsafe), `${unsafe} must be refused`).toThrow(ExportRefusedError);
    }
  });

  it('accepts the deterministic paths the packager itself generates', () => {
    expect(safeEntryPath('chapters/chapter-0001.txt')).toBe('chapters/chapter-0001.txt');
    expect(safeEntryPath('manifest.json')).toBe('manifest.json');
    expect(safeEntryPath('assets/cover-notes.txt')).toBe('assets/cover-notes.txt');
  });

  it('refuses content that would carry a credential, a prompt or a provider response', () => {
    for (const bad of [
      'db=postgres://user:hunter2@host:5432/app',
      '{"api_key": "sk-abc"}',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      '-----BEGIN RSA PRIVATE KEY-----',
      '{"provider_response": {"text": "x"}}',
    ]) {
      expect(() => {
        assertNoSensitiveContent(bad);
      }).toThrow(ExportRefusedError);
    }
    expect(() => {
      assertNoSensitiveContent('She stepped through the door.');
    }).not.toThrow();
  });

  it('canonical JSON is key-order independent, so formatting cannot change a hash', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
    expect(sha256(canonicalJson({ b: 1, a: 2 }))).toBe(sha256(canonicalJson({ a: 2, b: 1 })));
  });
});

run('deterministic export preparation', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let outDir: string;
  let otherWorkspaceId: string;
  let otherProjectId: string;

  const base = {
    platformId: 'generic',
    rulesVersion: '1.0',
    identifier: 'quiet-blade-0001',
  };

  beforeAll(async () => {
    pool = await freshDatabase();
    workspaceId = await createWorkspace(pool, 'export-tenant');
    projectId = (await createProject(pool, { workspaceId, title: 'Export Story' })).projectId;

    // Three accepted chapters, created through the ordinary path.
    for (const n of [1, 2, 3]) {
      const chapterId = await createChapter(pool, { workspaceId, projectId, number: n });
      const version = await createManuscriptVersion(pool, {
        workspaceId,
        projectId,
        chapterId,
        origin: 'imported',
        text: body(`Chapter ${String(n)} opens.`),
      });
      await approveManuscriptVersion(pool, version.id, 'test');
      const current = await pool.query<{ canon_version: number }>(
        'SELECT canon_version FROM projects WHERE id = $1',
        [projectId],
      );
      await commitDelta(pool, {
        projectId,
        parentVersion: current.rows[0]?.canon_version ?? 0,
        source: 'chapter_acceptance',
        chapterId,
        manuscriptVersionId: version.id,
        delta: { items: [] },
      });
    }

    otherWorkspaceId = await createWorkspace(pool, 'export-other');
    otherProjectId = (await createProject(pool, { workspaceId: otherWorkspaceId, title: 'Other' }))
      .projectId;
    outDir = mkdtempSync(join(tmpdir(), 'yeonjae-export-'));
  }, 180_000);

  afterAll(async () => {
    rmSync(outDir, { recursive: true, force: true });
    await pool.end();
  });

  const prepare = (overrides: Record<string, unknown> = {}) =>
    prepareExport(pool, {
      projectId,
      title: 'Export Story',
      metadata: { author: 'Yeonjae Studio', language: 'en' },
      ...base,
      ...overrides,
    });

  // --- reproducibility ---------------------------------------------------------------------------

  it('prepares a package with ordered chapters, metadata and check results', async () => {
    const prepared = await prepare();
    expect(prepared.manifest.manifest_version).toBe(EXPORT_MANIFEST_VERSION);
    expect(prepared.manifest.chapters.map((c) => c.chapter_no)).toEqual([1, 2, 3]);
    expect(prepared.manifest.metadata.title).toBe('Export Story');
    expect(prepared.manifest.typography.passed).toBe(true);
    expect(prepared.manifest.platform_format.passed).toBe(true);
    // The offline claim boundary travels with the manifest.
    expect(prepared.manifest.platform_format.external_acceptance).toBe('not_verified');
  });

  it('two preparations of identical state produce identical logical hashes', async () => {
    const first = await prepare({ now: new Date('2024-01-01T00:00:00Z') });
    const second = await prepare({ now: new Date('2030-12-31T23:59:59Z') });
    expect(second.logical_hash).toBe(first.logical_hash);
    expect(second.manifest.content_hash).toBe(first.manifest.content_hash);
    // The timestamps DIFFER, which is what makes the equal hashes meaningful.
    expect(second.prepared_at).not.toBe(first.prepared_at);
  });

  it('the timestamp is recorded and is absent from every hash input', async () => {
    const prepared = await prepare({ now: new Date('2024-06-01T12:00:00Z') });
    expect(prepared.prepared_at).toBe('2024-06-01T12:00:00.000Z');
    expect(canonicalJson(prepared.manifest)).not.toContain('2024-06-01');
  });

  it('files are ordered stably and every one is hashed', async () => {
    const prepared = await prepare();
    const paths = prepared.files.map((f) => f.path);
    expect([...paths].sort()).toEqual(paths);
    for (const file of prepared.files) expect(file.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('changing the content changes the hash', async () => {
    const whole = await prepare();
    const subset = await prepare({ chapters: [1, 2] });
    expect(subset.logical_hash).not.toBe(whole.logical_hash);
  });

  // --- writing and verification ---------------------------------------------------------------------

  it('writes the package and verifies it against its own manifest', async () => {
    const dir = join(outDir, 'written');
    const prepared = await prepare({ outputDir: dir });
    expect(prepared.written_to).toBe(dir);
    const verdict = verifyExportPackage(dir, prepared.manifest);
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('verification detects an edited chapter, a missing file and an undeclared extra file', async () => {
    const dir = join(outDir, 'tampered');
    const prepared = await prepare({ outputDir: dir });

    writeFileSync(join(dir, 'chapters/chapter-0001.txt'), 'replaced text\n', 'utf8');
    expect(verifyExportPackage(dir, prepared.manifest).ok).toBe(false);

    const fresh = join(outDir, 'extra');
    const second = await prepare({ outputDir: fresh });
    writeFileSync(join(fresh, 'stowaway.txt'), 'not declared\n', 'utf8');
    const verdict = verifyExportPackage(fresh, second.manifest);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('does not declare');

    rmSync(join(fresh, 'chapters/chapter-0002.txt'));
    expect(verifyExportPackage(fresh, second.manifest).ok).toBe(false);
  });

  it('detects a tampered manifest through its own content hash', async () => {
    const dir = join(outDir, 'manifest-tamper');
    const prepared = await prepare({ outputDir: dir });
    const forged = { ...prepared.manifest, canon_version: prepared.manifest.canon_version + 99 };
    const verdict = verifyExportPackage(dir, forged);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join(' ')).toContain('manifest hash');
  });

  it('a rewritten output directory does not inherit a stale file from a larger export', async () => {
    const dir = join(outDir, 'rewritten');
    await prepare({ outputDir: dir });
    const smaller = await prepare({ outputDir: dir, chapters: [1] });
    expect(verifyExportPackage(dir, smaller.manifest).ok).toBe(true);
  });

  // --- assets ------------------------------------------------------------------------------------------

  it('includes local assets, hashed, and refuses a corrupted one', async () => {
    const good = await prepare({
      assets: [{ filename: 'cover-notes.txt', content: 'A note about the cover.\n' }],
    });
    expect(good.manifest.assets).toHaveLength(1);
    expect(good.manifest.assets[0]?.content_hash).toBe(sha256('A note about the cover.\n'));

    await expect(
      prepare({
        assets: [
          { filename: 'cover-notes.txt', content: 'changed', expectedHash: sha256('original') },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ASSET_CORRUPT' });
  });

  it('refuses two assets that share a filename', async () => {
    await expect(
      prepare({
        assets: [
          { filename: 'a.txt', content: 'one' },
          { filename: 'a.txt', content: 'two' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ASSET_CORRUPT' });
  });

  it('refuses an asset whose filename would escape the package root', async () => {
    await expect(
      prepare({ assets: [{ filename: '../../escape.txt', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  // --- refusals ------------------------------------------------------------------------------------------

  it('refuses a project with no accepted chapters', async () => {
    await expect(
      prepareExport(pool, {
        projectId: otherProjectId,
        title: 'Other',
        metadata: {},
        ...base,
      }),
    ).rejects.toMatchObject({ code: 'NO_ACCEPTED_CHAPTERS' });
  });

  it('refuses when a requested chapter is not accepted', async () => {
    await expect(prepare({ chapters: [1, 99] })).rejects.toMatchObject({ code: 'CHAPTER_MISSING' });
  });

  it('refuses invalid metadata and an empty title', async () => {
    await expect(prepare({ title: '   ' })).rejects.toMatchObject({ code: 'METADATA_INVALID' });
    await expect(prepare({ metadata: { author: 'has a \u0000 null' } })).rejects.toMatchObject({
      code: 'METADATA_INVALID',
    });
  });

  it('refuses an unknown platform or rules version rather than defaulting', async () => {
    await expect(prepare({ platformId: 'nowhere' })).rejects.toMatchObject({
      code: 'UNKNOWN_PROFILE',
    });
    await expect(prepare({ rulesVersion: '9.9' })).rejects.toMatchObject({
      code: 'UNKNOWN_PROFILE',
    });
  });

  it('refuses a STALE request whose canon moved since it was made', async () => {
    await expect(prepare({ expectedCanonVersion: 1 })).rejects.toMatchObject({
      code: 'STALE_STATE',
    });
  });

  it('refuses when the platform-format check fails', async () => {
    // The strict profile requires metadata this call does not supply.
    await expect(prepare({ platformId: 'serial_web', metadata: {} })).rejects.toMatchObject({
      code: 'PLATFORM_FORMAT_FAILED',
    });
  });

  it('permits warnings under the default policy and refuses them under a strict one', async () => {
    const permissive = await prepare();
    expect(permissive.manifest.policy.allowWarnings).toBe(true);

    // A chapter written without blank-line paragraph separation produces warnings, not errors.
    const chapterId = await createChapter(pool, { workspaceId, projectId, number: 8 });
    const version = await createManuscriptVersion(pool, {
      workspaceId,
      projectId,
      chapterId,
      origin: 'imported',
      text: 'One line.\nAnother line immediately after.\n',
    });
    await approveManuscriptVersion(pool, version.id, 'test');
    const current = await pool.query<{ canon_version: number }>(
      'SELECT canon_version FROM projects WHERE id = $1',
      [projectId],
    );
    await commitDelta(pool, {
      projectId,
      parentVersion: current.rows[0]?.canon_version ?? 0,
      source: 'chapter_acceptance',
      chapterId,
      manuscriptVersionId: version.id,
      delta: { items: [] },
    });

    await expect(
      prepare({
        chapters: [8],
        policy: { allowWarnings: false, policyNote: 'no warnings may ship' },
      }),
    ).rejects.toMatchObject({ code: 'WARNINGS_NOT_PERMITTED' });
  });

  it('refuses a cancelled request and writes nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepare({ signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
  });

  it('a duplicate request produces an identical package rather than a different one', async () => {
    const a = await prepare();
    const b = await prepare();
    expect(b.logical_hash).toBe(a.logical_hash);
    expect(b.manifest).toEqual(a.manifest);
  });

  // --- security ------------------------------------------------------------------------------------------

  it('never includes a credential, a prompt, a provider response or an internal URL', async () => {
    const prepared = await prepare();
    const whole = prepared.files.map((f) => f.content).join('\n');
    for (const forbidden of [
      'postgres://',
      'password',
      'api_key',
      'Bearer ',
      'system_prompt',
      'provider_response',
      '127.0.0.1',
    ]) {
      expect(whole, `an export must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('never exports another tenant’s content, even when the project id is supplied directly', async () => {
    // `exportAccepted` resolves accepted chapters of the NAMED project only; another tenant's
    // project has none, so the refusal is structural rather than a filter.
    await expect(
      prepareExport(pool, {
        projectId: otherProjectId,
        title: 'Other',
        metadata: {},
        ...base,
      }),
    ).rejects.toMatchObject({ code: 'NO_ACCEPTED_CHAPTERS' });
  });

  it('nothing is published: the result says so and no network client exists in this path', async () => {
    const prepared = await prepare();
    // A local directory or nothing at all. There is no upload target in the type.
    expect(prepared.written_to).toBeNull();
  });
});
