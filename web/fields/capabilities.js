import { CANONICAL_FIELDS, getCanonicalField, getFieldDefinition } from "./canonical.js";
import { getFieldSource, DATASETS } from "./sources.js";
import { FieldError, deepFreeze, isPlainRecord, ownValue } from "./types.js";

export const CAPABILITIES = Object.freeze({
  FILTER: "filter", EDIT: "edit", IMPORT: "import", EXPORT: "export", UNDO: "undo",
});
const capabilityKeys = Object.freeze({
  filter: "filterable", edit: "editable", import: "importable", export: "exportable", undo: "undoable",
});
const restrictions = deepFreeze({
  "variant.sku": { edit: false, import: false, undo: false },
  "variant.barcode": { edit: false, import: false, undo: false },
  "inventoryItem.tracked": { edit: false, import: false, undo: false },
  "inventoryItem.requiresShipping": { edit: false, import: false, undo: false },
});
for (const [field, rules] of Object.entries(restrictions)) {
  if (!getCanonicalField(field) || Object.values(rules).some(value => value !== false))
    throw new Error("Capability restrictions must only reduce known canonical fields");
}

function assertCapability(capability) {
  if (typeof capability !== "string" || !Object.hasOwn(capabilityKeys, capability))
    throw new FieldError("UNKNOWN_FIELD_CAPABILITY", "Unknown field capability");
}

// Declaration only: this does not establish runtime authorization or readiness.
export function getFieldCapabilities(fieldId) {
  const field = getCanonicalField(fieldId);
  if (!field) return null;
  const reduced = ownValue(restrictions, field.id) ?? {};
  return Object.freeze(Object.fromEntries(Object.entries(capabilityKeys).map(([capability, key]) => [
    capability, field[key] === true && ownValue(reduced, capability) !== false,
  ])));
}

export function hasFieldCapability(fieldId, capability) {
  assertCapability(capability);
  return getFieldCapabilities(fieldId)?.[capability] === true;
}

export function requireFieldCapability(fieldId, capability) {
  assertCapability(capability);
  const field = getFieldDefinition(fieldId);
  if (!hasFieldCapability(field.id, capability))
    throw new FieldError("CAPABILITY_NOT_SUPPORTED", "Field does not declare this capability", field.id);
  return field;
}

export function listFieldsByCapability(capability) {
  assertCapability(capability);
  return Object.freeze(CANONICAL_FIELDS.filter(field => hasFieldCapability(field.id, capability)));
}

export function listFieldCapabilities() {
  return deepFreeze(CANONICAL_FIELDS.map(field => ({ field: field.id, capabilities: getFieldCapabilities(field.id) })));
}

function stringSet(value) {
  if (value === undefined) return new Set();
  if (!Array.isArray(value) || value.length > 1000)
    throw new FieldError("INVALID_FIELD_CONTEXT", "Capability context must contain bounded string arrays");
  const result = new Set();
  for (let i = 0; i < value.length; i++) {
    const entry = ownValue(value, String(i));
    if (typeof entry !== "string" || entry.length > 128)
      throw new FieldError("INVALID_FIELD_CONTEXT", "Invalid capability context entry");
    result.add(entry);
  }
  return result;
}

const availability = reason => Object.freeze({ available: reason === null, reason });

function readAvailability(field, context) {
  if (!isPlainRecord(context)) return availability("CONTEXT_REQUIRED");
  if (ownValue(context, "authorized") !== true) return availability("NOT_AUTHORIZED");
  const scopes = stringSet(ownValue(context, "scopes"));
  const datasets = stringSet(ownValue(context, "completedDatasets"));
  // Compatibility with the current mirror's physical dataset names. A complete
  // product import already validates the full nested variant set before sealing.
  if (datasets.has("products")) datasets.add(DATASETS.VARIANTS);
  if (datasets.has("inventory_locations")) datasets.add(DATASETS.LOCATIONS);
  const allows = required => required.every(scope => scopes.has(scope) ||
    (scope.startsWith("read_") && scopes.has(`write_${scope.slice(5)}`)));
  const covered = getFieldSource(field.id).requires.every(dataset => datasets.has(dataset));
  if (ownValue(context, "coverageReady") !== true || !covered) return availability("DATASET_NOT_READY");
  if (!allows(field.readScopes)) return availability("READ_SCOPE_MISSING");
  return availability(null);
}

// Final field-level gate only. Context must be assembled by trusted backend
// authorization, coverage and gateway services, never copied from request JSON.
export function checkFieldAvailability(fieldId, capability, context) {
  assertCapability(capability);
  const field = getCanonicalField(fieldId);
  if (!field) return availability("UNKNOWN_FIELD");
  if (!hasFieldCapability(field.id, capability)) return availability("CAPABILITY_NOT_SUPPORTED");
  const read = readAvailability(field, context);
  if (!read.available) return read;
  if (["edit", "import", "undo"].includes(capability)) {
    const scopes = stringSet(ownValue(context, "scopes"));
    if (!field.writeScopes.length || !field.writeScopes.every(scope => scopes.has(scope)))
      return availability("WRITE_SCOPE_MISSING");
    if (ownValue(context, "writeAdapterReady") !== true) return availability("WRITE_ADAPTER_NOT_READY");
    if (capability === "undo" && ownValue(context, "undoJournalReady") !== true)
      return availability("UNDO_JOURNAL_NOT_READY");
  }
  return availability(null);
}

// Compatibility API: returns runtime availability, not declarations.
export function getCapabilities(fieldId, context = {}) {
  const field = getFieldDefinition(fieldId);
  const read = readAvailability(field, context);
  const filter = checkFieldAvailability(field.id, "filter", context);
  const edit = checkFieldAvailability(field.id, "edit", context);
  const importStatus = checkFieldAvailability(field.id, "import", context);
  const exportStatus = checkFieldAvailability(field.id, "export", context);
  const undo = checkFieldAvailability(field.id, "undo", context);
  const reasons = [...new Set([read.reason, edit.reason].filter(Boolean))];
  return deepFreeze({
    field: field.id, readable: read.available, filterable: filter.available,
    sortable: read.available && field.sortable, editable: edit.available,
    importable: importStatus.available, exportable: exportStatus.available, undoable: undo.available,
    operations: edit.available ? [...field.operations] : [],
    readScopes: [...field.readScopes], writeScopes: [...field.writeScopes], reasons,
  });
}

export function assertFieldCapability(fieldId, action, context) {
  const key = { read: "readable", filter: "filterable", sort: "sortable", edit: "editable", import: "importable", export: "exportable", undo: "undoable" };
  if (typeof action !== "string" || !Object.hasOwn(key, action)) throw new FieldError("UNKNOWN_FIELD_CAPABILITY", "Unknown field capability");
  const capabilities = getCapabilities(fieldId, context);
  if (!capabilities[key[action]])
    throw new FieldError("FIELD_CAPABILITY_DENIED", "Field capability is unavailable for the supplied runtime context", capabilities.field);
  return capabilities;
}
