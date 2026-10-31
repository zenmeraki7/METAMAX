-- METAMAX — Edit History Mutation Request Integrity
--
-- web/prisma/migrations/
-- 20261030130000_edit_history_mutation_requests/
-- migration.sql
--
-- PostgreSQL 15+
--
-- PREREQUISITES:
--   edit_history.operations
--   edit_history.changes
--   edit_history.snapshots
--   multi-resource uniqueness migration
--
-- Run in one migration transaction.
--
-- This introduces a mutation-level envelope.
-- It is NOT a second execution authority.
--
-- The existing Bulk Edit Engine remains the sole
-- authority for Shopify writes, claims and fencing.
--
-- No existing mirror.* tables are changed.

-- =====================================================
-- 1. PREREQUISITE VERIFICATION
-- =====================================================

DO $$
BEGIN
  IF to_regclass('edit_history.operations') IS NULL
     OR to_regclass('edit_history.changes') IS NULL
     OR to_regclass('edit_history.snapshots') IS NULL
  THEN
    RAISE EXCEPTION
      'Edit History base schema is incomplete';
  END IF;

  IF to_regclass('edit_history.mutation_requests') IS NOT NULL
  THEN
    RAISE EXCEPTION
      'mutation_requests already exists; inspect schema before migration';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'edit_history.changes'::regclass
      AND conname IN (
        'hist_changes_attempt_resource_field_unique',
        'eh_change_attempt_resource_field_unique'
      )
      AND contype = 'u'
  )
  THEN
    RAISE EXCEPTION
      'Multi-resource integrity migration is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'edit_history.operations'::regclass
      AND conname IN (
        'hist_operations_tenant_key',
        'eh_op_tenant_key'
      )
      AND contype = 'u'
  )
  THEN
    RAISE EXCEPTION
      'Expected tenant-scoped operation key is absent';
  END IF;
END;
$$;

-- =====================================================
-- 2. MUTATION REQUEST ENVELOPE
-- =====================================================
--
-- One row per logical mutation attempt.
--
-- A mutation request contains an ordered-independent
-- approved set of (resourceGid, fieldId) pairs.
--
-- The resource_field_set is a canonical sorted JSONB
-- array of objects:
--
-- [
--   {
--     "resourceGid": "...",
--     "fieldId": "..."
--   }
-- ]
--
-- The authoritative execution plan, not a caller,
-- determines this complete set.
--
-- Database constraints prove internal consistency.
-- They do not authenticate plan provenance.
--
-- Dispatch states distinguish:
--
-- PREPARED:
--   Complete journal has been durably admitted.
--
-- DISPATCH_AUTHORIZED:
--   Durable pre-dispatch handoff committed.
--   Shopify contact is not yet proven.
--
-- OUTCOME_UNKNOWN:
--   Submission/commit/outcome is uncertain.
--
-- ACKNOWLEDGED:
--   Authoritative executor recorded acknowledgement.
--
-- VERIFIED:
--   Field outcomes were verified.
--
-- FAILED_NO_WRITE:
--   Authoritative no-write evidence was established.
--
-- CONFLICT:
--   Conflicting authoritative observations.
--
-- Terminal classifications are not reopened.
-- Corrections must be append-only elsewhere.

CREATE TABLE edit_history.mutation_requests (
  id UUID PRIMARY KEY,

  shop_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  operation_id UUID NOT NULL,

  mutation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,

  execution_item_id BIGINT NOT NULL,
  execution_fence_epoch BIGINT NOT NULL,
  execution_claim_id TEXT NOT NULL,

  mutation_plan_fingerprint TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,

  resource_field_set JSONB NOT NULL,
  field_count INTEGER NOT NULL,

  request_state TEXT NOT NULL DEFAULT 'PREPARED',

  -- Stable handoff identity must also be understood
  -- by the existing Execution Engine's idempotency
  -- and recovery protocol.
  dispatch_handoff_key TEXT NOT NULL,

  -- Optional evidence of a previous dispatch attempt.
  -- This is not a bearer authorization token.
  dispatch_evidence_fingerprint TEXT,

  outcome_evidence_fingerprint TEXT,
  outcome_evidence_kind TEXT,

  prepared_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  dispatch_authorized_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  CONSTRAINT eh_request_operation_fk
    FOREIGN KEY (
      shop_id,
      installation_id,
      operation_id
    )
    REFERENCES edit_history.operations (
      shop_id,
      installation_id,
      id
    )
    ON DELETE RESTRICT,

  CONSTRAINT eh_request_tenant_key UNIQUE (
    shop_id,
    installation_id,
    id
  ),

  CONSTRAINT eh_request_operation_key UNIQUE (
    shop_id,
    installation_id,
    operation_id,
    id
  ),

  CONSTRAINT eh_request_attempt_unique UNIQUE (
    shop_id,
    installation_id,
    operation_id,
    mutation_id,
    attempt_id
  ),

  CONSTRAINT eh_request_number_unique UNIQUE (
    shop_id,
    installation_id,
    operation_id,
    mutation_id,
    attempt_number
  ),

  CONSTRAINT eh_request_handoff_unique UNIQUE (
    shop_id,
    installation_id,
    dispatch_handoff_key
  ),

  CONSTRAINT eh_request_identity CHECK (
    length(btrim(shop_id)) > 0
    AND length(btrim(installation_id)) > 0
    AND length(btrim(mutation_id)) > 0
    AND length(btrim(attempt_id)) > 0
    AND length(btrim(execution_claim_id)) > 0
    AND octet_length(dispatch_handoff_key)
      BETWEEN 1 AND 256
    AND dispatch_handoff_key =
      btrim(dispatch_handoff_key)
  ),

  CONSTRAINT eh_request_execution CHECK (
    execution_item_id > 0
    AND execution_fence_epoch > 0
    AND attempt_number BETWEEN 1 AND 1000000
  ),

  CONSTRAINT eh_request_field_count CHECK (
    field_count BETWEEN 1 AND 64
  ),

  CONSTRAINT eh_request_field_set_type CHECK (
    jsonb_typeof(resource_field_set) = 'array'
    AND jsonb_array_length(resource_field_set)
      = field_count
  ),

  CONSTRAINT eh_request_hashes CHECK (
    mutation_plan_fingerprint ~
      '^sha256:[0-9a-f]{64}$'
    AND request_fingerprint ~
      '^sha256:[0-9a-f]{64}$'
    AND (
      dispatch_evidence_fingerprint IS NULL
      OR dispatch_evidence_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    )
    AND (
      outcome_evidence_fingerprint IS NULL
      OR outcome_evidence_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    )
  ),

  CONSTRAINT eh_request_state CHECK (
    request_state IN (
      'PREPARED',
      'DISPATCH_AUTHORIZED',
      'OUTCOME_UNKNOWN',
      'ACKNOWLEDGED',
      'VERIFIED',
      'FAILED_NO_WRITE',
      'CONFLICT'
    )
  ),

  CONSTRAINT eh_request_evidence_kind CHECK (
    outcome_evidence_kind IS NULL
    OR outcome_evidence_kind IN (
      'AMBIGUOUS',
      'SHOPIFY_ACKNOWLEDGEMENT',
      'AUTHORITATIVE_NO_WRITE',
      'VERIFIED_OBSERVATION',
      'CONFLICT_OBSERVATION'
    )
  ),

  CONSTRAINT eh_request_outcome_evidence_pair CHECK (
    (
      outcome_evidence_kind IS NULL
      AND outcome_evidence_fingerprint IS NULL
    )
    OR (
      outcome_evidence_kind IS NOT NULL
      AND outcome_evidence_fingerprint IS NOT NULL
    )
  ),

  CONSTRAINT eh_request_dispatch_time CHECK (
    (request_state='FAILED_NO_WRITE' AND outcome_evidence_kind='AUTHORITATIVE_NO_WRITE')
    OR
    (
      request_state = 'PREPARED'
      AND dispatch_authorized_at IS NULL
    )
    OR (
      request_state <> 'PREPARED'
      AND dispatch_authorized_at IS NOT NULL
    )
  ),

  CONSTRAINT eh_request_verified_time CHECK (
    (
      request_state = 'VERIFIED'
      AND verified_at IS NOT NULL
    )
    OR request_state <> 'VERIFIED'
  ),

  CONSTRAINT eh_request_terminal_evidence CHECK (
    (
      request_state = 'VERIFIED'
      AND outcome_evidence_kind =
        'VERIFIED_OBSERVATION'
    )
    OR (
      request_state = 'FAILED_NO_WRITE'
      AND outcome_evidence_kind =
        'AUTHORITATIVE_NO_WRITE'
    )
    OR (
      request_state = 'CONFLICT'
      AND outcome_evidence_kind =
        'CONFLICT_OBSERVATION'
    )
    OR request_state NOT IN (
      'VERIFIED',
      'FAILED_NO_WRITE',
      'CONFLICT'
    )
  )
);

-- =====================================================
-- 3. VALIDATE COMPOSITE RESOURCE/FIELD SET
-- =====================================================
--
-- Enforce exact pair shape, uniqueness and ordering.
--
-- JSONB removes object-key order, but preserves array
-- order. The pair array must be ordered by
-- resourceGid COLLATE "C", then fieldId COLLATE "C".
--
-- Duplicate pairs are invalid.
--
-- Do not use fieldId alone as a key.

CREATE FUNCTION edit_history.validate_resource_field_set()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry JSONB;
  resource_id TEXT;
  field_id TEXT;

  previous_resource TEXT;
  previous_field TEXT;

  entry_count INTEGER := 0;
BEGIN
  IF jsonb_typeof(NEW.resource_field_set) <> 'array'
  THEN
    RAISE EXCEPTION
      'Resource field set must be a JSON array'
      USING ERRCODE = '23514';
  END IF;

  FOR entry IN
    SELECT value
    FROM jsonb_array_elements(
      NEW.resource_field_set
    )
  LOOP
    IF jsonb_typeof(entry) <> 'object'
      OR NOT (
        entry ? 'resourceGid'
        AND entry ? 'fieldId'
      )
      OR (
        SELECT count(*)
        FROM jsonb_object_keys(entry)
      ) <> 2
      OR jsonb_typeof(
        entry -> 'resourceGid'
      ) <> 'string'
      OR jsonb_typeof(
        entry -> 'fieldId'
      ) <> 'string'
    THEN
      RAISE EXCEPTION
        'Invalid resource field entry'
        USING ERRCODE = '23514';
    END IF;

    resource_id := entry ->> 'resourceGid';
    field_id := entry ->> 'fieldId';

    IF length(btrim(resource_id)) = 0
      OR length(btrim(field_id)) = 0
      OR octet_length(resource_id) > 512
      OR octet_length(field_id) > 512
    THEN
      RAISE EXCEPTION
        'Invalid resource or field identifier'
        USING ERRCODE = '23514';
    END IF;

    IF previous_resource IS NOT NULL
    THEN
      IF (resource_id COLLATE "C") < (previous_resource COLLATE "C")
        OR (
          (resource_id COLLATE "C") = (previous_resource COLLATE "C")
          AND (field_id COLLATE "C") <= (previous_field COLLATE "C")
        )
      THEN
        RAISE EXCEPTION
          'Resource field set must be sorted and unique'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    previous_resource := resource_id;
    previous_field := field_id;
    entry_count := entry_count + 1;
  END LOOP;

  IF entry_count <> NEW.field_count
  THEN
    RAISE EXCEPTION
      'Resource field count mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER eh_request_field_set_guard
BEFORE INSERT OR UPDATE OF
  resource_field_set,
  field_count
ON edit_history.mutation_requests
FOR EACH ROW
EXECUTE FUNCTION edit_history.validate_resource_field_set();

-- =====================================================
-- 4. IMMUTABLE REQUEST IDENTITY
-- =====================================================

CREATE FUNCTION edit_history.guard_mutation_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legal BOOLEAN;
BEGIN
  IF
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.shop_id IS DISTINCT FROM NEW.shop_id
    OR OLD.installation_id IS DISTINCT
      FROM NEW.installation_id
    OR OLD.operation_id IS DISTINCT
      FROM NEW.operation_id
    OR OLD.mutation_id IS DISTINCT FROM NEW.mutation_id
    OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
    OR OLD.attempt_number IS DISTINCT
      FROM NEW.attempt_number
    OR OLD.execution_item_id IS DISTINCT
      FROM NEW.execution_item_id
    OR OLD.execution_fence_epoch IS DISTINCT
      FROM NEW.execution_fence_epoch
    OR OLD.execution_claim_id IS DISTINCT
      FROM NEW.execution_claim_id
    OR OLD.mutation_plan_fingerprint IS DISTINCT
      FROM NEW.mutation_plan_fingerprint
    OR OLD.request_fingerprint IS DISTINCT
      FROM NEW.request_fingerprint
    OR OLD.resource_field_set IS DISTINCT
      FROM NEW.resource_field_set
    OR OLD.field_count IS DISTINCT FROM NEW.field_count
    OR OLD.dispatch_handoff_key IS DISTINCT
      FROM NEW.dispatch_handoff_key
    OR OLD.prepared_at IS DISTINCT FROM NEW.prepared_at
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION
      'Mutation request identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.request_state IN (
    'VERIFIED',
    'FAILED_NO_WRITE',
    'CONFLICT'
  )
  THEN
    RAISE EXCEPTION
      'Terminal mutation request cannot be updated'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.dispatch_evidence_fingerprint IS NOT NULL
    AND OLD.dispatch_evidence_fingerprint IS DISTINCT
      FROM NEW.dispatch_evidence_fingerprint
  THEN
    RAISE EXCEPTION
      'Dispatch evidence cannot be replaced'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.request_state IS DISTINCT FROM NEW.request_state
  THEN
    legal := CASE OLD.request_state
      WHEN 'PREPARED' THEN
        NEW.request_state IN ('DISPATCH_AUTHORIZED','FAILED_NO_WRITE')

      WHEN 'DISPATCH_AUTHORIZED' THEN
        NEW.request_state IN (
          'OUTCOME_UNKNOWN',
          'ACKNOWLEDGED',
          'FAILED_NO_WRITE'
        )

      WHEN 'OUTCOME_UNKNOWN' THEN
        NEW.request_state IN (
          'ACKNOWLEDGED',
          'VERIFIED',
          'FAILED_NO_WRITE',
          'CONFLICT'
        )

      WHEN 'ACKNOWLEDGED' THEN
        NEW.request_state IN (
          'OUTCOME_UNKNOWN',
          'VERIFIED',
          'CONFLICT'
        )

      ELSE FALSE
    END;

    IF NOT legal
    THEN
      RAISE EXCEPTION
        'Illegal mutation request transition: % -> %',
        OLD.request_state,
        NEW.request_state
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.request_state = 'OUTCOME_UNKNOWN'
    AND NEW.outcome_evidence_kind
      IS DISTINCT FROM 'AMBIGUOUS'
  THEN
    RAISE EXCEPTION
      'Unknown outcome requires ambiguous evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.request_state = 'ACKNOWLEDGED'
    AND NEW.outcome_evidence_kind
      IS DISTINCT FROM 'SHOPIFY_ACKNOWLEDGEMENT'
  THEN
    RAISE EXCEPTION
      'Acknowledgement requires evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.request_state = 'VERIFIED'
    AND NEW.outcome_evidence_kind
      IS DISTINCT FROM 'VERIFIED_OBSERVATION'
  THEN
    RAISE EXCEPTION
      'Verified outcome requires observation evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.request_state = 'FAILED_NO_WRITE'
    AND NEW.outcome_evidence_kind
      IS DISTINCT FROM 'AUTHORITATIVE_NO_WRITE'
  THEN
    RAISE EXCEPTION
      'No-write failure requires authoritative evidence'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.request_state = 'CONFLICT'
    AND NEW.outcome_evidence_kind
      IS DISTINCT FROM 'CONFLICT_OBSERVATION'
  THEN
    RAISE EXCEPTION
      'Conflict requires observation evidence'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER eh_request_update_guard
BEFORE UPDATE
ON edit_history.mutation_requests
FOR EACH ROW
EXECUTE FUNCTION edit_history.guard_mutation_request();

-- =====================================================
-- 5. REQUEST-TO-CHANGE CONSISTENCY
-- =====================================================
--
-- This trigger proves local row-set consistency after
-- a transaction has inserted the request and all its
-- associated field-level change rows.
--
-- It is deferred until transaction commit.
--
-- It verifies:
-- - exact count
-- - exact resource/field pairs
-- - shared attempt identity
-- - same execution item
-- - same fence and claim
-- - same mutation plan fingerprint
--
-- It does NOT authenticate the approved execution plan.
-- The repository must compare the envelope to the
-- authoritative plan while holding execution ownership.

CREATE FUNCTION edit_history.assert_request_changes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_request edit_history.mutation_requests%ROWTYPE;
  actual_pairs JSONB;
  actual_count INTEGER;
  inconsistent_count INTEGER;
BEGIN
  SELECT *
    INTO current_request
  FROM edit_history.mutation_requests
  WHERE id = NEW.id
    AND shop_id = NEW.shop_id
    AND installation_id = NEW.installation_id;

  IF NOT FOUND
  THEN
    RETURN NULL;
  END IF;

  SELECT
    count(*)::integer,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'resourceGid', resource_gid,
          'fieldId', field_id
        )
        ORDER BY resource_gid COLLATE "C",
                 field_id COLLATE "C"
      ),
      '[]'::jsonb
    )
  INTO actual_count, actual_pairs
  FROM edit_history.changes
  WHERE shop_id = current_request.shop_id
    AND installation_id =
      current_request.installation_id
    AND operation_id = current_request.operation_id
    AND mutation_id = current_request.mutation_id
    AND attempt_id = current_request.attempt_id;

  IF actual_count <> current_request.field_count
    OR actual_pairs IS DISTINCT FROM
      current_request.resource_field_set
  THEN
    RAISE EXCEPTION
      'Mutation request does not match complete journal field set'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer
    INTO inconsistent_count
  FROM edit_history.changes c
  WHERE c.shop_id = current_request.shop_id
    AND c.installation_id =
      current_request.installation_id
    AND c.operation_id = current_request.operation_id
    AND c.mutation_id = current_request.mutation_id
    AND c.attempt_id = current_request.attempt_id
    AND (
      c.attempt_number IS DISTINCT FROM
        current_request.attempt_number
      OR c.execution_item_id IS DISTINCT FROM
        current_request.execution_item_id
      OR c.execution_fence_epoch IS DISTINCT FROM
        current_request.execution_fence_epoch
      OR c.execution_claim_id IS DISTINCT FROM
        current_request.execution_claim_id
      OR c.mutation_plan_fingerprint IS DISTINCT FROM
        current_request.mutation_plan_fingerprint
    );

  IF inconsistent_count <> 0
  THEN
    RAISE EXCEPTION
      'Mutation request and journal attempt coordinates disagree'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER eh_request_changes_commit
AFTER INSERT OR UPDATE
ON edit_history.mutation_requests
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION edit_history.assert_request_changes();

-- Trigger on changes so subsequent inserts/updates/deletes
-- cannot invalidate an existing envelope without rechecking it.

CREATE FUNCTION edit_history.assert_changes_request_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_shop TEXT;
  target_installation TEXT;
  target_operation UUID;
  target_mutation TEXT;
  target_attempt TEXT;
  current_request edit_history.mutation_requests%ROWTYPE;
  actual_pairs JSONB;
  actual_count INTEGER;
  inconsistent_count INTEGER;
BEGIN
  -- Maintenance marks the operation before bounded deletion starts. Runtime
  -- roles cannot set this marker or delete history. Deferred DELETE checks must
  -- permit a partially purged envelope across committed maintenance batches.
  IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM edit_history.operations o
    WHERE o.shop_id=OLD.shop_id AND o.installation_id=OLD.installation_id AND o.id=OLD.operation_id
    AND to_jsonb(o)->>'purge_requested_at' IS NOT NULL) THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN
    target_shop := OLD.shop_id;
    target_installation := OLD.installation_id;
    target_operation := OLD.operation_id;
    target_mutation := OLD.mutation_id;
    target_attempt := OLD.attempt_id;
  ELSE
    target_shop := NEW.shop_id;
    target_installation := NEW.installation_id;
    target_operation := NEW.operation_id;
    target_mutation := NEW.mutation_id;
    target_attempt := NEW.attempt_id;
  END IF;

  SELECT *
    INTO current_request
  FROM edit_history.mutation_requests
  WHERE shop_id = target_shop
    AND installation_id = target_installation
    AND operation_id = target_operation
    AND mutation_id = target_mutation
    AND attempt_id = target_attempt;

  IF NOT FOUND THEN
    -- If request envelope is not yet inserted in this transaction,
    -- the deferred trigger on mutation_requests will assert consistency at commit.
    RETURN NULL;
  END IF;

  SELECT
    count(*)::integer,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'resourceGid', resource_gid,
          'fieldId', field_id
        )
        ORDER BY resource_gid COLLATE "C",
                 field_id COLLATE "C"
      ),
      '[]'::jsonb
    )
  INTO actual_count, actual_pairs
  FROM edit_history.changes
  WHERE shop_id = current_request.shop_id
    AND installation_id = current_request.installation_id
    AND operation_id = current_request.operation_id
    AND mutation_id = current_request.mutation_id
    AND attempt_id = current_request.attempt_id;

  IF actual_count <> current_request.field_count
    OR actual_pairs IS DISTINCT FROM current_request.resource_field_set
  THEN
    RAISE EXCEPTION
      'Mutation request does not match complete journal field set'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer
    INTO inconsistent_count
  FROM edit_history.changes c
  WHERE c.shop_id = current_request.shop_id
    AND c.installation_id = current_request.installation_id
    AND c.operation_id = current_request.operation_id
    AND c.mutation_id = current_request.mutation_id
    AND c.attempt_id = current_request.attempt_id
    AND (
      c.attempt_number IS DISTINCT FROM current_request.attempt_number
      OR c.execution_item_id IS DISTINCT FROM current_request.execution_item_id
      OR c.execution_fence_epoch IS DISTINCT FROM current_request.execution_fence_epoch
      OR c.execution_claim_id IS DISTINCT FROM current_request.execution_claim_id
      OR c.mutation_plan_fingerprint IS DISTINCT FROM current_request.mutation_plan_fingerprint
    );

  IF inconsistent_count <> 0
  THEN
    RAISE EXCEPTION
      'Mutation request and journal attempt coordinates disagree'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER eh_changes_request_commit
AFTER INSERT OR UPDATE OR DELETE
ON edit_history.changes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION edit_history.assert_changes_request_consistency();

-- =====================================================
-- 6. INDEXES FOR REQUEST-LEVEL RECOVERY
-- =====================================================

CREATE INDEX eh_request_operation_idx
ON edit_history.mutation_requests (
  shop_id,
  installation_id,
  operation_id,
  created_at DESC,
  id
);

CREATE INDEX eh_request_recovery_idx
ON edit_history.mutation_requests (
  updated_at,
  id
)
WHERE request_state IN (
  'DISPATCH_AUTHORIZED',
  'OUTCOME_UNKNOWN',
  'ACKNOWLEDGED'
);

-- =====================================================
-- 7. RETENTION GUARD
-- =====================================================

CREATE TRIGGER eh_request_no_delete
BEFORE DELETE
ON edit_history.mutation_requests
FOR EACH ROW
EXECUTE FUNCTION edit_history.reject_history_delete();

-- =====================================================
-- 8. SECURITY / INTEGRATION CONTRACT
-- =====================================================
--
-- The History Repository must:
--
-- 1. Verify the authenticated installation.
-- 2. Lock the authoritative execution job.
-- 3. Load the complete approved plan.
-- 4. Normalize each resource/field composite identity.
-- 5. Verify all snapshot and mutation intent evidence.
-- 6. Insert the mutation request, changes and BEFORE
--    snapshots in one database transaction.
-- 7. Commit successfully before Shopify dispatch.
-- 8. Record DISPATCH_AUTHORIZED using the stable
--    dispatch_handoff_key.
-- 9. Reconcile any uncertain dispatch commit with the
--    existing execution engine. Never blindly resend.
-- 10. Persist authoritative mutation outcomes.
--
-- No caller-supplied fingerprint, receipt or handoff
-- identity is sufficient evidence by itself.
--
-- LIMITATIONS:
-- - No cross-schema Mirror Engine FK is invented.
-- - SQL cannot prove receipt authenticity.
-- - SQL cannot prove an external Shopify call occurred.
-- - This migration does not implement execution outbox.
-- - History must not independently call Shopify.
--
-- END MIGRATION

