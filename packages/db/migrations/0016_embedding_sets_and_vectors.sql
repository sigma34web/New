-- ---------------------------------------------------------------------------------------------------------
-- Migration 0016: versioned embedding sets with atomic activation, and vector storage (ADR-0035, ADR-0045).
--
-- WHAT 0003 LEFT OPEN. 0003 created `embedding_sets` as a REGISTRY only: a project, a model, a dimension
-- and a status, with a partial unique index enforcing one active set per project. Embeddings themselves
-- were deferred because they needed pgvector and a live embedder. This migration completes the lifecycle
-- for a provider-neutral backend: the set gains its full identity (model VERSION and config, the source
-- content hash, a purpose), vectors get a table, and activation becomes an ATOMIC, auditable transition
-- rather than two UPDATEs a reader can observe between.
--
-- WHY NOT pgvector. pgvector is not installed here and installing an extension is an infrastructure
-- decision, not a migration's to make. Vectors are therefore stored as `double precision[]` with the
-- dimension asserted by constraint, and similarity is computed by the application's deterministic local
-- backend. That is honest about its cost: it is a sequential scan, correct and bounded but not an ANN
-- index, so it is right for fixtures and development and NOT a production vector search. Moving to
-- pgvector later is a forward-only migration that rewrites this column; nothing above it changes, because
-- the retrieval interface is provider-neutral.
--
-- WHY ACTIVATION IS A FUNCTION. "One active set per project and purpose" plus "readers never observe
-- partial activation" cannot be guaranteed by a route handler: two concurrent activations that each
-- retire the old set and promote their own would both succeed if they interleave. The partial unique
-- index makes the second one fail, and `canon.activate_embedding_set` performs the retire-and-promote
-- inside ONE transaction with the rows locked, so a reader sees exactly one active set at every instant.
-- ---------------------------------------------------------------------------------------------------------

-- Full identity of a set. A vector is only comparable to another produced by the same
-- provider/model/version/config, so all four are part of the set's identity rather than metadata.
ALTER TABLE embedding_sets ADD COLUMN model_version text NOT NULL DEFAULT '1.0.0';
ALTER TABLE embedding_sets ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb;
-- What the set is FOR. Retrieval asks for the active set of a purpose, so an experiment for one purpose
-- cannot displace the set another purpose depends on.
ALTER TABLE embedding_sets ADD COLUMN purpose text NOT NULL DEFAULT 'retrieval'
  CHECK (purpose IN ('retrieval', 'dedup', 'experiment'));
-- Hash of the source corpus this set was built from, for stale-source detection.
ALTER TABLE embedding_sets ADD COLUMN source_content_hash text;
ALTER TABLE embedding_sets ADD COLUMN item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0);
ALTER TABLE embedding_sets ADD COLUMN failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0);
ALTER TABLE embedding_sets ADD COLUMN activated_at timestamptz;
ALTER TABLE embedding_sets ADD COLUMN retired_at timestamptz;
-- The set this one replaced, so a rollback knows where to go back to without guessing by timestamp.
ALTER TABLE embedding_sets ADD COLUMN replaced_set_id uuid REFERENCES embedding_sets(id);
ALTER TABLE embedding_sets ADD COLUMN notes text;

-- 0003's index was one active set per PROJECT. A purpose changes that to one per project and purpose,
-- which is the constraint the lifecycle actually needs.
DROP INDEX embedding_sets_one_active_per_project;
CREATE UNIQUE INDEX embedding_sets_one_active_per_purpose
  ON embedding_sets(project_id, purpose) WHERE status = 'active';
CREATE INDEX embedding_sets_project_status_idx ON embedding_sets(project_id, status);

-- ---------------------------------------------------------------------------------------------------------
-- Vectors.
--
-- A vector cites the search document it describes, so retrieval joins to the SAME accepted-content-only
-- rows the lexical path reads and cannot accidentally return unaccepted text through the vector route.
-- ON DELETE CASCADE is correct here (unlike canon history): a vector without its document is meaningless,
-- and search_documents is itself derived, rebuildable state rather than canon.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE embedding_vectors (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  embedding_set_id uuid NOT NULL REFERENCES embedding_sets(id) ON DELETE CASCADE,
  search_document_id uuid NOT NULL REFERENCES search_documents(id) ON DELETE CASCADE,
  embedding double precision[] NOT NULL,
  dimension integer NOT NULL CHECK (dimension > 0),
  -- Hash of the embedded text, so a source edit is detectable without re-embedding to compare.
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotent writes: re-running generation for the same document in the same set updates in place
  -- rather than inserting a duplicate, which is what makes generation resumable.
  UNIQUE (embedding_set_id, search_document_id),
  CONSTRAINT embedding_dimension_matches CHECK (array_length(embedding, 1) = dimension)
);
CREATE INDEX embedding_vectors_set_idx ON embedding_vectors(embedding_set_id);
CREATE INDEX embedding_vectors_project_idx ON embedding_vectors(project_id);

-- A vector must belong to its set's project and carry its set's dimension. Enforced in the DATABASE
-- because a mismatch is not a cosmetic error: comparing vectors of different dimensions or from another
-- project's model produces plausible-looking nonsense, and a rule living in one writer is bypassable by
-- the next writer.
CREATE OR REPLACE FUNCTION canon.embedding_vector_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_set embedding_sets;
  v_doc_project uuid;
BEGIN
  SELECT * INTO v_set FROM embedding_sets WHERE id = NEW.embedding_set_id;
  IF v_set.id IS NULL THEN
    PERFORM canon.raise_code('EMBEDDING_SET_NOT_FOUND', 'embedding set does not exist');
  END IF;
  IF v_set.project_id <> NEW.project_id OR v_set.workspace_id <> NEW.workspace_id THEN
    PERFORM canon.raise_code('EMBEDDING_SET_TENANT_MISMATCH',
      'a vector must belong to the same workspace and project as its embedding set');
  END IF;
  IF NEW.dimension <> v_set.dimension THEN
    PERFORM canon.raise_code('EMBEDDING_DIMENSION_MISMATCH',
      format('set expects dimension %s; vector has %s', v_set.dimension, NEW.dimension));
  END IF;
  SELECT project_id INTO v_doc_project FROM search_documents WHERE id = NEW.search_document_id;
  IF v_doc_project IS NULL THEN
    PERFORM canon.raise_code('EMBEDDING_SOURCE_NOT_FOUND', 'search document does not exist');
  END IF;
  -- Cross-project leakage is refused at the write, so a retrieval bug cannot become a data-isolation
  -- incident: a vector can never point at another project's text.
  IF v_doc_project <> NEW.project_id THEN
    PERFORM canon.raise_code('EMBEDDING_CROSS_PROJECT',
      'a vector may not describe a search document from another project');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER embedding_vectors_guard BEFORE INSERT OR UPDATE ON embedding_vectors
  FOR EACH ROW EXECUTE FUNCTION canon.embedding_vector_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Atomic activation and rollback.
-- ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION canon.activate_embedding_set(p_set_id uuid, p_now timestamptz DEFAULT now())
RETURNS embedding_sets
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_set embedding_sets;
  v_previous uuid;
BEGIN
  -- Lock the target first, so two activations of the SAME set serialize instead of both proceeding.
  SELECT * INTO v_set FROM embedding_sets WHERE id = p_set_id FOR UPDATE;
  IF v_set.id IS NULL THEN
    PERFORM canon.raise_code('EMBEDDING_SET_NOT_FOUND', 'embedding set does not exist');
  END IF;
  IF v_set.status = 'active' THEN
    -- Idempotent: re-activating the active set is a no-op, not an error, so a retried operator action
    -- or a redelivered activity cannot flap the active pointer.
    RETURN v_set;
  END IF;
  IF v_set.status = 'retired' THEN
    PERFORM canon.raise_code('EMBEDDING_SET_RETIRED',
      'a retired set cannot be activated directly; roll back to it instead');
  END IF;
  IF v_set.item_count = 0 THEN
    PERFORM canon.raise_code('EMBEDDING_SET_EMPTY',
      'refusing to activate a set with no vectors: retrieval would silently return nothing');
  END IF;
  IF v_set.failed_count > 0 THEN
    PERFORM canon.raise_code('EMBEDDING_SET_INCOMPLETE',
      format('refusing to activate a set with %s failed items', v_set.failed_count));
  END IF;

  -- Retire the incumbent of the same project AND purpose, inside this transaction. The partial unique
  -- index is the backstop: if a concurrent transaction promoted a different set first, the UPDATE below
  -- fails rather than producing two active sets.
  SELECT id INTO v_previous FROM embedding_sets
   WHERE project_id = v_set.project_id AND purpose = v_set.purpose AND status = 'active'
   FOR UPDATE;
  IF v_previous IS NOT NULL THEN
    UPDATE embedding_sets SET status = 'retired', retired_at = p_now WHERE id = v_previous;
  END IF;

  UPDATE embedding_sets
     SET status = 'active', activated_at = p_now, replaced_set_id = v_previous
   WHERE id = p_set_id
  RETURNING * INTO v_set;
  RETURN v_set;
END $$;

-- Roll back to the set the current active one replaced. Separate from activation because it is a
-- different operator intent and must not silently promote an arbitrary retired set.
CREATE OR REPLACE FUNCTION canon.rollback_embedding_set(
  p_project_id uuid, p_purpose text DEFAULT 'retrieval', p_now timestamptz DEFAULT now())
RETURNS embedding_sets
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_current embedding_sets;
  v_target embedding_sets;
BEGIN
  SELECT * INTO v_current FROM embedding_sets
   WHERE project_id = p_project_id AND purpose = p_purpose AND status = 'active' FOR UPDATE;
  IF v_current.id IS NULL THEN
    PERFORM canon.raise_code('EMBEDDING_SET_NOT_ACTIVE', 'no active embedding set to roll back from');
  END IF;
  IF v_current.replaced_set_id IS NULL THEN
    PERFORM canon.raise_code('EMBEDDING_SET_NO_PREVIOUS',
      'the active set replaced nothing; there is no previous set to roll back to');
  END IF;
  SELECT * INTO v_target FROM embedding_sets WHERE id = v_current.replaced_set_id FOR UPDATE;
  IF v_target.id IS NULL THEN
    PERFORM canon.raise_code('EMBEDDING_SET_NO_PREVIOUS', 'the previous set no longer exists');
  END IF;
  -- Retire the current one BEFORE promoting the previous one, in one transaction, so the partial unique
  -- index is never transiently violated and no reader sees two active sets.
  UPDATE embedding_sets SET status = 'retired', retired_at = p_now WHERE id = v_current.id;
  UPDATE embedding_sets
     SET status = 'active', activated_at = p_now, retired_at = NULL
   WHERE id = v_target.id
  RETURNING * INTO v_target;
  RETURN v_target;
END $$;

-- Which sets are eligible for garbage collection. Reports eligibility and never destroys anything:
-- deleting a retired set is an operator decision, and an automatic sweep would remove the only thing a
-- rollback needs.
CREATE OR REPLACE FUNCTION canon.gc_eligible_embedding_sets(
  p_project_id uuid, p_keep integer DEFAULT 1, p_now timestamptz DEFAULT now())
RETURNS TABLE (id uuid, purpose text, retired_at timestamptz, item_count integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  -- Recency is computed over ALL retired sets FIRST, and the rollback target is excluded afterwards.
  -- Doing it the other way round renumbers the remaining rows once the target is removed, which
  -- silently hides a genuinely eligible set behind the `p_keep` window.
  WITH retired AS (
    SELECT s.id, s.purpose, s.retired_at, s.item_count,
           row_number() OVER (PARTITION BY s.purpose ORDER BY s.retired_at DESC) AS recency,
           EXISTS (
             SELECT 1 FROM embedding_sets a
              WHERE a.status = 'active' AND a.replaced_set_id = s.id) AS is_rollback_target
      FROM embedding_sets s
     WHERE s.project_id = p_project_id
       AND s.status = 'retired'
  )
  SELECT r.id, r.purpose, r.retired_at, r.item_count FROM retired r
   WHERE r.recency > p_keep
     -- Never eligible: the set an active set could roll back to.
     AND NOT r.is_rollback_target
$$;

-- Tenant isolation and least privilege, on the same terms as every other workspace-owned table
-- (0006 decision, narrowed by 0007/0014). embedding_sets already carries the policy from 0006.
ALTER TABLE embedding_vectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_vectors FORCE ROW LEVEL SECURITY;
CREATE POLICY embedding_vectors_workspace_isolation ON embedding_vectors
  USING (canon.workspace_visible(workspace_id))
  WITH CHECK (canon.workspace_visible(workspace_id));

-- Derived, rebuildable state: unlike canon history, a vector may be deleted when its set is discarded.
GRANT SELECT, INSERT, UPDATE, DELETE ON embedding_vectors TO yeonjae_app;
GRANT SELECT, INSERT, UPDATE ON embedding_sets TO yeonjae_app;

GRANT EXECUTE ON FUNCTION canon.activate_embedding_set(uuid, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.rollback_embedding_set(uuid, text, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.gc_eligible_embedding_sets(uuid, integer, timestamptz) TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.embedding_vector_guard() TO yeonjae_app;

-- ADR-0050 decision 5, repeated for the same reason 0015 had to repeat it: PostgreSQL grants PUBLIC
-- EXECUTE by default, and 0014's ALTER DEFAULT PRIVILEGES does not cover functions this migration's own
-- owner creates in this schema. Without this line every function above would be born PUBLIC-executable.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA canon FROM PUBLIC;

COMMENT ON TABLE embedding_vectors IS
  'Vectors for one embedding set (migration 0016). Stored as double precision[] rather than pgvector, '
  'which is not installed: correct and bounded for fixtures and development, but a sequential scan and '
  'NOT a production ANN index. A trigger refuses a dimension mismatch, a tenant mismatch and a vector '
  'describing another project''s document, because such a row would produce plausible-looking nonsense.';
COMMENT ON FUNCTION canon.activate_embedding_set(uuid, timestamptz) IS
  'Atomically retire the incumbent set and promote this one, for one project and purpose. A reader never '
  'observes two active sets or none; re-activating the active set is idempotent. Refuses an empty or '
  'incomplete set, because activating one would make retrieval silently return nothing.';
