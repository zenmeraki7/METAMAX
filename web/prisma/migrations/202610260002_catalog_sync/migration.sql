-- Create generation-aware baseline table if not already present
CREATE TABLE IF NOT EXISTS mirror_generations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  shop_id TEXT NOT NULL,
  sequence BIGINT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'BUILDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  PRIMARY KEY (shop_id, id),
  UNIQUE (shop_id, id)
);

-- Durable catalog runs for bulk catalog synchronization
CREATE TABLE IF NOT EXISTS mirror_catalog_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id TEXT NOT NULL,
  generation_id UUID NOT NULL,

  state TEXT NOT NULL DEFAULT 'REQUESTED',

  bulk_operation_id TEXT,
  result_url TEXT,

  expected_objects BIGINT,
  expected_products BIGINT,

  imported_products BIGINT NOT NULL DEFAULT 0,
  imported_variants BIGINT NOT NULL DEFAULT 0,

  checksum TEXT,
  error_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  UNIQUE (shop_id, generation_id),

  FOREIGN KEY (shop_id, generation_id)
    REFERENCES mirror_generations(shop_id, id),

  CHECK (state IN (
    'REQUESTED',
    'STARTING',
    'RUNNING',
    'INGESTING',
    'VERIFYING',
    'PUBLISHED',
    'FAILED',
    'NEEDS_REVIEW'
  ))
);

-- Active catalog rebuild constraint: only one active run per shop
CREATE UNIQUE INDEX IF NOT EXISTS mirror_catalog_active_shop
  ON mirror_catalog_runs(shop_id)
  WHERE state IN (
    'REQUESTED',
    'STARTING',
    'RUNNING',
    'INGESTING',
    'VERIFYING',
    'NEEDS_REVIEW'
  );

-- Bulk operation identifier index for idempotent lookup
CREATE UNIQUE INDEX IF NOT EXISTS mirror_catalog_bulk_operation
  ON mirror_catalog_runs(shop_id, bulk_operation_id)
  WHERE bulk_operation_id IS NOT NULL;

-- Index for pending runs requiring attention / recovery
CREATE INDEX IF NOT EXISTS mirror_catalog_pending
  ON mirror_catalog_runs(updated_at)
  WHERE state IN (
    'REQUESTED',
    'RUNNING',
    'INGESTING',
    'VERIFYING'
  );
