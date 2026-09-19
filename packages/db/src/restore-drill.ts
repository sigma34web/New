/**
 * The disposable logical backup/restore drill (B-4-3).
 *
 * WHAT THIS PROVES. That a logical dump of a fully-migrated, multi-tenant database can be restored into a
 * fresh database and still carry every invariant the product depends on: the schema version, the RLS
 * policies, the immutable manuscript chain, canon continuity, evidence integrity, accepted-only
 * boundaries, quarantine exclusion, job/checkpoint state, attempt-level provider provenance, cost totals
 * and non-conflicting sequences.
 *
 * WHAT THIS DOES NOT PROVE, and never claims: point-in-time recovery, a staging restore, a production
 * restore, off-site backup, or any RTO/RPO figure. This is `pg_dump`/`pg_restore` against local
 * disposable databases. The report says exactly that, in a machine-readable field, so a reader cannot
 * mistake one for the other.
 *
 * SAFETY. Every destructive step goes through `restore-safety.ts`, which refuses anything that is not a
 * local, explicitly-marked-disposable database created by this very drill, and requires a separate
 * acknowledgement flag. The SOURCE database is opened read-only in intent and verified unchanged at the
 * end by re-checksumming it. Passwords and complete connection URLs never reach a log or the report.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPool, type Pool } from './client.js';
import { migrate } from './migrate.js';
import {
  approveManuscriptVersion,
  commitDelta,
  createManuscriptVersion,
  quarantineVersion,
  setChapterStatus,
} from './repo.js';
import {
  assertDestructiveTargetSafe,
  assertSourceSafe,
  describeTarget,
  drillDatabaseName,
  parseDatabaseTarget,
  urlForDatabase,
} from './restore-safety.js';

export interface DrillInvariant {
  /** Machine-readable id, e.g. `canon_versions_contiguous`. No prose. */
  readonly id: string;
  readonly outcome: 'passed' | 'failed';
  /** Compact observed value, for the report. Never prose, prompts or credentials. */
  readonly observed: string;
}

export interface RestoreDrillReport {
  readonly drill_id: string;
  readonly postgres_version: string;
  readonly migration_version: string;
  readonly migration_count: number;
  /** Deterministic logical checksum of the tenant-visible data, computed identically on both databases. */
  readonly source_checksum: string;
  readonly target_checksum: string;
  readonly source_checksum_after: string;
  readonly source_unchanged: boolean;
  readonly invariants: readonly DrillInvariant[];
  readonly duration_ms: number;
  readonly passed: boolean;
  /** Explicit scope statement so the evidence cannot be over-read. */
  readonly scope: {
    readonly method: 'logical_dump_restore';
    readonly pitr_tested: false;
    readonly staging_restore_tested: false;
    readonly production_restore_tested: false;
    readonly offsite_backup_tested: false;
    readonly rto_rpo_measured: false;
  };
}

/** Tables whose row counts are compared per workspace. Chosen to span every family the drill seeds. */
const COUNTED_TABLES = [
  'projects',
  'timelines',
  'chapters',
  'manuscript_versions',
  'quarantine_versions',
  'evidence_spans',
  'canon_commits',
  'summaries',
  'search_documents',
  'dependency_edges',
  'jobs',
  'job_steps',
  'job_events',
  'llm_calls',
] as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Run a PostgreSQL CLI tool. The password is passed via the environment, never on the command line. */
function runPgTool(
  tool: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): { ok: boolean; stderr: string } {
  const result = spawnSync(tool, [...args], { env, encoding: 'utf8' });
  if (result.error) return { ok: false, stderr: result.error.message };
  return { ok: result.status === 0, stderr: result.stderr };
}

/** True when both `pg_dump` and `pg_restore` are callable. The drill refuses rather than faking them. */
export function logicalToolsAvailable(): boolean {
  for (const tool of ['pg_dump', 'pg_restore']) {
    const probe = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return false;
  }
  return true;
}

/**
 * A deterministic logical checksum of the tenant-visible data.
 *
 * It is computed from ORDERED, per-table digests rather than from the dump bytes: a dump contains
 * timestamps, an OID ordering and a version banner, so comparing dump files would compare the dumper, not
 * the data. Ordering every row by primary key makes the digest independent of physical layout, which is
 * exactly what a restore is allowed to change.
 */
export async function logicalChecksum(pool: Pool): Promise<string> {
  const parts: string[] = [];
  for (const table of [...COUNTED_TABLES].sort()) {
    const { rows } = await pool.query<{ digest: string | null }>(
      // to_jsonb of the whole row keeps this schema-agnostic: a future column is included automatically
      // rather than silently escaping the comparison.
      `SELECT md5(string_agg(t.j::text, '|' ORDER BY t.j::text)) AS digest
         FROM (SELECT to_jsonb(x) AS j FROM ${table} x) t`,
    );
    parts.push(`${table}:${rows[0]?.digest ?? 'empty'}`);
  }
  return `sha256:${sha256(parts.join('\n'))}`;
}

async function scalar<T>(pool: Pool, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pool.query(sql, params);
  return Object.values(rows[0] as Record<string, unknown>)[0] as T;
}

/**
 * Scalar count as a JS number.
 *
 * `count(*)` and a `sum()` of bigints come back from node-postgres as STRINGS, because a bigint does not
 * fit a double safely. Comparing that string with `=== 0` is silently always false, so every numeric
 * check goes through this helper rather than trusting the driver's type.
 */
async function scalarNumber(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  return Number(await scalar<string | number>(pool, sql, params));
}

/**
 * Seed representative multi-tenant data: two workspaces with users, memberships, projects, story-bible
 * state, immutable manuscript versions (accepted and not), a quarantined rejected draft, canon commits
 * with evidence, summaries, jobs/steps/events, llm_calls carrying attempt records, search documents,
 * dependency edges and cost values.
 *
 * Acceptance goes through the REAL lifecycle — `createManuscriptVersion` → `approveManuscriptVersion` →
 * `commitDelta` — rather than inserting an accepted row directly. The schema refuses the shortcut
 * (`ILLEGAL_TRANSITION`, `CANON_WRITE_OUTSIDE_COMMIT`), and that refusal is the point: a restore drill
 * whose fixture bypassed the invariants would be verifying data the product can never actually produce.
 *
 * Rows a higher-level API would never construct — a quarantined rejected draft, a failed attempt record —
 * are written as direct SQL, because the drill must also carry them through a restore. All data is
 * synthetic and prose-free.
 */
export async function seedDrillData(pool: Pool): Promise<{ workspaces: string[] }> {
  const workspaceIds: string[] = [];

  for (const [index, name] of ['drill-workspace-alpha', 'drill-workspace-beta'].entries()) {
    const wsId = await scalar<string>(
      pool,
      'INSERT INTO workspaces (name) VALUES ($1) RETURNING id',
      [name],
    );
    workspaceIds.push(wsId);

    const userId = await scalar<string>(
      pool,
      `INSERT INTO users (email, display_name, password_algo, password_params, password_salt, password_hash)
       VALUES ($1, $2, 'scrypt', '{"N":16384,"r":8,"p":1,"keylen":64}'::jsonb, $3, $4) RETURNING id`,
      [
        `drill-${String(index)}@example.invalid`,
        `Drill Operator ${String(index)}`,
        'a'.repeat(32),
        'b'.repeat(128),
      ],
    );
    await pool.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [wsId, userId, index === 0 ? 'owner' : 'editor'],
    );

    const projectId = await scalar<string>(
      pool,
      // canon_version starts at 0 and is advanced by commitDelta itself; presetting it would make the
      // very first commit look stale.
      `INSERT INTO projects (workspace_id, title) VALUES ($1, $2) RETURNING id`,
      [wsId, `Drill Project ${String(index)}`],
    );
    await pool.query(
      `INSERT INTO timelines (workspace_id, project_id, name, kind) VALUES ($1, $2, 'main', 'main')`,
      [wsId, projectId],
    );
    const entityId = await scalar<string>(
      pool,
      `INSERT INTO entities (workspace_id, project_id, type, display_name)
       VALUES ($1, $2, 'character', $3) RETURNING id`,
      [wsId, projectId, `Drill Character ${String(index)}`],
    );

    // Canon version 1: the story-bible commit, through the real atomic canon boundary.
    await commitDelta(pool, {
      projectId,
      parentVersion: 0,
      source: 'bible',
      delta: {
        items: [
          {
            local_id: 'drill-b1',
            type: 'fact',
            op: 'assert',
            frame: 'canonical',
            confidence: 1,
            importance: 'core',
            evidence: [],
            payload: {
              entity_id: entityId,
              attribute: 'status.location',
              value: 'drill_hall',
              value_text: 'Drill Hall',
              valid_from: { chapter: 1, ord: 0 },
              valid_to: null,
            },
          },
        ],
      },
    });

    // Two chapters: chapter 1 goes all the way to ACCEPTED through the real lifecycle; chapter 2 stays
    // working. Plus one quarantined rejected draft that must survive the restore while staying excluded.
    const newChapter = async (chapterNo: number): Promise<string> =>
      scalar<string>(
        pool,
        `INSERT INTO chapters (workspace_id, project_id, number, title, status)
         VALUES ($1, $2, $3, $4, 'drafted') RETURNING id`,
        [wsId, projectId, chapterNo, `Chapter ${String(chapterNo)}`],
      );
    const acceptedChapterId = await newChapter(1);
    const workingChapterId = await newChapter(2);
    const quote = 'the drill hall stayed quiet';
    const acceptedText = `Chapter one: ${quote} until the gate opened.`;
    const accepted = await createManuscriptVersion(pool, {
      workspaceId: wsId,
      projectId,
      chapterId: acceptedChapterId,
      origin: 'assembled',
      text: acceptedText,
    });
    await setChapterStatus(pool, acceptedChapterId, 'review_pending');
    await approveManuscriptVersion(pool, accepted.id, 'drill-operator');

    // Canon version 2: chapter acceptance. This is the commit that flips the version to `accepted` and
    // writes the evidence span; doing it any other way is rejected by CANON_WRITE_OUTSIDE_COMMIT.
    const startCp = Array.from(acceptedText.slice(0, acceptedText.indexOf(quote))).length;
    await commitDelta(pool, {
      projectId,
      parentVersion: 1,
      source: 'chapter_acceptance',
      chapterId: acceptedChapterId,
      manuscriptVersionId: accepted.id,
      delta: {
        items: [
          {
            local_id: 'drill-f1',
            type: 'fact',
            op: 'assert',
            frame: 'canonical',
            confidence: 1,
            importance: 'core',
            story_clock: { chapter: 1, ord: 10 },
            evidence: [
              {
                manuscript_version_id: accepted.id,
                chapter_no: 1,
                start: startCp,
                end: startCp + Array.from(quote).length,
                quote,
                quote_hash: `sha256:${sha256(quote)}`,
              },
            ],
            payload: {
              entity_id: entityId,
              attribute: 'status.mood',
              value: 'quiet',
              value_text: 'Quiet',
              valid_from: { chapter: 1, ord: 10 },
              valid_to: null,
            },
          },
        ],
      },
    });

    // Chapter 2 keeps a working (non-accepted) version: the restore must preserve the boundary between
    // what is accepted and what is merely drafted.
    const working = await createManuscriptVersion(pool, {
      workspaceId: wsId,
      projectId,
      chapterId: workingChapterId,
      origin: 'assembled',
      text: 'Chapter two remains a working draft in this drill fixture.',
    });

    // A rejected draft, moved to quarantine by the real routine so it leaves the live table entirely.
    const rejected = await createManuscriptVersion(pool, {
      workspaceId: wsId,
      projectId,
      chapterId: acceptedChapterId,
      origin: 'revision',
      text: 'A revision that the drill fixture rejects on purpose.',
    });
    await quarantineVersion(pool, rejected.id, 'drill_synthetic_rejection');

    await pool.query(
      `INSERT INTO summaries
         (workspace_id, project_id, tier, scope_kind, scope_id, chapter_from, chapter_to,
          manuscript_version_id, text, canon_version, content_hash)
       VALUES ($1, $2, 'L1', 'chapter', $3, 1, 1, $4, $5, 2, $6)`,
      [
        wsId,
        projectId,
        acceptedChapterId,
        accepted.id,
        'Drill summary text.',
        sha256('drill-summary'),
      ],
    );
    await pool.query(
      `INSERT INTO search_documents
         (workspace_id, project_id, kind, ref_kind, ref_id, ref_key, chapter_no,
          manuscript_version_id, text, canon_version_added)
       VALUES ($1, $2, 'chapter_paragraph', 'manuscript_version', $3, 'p1', 1, $3, $4, 2)`,
      [wsId, projectId, accepted.id, acceptedText],
    );
    await pool.query(
      `INSERT INTO dependency_edges
         (workspace_id, project_id, dependent_kind, dependent_id, canon_item_kind, canon_item_ref,
          source_kind, canon_version_read, materiality, basis)
       VALUES ($1, $2, 'manuscript_version', $3, 'fact', $4, 'fact', 1, 'material', 't0')`,
      [wsId, projectId, working.id, `entity:${entityId}`],
    );

    // A job with a checkpointed step, an append-only event log and a terminal event.
    const jobId = await scalar<string>(
      pool,
      `INSERT INTO jobs (workspace_id, project_id, kind, status, production_policy_version, spend_cents,
                         current_step, finished_at)
       VALUES ($1, $2, 'produce_chapter', 'completed', 'policy/standard@1', 12, 'acceptance', now())
       RETURNING id`,
      [wsId, projectId],
    );
    await pool.query(
      `INSERT INTO job_steps (job_id, step, idempotency_key, status, result, completed_at)
       VALUES ($1, 'acceptance', $2, 'completed', '{"ok":true}'::jsonb, now())`,
      [jobId, `drill-${jobId}-acceptance`],
    );
    for (const [seq, kind] of [
      [1, 'job.started'],
      [2, 'job.completed'],
    ] as const) {
      await pool.query(
        `INSERT INTO job_events (workspace_id, project_id, job_id, seq, kind, payload, terminal)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6)`,
        [wsId, projectId, jobId, seq, kind, kind === 'job.completed'],
      );
    }

    // Two gateway calls: one clean success, one that fell back — the fallback carries per-attempt
    // provenance in migration 0011's attempt_records, which the restore must preserve verbatim.
    await pool.query(
      `INSERT INTO llm_calls
         (id, workspace_id, project_id, job_id, idempotency_key, role, prompt_version_id, prompt_hash,
          production_policy_version, model_id, model_class, provider, params, input_hash, usage,
          cost_cents, latency_ms, status, attempt_records)
       VALUES (canon.uuid_v7(), $1, $2, $3, $4, 'drafter', 'prompt/drafter@1.0.0', $5,
               'policy/standard@1', 'model-a', 'P', 'replay', '{}'::jsonb, $6,
               '{"input_tokens":100,"output_tokens":200}'::jsonb, 7, 120, 'succeeded',
               $7::jsonb)`,
      [
        wsId,
        projectId,
        jobId,
        `drill-${jobId}-drafter`,
        sha256('drill-prompt'),
        sha256('drill-input'),
        JSON.stringify([
          {
            attempt: 1,
            model_id: 'model-a',
            provider: 'replay',
            outcome: 'succeeded',
            cost_cents: 7,
            usage: { input_tokens: 100, output_tokens: 200 },
            latency_ms: 120,
          },
        ]),
      ],
    );
    // A CANCELLED call (migration 0012). Seeded because its provenance is the one audit field whose
    // whole purpose is to say what is NOT known — if a restore silently dropped it, a cancelled call
    // would read as an ordinary zero-cost call, which is the false-zero the column exists to prevent.
    await pool.query(
      `INSERT INTO llm_calls
         (id, workspace_id, project_id, job_id, idempotency_key, role, prompt_version_id, prompt_hash,
          production_policy_version, model_id, model_class, provider, params, input_hash, usage,
          cost_cents, latency_ms, status, attempt_records, cancellation)
       VALUES (canon.uuid_v7(), $1, $2, $3, $4, 'drafter', 'prompt/drafter@1.0.0', $5,
               'policy/standard@1', 'model-a', 'P', 'replay', '{}'::jsonb, $6,
               '{}'::jsonb, 0, 90, 'cancelled', $7::jsonb, $8::jsonb)`,
      [
        wsId,
        projectId,
        jobId,
        `drill-${jobId}-cancelled`,
        sha256('drill-prompt-cancelled'),
        sha256('drill-input-cancelled'),
        JSON.stringify([
          {
            attempt: 1,
            model_id: 'model-a',
            provider: 'replay',
            outcome: 'failed',
            failure_class: 'cancelled',
            error_class: 'CANCELLED',
            cost_cents: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
            latency_ms: 90,
          },
        ]),
        JSON.stringify({
          reason: 'operator_cancelled',
          outcome: 'operator_cancelled',
          remote_cancellation: 'unsupported',
          usage_status: 'unknown',
          billing_status: 'unknown',
          response_discarded: false,
          before_first_attempt: false,
        }),
      ],
    );
    await pool.query(
      `INSERT INTO llm_calls
         (id, workspace_id, project_id, job_id, idempotency_key, role, prompt_version_id, prompt_hash,
          production_policy_version, model_id, model_class, provider, params, input_hash, usage,
          cost_cents, latency_ms, status, fallback_from_model_id, attempt_records)
       VALUES (canon.uuid_v7(), $1, $2, $3, $4, 'evaluator', 'prompt/evaluator@1.0.0', $5,
               'policy/standard@1', 'model-b', 'C', 'replay', '{}'::jsonb, $6,
               '{"input_tokens":50,"output_tokens":60}'::jsonb, 5, 340, 'fallback_succeeded', 'model-a',
               $7::jsonb)`,
      [
        wsId,
        projectId,
        jobId,
        `drill-${jobId}-evaluator`,
        sha256('drill-prompt-2'),
        sha256('drill-input-2'),
        JSON.stringify([
          {
            attempt: 1,
            model_id: 'model-a',
            provider: 'replay',
            outcome: 'failed',
            failure_class: 'retryable',
            error_class: 'timeout',
            cost_cents: 0,
            latency_ms: 200,
          },
          {
            attempt: 2,
            model_id: 'model-b',
            provider: 'replay',
            outcome: 'succeeded',
            cost_cents: 5,
            usage: { input_tokens: 50, output_tokens: 60 },
            latency_ms: 140,
          },
        ]),
      ],
    );
  }

  return { workspaces: workspaceIds };
}

interface VerifyContext {
  readonly source: Pool;
  readonly target: Pool;
  readonly workspaces: readonly string[];
}

/** Every integrity check the drill makes on the RESTORED database. Each returns one report entry. */
async function verifyRestored(ctx: VerifyContext): Promise<DrillInvariant[]> {
  const out: DrillInvariant[] = [];
  const check = (id: string, ok: boolean, observed: string): void => {
    out.push({ id, outcome: ok ? 'passed' : 'failed', observed });
  };

  // Schema version: the restored database must claim exactly the migrations the source applied.
  const srcMigrations = await scalar<string>(
    ctx.source,
    'SELECT count(*)::text FROM schema_migrations',
  );
  const tgtMigrations = await scalar<string>(
    ctx.target,
    'SELECT count(*)::text FROM schema_migrations',
  );
  check(
    'migration_count_matches',
    srcMigrations === tgtMigrations,
    `${srcMigrations}/${tgtMigrations}`,
  );
  const latest = await scalar<string>(ctx.target, 'SELECT max(name) FROM schema_migrations');
  check('migration_0011_present', latest >= '0011', latest);

  // Tables, indexes and triggers all have to survive; a data-only restore would pass row counts alone.
  for (const [id, sql, min] of [
    ['tables_restored', "SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public'", 50],
    ['indexes_restored', "SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public'", 50],
    ['triggers_restored', 'SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal', 1],
  ] as const) {
    const n = await scalarNumber(ctx.target, sql);
    check(id, n >= min, String(n));
  }

  // RLS is a restore-critical property: pg_dump emits the policies, but only a check proves it.
  const srcPolicies = await scalarNumber(
    ctx.source,
    "SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'",
  );
  const tgtPolicies = await scalarNumber(
    ctx.target,
    "SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'",
  );
  check(
    'rls_policies_restored',
    srcPolicies === tgtPolicies && tgtPolicies > 0,
    `${String(srcPolicies)}/${String(tgtPolicies)}`,
  );
  const forced = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity`,
  );
  check('rls_forced_on_tenant_tables', forced > 0, String(forced));

  // Row counts per workspace, per table: a restore that lost or merged a tenant fails here.
  let countsMatch = true;
  const mismatches: string[] = [];
  for (const table of COUNTED_TABLES) {
    const hasWorkspace = await scalar<boolean>(
      ctx.target,
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema='public' AND table_name=$1 AND column_name='workspace_id')`,
      [table],
    );
    const sql = hasWorkspace
      ? `SELECT count(*)::text FROM ${table} WHERE workspace_id = $1`
      : `SELECT count(*)::text FROM ${table}`;
    for (const ws of ctx.workspaces) {
      const params = hasWorkspace ? [ws] : [];
      const a = await scalar<string>(ctx.source, sql, params);
      const b = await scalar<string>(ctx.target, sql, params);
      if (a !== b) {
        countsMatch = false;
        mismatches.push(`${table}=${a}/${b}`);
      }
      if (!hasWorkspace) break;
    }
  }
  check(
    'row_counts_match_by_workspace',
    countsMatch,
    countsMatch ? `${String(COUNTED_TABLES.length)}_tables_equal` : mismatches.join(','),
  );

  // Canon continuity: versions are contiguous from 1 and every commit is parent+1.
  const gaps = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM (
       SELECT version, parent_version,
              lag(version) OVER (PARTITION BY project_id ORDER BY version) AS prev
         FROM canon_commits) t
      WHERE version <> parent_version + 1 OR (prev IS NOT NULL AND version <> prev + 1)`,
  );
  check('canon_versions_contiguous', gaps === 0, `${String(gaps)}_gaps`);

  // Immutable chains and hashes: the stored content hash must still match the stored text. Hashes are
  // stored with the `sha256:` prefix the prose package writes, so the comparison reproduces that form
  // rather than a bare digest.
  const badHashes = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM manuscript_versions
      WHERE content_hash <> 'sha256:' || encode(sha256(convert_to(text, 'UTF8')), 'hex')`,
  );
  check('manuscript_content_hashes_intact', badHashes === 0, `${String(badHashes)}_mismatched`);

  // Evidence integrity: offsets are code-point offsets into NFC text and must still address their quote.
  // `substring` counts characters, which for PostgreSQL text is code points — the same unit ADR-0030
  // specifies, so the check is in the offsets' own unit rather than in bytes or UTF-16 units.
  const badEvidence = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM evidence_spans e
       JOIN manuscript_versions m ON m.id = e.manuscript_version_id
      WHERE substring(m.text FROM e.start_cp + 1 FOR e.end_cp - e.start_cp) <> e.quote
         OR e.quote_hash <> 'sha256:' || encode(sha256(convert_to(e.quote, 'UTF8')), 'hex')`,
  );
  check('evidence_offsets_and_hashes_intact', badEvidence === 0, `${String(badEvidence)}_broken`);

  // Accepted-only boundary: every chapter that points at an accepted version points at an ACCEPTED one.
  const badAccepted = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM chapters c JOIN manuscript_versions m ON m.id = c.accepted_version_id
      WHERE m.status <> 'accepted'`,
  );
  check('accepted_pointer_only_accepted', badAccepted === 0, `${String(badAccepted)}_violations`);

  // Quarantine stays quarantined and never leaks into the live manuscript table.
  const quarantined = await scalarNumber(
    ctx.target,
    'SELECT count(*)::int FROM quarantine_versions',
  );
  const leaked = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM manuscript_versions mv
      WHERE EXISTS (SELECT 1 FROM quarantine_versions q WHERE q.content_hash = mv.content_hash)`,
  );
  check(
    'quarantine_preserved_and_excluded',
    quarantined > 0 && leaked === 0,
    `${String(quarantined)}_quarantined_${String(leaked)}_leaked`,
  );

  // Job and checkpoint state, including the terminal event that must occur exactly once per job.
  const badTerminal = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM (
       SELECT job_id, count(*) FILTER (WHERE terminal) AS n FROM job_events GROUP BY job_id) t
      WHERE n <> 1`,
  );
  check('job_terminal_event_exactly_once', badTerminal === 0, `${String(badTerminal)}_jobs_wrong`);
  const completedSteps = await scalarNumber(
    ctx.target,
    "SELECT count(*)::int FROM job_steps WHERE status = 'completed'",
  );
  check('job_checkpoints_restored', completedSteps > 0, String(completedSteps));

  // Attempt-level provider provenance (migration 0011) must survive byte-for-byte.
  const attemptRows = await scalarNumber(
    ctx.target,
    'SELECT count(*)::int FROM llm_calls WHERE jsonb_array_length(attempt_records) > 0',
  );
  const fallbackAttempts = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM llm_calls
      WHERE status = 'fallback_succeeded' AND jsonb_array_length(attempt_records) >= 2`,
  );
  check(
    'attempt_provenance_restored',
    attemptRows > 0 && fallbackAttempts > 0,
    `${String(attemptRows)}_calls_${String(fallbackAttempts)}_fallbacks`,
  );

  /**
   * Cancellation provenance (migration 0012) must survive a restore INTACT, including its unknowns.
   *
   * Checked field by field rather than by mere presence: the failure mode worth catching is a restore
   * that keeps the row but loses the object, because the row then reads as an ordinary completed call
   * that cost nothing — a confirmed zero bill the system never observed.
   */
  const cancelledCalls = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM llm_calls WHERE status = 'cancelled'`,
  );
  const truthfulCancellations = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM llm_calls
      WHERE status = 'cancelled'
        AND cancellation->>'reason' = 'operator_cancelled'
        AND cancellation->>'usage_status' = 'unknown'
        AND cancellation->>'billing_status' = 'unknown'
        AND cancellation->>'remote_cancellation' <> 'acknowledged'`,
  );
  check(
    'cancellation_provenance_restored',
    cancelledCalls > 0 && truthfulCancellations === cancelledCalls,
    `${String(truthfulCancellations)}/${String(cancelledCalls)}`,
  );

  // Cost totals: the summed authoritative total must match, per workspace.
  let costsMatch = true;
  for (const ws of ctx.workspaces) {
    const a = await scalar<string>(
      ctx.source,
      'SELECT coalesce(sum(cost_cents),0)::text FROM llm_calls WHERE workspace_id = $1',
      [ws],
    );
    const b = await scalar<string>(
      ctx.target,
      'SELECT coalesce(sum(cost_cents),0)::text FROM llm_calls WHERE workspace_id = $1',
      [ws],
    );
    if (a !== b) costsMatch = false;
  }
  check('cost_totals_match_by_workspace', costsMatch, costsMatch ? 'equal' : 'mismatch');

  // Summaries, search documents and dependency edges must still reference live rows.
  const orphans = await scalarNumber(
    ctx.target,
    `SELECT (SELECT count(*) FROM summaries s
              WHERE s.manuscript_version_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM manuscript_versions m WHERE m.id = s.manuscript_version_id))
          + (SELECT count(*) FROM search_documents d
              WHERE d.manuscript_version_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM manuscript_versions m WHERE m.id = d.manuscript_version_id))
          + (SELECT count(*) FROM dependency_edges e
              WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = e.project_id))`,
  );
  check('derived_rows_have_no_orphans', orphans === 0, `${String(orphans)}_orphans`);

  // Sequences: a restore that reset a sequence would hand out a colliding id on the next insert.
  const nextSeq = await scalar<string>(ctx.target, "SELECT nextval('job_events_id_seq')::text");
  const maxExisting = await scalar<string>(
    ctx.target,
    'SELECT coalesce(max(id),0)::text FROM job_events',
  );
  check(
    'sequences_do_not_collide',
    Number(nextSeq) > Number(maxExisting),
    `${nextSeq}>${maxExisting}`,
  );

  // RLS still ISOLATES in the restored database — the policy existing is not the same as it binding.
  const [wsA, wsB] = ctx.workspaces;
  if (wsA !== undefined && wsB !== undefined) {
    const client = await ctx.target.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', wsA]);
      await client.query('SET LOCAL ROLE yeonjae_app');
      const visible = await client.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM projects WHERE workspace_id = $1',
        [wsB],
      );
      const own = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM projects');
      await client.query('COMMIT');
      const crossVisible = Number(visible.rows[0]?.n ?? '-1');
      const ownVisible = Number(own.rows[0]?.n ?? '0');
      check(
        'rls_cross_workspace_isolation_enforced',
        crossVisible === 0 && ownVisible > 0,
        `cross=${String(crossVisible)}_own=${String(ownVisible)}`,
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      check('rls_cross_workspace_isolation_enforced', false, `error:${(err as Error).name}`);
    } finally {
      client.release();
    }
  }

  await verifySecurityInvariants(ctx, check);

  return out;
}

/**
 * Security metadata and security BEHAVIOUR after restore (ADR-0050).
 *
 * The checks above prove the rows, the schema, the policy count and that RLS still isolates. None of them
 * would notice a restore that reproduced every row while losing a grant, re-enabling a disabled trigger,
 * dropping `FORCE RLS` on one table, changing a function's security mode or handing `EXECUTE` back to
 * PUBLIC. A restored database that has lost its privilege model has silently lost the security model, and
 * "the dump contained the DDL" is not the same claim as "the restored database refuses the write".
 *
 * So this compares the security metadata SOURCE-TO-TARGET (rather than against hard-coded numbers, which
 * would rot with every migration) and then re-executes both a legitimate application operation and a
 * forbidden direct mutation against the restored database, as the real non-owner role.
 */
async function verifySecurityInvariants(
  ctx: VerifyContext,
  check: (id: string, ok: boolean, observed: string) => void,
): Promise<void> {
  // 1. Table grants, sequence grants and function EXECUTE grants, compared as sorted text.
  const grantQueries: readonly (readonly [string, string])[] = [
    [
      'table_grants_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT DISTINCT table_name || ':' || privilege_type AS t
           FROM information_schema.role_table_grants
          WHERE grantee = 'yeonjae_app' AND table_schema = 'public') s`,
    ],
    [
      'sequence_grants_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT c.relname
                || ':U=' || has_sequence_privilege('yeonjae_app', c.oid, 'USAGE')::text
                || ':S=' || has_sequence_privilege('yeonjae_app', c.oid, 'SELECT')::text
                || ':W=' || has_sequence_privilege('yeonjae_app', c.oid, 'UPDATE')::text AS t
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'S' AND n.nspname = 'public') s`,
    ],
    [
      'function_execute_grants_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT p.proname
                || ':app=' || has_function_privilege('yeonjae_app', p.oid, 'EXECUTE')::text
                || ':public=' || has_function_privilege('public', p.oid, 'EXECUTE')::text AS t
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'canon') s`,
    ],
    [
      'function_security_and_search_path_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT p.proname || ':secdef=' || p.prosecdef::text
                || ':cfg=' || coalesce(array_to_string(p.proconfig, ','), 'none') AS t
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'canon') s`,
    ],
    [
      'policy_definitions_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT tablename || ':' || policyname || ':' || cmd
                || ':' || coalesce(qual, '-') || ':' || coalesce(with_check, '-') AS t
           FROM pg_policies WHERE schemaname = 'public') s`,
    ],
    [
      'rls_and_force_rls_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT c.relname || ':rls=' || c.relrowsecurity::text
                || ':force=' || c.relforcerowsecurity::text AS t
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r') s`,
    ],
    [
      'trigger_definitions_and_enabled_state_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT c.relname || ':' || tg.tgname || ':' || tg.tgenabled::text AS t
           FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE NOT tg.tgisinternal AND n.nspname = 'public') s`,
    ],
    [
      'table_owners_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT tablename || ':' || tableowner AS t
           FROM pg_tables WHERE schemaname = 'public') s`,
    ],
    [
      'schema_privileges_preserved',
      `SELECT coalesce(string_agg(t, ';' ORDER BY t), '') FROM (
         SELECT n.nspname
                || ':appU=' || has_schema_privilege('yeonjae_app', n.nspname, 'USAGE')::text
                || ':appC=' || has_schema_privilege('yeonjae_app', n.nspname, 'CREATE')::text AS t
           FROM pg_namespace n WHERE n.nspname IN ('public', 'canon')) s`,
    ],
  ];
  for (const [id, sql] of grantQueries) {
    const a = await scalar<string>(ctx.source, sql);
    const b = await scalar<string>(ctx.target, sql);
    // A non-empty value matters as much as equality: two empty strings would compare equal if the query
    // silently matched nothing, which would make this check vacuous.
    check(id, a === b && a.length > 0, a === b ? 'identical' : 'DIFFERS');
  }

  // 2. Role attributes. These are cluster-level, so they are read once and asserted absolutely: a
  //    superuser or BYPASSRLS application role would void every isolation result above.
  const role = await ctx.target.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
  }>(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname = 'yeonjae_app'`,
  );
  const attrs = role.rows[0];
  check(
    'app_role_remains_unprivileged',
    attrs !== undefined &&
      !attrs.rolsuper &&
      !attrs.rolbypassrls &&
      !attrs.rolcreatedb &&
      !attrs.rolcreaterole,
    attrs === undefined ? 'role_missing' : `super=${String(attrs.rolsuper)}`,
  );

  // 3. No canon function may be PUBLIC-executable after restore (ADR-0050 decision 5).
  const publicExec = await scalarNumber(
    ctx.target,
    `SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'canon' AND has_function_privilege('public', p.oid, 'EXECUTE')`,
  );
  check('no_public_execute_after_restore', publicExec === 0, `${String(publicExec)}_public_exec`);

  // 4. BEHAVIOUR, as the real non-owner role: the legitimate append still works and the forbidden direct
  //    mutations are still refused. Metadata can look right while the restored database behaves wrongly.
  const [wsA] = ctx.workspaces;
  if (wsA === undefined) return;
  const projectId = await scalar<string | null>(
    ctx.target,
    'SELECT id::text FROM projects WHERE workspace_id = $1 ORDER BY id LIMIT 1',
    [wsA],
  );
  if (projectId === null) return;

  const attempt = async (sql: string, params: readonly unknown[] = []): Promise<boolean> => {
    const client = await ctx.target.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', wsA]);
      await client.query('SET LOCAL ROLE yeonjae_app');
      await client.query(sql, params as unknown[]);
      return true;
    } catch {
      return false;
    } finally {
      // Always rolled back: a permitted forbidden write must not persist into the rest of the drill.
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };

  const appended = await attempt(
    `INSERT INTO audit_log (workspace_id, project_id, action, target_kind, target_id)
     VALUES ($1, $2, 'restore.drill.allowed', 'project', $3)`,
    [wsA, projectId, projectId],
  );
  check('restored_legitimate_audit_append_succeeds', appended, appended ? 'permitted' : 'REFUSED');

  for (const [id, sql] of [
    ['restored_audit_update_refused', `UPDATE audit_log SET action = 'forged'`],
    ['restored_audit_delete_refused', 'DELETE FROM audit_log'],
    ['restored_job_event_update_refused', `UPDATE job_events SET kind = 'forged'`],
    ['restored_canon_commit_delete_refused', 'DELETE FROM canon_commits'],
    ['restored_llm_call_cost_rewrite_refused', 'UPDATE llm_calls SET cost_cents = 0'],
  ] as const) {
    const permitted = await attempt(sql);
    check(id, !permitted, permitted ? 'PERMITTED' : 'refused');
  }
}

export interface RunDrillOptions {
  /** Admin URL on a LOCAL server used only to CREATE/DROP the drill databases. */
  readonly adminUrl: string;
  /** Required, explicit acknowledgement before any destructive step. */
  readonly acknowledgeDestructive: boolean;
  readonly drillId?: string | undefined;
  /** Keep the drill databases for inspection. Default false: the drill cleans up what it created. */
  readonly keepDatabases?: boolean | undefined;
}

/**
 * Run the complete drill: create two disposable databases, migrate and seed the source, dump it, restore
 * into the target, verify every invariant, confirm the source is unchanged, and clean up only what this
 * drill created.
 *
 * Partial failures are handled by an unconditional cleanup pass in `finally`, which itself re-runs the
 * safety guard on each name before dropping. A cleanup that cannot prove a target is safe leaves it in
 * place and says so rather than guessing.
 */
export async function runRestoreDrill(options: RunDrillOptions): Promise<RestoreDrillReport> {
  const startedAt = Date.now();
  const drillId = options.drillId ?? `d${Date.now().toString(36)}`;
  assertSourceSafe(options.adminUrl);
  if (!logicalToolsAvailable())
    throw new Error('pg_dump/pg_restore are unavailable; the drill refuses to substitute a fake');

  const sourceDb = drillDatabaseName(drillId, 'source');
  const targetDb = drillDatabaseName(drillId, 'restored');
  const created: string[] = [];
  const admin = createPool({ connectionString: options.adminUrl, max: 2 });
  /**
   * Attach an error listener to every drill pool.
   *
   * `DROP DATABASE ... WITH (FORCE)` in the cleanup below terminates any backend still attached to the
   * database being dropped. `pg` emits that as an `error` event on the POOL, and a pool with no `error`
   * listener turns it into an unhandled exception — which is how a drill whose 83 assertions all passed
   * still failed the runner with "terminating connection due to administrator command".
   *
   * The connection is genuinely gone and the drill is finished with it, so the correct handling is to
   * absorb the event rather than to crash. It is attached at creation, before any query, because an
   * error that arrives during teardown must already have a listener waiting.
   */
  const absorbPoolErrors = (pool: Pool): Pool => {
    pool.on('error', () => undefined);
    return pool;
  };
  absorbPoolErrors(admin);
  let source: Pool | undefined;
  let target: Pool | undefined;
  const dumpDir = mkdtempSync(join(tmpdir(), 'yeonjae-drill-'));
  const dumpPath = join(dumpDir, 'source.dump');

  try {
    // CREATE DATABASE cannot be parameterized; the names are generated by drillDatabaseName from a
    // sanitized id, so they contain [a-z0-9_] only.
    for (const db of [sourceDb, targetDb]) {
      await admin.query(`CREATE DATABASE ${db}`);
      created.push(db);
    }

    const sourceUrl = urlForDatabase(options.adminUrl, sourceDb);
    const targetUrl = urlForDatabase(options.adminUrl, targetDb);
    source = absorbPoolErrors(createPool({ connectionString: sourceUrl, max: 4 }));
    target = absorbPoolErrors(createPool({ connectionString: targetUrl, max: 4 }));

    const applied = await migrate(source);
    const seeded = await seedDrillData(source);
    const sourceChecksum = await logicalChecksum(source);

    const sourceTarget = parseDatabaseTarget(sourceUrl);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PGPASSWORD: new URL(sourceUrl).password,
    };
    const dump = runPgTool(
      'pg_dump',
      [
        '--format=custom',
        `--file=${dumpPath}`,
        `--host=${sourceTarget.host}`,
        `--port=${String(sourceTarget.port)}`,
        `--username=${sourceTarget.user}`,
        '--no-password',
        sourceDb,
      ],
      env,
    );
    if (!dump.ok) throw new Error(`pg_dump failed for ${describeTarget(sourceTarget)}`);

    const restore = runPgTool(
      'pg_restore',
      [
        `--dbname=${targetDb}`,
        `--host=${sourceTarget.host}`,
        `--port=${String(sourceTarget.port)}`,
        `--username=${sourceTarget.user}`,
        '--no-password',
        '--exit-on-error',
        dumpPath,
      ],
      env,
    );
    if (!restore.ok) throw new Error('pg_restore failed for the disposable restore target');

    const targetChecksum = await logicalChecksum(target);
    const invariants = await verifyRestored({ source, target, workspaces: seeded.workspaces });
    invariants.push({
      id: 'logical_checksum_matches',
      outcome: sourceChecksum === targetChecksum ? 'passed' : 'failed',
      observed: sourceChecksum === targetChecksum ? 'equal' : 'different',
    });

    // The source must be untouched by the whole exercise: re-checksum and compare.
    const sourceChecksumAfter = await logicalChecksum(source);
    const sourceUnchanged = sourceChecksumAfter === sourceChecksum;
    invariants.push({
      id: 'source_database_unchanged',
      outcome: sourceUnchanged ? 'passed' : 'failed',
      observed: sourceUnchanged ? 'unchanged' : 'mutated',
    });

    const pgVersion = await scalar<string>(target, 'SHOW server_version');

    return {
      drill_id: drillId,
      postgres_version: pgVersion,
      migration_version: await scalar<string>(target, 'SELECT max(name) FROM schema_migrations'),
      migration_count: applied.applied.length + applied.skipped.length,
      source_checksum: sourceChecksum,
      target_checksum: targetChecksum,
      source_checksum_after: sourceChecksumAfter,
      source_unchanged: sourceUnchanged,
      invariants,
      duration_ms: Date.now() - startedAt,
      passed: invariants.every((i) => i.outcome === 'passed') && sourceUnchanged,
      scope: {
        method: 'logical_dump_restore',
        pitr_tested: false,
        staging_restore_tested: false,
        production_restore_tested: false,
        offsite_backup_tested: false,
        rto_rpo_measured: false,
      },
    };
  } finally {
    await source?.end().catch(() => undefined);
    await target?.end().catch(() => undefined);
    rmSync(dumpDir, { recursive: true, force: true });
    if (!options.keepDatabases) {
      for (const db of created) {
        const url = urlForDatabase(options.adminUrl, db);
        // Re-verify immediately before dropping: the guard runs at the moment of destruction, not once
        // at the top of the function where a later mistake could slip past it.
        const verdict = assertDestructiveTargetSafeQuiet({
          url,
          acknowledged: options.acknowledgeDestructive,
          createdByDrill: created,
        });
        if (verdict)
          await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
      }
    }
    await admin.end().catch(() => undefined);
  }
}

/** Non-throwing guard used in cleanup, where an exception would mask the original failure. */
function assertDestructiveTargetSafeQuiet(input: {
  readonly url: string;
  readonly acknowledged: boolean;
  readonly createdByDrill: readonly string[];
}): boolean {
  try {
    assertDestructiveTargetSafe(input);
    return true;
  } catch {
    return false;
  }
}
