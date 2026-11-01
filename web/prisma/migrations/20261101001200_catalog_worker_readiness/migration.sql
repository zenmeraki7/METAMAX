-- Contract: docs/backend-interface-contracts.md#catalog-worker-readiness
-- Only the operation worker may discover readiness across tenants; returns one
-- lifecycle boolean, no product/session data, and does not authorize execution.
BEGIN;
CREATE FUNCTION mirror.catalog_edit_is_ready(tenant text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(
  SELECT 1 FROM mirror.shops s JOIN mirror.publications p ON p.shop_id=s.id
  JOIN mirror.generations g ON g.shop_id=p.shop_id AND g.id=p.generation_id AND g.status='PUBLISHED'
  JOIN LATERAL (SELECT j.status,j.generation_id FROM mirror.catalog_import_jobs j
    WHERE j.shop_id=s.id AND j.installation_version=s.installation_version ORDER BY j.created_at DESC,j.id DESC LIMIT 1) latest ON true
  WHERE s.id=tenant AND s.uninstalled_at IS NULL AND latest.status='SUCCEEDED' AND latest.generation_id=p.generation_id
 ) AND NOT EXISTS(SELECT 1 FROM mirror.catalog_import_jobs j WHERE j.shop_id=tenant
  AND (j.status IN ('QUEUED','RUNNING','RETRY') OR j.cancel_requested AND j.status NOT IN ('CANCELLED','SUCCEEDED')))
$$;
REVOKE ALL ON FUNCTION mirror.catalog_edit_is_ready(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mirror.catalog_edit_is_ready(text) TO metamax_operation_worker;
COMMIT;
