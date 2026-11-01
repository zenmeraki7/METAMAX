import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatalogImportService} from './catalog-import.server.js';
import {createReconciliationService} from '../mirror/reconciliation-service.server.js';
import {handleWebhookEvent} from '../privacy.js';

const shop='refresh-test.myshopify.com', installation='install-1';
const session={id:`offline_${shop}`,shop,isOnline:false,scope:'read_products',accessToken:'test'};
function events() {
  let state={receipts:{},journal:{},changes:{},refreshes:0},backup;
  const statements=[];
  let failProduct=null,failRefresh=false;
  const client={release(){},async query(sql,values=[]) {
    statements.push(sql);
    if(sql.startsWith('BEGIN'))backup=structuredClone(state);
    if(sql==='ROLLBACK')state=backup;
    if(sql.includes('SELECT payload_hash,topic FROM mirror.webhook_receipts'))return{rows:state.receipts[values[1]]?[state.receipts[values[1]]]:[]};
    if(sql.includes('INSERT INTO mirror.webhook_receipts'))state.receipts[values[1]]={payload_hash:values[3],topic:values[2]};
    if(sql.includes('SELECT * FROM mirror.mutation_journal'))return{rows:state.journal[values[1]]?[state.journal[values[1]]]:[]};
    if(sql.includes('INSERT INTO mirror.catalog_changes')){
      if(values[1]===failProduct)throw Error('Product persistence failed');
      state.changes[values[1]]=(state.changes[values[1]]??0)+1;
      return{rows:[{revision:String(state.changes[values[1]])}]};
    }
    if(sql.includes('INSERT INTO mirror.mutation_journal'))state.journal[values[3]]={product_id:values[1],revision:values[2],source:values[4],deleted:values[5],payload_hash:values[6]};
    if(sql.includes('INSERT INTO mirror.catalog_refresh_requests')){
      if(failRefresh)throw Error('Refresh persistence failed');
      state.refreshes++;
    }
    return{rows:[],rowCount:1};
  }};
  const database={connect:async()=>client};
  const service=createReconciliationService({database});
  const deliver=(topic,payload,id='event-1')=>handleWebhookEvent({topic,shop,body:JSON.stringify(payload),webhookId:id,database,reconciliationService:service});
  return{deliver,statements,get state(){return state},failProduct(value){failProduct=value},failRefresh(){failRefresh=true}};
}

test('multi-product webhook commits one receipt, every unique product, and refresh intent; duplicates remain idempotent',async()=>{
  const f=events(),payload={product_ids:[1,2,3,2]};
  await f.deliver('COLLECTIONS_UPDATE',payload);
  assert.equal(Object.keys(f.state.receipts).length,1);
  assert.equal(Object.keys(f.state.journal).length,3);
  assert.deepEqual(Object.values(f.state.changes),[1,1,1]);
  assert.equal(f.state.refreshes,1);
  assert.equal(f.statements.filter(sql=>sql.startsWith('BEGIN')).length,1);
  await f.deliver('COLLECTIONS_UPDATE',payload);
  assert.deepEqual(Object.values(f.state.changes),[1,1,1]);
  assert.equal(f.state.refreshes,1);
  await assert.rejects(()=>f.deliver('COLLECTIONS_UPDATE',{product_ids:[1,4]}),/different intent/);
  await assert.rejects(()=>f.deliver('COLLECTIONS_DELETE',payload),/different intent/);
});

test('catalogue webhook delivery requires durable persistence',async()=>{
 for(const topic of ['PRODUCTS_UPDATE','COLLECTIONS_UPDATE','INVENTORY_ITEMS_UPDATE','BULK_OPERATIONS_FINISH']){
  await assert.rejects(()=>handleWebhookEvent({topic,shop,body:'{}',webhookId:'missing-store'}),/Durable webhook persistence unavailable/);
 }
});

test('bulk completion deduplicates its hint without certifying external status',async()=>{
 const f=events(),payload={admin_graphql_api_id:'gid://shopify/BulkOperation/1',status:'COMPLETED'};
 await f.deliver('BULK_OPERATIONS_FINISH',payload);
 await f.deliver('BULK_OPERATIONS_FINISH',payload);
 assert.equal(Object.keys(f.state.receipts).length,1);
 assert.equal(f.statements.some(sql=>sql.includes('UPDATE mirror.sync_external_operations')),false);
 await assert.rejects(()=>f.deliver('CUSTOMERS_DATA_REQUEST',payload),/different intent/);
});

test('a later product failure rolls back the complete fan-out and delivery can retry',async()=>{
  const f=events();f.failProduct('gid://shopify/Product/2');
  await assert.rejects(()=>f.deliver('COLLECTIONS_UPDATE',{product_ids:[1,2,3]}),/Product persistence failed/);
  assert.deepEqual(f.state,{receipts:{},journal:{},changes:{},refreshes:0});
  f.failProduct(null);
  await f.deliver('COLLECTIONS_UPDATE',{product_ids:[1,2,3]});
  assert.equal(Object.keys(f.state.journal).length,3);
});

test('inventory events with no trusted mapping durably request refresh without querying a guessed relation',async()=>{
  for(const topic of ['INVENTORY_ITEMS_UPDATE','INVENTORY_LEVELS_UPDATE','INVENTORY_LEVELS_DISCONNECT']){
    const f=events();await f.deliver(topic,{id:123,inventory_item_id:123});
    assert.equal(f.state.refreshes,1);
    assert.equal(Object.keys(f.state.receipts).length,1);
    assert.equal(Object.keys(f.state.journal).length,0);
    assert.equal(f.statements.some(sql=>sql.includes('FROM mirror.variants')),false);
  }
});

test('refresh persistence failure rolls back receipt and prevents inventory acknowledgment',async()=>{
  const f=events();f.failRefresh();
  await assert.rejects(()=>f.deliver('INVENTORY_ITEMS_UPDATE',{id:123}),/Refresh persistence failed/);
  assert.equal(Object.keys(f.state.receipts).length,0);
});

function scheduler({active=false,failAllocation=false,revision='2',storedSession=session,exhausted=false}={}){
  const calls=[],errors=[];let allocations=0,acknowledgments=0;
  const query=async(sql,values=[])=>{
    calls.push({sql,values});
    if(sql.includes('SET review_required=true'))return{rows:exhausted?[{shop_id:shop,requested_revision:revision}]:[]};
    if(sql.includes('SET review_required=false'))return{rows:[{shop_id:shop}],rowCount:1};
    if(sql.includes('SELECT installation_version FROM mirror.shops'))return{rows:[{installation_version:installation}]};
    if(sql.includes('SET attempts=attempts+1'))return{rows:[{review_required:exhausted}],rowCount:1};
    if(sql.includes('FROM mirror.catalog_refresh_requests r JOIN'))return{rows:[{shop_id:shop,installation_version:installation,requested_revision:revision}]};
    if(sql.includes('SELECT installation_version,uninstalled_at'))return{rows:[{installation_version:installation,uninstalled_at:null}]};
    if(sql.includes('SELECT requested_revision,scheduled_revision'))return{rows:[{requested_revision:revision,scheduled_revision:'1'}]};
    if(sql.includes('SELECT * FROM mirror.catalog_import_jobs'))return{rows:active?[{id:'active',installation_version:installation}]:[]};
    if(sql.includes('SELECT 1 FROM mirror.generations'))return{rows:[],rowCount:0};
    if(sql.includes('SELECT generation_id FROM mirror.publications'))return{rows:[{generation_id:'published-1'}]};
    if(sql.includes('UPDATE mirror.catalog_refresh_requests SET scheduled_revision'))acknowledgments++;
    return{rows:[],rowCount:1};
  };
  const database={query,connect:async()=>({query,release(){}})};
  const service=createCatalogImportService({database,logger:{error(error){errors.push(error)}},shopify:{config:{sessionStorage:{
    loadSession:async()=>storedSession,findSessionsByShop:async()=>[storedSession],
  }}},phaseRuntime:{async enqueue(input){allocations++;assert.equal(input.expectedGenerationId,'published-1');
    if(failAllocation)throw Error('Allocation failed');return{id:'refresh-job',status:'QUEUED'};}}});
  return{service,calls,errors,get allocations(){return allocations},get acknowledgments(){return acknowledgments}};
}

test('pending webhook refresh allocates a new durable import after publication and acknowledges its exact revision',async()=>{
  const f=scheduler();await f.service.ensurePendingCatalogRefreshes();
  assert.equal(f.allocations,1,JSON.stringify({calls:f.calls,errors:f.errors}));assert.equal(f.acknowledgments,1);
  assert.deepEqual(f.calls.find(c=>c.sql.includes('SET scheduled_revision')).values,[shop,installation,'2']);
  assert.ok(f.calls.some(c=>c.sql==='COMMIT'));
});

test('event arriving during an active import remains pending for the next generation',async()=>{
  const f=scheduler({active:true});await f.service.ensurePendingCatalogRefreshes();
  assert.equal(f.allocations,0);assert.equal(f.acknowledgments,0);
});

test('failed allocation never acknowledges refresh and persists bounded retry eligibility',async()=>{
  const f=scheduler({failAllocation:true});await f.service.ensurePendingCatalogRefreshes();
  assert.equal(f.acknowledgments,0);
  assert.ok(f.calls.some(c=>c.sql==='ROLLBACK'));
  const retry=f.calls.find(c=>c.sql.includes('SET attempts=attempts+1'));
  assert.deepEqual(retry.values,[shop,installation,'2']);assert.match(retry.sql,/attempts<8/);
});

test('exhausted refresh revisions emit an operational incident and require explicit current-session recovery',async()=>{
 const f=scheduler({failAllocation:true,exhausted:true});await f.service.ensurePendingCatalogRefreshes();
 assert.ok(f.errors.some(error=>error.code==='REFRESH_RETRY_EXHAUSTED'));
 assert.equal((await f.service.requeueCatalogRefresh(session,{expectedRevision:'2',reason:'Credentials repaired'})).requeued,true);
 const recovery=f.calls.find(call=>call.sql.includes('SET review_required=false'));
 assert.match(recovery.sql,/installation_version=\$2 AND requested_revision=\$3/);assert.match(recovery.sql,/AND review_required/);
 assert.deepEqual(recovery.values,[shop,installation,'2']);assert.ok(f.calls.some(call=>call.sql.includes('catalog_refresh_requeued')));
 await assert.rejects(()=>f.service.requeueCatalogRefresh(null,{expectedRevision:'2',reason:'Unauthorized'}));
});
