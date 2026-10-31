import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createOperationWorker} from '../../workers/operation.worker.js';
import {createHistoryExecution} from '../history-execution.server.js';
import {getApprovedContractInTransaction} from '../../services/approval.server.js';
import {normalizeMutationAttempt,normalizeMutationIntent,normalizeHistorySnapshot,historyFingerprint} from '../history-contract.js';
import {evidence} from './repository-qa.js';
import {createUndoRepository} from '../undo-repository.server.js';
import {createUndoService} from '../undo-service.server.js';
import {createJobDispatchService} from '../../services/job-dispatch.server.js';
import {createHistoryRepository} from '../history-repository.server.js';
import {createBulkExecutionRuntime} from '../../services/bulk-execution-runtime.server.js';

export async function testWorkerExecution(t,fixture,pool){
 await t.test('different commands cannot dispatch the same resource family concurrently or while a prior outcome is unresolved',async()=>{
  const a=await fixture(),b=await fixture({tenant:{shopId:a.shopId,installationId:a.installationId}});
  await a.repository.prepareRequest(a.input);await b.repository.prepareRequest(b.input);
  const results=await Promise.allSettled([a.repository.beginDispatch(a.input),b.repository.beginDispatch(b.input)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const winner=results[0].status==='fulfilled'?a:b,loser=winner===a?b:a;
  await assert.rejects(()=>loser.repository.beginDispatch(loser.input));
  const evidenceId=await evidence(winner,'AUTHORITATIVE_NO_WRITE');
  await winner.repository.recordMutationOutcome({authContext:winner.input.authContext,operationId:winner.input.operationId,
   mutationId:winner.input.mutationId,attemptId:winner.plan.attemptId,claim:winner.input.claim,evidenceId});
  assert.ok((await loser.repository.beginDispatch(loser.input)).dispatchToken);
 });
 await t.test('a reinstall cannot bypass an unresolved resource-family mutation from the previous installation',async()=>{
  const old=await fixture();await old.repository.prepareRequest(old.input);await old.repository.beginDispatch(old.input);
  const installationId=randomUUID();await old.q('UPDATE mirror.shops SET installation_version=$2 WHERE id=$1',[old.shopId,installationId]);
  const current=await fixture({tenant:{shopId:old.shopId,installationId}});await current.repository.prepareRequest(current.input);
  await assert.rejects(()=>current.repository.beginDispatch(current.input),{code:'HISTORY_INVALID_TRANSITION'});
 });
 async function setup(mode='normal',options={}){
  const f=options.existing??await fixture();let sends=0,reads=0;
  if(mode==='consume-lost'){
   let consumed=false,lost=false;
   f.repository=createHistoryRepository({...f.adapters,database:{async connect(){const client=await pool.connect();return{
    async query(sql,values){const result=await client.query(sql,values);if(sql.includes('SET dispatch_consumed_at='))consumed=true;
     if(sql==='COMMIT'&&consumed&&!lost){lost=true;throw Object.assign(Error('Lost consume COMMIT response'),{code:'ECONNRESET'});}return result;},release(){client.release();}};}}});
  }
  // The worker is a global scanner. Quiesce earlier test commands so this case
  // exercises its own fixture rather than claiming another test's expired job.
  await f.q("UPDATE mirror.job_commands SET status='CANCELLED',lease_token=NULL,lease_until=NULL WHERE id<>$1 AND kind IN('bulk_edit','undo') AND status IN('PENDING','RUNNING','RETRY')",[f.command]);
  const resource=f.input.entries[0].intent.identity.resourceGid,original={id:resource,title:'Before',vendor:'Old Vendor'},edited={id:resource,title:'After',vendor:'Vendor'};
  const inverse=f.plan.operationKind==='UNDO',before=inverse?edited:original,after=inverse?original:edited;
  await f.q("UPDATE mirror.job_commands SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE shop_id=$1 AND id=$2",[f.shopId,f.command]);
  let completing=false,completionLost=false;
  const database={query:(...args)=>pool.query(...args),async connect(){const client=await pool.adminConnect();return{
   async query(...args){try{const result=await client.query(...args);if(args[0].includes("UPDATE mirror.job_items SET status='SUCCEEDED'"))completing=true;
    if(mode==='completion-lost'&&args[0]==='COMMIT'&&completing&&!completionLost){completionLost=true;throw Object.assign(Error('Lost local completion response'),{code:'ECONNRESET'});}return result;
   }catch(error){f.state.workerDatabaseError=`${error.code}: ${error.message}`;throw error;}},release(){client.release();}};}};
  const loadExecutionRequest=async({claim,item})=>{
   if(f.plan.executionJobId!==String(claim.id)){
    f.command=String(claim.id);f.item=String(item.id);f.plan.executionJobId=f.command;
    f.plan.editOperationId=(await f.q('SELECT id FROM mirror.edit_operations WHERE shop_id=$1 AND command_id=$2',[f.shopId,f.command])).rows[0].id;
    f.input.entries=f.input.entries.map(e=>{
     const identity={...e.intent.identity,executionJobId:f.command,executionItemId:f.item};
     const beforeSnapshot=normalizeHistorySnapshot({identity,binding:e.beforeSnapshot.binding,kind:'BEFORE',valueKind:'VALUE',value:e.beforeSnapshot.value,
      observation:Object.fromEntries(['observationId','source','observedAt','resourceGid','fieldId','sourceRevision','receiptId','receiptFingerprint'].map(k=>[k,e.beforeSnapshot.observation[k]]))});
     const intent=normalizeMutationIntent({identity,binding:e.intent.binding,beforeSnapshotFingerprint:beforeSnapshot.fingerprint,
      mutationPlanFingerprint:e.intent.mutationPlanFingerprint,intendedValueKind:'VALUE',intendedValue:e.intent.intendedValue});
     return{...e,beforeSnapshot,intent,attempt:{...e.attempt,identity}};
    });
    f.plan.fields=f.input.entries.map(e=>({identity:e.intent.identity,binding:e.intent.binding,intendedValueKind:'VALUE',intendedValue:e.intent.intendedValue,resourceFamilyGid:e.resourceFamilyGid}));
    for(const e of f.input.entries)await f.q('UPDATE history_test_authority.observations SET snapshot=$4 WHERE shop_id=$1 AND installation_id=$2 AND receipt_id=$3',
     [f.shopId,f.installationId,e.beforeSnapshot.observation.receiptId,JSON.stringify(e.beforeSnapshot)]);
   }
   Object.assign(f.input.claim,{fenceEpoch:String(claim.fence),leaseToken:claim.lease_token});f.plan.fenceEpoch=String(claim.fence);
   f.input.entries=f.input.entries.map(e=>({...e,attempt:normalizeMutationAttempt({...Object.fromEntries(['identity','attemptId','attemptNumber','executionClaimId','startedAt'].map(k=>[k,e.attempt[k]])),fenceEpoch:String(claim.fence)})}));
   await f.persistPlan(f.plan);return f.input;
  };
  const persistEvidence=async({kind,observation})=>{
   const evidenceId=randomUUID(),record={operationId:f.input.operationId,mutationId:f.input.mutationId,attemptId:f.plan.attemptId,
    executionJobId:f.command,executionItemId:f.item,executionFenceEpoch:f.plan.fenceEpoch,executionClaimId:f.plan.executionClaimId,kind,evidenceId,
    fields:f.input.entries.map(e=>({fieldId:e.intent.identity.fieldId,resourceGid:e.intent.identity.resourceGid,
     ...(kind==='VERIFIED_OBSERVATION'?{afterSnapshot:normalizeHistorySnapshot({identity:e.intent.identity,binding:e.intent.binding,kind:'OBSERVED_AFTER',valueKind:'VALUE',
      value:observation[{'product.title':'title','product.vendor':'vendor'}[e.intent.identity.fieldId]],observation:{observationId:randomUUID(),source:'SHOPIFY_GRAPHQL',
       observedAt:new Date().toISOString(),resourceGid:resource,fieldId:e.intent.identity.fieldId,sourceRevision:null,receiptId:randomUUID(),receiptFingerprint:`sha256:${'9'.repeat(64)}`}})}:{})}))};
   record.fingerprint=historyFingerprint(record,'fixture-authenticated-mutation-evidence-v3');
   await f.q('INSERT INTO history_test_authority.evidence VALUES($1,$2,$3,$4,true)',[f.shopId,f.installationId,evidenceId,JSON.stringify(record)]);return evidenceId;
  };
  const historyExecution=createHistoryExecution({historyRepository:f.repository,loadExecutionRequest,persistEvidence,undoRepository:options.undoRepository});
  const transport={async readProduct(){reads++;
   if(mode==='stale'&&reads===2)await f.q('UPDATE mirror.job_commands SET fence=fence+1 WHERE shop_id=$1',[f.shopId]);
   if(mode==='revoke'&&reads===2)await f.q("UPDATE mirror.execution_contracts SET status='REVOKED' WHERE shop_id=$1",[f.shopId]);
   if(mode==='intervening'&&reads===2)return{...before,title:'Intervening merchant edit'};
   return reads<3?before:mode==='wrong-value'?{...after,title:'Unrelated edit'}:after;
  },async applyMutation(){sends++;if(mode==='timeout')throw Error('Network timeout after possible remote acceptance');
   return mode==='wrong-id'?{...after,id:'gid://shopify/Product/999'}:after;}};
  let worker=createOperationWorker({database,historyExecution,undoRepository:options.undoRepository,shopifyClientFactory:async()=>transport,authorizeWrite:async()=>true,
   approvalService:{getApprovedContract:input=>getApprovedContractInTransaction({...input,client:database})},logger:{error(){}}});
  if(mode==='composition')worker=createBulkExecutionRuntime({engineDatabase:database,historyDatabase:pool,historyAdapters:f.adapters,
   executionProviders:{loadExecutionRequest,persistEvidence},undoProviders:{authorizeUndo:async()=>true,resolveWorkerAuth:async()=>f.input.authContext,
    observeCurrent:async()=>[],verifyCurrentObservation:async()=>false,approveInverseExecution:async()=>{throw Error('Not invoked for bulk edit');}},
   shopifyClientFactory:async()=>transport,approvalService:{getApprovedContract:input=>getApprovedContractInTransaction({...input,client:input.client??database})},
   authorizeWrite:async()=>true,resolveShop:async()=>f.shopId,logger:{error(){}}}).worker;
  return{f,worker,database,sends:()=>sends,reads:()=>reads};
 }
 await t.test('actual operation worker commits verified V3 history before fenced item completion',async()=>{
  const x=await setup(),result=await x.worker.processOne({workerId:'durable-worker'});
  assert.equal(result.kind,'SUCCEEDED',x.f.state.workerDatabaseError);assert.equal(x.sends(),1);assert.equal(x.reads(),3);
  assert.equal((await x.f.q('SELECT request_state FROM edit_history.mutation_requests WHERE shop_id=$1',[x.f.shopId])).rows[0].request_state,'VERIFIED');
  assert.equal((await x.f.q('SELECT operation_state FROM edit_history.operations WHERE shop_id=$1',[x.f.shopId])).rows[0].operation_state,'COMPLETED');
  assert.equal((await x.worker.processOne({workerId:'duplicate'})).kind,'EMPTY');assert.equal(x.sends(),1);
 });
 await t.test('server composition connects the existing engine to the issued journal and one transport',async()=>{
  const x=await setup('composition');assert.equal((await x.worker.processOne({workerId:'composed'})).kind,'SUCCEEDED');assert.equal(x.sends(),1);
 });
 await t.test('pending cancellation is durable, audited and never contacts Shopify',async()=>{
  const x=await setup();await x.f.q('UPDATE mirror.job_commands SET cancel_requested_at=clock_timestamp() WHERE shop_id=$1',[x.f.shopId]);
  assert.equal((await x.worker.processOne({workerId:'cancelled'})).kind,'EMPTY');assert.equal(x.sends(),0);
  assert.equal((await x.f.q('SELECT status FROM mirror.job_commands WHERE shop_id=$1',[x.f.shopId])).rows[0].status,'CANCELLED');
  assert.equal((await x.f.q("SELECT count(*) FROM mirror.audit_events WHERE shop_id=$1 AND action='bulk_edit_cancelled'",[x.f.shopId])).rows[0].count,'1');
 });
 for(const mode of ['timeout','wrong-id','wrong-value'])await t.test(`worker ${mode} remains uncertain and cannot be automatically resubmitted`,async()=>{
  const x=await setup(mode),result=await x.worker.processOne({workerId:'durable-worker'});assert.equal(result.kind,'OUTCOME_UNKNOWN');assert.equal(x.sends(),1);
  await x.f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()-interval '1 second' WHERE shop_id=$1",[x.f.shopId]);
  assert.equal((await x.worker.processOne({workerId:'replacement'})).kind,'EMPTY');assert.equal(x.sends(),1);
  assert.equal((await x.f.q('SELECT count(*) FROM mirror.product_snapshots WHERE shop_id=$1 AND confirmed_at IS NOT NULL',[x.f.shopId])).rows[0].count,'0');
 });
 for(const mode of ['consume-lost','revoke'])await t.test(`worker ${mode} cannot contact Shopify after losing dispatch eligibility`,async()=>{
  const x=await setup(mode);assert.equal((await x.worker.processOne({workerId:'worker'})).kind,'OUTCOME_UNKNOWN');assert.equal(x.sends(),0);
 });
 await t.test('lost item-completion COMMIT is inspected and finalized without another Shopify write',async()=>{
  const x=await setup('completion-lost');assert.equal((await x.worker.processOne({workerId:'worker'})).kind,'SUCCEEDED');assert.equal(x.sends(),1);
  assert.equal((await x.worker.processOne({workerId:'duplicate'})).kind,'EMPTY');assert.equal(x.sends(),1);
 });
 await t.test('lease loss between journal admission and consumption prevents Shopify contact and snapshot confirmation',async()=>{
  const x=await setup('stale'),result=await x.worker.processOne({workerId:'old-worker'});assert.equal(result.kind,'OUTCOME_UNKNOWN');assert.equal(x.sends(),0);
  assert.equal((await x.f.q('SELECT count(*) FROM mirror.product_snapshots WHERE shop_id=$1 AND confirmed_at IS NOT NULL',[x.f.shopId])).rows[0].count,'0');
 });
 await t.test('a changed second pre-send observation aborts without overwriting the intervening edit',async()=>{
  const x=await setup('intervening');assert.equal((await x.worker.processOne({workerId:'worker'})).kind,'FAILED');assert.equal(x.sends(),0);
  assert.equal((await x.f.q('SELECT request_state FROM edit_history.mutation_requests WHERE shop_id=$1',[x.f.shopId])).rows[0].request_state,'FAILED_NO_WRITE');
 });
 await t.test('worker honors future item retry deadlines and command claim budgets',async()=>{
  const x=await setup();await x.f.q("UPDATE mirror.job_items SET status='RETRY',next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE shop_id=$1",[x.f.shopId]);
  assert.equal((await x.worker.processOne({workerId:'not-due'})).kind,'PARTIAL');assert.equal(x.sends(),0);
  assert.equal((await x.worker.processOne({workerId:'not-due-again'})).kind,'EMPTY');
  await x.f.q("UPDATE mirror.job_commands SET status='RUNNING',lease_token='expired',lease_until=clock_timestamp()-interval '1 second',attempts=max_attempts WHERE shop_id=$1",[x.f.shopId]);
  assert.equal((await x.worker.claimNext({workerId:'exhausted'})),null);
  const exhausted=(await x.f.q('SELECT status,checkpoint FROM mirror.job_commands WHERE shop_id=$1',[x.f.shopId])).rows[0];
  assert.equal(exhausted.status,'FAILED');assert.equal(exhausted.checkpoint.review_required,true);
 });
 for(const mode of ['normal','intervening'])await t.test(`history undo ${mode} uses real inverse dispatch, stable lost-handoff recovery and the same fenced worker`,async()=>{
  const original=await setup();assert.equal((await original.worker.processOne({workerId:'original'})).kind,'SUCCEEDED');
  const f=original.f,tenant={shopId:f.shopId,installationId:f.installationId};
  const undo=createUndoRepository({database:pool,historyRepository:f.repository,resolveTenant:f.adapters.resolveTenant,authorizeUndo:async()=>true,
   resolveWorkerAuth:async()=>f.input.authContext,authorityRelations:f.adapters.authorityRelations});
  let inverse,dropReceipt=true;
  const dispatchDatabase={query:(...args)=>original.database.query(...args),async connect(){const client=await original.database.connect();return{
   async query(sql,values){const result=await client.query(sql,values);if(sql==='COMMIT'&&dropReceipt){dropReceipt=false;throw Object.assign(Error('Lost dispatch COMMIT response'),{code:'ECONNRESET'});}return result;},release(){client.release();}};}};
  const dispatch=createJobDispatchService({database:dispatchDatabase,resolveShop:async auth=>{assert.equal(auth,f.input.authContext);return f.shopId;},
   authorizeWrite:async()=>true,approvalService:{getApprovedContract:input=>getApprovedContractInTransaction({...input,client:input.client??original.database})}});
  const service=createUndoService({repository:undo,
   observeCurrent:async({fields})=>fields.map(field=>({resourceGid:field.resourceGid,fieldId:field.fieldId,valueKind:field.after.valueKind,value:field.after.value})),
   verifyCurrentObservation:async()=>true,
   approveInverseExecution:async({undoRequestId,preflightFingerprint,inversePlanFingerprint,handoffKey})=>{
    inverse=await fixture({tenant,kind:'undo',sourceCommandId:f.command,deferCommand:true,
     historyUndoBinding:{requestId:undoRequestId,preflightFingerprint,inversePlanFingerprint,handoffKey},
     resolveTenant:async({authContext})=>{assert.equal(authContext,f.input.authContext);return tenant;}});
    inverse.input.authContext=f.input.authContext;return{contractId:inverse.contractId};
   },dispatchService:dispatch});
  const preflight=await service.preflight({authContext:f.input.authContext,originalOperationId:f.input.operationId,idempotencyKey:'stable-undo'});
  assert.equal(preflight.state,'READY_FOR_REVIEW');assert.equal(preflight.eligibleFields,2);
  assert.equal((await service.submit({authContext:f.input.authContext,undoRequestId:preflight.undoRequestId})).state,'OUTCOME_UNKNOWN');
  const submitted=await service.submit({authContext:f.input.authContext,undoRequestId:preflight.undoRequestId});assert.equal(submitted.state,'EXECUTING');
  assert.equal((await f.q("SELECT count(*) FROM mirror.job_commands WHERE shop_id=$1 AND kind='undo'",[f.shopId])).rows[0].count,'1');
  inverse.command=submitted.executionJobId;
  const execution=await setup(mode,{existing:inverse,undoRepository:undo});
  assert.equal((await execution.worker.processOne({workerId:'inverse'})).kind,mode==='normal'?'SUCCEEDED':'FAILED',inverse.state.workerDatabaseError);
  assert.equal(execution.sends(),mode==='normal'?1:0);
  assert.equal((await undo.get({authContext:f.input.authContext,undoRequestId:preflight.undoRequestId})).undo_state,mode==='normal'?'COMPLETED':'FAILED');
  assert.equal((await f.q("SELECT count(*) FROM edit_history.operations WHERE shop_id=$1 AND operation_kind='UNDO'",[f.shopId])).rows[0].count,'1');
  assert.equal((await service.submit({authContext:f.input.authContext,undoRequestId:preflight.undoRequestId})).executionJobId,submitted.executionJobId);
 });
}
