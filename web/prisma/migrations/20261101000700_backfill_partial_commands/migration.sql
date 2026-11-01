-- Reclassify only completed v1 command results with proven mixed outcomes.
-- Preserve counts, evidence, fences, timestamps and all unresolved commands.
UPDATE mirror.job_commands SET status='PARTIAL'
WHERE status='FAILED' AND kind IN('bulk_edit','undo','import')
  AND result->>'version'='1' AND result->>'terminal'='true' AND result->>'outcome'='PARTIAL'
  AND jsonb_typeof(result#>'{counts,succeeded}')='number' AND result#>'{counts,succeeded}'>'0'::jsonb
  AND result#>'{counts,pending}'='0'::jsonb AND result#>'{counts,uncertain}'='0'::jsonb
  AND ((jsonb_typeof(result#>'{counts,failed}')='number' AND result#>'{counts,failed}'>'0'::jsonb)
    OR (jsonb_typeof(result#>'{counts,cancelled}')='number' AND result#>'{counts,cancelled}'>'0'::jsonb));

ALTER TABLE mirror.job_commands ADD CONSTRAINT command_partial_evidence CHECK (
 status<>'PARTIAL' OR COALESCE(
  kind IN('bulk_edit','undo','import') AND result->>'version'='1' AND result->>'terminal'='true' AND result->>'outcome'='PARTIAL'
  AND jsonb_typeof(result#>'{counts,succeeded}')='number' AND result#>'{counts,succeeded}'>'0'::jsonb
  AND result#>'{counts,pending}'='0'::jsonb AND result#>'{counts,uncertain}'='0'::jsonb
  AND ((jsonb_typeof(result#>'{counts,failed}')='number' AND result#>'{counts,failed}'>'0'::jsonb)
    OR (jsonb_typeof(result#>'{counts,cancelled}')='number' AND result#>'{counts,cancelled}'>'0'::jsonb)),false)
);
