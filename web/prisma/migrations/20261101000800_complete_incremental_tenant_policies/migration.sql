-- Older pending feature migrations may be installed after the already-applied
-- runtime_tenant_rls migration. Close that incremental-upgrade gap explicitly.
-- These are server-owned identifiers; no browser-selected schema or grants.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT n.nspname,c.relname,c.oid FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='mirror' AND c.relname IN
  ('import_previews','export_jobs','export_manifest_jobs','export_dispatch_outbox','schedule_occurrences'))
 OR (n.nspname='edit_history' AND c.relname IN('mutation_requests','privacy_scopes')) LOOP
  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',t.nspname,t.relname);
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t.oid AND polname='metamax_tenant_isolation') THEN
   EXECUTE format('CREATE POLICY metamax_tenant_isolation ON %I.%I USING(shop_id=current_setting(''app.shop_id'',true)) WITH CHECK(shop_id=current_setting(''app.shop_id'',true))',t.nspname,t.relname);
  END IF;
 END LOOP;
 -- Match the SELECT access the original runtime migration would have granted
 -- had these tables existed. Write grants remain owned by split-runtime roles.
 GRANT SELECT ON mirror.import_previews,mirror.export_jobs,mirror.export_manifest_jobs,
  mirror.export_dispatch_outbox,mirror.schedule_occurrences TO metamax_engine_runtime;
 GRANT SELECT ON edit_history.mutation_requests TO metamax_engine_runtime;
 -- The history maintenance roles were also introduced after runtime_tenant_rls
 -- on this deployment. Restore only that migration's declared function-owner
 -- and maintenance policies, without granting either role to app/worker logins.
 FOR t IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='edit_history' AND c.relkind='r' AND c.relrowsecurity LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t.oid AND polname='metamax_history_function_owner') THEN
   EXECUTE format('CREATE POLICY metamax_history_function_owner ON edit_history.%I TO metamax_history_owner USING(true) WITH CHECK(true)',t.relname);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t.oid AND polname='metamax_history_maintenance_read') THEN
   EXECUTE format('CREATE POLICY metamax_history_maintenance_read ON edit_history.%I FOR SELECT TO metamax_history_maintenance USING(true)',t.relname);
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='mirror.shops'::regclass AND polname='metamax_history_function_owner') THEN
  CREATE POLICY metamax_history_function_owner ON mirror.shops FOR SELECT TO metamax_history_owner USING(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='mirror.job_commands'::regclass AND polname='metamax_history_function_owner') THEN
  CREATE POLICY metamax_history_function_owner ON mirror.job_commands TO metamax_history_owner USING(true) WITH CHECK(true);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='mirror.execution_contracts'::regclass AND polname='metamax_history_function_owner') THEN
  CREATE POLICY metamax_history_function_owner ON mirror.execution_contracts FOR SELECT TO metamax_history_owner USING(true);
 END IF;
END $$;
