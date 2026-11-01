-- Additive cutover: old HTTP credentials lose unrestricted control-plane access.
-- Provision separate logins; never grant one login multiple application profiles.
CREATE ROLE metamax_catalog_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE metamax_operation_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA mirror TO metamax_catalog_worker,metamax_operation_worker;
GRANT USAGE ON SCHEMA edit_history TO metamax_operation_worker;

DO $$ DECLARE t record; role_name text; BEGIN
 FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='mirror' AND c.relkind='r' AND c.relname<>'_prisma_migrations' LOOP
  EXECUTE format('REVOKE INSERT,UPDATE,DELETE ON mirror.%I FROM metamax_engine_runtime',t.relname);
  EXECUTE format('DROP POLICY IF EXISTS metamax_control_plane ON mirror.%I',t.relname);
  EXECUTE format('DROP POLICY IF EXISTS metamax_control_metadata_read ON mirror.%I',t.relname);
  EXECUTE format('DROP POLICY IF EXISTS metamax_control_audit_insert ON mirror.%I',t.relname);
  -- Worker payload reads still require a scoped transaction; only declared
  -- control-plane tables below have cross-tenant discovery policies.
  IF t.relname=ANY(ARRAY['shops','generations','publications','coverage','products','variants','selection_snapshots','selection_items','execution_contracts','field_mappings']) THEN
   EXECUTE format('GRANT SELECT ON mirror.%I TO metamax_catalog_worker,metamax_operation_worker',t.relname);
  END IF;
  IF t.relname=ANY(ARRAY['shops','generations','products','coverage','selection_snapshots','execution_contracts']) THEN
   EXECUTE format('GRANT UPDATE(_history_lock) ON mirror.%I TO metamax_engine_runtime,metamax_operation_worker',t.relname);
  END IF;
  IF t.relname=ANY(ARRAY['selection_snapshots','selection_items','execution_contracts','edit_operations','job_commands','job_items','outbox_events','job_schedules','schedule_occurrences','product_snapshots','undo_operations','job_artifacts','audit_events','idempotency_records','import_previews','generation_read_leases','export_jobs','export_manifest_jobs','export_dispatch_outbox','saved_filters']) THEN
   EXECUTE format('GRANT INSERT,UPDATE,DELETE ON mirror.%I TO metamax_engine_runtime',t.relname);
  END IF;
  IF t.relname=ANY(ARRAY['shops','generations','publications','coverage','products','variants','product_options','categories','collections','product_collections','inventory_items','inventory_levels','locations','metafield_definitions','metafield_values','ingestion_runs','ingestion_chunks','catalog_changes','mutation_journal','webhook_receipts','generation_product_revisions','catalog_import_jobs','catalog_import_executions','catalog_refresh_requests','catalog_downloads','catalog_download_chunks','catalog_retention_audit','sync_dispatches','sync_dispatch_schedule','sync_dispatch_recovery_evidence','sync_external_operations','generation_read_leases']) THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON mirror.%I TO metamax_catalog_worker',t.relname);
  END IF;
  IF t.relname=ANY(ARRAY['job_commands','job_items','product_snapshots','outbox_events','operation_finalizations','audit_events']) THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON mirror.%I TO metamax_operation_worker',t.relname);
  END IF;
  IF t.relname='edit_operations' THEN
   EXECUTE format('GRANT SELECT ON mirror.%I TO metamax_operation_worker',t.relname);
  END IF;
  IF t.relname=ANY(ARRAY['shops','catalog_import_jobs','catalog_import_executions','catalog_refresh_requests','ingestion_runs','ingestion_chunks','sync_dispatches','sync_dispatch_schedule','sync_dispatch_recovery_evidence','sync_external_operations','generations','generation_read_leases','catalog_downloads','catalog_download_chunks']) THEN
   EXECUTE format('CREATE POLICY metamax_catalog_control ON mirror.%I TO metamax_catalog_worker USING(true) WITH CHECK(true)',t.relname);
  END IF;
  IF t.relname=ANY(ARRAY['job_commands','outbox_events','operation_finalizations']) THEN
   EXECUTE format('CREATE POLICY metamax_operation_control ON mirror.%I TO metamax_operation_worker USING(true) WITH CHECK(true)',t.relname);
  END IF;
 END LOOP;
END $$;
CREATE POLICY metamax_operation_discovery ON mirror.shops FOR SELECT TO metamax_operation_worker USING(true);
CREATE POLICY metamax_catalog_metadata ON mirror.coverage FOR SELECT TO metamax_catalog_worker USING(true);
CREATE POLICY metamax_catalog_metadata ON mirror.catalog_changes FOR SELECT TO metamax_catalog_worker USING(true);
CREATE POLICY metamax_operation_audit ON mirror.audit_events FOR INSERT TO metamax_operation_worker WITH CHECK(true);
REVOKE UPDATE,DELETE ON mirror.audit_events FROM metamax_engine_runtime,metamax_operation_worker;
REVOKE UPDATE,DELETE ON mirror.job_items FROM metamax_engine_runtime;
REVOKE INSERT,UPDATE,DELETE ON mirror.product_snapshots FROM metamax_engine_runtime;
-- Merchant read leases may extend retention, but cannot publish/retire catalogs.
GRANT UPDATE(retain_until) ON mirror.generations TO metamax_engine_runtime;

-- No snapshot values or intended values are granted for global discovery.
GRANT SELECT(id,shop_id,installation_id,execution_job_id,purge_requested_at) ON edit_history.operations TO metamax_operation_worker;
GRANT SELECT(id,shop_id,installation_id,operation_id,execution_item_id,mutation_id,attempt_id,request_state) ON edit_history.mutation_requests TO metamax_operation_worker;
GRANT SELECT(shop_id,installation_id,operation_id,mutation_id,attempt_id,mutation_state) ON edit_history.changes TO metamax_operation_worker;
CREATE POLICY metamax_operation_discovery ON edit_history.operations FOR SELECT TO metamax_operation_worker USING(true);
CREATE POLICY metamax_operation_discovery ON edit_history.mutation_requests FOR SELECT TO metamax_operation_worker USING(true);
CREATE POLICY metamax_operation_discovery ON edit_history.changes FOR SELECT TO metamax_operation_worker USING(true);

-- Completion reads only immutable coordinates and authenticated evidence metadata.
GRANT UPDATE(_history_lock) ON mirror.edit_operations TO metamax_operation_worker;
GRANT SELECT(approved_contract_fingerprint,execution_fingerprint,filter_fingerprint) ON edit_history.operations TO metamax_operation_worker;
GRANT SELECT(field_count,resource_field_set,verified_at,outcome_evidence_kind,outcome_evidence_fingerprint) ON edit_history.mutation_requests TO metamax_operation_worker;
GRANT SELECT(id,execution_item_id,resource_gid,field_id,verification_state,verified_at,mutation_plan_fingerprint,intended_value_fingerprint,last_evidence_kind,last_evidence_fingerprint,field_definition_revision) ON edit_history.changes TO metamax_operation_worker;
GRANT SELECT(shop_id,installation_id,operation_id,change_id,resource_gid,field_id,snapshot_kind,value_kind,field_definition_revision,execution_fingerprint,filter_fingerprint,field_resolution_fingerprint,snapshot_fingerprint,evidence_binding_fingerprint,observation_receipt_id,observation_receipt_fingerprint) ON edit_history.snapshots TO metamax_operation_worker;

-- Sequences follow actual INSERT permission, rather than all current/future sequences.
REVOKE USAGE,SELECT ON ALL SEQUENCES IN SCHEMA mirror FROM metamax_engine_runtime;
DO $$ DECLARE seq record; BEGIN
 FOR seq IN SELECT n.nspname,c.relname,t.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_depend d ON d.objid=c.oid AND d.deptype IN('a','i') JOIN pg_class t ON t.oid=d.refobjid
  WHERE n.nspname='mirror' AND c.relkind='S' LOOP
  IF has_table_privilege('metamax_engine_runtime','mirror.'||quote_ident(seq.table_name),'INSERT') THEN
   EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE mirror.%I TO metamax_engine_runtime',seq.relname); END IF;
  IF has_table_privilege('metamax_catalog_worker','mirror.'||quote_ident(seq.table_name),'INSERT') THEN
   EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE mirror.%I TO metamax_catalog_worker',seq.relname); END IF;
  IF has_table_privilege('metamax_operation_worker','mirror.'||quote_ident(seq.table_name),'INSERT') THEN
   EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE mirror.%I TO metamax_operation_worker',seq.relname); END IF;
 END LOOP;
END $$;
