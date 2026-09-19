/**
 * The credential-free product commands through the real CLI dispatcher.
 *
 * The CLI and the API are two adapters over one service layer, and the failure this suite exists to
 * catch is them DISAGREEING: a check that passes on one surface and fails on the other, or a command
 * that reaches content the HTTP route would refuse. Each case therefore drives `runDb` exactly as
 * `main.ts` does, including the exit-code contract (`ok`), which is what a script gates on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, resetDatabase, type Pool } from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import { produceChapter } from '@yeonjae/workflows';
import { createHarness } from '@yeonjae/workflows/testkit';
import { DB_COMMANDS, runDb } from './commands.js';

const run = databaseUrl() ? describe : describe.skip;

run('CLI: credential-free product commands', () => {
  let pool: Pool;
  let seeded: { projectId: string; acceptedVersionId: string };
  let counter = 0;

  const key = (): string => `cli-product-${String(++counter)}`;

  beforeAll(async () => {
    pool = await freshDatabase();
    await resetDatabase(pool);
    await migrate(pool);
    /**
     * A genuinely accepted chapter, produced by the real workflow over the frozen chapter-1 replay
     * fixture. Inserting an accepted row directly would prove the commands run and say nothing about
     * whether they respect the accepted-only gate.
     */
    const harness = await createHarness(pool);
    const produced = await produceChapter(
      { pool, gateway: harness.gateway(), bindings: harness.bindings },
      harness.input(1),
    );
    if (!produced.accepted)
      throw new Error(`the fixture chapter did not reach acceptance (${produced.status})`);
    seeded = {
      projectId: harness.projectId,
      acceptedVersionId: produced.accepted.manuscript_version_id,
    };
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it('registers every product command as a database command', () => {
    // A command missing from this set is dispatched to the no-database parser and silently prints
    // usage instead of running.
    for (const command of [
      'ops:dependencies',
      'preview:create',
      'preview:list',
      'preview:accept',
      'preview:discard',
      'preview:cancel',
      'quality:typography',
      'quality:platform-format',
      'quality:profiles',
      'export:package',
      'batch:run',
    ]) {
      expect(DB_COMMANDS.has(command), `${command} must be a DB command`).toBe(true);
    }
  });

  it('reports per-dependency status and exits non-zero only when a required one is down', async () => {
    const result = await runDb(['ops:dependencies']);
    expect(result.ok).toBe(true);
    const output = result.output as { components: { name: string; state: string }[] };
    expect(output.components.map((c) => c.name)).toContain('postgres');
    expect(JSON.stringify(output)).not.toContain('postgres://');
  });

  it('creates, lists and discards a preview without altering accepted content', async () => {
    const before = await pool.query<{ text: string }>(
      'SELECT text FROM manuscript_versions WHERE id = $1',
      [seeded.acceptedVersionId],
    );
    const created = await runDb([
      'preview:create',
      seeded.projectId,
      '1',
      '--instruction=tighten',
      `--key=${key()}`,
    ]);
    expect(created.ok, JSON.stringify(created.output)).toBe(true);
    const preview = (created.output as { preview: { id: string; status: string } }).preview;
    expect(preview.status).toBe('ready');

    const listed = await runDb(['preview:list', seeded.projectId, '--limit=5']);
    expect((listed.output as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const discarded = await runDb(['preview:discard', seeded.projectId, preview.id]);
    expect(discarded.ok).toBe(true);

    const after = await pool.query<{ text: string }>(
      'SELECT text FROM manuscript_versions WHERE id = $1',
      [seeded.acceptedVersionId],
    );
    expect(after.rows[0]?.text).toBe(before.rows[0]?.text);
  });

  it('accepts a preview into a working version through the CLI', async () => {
    const created = await runDb([
      'preview:create',
      seeded.projectId,
      '1',
      '--instruction=accept-path',
      `--key=${key()}`,
    ]);
    const preview = (created.output as { preview: { id: string } }).preview;
    const accepted = await runDb(['preview:accept', seeded.projectId, preview.id]);
    expect(accepted.ok, JSON.stringify(accepted.output)).toBe(true);
    const versionId = (accepted.output as { manuscript_version_id: string }).manuscript_version_id;
    const row = await pool.query<{ status: string }>(
      'SELECT status FROM manuscript_versions WHERE id = $1',
      [versionId],
    );
    expect(row.rows[0]?.status).toBe('working');
  });

  it('reports a closed refusal code rather than throwing for an invalid source', async () => {
    const result = await runDb([
      'preview:create',
      seeded.projectId,
      '999',
      '--instruction=missing',
      `--key=${key()}`,
    ]);
    expect(result.ok).toBe(false);
    expect((result.output as { error: string }).error).toBe('CHAPTER_NOT_FOUND');
  });

  it('runs typography checks and states the review boundary in its output', async () => {
    const result = await runDb(['quality:typography', seeded.projectId]);
    const output = result.output as {
      chapters: { chapter_no: number; passed: boolean }[];
      does_not_replace: string;
    };
    expect(output.chapters.length).toBeGreaterThan(0);
    expect(output.does_not_replace).toBe('bilingual human review');
    // The fixture manuscripts are clean, so the command must exit zero.
    expect(result.ok).toBe(true);
  });

  it('runs an offline platform-format check that never claims platform acceptance', async () => {
    const result = await runDb(['quality:platform-format', seeded.projectId, 'generic', '1.0']);
    expect((result.output as { external_acceptance: string }).external_acceptance).toBe(
      'not_verified',
    );
  });

  it('refuses an unknown platform profile with a closed code', async () => {
    const result = await runDb(['quality:platform-format', seeded.projectId, 'nowhere', '1.0']);
    expect(result.ok).toBe(false);
    expect((result.output as { error: string }).error).toBe('UNKNOWN_PLATFORM');
  });

  it('lists the bundled versioned platform profiles', async () => {
    const result = await runDb(['quality:profiles']);
    const profiles = (result.output as { profiles: { platform_id: string }[] }).profiles;
    expect(profiles.map((p) => p.platform_id)).toContain('generic');
  });

  it('prepares a reproducible export package and never reports it as published', async () => {
    const first = await runDb(['export:package', seeded.projectId]);
    expect(first.ok, JSON.stringify(first.output)).toBe(true);
    const a = first.output as { logical_hash: string; published: boolean; written_to: null };
    expect(a.published).toBe(false);
    expect(a.written_to).toBeNull();

    const second = await runDb(['export:package', seeded.projectId]);
    expect((second.output as { logical_hash: string }).logical_hash).toBe(a.logical_hash);
  });

  it('runs a bounded batch and reports per-item results', async () => {
    const result = await runDb([
      'batch:run',
      seeded.projectId,
      'typography_check',
      '1',
      `--key=${key()}`,
    ]);
    const output = result.output as { items: { ref: string; code: string }[]; status: string };
    expect(output.items).toHaveLength(1);
    expect(output.items[0]?.ref).toBe('1');
    expect(output.status).toBe('completed');
  });

  it('refuses an oversized batch with a closed code', async () => {
    const refs = Array.from({ length: 60 }, (_, i) => String(i + 1)).join(',');
    const result = await runDb([
      'batch:run',
      seeded.projectId,
      'typography_check',
      refs,
      `--key=${key()}`,
    ]);
    expect(result.ok).toBe(false);
    expect((result.output as { error: string }).error).toBe('BATCH_TOO_LARGE');
  });

  it('a batch is idempotent under a repeated key', async () => {
    const k = key();
    const first = await runDb([
      'batch:run',
      seeded.projectId,
      'typography_check',
      '1',
      `--key=${k}`,
    ]);
    const second = await runDb([
      'batch:run',
      seeded.projectId,
      'typography_check',
      '1',
      `--key=${k}`,
    ]);
    expect((second.output as { batch_id: string }).batch_id).toBe(
      (first.output as { batch_id: string }).batch_id,
    );
    expect((second.output as { duplicate: boolean }).duplicate).toBe(true);
  });

  it('no command output carries a credential, connection string or stack frame', async () => {
    for (const argv of [
      ['ops:dependencies'],
      ['quality:typography', seeded.projectId],
      ['export:package', seeded.projectId],
    ]) {
      const text = JSON.stringify((await runDb(argv)).output);
      for (const forbidden of ['postgres://', 'password', 'yeonjae:yeonjae', 'at Object.']) {
        expect(text, `${argv[0] ?? ''} leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
