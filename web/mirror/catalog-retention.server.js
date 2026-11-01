/** Called only under the publication barrier after generation retention/reference checks.
 * Keep uncertain work and consumers; compact only terminal history older than 24h. */
export async function retireCatalogExecutionHistory(client,{shopId,generationId}){
 const parameters=[shopId,generationId];
 const jobs=(await client.query(`SELECT j.id,j.status,j.execution_mode,j.installation_version,j.updated_at,
  e.phase,e.fence,e.delivery_revision,e.completed_at,e.cancel_completed_at,e.outcome_uncertain,e.review_required,e.lease_token
  FROM mirror.catalog_import_jobs j LEFT JOIN mirror.catalog_import_executions e ON e.shop_id=j.shop_id AND e.id=j.id
  WHERE j.shop_id=$1 AND j.generation_id=$2 ORDER BY j.id LIMIT 11 FOR UPDATE OF j`,parameters)).rows;
 if(jobs.length>10)return false;
 await client.query('SELECT id FROM mirror.catalog_import_executions WHERE shop_id=$1 AND generation_id=$2 FOR UPDATE',parameters);
 const blocked=(await client.query(`SELECT 1 FROM mirror.catalog_import_jobs j LEFT JOIN mirror.catalog_import_executions e ON e.shop_id=j.shop_id AND e.id=j.id
  WHERE j.shop_id=$1 AND j.generation_id=$2 AND (
   j.status NOT IN ('SUCCEEDED','CANCELLED','FAILED') OR j.updated_at>clock_timestamp()-interval '24 hours' OR j.lease_until>clock_timestamp()
   OR j.cancel_requested AND j.status NOT IN ('CANCELLED','SUCCEEDED')
   OR j.execution_mode='PHASE' AND(e.id IS NULL OR e.outcome_uncertain OR e.review_required OR e.lease_token IS NOT NULL
     OR COALESCE(e.completed_at,e.cancel_completed_at)>clock_timestamp()-interval '24 hours' OR(e.completed_at IS NULL AND e.cancel_completed_at IS NULL)))
  UNION ALL SELECT 1 FROM mirror.sync_external_operations WHERE shop_id=$1 AND generation_id=$2 AND state='DISPATCHING'
  UNION ALL SELECT 1 FROM mirror.sync_dispatches WHERE shop_id=$1 AND generation_id=$2 AND(
   state NOT IN ('CONSUMED','CANCELLED') OR recovery_token IS NOT NULL OR recovery_until>clock_timestamp() OR reserved_until>clock_timestamp())
  UNION ALL SELECT 1 FROM mirror.catalog_import_jobs WHERE shop_id=$1 AND expected_generation_id=$2 AND status IN ('QUEUED','RUNNING','RETRY')
  UNION ALL SELECT 1 FROM mirror.mutation_journal m JOIN mirror.ingestion_runs r ON r.shop_id=m.shop_id AND r.id=m.sync_run_id
   WHERE r.shop_id=$1 AND r.generation_id=$2
  LIMIT 1`,parameters)).rows.length;
 if(blocked)return false;
 const operations=(await client.query('SELECT operation_id,state,remote_status FROM mirror.sync_external_operations WHERE shop_id=$1 AND generation_id=$2 ORDER BY id LIMIT 11',parameters)).rows;
 if(operations.length>10)return false;
 // Audit contains identifiers and final states, never credentials or catalog payload.
 await client.query(`INSERT INTO mirror.catalog_retention_audit(shop_id,generation_id,summary)
  VALUES($1,$2,$3::jsonb) ON CONFLICT(shop_id,generation_id) DO NOTHING`,[...parameters,JSON.stringify({policy:'terminal-history-24h-v1',operations,jobs:jobs.map(j=>({id:j.id,status:j.status,phase:j.phase,fence:String(j.fence??0),deliveryRevision:String(j.delivery_revision??0),installationVersion:j.installation_version,completedAt:j.completed_at,cancelCompletedAt:j.cancel_completed_at}))})]);
 await client.query('DELETE FROM mirror.sync_dispatch_recovery_evidence WHERE shop_id=$1 AND generation_id=$2',parameters);
 await client.query('DELETE FROM mirror.sync_dispatches WHERE shop_id=$1 AND generation_id=$2',parameters);
 await client.query('DELETE FROM mirror.sync_external_operations WHERE shop_id=$1 AND generation_id=$2',parameters);
 // Runs/chunks leave before their RESTRICT execution FK; generation is RETIRED/FAILED and retention expired.
 await client.query('DELETE FROM mirror.ingestion_runs WHERE shop_id=$1 AND generation_id=$2',parameters);
 await client.query('DELETE FROM mirror.catalog_import_executions WHERE shop_id=$1 AND generation_id=$2',parameters);
 // Keep one small installation tombstone so initial-sync scanners cannot reset
 // a cancelled/exhausted installation after its detailed history is reclaimed.
 await client.query(`DELETE FROM mirror.catalog_import_jobs j WHERE j.shop_id=$1 AND j.generation_id=$2
  AND EXISTS(SELECT 1 FROM mirror.catalog_import_jobs first_job WHERE first_job.shop_id=j.shop_id
   AND first_job.installation_version=j.installation_version AND(first_job.created_at,first_job.id)<(j.created_at,j.id))`,parameters);
 return true;
}
