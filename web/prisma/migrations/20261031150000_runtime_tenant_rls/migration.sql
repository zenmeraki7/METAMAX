-- Runtime DML is separate from migration ownership. Queue/control-plane access
-- is explicit; catalog payload and history rows remain scoped by tenant GUC.
DO $$ DECLARE t record; col text; BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metamax_engine_runtime') THEN
    CREATE ROLE metamax_engine_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metamax_engine_runtime' AND
    (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe engine runtime profile';
  END IF;
  GRANT USAGE ON SCHEMA mirror TO metamax_engine_runtime;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='mirror' AND c.relkind='r' AND c.relname<>'_prisma_migrations' LOOP
    EXECUTE format('GRANT SELECT ON mirror.%I TO metamax_engine_runtime',t.relname);
    IF t.relname<>'field_mappings' THEN
      EXECUTE format('GRANT INSERT,UPDATE,DELETE ON mirror.%I TO metamax_engine_runtime',t.relname);
    END IF;
  END LOOP;
  GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA mirror TO metamax_engine_runtime;
  FOR t IN SELECT n.nspname,c.relname,c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN('mirror','edit_history','export_engine') AND c.relkind='r'
      AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='shop_id' AND NOT a.attisdropped) LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',t.nspname,t.relname);
    IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=t.oid AND polname='metamax_tenant_isolation') THEN
      EXECUTE format('CREATE POLICY metamax_tenant_isolation ON %I.%I USING(shop_id=current_setting(''app.shop_id'',true)) WITH CHECK(shop_id=current_setting(''app.shop_id'',true))',t.nspname,t.relname);
    END IF;
  END LOOP;
  -- This is the application control plane, not browser-selected catalog data.
  -- Existing claim SQL must still match durable ownership and fence each write.
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='mirror' AND c.relkind='r' AND c.relname=ANY(ARRAY[
      'shops','catalog_import_jobs','catalog_import_executions','catalog_refresh_requests',
      'ingestion_runs','ingestion_chunks','sync_dispatches','sync_dispatch_schedule',
      'sync_dispatch_recovery_evidence','sync_external_operations','job_commands',
      'job_schedules','schedule_occurrences','outbox_events','export_jobs','export_manifest_jobs',
      'generations','generation_read_leases']) LOOP
    EXECUTE format('CREATE POLICY metamax_control_plane ON mirror.%I TO metamax_engine_runtime USING(true) WITH CHECK(true)',t.relname);
  END LOOP;
  CREATE POLICY metamax_control_audit_insert ON mirror.audit_events FOR INSERT TO metamax_engine_runtime WITH CHECK(true);
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='mirror' AND c.relname IN('coverage','catalog_changes') LOOP
    EXECUTE format('CREATE POLICY metamax_control_metadata_read ON mirror.%I FOR SELECT TO metamax_engine_runtime USING(true)',t.relname);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='edit_history') THEN
    GRANT USAGE ON SCHEMA edit_history TO metamax_engine_runtime;
    FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='edit_history' AND c.relname IN('operations','changes','mutation_requests') LOOP
      EXECUTE format('GRANT SELECT ON edit_history.%I TO metamax_engine_runtime',t.relname);
    END LOOP;
    -- Existing, separately verified SECURITY DEFINER maintenance APIs run as
    -- this NOLOGIN role. Application runtime is not a member of either role.
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='metamax_history_owner') THEN
      FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='edit_history' AND c.relkind='r' AND c.relrowsecurity LOOP
        EXECUTE format('CREATE POLICY metamax_history_function_owner ON edit_history.%I TO metamax_history_owner USING(true) WITH CHECK(true)',t.relname);
        EXECUTE format('CREATE POLICY metamax_history_maintenance_read ON edit_history.%I FOR SELECT TO metamax_history_maintenance USING(true)',t.relname);
      END LOOP;
      CREATE POLICY metamax_history_function_owner ON mirror.shops FOR SELECT TO metamax_history_owner USING(true);
      CREATE POLICY metamax_history_function_owner ON mirror.job_commands TO metamax_history_owner USING(true) WITH CHECK(true);
      CREATE POLICY metamax_history_function_owner ON mirror.execution_contracts FOR SELECT TO metamax_history_owner USING(true);
    END IF;
  END IF;
END $$;
