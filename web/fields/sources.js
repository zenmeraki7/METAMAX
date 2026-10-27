/** Fixed source declarations and coverage requirements; no value extraction,
 * SQL, GraphQL execution, or user-provided query identifiers. */
import { CANONICAL_FIELDS, getCanonicalField } from "./canonical.js";
import { deepFreeze, FieldError, FIELD_LIMITS, isPlainRecord, ownValue, isCoverageToken } from "./types.js";

export const DATASETS = deepFreeze({
  PRODUCTS: "products", VARIANTS: "variants", INVENTORY_ITEMS: "inventory_items",
  INVENTORY_LEVELS: "inventory_levels", INVENTORY_QUANTITIES: "inventory_quantities",
  LOCATIONS: "locations", GOOGLE_SHOPPING: "google_shopping", METAFIELDS: "metafields",
});
const D = DATASETS;
const knownDatasets = new Set(Object.values(D));
const sources = new Map();
const resolvedDescriptors = new WeakMap();

// Internal resolver hook; intentionally not exported by fields/index.js.
// Only backend-created immutable descriptors may enter the coverage API. This
// records local identity; the backend still must establish Shopify provenance.
export function registerResolvedDescriptor(descriptor, provenance) {
  if (!Object.isFrozen(descriptor) || !Object.isFrozen(provenance))
    throw new TypeError("Resolved coverage descriptors and provenance must be immutable");
  resolvedDescriptors.set(descriptor, provenance);
  return descriptor;
}

// Shared identity boundary for value normalization/validation. Do not read an
// untrusted object's id, type or capabilities before checking its identity.
// This deliberately does not resolve raw dynamic IDs without a scoped registry.
export function requireValueField(reference) {
  if (reference && typeof reference === "object") {
    const provenance = resolvedDescriptors.get(reference);
    if (provenance?.kind === "dynamic") return reference;
    if (provenance?.kind === "fixed") return getCanonicalField(provenance.fieldId);
    if (CANONICAL_FIELDS.includes(reference)) return reference;
  } else {
    const field = getCanonicalField(reference);
    if (field) return field;
  }
  throw new FieldError("UNKNOWN_FIELD", "A canonical field or trusted resolved descriptor is required");
}

for (const field of CANONICAL_FIELDS) {
  const record = field.sources.mirror;
  const dataset = field.entity === "variant" ? D.VARIANTS : field.entity === "location" ? D.LOCATIONS : record.dataset;
  const quantity = !!record.quantityName;
  const relationship = field.id === "inventoryLevel.locationId";
  const requires = quantity ? [D.INVENTORY_ITEMS, D.INVENTORY_LEVELS, D.INVENTORY_QUANTITIES]
    : relationship ? [D.INVENTORY_ITEMS, D.INVENTORY_LEVELS, D.LOCATIONS]
    : [dataset];
  const mapping = deepFreeze({
    field: field.id, dataset,
    path: quantity ? "InventoryLevel.quantities" : `${field.sources.shopify.object}.${field.sources.shopify.path.join(".")}`,
    mirror: field.id,
    requires,
    mode: quantity ? "quantity" : relationship ? "relationship"
      : field.id === "product.variantCount" ? "derived"
      : ["product.totalInventory", "variant.inventoryQuantity"].includes(field.id) ? "aggregate" : "direct",
    // Internal adapter metadata is fixed, not accepted from requests. Logical
    // variants/locations coverage must not be confused with physical storage.
    storage: record,
  });
  if (sources.has(field.id) || mapping.field !== field.id ||
      !knownDatasets.has(dataset) || requires.some(item => !knownDatasets.has(item)))
    throw new Error("Invalid or duplicate canonical source mapping");
  sources.set(field.id, mapping);
}
if (sources.size !== CANONICAL_FIELDS.length) throw new Error("Canonical source coverage is incomplete");

export function getFieldSource(fieldId) {
  if (fieldId && typeof fieldId === "object") {
    const provenance = resolvedDescriptors.get(fieldId);
    if (provenance?.kind === "dynamic") return fieldId.source;
    if (provenance?.kind === "fixed") return sources.get(provenance.fieldId) ?? null;
    // Canonical descriptor identities are also trusted; clones are not.
    if (CANONICAL_FIELDS.includes(fieldId)) return sources.get(fieldId.id) ?? null;
    return null;
  }
  const field = getCanonicalField(fieldId);
  return field ? sources.get(field.id) ?? null : null;
}

export function requireFieldSource(fieldId) {
  const mapping = getFieldSource(fieldId);
  if (!mapping) throw new FieldError("FIELD_SOURCE_NOT_FOUND", "No canonical source mapping is available");
  return mapping;
}

export function listFieldSources() {
  return Object.freeze(CANONICAL_FIELDS.map(field => sources.get(field.id)));
}

export function listDatasetFields(dataset) {
  if (typeof dataset !== "string" || !knownDatasets.has(dataset))
    throw new FieldError("UNKNOWN_DATASET", "Unknown logical field dataset");
  return Object.freeze(listFieldSources().filter(mapping => mapping.dataset === dataset));
}

function coverageRequirements(fieldIds) {
  if (!Array.isArray(fieldIds) || fieldIds.length > FIELD_LIMITS.fieldReferences)
    throw new FieldError("INVALID_FIELD_LIST", "A bounded array of field IDs or trusted resolved descriptors is required");
  const required = new Set();
  const dynamic = new Map();
  let shopId;
  for (let i = 0; i < fieldIds.length; i++) {
    const reference = ownValue(fieldIds, String(i));
    const mapping = requireFieldSource(reference);
    for (const dataset of mapping.requires) required.add(dataset);
    const provenance = reference && typeof reference === "object" ? resolvedDescriptors.get(reference) : null;
    if (provenance?.kind === "dynamic") {
      if (shopId !== undefined && provenance.shopId !== shopId)
        throw new FieldError("SHOP_MISMATCH", "Coverage references cannot combine different shops");
      shopId = provenance.shopId;
      const existing = dynamic.get(mapping.field);
      if (existing && ["definitionVersion", "generation", "snapshotId", "shopifyType"].some(key => existing[key] !== provenance[key]))
        throw new FieldError("DYNAMIC_DEFINITION_CONFLICT", "Coverage references contain conflicting definition versions");
      dynamic.set(mapping.field, provenance);
    }
  }
  return { required: [...required].sort(), dynamic };
}

export function requiredDatasets(fieldIds) {
  return Object.freeze(coverageRequirements(fieldIds).required);
}

function scopedCoverage(coverage, context) {
  if (!isPlainRecord(context) || !isCoverageToken(ownValue(context, "shopId")) ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(ownValue(context, "shopId")) ||
      !isCoverageToken(ownValue(context, "generation")) || !isCoverageToken(ownValue(context, "snapshotId")))
    throw new FieldError("COVERAGE_CONTEXT_REQUIRED", "Verified shop, generation and snapshot context is required");
  for (const key of ["shopId", "generation", "snapshotId"]) {
    if (ownValue(coverage, key) !== ownValue(context, key))
      throw new FieldError(key === "shopId" ? "SHOP_MISMATCH" : "COVERAGE_CONTEXT_MISMATCH", "Coverage does not match the expected published context");
  }
  const datasets = ownValue(coverage, "datasets"), definitions = ownValue(coverage, "definitions");
  if (!isPlainRecord(datasets) || !isPlainRecord(definitions))
    throw new FieldError("INVALID_COVERAGE", "Scoped dataset and per-definition coverage records are required");
  return { datasets, definitions };
}

// Legacy fixed-only calls accept flat dataset flags. Dynamic references require
// a scoped envelope and an independently supplied trusted published context.
// These checks do not authenticate the caller or perform mirror ingestion.
export function checkSourceCoverage(fieldIds, coverage, context) {
  const { required, dynamic } = coverageRequirements(fieldIds);
  if (!isPlainRecord(coverage))
    throw new FieldError("INVALID_COVERAGE", "A trusted plain coverage snapshot is required");
  const scoped = dynamic.size > 0 || context !== undefined;
  const envelope = scoped ? scopedCoverage(coverage, context) : null;
  const datasets = envelope?.datasets ?? coverage;
  const missing = required.filter(dataset => ownValue(datasets, dataset) !== true);
  if (!dynamic.size) return deepFreeze({ ready: missing.length === 0, required, missing });
  const definitionFailures = [];
  for (const [fieldId, provenance] of dynamic) {
    if (provenance.shopId !== ownValue(context, "shopId"))
      throw new FieldError("SHOP_MISMATCH", "Dynamic descriptor belongs to another shop");
    if (!provenance.generation || !provenance.snapshotId)
      throw new FieldError("DYNAMIC_COVERAGE_BINDING_REQUIRED", "Dynamic descriptor is not bound to a published generation and snapshot");
    if (provenance.generation !== ownValue(context, "generation") || provenance.snapshotId !== ownValue(context, "snapshotId"))
      throw new FieldError("DYNAMIC_COVERAGE_CONTEXT_MISMATCH", "Dynamic descriptor belongs to another generation or snapshot");
    const entry = ownValue(envelope.definitions, fieldId);
    let reason = null;
    if (!provenance.definitionVersion) reason = "DEFINITION_VERSION_REQUIRED";
    else if (!isPlainRecord(entry)) reason = "DEFINITION_NOT_COVERED";
    else if (ownValue(entry, "complete") !== true) reason = "DEFINITION_NOT_COMPLETE";
    else if (["shopId", "generation", "snapshotId"].some(key => ownValue(entry, key) !== provenance[key]))
      reason = "DEFINITION_CONTEXT_MISMATCH";
    else if (["ownerType", "namespace", "key", "shopifyType", "definitionVersion"].some(key => ownValue(entry, key) !== provenance[key]))
      reason = "DEFINITION_IDENTITY_MISMATCH";
    if (reason) definitionFailures.push({ field: fieldId, reason });
  }
  const requiredDefinitions = [...dynamic.keys()].sort();
  const missingDefinitions = definitionFailures.map(failure => failure.field).sort();
  return deepFreeze({ ready: missing.length === 0 && missingDefinitions.length === 0,
    required, missing, requiredDefinitions, missingDefinitions, definitionFailures });
}
