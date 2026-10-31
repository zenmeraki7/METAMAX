-- Requires deployment-role administration. No login credentials or keys here.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ DECLARE r text; BEGIN
 FOREACH r IN ARRAY ARRAY['metamax_history_owner','metamax_history_runtime','metamax_history_maintenance','metamax_history_privacy'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
   EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',r);
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r AND(rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
   RAISE EXCEPTION 'Unsafe existing history role';
  END IF;
 END LOOP;
END $$;
GRANT metamax_history_owner TO CURRENT_USER;
GRANT USAGE,CREATE ON SCHEMA edit_history TO metamax_history_owner;
GRANT USAGE ON SCHEMA edit_history TO metamax_history_runtime,metamax_history_maintenance,metamax_history_privacy;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()); END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA edit_history FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA edit_history FROM PUBLIC;
REVOKE CREATE ON SCHEMA edit_history FROM PUBLIC;

ALTER TABLE edit_history.operations ADD COLUMN purge_requested_at timestamptz;
ALTER TABLE edit_history.operations ADD COLUMN purge_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE edit_history.operations ADD COLUMN purge_next_attempt_at timestamptz;
ALTER TABLE edit_history.operations ADD COLUMN purge_review_required boolean NOT NULL DEFAULT false;
ALTER TABLE edit_history.operations ADD COLUMN encryption_review_required boolean NOT NULL DEFAULT false;
ALTER TABLE edit_history.mutation_requests ADD COLUMN dispatch_token_hash text;
ALTER TABLE edit_history.mutation_requests ADD COLUMN dispatch_consumed_at timestamptz;
ALTER TABLE edit_history.mutation_requests ADD CONSTRAINT eh_request_consumption CHECK(
 (dispatch_token_hash IS NULL OR dispatch_token_hash ~ '^sha256:[0-9a-f]{64}$') AND
 (dispatch_consumed_at IS NULL OR dispatch_token_hash IS NOT NULL));
CREATE FUNCTION edit_history.guard_dispatch_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.dispatch_token_hash IS NOT NULL AND OLD.dispatch_token_hash IS DISTINCT FROM NEW.dispatch_token_hash OR
  OLD.dispatch_consumed_at IS NOT NULL AND OLD.dispatch_consumed_at IS DISTINCT FROM NEW.dispatch_consumed_at OR
  OLD.dispatch_token_hash IS NULL AND NEW.dispatch_token_hash IS NOT NULL AND
   (OLD.request_state<>'PREPARED' OR NEW.request_state<>'DISPATCH_AUTHORIZED') THEN
  RAISE EXCEPTION 'Dispatch consumption identity is immutable' USING ERRCODE='55000';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER eh_dispatch_consumption BEFORE UPDATE ON edit_history.mutation_requests
 FOR EACH ROW EXECUTE FUNCTION edit_history.guard_dispatch_consumption();
ALTER TABLE edit_history.operations ALTER COLUMN retained_until SET DEFAULT(clock_timestamp()+interval '30 days');
-- Enforces encryption for new VALUE snapshots without rewriting historical
-- plaintext under the migration role or inventing keys.
ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_encrypt_new_values
 CHECK(value_kind='ABSENT' OR value_encoding='ENCRYPTED_JSON') NOT VALID;
CREATE TABLE edit_history.privacy_scopes(
 shop_id text NOT NULL,installation_id text NOT NULL,uninstalled_at timestamptz NOT NULL,
 redact_requested_at timestamptz,completed_at timestamptz,review_required boolean NOT NULL DEFAULT false,
 PRIMARY KEY(shop_id,installation_id)
);
CREATE TABLE edit_history.purge_receipts(
 scope_digest text NOT NULL,operation_id uuid NOT NULL,reason text NOT NULL CHECK(reason IN('RETENTION','UNINSTALL','SHOP_REDACT')),
 purged_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT(clock_timestamp()+interval '30 days'),PRIMARY KEY(scope_digest,operation_id)
);
CREATE INDEX eh_retention_due ON edit_history.operations(retained_until,created_at,id) WHERE NOT legal_hold;

CREATE OR REPLACE FUNCTION edit_history.reject_history_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user<>'metamax_history_owner' THEN RAISE EXCEPTION 'History deletion requires retention maintenance' USING ERRCODE='42501'; END IF;
 RETURN OLD;
END $$;
CREATE OR REPLACE FUNCTION edit_history.reject_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user='metamax_history_owner' THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF OLD.value_encoding='JSONB' AND NEW.value_encoding='ENCRYPTED_JSON' AND NEW.value_json IS NULL
   AND NEW.encrypted_value IS NOT NULL AND NEW.encryption_key_reference IS NOT NULL AND
   (to_jsonb(OLD)-'value_encoding'-'value_json'-'encrypted_value'-'encryption_key_reference')=
   (to_jsonb(NEW)-'value_encoding'-'value_json'-'encrypted_value'-'encryption_key_reference') THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'Edit history snapshots are immutable' USING ERRCODE='55000';
END $$;

CREATE FUNCTION edit_history.capture_uninstall() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,edit_history,pg_temp AS $$
BEGIN
 IF NEW.uninstalled_at IS NOT NULL AND(OLD.uninstalled_at IS NULL OR OLD.installation_version IS DISTINCT FROM NEW.installation_version) THEN
  INSERT INTO edit_history.privacy_scopes(shop_id,installation_id,uninstalled_at)
   VALUES(NEW.id,NEW.installation_version,NEW.uninstalled_at) ON CONFLICT DO NOTHING;
  -- Cancel/fence execution; never infer its remote mutation result.
  UPDATE mirror.job_commands c SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),
   fence=CASE WHEN fence<9223372036854775807 THEN fence+1 ELSE fence END,
   lease_until=CASE WHEN lease_until IS NULL THEN NULL ELSE LEAST(lease_until,clock_timestamp()) END
   WHERE c.shop_id=NEW.id AND c.cancel_requested_at IS NULL AND c.id IN(
    SELECT o.execution_job_id FROM edit_history.operations o WHERE o.shop_id=NEW.id AND o.installation_id=NEW.installation_version
    UNION SELECT u.execution_job_id FROM edit_history.undo_requests u WHERE u.shop_id=NEW.id AND u.installation_id=NEW.installation_version);
  UPDATE edit_history.recovery_tasks SET task_state='CANCELLED',claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,
   completed_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE shop_id=NEW.id AND installation_id=NEW.installation_version AND task_state NOT IN('COMPLETED','CANCELLED','REVIEW_REQUIRED');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER eh_capture_uninstall AFTER UPDATE OF uninstalled_at,installation_version ON mirror.shops
 FOR EACH ROW EXECUTE FUNCTION edit_history.capture_uninstall();
INSERT INTO edit_history.privacy_scopes(shop_id,installation_id,uninstalled_at)
 SELECT id,installation_version,uninstalled_at FROM mirror.shops WHERE uninstalled_at IS NOT NULL;

CREATE FUNCTION edit_history.request_shop_redaction(target_shop text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,edit_history,pg_temp AS $$
DECLARE affected integer; BEGIN
 -- Delayed shop/redact never tombstones a newly installed current shop.
 INSERT INTO edit_history.privacy_scopes(shop_id,installation_id,uninstalled_at)
  SELECT DISTINCT o.shop_id,o.installation_id,COALESCE(s.uninstalled_at,clock_timestamp())
  FROM edit_history.operations o LEFT JOIN mirror.shops s ON s.id=o.shop_id
  WHERE o.shop_id=target_shop AND NOT EXISTS(SELECT 1 FROM mirror.shops live WHERE live.id=o.shop_id
   AND live.installation_version=o.installation_id AND live.uninstalled_at IS NULL)
  ON CONFLICT DO NOTHING;
 UPDATE edit_history.privacy_scopes SET redact_requested_at=COALESCE(redact_requested_at,clock_timestamp()),completed_at=NULL
  WHERE shop_id=target_shop AND completed_at IS NULL;
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected;
END $$;

CREATE FUNCTION edit_history.purge_history_batch(batch_rows integer DEFAULT 250) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,edit_history,pg_temp AS $$
DECLARE op edit_history.operations%ROWTYPE; remaining integer:=batch_rows; removed integer:=0; n integer; t text; column_name text; why text; digest text;
BEGIN
 IF batch_rows IS NULL OR batch_rows NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Bounded retention batch required' USING ERRCODE='22023'; END IF;
 SELECT o.* INTO op FROM edit_history.operations o
 LEFT JOIN edit_history.privacy_scopes p ON p.shop_id=o.shop_id AND p.installation_id=o.installation_id
 WHERE NOT o.legal_hold AND NOT o.purge_review_required AND(o.purge_next_attempt_at IS NULL OR o.purge_next_attempt_at<=clock_timestamp()) AND(
  o.purge_requested_at IS NOT NULL OR
  p.redact_requested_at IS NOT NULL OR p.uninstalled_at+interval '30 days'<=clock_timestamp() OR
  (o.operation_state IN('COMPLETED','PARTIAL','FAILED','CANCELLED') AND
   COALESCE(o.retained_until,o.created_at+interval '30 days')<=clock_timestamp() AND NOT EXISTS(
    SELECT 1 FROM mirror.job_commands c WHERE c.shop_id=o.shop_id AND c.id=o.execution_job_id AND c.status='RUNNING'
     AND c.lease_until>clock_timestamp() AND c.cancel_requested_at IS NULL)))
 ORDER BY o.created_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN
  WITH due AS(SELECT shop_id,installation_id FROM edit_history.privacy_scopes WHERE completed_at IS NULL
   AND(redact_requested_at IS NOT NULL OR uninstalled_at+interval '30 days'<=clock_timestamp())
   ORDER BY uninstalled_at LIMIT batch_rows FOR UPDATE SKIP LOCKED)
  UPDATE edit_history.privacy_scopes p SET review_required=EXISTS(SELECT 1 FROM edit_history.operations o
   WHERE o.shop_id=p.shop_id AND o.installation_id=p.installation_id AND(o.legal_hold OR o.purge_review_required)),
   completed_at=CASE WHEN NOT EXISTS(SELECT 1 FROM edit_history.operations o WHERE o.shop_id=p.shop_id AND o.installation_id=p.installation_id)
    THEN COALESCE(p.completed_at,clock_timestamp()) ELSE NULL END
   FROM due WHERE p.shop_id=due.shop_id AND p.installation_id=due.installation_id;
  DELETE FROM edit_history.privacy_scopes WHERE ctid IN(SELECT ctid FROM edit_history.privacy_scopes
   WHERE completed_at IS NOT NULL AND NOT review_required ORDER BY completed_at LIMIT remaining FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n=ROW_COUNT;removed:=n;remaining:=remaining-n;
  IF remaining>0 THEN
   DELETE FROM edit_history.purge_receipts WHERE ctid IN(SELECT ctid FROM edit_history.purge_receipts
    WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT remaining FOR UPDATE SKIP LOCKED);
   GET DIAGNOSTICS n=ROW_COUNT;removed:=removed+n;
  END IF;
  RETURN jsonb_build_object('deletedRows',removed,'operationCompleted',false);
 END IF;
 -- A live reinstall of the *same* identity must never inherit an old purge.
 IF EXISTS(SELECT 1 FROM mirror.shops WHERE id=op.shop_id AND installation_version=op.installation_id AND uninstalled_at IS NULL)
  AND EXISTS(SELECT 1 FROM edit_history.privacy_scopes WHERE shop_id=op.shop_id AND installation_id=op.installation_id) THEN
  RAISE EXCEPTION 'Installation privacy identity reused' USING ERRCODE='55000';
 END IF;
 UPDATE edit_history.operations SET purge_requested_at=COALESCE(purge_requested_at,clock_timestamp()) WHERE id=op.id;
 FOREACH t IN ARRAY ARRAY['recovery_tasks','undo_requests','snapshots','changes','mutation_requests'] LOOP
  -- Table identifiers are a server-owned constant list. Work is bounded even
  -- for an operation containing millions of fields; each batch commits progress.
  column_name:=CASE WHEN t='undo_requests' THEN 'original_operation_id' ELSE 'operation_id' END;
  EXECUTE format('DELETE FROM edit_history.%I WHERE ctid IN(SELECT ctid FROM edit_history.%I WHERE shop_id=$1 AND installation_id=$2 AND %I=$3 LIMIT $4)',t,t,column_name)
   USING op.shop_id,op.installation_id,op.id,remaining;
  GET DIAGNOSTICS n=ROW_COUNT;removed:=removed+n;remaining:=remaining-n;
  IF remaining=0 THEN RETURN jsonb_build_object('deletedRows',removed,'operationCompleted',false); END IF;
 END LOOP;
 SELECT CASE WHEN p.redact_requested_at IS NOT NULL THEN 'SHOP_REDACT' ELSE 'UNINSTALL' END INTO why
  FROM edit_history.privacy_scopes p WHERE p.shop_id=op.shop_id AND p.installation_id=op.installation_id;
 why:=COALESCE(why,'RETENTION');
 digest:=encode(sha256(convert_to(jsonb_build_array(op.shop_id,op.installation_id)::text,'UTF8')),'hex');
 DELETE FROM edit_history.operations WHERE id=op.id;
 INSERT INTO edit_history.purge_receipts(scope_digest,operation_id,reason) VALUES(digest,op.id,why) ON CONFLICT DO NOTHING;
 RETURN jsonb_build_object('deletedRows',removed+1,'operationCompleted',true);
EXCEPTION
 WHEN serialization_failure OR deadlock_detected OR query_canceled THEN RAISE;
 WHEN OTHERS THEN
  IF op.id IS NULL THEN RAISE; END IF;
  UPDATE edit_history.operations SET purge_requested_at=COALESCE(purge_requested_at,clock_timestamp()),
   purge_attempts=purge_attempts+1,purge_review_required=purge_attempts+1>=8,
   purge_next_attempt_at=clock_timestamp()+LEAST(900,30*power(2,LEAST(purge_attempts,5))) * interval '1 second' WHERE id=op.id;
  RETURN jsonb_build_object('deletedRows',0,'operationCompleted',false,'retryScheduled',true,'errorCode',SQLSTATE);
END $$;

CREATE FUNCTION edit_history.encrypt_legacy_snapshot(target_shop text,target_installation text,target_snapshot uuid,expected_hash text,ciphertext bytea,key_reference text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,edit_history,pg_temp AS $$
DECLARE affected integer; BEGIN
 IF ciphertext IS NULL OR octet_length(ciphertext) NOT BETWEEN 30 AND 32832 OR key_reference IS NULL OR length(btrim(key_reference)) NOT BETWEEN 1 AND 256 THEN
  RAISE EXCEPTION 'Invalid encrypted history payload' USING ERRCODE='22023'; END IF;
 UPDATE edit_history.snapshots SET value_encoding='ENCRYPTED_JSON',value_json=NULL,encrypted_value=ciphertext,encryption_key_reference=key_reference
  WHERE shop_id=target_shop AND installation_id=target_installation AND id=target_snapshot AND snapshot_fingerprint=expected_hash
  AND value_encoding='JSONB' AND value_kind='VALUE';
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected=1;
END $$;

CREATE FUNCTION edit_history.legacy_snapshot_batch(batch_rows integer) RETURNS SETOF edit_history.snapshots
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,edit_history,pg_temp AS $$
DECLARE target uuid; BEGIN
 IF batch_rows IS NULL OR batch_rows NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'Bounded encryption batch required' USING ERRCODE='22023'; END IF;
 SELECT o.id INTO target FROM edit_history.operations o WHERE o.purge_requested_at IS NULL AND NOT o.encryption_review_required
  AND EXISTS(SELECT 1 FROM edit_history.snapshots s WHERE s.operation_id=o.id AND s.value_kind='VALUE' AND s.value_encoding='JSONB')
  ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN; END IF;
 RETURN QUERY SELECT s.* FROM edit_history.snapshots s WHERE s.operation_id=target AND s.value_kind='VALUE' AND s.value_encoding='JSONB'
  ORDER BY s.id LIMIT batch_rows FOR UPDATE OF s SKIP LOCKED;
END $$;
CREATE FUNCTION edit_history.mark_encryption_review(target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER
 SET search_path=pg_catalog,edit_history,pg_temp AS $$
 UPDATE edit_history.operations SET encryption_review_required=true WHERE id=target AND purge_requested_at IS NULL;
$$;
CREATE INDEX eh_snapshot_legacy_encryption ON edit_history.snapshots(operation_id,id) WHERE value_kind='VALUE' AND value_encoding='JSONB';

GRANT SELECT ON edit_history.changes,edit_history.snapshots,
 edit_history.recovery_tasks,edit_history.mutation_requests TO metamax_history_runtime;
GRANT INSERT(id,shop_id,installation_id,operation_id,execution_item_id,mutation_id,attempt_id,attempt_number,
 execution_fence_epoch,execution_claim_id,resource_gid,resource_family_gid,field_id,field_definition_revision,
 mutation_plan_fingerprint,intended_value_fingerprint,before_snapshot_fingerprint,prepared_at) ON edit_history.changes TO metamax_history_runtime;
GRANT INSERT(id,shop_id,installation_id,operation_id,change_id,snapshot_kind,value_kind,value_json,snapshot_fingerprint,
 evidence_binding_fingerprint,observation_id,observation_source,observed_at,source_revision,observation_receipt_id,observation_receipt_fingerprint,
 resource_gid,field_id,field_definition_revision,filter_fingerprint,execution_fingerprint,field_resolution_fingerprint,binding_mode,generation_id,
 coverage_revision,mapping_version,execution_snapshot_id,mirror_before_snapshot_id,value_encoding,encrypted_value,encryption_key_reference)
 ON edit_history.snapshots TO metamax_history_runtime;
GRANT INSERT(id,shop_id,installation_id,operation_id,change_id,task_kind,dedupe_key) ON edit_history.recovery_tasks TO metamax_history_runtime;
GRANT INSERT(id,shop_id,installation_id,operation_id,mutation_id,attempt_id,attempt_number,execution_item_id,execution_fence_epoch,
 execution_claim_id,mutation_plan_fingerprint,request_fingerprint,resource_field_set,field_count,request_state,dispatch_handoff_key)
 ON edit_history.mutation_requests TO metamax_history_runtime;
GRANT SELECT ON edit_history.operations TO metamax_history_runtime;
GRANT INSERT(id,shop_id,installation_id,execution_job_id,edit_operation_id,execution_contract_id,operation_kind,
 execution_fingerprint,filter_fingerprint,approved_contract_fingerprint,field_mapping_version) ON edit_history.operations TO metamax_history_runtime;
GRANT UPDATE(operation_state,changes_recorded,changes_verified,changes_failed,changes_uncertain,completed_at,updated_at) ON edit_history.operations TO metamax_history_runtime;
GRANT UPDATE(mutation_state,verification_state,last_evidence_kind,last_evidence_fingerprint,dispatch_started_at,acknowledged_at,verified_at,updated_at) ON edit_history.changes TO metamax_history_runtime;
GRANT UPDATE(request_state,dispatch_authorized_at,dispatch_evidence_fingerprint,outcome_evidence_kind,outcome_evidence_fingerprint,
 acknowledged_at,verified_at,updated_at,dispatch_token_hash,dispatch_consumed_at) ON edit_history.mutation_requests TO metamax_history_runtime;
GRANT UPDATE(task_state,claimed_by,claim_token,claim_expires_at,fence_epoch,attempt_count,available_at,completed_at,updated_at,last_error_code,evidence_fingerprint,last_checked_at)
 ON edit_history.recovery_tasks TO metamax_history_runtime;
GRANT SELECT ON edit_history.operations,edit_history.changes,edit_history.snapshots,edit_history.privacy_scopes,edit_history.purge_receipts TO metamax_history_maintenance;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA edit_history TO metamax_history_owner;
GRANT USAGE ON SCHEMA mirror TO metamax_history_owner;
GRANT SELECT ON mirror.shops,mirror.job_commands TO metamax_history_owner;
GRANT UPDATE(cancel_requested_at,fence,lease_until) ON mirror.job_commands TO metamax_history_owner;
-- PostgreSQL row locks require UPDATE permission on at least one column. Give
-- history an inert lock carrier, never permission to change engine claims,
-- approvals, installation identity, catalog values or source snapshot payloads.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['shops','job_commands','edit_operations','job_items','execution_contracts','selection_snapshots',
  'generations','coverage','products','product_snapshots'] LOOP
  EXECUTE format('ALTER TABLE mirror.%I ADD COLUMN _history_lock integer NOT NULL DEFAULT 0',t);
  EXECUTE format('GRANT UPDATE(_history_lock) ON mirror.%I TO metamax_history_runtime',t);
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA mirror TO metamax_history_runtime;
GRANT SELECT ON mirror.shops,mirror.job_commands,mirror.edit_operations,mirror.job_items,mirror.execution_contracts,
 mirror.selection_snapshots,mirror.generations,mirror.coverage,mirror.products,mirror.product_snapshots,mirror.variants,
 mirror.selection_items,mirror.publications TO metamax_history_runtime;
ALTER FUNCTION edit_history.capture_uninstall() OWNER TO metamax_history_owner;
ALTER FUNCTION edit_history.request_shop_redaction(text) OWNER TO metamax_history_owner;
ALTER FUNCTION edit_history.purge_history_batch(integer) OWNER TO metamax_history_owner;
ALTER FUNCTION edit_history.encrypt_legacy_snapshot(text,text,uuid,text,bytea,text) OWNER TO metamax_history_owner;
ALTER FUNCTION edit_history.legacy_snapshot_batch(integer) OWNER TO metamax_history_owner;
ALTER FUNCTION edit_history.mark_encryption_review(uuid) OWNER TO metamax_history_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA edit_history FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA edit_history FROM PUBLIC;
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT c.relname,a.attname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) x
  WHERE n.nspname='edit_history' AND x.grantee=0 LOOP
  EXECUTE format('REVOKE ALL(%I) ON edit_history.%I FROM PUBLIC',item.attname,item.relname);
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION edit_history.request_shop_redaction(text) TO metamax_history_privacy;
GRANT EXECUTE ON FUNCTION edit_history.purge_history_batch(integer),edit_history.encrypt_legacy_snapshot(text,text,uuid,text,bytea,text),
 edit_history.legacy_snapshot_batch(integer),edit_history.mark_encryption_review(uuid)
 TO metamax_history_maintenance;
COMMIT;
