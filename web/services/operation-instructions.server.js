import { isDeepStrictEqual } from "node:util";
import { FieldError, FIELD_ERROR_CODES as C, isPlainObject, deepFreeze } from "../fields/types.js";
import { normalizeWriteOperand, WRITE_OPERATIONS } from "../fields/constraints.js";

// Server-owned product SET bindings. Metadata and arbitrary API properties
// never become mutation instructions.
const bindings = Object.freeze({
  title: "product.title", handle: "product.handle", descriptionHtml: "product.descriptionHtml",
  vendor: "product.vendor", productType: "product.productType", status: "product.status",
  tags: "product.tags", templateSuffix: "product.templateSuffix",
});
const fail = message => { throw new FieldError(C.CONTRACT_MISMATCH, message); };

export function contractPayload(contract, shopId, kind) {
  if (!contract || contract.shop_id !== shopId || contract.status !== "APPROVED" || contract.operation !== kind) {
    fail("Approved operation belongs to a different shop or operation");
  }
  const payload = typeof contract.contract === "string" ? JSON.parse(contract.contract) : contract.contract;
  if (!isPlainObject(payload)) fail("Approved operation payload required");
  return payload;
}
function fields(names) {
  if (!Array.isArray(names) || !names.length || names.length > Object.keys(bindings).length ||
      new Set(names).size !== names.length || names.some(name => !Object.hasOwn(bindings, name))) {
    fail("Unsupported approved product write fields");
  }
  return names;
}
export function productUpdates(updates) {
  if (!isPlainObject(updates)) fail("Explicit approved updates required");
  const result = {};
  for (const name of fields(Object.keys(updates))) {
    const descriptor = Object.getOwnPropertyDescriptor(updates, name);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("Write accessors are not supported");
    result[name] = normalizeWriteOperand(bindings[name], WRITE_OPERATIONS.SET, descriptor.value);
  }
  return deepFreeze(result);
}
export function bulkInstructions(contract, shopId) {
  return productUpdates(contractPayload(contract, shopId, "bulk_edit").updates);
}
export function undoInstructions(contract, shopId) {
  const payload = contractPayload(contract, shopId, "undo");
  if (typeof payload.sourceCommandId !== "string" || !payload.sourceCommandId) fail("Approved undo source required");
  return { sourceCommandId: payload.sourceCommandId, fields: [...fields(payload.fields)] };
}
export function restoredUpdates(before, approvedFields) {
  if (!isPlainObject(before) || approvedFields.some(name => !Object.hasOwn(before, name))) fail("Incomplete approved before-state");
  return productUpdates(Object.fromEntries(approvedFields.map(name => [name, before[name]])));
}
export function assertIntendedValues(intended, approved) {
  if (!isDeepStrictEqual(intended, approved)) fail("Job item differs from immutable approved mutation instructions");
}
export async function requireWriteAuthorization(authorizeWrite, context) {
  if (await authorizeWrite(context) !== true) throw new FieldError(C.PERMISSION_DENIED, "Current product write authorization required");
}
