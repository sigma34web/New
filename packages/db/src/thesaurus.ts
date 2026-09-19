/**
 * The name and terminology thesaurus (migration 0017), and the query expansion it feeds.
 *
 * Expansion is bounded, ranked and EXPLAINED. Each of those is a decision:
 *
 *   - BOUNDED, because an entity with forty recorded surfaces would otherwise turn one query into a
 *     forty-term OR that matches most of the corpus and ranks nothing usefully.
 *   - RANKED, because a canonical surface is better evidence than a generic title: expanding "Seo-ha" to
 *     include "the captain" must not let every captain in the book outrank the person asked about.
 *   - EXPLAINED, because a retrieval result an operator cannot account for is not reviewable. Diagnostics
 *     name which term came from which alias row and why.
 */
import { normalizeNfc } from '@yeonjae/prose';
import { type Client, type Pool } from './client.js';

type Queryable = Pool | Client;

/**
 * NFC-normalize a surface (ADR-0030 normalizes at the boundary).
 *
 * `normalizeNfc`, not `toNfcText`: the latter returns a `{ text, codePoints }` RECORD, so treating its
 * result as a string yields "[object Object]" and silently corrupts every surface it touches.
 */
function nfc(text: string): string {
  return normalizeNfc(text);
}

export type AliasKind =
  | 'canonical'
  | 'alias'
  | 'former_name'
  | 'title'
  | 'honorific'
  | 'romanization'
  | 'spacing_variant'
  | 'disguise'
  | 'organization'
  | 'location'
  | 'terminology';

export type AliasProvenance = 'operator' | 'extracted' | 'naming_policy' | 'terminology_policy';

export interface NameAliasRow {
  readonly id: string;
  readonly project_id: string;
  readonly entity_id: string | null;
  readonly kind: AliasKind;
  readonly surface: string;
  readonly normalized: string;
  readonly canonical_surface: string | null;
  readonly reveals_entity: string | null;
  readonly active: boolean;
  readonly ambiguous: boolean;
  readonly provenance: AliasProvenance;
  readonly from_chapter: number | null;
}

/**
 * Fold a surface for lookup.
 *
 * NFC first, then case folding, then whitespace collapse — which is what makes "Seo Ha", "Seo-ha" and
 * "seoha" one lookup key. Hyphens are collapsed too, because romanized Korean names vary in exactly that
 * position and a reader searching either form means the same person.
 */
export function normalizeSurface(surface: string): string {
  // `toNfcText` returns a BRANDED type, so it is widened to string here at the module boundary rather
  // than threaded through every local: nothing below depends on the NFC guarantee being in the type.
  return nfc(surface)
    .toLowerCase()
    .replace(/[\s\-_·]+/gu, '')
    .trim();
}

export async function addAlias(
  db: Queryable,
  input: {
    workspaceId: string;
    projectId: string;
    entityId?: string | undefined;
    kind: AliasKind;
    surface: string;
    canonicalSurface?: string | undefined;
    revealsEntity?: string | undefined;
    active?: boolean | undefined;
    ambiguous?: boolean | undefined;
    provenance?: AliasProvenance | undefined;
    fromChapter?: number | undefined;
  },
): Promise<NameAliasRow> {
  const surface = nfc(input.surface);
  const r = await db.query<NameAliasRow>(
    `INSERT INTO name_aliases
       (workspace_id, project_id, entity_id, kind, surface, normalized, canonical_surface,
        reveals_entity, active, ambiguous, provenance, from_chapter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, true), coalesce($10, false),
             coalesce($11, 'operator'), $12)
     ON CONFLICT (project_id, kind, normalized, entity_id) DO UPDATE
       SET surface = excluded.surface,
           canonical_surface = excluded.canonical_surface,
           reveals_entity = excluded.reveals_entity,
           active = excluded.active,
           ambiguous = excluded.ambiguous,
           provenance = excluded.provenance,
           from_chapter = excluded.from_chapter
     RETURNING *`,
    [
      input.workspaceId,
      input.projectId,
      input.entityId ?? null,
      input.kind,
      surface,
      normalizeSurface(surface),
      input.canonicalSurface === undefined ? null : nfc(input.canonicalSurface),
      input.revealsEntity ?? null,
      input.active ?? null,
      input.ambiguous ?? null,
      input.provenance ?? null,
      input.fromChapter ?? null,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error('alias insert returned no row');
  return row;
}

/** Deactivate rather than delete: a former name is history and may need to be explained later. */
export async function deactivateAlias(db: Queryable, aliasId: string): Promise<void> {
  await db.query('UPDATE name_aliases SET active = false WHERE id = $1', [aliasId]);
}

export async function aliasesForProject(db: Queryable, projectId: string): Promise<NameAliasRow[]> {
  const r = await db.query<NameAliasRow>(
    'SELECT * FROM name_aliases WHERE project_id = $1 ORDER BY id',
    [projectId],
  );
  return r.rows;
}

/** Weight per kind: how much a match on this surface should be trusted relative to a canonical one. */
const KIND_WEIGHT: Readonly<Record<AliasKind, number>> = {
  canonical: 1,
  alias: 0.9,
  romanization: 0.9,
  spacing_variant: 0.9,
  former_name: 0.75,
  organization: 0.7,
  location: 0.7,
  terminology: 0.7,
  disguise: 0.6,
  // A title or honorific is the weakest evidence: many people hold a rank.
  title: 0.4,
  honorific: 0.4,
};

export interface ExpansionTerm {
  readonly surface: string;
  readonly kind: AliasKind;
  readonly weight: number;
  readonly entityId: string | null;
  readonly ambiguous: boolean;
  /** Which alias row produced this term, so an operator can audit an expansion. */
  readonly aliasId: string | null;
}

export interface ExpansionDiagnostics {
  readonly matchedAliases: number;
  readonly droppedForBound: number;
  readonly excludedInactive: number;
  readonly ambiguousSurfaces: readonly string[];
  readonly notes: readonly string[];
}

export interface Expansion {
  readonly terms: readonly ExpansionTerm[];
  readonly diagnostics: ExpansionDiagnostics;
}

export const DEFAULT_EXPANSION_LIMIT = 12;

/**
 * Expand a query's terms through the project's thesaurus.
 *
 * The original query terms always survive expansion with full weight: the thesaurus adds reach and never
 * replaces what the caller asked for. Everything else is bounded and ordered by (weight, surface) so the
 * result is deterministic — a tie in weight is broken by the surface text, never by row order.
 */
export async function expandQuery(
  db: Queryable,
  input: {
    projectId: string;
    query: string;
    /** Never expand a surface that is only in play after this chapter. */
    chapterMax?: number | undefined;
    limit?: number | undefined;
    /** Disguises are opt-in: including one asserts nothing, but it does widen a spoiler-adjacent search. */
    includeDisguises?: boolean | undefined;
  },
): Promise<Expansion> {
  const limit = input.limit ?? DEFAULT_EXPANSION_LIMIT;
  const notes: string[] = [];
  const queryTerms = nfc(input.query)
    .split(/\s+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const normalizedQuery = new Set(queryTerms.map((t) => normalizeSurface(t)));
  // Also fold the whole query, so a multi-word surface ("Seo Ha") matches a single stored key.
  normalizedQuery.add(normalizeSurface(input.query));

  const rows = await db.query<NameAliasRow>(
    `SELECT * FROM name_aliases
      WHERE project_id = $1 AND normalized = ANY($2::text[])
      ORDER BY id`,
    [input.projectId, [...normalizedQuery]],
  );

  // Every alias of every entity the query matched, so "Seo-ha" reaches "Lady Seoha" and back.
  const entityIds = [...new Set(rows.rows.map((r) => r.entity_id).filter((x): x is string => !!x))];
  const related =
    entityIds.length > 0
      ? await db.query<NameAliasRow>(
          `SELECT * FROM name_aliases
            WHERE project_id = $1 AND entity_id = ANY($2::uuid[])
            ORDER BY id`,
          [input.projectId, entityIds],
        )
      : { rows: [] as NameAliasRow[] };

  const candidates = new Map<string, NameAliasRow>();
  for (const row of [...rows.rows, ...related.rows]) candidates.set(row.id, row);

  let excludedInactive = 0;
  const ambiguousSurfaces: string[] = [];
  const terms: ExpansionTerm[] = [];
  for (const row of candidates.values()) {
    if (!row.active) {
      excludedInactive++;
      continue;
    }
    if (row.kind === 'disguise' && input.includeDisguises !== true) {
      notes.push('disguise surfaces excluded (opt in with includeDisguises)');
      continue;
    }
    if (
      input.chapterMax !== undefined &&
      row.from_chapter !== null &&
      row.from_chapter > input.chapterMax
    ) {
      // A surface that only exists after a later reveal must not be searchable now.
      notes.push('a surface was excluded as not yet in play at this chapter');
      continue;
    }
    if (row.ambiguous) ambiguousSurfaces.push(row.surface);
    terms.push({
      surface: row.surface,
      kind: row.kind,
      // An ambiguous surface is halved rather than dropped: it is still evidence, just weaker, and a
      // generic alias must not be able to dominate a canonical one.
      weight: KIND_WEIGHT[row.kind] * (row.ambiguous ? 0.5 : 1),
      entityId: row.entity_id,
      ambiguous: row.ambiguous,
      aliasId: row.id,
    });
  }

  // The caller's own terms, at full weight, never dropped by the bound.
  const original: ExpansionTerm[] = queryTerms.map((surface) => ({
    surface,
    kind: 'canonical' as const,
    weight: 1,
    entityId: null,
    ambiguous: false,
    aliasId: null,
  }));

  const deduped = new Map<string, ExpansionTerm>();
  for (const term of [...original, ...terms]) {
    const key = normalizeSurface(term.surface);
    const existing = deduped.get(key);
    // Keep the strongest reading of a surface that appears more than once.
    if (!existing || term.weight > existing.weight) deduped.set(key, term);
  }

  const ordered = [...deduped.values()].sort(
    (a, b) => b.weight - a.weight || a.surface.localeCompare(b.surface),
  );
  const bounded = ordered.slice(0, limit);
  return {
    terms: bounded,
    diagnostics: {
      matchedAliases: candidates.size,
      droppedForBound: ordered.length - bounded.length,
      excludedInactive,
      ambiguousSurfaces,
      notes: [...new Set(notes)],
    },
  };
}
