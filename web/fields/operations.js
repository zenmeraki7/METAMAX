import { getCanonicalField, getFieldDefinition } from "./canonical.js";
import { requireValueField } from "./sources.js";
import { hasFieldCapability, assertFieldCapability } from "./capabilities.js";
import { requireValidFieldValue } from "./validate.js";
import { FieldError, FIELD_LIMITS, deepFreeze, isPlainRecord, ownValue } from "./types.js";

export const EDIT_OPERATIONS = Object.freeze({ SET: "set", ADD_TAGS: "add_tags", REMOVE_TAGS: "remove_tags" });
export const FIELD_OPERATIONS = EDIT_OPERATIONS;
const definitions = deepFreeze({
  set: { id: "set", label: "Set value", input: "field_value", requiresCurrentValue: false },
  add_tags: { id: "add_tags", label: "Add tags", input: "string_list", requiresCurrentValue: false, mutationFamily: "tagsAdd" },
  remove_tags: { id: "remove_tags", label: "Remove tags", input: "string_list", requiresCurrentValue: false, mutationFamily: "tagsRemove" },
});
// Explicit initial write surface. Canonical aliases resolve before this lookup.
const allowedByField = deepFreeze({
  "product.title": ["set"], "product.handle": ["set"], "product.descriptionHtml": ["set"],
  "product.vendor": ["set"], "product.productType": ["set"], "product.status": ["set"],
  "product.tags": ["set", "add_tags", "remove_tags"],
  "variant.price": ["set"], "variant.compareAtPrice": ["set"],
  "inventoryItem.sku": ["set"],
});
for (const [id, operations] of Object.entries(allowedByField)) {
  const field = getCanonicalField(id);
  if (!field || !hasFieldCapability(id, "edit") || operations.some(operation =>
    !Object.hasOwn(definitions, operation) || !field.operations.includes(operation)))
  throw new Error("Operation allowlist does not match the canonical field contract");
}

export class FieldOperationError extends FieldError {
  constructor(code, message, field = null) {
    super(code, message, field);
    this.name = "FieldOperationError";
  }
}

export function getEditOperation(operationId) {
  return typeof operationId === "string" && Object.hasOwn(definitions, operationId) ? definitions[operationId] : null;
}

export function listEditOperations() {
  return Object.freeze(Object.values(definitions));
}

export function supportsFieldOperation(fieldReference, operationId) {
  let field;
  try {
    field = requireValueField(fieldReference);
  } catch {
    return false;
  }
  if (!field || !getEditOperation(operationId)) return false;
  if (field.dynamic) {
    return (
      field.capabilities?.editable === true &&
      (field.operations || field.capabilities?.operations || []).includes(operationId)
    );
  }
  return hasFieldCapability(field.id, "edit") && (allowedByField[field.id] ?? []).includes(operationId);
}

export function listFieldOperations(fieldReference) {
  let field;
  try {
    field = requireValueField(fieldReference);
  } catch {
    return Object.freeze([]);
  }
  if (!field) return Object.freeze([]);
  if (field.dynamic) {
    if (!field.capabilities?.editable) return Object.freeze([]);
    const allowed = field.operations || field.capabilities?.operations || [];
    return Object.freeze(allowed.map(id => definitions[id]).filter(Boolean));
  }
  if (!hasFieldCapability(field.id, "edit")) return Object.freeze([]);
  return Object.freeze((allowedByField[field.id] ?? []).map(id => definitions[id]));
}

export function requireFieldOperation(fieldReference, operationId) {
  let field;
  try {
    field = requireValueField(fieldReference);
  } catch (error) {
    throw new FieldOperationError("UNKNOWN_FIELD", "A canonical field or trusted resolved descriptor is required");
  }
  const operation = getEditOperation(operationId);
  if (!operation) throw new FieldOperationError("UNKNOWN_OPERATION", "Unknown edit operation", field.id);
  if (!supportsFieldOperation(field, operationId))
    throw new FieldOperationError("OPERATION_NOT_SUPPORTED", "Operation is not supported for this field", field.id);
  return operation;
}

// Shape and operation compatibility only; no authorization, execution, derived
// price calculation or mutation calls. Central validation owns field value rules.
export function validateEditOperation(fieldReference, operationId, input) {
  let field;
  try {
    field = requireValueField(fieldReference);
    requireFieldOperation(field, operationId);
    if (["add_tags", "remove_tags"].includes(operationId)) {
      if (!Array.isArray(input)) throw new FieldOperationError("INVALID_TAGS", "Expected an array of tags", field.id);
      if (input.length < 1 || input.length > 250)
        throw new FieldOperationError("INVALID_TAG_COUNT", "Expected between 1 and 250 tags", field.id);
    }
    const value = requireValidFieldValue(field, input, { purpose: "edit" });
    return deepFreeze({ valid: true, field: field.id, operation: operationId, value, code: null, message: null });
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    return Object.freeze({
      valid: false,
      field: field?.id ?? (typeof fieldReference === "string" ? fieldReference : fieldReference?.id ?? null),
      operation: getEditOperation(operationId)?.id ?? null,
      value: undefined,
      code: error.code,
      message: error.message,
    });
  }
}

export function requireValidEditOperation(fieldReference, operationId, input) {
  const result = validateEditOperation(fieldReference, operationId, input);
  if (!result.valid) throw new FieldOperationError(result.code, result.message, result.field);
  return result.value;
}

// Legacy operation normalizer retains complete operation and value checks.
export const normalizeOperand = requireValidEditOperation;

function checkedKeys(change) {
  if (!isPlainRecord(change)) throw new FieldError("INVALID_FIELD_CHANGE", "Change must be a plain object");
  for (const key of Reflect.ownKeys(change)) {
    if (typeof key !== "string" || !["field", "operation", "value"].includes(key))
      throw new FieldError("INVALID_FIELD_CHANGE", "Change contains unsupported properties");
    ownValue(change, key);
  }
}

// Field-level checks are reusable at submission, planning and execution. The
// execution layer must additionally validate targets, leases and fresh state.
export function assertValidChange(change, context) {
  checkedKeys(change);
  const fieldRef = ownValue(change, "field");
  const field = requireValueField(fieldRef);
  const operation = ownValue(change, "operation");
  requireFieldOperation(field, operation);
  if (field.dynamic) {
    if (!field.capabilities?.editable) {
      throw new FieldError("CAPABILITY_NOT_SUPPORTED", "Field does not declare edit capability", field.id);
    }
  } else {
    assertFieldCapability(field.id, "edit", context);
  }
  const value = requireValidEditOperation(field, operation, ownValue(change, "value"));
  return deepFreeze({ field: field.id, operation, value });
}

export function assertValidChanges(changes, context) {
  if (!Array.isArray(changes) || changes.length < 1 || changes.length > FIELD_LIMITS.changes)
    throw new FieldError("INVALID_FIELD_CHANGES", "A bounded, nonempty changes array is required");
  const normalized = [], seen = new Set();
  for (let i = 0; i < changes.length; i++) {
    const change = assertValidChange(ownValue(changes, String(i)), context);
    if (seen.has(change.field))
      throw new FieldError("DUPLICATE_FIELD_CHANGE", "A field can be changed only once in a plan", change.field);
    seen.add(change.field);
    normalized.push(change);
  }
  return Object.freeze(normalized);
}

export function validateChange(change, context) {
  try { return deepFreeze({ ok: true, value: assertValidChange(change, context), errors: [] }); }
  catch (error) {
    if (!(error instanceof FieldError)) throw error;
    return deepFreeze({ ok: false, errors: [{ code: error.code, field: error.field, message: error.message }] });
  }
}
