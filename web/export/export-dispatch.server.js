/** BullMQ delivery evidence backed by durable PostgreSQL observations.
 * A missing Redis job proves neither non-delivery nor execution failure.
 */
import {randomUUID} from "node:crypto";
import {EXPORT_ERROR_CODES as C,ExportContractError} from "./export-contract.js";
const fail=(message)=>{throw new ExportContractError(C.LEASE_LOST,message);};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const EXPORT_QUEUE_NAME="metamax-export-v2";
export function assertExportQueuePayload(data) {
  if(!data||typeof data!=="object"||Array.isArray(data)||![Object.prototype,null].includes(Object.getPrototypeOf(data))||Reflect.ownKeys(data).length!==1||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(data,"eventId")??{},"value")||typeof data.eventId!=="string"||!UUID.test(data.eventId))throw new TypeError("Export queue accepts only {eventId}");
  return data.eventId;
}
export function createExportQueueEvidence({database,queue,generationProtection}={}) {
  if(typeof database?.connect!=="function"||typeof queue?.getJob!=="function"||typeof generationProtection?.verify!=="function")
    throw new TypeError("PostgreSQL, BullMQ inspection and generation protection required");
  async function inspect(event) {
    const receipt=(await database.query(`SELECT r.event_id FROM export_engine.delivery_receipts r
      JOIN export_engine.outbox o ON o.id=r.event_id AND o.delivery_key=r.delivery_key AND o.job_id=r.job_id
      WHERE r.event_id=$1 AND r.delivery_key=$2 AND r.job_id=$3`,[event.id,event.delivery_key,event.job_id])).rows[0];
    if(receipt)return {confirmed:true,source:"POSTGRES_OBSERVATION",eventId:event.id,deliveryKey:event.delivery_key};
    const queued=await queue.getJob(event.delivery_key);
    if(!queued)return null;
    if(queued.id!==event.delivery_key||queued.name!=="export"||assertExportQueuePayload(queued.data)!==event.id)fail("BullMQ delivery identity mismatch");
    const state=await queued.getState();
    if(!["waiting","active","delayed","completed","failed","waiting-children","prioritized"].includes(state))return null;
    return {confirmed:true,source:"BULLMQ_RETAINED_JOB",eventId:event.id,deliveryKey:event.delivery_key,state};
  }
  return Object.freeze({
    async verifyDeliveryEvidence({event}) {return await inspect(event)??{confirmed:false};},
    async reconcileDelivery({event}) {
      const retained=await inspect(event);
      if(retained?.state&&!['completed','failed'].includes(retained.state))return {decision:"DELIVERED",...retained};
      if(retained?.source==="POSTGRES_OBSERVATION") {
        const scheduled=await queue.getJob(event.delivery_key);
        if(scheduled) {
          if(scheduled.id!==event.delivery_key||scheduled.name!=="export"||assertExportQueuePayload(scheduled.data)!==event.id)fail("Queue receipt identity differs");
          const state=await scheduled.getState();
          if(["waiting","active","delayed","waiting-children","prioritized"].includes(state))return {decision:"DELIVERED",...retained,state};
        }
      }
      // Redelivery can be safe even if delivery DID occur: establish that from
      // the fenced execution state, not from Redis absence.
      const client=await database.connect();
      try {
        await client.query("BEGIN");await client.query("SET LOCAL statement_timeout='10000ms'");
        await client.query("LOCK TABLE mirror.publications IN ACCESS SHARE MODE");
        const job=(await client.query(`SELECT j.* FROM export_engine.jobs j JOIN export_engine.outbox o ON o.job_id=j.id
          WHERE o.id=$1 AND o.delivery_key=$2 AND j.state='QUEUED' AND NOT j.cancel_requested
            AND j.lease_token IS NULL AND NOT EXISTS(SELECT 1 FROM export_engine.artifacts a WHERE a.job_id=j.id)
          FOR UPDATE OF j`,[event.id,event.delivery_key])).rows[0];
        if(!job){await client.query("COMMIT");return retained?{decision:"DELIVERED",...retained}:{decision:"REVIEW_REQUIRED",reason:"NO_FENCED_REPLAY_PROOF"};}
        await generationProtection.verify({client,identity:{shopId:job.shop_id,installationId:job.installation_id},job,purpose:"DELIVERY_RECONCILIATION"});
        await client.query("COMMIT");
        return {decision:"RETRY_ELIGIBLE",safeToRetry:true,source:"POSTGRES_FENCED_REPLAY",jobId:job.id,
          fenceEpoch:String(job.fence_epoch),reason:"NO_ACTIVE_EXECUTION_AND_EXACT_GENERATION_VERIFIED"};
      } catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}
      finally{client.release();}
    },
    async observeDelivery({eventId,deliveryKey}) {
      if(!UUID.test(eventId)||!UUID.test(deliveryKey))throw new TypeError("Durable queue identity required");
      const event=(await database.query(`SELECT o.id,o.delivery_key,o.job_id,j.shop_id,j.installation_id
        FROM export_engine.outbox o JOIN export_engine.jobs j ON j.id=o.job_id
        WHERE o.id=$1 AND o.delivery_key=$2`,[eventId,deliveryKey])).rows[0];
      if(!event)fail("Unrecognized export delivery");
      await database.query(`INSERT INTO export_engine.delivery_receipts(event_id,delivery_key,job_id)
        VALUES($1,$2,$3) ON CONFLICT(event_id) DO NOTHING`,[event.id,event.delivery_key,event.job_id]);
      return event;
    },
  });
}

export function createExportDispatcher({repository,queue,worker,database,dispatcherId=`export-${randomUUID()}`,logger=console,intervalMs=2000}={}) {
  for(const key of ["claimOutbox","acknowledgeOutbox","markOutboxUnknown","recoverExpiredJobs","releaseRetryWaitJobs",
    "recoverExpiredOutbox","recoverStalledReconciliations","reconcileUnknownOutbox","renewPendingGenerationProtection",
    "releaseTerminalGenerationProtections","scheduleWaitingJobs"])if(typeof repository?.[key]!=="function")throw new TypeError(`Export repository.${key} required`);
  if(typeof queue?.add!=="function"||typeof worker?.recover!=="function"||typeof database?.query!=="function"||
    !Number.isSafeInteger(intervalMs)||intervalMs<100||intervalMs>60000)throw new TypeError("Export queue, recovery worker, database and bounded interval required");
  let timer,running,stopped=true;
  async function tick() {
    if(running)return running;
    running=(async()=>{
      await repository.recoverExpiredOutbox();await repository.recoverStalledReconciliations();
      for(const recovery of await repository.recoverExpiredJobs({recoveryOwner:dispatcherId,batchSize:20}))await worker.recover(recovery);
      await repository.renewPendingGenerationProtection();await repository.releaseRetryWaitJobs();await repository.scheduleWaitingJobs();
      await repository.releaseTerminalGenerationProtections();
      const uncertain=(await database.query(`SELECT id FROM export_engine.outbox WHERE state='UNKNOWN'
        AND available_at<=clock_timestamp() ORDER BY available_at,id LIMIT 20`)).rows;
      for(const event of uncertain)await repository.reconcileUnknownOutbox({eventId:event.id,reconcilerId:dispatcherId});
      // Redis may lose even acknowledged jobs. Move only stale, still-queued
      // schedules to UNKNOWN so evidence reconciliation decides safe redelivery.
      await database.query(`UPDATE export_engine.outbox o SET state='UNKNOWN',available_at=clock_timestamp(),updated_at=clock_timestamp()
        FROM export_engine.jobs j WHERE j.id=o.job_id AND j.state='QUEUED' AND NOT j.cancel_requested
          AND o.state='DELIVERED' AND o.delivered_at<clock_timestamp()-interval '60 seconds'`);
      for(const delivery of await repository.claimOutbox({dispatcherId,batchSize:20})) {
        try {
          const retained=await queue.getJob(delivery.event.delivery_key);
          if(retained&&["completed","failed"].includes(await retained.getState()))await retained.remove();
          await queue.add("export",{eventId:delivery.event.id},{jobId:delivery.event.delivery_key,attempts:1,
            removeOnComplete:{age:86400,count:10000},removeOnFail:{age:604800,count:20000}});
          await repository.acknowledgeOutbox({eventId:delivery.event.id,claim:delivery.claim,evidence:{deliveryKey:delivery.event.delivery_key}});
        } catch(error) {
          try{await repository.markOutboxUnknown({eventId:delivery.event.id,claim:delivery.claim});}catch{}
          logger.error?.({code:error.code??"EXPORT_DELIVERY_UNKNOWN"},"Export delivery outcome requires reconciliation");
        }
      }
    })().finally(()=>{running=null;});
    return running;
  }
  async function loop() {
    try{await tick();}catch(error){logger.error?.({code:error.code??"EXPORT_COORDINATOR_FAILED"},"Export coordinator tick failed");}
    if(!stopped){timer=setTimeout(loop,intervalMs);timer.unref?.();}
  }
  return Object.freeze({tick,start(){if(!stopped)return;stopped=false;void loop();},async stop(){stopped=true;clearTimeout(timer);await running;}});
}
