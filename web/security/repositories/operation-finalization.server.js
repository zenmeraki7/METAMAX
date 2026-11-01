// Interface contract (repository root): docs/backend-interface-contracts.md#mutation-and-command-finalization
/** Durable local-only finalization. These retries never send Shopify mutations. */
import {randomUUID} from 'node:crypto';
import {isStaleExecutionError} from '../../workers/execution-errors.server.js';
export async function enqueueOperationFinalization(tx,{claim,item}){
 await tx.query(`INSERT INTO mirror.operation_finalizations(shop_id,command_id,installation_version,execution_fence,item_id,undo_pending)
  VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(shop_id,command_id) DO NOTHING`,[claim.shop_id,claim.id,claim.installation_version,String(claim.fence),item?.id??null,claim.kind==='undo']);
}
export function createOperationFinalizer({database,historyExecution,undoRepository,timeoutMs=10000,logger=console}){
 async function transaction(work){const tx=await database.connect();try{await tx.query('BEGIN');await tx.query("SET LOCAL statement_timeout='15000ms'");await tx.query("SET LOCAL lock_timeout='2000ms'");const result=await work(tx);await tx.query('COMMIT');return result;}catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}}
 async function bounded(callback){let timer;try{return await Promise.race([Promise.resolve().then(callback),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Finalization deadline'),{code:'FINALIZATION_TIMEOUT'})),timeoutMs);})]);}finally{clearTimeout(timer);}}
 const stale=()=>({kind:'STALE_CLAIM'});
 return Object.freeze({async runOne({workerId,commandId=null,shopId=null}={}){
  if(typeof workerId!=='string'||!workerId||workerId.length>128)throw TypeError('Finalization worker identity required');
  // Repair historical terminal commands whose final acknowledgment was dropped.
  await transaction(tx=>tx.query(`INSERT INTO mirror.operation_finalizations(shop_id,command_id,installation_version,execution_fence,item_id,undo_pending)
   SELECT c.shop_id,c.id,c.installation_version,c.fence,NULL,c.kind='undo'
   FROM mirror.job_commands c JOIN mirror.shops s ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
   WHERE c.kind IN('bulk_edit','undo','import') AND c.status IN('SUCCEEDED','PARTIAL','FAILED','CANCELLED') AND($1::text IS NULL OR c.id::text=$1) AND($2::text IS NULL OR c.shop_id=$2)
    AND NOT EXISTS(SELECT 1 FROM mirror.operation_finalizations f WHERE f.shop_id=c.shop_id AND f.command_id=c.id)
   ORDER BY c.id LIMIT 25 ON CONFLICT DO NOTHING`,[commandId===null?null:String(commandId),shopId]));
  const exhausted=(await transaction(tx=>tx.query(`UPDATE mirror.operation_finalizations SET state='REVIEW_REQUIRED',lease_token=NULL,lease_until=NULL,last_error='FINALIZATION_RETRY_EXHAUSTED',updated_at=clock_timestamp()
   WHERE(shop_id,command_id) IN(SELECT shop_id,command_id FROM mirror.operation_finalizations WHERE attempts>=8
    AND(state IN('PENDING','RETRY') OR state='RUNNING' AND lease_until<=clock_timestamp()) LIMIT 25 FOR UPDATE SKIP LOCKED) RETURNING shop_id,command_id`))).rows;
  for(const row of exhausted){try{logger.error?.({code:'FINALIZATION_RETRY_EXHAUSTED',shopId:row.shop_id,commandId:String(row.command_id),reviewRequired:true},'Terminal history/undo inconsistency requires review');}catch{}}
  const token=randomUUID();
  const task=await transaction(async tx=>(await tx.query(`WITH due AS(SELECT f.shop_id,f.command_id FROM mirror.operation_finalizations f
   JOIN mirror.job_commands c ON c.shop_id=f.shop_id AND c.id=f.command_id AND c.fence=f.execution_fence AND c.installation_version=f.installation_version
   JOIN mirror.shops s ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
   WHERE c.status IN('SUCCEEDED','PARTIAL','FAILED','CANCELLED') AND f.attempts<8 AND f.next_attempt_at<=clock_timestamp()
    AND(f.state IN('PENDING','RETRY') OR f.state='RUNNING' AND f.lease_until<=clock_timestamp())
    AND($1::text IS NULL OR f.command_id::text=$1) AND($2::text IS NULL OR f.shop_id=$2)
   ORDER BY f.next_attempt_at,f.command_id LIMIT 1 FOR UPDATE OF f SKIP LOCKED)
   UPDATE mirror.operation_finalizations f SET state='RUNNING',fence=f.fence+1,lease_token=$3,lease_until=clock_timestamp()+interval '30 seconds',attempts=f.attempts+1
   FROM due WHERE f.shop_id=due.shop_id AND f.command_id=due.command_id RETURNING f.*`,[commandId===null?null:String(commandId),shopId,token])).rows[0]);
  if(!task)return {kind:'EMPTY'};
  const ack=async({historyPending=task.history_pending,undoPending=task.undo_pending,state='RUNNING',error=null}={})=>transaction(async tx=>{
   const result=await tx.query(`UPDATE mirror.operation_finalizations f SET history_pending=$5,undo_pending=$6,state=$7,last_error=$8,
    next_attempt_at=clock_timestamp()+LEAST(900,5*power(2,LEAST(f.attempts,7)))*interval '1 second',
    lease_token=CASE WHEN $7='RUNNING' THEN f.lease_token ELSE NULL END,
    lease_until=CASE WHEN $7='RUNNING' THEN GREATEST(f.lease_until,clock_timestamp()+interval '30 seconds') ELSE NULL END,updated_at=clock_timestamp()
    FROM mirror.job_commands c JOIN mirror.shops s ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
    WHERE f.shop_id=$1 AND f.command_id=$2 AND f.fence=$3 AND f.lease_token=$4 AND f.lease_until>clock_timestamp() AND f.state='RUNNING'
     AND c.shop_id=f.shop_id AND c.id=f.command_id AND c.fence=f.execution_fence AND c.installation_version=f.installation_version
     AND c.status IN('SUCCEEDED','PARTIAL','FAILED','CANCELLED') RETURNING f.command_id`,[task.shop_id,task.command_id,task.fence,token,historyPending,undoPending,state,error]);
   if(result.rowCount!==1)throw Object.assign(Error('Finalization ownership lost'),{code:'HISTORY_OWNERSHIP_LOST'});
  });
  try{
   const context=await transaction(async tx=>{
    await tx.query("SELECT set_config('app.shop_id',$1,true)",[task.shop_id]);
    const claim=(await tx.query('SELECT * FROM mirror.job_commands WHERE shop_id=$1 AND id=$2 AND fence=$3 AND installation_version=$4',[task.shop_id,task.command_id,task.execution_fence,task.installation_version])).rows[0];
    const item=(await tx.query(task.item_id==null?'SELECT id,resource_id,intended_values FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 ORDER BY id DESC LIMIT 1':'SELECT id,resource_id,intended_values FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 AND id=$3',task.item_id==null?[task.shop_id,task.command_id]:[task.shop_id,task.command_id,task.item_id])).rows[0];
    if(!claim)throw Object.assign(Error('Finalization lineage unavailable'),{code:'FINALIZATION_LINEAGE_MISSING'});return {claim,item,workerId};
   });
   if(task.history_pending){const result=await bounded(()=>historyExecution.finalize(context));if(result?.completed!==true)throw Object.assign(Error('History reconciliation incomplete'),{code:'HISTORY_FINALIZATION_PENDING'});await ack({historyPending:false});task.history_pending=false;}
   if(task.undo_pending){if(!undoRepository)throw Object.assign(Error('Undo reconciliation unavailable'),{code:'UNDO_FINALIZATION_PENDING'});
    const result=await bounded(()=>undoRepository.reconcileExecutionForWorker({claim:context.claim}));
    if(!['COMPLETED','PARTIAL','FAILED','CANCELLED'].includes(result?.state))throw Object.assign(Error('Undo reconciliation incomplete'),{code:'UNDO_FINALIZATION_PENDING'});
    await ack({historyPending:false,undoPending:false});task.undo_pending=false;
   }
   await ack({historyPending:false,undoPending:false,state:'SUCCEEDED'});return {kind:'FINALIZED',commandId:String(task.command_id)};
  }catch(error){
   if(isStaleExecutionError(error))return stale();
   const code=typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'FINALIZATION_FAILED';
   try{await ack({state:task.attempts>=8?'REVIEW_REQUIRED':'RETRY',error:code});}catch(failure){if(isStaleExecutionError(failure))return stale();throw failure;}
   try{logger.error?.({code,shopId:task.shop_id,commandId:String(task.command_id),reviewRequired:task.attempts>=8},'Operation finalization queued for reconciliation');}catch{}
   return {kind:'FINALIZATION_PENDING',commandId:String(task.command_id)};
  }
 }});
}
