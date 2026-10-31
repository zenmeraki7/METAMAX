-- Edit History V2 upgrade from EMPTY V1. History Contract V3.
-- V1 is preserved and actually applied; no table/data drops or invented backfills.
-- Populated V1 requires a separate provenance-aware data migration and is rejected.
-- Generated from the reviewed V1 and V2 sources by build-history-v2-upgrade.js.
-- V2 SHA256: 721d213185b1092dd16575f5cbecebd6d852ff66ed321bcd885ef7b1da9c393d
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
LOCK TABLE edit_history.operations, edit_history.changes, edit_history.snapshots, edit_history.undo_requests, edit_history.recovery_tasks IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM edit_history.operations) THEN
    RAISE EXCEPTION 'V2 upgrade requires empty V1 history; preserve legacy records and migrate authenticated provenance first' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM edit_history.changes) THEN
    RAISE EXCEPTION 'V2 upgrade requires empty V1 history; preserve legacy records and migrate authenticated provenance first' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM edit_history.snapshots) THEN
    RAISE EXCEPTION 'V2 upgrade requires empty V1 history; preserve legacy records and migrate authenticated provenance first' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM edit_history.undo_requests) THEN
    RAISE EXCEPTION 'V2 upgrade requires empty V1 history; preserve legacy records and migrate authenticated provenance first' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM edit_history.recovery_tasks) THEN
    RAISE EXCEPTION 'V2 upgrade requires empty V1 history; preserve legacy records and migrate authenticated provenance first' USING ERRCODE='55000';
  END IF;
END $$;

DROP TRIGGER hist_snapshots_no_update ON edit_history.snapshots;
DROP TRIGGER hist_operations_protect_identity ON edit_history.operations;
DROP TRIGGER hist_changes_protect_identity ON edit_history.changes;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_change_operation_fk;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_change_operation_fk;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_undo_operation_fk;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_operation_fk;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_operation_fk;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_change_fk;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_original_operation_fk;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_operation_fk;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_change_fk;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_undo_fk;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_operation_identity_unique;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_operation_identity_unique;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_shop_nonempty;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_install_nonempty;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_job_positive;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_edit_positive;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_contract_nonempty;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_version;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_scheme;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_kind;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_state;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_actor_type;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_fingerprint;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_filter_fingerprint;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_approval_fingerprint;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_counts;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_completed_after_creation;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_retention_after_creation;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_tenant_key;
ALTER TABLE edit_history.operations DROP CONSTRAINT hist_operations_execution_unique;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_tenant_key;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_execution_item_positive;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_attempt_number;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_fence_positive;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_identifiers;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_fingerprints;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_evidence_fingerprint;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_state;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_verification_state;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_evidence_kind;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_evidence_pair;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_terminal_evidence;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_time_order;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_attempt_field_unique;
ALTER TABLE edit_history.changes DROP CONSTRAINT hist_changes_attempt_number_unique;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_tenant_key;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_version;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_fingerprint_scheme;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_kind;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_value_kind;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_encoding;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_value_storage;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_absent_encoding;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_fingerprints;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_observation_nonempty;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_source;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_binding_mode;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_complete_binding;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_mirror_reference_positive;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_before_source_only;
ALTER TABLE edit_history.snapshots DROP CONSTRAINT hist_snapshots_observation_unique;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_tenant_key;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_idempotency_unique;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_request_fingerprint;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_preflight_fingerprint;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_plan_fingerprint;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_idempotency_nonempty;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_state;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_conflict_policy;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_approval_pair;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_execution_job_positive;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_claim_pair;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_fence_nonnegative;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_retries_nonnegative;
ALTER TABLE edit_history.undo_requests DROP CONSTRAINT hist_undo_completed_after_creation;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_tenant_key;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_dedupe;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_dedupe_nonempty;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_kind;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_state;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_evidence_fingerprint;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_attempt_budget;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_fence_nonnegative;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_claim_pair;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_terminal_claim;
ALTER TABLE edit_history.recovery_tasks DROP CONSTRAINT hist_recovery_completed_after_creation;
DROP INDEX edit_history.hist_operations_history_page_idx;
DROP INDEX edit_history.hist_operations_edit_reference_idx;
DROP INDEX edit_history.hist_operations_contract_reference_idx;
DROP INDEX edit_history.hist_operations_retention_idx;
DROP INDEX edit_history.hist_changes_operation_page_idx;
DROP INDEX edit_history.hist_changes_resource_history_idx;
DROP INDEX edit_history.hist_changes_family_idx;
DROP INDEX edit_history.hist_changes_unknown_idx;
DROP INDEX edit_history.hist_changes_item_reference_idx;
DROP INDEX edit_history.hist_snapshots_one_before_idx;
DROP INDEX edit_history.hist_snapshots_change_idx;
DROP INDEX edit_history.hist_snapshots_mirror_source_idx;
DROP INDEX edit_history.hist_undo_history_page_idx;
DROP INDEX edit_history.hist_undo_original_operation_idx;
DROP INDEX edit_history.hist_undo_ready_idx;
DROP INDEX edit_history.hist_undo_expired_claim_idx;
DROP INDEX edit_history.hist_recovery_queue_idx;
DROP INDEX edit_history.hist_recovery_expired_claim_idx;
DROP INDEX edit_history.hist_recovery_operation_idx;
DROP INDEX edit_history.hist_recovery_change_idx;
DROP INDEX edit_history.hist_recovery_undo_idx;
DROP FUNCTION edit_history.reject_snapshot_update();
DROP FUNCTION edit_history.protect_operation_identity();
DROP FUNCTION edit_history.protect_change_identity();
ALTER TABLE edit_history.snapshots ADD COLUMN resource_gid TEXT NOT NULL;
ALTER TABLE edit_history.snapshots ADD COLUMN field_id TEXT NOT NULL;
ALTER TABLE edit_history.snapshots ADD COLUMN filter_fingerprint TEXT NOT NULL;
ALTER TABLE edit_history.snapshots ADD COLUMN execution_fingerprint TEXT NOT NULL;
ALTER TABLE edit_history.snapshots ADD COLUMN field_resolution_fingerprint TEXT NOT NULL;
ALTER TABLE edit_history.undo_requests ADD COLUMN handoff_key TEXT NOT NULL;

CREATE SCHEMA IF NOT EXISTS edit_history;





ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_tenant_nonempty CHECK (
    length(btrim(shop_id)) > 0
    AND length(btrim(installation_id)) > 0
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_engine_ids CHECK (
    execution_job_id > 0
    AND (edit_operation_id IS NULL OR edit_operation_id > 0)
    AND (
      execution_contract_id IS NULL
      OR length(btrim(execution_contract_id)) > 0
    )
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_version CHECK (
    contract_version = 3
    AND fingerprint_scheme = 'metamax-history-sha256-v3'
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_kind CHECK (
    operation_kind IN (
      'BULK_EDIT',
      'IMPORT',
      'SCHEDULED_EDIT',
      'RECURRING_EDIT',
      'UNDO'
    )
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_state CHECK (
    operation_state IN (
      'RECORDING',
      'ACTIVE',
      'RECONCILING',
      'COMPLETED',
      'PARTIAL',
      'FAILED',
      'CANCELLED'
    )
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_actor CHECK (
    actor_type IN ('MERCHANT','SYSTEM','SCHEDULE','API')
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_fingerprints CHECK (
    execution_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND (
      filter_fingerprint IS NULL
      OR filter_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
    AND (
      approved_contract_fingerprint IS NULL
      OR approved_contract_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_counts CHECK (
    changes_recorded >= 0
    AND changes_verified >= 0
    AND changes_failed >= 0
    AND changes_uncertain >= 0
    AND changes_verified + changes_failed +
        changes_uncertain <= changes_recorded
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_completion CHECK (
    (
      operation_state IN (
        'COMPLETED','PARTIAL','FAILED','CANCELLED'
      )
      AND completed_at IS NOT NULL
    )
    OR (
      operation_state NOT IN (
        'COMPLETED','PARTIAL','FAILED','CANCELLED'
      )
      AND completed_at IS NULL
    )
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_times CHECK (
    (completed_at IS NULL OR completed_at >= created_at)
    AND (
      retained_until IS NULL
      OR retained_until > created_at
    )
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_tenant_key UNIQUE (
    shop_id, installation_id, id
  );
ALTER TABLE edit_history.operations ADD CONSTRAINT eh_op_execution_unique UNIQUE (
    shop_id, installation_id, execution_job_id
  );

CREATE INDEX eh_op_history_idx
  ON edit_history.operations (
    shop_id, installation_id, created_at DESC, id DESC
  );

CREATE INDEX eh_op_edit_idx
  ON edit_history.operations (
    shop_id, installation_id, edit_operation_id
  )
  WHERE edit_operation_id IS NOT NULL;

CREATE INDEX eh_op_contract_idx
  ON edit_history.operations (
    shop_id, installation_id, execution_contract_id
  )
  WHERE execution_contract_id IS NOT NULL;

CREATE INDEX eh_op_retention_idx
  ON edit_history.operations (retained_until, id)
  WHERE retained_until IS NOT NULL
    AND legal_hold = FALSE;
















ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_operation_fk
    FOREIGN KEY (
      shop_id, installation_id, operation_id
    )
    REFERENCES edit_history.operations (
      shop_id, installation_id, id
    )
    ON DELETE RESTRICT;
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_tenant_key UNIQUE (
    shop_id, installation_id, id
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_operation_key UNIQUE (
    shop_id, installation_id, operation_id, id
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_engine_id CHECK (
    execution_item_id > 0
    AND attempt_number BETWEEN 1 AND 1000000
    AND execution_fence_epoch > 0
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_ids CHECK (
    length(btrim(mutation_id)) > 0
    AND length(btrim(attempt_id)) > 0
    AND length(btrim(execution_claim_id)) > 0
    AND length(btrim(resource_gid)) > 0
    AND length(btrim(resource_family_gid)) > 0
    AND length(btrim(field_id)) > 0
    AND length(btrim(field_definition_revision)) > 0
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_hashes CHECK (
    mutation_plan_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND intended_value_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND before_snapshot_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND (
      last_evidence_fingerprint IS NULL
      OR last_evidence_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_state CHECK (
    mutation_state IN (
      'PREPARED',
      'DISPATCHING',
      'OUTCOME_UNKNOWN',
      'ACKNOWLEDGED',
      'VERIFIED',
      'FAILED_NO_WRITE',
      'CONFLICT'
    )
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_verification CHECK (
    verification_state IN (
      'NOT_CHECKED',
      'PENDING',
      'MATCHED',
      'MISMATCHED',
      'INCONCLUSIVE'
    )
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_evidence_kind CHECK (
    last_evidence_kind IS NULL
    OR last_evidence_kind IN (
      'NONE',
      'AMBIGUOUS',
      'SHOPIFY_ACKNOWLEDGEMENT',
      'AUTHORITATIVE_NO_WRITE',
      'VERIFIED_OBSERVATION',
      'CONFLICT_OBSERVATION'
    )
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_evidence_pair CHECK (
    (last_evidence_kind IS NULL)
      = (last_evidence_fingerprint IS NULL)
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_dispatch_evidence CHECK (
    mutation_state NOT IN ('OUTCOME_UNKNOWN', 'ACKNOWLEDGED')
    OR (
      last_evidence_kind IS NOT NULL
      AND last_evidence_kind = CASE mutation_state
        WHEN 'OUTCOME_UNKNOWN' THEN 'AMBIGUOUS'
        WHEN 'ACKNOWLEDGED' THEN 'SHOPIFY_ACKNOWLEDGEMENT'
      END
    )
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_outcome_evidence CHECK (
    (
    (
      mutation_state = 'VERIFIED'
      AND verification_state = 'MATCHED'
      AND last_evidence_kind = 'VERIFIED_OBSERVATION'
      AND verified_at IS NOT NULL
    )
    OR (
      mutation_state = 'FAILED_NO_WRITE'
      AND last_evidence_kind = 'AUTHORITATIVE_NO_WRITE'
    )
    OR (
      mutation_state = 'CONFLICT'
      AND verification_state = 'MISMATCHED'
      AND last_evidence_kind = 'CONFLICT_OBSERVATION'
    )
    OR mutation_state NOT IN (
      'VERIFIED','FAILED_NO_WRITE','CONFLICT'
    )
    ) IS TRUE
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_times CHECK (
    (dispatch_started_at IS NULL
      OR dispatch_started_at >= prepared_at)
    AND (acknowledged_at IS NULL
      OR acknowledged_at >= prepared_at)
    AND (verified_at IS NULL
      OR verified_at >= prepared_at)
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_attempt_field_unique UNIQUE (
    shop_id, installation_id, operation_id,
    mutation_id, attempt_id, field_id
  );
ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_attempt_number_unique UNIQUE (
    shop_id, installation_id, operation_id,
    mutation_id, attempt_number, field_id
  );

CREATE INDEX eh_change_operation_idx
  ON edit_history.changes (
    shop_id, installation_id, operation_id,
    prepared_at, id
  );

CREATE INDEX eh_change_resource_idx
  ON edit_history.changes (
    shop_id, installation_id, resource_gid,
    prepared_at DESC, id DESC
  );

CREATE INDEX eh_change_family_idx
  ON edit_history.changes (
    shop_id, installation_id, resource_family_gid,
    prepared_at DESC
  );

CREATE INDEX eh_change_unknown_idx
  ON edit_history.changes (
    shop_id, installation_id, updated_at, id
  )
  WHERE mutation_state = 'OUTCOME_UNKNOWN';

CREATE INDEX eh_change_execution_item_idx
  ON edit_history.changes (
    shop_id, installation_id, execution_item_id
  );




















ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_change_operation_fk
    FOREIGN KEY (
      shop_id, installation_id, operation_id, change_id
    )
    REFERENCES edit_history.changes (
      shop_id, installation_id, operation_id, id
    )
    ON DELETE RESTRICT;
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_tenant_key UNIQUE (
    shop_id, installation_id, id
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_version CHECK (
    snapshot_version = 3
    AND fingerprint_scheme = 'metamax-history-sha256-v3'
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_kind CHECK (
    snapshot_kind IN ('BEFORE','OBSERVED_AFTER')
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_value_kind CHECK (
    value_kind IN ('VALUE','ABSENT')
    AND value_encoding IN ('JSONB','ENCRYPTED_JSON')
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_storage CHECK (
    (
      value_kind = 'ABSENT'
      AND value_encoding = 'JSONB'
      AND value_json IS NULL
      AND encrypted_value IS NULL
      AND encryption_key_reference IS NULL
    )
    OR (
      value_kind = 'VALUE'
      AND (
        (
          value_encoding = 'JSONB'
          AND value_json IS NOT NULL
          AND encrypted_value IS NULL
          AND encryption_key_reference IS NULL
        )
        OR (
          value_encoding = 'ENCRYPTED_JSON'
          AND value_json IS NULL
          AND encrypted_value IS NOT NULL
          AND encryption_key_reference IS NOT NULL
        )
      )
    )
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_hashes CHECK (
    snapshot_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND evidence_binding_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND observation_receipt_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND filter_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND execution_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND field_resolution_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_identity CHECK (
    length(btrim(observation_id)) > 0
    AND length(btrim(observation_receipt_id)) > 0
    AND length(btrim(resource_gid)) > 0
    AND length(btrim(field_id)) > 0
    AND length(btrim(field_definition_revision)) > 0
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_source CHECK (
    observation_source IN (
      'SHOPIFY_GRAPHQL',
      'MIRROR_PINNED',
      'EXECUTION_SNAPSHOT'
    )
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_binding CHECK (
    (
      binding_mode = 'MIRROR_PINNED'
      AND observation_source = 'MIRROR_PINNED'
      AND nullif(btrim(generation_id), '') IS NOT NULL
      AND nullif(btrim(coverage_revision), '') IS NOT NULL
      AND nullif(btrim(mapping_version), '') IS NOT NULL
      AND execution_snapshot_id IS NULL
    )
    OR (
      binding_mode = 'SHOPIFY_DIRECT'
      AND observation_source = 'SHOPIFY_GRAPHQL'
      AND generation_id IS NULL
      AND coverage_revision IS NULL
      AND mapping_version IS NULL
      AND execution_snapshot_id IS NULL
    )
    OR (
      binding_mode = 'EXECUTION_SNAPSHOT'
      AND observation_source = 'EXECUTION_SNAPSHOT'
      AND generation_id IS NULL
      AND coverage_revision IS NULL
      AND mapping_version IS NULL
      AND nullif(btrim(execution_snapshot_id), '')
          IS NOT NULL
    )
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_mirror_reference CHECK (
    mirror_before_snapshot_id IS NULL
    OR (
      mirror_before_snapshot_id > 0
      AND snapshot_kind = 'BEFORE'
    )
  );
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_observation_unique UNIQUE (
    shop_id, installation_id, change_id,
    snapshot_kind, observation_id
  );

CREATE UNIQUE INDEX eh_snapshot_one_before_idx
  ON edit_history.snapshots (
    shop_id, installation_id, change_id
  )
  WHERE snapshot_kind = 'BEFORE';

CREATE INDEX eh_snapshot_change_idx
  ON edit_history.snapshots (
    shop_id, installation_id, change_id,
    observed_at, id
  );

CREATE INDEX eh_snapshot_mirror_reference_idx
  ON edit_history.snapshots (
    shop_id, installation_id, mirror_before_snapshot_id
  )
  WHERE mirror_before_snapshot_id IS NOT NULL;
































CREATE FUNCTION edit_history.assert_change_before_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_change edit_history.changes%ROWTYPE;
  matching_count INTEGER;
BEGIN
  
  
  SELECT *
    INTO current_change
  FROM edit_history.changes
  WHERE id = NEW.id
    AND shop_id = NEW.shop_id
    AND installation_id = NEW.installation_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*)::integer
    INTO matching_count
  FROM edit_history.snapshots s
  WHERE s.shop_id = current_change.shop_id
    AND s.installation_id = current_change.installation_id
    AND s.operation_id = current_change.operation_id
    AND s.change_id = current_change.id
    AND s.snapshot_kind = 'BEFORE'
    AND s.snapshot_fingerprint =
        current_change.before_snapshot_fingerprint
    AND s.resource_gid = current_change.resource_gid
    AND s.field_id = current_change.field_id
    AND s.field_definition_revision =
        current_change.field_definition_revision;

  IF matching_count <> 1 THEN
    RAISE EXCEPTION
      'Change % requires one matching BEFORE snapshot',
      current_change.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER eh_change_requires_before
AFTER INSERT OR UPDATE ON edit_history.changes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION edit_history.assert_change_before_snapshot();





CREATE FUNCTION edit_history.reject_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Edit history snapshots are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER eh_snapshot_no_update
BEFORE UPDATE ON edit_history.snapshots
FOR EACH ROW
EXECUTE FUNCTION edit_history.reject_snapshot_mutation();

CREATE TRIGGER eh_snapshot_no_delete
BEFORE DELETE ON edit_history.snapshots
FOR EACH ROW
EXECUTE FUNCTION edit_history.reject_snapshot_mutation();
















CREATE FUNCTION edit_history.guard_change_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  legal BOOLEAN := FALSE;
BEGIN
  IF
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.shop_id IS DISTINCT FROM NEW.shop_id
    OR OLD.installation_id IS DISTINCT FROM NEW.installation_id
    OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.execution_item_id IS DISTINCT FROM NEW.execution_item_id
    OR OLD.mutation_id IS DISTINCT FROM NEW.mutation_id
    OR OLD.attempt_id IS DISTINCT FROM NEW.attempt_id
    OR OLD.attempt_number IS DISTINCT FROM NEW.attempt_number
    OR OLD.execution_fence_epoch
       IS DISTINCT FROM NEW.execution_fence_epoch
    OR OLD.execution_claim_id
       IS DISTINCT FROM NEW.execution_claim_id
    OR OLD.resource_gid IS DISTINCT FROM NEW.resource_gid
    OR OLD.resource_family_gid
       IS DISTINCT FROM NEW.resource_family_gid
    OR OLD.field_id IS DISTINCT FROM NEW.field_id
    OR OLD.field_definition_revision
       IS DISTINCT FROM NEW.field_definition_revision
    OR OLD.mutation_plan_fingerprint
       IS DISTINCT FROM NEW.mutation_plan_fingerprint
    OR OLD.intended_value_fingerprint
       IS DISTINCT FROM NEW.intended_value_fingerprint
    OR OLD.before_snapshot_fingerprint
       IS DISTINCT FROM NEW.before_snapshot_fingerprint
    OR OLD.prepared_at IS DISTINCT FROM NEW.prepared_at
  THEN
    RAISE EXCEPTION
      'Edit history change identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  
  
  IF OLD.mutation_state IN (
    'VERIFIED','FAILED_NO_WRITE','CONFLICT'
  ) THEN
    IF
      OLD.mutation_state IS DISTINCT FROM NEW.mutation_state
      OR OLD.verification_state
         IS DISTINCT FROM NEW.verification_state
      OR OLD.last_evidence_kind
         IS DISTINCT FROM NEW.last_evidence_kind
      OR OLD.last_evidence_fingerprint
         IS DISTINCT FROM NEW.last_evidence_fingerprint
      OR OLD.outcome_code IS DISTINCT FROM NEW.outcome_code
      OR OLD.verified_at IS DISTINCT FROM NEW.verified_at
    THEN
      RAISE EXCEPTION
        'Terminal change classification cannot be rewritten'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  
  IF OLD.mutation_state IS DISTINCT FROM NEW.mutation_state
  THEN
    legal := CASE OLD.mutation_state
      WHEN 'PREPARED' THEN
        NEW.mutation_state IN (
          'DISPATCHING','FAILED_NO_WRITE'
        )
      WHEN 'DISPATCHING' THEN
        NEW.mutation_state IN (
          'OUTCOME_UNKNOWN',
          'ACKNOWLEDGED',
          'FAILED_NO_WRITE'
        )
      WHEN 'OUTCOME_UNKNOWN' THEN
        NEW.mutation_state IN (
          'ACKNOWLEDGED',
          'VERIFIED',
          'FAILED_NO_WRITE',
          'CONFLICT'
        )
      WHEN 'ACKNOWLEDGED' THEN
        NEW.mutation_state IN (
          'OUTCOME_UNKNOWN',
          'VERIFIED',
          'CONFLICT'
        )
      ELSE FALSE
    END;

    IF NOT legal THEN
      RAISE EXCEPTION
        'Illegal history transition: % -> %',
        OLD.mutation_state, NEW.mutation_state
        USING ERRCODE = '23514';
    END IF;

    IF (
      (NEW.mutation_state = 'OUTCOME_UNKNOWN'
        AND NEW.last_evidence_kind IS DISTINCT FROM 'AMBIGUOUS')
      OR
      (NEW.mutation_state = 'ACKNOWLEDGED'
        AND NEW.last_evidence_kind IS DISTINCT FROM
          'SHOPIFY_ACKNOWLEDGEMENT')
      OR
      (NEW.mutation_state = 'VERIFIED'
        AND NEW.last_evidence_kind IS DISTINCT FROM
          'VERIFIED_OBSERVATION')
      OR
      (NEW.mutation_state = 'FAILED_NO_WRITE'
        AND NEW.last_evidence_kind IS DISTINCT FROM
          'AUTHORITATIVE_NO_WRITE')
      OR
      (NEW.mutation_state = 'CONFLICT'
        AND NEW.last_evidence_kind IS DISTINCT FROM
          'CONFLICT_OBSERVATION')
    ) THEN
      RAISE EXCEPTION
        'Mutation transition lacks matching evidence type'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER eh_change_guard
BEFORE UPDATE ON edit_history.changes
FOR EACH ROW
EXECUTE FUNCTION edit_history.guard_change_update();





CREATE FUNCTION edit_history.guard_operation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.shop_id IS DISTINCT FROM NEW.shop_id
    OR OLD.installation_id IS DISTINCT FROM NEW.installation_id
    OR OLD.execution_job_id IS DISTINCT FROM NEW.execution_job_id
    OR OLD.edit_operation_id IS DISTINCT FROM NEW.edit_operation_id
    OR OLD.execution_contract_id
       IS DISTINCT FROM NEW.execution_contract_id
    OR OLD.contract_version IS DISTINCT FROM NEW.contract_version
    OR OLD.fingerprint_scheme IS DISTINCT FROM NEW.fingerprint_scheme
    OR OLD.operation_kind IS DISTINCT FROM NEW.operation_kind
    OR OLD.execution_fingerprint
       IS DISTINCT FROM NEW.execution_fingerprint
    OR OLD.filter_fingerprint
       IS DISTINCT FROM NEW.filter_fingerprint
    OR OLD.approved_contract_fingerprint
       IS DISTINCT FROM NEW.approved_contract_fingerprint
    OR OLD.field_mapping_version
       IS DISTINCT FROM NEW.field_mapping_version
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION
      'Edit history operation identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.operation_state IN (
    'COMPLETED','PARTIAL','FAILED','CANCELLED'
  ) AND OLD.operation_state IS DISTINCT FROM NEW.operation_state
  THEN
    RAISE EXCEPTION
      'Terminal history operation cannot be reopened'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER eh_operation_guard
BEFORE UPDATE ON edit_history.operations
FOR EACH ROW
EXECUTE FUNCTION edit_history.guard_operation_update();



















ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_operation_fk
    FOREIGN KEY (
      shop_id, installation_id, original_operation_id
    )
    REFERENCES edit_history.operations (
      shop_id, installation_id, id
    )
    ON DELETE RESTRICT;
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_tenant_key UNIQUE (
    shop_id, installation_id, id
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_operation_key UNIQUE (
    shop_id, installation_id, original_operation_id, id
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_idempotency UNIQUE (
    shop_id, installation_id, idempotency_key
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_handoff_unique UNIQUE (
    shop_id, installation_id, handoff_key
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_request_hash CHECK (
    request_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    AND (
      preflight_fingerprint IS NULL
      OR preflight_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
    AND (
      inverse_plan_fingerprint IS NULL
      OR inverse_plan_fingerprint ~ '^sha256:[0-9a-f]{64}$'
    )
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_key_sizes CHECK (
    octet_length(idempotency_key) BETWEEN 1 AND 128
    AND octet_length(handoff_key) BETWEEN 1 AND 256
    AND idempotency_key = btrim(idempotency_key)
    AND handoff_key = btrim(handoff_key)
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_state CHECK (
    undo_state IN (
      'REQUESTED',
      'PREFLIGHTING',
      'CONFLICT',
      'READY_FOR_REVIEW',
      'APPROVED',
      'SUBMITTING',
      'OUTCOME_UNKNOWN',
      'EXECUTING',
      'VERIFYING',
      'COMPLETED',
      'PARTIAL',
      'FAILED',
      'CANCELLED'
    )
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_policy CHECK (
    conflict_policy IN (
      'ABORT_ON_CONFLICT',
      'SKIP_CONFLICTED'
    )
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_approval CHECK (
    (
      approval_reference IS NULL
      AND approved_at IS NULL
    )
    OR (
      approval_reference IS NOT NULL
      AND approved_at IS NOT NULL
      AND inverse_plan_fingerprint IS NOT NULL
      AND preflight_fingerprint IS NOT NULL
    )
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_execution_id CHECK (
    execution_job_id IS NULL OR execution_job_id > 0
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_claim CHECK (
    (
      claimed_by IS NULL
      AND claim_token IS NULL
      AND claim_expires_at IS NULL
    )
    OR (
      claimed_by IS NOT NULL
      AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND fence_epoch > 0
    )
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_retry CHECK (
    retry_count >= 0 AND fence_epoch >= 0
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_terminal_claim CHECK (
    undo_state NOT IN (
      'CONFLICT','COMPLETED','PARTIAL','FAILED','CANCELLED'
    )
    OR (
      claimed_by IS NULL
      AND claim_token IS NULL
      AND claim_expires_at IS NULL
    )
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_completed CHECK (
    (
      undo_state IN (
        'CONFLICT','COMPLETED','PARTIAL','FAILED','CANCELLED'
      )
      AND completed_at IS NOT NULL
    )
    OR (
      undo_state NOT IN (
        'CONFLICT','COMPLETED','PARTIAL','FAILED','CANCELLED'
      )
      AND completed_at IS NULL
    )
  );
ALTER TABLE edit_history.undo_requests ADD CONSTRAINT eh_undo_time CHECK (
    completed_at IS NULL OR completed_at >= created_at
  );

CREATE UNIQUE INDEX eh_undo_execution_job_unique
  ON edit_history.undo_requests (
    shop_id, installation_id, execution_job_id
  )
  WHERE execution_job_id IS NOT NULL;

CREATE INDEX eh_undo_history_idx
  ON edit_history.undo_requests (
    shop_id, installation_id, created_at DESC, id DESC
  );

CREATE INDEX eh_undo_original_idx
  ON edit_history.undo_requests (
    shop_id, installation_id, original_operation_id
  );

CREATE INDEX eh_undo_ready_idx
  ON edit_history.undo_requests (
    next_attempt_at, created_at, id
  )
  WHERE undo_state IN (
    'REQUESTED','PREFLIGHTING',
    'SUBMITTING','OUTCOME_UNKNOWN'
  );

CREATE INDEX eh_undo_expired_claim_idx
  ON edit_history.undo_requests (
    claim_expires_at, id
  )
  WHERE claim_token IS NOT NULL;


CREATE FUNCTION edit_history.guard_undo_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    OLD.id IS DISTINCT FROM NEW.id
    OR OLD.shop_id IS DISTINCT FROM NEW.shop_id
    OR OLD.installation_id IS DISTINCT FROM NEW.installation_id
    OR OLD.original_operation_id
       IS DISTINCT FROM NEW.original_operation_id
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.request_fingerprint
       IS DISTINCT FROM NEW.request_fingerprint
    OR OLD.handoff_key IS DISTINCT FROM NEW.handoff_key
    OR OLD.conflict_policy IS DISTINCT FROM NEW.conflict_policy
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION
      'Undo request identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.execution_job_id IS NOT NULL AND (
    OLD.execution_job_id IS DISTINCT FROM NEW.execution_job_id
    OR OLD.execution_contract_id
       IS DISTINCT FROM NEW.execution_contract_id
  ) THEN
    RAISE EXCEPTION
      'Undo execution handoff cannot be replaced'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.undo_state IN (
    'CONFLICT','COMPLETED','PARTIAL','FAILED','CANCELLED'
  ) AND (
    OLD.undo_state IS DISTINCT FROM NEW.undo_state
    OR OLD.execution_job_id IS DISTINCT FROM NEW.execution_job_id
    OR OLD.inverse_plan_fingerprint
       IS DISTINCT FROM NEW.inverse_plan_fingerprint
  ) THEN
    RAISE EXCEPTION
      'Terminal undo request cannot be reopened'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.approved_at IS NOT NULL AND (
    OLD.approved_at IS DISTINCT FROM NEW.approved_at
    OR OLD.approval_reference IS DISTINCT FROM NEW.approval_reference
    OR OLD.inverse_plan_fingerprint
       IS DISTINCT FROM NEW.inverse_plan_fingerprint
    OR OLD.preflight_fingerprint
       IS DISTINCT FROM NEW.preflight_fingerprint
  ) THEN
    RAISE EXCEPTION
      'Approved undo plan cannot be changed'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER eh_undo_guard
BEFORE UPDATE ON edit_history.undo_requests
FOR EACH ROW
EXECUTE FUNCTION edit_history.guard_undo_update();















ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_operation_fk
    FOREIGN KEY (
      shop_id, installation_id, operation_id
    )
    REFERENCES edit_history.operations (
      shop_id, installation_id, id
    )
    ON DELETE RESTRICT;
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_change_fk
    FOREIGN KEY (
      shop_id, installation_id, operation_id, change_id
    )
    REFERENCES edit_history.changes (
      shop_id, installation_id, operation_id, id
    )
    ON DELETE RESTRICT;
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_undo_fk
    FOREIGN KEY (
      shop_id, installation_id, operation_id, undo_request_id
    )
    REFERENCES edit_history.undo_requests (
      shop_id, installation_id, original_operation_id, id
    )
    ON DELETE RESTRICT;
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_tenant_key UNIQUE (
    shop_id, installation_id, id
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_dedupe UNIQUE (
    shop_id, installation_id, task_kind, dedupe_key
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_key CHECK (
    octet_length(dedupe_key) BETWEEN 1 AND 512
    AND dedupe_key = btrim(dedupe_key)
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_kind CHECK (
    task_kind IN (
      'MUTATION_OUTCOME',
      'SNAPSHOT_VERIFICATION',
      'EVIDENCE_RECONCILIATION',
      'UNDO_HANDOFF',
      'UNDO_VERIFICATION',
      'RETENTION_DEPENDENCY'
    )
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_targets CHECK (
    (
      task_kind IN (
        'MUTATION_OUTCOME',
        'SNAPSHOT_VERIFICATION',
        'EVIDENCE_RECONCILIATION'
      )
      AND change_id IS NOT NULL
      AND undo_request_id IS NULL
    )
    OR (
      task_kind IN (
        'UNDO_HANDOFF','UNDO_VERIFICATION'
      )
      AND change_id IS NULL
      AND undo_request_id IS NOT NULL
    )
    OR (
      task_kind = 'RETENTION_DEPENDENCY'
      AND change_id IS NULL
      AND undo_request_id IS NULL
    )
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_state CHECK (
    task_state IN (
      'PENDING',
      'RECONCILING',
      'RETRY_WAIT',
      'COMPLETED',
      'REVIEW_REQUIRED',
      'CANCELLED'
    )
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_evidence CHECK (
    evidence_fingerprint IS NULL
    OR evidence_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_attempts CHECK (
    attempt_count >= 0
    AND max_attempts BETWEEN 1 AND 1000
    AND fence_epoch >= 0
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_claim CHECK (
    (
      task_state = 'RECONCILING'
      AND claimed_by IS NOT NULL
      AND claim_token IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND fence_epoch > 0
    )
    OR (
      task_state <> 'RECONCILING'
      AND claimed_by IS NULL
      AND claim_token IS NULL
      AND claim_expires_at IS NULL
    )
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_completed CHECK (
    (
      task_state IN (
        'COMPLETED','REVIEW_REQUIRED','CANCELLED'
      )
      AND completed_at IS NOT NULL
    )
    OR (
      task_state NOT IN (
        'COMPLETED','REVIEW_REQUIRED','CANCELLED'
      )
      AND completed_at IS NULL
    )
  );
ALTER TABLE edit_history.recovery_tasks ADD CONSTRAINT eh_recovery_times CHECK (
    completed_at IS NULL OR completed_at >= created_at
  );

CREATE INDEX eh_recovery_ready_idx
  ON edit_history.recovery_tasks (
    available_at, created_at, id
  )
  WHERE task_state IN ('PENDING','RETRY_WAIT');

CREATE INDEX eh_recovery_expired_idx
  ON edit_history.recovery_tasks (
    claim_expires_at, id
  )
  WHERE task_state = 'RECONCILING';

CREATE INDEX eh_recovery_operation_idx
  ON edit_history.recovery_tasks (
    shop_id, installation_id, operation_id
  );

CREATE INDEX eh_recovery_change_idx
  ON edit_history.recovery_tasks (
    shop_id, installation_id, change_id
  )
  WHERE change_id IS NOT NULL;

CREATE INDEX eh_recovery_undo_idx
  ON edit_history.recovery_tasks (
    shop_id, installation_id, undo_request_id
  )
  WHERE undo_request_id IS NOT NULL;






















CREATE FUNCTION edit_history.reject_history_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Direct edit history deletion is prohibited'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER eh_operations_no_delete
BEFORE DELETE ON edit_history.operations
FOR EACH ROW
EXECUTE FUNCTION edit_history.reject_history_delete();

CREATE TRIGGER eh_changes_no_delete
BEFORE DELETE ON edit_history.changes
FOR EACH ROW
EXECUTE FUNCTION edit_history.reject_history_delete();

CREATE TRIGGER eh_undo_no_delete
BEFORE DELETE ON edit_history.undo_requests
FOR EACH ROW
EXECUTE FUNCTION edit_history.reject_history_delete();

CREATE TRIGGER eh_recovery_no_delete
BEFORE DELETE ON edit_history.recovery_tasks
FOR EACH ROW
EXECUTE FUNCTION edit_history.reject_history_delete();
COMMIT;
