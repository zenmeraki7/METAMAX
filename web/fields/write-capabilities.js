/** Pure installed resource contracts. Metadata never grants authorization. */
import {deepFreeze,FieldError,FIELD_ERROR_CODES as C} from './types.js';
export const WRITE_CAPABILITY_VERSION='resource-set-v2';
export const LEGACY_PRODUCT_WRITE_VERSION='product-set-v1';
export const HISTORY_EXECUTION_CAPABILITIES=deepFreeze({version:1,executor:'HISTORY_RESOURCE_SET',
 jobKinds:['bulk_edit','undo','import'],
 requestShape:{maxResources:1,maxExecutionItems:1,valueKinds:['VALUE'],operations:['set']},
 operations:{bulk_edit:{handoff:'UNIFORM_SELECTED_RESOURCE_SET',resourceTypes:['product','variant']},
 undo:{handoff:'VERIFIED_SOURCE_INVERSE_SET',resourceTypes:['product','variant']},
 import:{handoff:'APPROVED_ROW_RESOURCE_SET',resourceTypes:['product'],mappingVersion:1},
 scheduled_edit:{handoff:'BULK_EDIT_OCCURRENCE',resourceTypes:['product','variant']},
 recurring_edit:{handoff:'BULK_EDIT_OCCURRENCE',resourceTypes:['product','variant']}}});
export const PRODUCT_WRITE_BINDINGS=deepFreeze({title:'product.title',handle:'product.handle',descriptionHtml:'product.descriptionHtml',vendor:'product.vendor',productType:'product.productType',status:'product.status',tags:'product.tags',templateSuffix:'product.templateSuffix'});
export const VARIANT_WRITE_BINDINGS=deepFreeze({price:'variant.price',compareAtPrice:'variant.compareAtPrice',barcode:'variant.barcode',taxable:'variant.taxable',inventoryPolicy:'variant.inventoryPolicy'});
const resource=(kind,gidType,bindings,readMethod,writeMethod)=>({kind,gidType,bindings,names:Object.fromEntries(Object.entries(bindings).map(([name,id])=>[id,name])),readMethod,writeMethod,
 adapterVersion:1,resourceFamily:'Product',targetIdentity:gidType,mutationOperation:kind==='variant'?'productVariantsBulkUpdate':'productUpdate',
 operandNormalization:'CANONICAL_FIELD_SET',beforeObservation:{method:readMethod,exactIdentity:true,completeFields:true},
 afterVerification:{method:readMethod,exactIdentity:true,completeFields:true,requireIntendedValues:true},
 undo:{supported:false,strategy:'VERIFIED_SOURCE_INVERSE_SET',atomicConditionalWrite:false,reason:'UNDO_ATOMICITY_UNAVAILABLE'},allowPartialUpdates:false,executionShape:HISTORY_EXECUTION_CAPABILITIES.requestShape});
export const RESOURCE_WRITE_CONTRACTS=deepFreeze({product:resource('product','Product',PRODUCT_WRITE_BINDINGS,'readProduct','applyMutation'),variant:resource('variant','ProductVariant',VARIANT_WRITE_BINDINGS,'readVariant','applyVariantMutation')});
export const PRODUCT_WRITE_NAMES=RESOURCE_WRITE_CONTRACTS.product.names;
export const INSTALLED_WRITE_CAPABILITIES=deepFreeze({version:WRITE_CAPABILITY_VERSION,fields:Object.fromEntries(Object.values(RESOURCE_WRITE_CONTRACTS).flatMap(writer=>Object.values(writer.bindings).map(id=>[id,{resourceType:writer.kind,adapterVersion:writer.adapterVersion,resourceFamily:writer.resourceFamily,targetIdentity:writer.targetIdentity,mutationOperation:writer.mutationOperation,operandNormalization:writer.operandNormalization,beforeObservation:writer.beforeObservation,afterVerification:writer.afterVerification,undo:writer.undo,operations:['set']}])))});
export function requireResourceWriteContract(kind='product'){
 if(typeof kind!=='string'||!Object.hasOwn(RESOURCE_WRITE_CONTRACTS,kind))throw new FieldError(C.UNSUPPORTED_OPERATION,'Resource writer is not installed');
 return RESOURCE_WRITE_CONTRACTS[kind];
}
/** Inverse plans and reads remain available, but safe Undo dispatch requires an
 * installed writer that atomically compares the expected source AFTER value at
 * mutation time. Application locks and preflight reads do not supply that API.
 */
export function assertInstalledUndoCapability(kind='product'){
 const writer=requireResourceWriteContract(kind);
 if(writer.undo.supported!==true||writer.undo.atomicConditionalWrite!==true)
  throw new FieldError(C.UNSUPPORTED_OPERATION,'UNDO_ATOMICITY_UNAVAILABLE: installed writer cannot conditionally restore this resource');
 return writer;
}
export function resourceTypeForGid(gid){
 if(typeof gid==='string')for(const writer of Object.values(RESOURCE_WRITE_CONTRACTS))if(new RegExp('^gid://shopify/'+writer.gidType+'/[1-9][0-9]*$').test(gid))return writer.kind;
 throw new FieldError(C.UNSUPPORTED_OPERATION,'Resource identity has no installed writer');
}
export function assertWriteCapabilityVersion(version,{resourceType='product'}={}){
 requireResourceWriteContract(resourceType);
 if(version!==WRITE_CAPABILITY_VERSION&&!(version===LEGACY_PRODUCT_WRITE_VERSION&&resourceType==='product'))throw new FieldError(C.CONTRACT_MISMATCH,'Exact installed write capability version required');
}
export function requireInstalledWriteCapability(fieldId,operation='set',version=WRITE_CAPABILITY_VERSION){
 const capability=Object.hasOwn(INSTALLED_WRITE_CAPABILITIES.fields,fieldId)?INSTALLED_WRITE_CAPABILITIES.fields[fieldId]:null;
 if(!capability||!capability.operations.includes(operation))throw new FieldError(C.UNSUPPORTED_OPERATION,'Installed writer does not support this field or operation',{fieldId});
 assertWriteCapabilityVersion(version,{resourceType:capability.resourceType});return capability;
}

/** Installed adapter admission, separate from the richer journal data model. */
export function assertResourceExecutionRequest(entries,{resourceId,itemId}={}){
 if(!Array.isArray(entries)||!entries.length||entries.length>64)throw new FieldError(C.UNSUPPORTED_OPERATION,'Bounded resource SET request required');
 const first=entries[0].intent.identity,writer=requireResourceWriteContract(resourceTypeForGid(first.resourceGid));
 const fields=new Set();
 for(const entry of entries){const identity=entry.intent.identity;
  if(identity.resourceGid!==first.resourceGid||identity.executionItemId!==first.executionItemId||
   resourceId!==undefined&&identity.resourceGid!==resourceId||itemId!==undefined&&identity.executionItemId!==String(itemId)||
   entry.intent.intendedValueKind!=='VALUE'||!Object.hasOwn(writer.names,identity.fieldId)||fields.has(identity.fieldId))
   throw new FieldError(C.UNSUPPORTED_OPERATION,'Installed history adapter requires one exact resource and item with supported VALUE SET fields');
  fields.add(identity.fieldId);
 }
 return writer;
}
