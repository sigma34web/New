/**
 * Operator diagnostics and controls (Workstream A).
 *
 * This module is the SHARED application layer behind both the `/v1/operator/*` HTTP routes and the
 * `operator:*` CLI commands, so the two surfaces cannot drift into two different answers to the same
 * question. It holds no invariants of its own: rate limiting, leases, budgets, embedding sets, the
 * thesaurus and hybrid retrieval are all already implemented and tested in `@yeonjae/db`, and everything
 * here does is bound the inputs, project the results onto a REDACTED shape and let the caller's already
 * authorized RLS scope decide what is visible.
 *
 * Three rules govern every function below, and they are the reason the module exists rather than each
 * route calling `@yeonjae/db` directly:
 *
 *  * SCOPE COMES FROM THE CALLER, NEVER FROM THE PAYLOAD. Each function takes a `Client` that is already
 *    inside the authenticated workspace's RLS scope. No function accepts a workspace id argument, so a
 *    body or query field simply has no way to widen what is read — a cross-tenant id is invisible rather
 *    than merely rejected.
 *  * EVERY LIST IS BOUNDED. There is no "return everything" path; `boundedLimit` clamps each caller-
 *    supplied limit, and truncated results say so with `truncated: true` rather than silently ending.
 *  * NOTHING SENSITIVE CROSSES THE BOUNDARY. No prompt text, provider response, credential, secret value,
 *    connection string or raw SQL appears in a return value. Credential rotation is reported as state and
 *    digests only; `packages/domain`'s rotation store never exposes the (synthetic) secret itself.
 */
import {
  activeEmbeddingSet,
  embeddingSetCompleteness,
  gcEligibleEmbeddingSets,
  activateEmbeddingSet,
  getEmbeddingSet,
  rollbackEmbeddingSet,
  type EmbeddingPurpose,
  type EmbeddingSetRow,
} from './embeddings.js';
import {
  addAlias,
  aliasesForProject,
  deactivateAlias,
  expandQuery,
  normalizeSurface,
  type AliasKind,
  type NameAliasRow,
} from './thesaurus.js';
import { hybridSearch, type RetrievalMode } from './hybrid-retrieval.js';
import { budgetStatus, findBudgetPolicy, type BudgetScopeKind } from './shared-budget.js';
import {
  rateLimitCounters,
  resolveRateLimitPolicy,
  scopeKeyFor,
  type OperationClass,
} from './rate-limits.js';
import type { Client } from './client.js';
import { createHash } from 'node:crypto';

/** The largest page any operator list will return, whatever the caller asks for. */
export const MAX_OPERATOR_LIMIT = 100;
export const DEFAULT_OPERATOR_LIMIT = 20;

/**
 * Closed allowlists for the operator query enums.
 *
 * They are restated here rather than derived from a union type because a runtime allowlist is what
 * actually rejects a malformed query; a TypeScript union disappears at runtime and would let an
 * arbitrary string reach the policy resolver.
 */
export const OPERATION_CLASSES = [
  'provider_call',
  'embedding_call',
  'job_start',
  'api_read',
  'api_mutation',
] as const satisfies readonly OperationClass[];

export const BUDGET_SCOPE_KINDS = [
  'workspace',
  'project',
  'job',
  'provider_model',
] as const satisfies readonly BudgetScopeKind[];

/**
 * Read a query-string field as a string, or `undefined`.
 *
 * A query string can legitimately parse to an array or an object (`?project_id[]=a&project_id[]=b`), and
 * coercing one of those with `String()` yields `[object Object]`, which would then be validated as a
 * malformed UUID rather than recognised as the wrong SHAPE. Returning `undefined` for a non-string keeps
 * the caller's own required/optional logic in charge.
 */
export function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// operator mutations (Workstream B)
//
// The read side above answers questions; these change what the system does next. Three rules apply to
// every one of them, and they are the reason the mutations live here rather than in each surface:
//
//  * THEY ARE SCOPED BY THE CALLER'S CLIENT, exactly like the reads. No mutation takes a workspace id,
//    so a body field cannot widen what is written; a target outside the caller's RLS scope is simply
//    invisible and comes back as "not found" rather than as a refusal that confirms it exists.
//  * THEY FAIL WITH A STABLE CODE. `OperatorMutationError` carries a closed set of codes so the API can
//    map them to problem documents and the CLI to exit codes without either one parsing prose.
//  * THEY RETURN A BOUNDED, REDACTED RESULT plus a safe audit payload. The caller writes the audit row
//    (it owns the actor and request id); this layer decides what is SAFE to record, which is how a
//    surface cannot accidentally log a credential or a passage.
// ---------------------------------------------------------------------------------------------------------

export type OperatorMutationCode =
  | 'NOT_FOUND'
  | 'EMBEDDING_SET_EMPTY'
  | 'EMBEDDING_SET_INCOMPLETE'
  | 'EMBEDDING_SET_RETIRED'
  | 'NO_ROLLBACK_TARGET'
  | 'ALIAS_INVALID'
  | 'CONFLICT';

export class OperatorMutationError extends Error {
  constructor(
    readonly code: OperatorMutationCode,
    message: string,
  ) {
    super(message);
    this.name = 'OperatorMutationError';
  }
}

/**
 * Translate a database-raised code into the operator vocabulary.
 *
 * The embedding-set guards live in migration 0016 as `canon.raise_code(...)`, which is the right place
 * for them — they must hold against ANY writer, not only this layer. This maps the raised code onto the
 * operator's closed set so the boundary never re-implements the rule, and an unrecognised failure is
 * rethrown untouched rather than being flattened into a misleading operator code.
 */
function asMutationError(err: unknown): never {
  const text = err instanceof Error ? err.message : String(err);
  for (const code of [
    'EMBEDDING_SET_INCOMPLETE',
    'EMBEDDING_SET_EMPTY',
    'EMBEDDING_SET_RETIRED',
  ] as const) {
    if (text.includes(code))
      throw new OperatorMutationError(
        code,
        code === 'EMBEDDING_SET_EMPTY'
          ? 'The set has no vectors; activating it would make retrieval silently return nothing.'
          : code === 'EMBEDDING_SET_INCOMPLETE'
            ? 'The set has failed items; activating it would make retrieval quietly wrong.'
            : 'A retired set cannot be activated directly; roll back to it instead.',
      );
  }
  throw err;
}

/** The safe, bounded record of a mutation. Never carries text, secrets or another tenant's ids. */
export interface MutationOutcome<T> {
  readonly result: T;
  readonly audit: Readonly<Record<string, string | number | boolean>>;
}

export interface EmbeddingSetSummary {
  readonly set_id: string;
  readonly purpose: string;
  readonly status: string;
  readonly item_count: number;
  readonly activated_at: string | null;
}

function summarize(set: EmbeddingSetRow): EmbeddingSetSummary {
  return {
    set_id: set.id,
    purpose: set.purpose,
    status: set.status,
    item_count: set.item_count,
    activated_at: set.activated_at ? new Date(set.activated_at).toISOString() : null,
  };
}

/**
 * Activate an embedding set.
 *
 * Idempotent by construction: migration 0016 returns the set unchanged when it is already active, so a
 * retried operator action or a redelivered request cannot flap the active pointer. Completeness is NOT
 * re-checked here — the database refuses an empty or failed set itself, and duplicating that rule in
 * the boundary would create a second place for it to drift.
 */
export async function activateEmbeddingSetForOperator(
  c: Client,
  input: { projectId: string; setId: string },
): Promise<MutationOutcome<EmbeddingSetSummary>> {
  // Resolved inside the caller's RLS scope first: a set in another workspace is invisible, so this is a
  // NOT_FOUND rather than a refusal that would confirm the id exists.
  const existing = await getEmbeddingSet(c, input.setId);
  if (existing?.project_id !== input.projectId)
    throw new OperatorMutationError('NOT_FOUND', 'The embedding set does not exist.');
  const wasActive = existing.status === 'active';
  let set: EmbeddingSetRow;
  try {
    set = await activateEmbeddingSet(c, input.setId);
  } catch (err) {
    asMutationError(err);
  }
  return {
    result: summarize(set),
    audit: {
      set_id: set.id,
      purpose: set.purpose,
      item_count: set.item_count,
      // Distinguishes a real promotion from an idempotent repeat in the audit trail.
      already_active: wasActive,
    },
  };
}

/** Roll back to the set the active one replaced. Refuses when there is nothing to roll back to. */
export async function rollbackEmbeddingSetForOperator(
  c: Client,
  input: { projectId: string; purpose?: EmbeddingPurpose | undefined },
): Promise<MutationOutcome<EmbeddingSetSummary>> {
  const purpose = input.purpose ?? 'retrieval';
  const active = await activeEmbeddingSet(c, input.projectId, purpose);
  if (!active)
    throw new OperatorMutationError(
      'NO_ROLLBACK_TARGET',
      'There is no active embedding set for this purpose to roll back from.',
    );
  if (!active.replaced_set_id)
    throw new OperatorMutationError(
      'NO_ROLLBACK_TARGET',
      'The active embedding set replaced nothing, so there is no previous set to restore.',
    );
  let set: EmbeddingSetRow;
  try {
    set = await rollbackEmbeddingSet(c, input.projectId, purpose);
  } catch (err) {
    asMutationError(err);
  }
  return {
    result: summarize(set),
    audit: { set_id: set.id, purpose, restored_from: active.id },
  };
}

/**
 * Alias kinds an operator may create.
 *
 * A closed list, and deliberately narrower than `AliasKind`: `canonical` is the entity's own name and is
 * owned by the naming policy rather than by an operator edit, so exposing it here would let the operator
 * surface rename a character through the thesaurus.
 */
export const OPERATOR_ALIAS_KINDS = [
  'alias',
  'former_name',
  'title',
  'honorific',
  'romanization',
  'spacing_variant',
  'disguise',
  'organization',
  'location',
  'terminology',
] as const satisfies readonly AliasKind[];

export interface AliasSummary {
  readonly alias_id: string;
  readonly surface: string;
  readonly normalized: string;
  readonly kind: string;
  readonly entity_id: string | null;
  readonly active: boolean;
  readonly ambiguous: boolean;
}

function summarizeAlias(row: NameAliasRow): AliasSummary {
  return {
    alias_id: row.id,
    surface: row.surface,
    normalized: row.normalized,
    kind: row.kind,
    entity_id: row.entity_id,
    active: row.active,
    ambiguous: row.ambiguous,
  };
}

/** A bounded surface: an unbounded one would be an unbounded index term and a payload hazard. */
const MAX_SURFACE_CHARS = 200;

/**
 * Create (or update) a thesaurus alias.
 *
 * Upsert rather than insert, because `addAlias` is keyed on (project, kind, normalized, entity): a
 * repeated operator action must converge on one row rather than failing or duplicating. The AMBIGUITY
 * flag is computed rather than accepted from the caller — whether a surface resolves to more than one
 * entity is a fact about the project's data, not an operator opinion.
 */
export async function createAliasForOperator(
  c: Client,
  input: {
    workspaceId: string;
    projectId: string;
    surface: string;
    kind: AliasKind;
    entityId?: string | undefined;
    fromChapter?: number | undefined;
  },
): Promise<MutationOutcome<AliasSummary>> {
  const surface = input.surface.trim();
  if (surface.length === 0 || surface.length > MAX_SURFACE_CHARS)
    throw new OperatorMutationError(
      'ALIAS_INVALID',
      `A surface must be between 1 and ${String(MAX_SURFACE_CHARS)} characters.`,
    );
  const normalized = normalizeSurface(surface);
  /**
   * Migration 0017's check constraint: every kind except `terminology` names an entity, and
   * `terminology` names none. Enforced here as well so the boundary answers with a stable code instead
   * of letting a constraint violation surface as an internal error — the constraint stays in the
   * database, where it holds against any writer; this only translates it.
   */
  if (input.kind === 'terminology' && input.entityId !== undefined)
    throw new OperatorMutationError(
      'ALIAS_INVALID',
      'A terminology entry names no entity; omit entity_id.',
    );
  if (input.kind !== 'terminology' && input.entityId === undefined)
    throw new OperatorMutationError(
      'ALIAS_INVALID',
      `A "${input.kind}" alias must name the entity it refers to; supply entity_id.`,
    );
  // Does this surface already point at a DIFFERENT entity? If so both rows are ambiguous, and saying so
  // is the whole value of the thesaurus diagnostic.
  const siblings = await aliasesForProject(c, input.projectId);
  const others = siblings.filter(
    (a) => a.normalized === normalized && a.active && a.entity_id && a.entity_id !== input.entityId,
  );
  const ambiguous = others.length > 0 && input.entityId !== undefined;

  const row = await addAlias(c, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    entityId: input.entityId,
    kind: input.kind,
    surface,
    provenance: 'operator',
    ambiguous,
    fromChapter: input.fromChapter,
  });
  if (ambiguous) {
    // The existing rows become ambiguous too: ambiguity is a property of the SURFACE, and marking only
    // the newcomer would leave the older row claiming to be unambiguous.
    await c.query(
      'UPDATE name_aliases SET ambiguous = true WHERE project_id = $1 AND normalized = $2',
      [input.projectId, normalized],
    );
  }
  return {
    result: { ...summarizeAlias(row), ambiguous },
    audit: {
      alias_id: row.id,
      kind: row.kind,
      ambiguous,
      // The surface itself is a project term, not a secret, and is what makes the audit row useful.
      surface: surface.slice(0, MAX_SURFACE_CHARS),
    },
  };
}

/**
 * Deactivate or reactivate an alias.
 *
 * Never deletes: a former name is history and may need to be explained later, which is the same reason
 * `deactivateAlias` exists rather than a DELETE.
 */
export async function setAliasActiveForOperator(
  c: Client,
  input: { projectId: string; aliasId: string; active: boolean },
): Promise<MutationOutcome<AliasSummary>> {
  const found = await c.query<NameAliasRow>(
    'SELECT * FROM name_aliases WHERE id = $1 AND project_id = $2',
    [input.aliasId, input.projectId],
  );
  const row = found.rows[0];
  if (!row) throw new OperatorMutationError('NOT_FOUND', 'The alias does not exist.');
  if (row.active === input.active) {
    // Idempotent: repeating the request is a no-op rather than an error, so a duplicate delivery is a
    // non-event.
    return {
      result: summarizeAlias(row),
      audit: { alias_id: row.id, active: row.active, unchanged: true },
    };
  }
  if (input.active) {
    await c.query('UPDATE name_aliases SET active = true WHERE id = $1', [input.aliasId]);
  } else {
    await deactivateAlias(c, input.aliasId);
  }
  const after = await c.query<NameAliasRow>('SELECT * FROM name_aliases WHERE id = $1', [
    input.aliasId,
  ]);
  const updated = after.rows[0];
  if (!updated) throw new OperatorMutationError('NOT_FOUND', 'The alias does not exist.');
  return {
    result: summarizeAlias(updated),
    audit: { alias_id: updated.id, active: updated.active, unchanged: false },
  };
}

/** Clamp a caller-supplied limit into the bounded range. Unparseable input falls back to the default. */
export function boundedLimit(value: unknown, fallback = DEFAULT_OPERATOR_LIMIT): number {
  if (value === undefined || value === null || value === '') return fallback;
  // Only a number or a numeric string is meaningful here. Anything else (an object, an array — both of
  // which a query string can produce) is malformed input, not a limit, and falls back rather than being
  // stringified into a `NaN` that would silently become the default anyway.
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_OPERATOR_LIMIT);
}

/**
 * A bounded projection of a list.
 *
 * `truncated` is reported rather than inferred, because "exactly `limit` items" and "more than `limit`
 * items" are different operational facts and an operator acting on a capacity report needs to know which
 * one they are looking at.
 */
export interface BoundedList<T> {
  readonly items: readonly T[];
  readonly limit: number;
  readonly returned: number;
  readonly truncated: boolean;
}

export function bounded<T>(rows: readonly T[], limit: number): BoundedList<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    limit,
    returned: items.length,
    truncated: rows.length > limit,
  };
}

// ---------------------------------------------------------------------------------------------------------
// rate limits
// ---------------------------------------------------------------------------------------------------------

export interface RateLimitStatus {
  readonly operation_class: OperationClass;
  readonly policy_id: string | null;
  readonly scope_key_digest: string | null;
  readonly window_seconds: number | null;
  readonly max_requests: number | null;
  readonly max_concurrent: number | null;
  readonly requests: number;
  readonly tokens: number;
  readonly rejected: number;
  readonly live_slots: number;
  readonly saturated: boolean;
}

/**
 * Current limiter counters for one operation class in the caller's scope.
 *
 * The scope KEY is reported as a digest rather than verbatim. The key is composed from workspace/project
 * identifiers, and echoing it back would hand a caller a durable cross-tenant correlator for free; a
 * digest still lets an operator tell two scopes apart without carrying the identifiers out of the system.
 */
export async function rateLimitStatus(
  c: Client,
  input: {
    workspaceId: string;
    projectId?: string | undefined;
    operationClass: OperationClass;
    now?: Date | undefined;
  },
): Promise<RateLimitStatus> {
  const now = input.now ?? new Date();
  const policy = await resolveRateLimitPolicy(c, {
    workspaceId: input.workspaceId,
    operationClass: input.operationClass,
  });
  if (!policy) {
    return {
      operation_class: input.operationClass,
      policy_id: null,
      scope_key_digest: null,
      window_seconds: null,
      max_requests: null,
      max_concurrent: null,
      requests: 0,
      tokens: 0,
      rejected: 0,
      live_slots: 0,
      saturated: false,
    };
  }
  const scopeKey = scopeKeyFor(policy, {
    workspaceId: input.workspaceId,
    operationClass: input.operationClass,
  });
  const counters = await rateLimitCounters(c, policy, { scopeKey, now });
  const maxRequests = policy.max_requests;
  const maxConcurrent = policy.max_concurrent;
  return {
    operation_class: input.operationClass,
    policy_id: policy.id,
    scope_key_digest: digest(scopeKey),
    window_seconds: policy.window_seconds,
    max_requests: maxRequests,
    max_concurrent: maxConcurrent,
    requests: counters.requests,
    tokens: counters.tokens,
    rejected: counters.rejected,
    live_slots: counters.liveSlots,
    saturated:
      (maxRequests !== null && counters.requests >= maxRequests) ||
      (maxConcurrent !== null && counters.liveSlots >= maxConcurrent),
  };
}

/** A short, stable, non-reversible label for a scope key. */
export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------------------------------------
// concurrency leases
// ---------------------------------------------------------------------------------------------------------

export interface LeaseOccupancy {
  readonly target_kind: string;
  readonly target_id: string;
  readonly fence_token: number;
  readonly expires_at: string;
  readonly seconds_remaining: number;
  readonly expiring_soon: boolean;
  /** The holder is reported as a digest: a worker/run identifier is internal provenance, not operator data. */
  readonly holder_digest: string;
}

/**
 * Live target leases in the caller's scope, soonest expiry first.
 *
 * Only LIVE leases are reported: an expired row is not occupancy, and including it would make a healthy
 * system look saturated. `expiring_soon` marks the leases an operator can expect to turn over shortly.
 */
export async function leaseOccupancy(
  c: Client,
  input: {
    projectId?: string | undefined;
    limit?: unknown;
    expiringWithinSeconds?: number | undefined;
    now?: Date | undefined;
  } = {},
): Promise<BoundedList<LeaseOccupancy>> {
  const now = input.now ?? new Date();
  const limit = boundedLimit(input.limit);
  const soon = Math.max(1, Math.min(input.expiringWithinSeconds ?? 30, 3600));
  // limit + 1 so `truncated` reflects reality rather than a guess.
  const r = await c.query<{
    target_kind: string;
    target_id: string;
    fence: string;
    expires_at: Date;
    holder_workflow_id: string | null;
  }>(
    `SELECT target_kind, target_id, fence, expires_at, holder_workflow_id
       FROM target_leases
      WHERE released_at IS NULL
        AND expires_at > $1
        AND ($2::uuid IS NULL OR project_id = $2::uuid)
      ORDER BY expires_at ASC, target_id ASC
      LIMIT $3`,
    [now.toISOString(), input.projectId ?? null, limit + 1],
  );
  const rows = r.rows.map((row) => {
    const remaining = Math.max(0, Math.round((row.expires_at.getTime() - now.getTime()) / 1000));
    return {
      target_kind: row.target_kind,
      target_id: row.target_id,
      fence_token: Number(row.fence),
      expires_at: row.expires_at.toISOString(),
      seconds_remaining: remaining,
      expiring_soon: remaining <= soon,
      holder_digest: digest(row.holder_workflow_id ?? ''),
    };
  });
  return bounded(rows, limit);
}

// ---------------------------------------------------------------------------------------------------------
// shared budget
// ---------------------------------------------------------------------------------------------------------

export interface BudgetReport {
  readonly scope_kind: BudgetScopeKind;
  readonly scope_id: string;
  readonly policy_id: string | null;
  readonly hard_limit_millicents: number | null;
  readonly soft_limit_millicents: number | null;
  readonly committed_millicents: number;
  readonly remaining_millicents: number | null;
  readonly outstanding_reservations: number;
  readonly unknown_cost_settlements: number;
  readonly soft_limit_breached: boolean;
  readonly exhausted: boolean;
}

/**
 * Reservation/commitment state for one budget scope.
 *
 * A scope with no policy is reported as "no policy" rather than as an unlimited budget: those are very
 * different operational facts, and rendering the first as the second is how an unbudgeted scope gets
 * mistaken for a healthy one.
 */
export async function budgetReport(
  c: Client,
  input: { scopeKind: BudgetScopeKind; scopeId: string; now?: Date | undefined },
): Promise<BudgetReport> {
  const policy = await findBudgetPolicy(c, input.scopeKind, input.scopeId);
  if (!policy) {
    return {
      scope_kind: input.scopeKind,
      scope_id: input.scopeId,
      policy_id: null,
      hard_limit_millicents: null,
      soft_limit_millicents: null,
      committed_millicents: 0,
      remaining_millicents: null,
      outstanding_reservations: 0,
      unknown_cost_settlements: 0,
      soft_limit_breached: false,
      exhausted: false,
    };
  }
  const status = await budgetStatus(c, policy, input.now ?? new Date());
  return {
    scope_kind: status.scopeKind,
    scope_id: status.scopeId,
    policy_id: status.policyId,
    hard_limit_millicents: status.hardLimitMillicents,
    soft_limit_millicents: status.softLimitMillicents ?? null,
    committed_millicents: status.committedMillicents,
    remaining_millicents: status.remainingMillicents,
    outstanding_reservations: status.outstandingReservations,
    unknown_cost_settlements: status.unknownCostSettlements,
    soft_limit_breached: status.softLimitBreached,
    exhausted: status.exhausted,
  };
}

// ---------------------------------------------------------------------------------------------------------
// embedding sets
// ---------------------------------------------------------------------------------------------------------

export interface EmbeddingSetReport {
  readonly set_id: string | null;
  readonly purpose: string;
  readonly status: string | null;
  readonly provider: string | null;
  readonly model_id: string | null;
  readonly model_version: string | null;
  readonly dimension: number | null;
  readonly activated_at: string | null;
  readonly completeness: {
    readonly expected: number;
    readonly embedded: number;
    readonly missing: number;
    readonly stale: number;
    readonly complete: boolean;
    /** Bounded samples, so a large incomplete set cannot produce an unbounded diagnostic payload. */
    readonly missing_sample: readonly string[];
    readonly stale_sample: readonly string[];
  } | null;
}

const SAMPLE = 10;

/**
 * The active embedding set for a project and whether it is actually complete.
 *
 * Completeness is computed rather than trusted from the row's status, because "active" only records that
 * someone activated it; whether it still covers every accepted document is a question about the data as it
 * is now. Missing and stale are reported separately for the reason `embeddingSetCompleteness` documents.
 */
export async function embeddingSetReport(
  c: Client,
  input: {
    projectId: string;
    purpose?: EmbeddingPurpose | undefined;
    hashOf: (text: string) => string;
  },
): Promise<EmbeddingSetReport> {
  const purpose = input.purpose ?? 'retrieval';
  const set = await activeEmbeddingSet(c, input.projectId, purpose);
  if (!set) {
    return {
      set_id: null,
      purpose,
      status: null,
      provider: null,
      model_id: null,
      model_version: null,
      dimension: null,
      activated_at: null,
      completeness: null,
    };
  }
  const report = await embeddingSetCompleteness(c, set.id, input.hashOf);
  return {
    set_id: set.id,
    purpose,
    status: set.status,
    provider: set.provider,
    model_id: set.model_id,
    model_version: set.model_version,
    dimension: set.dimension,
    activated_at: set.activated_at ? new Date(set.activated_at).toISOString() : null,
    completeness: {
      expected: report.expected,
      embedded: report.embedded,
      missing: report.missingDocumentIds.length,
      stale: report.staleDocumentIds.length,
      complete: report.complete,
      missing_sample: report.missingDocumentIds.slice(0, SAMPLE),
      stale_sample: report.staleDocumentIds.slice(0, SAMPLE),
    },
  };
}

export interface GcCandidate {
  readonly set_id: string;
  readonly purpose: string;
  readonly item_count: number;
}

/** Sets eligible for garbage collection. Reporting only: nothing here destroys anything. */
export async function gcEligible(
  c: Client,
  input: { projectId: string; keep?: number | undefined; limit?: unknown },
): Promise<BoundedList<GcCandidate>> {
  const keep = Math.max(0, Math.min(input.keep ?? 1, 50));
  const limit = boundedLimit(input.limit);
  const rows = await gcEligibleEmbeddingSets(c, input.projectId, keep);
  return bounded(
    rows.map((r) => ({ set_id: r.id, purpose: r.purpose, item_count: r.itemCount })),
    limit,
  );
}

// ---------------------------------------------------------------------------------------------------------
// thesaurus
// ---------------------------------------------------------------------------------------------------------

export interface AliasReport {
  readonly alias_id: string;
  readonly surface: string;
  readonly kind: string;
  readonly entity_id: string | null;
  readonly active: boolean;
  readonly ambiguous: boolean;
  readonly provenance: string;
  readonly from_chapter: number | null;
}

export interface ThesaurusListing extends BoundedList<AliasReport> {
  /** Surfaces that resolve to more than one entity: the diagnostic an operator actually needs. */
  readonly ambiguous_surfaces: readonly string[];
}

/**
 * The project's thesaurus with its ambiguity diagnostic.
 *
 * Ambiguity is computed over the WHOLE active alias set before the page is cut, because an ambiguity that
 * disappears when you ask for a smaller page would be a diagnostic that lies.
 */
export async function thesaurusListing(
  c: Client,
  input: { projectId: string; limit?: unknown; includeInactive?: boolean | undefined },
): Promise<ThesaurusListing> {
  const limit = boundedLimit(input.limit);
  const all = await aliasesForProject(c, input.projectId);
  const byEntity = new Map<string, Set<string>>();
  for (const a of all) {
    if (!a.active) continue;
    const set = byEntity.get(a.normalized) ?? new Set<string>();
    if (a.entity_id) set.add(a.entity_id);
    byEntity.set(a.normalized, set);
  }
  const ambiguous = [...byEntity.entries()]
    .filter(([, ids]) => ids.size > 1)
    .map(([surface]) => surface)
    .sort();
  const visible = input.includeInactive ? all : all.filter((a) => a.active);
  const page = bounded(
    visible.map((a) => ({
      alias_id: a.id,
      surface: a.surface,
      kind: a.kind,
      entity_id: a.entity_id,
      active: a.active,
      ambiguous: a.ambiguous,
      provenance: a.provenance,
      from_chapter: a.from_chapter,
    })),
    limit,
  );
  return { ...page, ambiguous_surfaces: ambiguous.slice(0, MAX_OPERATOR_LIMIT) };
}

/** A bounded, redacted expansion diagnostic for one query. */
export async function expansionDiagnostics(
  c: Client,
  input: {
    projectId: string;
    query: string;
    chapterMax?: number | undefined;
    limit?: unknown;
    includeDisguises?: boolean | undefined;
  },
): Promise<{
  readonly terms: readonly { surface: string; kind: string; weight: number; ambiguous: boolean }[];
  readonly diagnostics: {
    readonly matched_aliases: number;
    readonly dropped_for_bound: number;
    readonly excluded_inactive: number;
    readonly ambiguous_surfaces: readonly string[];
    readonly notes: readonly string[];
  };
}> {
  const expansion = await expandQuery(c, {
    projectId: input.projectId,
    query: input.query,
    chapterMax: input.chapterMax,
    limit: boundedLimit(input.limit, 12),
    includeDisguises: input.includeDisguises,
  });
  return {
    terms: expansion.terms.map((t) => ({
      surface: t.surface,
      kind: t.kind,
      weight: t.weight,
      ambiguous: t.ambiguous,
    })),
    diagnostics: {
      matched_aliases: expansion.diagnostics.matchedAliases,
      dropped_for_bound: expansion.diagnostics.droppedForBound,
      excluded_inactive: expansion.diagnostics.excludedInactive,
      ambiguous_surfaces: expansion.diagnostics.ambiguousSurfaces,
      notes: expansion.diagnostics.notes,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// retrieval diagnostics
// ---------------------------------------------------------------------------------------------------------

/**
 * A bounded hybrid-retrieval diagnostic.
 *
 * Document TEXT is deliberately absent. An operator debugging retrieval needs to know which documents
 * ranked where and why; returning the passages themselves would turn a diagnostic endpoint into an
 * unaudited content-read path around the normal accepted-only reading rules.
 */
export async function retrievalDiagnostics(
  c: Client,
  input: {
    projectId: string;
    query: string;
    mode?: RetrievalMode | undefined;
    limit?: unknown;
    chapterMax?: number | undefined;
    queryVector?: readonly number[] | undefined;
  },
): Promise<{
  readonly mode: RetrievalMode;
  readonly hits: readonly {
    document_id: string;
    kind: string;
    chapter_no: number | null;
    score: number;
    lexical_score: number;
    vector_score: number;
    sources: readonly string[];
  }[];
  readonly diagnostics: Record<string, unknown>;
}> {
  const limit = boundedLimit(input.limit);
  const result = await hybridSearch(c, {
    projectId: input.projectId,
    query: input.query,
    limit,
    chapterMax: input.chapterMax,
    queryVector: input.queryVector,
    useThesaurus: true,
  });
  return {
    mode: result.diagnostics.mode,
    hits: result.hits.slice(0, limit).map((h) => ({
      document_id: h.searchDocumentId,
      kind: h.kind,
      chapter_no: h.chapterNo,
      score: h.score,
      lexical_score: h.lexicalScore,
      vector_score: h.vectorScore,
      sources: h.sources,
    })),
    diagnostics: {
      lexical_hits: result.diagnostics.lexicalHits,
      vector_hits: result.diagnostics.vectorHits,
      embedding_set_id: result.diagnostics.embeddingSetId,
      embedding_set_stale: result.diagnostics.embeddingSetStale,
      expanded_terms: result.diagnostics.expandedTerms,
      weights: result.diagnostics.weights,
      truncated: result.diagnostics.truncated,
      notes: result.diagnostics.notes,
    },
  };
}
