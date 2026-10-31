/** Validate committed SyncCheckpoint rows against the exact product SyncRun.
 * Call only in an authorized transaction; this boolean is not an authority grant.
 * Bigint run IDs/counts stay in PostgreSQL and never pass through Number.
 */
export async function verifyCatalogCheckpoints(client, {shopId, executionId, generationId, requireComplete=false}) {
  const result = await client.query(`SELECT 1 FROM mirror.catalog_import_jobs j
    JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=j.shop_id AND r.generation_id=j.generation_id
      AND r.execution_id=j.id AND r.dataset='products'
    CROSS JOIN LATERAL (SELECT COALESCE(sum(c.line_count),0) AS lines,count(*) AS chunks,
      COALESCE(max(c.ordinal),-1) AS last,
      COALESCE(bool_and(c.ordinal>=0 AND c.line_count>0 AND c.checksum ~ '^[a-f0-9]{64}$'),true) AS valid
      FROM mirror.ingestion_chunks c WHERE c.shop_id=r.shop_id AND c.run_id=r.id) checkpoints
    WHERE j.id=$1 AND j.shop_id=$2 AND j.generation_id=$3 AND j.execution_mode='PHASE'
      AND r.bulk_operation_id IS NOT NULL AND r.invalid_lines=0 AND r.processed_lines>=0
      AND r.expected_lines>=r.processed_lines AND checkpoints.valid
      AND checkpoints.lines=r.processed_lines AND checkpoints.last=checkpoints.chunks-1
      AND (NOT $4::boolean OR (r.status='SUCCEEDED' AND r.eof_verified AND r.writes_finished_at IS NOT NULL
        AND r.expected_lines=r.processed_lines))`, [executionId,shopId,generationId,requireComplete]);
  return result.rows.length === 1;
}
