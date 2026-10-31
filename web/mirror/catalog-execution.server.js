import { runSyncDbTransaction } from "./sync-db-transaction.server.js";
import { invalid } from "./transactions.server.js";
import { getInstalledFilterSchemaOptions } from "../services/filter-schema.server.js";
import { verifyCatalogCheckpoints } from "./sync-checkpoints.server.js";
import { CATALOG_EXECUTION_MAPPING } from "./sync-domain-schema.server.js";
import { createSyncRunDbAdapter, verifySyncRunDbMapping } from "./sync-run-db-adapter.server.js";

export { CATALOG_EXECUTION_MAPPING } from "./sync-domain-schema.server.js";

/** Production adapter: exact domain mappings and application-owned validators.
 * Callers cannot substitute ingestion_runs for the phase execution extension.
 */
export async function createCatalogSyncRunDbAdapter({database,prisma,dispatchRepository}) {
  if(dispatchRepository&&typeof dispatchRepository.acknowledgeConsumptionInTransaction!=='function')throw new TypeError('Dispatch consumption method required');
  const mapping=await verifySyncRunDbMapping({database,prisma,mapping:CATALOG_EXECUTION_MAPPING});
  // Remote Postgres round trips and a committed import batch can hold the
  // publication barrier longer than one second. Keep waits bounded below the
  // worker lease, and recheck the live claim after acquiring the lock.
  return createSyncRunDbAdapter({database,prisma,mapping,lockTimeoutMs:5000,statementTimeoutMs:10000,transactionTimeoutMs:20000,...createCatalogEvidenceValidators(),
    dispatchConsumption:dispatchRepository?input=>dispatchRepository.acknowledgeConsumptionInTransaction(input):undefined});
}

// Bridge an already protected transaction into the existing ingestion services.
export const pgTransactionClient = tx => ({ query:async (text, values=[]) => {
  const rows=await tx.$queryRawUnsafe(text,...values);return {rows,rowCount:rows.length};
} });
export const executionTransaction = (database, work) => runSyncDbTransaction({database,
  work:tx=>work(pgTransactionClient(tx))});

export async function lockCatalogExecution(client, claim, { recovery=false }={}) {
  const row=(await client.query(`SELECT e.*,j.installation_version,j.run_id,j.expected_generation_id,
      r.fence AS ingestion_fence,r.status AS ingestion_status,r.bulk_operation_id,
      g.status AS generation_status
    FROM mirror.catalog_import_executions e
    JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id AND j.generation_id=e.generation_id
    JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
    JOIN mirror.ingestion_runs r ON r.shop_id=e.shop_id AND r.id=j.run_id AND r.generation_id=e.generation_id AND r.execution_id=e.id
    JOIN mirror.generations g ON g.shop_id=e.shop_id AND g.id=e.generation_id
    WHERE e.id=$1 AND e.shop_id=$2 AND e.generation_id=$3 AND e.fence=$4 AND e.lease_token=$5
      AND e.phase=$6 AND e.lease_until>clock_timestamp() AND e.completed_at IS NULL
      AND NOT e.cancel_requested AND NOT j.cancel_requested AND j.execution_mode='PHASE'
      AND NOT e.review_required AND (NOT e.outcome_uncertain OR $7)
    FOR UPDATE OF e,j`,[claim.runId,claim.shopId,claim.generationId,claim.fence,claim.leaseToken,claim.phase,recovery])).rows[0];
  if(!row) invalid("Catalog execution authority changed");
  return row;
}

async function durableIngestion(tx, run) {
  if (!await verifyCatalogCheckpoints(pgTransactionClient(tx), {shopId:run.shopId,executionId:run.id,
    generationId:run.generationId,requireComplete:true})) return false;
  const rows=await tx.$queryRawUnsafe(`SELECT 1 FROM mirror.generations g WHERE g.shop_id=$1 AND g.id=$2
    AND g.status IN ('RECONCILING','VERIFIED','PUBLISHED')
    AND NOT EXISTS(SELECT 1 FROM unnest(g.required_datasets) d(name) WHERE NOT EXISTS(
      SELECT 1 FROM mirror.ingestion_runs r WHERE r.shop_id=g.shop_id AND r.generation_id=g.id AND r.dataset=d.name
        AND r.status='SUCCEEDED' AND r.eof_verified AND r.writes_finished_at IS NOT NULL
        AND r.invalid_lines=0 AND r.expected_lines=r.processed_lines))
    AND EXISTS(SELECT 1 FROM mirror.ingestion_runs r WHERE r.shop_id=g.shop_id AND r.generation_id=g.id
        AND r.dataset='products' AND r.execution_id=$3 AND r.bulk_operation_id IS NOT NULL)`,run.shopId,run.generationId,run.id);
  return rows.length===1;
}

export function createCatalogEvidenceValidators() {
  const versions=getInstalledFilterSchemaOptions();
  return {
    verifyShop:async({tx,shopId})=>(await tx.$queryRawUnsafe("SELECT 1 FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL",shopId)).length===1,
    verifyRun:async({tx,run})=>(await tx.$queryRawUnsafe(`SELECT 1 FROM mirror.catalog_import_jobs j JOIN mirror.shops s
      ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
      JOIN mirror.generations g ON g.shop_id=j.shop_id AND g.id=j.generation_id
      JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=j.shop_id AND r.generation_id=j.generation_id
        AND r.execution_id=j.id AND r.dataset='products' AND (r.status='SUCCEEDED' OR r.execution_fence=$6::bigint)
      WHERE j.id=$1 AND j.shop_id=$2 AND j.generation_id=$3 AND j.execution_mode='PHASE'
        AND NOT j.cancel_requested AND j.status IN ('QUEUED','RUNNING','RETRY')
        AND g.mirror_schema_version=$4 AND g.source_contract_version=$5 AND g.mapping_version='mapping_v1'
      FOR UPDATE OF j,r,g`,
    run.id,run.shopId,run.generationId,versions.mirrorSchemaVersion,versions.sourceContractVersion,run.fence)).length===1,
    async verifyStepEvidence({tx,run}) {
      if(run.phase==='STARTING'||run.phase==='WAITING') {
        return (await tx.$queryRawUnsafe(`SELECT 1 FROM mirror.sync_external_operations o
          JOIN mirror.catalog_import_jobs j ON j.id=o.run_id AND j.shop_id=o.shop_id AND j.generation_id=o.generation_id
          JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=o.shop_id AND r.generation_id=o.generation_id AND r.execution_id=o.run_id
          WHERE o.run_id=$1 AND o.shop_id=$2 AND o.generation_id=$3 AND o.state='CONFIRMED'
            AND o.operation_id=r.bulk_operation_id AND ($4='STARTING' OR
              (o.remote_status='COMPLETED' AND o.object_count IS NOT NULL AND o.object_count=r.expected_lines))`,
        run.id,run.shopId,run.generationId,run.phase)).length===1;
      }
      if(!await durableIngestion(tx,run))return false;
      if(run.phase==='INGESTING')return true;
      return run.phase==='RECONCILING' && (await tx.$queryRawUnsafe(`SELECT 1 FROM mirror.generations g WHERE g.shop_id=$1 AND g.id=$2
        AND g.status='VERIFIED' AND g.verified_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM mirror.catalog_changes c WHERE c.shop_id=g.shop_id AND c.dirty)
        AND NOT EXISTS(SELECT 1 FROM unnest(g.required_datasets) d(name) WHERE NOT EXISTS(
          SELECT 1 FROM mirror.coverage c WHERE c.shop_id=g.shop_id AND c.generation_id=g.id AND c.name=d.name AND c.status='COMPLETE'))`,
      run.shopId,run.generationId)).length===1;
    },
    async verifyPublished({tx,run}) {
      return await durableIngestion(tx,run) && (await tx.$queryRawUnsafe(`SELECT 1 FROM mirror.publications p JOIN mirror.generations g
        ON g.shop_id=p.shop_id AND g.id=p.generation_id AND g.coverage_revision=p.coverage_revision AND g.mapping_version=p.mapping_version
        WHERE p.shop_id=$1 AND p.generation_id=$2 AND g.status='PUBLISHED' AND g.verified_at IS NOT NULL AND g.published_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM unnest(g.required_datasets) d(name) WHERE NOT EXISTS(
            SELECT 1 FROM mirror.coverage c WHERE c.shop_id=g.shop_id AND c.generation_id=g.id AND c.name=d.name AND c.status='COMPLETE'))`,
      run.shopId,run.generationId)).length===1;
    },
  };
}
