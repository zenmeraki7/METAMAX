import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncDispatchRepository} from './sync-dispatch-repository.server.js';
import {dispatchJobId} from '../workers/sync-dispatcher.js';

function fixture() {
  let connections=0;
  const repository=createSyncDispatchRepository({database:{connect(){connections++;throw new Error('Unexpected SQL');}}});
  return {repository,connections:()=>connections};
}
const receipt={dispatchId:'delivery',dispatchToken:'token',kind:'SYNC',runId:'run',deliveryKey:'logical-key'};
test('dispatch persistence requires a PostgreSQL driver',()=>{
  assert.throws(()=>createSyncDispatchRepository(),/PostgreSQL/);
  assert.throws(()=>createSyncDispatchRepository({database:{}}),/PostgreSQL/);
});
test('dispatch discovery and expiry scanner enforce bounded limits before any SQL',async()=>{
  const f=fixture();
  await assert.rejects(()=>f.repository.reserveDispatchBatch({limit:2}),RangeError);
  for(const options of [{limit:0},{limit:251},{limit:1.2},{reservationSeconds:9},{reservationSeconds:3601}]) {
    await assert.rejects(()=>f.repository.reserveDispatchBatch(options),RangeError);
  }
  for(const limit of [0,251,-1,NaN])await assert.rejects(()=>f.repository.recoverExpiredReservations({limit}),RangeError);
  assert.equal(f.connections(),0);
});
test('standalone consumption and unverified mapping capabilities cannot authorize SQL',async()=>{
  const f=fixture();
  await assert.rejects(()=>f.repository.acknowledgeConsumptionInTransaction({tx:{},claim:{}}),/fresh execution claim transaction/);
  assert.throws(()=>createSyncDispatchRepository({database:{connect(){}},mapping:{runs:{table:'mirror.catalog_import_executions'}}}),/Genuine physically verified/);
  assert.equal(f.connections(),0);
});
test('V3 callback types and retry budgets are validated without invoking methods on functions',()=>{
  const database={connect(){assert.fail('Unexpected SQL');}};
  for(const name of ['verifyShop','needsRecovery','verifyRecoveryDecision','verifyConsumption']) {
    assert.throws(()=>createSyncDispatchRepository({database,[name]:{call(){}}}),/callback/);
  }
  assert.throws(()=>createSyncDispatchRepository({database,maxDispatchAttempts:0}),RangeError);
  assert.throws(()=>createSyncDispatchRepository({database,maxRunAttempts:13}),RangeError);
  const callback=()=>true;Object.defineProperty(callback,'call',{get(){assert.fail('Function .call accessed');}});
  assert.ok(createSyncDispatchRepository({database,verifyShop:callback}));
});
test('acknowledgment and failure receipts validate identities and logical delivery before SQL',async()=>{
  const f=fixture();
  for(const change of [{dispatchId:''},{dispatchToken:'bad token'},{kind:'unknown'},{runId:42},
    {deliveryKey:''},{deliveryKey:'x'.repeat(129)}]) {
    await assert.rejects(()=>f.repository.markDispatched({...receipt,...change,jobId:dispatchJobId(receipt)}));
    await assert.rejects(()=>f.repository.markDispatchFailure({...receipt,...change,code:'REDIS_UNKNOWN'}));
  }
  await assert.rejects(()=>f.repository.markDispatched({...receipt,jobId:'wrong'}),/logical job/);
  await assert.rejects(()=>f.repository.markDispatchFailure({...receipt,code:'secret details'}),/failure code/);
  assert.equal(f.connections(),0);
});
test('accessor-backed or inherited dispatch scopes cannot invoke application code or SQL',async()=>{
  const f=fixture();
  for(const key of Object.keys(receipt)) {
    const bad={...receipt};Object.defineProperty(bad,key,{get(){assert.fail('Getter invoked');}});
    Object.defineProperty(bad,'jobId',{value:dispatchJobId(receipt)});
    await assert.rejects(()=>f.repository.markDispatched(bad));
    Object.defineProperty(bad,'code',{value:'REDIS_UNKNOWN'});
    await assert.rejects(()=>f.repository.markDispatchFailure(bad));
  }
  await assert.rejects(()=>f.repository.markDispatchFailure(Object.assign(Object.create(receipt),{code:'REDIS_UNKNOWN'})));
  assert.equal(f.connections(),0);
});
