// Interface contract (repository root): docs/backend-interface-contracts.md#mutation-and-command-finalization
/** Fenced journal outcomes and evidence-only recovery. Never sends Shopify writes. */
import { randomUUID,createHash } from 'node:crypto';
import { canonicalHistoryJson,normalizeHistorySnapshot,assertMutationTransition,historyFingerprint,requireHistoryId,HISTORY_LIMITS,
 HistoryContractError,HISTORY_ERROR_CODES as C } from './history-contract.js';
import { createHistoryHookInvoker } from './transaction-hooks.server.js';
import {assertAfterBinding} from './after-binding.server.js';
import { historyMemberKey,changeMemberKey,requestMembers } from './request-members.server.js';
const fail=(code,message)=>{throw new HistoryContractError(code,message);};
const hash=value=>typeof value==='string'&&/^sha256:[0-9a-f]{64}$/.test(value);
const equal=(a,b)=>JSON.stringify(canonicalHistoryJson(a))===JSON.stringify(canonicalHistoryJson(b));
const terminal=new Set(['VERIFIED','FAILED_NO_WRITE','CONFLICT']);
const states={AMBIGUOUS:['OUTCOME_UNKNOWN','PENDING'],SHOPIFY_ACKNOWLEDGEMENT:['ACKNOWLEDGED','PENDING'],AUTHORITATIVE_NO_WRITE:['FAILED_NO_WRITE','NOT_CHECKED'],VERIFIED_OBSERVATION:['VERIFIED','MATCHED'],CONFLICT_OBSERVATION:['CONFLICT','MISMATCHED']};
function data(input,keys){if(!input||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail(C.INVALID_INPUT,'Plain lifecycle input required');for(const key of Reflect.ownKeys(input)){const d=Object.getOwnPropertyDescriptor(input,key);if(!keys.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))fail(C.INVALID_INPUT,'Unsupported lifecycle input');}return input;}
const reference=(value)=>{if(typeof value!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))fail(C.INVALID_INPUT,'History UUID required');return value;};
const positive=(value,max=1000)=>{if(!Number.isSafeInteger(value)||value<1||value>max)fail(C.INVALID_INPUT,'Bounded positive integer required');return value;};
function snapshot(raw){
 if(!raw)fail(C.EVIDENCE_REQUIRED,'Authoritative after observation required');
 const o=raw.observation;
 const value=normalizeHistorySnapshot({identity:raw.identity,binding:raw.binding,kind:raw.kind,valueKind:raw.valueKind,...(Object.hasOwn(raw,'value')?{value:raw.value}:{}),
  observation:Object.fromEntries(['observationId','source','observedAt','resourceGid','fieldId','sourceRevision','receiptId','receiptFingerprint'].filter(k=>Object.hasOwn(o,k)).map(k=>[k,o[k]]))});
 if(value.kind!=='OBSERVED_AFTER'||value.fingerprint!==raw.fingerprint||value.evidenceBindingFingerprint!==raw.evidenceBindingFingerprint)fail(C.EVIDENCE_CONFLICT,'Invalid after snapshot or receipt binding');return value;
}
export function createHistoryLifecycle({database,executionAdapter,resolveTenant,authorizeRecovery,authorizeDispatch,loadMutationEvidence,verifyMutationEvidence,valueProtection}){
 async function scope(raw,action,extras,callback){
  data(raw,['authContext','operationId','mutationId','attemptId','claim','recoveryClaim',...extras]);
  if(!raw.authContext)fail(C.UNAUTHORIZED,'Authenticated lifecycle context required');
  const operationId=reference(raw.operationId),mutationId=requireHistoryId(raw.mutationId),attemptId=requireHistoryId(raw.attemptId),authContext=raw.authContext;
  const options=canonicalHistoryJson(Object.fromEntries(Object.entries(raw).filter(([key])=>key!=='authContext')));
  for(let retry=0;;retry++){
   const tx=await database.connect(),invoke=createHistoryHookInvoker(tx);
   try{
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await tx.query("SET LOCAL lock_timeout='2000ms'");await tx.query("SET LOCAL statement_timeout='15000ms'");
    await tx.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");await executionAdapter.beginScope({client:tx,write:true});
    const tenant=canonicalHistoryJson(await invoke(resolveTenant,{authContext}));await executionAdapter.assertTenant({client:tx,tenant});
    const op=(await tx.query(`SELECT * FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3`,[tenant.shopId,tenant.installationId,operationId])).rows[0];
    if(!op)fail(C.UNAUTHORIZED,'Owned history operation required');
    if(op.purge_requested_at!=null)fail(C.UNAUTHORIZED,'History is being removed');
    await executionAdapter.lockCommandForEvidence({client:tx,tenant,jobId:op.execution_job_id});
    await executionAdapter.assertEvidenceAuthority({client:tx,tenant,op});
    await tx.query(`SELECT id FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3 FOR UPDATE`,[tenant.shopId,tenant.installationId,operationId]);
    const params=[tenant.shopId,tenant.installationId,operationId,mutationId,attemptId];
    const request=(await tx.query(`SELECT * FROM edit_history.mutation_requests WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5 FOR UPDATE`,params)).rows[0];
    if(!request)fail(C.BINDING_CONFLICT,'Durable mutation request required');
    const changes=(await tx.query(`SELECT * FROM edit_history.changes WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5 ORDER BY field_id FOR UPDATE`,params)).rows;
    if(!equal(changes.map(changeMemberKey).sort(),requestMembers(request).map(historyMemberKey).sort()))fail(C.BINDING_CONFLICT,'Mutation request field set is incomplete');
    const context={tx,invoke,tenant,authContext,operationId,mutationId,attemptId,op,request,changes,params,options,policies:new Set()};
    const result=await callback(context);
    if(!equal(await invoke(resolveTenant,{authContext}),tenant))fail(C.UNAUTHORIZED,'Installation changed during lifecycle update');
    for(const policy of context.policies)if(await invoke(authorizeRecovery,{authContext,tenant,operation:policy,request})!==true)fail(C.UNAUTHORIZED,'Recovery authorization changed during transaction');
    if(context.recheck)await context.recheck();
    await tx.query('SET CONSTRAINTS ALL IMMEDIATE');await tx.query('COMMIT');return result;
   }catch(error){await tx.query('ROLLBACK').catch(()=>{});if(['40001','40P01','23505','P2002','P2034'].includes(error.code)&&retry<2)continue;throw error;}finally{tx.release();}
  }
 }
  async function operationScope(raw,action,callback){
   data(raw,['authContext','operationId','claim','recoveryClaim','mutationId','attemptId']);
   if(!raw.authContext)fail(C.UNAUTHORIZED,'Authenticated lifecycle context required');
   const operationId=reference(raw.operationId),authContext=raw.authContext;
   for(let retry=0;;retry++){
    const tx=await database.connect(),invoke=createHistoryHookInvoker(tx);
    try{
     await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await tx.query("SET LOCAL lock_timeout='2000ms'");await tx.query("SET LOCAL statement_timeout='15000ms'");
     await tx.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");await executionAdapter.beginScope({client:tx,write:true});
     const tenant=canonicalHistoryJson(await invoke(resolveTenant,{authContext}));await executionAdapter.assertTenant({client:tx,tenant});
     const op=(await tx.query(`SELECT * FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3 FOR UPDATE`,[tenant.shopId,tenant.installationId,operationId])).rows[0];
     if(!op)fail(C.UNAUTHORIZED,'Owned history operation required');
     if(op.purge_requested_at!=null)fail(C.UNAUTHORIZED,'History is being removed');
     await executionAdapter.lockCommandForEvidence({client:tx,tenant,jobId:op.execution_job_id});
    await executionAdapter.assertEvidenceAuthority({client:tx,tenant,op});
     if(await invoke(authorizeRecovery,{authContext,tenant,operation:action,op})!==true)fail(C.UNAUTHORIZED,'Operation finalization authorization required');
     const context={tx,invoke,tenant,authContext,operationId,op};
     const result=await callback(context);
     if(!equal(await invoke(resolveTenant,{authContext}),tenant))fail(C.UNAUTHORIZED,'Installation changed during lifecycle update');
     await tx.query('SET CONSTRAINTS ALL IMMEDIATE');await tx.query('COMMIT');return result;
    }catch(error){await tx.query('ROLLBACK').catch(()=>{});if(['40001','40P01','23505','P2002','P2034'].includes(error.code)&&retry<2)continue;throw error;}finally{tx.release();}
   }
  }
 async function recoveryPermission(c,action){c.policies.add(action);if(await c.invoke(authorizeRecovery,{authContext:c.authContext,tenant:c.tenant,operation:action,request:c.request})!==true)fail(C.UNAUTHORIZED,'Independent outcome recovery authorization required');}
 async function normalOwner(c){
  const claim=data(c.options.claim,['fenceEpoch','executionClaimId','leaseToken']);
  if(typeof claim.leaseToken!=='string'||!claim.leaseToken||claim.leaseToken.length>512)fail(C.INVALID_INPUT,'Private execution lease token required');
  if(claim.fenceEpoch!==c.request.execution_fence_epoch||claim.executionClaimId!==c.request.execution_claim_id)fail(C.OWNERSHIP_LOST,'Worker cannot acknowledge another observed attempt');
  await executionAdapter.assertExecutionClaim({client:c.tx,tenant:c.tenant,jobId:c.op.execution_job_id,claim});
 }
 async function tasks(c){return(await c.tx.query(`SELECT t.* FROM edit_history.recovery_tasks t JOIN edit_history.changes x
  ON x.shop_id=t.shop_id AND x.installation_id=t.installation_id AND x.operation_id=t.operation_id AND x.id=t.change_id
  WHERE t.shop_id=$1 AND t.installation_id=$2 AND t.operation_id=$3 AND x.mutation_id=$4 AND x.attempt_id=$5 AND t.task_kind='MUTATION_OUTCOME' ORDER BY t.change_id FOR UPDATE OF t`,c.params)).rows;}
 async function assertRecovery(c,action='record_recovery_evidence'){
  const claim=data(c.options.recoveryClaim,['claimToken','fenceEpoch','workerId']);await recoveryPermission(c,action);
  const rows=await tasks(c);
  if(rows.length!==c.changes.length)fail(C.OWNERSHIP_LOST,'Complete recovery claim required');
  const due=(await c.tx.query(`SELECT clock_timestamp() AS now`)).rows[0].now;
  for(const row of rows)if(row.task_state!=='RECONCILING'||row.claim_token!==claim.claimToken||row.fence_epoch!==claim.fenceEpoch||row.claimed_by!==claim.workerId||row.claim_expires_at<=due)fail(C.OWNERSHIP_LOST,'Recovery lease expired or superseded');
  return rows;
 }
 async function schedule(c){
  if(c.changes.some(change=>change.mutation_state==='PREPARED'))fail(C.INVALID_TRANSITION,'Clean prepared requests are not outcome-recovery work');
  for(const change of c.changes){
   const key=historyFingerprint({operationId:c.operationId,mutationId:c.mutationId,attemptId:c.attemptId,changeId:change.id},'outcome-recovery-v3');
   await c.tx.query(`INSERT INTO edit_history.recovery_tasks(id,shop_id,installation_id,operation_id,change_id,task_kind,dedupe_key)
    VALUES($1,$2,$3,$4,$5,'MUTATION_OUTCOME',$6) ON CONFLICT(shop_id,installation_id,task_kind,dedupe_key) DO NOTHING`,[randomUUID(),...c.params.slice(0,3),change.id,key]);
  }
 }
 async function updateCounters(c){await c.tx.query(`UPDATE edit_history.operations o SET
  changes_recorded=s.total,changes_verified=s.verified,changes_failed=s.failed,changes_uncertain=s.uncertain,updated_at=clock_timestamp()
  FROM(SELECT count(*) AS total,count(*) FILTER(WHERE mutation_state='VERIFIED') AS verified,
   count(*) FILTER(WHERE mutation_state IN ('FAILED_NO_WRITE','CONFLICT')) AS failed,
   count(*) FILTER(WHERE mutation_state IN ('DISPATCHING','OUTCOME_UNKNOWN','ACKNOWLEDGED')) AS uncertain
   FROM edit_history.changes WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3)s
  WHERE o.shop_id=$1 AND o.installation_id=$2 AND o.id=$3`,c.params.slice(0,3));}
 async function persistAfter(c,change,value){
  if(!equal(value.identity,{shopId:c.tenant.shopId,installationId:c.tenant.installationId,executionJobId:c.op.execution_job_id,executionItemId:change.execution_item_id,mutationId:c.mutationId,resourceGid:change.resource_gid,fieldId:change.field_id}))fail(C.BINDING_CONFLICT,'After snapshot identity differs from the complete mutation request');
  const before=(await c.tx.query(`SELECT field_resolution_fingerprint,binding_mode,generation_id,coverage_revision,mapping_version,execution_snapshot_id
   FROM edit_history.snapshots WHERE shop_id=$1 AND installation_id=$2 AND change_id=$3 AND snapshot_kind='BEFORE'`,[c.tenant.shopId,c.tenant.installationId,change.id])).rows[0];
  assertAfterBinding(value.binding,before,c.op,change);
  const existing=(await c.tx.query(`SELECT id,snapshot_fingerprint,evidence_binding_fingerprint FROM edit_history.snapshots
   WHERE shop_id=$1 AND installation_id=$2 AND change_id=$3 AND snapshot_kind='OBSERVED_AFTER' AND observation_id=$4`,[c.tenant.shopId,c.tenant.installationId,change.id,value.observation.observationId])).rows[0];
  if(existing){if(existing.snapshot_fingerprint!==value.fingerprint||existing.evidence_binding_fingerprint!==value.evidenceBindingFingerprint)fail(C.EVIDENCE_CONFLICT,'Observation identity was reused with different evidence');return existing.id;}
  const id=randomUUID(),b=value.binding,o=value.observation;
  const sealed=await valueProtection.seal({id,shop_id:c.tenant.shopId,installation_id:c.tenant.installationId,operation_id:c.operationId,
    change_id:change.id,snapshot_kind:'OBSERVED_AFTER',value_kind:value.valueKind,resource_gid:value.identity.resourceGid,field_id:value.identity.fieldId,
    snapshot_fingerprint:value.fingerprint,evidence_binding_fingerprint:value.evidenceBindingFingerprint},value.value,{client:c.tx,tenant:c.tenant,authContext:c.authContext});
  await c.tx.query(`INSERT INTO edit_history.snapshots(id,shop_id,installation_id,operation_id,change_id,snapshot_kind,value_kind,value_json,
   snapshot_fingerprint,evidence_binding_fingerprint,observation_id,observation_source,observed_at,source_revision,observation_receipt_id,observation_receipt_fingerprint,
   resource_gid,field_id,field_definition_revision,filter_fingerprint,execution_fingerprint,field_resolution_fingerprint,binding_mode,generation_id,coverage_revision,mapping_version,execution_snapshot_id,value_encoding,encrypted_value,encryption_key_reference)
   VALUES($1,$2,$3,$4,$5,'OBSERVED_AFTER',$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
   [id,...c.params.slice(0,3),change.id,value.valueKind,sealed.value_json===null?null:JSON.stringify(sealed.value_json),value.fingerprint,value.evidenceBindingFingerprint,o.observationId,o.source,o.observedAt,o.sourceRevision,o.receiptId,o.receiptFingerprint,
    value.identity.resourceGid,value.identity.fieldId,b.fieldDefinitionRevision,b.filterFingerprint,b.executionFingerprint,b.fieldResolutionFingerprint,b.mode,b.generationId,b.coverageRevision,b.mappingVersion,b.executionSnapshotId,
    sealed.value_encoding,sealed.encrypted_value,sealed.encryption_key_reference]);return id;
 }
 async function outcome(c,verification){
  if(c.options.recoveryClaim){await assertRecovery(c);c.recheck=()=>assertRecovery(c);}else{await normalOwner(c);c.recheck=()=>normalOwner(c);}
  const evidenceId=requireHistoryId(c.options.evidenceId);
  const evidence=canonicalHistoryJson(await c.invoke(loadMutationEvidence,{authContext:c.authContext,tenant:c.tenant,operationId:c.operationId,mutationId:c.mutationId,attemptId:c.attemptId,evidenceId}),{maxBytes:HISTORY_LIMITS.MAX_RECORD_BYTES});
  if(!evidence||!hash(evidence.fingerprint)||!states[evidence.kind]||!equal([evidence.operationId,evidence.mutationId,evidence.attemptId,evidence.executionJobId,evidence.executionItemId,evidence.executionFenceEpoch,evidence.executionClaimId],
   [c.operationId,c.mutationId,c.attemptId,c.op.execution_job_id,c.request.execution_item_id,c.request.execution_fence_epoch,c.request.execution_claim_id]))fail(C.EVIDENCE_REQUIRED,'Complete attempt-bound durable evidence required');
  if(verification!==['VERIFIED_OBSERVATION','CONFLICT_OBSERVATION'].includes(evidence.kind))fail(C.INVALID_INPUT,'Evidence classification does not match the recording operation');
  const multiResource=new Set(c.changes.map(change=>change.resource_gid)).size>1;
  const defaultResourceGid=multiResource?undefined:(c.request.resource_gid??c.changes[0]?.resource_gid);
  const evidenceKey=field=>historyMemberKey({resourceGid:field.resourceGid??defaultResourceGid,fieldId:field.fieldId});
  if(!Array.isArray(evidence.fields)||!equal(evidence.fields.map(evidenceKey).sort(),requestMembers(c.request).map(historyMemberKey).sort()))fail(C.EVIDENCE_CONFLICT,'Evidence must cover the entire mutation request');
  if(await c.invoke(verifyMutationEvidence,{authContext:c.authContext,tenant:c.tenant,request:c.request,evidence,operation:verification?'verification':'outcome'})!==true)fail(C.EVIDENCE_REQUIRED,'Mutation evidence is not authenticated');
  if(c.verifiedNoWrite&&evidence.kind!=='AUTHORITATIVE_NO_WRITE')fail(C.EVIDENCE_REQUIRED,'Verified no-write evidence required');
  if(evidence.kind==='AUTHORITATIVE_NO_WRITE'&&!c.verifiedNoWrite&&!c.options.recoveryClaim)fail(C.INVALID_TRANSITION,'Verified pre-send no-write transition required');
  const [target,checked]=states[evidence.kind],observations=[];
  for(const change of c.changes){
   const field=evidence.fields.find(f=>evidenceKey(f)===changeMemberKey(change));
   if(verification){
    const value=snapshot(field.afterSnapshot),valueHash=historyFingerprint({valueKind:value.valueKind,...(Object.hasOwn(value,'value')?{value:value.value}:{})},'intended-value-v3');
    if((target==='VERIFIED')!==(valueHash===change.intended_value_fingerprint))fail(C.EVIDENCE_CONFLICT,'Verification classification contradicts the observed field value');
    observations.push(await persistAfter(c,change,value));
   }
   if(change.mutation_state===target){if(change.last_evidence_kind!==evidence.kind||change.last_evidence_fingerprint!==evidence.fingerprint)fail(C.EVIDENCE_CONFLICT,'Existing outcome has different immutable evidence');continue;}
   assertMutationTransition(change.mutation_state,target,{evidenceKind:evidence.kind});
   await c.tx.query(`UPDATE edit_history.changes SET mutation_state=$4,verification_state=$5,last_evidence_kind=$6,last_evidence_fingerprint=$7,
    acknowledged_at=CASE WHEN $4='ACKNOWLEDGED' THEN clock_timestamp() ELSE acknowledged_at END,
    verified_at=CASE WHEN $4='VERIFIED' THEN clock_timestamp() ELSE verified_at END,updated_at=clock_timestamp()
    WHERE shop_id=$1 AND installation_id=$2 AND id=$3`,[c.tenant.shopId,c.tenant.installationId,change.id,target,checked,evidence.kind,evidence.fingerprint]);
  }
  if(c.request.request_state!==target)await c.tx.query(`UPDATE edit_history.mutation_requests SET request_state=$4,outcome_evidence_kind=$5,outcome_evidence_fingerprint=$6,
   acknowledged_at=CASE WHEN $4='ACKNOWLEDGED' THEN COALESCE(acknowledged_at,clock_timestamp()) ELSE acknowledged_at END,
   verified_at=CASE WHEN $4='VERIFIED' THEN COALESCE(verified_at,clock_timestamp()) ELSE verified_at END,updated_at=clock_timestamp()
   WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$7 AND attempt_id=$8`,
   [c.tenant.shopId,c.tenant.installationId,c.operationId,target,evidence.kind,evidence.fingerprint,c.mutationId,c.attemptId]);
  if(!terminal.has(target))await schedule(c);
  else {
   const completed=await c.tx.query(`UPDATE edit_history.recovery_tasks t SET task_state='COMPLETED',claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,
   evidence_fingerprint=$4,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE t.shop_id=$1 AND t.installation_id=$2 AND t.operation_id=$3
   AND t.change_id=ANY($5::uuid[]) AND t.task_kind='MUTATION_OUTCOME' AND t.task_state NOT IN ('COMPLETED','CANCELLED','REVIEW_REQUIRED')
   AND ($6::uuid IS NULL OR (t.task_state='RECONCILING' AND t.claim_token=$6 AND t.fence_epoch=$7 AND t.claimed_by=$8 AND t.claim_expires_at>clock_timestamp()))`,
   [...c.params.slice(0,3),evidence.fingerprint,c.changes.map(row=>row.id),c.options.recoveryClaim?.claimToken??null,c.options.recoveryClaim?.fenceEpoch??null,c.options.recoveryClaim?.workerId??null]);
   if(c.options.recoveryClaim&&completed.rowCount!==c.changes.length)fail(C.OWNERSHIP_LOST,'Recovery claim expired before atomic completion');
  }
  await updateCounters(c);
  // Tasks are completed by this transaction; the final recovery check must
  // happen before clearing the claim, not attempt to re-open completed leases.
  if(c.options.recoveryClaim&&terminal.has(target))c.recheck=async()=>{await recoveryPermission(c,'record_recovery_evidence');};
  return Object.freeze({operationId:c.operationId,mutationId:c.mutationId,attemptId:c.attemptId,state:target,observationIds:Object.freeze(observations)});
 }
 const api={
  completeExecution:raw=>api.finalizeExecutionOperation(raw),
  finalizeMutationAttempt:raw=>scope(raw,'finalize_mutation_attempt',[],async c=>{
   await recoveryPermission(c,'finalize_mutation_attempt');
   const req=(await c.tx.query(`SELECT request_state FROM edit_history.mutation_requests WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5`,c.params)).rows[0];
   if(!req||!terminal.has(req.request_state))return Object.freeze({completed:false,mutationId:c.mutationId,attemptId:c.attemptId});
   const unresolved=(await c.tx.query(`SELECT count(*)::int AS unresolved FROM edit_history.changes WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5 AND mutation_state NOT IN('VERIFIED','FAILED_NO_WRITE','CONFLICT')`,c.params)).rows[0]?.unresolved??0;
   if(unresolved>0)return Object.freeze({completed:false,mutationId:c.mutationId,attemptId:c.attemptId});
   return Object.freeze({completed:true,mutationId:c.mutationId,attemptId:c.attemptId,state:req.request_state});
  }),
  finalizeExecutionOperation:raw=>(raw.mutationId&&raw.attemptId?scope(raw,'complete_execution',[],async c=>{
   await recoveryPermission(c,'complete_execution');
   const engine=(await c.tx.query(`SELECT status FROM mirror.job_commands WHERE shop_id=$1 AND installation_version=$2 AND id=$3`,[c.tenant.shopId,c.tenant.installationId,c.op.execution_job_id])).rows[0];
   if(!engine||!['SUCCEEDED','PARTIAL','FAILED','CANCELLED'].includes(engine.status))return Object.freeze({completed:false});
   if((await c.tx.query(`SELECT 1 FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 AND status IN('PENDING','RETRY','RUNNING') LIMIT 1`,[c.tenant.shopId,c.op.execution_job_id])).rows.length)return Object.freeze({completed:false});
   const counts=(await c.tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE mutation_state='VERIFIED')::int AS verified, count(*) FILTER(WHERE mutation_state NOT IN('VERIFIED','FAILED_NO_WRITE','CONFLICT'))::int AS unresolved FROM edit_history.changes WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3`,c.params.slice(0,3))).rows[0];
   if(!counts.total||counts.unresolved)return Object.freeze({completed:false});
   const state=engine.status==='CANCELLED'?'CANCELLED':engine.status==='SUCCEEDED'&&counts.verified===counts.total?'COMPLETED':counts.verified?'PARTIAL':'FAILED';
   if(!['COMPLETED','PARTIAL','FAILED','CANCELLED'].includes(c.op.operation_state))await c.tx.query(`UPDATE edit_history.operations SET operation_state=$4,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE shop_id=$1 AND installation_id=$2 AND id=$3`,[...c.params.slice(0,3),state]);
   return Object.freeze({completed:true,state,operationId:c.operationId});
  }):operationScope(raw,'complete_execution',async c=>{
   const engine=(await c.tx.query(`SELECT status FROM mirror.job_commands WHERE shop_id=$1 AND installation_version=$2 AND id=$3`,[c.tenant.shopId,c.tenant.installationId,c.op.execution_job_id])).rows[0];
   if(!engine||!['SUCCEEDED','PARTIAL','FAILED','CANCELLED'].includes(engine.status))return Object.freeze({completed:false});
   if((await c.tx.query(`SELECT 1 FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 AND status IN('PENDING','RETRY','RUNNING') LIMIT 1`,[c.tenant.shopId,c.op.execution_job_id])).rows.length)return Object.freeze({completed:false});
   const counts=(await c.tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE mutation_state='VERIFIED')::int AS verified, count(*) FILTER(WHERE mutation_state NOT IN('VERIFIED','FAILED_NO_WRITE','CONFLICT'))::int AS unresolved FROM edit_history.changes WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3`,[c.tenant.shopId,c.tenant.installationId,c.operationId])).rows[0];
   if(!counts.total||counts.unresolved)return Object.freeze({completed:false});
   const state=engine.status==='CANCELLED'?'CANCELLED':engine.status==='SUCCEEDED'&&counts.verified===counts.total?'COMPLETED':counts.verified?'PARTIAL':'FAILED';
   if(!['COMPLETED','PARTIAL','FAILED','CANCELLED'].includes(c.op.operation_state))await c.tx.query(`UPDATE edit_history.operations SET operation_state=$4,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE shop_id=$1 AND installation_id=$2 AND id=$3`,[c.tenant.shopId,c.tenant.installationId,c.operationId,state]);
   return Object.freeze({completed:true,state,operationId:c.operationId});
  })),
  async discoverOutcomeRecovery(raw){
   data(raw,['authContext','limit','expectedTenant','executionJobId']);if(!raw.authContext)fail(C.UNAUTHORIZED,'Authenticated recovery context required');const limit=positive(raw.limit??25,100);
   const executionJobId=raw.executionJobId===undefined?undefined:requireHistoryId(raw.executionJobId);
   const expectedTenant=raw.expectedTenant===undefined?null:canonicalHistoryJson(data(raw.expectedTenant,['shopId','installationId']));
   const tx=await database.connect(),invoke=createHistoryHookInvoker(tx);let rows;
   try{
    await tx.query('BEGIN');await tx.query("SET LOCAL statement_timeout='15000ms'");await executionAdapter.beginScope({client:tx,write:false});
    const tenant=canonicalHistoryJson(await invoke(resolveTenant,{authContext:raw.authContext}));await executionAdapter.assertTenant({client:tx,tenant});
    if(expectedTenant&&!equal(tenant,expectedTenant))fail(C.UNAUTHORIZED,'Recovery authentication differs from discovered tenant');
    if(await invoke(authorizeRecovery,{authContext:raw.authContext,tenant,operation:'discover_outcome_recovery'})!==true)fail(C.UNAUTHORIZED,'Recovery discovery is not authorized');
    rows=await executionAdapter.discoverInterruptedRequests({client:tx,tenant,limit,executionJobId});
    if(await invoke(authorizeRecovery,{authContext:raw.authContext,tenant,operation:'discover_outcome_recovery'})!==true||!equal(await invoke(resolveTenant,{authContext:raw.authContext}),tenant))fail(C.UNAUTHORIZED,'Recovery discovery authorization changed');
    await tx.query('COMMIT');
   }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}
   for(const row of rows)await api.scheduleOutcomeRecovery({authContext:raw.authContext,operationId:row.operation_id,mutationId:row.mutation_id,attemptId:row.attempt_id});
   return Object.freeze({scheduledRequests:rows.length});
  },
  recordVerifiedNoWrite:raw=>scope(raw,'verified_no_write',['evidenceId','dispatchToken','dispatchHandoffKey'],async c=>{
   await normalOwner(c);
   if(c.request.dispatch_consumed_at!=null)fail(C.INVALID_TRANSITION,'Consumed dispatch requires outcome recovery');
   if(c.request.request_state==='DISPATCH_AUTHORIZED'){
    const token=c.options.dispatchToken;
    if(typeof token!=='string'||!token||token.length>256||c.request.dispatch_token_hash!=='sha256:'+createHash('sha256').update(token).digest('hex')||
      c.options.dispatchHandoffKey!==c.request.dispatch_handoff_key||c.changes.some(change=>change.mutation_state!=='DISPATCHING'))
     fail(C.INVALID_TRANSITION,'Exact unconsumed dispatch handoff required for no-write proof');
   }else if(c.request.request_state!=='PREPARED'||c.changes.some(change=>change.mutation_state!=='PREPARED')){
    fail(C.INVALID_TRANSITION,'No-write transition requires a prepared or unconsumed authorized request');
   }
   c.verifiedNoWrite=true;
   return outcome(c,false);
  }),
  recordMutationOutcome:raw=>scope(raw,'outcome',['evidenceId'],c=>outcome(c,false)),
  recordVerification:raw=>scope(raw,'verification',['evidenceId'],c=>outcome(c,true)),
  scheduleOutcomeRecovery:raw=>scope(raw,'schedule',[],async c=>{await recoveryPermission(c,'schedule_outcome_recovery');if(c.changes.every(x=>terminal.has(x.mutation_state)))return Object.freeze({scheduled:false});await schedule(c);return Object.freeze({scheduled:true,count:c.changes.length});}),
  consumeDispatch:raw=>scope(raw,'consume',['dispatchToken','dispatchHandoffKey'],async c=>{
   await normalOwner(c);
   await executionAdapter.assertDispatchClaim({client:c.tx,tenant:c.tenant,jobId:c.op.execution_job_id,claim:c.options.claim});
   if(await c.invoke(authorizeDispatch,{authContext:c.authContext,tenant:c.tenant,operation:'consume_dispatch',request:c.request})!==true)fail(C.UNAUTHORIZED,'Independent executor dispatch permission required');
   const token=c.options.dispatchToken;
   if(typeof token!=='string'||!token||token.length>256)fail(C.INVALID_INPUT,'Private single-use dispatch token required');
   if(c.request.request_state!=='DISPATCH_AUTHORIZED'||c.changes.some(x=>x.mutation_state!=='DISPATCHING'))fail(C.INVALID_TRANSITION,'Request is not dispatching');
   if(c.options.dispatchHandoffKey&&c.options.dispatchHandoffKey!==c.request.dispatch_handoff_key)fail(C.BINDING_CONFLICT,'Dispatch handoff key mismatch');
   const consumed=await c.tx.query(`UPDATE edit_history.mutation_requests SET dispatch_consumed_at=clock_timestamp()
    WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5
    AND dispatch_token_hash=$6 AND dispatch_consumed_at IS NULL AND request_state='DISPATCH_AUTHORIZED'`,
    [...c.params,'sha256:'+createHash('sha256').update(token).digest('hex')]);
   if(consumed.rowCount!==1)fail(C.INVALID_TRANSITION,'Dispatch token invalid, consumed or uncertain; reconcile');
   c.recheck=async()=>{await normalOwner(c);await executionAdapter.assertDispatchClaim({client:c.tx,tenant:c.tenant,jobId:c.op.execution_job_id,claim:c.options.claim});};return Object.freeze({consumed:true});
  }),
  claimOutcomeRecovery:raw=>scope(raw,'claim_recovery',['workerId','leaseSeconds'],async c=>{
   await recoveryPermission(c,'claim_outcome_recovery');
   const workerId=requireHistoryId(c.options.workerId),seconds=positive(c.options.leaseSeconds??30,60);
   await executionAdapter.assertRecoveryWindow({client:c.tx,tenant:c.tenant,jobId:c.op.execution_job_id,claim:c.options.claim});
   if(c.changes.every(x=>terminal.has(x.mutation_state)))return null;
   await schedule(c);const rows=await tasks(c),now=(await c.tx.query('SELECT clock_timestamp() AS now')).rows[0].now;
   if(rows.length!==c.changes.length)fail(C.BINDING_CONFLICT,'Recovery request task set is incomplete');
   if(rows.some(row=>['COMPLETED','CANCELLED','REVIEW_REQUIRED'].includes(row.task_state)||row.available_at>now||(row.task_state==='RECONCILING'&&row.claim_expires_at>now)))return null;
   if(rows.some(row=>row.attempt_count>=row.max_attempts)){
    await c.tx.query(`UPDATE edit_history.recovery_tasks SET task_state='REVIEW_REQUIRED',claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,completed_at=clock_timestamp()
     WHERE shop_id=$1 AND installation_id=$2 AND id=ANY($3::uuid[])`,[c.tenant.shopId,c.tenant.installationId,rows.map(x=>x.id)]);return null;
   }
   const token=randomUUID(),epoch=(BigInt(rows.reduce((n,row)=>BigInt(row.fence_epoch)>n?BigInt(row.fence_epoch):n,0n))+1n).toString();
   await c.tx.query(`UPDATE edit_history.recovery_tasks SET task_state='RECONCILING',claimed_by=$4,claim_token=$5,fence_epoch=$6,
    claim_expires_at=clock_timestamp()+$7*interval '1 second',attempt_count=attempt_count+1,last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE shop_id=$1 AND installation_id=$2 AND id=ANY($3::uuid[])`,[c.tenant.shopId,c.tenant.installationId,rows.map(x=>x.id),workerId,token,epoch,seconds]);
   // DISPATCHING never implies whether the external request was sent.
   const uncertaintyDigest=historyFingerprint({request:c.request.request_fingerprint,reason:'DISPATCH_COMMIT_GAP'},'local-dispatch-uncertainty-v3');
   for(const change of c.changes.filter(x=>x.mutation_state==='DISPATCHING'))await c.tx.query(`UPDATE edit_history.changes SET mutation_state='OUTCOME_UNKNOWN',verification_state='PENDING',
    last_evidence_kind='AMBIGUOUS',last_evidence_fingerprint=$4,updated_at=clock_timestamp() WHERE shop_id=$1 AND installation_id=$2 AND id=$3`,
    [c.tenant.shopId,c.tenant.installationId,change.id,uncertaintyDigest]);
   if(c.request.request_state==='DISPATCH_AUTHORIZED'){
    await c.tx.query(`UPDATE edit_history.mutation_requests SET request_state='OUTCOME_UNKNOWN',outcome_evidence_kind='AMBIGUOUS',outcome_evidence_fingerprint=$4,updated_at=clock_timestamp()
     WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$5 AND attempt_id=$6 AND request_state='DISPATCH_AUTHORIZED'`,
     [c.tenant.shopId,c.tenant.installationId,c.operationId,uncertaintyDigest,c.mutationId,c.attemptId]);
   }
   await updateCounters(c);return Object.freeze({claimToken:token,fenceEpoch:epoch,workerId});
  }),
  retryOutcomeRecovery:raw=>scope(raw,'retry_recovery',['errorCode'],async c=>{
   const rows=await assertRecovery(c,'retry_outcome_recovery'),errorCode=requireHistoryId(c.options.errorCode??'EVIDENCE_UNAVAILABLE');
   const exhausted=rows.some(row=>row.attempt_count>=row.max_attempts),delay=Math.min(900,30*2**Math.min(5,Math.max(...rows.map(row=>row.attempt_count))-1));
   const result=await c.tx.query(`UPDATE edit_history.recovery_tasks SET task_state=$4,claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,last_error_code=$5,
    available_at=clock_timestamp()+$6*interval '1 second',completed_at=CASE WHEN $4='REVIEW_REQUIRED' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
    WHERE shop_id=$1 AND installation_id=$2 AND id=ANY($3::uuid[]) AND task_state='RECONCILING' AND claim_token=$7 AND fence_epoch=$8 AND claim_expires_at>clock_timestamp()`,[c.tenant.shopId,c.tenant.installationId,rows.map(x=>x.id),exhausted?'REVIEW_REQUIRED':'RETRY_WAIT',errorCode,delay,c.options.recoveryClaim.claimToken,c.options.recoveryClaim.fenceEpoch]);
   if(result.rowCount!==rows.length)fail(C.OWNERSHIP_LOST,'Recovery claim expired before retry scheduling');
   return Object.freeze({state:exhausted?'REVIEW_REQUIRED':'RETRY_WAIT',delaySeconds:delay});
  }),
  renewOutcomeRecovery:raw=>scope(raw,'renew_recovery',['leaseSeconds'],async c=>{
   const rows=await assertRecovery(c,'renew_outcome_recovery'),seconds=positive(c.options.leaseSeconds??30,60);
   const result=await c.tx.query(`UPDATE edit_history.recovery_tasks SET claim_expires_at=clock_timestamp()+$4*interval '1 second',updated_at=clock_timestamp()
    WHERE shop_id=$1 AND installation_id=$2 AND id=ANY($3::uuid[]) AND task_state='RECONCILING' AND claim_token=$5 AND fence_epoch=$6 AND claim_expires_at>clock_timestamp()`,
    [c.tenant.shopId,c.tenant.installationId,rows.map(x=>x.id),seconds,c.options.recoveryClaim.claimToken,c.options.recoveryClaim.fenceEpoch]);
   if(result.rowCount!==rows.length)fail(C.OWNERSHIP_LOST,'Recovery lease expired before renewal');return Object.freeze({renewed:true});
  }),
  cancelOutcomeRecovery:raw=>scope(raw,'cancel_recovery',[],async c=>{
   await recoveryPermission(c,'cancel_outcome_recovery');const rows=await tasks(c);
   await c.tx.query(`UPDATE edit_history.recovery_tasks SET task_state='CANCELLED',claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,completed_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE shop_id=$1 AND installation_id=$2 AND id=ANY($3::uuid[]) AND task_state NOT IN ('COMPLETED','REVIEW_REQUIRED','CANCELLED')`,[c.tenant.shopId,c.tenant.installationId,rows.map(x=>x.id)]);return Object.freeze({cancelled:true});
  })
 };
 return Object.freeze(api);
}
