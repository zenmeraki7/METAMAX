-- Separate execution API supplied as Export Repository V2. Existing admission
-- records in mirror.export_manifest_jobs are intentionally not reinterpreted.
CREATE SCHEMA export_engine;

CREATE TABLE export_engine.jobs (
  id uuid PRIMARY KEY,
  shop_id text NOT NULL,
  installation_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  manifest_fingerprint text NOT NULL CHECK (manifest_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  contract_version integer NOT NULL CHECK (contract_version=2),
  manifest_version integer NOT NULL CHECK (manifest_version=1),
  manifest jsonb NOT NULL,
  generation_id text NOT NULL,
  coverage_revision text NOT NULL,
  mapping_version text NOT NULL,
  compiler_version text NOT NULL,
  -- Historical lease identity, deliberately not an FK: terminal cleanup deletes
  -- the actual Mirror read lease while retaining the immutable execution record.
  generation_lease_id text NOT NULL,
  generation_lease_expires_at timestamptz NOT NULL,
  generation_lease_renewed_at timestamptz,
  generation_protection_released_at timestamptz,
  generation_release_reason text,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN (
    'PENDING','VALIDATING','WAITING_FOR_CAPACITY','QUEUED','RUNNING','FINALIZING',
    'RECOVERING','REVIEW_REQUIRED','RETRY_WAIT','CANCELLING','CANCELLED','FAILED','COMPLETED','EXPIRED')),
  resume_state text NOT NULL DEFAULT 'RUNNING' CHECK (resume_state IN ('RUNNING','FINALIZING')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  recovery_attempts integer NOT NULL DEFAULT 0 CHECK (recovery_attempts>=0),
  recovery_evidence jsonb,
  fence_epoch bigint NOT NULL DEFAULT 0 CHECK (fence_epoch>=0),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  next_attempt_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  failure_code text,
  checkpoint_version bigint NOT NULL DEFAULT 0 CHECK (checkpoint_version>=0),
  checkpoint jsonb NOT NULL DEFAULT '{}',
  rows_committed bigint NOT NULL DEFAULT 0 CHECK (rows_committed>=0),
  -- Stored immutable intermediate-part bytes, NEVER final assembled output bytes.
  bytes_committed bigint NOT NULL DEFAULT 0 CHECK (bytes_committed>=0 AND bytes_committed<=8589934592),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(shop_id,installation_id,idempotency_key),
  FOREIGN KEY(shop_id,installation_id) REFERENCES mirror.shops(id,installation_version) ON UPDATE RESTRICT ON DELETE RESTRICT,
  -- Pinned generation metadata is historical, not a permanent FK retention hold.
  -- The actual Mirror lease owns active retention and is released at termination.
  CHECK ((lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state IN ('RUNNING','FINALIZING','RECOVERING') AND lease_token IS NOT NULL)
    OR state='CANCELLING' OR (state NOT IN ('RUNNING','FINALIZING','RECOVERING','CANCELLING') AND lease_token IS NULL)),
  CHECK (state<>'RETRY_WAIT' OR next_attempt_at IS NOT NULL),
  CHECK (generation_protection_released_at IS NULL OR state IN ('COMPLETED','CANCELLED','FAILED','EXPIRED')),
  CHECK ((manifest->>'shopId'=shop_id AND manifest->>'installationId'=installation_id
    AND manifest->>'generationId'=generation_id AND manifest->>'coverageRevision'=coverage_revision
    AND manifest->>'mappingVersion'=mapping_version AND manifest->>'compilerVersion'=compiler_version
    AND manifest->>'format' IN ('CSV','JSONL','XLSX')) IS TRUE)
);
CREATE INDEX export_jobs_recovery_due ON export_engine.jobs(lease_expires_at,id)
  WHERE state IN ('RUNNING','FINALIZING','RECOVERING');
CREATE INDEX export_jobs_retry_due ON export_engine.jobs(next_attempt_at,id) WHERE state='RETRY_WAIT';
CREATE INDEX export_jobs_ready ON export_engine.jobs(created_at,id) WHERE state='QUEUED' AND NOT cancel_requested;
CREATE INDEX export_jobs_protection_cleanup ON export_engine.jobs(updated_at,id)
  WHERE state IN ('COMPLETED','CANCELLED','FAILED','EXPIRED') AND generation_protection_released_at IS NULL;
CREATE INDEX export_jobs_protection_renewal ON export_engine.jobs(generation_lease_expires_at,id)
  WHERE generation_protection_released_at IS NULL;

CREATE TABLE export_engine.parts (
  job_id uuid NOT NULL REFERENCES export_engine.jobs(id) ON DELETE RESTRICT,
  part_number integer NOT NULL CHECK(part_number>=0),
  storage_key text NOT NULL,
  storage_version text NOT NULL CHECK(length(storage_version)>0),
  checksum text NOT NULL CHECK(checksum ~ '^sha256:[a-f0-9]{64}$'),
  row_count bigint NOT NULL CHECK(row_count>=0),
  byte_count bigint NOT NULL CHECK(byte_count>=0),
  checkpoint_after jsonb NOT NULL,
  committed_fence bigint NOT NULL CHECK(committed_fence>0),
  PRIMARY KEY(job_id,part_number),
  UNIQUE(storage_key,storage_version)
);
CREATE TABLE export_engine.artifacts (
  job_id uuid PRIMARY KEY REFERENCES export_engine.jobs(id) ON DELETE RESTRICT,
  storage_key text NOT NULL,
  storage_version text NOT NULL CHECK(length(storage_version)>0),
  checksum text NOT NULL CHECK(checksum ~ '^sha256:[a-f0-9]{64}$'),
  format text NOT NULL CHECK(format IN ('CSV','JSONL','XLSX')),
  byte_count bigint NOT NULL CHECK(byte_count>=0 AND byte_count<=2147483648),
  source_byte_count bigint NOT NULL CHECK(source_byte_count>=0 AND source_byte_count<=8589934592),
  accounting_version text NOT NULL,
  row_count bigint NOT NULL CHECK(row_count>=0),
  part_count integer NOT NULL CHECK(part_count>=0),
  storage_receipt jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE(storage_key,storage_version),
  CHECK(accounting_version=CASE format WHEN 'CSV' THEN 'csv-assembled-v1' WHEN 'JSONL' THEN 'jsonl-assembled-v1' ELSE 'xlsx-packaged-v1' END)
);
CREATE TABLE export_engine.outbox (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES export_engine.jobs(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK(event_type='EXPORT_READY'),
  delivery_key uuid NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CLAIMED','UNKNOWN','RECONCILING','RETRY_ELIGIBLE','DELIVERED','REVIEW_REQUIRED')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  reconciliation_attempts integer NOT NULL DEFAULT 0 CHECK(reconciliation_attempts>=0),
  fence_epoch bigint NOT NULL DEFAULT 0 CHECK(fence_epoch>=0),
  claim_owner text,
  claim_token uuid,
  claim_expires_at timestamptz,
  last_error_code text,
  delivery_evidence jsonb,
  last_checked_at timestamptz,
  delivered_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((state IN ('CLAIMED','RECONCILING') AND claim_owner IS NOT NULL AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (state NOT IN ('CLAIMED','RECONCILING') AND claim_owner IS NULL AND claim_token IS NULL AND claim_expires_at IS NULL))
);
CREATE INDEX export_outbox_due ON export_engine.outbox(available_at,id) WHERE state IN ('PENDING','RETRY_ELIGIBLE');
CREATE INDEX export_outbox_recovery ON export_engine.outbox(claim_expires_at,id) WHERE state IN ('CLAIMED','RECONCILING');

CREATE FUNCTION export_engine.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Committed export records are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER export_parts_immutable BEFORE UPDATE OR DELETE ON export_engine.parts
  FOR EACH ROW EXECUTE FUNCTION export_engine.immutable_record();
CREATE TRIGGER export_artifacts_immutable BEFORE UPDATE OR DELETE ON export_engine.artifacts
  FOR EACH ROW EXECUTE FUNCTION export_engine.immutable_record();

CREATE FUNCTION export_engine.guard_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.shop_id,NEW.installation_id,NEW.idempotency_key,NEW.request_fingerprint,NEW.manifest_fingerprint,
      NEW.contract_version,NEW.manifest_version,NEW.manifest,NEW.generation_id,NEW.coverage_revision,NEW.mapping_version,
      NEW.compiler_version,NEW.generation_lease_id,NEW.created_at)
     IS DISTINCT FROM
     (OLD.id,OLD.shop_id,OLD.installation_id,OLD.idempotency_key,OLD.request_fingerprint,OLD.manifest_fingerprint,
      OLD.contract_version,OLD.manifest_version,OLD.manifest,OLD.generation_id,OLD.coverage_revision,OLD.mapping_version,
      OLD.compiler_version,OLD.generation_lease_id,OLD.created_at)
     OR NEW.fence_epoch<OLD.fence_epoch OR NEW.checkpoint_version<OLD.checkpoint_version
     OR (OLD.generation_protection_released_at IS NOT NULL AND
       (NEW.generation_protection_released_at,NEW.generation_release_reason) IS DISTINCT FROM
       (OLD.generation_protection_released_at,OLD.generation_release_reason))
  THEN RAISE EXCEPTION 'Export identity or monotonic state changed' USING ERRCODE='23514'; END IF;
  IF OLD.state IN ('COMPLETED','CANCELLED','FAILED','EXPIRED') AND
    (to_jsonb(NEW)-'state'-'generation_protection_released_at'-'generation_release_reason') IS DISTINCT FROM
    (to_jsonb(OLD)-'state'-'generation_protection_released_at'-'generation_release_reason')
  THEN RAISE EXCEPTION 'Terminal export execution is immutable' USING ERRCODE='23514'; END IF;
  IF NEW.state<>OLD.state AND NOT (
    (OLD.state='PENDING' AND NEW.state IN ('VALIDATING','CANCELLING','FAILED')) OR
    (OLD.state='VALIDATING' AND NEW.state IN ('WAITING_FOR_CAPACITY','QUEUED','CANCELLING','FAILED')) OR
    (OLD.state='WAITING_FOR_CAPACITY' AND NEW.state IN ('QUEUED','CANCELLING','FAILED')) OR
    (OLD.state='QUEUED' AND NEW.state IN ('RUNNING','FINALIZING','RETRY_WAIT','CANCELLING','FAILED')) OR
    (OLD.state='RUNNING' AND NEW.state IN ('FINALIZING','RETRY_WAIT','RECOVERING','CANCELLING','FAILED')) OR
    (OLD.state='FINALIZING' AND NEW.state IN ('COMPLETED','RETRY_WAIT','RECOVERING','CANCELLING','FAILED')) OR
    (OLD.state='RECOVERING' AND NEW.state IN ('RETRY_WAIT','REVIEW_REQUIRED','CANCELLING','FAILED')) OR
    (OLD.state='RETRY_WAIT' AND NEW.state IN ('QUEUED','CANCELLING','FAILED')) OR
    (OLD.state='REVIEW_REQUIRED' AND NEW.state IN ('CANCELLING','FAILED')) OR
    (OLD.state='CANCELLING' AND NEW.state IN ('CANCELLED','FAILED')) OR
    (OLD.state='COMPLETED' AND NEW.state='EXPIRED'))
  THEN RAISE EXCEPTION 'Invalid export lifecycle transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_export_job BEFORE UPDATE ON export_engine.jobs FOR EACH ROW EXECUTE FUNCTION export_engine.guard_job();
