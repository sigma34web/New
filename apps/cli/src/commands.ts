/**
 * CLI commands available in Checkpoint 1. Each command is a pure function over its inputs so it can be unit
 * tested without a TTY; main.ts only parses argv and prints. Later checkpoints add project/chapter commands.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  checkOutputLanguage,
  contentHashOf,
  measure,
  toNfcText,
  verifyEvidence,
  segmentParagraphs,
} from '@yeonjae/prose';
import { loadPolicies, loadSchemas, validatorFor } from '@yeonjae/domain';
import {
  type Pool,
  approveManuscriptVersion,
  budgetReport,
  BUDGET_SCOPE_KINDS,
  configFromEnv,
  createChapter,
  createEntity,
  createManuscriptVersion,
  createPool,
  createProject,
  createWorkspace,
  embeddingSetReport,
  factsForEntity,
  gcEligible,
  getProject,
  leaseOccupancy,
  listCommits,
  migrate,
  OPERATION_CLASSES,
  OPERATOR_ALIAS_KINDS,
  OperatorMutationError,
  activateEmbeddingSetForOperator,
  createAliasForOperator,
  rateLimitStatus,
  retrievalDiagnostics,
  rollbackLatest,
  rollbackEmbeddingSetForOperator,
  setAliasActiveForOperator,
  stateAt,
  thesaurusListing,
  withWorkspace,
  acceptPreview,
  BatchError,
  cancelPreview,
  createPreview,
  dependencyReport,
  discardPreview,
  listPreviews,
  PreviewError,
  runBatch,
  type ItemCode,
} from '@yeonjae/db';
import { acceptChapter, DeltaRejectedError } from '@yeonjae/canon';
import {
  checkPlatformFormat,
  checkTypography,
  PLATFORM_PROFILES,
  PlatformProfileError,
  resolveProfile,
  typographySummary,
} from '@yeonjae/prose';
import { compileBlock, composeIdentity, ProfileStore, type RoleVariant } from '@yeonjae/narrative';
import { PromptRegistry } from '@yeonjae/prompts';
import {
  acceptedChapter,
  indexAcceptedVersion,
  reindexProject,
  upsertL1Summary,
  withTransaction,
} from '@yeonjae/db';
import {
  buildPack,
  compileActiveConstraintSet,
  ContextError,
  PgLexicalRetriever,
  type ChapterContract,
  type StorySpec,
} from '@yeonjae/context';
import { loadPolicies as loadPolicyMap, type PolicyRef } from '@yeonjae/domain';
import {
  exportAccepted,
  ExportRefusedError,
  prepareExport,
  produceChapter,
  workflowIdFor,
  workflowStatus,
  type ChapterProductionInput,
} from '@yeonjae/workflows';
import { Gateway, MemoryBudget, ReplayProvider, type RoutingTable } from '@yeonjae/gateway';
import { PgAuditStore } from '@yeonjae/db';
import { ArtifactLlmOutputStore } from '@yeonjae/workflows';
import { WorkflowError } from '@yeonjae/workflows';

/** Chapter-1 fixture paths and identity pins (mirrors packages/workflows/src/testkit.ts, the test-only harness). */
const FIXTURE_ROOT = new URL('../../../', import.meta.url);
const FIXTURE_REPLAY = new URL('examples/fixture/ch01/replay.ch01.json', FIXTURE_ROOT);
const FIXTURE_INTAKE = new URL('examples/fixture/story-intake.json', FIXTURE_ROOT);
const FIXTURE_BIBLE = new URL('examples/fixture/ch01/story-bible.ch01.json', FIXTURE_ROOT);
const FIXTURE_IDS = JSON.parse(
  readFileSync(new URL('examples/fixture/ch01/ids.ch01.json', FIXTURE_ROOT), 'utf8'),
) as { arc1: string; season1: string; contract1: string; contract2: string };
const IDENTITY_REF = 'project/0191b2a0-0000-7000-8000-000000000001@1';
const IDENTITY_VERSION = '0191b2a0-0000-7000-8000-000000060001';
const REPLAY_ROUTING: RoutingTable = {
  R: [
    {
      modelId: 'replay-r',
      provider: 'replay',
      priority: 1,
      family: 'alpha',
      priceInPerMTokCents: 100,
      priceOutPerMTokCents: 400,
      maxContextTokens: 200_000,
      supportsJsonSchema: true,
    },
  ],
  P: [
    {
      modelId: 'replay-p',
      provider: 'replay',
      priority: 1,
      family: 'alpha',
      priceInPerMTokCents: 100,
      priceOutPerMTokCents: 400,
      maxContextTokens: 200_000,
      supportsJsonSchema: true,
    },
  ],
  M: [
    {
      modelId: 'replay-m',
      provider: 'replay',
      priority: 1,
      family: 'beta',
      priceInPerMTokCents: 100,
      priceOutPerMTokCents: 400,
      maxContextTokens: 200_000,
      supportsJsonSchema: true,
    },
  ],
  C: [
    {
      modelId: 'replay-c',
      provider: 'replay',
      priority: 1,
      family: 'beta',
      priceInPerMTokCents: 100,
      priceOutPerMTokCents: 400,
      maxContextTokens: 200_000,
      supportsJsonSchema: true,
    },
  ],
  E: [],
};

export interface CommandResult {
  readonly ok: boolean;
  readonly output: unknown;
}

export function cmdMeasure(path: string): CommandResult {
  const nfc = toNfcText(readFileSync(path, 'utf8'));
  return { ok: true, output: measure(nfc) };
}

export function cmdLanguageCheck(path: string, allowlist: readonly string[] = []): CommandResult {
  const nfc = toNfcText(readFileSync(path, 'utf8'));
  const r = checkOutputLanguage(nfc, { allowlist });
  return { ok: r.passed, output: r };
}

export function cmdValidate(schemaFile: string, instancePath: string): CommandResult {
  const instance = JSON.parse(readFileSync(instancePath, 'utf8')) as unknown;
  const r = validatorFor(schemaFile)(instance);
  return r.ok
    ? { ok: true, output: { valid: true, schema: schemaFile } }
    : { ok: false, output: { valid: false, errors: r.errors } };
}

export function cmdVerifyEvidence(manuscriptPath: string, deltaPath: string): CommandResult {
  const nfc = toNfcText(readFileSync(manuscriptPath, 'utf8'));
  const paragraphs = segmentParagraphs(nfc);
  const delta = JSON.parse(readFileSync(deltaPath, 'utf8')) as {
    items: {
      local_id: string;
      evidence: {
        start: number;
        end: number;
        quote: string;
        quote_hash?: string;
        paragraph_id?: string;
      }[];
    }[];
  };
  const results = delta.items.flatMap((item) =>
    item.evidence.map((ev, i) => {
      const verdict = verifyEvidence(nfc, {
        start: ev.start,
        end: ev.end,
        quote: ev.quote,
        quoteHash: ev.quote_hash,
      });
      const para = paragraphs.find((p) => p.start <= ev.start && ev.start < p.end);
      const paragraphOk = ev.paragraph_id === undefined || para?.id === ev.paragraph_id;
      return { item: item.local_id, evidence: i, verdict, paragraph_ok: paragraphOk };
    }),
  );
  const ok = results.every((r) => r.verdict.ok && r.paragraph_ok);
  return {
    ok,
    output: {
      checked: results.length,
      ok,
      failures: results.filter((r) => !r.verdict.ok || !r.paragraph_ok),
    },
  };
}

export function cmdPolicies(): CommandResult {
  const policies = loadPolicies();
  return {
    ok: true,
    output: [...policies.entries()].map(([ref, p]) => ({
      ref,
      tier: p.quality_tier,
      max_revision_rounds: p.revision.max_rounds,
      gates: Object.fromEntries(
        Object.entries(p.gates.dimensions).map(([k, v]) => [k, v.min_score]),
      ),
      calibration: p.calibration.status,
    })),
  };
}

export function cmdSchemas(): CommandResult {
  const { schemas } = loadSchemas();
  return { ok: true, output: [...schemas.keys()] };
}

export interface AsyncCommandResult extends CommandResult {
  readonly ok: boolean;
}

/** Commands that need Postgres (DATABASE_URL). Kept separate so the pure commands stay synchronous. */
export async function runDb(argv: readonly string[]): Promise<AsyncCommandResult> {
  const [cmd, ...rest] = argv;
  const pool = createPool(configFromEnv());
  try {
    switch (cmd) {
      case 'db:migrate': {
        return { ok: true, output: await migrate(pool) };
      }
      case 'project:create': {
        const [title] = rest;
        if (!title) return { ok: false, output: USAGE };
        const ws = await createWorkspace(pool, 'local');
        const p = await createProject(pool, { workspaceId: ws, title });
        return { ok: true, output: { workspace_id: ws, ...p } };
      }
      case 'entity:create': {
        const [projectId, type, displayName] = rest;
        if (!projectId || !type || !displayName) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        const id = await createEntity(pool, {
          workspaceId: project.workspace_id,
          projectId,
          type,
          displayName,
        });
        return { ok: true, output: { entity_id: id } };
      }
      case 'manuscript:import': {
        const [projectId, chapterNo, file] = rest;
        if (!projectId || !chapterNo || !file) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        const chapterId = await createChapter(pool, {
          workspaceId: project.workspace_id,
          projectId,
          number: Number(chapterNo),
        });
        const v = await createManuscriptVersion(pool, {
          workspaceId: project.workspace_id,
          projectId,
          chapterId,
          origin: 'imported',
          text: readFileSync(file, 'utf8'),
        });
        return {
          ok: true,
          output: {
            chapter_id: chapterId,
            manuscript_version_id: v.id,
            status: v.status,
            length: v.length,
          },
        };
      }
      case 'manuscript:approve': {
        const [versionId] = rest;
        if (!versionId) return { ok: false, output: USAGE };
        await approveManuscriptVersion(pool, versionId, 'cli');
        return { ok: true, output: { manuscript_version_id: versionId, status: 'approved' } };
      }
      case 'canon:accept': {
        const [projectId, chapterId, versionId, deltaFile] = rest;
        if (!projectId || !chapterId || !versionId || !deltaFile)
          return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        const timelines = await pool.query<{
          id: string;
          kind: 'main' | 'prior_loop' | 'alternate' | 'source_story';
        }>('SELECT id, kind FROM timelines WHERE project_id = $1', [projectId]);
        const main = timelines.rows.find((t) => t.kind === 'main');
        if (!main) return { ok: false, output: 'project has no main timeline' };
        try {
          const r = await acceptChapter(pool, {
            projectId,
            chapterId,
            manuscriptVersionId: versionId,
            delta: JSON.parse(readFileSync(deltaFile, 'utf8')) as unknown,
            timelines: new Map(timelines.rows.map((t) => [t.id, t.kind])),
            mainTimelineId: main.id,
            actor: { cli: true },
          });
          return { ok: true, output: { ...r, previous_version: project.canon_version } };
        } catch (err) {
          if (err instanceof DeltaRejectedError)
            return { ok: false, output: { rejected: true, issues: err.issues } };
          throw err;
        }
      }
      case 'canon:state-at': {
        const [projectId, entityId, chapterNo, ordinal] = rest;
        if (!projectId || !entityId || !chapterNo) return { ok: false, output: USAGE };
        const rows = await stateAt(pool, {
          projectId,
          entityId,
          clock: {
            chapter_no: Number(chapterNo),
            ordinal: Number(ordinal ?? '0'),
            precision: 'exact',
          },
        });
        return {
          ok: true,
          output: rows.map((f) => ({
            attribute: f.attribute,
            key: f.key,
            value_text: f.value_text ?? f.value,
            valid_from: f.valid_from,
            valid_to: f.valid_to,
            asserted_at_version: f.asserted_at_version,
          })),
        };
      }
      case 'canon:facts': {
        const [projectId, entityId] = rest;
        if (!projectId || !entityId) return { ok: false, output: USAGE };
        return { ok: true, output: await factsForEntity(pool, projectId, entityId) };
      }
      case 'canon:commits': {
        const [projectId] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        return {
          ok: true,
          output: (await listCommits(pool, projectId)).map((c) => ({
            version: c.version,
            source: c.source,
            item_counts: c.item_counts,
            created_at: c.created_at,
          })),
        };
      }
      case 'canon:rollback': {
        const [projectId] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        return { ok: true, output: await rollbackLatest(pool, projectId, { cli: true }) };
      }
      case 'summary:set': {
        const [projectId, chapterNo, summaryFile, hookFile] = rest;
        if (!projectId || !chapterNo || !summaryFile) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        const lookup = await acceptedChapter(pool, projectId, Number(chapterNo));
        if (lookup.state !== 'accepted') {
          return {
            ok: false,
            output: {
              error: 'CHAPTER_NOT_ACCEPTED',
              detail: `chapter ${chapterNo} has no accepted version (${lookup.state}); summaries are stored only for accepted versions`,
            },
          };
        }
        const row = await withTransaction(pool, async (client) => {
          const r = await upsertL1Summary(client, {
            workspaceId: project.workspace_id,
            projectId,
            manuscriptVersionId: lookup.chapter.version.id,
            chapterNo: Number(chapterNo),
            text: readFileSync(summaryFile, 'utf8').trim(),
            endingHook: hookFile ? readFileSync(hookFile, 'utf8').trim() : undefined,
            canonVersion: lookup.chapter.acceptedCanonVersion,
          });
          const indexed = await indexAcceptedVersion(client, lookup.chapter.version.id);
          return { ...r, indexed_documents: indexed };
        });
        return {
          ok: true,
          output: {
            summary_id: row.id,
            manuscript_version_id: row.manuscript_version_id,
            content_hash: row.content_hash,
            indexed_documents: row.indexed_documents,
          },
        };
      }
      case 'search:index': {
        const [projectId, chapterNo] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        if (chapterNo) {
          const lookup = await acceptedChapter(pool, projectId, Number(chapterNo));
          if (lookup.state !== 'accepted')
            return { ok: false, output: { error: 'CHAPTER_NOT_ACCEPTED', state: lookup.state } };
          const n = await withTransaction(pool, (c) =>
            indexAcceptedVersion(c, lookup.chapter.version.id),
          );
          return {
            ok: true,
            output: { manuscript_version_id: lookup.chapter.version.id, documents: n },
          };
        }
        return { ok: true, output: { documents: await reindexProject(pool, projectId) } };
      }
      case 'pack:build': {
        const [projectId, chapterNo, role, contractFile, specFile, ...flags] = rest;
        if (!projectId || !chapterNo || !role || !contractFile || !specFile)
          return { ok: false, output: USAGE };
        const identityFlag = flags.find((f) => f.startsWith('--identity='));
        return await cmdPackBuild(pool, {
          projectId,
          chapterNo: Number(chapterNo),
          role,
          contractFile,
          specFile,
          identityRef: identityFlag?.slice('--identity='.length),
          full: flags.includes('--full'),
          persist: flags.includes('--persist'),
          lexical: !flags.includes('--no-lexical'),
        });
      }
      case 'chapter:produce': {
        const [projectId, chapterNo, ...flags] = rest;
        return await cmdChapterProduce(pool, {
          projectId,
          chapterNo: chapterNo === undefined ? Number.NaN : Number(chapterNo),
          stage: flags.includes('--stage=contract_and_pack') ? 'contract_and_pack' : 'full',
          failAfterStep: flags
            .find((f) => f.startsWith('--fail-after='))
            ?.slice('--fail-after='.length),
          replayFile: flags.find((f) => f.startsWith('--replay='))?.slice('--replay='.length),
        });
      }
      case 'chapter:status': {
        const [workflowId] = rest;
        if (!workflowId) return { ok: false, output: USAGE };
        try {
          return { ok: true, output: await workflowStatus(pool, workflowId) };
        } catch (err) {
          if (err instanceof WorkflowError)
            return { ok: false, output: { error: err.code, detail: err.detail } };
          throw err;
        }
      }
      // ---- operator diagnostics (Workstream A) ------------------------------------------------
      //
      // These commands call the SAME `@yeonjae/db` operator layer the `/v1/operator/*` routes call, so
      // the CLI cannot answer an operational question differently from the API. Each one runs inside the
      // project's workspace RLS scope, resolved from the project row rather than from an argument, which
      // is the CLI's equivalent of deriving scope from the auth context: an operator cannot widen the
      // read by passing a different workspace id.
      case 'operator:rate-limits': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const requested =
          flags.find((f) => f.startsWith('--class='))?.slice('--class='.length) ?? 'provider_call';
        const operationClass = OPERATION_CLASSES.find((c) => c === requested);
        if (!operationClass)
          return {
            ok: false,
            output: {
              error: 'VALIDATION_FAILED',
              detail: `--class must be one of: ${OPERATION_CLASSES.join(', ')}`,
            },
          };
        const project = await getProject(pool, projectId);
        return {
          ok: true,
          output: await withWorkspace(pool, project.workspace_id, (c) =>
            rateLimitStatus(c, {
              workspaceId: project.workspace_id,
              projectId,
              operationClass,
            }),
          ),
        };
      }
      case 'operator:leases': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        return {
          ok: true,
          output: await withWorkspace(pool, project.workspace_id, (c) =>
            leaseOccupancy(c, {
              projectId,
              limit: flags.find((f) => f.startsWith('--limit='))?.slice('--limit='.length),
            }),
          ),
        };
      }
      case 'operator:budget': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const requested =
          flags.find((f) => f.startsWith('--scope='))?.slice('--scope='.length) ?? 'project';
        const scopeKind = BUDGET_SCOPE_KINDS.find((k) => k === requested);
        if (!scopeKind || (scopeKind !== 'project' && scopeKind !== 'workspace'))
          return {
            ok: false,
            output: {
              error: 'VALIDATION_FAILED',
              detail: '--scope must be one of: project, workspace',
            },
          };
        const project = await getProject(pool, projectId);
        const scopeId = scopeKind === 'project' ? projectId : project.workspace_id;
        return {
          ok: true,
          output: await withWorkspace(pool, project.workspace_id, (c) =>
            budgetReport(c, { scopeKind, scopeId }),
          ),
        };
      }
      case 'operator:embedding-set': {
        const [projectId] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        return {
          ok: true,
          output: await withWorkspace(pool, project.workspace_id, (c) =>
            embeddingSetReport(c, { projectId, hashOf: contentHashOf }),
          ),
        };
      }
      case 'operator:embedding-gc': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const keepFlag = flags.find((f) => f.startsWith('--keep='))?.slice('--keep='.length);
        const project = await getProject(pool, projectId);
        return {
          ok: true,
          output: await withWorkspace(pool, project.workspace_id, (c) =>
            gcEligible(c, { projectId, keep: keepFlag === undefined ? 1 : Number(keepFlag) }),
          ),
        };
      }
      case 'operator:thesaurus': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        return {
          ok: true,
          output: await withWorkspace(pool, project.workspace_id, (c) =>
            thesaurusListing(c, {
              projectId,
              limit: flags.find((f) => f.startsWith('--limit='))?.slice('--limit='.length),
              includeInactive: flags.includes('--include-inactive'),
            }),
          ),
        };
      }
      case 'operator:retrieval': {
        const [projectId, query, ...flags] = rest;
        if (!projectId || !query) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        return {
          ok: true,
          output: await withWorkspace(pool, project.workspace_id, (c) =>
            retrievalDiagnostics(c, {
              projectId,
              query,
              limit: flags.find((f) => f.startsWith('--limit='))?.slice('--limit='.length),
            }),
          ),
        };
      }
      /**
       * Operator MUTATIONS (Workstream B).
       *
       * Same service layer as the `/v1/operator/*` routes, so the CLI cannot make a different decision
       * from the API. `OperatorMutationError` is translated into `{ error, detail }` with `ok: false`,
       * which `main.ts` turns into a non-zero exit code — a stable, documented contract for scripts.
       *
       * Authorization note: the CLI runs with direct database credentials and is therefore an
       * ADMINISTRATIVE surface by construction, the same as `db:migrate` and `canon:rollback` already
       * are. The owner-role check lives on the HTTP boundary, where an untrusted caller exists.
       */
      case 'operator:embedding-activate': {
        const [projectId, setId] = rest;
        if (!projectId || !setId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        try {
          const outcome = await withWorkspace(pool, project.workspace_id, (c) =>
            activateEmbeddingSetForOperator(c, { projectId, setId }),
          );
          return { ok: true, output: outcome.result };
        } catch (err) {
          if (err instanceof OperatorMutationError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'operator:embedding-rollback': {
        const [projectId] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        try {
          const outcome = await withWorkspace(pool, project.workspace_id, (c) =>
            rollbackEmbeddingSetForOperator(c, { projectId }),
          );
          return { ok: true, output: outcome.result };
        } catch (err) {
          if (err instanceof OperatorMutationError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'operator:thesaurus-add': {
        const [projectId, surface, ...flags] = rest;
        if (!projectId || !surface) return { ok: false, output: USAGE };
        const requested =
          flags.find((f) => f.startsWith('--kind='))?.slice('--kind='.length) ?? 'alias';
        const kind = OPERATOR_ALIAS_KINDS.find((k) => k === requested);
        if (!kind)
          return {
            ok: false,
            output: {
              error: 'ALIAS_INVALID',
              detail: `--kind must be one of: ${OPERATOR_ALIAS_KINDS.join(', ')}`,
            },
          };
        const entityId = flags.find((f) => f.startsWith('--entity='))?.slice('--entity='.length);
        const project = await getProject(pool, projectId);
        try {
          const outcome = await withWorkspace(pool, project.workspace_id, (c) =>
            createAliasForOperator(c, {
              workspaceId: project.workspace_id,
              projectId,
              surface,
              kind,
              entityId,
            }),
          );
          return { ok: true, output: outcome.result };
        } catch (err) {
          if (err instanceof OperatorMutationError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'operator:thesaurus-set-active': {
        const [projectId, aliasId, state] = rest;
        if (!projectId || !aliasId || (state !== 'on' && state !== 'off'))
          return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        try {
          const outcome = await withWorkspace(pool, project.workspace_id, (c) =>
            setAliasActiveForOperator(c, { projectId, aliasId, active: state === 'on' }),
          );
          return { ok: true, output: outcome.result };
        } catch (err) {
          if (err instanceof OperatorMutationError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      /**
       * The credential-free product commands.
       *
       * Every one of them calls the SAME service layer the API routes call: `dependencyReport`,
       * `createPreview`, `checkTypography`, `checkPlatformFormat`, `prepareExport` and `runBatch`. A
       * CLI that re-implemented any of those rules would be a second place for them to be wrong.
       */
      case 'ops:dependencies': {
        const report = await dependencyReport({ db: pool, self: 'api' });
        return {
          // A required dependency that is down is a non-zero exit, so a script can gate on it.
          ok: report.ready,
          output: {
            ready: report.ready,
            degraded: report.degraded,
            draining: report.draining,
            totals: report.totals,
            components: report.components,
          },
        };
      }
      case 'preview:create': {
        const [projectId, chapterNo, ...restArgs] = rest;
        if (!projectId || !chapterNo) return { ok: false, output: USAGE };
        const instruction =
          restArgs.find((f) => f.startsWith('--instruction='))?.slice('--instruction='.length) ??
          'tighten the pacing';
        const key =
          restArgs.find((f) => f.startsWith('--key='))?.slice('--key='.length) ??
          `cli:${projectId}:${chapterNo}:${instruction}`;
        const project = await getProject(pool, projectId);
        try {
          const result = await withWorkspace(pool, project.workspace_id, (c) =>
            createPreview(c, {
              workspaceId: project.workspace_id,
              projectId,
              chapterNo: Number(chapterNo),
              instruction,
              requestKey: key,
            }),
          );
          return {
            ok: true,
            output: {
              preview: result.preview,
              duplicate: result.duplicate,
              proposed_text: result.proposed_text,
            },
          };
        } catch (err) {
          if (err instanceof PreviewError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'preview:list': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const limit = Number(
          flags.find((f) => f.startsWith('--limit='))?.slice('--limit='.length) ?? '20',
        );
        const project = await getProject(pool, projectId);
        const listing = await withWorkspace(pool, project.workspace_id, (c) =>
          listPreviews(c, { projectId, limit: Number.isFinite(limit) ? limit : 20 }),
        );
        return { ok: true, output: listing };
      }
      case 'preview:accept':
      case 'preview:discard': {
        const [projectId, previewId] = rest;
        if (!projectId || !previewId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        try {
          if (cmd === 'preview:accept') {
            const result = await acceptPreview(
              pool,
              (fn) => withWorkspace(pool, project.workspace_id, fn),
              { previewId, projectId },
            );
            return { ok: true, output: result };
          }
          const view = await withWorkspace(pool, project.workspace_id, (c) =>
            discardPreview(c, { previewId, projectId }),
          );
          return { ok: true, output: { preview: view } };
        } catch (err) {
          if (err instanceof PreviewError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'preview:cancel': {
        const [projectId, previewId] = rest;
        if (!projectId || !previewId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        try {
          const view = await withWorkspace(pool, project.workspace_id, (c) =>
            cancelPreview(c, { previewId, projectId }),
          );
          return { ok: true, output: { preview: view } };
        } catch (err) {
          if (err instanceof PreviewError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'quality:typography': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const chapterFlag = flags
          .find((f) => f.startsWith('--chapter='))
          ?.slice('--chapter='.length);
        const project = await getProject(pool, projectId);
        const accepted = await exportAccepted(pool, {
          projectId,
          chapters: chapterFlag === undefined ? undefined : [Number(chapterFlag)],
          format: 'text',
          title: project.title,
        });
        const chapters = (
          await Promise.all(
            accepted.chapters.map(async (chapter) => ({
              chapter_no: chapter.chapter_no,
              ...typographySummary(
                checkTypography(await chapterBodyOf(pool, projectId, chapter.chapter_no)),
              ),
            })),
          )
        ).sort((a, b) => a.chapter_no - b.chapter_no);
        const passed = chapters.every((c) => c.passed);
        return {
          ok: passed,
          output: {
            project_id: projectId,
            chapters,
            passed,
            does_not_replace: 'bilingual human review',
          },
        };
      }
      case 'quality:platform-format': {
        const [projectId, platformId, rulesVersion, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        try {
          const profile = resolveProfile(platformId ?? 'generic', rulesVersion ?? '1.0');
          const accepted = await exportAccepted(pool, {
            projectId,
            format: 'text',
            title: project.title,
          });
          const result = checkPlatformFormat(profile, {
            metadata: { title: project.title },
            chapters: await Promise.all(
              accepted.chapters.map(async (c) => ({
                chapter_no: c.chapter_no,
                text: await chapterBodyOf(pool, projectId, c.chapter_no),
              })),
            ),
            manifestFields: [
              'manifest_version',
              'project_id',
              'chapters',
              'content_hash',
              'external_identifier',
            ],
            identifier: flags
              .find((f) => f.startsWith('--identifier='))
              ?.slice('--identifier='.length),
            totalBytes: Buffer.byteLength(accepted.text),
          });
          return { ok: result.passed, output: result };
        } catch (err) {
          if (err instanceof PlatformProfileError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'quality:profiles': {
        return {
          ok: true,
          output: {
            profiles: PLATFORM_PROFILES.map((p) => ({
              platform_id: p.platform_id,
              rules_version: p.rules_version,
              display_name: p.display_name,
            })),
          },
        };
      }
      case 'export:package': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const project = await getProject(pool, projectId);
        const outputDir = flags.find((f) => f.startsWith('--out='))?.slice('--out='.length);
        try {
          const prepared = await prepareExport(pool, {
            projectId,
            title: project.title,
            metadata: { title: project.title },
            platformId:
              flags.find((f) => f.startsWith('--platform='))?.slice('--platform='.length) ??
              'generic',
            rulesVersion:
              flags.find((f) => f.startsWith('--rules='))?.slice('--rules='.length) ?? '1.0',
            identifier: flags
              .find((f) => f.startsWith('--identifier='))
              ?.slice('--identifier='.length),
            outputDir,
          });
          return {
            ok: true,
            output: {
              manifest: prepared.manifest,
              logical_hash: prepared.logical_hash,
              written_to: prepared.written_to,
              total_bytes: prepared.total_bytes,
              files: prepared.files.map((f) => ({ path: f.path, hash: f.hash })),
              // Stated in the output: preparing an export never publishes it.
              published: false,
            },
          };
        } catch (err) {
          if (err instanceof ExportRefusedError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'batch:run': {
        const [projectId, operation, refs, ...flags] = rest;
        if (!projectId || !operation || !refs) return { ok: false, output: USAGE };
        const items = refs
          .split(',')
          .map((r) => r.trim())
          .filter((r) => r !== '')
          .map((ref) => ({ ref, projectId }));
        const key =
          flags.find((f) => f.startsWith('--key='))?.slice('--key='.length) ??
          `cli:batch:${projectId}:${operation}:${refs}`;
        const project = await getProject(pool, projectId);
        try {
          const result = await withWorkspace(pool, project.workspace_id, (c) =>
            runBatch(c, {
              workspaceId: project.workspace_id,
              projectId,
              operation,
              requestKey: key,
              items,
              run: cliItemRunner(pool, operation, project.title),
            }),
          );
          return { ok: result.status === 'completed', output: result };
        } catch (err) {
          if (err instanceof BatchError)
            return { ok: false, output: { error: err.code, detail: err.message } };
          throw err;
        }
      }
      case 'chapter:resume': {
        const [workflowId, ...flags] = rest;
        if (!workflowId) return { ok: false, output: USAGE };
        return await cmdChapterResume(pool, {
          workflowId,
          replayFile: flags.find((f) => f.startsWith('--replay='))?.slice('--replay='.length),
        });
      }
      case 'export:accepted': {
        const [projectId, ...flags] = rest;
        if (!projectId) return { ok: false, output: USAGE };
        const chaptersFlag = flags.find((f) => f.startsWith('--chapters='));
        const formatFlag = flags.find((f) => f.startsWith('--format='));
        const format = formatFlag?.slice('--format='.length);
        if (format !== undefined && format !== 'markdown' && format !== 'text')
          return { ok: false, output: USAGE };
        const chapters = chaptersFlag
          ? chaptersFlag
              .slice('--chapters='.length)
              .split(',')
              .map((s) => Number(s.trim()))
          : undefined;
        if (
          chapters !== undefined &&
          (chapters.length === 0 || chapters.some((n) => !Number.isInteger(n) || n < 1))
        )
          return { ok: false, output: USAGE };
        try {
          const result = await exportAccepted(pool, {
            projectId,
            chapters,
            ...(format === undefined ? {} : { format }),
          });
          const full = flags.includes('--full');
          return {
            ok: true,
            output: full ? result : { ...result, text: undefined, text_bytes: result.text.length },
          };
        } catch (err) {
          if (err instanceof WorkflowError)
            return { ok: false, output: { error: err.code, detail: err.detail } };
          throw err;
        }
      }
      default:
        return { ok: false, output: USAGE };
    }
  } finally {
    await pool.end();
  }
}

export interface PackBuildArgs {
  readonly projectId: string;
  readonly chapterNo: number;
  readonly role: string;
  readonly contractFile: string;
  readonly specFile: string;
  readonly identityRef?: string | undefined;
  readonly full: boolean;
  readonly persist: boolean;
  readonly lexical: boolean;
}

/**
 * Build a Context Pack from a contract + spec file. The default output is the manifest view (hashes, tokens,
 * items, degradation) and never prints manuscript text; `--full` adds the rendered prompt for local review.
 */
export async function cmdPackBuild(pool: Pool, args: PackBuildArgs): Promise<AsyncCommandResult> {
  const contract = JSON.parse(readFileSync(args.contractFile, 'utf8')) as ChapterContract;
  const spec = JSON.parse(readFileSync(args.specFile, 'utf8')) as StorySpec;
  if (contract.chapter_number !== args.chapterNo)
    return {
      ok: false,
      output: {
        error: 'TASK_INVALID',
        detail: `contract is for chapter ${contract.chapter_number}, command asked for ${args.chapterNo}`,
      },
    };
  const project = await getProject(pool, args.projectId);
  const policies = loadPolicyMap();
  const policy = policies.get(project.production_policy_version as PolicyRef);
  if (!policy)
    return {
      ok: false,
      output: { error: 'POLICY_UNKNOWN', detail: project.production_policy_version },
    };
  const store = ProfileStore.fromDirectory();
  const composedRef = args.identityRef ?? `project/${args.projectId}@1`;
  let identity;
  try {
    identity = composeIdentity(store, composedRef, contract.narrative_identity_version_id);
  } catch (err) {
    if (args.identityRef !== undefined)
      return {
        ok: false,
        output: {
          error: 'IDENTITY_UNKNOWN',
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    identity = undefined;
  }
  try {
    const { pack, fetch, stored } = await buildPack(pool, {
      projectId: args.projectId,
      role: args.role,
      contract,
      spec,
      policy,
      identity,
      lexical: args.lexical ? new PgLexicalRetriever(pool) : undefined,
      persist: args.persist,
    });
    const m = pack.manifest;
    return {
      ok: true,
      output: {
        pack_id: m.pack_id,
        pack_hash: m.pack_hash,
        template: m.template,
        template_version: m.template_version,
        role: m.role,
        pinned: m.pinned,
        production_policy_version: m.production_policy_version,
        query_plan_hash: m.query_plan_hash,
        narrative_identity_block: m.narrative_identity_block,
        active_constraint_set: m.active_constraint_set,
        previous_chapter: m.previous_chapter,
        budget_tokens: m.budget_tokens,
        token_counts: m.token_counts,
        sections: m.sections.map((s) => ({
          name: s.name,
          tier: s.tier,
          tokens: s.tokens,
          hash: s.hash,
        })),
        included: m.items
          .filter((i) => i.included)
          .map((i) => ({
            id: i.id,
            tier: i.tier,
            tokens: i.tokens,
            source: `${i.source?.kind ?? '?'}:${i.source?.ref ?? '?'}@${i.source?.version ?? '?'}`,
            provenance: i.provenance,
          })),
        excluded: m.items
          .filter((i) => !i.included)
          .map((i) => ({ id: i.id, tier: i.tier, reason: i.drop_reason })),
        degraded: m.degraded,
        degradation: m.degradation,
        degradation_notes: m.degradation_notes,
        validation: m.validation,
        ladder_steps: pack.ladderSteps,
        constraints_excluded: fetch.constraints.excluded,
        stored,
        ...(args.full
          ? { rendered_system: pack.renderedSystem, rendered_user: pack.renderedUser }
          : {}),
      },
    };
  } catch (err) {
    if (err instanceof ContextError)
      return { ok: false, output: { error: err.code, detail: err.detail, data: err.data } };
    throw err;
  }
}

export function cmdConstraintsCompile(
  chapterNo: number,
  specFile: string,
  cap: string | undefined,
): CommandResult {
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as StorySpec;
  const capTokens = Number(cap ?? '1200');
  try {
    const acs = compileActiveConstraintSet(
      spec,
      { chapterNo, participantIds: [], specVersion: spec.version },
      { capTokens },
    );
    return {
      ok: true,
      output: {
        id: acs.id,
        content_hash: acs.contentHash,
        token_count: acs.tokenCount,
        hard: acs.hard.map((c) => c.id),
        soft: acs.soft.map((c) => c.id),
        assumptions: acs.assumptions.map((c) => c.id),
        excluded: acs.excluded,
        rendered_text: acs.renderedText,
      },
    };
  } catch (err) {
    if (err instanceof ContextError)
      return { ok: false, output: { error: err.code, detail: err.detail, data: err.data } };
    throw err;
  }
}

/**
 * Resolve a project to the fixture replay harness: pins the fixture Narrative Identity on the project,
 * builds a ReplayProvider over the fixture recordings, and wires the artifact-backed audit store.
 * Refuses live providers: the only routing is the replay provider, so an unrecorded prompt fails
 * closed (`ReplayProvider` throws) instead of spending on a live model.
 */
async function replayDeps(
  pool: Pool,
  projectId: string,
  replayFile: string | undefined,
): Promise<{ gateway: Gateway; bindings: Record<string, string> }> {
  const project = await getProject(pool, projectId);
  const settings = project.settings;
  if (
    settings.narrative_identity_ref !== IDENTITY_REF ||
    settings.narrative_identity_version_id !== IDENTITY_VERSION
  ) {
    await pool.query('UPDATE projects SET settings = $2 WHERE id = $1', [
      projectId,
      JSON.stringify({
        ...settings,
        narrative_identity_ref: IDENTITY_REF,
        narrative_identity_version_id: IDENTITY_VERSION,
      }),
    ]);
  }
  const bindings: Record<string, string> = {};
  const provider = ReplayProvider.fromFile(replayFile ?? fileURLToPath(FIXTURE_REPLAY), {
    name: 'replay',
    bindings: () => bindings,
  });
  const gateway = new Gateway({
    providers: new Map([['replay', provider]]),
    routing: REPLAY_ROUTING,
    budget: new MemoryBudget(1_000_000),
    audit: new PgAuditStore(
      pool,
      { workspaceId: project.workspace_id, projectId },
      new ArtifactLlmOutputStore(pool, { workspaceId: project.workspace_id, projectId }),
    ),
    guardContext: { pinnedIdentityVersionId: IDENTITY_VERSION },
    minEnglishConfidence: 0.99,
  });
  return { gateway, bindings };
}

/** Shape-check the caller-facing produce args before touching the database. */
function invalidProduceArgs(args: {
  projectId: string | undefined;
  chapterNo: number;
  failAfterStep: string | undefined;
}): string | undefined {
  if (!args.projectId?.length || !Number.isInteger(args.chapterNo) || args.chapterNo < 1)
    return 'usage: chapter:produce <project> <chapter#> [--replay=<file>] [--stage=contract_and_pack] [--fail-after=<step>]';
  if (args.failAfterStep !== undefined && args.failAfterStep.length < 1)
    return '--fail-after requires a step name';
  return undefined;
}

export interface ChapterProduceArgs {
  readonly projectId: string | undefined;
  readonly chapterNo: number;
  readonly stage: 'full' | 'contract_and_pack';
  readonly failAfterStep: string | undefined;
  readonly replayFile: string | undefined;
}

/**
 * Run (or resume) the production workflow for one chapter. The workflow id is deterministic
 * (`chapter:<project>:<chapter>`), so a repeated invocation replays completed steps from `job_steps`
 * and never re-spends; `chapter:resume` is the same entrypoint made explicit. No live provider is
 * configured: `--replay` selects a recordings file (default: the chapter-1 fixture), and any prompt
 * without a recording fails closed. Returns nonzero exit on workflow failure with the actionable
 * `WorkflowError` code, step and recommended actions.
 */
export async function cmdChapterProduce(
  pool: Pool,
  args: ChapterProduceArgs,
): Promise<AsyncCommandResult> {
  const invalid = invalidProduceArgs(args);
  if (invalid) return { ok: false, output: invalid };
  const projectId = args.projectId;
  if (!projectId) return { ok: false, output: USAGE };
  try {
    await getProject(pool, projectId);
  } catch {
    return {
      ok: false,
      output: { error: 'PROJECT_NOT_FOUND', detail: `project ${projectId} not found` },
    };
  }
  let deps;
  try {
    deps = await replayDeps(pool, projectId, args.replayFile);
  } catch (err) {
    return {
      ok: false,
      output: {
        error: 'REPLAY_UNAVAILABLE',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
  let intake: unknown;
  let bible: ChapterProductionInput['bible'];
  let ids: ChapterProductionInput['ids'];
  try {
    ({ intake, bible, ids } = await loadFixtureInputs(args.replayFile));
  } catch (err) {
    return {
      ok: false,
      output: {
        error: 'REPLAY_UNAVAILABLE',
        detail: err instanceof Error ? err.message : String(err),
      },
    };
  }
  try {
    const result = await produceChapter(
      { pool, gateway: deps.gateway, bindings: deps.bindings },
      {
        projectId,
        chapterNo: args.chapterNo,
        intake,
        bible,
        ids: args.chapterNo === 1 ? ids : { ...ids, contractId: FIXTURE_IDS.contract2 },
        stage: args.stage,
        ...(args.failAfterStep === undefined ? {} : { failAfterStep: args.failAfterStep }),
      },
    );
    return { ok: true, output: summarizeChapterResult(result) };
  } catch (err) {
    if (err instanceof WorkflowError)
      return {
        ok: false,
        output: {
          error: err.code,
          detail: err.detail,
          step: err.options.step,
          recommended_actions: err.options.recommendedActions ?? [],
          data: err.options.data ?? null,
          workflow_id: workflowIdFor(projectId, args.chapterNo),
        },
      };
    throw err;
  }
}

async function loadFixtureInputs(replayFile: string | undefined): Promise<{
  intake: unknown;
  bible: ChapterProductionInput['bible'];
  ids: ChapterProductionInput['ids'];
}> {
  if (replayFile !== undefined)
    throw new WorkflowError(
      'INTERNAL',
      `--replay ${replayFile}: custom replay inputs are not supported in this checkpoint; omit --replay to use the chapter-1 fixture`,
      {
        step: 'init',
      },
    );
  const { readFileSync: read } = await import('node:fs');
  return {
    intake: JSON.parse(read(fileURLToPath(FIXTURE_INTAKE), 'utf8')) as unknown,
    bible: JSON.parse(
      read(fileURLToPath(FIXTURE_BIBLE), 'utf8'),
    ) as ChapterProductionInput['bible'],
    ids: {
      arcId: FIXTURE_IDS.arc1,
      seasonId: FIXTURE_IDS.season1,
      contractId: FIXTURE_IDS.contract1,
    },
  };
}

/** Operator summary of a production run: ids, status and hashes — never manuscript text. */
function summarizeChapterResult(
  result: Awaited<ReturnType<typeof produceChapter>>,
): Record<string, unknown> {
  return {
    workflow_id: result.workflow_id,
    job_id: result.job_id,
    chapter_no: result.chapter_no,
    chapter_id: result.chapter_id,
    status: result.status,
    stage: result.accepted ? 'full' : 'contract_and_pack',
    spec: result.spec,
    bible_canon_version: result.bible_canon_version,
    arc_plan_id: result.arc_plan_id,
    contract: result.contract,
    packs: result.packs,
    scenes: result.scenes.map((s) => ({
      scene_no: s.scene_no,
      artifact_id: s.artifact_id,
      content_hash: s.content_hash,
      words: s.words,
    })),
    versions: result.versions,
    scorecards: result.scorecards,
    revision: result.revision,
    accepted: result.accepted,
    steps: result.steps,
  };
}

export interface ChapterResumeArgs {
  readonly workflowId: string;
  readonly replayFile: string | undefined;
}

/** Resume a started workflow by id: parses `chapter:<project>:<chapter>` and re-runs `produceChapter`. */
export async function cmdChapterResume(
  pool: Pool,
  args: ChapterResumeArgs,
): Promise<AsyncCommandResult> {
  const match = /^chapter:(.+):(\d+)$/.exec(args.workflowId);
  if (!match?.[1]?.length || !match[2]) return { ok: false, output: USAGE };
  const chapterNo = Number(match[2]);
  if (!Number.isInteger(chapterNo) || chapterNo < 1) return { ok: false, output: USAGE };
  if (args.replayFile !== undefined)
    return {
      ok: false,
      output: {
        error: 'REPLAY_UNAVAILABLE',
        detail: `--replay ${args.replayFile}: custom replay inputs are not supported in this checkpoint`,
      },
    };
  const status = await workflowStatus(pool, args.workflowId).catch(() => undefined);
  if (!status)
    return {
      ok: false,
      output: { error: 'WORKFLOW_NOT_FOUND', detail: `no job for workflow ${args.workflowId}` },
    };
  return cmdChapterProduce(pool, {
    projectId: status.job_id ? await projectForJob(pool, status.job_id) : undefined,
    chapterNo,
    stage: 'full',
    failAfterStep: undefined,
    replayFile: undefined,
  });
}

async function projectForJob(pool: Pool, jobId: string): Promise<string | undefined> {
  const r = await pool.query<{ project_id: string }>('SELECT project_id FROM jobs WHERE id = $1', [
    jobId,
  ]);
  return r.rows[0]?.project_id;
}

export const DB_COMMANDS = new Set([
  'db:migrate',
  'project:create',
  'entity:create',
  'manuscript:import',
  'manuscript:approve',
  'canon:accept',
  'canon:state-at',
  'canon:facts',
  'canon:commits',
  'canon:rollback',
  'summary:set',
  'search:index',
  'pack:build',
  'chapter:produce',
  'chapter:status',
  'chapter:resume',
  'export:accepted',
  'operator:rate-limits',
  'operator:leases',
  'operator:budget',
  'operator:embedding-set',
  'operator:embedding-gc',
  'operator:thesaurus',
  'operator:retrieval',
  'operator:embedding-activate',
  'operator:embedding-rollback',
  'operator:thesaurus-add',
  'operator:thesaurus-set-active',
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
]);

/**
 * One chapter's ACCEPTED text.
 *
 * Resolved through `acceptedChapter` rather than by splitting the assembled export document on its
 * heading markers: prose that itself contains `Chapter N` would truncate the body there, and a check
 * over a truncated chapter is a check that passed for the wrong reason.
 */
export async function chapterBodyOf(
  pool: Pool,
  projectId: string,
  chapterNo: number,
): Promise<string> {
  const lookup = await acceptedChapter(pool, projectId, chapterNo);
  return lookup.state === 'accepted' ? lookup.chapter.version.text : '';
}

/**
 * The per-item work the CLI's batch runner performs.
 *
 * Deliberately identical in behaviour to the API's runner, and for the same reason both exist rather
 * than one: both call the same check functions over the same accepted-content service, so neither can
 * reach content the other could not.
 */
export function cliItemRunner(
  pool: Pool,
  operation: string,
  title: string,
): (item: { ref: string; projectId: string; position: number }) => Promise<{
  code: ItemCode;
  detail?: Record<string, unknown> | undefined;
}> {
  return async (item) => {
    const chapterNo = Number(item.ref);
    if (!Number.isInteger(chapterNo) || chapterNo < 1)
      return { code: 'VALIDATION_FAILED', detail: {} };
    const accepted = await exportAccepted(pool, {
      projectId: item.projectId,
      chapters: [chapterNo],
      format: 'text',
      title,
    });
    if (accepted.chapters.length === 0) return { code: 'NOT_FOUND', detail: {} };
    const text = await chapterBodyOf(pool, item.projectId, chapterNo);
    if (operation === 'platform_format_check') {
      const result = checkPlatformFormat(resolveProfile('generic', '1.0'), {
        metadata: { title },
        chapters: [{ chapter_no: chapterNo, text }],
        manifestFields: ['manifest_version', 'project_id', 'chapters', 'content_hash'],
      });
      return {
        code: result.passed ? 'OK' : 'CHECK_FAILED',
        detail: { errors: result.errors, warnings: result.warnings },
      };
    }
    const summary = typographySummary(checkTypography(text));
    return {
      code: summary.passed ? 'OK' : 'CHECK_FAILED',
      detail: { errors: summary.errors, warnings: summary.warnings, codes: summary.codes },
    };
  };
}

export function cmdIdentityCompile(
  composedRef: string,
  role: string,
  budget: string | undefined,
): CommandResult {
  const store = ProfileStore.fromDirectory();
  const identity = composeIdentity(store, composedRef, '00000000-0000-7000-8000-000000000000');
  const block = compileBlock(identity, {
    role: role as RoleVariant,
    budgetTokens: Number(budget ?? '6000'),
  });
  return {
    ok: true,
    output: {
      identity: identity.ref,
      role: block.role,
      hash: block.hash,
      output_language_contract_hash: block.outputLanguageContractHash,
      tradition_contract_hash: block.traditionContractHash,
      sections: block.sections,
      dropped_sections: block.droppedSections,
      est_tokens: block.estTokens,
      conflicts: identity.conflicts,
      text: block.text,
    },
  };
}

export function cmdPromptsList(): CommandResult {
  const reg = PromptRegistry.fromDirectory();
  return {
    ok: true,
    output: {
      prompt_set: reg.activeSet(),
      versions: reg.list().map((v) => ({
        id: v.id,
        role: v.role,
        model_class: v.model_class,
        style_sensitive: v.style_sensitive,
        manuscript_producing: v.manuscript_producing,
        identity_variant: v.identity_variant,
        output_schema: v.output_schema,
        content_hash: v.content_hash,
        status: v.status,
      })),
    },
  };
}

export const USAGE = `yeonjae <command> [args]

  schemas                              list loaded JSON Schemas
  validate <schema-file> <json>        validate a JSON instance against schemas/<schema-file>
  measure <text-file>                  length model (words, code points, paragraphs, sentences, est. tokens)
  language-check <text-file> [terms…]  deterministic English output-language check (allowlist terms optional)
  verify-evidence <manuscript> <delta> verify every evidence span of a canon delta against the NFC manuscript
  policies                             list Production Policy versions and their per-dimension gates
  identity:compile <composed-ref> <role> [budget]
                                       compile the Narrative Identity Block (both contracts first) for a role variant
  prompts:list                         list immutable prompt versions and the active prompt set

Database commands (DATABASE_URL required):
  db:migrate                                   apply forward-only migrations
  project:create <title>                       create a workspace + project + main timeline
  entity:create <project> <type> <name>        add a bible entity
  manuscript:import <project> <chapter#> <file> store an immutable working version (NFC, measured)
  manuscript:approve <version>                 approval-lock a working version (gate outcome)
  canon:accept <project> <chapter> <version> <delta.json>
                                               verify the delta, then commit atomically (sets accepted)
  canon:state-at <project> <entity> <ch> [ord] facts valid at a story clock
  canon:facts <project> <entity>               full bitemporal history for an entity
  canon:commits <project>                      canon commit log
  canon:rollback <project>                     roll back the latest commit (new commit, version +1)
  summary:set <project> <chapter#> <summary.txt> [hook.txt]
                                               store the L1 summary (+ ending hook) of the ACCEPTED version of a chapter
  search:index <project> [chapter#]            (re)index accepted content for lexical retrieval (idempotent)
  pack:build <project> <chapter#> <role> <contract.json> <spec.json> [--identity=<composed-ref>] [--full] [--persist] [--no-lexical]
                                               build a Context Pack: manifest, section hashes, token estimates,
                                               included/excluded items and degradation flags; the composed
                                               identity defaults to project/<project>@1; --full prints the
                                               rendered prompt (manuscript excerpts) — local development only
  chapter:produce <project> <chapter#> [--replay=<file>] [--stage=contract_and_pack] [--fail-after=<step>]
                                               run (or resume) chapter production through the Postgres-checkpointed
                                               workflow; deterministic workflow id, replay only, JSON summary
  chapter:status <workflow-id>                 job status, pins, steps and llm call count for a workflow
  chapter:resume <workflow-id>                 resume a started workflow (same entrypoint as re-running produce)
  export:accepted <project> [--chapters=1,2] [--format=markdown|text] [--full]
                                               export accepted manuscripts only (never working/approved/quarantined)
  operator:rate-limits <project> [--class=provider_call]
                                               limiter counters for one operation class (scope key is digested)
  operator:leases <project> [--limit=20]       live target leases, soonest expiry first, bounded
  operator:budget <project> [--scope=project|workspace]
                                               reservations, commitments and remaining budget for a scope
  operator:embedding-set <project>             the active embedding set and whether it is actually complete
  operator:embedding-gc <project> [--keep=1]   embedding sets eligible for garbage collection (reports only)
  operator:thesaurus <project> [--limit=20] [--include-inactive]
                                               project thesaurus with its ambiguity diagnostic, bounded
  operator:retrieval <project> <query> [--limit=20]
                                               bounded hybrid-retrieval diagnostic (ranking only, never passages)
  operator:embedding-activate <project> <set-id>
                                               activate an embedding set (refuses an empty or incomplete set)
  operator:embedding-rollback <project>        restore the embedding set the active one replaced
  operator:thesaurus-add <project> <surface> [--kind=alias] [--entity=<id>]
                                               add a thesaurus entry; every kind except terminology names an entity
  operator:thesaurus-set-active <project> <alias-id> on|off
                                               reactivate or deactivate an alias (never deleted: a former name is history)
  ops:dependencies                             per-dependency status: up/degraded/unavailable/disabled/starting/draining
  preview:create <project> <chapter#> [--instruction=…] [--key=…]
                                               deterministic regeneration preview; never alters accepted content
  preview:list <project> [--limit=20]          previews for a project, newest first, bounded
  preview:accept <project> <preview-id>        accept a preview into a NEW working version (still faces every gate)
  preview:discard <project> <preview-id>       discard a preview (the row is retained: proposals are history)
  preview:cancel <project> <preview-id>        cancel a preview
  quality:typography <project> [--chapter=N]   deterministic mechanical typography checks (NOT a quality verdict)
  quality:platform-format <project> [platform] [rules-version] [--identifier=…]
                                               OFFLINE platform format validation; never contacts a platform
  quality:profiles                             the bundled versioned platform profiles
  export:package <project> [--out=dir] [--platform=generic] [--rules=1.0] [--identifier=…]
                                               prepare a reproducible LOCAL export package; never uploads or publishes
  batch:run <project> <operation> <refs> [--key=…]
                                               bounded batch (max 50) of typography_check | platform_format_check
  constraints:compile <chapter#> <spec.json> [cap]
                                               compile the Active Constraint Set for a chapter (no database)
`;

export function run(argv: readonly string[]): CommandResult {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'schemas':
      return cmdSchemas();
    case 'validate': {
      const [schema, file] = rest;
      if (!schema || !file) return { ok: false, output: USAGE };
      return cmdValidate(schema, file);
    }
    case 'measure': {
      const [file] = rest;
      if (!file) return { ok: false, output: USAGE };
      return cmdMeasure(file);
    }
    case 'language-check': {
      const [file, ...terms] = rest;
      if (!file) return { ok: false, output: USAGE };
      return cmdLanguageCheck(file, terms);
    }
    case 'verify-evidence': {
      const [manuscript, delta] = rest;
      if (!manuscript || !delta) return { ok: false, output: USAGE };
      return cmdVerifyEvidence(manuscript, delta);
    }
    case 'policies':
      return cmdPolicies();
    case 'identity:compile': {
      const [ref, role, budget] = rest;
      if (!ref || !role) return { ok: false, output: USAGE };
      return cmdIdentityCompile(ref, role, budget);
    }
    case 'prompts:list':
      return cmdPromptsList();
    case 'constraints:compile': {
      const [chapterNo, specFile, cap] = rest;
      if (!chapterNo || !specFile) return { ok: false, output: USAGE };
      return cmdConstraintsCompile(Number(chapterNo), specFile, cap);
    }
    default:
      return { ok: false, output: USAGE };
  }
}
