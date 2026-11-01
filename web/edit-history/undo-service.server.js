/** Undo is an approved inverse execution, never a separate mutation writer. */
import {assertUndoRepository} from './undo-repository.server.js';
import {detectUndoConflicts} from './undo-conflict-detector.server.js';
import {historyFingerprint,HistoryContractError,HISTORY_ERROR_CODES as C} from './history-contract.js';
import {assertJobDispatchService} from '../services/job-dispatch.server.js';
export function createUndoService({repository,observeCurrent,verifyCurrentObservation,verifyInverseWritePolicy,approveInverseExecution,dispatchService,timeoutMs=10000}={}){
 assertUndoRepository(repository);
 assertJobDispatchService(dispatchService);
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw TypeError('Bounded undo provider deadline required');
 if([observeCurrent,verifyCurrentObservation,verifyInverseWritePolicy,approveInverseExecution].some(fn=>typeof fn!=='function')||typeof dispatchService?.dispatchUndo!=='function')throw TypeError('Authoritative verification, current Field Engine write policies, approval and existing execution pipeline required');
 async function call(fn,context){const controller=new AbortController();let timer;
  try{return await Promise.race([Promise.resolve().then(()=>fn({...context,signal:controller.signal})),new Promise((_,reject)=>{
   timer=setTimeout(()=>{controller.abort();reject(new HistoryContractError(C.EVIDENCE_REQUIRED,'Undo provider deadline exceeded'));},timeoutMs);})]);}
  finally{clearTimeout(timer);controller.abort();}
 }
 async function inspect(authContext,row){
  const source=await repository.loadSource({authContext,originalOperationId:row.original_operation_id,resourceGid:row.resource_gid??undefined});
  const observations=await call(observeCurrent,{authContext,tenant:source.tenant,fields:source.fields});
  if(await call(verifyCurrentObservation,{authContext,tenant:source.tenant,fields:source.fields,observations})!==true)
   throw new HistoryContractError(C.EVIDENCE_REQUIRED,'Authenticated current undo observations required');
  const plan=detectUndoConflicts({fields:source.fields,observations,conflictPolicy:row.conflict_policy});
  if(plan.inverse.length&&await call(verifyInverseWritePolicy,{authContext,tenant:source.tenant,originalOperationId:row.original_operation_id,
   fields:source.fields,inverse:plan.inverse,operation:'undo'})!==true)
   throw new HistoryContractError(C.UNAUTHORIZED,'Current inverse field write policy denied');
  const values=observations.map(o=>({resourceGid:o.resourceGid,fieldId:o.fieldId,valueKind:o.valueKind,...(o.valueKind==='VALUE'?{value:o.value}:{})}))
   .sort((a,b)=>JSON.stringify([a.resourceGid,a.fieldId]).localeCompare(JSON.stringify([b.resourceGid,b.fieldId])));
  const fingerprint=historyFingerprint({source:source.fields.map(f=>[f.changeId,f.before.fingerprint,f.after.fingerprint]),values},'undo-preflight-v3');
  return{source,plan,fingerprint};
 }
 return Object.freeze({async reconcile({authContext,undoRequestId}){
  const recovered=await repository.recoverHandoff({authContext,undoRequestId});
  if(!recovered.executionJobId)return{undoRequestId,...recovered};
  const result=await repository.reconcileExecution({authContext,executionJobId:recovered.executionJobId});
  return{undoRequestId,executionJobId:recovered.executionJobId,...result};
 },async preflight(input){
  const row=await repository.request(input);if(!['REQUESTED','READY_FOR_REVIEW'].includes(row.undo_state))return{undoRequestId:row.id,state:row.undo_state};
  const {plan,fingerprint}=await inspect(input.authContext,row);
  const saved=await repository.recordPreflight({authContext:input.authContext,undoRequestId:row.id,fingerprint,inverseFingerprint:plan.fingerprint,conflict:!plan.inverse.length});
  return Object.freeze({undoRequestId:row.id,state:saved.undo_state,conflictedResources:plan.conflicts.length,eligibleFields:plan.inverse.length});
 },async submit({authContext,undoRequestId}){
  let row=await repository.get({authContext,undoRequestId});
  if(row.execution_job_id)return{undoRequestId,state:row.undo_state,executionJobId:String(row.execution_job_id)};
  if(row.undo_state==='READY_FOR_REVIEW'){
   const {source,plan,fingerprint}=await inspect(authContext,row);
   if(fingerprint!==row.preflight_fingerprint||plan.fingerprint!==row.inverse_plan_fingerprint||!plan.inverse.length)
    throw new HistoryContractError(C.EVIDENCE_CONFLICT,'Undo preflight changed; repeat review');
   const approved=await call(approveInverseExecution,{authContext,tenant:source.tenant,sourceCommandId:source.sourceCommandId,
    inverse:plan.inverse,handoffKey:row.handoff_key,preflightFingerprint:fingerprint,inversePlanFingerprint:plan.fingerprint,undoRequestId:row.id});
   row=await repository.approve({authContext,undoRequestId,contractId:approved.contractId});
  }
  row=await repository.markSubmitting({authContext,undoRequestId});
  if(row.reviewRequired)return Object.freeze({undoRequestId,state:'REVIEW_REQUIRED'});
  if(row.waiting)return Object.freeze({undoRequestId,state:'RETRY_WAIT'});
  try{
   const source=await repository.loadSource({authContext,originalOperationId:row.original_operation_id,resourceGid:row.resource_gid??undefined});
   const receipt=await call(dispatchService.dispatchUndo,{authContext,contractId:row.execution_contract_id,sourceCommandId:source.sourceCommandId,idempotencyKey:row.handoff_key});
   const saved=await repository.bindExecution({authContext,undoRequestId,executionJobId:receipt.commandId});
   return Object.freeze({undoRequestId,state:saved.undo_state,executionJobId:String(saved.execution_job_id)});
  }catch{const result=await repository.markUnknown({authContext,undoRequestId}).catch(()=>null);return Object.freeze({undoRequestId,state:result?.reviewRequired?'REVIEW_REQUIRED':'OUTCOME_UNKNOWN'});}
 }});
}
