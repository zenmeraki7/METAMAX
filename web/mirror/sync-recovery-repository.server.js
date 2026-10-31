/** Fenced PostgreSQL recovery persistence for the catalog execution extension.
 * No external requests occur here. Every transaction retains the publication
 * barrier; final CAS failures roll back earlier uncertainty/binding writes.
 */
import { randomUUID } from "node:crypto";
import { CATALOG_EXECUTION_MAPPING, pgTransactionClient } from "./catalog-execution.server.js";
import { createSyncRunService } from "./sync-run-service.server.js";
import { getInstalledFilterSchemaOptions } from "../services/filter-schema.server.js";
import { SyncOutcomeUnknownError, runSyncDbTransaction } from "./sync-db-transaction.server.js";
import { verifySyncRunDbMapping, revalidateSyncRunDbMapping } from "./sync-run-schema.server.js";
import { verifyCatalogCheckpoints } from "./sync-checkpoints.server.js";
import {consumeFreshDispatchClaim} from './sync-dispatch-consumption.server.js';

const PHASES = new Set(["STARTING","WAITING","INGESTING","RECONCILING","PUBLISHING"]);
const MAX_FENCE = 9223372036854775807n;
const MAX_RECOVERIES = 8;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OPERATION = /^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/;
const GENERATION_STATES = Object.freeze({STARTING:["INGESTING"],WAITING:["INGESTING"],
  INGESTING:["INGESTING","RECONCILING"],RECONCILING:["RECONCILING","VERIFIED"],PUBLISHING:["VERIFIED","PUBLISHED"]});
class StaleRecoveryClaim extends Error {}
export class SyncRecoveryRepositoryError extends Error {
  constructor(message) { super(message);this.name="SyncRecoveryRepositoryError";this.code="INVALID_RECOVERY_INPUT"; }
}
const bad = message => { throw new SyncRecoveryRepositoryError(message); };
function data(value, keys) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) bad("Plain recovery data required");
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value,key);
    if (!descriptor || !Object.hasOwn(descriptor,"value")) bad(`Recovery ${key} data required`);
    result[key] = descriptor.value;
  }
  return result;
}
function id(value) { if(typeof value!=="string"||!ID.test(value))bad("Opaque recovery identity required");return value; }
function shop(value) {
  if(typeof value!=="string"||value.length>255||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value))bad("Exact recovery shop required");return value;
}
function fence(value, positive = false) {
  if(!["string","bigint"].includes(typeof value)||!/^(0|[1-9][0-9]{0,18})$/.test(String(value))||
    BigInt(value)>MAX_FENCE||(positive&&BigInt(value)===0n))bad("Exact recovery fence required");
  return String(value);
}
function attempt(value) {
  if(!Number.isSafeInteger(value)||value<1||value>MAX_RECOVERIES)bad("Positive bounded recovery attempt required");return value;
}
function captureClaim(raw) {
  const claim=data(raw,["runId","shopId","generationId","phase","fence","leaseToken","recoveryAttempt","intent"]);
  id(claim.runId);id(claim.generationId);id(claim.leaseToken);claim.fence=fence(claim.fence,true);attempt(claim.recoveryAttempt);
  shop(claim.shopId);
  if(!PHASES.has(claim.phase))bad("Exact recovery phase required");
  const intent=data(claim.intent,["id","kind","operationId","inputHash","state","installationVersion","recoveryFence","dispatchFence"]);
  id(intent.id);id(intent.installationVersion);
  if(intent.recoveryFence!==claim.fence)bad("Recovery intent fence mismatch");
  if(!["LOCAL_PHASE","BULK_START"].includes(intent.kind))bad("Known recovery intent required");
  if(intent.operationId!==null&&(typeof intent.operationId!=="string"||!OPERATION.test(intent.operationId)))bad("Exact operation identity required");
  if(intent.inputHash!==null&&(typeof intent.inputHash!=="string"||!/^[a-f0-9]{64}$/.test(intent.inputHash)))bad("Exact input hash required");
  if(intent.state!==null&&!["PREPARED","DISPATCHING","CONFIRMED","REJECTED"].includes(intent.state))bad("Known intent state required");
  if(intent.dispatchFence!==null)intent.dispatchFence=fence(intent.dispatchFence,true);
  return Object.freeze({...claim,intent:Object.freeze(intent)});
}
function intentSnapshot(row, operation, recoveryFence) {
  return Object.freeze({id:operation?.id??row.id,kind:operation?.kind??"LOCAL_PHASE",operationId:operation?.operation_id??null,
    inputHash:operation?.input_hash??null,state:operation?.state??null,installationVersion:row.installation_version,
    recoveryFence,dispatchFence:operation?fence(operation.dispatch_fence,true):null});
}
function sameIntent(a,b) { return Object.keys(a).every(key=>a[key]===b[key]); }

export function createSyncRecoveryRepository({database,syncRunRepository,verifyRecoveryEvidence,inputHash,leaseSeconds=60,dispatchRepository}={}) {
  if(typeof database?.connect!=="function")throw new TypeError("PostgreSQL pool required");
  if(typeof syncRunRepository?.getRecoveryEligibility!=="function")throw new TypeError("Sync repository recovery eligibility required");
  if(typeof verifyRecoveryEvidence!=="function")throw new TypeError("Trusted recovery evidence validator required");
  if(dispatchRepository&&typeof dispatchRepository.acknowledgeConsumptionInTransaction!=='function')throw new TypeError('Dispatch consumption method required');
  if(typeof inputHash!=="string"||!/^[a-f0-9]{64}$/.test(inputHash))bad("Trusted catalog input hash required");
  if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<1||leaseSeconds>300)bad("Bounded recovery lease required");
  const sync=createSyncRunService({database}),versions=getInstalledFilterSchemaOptions();
  let mappingPromise;
  async function verifiedMapping() {
    mappingPromise??=verifySyncRunDbMapping({database,mapping:CATALOG_EXECUTION_MAPPING});
    try{return await mappingPromise;}catch(error){mappingPromise=undefined;throw error;}
  }
  const stale=()=>{throw new StaleRecoveryClaim();};
  async function transaction(work) {
    try{
      const mapping=await verifiedMapping();
      return await runSyncDbTransaction({database,work:async tx=>{
        await revalidateSyncRunDbMapping(tx,mapping);
        return work(pgTransactionClient(tx));
      }});
    }
    catch(error){if(error instanceof StaleRecoveryClaim)return Object.freeze({kind:"STALE_CLAIM"});throw error;}
  }
  async function lockShop(c,shopId) {
    return (await c.query("SELECT id FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR UPDATE",[shopId])).rows.length===1;
  }
  // This exact owner predicate is repeated in SQL for every final mutation.
  // A row lock prevents other writers; it does not stop wall-clock lease expiry.
  async function mutate(c,claim,assignments,values,uncertain=true) {
    const p=n=>`$${values.length+n}`;
    const result=await c.query(`UPDATE mirror.catalog_import_executions e SET ${assignments}
      WHERE e.id=${p(1)} AND e.shop_id=${p(2)} AND e.generation_id=${p(3)} AND e.phase=${p(4)}
        AND e.fence=${p(5)}::bigint AND e.lease_token=${p(6)} AND e.recovery_attempts=${p(7)}
        AND e.worker_id='recovery' AND e.lease_until>clock_timestamp() AND e.outcome_uncertain=${p(8)}
        AND NOT e.review_required AND NOT e.cancel_requested AND e.completed_at IS NULL
        AND EXISTS(SELECT 1 FROM mirror.catalog_import_jobs j JOIN mirror.shops s
          ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
          JOIN mirror.generations g ON g.shop_id=j.shop_id AND g.id=j.generation_id
          WHERE j.id=e.id AND j.shop_id=e.shop_id AND j.generation_id=e.generation_id AND j.execution_mode='PHASE'
            AND NOT j.cancel_requested AND j.installation_version=${p(9)}
            AND g.mirror_schema_version=${p(10)} AND g.source_contract_version=${p(11)} AND g.mapping_version='mapping_v1')
      RETURNING e.*`,[...values,claim.runId,claim.shopId,claim.generationId,claim.phase,claim.fence,claim.leaseToken,
        claim.recoveryAttempt,uncertain,claim.intent.installationVersion,versions.mirrorSchemaVersion,versions.sourceContractVersion]);
    if(result.rows.length===0)stale();
    if(result.rows.length!==1)throw new SyncOutcomeUnknownError("Recovery mutation cardinality could not be verified");
    return result.rows[0];
  }
  async function lockClaim(c,claim) {
    if(!await lockShop(c,claim.shopId))stale();
    const row=(await c.query(`SELECT e.*,j.installation_version,j.run_id,r.fence AS ingestion_fence,r.bulk_operation_id,
        r.status AS ingestion_status,g.status AS generation_status
      FROM mirror.catalog_import_executions e
      JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id AND j.generation_id=e.generation_id
      JOIN mirror.shops s ON s.id=e.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
      JOIN mirror.generations g ON g.shop_id=e.shop_id AND g.id=e.generation_id
      JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=e.shop_id AND r.generation_id=e.generation_id
        AND r.execution_id=e.id AND r.dataset='products'
      WHERE e.id=$1 AND e.shop_id=$2 AND e.generation_id=$3 AND e.phase=$4 AND e.fence=$5::bigint AND e.lease_token=$6
        AND e.recovery_attempts=$7 AND e.worker_id='recovery' AND e.lease_until>clock_timestamp() AND e.outcome_uncertain
        AND NOT e.review_required AND NOT e.cancel_requested AND NOT j.cancel_requested AND e.completed_at IS NULL
        AND j.execution_mode='PHASE' AND j.installation_version=$8
        AND g.mirror_schema_version=$9 AND g.source_contract_version=$10 AND g.mapping_version='mapping_v1'
      FOR UPDATE OF e,j,r`,[claim.runId,claim.shopId,claim.generationId,claim.phase,claim.fence,claim.leaseToken,claim.recoveryAttempt,
        claim.intent.installationVersion,versions.mirrorSchemaVersion,versions.sourceContractVersion])).rows[0];
    if(!row)stale();return row;
  }
  async function lockIntent(c,row) {
    const result=await c.query(`SELECT * FROM mirror.sync_external_operations WHERE run_id=$1 AND shop_id=$2 AND generation_id=$3 FOR UPDATE`,
      [row.id,row.shop_id,row.generation_id]);
    if(result.rows.length>1)throw new SyncOutcomeUnknownError("Recovery intent identity is not unique");
    return result.rows[0]??null;
  }
  function operationOwner(offset) {
    const p=n=>`$${offset+n}`;
    return `EXISTS(SELECT 1 FROM mirror.catalog_import_executions e WHERE e.id=o.run_id AND e.shop_id=o.shop_id
      AND e.generation_id=o.generation_id AND e.phase=${p(1)} AND e.fence=${p(2)}::bigint
      AND e.lease_token=${p(3)} AND e.recovery_attempts=${p(4)} AND e.worker_id='recovery'
      AND e.lease_until>clock_timestamp() AND NOT e.outcome_uncertain AND NOT e.review_required
      AND NOT e.cancel_requested AND e.completed_at IS NULL)`;
  }
  async function review(c,claim,reason) {
    const row=await mutate(c,claim,"review_required=true,last_error=$1,lease_token=NULL,lease_until=NULL,worker_id=NULL,next_eligible_at=NULL",[reason]);
    if(!row.review_required||!row.outcome_uncertain||row.lease_token!==null||row.lease_until!==null)throw new SyncOutcomeUnknownError("Recovery review acknowledgment invalid");
    return Object.freeze({kind:"REVIEW_REQUIRED"});
  }
  return Object.freeze({
    async claimRecovery({runId}) {
      id(runId);
      const raw=await syncRunRepository.getRecoveryEligibility({runId});
      const eligibility=data(raw,["eligible"]);
      if(typeof eligibility.eligible!=="boolean")bad("Verified recovery eligibility required");
      const reason=Object.getOwnPropertyDescriptor(raw,"reason");
      if(reason&&!Object.hasOwn(reason,"value"))bad("Recovery reason data required");
      if(!eligibility.eligible&&reason?.value!=="RECOVERY_LIMIT")return null;
      Object.assign(eligibility,data(raw,["runId","shopId"]));
      if(eligibility.runId!==runId)bad("Recovery scheduling scope mismatch");
      shop(eligibility.shopId);
      return transaction(async c=>{
        if(!await lockShop(c,eligibility.shopId))return null;
        const row=(await c.query(`SELECT e.*,j.installation_version FROM mirror.catalog_import_executions e
          JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id AND j.generation_id=e.generation_id
          JOIN mirror.shops s ON s.id=e.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
          JOIN mirror.generations g ON g.shop_id=e.shop_id AND g.id=e.generation_id
          JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=e.shop_id AND r.generation_id=e.generation_id
            AND r.execution_id=e.id AND r.dataset='products'
          WHERE e.id=$1 AND e.shop_id=$2 AND e.outcome_uncertain AND NOT e.review_required AND NOT e.cancel_requested
            AND NOT j.cancel_requested AND j.execution_mode='PHASE' AND e.completed_at IS NULL
            AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp())
            AND (e.next_eligible_at IS NULL OR e.next_eligible_at<=clock_timestamp())
            AND g.mirror_schema_version=$3 AND g.source_contract_version=$4 AND g.mapping_version='mapping_v1'
            AND NOT EXISTS(SELECT 1 FROM mirror.catalog_import_executions other WHERE other.shop_id=e.shop_id AND other.id<>e.id
              AND other.lease_token IS NOT NULL AND other.lease_until>clock_timestamp() AND other.completed_at IS NULL)
          FOR UPDATE OF e,j`,[runId,eligibility.shopId,versions.mirrorSchemaVersion,versions.sourceContractVersion])).rows[0];
        if(!row)return null;
        const previousFence=fence(row.fence),count=row.recovery_attempts;
        if(!Number.isSafeInteger(count)||count<0||count>MAX_RECOVERIES)bad("Invalid durable recovery attempt count");
        if(count===MAX_RECOVERIES||BigInt(previousFence)===MAX_FENCE) {
          const terminal=await c.query(`UPDATE mirror.catalog_import_executions SET review_required=true,last_error=$4,
            lease_token=NULL,lease_until=NULL,worker_id=NULL,next_eligible_at=NULL
            WHERE id=$1 AND shop_id=$2 AND fence=$3::bigint AND outcome_uncertain AND NOT review_required
              AND recovery_attempts=$5 AND generation_id=$6 AND phase=$7 AND NOT cancel_requested AND completed_at IS NULL
              AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING id`,
          [runId,row.shop_id,previousFence,count===MAX_RECOVERIES?"RECOVERY_LIMIT":"FENCE_EXHAUSTED",count,row.generation_id,row.phase]);
          if(terminal.rows.length!==1)throw new SyncOutcomeUnknownError("Recovery review was not durably verified");
          return null;
        }
        const leaseToken=randomUUID(),nextFence=String(BigInt(previousFence)+1n);
        const updated=(await c.query(`UPDATE mirror.catalog_import_executions SET lease_token=$4,worker_id='recovery',fence=$5::bigint,
          lease_until=clock_timestamp()+$6::integer*interval '1 second',recovery_attempts=recovery_attempts+1
          WHERE id=$1 AND shop_id=$2 AND fence=$3::bigint AND generation_id=$7 AND phase=$8 AND recovery_attempts=$9
            AND outcome_uncertain AND NOT review_required AND NOT cancel_requested AND completed_at IS NULL
            AND (lease_until IS NULL OR lease_until<=clock_timestamp())
            AND (next_eligible_at IS NULL OR next_eligible_at<=clock_timestamp()) RETURNING *`,
        [runId,row.shop_id,previousFence,leaseToken,nextFence,leaseSeconds,row.generation_id,row.phase,count])).rows;
        if(updated.length!==1)throw new SyncOutcomeUnknownError("Recovery claim was not durably verified");
        const current=updated[0];
        if(current.lease_token!==leaseToken||fence(current.fence)!==nextFence||current.recovery_attempts!==count+1||current.attempt!==row.attempt||!current.outcome_uncertain) {
          throw new SyncOutcomeUnknownError("Recovery claim receipt invalid");
        }
        const operation=await lockIntent(c,row);
        await consumeFreshDispatchClaim({tx:c,claim:Object.freeze({runId,shopId:row.shop_id,generationId:row.generation_id,
          phase:row.phase,fence:nextFence,leaseToken}),kind:'RECOVERY',
          acknowledge:dispatchRepository?input=>dispatchRepository.acknowledgeConsumptionInTransaction(input):undefined});
        return Object.freeze({runId,shopId:row.shop_id,generationId:row.generation_id,phase:row.phase,leaseToken,fence:nextFence,
          recoveryAttempt:count+1,intent:intentSnapshot(row,operation,nextFence)});
      });
    },
    async finishRecovery({claim:rawClaim,verification:rawVerification}) {
      const claim=captureClaim(rawClaim),verification=data(rawVerification,["kind"]);
      if(!["CONFIRMED","SAFE_TO_RETRY","UNRESOLVED"].includes(verification.kind))bad("Known recovery verification required");
      // Preserve the verifier's immutable evidence object for the trusted private
      // receipt check; it is never interpolated into SQL or treated as authority.
      if(verification.kind!=="UNRESOLVED") {
        verification.evidence=Object.freeze(data(data(rawVerification,["evidence"]).evidence,["ticket"]));
        id(verification.evidence.ticket);
      }
      return transaction(async c=>{
        let row=await lockClaim(c,claim);const operation=await lockIntent(c,row);
        const current=intentSnapshot(row,operation,claim.fence);
        if(!sameIntent(current,claim.intent)) {
          await mutate(c,claim,"lease_token=NULL,lease_until=NULL,worker_id=NULL,next_eligible_at=clock_timestamp()+interval '5 seconds',last_error='RECOVERY_INTENT_CHANGED'",[]);
          return Object.freeze({kind:"STALE_CLAIM"});
        }
        if(verification.kind==="UNRESOLVED"||verifyRecoveryEvidence({claim,verification:Object.freeze(verification),intent:current})!==true) {
          return review(c,claim,"RECOVERY_UNRESOLVED");
        }
        if(!GENERATION_STATES[claim.phase].includes(row.generation_status))return review(c,claim,"RECOVERY_GENERATION_CHANGED");
        const known=operation?.operation_id;
        if(operation&&(operation.kind!=="BULK_START"||operation.input_hash!==inputHash||BigInt(operation.dispatch_fence)>BigInt(claim.fence)))return review(c,claim,"RECOVERY_INPUT_CHANGED");
        if(known&&(!OPERATION.test(known)||!['DISPATCHING','CONFIRMED'].includes(operation.state)))return review(c,claim,"RECOVERY_INPUT_CHANGED");
        if(claim.phase==="STARTING") {
          if(!known&&(row.bulk_operation_id||(operation&&!['PREPARED','REJECTED'].includes(operation.state))||verification.kind!=="SAFE_TO_RETRY")) {
            return review(c,claim,"RECOVERY_START_UNPROVEN");
          }
          if(known&&row.bulk_operation_id&&row.bulk_operation_id!==known)return review(c,claim,"RECOVERY_INPUT_CHANGED");
        } else if(!known||operation.state!=="CONFIRMED"||known!==row.bulk_operation_id) return review(c,claim,"RECOVERY_INPUT_CHANGED");
        if (['INGESTING','RECONCILING','PUBLISHING'].includes(claim.phase) &&
            !await verifyCatalogCheckpoints(c, {shopId:claim.shopId,executionId:claim.runId,generationId:claim.generationId,
              requireComplete:claim.phase!=='INGESTING'||row.generation_status!=='INGESTING'})) {
          return review(c,claim,"RECOVERY_CHECKPOINTS_INVALID");
        }
        // Binding uses the existing ingestion service, which requires a live
        // parent with cleared uncertainty. Both writes remain rollback-atomic.
        await mutate(c,claim,"outcome_uncertain=false",[]);
        if(claim.phase==="STARTING"&&known) {
          row=await lockClaimAfterClear(c,claim);
          await sync.bindBulkOperationIdInTransaction({client:c,shopId:claim.shopId,runId:row.run_id,fence:row.ingestion_fence,bulkOperationId:known});
          const bound=await c.query(`UPDATE mirror.sync_external_operations o SET state='CONFIRMED',updated_at=now()
            WHERE o.id=$1 AND o.run_id=$2 AND o.shop_id=$3 AND o.generation_id=$4 AND o.operation_id=$5 AND o.input_hash=$6
              AND o.state IN ('DISPATCHING','CONFIRMED') AND ${operationOwner(6)} RETURNING o.id`,
          [operation.id,claim.runId,claim.shopId,claim.generationId,known,inputHash,claim.phase,claim.fence,claim.leaseToken,claim.recoveryAttempt]);
          if(bound.rows.length!==1)stale();
        } else if(claim.phase==="STARTING"&&operation?.state==="PREPARED") {
          // PREPARED precedes dispatch. Preserve the immutable intent, but make
          // its verified non-dispatch eligible for the existing start service.
          const prepared=await c.query(`UPDATE mirror.sync_external_operations o SET state='REJECTED',last_error='RECOVERY_NOT_DISPATCHED',updated_at=now()
            WHERE o.id=$1 AND o.run_id=$2 AND o.shop_id=$3 AND o.generation_id=$4 AND o.state='PREPARED'
              AND o.operation_id IS NULL AND o.input_hash=$5 AND ${operationOwner(5)} RETURNING o.id`,
          [operation.id,claim.runId,claim.shopId,claim.generationId,inputHash,claim.phase,claim.fence,claim.leaseToken,claim.recoveryAttempt]);
          if(prepared.rows.length!==1)stale();
        }
        const done=await mutate(c,claim,"lease_token=NULL,lease_until=NULL,worker_id=NULL,attempt=0,next_eligible_at=clock_timestamp(),last_error=NULL",[],false);
        if(done.outcome_uncertain||done.attempt!==0||done.lease_token!==null||done.lease_until!==null||done.worker_id!==null)throw new SyncOutcomeUnknownError("Recovery completion receipt invalid");
        return Object.freeze({kind:"RESUMED"});
      });
    },
    async recordRecoveryFailure({claim:rawClaim,reason}) {
      const claim=captureClaim(rawClaim);
      if(typeof reason!=="string"||!/^[A-Z_]{1,64}$/.test(reason))bad("Bounded recovery failure reason required");
      return transaction(async c=>{
        const current=await lockClaim(c,claim),operation=await lockIntent(c,current);
        if(!sameIntent(intentSnapshot(current,operation,claim.fence),claim.intent)) {
          await mutate(c,claim,"lease_token=NULL,lease_until=NULL,worker_id=NULL,next_eligible_at=clock_timestamp()+interval '5 seconds',last_error='RECOVERY_INTENT_CHANGED'",[]);
          return Object.freeze({kind:"STALE_CLAIM"});
        }
        const row=await mutate(c,claim,`review_required=recovery_attempts>=8,last_error=$1,lease_token=NULL,lease_until=NULL,worker_id=NULL,
          next_eligible_at=CASE WHEN recovery_attempts>=8 THEN NULL ELSE clock_timestamp()+LEAST(900,5*power(2,recovery_attempts))*interval '1 second' END`,[reason]);
        if(!row.outcome_uncertain||row.recovery_attempts!==claim.recoveryAttempt||row.lease_token!==null||row.lease_until!==null)throw new SyncOutcomeUnknownError("Recovery failure receipt invalid");
        return Object.freeze({kind:"RECORDED",reviewRequired:row.review_required});
      });
    },
  });

  // The claim was already locked while uncertain. Re-read its child fence after
  // the uncertainty trigger derived the ingestion lease, without relaxing CAS.
  async function lockClaimAfterClear(c,claim) {
    const row=(await c.query(`SELECT j.run_id,r.fence AS ingestion_fence FROM mirror.catalog_import_executions e
      JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id AND j.generation_id=e.generation_id
      JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=e.shop_id AND r.generation_id=e.generation_id
        AND r.execution_id=e.id AND r.dataset='products'
      WHERE e.id=$1 AND e.shop_id=$2 AND e.generation_id=$3 AND e.fence=$4::bigint AND e.lease_token=$5
        AND e.phase=$6 AND e.recovery_attempts=$7 AND e.lease_until>clock_timestamp() AND NOT e.outcome_uncertain`,
    [claim.runId,claim.shopId,claim.generationId,claim.fence,claim.leaseToken,claim.phase,claim.recoveryAttempt])).rows[0];
    if(!row)stale();return row;
  }
}
