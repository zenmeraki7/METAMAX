import test from 'node:test';
import assert from 'node:assert/strict';
import {importInstructions,importItemInstructions} from './operation-instructions.server.js';
import {assertResourceExecutionRequest,HISTORY_EXECUTION_CAPABILITIES} from '../fields/write-capabilities.js';
const shopId='import.myshopify.com';
function contract(){return{shop_id:shopId,status:'APPROVED',operation:'import',contract:{writeCapabilityVersion:'resource-set-v2',resourceType:'product',importMappingVersion:1,rowCount:2,
 fieldIds:['product.title','product.vendor'],rows:[{resourceGid:'gid://shopify/Product/1',fields:{'product.title':'One'}},{resourceGid:'gid://shopify/Product/2',fields:{'product.vendor':'Two'}}]}};}

test('import instructions retain each resource and its distinct approved field mapping',()=>{
 const c=contract();assert.deepEqual(importInstructions(c,shopId).rows,[{resourceId:'gid://shopify/Product/1',updates:{title:'One'}},{resourceId:'gid://shopify/Product/2',updates:{vendor:'Two'}}]);
 assert.deepEqual(importItemInstructions(c,shopId,'gid://shopify/Product/2'),{vendor:'Two'});
 assert.throws(()=>importItemInstructions(c,shopId,'gid://shopify/Product/3'));
 assert.throws(()=>importInstructions(c,'foreign.myshopify.com'));
});
for(const [label,change] of [
 ['unversioned mappings',p=>delete p.importMappingVersion],['missing resource',p=>delete p.rows[0].resourceGid],
 ['duplicate resource',p=>p.rows[1].resourceGid=p.rows[0].resourceGid],['variant resource',p=>p.rows[0].resourceGid='gid://shopify/ProductVariant/1'],
 ['inventory field',p=>p.rows[0].fields={'inventoryItem.unitCost':'1'}],['absent field',p=>p.rows[0].fields={}],
 ['wrong count',p=>p.rowCount=3],['extra membership',p=>p.fieldIds.push('product.status')],['uncanonical operand',p=>p.rows[0].fields={'product.status':'active'}]
])test(`import rejects ${label}`,()=>{const c=contract();change(c.contract);assert.throws(()=>importInstructions(c,shopId));});

const entry=(resourceGid,fieldId,executionItemId='item',intendedValueKind='VALUE')=>({intent:{identity:{resourceGid,fieldId,executionItemId},intendedValueKind}});
test('installed request shape supports multiple product or variant fields on one resource',()=>{
 assert.equal(assertResourceExecutionRequest([entry('gid://shopify/Product/1','product.title'),entry('gid://shopify/Product/1','product.vendor')]).kind,'product');
 assert.equal(assertResourceExecutionRequest([entry('gid://shopify/ProductVariant/1','variant.price')]).kind,'variant');
 assert.deepEqual(HISTORY_EXECUTION_CAPABILITIES.requestShape,{maxResources:1,maxExecutionItems:1,valueKinds:['VALUE'],operations:['set']});
});
for(const entries of [
 [entry('gid://shopify/Product/1','product.title'),entry('gid://shopify/Product/2','product.title')],
 [entry('gid://shopify/Product/1','product.title'),entry('gid://shopify/Product/1','product.vendor','other')],
 [entry('gid://shopify/InventoryItem/1','inventoryItem.unitCost')],
 [entry('gid://shopify/Product/1','product.title','item','ABSENT')],
 [entry('gid://shopify/Product/1','variant.price')]
])test(`installed request rejects unsupported shape ${JSON.stringify(entries)}`,()=>assert.throws(()=>assertResourceExecutionRequest(entries)));
