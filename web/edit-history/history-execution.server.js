// Interface contract (repository root): docs/backend-interface-contracts.md#history-admission-handoff-and-execution
import {isStaleExecutionError} from '../workers/execution-errors.server.js';
import {assertResourceExecutionRequest} from '../fields/write-capabilities.js';
/** The existing worker's single mutation path. Never retries a remote send. */
import {isDeepStrictEqual} from 'node:util';
import {assertHistoryRepository,assertHistoryExecutionReady} from './history-repository.server.js';
import {HistoryContractError,HISTORY_ERROR_CODES as C} from './history-contract.js';
import {resourceUpdates} from '../services/operation-instructions.server.js';
import {assertUndoRepository} from './undo-repository.server.js';
const issued=new WeakSet();
const fail=(code,message)=>{throw new HistoryContractError(code,message);};
export function assertHistoryExecution(execution){if(!issued.has(execution))throw TypeError('Issued durable history execution required');}
function remoteValues(remote,resourceId,fields,writer,productId){
 if(!remote||![Object.prototype,null].includes(Object.getPrototypeOf(remote))||Object.getOwnPropertyDescriptor(remote,'id')?.value!==resourceId)
  fail(C.EVIDENCE_CONFLICT,'Exact remote resource identity required');
 if(writer.kind==='variant'&&remote.productId!==productId)fail(C.BINDING_CONFLICT,'Variant family differs from approved snapshot');
 const values={};for(const name of fields){const p=Object.getOwnPropertyDescriptor(remote,name);
  if(!p||!Object.hasOwn(p,'value'))fail(C.EVIDENCE_REQUIRED,'Complete authoritative resource observation required');values[name]=p.value;}
 return resourceUpdates(writer.kind,values);
}
export function createHistoryExecution({historyRepository,loadExecutionRequest,persistEvidence,resolveRecoveryAuth,undoRepository,timeoutMs=10000}={}){
 assertHistoryRepository(historyRepository);
 assertHistoryExecutionReady(historyRepository);
 if(undoRepository!==undefined)assertUndoRepository(undoRepository);
 if([loadExecutionRequest,persistEvidence].some(fn=>typeof fn!=='function')||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)
  throw TypeError('Trusted durable request/evidence providers and bounded transport required');
 async function bounded(callback){const controller=new AbortController();let timer;
  try{return await Promise.race([Promise.resolve().then(()=>callback(controller.signal)),new Promise((_,reject)=>{
   timer=setTimeout(()=>{controller.abort();reject(Error('Execution deadline'));},timeoutMs);})]);}
  finally{clearTimeout(timer);controller.abort();}
 }
 const execution=Object.freeze({async discoverRecovery({shopId,installationId,executionJobId,workerId,limit=25}){
  if(typeof resolveRecoveryAuth!=='function')throw Object.assign(Error('Independent tenant recovery authentication required'),{code:'HISTORY_RECOVERY_AUTH_REQUIRED'});
  const authContext=await bounded(signal=>resolveRecoveryAuth({shopId,installationId,executionJobId,workerId,operation:'discover_outcome_recovery',signal}));
  return bounded(()=>historyRepository.discoverOutcomeRecovery({authContext,limit,executionJobId,expectedTenant:{shopId,installationId}}));
 },async finalize({claim,item,workerId}){
  return execution.finalizeExecutionOperation({claim,item,workerId});
 },async finalizeMutationAttempt({claim,item,workerId}){
  const request=await bounded(signal=>loadExecutionRequest({claim,item,workerId,signal,phase:'finalize_mutation'}));
  return historyRepository.finalizeMutationAttempt({authContext:request.authContext,operationId:request.operationId,mutationId:request.mutationId,
   attemptId:request.entries[0].attempt.attemptId});
 },async finalizeExecutionOperation({claim,item,workerId}){
  if(typeof resolveRecoveryAuth!=='function')throw Object.assign(Error('Independent command finalization authentication required'),{code:'HISTORY_RECOVERY_AUTH_REQUIRED'});
  const authContext=await bounded(signal=>resolveRecoveryAuth({shopId:claim.shop_id,installationId:claim.installation_version,executionJobId:String(claim.id),workerId,operation:'finalize_execution_job',signal}));
  return historyRepository.finalizeExecutionJob({authContext,executionJobId:String(claim.id),expectedTenant:{shopId:claim.shop_id,installationId:claim.installation_version}});
 },async inspectItem({claim,item}){
  const request=await bounded(signal=>loadExecutionRequest({claim,item,signal,phase:'inspect'}));
  return historyRepository.inspectItem({claim,item,authContext:request.authContext,operationId:request.operationId,mutationId:request.mutationId});
 },async verifyItemCompletion({tx,claim,item,approved,result}){
  const request=await bounded(signal=>loadExecutionRequest({client:tx,claim,item,signal,phase:'verify_completion'}));
  return historyRepository.verifyItemCompletion({tx,claim,item,approved,result,authContext:request.authContext,operationId:request.operationId,mutationId:request.mutationId});
 },async execute({claim,item,workerId,shopifyClient,approved,dispatchGuard,captureBefore}){
  if(typeof dispatchGuard!=='function')throw TypeError('Transaction-scoped dispatch guard required');
  if(captureBefore!==undefined&&typeof captureBefore!=='function')throw TypeError('Fenced engine BEFORE persistence required');
  const request=await bounded(signal=>loadExecutionRequest({claim,item,workerId,signal}));
  if(!request?.entries?.length||request.entries.length>64)fail(C.EVIDENCE_REQUIRED,'Bounded durable execution request required');
  const first=request.entries[0],identity=first.intent.identity;
  if(identity.shopId!==claim.shop_id||identity.installationId!==claim.installation_version||identity.executionJobId!==String(claim.id)||
   identity.executionItemId!==String(item.id)||identity.resourceGid!==item.resource_id||request.claim.fenceEpoch!==String(claim.fence)||
   request.claim.leaseToken!==claim.lease_token)fail(C.OWNERSHIP_LOST,'Request must match current engine claim and item');
  const writer=assertResourceExecutionRequest(request.entries,{resourceId:item.resource_id,itemId:item.id});
  const names=writer.names;
  if(typeof shopifyClient[writer.readMethod]!=='function'||typeof shopifyClient[writer.writeMethod]!=='function')fail(C.BINDING_CONFLICT,'Matching resource transport required');
  const fields=request.entries.map(e=>names[e.intent.identity.fieldId]);
  if(fields.some(name=>!name)||new Set(fields).size!==fields.length||request.entries.some(e=>
   e.resourceFamilyGid!==first.resourceFamilyGid||e.intent.identity.resourceGid!==item.resource_id||e.intent.identity.executionItemId!==String(item.id)||e.intent.intendedValueKind!=='VALUE'))
   fail(C.BINDING_CONFLICT,'Installed writer requires exact approved product fields');
  const intended=resourceUpdates(writer.kind,Object.fromEntries(request.entries.map((e,i)=>[fields[i],e.intent.intendedValue])));
  if(!isDeepStrictEqual(intended,approved))fail(C.BINDING_CONFLICT,'History intent differs from engine approved values');
  const base={authContext:request.authContext,operationId:request.operationId,mutationId:request.mutationId,attemptId:first.attempt.attemptId,claim:request.claim};
  const evidence=async(kind,details={})=>{
   const id=await bounded(signal=>persistEvidence({request,kind,...details,signal}));
   if(typeof id!=='string'||!id||id.length>512)fail(C.EVIDENCE_REQUIRED,'Durable evidence reference required');return id;
  };
  const unknown=async(error)=>{if(isStaleExecutionError(error))throw error;const failures=[];let ambiguousRecorded=false,recoveryScheduled=false;
   try{await historyRepository.recordMutationOutcome({...base,evidenceId:await evidence('AMBIGUOUS')});ambiguousRecorded=true;}catch(error){if(isStaleExecutionError(error))throw error;failures.push(error);}
   try{await historyRepository.scheduleOutcomeRecovery(base);recoveryScheduled=true;}catch(error){if(isStaleExecutionError(error))throw error;failures.push(error);}
   if(failures.length)throw Object.assign(new AggregateError(failures,'Outcome recovery persistence incomplete',{cause:error}),{code:'HISTORY_RECOVERY_PERSISTENCE_FAILED',operationId:request.operationId,ambiguousRecorded,recoveryScheduled});
   return Object.freeze({state:'OUTCOME_UNKNOWN',operationId:request.operationId});};
  const prepared=await historyRepository.prepareRequest(request);
  if(prepared.state==='FAILED_NO_WRITE')return Object.freeze({state:'CONFLICT',operationId:request.operationId});
  if(prepared.state==='VERIFIED')return Object.freeze({state:'VERIFIED',operationId:request.operationId});
  if(prepared.state!=='PREPARED')return unknown();
  const before=resourceUpdates(writer.kind,Object.fromEntries(request.entries.map((e,i)=>{
   if(e.beforeSnapshot.valueKind!=='VALUE')fail(C.BINDING_CONFLICT,'Product writer requires explicit before values');return[fields[i],e.beforeSnapshot.value];})));
  const observe=async()=>{const remote=await bounded(signal=>shopifyClient[writer.readMethod]({shopId:identity.shopId,resourceId:item.resource_id,productId:first.resourceFamilyGid,signal}));
   return{remote,values:remoteValues(remote,item.resource_id,fields,writer,first.resourceFamilyGid)};};
  const noWrite=async(dispatch,reason='PREFLIGHT_CONFLICT')=>{
   await historyRepository.recordVerifiedNoWrite({...base,...(dispatch?{dispatchToken:dispatch.dispatchToken,dispatchHandoffKey:dispatch.dispatchHandoffKey}:{}),evidenceId:await evidence('AUTHORITATIVE_NO_WRITE',{reason,contacted:false})});
   return Object.freeze({state:'CONFLICT',operationId:request.operationId});};
  const mutationMethod=claim.kind==='undo'?writer.undo.writeMethod:writer.writeMethod;
  if(claim.kind==='undo'&&(writer.undo.supported!==true||writer.undo.atomicConditionalWrite!==true||
    typeof mutationMethod!=='string'||typeof shopifyClient[mutationMethod]!=='function')){
   const outcome=await noWrite(undefined,'UNDO_ATOMICITY_UNAVAILABLE');
   return Object.freeze({...outcome,reason:'UNDO_ATOMICITY_UNAVAILABLE'});
  }
  if(claim.kind==='undo'){
   if(typeof undoRepository?.loadExecutionSource!=='function')fail(C.UNAUTHORIZED,'Durable approved undo source required');
   const source=await undoRepository.loadExecutionSource({authContext:request.authContext,executionJobId:String(claim.id),resourceGid:item.resource_id});
   if(!isDeepStrictEqual(source.inverseValues,intended)||!isDeepStrictEqual(source.expectedValues,before))fail(C.BINDING_CONFLICT,'Inverse intent differs from verified original history');
  }
  try{
   if(!isDeepStrictEqual((await observe()).values,before))return await noWrite();
   if(captureBefore)await captureBefore(before);
  }catch(error){
   if(isStaleExecutionError(error))throw error;
   // This path has never consumed a dispatch token or invoked the transport.
   await noWrite(undefined,'PRE_SEND_ERROR');
   throw error;
  }
  const dispatch=await historyRepository.beginDispatch(request,{dispatchGuard});
  // Recheck undo/current values after admission; never ignore a newer read.
  try{if(!isDeepStrictEqual((await observe()).values,before))return await noWrite(dispatch);}catch(error){
   if(isStaleExecutionError(error))throw error;
   try{await noWrite(dispatch,'PRE_SEND_ERROR');}catch(error){return unknown(error);}
   throw error;
  }
  try{await historyRepository.consumeDispatch({...base,dispatchToken:dispatch.dispatchToken,dispatchHandoffKey:dispatch.dispatchHandoffKey});}
  catch(error){return unknown(error);} // Lost consume COMMIT must never trigger a send.
  try{
   // Exactly one invocation. No changed-value timeout heuristic or transport retry.
   const acknowledgement=await bounded(signal=>shopifyClient[mutationMethod]({shopId:identity.shopId,resourceId:item.resource_id,productId:first.resourceFamilyGid,
    values:intended,...(claim.kind==='undo'?{expectedValues:before}:{}),idempotencyKey:dispatch.dispatchHandoffKey,signal}));
   remoteValues(acknowledgement,item.resource_id,fields,writer,first.resourceFamilyGid);
   await historyRepository.recordMutationOutcome({...base,evidenceId:await evidence('SHOPIFY_ACKNOWLEDGEMENT',{acknowledgement})});
   const observation=await observe();if(!isDeepStrictEqual(observation.values,intended))return unknown();
   await historyRepository.recordVerification({...base,evidenceId:await evidence('VERIFIED_OBSERVATION',{observation:observation.remote})});
   return Object.freeze({state:'VERIFIED',operationId:request.operationId,beforeValues:before,afterValues:intended});
  }catch(error){return unknown(error);}
 }});issued.add(execution);return execution;
}
