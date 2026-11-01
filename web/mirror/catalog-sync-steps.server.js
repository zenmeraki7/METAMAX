import {stageCatalogExport} from './staged-catalog-download.server.js';
import { createHash } from "node:crypto";
import { createSyncRunService } from "./sync-run-service.server.js";
import { createIngestionWriter } from "./ingestion-writer.server.js";
import { createBulkOperationRunner, PRODUCTS_BULK_QUERY, BULK_START_MUTATION } from "./bulk-operation-runner.server.js";
import { createReconciliationService } from "./reconciliation-service.server.js";
import { readCompleteProduct } from "./shopify-catalog-source.server.js";
import { executionTransaction, lockCatalogExecution } from "./catalog-execution.server.js";
import { createSyncExternalOperations } from "./sync-external-operations.server.js";
import { SyncWorkerError } from "../workers/sync.worker.js";
import { staging } from "./transactions.server.js";

export const CATALOG_INPUT_HASH=createHash('sha256').update(PRODUCTS_BULK_QUERY).digest('hex');
const uncertain=()=>new SyncWorkerError('BULK_START_UNCERTAIN','Bulk start requires authoritative recovery',{retryable:true,outcomeUncertain:true});
const terminal=message=>new SyncWorkerError('REMOTE_TERMINAL',message,{retryable:false});
const count=value=> /^(0|[1-9][0-9]*)$/.test(String(value)) && !(typeof value==='number'&&!Number.isSafeInteger(value)) && BigInt(value)<=9223372036854775807n;

export function createCatalogSyncSteps({database,clientFactory,fetchImpl=fetch}) {
  const sync=createSyncRunService({database});
  const operations=createSyncExternalOperations({database,inputHash:CATALOG_INPUT_HASH,syncRunService:sync});
  const owned=(claim,work)=>executionTransaction(database,async c=>work(c,await lockCatalogExecution(c,claim)));
  async function context(claim) {
    const row=await owned(claim,async(_c,row)=>row);
    const client=clientFactory({shopId:claim.shopId,installationVersion:row.installation_version});
    const runner=createBulkOperationRunner({database,shopifyClient:client,syncRunService:sync,ingestionWriter:createIngestionWriter({syncRunService:sync})});
    return {row,client,runner};
  }
  // Both phases can observe new webhooks after verification. Keep the execution
  // phase monotonic while reopening only its owned, unpublished staging data.
  async function reopenIfDirty(c, claim, row) {
    if (row.generation_status !== 'VERIFIED') return row.generation_status;
    const dirty = (await c.query('SELECT 1 FROM mirror.catalog_changes WHERE shop_id=$1 AND dirty LIMIT 1', [claim.shopId])).rowCount;
    if (!dirty) return 'VERIFIED';
    await staging(c, claim.shopId, claim.generationId, ['VERIFIED']);
    await c.query("UPDATE mirror.generations SET status='RECONCILING',verified_at=NULL WHERE shop_id=$1 AND id=$2", [claim.shopId,claim.generationId]);
    await c.query("UPDATE mirror.coverage SET status='PENDING',verified_at=NULL,verification_hash=NULL WHERE shop_id=$1 AND generation_id=$2", [claim.shopId,claim.generationId]);
    return 'RECONCILING';
  }
  async function reconcilePending({claim,signal}) {
    const {client}=await context(claim);
    const status=await owned(claim,(c,row)=>reopenIfDirty(c,claim,row));
    if (status==='VERIFIED'||status==='PUBLISHED')return {kind:'ADVANCE'};
    const reconciliation=createReconciliationService({database,authorizeWrite:c=>lockCatalogExecution(c,claim)});
    const due=await reconciliation.scanDueDirtyProducts({shopId:claim.shopId,limit:10});
    for(const product of due) {
      signal.throwIfAborted();
      await reconciliation.reconcileLatestProduct({shopId:claim.shopId,generationId:claim.generationId,productId:product.productId,
        workerId:claim.leaseToken,signal,fetchProduct:({productId,signal:productSignal})=>readCompleteProduct({client,productId,signal:productSignal})});
    }
    return owned(claim,async c=>{
      const dirty=(await c.query(`SELECT EXISTS(SELECT 1 FROM mirror.catalog_changes WHERE shop_id=$1 AND dirty) AS pending,
        EXISTS(SELECT 1 FROM mirror.catalog_changes WHERE shop_id=$1 AND dirty AND dead_letter_at IS NOT NULL) AS dead`,[claim.shopId])).rows[0];
      if(dirty.dead)throw terminal('Reconciliation requires review of dead letters');
      if(dirty.pending)return {kind:'DEFER',delayMs:2000};
      await sync.completeCoverageAndVerify({client:c,shopId:claim.shopId,generationId:claim.generationId});
      return {kind:'ADVANCE'};
    });
  }
  return Object.freeze({
    async startBulk({claim,signal}) {
      const {client}=await context(claim);
      const intent=await operations.prepare({claim});
      if(intent.alreadyBound)return {kind:'ADVANCE'};
      signal.throwIfAborted();
      await operations.beginDispatch({claim,intentId:intent.id});
      signal.throwIfAborted();
      let response;
      try {response=await client.request(BULK_START_MUTATION,{variables:{query:PRODUCTS_BULK_QUERY}});}
      catch {throw uncertain();}
      const payload=response.data?.bulkOperationRunQuery;
      if(!response.errors&&payload?.userErrors?.length&&!payload.bulkOperation) {
        await operations.reject({claim,intentId:intent.id});
        throw new SyncWorkerError('START_REJECTED','Remote bulk start rejected',{retryable:true});
      }
      const operationId=payload?.bulkOperation?.id;
      if(response.errors||payload?.userErrors?.length||!/^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/.test(operationId??''))throw uncertain();
      await operations.recordResponse({claim,intentId:intent.id,operationId});
      signal.throwIfAborted();
      await operations.confirm({claim,intentId:intent.id,operationId});
      return {kind:'ADVANCE'};
    },
    async checkBulk({claim,signal}) {
      const {row,runner}=await context(claim);signal.throwIfAborted();
      const op=await runner.bulkSync.getStatus({shopId:claim.shopId,bulkOperationId:row.bulk_operation_id});
      signal.throwIfAborted();
      if(['FAILED','CANCELLED','EXPIRED'].includes(op.status))throw terminal('Bulk export failed or expired');
      if(op.status!=='COMPLETED')return {kind:'DEFER',delayMs:2000};
      if(!count(op.objectCount))throw terminal('Bulk export returned an invalid record count');
      await operations.recordCompleted({claim,operationId:row.bulk_operation_id,objectCount:op.objectCount});
      return {kind:'ADVANCE'};
    },
    async ingestChunk({claim,signal}) {
      const {row,runner}=await context(claim);
      if(row.ingestion_status==='SUCCEEDED'&&row.generation_status==='RECONCILING')return {kind:'ADVANCE'};
      const op=await runner.bulkSync.getStatus({shopId:claim.shopId,bulkOperationId:row.bulk_operation_id});
      const staged=await stageCatalogExport({op,claim,runId:row.run_id,owned:work=>owned(claim,work),fetchImpl,signal});
      if(!staged.complete)return {kind:'DEFER',delayMs:1000};
      const lines=staged.lines;
      const receipt=await runner.ingestJsonlLines({shopId:claim.shopId,generationId:claim.generationId,runId:row.run_id,
        fence:row.ingestion_fence,lines,signal,cancelOnAbort:false,batchSize:100,maxNewChunks:5});
      return receipt.succeeded ? {kind:'ADVANCE'} : {kind:'DEFER',delayMs:1000};
    },
    reconcile: reconcilePending,
    async publish({claim,signal}) {
      const {row,client}=await context(claim);
      // A durable publication only needs acknowledgment. Fresh authorization is
      // required before publishing, not before recognizing an existing commit.
      if(row.generation_status!=='PUBLISHED')await client.authorize();
      signal.throwIfAborted();
      const progress=await reconcilePending({claim,signal});
      if(progress.kind==='DEFER')return progress;
      return owned(claim,async(c,row)=>{
        if(row.generation_status==='PUBLISHED')return {kind:'COMPLETE'};
        // Webhooks take the same publication barrier. Check and publish within
        // one transaction so another dirty revision cannot slip between them.
        if(await reopenIfDirty(c,claim,row)==='RECONCILING')return {kind:'DEFER',delayMs:1000};
        await sync.publishGeneration({client:c,shopId:claim.shopId,generationId:claim.generationId,expectedGenerationId:row.expected_generation_id});
        return {kind:'COMPLETE'};
      });
    },
  });
}
