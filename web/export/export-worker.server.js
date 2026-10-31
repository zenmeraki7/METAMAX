/** Database-fenced worker. Queue data schedules an event, never carries authority. */
import {setTimeout as delay} from "node:timers/promises";
import {EXPORT_ERROR_CODES as C,ExportContractError} from "./export-contract.js";
import {assertExportQueuePayload} from "./export-dispatch.server.js";
import {FIELD_ERROR_CODES as F} from "../fields/types.js";
const terminal=new Set(["COMPLETED","CANCELLED","FAILED","EXPIRED","REVIEW_REQUIRED"]);
const permanent=new Set([C.UNAUTHORIZED,C.INVALID_REQUEST,C.SCHEMA_DRIFT,C.MISSING_COVERAGE,C.SNAPSHOT_EXPIRED,C.TOO_LARGE,C.ARTIFACT_INTEGRITY_FAILED]);
const dependencyCode=code=>({[F.PERMISSION_DENIED]:C.UNAUTHORIZED,[F.CONTRACT_MISMATCH]:C.SCHEMA_DRIFT,
  [F.MISSING_DEPENDENCY]:C.MISSING_COVERAGE,[F.EXECUTION_UNAVAILABLE]:C.SNAPSHOT_EXPIRED}[code]??code);

export function createExportWorker({repository,storage,source,evidence,workerId,heartbeatMs=10000,leaseMs=60000,logger=console}={}) {
  for(const key of ["claimNext","getJob","commitPart","heartbeat","renewGenerationProtection","transitionWorker","finalizeArtifact",
    "acknowledgeCancellation","resolveRecoveredJob","getCommittedParts"])if(typeof repository?.[key]!=="function")throw new TypeError(`Export repository.${key} required`);
  for(const key of ["writePart","assemble","verifyRecoveryEvidence"])if(typeof storage?.[key]!=="function")throw new TypeError(`Export storage.${key} required`);
  if(typeof source?.readPage!=="function"||typeof evidence?.observeDelivery!=="function"||typeof workerId!=="string"||!workerId||
    !Number.isSafeInteger(heartbeatMs)||heartbeatMs<100||!Number.isSafeInteger(leaseMs)||leaseMs<5000||leaseMs>300000||heartbeatMs>=leaseMs/3)
    throw new TypeError("Export source, delivery observer, identity and bounded heartbeat required");
  const active=new Set(),controllers=new Set();let stopping=false;
  async function run(delivered) {
    if(stopping)throw new Error("Export worker is stopping");
    const eventId=assertExportQueuePayload(delivered.data);
    const observed=await evidence.observeDelivery({eventId,deliveryKey:delivered.id});
    const identity={shopId:observed.shop_id,installationId:observed.installation_id},common={identity,jobId:observed.job_id};
    const current=await repository.getJob(common);
    if(!current||terminal.has(current.state)||current.cancel_requested)return {skipped:true};
    const acquired=await repository.claimNext({workerId,leaseMs,jobId:observed.job_id});
    if(!acquired) {
      // A scheduling token may have reached a worker before a slot was free.
      // Retain a failed token for the coordinator's fenced rescheduling proof.
      if((await repository.getJob(common))?.state==="QUEUED")throw new ExportContractError(C.CAPACITY_EXCEEDED,"Export execution slot unavailable",{retryable:true});
      return {skipped:true};
    }
    const {claim}=acquired;let job=acquired.job,finished=false,ownershipError;
    const abort=new AbortController(),stopPulse=new AbortController();
    controllers.add(abort);
    const pulse=(async()=>{
      try {
        for(;;) {
          await delay(heartbeatMs,undefined,{signal:stopPulse.signal});
          const latest=await repository.getJob(common);
          if(latest?.state==="CANCELLING")throw new ExportContractError(C.LEASE_LOST,"Cancellation requested");
          await repository.heartbeat({...common,claim,leaseMs});
          await repository.renewGenerationProtection({...common,claim});
        }
      } catch(error) {
        if(!stopPulse.signal.aborted){ownershipError=error;abort.abort(error);}
      }
    })();
    const check=()=>{if(ownershipError)throw ownershipError;abort.signal.throwIfAborted();};
    try {
      await repository.renewGenerationProtection({...common,claim});
      if(job.state==="RUNNING") {
        while(job.checkpoint?.done!==true) {
          check();
          const page=await source.readPage({job,checkpoint:job.checkpoint,signal:abort.signal});check();
          if(!page||!Array.isArray(page.rows)||typeof page.checkpoint?.done!=="boolean"||
            (page.checkpoint.done!==true&&page.rows.length===0))throw new ExportContractError(C.CHECKPOINT_CONFLICT,"Source page did not advance");
          const version=Number(job.checkpoint_version);
          if(!Number.isSafeInteger(version))throw new ExportContractError(C.CHECKPOINT_CONFLICT,"Checkpoint version overflow");
          const stored=await storage.writePart({...common,claim,partNumber:version,rows:page.rows,signal:abort.signal});check();
          job=await repository.commitPart({...common,claim,expectedVersion:version,partNumber:version,storageKey:stored.storageKey,
            storageVersion:stored.storageVersion,checksum:stored.checksum,rowCount:stored.rowCount,byteCount:stored.byteCount,cursor:page.checkpoint});
        }
        job=await repository.transitionWorker({...common,claim,fromState:"RUNNING",toState:"FINALIZING"});
      }
      check();
      const artifact=await storage.assemble({...common,claim,signal:abort.signal});check();
      const result=await repository.finalizeArtifact({...common,claim,expectedCheckpointVersion:Number(job.checkpoint_version),artifact});
      finished=true;return {jobId:job.id,state:result.job.state};
    } catch(error) {
      // Re-read durable state after any timeout or uncertain COMMIT. Never
      // delete a registered artifact or restart from a worker-local cursor.
      const latest=await repository.getJob(common);
      if(latest?.state==="COMPLETED"){finished=true;return {jobId:latest.id,state:latest.state};}
      if(latest?.state==="CANCELLING") {
        stopPulse.abort();await pulse;
        await repository.acknowledgeCancellation({...common,claim});finished=true;return {jobId:latest.id,state:"CANCELLED"};
      }
      if(latest?.lease_token===claim.leaseToken&&String(latest.fence_epoch)===String(claim.fenceEpoch)&&["RUNNING","FINALIZING"].includes(latest.state)) {
        stopPulse.abort();await pulse;
        const code=dependencyCode(error.code);
        await repository.transitionWorker({...common,claim,fromState:latest.state,toState:permanent.has(code)?"FAILED":"RETRY_WAIT",
          failureCode:Object.values(C).includes(code)?code:C.EXECUTION_FAILED});
      }
      logger.error?.({code:error.code??"EXPORT_ATTEMPT_FAILED",jobId:job.id},"Export attempt stopped; PostgreSQL owns recovery");
      throw error;
    } finally {stopPulse.abort();await pulse;if(!finished)abort.abort();controllers.delete(abort);}
  }
  return Object.freeze({
    process(job) {const pending=run(job);active.add(pending);pending.finally(()=>active.delete(pending)).catch(()=>{});return pending;},
    async recover({job,recoveryClaim}) {
      const common={identity:{shopId:job.shop_id,installationId:job.installation_id},jobId:job.id};
      try {
        const parts=await repository.getCommittedParts(common);
        // The repository performs independent part verification, checkpoint
        // comparison, storage evidence and exact-generation renewal under fence.
        return await repository.resolveRecoveredJob({...common,recoveryClaim,decision:"RESUME",evidence:{observedParts:parts.length}});
      } catch(error) {
        if(error.code===C.LEASE_LOST)return null;
        if(permanent.has(error.code))return repository.resolveRecoveredJob({...common,recoveryClaim,
          decision:[C.SNAPSHOT_EXPIRED,C.UNAUTHORIZED,C.SCHEMA_DRIFT].includes(error.code)?"FAIL":"REVIEW",evidence:{code:error.code}});
        // Keep the recovery lease. A fresh coordinator can reclaim after expiry.
        logger.error?.({jobId:job.id,code:error.code??"EXPORT_RECOVERY_UNCERTAIN"},"Export recovery requires another observation");return null;
      }
    },
    async stop(){stopping=true;for(const controller of controllers)controller.abort(new Error("Export worker stopping"));await Promise.allSettled([...active]);},
  });
}
