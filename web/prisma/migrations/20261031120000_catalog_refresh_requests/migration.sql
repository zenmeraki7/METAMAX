-- Refresh intent is committed with webhook fan-out. The scheduler acknowledges
-- only allocation into the existing durable, bounded-retry import pipeline.
CREATE TABLE mirror.catalog_refresh_requests (
  shop_id TEXT PRIMARY KEY REFERENCES mirror.shops(id) ON DELETE CASCADE,
  installation_version TEXT NOT NULL,
  requested_revision BIGINT NOT NULL DEFAULT 1 CHECK (requested_revision > 0),
  scheduled_revision BIGINT NOT NULL DEFAULT 0 CHECK (scheduled_revision >= 0 AND scheduled_revision <= requested_revision),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX catalog_refresh_requests_due ON mirror.catalog_refresh_requests(next_attempt_at,shop_id)
  WHERE requested_revision > scheduled_revision;

-- Catch up every active published shop once: old inventory deliveries and
-- partially acknowledged fan-outs may have left no dirty row to discover.
INSERT INTO mirror.catalog_refresh_requests(shop_id,installation_version)
SELECT s.id,s.installation_version FROM mirror.shops s
WHERE s.uninstalled_at IS NULL AND (
  EXISTS(SELECT 1 FROM mirror.publications p WHERE p.shop_id=s.id) OR
  EXISTS(SELECT 1 FROM mirror.catalog_changes c WHERE c.shop_id=s.id AND c.dirty)
);
