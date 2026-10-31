-- Append to the generated initial migration. Never apply this file alone.
-- Runtime writers must acquire the publication barrier BEFORE their first read.

ALTER TABLE mirror.shops ADD CONSTRAINT shop_domain CHECK
  (id ~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$' AND length(id) <= 255);

ALTER TABLE mirror.generations ADD CONSTRAINT required_datasets_nonempty CHECK
  (cardinality(required_datasets) > 0 AND cardinality(required_datasets) <= 32
   AND array_position(required_datasets, NULL) IS NULL
   AND required_datasets @> ARRAY['products']::text[]
   AND required_datasets <@ ARRAY['products','variants','inventory_items','inventory_levels',
     'locations','collections','product_options','categories','metafields']::text[]);
ALTER TABLE mirror.generations ADD CONSTRAINT generation_verified_timestamps CHECK
  ((status NOT IN ('VERIFIED','PUBLISHED','RETIRED') OR verified_at IS NOT NULL)
   AND (status <> 'PUBLISHED' OR published_at IS NOT NULL));
ALTER TABLE mirror.coverage ADD CONSTRAINT coverage_verified CHECK
  (name ~ '^[a-z][a-z0-9_]{0,63}$' AND durable_rows >= 0
   AND (status <> 'COMPLETE' OR (verified_at IS NOT NULL AND verification_hash IS NOT NULL)));
ALTER TABLE mirror.ingestion_runs ADD CONSTRAINT ingestion_durable_counts CHECK
  (processed_lines >= 0 AND invalid_lines >= 0 AND fence >= 0
   AND (expected_lines IS NULL OR (expected_lines >= 0 AND processed_lines <= expected_lines))
   AND (status <> 'SUCCEEDED' OR (expected_lines IS NOT NULL
     AND expected_lines = processed_lines AND invalid_lines = 0
     AND eof_verified AND writes_finished_at IS NOT NULL)));
ALTER TABLE mirror.ingestion_chunks ADD CONSTRAINT chunk_counts CHECK (ordinal >= 0 AND line_count >= 0);
ALTER TABLE mirror.catalog_changes ADD CONSTRAINT reconciliation_revisions CHECK
  (revision > 0 AND applied_revision >= 0 AND applied_revision <= revision
   AND (dirty OR applied_revision = revision) AND attempts >= 0 AND fence >= 0);

CREATE INDEX catalog_changes_due ON mirror.catalog_changes
  (shop_id, next_attempt_at, product_id) WHERE dirty AND dead_letter_at IS NULL;
CREATE INDEX job_commands_due ON mirror.job_commands (available_at, id)
  WHERE status IN ('PENDING', 'RETRY');
CREATE INDEX job_commands_recover ON mirror.job_commands (lease_until, id)
  WHERE status = 'RUNNING';
CREATE INDEX outbox_events_due ON mirror.outbox_events (available_at, id)
  WHERE dispatched_at IS NULL;
CREATE INDEX job_schedules_due ON mirror.job_schedules (next_run_at, id) WHERE enabled;

ALTER TABLE mirror.products ADD CONSTRAINT product_revision CHECK (source_revision >= 0);
ALTER TABLE mirror.variants ADD CONSTRAINT variant_revision CHECK (source_revision >= 0);
ALTER TABLE mirror.products ADD CONSTRAINT product_shopify_identity CHECK (shopify_id ~ '^gid://shopify/Product/[1-9][0-9]*$');
ALTER TABLE mirror.variants ADD CONSTRAINT variant_shopify_identity CHECK (shopify_id ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$');
ALTER TABLE mirror.catalog_changes ADD CONSTRAINT change_shopify_identity CHECK (product_id ~ '^gid://shopify/Product/[1-9][0-9]*$');
ALTER TABLE mirror.metafield_definitions ADD CONSTRAINT definition_shopify_identity CHECK
  (shopify_definition_id ~ '^gid://shopify/MetafieldDefinition/[1-9][0-9]*$');
ALTER TABLE mirror.product_metafields ADD CONSTRAINT product_metafield_owner CHECK (owner_entity = 'product');
ALTER TABLE mirror.variant_metafields ADD CONSTRAINT variant_metafield_owner CHECK (owner_entity = 'variant');
ALTER TABLE mirror.metafield_definitions ADD CONSTRAINT definition_verification CHECK
  ((precision IS NULL AND scale IS NULL OR (precision IS NOT NULL AND scale IS NOT NULL
     AND precision BETWEEN 1 AND 38 AND scale BETWEEN 0 AND precision))
   AND (NOT definition_verified OR (verified_at IS NOT NULL AND verification_expires_at IS NOT NULL AND verification_expires_at > verified_at
     AND definition_token ~ '^[A-Za-z0-9_-]+$' AND length(definition_token) BETWEEN 16 AND 256)));
ALTER TABLE mirror.selection_snapshots ADD CONSTRAINT selection_frozen CHECK
  (selected_count >= 0 AND expires_at > created_at
   AND (status <> 'APPROVED' OR (frozen_at IS NOT NULL AND selection_hash IS NOT NULL)));
ALTER TABLE mirror.execution_contracts ADD CONSTRAINT contract_approved CHECK
  (status <> 'APPROVED' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL));
ALTER TABLE mirror.job_commands ADD CONSTRAINT command_retry_bounds CHECK
  (attempts >= 0 AND max_attempts BETWEEN 1 AND 100 AND attempts <= max_attempts AND fence >= 0
   AND (status <> 'RUNNING' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)));
ALTER TABLE mirror.job_items ADD CONSTRAINT item_retry_bounds CHECK (attempts >= 0);
ALTER TABLE mirror.outbox_events ADD CONSTRAINT outbox_retry_bounds CHECK (attempts >= 0 AND fence >= 0);
ALTER TABLE mirror.job_schedules ADD CONSTRAINT schedule_fence CHECK (fence >= 0);
ALTER TABLE mirror.job_artifacts ADD CONSTRAINT artifact_integrity CHECK
  (byte_length >= 0 AND (row_count IS NULL OR row_count >= 0) AND sha256 ~ '^[a-f0-9]{64}$');

-- Freeze all published catalog data. Writers lock this parent row while staging;
-- the status transition waits for in-flight writers rather than racing them.
CREATE FUNCTION mirror.guard_generation_data() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text; tenant text; gen text; mapping text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.shop_id, NEW.generation_id) IS DISTINCT FROM (OLD.shop_id, OLD.generation_id) THEN
    RAISE EXCEPTION 'Cannot move rows between tenants or generations' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN tenant := OLD.shop_id; gen := OLD.generation_id;
  ELSE tenant := NEW.shop_id; gen := NEW.generation_id; END IF;
  SELECT status::text, mapping_version INTO s, mapping FROM mirror.generations WHERE shop_id = tenant AND id = gen FOR SHARE;
  -- A cascaded deletion of the parent has already checked retained references.
  IF NOT FOUND AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF s IS NULL OR (s NOT IN ('INGESTING', 'RECONCILING') AND NOT (TG_OP = 'DELETE' AND s IN ('RETIRED', 'FAILED'))) THEN
    RAISE EXCEPTION 'Generation data is immutable outside staging' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('products', 'variants') AND TG_OP = 'UPDATE' THEN
    IF NEW.source_revision < OLD.source_revision THEN
      RAISE EXCEPTION 'Stale mirror revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'field_mappings' AND TG_OP <> 'DELETE' THEN
    IF NEW.mapping_version <> mapping THEN RAISE EXCEPTION 'Mapping version differs from generation' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['products','variants','inventory_items','locations','inventory_levels',
    'collections','product_collections','product_options','categories','product_metafields',
    'variant_metafields','field_mappings','coverage','ingestion_runs'] LOOP
    EXECUTE format('CREATE TRIGGER guard_generation_data BEFORE INSERT OR UPDATE OR DELETE ON mirror.%I
      FOR EACH ROW EXECUTE FUNCTION mirror.guard_generation_data()', t);
  END LOOP;
END $$;

CREATE FUNCTION mirror.guard_generation_status() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER guard_generation_status BEFORE INSERT OR UPDATE OR DELETE ON mirror.generations
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_generation_status();

CREATE FUNCTION mirror.guard_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mirror.generations g WHERE g.shop_id = NEW.shop_id AND g.id = NEW.generation_id
    AND g.status = 'PUBLISHED' AND g.verified_at IS NOT NULL AND g.published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Only verified published generations may become current' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_publication BEFORE INSERT OR UPDATE ON mirror.publications
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_publication();

-- Selection membership becomes immutable at approval; row locks serialize an
-- insertion with a concurrent freeze. Runtime still verifies counts and hashes.
CREATE FUNCTION mirror.guard_selection_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen timestamptz; approval text; tenant text; snapshot text;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Selection items cannot be changed' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN tenant := OLD.shop_id; snapshot := OLD.snapshot_id;
  ELSE tenant := NEW.shop_id; snapshot := NEW.snapshot_id; END IF;
  SELECT frozen_at, status::text INTO frozen, approval FROM mirror.selection_snapshots
    WHERE shop_id = tenant AND id = snapshot FOR UPDATE;
  IF NOT FOUND AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF frozen IS NOT NULL OR approval IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Selection is frozen' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_selection_item BEFORE INSERT OR UPDATE OR DELETE ON mirror.selection_items
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_selection_item();

CREATE FUNCTION mirror.guard_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN RAISE EXCEPTION 'Approval must begin DRAFT' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'APPROVED' THEN
    IF TG_TABLE_NAME = 'selection_snapshots' THEN
      IF NOT EXISTS (SELECT 1 FROM mirror.generations g WHERE g.shop_id = NEW.shop_id AND g.id = NEW.generation_id
        AND g.status = 'PUBLISHED') THEN
        RAISE EXCEPTION 'Selection requires a published generation' USING ERRCODE = '23514';
      END IF;
      IF NEW.selected_count <> (SELECT count(*) FROM mirror.selection_items
        WHERE shop_id = NEW.shop_id AND snapshot_id = NEW.id) THEN
        RAISE EXCEPTION 'Selection count differs from frozen membership' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM mirror.selection_snapshots s WHERE s.shop_id = NEW.shop_id AND s.id = NEW.snapshot_id
        AND s.status = 'APPROVED' AND s.operation = NEW.operation AND s.expires_at > now()
        AND NEW.expires_at <= s.expires_at) THEN
        RAISE EXCEPTION 'Approved matching selection required' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.status IN ('REVOKED','EXPIRED') AND OLD.expires_at <= now() THEN RETURN OLD; END IF;
      RAISE EXCEPTION 'Approval must be revoked or expired before cleanup' USING ERRCODE = '23514';
    END IF;
    IF NEW.status NOT IN (OLD.status, 'REVOKED', 'EXPIRED') OR
      (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'Approved contract or selection is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_selection_approval BEFORE INSERT OR UPDATE OR DELETE ON mirror.selection_snapshots
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_approval();
CREATE TRIGGER guard_execution_approval BEFORE INSERT OR UPDATE OR DELETE ON mirror.execution_contracts
  FOR EACH ROW EXECUTE FUNCTION mirror.guard_approval();
