CREATE TABLE mirror.catalog_import_jobs (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES mirror.shops(id) ON DELETE CASCADE ON UPDATE CASCADE,
  installation_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  generation_id TEXT,
  run_id BIGINT,
  expected_generation_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  fence BIGINT NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ(3),
  next_attempt_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  last_error TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT catalog_import_status CHECK (status IN ('QUEUED','RUNNING','RETRY','SUCCEEDED','FAILED','CANCELLED')),
  CONSTRAINT catalog_import_attempts CHECK (attempts BETWEEN 0 AND 8 AND fence >= 0)
);
CREATE UNIQUE INDEX catalog_import_active_shop ON mirror.catalog_import_jobs(shop_id)
  WHERE status IN ('QUEUED','RUNNING','RETRY');
CREATE INDEX catalog_import_due ON mirror.catalog_import_jobs(status,next_attempt_at,lease_until);
