import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
const runtime=await import('../security/runtime-database.server.js');
mock.module('../security/runtime-database.server.js',{namedExports:{...runtime,assertRuntimeDatabaseProfile(database,profile){assert.equal(database.profile,profile);}}});
const {createOperationOutboxDispatcher}=await import('./operation-outbox.server.js');

test('committed import outbox events publish only the command identity scheduling token',async()=>{
 const queued=[];let acknowledged=false;
 const dispatcher=createOperationOutboxDispatcher({database:{profile:'operationWorker',async query(sql){
  if(sql.includes("SET review_required=true"))return{rows:[],rowCount:0};
  if(sql.includes('WITH due AS')){assert.match(sql,/c.kind IN\('bulk_edit','undo','import'\)/);return{rows:[{id:'outbox',shop_id:'import.myshopify.com',command_id:'10',fence:'1',attempts:1}]};}
  if(sql.includes('SELECT kind'))return{rows:[{kind:'import'}]};
  if(sql.includes('SET dispatched_at')){acknowledged=true;return{rows:[],rowCount:1};}
  assert.fail(sql);
 }},queue:{async add(...args){queued.push(args);}}});
 assert.equal((await dispatcher.dispatchNext()).kind,'DISPATCHED');assert.equal(acknowledged,true);
 assert.equal(queued[0][0],'import');assert.deepEqual(queued[0][1],{shopId:'import.myshopify.com',commandId:'10'});
});

test('last failed attempt persists review state and a crashed final claim is independently discovered',async()=>{
 const events=[{shop_id:'a.myshopify.com',command_id:'1'}],alerts=[];let persisted=false;
 const dispatcher=createOperationOutboxDispatcher({logger:{error(data){alerts.push(data);}},database:{profile:'operationWorker',async query(sql){
  if(sql.includes('SET review_required=true')){assert.match(sql,/lease_until<=clock_timestamp/);return{rows:events.splice(0),rowCount:1};}
  if(sql.includes('WITH due AS'))return{rows:[{id:'2',shop_id:'b.myshopify.com',command_id:'2',fence:'7',attempts:8}]};
  if(sql.includes('SELECT kind'))return{rows:[{kind:'bulk_edit'}]};
  if(sql.includes("last_error='QUEUE_DELIVERY_UNCONFIRMED'")){
   persisted=true;assert.match(sql,/review_required=attempts>=8/);assert.match(sql,/lease_until>clock_timestamp/);
   return{rows:[{review_required:true}],rowCount:1};
  }
  assert.fail(sql);
 }},queue:{async add(){throw Error('Queue response lost');}}});
 assert.equal((await dispatcher.dispatchNext()).kind,'REVIEW_REQUIRED');assert.equal(persisted,true);assert.equal(alerts.length,2);
});

test('outbox rejects an arbitrary merchant database at construction',()=>{
 assert.throws(()=>createOperationOutboxDispatcher({database:{profile:'merchant',query(){}},queue:{add(){}}}));
});

test('outbox claims and exhausted-event updates use exact tenant/event joins and eligible live commands',async()=>{
 let queried=0;
 const dispatcher=createOperationOutboxDispatcher({database:{profile:'operationWorker',async query(sql){queried++;
  assert.match(sql,/c.cancel_requested_at IS NULL AND c.status IN\('PENDING','RETRY'\)/);
  assert.match(sql,/s.installation_version=c.installation_version AND s.uninstalled_at IS NULL/);
  if(sql.includes('WITH exhausted'))assert.match(sql,/e.shop_id=x.shop_id AND e.id=x.id/);
  else assert.match(sql,/e.shop_id=due.shop_id AND e.id=due.id/);
  return {rows:[]};}},queue:{async add(){assert.fail('No eligible command');}}});
 assert.equal((await dispatcher.dispatchNext()).kind,'EMPTY');assert.equal(queried,2);
});

test('cancellation or terminal completion after claim suppresses queue delivery with fenced release',async()=>{
 let released=false;
 const dispatcher=createOperationOutboxDispatcher({database:{profile:'operationWorker',async query(sql,params){
  if(sql.includes('WITH exhausted'))return {rows:[]};
  if(sql.includes('WITH due'))return {rows:[{id:'event',shop_id:'cancel.myshopify.com',command_id:'10',fence:'3'}]};
  if(sql.includes('SELECT kind')){assert.match(sql,/c.cancel_requested_at IS NULL AND c.status IN\('PENDING','RETRY'\)/);return {rows:[]};}
  assert.match(sql,/COMMAND_NOT_DISPATCHABLE/);assert.deepEqual(params.slice(0,3),['cancel.myshopify.com','event','3']);released=true;return {rows:[],rowCount:1};
 }},queue:{async add(){assert.fail('Cancelled command was queued');}}});
 assert.equal((await dispatcher.dispatchNext()).kind,'SKIPPED');assert.equal(released,true);
});
