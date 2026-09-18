-- ---------------------------------------------------------------------------------------------------------
-- Migration 0018: regeneration previews and bounded batch operations.
--
-- WHY A TABLE AND NOT AN IN-MEMORY OBJECT. A preview is a *proposal about accepted content* that an
-- operator may accept minutes later, possibly from a different process. It therefore needs the same
-- properties every other proposal in this system has: durability, tenant isolation, an idempotency key so
-- a duplicated request does not produce two proposals, a content hash so acceptance can refuse a stale
-- one, and an audit trail. None of those survive in process memory.
--
-- THE INVARIANT THIS MIGRATION EXISTS TO ENFORCE. A preview MUST NOT be able to mutate accepted content.
-- That is guaranteed structurally rather than by convention: `regeneration_previews` holds the proposed
-- text in its OWN column and has no write path into `manuscript_versions`, `chapters` or any canon table,
-- and `canon.preview_transition_guard` refuses every transition out of a terminal state and every edit of
-- a resolved row. Accepting a preview is a separate, ordinary production write performed by the
-- application through the existing manuscript-version path; this table never becomes that path.
--
-- STALENESS IS DETECTED, NOT ASSUMED. `source_content_hash` records the bytes the proposal was computed
-- against. Acceptance compares it with the current accepted version, so a preview raised against content
-- that has since changed is refused rather than silently applied to different text.
--
-- BATCHES ARE BOUNDED IN THE DATABASE, not only in the handler. `batch_operations.item_count` carries a
-- CHECK against the same maximum the application enforces, so a caller that bypassed the handler still
-- cannot create an unbounded batch, and every item row carries its own workspace for per-item isolation.
--
-- ROLLBACK. Forward-only (data architecture §15). This migration only ADDs objects, so reverting means
-- writing a new migration that drops them; no existing data moves.
-- ---------------------------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------------------------
-- 1. regeneration previews
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE regeneration_previews (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  chapter_id uuid NOT NULL REFERENCES chapters(id),
  -- The accepted version this proposal was computed against. The preview never writes to it.
  source_manuscript_version_id uuid NOT NULL REFERENCES manuscript_versions(id),
  -- The bytes of that version at preview time, so acceptance can refuse a stale proposal.
  source_content_hash text NOT NULL,
  -- Idempotency: one preview per (workspace, key). A duplicate delivery returns the SAME row.
  request_key text NOT NULL,
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'accepted', 'discarded', 'cancelled', 'failed')),
  -- Everything needed to reproduce the proposal, recorded rather than recomputed.
  simulator jsonb NOT NULL DEFAULT '{}'::jsonb,
  seed bigint NOT NULL,
  context_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  retrieval_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The proposal itself, held HERE and nowhere else until it is explicitly accepted.
  proposed_text text,
  proposed_content_hash text,
  -- A simulated estimate in integer millicents, matching migration 0015's accounting unit. It is an
  -- ESTIMATE from a local simulator and is never presented as a provider charge.
  estimated_millicents bigint NOT NULL DEFAULT 0 CHECK (estimated_millicents >= 0),
  -- Why a preview ended up in a non-ready state. A closed code, never an exception message.
  failure_code text,
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT preview_request_key_not_blank CHECK (length(btrim(request_key)) > 0),
  CONSTRAINT preview_text_is_nfc CHECK (
    proposed_text IS NULL OR proposed_text = normalize(proposed_text, NFC)),
  -- A ready preview must carry a proposal; a failed one must not pretend to.
  CONSTRAINT preview_ready_has_content CHECK (
    status <> 'ready' OR (proposed_text IS NOT NULL AND proposed_content_hash IS NOT NULL)),
  CONSTRAINT preview_resolved_has_time CHECK ((status = 'ready') = (resolved_at IS NULL)),
  UNIQUE (workspace_id, request_key)
);
CREATE INDEX regeneration_previews_project_idx
  ON regeneration_previews(project_id, created_at DESC);
CREATE INDEX regeneration_previews_chapter_idx
  ON regeneration_previews(chapter_id, status);

-- A preview's state machine, enforced where it cannot be bypassed.
--
-- Only `ready -> {accepted, discarded, cancelled, failed}` is legal. A terminal row is immutable:
-- without this, an accepted preview could be flipped back to ready and re-accepted, which is a second
-- write of the same proposal against content that has since moved on.
CREATE OR REPLACE FUNCTION canon.preview_transition_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.status <> 'ready' THEN
    PERFORM canon.raise_code('PREVIEW_TERMINAL',
      'a resolved preview is immutable; create a new preview instead');
  END IF;
  IF NEW.status = 'ready' THEN
    PERFORM canon.raise_code('PREVIEW_ILLEGAL_TRANSITION',
      'a preview may not return to the ready state');
  END IF;
  -- The proposal and its provenance are fixed at creation. Allowing them to change on resolution would
  -- mean accepting different bytes from the ones the operator previewed.
  IF NEW.proposed_content_hash IS DISTINCT FROM OLD.proposed_content_hash
     OR NEW.proposed_text IS DISTINCT FROM OLD.proposed_text
     OR NEW.source_content_hash IS DISTINCT FROM OLD.source_content_hash
     OR NEW.source_manuscript_version_id IS DISTINCT FROM OLD.source_manuscript_version_id
     OR NEW.seed IS DISTINCT FROM OLD.seed
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    PERFORM canon.raise_code('PREVIEW_IMMUTABLE_FIELD',
      'a preview''s proposal and provenance may not be altered');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER regeneration_previews_transition
  BEFORE UPDATE ON regeneration_previews
  FOR EACH ROW EXECUTE FUNCTION canon.preview_transition_guard();

-- A preview is history: it records what was proposed. Deleting one would erase the record of a decision.
CREATE OR REPLACE FUNCTION canon.preview_no_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM canon.raise_code('PREVIEW_DELETE_FORBIDDEN', 'previews are append-only history');
  RETURN NULL;
END $$;

CREATE TRIGGER regeneration_previews_no_delete
  BEFORE DELETE ON regeneration_previews
  FOR EACH ROW EXECUTE FUNCTION canon.preview_no_delete();

-- A preview may only name a chapter and a manuscript version of its OWN project. Enforced here for the
-- same reason 0017 enforces it for aliases: a cross-project reference would be a data-isolation failure
-- presented as a feature.
CREATE OR REPLACE FUNCTION canon.preview_scope_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_project uuid;
BEGIN
  SELECT project_id INTO v_project FROM chapters WHERE id = NEW.chapter_id;
  IF v_project IS DISTINCT FROM NEW.project_id THEN
    PERFORM canon.raise_code('PREVIEW_CROSS_PROJECT',
      'a preview may not name another project''s chapter');
  END IF;
  SELECT project_id INTO v_project FROM manuscript_versions
   WHERE id = NEW.source_manuscript_version_id;
  IF v_project IS DISTINCT FROM NEW.project_id THEN
    PERFORM canon.raise_code('PREVIEW_CROSS_PROJECT',
      'a preview may not name another project''s manuscript version');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER regeneration_previews_scope
  BEFORE INSERT ON regeneration_previews
  FOR EACH ROW EXECUTE FUNCTION canon.preview_scope_guard();

ALTER TABLE regeneration_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE regeneration_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY regeneration_previews_workspace_isolation ON regeneration_previews
  USING (canon.workspace_visible(workspace_id))
  WITH CHECK (canon.workspace_visible(workspace_id));

-- ---------------------------------------------------------------------------------------------------------
-- 2. bounded batch operations
-- ---------------------------------------------------------------------------------------------------------

CREATE TABLE batch_operations (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  operation text NOT NULL CHECK (operation IN (
    'typography_check', 'platform_format_check', 'preview_prepare', 'export_prepare',
    'retry_failed_job')),
  -- Idempotency: a duplicated submission resolves to the SAME batch rather than doing the work twice.
  request_key text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'partially_failed', 'failed', 'cancelled')),
  -- The database enforces the same ceiling the handler does, so bypassing the handler cannot unbound it.
  item_count integer NOT NULL CHECK (item_count > 0 AND item_count <= 50),
  succeeded integer NOT NULL DEFAULT 0 CHECK (succeeded >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT batch_request_key_not_blank CHECK (length(btrim(request_key)) > 0),
  UNIQUE (workspace_id, request_key)
);
CREATE INDEX batch_operations_project_idx ON batch_operations(project_id, created_at DESC);

CREATE TABLE batch_items (
  id uuid PRIMARY KEY DEFAULT canon.uuid_v7(),
  batch_id uuid NOT NULL REFERENCES batch_operations(id),
  -- Carried on the ITEM as well as the batch: per-item authorization is the rule, and an item row that
  -- could not be isolated on its own would make that rule unenforceable at the storage layer.
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  position integer NOT NULL CHECK (position >= 0),
  -- What the item refers to (a chapter number, an export target). Bounded text, never a payload.
  item_ref text NOT NULL,
  outcome text NOT NULL
    CHECK (outcome IN ('succeeded', 'failed', 'skipped', 'refused', 'cancelled')),
  -- A closed refusal code. Never an exception message, never provider text.
  code text,
  -- Whether a failure is SAFE to retry. An authorization or validation failure never is.
  retryable boolean NOT NULL DEFAULT false,
  -- A bounded per-item result summary: counts and codes, never manuscript text.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batch_item_ref_bounded CHECK (length(item_ref) BETWEEN 1 AND 200),
  CONSTRAINT batch_item_code_bounded CHECK (code IS NULL OR length(code) BETWEEN 1 AND 64),
  UNIQUE (batch_id, position)
);
CREATE INDEX batch_items_batch_idx ON batch_items(batch_id, position);

-- Batch results are a record of what happened. They are never rewritten or deleted.
CREATE OR REPLACE FUNCTION canon.batch_item_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM canon.raise_code('BATCH_ITEM_APPEND_ONLY', 'batch item results are append-only');
  RETURN NULL;
END $$;

CREATE TRIGGER batch_items_append_only
  BEFORE UPDATE OR DELETE ON batch_items
  FOR EACH ROW EXECUTE FUNCTION canon.batch_item_append_only();

-- An item may not be smuggled into another tenant's batch. This is the cross-tenant insertion the batch
-- authorization model refuses in the application; enforcing it here means a direct SQL path cannot do it
-- either.
CREATE OR REPLACE FUNCTION canon.batch_item_scope_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  v_workspace uuid;
  v_project uuid;
BEGIN
  SELECT workspace_id, project_id INTO v_workspace, v_project
    FROM batch_operations WHERE id = NEW.batch_id;
  IF v_workspace IS NULL THEN
    PERFORM canon.raise_code('BATCH_NOT_FOUND', 'the batch does not exist');
  END IF;
  IF v_workspace <> NEW.workspace_id OR v_project <> NEW.project_id THEN
    PERFORM canon.raise_code('BATCH_CROSS_TENANT',
      'an item may not belong to a different tenant or project than its batch');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER batch_items_scope BEFORE INSERT ON batch_items
  FOR EACH ROW EXECUTE FUNCTION canon.batch_item_scope_guard();

ALTER TABLE batch_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY batch_operations_workspace_isolation ON batch_operations
  USING (canon.workspace_visible(workspace_id))
  WITH CHECK (canon.workspace_visible(workspace_id));

ALTER TABLE batch_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE batch_items FORCE ROW LEVEL SECURITY;
CREATE POLICY batch_items_workspace_isolation ON batch_items
  USING (canon.workspace_visible(workspace_id))
  WITH CHECK (canon.workspace_visible(workspace_id));

-- ---------------------------------------------------------------------------------------------------------
-- 3. least-privilege grants (ADR-0050)
-- ---------------------------------------------------------------------------------------------------------
-- Previews and batches need UPDATE for their state transitions, which the triggers above constrain to the
-- legal ones. `batch_items` is append-only, so it gets INSERT and SELECT and nothing else -- the same
-- shape 0014 established for every other result-recording table. DELETE is granted nowhere here.
GRANT SELECT, INSERT, UPDATE ON regeneration_previews TO yeonjae_app;
GRANT SELECT, INSERT, UPDATE ON batch_operations TO yeonjae_app;
GRANT SELECT, INSERT ON batch_items TO yeonjae_app;

GRANT EXECUTE ON FUNCTION canon.preview_transition_guard() TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.preview_no_delete() TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.preview_scope_guard() TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.batch_item_append_only() TO yeonjae_app;
GRANT EXECUTE ON FUNCTION canon.batch_item_scope_guard() TO yeonjae_app;

-- Same reason as 0015, 0016 and 0017: a function CREATEd here is born PUBLIC-executable.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA canon FROM PUBLIC;

COMMENT ON TABLE regeneration_previews IS
  'Deterministic regeneration proposals (migration 0018). A preview NEVER mutates accepted content: the '
  'proposal lives in this table''s own columns, the table has no write path into manuscript_versions or '
  'canon, and canon.preview_transition_guard makes a resolved preview immutable. source_content_hash is '
  'what makes a stale proposal detectable at acceptance time. The cost figure is a simulated ESTIMATE '
  'from the local provider simulator and is never a provider charge.';
COMMENT ON TABLE batch_operations IS
  'Bounded batch operations (migration 0018). The size ceiling is a CHECK rather than only a handler '
  'rule, and each item carries its own workspace and project so per-item authorization and cross-tenant '
  'refusal are enforceable at the storage layer.';
COMMENT ON TABLE batch_items IS
  'Append-only per-item batch results (migration 0018). Results carry a closed refusal code and a '
  'retryable flag: an authorization or permanent validation failure is never marked retryable, which is '
  'what stops an automatic retry from re-attempting something that was refused on purpose.';
