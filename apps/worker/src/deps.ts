/**
 * How the worker builds its model gateway (Checkpoint 7; shared enforcement in Phase 4).
 *
 * There is no default that reaches a paid provider. `YEONJAE_PROVIDER_MODE` must be set explicitly, and
 * the only mode this checkpoint implements is `replay` — the same routing the CLI and every test use, which
 * serves recorded fixture responses and cannot issue a network call. A live mode is a separate, deliberate
 * decision with its own credential handling and budget review; leaving a `live` branch here that merely
 * lacked configuration would be an accident waiting to be triggered by an environment variable.
 *
 * SHARED ENFORCEMENT. The worker's default path uses the database-backed `SharedBudget` and the
 * PostgreSQL shared limiter, never the in-process `MemoryBudget`. That distinction only matters because
 * the worker runs more than once: a `Map` of spend in one process is not a budget when two processes
 * spend against the same project, and the failure mode is over-spend that nobody observes until the
 * invoice. `MemoryBudget` is therefore reachable here ONLY through an explicit isolated-test opt-in
 * (`YEONJAE_ENFORCEMENT_MODE=isolated_test`), and an unset or unrecognized value fails closed rather
 * than silently degrading — a silent fallback to in-memory protection is exactly the bug this guards.
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_GENSPARK_BRIDGE_URL,
  Gateway,
  GensparkProvider,
  MemoryBudget,
  ReplayProvider,
  type RoutingTable,
} from '@yeonjae/gateway';
import { Metrics } from '@yeonjae/domain';
import { ArtifactLlmOutputStore, type ChapterProductionDeps } from '@yeonjae/workflows';
import { PgAuditStore, PgProviderAdmission, SharedBudget, type Pool } from '@yeonjae/db';

export type ProviderMode = 'replay' | 'genspark';

export function providerModeFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderMode {
  const mode = env.YEONJAE_PROVIDER_MODE;
  if (mode === 'replay') return 'replay';
  if (mode === 'genspark') return 'genspark';
  throw new Error(
    "YEONJAE_PROVIDER_MODE must be set to 'replay' or 'genspark'; the worker refuses to start without an explicit " +
      'provider mode so a misconfigured deployment cannot issue paid calls',
  );
}

/**
 * Which protection the worker runs with.
 *
 * `shared` is the default and the only mode that protects a multi-process deployment. `isolated_test`
 * exists so a single-process test can run without a budget-policy row, and it is deliberately verbose:
 * an operator reading a process's environment can see that its protection is not shared.
 */
export type EnforcementMode = 'shared' | 'isolated_test';

export function enforcementModeFromEnv(env: NodeJS.ProcessEnv = process.env): EnforcementMode {
  const mode = env.YEONJAE_ENFORCEMENT_MODE ?? 'shared';
  if (mode === 'shared') return 'shared';
  if (mode === 'isolated_test') return 'isolated_test';
  throw new Error(
    `YEONJAE_ENFORCEMENT_MODE must be 'shared' or 'isolated_test'; got '${mode}'. The worker refuses ` +
      'to start on an unrecognized value rather than fall back to in-process protection',
  );
}

/**
 * Assert that shared enforcement is actually USABLE before the worker accepts work.
 *
 * Reading the two 0015 functions is the cheapest honest check: if the migration that defines shared
 * admission and the shared ledger is not present, a worker started in `shared` mode would run with no
 * effective limiter at all while reporting that it was protected. Failing here names the real problem.
 */
export async function assertSharedEnforcementAvailable(pool: Pool): Promise<void> {
  const r = await pool.query<{ missing: string }>(
    `SELECT f.name AS missing
       FROM (VALUES ('resolve_rate_limit_policy'), ('rate_limit_admit'), ('rate_limit_acquire_slot'),
                    ('rate_limit_release_slot'), ('budget_reserve'), ('budget_settle')) AS f(name)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'canon' AND p.proname = f.name)`,
  );
  if (r.rows.length > 0) {
    throw new Error(
      'shared enforcement is required but unavailable: migration 0015 functions missing (' +
        r.rows.map((x) => x.missing).join(', ') +
        '). Apply migrations before starting the worker',
    );
  }
}

/**
 * Routing for the replay provider: every model class resolves to the recorded fixture responses.
 *
 * The class letters are the gateway's own (`R` requirements, `P` prose, `M` evaluation, `C` checking,
 * `E` embedding). `E` is empty because no embedder exists yet (ADR-0035), and an empty route list makes
 * the gateway refuse an embedding call rather than silently serving a replayed one.
 */
export function replayRouting(): RoutingTable {
  const route = (modelId: string, family: string) => [
    {
      modelId,
      provider: 'replay',
      priority: 1,
      family,
      priceInPerMTokCents: 100,
      priceOutPerMTokCents: 400,
      maxContextTokens: 200_000,
      supportsJsonSchema: true,
    },
  ];
  return {
    R: route('replay-r', 'alpha'),
    P: route('replay-p', 'alpha'),
    M: route('replay-m', 'beta'),
    C: route('replay-c', 'beta'),
    E: [],
  };
}

export function gensparkRouting(): RoutingTable {
  const route = (modelId: string, family: string) => [
    {
      modelId,
      provider: 'genspark',
      priority: 1,
      family,
      priceInPerMTokCents: 0,
      priceOutPerMTokCents: 0,
      maxContextTokens: 128_000,
      supportsJsonSchema: true,
    },
  ];
  return {
    R: route('gemini-3.8-flash', 'google'),
    P: route('gemini-3.8-flash', 'google'),
    M: route('gemini-3.8-flash', 'google'),
    C: route('gemini-3.8-flash', 'google'),
    E: [],
  };
}

/**
 * Build the production dependency factory.
 *
 * The replay recording is read from `YEONJAE_REPLAY_FILE` when in replay mode. It is a required input in
 * this mode: a replay provider with no recording would fail every call, and failing at startup names
 * the real problem. In genspark mode, calls are dispatched to the local Genspark bridge service.
 *
 * Every gateway this factory builds carries shared enforcement unless the process was explicitly started
 * in `isolated_test` mode. `holder` identifies this process on the concurrency leases it takes, which is
 * what lets a dead worker's slots be attributed and reclaimed by deadline rather than stranded.
 */
export function productionDeps(
  pool: Pool,
  opts: {
    readonly enforcement?: EnforcementMode | undefined;
    /**
     * The process-wide registry. One instance per PROCESS, shared by every gateway this factory
     * builds: a registry per project would reset its counters whenever a project's deps were rebuilt,
     * which is the opposite of what a scraped counter is for.
     */
    readonly metrics?: Metrics | undefined;
  } = {},
): (input: { workspaceId: string; projectId: string }) => ChapterProductionDeps {
  const mode = providerModeFromEnv();
  const enforcement = opts.enforcement ?? enforcementModeFromEnv();
  const replayFile = process.env.YEONJAE_REPLAY_FILE;
  if (mode === 'replay' && !replayFile)
    throw new Error('YEONJAE_REPLAY_FILE must name a recording when YEONJAE_PROVIDER_MODE=replay');
  const recording =
    mode === 'replay' && replayFile
      ? (JSON.parse(readFileSync(replayFile, 'utf8')) as Record<string, unknown>)
      : {};
  const budgetCents = Number(process.env.YEONJAE_BUDGET_CENTS ?? '100000');
  const holder = `worker:${process.env.YEONJAE_WORKER_ID ?? String(process.pid)}`;
  const maxWaitMs = Number(process.env.YEONJAE_RATE_MAX_WAIT_MS ?? '0');
  const metrics = opts.metrics ?? new Metrics();

  return ({ workspaceId, projectId }) => {
    const provider =
      mode === 'genspark'
        ? new GensparkProvider({
            baseUrl: process.env.YEONJAE_GENSPARK_URL ?? DEFAULT_GENSPARK_BRIDGE_URL,
          })
        : new ReplayProvider(recording as never);
    const providerName = mode === 'genspark' ? 'genspark' : 'replay';
    const routing = mode === 'genspark' ? gensparkRouting() : replayRouting();
    const audit = new PgAuditStore(
      pool,
      { workspaceId, projectId },
      new ArtifactLlmOutputStore(pool, { workspaceId, projectId }),
    );
    if (enforcement === 'isolated_test') {
      return {
        pool,
        gateway: new Gateway({
          providers: new Map([[providerName, provider]]),
          routing,
          budget: new MemoryBudget(budgetCents),
          metrics,
          audit,
        }),
      };
    }
    return {
      pool,
      gateway: new Gateway({
        providers: new Map([[providerName, provider]]),
        routing,
        // The shared ledger, so two workers spending against one project see one another's spend.
        budget: new SharedBudget(pool),
        admission: new PgProviderAdmission(pool, { holder, maxWaitMs, metrics }),
        metrics,
        audit,
      }),
    };
  };
}
