import {approvedContractFixture} from '../security/test-support/approved-contract.js';
import {createInstallationResolver} from '../security/installation-lifecycle.server.js';
import test,{mock} from "node:test";
import assert from "node:assert/strict";
const actualRuntime=await import('../security/runtime-database.server.js');
mock.module('../security/runtime-database.server.js',{namedExports:{...actualRuntime,assertRuntimeDatabaseProfile(){},verifyRuntimeDatabase:async()=>({})}});
const {createJobDispatchService}=await import("./job-dispatch.server.js");

const shopId = "dispatch.myshopify.com", authContext = Object.freeze({});
function fixture({count = 100000, kind = "bulk_edit", loseRace = false, failItems = false, deny = false, denyAfterInsert = false,itemCount=count} = {}) {
  const calls = [], commands = new Map();
  let current;
  const state={allowed:!deny,installation:"install-1",review:true,settings:{isolation:'read committed',read_only:'off',statement_timeout_ms:'30000',lock_timeout_ms:'2000'}};
  const contract = { id:"approved",shop_id:shopId,status:"APPROVED",operation:kind,snapshot_id:"snapshot",
    contract:kind === "undo" ? { writeCapabilityVersion:"product-set-v1",sourceCommandId:"source",fields:["title"] } : { writeCapabilityVersion:"product-set-v1",updates:{title:"Approved"},targetTitle:"Display metadata" } };
  const query = async (sql, params) => {
    calls.push({sql,params});
    if(sql==='SAVEPOINT metamax_dispatch'&&state.autocommit)throw Object.assign(Error('No transaction'),{code:'25P01'});
    if(sql.includes("current_setting('transaction_isolation')"))return {rows:[state.settings]};
    if(sql.includes('UPDATE mirror.outbox_events e SET review_required=false')){
      if(!state.review)return{rows:[],rowCount:0};state.review=false;return{rows:[{id:'outbox'}],rowCount:1};
    }
    if (sql.includes('FROM mirror.shops')) return {rows:state.installation?[{installation_version:state.installation}]:[]};
    if (sql.includes("FROM mirror.job_commands c")) return { rows:current ? [{...current,operation_id:"op",item_count:count}] : [] };
    if (sql.includes("INSERT INTO mirror.job_commands")) {
      assert.match(sql, /ON CONFLICT DO NOTHING/);
      const identity = JSON.stringify([params[0],params[3],params[1]]);
      if (commands.has(identity)) return {rows:[]};
      current = { id:"command",status:"PENDING",installation_version:"install-1" };
      commands.set(identity,current);
      if (denyAfterInsert) state.allowed=false;
      if (loseRace) return {rows:[]};
      return {rows:[current]};
    }
    if (sql.includes("INSERT INTO mirror.edit_operations")) return {rows:[{id:"op"}]};
    if (sql.includes("SELECT id FROM mirror.edit_operations")) return {rows:[{id:"source-op"}]};
    if (sql.includes("SELECT s.selected_count")) return {rows:[{selected_count:count,target_count:String(count)}]};
    if (sql.includes("INSERT INTO mirror.job_items")) {
      if (failItems) throw new Error("membership failed");
      return {rowCount:itemCount};
    }
    return {rows:[],rowCount:1};
  };
  const database = { query,async connect() { return {query,release() {}}; } };
  const options = { database, resolveShop:async context => {
    if (context !== authContext) throw new Error("unverified"); return shopId;
  },resolveTenant:async()=>createInstallationResolver({readInstallation:async()=>({installation_version:'install-1'})})(shopId),approvalService:{async getApprovedContract() {return approvedContractFixture(structuredClone(contract));}},authorizeWrite:async () => state.allowed };
  return { service:createJobDispatchService(options),options,contract,calls,commands,state };
}
test('an authorized idempotent receipt preserves the durable merchant partial result',async()=>{
 const f=fixture({count:10});const input={authContext,contractId:'approved'};
 await f.service.dispatchBulkEdit(input);const command=[...f.commands.values()][0];
 command.status='PARTIAL';command.result={version:1,outcome:'PARTIAL',terminal:true,counts:{total:10,succeeded:9,failed:1,pending:0,uncertain:0,cancelled:0}};
 const receipt=await f.service.dispatchBulkEdit(input);assert.equal(receipt.status,'PARTIAL');assert.deepEqual(receipt.result,command.result);
 f.state.allowed=false;await assert.rejects(()=>f.service.dispatchBulkEdit(input),{code:'FIELD_PERMISSION_DENIED'});
});

test('authorized delivery requeue preserves the command and idempotency identity and records review',async()=>{
 const f=fixture({count:1}),input={authContext,contractId:'approved'};
 const original=await f.service.dispatchBulkEdit(input);
 const retried=await f.service.requeueDispatch({...input,kind:'bulk_edit',reason:'Queue restored'});
 assert.equal(retried.commandId,original.commandId);assert.equal(retried.idempotencyKey,original.idempotencyKey);assert.equal(retried.requeued,true);
 assert.equal(f.commands.size,1);assert.equal(f.calls.filter(call=>call.sql.includes('INSERT INTO mirror.outbox_events')).length,1);
 assert.ok(f.calls.some(call=>call.sql.includes('operation_dispatch_requeued')));
 f.state.allowed=false;await assert.rejects(()=>f.service.requeueDispatch({...input,kind:'bulk_edit',reason:'Denied'}),{code:'FIELD_PERMISSION_DENIED'});
});

test('approved import dispatch materializes exact row mappings and reauthorizes idempotent receipts',async()=>{
 const f=fixture({kind:'import',count:2});
 f.contract.contract={writeCapabilityVersion:'resource-set-v2',resourceType:'product',importMappingVersion:1,rowCount:2,
  fieldIds:['product.title','product.vendor'],rows:[{resourceGid:'gid://shopify/Product/1',fields:{'product.title':'First'}},{resourceGid:'gid://shopify/Product/2',fields:{'product.vendor':'Second'}}]};
 const input={authContext,contractId:'approved'};
 assert.equal((await f.service.dispatchImport(input)).itemCount,2);
 const insert=f.calls.find(call=>call.sql.includes('INSERT INTO mirror.job_items'));
 assert.match(insert.sql,/mapped\."resourceId"=p.shopify_id/);assert.match(insert.sql,/si.shop_id=\$1 AND si.snapshot_id=\$3/);
 assert.deepEqual(JSON.parse(insert.params[3]),[{resourceId:'gid://shopify/Product/1',updates:{title:'First'}},{resourceId:'gid://shopify/Product/2',updates:{vendor:'Second'}}]);
 assert.equal((await f.service.dispatchImport(input)).existing,true);assert.equal(f.commands.size,1);
 f.state.allowed=false;await assert.rejects(()=>f.service.dispatchImport(input),{code:'FIELD_PERMISSION_DENIED'});
});

test('import mapping and selection cardinality must match before outbox publication',async()=>{
 const f=fixture({kind:'import',count:2});
 f.contract.contract={writeCapabilityVersion:'resource-set-v2',resourceType:'product',importMappingVersion:1,rowCount:1,fieldIds:['product.title'],rows:[{resourceGid:'gid://shopify/Product/1',fields:{'product.title':'First'}}]};
 await assert.rejects(()=>f.service.dispatchImport({authContext,contractId:'approved'}));
 assert.equal(f.calls.some(call=>call.sql.includes('INSERT INTO mirror.outbox_events')),false);
 assert.equal(f.calls.at(-1).sql,'ROLLBACK');
});
for(const kind of ['bulk_edit'])test(`${kind} materializes only approved pinned variants and rejects a changed target count`,async()=>{
 const make=itemCount=>{
  const f=fixture({count:2,kind,itemCount});
  f.contract.contract={writeCapabilityVersion:'resource-set-v2',resourceType:'variant',variantTargetCount:3,
   variantTargetingPolicy:kind==='undo'?'VERIFIED_VARIANTS_OF_SOURCE_COMMAND':'ALL_VARIANTS_OF_SELECTED_PRODUCTS',
   ...(kind==='undo'?{sourceCommandId:'source',fields:['price']}:{updates:{price:'10'}})};return f;
 };
 const invoke=f=>f.service[kind==='undo'?'dispatchUndo':'dispatchBulkEdit']({authContext,contractId:'approved',sourceCommandId:'source'});
 const f=make(3);assert.equal((await invoke(f)).itemCount,3);
 const insert=f.calls.find(x=>x.sql.includes('INSERT INTO mirror.job_items'));
 assert.match(insert.sql,/JOIN mirror.variants v ON v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id/);
 assert.match(insert.sql,/LIMIT 100001/);assert.equal(insert.params[0],shopId);
 if(kind==='undo'){assert.match(insert.sql,/original.resource_id=v.shopify_id/);assert.match(insert.sql,/ps.confirmed_at IS NOT NULL/);}
 const changed=make(4);await assert.rejects(()=>invoke(changed),/Materialized targets differ/);assert.equal(changed.calls.at(-1).sql,'ROLLBACK');
});

for (const kind of ["bulk_edit"]) {
  const run = f => f.service[kind === "undo" ? "dispatchUndo" : "dispatchBulkEdit"].bind(f.service);
  test(`${kind} dispatch derives a stable identity despite retries and changing caller keys`, async () => {
    const f = fixture({kind});
    const options = {authContext,contractId:"approved",sourceCommandId:"source"};
    const first = await run(f)(options);
    const retried = await run(f)({...options,idempotencyKey:"changed"});
    assert.equal(first.commandId,retried.commandId);
    assert.equal(first.idempotencyKey,retried.idempotencyKey);
    assert.equal(retried.existing,true);
    assert.equal(f.commands.size,1);
    assert.equal(f.calls.filter(call => call.sql.includes("INSERT INTO mirror.outbox_events")).length,1);
    const inserts = f.calls.filter(call => call.sql.includes("INSERT INTO mirror.job_items"));
    assert.equal(inserts.length,1);
    assert.match(inserts[0].sql,/SELECT si.shop_id/);
    assert.match(inserts[0].sql,/si.shop_id=\$1 AND si.snapshot_id=\$3/);
    assert.equal(inserts[0].params[0],shopId);
    assert.equal(inserts[0].params.length,kind === "undo" ? 5 : 4);
    assert.equal(first.itemCount,100000);
    if (kind === "bulk_edit") assert.deepEqual(JSON.parse(inserts[0].params[3]),{title:"Approved"});
  });
  test(`${kind} dispatch returns the concurrent winner without inserting items again`, async () => {
    const f = fixture({kind,loseRace:true});
    const result = await run(f)({authContext,contractId:"approved",sourceCommandId:"source"});
    assert.equal(result.existing,true);
    assert.equal(f.calls.some(call => call.sql.includes("INSERT INTO mirror.job_items")),false);
  });
  test(`${kind} dispatch rejects forged context, browser shop and revoked write permission`, async () => {
    for (const override of [{authContext:null},{authContext:{}},{shopId:"other.myshopify.com"}]) {
      const f = fixture({kind});
      await assert.rejects(() => run(f)({authContext,contractId:"approved",sourceCommandId:"source",...override}));
      assert.equal(f.calls.length,0);
    }
    const f = fixture({kind,deny:true});
    await assert.rejects(() => run(f)({authContext,contractId:"approved",sourceCommandId:"source"}), /authorization/);
    assert.equal(f.commands.size,0);
    assert.equal(f.calls.at(-1).sql,"ROLLBACK");
  });
}

test("dispatch rolls back materialization failures without publishing queue notifications", async () => {
  const f = fixture({failItems:true});
  const service = createJobDispatchService({...f.options,queue:{add() {assert.fail("Uncommitted job published");}}});
  await assert.rejects(() => service.dispatchBulkEdit({authContext,contractId:"approved"}),/membership failed/);
  assert.equal(f.calls.at(-1).sql,"ROLLBACK");
  assert.equal(f.calls.some(call => call.sql.includes("INSERT INTO mirror.outbox_events")),false);
});

test("undo requires a new undo approval bound to the source; bulk metadata is never a write", async () => {
  const f = fixture({kind:"undo"});
  await assert.rejects(() => f.service.dispatchUndo({authContext,contractId:"approved",sourceCommandId:"different"}),/differs from approval/);
  const bulk = fixture();
  bulk.contract.contract.updates.targetTitle = "Unapproved write";
  await assert.rejects(() => bulk.service.dispatchBulkEdit({authContext,contractId:"approved"}),{code:'FIELD_CONTRACT_MISMATCH'});
  assert.equal(bulk.commands.size,0);
});

for(const kind of ['bulk_edit']){
 const invoke=(f,extra={})=>f.service[kind==='undo'?'dispatchUndo':'dispatchBulkEdit']({authContext,contractId:'approved',sourceCommandId:'source',...extra});
 test(`${kind} existing receipts require current write permission and installation`,async()=>{
  const f=fixture({kind});await invoke(f);
  const inserts=f.calls.filter(c=>c.sql.startsWith('INSERT')).length;
  f.state.allowed=false;await assert.rejects(()=>invoke(f),/authorization/);
  assert.equal(f.calls.at(-1).sql,'ROLLBACK');
  f.state.allowed=true;f.state.installation=null;await assert.rejects(()=>invoke(f),/Active installation/);
  f.state.installation='reinstalled';await assert.rejects(()=>invoke(f),/different installation|installation changed/);
  f.state.installation='install-1';assert.equal((await invoke(f)).existing,true);
  assert.equal(f.calls.filter(c=>c.sql.startsWith('INSERT')).length,inserts);
 });
 test(`${kind} concurrent winner receipts recheck permission after losing the insert race`,async()=>{
  const f=fixture({kind,loseRace:true,denyAfterInsert:true});
  await assert.rejects(()=>invoke(f),/authorization/);
  assert.equal(f.calls.at(-1).sql,'ROLLBACK');
  assert.equal(f.calls.some(c=>c.sql.includes('INSERT INTO mirror.job_items')),false);
 });
 test(`${kind} replay rejects current contract and tenant changes`,async()=>{
  const f=fixture({kind});await invoke(f);
  f.contract.shop_id='other.myshopify.com';await assert.rejects(()=>invoke(f),{code:'FIELD_CONTRACT_MISMATCH'});
  f.contract.shop_id=shopId;
  const revoked=createJobDispatchService({...f.options,resolveShop:async()=>{throw Error('Session revoked');}});
  await assert.rejects(()=>revoked[kind==='undo'?'dispatchUndo':'dispatchBulkEdit']({authContext,contractId:'approved',sourceCommandId:'source'}),/revoked/);
 });
}

test('external dispatch transactions require explicit bounded read-write READ COMMITTED ownership',async()=>{
 for(const patch of [{isolation:'repeatable read'},{isolation:'serializable'},{read_only:'on'},
  {statement_timeout_ms:'0'},{statement_timeout_ms:'30001'},{lock_timeout_ms:'0'},{lock_timeout_ms:'2001'}]){
  const f=fixture();Object.assign(f.state.settings,patch);const client=await f.options.database.connect();
  await assert.rejects(()=>f.service.dispatchBulkEdit({client,authContext,contractId:'approved'}),{code:'FIELD_CONTRACT_MISMATCH'});
  assert.equal(f.calls.some(call=>call.sql.startsWith('INSERT')),false);
  assert.equal(f.calls.at(-2).sql,'ROLLBACK TO SAVEPOINT metamax_dispatch');
  assert.equal(f.calls.at(-1).sql,'RELEASE SAVEPOINT metamax_dispatch');
 }
 const f=fixture();f.state.autocommit=true;
 const client=await f.options.database.connect();
 await assert.rejects(()=>f.service.dispatchBulkEdit({client,authContext,contractId:'approved'}),{code:'25P01'});
});

test('external success releases its savepoint without committing caller work; failure rolls back local writes',async()=>{
 for(const failItems of [false,true]){
  const f=fixture({count:1,failItems}),client=await f.options.database.connect();
  const run=()=>f.service.dispatchBulkEdit({client,authContext,contractId:'approved'});
  if(failItems)await assert.rejects(run,/membership failed/);else assert.equal((await run()).itemCount,1);
  assert.equal(f.calls.some(call=>['BEGIN','COMMIT','ROLLBACK'].includes(call.sql)),false);
  assert.equal(f.calls.at(-1).sql,'RELEASE SAVEPOINT metamax_dispatch');
  assert.equal(f.calls.some(call=>call.sql==='ROLLBACK TO SAVEPOINT metamax_dispatch'),failItems);
 }
});

test('one external transaction cannot run concurrent dispatch calls across gateway instances',async()=>{
 const f=fixture({count:1});let release,entered;
 const arrived=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const raw=await f.options.database.connect();let block=true;
 const client={release(){},async query(sql,params){if(sql==='SAVEPOINT metamax_dispatch'&&block){block=false;entered();await gate;}return raw.query(sql,params);}};
 const first=f.service.dispatchBulkEdit({client,authContext,contractId:'approved'});await arrived;
 const other=createJobDispatchService(f.options);
 await assert.rejects(()=>other.dispatchBulkEdit({client,authContext,contractId:'approved'}),/Concurrent use/);
 release();await first;assert.equal((await other.dispatchBulkEdit({client,authContext,contractId:'approved'})).existing,true);
});

test('installed product and variant Undo cannot create commands without atomic write conditions',async()=>{
 for(const resourceType of ['product','variant']){
  const f=fixture({kind:'undo'});
  f.contract.contract={writeCapabilityVersion:'resource-set-v2',resourceType,sourceCommandId:'source',fields:[resourceType==='product'?'title':'price']};
  const invoke=()=>f.service.dispatchUndo({authContext,contractId:'approved',sourceCommandId:'source'});
  await assert.rejects(invoke,/UNDO_ATOMICITY_UNAVAILABLE/);
  assert.equal(f.calls.some(call=>call.sql.startsWith('INSERT')),false);assert.equal(f.commands.size,0);
  f.state.allowed=false;await assert.rejects(invoke,/authorization/);
 }
});
