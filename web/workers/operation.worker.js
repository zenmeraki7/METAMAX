/** Durable Bulk Edit/Undo worker. Every remote write passes through V3 history. */
import {randomUUID,createHash} from 'node:crypto';
import {assertHistoryExecution} from '../edit-history/history-execution.server.js';
import {assertUndoRepository} from '../edit-history/undo-repository.server.js';
import {bulkInstructions,undoInstructions,restoredUpdates,assertIntendedValues,requireWriteAuthorization} from '../services/operation-instructions.server.js';
export function createOperationWorker({database,shopifyClientFactory,approvalService,authorizeWrite,historyExecution,undoRepository,logger=console}={}){
 if(typeof database?.connect!=='function'||typeof database?.query!=='function'||typeof shopifyClientFactory!=='function'||
  typeof approvalService?.getApprovedContract!=='function'||typeof authorizeWrite!=='function')throw TypeError('Transactional engine database and trusted execution providers required');
 assertHistoryExecution(historyExecution);
 if(undoRepository!==undefined)assertUndoRepository(undoRepository);
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 async function transaction(work){const tx=await database.connect();try{await tx.query('BEGIN');
  await tx.query("SET LOCAL statement_timeout='15000ms'");await tx.query("SET LOCAL lock_timeout='2000ms'");
  const value=await work(tx);await tx.query('COMMIT');return value;
 }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}}
 async function owner(tx,claim){const row=(await tx.query(`SELECT c.id FROM mirror.job_commands c JOIN mirror.shops s
  ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
  WHERE c.shop_id=$1 AND c.id=$2 AND c.fence=$3 AND c.lease_token=$4 AND c.status='RUNNING'
   AND c.lease_until>clock_timestamp() AND c.cancel_requested_at IS NULL FOR UPDATE OF c`,
  [claim.shop_id,claim.id,String(claim.fence),claim.lease_token])).rows[0];
  if(!row)throw Object.assign(Error('Current execution ownership required'),{code:'HISTORY_OWNERSHIP_LOST'});
 }
 async function complete(claim,item,result){return transaction(async tx=>{
  await owner(tx,claim);
  const verified=(await tx.query(`SELECT r.id FROM edit_history.mutation_requests r JOIN edit_history.operations o
   ON o.shop_id=r.shop_id AND o.installation_id=r.installation_id AND o.id=r.operation_id
   WHERE r.shop_id=$1 AND r.installation_id=$2 AND o.execution_job_id=$3 AND r.execution_item_id=$4
    AND r.request_state='VERIFIED' AND o.purge_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM edit_history.changes c
     WHERE c.shop_id=r.shop_id AND c.installation_id=r.installation_id AND c.operation_id=r.operation_id
      AND c.mutation_id=r.mutation_id AND c.attempt_id=r.attempt_id AND c.mutation_state<>'VERIFIED') LIMIT 1`,
   [claim.shop_id,claim.installation_version,claim.id,item.id])).rows[0];
  if(!verified)throw Error('Durable verified history required for item completion');
  const snapshot=(await tx.query('SELECT id,before_hash,confirmed_at FROM mirror.product_snapshots WHERE shop_id=$1 AND edit_item_id=$2 FOR UPDATE',[claim.shop_id,item.id])).rows[0];
  if(!snapshot||result?.beforeValues&&snapshot.before_hash!==hash(result.beforeValues))throw Error('Owned immutable engine BEFORE snapshot required');
  await tx.query("UPDATE mirror.job_items SET status='SUCCEEDED',last_error=NULL,next_attempt_at=NULL WHERE shop_id=$1 AND command_id=$2 AND id=$3",[claim.shop_id,claim.id,item.id]);
  if(!snapshot.confirmed_at)await tx.query('UPDATE mirror.product_snapshots SET after_hash=$3,confirmed_at=clock_timestamp() WHERE shop_id=$1 AND id=$2',
   [claim.shop_id,snapshot.id,hash(result?.afterValues??(typeof item.intended_values==='string'?JSON.parse(item.intended_values):item.intended_values))]);
 });}
 const worker=Object.freeze({async claimNext({workerId,leaseSeconds=120}={}){
  if(typeof workerId!=='string'||!workerId||workerId.length>128||!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>300)throw TypeError('Bounded worker identity and lease required');
  return transaction(async tx=>{
   const cancelled=(await tx.query(`UPDATE mirror.job_commands SET status='CANCELLED',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE id IN(SELECT id FROM mirror.job_commands WHERE kind IN('bulk_edit','undo') AND cancel_requested_at IS NOT NULL
     AND(status IN('PENDING','RETRY') OR(status='RUNNING' AND lease_until<=clock_timestamp())) ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)
    RETURNING id,shop_id,contract_id,kind`)).rows;
   for(const command of cancelled)await tx.query(`INSERT INTO mirror.audit_events(shop_id,operation_id,action,actor_id,outcome,summary)
    VALUES($1,$2,$3,$4,'CANCELLED',$5::jsonb)`,[command.shop_id,command.contract_id,`${command.kind}_cancelled`,workerId,
     JSON.stringify({commandId:String(command.id),writeOutcome:'consult_history'})]);
   await tx.query(`UPDATE mirror.job_commands SET status='FAILED',lease_token=NULL,lease_until=NULL,
    checkpoint=COALESCE(checkpoint,'{}'::jsonb)||'{"review_required":true}',updated_at=clock_timestamp() WHERE kind IN('bulk_edit','undo')
     AND id IN(SELECT id FROM mirror.job_commands WHERE kind IN('bulk_edit','undo') AND attempts>=max_attempts
      AND(status IN('PENDING','RETRY') OR(status='RUNNING' AND lease_until<=clock_timestamp())) ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)`);
   const row=(await tx.query(`SELECT c.* FROM mirror.job_commands c JOIN mirror.shops s
    ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
    WHERE c.kind IN('bulk_edit','undo') AND c.attempts<c.max_attempts AND c.cancel_requested_at IS NULL
     AND NOT COALESCE((c.checkpoint->>'review_required')::boolean,false)
     AND ((c.status IN('PENDING','RETRY') AND c.available_at<=clock_timestamp()) OR(c.status='RUNNING' AND c.lease_until<=clock_timestamp()))
     AND NOT EXISTS(SELECT 1 FROM edit_history.operations o JOIN edit_history.mutation_requests r
      ON r.shop_id=o.shop_id AND r.installation_id=o.installation_id AND r.operation_id=o.id
      WHERE o.shop_id=c.shop_id AND o.installation_id=c.installation_version AND o.execution_job_id=c.id
       AND r.request_state IN('DISPATCH_AUTHORIZED','ACKNOWLEDGED','OUTCOME_UNKNOWN'))
    ORDER BY c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`)).rows[0];
   if(!row)return null;
   const token=randomUUID();return(await tx.query(`UPDATE mirror.job_commands SET status='RUNNING',lease_token=$1,
    lease_until=clock_timestamp()+$2*interval '1 second',fence=fence+1,attempts=attempts+1,updated_at=clock_timestamp()
    WHERE shop_id=$3 AND id=$4 AND fence=$5 RETURNING *`,[token,leaseSeconds,row.shop_id,row.id,String(row.fence)])).rows[0]??null;
  });
 },async processOne(options={}){
  const claim=await worker.claimNext(options);if(!claim)return{kind:'EMPTY'};
  let succeededCount=0;
  const client=await shopifyClientFactory({shopId:claim.shop_id,installationId:claim.installation_version});
  if(typeof client?.readProduct!=='function'||typeof client?.applyMutation!=='function')throw TypeError('Authoritative Shopify transport required');
  const items=(await database.query(`SELECT id,resource_id,intended_values,restore_snapshot_id,attempts FROM mirror.job_items
   WHERE shop_id=$1 AND command_id=$2 AND status IN('PENDING','RETRY') AND attempts<8
    AND(next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) ORDER BY id LIMIT 25`,[claim.shop_id,claim.id])).rows;
  for(const item of items){try{
   const reconciled=(await database.query(`SELECT r.id FROM edit_history.mutation_requests r JOIN edit_history.operations o
    ON o.shop_id=r.shop_id AND o.installation_id=r.installation_id AND o.id=r.operation_id
    WHERE o.shop_id=$1 AND o.installation_id=$2 AND o.execution_job_id=$3 AND r.execution_item_id=$4 AND r.request_state='VERIFIED' LIMIT 1`,
    [claim.shop_id,claim.installation_version,claim.id,item.id])).rows[0];
   if(reconciled){await complete(claim,item);succeededCount++;continue;}
   const contract=await approvalService.getApprovedContract({shopId:claim.shop_id,contractId:claim.contract_id});
   let approved;
   if(claim.kind==='undo'){
    const undo=undoInstructions(contract,claim.shop_id);
    if(!undoRepository)throw Error('History undo integration required');
    const source=await undoRepository.loadExecutionSourceForWorker({claim,item});
    if(source.sourceCommandId!==undo.sourceCommandId)throw Error('Approved original execution required');
    approved=restoredUpdates(source.inverseValues,undo.fields);
   }else approved=bulkInstructions(contract,claim.shop_id);
   assertIntendedValues(typeof item.intended_values==='string'?JSON.parse(item.intended_values):item.intended_values,approved);
   await requireWriteAuthorization(authorizeWrite,{shopId:claim.shop_id,installationId:claim.installation_version,contract,operation:claim.kind,
    resourceId:item.resource_id,fields:Object.keys(approved)});
   await transaction(tx=>owner(tx,claim));
   const result=await historyExecution.execute({claim,item,workerId:options.workerId,shopifyClient:client,approved,
    captureBefore:before=>transaction(async tx=>{await owner(tx,claim);
     await tx.query(`INSERT INTO mirror.product_snapshots(shop_id,edit_item_id,before_values,before_hash,captured_at)
      VALUES($1,$2,$3::jsonb,$4,clock_timestamp()) ON CONFLICT(shop_id,edit_item_id) DO NOTHING`,[claim.shop_id,item.id,JSON.stringify(before),hash(before)]);
     const stored=(await tx.query('SELECT before_hash FROM mirror.product_snapshots WHERE shop_id=$1 AND edit_item_id=$2',[claim.shop_id,item.id])).rows[0];
     if(stored?.before_hash!==hash(before))throw Error('Engine BEFORE snapshot cannot change across retries');
    })});
   if(result.state==='VERIFIED'){await complete(claim,item,result);succeededCount++;}
   else if(result.state==='OUTCOME_UNKNOWN')return{kind:'OUTCOME_UNKNOWN',commandId:String(claim.id),succeededCount};
   else await transaction(async tx=>{await owner(tx,claim);await tx.query("UPDATE mirror.job_items SET status='FAILED',last_error='PREFLIGHT_CONFLICT' WHERE shop_id=$1 AND id=$2 AND command_id=$3",[claim.shop_id,item.id,claim.id]);});
  }catch(error){
   if(error.code==='HISTORY_OWNERSHIP_LOST')return{kind:'STALE_CLAIM',commandId:String(claim.id)};
   const verified=(await database.query(`SELECT 1 FROM edit_history.operations o JOIN edit_history.mutation_requests r
    ON r.shop_id=o.shop_id AND r.installation_id=o.installation_id AND r.operation_id=o.id WHERE o.shop_id=$1 AND o.installation_id=$2
     AND o.execution_job_id=$3 AND r.execution_item_id=$4 AND r.request_state='VERIFIED' LIMIT 1`,[claim.shop_id,claim.installation_version,claim.id,item.id])).rows.length;
   if(verified){
    // Inspect durable truth before retrying only the idempotent local completion.
    // Never turn a verified remote write back into a retryable mutation item.
    try{await complete(claim,item);succeededCount++;continue;}catch{return{kind:'RECOVERY_REQUIRED',commandId:String(claim.id)};}
   }
   const uncertain=(await database.query(`SELECT 1 FROM edit_history.operations o JOIN edit_history.mutation_requests r
    ON r.shop_id=o.shop_id AND r.installation_id=o.installation_id AND r.operation_id=o.id
    WHERE o.shop_id=$1 AND o.installation_id=$2 AND o.execution_job_id=$3 AND r.execution_item_id=$4
     AND r.request_state IN('DISPATCH_AUTHORIZED','ACKNOWLEDGED','OUTCOME_UNKNOWN') LIMIT 1`,[claim.shop_id,claim.installation_version,claim.id,item.id])).rows.length;
   if(uncertain)return{kind:'OUTCOME_UNKNOWN',commandId:String(claim.id)};
   await transaction(async tx=>{await owner(tx,claim);await tx.query(`UPDATE mirror.job_items SET attempts=attempts+1,
    status=(CASE WHEN attempts+1>=8 THEN 'FAILED' ELSE 'RETRY' END)::mirror."WorkStatus",last_error='EXECUTION_PRE_SEND_ERROR',
    next_attempt_at=clock_timestamp()+LEAST(900,10*power(2,LEAST(attempts+1,7)))*interval '1 second' WHERE shop_id=$1 AND command_id=$2 AND id=$3`,[claim.shop_id,claim.id,item.id]);});
   try{logger.error?.('[operation] Pre-send execution failed; bounded retry scheduled');}catch{}
  }}
  const receipt=await transaction(async tx=>{await owner(tx,claim);
   const counts=(await tx.query(`SELECT count(*) FILTER(WHERE status<>'SUCCEEDED')::int AS remaining,
    count(*) FILTER(WHERE status='FAILED')::int AS failed,min(next_attempt_at) FILTER(WHERE status='RETRY') AS due
    FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2`,[claim.shop_id,claim.id])).rows[0];
   const waiting=(await tx.query("SELECT 1 FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 AND status IN('PENDING','RETRY','RUNNING') AND attempts<8 LIMIT 1",[claim.shop_id,claim.id])).rows.length;
   const state=counts.remaining===0?'SUCCEEDED':waiting?'RETRY':'FAILED';
   await tx.query(`UPDATE mirror.job_commands SET status=$3,lease_token=NULL,lease_until=NULL,
    available_at=GREATEST(clock_timestamp(),COALESCE($4::timestamptz,clock_timestamp())),updated_at=clock_timestamp()
    WHERE shop_id=$1 AND id=$2`,[claim.shop_id,claim.id,state,counts.due]);
   if(state!=='RETRY')await tx.query(`INSERT INTO mirror.audit_events(shop_id,operation_id,action,actor_id,outcome,summary)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[claim.shop_id,claim.contract_id,`${claim.kind}_completed`,options.workerId,state,
     JSON.stringify({commandId:String(claim.id),succeededCount,remainingCount:counts.remaining})]);
   return{kind:state==='RETRY'?'PARTIAL':state,commandId:String(claim.id),succeededCount};
  });
  if(['SUCCEEDED','FAILED'].includes(receipt.kind)){
   const finalItem=items.at(-1)??(await database.query('SELECT id,resource_id,intended_values FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 ORDER BY id LIMIT 1',[claim.shop_id,claim.id])).rows[0];
   if(finalItem)await historyExecution.finalize({claim,item:finalItem,workerId:options.workerId}).catch(()=>{});
   if(claim.kind==='undo')await undoRepository?.reconcileExecutionForWorker({claim}).catch(()=>{});
  }
  return receipt;
 }});return worker;
}
