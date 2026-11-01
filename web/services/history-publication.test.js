import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoryExecutionAdapter} from './history-execution-adapter.server.js';
const tenant={shopId:'publication.myshopify.com',installationId:'installation'};

test('history acquires the canonical shared shop barrier before reading installation state',async()=>{
 const calls=[],adapter=createHistoryExecutionAdapter();
 await adapter.assertTenant({tenant,client:{async query(sql,params){calls.push({sql,params});return{rows:sql.includes('FROM mirror.shops')?[{installation_version:'installation'}]:[]};}}});
 const advisory=calls.findIndex(call=>call.sql.includes('pg_advisory_xact_lock_shared'));
 const installation=calls.findIndex(call=>call.sql.includes('FROM mirror.shops'));
 assert.ok(advisory>=0&&advisory<installation);assert.deepEqual(calls[advisory].params,[tenant.shopId]);
});

test('one-use dispatch requires locking the exact still-published approval coordinates',async()=>{
 const adapter=createHistoryExecutionAdapter(),claim={fenceEpoch:'1',leaseToken:'token'};
 for(const current of [true,false]){
  let checked=false;
  const client={async query(sql){
   if(sql.includes('JOIN mirror.publications pub')){
    checked=true;assert.match(sql,/pub.generation_id=s.generation_id/);assert.match(sql,/pub.coverage_revision=s.coverage_revision/);
    assert.match(sql,/pub.mapping_version=s.mapping_version/);assert.match(sql,/FOR SHARE OF pub/);return{rows:current?[{id:'1'}]:[]};
   }
   return{rows:[{id:'1'}]};
  }};
  if(current)await adapter.assertDispatchClaim({client,tenant,jobId:'1',claim});
  else await assert.rejects(()=>adapter.assertDispatchClaim({client,tenant,jobId:'1',claim}),{code:'HISTORY_OWNERSHIP_LOST'});
  assert.equal(checked,true);
 }
});
