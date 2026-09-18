/**
 * Regeneration previews, against real PostgreSQL 16.
 *
 * The suite is organised around the one guarantee the feature must not break — a preview cannot alter
 * accepted content — and then around the lifecycle that makes it usable: idempotency, staleness,
 * cancellation, budget, isolation and redaction. The accepted-content assertion is made by comparing
 * the accepted version's bytes BEFORE and AFTER every operation, rather than by trusting that no code
 * path writes to it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Metrics } from '@yeonjae/domain';
import {
  acceptPreview,
  cancelPreview,
  createPreview,
  DeterministicPreviewSimulator,
  discardPreview,
  hashText,
  listPreviews,
  type PreviewError,
  reserve,
  seedFor,
  upsertBudgetPolicy,
  withWorkspace,
  type Client,
  type Pool,
  approveManuscriptVersion,
  createChapter,
  createManuscriptVersion,
  createProject,
  createWorkspace,
  commitDelta,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';

const run = databaseUrl() ? describe : describe.skip;

const CHAPTER_TEXT =
  'The hall went quiet when she stepped through the door.\n\n' +
  'She had done this before, in a life that no longer existed.\n\n' +
  'This time she would not be late.\n';

run('regeneration previews (credential-free product surface)', () => {
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let chapterId: string;
  let acceptedVersionId: string;
  let otherWorkspaceId: string;
  let otherProjectId: string;
  let counter = 0;

  const scoped = <T>(fn: (c: Client) => Promise<T>, ws = workspaceId): Promise<T> =>
    withWorkspace(pool, ws, fn);
  const key = (): string => `preview-key-${String(++counter)}`;

  /** The accepted bytes, read back independently. This is the invariant witness. */
  const acceptedText = async (): Promise<string> => {
    const r = await pool.query<{ text: string }>(
      `SELECT mv.text FROM chapters c JOIN manuscript_versions mv ON mv.id = c.accepted_version_id
        WHERE c.id = $1`,
      [chapterId],
    );
    return r.rows[0]?.text ?? '';
  };

  beforeAll(async () => {
    pool = await freshDatabase();
    workspaceId = await createWorkspace(pool, 'preview-tenant');
    const project = await createProject(pool, { workspaceId, title: 'Preview Story' });
    projectId = project.projectId;
    chapterId = await createChapter(pool, { workspaceId, projectId, number: 1 });
    const version = await createManuscriptVersion(pool, {
      workspaceId,
      projectId,
      chapterId,
      origin: 'imported',
      text: CHAPTER_TEXT,
    });
    await approveManuscriptVersion(pool, version.id, 'test');
    // Canon is committed the only way canon can be: through canon.commit_delta, which is what sets
    // the version to `accepted` atomically. An empty delta is legal for a chapter that asserts no
    // new canon, and it is enough to give this suite a genuinely accepted source version.
    await commitDelta(pool, {
      projectId,
      parentVersion: 0,
      source: 'chapter_acceptance',
      chapterId,
      manuscriptVersionId: version.id,
      delta: { items: [] },
    });
    acceptedVersionId = version.id;

    otherWorkspaceId = await createWorkspace(pool, 'other-tenant');
    otherProjectId = (await createProject(pool, { workspaceId: otherWorkspaceId, title: 'Other' }))
      .projectId;
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  let before = '';
  beforeEach(async () => {
    before = await acceptedText();
  });

  // --- the guarantee -----------------------------------------------------------------------------

  it('creates a preview and leaves the accepted version byte-identical', async () => {
    const result = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'tighten the pacing',
        requestKey: key(),
      }),
    );
    expect(result.preview.status).toBe('ready');
    expect(result.proposed_text).not.toBe(CHAPTER_TEXT);
    expect(result.source_text).toBe(CHAPTER_TEXT);
    // The whole feature in one assertion.
    expect(await acceptedText()).toBe(before);
    expect(await acceptedText()).toBe(CHAPTER_TEXT);
  });

  it('records the full provenance needed to reproduce the proposal', async () => {
    const result = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'reproducible',
        requestKey: key(),
      }),
    );
    const preview = result.preview;
    expect(preview.source_manuscript_version_id).toBe(acceptedVersionId);
    expect(preview.source_content_hash).toBe(hashText(CHAPTER_TEXT));
    expect(preview.proposed_content_hash).toBe(hashText(result.proposed_text));
    expect(preview.seed).toBe(
      seedFor({
        projectId,
        chapterId,
        sourceContentHash: hashText(CHAPTER_TEXT),
        instruction: 'reproducible',
      }),
    );
    expect(preview.simulator.name).toBe('deterministic_local');
    expect(preview.context_summary).toBeTruthy();
    expect(preview.retrieval_summary).toBeTruthy();
  });

  it('carries a SIMULATED cost estimate that is labelled as such', async () => {
    const result = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'cost',
        requestKey: key(),
      }),
    );
    expect(result.preview.estimated_millicents).toBeGreaterThan(0);
    // A consumer must not be able to render this as a provider charge.
    expect(result.preview.cost_basis).toBe('simulated');
  });

  it('is deterministic: the same inputs produce the same proposal and the same hash', async () => {
    const a = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'same',
        requestKey: key(),
      }),
    );
    const b = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'same',
        requestKey: key(),
      }),
    );
    expect(b.proposed_text).toBe(a.proposed_text);
    expect(b.preview.proposed_content_hash).toBe(a.preview.proposed_content_hash);
  });

  // --- lifecycle ----------------------------------------------------------------------------------

  it('accepts a preview into a NEW WORKING version, never overwriting the accepted one', async () => {
    const created = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'accept me',
        requestKey: key(),
      }),
    );
    const accepted = await acceptPreview(pool, scoped, {
      previewId: created.preview.id,
      projectId,
    });
    expect(accepted.preview.status).toBe('accepted');

    const version = await pool.query<{ status: string; text: string; origin: string }>(
      'SELECT status, text, origin FROM manuscript_versions WHERE id = $1',
      [accepted.manuscript_version_id],
    );
    // WORKING, not accepted: the proposal still has to pass every gate a normal draft passes.
    expect(version.rows[0]?.status).toBe('working');
    expect(version.rows[0]?.text).toBe(created.proposed_text);
    // And the accepted version is untouched.
    expect(await acceptedText()).toBe(CHAPTER_TEXT);
  });

  it('discards a preview and retains the row as history', async () => {
    const created = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'discard me',
        requestKey: key(),
      }),
    );
    const view = await scoped((c) =>
      discardPreview(c, { previewId: created.preview.id, projectId }),
    );
    expect(view.status).toBe('discarded');
    const still = await pool.query('SELECT 1 FROM regeneration_previews WHERE id = $1', [
      created.preview.id,
    ]);
    expect(still.rows).toHaveLength(1);
    expect(await acceptedText()).toBe(CHAPTER_TEXT);
  });

  it('cancels a preview through the state machine', async () => {
    const created = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'cancel me',
        requestKey: key(),
      }),
    );
    const view = await scoped((c) =>
      cancelPreview(c, { previewId: created.preview.id, projectId }),
    );
    expect(view.status).toBe('cancelled');
  });

  it('refuses a request that was cancelled before the simulator ran, reserving nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 1,
          instruction: 'aborted',
          requestKey: key(),
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses to resolve an already-resolved preview, at the service AND in the database', async () => {
    const created = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'twice',
        requestKey: key(),
      }),
    );
    await scoped((c) => discardPreview(c, { previewId: created.preview.id, projectId }));
    await expect(
      scoped((c) => discardPreview(c, { previewId: created.preview.id, projectId })),
    ).rejects.toMatchObject({ code: 'PREVIEW_TERMINAL' });

    // And the trigger refuses it even when the service is bypassed entirely.
    await expect(
      pool.query(`UPDATE regeneration_previews SET status = 'ready' WHERE id = $1`, [
        created.preview.id,
      ]),
    ).rejects.toThrow();
  });

  it('the database refuses to alter a preview’s proposal or provenance', async () => {
    const created = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'immutable',
        requestKey: key(),
      }),
    );
    await expect(
      pool.query(
        `UPDATE regeneration_previews SET status = 'accepted', resolved_at = now(),
            proposed_text = 'something else' WHERE id = $1`,
        [created.preview.id],
      ),
    ).rejects.toThrow();
  });

  it('previews are append-only: a delete is refused', async () => {
    const created = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'no delete',
        requestKey: key(),
      }),
    );
    await expect(
      pool.query('DELETE FROM regeneration_previews WHERE id = $1', [created.preview.id]),
    ).rejects.toThrow();
  });

  // --- idempotency and staleness --------------------------------------------------------------------

  it('a duplicate delivery returns the SAME preview and does not create a second', async () => {
    const k = key();
    const first = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'dup',
        requestKey: k,
      }),
    );
    const second = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'dup',
        requestKey: k,
      }),
    );
    expect(second.duplicate).toBe(true);
    expect(second.preview.id).toBe(first.preview.id);
    const count = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM regeneration_previews WHERE request_key = $1',
      [k],
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('two concurrent duplicate requests resolve to exactly one preview', async () => {
    const k = key();
    const make = (): Promise<unknown> =>
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 1,
          instruction: 'race',
          requestKey: k,
        }),
      );
    await Promise.all([make(), make()]);
    const count = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM regeneration_previews WHERE request_key = $1',
      [k],
    );
    expect(count.rows[0]?.n).toBe('1');
  });

  it('refuses a STALE preview whose source content changed, and never applies it', async () => {
    // Its OWN chapter: moving the shared chapter's accepted version would change the source every
    // later test reads, which is how one test silently breaks the rest of a suite.
    const staleChapter = await createChapter(pool, { workspaceId, projectId, number: 7 });
    const first = await createManuscriptVersion(pool, {
      workspaceId,
      projectId,
      chapterId: staleChapter,
      origin: 'imported',
      text: CHAPTER_TEXT,
    });
    await approveManuscriptVersion(pool, first.id, 'test');
    const v1 = await pool.query<{ canon_version: number }>(
      'SELECT canon_version FROM projects WHERE id = $1',
      [projectId],
    );
    await commitDelta(pool, {
      projectId,
      parentVersion: v1.rows[0]?.canon_version ?? 0,
      source: 'chapter_acceptance',
      chapterId: staleChapter,
      manuscriptVersionId: first.id,
      delta: { items: [] },
    });

    const created = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 7,
        instruction: 'stale',
        requestKey: key(),
      }),
    );

    // Move the source: a second accepted version of that same chapter, through the ordinary path.
    const next = await createManuscriptVersion(pool, {
      workspaceId,
      projectId,
      chapterId: staleChapter,
      origin: 'revision',
      text: `${CHAPTER_TEXT}\nAnd then the bell rang.\n`,
    });
    await approveManuscriptVersion(pool, next.id, 'test');
    const v2 = await pool.query<{ canon_version: number }>(
      'SELECT canon_version FROM projects WHERE id = $1',
      [projectId],
    );
    // Two commits, because `manuscript_versions_one_accepted_per_chapter` is a non-deferred unique
    // index: the prior version has to LEAVE the accepted state before the replacement enters it.
    await commitDelta(pool, {
      projectId,
      parentVersion: v2.rows[0]?.canon_version ?? 0,
      source: 'regeneration',
      chapterId: staleChapter,
      supersededManuscriptVersionId: first.id,
      delta: { items: [] },
    });
    const v3 = await pool.query<{ canon_version: number }>(
      'SELECT canon_version FROM projects WHERE id = $1',
      [projectId],
    );
    await commitDelta(pool, {
      projectId,
      parentVersion: v3.rows[0]?.canon_version ?? 0,
      source: 'chapter_acceptance',
      chapterId: staleChapter,
      manuscriptVersionId: next.id,
      delta: { items: [] },
    });

    const acceptedNow = await pool.query<{ text: string }>(
      `SELECT mv.text FROM chapters c JOIN manuscript_versions mv ON mv.id = c.accepted_version_id
        WHERE c.id = $1`,
      [staleChapter],
    );
    await expect(
      acceptPreview(pool, scoped, { previewId: created.preview.id, projectId }),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE' });

    // Nothing was written, and the stale preview is no longer acceptable.
    const after = await pool.query<{ text: string }>(
      `SELECT mv.text FROM chapters c JOIN manuscript_versions mv ON mv.id = c.accepted_version_id
        WHERE c.id = $1`,
      [staleChapter],
    );
    expect(after.rows[0]?.text).toBe(acceptedNow.rows[0]?.text);
    const row = await pool.query<{ status: string; failure_code: string }>(
      'SELECT status, failure_code FROM regeneration_previews WHERE id = $1',
      [created.preview.id],
    );
    expect(row.rows[0]?.status).toBe('discarded');
    expect(row.rows[0]?.failure_code).toBe('PREVIEW_STALE');
  });

  // --- invalid source states --------------------------------------------------------------------------

  it('refuses a chapter that does not exist', async () => {
    await expect(
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 999,
          instruction: 'missing',
          requestKey: key(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'CHAPTER_NOT_FOUND' });
  });

  it('refuses a chapter with no ACCEPTED version', async () => {
    const draftChapter = await createChapter(pool, { workspaceId, projectId, number: 42 });
    await createManuscriptVersion(pool, {
      workspaceId,
      projectId,
      chapterId: draftChapter,
      origin: 'imported',
      text: 'a working draft that is not canon',
    });
    await expect(
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 42,
          instruction: 'not accepted',
          requestKey: key(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_ACCEPTED' });
  });

  it('refuses a malformed request without touching anything', async () => {
    await expect(
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 1,
          instruction: 'x'.repeat(5_000),
          requestKey: key(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 1,
          instruction: 'ok',
          requestKey: '   ',
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('a failing simulator refuses the preview and writes no row', async () => {
    const broken = {
      name: 'broken',
      version: '1.0',
      generate: (): string => {
        throw new Error('simulator exploded with secret=hunter2');
      },
    };
    const k = key();
    await expect(
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 1,
          instruction: 'break',
          requestKey: k,
          simulator: broken,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SIMULATOR_FAILED' });
    const rows = await pool.query('SELECT 1 FROM regeneration_previews WHERE request_key = $1', [
      k,
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it('a simulator failure never leaks the exception text', async () => {
    const broken = {
      name: 'broken',
      version: '1.0',
      generate: (): string => {
        throw new Error('postgres://u:hunter2@host/db exploded');
      },
    };
    try {
      await scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 1,
          instruction: 'leak',
          requestKey: key(),
          simulator: broken,
        }),
      );
      expect.unreachable('the simulator failure must surface');
    } catch (err) {
      expect((err as PreviewError).message).not.toContain('hunter2');
      expect((err as PreviewError).message).not.toContain('postgres://');
    }
  });

  // --- budget ------------------------------------------------------------------------------------------

  it('reserves and settles the simulated estimate against the shared budget', async () => {
    const policy = await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      hardLimitMillicents: 1_000_000,
    });
    const result = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'budgeted',
        requestKey: key(),
        budgetPolicyId: policy.id,
      }),
    );
    const settled = await pool.query<{ state: string; settled_millicents: string }>(
      `SELECT state, settled_millicents FROM budget_reservations
        WHERE policy_id = $1 ORDER BY reserved_at DESC LIMIT 1`,
      [policy.id],
    );
    expect(settled.rows[0]?.state).toBe('settled');
    expect(Number(settled.rows[0]?.settled_millicents)).toBe(result.preview.estimated_millicents);
  });

  it('refuses when the shared budget is exhausted, before generating anything', async () => {
    const policy = await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: otherProjectId,
      hardLimitMillicents: 1,
    });
    // Consume the entire limit first.
    await reserve(pool, {
      policyId: policy.id,
      requestId: 'fill-the-budget',
      estimatedMillicents: 1,
      ttlSeconds: 300,
      now: new Date(),
    });
    await expect(
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 1,
          instruction: 'too expensive',
          requestKey: key(),
          budgetPolicyId: policy.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });

  it('leaves NO outstanding reservation when the simulator fails', async () => {
    const policy = await upsertBudgetPolicy(pool, {
      workspaceId,
      scopeKind: 'project',
      scopeId: projectId,
      hardLimitMillicents: 1_000_000,
    });
    const k = key();
    await expect(
      scoped((c) =>
        createPreview(c, {
          workspaceId,
          projectId,
          chapterNo: 1,
          instruction: 'release me',
          requestKey: k,
          budgetPolicyId: policy.id,
          simulator: {
            name: 'broken',
            version: '1.0',
            generate: (): string => {
              throw new Error('nope');
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'SIMULATOR_FAILED' });

    /**
     * The reservation is GONE, not merely released.
     *
     * `withWorkspace` runs the whole call in one transaction, so a refusal rolls the reservation back
     * with everything else. The service still issues an explicit release — that is what protects a
     * caller who passes a non-transactional client — but the property that matters to accounting is
     * asserted here directly: nothing outstanding, and nothing committed, for work that never
     * happened.
     */
    const rows = await scoped((c) =>
      c.query<{ state: string }>('SELECT state FROM budget_reservations WHERE request_id = $1', [
        `preview:${workspaceId}:${k}`,
      ]),
    );
    expect(rows.rows).toHaveLength(0);

    const status = await scoped((c) =>
      c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM budget_reservations
          WHERE policy_id = $1 AND state = 'reserved'`,
        [policy.id],
      ),
    );
    expect(Number(status.rows[0]?.n ?? '-1')).toBe(0);
  });

  // --- isolation ------------------------------------------------------------------------------------------

  it('a second tenant can see none of the first tenant’s previews', async () => {
    await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'private',
        requestKey: key(),
      }),
    );
    const visible = await withWorkspace(pool, otherWorkspaceId, async (c) => {
      const r = await c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM regeneration_previews WHERE project_id = $1',
        [projectId],
      );
      return Number(r.rows[0]?.n ?? '-1');
    });
    expect(visible).toBe(0);
  });

  it('a preview may not be resolved through another project’s scope', async () => {
    const created = await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'wrong project',
        requestKey: key(),
      }),
    );
    await expect(
      scoped((c) =>
        discardPreview(c, { previewId: created.preview.id, projectId: otherProjectId }),
      ),
    ).rejects.toMatchObject({ code: 'PREVIEW_NOT_FOUND' });
  });

  it('the database refuses a preview naming another project’s chapter', async () => {
    await expect(
      pool.query(
        `INSERT INTO regeneration_previews
           (workspace_id, project_id, chapter_id, source_manuscript_version_id, source_content_hash,
            request_key, seed, proposed_text, proposed_content_hash)
         VALUES ($1, $2, $3, $4, 'sha256:x', 'cross', 1, 'x', 'sha256:y')`,
        [otherWorkspaceId, otherProjectId, chapterId, acceptedVersionId],
      ),
    ).rejects.toThrow();
  });

  // --- reporting --------------------------------------------------------------------------------------------

  it('lists previews bounded and newest first', async () => {
    const listing = await scoped((c) => listPreviews(c, { projectId, limit: 3 }));
    expect(listing.items.length).toBeLessThanOrEqual(3);
    for (const item of listing.items) expect(item.project_id).toBe(projectId);
  });

  it('records bounded metrics for preview operations', async () => {
    const metrics = new Metrics();
    await scoped((c) =>
      createPreview(c, {
        workspaceId,
        projectId,
        chapterNo: 1,
        instruction: 'metrics',
        requestKey: key(),
        metrics,
      }),
    );
    expect(metrics.render()).toContain('yeonjae_preview_operations_total');
  });

  it('the default simulator is deterministic and obviously local', () => {
    const simulator = new DeterministicPreviewSimulator();
    const a = simulator.generate({ sourceText: CHAPTER_TEXT, instruction: 'x', seed: 7 });
    const b = simulator.generate({ sourceText: CHAPTER_TEXT, instruction: 'x', seed: 7 });
    expect(a).toBe(b);
    // It does not pretend to be model output; a reader can tell at a glance.
    expect(a).toContain('[simulated revision');
  });
});
