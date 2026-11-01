import {approvedContractFixture} from '../security/test-support/approved-contract.js';
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
// Isolate scheduling from the separately tested durable history capability.
mock.module('../edit-history/undo-repository.server.js',{namedExports:{assertUndoRepository(){}}});
mock.module('../edit-history/history-execution.server.js',{namedExports:{assertHistoryExecution(){}}});
const actualRuntime=await import('../security/runtime-database.server.js');
mock.module('../security/runtime-database.server.js',{namedExports:{...actualRuntime,assertRuntimeDatabaseProfile(){}}});
const {createOperationWorker}=await import('./operation.worker.js');
const {createOperationOutboxDispatcher}=await import('./operation-outbox.server.js');
function fixture(kind='bulk_edit',size=201,controls={}){
 const command={id:'cmd',shop_id:'progress.myshopify.com',installation_version:'install',kind,contract_id:'contract',fence:0,attempts:0,max_attempts:8,status:'PENDING'};
 const items=Array.from({length:size},(_,i)=>({id:String(i+1),resource_id:`gid://shopify/Product/${i+1}`,intended_values:{title:'Updated'},attempts:0,status:'PENDING'}));
 let sends=0;let finalTask;
 const rows=value=>({rows:value,rowCount:value.length});
 async function query(sql,p=[]){
  if(controls.queryHook){const result=await controls.queryHook(sql,p);if(result!==undefined)return result;}
  if(sql.includes('INSERT INTO mirror.operation_finalizations')){
   if(sql.includes('VALUES'))finalTask??={shop_id:command.shop_id,command_id:command.id,execution_fence:command.fence,installation_version:command.installation_version,item_id:p[4],history_pending:true,undo_pending:kind==='undo',attempts:0,fence:0,state:'PENDING'};
   return rows([]);
  }
  if(sql.includes("SET state='REVIEW_REQUIRED'"))return rows([]);
  if(sql.includes('WITH due AS(SELECT f.shop_id')){
   if(!finalTask||!['PENDING','RETRY'].includes(finalTask.state))return rows([]);finalTask.state='RUNNING';finalTask.fence++;finalTask.attempts++;finalTask.lease_token=p[2];return rows([{...finalTask}]);
  }
  if(sql.includes('UPDATE mirror.operation_finalizations f SET history_pending')){Object.assign(finalTask,{history_pending:p[4],undo_pending:p[5],state:p[6],last_error:p[7]});return rows([{command_id:command.id}]);}
  if(sql.includes('SELECT * FROM mirror.job_commands WHERE'))return rows([{...command}]);
  if(sql.includes('SELECT id,resource_id,intended_values FROM mirror.job_items')&&sql.includes('id=$3'))return rows(items.filter(item=>item.id===p[2]));
  if(sql.includes('UPDATE mirror.job_commands c SET lease_until')){
   assert.deepEqual(p.slice(0,5),[command.shop_id,command.id,String(command.fence),command.lease_token,command.installation_version]);
   assert.match(sql,/c.lease_until>clock_timestamp()/);assert.match(sql,/c.cancel_requested_at IS NULL/);assert.match(sql,/s.uninstalled_at IS NULL/);
   controls.renewals=(controls.renewals??0)+1;
   return controls.renew?controls.renew():rows([{id:command.id}]);
  }
  if(sql.includes("SET status='CANCELLED'"))return rows([]);
  if(sql.includes("SET status='FAILED',lease_token=NULL")){
   if(command.attempts>=8)command.status='FAILED';return rows([]);
  }
  if(sql.includes("UPDATE mirror.job_commands SET status='RETRY',lease_token=NULL")){
   command.status='RETRY';command.checkpoint={review_required:true};command.result=JSON.parse(p[2]);return rows([{id:command.id}]);
  }
  if(sql.includes('SELECT c.* FROM mirror.job_commands'))return rows(['FAILED','SUCCEEDED','PARTIAL','CANCELLED'].includes(command.status)||command.checkpoint?.review_required?[]:[{...command}]);
  if(sql.includes("SET status='RUNNING',lease_token=$1")){command.status='RUNNING';command.attempts++;command.fence++;command.lease_token=p[0];return rows([{...command}]);}
  if(sql.includes('SELECT c.id FROM mirror.job_commands')){if(sql.includes('FOR UPDATE OF c')){assert.match(sql,/c.installation_version=\$5/);assert.equal(p[4],command.installation_version);}return rows(controls.lost?[]:[{id:command.id}]);}
  if(sql.includes('SELECT id,resource_id,intended_values,restore_snapshot_id'))return rows(items.filter(x=>x.status==='PENDING').slice(0,25));
  if(sql.includes('SELECT r.id FROM edit_history.mutation_requests'))return rows(kind==='undo'||sql.includes('JOIN edit_history.operations o\n   ON')?[{id:'verified'}]:[]);
  if(sql.includes('SELECT id,before_hash,confirmed_at'))return rows([{id:'snapshot',confirmed_at:new Date()}]);
  if(sql.includes("UPDATE mirror.job_items SET status='SUCCEEDED'")){items.find(x=>x.id===p[2]).status='SUCCEEDED';return rows([{id:p[2]}]);}
  if(sql.includes('WITH item_outcomes'))return rows([{total:items.length,succeeded:items.filter(x=>x.status==='SUCCEEDED').length,failed:items.filter(x=>x.status==='FAILED').length,pending:items.filter(x=>['PENDING','RUNNING','RETRY'].includes(x.status)&&!controls.uncertain?.has(x.id)).length,uncertain:controls.uncertain?.size??0,cancelled:0,due:null}]);
  if(sql.includes("UPDATE mirror.job_items SET status='FAILED',last_error='PREFLIGHT_CONFLICT'")){items.find(x=>x.id===p[1]).status='FAILED';return rows([]);}
  if(sql.startsWith('UPDATE mirror.job_commands SET result=')){command.result=JSON.parse(p[2]);return rows([]);}
  if(sql.startsWith('INSERT INTO mirror.audit_events')){(controls.audits??=[]).push({outcome:p[4],summary:JSON.parse(p[5])});return rows([]);}
  if(sql.includes('SELECT 1 FROM mirror.job_items'))return rows(items.some(x=>x.status==='PENDING')?[{one:1}]:[]);
  if(sql.includes('UPDATE mirror.job_commands SET status=$3')){command.status=p[2];command.result=JSON.parse(p[5]);if(p[4]===true&&sql.includes('attempts=CASE'))command.attempts=0;return rows([]);}
  if(sql.includes('pg_advisory_xact_lock_shared')||sql.includes("SELECT set_config('app.shop_id'")||/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|LOCK TABLE|INSERT INTO mirror.audit_events)/.test(sql))return rows([]);
  throw Error(`Unexpected scheduling SQL: ${sql}`);
 }
 const database={query,async connect(){return {query,release(){}};}};
 const worker=createOperationWorker({database,shopifyClientFactory:async()=>{controls.factoryCalls=(controls.factoryCalls??0)+1;if(controls.factoryError)throw controls.factoryError;return{readProduct(){},applyMutation(input){controls.remoteSends=(controls.remoteSends??0)+1;return controls.transport?.(input)??{};}};},
  approvalService:{async getApprovedContract(){if(controls.approvalError)throw Object.assign(Error('Approval requires revalidation'),{code:controls.approvalError});return approvedContractFixture({shop_id:command.shop_id,status:'APPROVED',operation:kind,contract:{writeCapabilityVersion:'product-set-v1',...(kind==='undo'?{sourceCommandId:'original',fields:['title']}:kind==='import'?{resourceType:'product',importMappingVersion:1,rowCount:items.length,fieldIds:['product.title'],rows:items.map(item=>({resourceGid:item.resource_id,fields:{'product.title':item.intended_values.title}}))}:{updates:{title:'Updated'}})}},{installationId:'install'});}},
  undoRepository:kind==='undo'?{async loadExecutionSourceForWorker(){return{sourceCommandId:'original',inverseValues:{title:'Updated'}};},async reconcileExecutionForWorker(){return{state:'COMPLETED'};}}:undefined,authorizeWrite:async()=>true,heartbeatMs:controls.heartbeatMs??20000,renewalTimeoutMs:controls.renewalTimeoutMs??2000,historyExecution:{async inspectItem(){return controls.inspect?controls.inspect():{state:kind==='undo'?'VERIFIED':'NOT_DISPATCHED'};},async verifyItemCompletion(input){controls.completions=(controls.completions??0)+1;return controls.verify?controls.verify(input):true;},async execute(input){sends++;if(controls.execute){const result=await controls.execute(input);if(result)return result;}return{state:'VERIFIED'};},async finalize(){return controls.finalize?controls.finalize():{completed:true};}} });
 return{worker,command,items,sends:()=>sends,finalTask:()=>finalTask};
}
for(const kind of ['bulk_edit','undo','import'])test(`${kind}: 201 verified items finish across nine claims without exhausting failure retries`,async()=>{
 const f=fixture(kind);let result;
 for(let i=0;i<9;i++)result=await f.worker.processOne({workerId:'progress'});
 assert.equal(result.kind,'SUCCEEDED');assert.equal(f.command.status,'SUCCEEDED');assert.ok(f.items.every(x=>x.status==='SUCCEEDED'));
 assert.equal(f.sends(),kind==='undo'?0:201);
 assert.equal((await f.worker.processOne({workerId:'duplicate'})).kind,'EMPTY');
 assert.equal(result.counts.succeeded,201);assert.equal(result.counts.pending,0);assert.equal(result.terminal,true);
});
test('nine successful resources and one permanent conflict produce a durable partial result',async()=>{
 const controls={execute:async()=>({state:'CONFLICT'})};const f=fixture('bulk_edit',10,controls);
 f.items.slice(0,9).forEach(item=>item.status='SUCCEEDED');
 const result=await f.worker.processOne({workerId:'partial'});
 assert.equal(result.kind,'PARTIAL');assert.equal(result.outcome,'PARTIAL');assert.equal(result.terminal,true);assert.equal(result.commandStatus,'PARTIAL');assert.equal(f.command.status,'PARTIAL');
 assert.deepEqual(result.counts,{total:10,succeeded:9,failed:1,pending:0,uncertain:0,cancelled:0});
 assert.equal(result.countUnit,'resources');
 assert.equal(f.command.result.outcome,'PARTIAL');assert.equal(controls.audits[0].outcome,'PARTIAL');assert.deepEqual(controls.audits[0].summary.counts,result.counts);
});
test('an unfinished batch reports pending counts without presenting terminal partial success',async()=>{
 const f=fixture('bulk_edit',26);const result=await f.worker.processOne({workerId:'batch'});
 assert.equal(result.kind,'IN_PROGRESS');assert.equal(result.outcome,'IN_PROGRESS');assert.equal(result.terminal,false);
 assert.deepEqual(result.counts,{total:26,succeeded:25,failed:0,pending:1,uncertain:0,cancelled:0});
});
test('an uncertain resource is counted separately and is never marked retryable or failed',async()=>{
 const controls={uncertain:new Set(),execute:async({item})=>{controls.uncertain.add(item.id);return{state:'OUTCOME_UNKNOWN'};}};
 const f=fixture('bulk_edit',3,controls);f.items[0].status='SUCCEEDED';
 const result=await f.worker.processOne({workerId:'unknown'});
 assert.equal(result.kind,'OUTCOME_UNKNOWN');assert.deepEqual(result.counts,{total:3,succeeded:1,failed:0,pending:1,uncertain:1,cancelled:0});
 assert.equal(f.command.result.outcome,'OUTCOME_UNKNOWN');assert.equal(f.command.status,'RUNNING');
});
test('failed recovery persistence reports an incident and never retries the original mutation',async()=>{
 let failed=false;const controls={execute:async()=>{failed=true;throw Object.assign(Error('storage unavailable'),{code:'HISTORY_RECOVERY_PERSISTENCE_FAILED'});},queryHook:async sql=>{if(failed&&!/ROLLBACK/.test(sql))assert.fail('Incident path performed further owned work');}};
 const f=fixture('bulk_edit',2,controls);const result=await f.worker.processOne({workerId:'incident'});
 assert.equal(result.kind,'RECOVERY_PERSISTENCE_FAILED');assert.equal(result.outcome,'OUTCOME_UNKNOWN');assert.equal(f.sends(),1);assert.ok(f.items.every(i=>i.status==='PENDING'));
});
test('abandoned claims with no progress still exhaust the command retry budget',async()=>{
 const f=fixture();
 // The fixture models expiry between claims; no successful completion is run.
 for(let i=0;i<8;i++)assert.ok(await f.worker.claimNext({workerId:'crashed'}));
 assert.equal(await f.worker.claimNext({workerId:'replacement'}),null);assert.equal(f.command.status,'FAILED');
 assert.ok(f.items.every(x=>x.status==='PENDING'));
});

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('bulk processing renews the fenced lease throughout a long item and stops the heartbeat at completion',async()=>{
 const controls={heartbeatMs:5,execute:async()=>delay(40)};
 const f=fixture('bulk_edit',1,controls);
 assert.equal((await f.worker.processOne({workerId:'heartbeat'})).kind,'SUCCEEDED');
 assert.ok(controls.renewals>=2);const renewals=controls.renewals;
 await delay(20);assert.equal(controls.renewals,renewals);assert.equal(f.command.status,'SUCCEEDED');
});
for(const failure of ['revoked','error','hung'])test(`bulk heartbeat ${failure} stops processing and prevents subsequent sends and completion`,async()=>{
 const controls={heartbeatMs:5,renewalTimeoutMs:15,
  renew:()=>failure==='error'?Promise.reject(Error('storage failed')):failure==='hung'?new Promise(()=>{}):{rows:[],rowCount:0},
  execute:async({shopifyClient})=>{await delay(45);await shopifyClient.applyMutation({values:{title:'Updated'}});}};
 const f=fixture('bulk_edit',2,controls);
 assert.equal((await f.worker.processOne({workerId:'lost'})).kind,'STALE_CLAIM');
 await delay(65);
 assert.equal(controls.remoteSends??0,0);assert.equal(f.sends(),1);
 assert.ok(f.items.every(item=>item.status==='PENDING'));assert.equal(f.command.status,'RUNNING');
});
test('final acknowledgment waits for an in-flight renewal and cannot conceal its failure',async()=>{
 let release,entered;const renewing=new Promise(resolve=>entered=resolve);
 const controls={heartbeatMs:1,renewalTimeoutMs:100,
  renew:()=>{entered();return new Promise(resolve=>release=resolve);},execute:async()=>{await renewing;}};
 const helper=fixture('bulk_edit',1,controls);
 const pending=helper.worker.processOne({workerId:'drain'});
 await renewing;await delay(5);release({rows:[],rowCount:0});
 assert.equal((await pending).kind,'STALE_CLAIM');assert.notEqual(helper.command.status,'SUCCEEDED');
});

test('lease loss aborts an in-flight transport without acknowledging or resending the item',async()=>{
 let aborted=false;
 const controls={heartbeatMs:5,renew:()=>({rows:[],rowCount:0}),
  transport:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true})),
  execute:({shopifyClient})=>shopifyClient.applyMutation({values:{title:'Updated'}})};
 const f=fixture('bulk_edit',1,controls);
 assert.equal((await f.worker.processOne({workerId:'in-flight'})).kind,'STALE_CLAIM');
 await delay(20);assert.equal(aborted,true);assert.equal(controls.remoteSends,1);
 assert.equal(f.items[0].status,'PENDING');assert.equal(f.command.status,'RUNNING');
});

for(const code of ['HISTORY_OWNERSHIP_LOST','WORKER_CLAIM_REVOKED','STALE_CLAIM'])test(`known stale error ${code} stops the worker without recovery probes`,async()=>{
 let lost=false;const controls={execute:async()=>{lost=true;throw Object.assign(Error('ownership lost'),{code});},queryHook:async sql=>{if(lost&&!/ROLLBACK/.test(sql))assert.fail('Stale worker performed another query');}};
 const f=fixture('bulk_edit',1,controls);assert.equal((await f.worker.processOne({workerId:'stale'})).kind,'STALE_CLAIM');assert.equal(f.finalTask(),undefined);assert.equal(f.items[0].status,'PENDING');
});
test('ownership lost inside exception handling returns STALE_CLAIM instead of failing again',async()=>{
 const controls={execute:async()=>{controls.lost=true;throw Error('initial failure');}};const f=fixture('bulk_edit',1,controls);
 assert.equal((await f.worker.processOne({workerId:'recovery-probe'})).kind,'STALE_CLAIM');assert.equal(f.finalTask(),undefined);
});
for(const code of ['STALE_CLAIM','WORKER_CLAIM_REVOKED','INSTALLATION_NOT_ACTIVE'])test(`stale recovery-probe error ${code} stops processing`,async()=>{
 let failed=false;const controls={execute:async()=>{failed=true;throw Error('initial failure');},inspect:async()=>{if(failed)throw Object.assign(Error('probe lost ownership'),{code});return{state:'NOT_DISPATCHED'};}};
 const f=fixture('bulk_edit',1,controls);assert.equal((await f.worker.processOne({workerId:'probe'})).kind,'STALE_CLAIM');assert.equal(f.finalTask(),undefined);
});
test('ownership lost during verified local completion recovery is never masked as RECOVERY_REQUIRED',async()=>{
 let first=true;const controls={inspect:async()=>{if(!first){controls.lost=true;return{state:'VERIFIED'};}return{state:'NOT_DISPATCHED'};},queryHook:async sql=>{
  if(sql.includes('SELECT id,before_hash,confirmed_at')&&first){first=false;throw Error('local snapshot unavailable');}
  
 }};
 const f=fixture('bulk_edit',1,controls);assert.equal((await f.worker.processOne({workerId:'completion-recovery'})).kind,'STALE_CLAIM');assert.equal(f.items[0].status,'PENDING');
});
test('terminal command completion durably queues failed history finalization',async()=>{
 const controls={finalize:async()=>{throw Error('history unavailable');}};const f=fixture('bulk_edit',1,controls);
 const result=await f.worker.processOne({workerId:'finalization-failure'});
 assert.equal(result.kind,'FINALIZATION_PENDING');assert.equal(result.executionState,'SUCCEEDED');assert.equal(f.command.status,'SUCCEEDED');
 assert.equal(f.finalTask().state,'RETRY');assert.equal(f.finalTask().history_pending,true);assert.equal(f.finalTask().last_error,'FINALIZATION_FAILED');
});

test('incomplete field verification cannot mark an item successful',async()=>{
 const controls={verify:async({tx,approved})=>{assert.equal(typeof tx.query,'function');assert.deepEqual(approved,{title:'Updated'});return false;}};
 const f=fixture('bulk_edit',1,controls);
 assert.equal((await f.worker.processOne({workerId:'incomplete'})).kind,'RECOVERY_REQUIRED');
 assert.equal(f.items[0].status,'PENDING');assert.equal(controls.completions,1);
});

test('completion requires exactly one eligible item update',async()=>{
 const controls={queryHook:async(sql,p)=>{
  if(sql.includes("UPDATE mirror.job_items SET status='SUCCEEDED'")){
   assert.match(sql,/status IN \('PENDING','RETRY','RUNNING'\) RETURNING id/);
   assert.deepEqual(p,['progress.myshopify.com','cmd','1']);return{rows:[],rowCount:0};
  }
 }};
 const f=fixture('bulk_edit',1,controls);
 assert.equal((await f.worker.processOne({workerId:'fenced'})).kind,'STALE_CLAIM');
 assert.equal(f.items[0].status,'PENDING');
});

for(const approvalError of ['FIELD_CONTRACT_MISMATCH','FIELD_EXECUTION_UNAVAILABLE'])test(`incompatible or expired approval suspends without replaying verified items (${approvalError})`,async()=>{
 const f=fixture('bulk_edit',2,{approvalError});f.items[0].status='SUCCEEDED';
 const result=await f.worker.processOne({workerId:'revalidate'});
 assert.equal(result.kind,'REVIEW_REQUIRED');assert.equal(result.counts.succeeded,1);assert.equal(result.counts.pending,1);
 assert.equal(f.sends(),0);assert.equal(f.items[0].status,'SUCCEEDED');assert.equal(f.items[1].status,'PENDING');
 assert.equal((await f.worker.processOne({workerId:'retry'})).kind,'EMPTY');
});

test('already verified writes complete locally even when new execution approval is expired',async()=>{
 const controls={factoryError:Error('Transport unavailable'),approvalError:'FIELD_EXECUTION_UNAVAILABLE',inspect:async()=>({state:'VERIFIED'})};
 const f=fixture('bulk_edit',1,controls);
 assert.equal((await f.worker.processOne({workerId:'persist-existing-result'})).kind,'SUCCEEDED');
 assert.equal(f.sends(),0);assert.equal(f.items[0].status,'SUCCEEDED');assert.equal(controls.factoryCalls??0,0);
});

for(const lost of ['queue-response','database-ack'])test(`${lost} loss can duplicate scheduling tokens without duplicating effective execution`,async()=>{
 const controls={execute:async({shopifyClient,approved})=>{await shopifyClient.applyMutation({values:approved});return {state:'VERIFIED'};}};
 const f=fixture('bulk_edit',1,controls),accepted=[];
 const event={id:'event',shop_id:f.command.shop_id,command_id:f.command.id,fence:0,attempts:0};let failed=false,delivered=false;
 const database={async query(sql,params){
  if(sql.includes('WITH exhausted'))return {rows:[]};
  if(sql.includes('WITH due AS')){
   if(delivered||!['PENDING','RETRY'].includes(f.command.status))return {rows:[]};
   event.fence++;event.attempts++;return {rows:[{...event}]};
  }
  if(sql.includes('SELECT kind'))return {rows:[{kind:f.command.kind}]};
  if(sql.includes('SET dispatched_at')){if(lost==='database-ack'&&!failed){failed=true;throw Error('Ack failed before commit');}delivered=true;return {rowCount:1};}
  assert.match(sql,/QUEUE_DELIVERY_UNCONFIRMED/);assert.deepEqual(params.slice(0,2),[event.shop_id,event.id]);return {rows:[{review_required:false}],rowCount:1};
 }};
 const dispatcher=createOperationOutboxDispatcher({database,queue:{async add(kind,data,options){
  accepted.push({kind,data,jobId:options.jobId});if(lost==='queue-response'&&!failed){failed=true;throw Error('Accepted token; response lost');}
 }}});
 assert.equal((await dispatcher.dispatchNext()).kind,'RETRY');assert.equal((await dispatcher.dispatchNext()).kind,'DISPATCHED');
 assert.equal(accepted.length,2);assert.deepEqual(accepted[0],accepted[1]);
 // Deliberately deliver both copies: the database/journal must protect execution,
 // even if queue deduplication has expired or is unavailable.
 assert.equal((await f.worker.processOne({workerId:'first-token'})).kind,'SUCCEEDED');
 assert.equal((await f.worker.processOne({workerId:'duplicate-token'})).kind,'EMPTY');
 assert.equal(controls.remoteSends,1);assert.equal(f.sends(),1);assert.equal(f.command.status,'SUCCEEDED');
});

test('lease expiration during an accepted in-flight write prevents finalization and every later send',async()=>{
 let entered,release;const started=new Promise(resolve=>{entered=resolve;}),response=new Promise(resolve=>{release=resolve;});
 let expired=false;
 const controls={heartbeatMs:5,renewalTimeoutMs:20,
  renew:()=>expired?{rows:[],rowCount:0}:{rows:[{id:'cmd'}],rowCount:1},
  transport:async()=>{entered();await response;return {};},
  execute:async({shopifyClient})=>{await shopifyClient.applyMutation({values:{title:'Updated'}});await shopifyClient.applyMutation({values:{title:'Must not send'}});return {state:'VERIFIED'};}};
 const f=fixture('bulk_edit',2,controls),processing=f.worker.processOne({workerId:'expiring'});await started;
 expired=true;controls.lost=true;
 assert.equal((await processing).kind,'STALE_CLAIM');release();await delay(40);
 assert.equal(controls.remoteSends,1);assert.ok(f.items.every(item=>item.status==='PENDING'));
 assert.equal(f.finalTask(),undefined);assert.equal(f.command.status,'RUNNING');
});
