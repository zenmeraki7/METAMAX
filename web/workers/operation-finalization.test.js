import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperationFinalizer} from './operation-finalization.server.js';
function fixture({undo=false,attempts=0,history,undoHook,timeoutMs=1000}={}){
 const task={shop_id:'finalize.myshopify.com',command_id:'1',installation_version:'installation',execution_fence:'7',item_id:'2',history_pending:true,undo_pending:undo,attempts,fence:0,state:'PENDING'};
 const state={lost:false,due:true,historyCalls:0,undoCalls:0,alerts:[]};const calls=[];
 const rows=values=>({rows:values,rowCount:values.length});
 const query=async(sql,p=[])=>{calls.push({sql,p});
  if(sql.startsWith('INSERT INTO mirror.operation_finalizations'))return rows([]);
  if(sql.includes("SET state='REVIEW_REQUIRED'")){
   if(task.attempts<8)return rows([]);task.state='REVIEW_REQUIRED';state.due=false;return rows([{shop_id:task.shop_id,command_id:task.command_id}]);
  }
  if(sql.includes('WITH due AS(SELECT f.shop_id')){if(!state.due||!['PENDING','RETRY'].includes(task.state))return rows([]);Object.assign(task,{state:'RUNNING',fence:task.fence+1,attempts:task.attempts+1,lease_token:p[2]});return rows([{...task}]);}
  if(sql.includes('UPDATE mirror.operation_finalizations f SET history_pending')){
   assert.match(sql,/c.fence=f.execution_fence/);assert.match(sql,/f.lease_until>clock_timestamp/);
   assert.equal(p[2],task.fence);assert.equal(p[3],task.lease_token);
   if(state.lost)return rows([]);
   Object.assign(task,{history_pending:p[4],undo_pending:p[5],state:p[6],last_error:p[7]});if(p[6]!=='RUNNING')state.due=false;return rows([{command_id:'1'}]);
  }
  if(sql.includes('SELECT * FROM mirror.job_commands WHERE'))return rows([{id:'1',shop_id:task.shop_id,installation_version:'installation',fence:'7',kind:undo?'undo':'bulk_edit',status:'SUCCEEDED'}]);
  if(sql.includes('SELECT id,resource_id,intended_values FROM mirror.job_items'))return rows([{id:'2',resource_id:'gid://shopify/Product/1',intended_values:{title:'Approved'}}]);
  if(/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT set_config)/.test(sql))return rows([]);
  throw Error(sql);
 };
 const finalizer=createOperationFinalizer({database:{async connect(){return {query,release(){}};}},timeoutMs,logger:{error(data){state.alerts.push(data);}},
  historyExecution:{async finalize(input){state.historyCalls++;return history?history(input,state):{completed:true};}},
  undoRepository:{async reconcileExecutionForWorker(input){state.undoCalls++;return undoHook?undoHook(input,state):{state:'COMPLETED'};}}});
 return {task,state,calls,run:()=>finalizer.runOne({workerId:'finalizer'})};
}
test('history finalization failure is durable, backed off and retried without a mutation',async()=>{
 let failed=true;const f=fixture({history:()=>{if(failed)throw Error('private backend detail');return {completed:true};}});
 assert.equal((await f.run()).kind,'FINALIZATION_PENDING');assert.equal(f.task.state,'RETRY');assert.equal(f.task.history_pending,true);assert.equal(f.task.last_error,'FINALIZATION_FAILED');
 assert.equal((await f.run()).kind,'EMPTY');failed=false;f.state.due=true;
 assert.equal((await f.run()).kind,'FINALIZED');assert.equal(f.task.state,'SUCCEEDED');assert.equal(f.state.historyCalls,2);
});
test('undo finalization retries only the unfinished local phase',async()=>{
 let failed=true;const f=fixture({undo:true,undoHook:()=>{if(failed)throw Error('undo service failed');return {state:'COMPLETED'};}});
 assert.equal((await f.run()).kind,'FINALIZATION_PENDING');assert.equal(f.task.history_pending,false);assert.equal(f.task.undo_pending,true);
 failed=false;f.state.due=true;assert.equal((await f.run()).kind,'FINALIZED');assert.equal(f.state.historyCalls,1);assert.equal(f.state.undoCalls,2);
});
test('incomplete, timed out and exhausted finalization remains recorded for reconciliation or review',async()=>{
 for(const options of [{history:()=>({completed:false})},{history:()=>new Promise(()=>{}),timeoutMs:5},{history:()=>{throw Error('failed');},attempts:7}]){
  const f=fixture(options);await f.run();assert.equal(f.task.history_pending,true);assert.equal(f.task.state,options.attempts?'REVIEW_REQUIRED':'RETRY');
 }
});
test('stale finalization results cannot acknowledge another fence or continue to undo',async()=>{
 const f=fixture({undo:true,history:(_,state)=>{state.lost=true;return {completed:true};}});
 assert.equal((await f.run()).kind,'STALE_CLAIM');assert.equal(f.state.undoCalls,0);assert.equal(f.task.history_pending,true);assert.equal(f.task.state,'RUNNING');
});
test('a finalizer abandoned on its last attempt is durably escalated and emits a review alert',async()=>{
 const f=fixture({attempts:8});assert.equal((await f.run()).kind,'EMPTY');assert.equal(f.task.state,'REVIEW_REQUIRED');
 assert.equal(f.state.historyCalls,0);assert.equal(f.state.alerts[0].code,'FINALIZATION_RETRY_EXHAUSTED');assert.equal(f.state.alerts[0].reviewRequired,true);
});
