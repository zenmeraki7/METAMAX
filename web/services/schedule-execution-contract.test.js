import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {currentMutationAdapterVersion} from './execution-contract.server.js';
const runtime=await import('../security/runtime-database.server.js');
mock.module('../security/runtime-database.server.js',{namedExports:{...runtime,assertRuntimeDatabaseProfile(database,profile){assert.equal(database.profile,profile);}}});
const {createSchedulesService}=await import('./schedules.server.js');

function fixture({phase='DONE',frozen=false,commandStatus='SUCCEEDED',outcome='SUCCEEDED',finalization='SUCCEEDED',failFinalization=false}={}){
 const shopId='scheduled.myshopify.com',state={installation:'installation',dispatches:0,authCalls:0,created:0,loaded:0},calls=[];
 const template={selectionMode:'EXPLICIT',productIds:['1'],contractPayload:{writeCapabilityVersion:'resource-set-v2',updates:{title:'Approved'}},
  mutationAdapterVersion:currentMutationAdapterVersion(),...(frozen?{frozenSnapshotId:'snapshot'}:{})};
 const occurrence={id:'occurrence',shop_id:shopId,installation_version:'installation',schedule_id:'1',operation:'bulk_edit',phase,template,status:'DISPATCHED',fence:0,attempts:0,command_id:'10',contract_id:'contract',snapshot_id:'snapshot'};
 const result={outcome,terminal:!['RUNNING','PENDING','RETRY'].includes(commandStatus),counts:{succeeded:outcome==='PARTIAL'?9:10,failed:outcome==='PARTIAL'?1:0,pending:0,uncertain:0}};
 const rows=items=>({rows:items,rowCount:items.length});
 async function query(sql,p=[]){
  calls.push({sql,p});
  if(sql.includes("last_error='INSTALLATION_CHANGED'")){
   if(occurrence.installation_version!==state.installation)occurrence.status='REVIEW_REQUIRED';return rows([]);
  }
  if(sql.startsWith('WITH due AS')){
   if(['REVIEW_REQUIRED','SUCCEEDED','PARTIAL','FAILED','CANCELLED','RUNNING'].includes(occurrence.status))return rows([]);
   Object.assign(occurrence,{status:'RUNNING',fence:occurrence.fence+1,lease_token:p[0],attempts:occurrence.attempts+1});return rows([structuredClone(occurrence)]);
  }
  if(sql.includes('FROM mirror.shops'))return rows([{installation_version:state.installation}]);
  if(sql.includes('SELECT o.id FROM mirror.schedule_occurrences')){
   assert.equal(p[5],occurrence.installation_version);return rows(occurrence.installation_version===state.installation?[{id:occurrence.id}]:[]);
  }
  if(sql.includes('SELECT status,result,installation_version FROM mirror.job_commands')){
   assert.equal(p[2],occurrence.installation_version);return rows([{status:commandStatus,result,installation_version:state.installation}]);
  }
  if(sql.includes('SELECT state FROM mirror.operation_finalizations')){
   if(failFinalization)throw Error('History status database failure');return rows(finalization?[{state:finalization}]:[]);
  }
  if(sql.includes('UPDATE mirror.schedule_occurrences SET phase=')){
   assert.match(sql,/lease_until>clock_timestamp\(\)/);assert.equal(p[12],occurrence.installation_version);
   Object.assign(occurrence,{phase:p[5],snapshot_id:p[6],contract_id:p[7],command_id:p[8],status:p[9]??'QUEUED',attempts:0,lease_token:null,
    execution_result:p[10]?JSON.parse(p[10]):null});return rows([{id:occurrence.id}]);
  }
  if(sql.includes("status=CASE WHEN $7::boolean")){occurrence.status=p[6]?'REVIEW_REQUIRED':'RETRY';return rows([{id:occurrence.id}]);}
  return rows([]);
 }
 const client={query,release(){}},database={query,async connect(){return client;}},workerDatabase={...database,profile:'operationWorker'};
 const snapshot={snapshotId:'snapshot',shopId,installationId:'installation',selectedCount:1,status:'APPROVED',operation:'bulk_edit',expiresAt:new Date(Date.now()+60000).toISOString()};
 const service=createSchedulesService({database,workerDatabase,resolveShop:async()=>shopId,getScheduleAuthContext:async({installationId})=>{state.authCalls++;assert.equal(installationId,'installation');return{};},
  selectionService:{async withSelectionTransaction(input,callback){state.created++;assert.equal(input.operationId,'schedule-occurrence:occurrence');return callback({client,snapshot});},
   async getSelectionSnapshot(){state.loaded++;return snapshot;}},
  approvalService:{async approveContract(){return{contractId:'contract'};}},jobDispatchService:{async dispatchBulkEdit(){state.dispatches++;return{commandId:'10'};}},logger:{error(){}}});
 return{service,state,occurrence,calls,result,run:()=>service.processNextOccurrence()};
}
for(const frozen of [false,true])test(`new and persisted selection snapshots use one contract (frozen=${frozen})`,async()=>{
 const f=fixture({phase:'SELECT',frozen});await f.run();assert.equal(f.occurrence.phase,'APPROVE');assert.equal(f.occurrence.snapshot_id,'snapshot');
 assert.equal(frozen?f.state.loaded:f.state.created,1);
});
test('successful dispatch is not successful execution and replay does not redispatch',async()=>{
 const f=fixture({phase:'DISPATCH',commandStatus:'RUNNING'});await f.run();assert.equal(f.occurrence.status,'DISPATCHED');assert.equal(f.state.dispatches,1);
 await f.run();assert.equal(f.occurrence.status,'EXECUTING');assert.equal(f.state.dispatches,1);
});
test('permanent item failures preserve a merchant-facing partial occurrence',async()=>{
 const f=fixture({commandStatus:'FAILED',outcome:'PARTIAL'});await f.run();assert.equal(f.occurrence.status,'PARTIAL');assert.deepEqual(f.occurrence.execution_result,f.result);
});
for(const finalization of [null,'PENDING','RETRY','RUNNING'])test(`terminal command waits for history finalization ${finalization}`,async()=>{
 const f=fixture({finalization});await f.run();assert.equal(f.occurrence.status,'EXECUTING');assert.equal(f.occurrence.attempts,0);
});
test('finalization review propagates to occurrence and status read errors remain retryable',async()=>{
 const review=fixture({finalization:'REVIEW_REQUIRED'});await review.run();assert.equal(review.occurrence.status,'REVIEW_REQUIRED');
 const failed=fixture({failFinalization:true});assert.equal((await failed.run()).kind,'RETRY');assert.equal(failed.occurrence.status,'RETRY');
});
test('old installation occurrence never obtains newly installed authentication',async()=>{
 const f=fixture({phase:'SELECT'});f.state.installation='reinstalled';assert.equal((await f.run()).kind,'EMPTY');
 assert.equal(f.occurrence.status,'REVIEW_REQUIRED');assert.equal(f.state.authCalls,0);assert.equal(f.state.created,0);
});
test('adapter upgrade suspends the occurrence before creating new execution authority',async()=>{
 const f=fixture({phase:'APPROVE'});f.occurrence.template.mutationAdapterVersion={id:'old-adapter',version:0};
 assert.equal((await f.run()).kind,'REVIEW_REQUIRED');assert.equal(f.state.dispatches,0);
});

test('reading an already finalized command does not reacquire merchant write authority after an adapter upgrade',async()=>{
 const f=fixture();f.occurrence.template.mutationAdapterVersion={id:'old-adapter',version:0};
 await f.run();assert.equal(f.occurrence.status,'SUCCEEDED');assert.equal(f.state.authCalls,0);assert.equal(f.state.dispatches,0);
});

test('unsupported merchant-local recurrence is rejected rather than interpreted as UTC',async()=>{
 const f=fixture();await assert.rejects(()=>f.service.createSchedule({authContext:{},timezone:'Asia/Calcutta',template:{}}),{code:'FIELD_INVALID_VALUE'});
 assert.equal(f.calls.some(call=>call.sql.includes('INSERT INTO mirror.job_schedules')),false);
});
