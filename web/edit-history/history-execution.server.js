/** The existing worker's single mutation path. Never retries a remote send. */
import {isDeepStrictEqual} from 'node:util';
import {assertHistoryRepository,assertHistoryExecutionReady} from './history-repository.server.js';
import {HistoryContractError,HISTORY_ERROR_CODES as C} from './history-contract.js';
import {productUpdates} from '../services/operation-instructions.server.js';
import {assertUndoRepository} from './undo-repository.server.js';
const issued=new WeakSet(),names=Object.freeze({'product.title':'title','product.handle':'handle','product.descriptionHtml':'descriptionHtml',
 'product.vendor':'vendor','product.productType':'productType','product.status':'status','product.tags':'tags','product.templateSuffix':'templateSuffix'});
const fail=(code,message)=>{throw new HistoryContractError(code,message);};
export function assertHistoryExecution(execution){if(!issued.has(execution))throw TypeError('Issued durable history execution required');}
function remoteValues(remote,resourceId,fields){
 if(!remote||![Object.prototype,null].includes(Object.getPrototypeOf(remote))||Object.getOwnPropertyDescriptor(remote,'id')?.value!==resourceId)
  fail(C.EVIDENCE_CONFLICT,'Exact remote resource identity required');
 const values={};for(const name of fields){const p=Object.getOwnPropertyDescriptor(remote,name);
  if(!p||!Object.hasOwn(p,'value'))fail(C.EVIDENCE_REQUIRED,'Complete authoritative resource observation required');values[name]=p.value;}
 return productUpdates(values);
}
export function createHistoryExecution({historyRepository,loadExecutionRequest,persistEvidence,undoRepository,timeoutMs=10000}={}){
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
 const execution=Object.freeze({async finalize({claim,item,workerId}){
  const request=await bounded(signal=>loadExecutionRequest({claim,item,workerId,signal,phase:'finalize'}));
  return historyRepository.completeExecution({authContext:request.authContext,operationId:request.operationId,mutationId:request.mutationId,
   attemptId:request.entries[0].attempt.attemptId});
 },async execute({claim,item,workerId,shopifyClient,approved,captureBefore}){
  if(typeof captureBefore!=='function')throw TypeError('Fenced engine BEFORE persistence required');
  const request=await bounded(signal=>loadExecutionRequest({claim,item,workerId,signal}));
  if(!request?.entries?.length||request.entries.length>64)fail(C.EVIDENCE_REQUIRED,'Bounded durable execution request required');
  const first=request.entries[0],identity=first.intent.identity;
  if(identity.shopId!==claim.shop_id||identity.installationId!==claim.installation_version||identity.executionJobId!==String(claim.id)||
   identity.executionItemId!==String(item.id)||identity.resourceGid!==item.resource_id||request.claim.fenceEpoch!==String(claim.fence)||
   request.claim.leaseToken!==claim.lease_token)fail(C.OWNERSHIP_LOST,'Request must match current engine claim and item');
  const fields=request.entries.map(e=>names[e.intent.identity.fieldId]);
  if(fields.some(name=>!name)||new Set(fields).size!==fields.length||request.entries.some(e=>
   e.intent.identity.resourceGid!==item.resource_id||e.intent.identity.executionItemId!==String(item.id)||e.intent.intendedValueKind!=='VALUE'))
   fail(C.BINDING_CONFLICT,'Installed writer requires exact approved product fields');
  const intended=productUpdates(Object.fromEntries(request.entries.map((e,i)=>[fields[i],e.intent.intendedValue])));
  if(!isDeepStrictEqual(intended,approved))fail(C.BINDING_CONFLICT,'History intent differs from engine approved values');
  const base={authContext:request.authContext,operationId:request.operationId,mutationId:request.mutationId,attemptId:first.attempt.attemptId,claim:request.claim};
  const evidence=async(kind,details={})=>{
   const id=await bounded(signal=>persistEvidence({request,kind,...details,signal}));
   if(typeof id!=='string'||!id||id.length>512)fail(C.EVIDENCE_REQUIRED,'Durable evidence reference required');return id;
  };
  const unknown=async()=>{try{await historyRepository.recordMutationOutcome({...base,evidenceId:await evidence('AMBIGUOUS')});}catch{}
   try{await historyRepository.scheduleOutcomeRecovery(base);}catch{}
   return Object.freeze({state:'OUTCOME_UNKNOWN',operationId:request.operationId});};
  const prepared=await historyRepository.prepareRequest(request);
  if(prepared.state==='VERIFIED')return Object.freeze({state:'VERIFIED',operationId:request.operationId});
  if(prepared.state!=='PREPARED')return unknown();
  const before=productUpdates(Object.fromEntries(request.entries.map((e,i)=>{
   if(e.beforeSnapshot.valueKind!=='VALUE')fail(C.BINDING_CONFLICT,'Product writer requires explicit before values');return[fields[i],e.beforeSnapshot.value];})));
  if(claim.kind==='undo'){
   if(typeof undoRepository?.loadExecutionSource!=='function')fail(C.UNAUTHORIZED,'Durable approved undo source required');
   const source=await undoRepository.loadExecutionSource({authContext:request.authContext,executionJobId:String(claim.id),resourceGid:item.resource_id});
   if(!isDeepStrictEqual(source.inverseValues,intended)||!isDeepStrictEqual(source.expectedValues,before))fail(C.BINDING_CONFLICT,'Inverse intent differs from verified original history');
  }
  const observe=async()=>{const remote=await bounded(signal=>shopifyClient.readProduct({shopId:identity.shopId,resourceId:item.resource_id,signal}));
   return{remote,values:remoteValues(remote,item.resource_id,fields)};};
  const noWrite=async()=>{
   await historyRepository.recordMutationOutcome({...base,evidenceId:await evidence('AUTHORITATIVE_NO_WRITE',{reason:'PREFLIGHT_CONFLICT',contacted:false})});
   return Object.freeze({state:'CONFLICT',operationId:request.operationId});};
  try{
   if(!isDeepStrictEqual((await observe()).values,before))return await noWrite();
   await captureBefore(before);
  }catch(error){
   // This path has never consumed a dispatch token or invoked the transport.
   await historyRepository.recordMutationOutcome({...base,evidenceId:await evidence('AUTHORITATIVE_NO_WRITE',{reason:'PRE_SEND_ERROR',contacted:false})}).catch(()=>{});
   throw error;
  }
  const dispatch=await historyRepository.beginDispatch(request);
  // Recheck undo/current values after admission; never ignore a newer read.
  try{if(!isDeepStrictEqual((await observe()).values,before))return await noWrite();}catch{return unknown();}
  try{await historyRepository.consumeDispatch({...base,dispatchToken:dispatch.dispatchToken,dispatchHandoffKey:dispatch.dispatchHandoffKey});}
  catch{return unknown();} // Lost consume COMMIT must never trigger a send.
  try{
   // Exactly one invocation. No changed-value timeout heuristic or transport retry.
   const acknowledgement=await bounded(signal=>shopifyClient.applyMutation({shopId:identity.shopId,resourceId:item.resource_id,
    values:intended,idempotencyKey:dispatch.dispatchHandoffKey,signal}));
   remoteValues(acknowledgement,item.resource_id,fields);
   await historyRepository.recordMutationOutcome({...base,evidenceId:await evidence('SHOPIFY_ACKNOWLEDGEMENT',{acknowledgement})});
   const observation=await observe();if(!isDeepStrictEqual(observation.values,intended))return unknown();
   await historyRepository.recordVerification({...base,evidenceId:await evidence('VERIFIED_OBSERVATION',{observation:observation.remote})});
   return Object.freeze({state:'VERIFIED',operationId:request.operationId,beforeValues:before,afterValues:intended});
  }catch{return unknown();}
 }});issued.add(execution);return execution;
}
