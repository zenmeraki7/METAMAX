import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHistoryRepository } from '../history-repository.server.js';
import { normalizeHistorySnapshot,normalizeMutationIntent,normalizeMutationAttempt } from '../history-contract.js';

export async function testRepositoryAuthority(t,fixture,pool){
 await t.test('multi-resource envelopes replay through integrated authority without new fingerprints or duplicate history',async()=>{
  const f=await fixture();
  const first=await f.repository.prepareRequest(f.input);
  assert.equal(first.existing,false);
  const envelope=(await f.q('SELECT * FROM edit_history.mutation_requests WHERE shop_id=$1',[f.shopId])).rows[0];
  assert.equal(envelope.field_count,2);
  assert.equal(envelope.request_state,'PREPARED');
  const replay=await f.repository.prepareRequest(f.input);assert.equal(replay.existing,true);assert.deepEqual(replay.fields,first.fields);
  const dispatch=await f.repository.beginDispatch(f.input);
  assert.equal(dispatch.state,'DISPATCHING');
  const consumed=await f.repository.consumeDispatch({authContext:f.input.authContext,operationId:f.input.operationId,
   mutationId:f.input.mutationId,attemptId:f.plan.attemptId,claim:f.input.claim,dispatchToken:dispatch.dispatchToken});
  assert.equal(consumed.consumed,true);
  assert.equal((await f.q('SELECT changes_recorded FROM edit_history.operations WHERE shop_id=$1',[f.shopId])).rows[0].changes_recorded,'2');
 });
 await t.test('integrated authority holds the engine lock and journal writes on one transaction until COMMIT',async()=>{
  const f=await fixture(),probe=await pool.adminConnect(),ids=[];let writes=0,ownerReads=0,grants=0,resume,entered;
  const paused=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{resume=resolve;});
  const database={async connect(){const client=await pool.connect();return{release:()=>client.release(),async query(sql,values){
   if(sql.includes('INSERT INTO edit_history.snapshots')||sql.includes('mirror.job_commands')&&sql.includes('FOR UPDATE')){
    ids.push((await client.query('SELECT txid_current()::text AS id')).rows[0].id);
    if(sql.includes('INSERT INTO edit_history.snapshots'))writes++;else ownerReads++;
   }
   return client.query(sql,values);
  }};}};
  const repository=createHistoryRepository({database,...f.adapters,authorizePlan:async context=>{
   ids.push((await context.client.query('SELECT txid_current()::text AS id')).rows[0].id);
   if(++grants===2){entered();await gate;}return f.adapters.authorizePlan(context);
  }});
  const pending=repository.prepareRequest(f.input);let timeout;
  try{
   await Promise.race([paused,pending.then(()=>assert.fail('Admission did not reach the authority')),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Authority gate not reached')),3000);})]);
   assert.equal((await probe.query('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1',[f.shopId])).rows[0].count,'0');
   await probe.query('BEGIN');await probe.query("SET LOCAL lock_timeout='100ms'");
   await assert.rejects(()=>probe.query('UPDATE mirror.job_commands SET fence=fence+1 WHERE shop_id=$1 AND id=$2',[f.shopId,f.command]),{code:'55P03'});
   await probe.query('ROLLBACK');resume();
   const receipt=await pending;assert.equal(receipt.state,'PREPARED');assert.equal(receipt.dispatchToken,undefined);
   assert.equal(new Set(ids).size,1);assert.equal(writes,2);assert.ok(ownerReads>=3);assert.ok(grants>=4);
   assert.equal((await probe.query('SELECT count(*) FROM edit_history.changes WHERE shop_id=$1',[f.shopId])).rows[0].count,'2');
   assert.equal((await probe.query('SELECT count(*) FROM edit_history.snapshots WHERE shop_id=$1',[f.shopId])).rows[0].count,'2');
   await probe.query('UPDATE mirror.job_commands SET fence=fence+1 WHERE shop_id=$1 AND id=$2',[f.shopId,f.command]);
   await assert.rejects(()=>repository.beginDispatch(f.input),{code:'HISTORY_OWNERSHIP_LOST'});
  }finally{clearTimeout(timeout);resume();await pending.catch(()=>{});await probe.query('ROLLBACK').catch(()=>{});probe.release();}
 });

 await t.test('a journal failure after authority approval rolls back the envelope, every snapshot and dispatch eligibility',async()=>{
  const f=await fixture();let snapshots=0,commits=0,grants=0;
  const database={async connect(){const client=await pool.connect();return{release:()=>client.release(),async query(sql,values){
   if(sql==='COMMIT')commits++;
   if(sql.includes('INSERT INTO edit_history.snapshots')&&++snapshots===2)throw Error('Injected second snapshot failure');
   return client.query(sql,values);
  }};}};
  const repository=createHistoryRepository({database,...f.adapters,authorizePlan:async context=>{grants++;return f.adapters.authorizePlan(context);}});
  await assert.rejects(()=>repository.prepareRequest(f.input),/Injected second snapshot failure/);assert.ok(grants>=3);assert.equal(commits,0);
  for(const table of ['operations','mutation_requests','changes','snapshots'])assert.equal((await f.q(`SELECT count(*) FROM edit_history.${table} WHERE shop_id=$1`,[f.shopId])).rows[0].count,'0');
  await assert.rejects(()=>f.repository.beginDispatch(f.input));
  assert.equal((await f.q("SELECT count(*) FROM edit_history.mutation_requests WHERE shop_id=$1 AND request_state='DISPATCH_AUTHORIZED'",[f.shopId])).rows[0].count,'0');
 });

 await t.test('resource-pair admission cannot borrow the first item ownership or authorize an unselected resource',async()=>{
  const f=await fixture({extraProduct:true}),first=f.input.entries[0],identity={...first.intent.identity,resourceGid:'gid://shopify/Product/2'};
  const source=first.beforeSnapshot.observation;
  const beforeSnapshot=normalizeHistorySnapshot({identity,binding:first.intent.binding,kind:'BEFORE',valueKind:'VALUE',value:'Before',
   observation:{...Object.fromEntries(['source','observedAt','fieldId','sourceRevision','receiptFingerprint'].map(key=>[key,source[key]])),
    resourceGid:identity.resourceGid,observationId:randomUUID(),receiptId:randomUUID()}});
  const intent=normalizeMutationIntent({identity,binding:first.intent.binding,beforeSnapshotFingerprint:beforeSnapshot.fingerprint,
   intendedValueKind:'VALUE',intendedValue:'After',mutationPlanFingerprint:f.plan.mutationPlanFingerprint});
  const attempt=normalizeMutationAttempt({identity,...Object.fromEntries(['attemptId','attemptNumber','fenceEpoch','executionClaimId','startedAt'].map(key=>[key,first.attempt[key]]))});
  const entries=[first,{beforeSnapshot,intent,attempt,resourceFamilyGid:identity.resourceGid}];
  await f.persistPlan({...f.plan,fields:entries.map(e=>({identity:e.intent.identity,binding:e.intent.binding,resourceFamilyGid:e.resourceFamilyGid,
   intendedValueKind:e.intent.intendedValueKind,intendedValue:e.intent.intendedValue}))});
  await assert.rejects(()=>f.repository.prepareRequest({...f.input,entries}),{code:'HISTORY_BINDING_CONFLICT',message:'Mutation resource is not part of the exact approved targeting snapshot'});
  assert.equal((await f.q('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1',[f.shopId])).rows[0].count,'0');
 });
}
