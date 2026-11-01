import test from 'node:test';
import assert from 'node:assert/strict';
import {createVariantMutationWriter,WRITE_VARIANT_MUTATION} from './variant-mutation-writer.server.js';
const resourceId='gid://shopify/ProductVariant/11',productId='gid://shopify/Product/1';
const variant={id:resourceId,product:{id:productId},price:'10.00',compareAtPrice:null,barcode:null,taxable:true,inventoryPolicy:'DENY'};
test('variant writer binds exact owner, selected fields and non-partial update semantics',async()=>{
 const calls=[];const writer=createVariantMutationWriter({request:async(query,options)=>{calls.push({query,...options});return query===WRITE_VARIANT_MUTATION?{data:{productVariantsBulkUpdate:{product:{id:productId},productVariants:[variant],userErrors:[]}}}:{data:{productVariant:variant}};}});
 assert.equal((await writer.readVariant({resourceId,productId})).price,'10');
 assert.equal((await writer.applyVariantMutation({resourceId,productId,values:{price:'10.00'}})).productId,productId);
 assert.match(calls[1].query,/allowPartialUpdates:false/);assert.deepEqual(calls[1].variables,{productId,variants:[{id:resourceId,price:'10'}]});
 for(const values of [{title:'wrong resource'},{inventoryQuantity:'5'},{price:'-1'}])await assert.rejects(()=>writer.applyVariantMutation({resourceId,productId,values}));
 assert.equal(calls.length,2);
});
test('variant transport rejects missing fields, wrong resources/families and partial or ambiguous responses',async()=>{
 for(const payload of [null,{...variant,id:'gid://shopify/ProductVariant/12'},{...variant,product:{id:'gid://shopify/Product/2'}},{id:resourceId,product:{id:productId}}]){
  const writer=createVariantMutationWriter({request:async()=>({data:{productVariant:payload}})});await assert.rejects(()=>writer.readVariant({resourceId,productId}));
 }
 for(const response of [{data:{productVariantsBulkUpdate:null}},{errors:[{}],data:{productVariantsBulkUpdate:{product:{id:productId},productVariants:[variant],userErrors:[]}}},{data:{productVariantsBulkUpdate:{product:{id:productId},productVariants:[variant],userErrors:[{message:'rejected'}]}}}]){
  let sends=0;const writer=createVariantMutationWriter({request:async()=>{sends++;return response;}});
  await assert.rejects(()=>writer.applyVariantMutation({resourceId,productId,values:{price:'10'}}));assert.equal(sends,1);
 }
});
