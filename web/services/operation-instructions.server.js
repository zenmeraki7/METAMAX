import {requireResourceWriteContract,assertWriteCapabilityVersion} from '../fields/write-capabilities.js';
import { isDeepStrictEqual } from "node:util";
import { FieldError, FIELD_ERROR_CODES as C, isPlainObject, deepFreeze } from "../fields/types.js";
import { normalizeWriteOperand, WRITE_OPERATIONS } from "../fields/constraints.js";

// Server-owned product SET bindings. Metadata and arbitrary API properties
// never become mutation instructions.
const fail = message => { throw new FieldError(C.CONTRACT_MISMATCH, message); };

export function contractPayload(contract, shopId, kind) {
  if (!contract || contract.shop_id !== shopId || contract.status !== "APPROVED" || contract.operation !== kind) {
    fail("Approved operation belongs to a different shop or operation");
  }
  const payload = typeof contract.contract === "string" ? JSON.parse(contract.contract) : contract.contract;
  if (!isPlainObject(payload)) fail("Approved operation payload required");
  assertWriteCapabilityVersion(payload.writeCapabilityVersion,{resourceType:payload.resourceType??'product'});
  return payload;
}
function fields(names,resourceType='product') {
  const bindings=requireResourceWriteContract(resourceType).bindings;
  if (!Array.isArray(names) || !names.length || names.length > Object.keys(bindings).length ||
      new Set(names).size !== names.length || names.some(name => !Object.hasOwn(bindings, name))) {
    fail("Unsupported approved product write fields");
  }
  return names;
}
export function resourceUpdates(resourceType,updates) {
  const bindings=requireResourceWriteContract(resourceType).bindings;
  if (!isPlainObject(updates)) fail("Explicit approved updates required");
  const result = {};
  for (const name of fields(Object.keys(updates),resourceType)) {
    const descriptor = Object.getOwnPropertyDescriptor(updates, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("Write accessors are not supported");
    result[name] = normalizeWriteOperand(bindings[name], WRITE_OPERATIONS.SET, descriptor.value);
  }
  return deepFreeze(result);
}
export const productUpdates=updates=>resourceUpdates('product',updates);
export function bulkResourceType(contract,shopId){return contractPayload(contract,shopId,contract.operation).resourceType??'product';}
export function bulkInstructions(contract, shopId) {
  const payload=contractPayload(contract,shopId,'bulk_edit');
  return resourceUpdates(payload.resourceType??'product',payload.updates);
}
export function undoInstructions(contract, shopId) {
  const payload = contractPayload(contract, shopId, "undo");
  if (typeof payload.sourceCommandId !== "string" || !payload.sourceCommandId) fail("Approved undo source required");
  return { sourceCommandId: payload.sourceCommandId, resourceType:payload.resourceType??'product',fields: [...fields(payload.fields,payload.resourceType??'product')] };
}
export function importInstructions(contract,shopId){
 const payload=contractPayload(contract,shopId,'import'),writer=requireResourceWriteContract('product');
 if(payload.importMappingVersion!==1||payload.resourceType!=='product'||!Array.isArray(payload.rows)||!payload.rows.length||payload.rows.length>1000||payload.rowCount!==payload.rows.length)
  fail('Approved versioned product import mappings required');
 const seen=new Set(),fieldIds=new Set();
 const rows=payload.rows.map(row=>{
  if(!isPlainObject(row)||typeof row.resourceGid!=='string'||!/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(row.resourceGid)||seen.has(row.resourceGid)||!isPlainObject(row.fields))fail('Exact distinct approved import resource identities required');
  seen.add(row.resourceGid);
  const updates={};
  for(const [id,value] of Object.entries(row.fields)){
   if(!Object.hasOwn(writer.names,id))fail('Import field has no installed product writer');
   fieldIds.add(id);updates[writer.names[id]]=value;
  }
  const normalized=resourceUpdates('product',updates);
  if(!isDeepStrictEqual(normalized,updates))fail('Import operands must already be canonical');
  return {resourceId:row.resourceGid,updates:normalized};
 });
 if(!Array.isArray(payload.fieldIds)||!isDeepStrictEqual([...fieldIds].sort(),[...payload.fieldIds].sort()))fail('Complete import field membership required');
 return deepFreeze({resourceType:'product',rows,fields:[...fieldIds].map(id=>writer.names[id]).sort()});
}
export function importItemInstructions(contract,shopId,resourceId){
 const row=importInstructions(contract,shopId).rows.find(row=>row.resourceId===resourceId);
 if(!row)fail('Resource is not present in the approved import mappings');
 return row.updates;
}
export function restoredUpdates(before, approvedFields,resourceType='product') {
  if (!isPlainObject(before) || approvedFields.some(name => !Object.hasOwn(before, name))) fail("Incomplete approved before-state");
  return resourceUpdates(resourceType,Object.fromEntries(approvedFields.map(name => [name, before[name]])));
}
export function assertIntendedValues(intended, approved) {
  if (!isDeepStrictEqual(intended, approved)) fail("Job item differs from immutable approved mutation instructions");
}
export async function requireWriteAuthorization(authorizeWrite, context) {
  if (await authorizeWrite(context) !== true) throw new FieldError(C.PERMISSION_DENIED, "Current product write authorization required");
}
