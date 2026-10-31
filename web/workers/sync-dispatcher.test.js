import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {createSyncDispatcher,dispatchJobId,SYNC_DISPATCH_QUEUE,RECOVERY_DISPATCH_QUEUE} from './sync-dispatcher.js';
import {SYNC_QUEUE_NAME} from './sync.worker.js';

const reservation=(n=1,kind='SYNC')=>({dispatchId:`dispatch-${n}`,dispatchToken:`token-${n}`,kind,runId:`run-${n}`,deliveryKey:`shop-a-run-${n}-phase-1`});
const deferred=()=>Promise.withResolvers();
function fixture({batch=[reservation()],repo={},syncAdd,recoveryAdd,options={}}={}) {
  const calls={reserve:[],sync:[],recovery:[],ack:[],failure:[],order:[]};
  const remaining=[...batch];
  const repository={
    async reserveDispatchBatch(input){calls.reserve.push(input);calls.order.push('reserve');return remaining.length?[remaining.shift()]:[];},
    async markDispatched(input){calls.ack.push(input);calls.order.push('ack');return {kind:'RECORDED'};},
    async markDispatchFailure(input){calls.failure.push(input);return {kind:'RECORDED'};},...repo,
  };
  const syncQueue={async add(...args){calls.sync.push(args);calls.order.push('sync');return syncAdd?syncAdd(...args):{id:args[2].jobId};}};
  const recoveryQueue={async add(...args){calls.recovery.push(args);calls.order.push('recovery');return recoveryAdd?recoveryAdd(...args):{id:args[2].jobId};}};
  const settings={repository,syncQueue,recoveryQueue,logger:{info(){},error(){}},queueTimeoutMs:100,ackTimeoutMs:100,reservationSeconds:10,...options};
  return {dispatcher:createSyncDispatcher(settings),calls,settings};
}

test('dispatcher validates dependencies, bounded settings and reservation budget',()=>{
  assert.throws(()=>createSyncDispatcher(),/reserveDispatchBatch/);
  const {settings}=fixture();
  for(const method of ['reserveDispatchBatch','markDispatched','markDispatchFailure']) {
    assert.throws(()=>createSyncDispatcher({...settings,repository:{...settings.repository,[method]:null}}),new RegExp(method));
  }
  for(const queue of ['syncQueue','recoveryQueue'])assert.throws(()=>createSyncDispatcher({...settings,[queue]:{}}),/add/);
  for(const options of [{maxDeliveriesPerCycle:0},{maxDeliveriesPerCycle:251},{reservationSeconds:9},
    {reservationSeconds:3601},{queueTimeoutMs:99},{ackTimeoutMs:60001},{queueTimeoutMs:3000,ackTimeoutMs:3000}]) {
    assert.throws(()=>fixture({options}),RangeError);
  }
});

test('reserves one immediately before use and emits runId-only notifications to the correct queues',async()=>{
  assert.equal(SYNC_DISPATCH_QUEUE,SYNC_QUEUE_NAME);
  const {dispatcher,calls}=fixture({batch:[reservation(),reservation(2,'RECOVERY')]});
  const result=await dispatcher.runOnce();
  assert.equal(result.kind,'COMPLETED');assert.equal(result.dispatched,2);assert.equal(result.stopReason,'NO_DUE_WORK');
  assert.deepEqual(calls.reserve,[1,2,3].map(()=>({limit:1,reservationSeconds:10})));
  assert.deepEqual(calls.order,['reserve','sync','ack','reserve','recovery','ack','reserve']);
  for(const [name,data,options] of [calls.sync[0],calls.recovery[0]]) {
    assert.ok([SYNC_DISPATCH_QUEUE,RECOVERY_DISPATCH_QUEUE].includes(name));
    assert.deepEqual(Object.keys(data),['runId']);assert.equal(options.attempts,1);
    assert.equal(options.removeOnComplete,true);assert.equal(options.removeOnFail,true);
    assert.match(options.jobId,/^metamax-(sync|recovery)-[a-f0-9]{64}$/);
  }
  assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(dispatcher));
});

test('job identity stays stable across reservation expiry and is distinct across delivery key and dispatch kind',async()=>{
  const first=reservation();
  const f=fixture({batch:[first,{...first,dispatchId:'replacement',dispatchToken:'new-token'},
    {...reservation(3,'RECOVERY'),runId:first.runId,deliveryKey:first.deliveryKey},reservation(4)]});
  await f.dispatcher.runOnce();
  assert.equal(f.calls.sync[0][2].jobId,f.calls.sync[1][2].jobId);
  assert.notEqual(f.calls.sync[0][2].jobId,f.calls.sync[2][2].jobId);
  assert.notEqual(f.calls.sync[0][2].jobId,f.calls.recovery[0][2].jobId);
  assert.equal(f.calls.ack[1].dispatchToken,'new-token');
  assert.equal(f.calls.ack[1].deliveryKey,first.deliveryKey);
});

test('exported job identity uses the exact kind and deliveryKey hash contract',()=>{
  const digest=createHash('sha256').update('SYNC').update('\0').update('durable-key').digest('hex');
  assert.equal(dispatchJobId({kind:'SYNC',deliveryKey:'durable-key'}),`metamax-sync-${digest}`);
  for(const deliveryKey of [undefined,null,42,'','bad:key','a'.repeat(129)]) {
    assert.throws(()=>dispatchJobId({kind:'SYNC',deliveryKey}),/deliveryKey/);
  }
  for(const kind of ['UNKNOWN','sync',undefined]) {
    assert.throws(()=>dispatchJobId({kind,deliveryKey:'valid'}),{code:'INVALID_KIND'});
  }
});

test('a retained prior phase job cannot suppress the next phase or another shop delivery',async()=>{
  const first=reservation();
  const retry={...first,dispatchId:'retry',dispatchToken:'retry-token'};
  const next={...first,dispatchId:'next-phase',deliveryKey:'shop-a-run-1-phase-2'};
  const otherShop={...first,dispatchId:'other-shop',deliveryKey:'shop-b-run-1-phase-1'};
  const retained=new Map();
  const f=fixture({batch:[first,retry,next,otherShop],syncAdd:async(name,data,options)=>{
    if(!retained.has(options.jobId))retained.set(options.jobId,{id:options.jobId,name,data});
    return retained.get(options.jobId);
  }});
  assert.equal((await f.dispatcher.runOnce()).dispatched,4);
  assert.equal(retained.size,3);
  assert.equal(f.calls.sync[0][2].jobId,f.calls.sync[1][2].jobId);
  assert.notEqual(f.calls.sync[0][2].jobId,f.calls.sync[2][2].jobId);
  assert.notEqual(f.calls.sync[0][2].jobId,f.calls.sync[3][2].jobId);
});

test('cycle bounds and duplicate reservation checks prevent repeated delivery',async()=>{
  const bounded=fixture({batch:[reservation(),reservation(2)],options:{maxDeliveriesPerCycle:1}});
  assert.equal((await bounded.dispatcher.runOnce()).scanned,1);assert.equal(bounded.calls.reserve.length,1);
  const duplicate=fixture({batch:[reservation(),reservation()]});
  const result=await duplicate.dispatcher.runOnce();
  assert.equal(result.stopReason,'DUPLICATE_RESERVATION');assert.equal(result.errors,1);assert.equal(duplicate.calls.sync.length,1);
});

test('malformed batches and accessor-backed reservations cannot reach queues',async()=>{
  let getters=0;
  const accessor={...reservation()};Object.defineProperty(accessor,'kind',{get(){getters++;return 'SYNC';}});
  const keyAccessor={...reservation()};Object.defineProperty(keyAccessor,'deliveryKey',{get(){getters++;return 'key';}});
  const missingKey=reservation();delete missingKey.deliveryKey;
  const inheritedKey=Object.assign(Object.create({deliveryKey:'inherited'}),missingKey);
  const array=[];Object.defineProperty(array,0,{get(){getters++;return reservation();}});
  for(const batch of [null,{},[reservation(),reservation(2)],[undefined],[accessor],[keyAccessor],[missingKey],[inheritedKey],array,
    [{...reservation(),kind:'UNKNOWN'}],[{...reservation(),runId:'bad run'}],
    ...[undefined,null,42,'','bad:key','a'.repeat(129)].map(deliveryKey=>[{...reservation(),deliveryKey}])]) {
    const f=fixture({repo:{async reserveDispatchBatch(){return batch;}}});
    const result=await f.dispatcher.runOnce();
    assert.equal(result.stopReason,'RESERVATION_FAILED');assert.equal(f.calls.sync.length,0);assert.equal(f.calls.failure.length,0);
  }
  assert.equal(getters,0);
});

test('a queue failure records uncertainty independently and later reservations still deliver',async()=>{
  const f=fixture({batch:[reservation(),reservation(2)],syncAdd:async(_name,data,options)=>{
    if(data.runId==='run-1')throw Object.assign(new Error('unavailable'),{code:'REDIS_UNAVAILABLE'});
    return {id:options.jobId};
  }});
  const result=await f.dispatcher.runOnce();
  assert.equal(result.uncertain,1);assert.equal(result.dispatched,1);assert.equal(result.kind,'PARTIAL');
  assert.deepEqual(f.calls.failure,[{...reservation(),code:'REDIS_UNAVAILABLE'}]);assert.equal(f.calls.ack.length,1);
});

test('failure-recording errors and malformed receipts cannot authorize a delivery acknowledgment',async()=>{
  for(const receipt of [null,{kind:'UNKNOWN'},{get kind(){assert.fail('getter invoked');}}]) {
    const f=fixture({batch:[reservation(),reservation(2)],syncAdd:async()=>{throw new Error('lost response');},
      repo:{async markDispatchFailure(){return receipt;}}});
    assert.equal((await f.dispatcher.runOnce()).uncertain,2);assert.equal(f.calls.ack.length,0);
  }
});

test('unverified queue receipts are uncertain and cannot be acknowledged as dispatched',async()=>{
  for(const job of [undefined,{id:'wrong-job'}]) {
    const f=fixture({syncAdd:async()=>job});
    assert.equal((await f.dispatcher.runOnce()).uncertain,1);assert.equal(f.calls.ack.length,0);assert.equal(f.calls.failure.length,1);
  }
});

test('lost or invalid DB acknowledgments never re-enqueue or issue a compensating failure write',async()=>{
  for(const result of [null,{kind:'UNKNOWN'},new Error('commit response lost')]) {
    const f=fixture({repo:{async markDispatched(){if(result instanceof Error)throw result;return result;}}});
    assert.equal((await f.dispatcher.runOnce()).ackUnknown,1);
    assert.equal(f.calls.sync.length,1);assert.equal(f.calls.failure.length,0);
  }
  const stale=fixture({repo:{async markDispatched(){return {kind:'STALE_CLAIM'};}}});
  assert.equal((await stale.dispatcher.runOnce()).stale,1);
});

test('queue timeout stops the cycle and excludes later cycles until the actual operation settles',async()=>{
  const pending=deferred();let adds=0;
  const f=fixture({batch:[reservation(),reservation(2)],syncAdd:async(_name,_data,options)=>{
    if(++adds===1)await pending.promise;return {id:options.jobId};
  }});
  const result=await f.dispatcher.runOnce();
  assert.equal(result.stopReason,'UNRESOLVED_ASYNC_OPERATION');assert.equal(result.uncertain,1);
  assert.deepEqual(await f.dispatcher.runOnce(),{kind:'ASYNC_OPERATION_PENDING'});
  assert.equal(f.calls.reserve.length,1);assert.equal(f.calls.failure[0].code,'OPERATION_TIMEOUT');
  pending.resolve();await delay(0);
  assert.equal(f.calls.ack.length,0); // A late queue response has no acknowledgment continuation.
  assert.equal((await f.dispatcher.runOnce()).dispatched,1);
});

test('a late enqueue rejection is observed and releases exclusion without a late acknowledgment',async()=>{
  const pending=deferred();let adds=0;
  const f=fixture({batch:[reservation(),reservation(2)],syncAdd:async(_name,_data,options)=>{
    if(++adds===1)return pending.promise;
    return {id:options.jobId};
  }});
  assert.equal((await f.dispatcher.runOnce()).uncertain,1);
  assert.equal((await f.dispatcher.runOnce()).kind,'ASYNC_OPERATION_PENDING');
  pending.reject(new Error('late Redis rejection'));await delay(0);
  assert.equal(f.calls.failure.length,1);assert.equal(f.calls.ack.length,0);
  assert.equal((await f.dispatcher.runOnce()).dispatched,1);
});

test('settling a timed-out enqueue cannot release exclusion while its DB failure record remains unresolved',async()=>{
  const enqueue=deferred(),record=deferred();let adds=0;
  const f=fixture({batch:[reservation(),reservation(2)],syncAdd:async(_name,_data,options)=>{
    if(++adds===1)return enqueue.promise;
    return {id:options.jobId};
  },repo:{async markDispatchFailure(){return record.promise;}}});
  assert.equal((await f.dispatcher.runOnce()).stopReason,'UNRESOLVED_ASYNC_OPERATION');
  enqueue.resolve({id:'late-response'});await delay(0);
  assert.equal((await f.dispatcher.runOnce()).kind,'ASYNC_OPERATION_PENDING');
  assert.equal(f.calls.reserve.length,1);assert.equal(f.calls.sync.length,1);
  record.resolve({kind:'RECORDED'});await delay(0);
  assert.equal((await f.dispatcher.runOnce()).dispatched,1);
});

test('a timed-out enqueue still ends the cycle when it settles during failure recording',async()=>{
  const pending=deferred();
  const f=fixture({batch:[reservation(),reservation(2)],syncAdd:async()=>pending.promise,
    repo:{async markDispatchFailure(){pending.resolve({id:'late'});await delay(0);return {kind:'RECORDED'};}}});
  const result=await f.dispatcher.runOnce();
  assert.equal(result.stopReason,'UNRESOLVED_ASYNC_OPERATION');assert.equal(f.calls.sync.length,1);
});

test('reservation timeout leaves late reservations for expiry and cannot dispatch them',async()=>{
  const pending=deferred();
  const f=fixture({repo:{async reserveDispatchBatch(){return pending.promise;}}});
  assert.equal((await f.dispatcher.runOnce()).stopReason,'RESERVATION_FAILED');
  assert.equal((await f.dispatcher.runOnce()).kind,'ASYNC_OPERATION_PENDING');
  pending.resolve([reservation()]);await delay(0);
  assert.equal(f.calls.sync.length,0);assert.equal(f.calls.failure.length,0);
});

test('acknowledgment and failure-record timeouts remain bounded without overlapping later cycles',async()=>{
  for(const stage of ['ack','failure']) {
    const pending=deferred();
    const f=fixture({batch:[reservation(),reservation(2)],
      ...(stage==='failure'?{syncAdd:async()=>{throw new Error('unknown enqueue');}}:{}),
      repo:stage==='ack'?{async markDispatched(){return pending.promise;}}:{async markDispatchFailure(){return pending.promise;}}});
    const result=await f.dispatcher.runOnce();
    assert.equal(result.stopReason,'UNRESOLVED_ASYNC_OPERATION');
    assert.equal(stage==='ack'?result.ackUnknown:result.uncertain,1);
    assert.equal((await f.dispatcher.runOnce()).kind,'ASYNC_OPERATION_PENDING');
    assert.equal(f.calls.sync.length,1);
    pending.reject(new Error('late rejection'));await delay(0);
  }
});

test('overlapping runOnce calls cannot reserve independently and logger failures do not affect outcomes',async()=>{
  const pending=deferred(),started=deferred();
  const f=fixture({repo:{async reserveDispatchBatch(){started.resolve();return pending.promise;}},
    options:{logger:{info(){return Promise.reject(new Error('logger'));},error(){throw new Error('logger');}}}});
  const run=f.dispatcher.runOnce();await started.promise;
  assert.equal((await f.dispatcher.runOnce()).kind,'ALREADY_RUNNING');
  pending.resolve([]);assert.equal((await run).kind,'COMPLETED');await delay(0);
  const failure=fixture({syncAdd:async()=>{throw new Error('queue');},options:{logger:{error(){throw new Error('logger');}}}});
  assert.equal((await failure.dispatcher.runOnce()).uncertain,1);
});
