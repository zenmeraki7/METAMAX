import { randomUUID } from "node:crypto";
import { createSyncRunRepository } from "../mirror/sync-run-repository.server.js";
import {
  createSyncProcessor,
  createBullMQSyncWorker,
  createBullMQRecoveryWorker,
} from "../workers/sync.worker.js";
import { createSyncDispatcher } from "../workers/sync-dispatcher.js";
import { createSyncRedisTransport } from "../workers/sync-redis-transport.server.js";
import { createSyncRunService } from "../mirror/sync-run-service.server.js";
import { createCatalogSyncSteps } from "../mirror/catalog-sync-steps.server.js";
import { createCatalogSyncRecovery } from "../mirror/catalog-sync-recovery.server.js";
import { createCatalogSyncRunDbAdapter, executionTransaction } from "../mirror/catalog-execution.server.js";
import { createShopifyCatalogClient } from "../mirror/shopify-catalog-source.server.js";
import { BULK_CANCEL_MUTATION, BULK_STATUS_QUERY } from "../mirror/bulk-sync.server.js";
import { getInstalledFilterSchemaOptions } from "./filter-schema.server.js";
import {createSyncDispatchRepository} from '../mirror/sync-dispatch-repository.server.js';
import {createSyncDispatchRecoveryVerifier,createSyncDispatchRecovery} from '../mirror/sync-dispatch-recovery.server.js';
import {createSyncDispatchMonitor} from '../workers/sync-dispatch-monitor.server.js';

export async function createCatalogPhaseRuntime({database,shopify,redis,Worker:providedWorker,connection:providedConnection,
  fetchImpl=fetch,logger=console,dispatchRepository:providedDispatchRepository,
  syncQueue:providedSyncQueue,recoveryQueue:providedRecoveryQueue,inspectDispatchQueue,
  dispatchIntervalMs=2000,recoveryIntervalMs=5000,
  clientFactory=input=>createShopifyCatalogClient({database,shopify,...input})}) {
  const transport=redis&&(!Object.hasOwn(redis,'isOpen')||redis.isOpen)?createSyncRedisTransport({redis}):null;
  const syncQueue=providedSyncQueue??transport?.syncQueue;
  const recoveryQueue=providedRecoveryQueue??transport?.recoveryQueue;
  const Worker=providedWorker??transport?.Worker;
  const connection=providedConnection??transport?.connection??redis;
  const deliveryVerifier=createSyncDispatchRecoveryVerifier({database,syncQueue,recoveryQueue,inspectQueue:inspectDispatchQueue});
  const dispatchRepository=providedDispatchRepository||createSyncDispatchRepository({database,
    verifyRecoveryDecision:deliveryVerifier.verifyRecoveryDecision});
  const dispatchRecovery=createSyncDispatchRecovery({repository:dispatchRepository,verifier:deliveryVerifier,logger});
  const db=await createCatalogSyncRunDbAdapter({database,dispatchRepository});
  const repository=createSyncRunRepository({db});
  const sync=createSyncRunService({database});
  const versions=getInstalledFilterSchemaOptions();
  const recovery=createCatalogSyncRecovery({database,clientFactory,syncRunRepository:repository,dispatchRepository});
  const dispatchMonitor=createSyncDispatchMonitor({repository:dispatchRepository,logger});
  let shutdown=new AbortController(),dispatchTimer=null,recoveryTimer=null,dispatchRunning=null,recoveryRunning=null;
  const steps=createCatalogSyncSteps({database,clientFactory,fetchImpl});
  const syncSteps=Object.fromEntries(Object.entries(steps).map(([name,step])=>[name,({claim,signal})=>
    step({claim,signal:AbortSignal.any([signal,shutdown.signal])})]));
  const processor=createSyncProcessor({repository,syncSteps,
    workerId:randomUUID(),heartbeatMs:45000,logger});
  const dispatcher=syncQueue&&recoveryQueue?createSyncDispatcher({repository:dispatchRepository,syncQueue,recoveryQueue,logger}):null;
  const syncWorker=Worker&&connection?createBullMQSyncWorker({Worker,connection,processor,logger}):null;
  const recoveryWorker=Worker&&connection?createBullMQRecoveryWorker({Worker,connection,recovery,logger}):null;
  const hasQueueRecovery=Boolean((syncQueue&&recoveryQueue)||inspectDispatchQueue);
  return Object.freeze({
    syncQueue:syncQueue??null,
    recoveryQueue:recoveryQueue??null,
    syncWorker,
    recoveryWorker,
    start(){
      if(shutdown.signal.aborted)shutdown=new AbortController();
      dispatchMonitor.start();
      syncWorker?.run?.();
      recoveryWorker?.run?.();
      if(dispatcher&&!dispatchTimer){
        const tick=()=>{
          if(dispatchRunning||shutdown.signal.aborted)return;
          // Advisory discovery avoids taking the publication write barrier when
          // every run is currently leased. Reservation still rechecks all scope,
          // phase and fencing predicates inside its authoritative transaction.
          dispatchRunning=(async()=>{
            const due=await database.query(`SELECT 1 FROM mirror.catalog_import_executions WHERE completed_at IS NULL
              AND NOT cancel_requested AND NOT review_required AND (lease_until IS NULL OR lease_until<=clock_timestamp())
              AND (next_eligible_at IS NULL OR next_eligible_at<=clock_timestamp()) LIMIT 1`);
            if(due.rowCount)await dispatcher.runOnce();
          })().catch(error=>logger.error?.({code:error.code},'Sync dispatcher cycle failed')).finally(()=>{dispatchRunning=null;});
        };
        dispatchTimer=setInterval(tick,dispatchIntervalMs);dispatchTimer.unref?.();tick();
      }
      if(hasQueueRecovery&&!recoveryTimer){
        const tick=()=>{
          if(recoveryRunning||shutdown.signal.aborted)return;
          recoveryRunning=(async()=>{
            const due=await database.query(`SELECT 1 FROM mirror.sync_dispatches d JOIN mirror.catalog_import_executions e
              ON e.id=d.run_id AND e.shop_id=d.shop_id AND e.generation_id=d.generation_id
              WHERE d.next_attempt_at<=clock_timestamp() AND (d.recovery_until IS NULL OR d.recovery_until<=clock_timestamp())
              AND (d.state IN ('UNKNOWN','ENQUEUED') OR (d.state='RESERVED' AND d.reserved_until<=clock_timestamp())
                OR d.state='RECONCILING' OR (d.state='CONSUMED' AND d.delivery_revision=e.delivery_revision
                  AND d.consumed_fence=e.fence AND e.completed_at IS NULL
                  AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp()))) LIMIT 1`);
            if(due.rowCount)await dispatchRecovery.recoverDueDeliveries({signal:shutdown.signal});
          })().catch(error=>logger.error?.({code:error.code},'Sync dispatch recovery cycle failed')).finally(()=>{recoveryRunning=null;});
        };
        recoveryTimer=setInterval(tick,recoveryIntervalMs);recoveryTimer.unref?.();
      }
    },
    async stop(){
      shutdown.abort(new Error('Worker shutdown; durable recovery pending'));
      clearInterval(dispatchTimer);dispatchTimer=null;
      clearInterval(recoveryTimer);recoveryTimer=null;
      await Promise.allSettled([
        dispatchRunning,
        recoveryRunning,
        syncWorker?.close?.(),
        recoveryWorker?.close?.(),
        dispatchMonitor.stop(),
      ]);
    },
    getDispatchMetrics(){return dispatchMonitor.getMetrics();},
    dispatchOnce() {
      return dispatcher?dispatcher.runOnce():null;
    },
    recoverDelivery(dispatchId,{signal}={}) {
      return dispatchRecovery.recoverDelivery(dispatchId,{signal:signal?AbortSignal.any([signal,shutdown.signal]):shutdown.signal});
    },
    recoverDeliveries({limit,signal}={}) {
      return dispatchRecovery.recoverDueDeliveries({limit,signal:signal?AbortSignal.any([signal,shutdown.signal]):shutdown.signal});
    },
    async enqueue({client,shopId,installationVersion,expectedGenerationId}={}) {
      if(!shopId||typeof shopId!=='string')throw new Error('Active shop identity required');
      const allocate=async c=>{
        // Allocation acquires the shop-scoped row lock and verifies active installation
        // and staging state inside the transaction so enqueue() is independently concurrency-safe.
        const shopRow=(await c.query(
          'SELECT id,installation_version,uninstalled_at FROM mirror.shops WHERE id=$1 FOR UPDATE',
          [shopId],
        )).rows[0];
        if(!shopRow||shopRow.uninstalled_at!==null)throw new Error('Active shop installation required');
        if(installationVersion!==undefined&&shopRow.installation_version!==installationVersion) {
          throw new Error('Shop installation version changed before phase allocation');
        }
        const resolvedVersion=installationVersion??shopRow.installation_version;
        const existing=(await c.query(
          "SELECT 1 FROM mirror.generations WHERE shop_id=$1 AND status IN ('INGESTING','RECONCILING','VERIFIED') FOR UPDATE",
          [shopId],
        )).rows;
        if(existing.length)throw new Error('Existing staging generation requires completion or cancellation');
        const activeJob=(await c.query(
          "SELECT 1 FROM mirror.catalog_import_jobs WHERE shop_id=$1 AND (status IN ('QUEUED','RUNNING','RETRY') OR (cancel_requested AND status NOT IN ('CANCELLED','SUCCEEDED'))) FOR UPDATE",
          [shopId],
        )).rows;
        if(activeJob.length)throw new Error('Existing import job requires completion or cancellation');
        const run=await sync.startIngestionRun({shopId,workerId:'allocate',client:c});
        const id=randomUUID();
        const job=(await c.query(`INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,generation_id,run_id,expected_generation_id,execution_mode)
          VALUES($1,$2,$3,$4,$5,$6,'PHASE') RETURNING *`,[id,shopId,resolvedVersion,run.generationId,run.runId,expectedGenerationId??null])).rows[0];
        await c.query("INSERT INTO mirror.catalog_import_executions(id,shop_id,generation_id) VALUES($1,$2,$3)",[id,shopId,run.generationId]);
        await c.query(`UPDATE mirror.ingestion_runs SET execution_id=$3,execution_fence=0,lease_token=NULL,lease_until=NULL
          WHERE shop_id=$1 AND id=$2`,[shopId,run.runId,id]);
        return job;
      };
      if(client){
        if(typeof client.query!=='function')throw new TypeError('Transactional database client required');
        return allocate(client);
      }
      return executionTransaction(database,allocate);
    },
    async processOne() {
      if(shutdown.signal.aborted)return null;
      const maintenance=await database.query(`SELECT 1 FROM mirror.catalog_import_executions e
        JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id
        JOIN mirror.shops s ON s.id=e.shop_id JOIN mirror.generations g ON g.shop_id=e.shop_id AND g.id=e.generation_id
        WHERE e.completed_at IS NULL AND (
          (e.cancel_completed_at IS NULL AND (e.cancel_requested OR j.cancel_requested OR s.uninstalled_at IS NOT NULL OR s.installation_version<>j.installation_version)
            AND (NOT e.cancel_requested OR e.lease_until IS NULL OR e.lease_until<=clock_timestamp()))
          OR (e.lease_until<=clock_timestamp() AND e.lease_token IS NOT NULL AND NOT e.cancel_requested)
          OR (NOT e.review_required AND NOT e.cancel_requested AND
            (g.mirror_schema_version<>$1 OR g.source_contract_version<>$2 OR g.mapping_version<>'mapping_v1'))) LIMIT 1`,
      [versions.mirrorSchemaVersion,versions.sourceContractVersion]);
      const cancelled=maintenance.rowCount?await executionTransaction(database,async c=>{
        // Installation changes and cancellation immediately fence every child.
        const rows=(await c.query(`SELECT e.id,e.shop_id,e.generation_id,e.outcome_uncertain,e.last_error,
            j.installation_version,r.bulk_operation_id,g.status AS generation_status,
            (s.uninstalled_at IS NULL AND s.installation_version=j.installation_version) AS shop_active
          FROM mirror.catalog_import_executions e JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id
          JOIN mirror.shops s ON s.id=e.shop_id JOIN mirror.generations g ON g.shop_id=e.shop_id AND g.id=e.generation_id
          LEFT JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=j.shop_id
          WHERE e.completed_at IS NULL AND e.cancel_completed_at IS NULL AND
            (e.cancel_requested OR j.cancel_requested OR s.uninstalled_at IS NOT NULL OR s.installation_version<>j.installation_version)
            AND (NOT e.cancel_requested OR e.lease_until IS NULL OR e.lease_until<=clock_timestamp())
          ORDER BY e.id LIMIT 1 FOR UPDATE OF e,j`,[])).rows;
        const claimedRows=[];
        for(const row of rows){
          const leaseToken=randomUUID();
          const claimed=(await c.query(`UPDATE mirror.catalog_import_executions SET cancel_requested=true,
            lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds',worker_id='cancel',fence=fence+1
            WHERE id=$1 AND shop_id=$3 AND completed_at IS NULL AND cancel_completed_at IS NULL
            RETURNING fence,lease_token`,[row.id,leaseToken,row.shop_id])).rows[0];
          if(claimed)claimedRows.push({...row,fence:claimed.fence,lease_token:claimed.lease_token});
        }
        // Lost worker acknowledgments always go through recovery before replay.
        await c.query(`UPDATE mirror.catalog_import_executions SET outcome_uncertain=true,lease_token=NULL,lease_until=NULL,worker_id=NULL,
          next_eligible_at=clock_timestamp(),last_error='LEASE_EXPIRED'
          WHERE lease_until<=clock_timestamp() AND lease_token IS NOT NULL AND completed_at IS NULL AND NOT cancel_requested`);
        await c.query(`UPDATE mirror.catalog_import_executions e SET review_required=true,last_error='GENERATION_CONTRACT_CHANGED',
          lease_token=NULL,lease_until=NULL,worker_id=NULL,fence=e.fence+1
          FROM mirror.generations g WHERE g.shop_id=e.shop_id AND g.id=e.generation_id AND e.completed_at IS NULL
            AND NOT e.review_required AND NOT e.cancel_requested
            AND (g.mirror_schema_version<>$1 OR g.source_contract_version<>$2 OR g.mapping_version<>'mapping_v1')`,
        [versions.mirrorSchemaVersion,versions.sourceContractVersion]);
        return claimedRows;
      }):[];
      for(const row of cancelled) {
        // Publication committed before cancellation is already authoritative.
        if(row.generation_status==='PUBLISHED') {
          const completed=await executionTransaction(database,c=>c.query(`UPDATE mirror.catalog_import_executions
            SET completed_at=COALESCE(completed_at,clock_timestamp()),
                cancel_requested=false,lease_token=NULL,lease_until=NULL,worker_id=NULL
            WHERE id=$1 AND shop_id=$2 AND ((fence=$3 AND lease_token=$4 AND lease_until>clock_timestamp()) OR completed_at IS NOT NULL)
            RETURNING id`,[row.id,row.shop_id,row.fence,row.lease_token]));
          return {id:row.id,kind:completed.rowCount?'COMPLETE':'STALE_CLAIM'};
        }
        await sync.cancelGeneration({shopId:row.shop_id,generationId:row.generation_id});
        if(row.bulk_operation_id&&row.shop_active) {
          const cancelController=new AbortController();
          const onShutdown=()=>cancelController.abort(shutdown.signal.reason);
          shutdown.signal.addEventListener('abort',onShutdown,{once:true});
          const requestBounded=async(query,variables)=>{
            let deadline;
            try {
              const client=clientFactory({shopId:row.shop_id,installationVersion:row.installation_version,signal:cancelController.signal});
              return await Promise.race([
                client.request(query,{variables,signal:cancelController.signal}),
                new Promise((_,reject)=>{
                  deadline=setTimeout(()=>{
                    const timeoutError=Object.assign(new Error('Remote cleanup deadline exceeded'),{code:'REMOTE_CLEANUP_TIMEOUT'});
                    cancelController.abort(timeoutError);
                    reject(timeoutError);
                  },10000);
                  deadline.unref?.();
                }),
              ]);
            } finally {
              clearTimeout(deadline);
            }
          };
          let remoteConfirmed=false;
          try {
            if(row.outcome_uncertain||row.last_error==='REMOTE_CANCEL_OUTCOME_UNKNOWN') {
              const statusRes=await requestBounded(BULK_STATUS_QUERY,{id:row.bulk_operation_id});
              const statusOp=statusRes?.data?.bulkOperation;
              if(statusOp?.id===row.bulk_operation_id&&['CANCELLED','COMPLETED','FAILED','EXPIRED'].includes(statusOp.status)) {
                remoteConfirmed=true;
              }
            }
            if(!remoteConfirmed) {
              const cancelRes=await requestBounded(BULK_CANCEL_MUTATION,{id:row.bulk_operation_id});
              const payload=cancelRes?.data?.bulkOperationCancel;
              if(cancelRes?.errors?.length||payload?.userErrors?.length) {
                const statusRes=await requestBounded(BULK_STATUS_QUERY,{id:row.bulk_operation_id});
                const statusOp=statusRes?.data?.bulkOperation;
                if(statusOp?.id===row.bulk_operation_id&&['CANCELLED','COMPLETED','FAILED','EXPIRED'].includes(statusOp.status)) {
                  remoteConfirmed=true;
                } else {
                  throw Object.assign(new Error('Remote bulk cancellation rejected'),{code:'REMOTE_CANCEL_REJECTED'});
                }
              } else {
                remoteConfirmed=true;
              }
            }
          } catch(error) {
            logger.error?.({code:error.code},'Cancelled import remote export cleanup failed');
            await executionTransaction(database,c=>c.query(`UPDATE mirror.catalog_import_executions
              SET outcome_uncertain=true,last_error='REMOTE_CANCEL_OUTCOME_UNKNOWN',
                  lease_token=NULL,lease_until=NULL,worker_id=NULL,next_eligible_at=clock_timestamp()
              WHERE id=$1 AND shop_id=$2 AND fence=$3 AND lease_token=$4 AND lease_until>clock_timestamp()
                AND completed_at IS NULL AND cancel_completed_at IS NULL`,
            [row.id,row.shop_id,row.fence,row.lease_token]));
            return {id:row.id,kind:'CANCEL_PENDING',outcomeUncertain:true};
          } finally {
            shutdown.signal.removeEventListener('abort',onShutdown);
          }
        }
        const finalized=await executionTransaction(database,async c=>{
          const existingRow=(await c.query(
            'SELECT cancel_completed_at FROM mirror.catalog_import_executions WHERE id=$1 AND shop_id=$2 FOR UPDATE',
            [row.id,row.shop_id],
          )).rows[0];
          if(existingRow?.cancel_completed_at)return {kind:'CANCELLED'};
          const updated=await c.query(`UPDATE mirror.catalog_import_executions
            SET cancel_completed_at=clock_timestamp(),outcome_uncertain=false,last_error=NULL,
                lease_token=NULL,lease_until=NULL,worker_id=NULL
            WHERE id=$1 AND shop_id=$2 AND fence=$3 AND lease_token=$4 AND lease_until>clock_timestamp()
              AND cancel_requested=true AND completed_at IS NULL AND cancel_completed_at IS NULL
            RETURNING id`,[row.id,row.shop_id,row.fence,row.lease_token]);
          return {kind:updated.rowCount?'CANCELLED':'STALE_CLAIM'};
        });
        return {id:row.id,kind:finalized.kind};
      }
      // A configured transport owns phase delivery. Running the direct polling
      // fallback as well duplicates schema/claim transactions on every tick and
      // can starve the queue consumer's renewal behind the publication barrier.
      // Maintenance above remains active; the durable dispatcher routes expiry.
      if(syncWorker&&recoveryWorker)return null;
      const recovering=(await database.query(`SELECT id FROM mirror.catalog_import_executions WHERE outcome_uncertain
        AND NOT review_required AND NOT cancel_requested AND completed_at IS NULL
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND (next_eligible_at IS NULL OR next_eligible_at<=clock_timestamp())
        ORDER BY id LIMIT 1`)).rows[0];
      if(recovering)return {id:recovering.id,...await recovery.recoverRun(recovering.id,{signal:shutdown.signal})};
      const due=(await database.query(`SELECT id FROM mirror.catalog_import_executions WHERE NOT outcome_uncertain AND NOT review_required
        AND NOT cancel_requested AND completed_at IS NULL AND attempt<12
        AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND (next_eligible_at IS NULL OR next_eligible_at<=clock_timestamp())
        ORDER BY next_eligible_at NULLS FIRST,id LIMIT 1`)).rows[0];
      if(!due)return null;
      return {id:due.id,...await processor.processRun(due.id)};
    },
    async verifyStorage() {
      await database.query('SELECT recovery_attempts FROM mirror.catalog_import_executions LIMIT 0');
      await database.query('SELECT id FROM mirror.sync_dispatch_recovery_evidence LIMIT 0');
    },
  });
}
