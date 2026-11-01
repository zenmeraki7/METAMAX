import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalService, computeContractHash } from "./approval.server.js";

test("approval service: binds immutable contract and verifies contractHash against tampering", async () => {
  const shopId = "approval-test.myshopify.com";
  const snapshotId = "snap-123";
  let storedContract = null;

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("FROM mirror.selection_snapshots") && sql.includes("FOR SHARE")) {
        return {
          rows: [{
            id: snapshotId,shop_id:shopId,operation:'bulk_edit',filter_fingerprint:'filter',installation_version:'install-1',target_mode:'EXPLICIT',coordinate_installation:'install-1',installation_version:'install-1',target_mode:'ALL_MATCHING',coordinate_coverage:'coverage-1',coordinate_mapping:'mapping-1',coordinate_schema:'schema-1',coordinate_source:'source-1',coverage_revision:'coverage-1',mapping_version:'mapping-1',registry_version:'registry-1',definition_revisions:[],operation_id:'logical-1',
            status: "APPROVED",
            selection_hash: "selection-sha256-hash",
            expires_at: new Date(Date.now() + 100000).toISOString(),
            generation_id: "gen-active",
          }],
        };
      }
      if (sql.includes("INSERT INTO mirror.execution_contracts")) {
        storedContract = {
          shop_id: params[0],
          id: params[1],
          snapshot_id: params[2],
          operation: params[3],
          approval_revision: params[4],
          status: "APPROVED",
          contract: JSON.parse(params[5]),
          contract_hash: params[6],
          approved_by: params[7],
          approved_at: params[8],
          expires_at: params[9],
          selection_hash: "selection-sha256-hash",
          hash_version: "canonical-v2",
          canonical_contract: params[10],
        };
        return { rowCount: 1 };
      }
      if (sql.includes("FROM mirror.execution_contracts c")) {
        return { rows: storedContract ? [storedContract] : [] };
      }
      if (sql.includes("UPDATE mirror.execution_contracts SET status='APPROVED'")) return {rowCount:1};
      return { rows: [], rowCount: 0 };
    },
  };

  mockDb.connect=async()=>({query:mockDb.query,release(){}});
  const service = createApprovalService({ database: mockDb,resolveMerchantActor:async()=>({id:'actor:merchant_1',shopId}),authorizeApproval:async()=>true });

  const approved = await service.approveContract({
    authContext:{},
    shopId,
    snapshotId,
    contractPayload: {updates:{title:"[Sale] "}},
    approvedBy: "actor:merchant_1",
  });

  assert.equal(approved.status, "APPROVED");
  assert.ok(approved.contractId);
  assert.ok(approved.contractHash);

  // Verify retrieval and hash validation
  const retrieved = await service.getApprovedContract({
    shopId,
    contractId: approved.contractId,
  });
  assert.ok(retrieved);
  assert.equal(retrieved.status, "APPROVED");
  assert.equal(retrieved.hash_version,"canonical-v2");
  const savedCanonical=storedContract.canonical_contract;
  storedContract.canonical_contract=` ${savedCanonical}`;
  await assert.rejects(()=>service.getApprovedContract({shopId,contractId:approved.contractId}),/contractHash mismatch/);
  storedContract.canonical_contract=savedCanonical;
  storedContract.hash_version="unsupported-v99";
  await assert.rejects(()=>service.getApprovedContract({shopId,contractId:approved.contractId}),/contractHash mismatch/);
  storedContract.hash_version="canonical-v2";

  // Tampering detection test: modify stored contract payload
  storedContract.contract.updates.title = "MALICIOUS";
  await assert.rejects(
    () => service.getApprovedContract({ shopId, contractId: approved.contractId }),
    /contractHash mismatch/,
  );
});

test("approval hashes are stable across JSONB object key ordering and still bind values", () => {
  const context = {shopId:"approval.myshopify.com",snapshotId:"snapshot",operation:"bulk_edit",selectionHash:"selection",approvedBy:"merchant"};
  const first = {updates:{title:"Title",status:"ACTIVE"},source:{revision:1,registry:"v1"}};
  const reordered = {source:{registry:"v1",revision:1},updates:{status:"ACTIVE",title:"Title"}};
  assert.equal(computeContractHash({...context,contract:first}),computeContractHash({...context,contract:reordered}));
  reordered.updates.title="Changed";
  assert.notEqual(computeContractHash({...context,contract:first}),computeContractHash({...context,contract:reordered}));
});

test('approval fingerprints bind shop, snapshot, operation, selection and actor',()=>{
 const context={shopId:'one.myshopify.com',snapshotId:'snapshot',operation:'bulk_edit',selectionHash:'selection',approvedBy:'actor',contract:{updates:{title:'Reviewed'}}};
 const original=computeContractHash(context);
 for(const [key,value] of Object.entries({shopId:'two.myshopify.com',snapshotId:'other',operation:'undo',selectionHash:'changed',approvedBy:'other',contract:{updates:{title:'Changed'}}}))assert.notEqual(computeContractHash({...context,[key]:value}),original,key);
});

function approvalFixture(overrides={}){
 const shopId='approval.myshopify.com',authContext=Object.freeze({}),calls=[];
 const state={actor:{id:'verified-merchant',shopId},allowed:true,variantCount:3,operation:'bulk_edit'};
 const client={async query(sql,params){calls.push({sql,params});
  if(sql.includes('bounded_targets'))return {rows:[{target_count:String(state.variantCount)}]};
  if(sql.includes('FROM mirror.selection_snapshots'))return {rows:[{id:'snapshot',shop_id:shopId,operation:state.operation,filter_fingerprint:'filter',installation_version:'install-1',target_mode:'EXPLICIT',coordinate_installation:'install-1',installation_version:'install-1',target_mode:'ALL_MATCHING',coordinate_coverage:'coverage-1',coordinate_mapping:'mapping-1',coordinate_schema:'schema-1',coordinate_source:'source-1',generation_id:'gen-1',coverage_revision:'coverage-1',mapping_version:'mapping-1',registry_version:'registry-1',definition_revisions:[],operation_id:'logical-1',status:'APPROVED',selection_hash:'selection',expires_at:new Date(Date.now()+60000)}]};
  return {rows:[],rowCount:1};
 },release(){}};
 const options={database:{query:client.query,async connect(){return client;}},logger:{error(){}},
  resolveMerchantActor:async context=>context===authContext?state.actor:null,
  authorizeApproval:async input=>{assert.equal(input.client,client);assert.equal(input.actor.id,'verified-merchant');return state.allowed;},...overrides};
 return {service:createApprovalService(options),options,state,calls,authContext,
  input:{authContext,shopId,snapshotId:'snapshot',contractPayload:{updates:{title:'Reviewed'}}}};
}
test('variant approval freezes a bounded, tenant-scoped target count and explicit targeting policy',async()=>{
 const f=approvalFixture();f.input.contractPayload={resourceType:'variant',updates:{price:'10'},variantTargetingPolicy:'ALL_VARIANTS_OF_SELECTED_PRODUCTS'};
 await f.service.approveContract(f.input);
 const payload=JSON.parse(f.calls.find(x=>x.sql.includes('INSERT INTO mirror.execution_contracts')).params[5]);
 assert.equal(payload.variantTargetCount,3);assert.equal(payload.writeCapabilityVersion,'resource-set-v2');
 const count=f.calls.find(x=>x.sql.includes('bounded_targets'));assert.match(count.sql,/LIMIT 100001/);assert.equal(count.params[0],f.input.shopId);
 for(const patch of [{variantTargetingPolicy:undefined},{variantTargetCount:2},{updates:{title:'wrong family'}}])await assert.rejects(()=>f.service.approveContract({...f.input,contractPayload:{...f.input.contractPayload,...patch}}));
 f.state.variantCount=100001;await assert.rejects(()=>f.service.approveContract(f.input));
});
for(const operation of ['bulk_edit','undo','scheduled_edit','recurring_edit','export']){
 test(`${operation} approvals resolve actors and require current authorization`,async()=>{
  const f=approvalFixture();f.state.operation=operation;
  if(operation==='undo')f.input.contractPayload={sourceCommandId:'source',fields:['title']};
  if(operation==='undo'){
   await assert.rejects(()=>f.service.approveContract({...f.input,operation}),{code:'FIELD_UNSUPPORTED_OPERATION'});
   assert.equal(f.calls.some(c=>c.sql.includes('INSERT INTO mirror.execution_contracts')),false);
  }else{
   const result=await f.service.approveContract({...f.input,operation});assert.equal(result.approvedBy,'verified-merchant');
   assert.equal(f.calls.find(c=>c.sql.includes('INSERT INTO mirror.execution_contracts')).params[7],'verified-merchant');
  }
  for(const override of [{authContext:null},{authContext:{}},{approvedBy:'browser-forgery'},{shopId:'other.myshopify.com'}])
   await assert.rejects(()=>f.service.approveContract({...f.input,operation,...override}),{code:'FIELD_PERMISSION_DENIED'});
  f.state.allowed=false;await assert.rejects(()=>f.service.approveContract({...f.input,operation}),{code:'FIELD_PERMISSION_DENIED'});
 });
}
test('approval fails closed without identity or authorization providers',async()=>{
 for(const name of ['resolveMerchantActor','authorizeApproval']){
  const f=approvalFixture({[name]:undefined});await assert.rejects(()=>f.service.approveContract(f.input),{code:'FIELD_PERMISSION_DENIED'});assert.equal(f.calls.length,0);
 }
});
test('approval rechecks actor and permission after drafting and rolls back revocation',async()=>{
 for(const change of ['actor','permission']){
  const f=approvalFixture();let checks=0;
  const service=createApprovalService({...f.options,authorizeApproval:async()=>{
   if(++checks===1){if(change==='actor')f.state.actor={...f.state.actor,id:'changed'};else f.state.allowed=false;return true;}
   return f.state.allowed;
  }});
  await assert.rejects(()=>service.approveContract(f.input),{code:'FIELD_PERMISSION_DENIED'});
  assert.equal(f.calls.at(-1).sql,'ROLLBACK');
  assert.equal(f.calls.some(c=>c.sql.includes("UPDATE mirror.execution_contracts SET status='APPROVED'")),false);
 }
});

test('approvals cannot use nontransactional storage for authorization rechecks',async()=>{
 const f=approvalFixture();
 const service=createApprovalService({...f.options,database:{query:f.options.database.query}});
 await assert.rejects(()=>service.approveContract(f.input),/Transactional approval storage/);
 assert.equal(f.calls.length,0);
});

test('approval rejects fields outside the installed writer and incompatible capability versions before drafting',async()=>{
 for(const contractPayload of [{updates:{seoTitle:'Unsupported'}},{updates:{title:'Reviewed'},writeCapabilityVersion:'obsolete-writer'},{updates:{title:'Reviewed'},executionCoordinates:{installationVersion:'forged'}}]){
  const f=approvalFixture();await assert.rejects(()=>f.service.approveContract({...f.input,contractPayload}));
  assert.equal(f.calls.some(call=>call.sql.includes('INSERT INTO mirror.execution_contracts')),false);
 }
 const f=approvalFixture();const approved=await f.service.approveContract(f.input);
 assert.equal(approved.contract.writeCapabilityVersion,'resource-set-v2');
 assert.deepEqual(approved.contract.executionCoordinates.executionCapabilities.requestShape,
  {maxResources:1,maxExecutionItems:1,valueKinds:['VALUE'],operations:['set']});
 assert.deepEqual(approved.contract.executionCoordinates.executionCapabilities.operations.import.resourceTypes,['product']);
});

test('approval cannot reinterpret a selection authorized for a different operation',async()=>{
 const f=approvalFixture();
 const original=f.options.database.query;
 f.options.database.query=async(sql,p)=>{
  const result=await original(sql,p);
  if(sql.includes('FROM mirror.selection_snapshots'))return{...result,rows:result.rows.map(row=>({...row,operation:'export'}))};
  return result;
 };
 // The fixture connect method closes over its query; supply the wrapped client.
 const service=createApprovalService({...f.options,database:{query:f.options.database.query,async connect(){return{query:f.options.database.query,release(){}};}}});
 await assert.rejects(()=>service.approveContract(f.input),{code:'FIELD_CONTRACT_MISMATCH'});
 assert.equal(f.calls.some(call=>call.sql.includes('INSERT INTO mirror.execution_contracts')),false);
});
