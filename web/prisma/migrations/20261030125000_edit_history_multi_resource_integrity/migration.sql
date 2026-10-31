-- METAMAX — Multi-Resource Integrity Migration V2
--
-- PostgreSQL 15+
-- History Contract V3
--
-- PURPOSE
-- Correct uniqueness for multiple Shopify resources
-- changing the same field within one mutation attempt.
--
-- This migration:
-- 1. Supports the two previously proposed constraint
--    naming schemes.
-- 2. Refuses unknown or partially migrated schemas.
-- 3. Preserves tenant-scoped constraints.
-- 4. Serializes admission at the history-operation level.
-- 5. Checks shared attempt identity on INSERT only.
-- 6. Avoids an unnecessary duplicate lookup index.
--
-- It does not modify mirror.* tables.
-- It does not authorize Shopify mutation dispatch.
--
-- Apply transactionally with Prisma Migrate.
-- Do not apply to production before checking the
-- actual deployed schema and integration test results.

-- ======================================================
-- 1. SCHEMA PRECONDITIONS
-- ======================================================

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$
DECLARE
  old_field_constraint TEXT;
  old_number_constraint TEXT;
  identity_trigger_count INTEGER;
BEGIN
  IF to_regclass('edit_history.operations') IS NULL
     OR to_regclass('edit_history.changes') IS NULL
     OR to_regclass('edit_history.snapshots') IS NULL
  THEN
    RAISE EXCEPTION
      'Required Edit History tables do not exist';
  END IF;

  -- Lock before inspecting metadata or existing rows, not after the audit.
  LOCK TABLE edit_history.operations,edit_history.changes IN ACCESS EXCLUSIVE MODE;

  SELECT count(*)
  INTO identity_trigger_count
  FROM pg_trigger
  WHERE tgrelid = 'edit_history.changes'::regclass
    AND NOT tgisinternal
    AND tgname IN (
      'hist_changes_protect_identity',
      'eh_change_guard'
    )
    AND tgenabled = 'O';

  IF identity_trigger_count <> 1 THEN
    RAISE EXCEPTION
      'Expected enabled change-identity protection is missing or ambiguous';
  END IF;

  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='edit_history.changes'::regclass AND contype='u'
    AND conname IN ('hist_changes_attempt_field_unique','eh_change_attempt_field_unique'))<>1 OR
     (SELECT count(*) FROM pg_constraint WHERE conrelid='edit_history.changes'::regclass AND contype='u'
    AND conname IN ('hist_changes_attempt_number_unique','eh_change_attempt_number_unique'))<>1 THEN
    RAISE EXCEPTION 'Missing or ambiguous prior uniqueness constraints';
  END IF;

  SELECT conname
  INTO old_field_constraint
  FROM pg_constraint
  WHERE conrelid = 'edit_history.changes'::regclass
    AND contype = 'u'
    AND conname IN (
      'hist_changes_attempt_field_unique',
      'eh_change_attempt_field_unique'
    );

  SELECT conname
  INTO old_number_constraint
  FROM pg_constraint
  WHERE conrelid = 'edit_history.changes'::regclass
    AND contype = 'u'
    AND conname IN (
      'hist_changes_attempt_number_unique',
      'eh_change_attempt_number_unique'
    );

  IF old_field_constraint IS NULL
     OR old_number_constraint IS NULL
  THEN
    RAISE EXCEPTION
      'Expected V1/V2 attempt uniqueness constraints missing';
  END IF;

  IF (
    old_field_constraint LIKE 'hist_%'
    AND old_number_constraint NOT LIKE 'hist_%'
  ) OR (
    old_field_constraint LIKE 'eh_%'
    AND old_number_constraint NOT LIKE 'eh_%'
  ) THEN
    RAISE EXCEPTION
      'Inconsistent prior constraint naming scheme';
  END IF;

  -- Verify the exact column order and identity
  -- represented by the existing unique constraints.
  -- Constraint name alone is insufficient.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'edit_history.changes'::regclass
      AND c.conname = old_field_constraint
      AND (
        SELECT array_agg(a.attname ORDER BY u.ordinality)
        FROM unnest(c.conkey)
          WITH ORDINALITY AS u(attnum, ordinality)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = u.attnum
      ) = ARRAY[
        'shop_id',
        'installation_id',
        'operation_id',
        'mutation_id',
        'attempt_id',
        'field_id'
      ]::name[]
  ) THEN
    RAISE EXCEPTION
      'Unexpected prior attempt-field constraint definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = 'edit_history.changes'::regclass
      AND c.conname = old_number_constraint
      AND (
        SELECT array_agg(a.attname ORDER BY u.ordinality)
        FROM unnest(c.conkey)
          WITH ORDINALITY AS u(attnum, ordinality)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = u.attnum
      ) = ARRAY[
        'shop_id',
        'installation_id',
        'operation_id',
        'mutation_id',
        'attempt_number',
        'field_id'
      ]::name[]
  ) THEN
    RAISE EXCEPTION
      'Unexpected prior attempt-number constraint definition';
  END IF;

  -- Inspect existing data before changing uniqueness.
  -- The new trigger cannot validate legacy rows
  -- merely by being installed.

  IF EXISTS (
    SELECT 1
    FROM edit_history.changes
    GROUP BY
      shop_id,
      installation_id,
      operation_id,
      mutation_id,
      attempt_id
    HAVING count(DISTINCT (
      execution_item_id,
      attempt_number,
      execution_fence_epoch,
      execution_claim_id,
      mutation_plan_fingerprint
    )) > 1
  ) THEN
    RAISE EXCEPTION
      'Existing history has conflicting attempt metadata';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM edit_history.changes
    GROUP BY
      shop_id,
      installation_id,
      operation_id,
      mutation_id,
      attempt_number
    HAVING count(DISTINCT attempt_id) > 1
  ) THEN
    RAISE EXCEPTION
      'Existing attempt numbers map to multiple attempt IDs';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM edit_history.changes
    GROUP BY
      shop_id,
      installation_id,
      operation_id,
      mutation_id,
      attempt_id
    HAVING count(DISTINCT attempt_number) > 1
  ) THEN
    RAISE EXCEPTION
      'Existing attempt IDs map to multiple attempt numbers';
  END IF;
END;
$$;

-- ======================================================
-- 2. SERIALIZE MIGRATION DDL
-- ======================================================
--
-- ACCESS EXCLUSIVE prevents concurrent history writes
-- while constraints and triggers are replaced.
-- This is deliberate and requires a maintenance window
-- for a populated production database.

-- The prerequisite block already holds both operation and change locks.

-- ======================================================
-- 3. REPLACE EXISTING UNIQUE CONSTRAINTS
-- ======================================================

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'edit_history.changes'::regclass
      AND conname IN (
        'hist_changes_attempt_field_unique',
        'hist_changes_attempt_number_unique',
        'eh_change_attempt_field_unique',
        'eh_change_attempt_number_unique'
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE edit_history.changes DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END;
$$;

ALTER TABLE edit_history.changes
  ADD CONSTRAINT eh_change_attempt_resource_field_unique
  UNIQUE (
    shop_id,
    installation_id,
    operation_id,
    mutation_id,
    attempt_id,
    resource_gid,
    field_id
  );

ALTER TABLE edit_history.changes
  ADD CONSTRAINT eh_change_attempt_number_resource_field_unique
  UNIQUE (
    shop_id,
    installation_id,
    operation_id,
    mutation_id,
    attempt_number,
    resource_gid,
    field_id
  );

-- PostgreSQL automatically creates a B-tree index
-- for each UNIQUE constraint. No duplicate index added.

-- ======================================================
-- 4. SHARED ATTEMPT CONSISTENCY
-- ======================================================
--
-- This trigger runs only on INSERT.
--
-- The existing history identity-protection trigger
-- must continue to reject updates to:
-- - mutation_id / attempt_id / attempt_number
-- - execution_item_id
-- - execution_fence_epoch
-- - execution_claim_id
-- - mutation_plan_fingerprint
-- - resource_gid / field_id
--
-- Normal mutation outcome updates therefore avoid
-- repeatedly locking the operation and scanning peers.

CREATE OR REPLACE FUNCTION
edit_history.guard_attempt_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Serialize journal admission for this operation.
  -- This prevents concurrent transactions from
  -- validating incompatible partial attempt sets.
  -- Touch the protecting row as well as locking it. A waiting Repeatable Read
  -- or Serializable writer must abort/retry with a fresh snapshot; a plain
  -- FOR UPDATE lock would leave its peer scan on an obsolete snapshot.
  UPDATE edit_history.operations o SET updated_at=clock_timestamp()
  WHERE o.shop_id = NEW.shop_id
    AND o.installation_id = NEW.installation_id
    AND o.id = NEW.operation_id
  ;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'History operation not found for attempt'
      USING ERRCODE = '23503';
  END IF;

  -- Same mutation + attempt ID must share all
  -- authoritative execution-attempt coordinates.
  IF EXISTS (
    SELECT 1
    FROM edit_history.changes c
    WHERE c.shop_id = NEW.shop_id
      AND c.installation_id = NEW.installation_id
      AND c.operation_id = NEW.operation_id
      AND c.mutation_id = NEW.mutation_id
      AND c.attempt_id = NEW.attempt_id
      AND c.id <> NEW.id
      AND (
        c.execution_item_id
          IS DISTINCT FROM NEW.execution_item_id
        OR c.attempt_number
          IS DISTINCT FROM NEW.attempt_number
        OR c.execution_fence_epoch
          IS DISTINCT FROM NEW.execution_fence_epoch
        OR c.execution_claim_id
          IS DISTINCT FROM NEW.execution_claim_id
        OR c.mutation_plan_fingerprint
          IS DISTINCT FROM NEW.mutation_plan_fingerprint
      )
  ) THEN
    RAISE EXCEPTION
      'Conflicting execution identity within attempt'
      USING ERRCODE = '23514';
  END IF;

  -- Same attempt number must map to the same attempt ID.
  IF EXISTS (
    SELECT 1
    FROM edit_history.changes c
    WHERE c.shop_id = NEW.shop_id
      AND c.installation_id = NEW.installation_id
      AND c.operation_id = NEW.operation_id
      AND c.mutation_id = NEW.mutation_id
      AND c.attempt_number = NEW.attempt_number
      AND c.attempt_id <> NEW.attempt_id
  ) THEN
    RAISE EXCEPTION
      'Attempt number maps to another attempt ID'
      USING ERRCODE = '23514';
  END IF;

  -- Same attempt ID must map to the same attempt number.
  IF EXISTS (
    SELECT 1
    FROM edit_history.changes c
    WHERE c.shop_id = NEW.shop_id
      AND c.installation_id = NEW.installation_id
      AND c.operation_id = NEW.operation_id
      AND c.mutation_id = NEW.mutation_id
      AND c.attempt_id = NEW.attempt_id
      AND c.attempt_number <> NEW.attempt_number
  ) THEN
    RAISE EXCEPTION
      'Attempt ID maps to another attempt number'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS eh_change_attempt_consistency
ON edit_history.changes;

CREATE TRIGGER eh_change_attempt_consistency
BEFORE INSERT ON edit_history.changes
FOR EACH ROW
EXECUTE FUNCTION edit_history.guard_attempt_consistency();

-- ======================================================
-- 5. SAFETY / INTEGRATION BOUNDARY
-- ======================================================
--
-- DATABASE ENFORCES:
-- - Composite resource/field uniqueness
-- - One attempt ID <-> one attempt number
-- - Shared execution attempt metadata
-- - Tenant-scoped operation relationships
-- - Serialization of journal admission per operation
--
-- REPOSITORY MUST ENFORCE:
-- - Authoritative approved field-set completeness
-- - Same PostgreSQL transaction as approval/fence checks
-- - Immutable BEFORE snapshots and intent linkage
-- - Current installation authority
-- - Idempotent replay of complete committed field sets
-- - No dispatch before successful journal commit
-- - No automatic retry of uncertain Shopify outcomes
--
-- EXISTING EXECUTION ENGINE MUST ENFORCE:
-- - Current mirror.job_commands lease/fence
-- - Existing resource-family write coordination
-- - Shopify mutation and undo authority
--
-- END
COMMIT;

