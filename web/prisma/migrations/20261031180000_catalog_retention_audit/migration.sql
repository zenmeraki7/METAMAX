CREATE TABLE mirror.catalog_retention_audit (
 shop_id text NOT NULL REFERENCES mirror.shops(id) ON DELETE CASCADE,
 generation_id text NOT NULL,summary jsonb NOT NULL,reclaimed_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(shop_id,generation_id)
);
CREATE INDEX catalog_retention_audit_age ON mirror.catalog_retention_audit(reclaimed_at);
ALTER TABLE mirror.catalog_retention_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY metamax_tenant_isolation ON mirror.catalog_retention_audit USING(shop_id=current_setting('app.shop_id',true)) WITH CHECK(shop_id=current_setting('app.shop_id',true));
GRANT SELECT,INSERT,DELETE ON mirror.catalog_retention_audit TO metamax_engine_runtime;
-- Preserve efficient lookup of the one per-installation initial-sync tombstone.
CREATE INDEX catalog_import_installation_history ON mirror.catalog_import_jobs(shop_id,installation_version,created_at,id);
