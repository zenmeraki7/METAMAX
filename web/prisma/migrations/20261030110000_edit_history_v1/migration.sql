-- METAMAX — Edit History Schema V1
--
-- web/prisma/migrations/
--   20261030110000_edit_history_v1/migration.sql
--
-- PostgreSQL 15+.
--
-- Assumed existing Mirror Engine references:
--
-- mirror.job_commands.id        BIGINT
-- mirror.edit_operations.id     BIGINT
-- mirror.job_items.id           BIGINT
-- mirror.product_snapshots.id   BIGINT
-- mirror.execution_contracts.id TEXT
--
-- Existing Mirror tables are NOT modified.
--
-- Cross-schema foreign keys intentionally deferred:
-- their tenant-scoped candidate keys have not been
-- verified against the actual deployed schema.
--
-- All history-owned foreign keys include:
--   shop_id, installation_id
--
-- The application must never accept tenant identity,
-- execution ownership or lease authority from a browser.
--
-- A migration transaction is managed by the migration
-- runner. Do not manually add BEGIN/COMMIT around this
-- file unless required by your migration tooling.

CREATE SCHEMA IF NOT EXISTS edit_history;

-- ======================================================
-- 1. OPERATIONS
-- ======================================================
--
-- One history operation for an original Bulk Edit Engine
-- operation. It does not replace mirror.job_commands or
-- mirror.edit_operations.
--
-- References are typed to match existing Mirror tables.
-- Their tenant ownership must be verified by the
-- integration service.
--
-- installation_id is REQUIRED on every history row.
-- This is a future-proof installation binding inside
-- history, not proof that Mirror Engine already enforces
-- an equivalent installation foreign key.

CREATE TABLE edit_history.operations (
  id UUID PRIMARY KEY,

  shop_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,

  execution_job_id BIGINT NOT NULL,
  edit_operation_id BIGINT,
  execution_contract_id TEXT,

  contract_version INTEGER NOT NULL DEFAULT 3,
  fingerprint_scheme TEXT NOT NULL
    DEFAULT 'metamax-history-sha256-v3',

  operation_kind TEXT NOT NULL,
  operation_state TEXT NOT NULL DEFAULT 'RECORDING',

  execution_fingerprint TEXT NOT NULL,
  filter_fingerprint TEXT,
  approved_contract_fingerprint TEXT,

  field_mapping_version TEXT,

  actor_type TEXT NOT NULL DEFAULT 'SYSTEM',
  actor_reference TEXT,

  changes_recorded BIGINT NOT NULL DEFAULT 0,
  changes_verified BIGINT NOT NULL DEFAULT 0,
  changes_failed BIGINT NOT NULL DEFAULT 0,
  changes_uncertain BIGINT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,

  retained_until TIMESTAMPTZ,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,

  CONSTRAINT hist_operations_shop_nonempty
    CHECK (length(btrim(shop_id)) > 0),

  CONSTRAINT hist_operations_install_nonempty
    CHECK (length(btrim(installation_id)) > 0),

  CONSTRAINT hist_operations_job_positive
    CHECK (execution_job_id > 0),

  CONSTRAINT hist_operations_edit_positive
    CHECK (
      edit_operation_id IS NULL
      OR edit_operation_id > 0
    ),

  CONSTRAINT hist_operations_contract_nonempty
    CHECK (
      execution_contract_id IS NULL
      OR length(btrim(execution_contract_id)) > 0
    ),

  CONSTRAINT hist_operations_version
    CHECK (contract_version = 3),

  CONSTRAINT hist_operations_scheme
    CHECK (
      fingerprint_scheme =
        'metamax-history-sha256-v3'
    ),

  CONSTRAINT hist_operations_kind
    CHECK (
      operation_kind IN (
        'BULK_EDIT',
        'IMPORT',
        'SCHEDULED_EDIT',
        'RECURRING_EDIT',
        'UNDO'
      )
    ),

  CONSTRAINT hist_operations_state
    CHECK (
      operation_state IN (
        'RECORDING',
        'ACTIVE',
        'RECONCILING',
        'COMPLETED',
        'PARTIAL',
        'FAILED',
        'CANCELLED'
      )
    ),

  CONSTRAINT hist_operations_actor_type
    CHECK (
      actor_type IN (
        'MERCHANT',
        'SYSTEM',
        'SCHEDULE',
        'API'
      )
    ),

  CONSTRAINT hist_operations_fingerprint
    CHECK (
      execution_fingerprint ~
      '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_operations_filter_fingerprint
    CHECK (
      filter_fingerprint IS NULL
      OR filter_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_operations_approval_fingerprint
    CHECK (
      approved_contract_fingerprint IS NULL
      OR approved_contract_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_operations_counts
    CHECK (
      changes_recorded >= 0
      AND changes_verified >= 0
      AND changes_failed >= 0
      AND changes_uncertain >= 0
      AND changes_verified +
          changes_failed +
          changes_uncertain <= changes_recorded
    ),

  CONSTRAINT hist_operations_completed_after_creation
    CHECK (
      completed_at IS NULL
      OR completed_at >= created_at
    ),

  CONSTRAINT hist_operations_retention_after_creation
    CHECK (
      retained_until IS NULL
      OR retained_until > created_at
    ),

  CONSTRAINT hist_operations_tenant_key
    UNIQUE (shop_id, installation_id, id),

  CONSTRAINT hist_operations_execution_unique
    UNIQUE (
      shop_id,
      installation_id,
      execution_job_id
    )
);

CREATE INDEX hist_operations_history_page_idx
  ON edit_history.operations (
    shop_id,
    installation_id,
    created_at DESC,
    id DESC
  );

CREATE INDEX hist_operations_edit_reference_idx
  ON edit_history.operations (
    shop_id,
    installation_id,
    edit_operation_id
  )
  WHERE edit_operation_id IS NOT NULL;

CREATE INDEX hist_operations_contract_reference_idx
  ON edit_history.operations (
    shop_id,
    installation_id,
    execution_contract_id
  )
  WHERE execution_contract_id IS NOT NULL;

CREATE INDEX hist_operations_retention_idx
  ON edit_history.operations (retained_until, id)
  WHERE retained_until IS NOT NULL
    AND legal_hold = FALSE;

-- ======================================================
-- 2. CHANGES
-- ======================================================
--
-- One row per logical mutation attempt AND field.
--
-- Example:
-- One Shopify mutation request changes price and SKU.
-- Both field entries may share mutation_id / attempt_id,
-- but have different field_id values.
--
-- The execution attempt and fence are recorded here.
-- The actual authoritative fence remains on
-- mirror.job_commands.
--
-- Repeated attempts never overwrite earlier attempt rows.
--
-- No-write failure requires trusted evidence validation
-- at the repository layer. CHECK constraints alone cannot
-- authenticate external Shopify evidence.

CREATE TABLE edit_history.changes (
  id UUID PRIMARY KEY,

  shop_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,

  operation_id UUID NOT NULL,

  execution_item_id BIGINT NOT NULL,

  mutation_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,

  execution_fence_epoch BIGINT NOT NULL,
  execution_claim_id TEXT NOT NULL,

  resource_gid TEXT NOT NULL,
  resource_family_gid TEXT NOT NULL,
  field_id TEXT NOT NULL,
  field_definition_revision TEXT NOT NULL,

  mutation_plan_fingerprint TEXT NOT NULL,
  intended_value_fingerprint TEXT NOT NULL,

  before_snapshot_fingerprint TEXT NOT NULL,

  mutation_state TEXT NOT NULL DEFAULT 'PREPARED',
  verification_state TEXT NOT NULL DEFAULT 'NOT_CHECKED',

  last_evidence_kind TEXT,
  last_evidence_fingerprint TEXT,

  outcome_code TEXT,

  prepared_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  dispatch_started_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,

  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  CONSTRAINT hist_changes_operation_fk
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

  CONSTRAINT hist_changes_tenant_key
    UNIQUE (
      shop_id,
      installation_id,
      id
    ),

  CONSTRAINT hist_changes_execution_item_positive
    CHECK (execution_item_id > 0),

  CONSTRAINT hist_changes_attempt_number
    CHECK (
      attempt_number >= 1
      AND attempt_number <= 1000000
    ),

  CONSTRAINT hist_changes_fence_positive
    CHECK (execution_fence_epoch > 0),

  CONSTRAINT hist_changes_identifiers
    CHECK (
      length(btrim(mutation_id)) > 0
      AND length(btrim(attempt_id)) > 0
      AND length(btrim(execution_claim_id)) > 0
      AND length(btrim(resource_gid)) > 0
      AND length(btrim(resource_family_gid)) > 0
      AND length(btrim(field_id)) > 0
      AND length(btrim(field_definition_revision)) > 0
    ),

  CONSTRAINT hist_changes_fingerprints
    CHECK (
      mutation_plan_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
      AND intended_value_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
      AND before_snapshot_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_changes_evidence_fingerprint
    CHECK (
      last_evidence_fingerprint IS NULL
      OR last_evidence_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_changes_state
    CHECK (
      mutation_state IN (
        'PREPARED',
        'DISPATCHING',
        'OUTCOME_UNKNOWN',
        'ACKNOWLEDGED',
        'VERIFIED',
        'FAILED_NO_WRITE',
        'CONFLICT'
      )
    ),

  CONSTRAINT hist_changes_verification_state
    CHECK (
      verification_state IN (
        'NOT_CHECKED',
        'PENDING',
        'MATCHED',
        'MISMATCHED',
        'INCONCLUSIVE'
      )
    ),

  CONSTRAINT hist_changes_evidence_kind
    CHECK (
      last_evidence_kind IS NULL
      OR last_evidence_kind IN (
        'NONE',
        'AMBIGUOUS',
        'SHOPIFY_ACKNOWLEDGEMENT',
        'AUTHORITATIVE_NO_WRITE',
        'VERIFIED_OBSERVATION',
        'CONFLICT_OBSERVATION'
      )
    ),

  CONSTRAINT hist_changes_evidence_pair
    CHECK (
      (
        last_evidence_kind IS NULL
        AND last_evidence_fingerprint IS NULL
      )
      OR
      (
        last_evidence_kind IS NOT NULL
        AND last_evidence_fingerprint IS NOT NULL
      )
    ),

  CONSTRAINT hist_changes_terminal_evidence
    CHECK (
      (
        mutation_state = 'VERIFIED'
        AND verification_state = 'MATCHED'
        AND last_evidence_kind = 'VERIFIED_OBSERVATION'
      )
      OR
      (
        mutation_state = 'FAILED_NO_WRITE'
        AND last_evidence_kind = 'AUTHORITATIVE_NO_WRITE'
      )
      OR
      (
        mutation_state = 'CONFLICT'
        AND verification_state = 'MISMATCHED'
        AND last_evidence_kind = 'CONFLICT_OBSERVATION'
      )
      OR mutation_state NOT IN (
        'VERIFIED',
        'FAILED_NO_WRITE',
        'CONFLICT'
      )
    ),

  CONSTRAINT hist_changes_time_order
    CHECK (
      (
        dispatch_started_at IS NULL
        OR dispatch_started_at >= prepared_at
      )
      AND (
        acknowledged_at IS NULL
        OR acknowledged_at >= prepared_at
      )
      AND (
        verified_at IS NULL
        OR verified_at >= prepared_at
      )
    ),

  CONSTRAINT hist_changes_attempt_field_unique
    UNIQUE (
      shop_id,
      installation_id,
      operation_id,
      mutation_id,
      attempt_id,
      field_id
    ),

  CONSTRAINT hist_changes_attempt_number_unique
    UNIQUE (
      shop_id,
      installation_id,
      operation_id,
      mutation_id,
      attempt_number,
      field_id
    )
);

CREATE INDEX hist_changes_operation_page_idx
  ON edit_history.changes (
    shop_id,
    installation_id,
    operation_id,
    prepared_at,
    id
  );

CREATE INDEX hist_changes_resource_history_idx
  ON edit_history.changes (
    shop_id,
    installation_id,
    resource_gid,
    prepared_at DESC,
    id DESC
  );

CREATE INDEX hist_changes_family_idx
  ON edit_history.changes (
    shop_id,
    installation_id,
    resource_family_gid,
    prepared_at DESC
  );

CREATE INDEX hist_changes_unknown_idx
  ON edit_history.changes (
    shop_id,
    installation_id,
    updated_at,
    id
  )
  WHERE mutation_state = 'OUTCOME_UNKNOWN';

CREATE INDEX hist_changes_item_reference_idx
  ON edit_history.changes (
    shop_id,
    installation_id,
    execution_item_id
  );

-- ======================================================
-- 3. SNAPSHOTS
-- ======================================================
--
-- Stores field-level snapshots only.
-- No unrestricted whole-product payload copies.
--
-- Existing mirror.product_snapshots may remain the source
-- of the BEFORE observation. The optional BIGINT reference
-- retains exact lineage.
--
-- Snapshot kinds:
--   BEFORE
--   OBSERVED_AFTER
--
-- Multiple after observations can be represented by
-- different observation IDs. Do not overwrite evidence.
--
-- value_kind distinguishes:
--   VALUE (including JSON null)
--   ABSENT (no JSON value)
--
-- Important:
-- PostgreSQL JSONB generally preserves JSON semantics,
-- but it is NOT a byte-for-byte archive of canonical JSON.
-- The contract fingerprint must be computed on canonical
-- input before writing, with a version-specific reader.
--
-- Snapshot contents must be encrypted/redacted at the
-- service boundary when required by sensitivity policy.

CREATE TABLE edit_history.snapshots (
  id UUID PRIMARY KEY,

  shop_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,

  operation_id UUID NOT NULL,
  change_id UUID NOT NULL,

  snapshot_version INTEGER NOT NULL DEFAULT 3,
  fingerprint_scheme TEXT NOT NULL
    DEFAULT 'metamax-history-sha256-v3',

  snapshot_kind TEXT NOT NULL,
  value_kind TEXT NOT NULL,

  value_encoding TEXT NOT NULL DEFAULT 'JSONB',
  value_json JSONB,
  encrypted_value BYTEA,
  encryption_key_reference TEXT,

  snapshot_fingerprint TEXT NOT NULL,
  evidence_binding_fingerprint TEXT NOT NULL,

  observation_id TEXT NOT NULL,
  observation_source TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,

  source_revision TEXT,
  observation_receipt_id TEXT NOT NULL,
  observation_receipt_fingerprint TEXT NOT NULL,

  field_definition_revision TEXT NOT NULL,

  binding_mode TEXT NOT NULL,
  generation_id TEXT,
  coverage_revision TEXT,
  mapping_version TEXT,
  execution_snapshot_id TEXT,

  mirror_before_snapshot_id BIGINT,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  CONSTRAINT hist_snapshots_operation_fk
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

  CONSTRAINT hist_snapshots_change_fk
    FOREIGN KEY (
      shop_id,
      installation_id,
      change_id
    )
    REFERENCES edit_history.changes (
      shop_id,
      installation_id,
      id
    )
    ON DELETE RESTRICT,

  CONSTRAINT hist_snapshots_tenant_key
    UNIQUE (
      shop_id,
      installation_id,
      id
    ),

  CONSTRAINT hist_snapshots_version
    CHECK (snapshot_version = 3),

  CONSTRAINT hist_snapshots_fingerprint_scheme
    CHECK (
      fingerprint_scheme =
        'metamax-history-sha256-v3'
    ),

  CONSTRAINT hist_snapshots_kind
    CHECK (
      snapshot_kind IN (
        'BEFORE',
        'OBSERVED_AFTER'
      )
    ),

  CONSTRAINT hist_snapshots_value_kind
    CHECK (
      value_kind IN (
        'VALUE',
        'ABSENT'
      )
    ),

  CONSTRAINT hist_snapshots_encoding
    CHECK (
      value_encoding IN (
        'JSONB',
        'ENCRYPTED_JSON'
      )
    ),

  CONSTRAINT hist_snapshots_value_storage
    CHECK (
      (
        value_kind = 'ABSENT'
        AND value_json IS NULL
        AND encrypted_value IS NULL
      )
      OR
      (
        value_kind = 'VALUE'
        AND (
          (
            value_encoding = 'JSONB'
            AND value_json IS NOT NULL
            AND encrypted_value IS NULL
            AND encryption_key_reference IS NULL
          )
          OR
          (
            value_encoding = 'ENCRYPTED_JSON'
            AND value_json IS NULL
            AND encrypted_value IS NOT NULL
            AND encryption_key_reference IS NOT NULL
          )
        )
      )
    ),

  CONSTRAINT hist_snapshots_absent_encoding
    CHECK (
      value_kind <> 'ABSENT'
      OR (
        value_encoding = 'JSONB'
        AND encryption_key_reference IS NULL
      )
    ),

  CONSTRAINT hist_snapshots_fingerprints
    CHECK (
      snapshot_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
      AND evidence_binding_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
      AND observation_receipt_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_snapshots_observation_nonempty
    CHECK (
      length(btrim(observation_id)) > 0
      AND length(btrim(observation_receipt_id)) > 0
      AND length(btrim(field_definition_revision)) > 0
    ),

  CONSTRAINT hist_snapshots_source
    CHECK (
      observation_source IN (
        'SHOPIFY_GRAPHQL',
        'MIRROR_PINNED',
        'EXECUTION_SNAPSHOT'
      )
    ),

  CONSTRAINT hist_snapshots_binding_mode
    CHECK (
      binding_mode IN (
        'MIRROR_PINNED',
        'SHOPIFY_DIRECT',
        'EXECUTION_SNAPSHOT'
      )
    ),

  CONSTRAINT hist_snapshots_complete_binding
    CHECK (
      (
        binding_mode = 'MIRROR_PINNED'
        AND observation_source = 'MIRROR_PINNED'
        AND generation_id IS NOT NULL
        AND coverage_revision IS NOT NULL
        AND mapping_version IS NOT NULL
        AND execution_snapshot_id IS NULL
      )
      OR
      (
        binding_mode = 'SHOPIFY_DIRECT'
        AND observation_source = 'SHOPIFY_GRAPHQL'
        AND generation_id IS NULL
        AND coverage_revision IS NULL
        AND mapping_version IS NULL
        AND execution_snapshot_id IS NULL
      )
      OR
      (
        binding_mode = 'EXECUTION_SNAPSHOT'
        AND observation_source = 'EXECUTION_SNAPSHOT'
        AND generation_id IS NULL
        AND coverage_revision IS NULL
        AND mapping_version IS NULL
        AND execution_snapshot_id IS NOT NULL
      )
    ),

  CONSTRAINT hist_snapshots_mirror_reference_positive
    CHECK (
      mirror_before_snapshot_id IS NULL
      OR mirror_before_snapshot_id > 0
    ),

  CONSTRAINT hist_snapshots_before_source_only
    CHECK (
      mirror_before_snapshot_id IS NULL
      OR snapshot_kind = 'BEFORE'
    ),

  CONSTRAINT hist_snapshots_observation_unique
    UNIQUE (
      shop_id,
      installation_id,
      change_id,
      snapshot_kind,
      observation_id
    )
);

CREATE UNIQUE INDEX hist_snapshots_one_before_idx
  ON edit_history.snapshots (
    shop_id,
    installation_id,
    change_id
  )
  WHERE snapshot_kind = 'BEFORE';

CREATE INDEX hist_snapshots_change_idx
  ON edit_history.snapshots (
    shop_id,
    installation_id,
    change_id,
    observed_at,
    id
  );

CREATE INDEX hist_snapshots_mirror_source_idx
  ON edit_history.snapshots (
    shop_id,
    installation_id,
    mirror_before_snapshot_id
  )
  WHERE mirror_before_snapshot_id IS NOT NULL;

-- ======================================================
-- 4. UNDO REQUESTS
-- ======================================================
--
-- Durable undo intent, not a second mutation executor.
--
-- The undo service creates an immutable inverse plan,
-- records its fingerprint, obtains approval and submits
-- through the existing Bulk Edit Execution Engine.
--
-- A single idempotency key is unique within one
-- shop + installation.
--
-- Undo request ownership remains distinct from actual
-- execution ownership and fencing on mirror.job_commands.

CREATE TABLE edit_history.undo_requests (
  id UUID PRIMARY KEY,

  shop_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,

  original_operation_id UUID NOT NULL,

  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,

  undo_state TEXT NOT NULL DEFAULT 'REQUESTED',

  conflict_policy TEXT NOT NULL
    DEFAULT 'ABORT_ON_CONFLICT',

  preflight_fingerprint TEXT,
  inverse_plan_fingerprint TEXT,

  approval_reference TEXT,
  approved_at TIMESTAMPTZ,

  execution_job_id BIGINT,
  execution_contract_id TEXT,

  claimed_by TEXT,
  claim_token UUID,
  fence_epoch BIGINT NOT NULL DEFAULT 0,
  claim_expires_at TIMESTAMPTZ,

  retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,

  failure_code TEXT,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  completed_at TIMESTAMPTZ,

  CONSTRAINT hist_undo_original_operation_fk
    FOREIGN KEY (
      shop_id,
      installation_id,
      original_operation_id
    )
    REFERENCES edit_history.operations (
      shop_id,
      installation_id,
      id
    )
    ON DELETE RESTRICT,

  CONSTRAINT hist_undo_tenant_key
    UNIQUE (
      shop_id,
      installation_id,
      id
    ),

  CONSTRAINT hist_undo_idempotency_unique
    UNIQUE (
      shop_id,
      installation_id,
      idempotency_key
    ),

  CONSTRAINT hist_undo_request_fingerprint
    CHECK (
      request_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_undo_preflight_fingerprint
    CHECK (
      preflight_fingerprint IS NULL
      OR preflight_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_undo_plan_fingerprint
    CHECK (
      inverse_plan_fingerprint IS NULL
      OR inverse_plan_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_undo_idempotency_nonempty
    CHECK (
      length(btrim(idempotency_key)) > 0
      AND octet_length(idempotency_key) <= 128
    ),

  CONSTRAINT hist_undo_state
    CHECK (
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
    ),

  CONSTRAINT hist_undo_conflict_policy
    CHECK (
      conflict_policy IN (
        'ABORT_ON_CONFLICT',
        'SKIP_CONFLICTED'
      )
    ),

  CONSTRAINT hist_undo_approval_pair
    CHECK (
      (
        approval_reference IS NULL
        AND approved_at IS NULL
      )
      OR
      (
        approval_reference IS NOT NULL
        AND approved_at IS NOT NULL
      )
    ),

  CONSTRAINT hist_undo_execution_job_positive
    CHECK (
      execution_job_id IS NULL
      OR execution_job_id > 0
    ),

  CONSTRAINT hist_undo_claim_pair
    CHECK (
      (
        claimed_by IS NULL
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
      )
      OR
      (
        claimed_by IS NOT NULL
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
      )
    ),

  CONSTRAINT hist_undo_fence_nonnegative
    CHECK (fence_epoch >= 0),

  CONSTRAINT hist_undo_retries_nonnegative
    CHECK (retry_count >= 0),

  CONSTRAINT hist_undo_completed_after_creation
    CHECK (
      completed_at IS NULL
      OR completed_at >= created_at
    )
);

CREATE INDEX hist_undo_history_page_idx
  ON edit_history.undo_requests (
    shop_id,
    installation_id,
    created_at DESC,
    id DESC
  );

CREATE INDEX hist_undo_original_operation_idx
  ON edit_history.undo_requests (
    shop_id,
    installation_id,
    original_operation_id
  );

CREATE INDEX hist_undo_ready_idx
  ON edit_history.undo_requests (
    next_attempt_at,
    created_at,
    id
  )
  WHERE undo_state IN (
    'REQUESTED',
    'PREFLIGHTING',
    'SUBMITTING',
    'OUTCOME_UNKNOWN'
  );

CREATE INDEX hist_undo_expired_claim_idx
  ON edit_history.undo_requests (
    claim_expires_at,
    id
  )
  WHERE claim_token IS NOT NULL;

-- ======================================================
-- 5. RECOVERY TASKS
-- ======================================================
--
-- Durable reconciliation tasks for:
-- - Unknown Shopify mutation results
-- - Failed verification persistence
-- - Incomplete observation evidence
-- - Undo handoff uncertainty
-- - Retention/cleanup dependencies
--
-- Recovery tasks must never directly perform Shopify
-- mutations. They may request the existing execution
-- engine to recover an operation using its own fencing.
--
-- A dedupe_key identifies the logical recovery issue.
-- A retry does not create another independent task.
--
-- RECONCILING claims are recoverable after lease expiry.
-- Lease tokens/fences protect repository state changes.

CREATE TABLE edit_history.recovery_tasks (
  id UUID PRIMARY KEY,

  shop_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,

  operation_id UUID NOT NULL,

  change_id UUID,
  undo_request_id UUID,

  task_kind TEXT NOT NULL,
  task_state TEXT NOT NULL DEFAULT 'PENDING',

  dedupe_key TEXT NOT NULL,

  evidence_fingerprint TEXT,
  last_error_code TEXT,

  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 20,

  available_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  claimed_by TEXT,
  claim_token UUID,
  fence_epoch BIGINT NOT NULL DEFAULT 0,
  claim_expires_at TIMESTAMPTZ,

  last_checked_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT clock_timestamp(),

  completed_at TIMESTAMPTZ,

  CONSTRAINT hist_recovery_operation_fk
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

  CONSTRAINT hist_recovery_change_fk
    FOREIGN KEY (
      shop_id,
      installation_id,
      change_id
    )
    REFERENCES edit_history.changes (
      shop_id,
      installation_id,
      id
    )
    ON DELETE RESTRICT,

  CONSTRAINT hist_recovery_undo_fk
    FOREIGN KEY (
      shop_id,
      installation_id,
      undo_request_id
    )
    REFERENCES edit_history.undo_requests (
      shop_id,
      installation_id,
      id
    )
    ON DELETE RESTRICT,

  CONSTRAINT hist_recovery_tenant_key
    UNIQUE (
      shop_id,
      installation_id,
      id
    ),

  CONSTRAINT hist_recovery_dedupe
    UNIQUE (
      shop_id,
      installation_id,
      task_kind,
      dedupe_key
    ),

  CONSTRAINT hist_recovery_dedupe_nonempty
    CHECK (
      length(btrim(dedupe_key)) > 0
      AND octet_length(dedupe_key) <= 512
    ),

  CONSTRAINT hist_recovery_kind
    CHECK (
      task_kind IN (
        'MUTATION_OUTCOME',
        'SNAPSHOT_VERIFICATION',
        'EVIDENCE_RECONCILIATION',
        'UNDO_HANDOFF',
        'UNDO_VERIFICATION',
        'RETENTION_DEPENDENCY'
      )
    ),

  CONSTRAINT hist_recovery_state
    CHECK (
      task_state IN (
        'PENDING',
        'RECONCILING',
        'RETRY_WAIT',
        'COMPLETED',
        'REVIEW_REQUIRED',
        'CANCELLED'
      )
    ),

  CONSTRAINT hist_recovery_evidence_fingerprint
    CHECK (
      evidence_fingerprint IS NULL
      OR evidence_fingerprint ~
        '^sha256:[0-9a-f]{64}$'
    ),

  CONSTRAINT hist_recovery_attempt_budget
    CHECK (
      attempt_count >= 0
      AND max_attempts >= 1
      AND max_attempts <= 1000
    ),

  CONSTRAINT hist_recovery_fence_nonnegative
    CHECK (fence_epoch >= 0),

  CONSTRAINT hist_recovery_claim_pair
    CHECK (
      (
        claimed_by IS NULL
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
      )
      OR
      (
        claimed_by IS NOT NULL
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
      )
    ),

  CONSTRAINT hist_recovery_terminal_claim
    CHECK (
      task_state NOT IN (
        'COMPLETED',
        'REVIEW_REQUIRED',
        'CANCELLED'
      )
      OR (
        claimed_by IS NULL
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
      )
    ),

  CONSTRAINT hist_recovery_completed_after_creation
    CHECK (
      completed_at IS NULL
      OR completed_at >= created_at
    )
);

CREATE INDEX hist_recovery_queue_idx
  ON edit_history.recovery_tasks (
    available_at,
    created_at,
    id
  )
  WHERE task_state IN (
    'PENDING',
    'RETRY_WAIT'
  );

CREATE INDEX hist_recovery_expired_claim_idx
  ON edit_history.recovery_tasks (
    claim_expires_at,
    id
  )
  WHERE task_state = 'RECONCILING';

CREATE INDEX hist_recovery_operation_idx
  ON edit_history.recovery_tasks (
    shop_id,
    installation_id,
    operation_id
  );

CREATE INDEX hist_recovery_change_idx
  ON edit_history.recovery_tasks (
    shop_id,
    installation_id,
    change_id
  )
  WHERE change_id IS NOT NULL;

CREATE INDEX hist_recovery_undo_idx
  ON edit_history.recovery_tasks (
    shop_id,
    installation_id,
    undo_request_id
  )
  WHERE undo_request_id IS NOT NULL;

-- ======================================================
-- 6. INTERNAL OPERATION CONSISTENCY
-- ======================================================
--
-- A change and its snapshot must reference the same
-- operation. Similarly, a recovery task must not point
-- at a change or undo request from another operation.
--
-- These composite constraints enforce consistency in
-- addition to shop/installation isolation.

ALTER TABLE edit_history.changes
  ADD CONSTRAINT hist_changes_operation_identity_unique
  UNIQUE (
    shop_id,
    installation_id,
    operation_id,
    id
  );

ALTER TABLE edit_history.snapshots
  ADD CONSTRAINT hist_snapshots_change_operation_fk
  FOREIGN KEY (
    shop_id,
    installation_id,
    operation_id,
    change_id
  )
  REFERENCES edit_history.changes (
    shop_id,
    installation_id,
    operation_id,
    id
  )
  ON DELETE RESTRICT;

ALTER TABLE edit_history.undo_requests
  ADD CONSTRAINT hist_undo_operation_identity_unique
  UNIQUE (
    shop_id,
    installation_id,
    original_operation_id,
    id
  );

ALTER TABLE edit_history.recovery_tasks
  ADD CONSTRAINT hist_recovery_change_operation_fk
  FOREIGN KEY (
    shop_id,
    installation_id,
    operation_id,
    change_id
  )
  REFERENCES edit_history.changes (
    shop_id,
    installation_id,
    operation_id,
    id
  )
  ON DELETE RESTRICT;

ALTER TABLE edit_history.recovery_tasks
  ADD CONSTRAINT hist_recovery_undo_operation_fk
  FOREIGN KEY (
    shop_id,
    installation_id,
    operation_id,
    undo_request_id
  )
  REFERENCES edit_history.undo_requests (
    shop_id,
    installation_id,
    original_operation_id,
    id
  )
  ON DELETE RESTRICT;

-- ======================================================
-- 7. IMMUTABLE SNAPSHOT RECORDS
-- ======================================================
--
-- Snapshot INSERT is permitted.
-- Snapshot UPDATE is prohibited.
--
-- Deletion is deliberately not blocked by trigger:
-- retention requires a separately authorized purge
-- process that verifies:
-- - no active undo
-- - no unresolved recovery
-- - no legal hold
-- - expiry eligibility
--
-- Foreign keys default to RESTRICT, so deleting
-- snapshots alone does not cascade into other history.
--
-- A fingerprint or observation receipt must never be
-- changed in place.

CREATE FUNCTION edit_history.reject_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Edit history snapshots are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER hist_snapshots_no_update
BEFORE UPDATE ON edit_history.snapshots
FOR EACH ROW
EXECUTE FUNCTION edit_history.reject_snapshot_update();

-- ======================================================
-- 8. PREVENT CHANGING EXECUTION REFERENCES
-- ======================================================
--
-- Operations may update status/counts, but identity,
-- tenant and original Mirror Engine bindings must be
-- immutable after insertion.
--
-- Change rows may update outcome/verification fields,
-- but never their execution identity, field identity,
-- attempt number or captured intent fingerprints.

CREATE FUNCTION edit_history.protect_operation_identity()
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
    OR OLD.execution_contract_id IS DISTINCT FROM NEW.execution_contract_id
    OR OLD.execution_fingerprint IS DISTINCT FROM NEW.execution_fingerprint
    OR OLD.filter_fingerprint IS DISTINCT FROM NEW.filter_fingerprint
    OR OLD.approved_contract_fingerprint
       IS DISTINCT FROM NEW.approved_contract_fingerprint
    OR OLD.contract_version IS DISTINCT FROM NEW.contract_version
    OR OLD.fingerprint_scheme IS DISTINCT FROM NEW.fingerprint_scheme
  THEN
    RAISE EXCEPTION
      'Edit history operation identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER hist_operations_protect_identity
BEFORE UPDATE ON edit_history.operations
FOR EACH ROW
EXECUTE FUNCTION edit_history.protect_operation_identity();

CREATE FUNCTION edit_history.protect_change_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
    OR OLD.execution_claim_id IS DISTINCT FROM NEW.execution_claim_id
    OR OLD.resource_gid IS DISTINCT FROM NEW.resource_gid
    OR OLD.resource_family_gid IS DISTINCT FROM NEW.resource_family_gid
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

  RETURN NEW;
END;
$$;

CREATE TRIGGER hist_changes_protect_identity
BEFORE UPDATE ON edit_history.changes
FOR EACH ROW
EXECUTE FUNCTION edit_history.protect_change_identity();

-- ======================================================
-- 9. OPTIONAL POST-MIGRATION ACCESS HARDENING
-- ======================================================
--
-- Run separately after inspecting real database roles:
--
-- - Revoke direct history writes from browser-facing roles.
-- - Grant INSERT/UPDATE only to trusted application roles.
-- - Restrict sensitive snapshot SELECT access.
-- - Consider RLS with a trusted transaction-scoped
--   tenant setting if direct SQL access is multi-tenant.
-- - Ensure background workers cannot impersonate a
--   different shop via browser-controlled settings.
--
-- RLS and role grants are NOT included here because
-- the deployed Neon role structure is not verified.
--
-- END MIGRATION
