CREATE OR REPLACE FUNCTION mirror.guard_generation_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'INGESTING' THEN RAISE EXCEPTION 'Generation must begin INGESTING' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN ('RETIRED', 'FAILED') THEN RAISE EXCEPTION 'Retire generation before cleanup' USING ERRCODE = '23514'; END IF;
    IF OLD.retain_until > now() THEN RAISE EXCEPTION 'Generation retention has not expired' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF (NEW.shop_id, NEW.id) IS DISTINCT FROM (OLD.shop_id, OLD.id) THEN
    RAISE EXCEPTION 'Generation identity is immutable' USING ERRCODE = '23514';
  END IF;
  -- Late webhook work may reopen only an unpublished, actively owned staging
  -- generation. Published and retired snapshots keep the immutable contract.
  IF OLD.status = 'VERIFIED' AND NEW.status = 'RECONCILING'
    AND OLD.published_at IS NULL AND NEW.verified_at IS NULL
    AND (to_jsonb(NEW) - ARRAY['status','verified_at']) = (to_jsonb(OLD) - ARRAY['status','verified_at'])
    AND NOT EXISTS (SELECT 1 FROM mirror.publications p WHERE p.shop_id=OLD.shop_id AND p.generation_id=OLD.id)
    AND EXISTS (SELECT 1 FROM mirror.catalog_changes c WHERE c.shop_id=OLD.shop_id AND c.dirty)
    AND EXISTS (SELECT 1 FROM mirror.catalog_import_executions e
      JOIN mirror.catalog_import_jobs j ON j.shop_id=e.shop_id AND j.id=e.id AND j.generation_id=e.generation_id
      JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
      WHERE e.shop_id=OLD.shop_id AND e.generation_id=OLD.id AND e.phase IN ('RECONCILING','PUBLISHING')
        AND e.lease_token IS NOT NULL AND e.lease_until>clock_timestamp() AND e.completed_at IS NULL
        AND NOT e.cancel_requested AND NOT j.cancel_requested AND NOT e.review_required AND NOT e.outcome_uncertain)
  THEN RETURN NEW; END IF;
  IF OLD.status IN ('VERIFIED', 'PUBLISHED', 'RETIRED') AND
    (to_jsonb(NEW) - ARRAY['status','published_at','retired_at','retain_until']) IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status','published_at','retired_at','retain_until']) THEN
    RAISE EXCEPTION 'Verified generation metadata is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('VERIFIED', 'PUBLISHED', 'RETIRED') AND NEW.published_at IS DISTINCT FROM OLD.published_at
    AND NOT (OLD.status = 'VERIFIED' AND NEW.status = 'PUBLISHED' AND NEW.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Publication timestamp is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'INGESTING' AND NEW.status IN ('RECONCILING','FAILED'))
    OR (OLD.status = 'RECONCILING' AND NEW.status IN ('VERIFIED','FAILED'))
    OR (OLD.status = 'VERIFIED' AND NEW.status IN ('PUBLISHED','RETIRED'))
    OR (OLD.status = 'PUBLISHED' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'Invalid generation state transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RECONCILING' AND EXISTS (
    SELECT 1 FROM unnest(NEW.required_datasets) d(name) WHERE NOT EXISTS (
      SELECT 1 FROM mirror.ingestion_runs r WHERE r.shop_id = NEW.shop_id AND r.generation_id = NEW.id
      AND r.dataset = d.name AND r.status = 'SUCCEEDED')) THEN
    RAISE EXCEPTION 'Durable ingestion must finish before reconciliation' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'VERIFIED' AND (NEW.verified_at IS NULL OR EXISTS (
    SELECT 1 FROM unnest(NEW.required_datasets) d(name) WHERE NOT EXISTS (
      SELECT 1 FROM mirror.coverage c WHERE c.shop_id = NEW.shop_id AND c.generation_id = NEW.id
      AND c.name = d.name AND c.status = 'COMPLETE'))) THEN
    RAISE EXCEPTION 'Complete verified coverage required' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'RETIRED' AND EXISTS (SELECT 1 FROM mirror.publications p
    WHERE p.shop_id = NEW.shop_id AND p.generation_id = NEW.id) THEN
    RAISE EXCEPTION 'Move or remove publication pointer before retirement' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
