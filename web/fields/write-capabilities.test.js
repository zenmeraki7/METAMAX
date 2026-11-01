import test from 'node:test';
import assert from 'node:assert/strict';
import {createFieldService} from './resolve.js';
import {CANONICAL_FIELDS} from './canonical.js';
import {WRITE_CAPABILITY_VERSION,PRODUCT_WRITE_BINDINGS,PRODUCT_WRITE_NAMES,VARIANT_WRITE_BINDINGS,INSTALLED_WRITE_CAPABILITIES,RESOURCE_WRITE_CONTRACTS,requireInstalledWriteCapability} from './write-capabilities.js';
import {productUpdates,bulkInstructions} from '../services/operation-instructions.server.js';
const fieldService=()=>createFieldService({adapter:{resolveOne(){},resolveBatch(){}},resolveShop:async()=> 'capabilities.myshopify.com',
 authorizeAccess:async()=>true,verifyCoverage:async()=>({ready:true,generationId:'generation',coverageRevision:'coverage'})});
const args=id=>({authContext:{},fieldIds:[id],access:'write',operation:'bulk_edit',executionContext:{phase:'preview',operationId:'operation',generationId:'generation'}});
test('installed capability registry and writer accept exactly the same canonical product fields',async()=>{
 const service=fieldService();
 for(const [name,id] of Object.entries(PRODUCT_WRITE_BINDINGS)){
  assert.equal(PRODUCT_WRITE_NAMES[id],name);assert.deepEqual(requireInstalledWriteCapability(id).operations,['set']);
  const value=name==='tags'?['tag']:name==='status'?'ACTIVE':'value';
  assert.deepEqual(productUpdates({[name]:value}),{[name]:value});
  const resolution=await service.requireFields(args(id));assert.equal(resolution.writeCapabilityVersion,WRITE_CAPABILITY_VERSION);
 }
 for(const field of Object.values(CANONICAL_FIELDS))if(!Object.hasOwn(INSTALLED_WRITE_CAPABILITIES.fields,field.id)){
  await assert.rejects(()=>service.requireFields(args(field.id)),field.id);
  assert.throws(()=>requireInstalledWriteCapability(field.id));
 }
 assert.equal(Object.keys(INSTALLED_WRITE_CAPABILITIES.fields).length,13);
 for(const id of Object.values(VARIANT_WRITE_BINDINGS)){await service.requireFields(args(id));assert.throws(()=>requireInstalledWriteCapability(id,'set','product-set-v1'));}
});
test('unsupported operations and incompatible pinned capabilities fail closed',async()=>{
 for(const operation of ['append','clear','increase','remove_items'])assert.throws(()=>requireInstalledWriteCapability('product.title',operation));
 const contract={shop_id:'capabilities.myshopify.com',status:'APPROVED',operation:'bulk_edit',contract:{updates:{title:'Approved'}}};
 for(const version of [undefined,null,'old-version'])assert.throws(()=>bulkInstructions({...contract,contract:{...contract.contract,writeCapabilityVersion:version}},contract.shop_id));
 assert.deepEqual(bulkInstructions({...contract,contract:{...contract.contract,writeCapabilityVersion:WRITE_CAPABILITY_VERSION}},contract.shop_id),{title:'Approved'});
 await assert.rejects(()=>fieldService().requireFields({...args('product.title'),executionContext:{...args('product.title').executionContext,writeCapabilityVersion:'old-version'}}));
 await assert.rejects(()=>fieldService().requireFields({...args('product.title'),executionContext:{...args('product.title').executionContext,writeOperation:'unsupported_op'}}));
 assert.throws(()=>productUpdates({seoTitle:'Unsupported'}));
});
test('each enabled field declares the full matching resource adapter lifecycle',()=>{
 for(const [fieldId,capability] of Object.entries(INSTALLED_WRITE_CAPABILITIES.fields)){
  const adapter=RESOURCE_WRITE_CONTRACTS[capability.resourceType];assert.equal(capability.resourceFamily,'Product');
  assert.equal(capability.targetIdentity,capability.resourceType==='variant'?'ProductVariant':'Product');
  assert.equal(capability.mutationOperation,capability.resourceType==='variant'?'productVariantsBulkUpdate':'productUpdate');
  assert.equal(capability.operandNormalization,'CANONICAL_FIELD_SET');assert.equal(capability.beforeObservation.method,adapter.readMethod);
  assert.equal(capability.afterVerification.requireIntendedValues,true);assert.equal(capability.undo.supported,false);assert.equal(capability.undo.atomicConditionalWrite,false);assert.ok(adapter.names[fieldId]);
 }
 for(const id of ['variant.inventoryQuantity','inventoryItem.unitCost','product.seoTitle'])assert.throws(()=>requireInstalledWriteCapability(id));
});
