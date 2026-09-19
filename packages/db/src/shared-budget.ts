/**
 * Shared budget reservations over Postgres (migration 0015).
 *
 * WHY THIS EXISTS. `MemoryBudget` was the only `BudgetLedger` implementation: spend in a `Map`, reset on
 * restart, invisible to every other process. A hard limit that two workers can each spend in full is not a
 * hard limit, and losing the ledger on restart turns "we stopped at the budget" into an unverifiable
 * claim. Enforcement therefore moves to the database, where every instance already looks.
 *
 * Three rules are the substance, and each one exists because the alternative silently lies about money:
 *
 *   1. A RESERVATION EXPIRES. A worker that dies between reserving and settling would otherwise strand
 *      the estimate forever, and the budget would shrink every time a worker crashed. Expiry reclaims it.
 *   2. SETTLEMENT IS IDEMPOTENT. Temporal delivers activities at least once, so settling twice must not
 *      double-charge. The second call returns the first outcome.
 *   3. UNKNOWN COST IS NOT ZERO. When a provider reports no usage — the cancelled-call case ADR-0049
 *      cares about — the reservation's estimate stands and the row is marked `cost_known = false`.
 *      Booking it as zero would make a cancelled call look free, which is the exact false-zero defect
 *      migration 0012 exists to prevent for `llm_calls`.
 *
 * Money is integer millicents throughout (`COST_SCALE = 1000`). No floating point touches a monetary value.
 */
import { COST_SCALE } from './cost-accounting.js';
import { type Client, type Pool } from './client.js';

type Queryable = Pool | Client;

export type BudgetScopeKind = 'workspace' | 'project' | 'job' | 'provider_model';

export interface BudgetPolicyRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly scope_kind: BudgetScopeKind;
  readonly scope_id: string;
  readonly hard_limit_millicents: string | number;
  readonly soft_limit_millicents: string | number | null;
  readonly enabled: boolean;
}

export interface ReservationRow {
  readonly id: string;
  readonly policy_id: string;
  readonly request_id: string;
  readonly estimated_millicents: string | number;
  readonly settled_millicents: string | number | null;
  readonly cost_known: boolean | null;
  readonly state: 'reserved' | 'settled' | 'released' | 'expired';
  readonly expires_at: Date;
}

/** Cents (possibly fractional) to exact integer millicents. */
export function centsToMillicents(cents: number): number {
  return Math.round(cents * COST_SCALE);
}

/** Create or update a budget policy. Operator/migration path, not the request path. */
export async function upsertBudgetPolicy(
  db: Queryable,
  input: {
    workspaceId: string;
    scopeKind: BudgetScopeKind;
    scopeId: string;
    hardLimitMillicents: number;
    softLimitMillicents?: number | undefined;
    enabled?: boolean | undefined;
  },
): Promise<BudgetPolicyRow> {
  const r = await db.query<BudgetPolicyRow>(
    `INSERT INTO budget_policies
       (workspace_id, scope_kind, scope_id, hard_limit_millicents, soft_limit_millicents, enabled)
     VALUES ($1, $2, $3, $4, $5, coalesce($6, true))
     ON CONFLICT (scope_kind, scope_id) DO UPDATE
       SET hard_limit_millicents = excluded.hard_limit_millicents,
           soft_limit_millicents = excluded.soft_limit_millicents,
           enabled = excluded.enabled
     RETURNING *`,
    [
      input.workspaceId,
      input.scopeKind,
      input.scopeId,
      Math.trunc(input.hardLimitMillicents),
      input.softLimitMillicents === undefined ? null : Math.trunc(input.softLimitMillicents),
      input.enabled ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('budget policy upsert returned no row');
  return row;
}

export async function findBudgetPolicy(
  db: Queryable,
  scopeKind: BudgetScopeKind,
  scopeId: string,
): Promise<BudgetPolicyRow | undefined> {
  const r = await db.query<BudgetPolicyRow>(
    'SELECT * FROM budget_policies WHERE scope_kind = $1 AND scope_id = $2',
    [scopeKind, scopeId],
  );
  return r.rows[0];
}

/** Outstanding + settled spend against a policy, in millicents, excluding expired reservations. */
export async function committedMillicents(
  db: Queryable,
  policyId: string,
  now: Date,
): Promise<number> {
  const r = await db.query<{ committed: string }>(
    'SELECT canon.budget_committed_millicents($1, $2)::text AS committed',
    [policyId, now.toISOString()],
  );
  return Number(r.rows[0]?.committed ?? 0);
}

/**
 * Reserve estimated spend, or return `undefined` when the hard limit cannot afford it.
 *
 * Refusal is returned rather than thrown so the caller can record `budget_blocked` and make no provider
 * call, which is the "no spend after hard-budget exhaustion" guarantee. Idempotent by `requestId`.
 */
export async function reserve(
  db: Queryable,
  input: {
    policyId: string;
    requestId: string;
    estimatedMillicents: number;
    ttlSeconds: number;
    now: Date;
  },
): Promise<ReservationRow | undefined> {
  // Same nullable-composite caveat as the rate-limit helpers: a plpgsql function returning NULL yields
  // one all-NULL row, which is how a refused reservation is distinguished from a granted one.
  const r = await db.query<Omit<ReservationRow, 'id'> & { id: string | null }>(
    'SELECT * FROM canon.budget_reserve($1, $2, $3, $4, $5)',
    [
      input.policyId,
      input.requestId,
      Math.trunc(input.estimatedMillicents),
      input.ttlSeconds,
      input.now.toISOString(),
    ],
  );
  const row = r.rows[0];
  if (row?.id == null) return undefined;
  return { ...row, id: row.id };
}

/**
 * Settle a reservation.
 *
 * `costKnown: false` keeps the reservation's estimate as the amount and marks the row unknown. Zero is
 * never substituted for an unknown cost.
 */
export async function settle(
  db: Queryable,
  input: {
    policyId: string;
    requestId: string;
    actualMillicents: number;
    costKnown: boolean;
    now: Date;
  },
): Promise<ReservationRow> {
  const r = await db.query<Omit<ReservationRow, 'id'> & { id: string | null }>(
    'SELECT * FROM canon.budget_settle($1, $2, $3, $4, $5)',
    [
      input.policyId,
      input.requestId,
      Math.trunc(input.actualMillicents),
      input.costKnown,
      input.now.toISOString(),
    ],
  );
  const row = r.rows[0];
  if (row?.id == null) throw new Error('budget_settle returned no row');
  return { ...row, id: row.id };
}

/** Release a reservation that spent nothing. Idempotent; refuses to un-charge a settled row. */
export async function release(
  db: Queryable,
  input: { policyId: string; requestId: string; now: Date },
): Promise<boolean> {
  const r = await db.query<{ budget_release: boolean }>('SELECT canon.budget_release($1, $2, $3)', [
    input.policyId,
    input.requestId,
    input.now.toISOString(),
  ]);
  return r.rows[0]?.budget_release ?? false;
}

export interface BudgetStatus {
  readonly policyId: string;
  readonly scopeKind: BudgetScopeKind;
  readonly scopeId: string;
  readonly hardLimitMillicents: number;
  readonly softLimitMillicents: number | undefined;
  readonly committedMillicents: number;
  readonly remainingMillicents: number;
  readonly outstandingReservations: number;
  /** Settled reservations whose real cost the provider never reported. Never counted as zero. */
  readonly unknownCostSettlements: number;
  readonly softLimitBreached: boolean;
  readonly exhausted: boolean;
}

/** A truthful budget summary for metrics and the operator surface. */
export async function budgetStatus(
  db: Queryable,
  policy: BudgetPolicyRow,
  now: Date,
): Promise<BudgetStatus> {
  const committed = await committedMillicents(db, policy.id, now);
  const counts = await db.query<{ outstanding: string; unknown_cost: string }>(
    `SELECT count(*) FILTER (WHERE state = 'reserved' AND expires_at > $2)::text AS outstanding,
            count(*) FILTER (WHERE state = 'settled' AND cost_known = false)::text AS unknown_cost
       FROM budget_reservations WHERE policy_id = $1`,
    [policy.id, now.toISOString()],
  );
  const hard = Number(policy.hard_limit_millicents);
  const soft =
    policy.soft_limit_millicents === null ? undefined : Number(policy.soft_limit_millicents);
  return {
    policyId: policy.id,
    scopeKind: policy.scope_kind,
    scopeId: policy.scope_id,
    hardLimitMillicents: hard,
    softLimitMillicents: soft,
    committedMillicents: committed,
    remainingMillicents: Math.max(0, hard - committed),
    outstandingReservations: Number(counts.rows[0]?.outstanding ?? 0),
    unknownCostSettlements: Number(counts.rows[0]?.unknown_cost ?? 0),
    softLimitBreached: soft !== undefined && committed > soft,
    exhausted: committed >= hard,
  };
}

/**
 * The gateway's `BudgetLedger` shape, restated here so `packages/db` does not depend on
 * `packages/gateway` (the dependency runs the other way).
 */
export interface SharedBudgetReservation {
  /**
   * Settle the call.
   *
   * `costKnown` defaults to TRUE because the overwhelming majority of calls do report usage, and a
   * caller that knows the cost should not have to say so. The cancelled-call path passes `false`
   * explicitly, which keeps the reservation's estimate instead of booking a false zero (ADR-0049).
   */
  release(actualCents: number, opts?: { costKnown?: boolean | undefined }): Promise<void>;
}

export class BudgetExhaustedError extends Error {
  readonly code = 'BUDGET_EXHAUSTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * A `BudgetLedger` backed by migration 0015, for the gateway to use in place of `MemoryBudget`.
 *
 * The important difference is not the storage but the SCOPE RESOLUTION: a call is checked against every
 * policy that covers it (job, then project, then workspace), most specific first, so a job budget cannot
 * be evaded by spending against the project and a workspace ceiling still applies. A scope with no policy
 * is simply not limited, rather than refused — an unconfigured budget must not brick production.
 */
export class SharedBudget {
  constructor(
    private readonly db: Queryable,
    private readonly opts: {
      /** Injected so tests and replays are deterministic. */
      readonly clock?: (() => Date) | undefined;
      /** How long a reservation stays chargeable before it is reclaimed. */
      readonly reservationTtlSeconds?: number | undefined;
    } = {},
  ) {}

  private now(): Date {
    return (this.opts.clock ?? (() => new Date()))();
  }

  async reserve(
    scope: { projectId: string; jobId?: string | undefined; workspaceId?: string | undefined },
    cents: number,
  ): Promise<SharedBudgetReservation> {
    const now = this.now();
    const ttl = this.opts.reservationTtlSeconds ?? 900;
    const estimate = centsToMillicents(cents);
    // Most specific first: a job ceiling is tighter than the project's, which is tighter than the
    // workspace's. Every applicable policy must admit the spend.
    const candidates: readonly (readonly [BudgetScopeKind, string])[] = [
      ...(scope.jobId !== undefined ? ([['job', scope.jobId]] as const) : []),
      ['project', scope.projectId],
      ...(scope.workspaceId !== undefined ? ([['workspace', scope.workspaceId]] as const) : []),
    ];

    const reserved: { policyId: string; requestId: string }[] = [];
    const requestId = `${scope.jobId ?? scope.projectId}:${String(now.getTime())}:${String(estimate)}`;
    for (const [kind, id] of candidates) {
      const policy = await findBudgetPolicy(this.db, kind, id);
      if (policy?.enabled !== true) continue;
      const row = await reserve(this.db, {
        policyId: policy.id,
        requestId,
        estimatedMillicents: estimate,
        ttlSeconds: ttl,
        now,
      });
      if (!row) {
        // Refused. Unwind the reservations already taken for this call so a partially-admitted call
        // does not strand budget in the looser scopes.
        for (const done of reserved) {
          await release(this.db, { policyId: done.policyId, requestId: done.requestId, now });
        }
        throw new BudgetExhaustedError(`${kind} budget ${id} cannot afford ${String(cents)} cents`);
      }
      reserved.push({ policyId: policy.id, requestId });
    }

    return {
      release: async (actualCents: number, releaseOpts): Promise<void> => {
        const settledAt = this.now();
        const costKnown = releaseOpts?.costKnown ?? true;
        for (const done of reserved) {
          await settle(this.db, {
            policyId: done.policyId,
            requestId: done.requestId,
            actualMillicents: centsToMillicents(actualCents),
            costKnown,
            now: settledAt,
          });
        }
      },
    };
  }
}
