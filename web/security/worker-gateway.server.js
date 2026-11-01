// Interface contract (repository root): docs/backend-interface-contracts.md#worker-claim-and-processing
import {createVariantMutationWriter} from '../services/variant-mutation-writer.server.js';
import {resourceTypeForGid,requireResourceWriteContract} from '../fields/write-capabilities.js';
import {createOperationFinalizer,enqueueOperationFinalization} from '../workers/operation-finalization.server.js';
import {isStaleExecutionError as staleError} from '../workers/execution-errors.server.js';
import {startExecutionHeartbeat} from '../workers/execution-heartbeat.server.js';
import {assertRuntimeDatabaseProfile} from './runtime-database.server.js';
import {lockPublication} from '../mirror/publication-lock.server.js';
import {assertExecutionAuthorityContext} from '../services/execution-contract.server.js';
import {readOperationOutcome} from '../workers/operation-outcome.server.js';
import {createOperationRecoveryScanner} from '../workers/operation-recovery-scanner.server.js';
/** Durable Bulk Edit/Undo worker. Every remote write passes through V3 history. */
import {randomUUID,createHash} from 'node:crypto';
import {assertHistoryExecution} from '../edit-history/history-execution.server.js';
import {assertUndoRepository} from '../edit-history/undo-repository.server.js';
import {bulkInstructions,undoInstructions,importItemInstructions,restoredUpdates,assertIntendedValues,requireWriteAuthorization} from '../services/operation-instructions.server.js';
const issuedWorkers=new WeakSet();

export function assertOperationWorker(worker){if(!issuedWorkers.has(worker))throw TypeError('Issued journaled operation worker required');}
export function createOperationWorker({database,shopifyClientFactory,approvalService,authorizeWrite,historyExecution,undoRepository,logger=console,heartbeatMs=20000,renewalTimeoutMs=2000}={}){
 assertRuntimeDatabaseProfile(database,'operationWorker');
 if(typeof database?.connect!=='function'||typeof database?.query!=='function'||typeof shopifyClientFactory!=='function'||
  typeof approvalService?.getApprovedContract!=='function'||typeof authorizeWrite!=='function')throw TypeError('Transactional engine database and trusted execution providers required');
 if(!Number.isSafeInteger(heartbeatMs)||heartbeatMs<1||heartbeatMs>20000||!Number.isSafeInteger(renewalTimeoutMs)||renewalTimeoutMs<1||renewalTimeoutMs>2000)throw TypeError('Bounded heartbeat timing required');
 const heartbeats=new WeakMap();
 assertHistoryExecution(historyExecution);
 if(undoRepository!==undefined)assertUndoRepository(undoRepository);
 const finalizer=createOperationFinalizer({database,historyExecution,undoRepository,logger});
 const recoveryScanner=createOperationRecoveryScanner({database,historyExecution,logger});
 const transactionClaims=new WeakMap();
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 async function transaction(work){const tx=await database.connect();try{await tx.query('BEGIN');
  await tx.query("SET LOCAL statement_timeout='15000ms'");await tx.query("SET LOCAL lock_timeout='2000ms'");
  const value=await work(tx);const heldClaim=transactionClaims.get(tx);if(heldClaim)heartbeats.get(heldClaim)?.assertOwned();await tx.query('COMMIT');return value;
 }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{transactionClaims.delete(tx);tx.release();}}
 async function owner(tx,claim){transactionClaims.set(tx,claim);heartbeats.get(claim)?.assertOwned();await tx.query("SELECT set_config('app.shop_id',$1,true),set_config('app.installation_id',$2,true),set_config('app.installation_version',$2,true)",[claim.shop_id,claim.installation_version]);
  await lockPublication(tx,claim.shop_id,{write:false});
  const row=(await tx.query(`SELECT c.id FROM mirror.job_commands c JOIN mirror.shops s
  ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
  WHERE c.shop_id=$1 AND c.id=$2 AND c.fence=$3 AND c.lease_token=$4 AND c.status='RUNNING'
   AND c.lease_until>clock_timestamp() AND c.cancel_requested_at IS NULL AND c.installation_version=$5 FOR UPDATE OF c`,
  [claim.shop_id,claim.id,String(claim.fence),claim.lease_token,claim.installation_version])).rows[0];
  heartbeats.get(claim)?.assertOwned();
  if(!row)throw Object.assign(Error('Current execution ownership required'),{code:'HISTORY_OWNERSHIP_LOST'});
 }
 async function renewClaim(claim,leaseSeconds){return transaction(async tx=>{
    await tx.query("SELECT set_config('app.shop_id',$1,true),set_config('app.installation_id',$2,true),set_config('app.installation_version',$2,true)",[claim.shop_id,claim.installation_version]);
    const renewed=await tx.query(`UPDATE mirror.job_commands c SET lease_until=GREATEST(c.lease_until,clock_timestamp()+$6*interval '1 second'),updated_at=clock_timestamp()
     FROM mirror.shops s WHERE c.shop_id=$1 AND c.id=$2 AND c.fence=$3 AND c.lease_token=$4
      AND c.installation_version=$5 AND s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
      AND c.status='RUNNING' AND c.cancel_requested_at IS NULL AND c.lease_until>clock_timestamp() RETURNING c.id`,
     [claim.shop_id,claim.id,String(claim.fence),claim.lease_token,claim.installation_version,leaseSeconds]);
    return renewed.rowCount===1;
   });}
 async function claimedQuery(claim,sql,values){return transaction(async tx=>{await owner(tx,claim);return tx.query(sql,values);});}
 async function complete(claim,item,approved,result){return transaction(async tx=>{
  await owner(tx,claim);
  if(await historyExecution.verifyItemCompletion({tx,claim,item,approved,result})!==true)
   throw Object.assign(Error('Complete field verification required'),{code:'HISTORY_VERIFICATION_INCOMPLETE'});
  const snapshot=(await tx.query('SELECT id,before_hash,after_hash,confirmed_at FROM mirror.product_snapshots WHERE shop_id=$1 AND edit_item_id=$2 FOR UPDATE',[claim.shop_id,item.id])).rows[0];
  if(!snapshot||result?.beforeValues&&snapshot.before_hash!==hash(result.beforeValues))throw Error('Owned immutable engine BEFORE snapshot required');
  const updated=await tx.query(`UPDATE mirror.job_items SET status='SUCCEEDED',last_error=NULL,next_attempt_at=NULL
   WHERE shop_id=$1 AND command_id=$2 AND id=$3 AND status IN ('PENDING','RETRY','RUNNING') RETURNING id`,[claim.shop_id,claim.id,item.id]);
  if(updated.rowCount!==1){
   // A lost COMMIT response may follow a durable completion. Evidence and the
   // current claim were reverified above; accept only that exact final state.
   const prior=(await tx.query('SELECT status FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 AND id=$3 FOR SHARE',[claim.shop_id,claim.id,item.id])).rows[0];
   if(prior?.status==='SUCCEEDED'&&snapshot.confirmed_at&&snapshot.after_hash===hash(approved))return Object.freeze({state:'SUCCEEDED',itemId:String(item.id)});
   throw Object.assign(Error('Fenced item completion failed'),{code:'HISTORY_OWNERSHIP_LOST'});
  }
  if(!snapshot.confirmed_at)await tx.query('UPDATE mirror.product_snapshots SET after_hash=$3,confirmed_at=clock_timestamp() WHERE shop_id=$1 AND id=$2',
   [claim.shop_id,snapshot.id,hash(approved)]);
  return Object.freeze({state:'SUCCEEDED',itemId:String(item.id)});
 });}
 async function uncertainReceipt(claim){return transaction(async tx=>{await owner(tx,claim);const summary=await readOperationOutcome(tx,claim);
  await tx.query('UPDATE mirror.job_commands SET result=$3::jsonb WHERE shop_id=$1 AND id=$2',[claim.shop_id,claim.id,JSON.stringify(summary)]);
  return{kind:'OUTCOME_UNKNOWN',commandId:String(claim.id),...summary};});}
 const worker=Object.freeze({reconcileFinalizations:input=>finalizer.runOne(input),discoverRecoveries:input=>recoveryScanner.runOne(input),async claimNext({workerId,leaseSeconds=120}={}){
  if(typeof workerId!=='string'||!workerId||workerId.length>128||!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>300)throw TypeError('Bounded worker identity and lease required');
  return transaction(async tx=>{
   const cancelled=(await tx.query(`UPDATE mirror.job_commands SET status='CANCELLED',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
    WHERE id IN(SELECT id FROM mirror.job_commands WHERE kind IN('bulk_edit','undo','import') AND cancel_requested_at IS NOT NULL
     AND(status IN('PENDING','RETRY') OR(status='RUNNING' AND lease_until<=clock_timestamp())) ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)
    RETURNING id,shop_id,contract_id,kind`)).rows;
   for(const command of cancelled)await tx.query(`INSERT INTO mirror.audit_events(shop_id,operation_id,action,actor_id,outcome,summary)
    VALUES($1,$2,$3,$4,'CANCELLED',$5::jsonb)`,[command.shop_id,command.contract_id,`${command.kind}_cancelled`,workerId,
     JSON.stringify({commandId:String(command.id),writeOutcome:'consult_history'})]);
   await tx.query(`UPDATE mirror.job_commands SET status='FAILED',lease_token=NULL,lease_until=NULL,
    checkpoint=COALESCE(checkpoint,'{}'::jsonb)||'{"review_required":true}',updated_at=clock_timestamp() WHERE kind IN('bulk_edit','undo','import')
     AND id IN(SELECT id FROM mirror.job_commands WHERE kind IN('bulk_edit','undo','import') AND attempts>=max_attempts
      AND(status IN('PENDING','RETRY') OR(status='RUNNING' AND lease_until<=clock_timestamp())) ORDER BY id LIMIT 25 FOR UPDATE SKIP LOCKED)`);
   const row=(await tx.query(`SELECT c.* FROM mirror.job_commands c JOIN mirror.shops s
    ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
    WHERE c.kind IN('bulk_edit','undo','import') AND c.attempts<c.max_attempts AND c.cancel_requested_at IS NULL
     AND NOT COALESCE((c.checkpoint->>'review_required')::boolean,false)
     AND mirror.catalog_edit_is_ready(c.shop_id)
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
  const leaseSeconds=options.leaseSeconds??120;
  const heartbeat=startExecutionHeartbeat({leaseMs:leaseSeconds*1000,intervalMs:Math.min(heartbeatMs,Math.floor(leaseSeconds*1000/3)),timeoutMs:Math.min(renewalTimeoutMs,Math.floor(leaseSeconds*1000/3)),
   renew:()=>renewClaim(claim,leaseSeconds)});
  heartbeats.set(claim,heartbeat);
  const process=async()=>{
  let succeededCount=0;
  let client;
  async function executionClient(){
   if(client)return client;
  const transport=await shopifyClientFactory({shopId:claim.shop_id,installationId:claim.installation_version,signal:heartbeat.signal});
  const variants=typeof transport?.request==='function'?createVariantMutationWriter({request:(...args)=>transport.request(...args)}):{};
  const methods={...variants,...transport};
  client=Object.fromEntries(['readProduct','applyMutation','readVariant','applyVariantMutation'].map(name=>[name,typeof (transport?.[name]??methods[name])==='function'?async input=>{
   await heartbeat.check();
   const signal=input.signal?AbortSignal.any([input.signal,heartbeat.signal]):heartbeat.signal;
   heartbeat.assertOwned();return (transport?.[name]??methods[name]).call(transport,{...input,signal});
  }:undefined]));
  if(!(['readProduct','applyMutation'].every(name=>typeof client[name]==='function')||['readVariant','applyVariantMutation'].every(name=>typeof client[name]==='function')))throw TypeError('Authoritative resource transport required');
   return client;
  }
  const items=(await claimedQuery(claim,`SELECT id,resource_id,intended_values,restore_snapshot_id,attempts FROM mirror.job_items
   WHERE shop_id=$1 AND command_id=$2 AND status IN('PENDING','RETRY') AND attempts<8
    AND(next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) ORDER BY id LIMIT 25`,[claim.shop_id,claim.id])).rows;
  for(const item of items){let approved;try{
   const inspection=await historyExecution.inspectItem({claim,item});
   if(inspection.state==='VERIFIED'){
    approved=typeof item.intended_values==='string'?JSON.parse(item.intended_values):item.intended_values;
    await complete(claim,item,approved,inspection);succeededCount++;continue;
   }
   if(inspection.state==='UNCERTAIN')return await uncertainReceipt(claim);
   if(inspection.state==='CONFLICT')throw Object.assign(Error('History conflict requires reconciliation'),{code:'HISTORY_VERIFICATION_INCOMPLETE'});
   const contract=await transaction(async tx=>{await owner(tx,claim);return approvalService.getApprovedContract({client:tx,shopId:claim.shop_id,contractId:claim.contract_id});});
   assertExecutionAuthorityContext(contract,{shopId:claim.shop_id,installationId:claim.installation_version,operationKind:claim.kind});
   if(claim.kind==='undo'){
    const undo=undoInstructions(contract,claim.shop_id);
    if(!undoRepository)throw Error('History undo integration required');
    const source=await undoRepository.loadExecutionSourceForWorker({claim,item});
    if(source.sourceCommandId!==undo.sourceCommandId)throw Error('Approved original execution required');
    approved=restoredUpdates(source.inverseValues,undo.fields,undo.resourceType);
   }else approved=claim.kind==='import'?importItemInstructions(contract,claim.shop_id,item.resource_id):bulkInstructions(contract,claim.shop_id);
   assertIntendedValues(typeof item.intended_values==='string'?JSON.parse(item.intended_values):item.intended_values,approved);
   const resourceType=resourceTypeForGid(item.resource_id);
   await requireWriteAuthorization(authorizeWrite,{resourceType,fieldIds:Object.keys(approved).map(name=>requireResourceWriteContract(resourceType).bindings[name]),shopId:claim.shop_id,installationId:claim.installation_version,contract,operation:claim.kind,
    resourceId:item.resource_id,fields:Object.keys(approved)});
   const result=await historyExecution.execute({claim,item,workerId:options.workerId,shopifyClient:await executionClient(),approved,
    dispatchGuard:async tx=>{
     heartbeat.assertOwned();
     const held=(await tx.query(`SELECT c.id FROM mirror.job_commands c JOIN mirror.shops s
      ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
      WHERE c.shop_id=$1 AND c.id=$2 AND c.installation_version=$3 AND c.fence=$4 AND c.lease_token=$5
       AND c.status='RUNNING' AND c.cancel_requested_at IS NULL AND c.lease_until>clock_timestamp()`,
      [claim.shop_id,claim.id,claim.installation_version,String(claim.fence),claim.lease_token])).rows[0];
     if(!held)throw Object.assign(Error('Dispatch ownership lost'),{code:'HISTORY_OWNERSHIP_LOST'});
     const current=await approvalService.getApprovedContract({client:tx,shopId:claim.shop_id,contractId:claim.contract_id});
     assertExecutionAuthorityContext(current,{shopId:claim.shop_id,installationId:claim.installation_version,operationKind:claim.kind});
     await requireWriteAuthorization(authorizeWrite,{client:tx,resourceType,fieldIds:Object.keys(approved).map(name=>requireResourceWriteContract(resourceType).bindings[name]),
      shopId:claim.shop_id,installationId:claim.installation_version,contract:current,operation:claim.kind,resourceId:item.resource_id,fields:Object.keys(approved)});
     heartbeat.assertOwned();
    },
    captureBefore:before=>transaction(async tx=>{await owner(tx,claim);
     await tx.query(`INSERT INTO mirror.product_snapshots(shop_id,edit_item_id,before_values,before_hash,captured_at)
      VALUES($1,$2,$3::jsonb,$4,clock_timestamp()) ON CONFLICT(shop_id,edit_item_id) DO NOTHING`,[claim.shop_id,item.id,JSON.stringify(before),hash(before)]);
     const stored=(await tx.query('SELECT before_hash FROM mirror.product_snapshots WHERE shop_id=$1 AND edit_item_id=$2',[claim.shop_id,item.id])).rows[0];
     if(stored?.before_hash!==hash(before))throw Error('Engine BEFORE snapshot cannot change across retries');
    })});
   if(result.state==='VERIFIED'){await complete(claim,item,approved,result);succeededCount++;}
   else if(result.state==='OUTCOME_UNKNOWN')return await uncertainReceipt(claim);
   else await transaction(async tx=>{await owner(tx,claim);await tx.query("UPDATE mirror.job_items SET status='FAILED',last_error='PREFLIGHT_CONFLICT' WHERE shop_id=$1 AND id=$2 AND command_id=$3",[claim.shop_id,item.id,claim.id]);});
  }catch(error){
   if(staleError(error))return{kind:'STALE_CLAIM',commandId:String(claim.id)};
   if(['FIELD_CONTRACT_MISMATCH','HISTORY_BINDING_CONFLICT','FIELD_UNSUPPORTED_OPERATION','FIELD_EXECUTION_UNAVAILABLE'].includes(error.code)){
    await heartbeat.stop();
    return transaction(async tx=>{await owner(tx,claim);const summary=await readOperationOutcome(tx,claim);
     const result={...summary,outcome:'REVIEW_REQUIRED',terminal:false,reason:error.code};
     await tx.query(`UPDATE mirror.job_commands SET status='RETRY',lease_token=NULL,lease_until=NULL,
      checkpoint=COALESCE(checkpoint,'{}'::jsonb)||'{"review_required":true}',result=$3::jsonb,updated_at=clock_timestamp()
      WHERE shop_id=$1 AND id=$2`,[claim.shop_id,claim.id,JSON.stringify(result)]);
     return{kind:'REVIEW_REQUIRED',commandId:String(claim.id),...result};
    });
   }
   if(error.code==='HISTORY_RECOVERY_PERSISTENCE_FAILED'){
    try{logger.error?.({code:error.code,shopId:claim.shop_id,commandId:String(claim.id)},'Outcome persistence failed; independent recovery scanner required');}catch{}
    return{kind:'RECOVERY_PERSISTENCE_FAILED',outcome:'OUTCOME_UNKNOWN',commandId:String(claim.id)};
   }
   let inspection;
   try{inspection=await historyExecution.inspectItem({claim,item});}
   catch(failure){if(staleError(failure))throw failure;return{kind:'RECOVERY_REQUIRED',commandId:String(claim.id)};}
   if(inspection.state==='VERIFIED'){
    try{if(!approved)throw Error('Approval unavailable');await complete(claim,item,approved,inspection);succeededCount++;continue;}
    catch(failure){if(staleError(failure))throw failure;return{kind:'RECOVERY_REQUIRED',commandId:String(claim.id)};}
   }
   if(inspection.state==='UNCERTAIN')return await uncertainReceipt(claim);
   if(inspection.state==='CONFLICT'||error.code==='HISTORY_VERIFICATION_INCOMPLETE')return{kind:'RECOVERY_REQUIRED',commandId:String(claim.id)};
   await transaction(async tx=>{await owner(tx,claim);await tx.query(`UPDATE mirror.job_items SET attempts=attempts+1,
    status=(CASE WHEN attempts+1>=8 THEN 'FAILED' ELSE 'RETRY' END)::mirror."WorkStatus",last_error='EXECUTION_PRE_SEND_ERROR',
    next_attempt_at=clock_timestamp()+LEAST(900,10*power(2,LEAST(attempts+1,7)))*interval '1 second' WHERE shop_id=$1 AND command_id=$2 AND id=$3`,[claim.shop_id,claim.id,item.id]);});
   try{logger.error?.('[operation] Pre-send execution failed; bounded retry scheduled');}catch{}
  }}
   await heartbeat.stop();
   const finalItem=items.at(-1)??(await claimedQuery(claim,'SELECT id,resource_id,intended_values FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 ORDER BY id LIMIT 1',[claim.shop_id,claim.id])).rows[0];
  const receipt=await transaction(async tx=>{await owner(tx,claim);
   const summary=await readOperationOutcome(tx,claim),counts=summary.counts;
   const state=!summary.terminal?'RETRY':summary.outcome==='SUCCEEDED'?'SUCCEEDED':summary.outcome==='PARTIAL'?'PARTIAL':'FAILED';
   // Successful batches continue without spending the failure budget. Item
   // failures and abandoned/no-progress claims retain their bounded retries.
   await tx.query(`UPDATE mirror.job_commands SET status=$3,lease_token=NULL,lease_until=NULL,
    attempts=CASE WHEN $5::boolean THEN 0 ELSE attempts END,
    available_at=GREATEST(clock_timestamp(),COALESCE($4::timestamptz,clock_timestamp())),result=$6::jsonb,updated_at=clock_timestamp()
    WHERE shop_id=$1 AND id=$2`,[claim.shop_id,claim.id,state,summary.due,succeededCount>0,JSON.stringify(summary)]);
   if(state!=='RETRY')await tx.query(`INSERT INTO mirror.audit_events(shop_id,operation_id,action,actor_id,outcome,summary)
    VALUES($1,$2,$3,$4,$5,$6::jsonb)`,[claim.shop_id,claim.contract_id,`${claim.kind}_completed`,options.workerId,summary.outcome,
     JSON.stringify({commandId:String(claim.id),...summary})]);
   if(state!=='RETRY')await enqueueOperationFinalization(tx,{claim,item:finalItem});
   return{kind:state==='RETRY'?'IN_PROGRESS':summary.outcome,commandStatus:state,commandId:String(claim.id),succeededCount:counts.succeeded,...summary};
  });
  if(receipt.terminal){
   const result=await finalizer.runOne({workerId:options.workerId,commandId:claim.id,shopId:claim.shop_id});
   if(result.kind!=='FINALIZED')return {...receipt,kind:'FINALIZATION_PENDING',executionState:receipt.outcome};
  }
  return receipt;
  };
  try{return await Promise.race([process(),heartbeat.loss]);}
  catch(error){if(staleError(error))return {kind:'STALE_CLAIM',commandId:String(claim.id)};throw error;}
  finally{await heartbeat.stop().catch(()=>{});}
 }});issuedWorkers.add(worker);return worker;
}
