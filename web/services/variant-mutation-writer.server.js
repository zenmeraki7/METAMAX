/** Variant-specific transport; one dispatch admission covers exactly one variant. */
import {FieldError,FIELD_ERROR_CODES as C} from '../fields/types.js';
import {resourceUpdates} from './operation-instructions.server.js';
export const READ_VARIANT_QUERY=`query HistoryVariant($id:ID!){productVariant(id:$id){id product{id} price compareAtPrice barcode taxable inventoryPolicy}}`;
export const WRITE_VARIANT_MUTATION=`mutation HistoryVariantUpdate($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:false){product{id} productVariants{id product{id} price compareAtPrice barcode taxable inventoryPolicy} userErrors{field message}}}`;
const fail=()=>{throw new FieldError(C.CONTRACT_MISMATCH,'Complete exact variant response required');};
function flat(raw,resourceId,productId){
 if(!raw||raw.id!==resourceId||raw.product?.id!==productId)fail();
 const values={};for(const key of ['price','compareAtPrice','barcode','taxable','inventoryPolicy']){
  const value=Object.getOwnPropertyDescriptor(raw,key);if(!value||!Object.hasOwn(value,'value'))fail();values[key]=value.value;
 }
 return {id:resourceId,productId,...resourceUpdates('variant',values)};
}
const errors=response=>response?.errors!=null&&(!Array.isArray(response.errors)||response.errors.length);
export function createVariantMutationWriter({request}){
 if(typeof request!=='function')throw TypeError('Authenticated Shopify request required');
 const identity=({resourceId,productId})=>{if(!/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(resourceId??'')||!/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(productId??''))fail();};
 return Object.freeze({
  async readVariant(input){identity(input);input.signal?.throwIfAborted();const response=await request(READ_VARIANT_QUERY,{variables:{id:input.resourceId},signal:input.signal});if(errors(response))fail();return flat(response?.data?.productVariant,input.resourceId,input.productId);},
  async applyVariantMutation(input){identity(input);const values=resourceUpdates('variant',input.values);input.signal?.throwIfAborted();
   const response=await request(WRITE_VARIANT_MUTATION,{variables:{productId:input.productId,variants:[{id:input.resourceId,...values}]},signal:input.signal});
   const payload=response?.data?.productVariantsBulkUpdate;
   if(errors(response)||!payload||!Array.isArray(payload.userErrors)||payload.userErrors.length||payload.product?.id!==input.productId||!Array.isArray(payload.productVariants)||payload.productVariants.length!==1)fail();
   return flat(payload.productVariants[0],input.resourceId,input.productId);
  }
 });
}
