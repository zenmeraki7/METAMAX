CREATE TABLE mirror.export_manifest_jobs (
  id UUID PRIMARY KEY,

  shop_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,

  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  manifest_fingerprint TEXT NOT NULL,

  contract_version INTEGER NOT NULL,
  manifest_version INTEGER NOT NULL,

  generation_id TEXT NOT NULL,
  coverage_revision TEXT NOT NULL,
  mapping_version TEXT NOT NULL,
  read_lease_id TEXT NOT NULL,

  manifest JSONB NOT NULL,

  state TEXT NOT NULL DEFAULT 'QUEUED',

  attempts INTEGER NOT NULL DEFAULT 0,
  fence_epoch BIGINT NOT NULL DEFAULT 0,

  lease_token UUID,
  lease_expires_at TIMESTAMPTZ(3),

  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  UNIQUE (shop_id, id),
  CONSTRAINT export_manifest_jobs_idempotency_unique
    UNIQUE (shop_id, installation_id, idempotency_key),
  CONSTRAINT export_manifest_jobs_attempts_nonnegative
    CHECK (attempts >= 0),
  CONSTRAINT export_manifest_jobs_state_valid
    CHECK (state IN (
      'PENDING',
      'VALIDATING',
      'WAITING_FOR_CAPACITY',
      'QUEUED',
      'RUNNING',
      'RETRY_WAIT',
      'FINALIZING',
      'COMPLETED',
      'CANCELLING',
      'CANCELLED',
      'FAILED',
      'EXPIRED'
    )),
  FOREIGN KEY (shop_id, installation_id)
    REFERENCES mirror.shops (id, installation_version)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (shop_id, generation_id, coverage_revision, mapping_version)
    REFERENCES mirror.generations (shop_id, id, coverage_revision, mapping_version)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (shop_id, read_lease_id)
    REFERENCES mirror.generation_read_leases (shop_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX export_manifest_jobs_shop_state_idx
ON mirror.export_manifest_jobs (
  shop_id,
  state,
  created_at
);

CREATE FUNCTION mirror.guard_export_manifest_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (
    NEW.id,
    NEW.shop_id,
    NEW.installation_id,
    NEW.idempotency_key,
    NEW.request_fingerprint,
    NEW.manifest_fingerprint,
    NEW.contract_version,
    NEW.manifest_version,
    NEW.generation_id,
    NEW.coverage_revision,
    NEW.mapping_version,
    NEW.read_lease_id,
    NEW.manifest,
    NEW.created_at
  ) IS DISTINCT FROM (
    OLD.id,
    OLD.shop_id,
    OLD.installation_id,
    OLD.idempotency_key,
    OLD.request_fingerprint,
    OLD.manifest_fingerprint,
    OLD.contract_version,
    OLD.manifest_version,
    OLD.generation_id,
    OLD.coverage_revision,
    OLD.mapping_version,
    OLD.read_lease_id,
    OLD.manifest,
    OLD.created_at
  ) OR (
    OLD.state IN ('CANCELLED', 'FAILED', 'EXPIRED') AND NEW IS DISTINCT FROM OLD
  ) THEN
    RAISE EXCEPTION 'Export manifest identity, pins, and terminal states are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_export_manifest_job
BEFORE UPDATE ON mirror.export_manifest_jobs
FOR EACH ROW EXECUTE FUNCTION mirror.guard_export_manifest_job();

CREATE TABLE mirror.export_dispatch_outbox (
  id BIGSERIAL PRIMARY KEY,
  shop_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  export_job_id UUID NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ(3),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ(3),
  fence_epoch BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),

  UNIQUE (shop_id, dedupe_key),
  UNIQUE (shop_id, export_job_id),
  FOREIGN KEY (shop_id, export_job_id)
    REFERENCES mirror.export_manifest_jobs (shop_id, id)
    ON DELETE CASCADE ON UPDATE RESTRICT
);

CREATE INDEX export_dispatch_outbox_due_idx
ON mirror.export_dispatch_outbox (available_at, id)
WHERE dispatched_at IS NULL;

