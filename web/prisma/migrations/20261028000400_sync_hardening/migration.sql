BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;

-- Additive backstops; preserve all existing objects and historical migrations.
CREATE FUNCTION mirror.guard_sync_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.retain_until IS NULL OR OLD.retain_until>now() THEN
      RAISE EXCEPTION 'Explicit expired retention required' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.retain_until IS NOT NULL AND (NEW.retain_until IS NULL OR NEW.retain_until<OLD.retain_until) THEN
    RAISE EXCEPTION 'Generation retention cannot decrease' USING ERRCODE='23514';
  END IF;
  IF NEW.status IN ('VERIFIED','PUBLISHED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF EXISTS(SELECT 1 FROM mirror.catalog_changes WHERE shop_id=NEW.shop_id AND dirty) THEN
      RAISE EXCEPTION 'Pending mutations prevent publication' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM mirror.products WHERE shop_id=NEW.shop_id AND generation_id=NEW.id AND deleted_at IS NOT NULL)
      OR EXISTS(SELECT 1 FROM mirror.variants WHERE shop_id=NEW.shop_id AND generation_id=NEW.id AND deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'Searchable tombstones prevent publication' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_sync_retention BEFORE UPDATE OR DELETE ON mirror.generations
FOR EACH ROW EXECUTE FUNCTION mirror.guard_sync_retention();

CREATE FUNCTION mirror.guard_ingestion_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r mirror.ingestion_runs%ROWTYPE; generation_state text; retained timestamptz;
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'Committed checkpoints are immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN
    SELECT * INTO r FROM mirror.ingestion_runs WHERE shop_id=OLD.shop_id AND id=OLD.run_id;
    IF NOT FOUND THEN RETURN OLD; END IF;
    SELECT status::text,retain_until INTO generation_state,retained FROM mirror.generations
      WHERE shop_id=r.shop_id AND id=r.generation_id;
    IF NOT FOUND THEN RETURN OLD; END IF;
    IF generation_state NOT IN ('FAILED','RETIRED') OR retained IS NULL OR retained>now() THEN
      RAISE EXCEPTION 'Checkpoint remains retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT * INTO r FROM mirror.ingestion_runs WHERE shop_id=NEW.shop_id AND id=NEW.run_id FOR SHARE;
  SELECT status::text INTO generation_state FROM mirror.generations WHERE shop_id=r.shop_id AND id=r.generation_id FOR SHARE;
  IF r.status IS DISTINCT FROM 'RUNNING' OR r.lease_until IS NULL OR r.lease_until<=clock_timestamp()
    OR generation_state IS DISTINCT FROM 'INGESTING' OR NEW.checksum !~ '^[a-f0-9]{64}$' OR NEW.line_count<=0 THEN
    RAISE EXCEPTION 'Active durable ingestion checkpoint required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_ingestion_checkpoint BEFORE INSERT OR UPDATE OR DELETE ON mirror.ingestion_chunks
FOR EACH ROW EXECUTE FUNCTION mirror.guard_ingestion_checkpoint();

CREATE FUNCTION mirror.guard_completed_ingestion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='SUCCEEDED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Successful ingestion receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_completed_ingestion BEFORE UPDATE ON mirror.ingestion_runs
FOR EACH ROW EXECUTE FUNCTION mirror.guard_completed_ingestion();
COMMIT;
