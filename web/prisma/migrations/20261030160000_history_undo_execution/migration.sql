BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE edit_history.undo_requests ADD COLUMN resource_gid text
 CHECK(resource_gid IS NULL OR resource_gid ~ '^gid://shopify/Product/[1-9][0-9]*$');
CREATE FUNCTION edit_history.guard_undo_resource() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,edit_history,pg_temp AS $$ BEGIN
 IF NEW.resource_gid IS DISTINCT FROM OLD.resource_gid THEN RAISE EXCEPTION 'Undo target is immutable' USING ERRCODE='55000'; END IF;
 RETURN NEW; END $$;
ALTER FUNCTION edit_history.guard_undo_resource() OWNER TO metamax_history_owner;
REVOKE ALL ON FUNCTION edit_history.guard_undo_resource() FROM PUBLIC;
CREATE TRIGGER eh_undo_resource_guard BEFORE UPDATE ON edit_history.undo_requests FOR EACH ROW EXECUTE FUNCTION edit_history.guard_undo_resource();
-- AFTER observations come from Shopify while retaining the execution's pinned
-- Field/Filter coordinates. BEFORE provenance remains strict.
ALTER TABLE edit_history.snapshots DROP CONSTRAINT eh_snapshot_binding;
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_binding CHECK(
 (binding_mode='MIRROR_PINNED' AND(observation_source='MIRROR_PINNED' OR(snapshot_kind='OBSERVED_AFTER' AND observation_source='SHOPIFY_GRAPHQL'))
  AND nullif(btrim(generation_id),'') IS NOT NULL AND nullif(btrim(coverage_revision),'') IS NOT NULL
  AND nullif(btrim(mapping_version),'') IS NOT NULL AND execution_snapshot_id IS NULL)
 OR(binding_mode='SHOPIFY_DIRECT' AND observation_source='SHOPIFY_GRAPHQL' AND generation_id IS NULL AND coverage_revision IS NULL AND mapping_version IS NULL AND execution_snapshot_id IS NULL)
 OR(binding_mode='EXECUTION_SNAPSHOT' AND(observation_source='EXECUTION_SNAPSHOT' OR(snapshot_kind='OBSERVED_AFTER' AND observation_source='SHOPIFY_GRAPHQL'))
  AND generation_id IS NULL AND coverage_revision IS NULL AND mapping_version IS NULL AND nullif(btrim(execution_snapshot_id),'') IS NOT NULL));
-- Commands did not previously carry an installation identity. Never adopt an
-- unproven legacy command into the current installation after a reinstall.
ALTER TABLE mirror.job_commands ADD COLUMN installation_version text;
UPDATE mirror.job_commands c SET installation_version=p.installation_id FROM(
 SELECT shop_id,execution_job_id,min(installation_id) AS installation_id FROM edit_history.operations
 GROUP BY shop_id,execution_job_id HAVING count(DISTINCT installation_id)=1)p
 WHERE p.shop_id=c.shop_id AND p.execution_job_id=c.id;
CREATE FUNCTION mirror.pin_command_installation() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog,mirror,pg_temp AS $$ BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.installation_version IS DISTINCT FROM OLD.installation_version THEN
   RAISE EXCEPTION 'Command installation is immutable' USING ERRCODE='55000';
  END IF;
 ELSE
  IF NEW.installation_version IS NULL THEN SELECT installation_version INTO NEW.installation_version
   FROM mirror.shops WHERE id=NEW.shop_id AND uninstalled_at IS NULL FOR SHARE; END IF;
  IF NOT EXISTS(SELECT 1 FROM mirror.shops WHERE id=NEW.shop_id AND installation_version=NEW.installation_version AND uninstalled_at IS NULL) THEN
   RAISE EXCEPTION 'Current installation required for command creation' USING ERRCODE='23514';
  END IF;
 END IF; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION mirror.pin_command_installation() FROM PUBLIC;
CREATE TRIGGER command_installation_pin BEFORE INSERT OR UPDATE ON mirror.job_commands
 FOR EACH ROW EXECUTE FUNCTION mirror.pin_command_installation();
CREATE INDEX job_commands_history_claim_idx ON mirror.job_commands(status,available_at,id)
 WHERE installation_version IS NOT NULL AND kind IN('bulk_edit','undo');
CREATE INDEX eh_unresolved_family_idx ON edit_history.changes(shop_id,resource_family_gid)
 WHERE mutation_state IN('DISPATCHING','OUTCOME_UNKNOWN','ACKNOWLEDGED');
CREATE INDEX eh_undo_source_read_idx ON edit_history.changes(shop_id,installation_id,operation_id,resource_gid,field_id,prepared_at DESC,attempt_number DESC,id DESC);
CREATE INDEX eh_verified_execution_item_idx ON edit_history.mutation_requests(shop_id,installation_id,execution_item_id,operation_id)
 WHERE request_state='VERIFIED';
CREATE INDEX eh_unresolved_execution_idx ON edit_history.mutation_requests(shop_id,installation_id,operation_id)
 WHERE request_state IN('DISPATCH_AUTHORIZED','ACKNOWLEDGED','OUTCOME_UNKNOWN');
GRANT SELECT ON edit_history.undo_requests TO metamax_history_runtime;
GRANT INSERT(id,shop_id,installation_id,original_operation_id,idempotency_key,request_fingerprint,conflict_policy,handoff_key,resource_gid)
 ON edit_history.undo_requests TO metamax_history_runtime;
GRANT UPDATE(undo_state,preflight_fingerprint,inverse_plan_fingerprint,approval_reference,approved_at,execution_job_id,
 execution_contract_id,updated_at,completed_at,failure_code,retry_count,next_attempt_at) ON edit_history.undo_requests TO metamax_history_runtime;
COMMIT;
