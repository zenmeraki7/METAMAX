/** Discover from journal truth, without relying on the original worker's writes.
 * Recovery scheduling uses independent tenant authentication, never a stale claim.
 * Scan ownership/backoff lives durably in the command checkpoint. No Shopify send.
 */
import {randomUUID} from 'node:crypto';
export function createOperationRecoveryScanner({database,historyExecution,logger=console}){
 async function transaction(work){const tx=await database.connect();try{await tx.query('BEGIN');await tx.query("SET LOCAL statement_timeout='15000ms'");await tx.query("SET LOCAL lock_timeout='2000ms'");const result=await work(tx);await tx.query('COMMIT');return result;}catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}}
 return Object.freeze({async runOne({workerId,shopId=null,commandId=null}={}){
  if(typeof workerId!=='string'||!workerId||workerId.length>128)throw TypeError('Recovery scanner identity required');
  const token=randomUUID();
  const scan=await transaction(async tx=>(await tx.query(`WITH interrupted AS(SELECT j.shop_id,j.id FROM mirror.job_commands j
   JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
   WHERE j.kind IN('bulk_edit','undo','import') AND(j.status<>'RUNNING' OR j.lease_until<=clock_timestamp())
    AND($2::text IS NULL OR j.shop_id=$2) AND($3::text IS NULL OR j.id::text=$3)
    AND COALESCE((j.checkpoint->'recoveryScan'->>'nextAttemptAt')::timestamptz,'epoch')<=clock_timestamp()
    AND EXISTS(SELECT 1 FROM edit_history.operations o JOIN edit_history.mutation_requests r
     ON r.shop_id=o.shop_id AND r.installation_id=o.installation_id AND r.operation_id=o.id
     WHERE o.shop_id=j.shop_id AND o.installation_id=j.installation_version AND o.execution_job_id=j.id AND o.purge_requested_at IS NULL
      AND r.request_state IN('DISPATCH_AUTHORIZED','ACKNOWLEDGED','OUTCOME_UNKNOWN'))
   ORDER BY COALESCE((j.checkpoint->'recoveryScan'->>'nextAttemptAt')::timestamptz,'epoch'),j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED)
   UPDATE mirror.job_commands j SET checkpoint=COALESCE(j.checkpoint,'{}'::jsonb)||jsonb_build_object('recoveryScan',jsonb_build_object(
    'version',1,'state','RUNNING','token',$1::text,'attempts',LEAST(8,COALESCE((j.checkpoint->'recoveryScan'->>'attempts')::int,0)+1),
    'fence',(COALESCE((j.checkpoint->'recoveryScan'->>'fence')::bigint,0)+1)::text,'nextAttemptAt',clock_timestamp()+interval '60 seconds'))
   FROM interrupted WHERE j.shop_id=interrupted.shop_id AND j.id=interrupted.id RETURNING j.*`,[token,shopId,commandId===null?null:String(commandId)])).rows[0]);
  if(!scan)return {kind:'EMPTY'};
  const ownership=scan.checkpoint.recoveryScan;
  let result,errorCode;
  try{result=await historyExecution.discoverRecovery({shopId:scan.shop_id,installationId:scan.installation_version,executionJobId:String(scan.id),workerId,limit:25});}
  catch(error){errorCode=typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'RECOVERY_DISCOVERY_FAILED';}
  if(!errorCode&&(!Number.isSafeInteger(result?.scheduledRequests)||result.scheduledRequests<0))errorCode='RECOVERY_DISCOVERY_INCOMPLETE';
  const attempts=errorCode?ownership.attempts:0,state=errorCode?(attempts>=8?'REVIEW_REQUIRED':'RETRY'):'SCHEDULED';
  const acknowledged=await transaction(async tx=>(await tx.query(`UPDATE mirror.job_commands j SET checkpoint=jsonb_set(j.checkpoint,'{recoveryScan}',
   jsonb_build_object('version',1,'state',$6::text,'attempts',$7::int,'fence',$5::text,'lastError',$8::text,
    'nextAttemptAt',clock_timestamp()+$9::int*interval '1 second','scheduledRequests',$10::int)),updated_at=clock_timestamp()
   FROM mirror.shops s WHERE j.shop_id=$1 AND j.id=$2 AND j.installation_version=$3 AND j.fence=$4
    AND s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
    AND j.checkpoint->'recoveryScan'->>'token'=$11 AND(j.checkpoint->'recoveryScan'->>'fence')::bigint=$5::bigint
    AND(j.checkpoint->'recoveryScan'->>'nextAttemptAt')::timestamptz>clock_timestamp()
    AND(j.status<>'RUNNING' OR j.lease_until<=clock_timestamp()) RETURNING j.id`,
   [scan.shop_id,scan.id,scan.installation_version,scan.fence,ownership.fence,state,attempts,errorCode??null,errorCode?Math.min(900,5*2**Math.min(attempts,8)):60,result?.scheduledRequests??null,token])).rowCount);
  if(acknowledged!==1)return {kind:'STALE_CLAIM'};
  if(errorCode){try{logger.error?.({code:errorCode,shopId:scan.shop_id,commandId:String(scan.id),reviewRequired:state==='REVIEW_REQUIRED'},'Independent outcome recovery requires attention');}catch{}}
  return {kind:errorCode?'RECOVERY_SCAN_PENDING':'RECOVERY_SCHEDULED',commandId:String(scan.id),state};
 }});
}
