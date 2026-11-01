-- Contract: docs/backend-interface-contracts.md#catalog-sync-preview-and-edit-barrier
-- These functions expose no rows and accept no SQL/field mappings. Definer
-- privileges only read lifecycle metadata; trigger owners cannot be runtime roles.
BEGIN;
CREATE FUNCTION mirror.catalog_edit_barrier(tenant text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant,581834147::bigint));
  IF NOT EXISTS(
    SELECT 1 FROM mirror.shops s JOIN mirror.publications p ON p.shop_id=s.id
    JOIN mirror.generations g ON g.shop_id=p.shop_id AND g.id=p.generation_id AND g.status='PUBLISHED'
    JOIN LATERAL (SELECT j.status,j.generation_id FROM mirror.catalog_import_jobs j
      WHERE j.shop_id=s.id AND j.installation_version=s.installation_version ORDER BY j.created_at DESC,j.id DESC LIMIT 1) latest ON true
    WHERE s.id=tenant AND s.uninstalled_at IS NULL AND latest.status='SUCCEEDED' AND latest.generation_id=p.generation_id
  ) OR EXISTS(SELECT 1 FROM mirror.catalog_import_jobs j WHERE j.shop_id=tenant
    AND (j.status IN ('QUEUED','RUNNING','RETRY') OR j.cancel_requested AND j.status NOT IN ('CANCELLED','SUCCEEDED'))) THEN
    RAISE EXCEPTION 'Editing is locked until catalog sync completes' USING ERRCODE='55000';
  END IF;
END $$;
REVOKE ALL ON FUNCTION mirror.catalog_edit_barrier(text) FROM PUBLIC;
CREATE FUNCTION mirror.assert_catalog_edit_ready(tenant text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF current_setting('app.shop_id',true) IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'Verified tenant scope required' USING ERRCODE='42501';
  END IF;
  PERFORM mirror.catalog_edit_barrier(tenant);
END $$;
REVOKE ALL ON FUNCTION mirror.assert_catalog_edit_ready(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mirror.assert_catalog_edit_ready(text) TO metamax_catalog_worker,metamax_engine_runtime,metamax_operation_worker,metamax_history_runtime;

CREATE FUNCTION mirror.guard_catalog_edit_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.kind IN ('bulk_edit','import','undo') AND
    (TG_OP='INSERT' OR NEW.status='RUNNING' AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.lease_token IS DISTINCT FROM NEW.lease_token)) THEN
    -- Global worker discovery uses its existing worker policy. Do not rewrite
    -- tenant GUCs in a BEFORE trigger: that would change the later RLS check.
    PERFORM mirror.catalog_edit_barrier(NEW.shop_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mirror.guard_catalog_edit_admission() FROM PUBLIC;
CREATE TRIGGER guard_catalog_edit_admission BEFORE INSERT OR UPDATE OF status,lease_token ON mirror.job_commands
FOR EACH ROW EXECUTE FUNCTION mirror.guard_catalog_edit_admission();

CREATE FUNCTION mirror.guard_catalog_dispatch_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.request_state='DISPATCH_AUTHORIZED' AND OLD.request_state IS DISTINCT FROM NEW.request_state)
    OR (NEW.dispatch_consumed_at IS NOT NULL AND OLD.dispatch_consumed_at IS NULL) THEN
    PERFORM mirror.catalog_edit_barrier(NEW.shop_id);
  END IF;
  -- Acknowledgment, uncertain-outcome recovery and durable finalization must
  -- remain possible after sync begins. Never gate these as a new remote send.
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mirror.guard_catalog_dispatch_admission() FROM PUBLIC;
CREATE TRIGGER guard_catalog_dispatch_admission BEFORE UPDATE OF request_state,dispatch_consumed_at ON edit_history.mutation_requests
FOR EACH ROW EXECUTE FUNCTION mirror.guard_catalog_dispatch_admission();

CREATE FUNCTION mirror.catalog_sync_has_edits(tenant text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS(SELECT 1 FROM mirror.job_commands c WHERE c.shop_id=tenant AND c.status='RUNNING' AND c.kind IN ('bulk_edit','import','undo'))
    OR EXISTS(SELECT 1 FROM edit_history.mutation_requests r WHERE r.shop_id=tenant
      AND r.request_state IN ('DISPATCH_AUTHORIZED','ACKNOWLEDGED','OUTCOME_UNKNOWN'))
$$;
REVOKE ALL ON FUNCTION mirror.catalog_sync_has_edits(text) FROM PUBLIC;
CREATE FUNCTION mirror.catalog_sync_is_blocked(tenant text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF current_setting('app.shop_id',true) IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'Verified tenant scope required' USING ERRCODE='42501';
  END IF;
  RETURN mirror.catalog_sync_has_edits(tenant);
END $$;
REVOKE ALL ON FUNCTION mirror.catalog_sync_is_blocked(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mirror.catalog_sync_is_blocked(text) TO metamax_catalog_worker;
CREATE FUNCTION mirror.guard_catalog_sync_admission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status IN ('QUEUED','RUNNING','RETRY') AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.shop_id,581834147::bigint));
    IF mirror.catalog_sync_has_edits(NEW.shop_id) THEN
      RAISE EXCEPTION 'Active or uncertain edits must drain before catalog sync' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mirror.guard_catalog_sync_admission() FROM PUBLIC;
CREATE TRIGGER guard_catalog_sync_admission BEFORE INSERT OR UPDATE OF status ON mirror.catalog_import_jobs
FOR EACH ROW EXECUTE FUNCTION mirror.guard_catalog_sync_admission();
COMMIT;
