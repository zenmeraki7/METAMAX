import test from 'node:test';
import assert from 'node:assert/strict';
import {createImportPreviewService} from './import-preview.server.js';
import {createFieldService} from '../fields/resolve.js';

function fixture(targets){
 const shopId='preview.myshopify.com',authContext={},calls=[];
 const client={async query(sql,params){calls.push({sql,params});return{rows:sql.includes('SELECT p.id::text')?targets:[],rowCount:1};}};
 const fieldService=createFieldService({adapter:{resolveOne(){},resolveBatch(){}},resolveShop:async()=>shopId,authorizeAccess:async()=>true,
  verifyCoverage:async()=>({ready:true,generationId:'generation',coverageRevision:'coverage'})});
 const snapshot={shopId,selectedCount:targets.length,operationId:'operation',generationId:'generation',coverageRevision:'coverage',snapshotId:'snapshot',selectionHash:'selection',expiresAt:new Date(Date.now()+60000)};
 const service=createImportPreviewService({database:{async connect(){return client;}},fieldService,resolveShop:async()=>shopId,
  resolveMerchantActor:async()=>({shopId,id:'merchant'}),resolveDatasets:async()=>({executionContext:{}}),
  approvalService:{async approveContract(){assert.fail('Preparation cannot approve');},async getApprovedContract(){}},
  selectionService:{async withSelectionTransaction(input,callback){assert.equal(input.operation,'import');return callback({client,snapshot});}}});
 return {service,calls,authContext};
}
test('preview resolves internal selection IDs and Shopify IDs to exact canonical approved resources',async()=>{
 const f=fixture([{id:'9001',shopify_id:'gid://shopify/Product/1'},{id:'9002',shopify_id:'gid://shopify/Product/2'}]);
 await f.service.createImportPreview({authContext:f.authContext,records:[{id:'9001',title:'One'},{id:'gid://shopify/Product/2',vendor:'Two'}]});
 const payload=JSON.parse(f.calls.find(call=>call.sql.includes('INSERT INTO mirror.import_previews')).params[3]);
 assert.equal(payload.importMappingVersion,1);assert.equal(payload.resourceType,'product');
 assert.deepEqual(payload.rows.map(row=>[row.targetId,row.resourceGid,row.fields]),[
  ['9001','gid://shopify/Product/1',{'product.title':'One'}],['gid://shopify/Product/2','gid://shopify/Product/2',{'product.vendor':'Two'}]]);
});
test('preview cannot certify an unmapped target or two aliases of the same canonical resource',async()=>{
 for(const targets of [[{id:'1',shopify_id:'gid://shopify/Product/1'},{id:'2',shopify_id:'gid://shopify/Product/2'}],
  [{id:'1',shopify_id:'gid://shopify/Product/1'},{id:'2',shopify_id:'gid://shopify/Product/1'}]]){
  const f=fixture(targets);
  await assert.rejects(()=>f.service.createImportPreview({authContext:f.authContext,records:[{id:'1',title:'One'},{id:'gid://shopify/Product/1',title:'Alias'}]}),{code:'FIELD_CONTRACT_MISMATCH'});
  assert.equal(f.calls.some(call=>call.sql.includes('INSERT INTO mirror.import_previews')),false);
 }
});

test('mixed product, variant and metafield imports fail before creating any selection or approval',async()=>{
 const f=fixture([{id:'1',shopify_id:'gid://shopify/Product/1'}]);
 const records=[{id:'1',title:'Supported product'},
  {id:'gid://shopify/ProductVariant/2','variant.price':'12'},
  {id:'gid://shopify/Product/3','metafield.custom.note':'Unsupported dynamic write'}];
 await assert.rejects(()=>f.service.createImportPreview({authContext:f.authContext,records}),{code:'FIELD_INVALID_VALUE'});
 assert.equal(f.calls.length,0);
});
