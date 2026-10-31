/** PostgreSQL delivery reservations, not execution leases. All callbacks are
 * DB-only; a Redis error must never fail the actual catalog execution. */
import {randomUUID} from 'node:crypto';
import {runSyncDbTransaction,SyncOutcomeUnknownError,assertSyncDriver} from './sync-db-transaction.server.js';
import {verifySyncRunDbMapping,revalidateSyncRunDbMapping,requireSyncRunDbMapping} from './sync-run-schema.server.js';
import {CATALOG_EXECUTION_MAPPING} from './sync-domain-schema.server.js';
import {pgTransactionClient} from './catalog-execution.server.js';
import {getInstalledFilterSchemaOptions} from '../services/filter-schema.server.js';
import {CATALOG_INPUT_HASH} from './catalog-sync-steps.server.js';
import {dispatchJobId} from '../workers/sync-dispatcher.js';
import {logicalDispatchKey,acknowledgeDispatchConsumptionInTransaction} from './sync-dispatch-consumption.server.js';

export class DispatchRepositoryError extends Error {
  constructor(code,message,cause){super(message,{cause});this.name='DispatchRepositoryError';this.code=code;}
}
const fail=(code,message)=>{throw new DispatchRepositoryError(code,message);};
function own(raw,key){
  if(!raw||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))fail('INVALID_INPUT','Plain dispatch data required');
  const d=Object.getOwnPropertyDescriptor(raw,key);
  if(!d||!Object.hasOwn(d,'value'))fail('INVALID_INPUT',`Missing ${key} data`);
  return d.value;
}
function validId(value){if(typeof value!=='string'||!ID.test(value))fail('INVALID_INPUT','Opaque identity required');return value;}

const ID=/^[A-Za-z0-9_-]{1,128}$/;
const stale=()=>Object.freeze({kind:'STALE_CLAIM'});
const recorded=()=>Object.freeze({kind:'RECORDED'});
function integer(value,min,max,name) {
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError(`Invalid ${name}`);
}
function capture(raw,extra) {
  if(!raw||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))throw new TypeError('Plain dispatch receipt required');
  const result={};
  for(const key of ['dispatchId','dispatchToken','kind','runId','deliveryKey',extra]) {
    const d=Object.getOwnPropertyDescriptor(raw,key);
    if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string')throw new TypeError(`Dispatch ${key} data required`);
    result[key]=d.value;
  }
  for(const key of ['dispatchId','dispatchToken','runId','deliveryKey'])if(!ID.test(result[key]))throw new TypeError(`Invalid ${key}`);
  if(!['SYNC','RECOVERY'].includes(result.kind))throw new TypeError('Invalid dispatch kind');
  if(extra==='jobId'&&result.jobId!==dispatchJobId(result))throw new TypeError('Exact logical job identity required');
  if(extra==='code'&&!/^[A-Z][A-Z0-9_]{0,63}$/.test(result.code))throw new TypeError('Bounded failure code required');
  return Object.freeze(result);
}

// Parameters $1..$3 are trusted installed schema versions and the source hash.
const source=`FROM mirror.catalog_import_executions e
  JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id AND j.generation_id=e.generation_id
  JOIN mirror.shops s ON s.id=e.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
  JOIN mirror.generations g ON g.shop_id=e.shop_id AND g.id=e.generation_id
  JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=e.shop_id AND r.generation_id=e.generation_id
    AND r.execution_id=e.id AND r.dataset='products'
  LEFT JOIN mirror.sync_external_operations o ON o.run_id=e.id AND o.shop_id=e.shop_id AND o.generation_id=e.generation_id AND o.kind='BULK_START'`;
const recovery=`(e.outcome_uncertain OR (e.lease_token IS NOT NULL AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp())) OR o.state='DISPATCHING'
  OR (o.id IS NOT NULL AND o.input_hash<>$3)
  OR (o.state='CONFIRMED' AND o.operation_id IS DISTINCT FROM r.bulk_operation_id)
  OR (r.bulk_operation_id IS NOT NULL AND (o.id IS NULL OR o.state<>'CONFIRMED' OR o.operation_id IS DISTINCT FROM r.bulk_operation_id))
  OR (o.operation_id IS NOT NULL AND o.state NOT IN ('DISPATCHING','CONFIRMED'))
  OR (e.phase<>'STARTING' AND (o.id IS NULL OR o.state<>'CONFIRMED' OR o.operation_id IS DISTINCT FROM r.bulk_operation_id)))`;
// COALESCE is essential: no external intent in STARTING is an ordinary delivery.
const route=`CASE WHEN COALESCE(${recovery},false) THEN 'RECOVERY' ELSE 'SYNC' END`;
const authority=`j.execution_mode='PHASE' AND NOT j.cancel_requested AND j.status IN ('QUEUED','RUNNING','RETRY')
  AND NOT e.cancel_requested AND NOT e.review_required AND e.completed_at IS NULL
  AND g.mirror_schema_version=$1 AND g.source_contract_version=$2 AND g.mapping_version='mapping_v1'
  AND (r.status='SUCCEEDED' OR r.execution_fence=e.fence)
  AND ((e.phase IN ('STARTING','WAITING') AND g.status='INGESTING')
    OR (e.phase='INGESTING' AND g.status IN ('INGESTING','RECONCILING'))
    OR (e.phase='RECONCILING' AND g.status IN ('RECONCILING','VERIFIED'))
    OR (e.phase='PUBLISHING' AND g.status IN ('VERIFIED','PUBLISHED')))`;
const recoveryDue=`d.next_attempt_at<=clock_timestamp() AND (d.recovery_token IS NULL OR d.recovery_until<=clock_timestamp()) AND (
  d.state IN ('UNKNOWN','ENQUEUED')
  OR (d.state='RESERVED' AND d.reserved_until<=clock_timestamp())
  OR (d.state='RECONCILING' AND d.recovery_until<=clock_timestamp())
  OR (d.state='CONSUMED' AND d.delivery_revision=e.delivery_revision AND d.consumed_fence=e.fence
    AND e.completed_at IS NULL AND NOT e.cancel_requested AND NOT e.review_required
    AND (e.attempt>0 OR e.outcome_uncertain OR e.lease_token IS NOT NULL)
    AND (e.lease_token IS NULL OR e.lease_until<=clock_timestamp())))`;

export function createSyncDispatchRepository({database,prisma,mapping,verifyShop,needsRecovery,
  verifyRecoveryDecision,verifyConsumption,maxDispatchAttempts=20,maxRunAttempts=12}={}) {
  if(!database&&!prisma)throw new TypeError('PostgreSQL pool or Prisma client required');
  assertSyncDriver({database,prisma});
  integer(maxDispatchAttempts,1,1000,'maxDispatchAttempts');integer(maxRunAttempts,1,12,'maxRunAttempts');
  for(const [name,callback] of Object.entries({verifyShop,needsRecovery,verifyRecoveryDecision,verifyConsumption})) {
    if(callback!==undefined&&typeof callback!=='function')throw new TypeError(`${name} callback required`);
  }
  if(mapping&&requireSyncRunDbMapping(mapping,database||prisma).runs.table!==CATALOG_EXECUTION_MAPPING.runs.table) {
    fail('INVALID_MAPPING','Exact production execution mapping required');
  }
  const versions=getInstalledFilterSchemaOptions();
  const parameters=[versions.mirrorSchemaVersion,versions.sourceContractVersion,CATALOG_INPUT_HASH];
  let mappingPromise=mapping?Promise.resolve(mapping):undefined;
  async function transaction(work) {
    mappingPromise??=verifySyncRunDbMapping({database,prisma,mapping:CATALOG_EXECUTION_MAPPING});
    let mapping;
    try{mapping=await mappingPromise;}catch(error){mappingPromise=undefined;throw error;}
    return runSyncDbTransaction({database,prisma,work:async tx=>{
      await revalidateSyncRunDbMapping(tx,mapping);
      return work(pgTransactionClient(tx),tx);
    }});
  }
  async function acknowledge(input,failure) {
    return transaction(async(c,tx)=>{
      // A lookup hint grants no authority. Recheck everything after locks, in
      // shop -> execution/job -> intent/delivery order under the barrier.
      const hint=(await c.query('SELECT shop_id FROM mirror.sync_dispatches WHERE id=$1',[input.dispatchId])).rows[0];
      if(!hint)return stale();
      if(!(await c.query('SELECT id FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR UPDATE',[hint.shop_id])).rows.length)return stale();
      if(verifyShop&&await verifyShop({tx,shopId:hint.shop_id})!==true)return stale();
      const owner=(await c.query(`SELECT e.*,r.id AS sync_run_id,${route} AS kind ${source}
        WHERE ${authority} AND e.id=$4 AND e.shop_id=$5 FOR UPDATE OF e,j,r,g`,[...parameters,input.runId,hint.shop_id])).rows[0];
      if(!owner)return stale();
      const delivery=(await c.query('SELECT * FROM mirror.sync_dispatches WHERE id=$1 AND shop_id=$2 FOR UPDATE',[input.dispatchId,hint.shop_id])).rows[0];
      if(!delivery||delivery.run_id!==owner.id||delivery.generation_id!==owner.generation_id||delivery.sync_run_id!==owner.sync_run_id||
        delivery.delivery_revision!==owner.delivery_revision||delivery.kind!==input.kind||delivery.kind!==owner.kind||
        delivery.delivery_key!==input.deliveryKey||delivery.dispatch_token!==input.dispatchToken)return stale();
      // A failure may not undo an already acknowledged delivery, even with the
      // same token. Both outcomes keep the reservation until its DB expiry.
      const result=await c.query(`UPDATE mirror.sync_dispatches SET
        state=$7,job_id=CASE WHEN $7='ENQUEUED' THEN $8 ELSE job_id END,last_error_code=$9,updated_at=now(),
        enqueued_at=CASE WHEN $7='ENQUEUED' THEN COALESCE(enqueued_at,clock_timestamp()) ELSE enqueued_at END
        WHERE id=$1 AND shop_id=$2 AND run_id=$3 AND delivery_key=$4 AND dispatch_token=$5
          AND reservation_fence=$6 AND reserved_until>clock_timestamp()
          AND recovery_token IS NULL AND recovery_until IS NULL
          AND state IN ('RESERVED','UNKNOWN'${failure?'':",'ENQUEUED'"})
          AND EXISTS(SELECT 1 FROM mirror.catalog_import_executions e WHERE e.id=$3 AND e.shop_id=$2
            AND e.delivery_revision=$10 AND NOT e.cancel_requested AND NOT e.review_required AND e.completed_at IS NULL)
        RETURNING id`,[delivery.id,delivery.shop_id,input.runId,input.deliveryKey,input.dispatchToken,
          delivery.reservation_fence,failure?'UNKNOWN':'ENQUEUED',failure?null:input.jobId,
          failure?input.code:null,owner.delivery_revision]);
      return result.rows.length===1?recorded():stale();
    });
  }
  async function lockDelivery(c,tx,dispatchId) {
    const hint=(await c.query('SELECT shop_id,run_id FROM mirror.sync_dispatches WHERE id=$1',[dispatchId])).rows[0];
    if(!hint)return null;
    if(!(await c.query('SELECT id FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR UPDATE',[hint.shop_id])).rows.length)return null;
    if(!(await c.query('SELECT shop_id FROM mirror.sync_dispatch_schedule WHERE shop_id=$1 FOR UPDATE',[hint.shop_id])).rows.length)return null;
    if(verifyShop&&await verifyShop({tx,shopId:hint.shop_id})!==true)return null;
    const run=(await c.query(`SELECT e.*,r.id AS sync_run_id,${route} AS kind ${source}
      WHERE e.id=$4 AND e.shop_id=$5 AND g.mirror_schema_version=$1 AND g.source_contract_version=$2
        AND g.mapping_version='mapping_v1' FOR UPDATE OF e,j,r,g`,[...parameters,hint.run_id,hint.shop_id])).rows[0];
    if(!run)return null;
    const delivery=(await c.query('SELECT * FROM mirror.sync_dispatches WHERE id=$1 AND shop_id=$2 FOR UPDATE',[dispatchId,hint.shop_id])).rows[0];
    if(!delivery||delivery.run_id!==run.id||delivery.generation_id!==run.generation_id||delivery.sync_run_id!==run.sync_run_id)return null;
    return {run,delivery};
  }
  function recoveryClaim(raw) {
    const result={};
    for(const key of ['dispatchId','recoveryToken','shopId','runId','generationId','deliveryKey','kind','deliveryRevision','recoveryFence'])result[key]=own(raw,key);
    for(const key of ['dispatchId','recoveryToken','runId','generationId','deliveryKey'])validId(result[key]);
    if(typeof result.shopId!=='string'||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(result.shopId)||!['SYNC','RECOVERY'].includes(result.kind))fail('INVALID_INPUT','Invalid recovery scope');
    for(const key of ['deliveryRevision','recoveryFence'])if(typeof result[key]!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(result[key])||BigInt(result[key])>9223372036854775807n)fail('INVALID_INPUT','Exact recovery revision required');
    return Object.freeze(result);
  }
  async function listRecoveryCandidates({limit=20}={}) {
    integer(limit,1,100,'recovery discovery limit');
    return transaction(async c=>Object.freeze((await c.query(`SELECT d.id AS "dispatchId",d.shop_id AS "shopId",d.run_id AS "runId",
      d.kind,d.state FROM mirror.sync_dispatches d JOIN mirror.catalog_import_executions e
        ON e.id=d.run_id AND e.shop_id=d.shop_id AND e.generation_id=d.generation_id
      WHERE ${recoveryDue} ORDER BY d.updated_at,d.id LIMIT $1`,[limit])).rows.map(Object.freeze)));
  }
  async function markDispatchReviewRequired({dispatchId}) {
    validId(dispatchId);
    return transaction(async(c,tx)=>{
      if(!await lockDelivery(c,tx,dispatchId))return Object.freeze({kind:'NOT_ELIGIBLE'});
      const rows=await c.query(`UPDATE mirror.sync_dispatches SET state='REVIEW_REQUIRED',reviewed_at=clock_timestamp(),
        recovery_reason='MAX_DISPATCH_ATTEMPTS',updated_at=clock_timestamp() WHERE id=$1 AND attempt>=$2
        AND state IN ('PENDING','RETRY_ELIGIBLE') AND (reserved_until IS NULL OR reserved_until<=clock_timestamp())
        AND (recovery_until IS NULL OR recovery_until<=clock_timestamp()) RETURNING id`,[dispatchId,maxDispatchAttempts]);
      return rows.rows.length===1?recorded():Object.freeze({kind:'NOT_ELIGIBLE'});
    });
  }
  return Object.freeze({
    async reserveDispatchBatch({limit=1,reservationSeconds=60}={}) {
      integer(limit,1,1,'dispatch limit');integer(reservationSeconds,10,3600,'reservationSeconds');
      return transaction(async (c,tx)=>{
        const reservations=[];
        for(let i=0;i<limit;i++) {
          const row=(await c.query(`SELECT e.*,r.id AS sync_run_id,${route} AS kind ${source}
            JOIN mirror.sync_dispatch_schedule fairness ON fairness.shop_id=e.shop_id
            WHERE ${authority}
              AND fairness.next_eligible_at<=clock_timestamp()
              AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp())
              AND (e.next_eligible_at IS NULL OR e.next_eligible_at<=clock_timestamp())
              AND (${route}='RECOVERY' OR e.attempt<$4)
              AND NOT EXISTS(SELECT 1 FROM mirror.catalog_import_executions other WHERE other.shop_id=e.shop_id AND other.id<>e.id
                AND other.lease_token IS NOT NULL AND other.lease_until>clock_timestamp() AND other.completed_at IS NULL)
              AND NOT EXISTS(SELECT 1 FROM mirror.sync_dispatches d WHERE d.shop_id=e.shop_id AND d.run_id=e.id
                AND d.delivery_revision=e.delivery_revision AND d.kind=${route}
                AND (d.reserved_until>clock_timestamp() OR d.next_attempt_at>clock_timestamp()
                  OR d.state NOT IN ('PENDING','RETRY_ELIGIBLE') OR d.attempt>=$5
                  OR d.recovery_until>clock_timestamp() OR (d.recovery_token IS NOT NULL AND d.recovery_until IS NULL)))
            ORDER BY fairness.last_dispatched_at NULLS FIRST,fairness.last_served,e.shop_id,e.next_eligible_at NULLS FIRST,e.id
            LIMIT 1 FOR UPDATE OF s,e,j,r,g,fairness SKIP LOCKED`,[...parameters,maxRunAttempts,maxDispatchAttempts])).rows[0];
          if(!row)break;
          if(verifyShop&&await verifyShop({tx,shopId:row.shop_id})!==true)break;
          if(needsRecovery){
            const needed=await needsRecovery({tx,run:Object.freeze({...row,runId:row.id,shopId:row.shop_id,generationId:row.generation_id})});
            if(typeof needed!=='boolean')fail('INVALID_RECOVERY_PROOF','Boolean recovery classification required');
            if(needed)row.kind='RECOVERY';
          }
          if(row.kind==='RECOVERY'&&!row.outcome_uncertain) {
            // Lost execution acknowledgments and ambiguous remote intents are
            // never ordinary starts. Normalize them for the recovery consumer.
            const normalized=await c.query(`UPDATE mirror.catalog_import_executions SET outcome_uncertain=true,
              lease_token=NULL,lease_until=NULL,worker_id=NULL,last_error='DISPATCH_RECOVERY_REQUIRED'
              WHERE id=$1 AND shop_id=$2 AND delivery_revision=$3
                AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING id`,[row.id,row.shop_id,row.delivery_revision]);
            if(normalized.rows.length!==1)throw new SyncOutcomeUnknownError('Recovery discovery was not durably fenced');
          }
          const deliveryKey=logicalDispatchKey({shopId:row.shop_id,runId:row.id,deliveryRevision:row.delivery_revision,kind:row.kind});
          const delivery=(await c.query(`INSERT INTO mirror.sync_dispatches AS d
            (id,shop_id,run_id,generation_id,delivery_revision,kind,delivery_key,state,dispatch_token,reservation_fence,reserved_until,sync_run_id,attempt)
            VALUES($1,$2,$3,$4,$5,$6,$7,'RESERVED',$8,1,clock_timestamp()+$9::integer*interval '1 second',$10,1)
            ON CONFLICT(shop_id,run_id,delivery_revision,kind) DO UPDATE SET state='RESERVED',
              dispatch_token=EXCLUDED.dispatch_token,reservation_fence=d.reservation_fence+1,
              reserved_until=EXCLUDED.reserved_until,last_error_code=NULL,attempt=d.attempt+1,updated_at=now(),
              recovery_token=NULL,recovery_until=NULL
            WHERE (d.reserved_until IS NULL OR d.reserved_until<=clock_timestamp()) AND d.next_attempt_at<=clock_timestamp()
              AND d.state IN ('PENDING','RETRY_ELIGIBLE')
              AND (d.recovery_until IS NULL OR d.recovery_until<=clock_timestamp())
              AND (d.recovery_token IS NULL OR d.recovery_until IS NOT NULL)
              AND d.attempt<$11 AND d.reservation_fence<9223372036854775807
            RETURNING *`,[randomUUID(),row.shop_id,row.id,row.generation_id,row.delivery_revision,row.kind,deliveryKey,randomUUID(),reservationSeconds,row.sync_run_id,maxDispatchAttempts])).rows[0];
          if(!delivery)throw new SyncOutcomeUnknownError('Dispatch reservation was not durably verified');
          await c.query(`UPDATE mirror.sync_dispatch_schedule SET last_served=nextval('mirror.sync_dispatch_fairness_sequence'),
            last_dispatched_at=clock_timestamp() WHERE shop_id=$1`,[row.shop_id]);
          reservations.push(Object.freeze({dispatchId:delivery.id,dispatchToken:delivery.dispatch_token,
            kind:delivery.kind,runId:delivery.run_id,deliveryKey:delivery.delivery_key}));
        }
        return Object.freeze(reservations);
      });
    },
    async markDispatched(raw) {return acknowledge(capture(raw,'jobId'),false);},
    async markDispatchFailure(raw) {return acknowledge(capture(raw,'code'),true);},
    listRecoveryCandidates,
    async claimDeliveryRecovery({dispatchId,recoverySeconds=120}) {
      validId(dispatchId);integer(recoverySeconds,10,3600,'recoverySeconds');
      return transaction(async(c,tx)=>{
        if(!await lockDelivery(c,tx,dispatchId))return null;
        const token=randomUUID();
        const rows=(await c.query(`UPDATE mirror.sync_dispatches d SET state='RECONCILING',recovery_token=$2,
          recovery_fence=recovery_fence+1,recovery_until=clock_timestamp()+$3::integer*interval '1 second',updated_at=clock_timestamp()
          FROM mirror.catalog_import_executions e WHERE d.id=$1 AND e.id=d.run_id AND e.shop_id=d.shop_id
            AND e.generation_id=d.generation_id AND d.recovery_fence<9223372036854775807 AND ${recoveryDue}
          RETURNING d.*`,[dispatchId,token,recoverySeconds])).rows;
        if(!rows.length)return null;
        const d=rows[0];return Object.freeze({dispatchId:d.id,shopId:d.shop_id,runId:d.run_id,generationId:d.generation_id,
          deliveryKey:d.delivery_key,kind:d.kind,deliveryRevision:String(d.delivery_revision),recoveryToken:token,recoveryFence:String(d.recovery_fence),jobId:d.job_id});
      });
    },
    async finishDeliveryRecovery(raw) {
      const claim=recoveryClaim(own(raw,'claim')),decision=own(raw,'decision'),evidenceId=validId(own(raw,'evidenceId'));
      const targets={CONSUMED:'CONSUMED',STILL_ENQUEUED:'ENQUEUED',RETRY_VERIFIED:'RETRY_ELIGIBLE',UNRESOLVED:'REVIEW_REQUIRED'};
      if(!Object.hasOwn(targets,decision))fail('INVALID_DECISION','Invalid recovery decision');
      return transaction(async(c,tx)=>{
        const context=await lockDelivery(c,tx,claim.dispatchId);
        if(!context)return Object.freeze({kind:'STALE_RECOVERY'});
        const {run,delivery:d}=context;
        if(d.state!=='RECONCILING'||d.recovery_token!==claim.recoveryToken||String(d.recovery_fence)!==claim.recoveryFence||
          d.shop_id!==claim.shopId||d.run_id!==claim.runId||d.generation_id!==claim.generationId||d.delivery_key!==claim.deliveryKey||
          d.kind!==claim.kind||String(d.delivery_revision)!==claim.deliveryRevision)return Object.freeze({kind:'STALE_RECOVERY'});
        const live=(await c.query('SELECT recovery_until>clock_timestamp() AS live FROM mirror.sync_dispatches WHERE id=$1',[d.id])).rows[0]?.live;
        if(!live)return Object.freeze({kind:'STALE_RECOVERY'});
        if(typeof verifyRecoveryDecision!=='function'||await verifyRecoveryDecision({tx,delivery:Object.freeze({...d}),
          run:Object.freeze({...run}),decision,evidenceId})!==true)fail('EVIDENCE_MISSING','Recovery evidence not verified');
        // Proof cannot revive a superseded logical phase or bypass a worker's
        // live execution lease / an unresolved reservation. Recheck in SQL too.
        const rows=await c.query(`UPDATE mirror.sync_dispatches d SET state=$3,recovery_token=NULL,recovery_until=NULL,
          recovery_reason=$4,next_attempt_at=CASE WHEN $3='RETRY_ELIGIBLE' THEN clock_timestamp()
            WHEN $3='ENQUEUED' THEN clock_timestamp()+interval '30 seconds' ELSE next_attempt_at END,
          consumed_at=CASE WHEN $3='CONSUMED' THEN COALESCE(consumed_at,clock_timestamp()) ELSE consumed_at END,
          reviewed_at=CASE WHEN $3='REVIEW_REQUIRED' THEN clock_timestamp() ELSE reviewed_at END,updated_at=clock_timestamp()
          FROM mirror.catalog_import_executions e WHERE d.id=$1 AND d.recovery_token=$2 AND d.state='RECONCILING'
            AND d.recovery_fence=$5 AND d.recovery_until>clock_timestamp() AND e.id=d.run_id AND e.shop_id=d.shop_id
            AND e.generation_id=d.generation_id AND ($3<>'RETRY_ELIGIBLE' OR (
              e.delivery_revision=d.delivery_revision AND e.phase=$6 AND NOT e.cancel_requested AND NOT e.review_required
              AND e.completed_at IS NULL AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp())
              AND (d.reserved_until IS NULL OR d.reserved_until<=clock_timestamp()) AND $7=d.kind)) RETURNING d.id`,
        [d.id,claim.recoveryToken,targets[decision],decision,claim.recoveryFence,run.phase,run.kind]);
        return rows.rows.length===1?recorded():Object.freeze({kind:'STALE_RECOVERY'});
      });
    },
    async acknowledgeConsumptionInTransaction(input) {
      const tx=own(input,'tx'),claim=own(input,'claim');
      const deliveryKey=Object.hasOwn(input,'deliveryKey')?validId(own(input,'deliveryKey')):undefined;
      return acknowledgeDispatchConsumptionInTransaction({tx,claim,deliveryKey,verifyConsumption});
    },
    markDispatchReviewRequired,
    async listExhaustedDispatches({limit=100}={}) {
      integer(limit,1,100,'exhaustion discovery limit');
      return transaction(async c=>Object.freeze((await c.query(`SELECT d.id AS "dispatchId" FROM mirror.sync_dispatches d
        JOIN mirror.catalog_import_jobs j ON j.id=d.run_id AND j.shop_id=d.shop_id AND j.generation_id=d.generation_id
        JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
        WHERE d.state IN ('PENDING','RETRY_ELIGIBLE') AND d.attempt>=$1
          AND (d.reserved_until IS NULL OR d.reserved_until<=clock_timestamp())
          AND (d.recovery_until IS NULL OR d.recovery_until<=clock_timestamp()) ORDER BY d.updated_at,d.id LIMIT $2`,[maxDispatchAttempts,limit])).rows.map(Object.freeze)));
    },
    async getDispatchMetrics() {
      return transaction(async c=>{
        const states=(await c.query('SELECT state,count(*)::text AS count FROM mirror.sync_dispatches GROUP BY state ORDER BY state')).rows;
        const pending=(await c.query(`SELECT count(*)::text AS count FROM mirror.sync_dispatches
          WHERE state IN ('PENDING','RETRY_ELIGIBLE') AND attempt>=$1`,[maxDispatchAttempts])).rows[0].count;
        return Object.freeze({states:Object.freeze(Object.fromEntries(states.map(r=>[r.state,r.count]))),exhausted:pending});
      });
    },
    // Compatibility entry point: discovery only. Expiry is not retry proof.
    async recoverExpiredReservations({limit=100}={}) {
      return Object.freeze({kind:'RECOVERY_REQUIRED',candidates:await listRecoveryCandidates({limit})});
    },
  });
}
