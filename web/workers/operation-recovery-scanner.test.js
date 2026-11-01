import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperationRecoveryScanner} from './operation-recovery-scanner.server.js';
function fixture({fail=false,attempts=0,lost=false}={}){
 const state={due:true,scan:null,calls:0,alerts:[],ack:null};
 const query=async(sql,p=[])=>{
  if(sql.includes('WITH interrupted AS')){
   assert.match(sql,/r.request_state IN\('DISPATCH_AUTHORIZED','ACKNOWLEDGED','OUTCOME_UNKNOWN'\)/);
   assert.match(sql,/j.lease_until<=clock_timestamp\(\)/);assert.match(sql,/s.installation_version=j.installation_version/);assert.match(sql,/FOR UPDATE OF j SKIP LOCKED/);
   if(!state.due)return {rows:[]};state.due=false;
   state.scan={id:'42',shop_id:'recovery.myshopify.com',installation_version:'installation',fence:'7',checkpoint:{recoveryScan:{token:p[0],fence:3,attempts:attempts+1}}};
   return {rows:[structuredClone(state.scan)]};
  }
  if(sql.includes("checkpoint=jsonb_set")){
   assert.deepEqual(p.slice(0,5),['recovery.myshopify.com','42','installation','7',3]);assert.equal(p[10],state.scan.checkpoint.recoveryScan.token);
   assert.match(sql,/nextAttemptAt'\)::timestamptz>clock_timestamp/);assert.match(sql,/j.fence=\$4/);
   if(lost)return {rowCount:0};state.ack=p;return {rowCount:1};
  }
  assert.match(sql,/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/);return {rows:[]};
 };
 const scanner=createOperationRecoveryScanner({database:{async connect(){return{query,release(){}};}},logger:{error(data){state.alerts.push(data);}},historyExecution:{async discoverRecovery(input){
  state.calls++;assert.deepEqual(input,{shopId:'recovery.myshopify.com',installationId:'installation',executionJobId:'42',workerId:'scanner',limit:25});
  if(fail)throw Object.assign(Error('private detail'),{code:'HISTORY_STORE_DOWN'});return{scheduledRequests:1};
 }}});
 return{state,run:()=>scanner.runOne({workerId:'scanner'})};
}
test('scanner independently schedules interrupted journal work and durably checkpoints its next scan',async()=>{
 const f=fixture();assert.equal((await f.run()).kind,'RECOVERY_SCHEDULED');assert.equal(f.state.ack[5],'SCHEDULED');assert.equal(f.state.ack[9],1);
 assert.equal((await f.run()).kind,'EMPTY');assert.equal(f.state.calls,1);
});
test('scanner failure persists backoff and alerts without executing a mutation',async()=>{
 for(const attempts of [0,7]){
  const f=fixture({fail:true,attempts});assert.equal((await f.run()).kind,'RECOVERY_SCAN_PENDING');
  assert.equal(f.state.ack[5],attempts===7?'REVIEW_REQUIRED':'RETRY');assert.equal(f.state.ack[7],'HISTORY_STORE_DOWN');assert.ok(f.state.ack[8]>0&&f.state.ack[8]<=900);
  assert.equal(f.state.alerts[0].reviewRequired,attempts===7);assert.ok(!JSON.stringify(f.state.alerts).includes('private detail'));
 }
});
test('a superseded scan cannot acknowledge another execution fence or lease',async()=>{
 const f=fixture({lost:true});assert.equal((await f.run()).kind,'STALE_CLAIM');assert.equal(f.state.ack,null);
});
