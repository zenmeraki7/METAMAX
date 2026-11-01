BEGIN;
ALTER TABLE mirror.ingestion_runs
  ADD COLUMN bulk_start_input_hash text,
  ADD COLUMN bulk_start_fence bigint,
  ADD COLUMN bulk_start_operation_id text;
ALTER TABLE mirror.ingestion_runs ADD CONSTRAINT ingestion_bulk_start_intent CHECK (
  (bulk_start_input_hash IS NULL AND bulk_start_fence IS NULL AND bulk_start_operation_id IS NULL)
  OR (bulk_start_input_hash IS NOT NULL AND bulk_start_input_hash ~ '^[a-f0-9]{64}$'
    AND (bulk_start_fence IS NULL OR bulk_start_fence >= 0)
    AND (bulk_start_operation_id IS NULL OR (bulk_start_fence IS NOT NULL
      AND bulk_start_operation_id ~ '^gid://shopify/BulkOperation/[1-9][0-9]*$')))
);
-- Existing grants/RLS on ingestion_runs cover these evidence columns. No new
-- role, policy, remote mutation, product rewrite or publication change occurs.
COMMIT;
