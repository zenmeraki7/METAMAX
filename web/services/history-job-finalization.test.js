import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
mock.module('./approval.server.js',{namedExports:{async getEvidenceContractInTransaction(){return{executionAuthority:{installationId:'installation',approvedContractHash:'sha256:approved'}};}}});
const {createHistoryJobFinalizer}=await import('../edit-history/job-finalization.server.js');

function fixture({status='FAILED',verified=1,unresolved=0,incomplete=false,authorize=true}={}){
 const calls=[],tenant={shopId:'job.myshopify.com',installationId:'installation'};let permissionCalls=0;
 const tx={async query(sql,p){calls.push({sql,p});
  if(sql.includes('SELECT status,contract_id'))return{rows:[{status,contract_id:'contract'}]};
  if(sql.includes('SELECT count(*)::int AS total'))return{rows:[{total:2,verified,unresolved}]};
  if(sql.includes('SELECT i.id FROM mirror.job_items')){
   assert.match(sql,/r.resource_field_set @>/);assert.match(sql,/c.execution_item_id=i.id AND c.resource_gid=i.resource_id/);
   assert.match(sql,/s.snapshot_kind='OBSERVED_AFTER'/);return{rows:incomplete?[{id:'missing-evidence'}]:[]};
  }
  if(sql.includes('SELECT id FROM edit_history.operations'))return{rows:[]};
  if(sql.includes('UPDATE edit_history.operations')){
   assert.match(sql,/execution_job_id=\$3/);assert.doesNotMatch(sql,/AND id=\$/);return{rows:[{id:'op-one'},{id:'op-two'}],rowCount:2};
  }
  return{rows:[],rowCount:0};
 },release(){}};
 const finalize=createHistoryJobFinalizer({database:{async connect(){return tx;}},resolveTenant:async()=>tenant,
  authorizeRecovery:async()=>{permissionCalls++;return typeof authorize==='function'?authorize(permissionCalls):authorize;},
  executionAdapter:{async beginScope(){},async assertTenant({client}){assert.equal(client,tx);}}});
 return{calls,run:()=>finalize({authContext:{},executionJobId:'10',expectedTenant:tenant})};
}
test('command-wide finalization covers every operation and preserves partial outcome',async()=>{
 const f=fixture();const result=await f.run();assert.equal(result.completed,true);assert.equal(result.state,'PARTIAL');assert.equal(result.updatedOperations,2);
 const update=f.calls.find(call=>call.sql.includes('UPDATE edit_history.operations'));assert.deepEqual(update.p,['job.myshopify.com','installation','10','PARTIAL']);
});
for(const options of [{unresolved:1},{incomplete:true},{status:'RUNNING'}])test(`command finalization waits for complete terminal evidence ${JSON.stringify(options)}`,async()=>{
 const f=fixture(options);assert.equal((await f.run()).completed,false);assert.equal(f.calls.some(call=>call.sql.includes('UPDATE edit_history.operations')),false);
});
test('a recovered failed-no-write attempt does not make an entirely successful command partial',async()=>{
 const f=fixture({status:'SUCCEEDED',verified:1});assert.equal((await f.run()).state,'COMPLETED');
});
test('revoked finalization permission rolls back and never acknowledges completion',async()=>{
 const f=fixture({authorize:count=>count===1});await assert.rejects(f.run,{code:'HISTORY_UNAUTHORIZED'});
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');assert.equal(f.calls.some(call=>call.sql==='COMMIT'),false);
});
