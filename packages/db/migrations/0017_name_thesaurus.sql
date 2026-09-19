-- ---------------------------------------------------------------------------------------------------------
-- Migration 0017: a project-scoped name and terminology thesaurus.
--
-- WHY THIS EXISTS. Retrieval is lexical-first, and a Korean-tradition serialized webnovel is full of one
-- entity under many surfaces: a canonical name, a former name, a title, an honorific form, a romanization
-- variant, a spacing variant, and — structurally important to the genre — a DISGUISED identity the
-- narration deliberately keeps separate from the true one. A query for "Seo-ha" that cannot also match
-- "Lady Seoha", "Seo Ha" or "the veiled instructor" misses the canon it was asked to check, which is how
-- continuity errors reach a manuscript.
--
-- THE DECISION THAT SHAPES THE TABLE. Alias expansion is a RETRIEVAL aid, never a canon assertion. An
-- alias row therefore carries provenance and an `ambiguous` flag rather than implying identity: two
-- characters may legitimately share a surface form, and a disguised identity must be expandable for
-- search WITHOUT the system stating that the disguise and the person are the same entity. That is why
-- `entity_id` is nullable (a terminology entry names no entity) and why `reveals_entity` is separate
-- from `entity_id`: linking a disguise to its true identity is a spoiler-bearing fact that belongs to
-- canon, and the thesaurus only records that the link exists for search purposes.
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE name_aliases (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  -- The entity this surface refers to, when it refers to one. NULL for approved terminology.
  entity_id uuid REFERENCES entities(id),
  kind text NOT NULL CHECK (kind IN (
    'canonical', 'alias', 'former_name', 'title', 'honorific', 'romanization', 'spacing_variant',
    'disguise', 'organization', 'location', 'terminology')),
  -- The searchable surface, NFC-normalized like every other text column (ADR-0030).
  surface text NOT NULL,
  -- Case- and space-folded form, so lookup does not depend on how the query was typed.
  normalized text NOT NULL,
  -- The canonical surface this expands to, for diagnostics and for favouring canonical matches.
  canonical_surface text,
  -- A disguise's true entity, recorded only so retrieval can be asked to include it deliberately.
  reveals_entity uuid REFERENCES entities(id),
  -- An inactive alias is excluded from expansion but retained: a former name is history, not a mistake.
  active boolean NOT NULL DEFAULT true,
  -- Genuinely ambiguous surfaces ("the captain") must not silently resolve to one entity.
  ambiguous boolean NOT NULL DEFAULT false,
  -- Where this came from, so an operator can tell an extracted alias from an authored one.
  provenance text NOT NULL DEFAULT 'operator'
    CHECK (provenance IN ('operator', 'extracted', 'naming_policy', 'terminology_policy')),
  -- The chapter from which this surface is in play, so a reveal cannot be searched before it happens.
  from_chapter integer,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alias_surface_is_nfc CHECK (surface = normalize(surface, NFC)),
  CONSTRAINT alias_normalized_is_nfc CHECK (normalized = normalize(normalized, NFC)),
  CONSTRAINT alias_surface_not_blank CHECK (length(btrim(surface)) > 0),
  -- Terminology names no entity; every other kind describes one.
  CONSTRAINT alias_entity_presence CHECK (
    (kind = 'terminology' AND entity_id IS NULL) OR (kind <> 'terminology' AND entity_id IS NOT NULL)),
  -- One surface of one kind per entity per project. The project scope is what prevents cross-project
  -- leakage from being possible at all rather than merely filtered later.
  UNIQUE (project_id, kind, normalized, entity_id)
);
CREATE INDEX name_aliases_lookup_idx ON name_aliases(project_id, normalized) WHERE active;
CREATE INDEX name_aliases_entity_idx ON name_aliases(project_id, entity_id);

-- An alias may only describe an entity of its OWN project. Enforced in the database because a
-- cross-project alias would expand one tenant's query with another tenant's names — a data-isolation
-- failure dressed up as a search feature.
CREATE OR REPLACE FUNCTION canon.name_alias_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_project uuid;
BEGIN
  IF NEW.entity_id IS NOT NULL THEN
    SELECT project_id INTO v_project FROM entities WHERE id = NEW.entity_id;
    IF v_project IS NULL THEN
      PERFORM canon.raise_code('ALIAS_ENTITY_NOT_FOUND', 'entity does not exist');
    END IF;
    IF v_project <> NEW.project_id THEN
      PERFORM canon.raise_code('ALIAS_CROSS_PROJECT',
        'an alias may not describe an entity from another project');
    END IF;
  END IF;
  IF NEW.reveals_entity IS NOT NULL THEN
    SELECT project_id INTO v_project FROM entities WHERE id = NEW.reveals_entity;
    IF v_project IS DISTINCT FROM NEW.project_id THEN
      PERFORM canon.raise_code('ALIAS_CROSS_PROJECT',
        'a disguise may not reveal an entity from another project');
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER name_aliases_guard BEFORE INSERT OR UPDATE ON name_aliases
  FOR EACH ROW EXECUTE FUNCTION canon.name_alias_guard();

ALTER TABLE name_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE name_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY name_aliases_workspace_isolation ON name_aliases
  USING (canon.workspace_visible(workspace_id))
  WITH CHECK (canon.workspace_visible(workspace_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON name_aliases TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.name_alias_guard() TO yeonjae_app;

-- Same reason as 0015 and 0016: functions created here are born PUBLIC-executable otherwise.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA canon FROM PUBLIC;

COMMENT ON TABLE name_aliases IS
  'Project-scoped name and terminology thesaurus (migration 0017). Alias expansion is a RETRIEVAL aid, '
  'never a canon assertion: rows carry provenance and an ambiguous flag, a disguise''s true identity is '
  'recorded separately from its entity because that link is spoiler-bearing canon, and an inactive alias '
  'is retained rather than deleted because a former name is history. A trigger refuses an alias that '
  'describes another project''s entity.';
