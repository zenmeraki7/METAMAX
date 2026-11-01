-- Dedicated gateway-read profile. Login/password provisioning is deliberately
-- separate; credentials never enter migration SQL or the migration ledger.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metamax_tenant_reader') THEN
    CREATE ROLE metamax_tenant_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metamax_tenant_reader' AND
    (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe tenant reader role';
  END IF;
END $$;
GRANT USAGE ON SCHEMA mirror TO metamax_tenant_reader;
GRANT SELECT ON mirror.shops,mirror.publications,mirror.generations,mirror.coverage,mirror.catalog_import_jobs TO metamax_tenant_reader;
ALTER TABLE mirror.shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE mirror.catalog_import_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY metamax_tenant_isolation ON mirror.shops
  USING(id=current_setting('app.shop_id',true)) WITH CHECK(id=current_setting('app.shop_id',true));
CREATE POLICY metamax_tenant_isolation ON mirror.publications
  USING(shop_id=current_setting('app.shop_id',true)) WITH CHECK(shop_id=current_setting('app.shop_id',true));
CREATE POLICY metamax_tenant_isolation ON mirror.generations
  USING(shop_id=current_setting('app.shop_id',true)) WITH CHECK(shop_id=current_setting('app.shop_id',true));
CREATE POLICY metamax_tenant_isolation ON mirror.coverage
  USING(shop_id=current_setting('app.shop_id',true)) WITH CHECK(shop_id=current_setting('app.shop_id',true));
CREATE POLICY metamax_tenant_isolation ON mirror.catalog_import_jobs
  USING(shop_id=current_setting('app.shop_id',true)) WITH CHECK(shop_id=current_setting('app.shop_id',true));
