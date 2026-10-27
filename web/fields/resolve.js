import { CANONICAL_FIELDS, getCanonicalField, getFieldDefinition } from "./canonical.js";
import { requireValidFieldValue } from "./validate.js";
import { metafieldContract } from "./metafields.js";
import { getCapabilities, getFieldCapabilities } from "./capabilities.js";
import { DATASETS, getFieldSource, registerResolvedDescriptor, requireValueField } from "./sources.js";
import { FieldError, ownValue, deepFreeze, FIELD_LIMITS, isPlainRecord, isCoverageToken } from "./types.js";

export const METAFIELD_OWNERS = deepFreeze({ PRODUCT: "product", VARIANT: "variant" });
const ownerTypes = Object.freeze({ product: "PRODUCT", variant: "PRODUCTVARIANT" });
const metafieldTypes = Object.freeze({
  single_line_text_field: "text", multi_line_text_field: "text",
  number_integer: "integer", number_decimal: "decimal", boolean: "boolean",
  "list.single_line_text_field": "string_list",
});
const partPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const idPattern = /^metafield:(product|variant):([a-zA-Z0-9_][a-zA-Z0-9_-]*)\.([a-zA-Z0-9_][a-zA-Z0-9_-]*)$/;
const registryState = new WeakMap();
const fixedDescriptors = new Map();

export class FieldResolutionError extends FieldError {
  constructor(code, message) {
    super(code, message);
    this.name = "FieldResolutionError";
  }
}
const fail = (code, message) => { throw new FieldResolutionError(code, message); };

function assertShop(shopId) {
  if (typeof shopId !== "string" || shopId.length > 255 ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopId))
    fail("SHOP_CONTEXT_REQUIRED", "A verified canonical shop domain is required");
}

function assertPart(value) {
  if (typeof value !== "string" || value.length > 255 || !partPattern.test(value))
    fail("INVALID_METAFIELD_IDENTITY", "Invalid concrete metafield namespace or key");
}

export function makeMetafieldId(identity) {
  if (!isPlainRecord(identity)) fail("INVALID_METAFIELD_IDENTITY", "A metafield identity object is required");
  const owner = ownValue(identity, "owner"), namespace = ownValue(identity, "namespace"), key = ownValue(identity, "key");
  if (typeof owner !== "string" || !Object.hasOwn(ownerTypes, owner))
    fail("UNSUPPORTED_OWNER", "Only product and variant metafields are supported");
  assertPart(namespace); assertPart(key);
  return `metafield:${owner}:${namespace}.${key}`;
}

export function parseMetafieldId(id) {
  if (typeof id !== "string" || id.length > 532) return null;
  const match = idPattern.exec(id);
  if (!match || match[2].length > 255 || match[3].length > 255) return null;
  return Object.freeze({ owner: match[1], namespace: match[2], key: match[3] });
}

// Backend-only factory. Shape validation and local registry branding do not
// establish Shopify provenance, current access, generation, or definition freshness.
export function createMetafieldRegistry(shopId, definitions, coverageContext = {}) {
  assertShop(shopId);
  if (!isPlainRecord(coverageContext) || Reflect.ownKeys(coverageContext).some(key => !["generation", "snapshotId"].includes(key)))
    fail("INVALID_COVERAGE_CONTEXT", "Registry coverage binding must contain generation and snapshotId only");
  const generation = ownValue(coverageContext, "generation") ?? null;
  const snapshotId = ownValue(coverageContext, "snapshotId") ?? null;
  if ((generation !== null || snapshotId !== null) && (!isCoverageToken(generation) || !isCoverageToken(snapshotId)))
    fail("INVALID_COVERAGE_CONTEXT", "Both generation and snapshotId must be valid backend tokens");
  if (!Array.isArray(definitions) || definitions.length > FIELD_LIMITS.metafieldDefinitions)
    fail("INVALID_DEFINITIONS", "A bounded array of verified definition projections is required");
  const entries = new Map();
  for (let i = 0; i < definitions.length; i++) {
    const definition = ownValue(definitions, String(i));
    if (!isPlainRecord(definition)) fail("INVALID_DEFINITION", "Invalid metafield definition projection");
    for (const key of Reflect.ownKeys(definition)) {
      if (typeof key !== "string" || !["owner", "ownerType", "namespace", "key", "name", "type", "definitionVersion", "validations", "access"].includes(key))
        fail("INVALID_DEFINITION", "Definition projection contains unsupported properties");
      ownValue(definition, key);
    }
    const owner = ownValue(definition, "owner"), namespace = ownValue(definition, "namespace"), key = ownValue(definition, "key");
    const id = makeMetafieldId({ owner, namespace, key });
    const shopifyType = ownValue(definition, "type");
    if (typeof shopifyType !== "string" || !Object.hasOwn(metafieldTypes, shopifyType))
      fail("UNSUPPORTED_METAFIELD_TYPE", "Metafield type is not supported by this registry");
    if (entries.has(id)) fail("DUPLICATE_METAFIELD", "Duplicate metafield definition identity");
    const name = ownValue(definition, "name");
    if (name !== undefined && (typeof name !== "string" || name.length > 1024 || /\0|\p{Surrogate}/u.test(name)))
      fail("INVALID_DEFINITION", "Invalid metafield display name");
    const definitionVersion = ownValue(definition, "definitionVersion") ?? null;
    if (definitionVersion !== null && !isCoverageToken(definitionVersion))
      fail("INVALID_DEFINITION_VERSION", "Definition version must be an opaque backend revision token");
    const descriptor = deepFreeze({
      id, label: name?.trim() || `${namespace}.${key}`, entity: owner, scope: owner,
      type: metafieldTypes[shopifyType], dynamic: true, nullable: true,
      shopId, namespace, key, ownerType: ownerTypes[owner], shopifyType,
      definitionVersion, coverageContext: { generation, snapshotId },
      readScopes: ["read_products"], writeScopes: ["write_products"],
      metafieldContract: metafieldContract(definition, shopifyType, ownerTypes[owner]),
      // A definition does not grant value access or prove a query/export adapter.
      capabilities: { readable: false, filterable: false, sortable: false,
        editable: false, import: false, export: false, undo: false, operations: [],
        reasons: ["METAFIELD_ACCESS_AND_ADAPTER_UNVERIFIED"] },
      source: { field: id, dataset: DATASETS.METAFIELDS, path: null,
        mirror: "metafield.value", requires: [owner === "product" ? DATASETS.PRODUCTS : DATASETS.VARIANTS, DATASETS.METAFIELDS],
        mode: "metafield", owner, namespace, key },
    });
    registerResolvedDescriptor(descriptor, Object.freeze({ kind: "dynamic", fieldId: id,
      shopId, generation, snapshotId, definitionVersion, ownerType: ownerTypes[owner], namespace, key, shopifyType }));
    entries.set(id, descriptor);
  }
  const registry = Object.freeze({
    shopId,
    get: id => entries.get(id) ?? null,
    has: id => entries.has(id),
    list: () => Object.freeze([...entries.values()]),
  });
  registryState.set(registry, { shopId, entries });
  return registry;
}

function checkedContext(context) {
  if (!isPlainRecord(context)) fail("INVALID_FIELD_CONTEXT", "A trusted plain resolution context is required");
  return context;
}

function scopedRegistry(context) {
  const shopId = ownValue(context, "shopId"), registry = ownValue(context, "metafields");
  assertShop(shopId);
  if (registry === undefined || registry === null) return null;
  const state = registryState.get(registry);
  if (!state) fail("INVALID_REGISTRY", "A backend-created metafield registry is required");
  if (state.shopId !== shopId) fail("SHOP_MISMATCH", "Metafield registry belongs to another shop");
  return state.entries;
}

function resolveFixed(field, context) {
  if (ownValue(context, "scopes") === undefined && ownValue(context, "completedDatasets") === undefined) {
    if (!fixedDescriptors.has(field.id)) fixedDescriptors.set(field.id, registerResolvedDescriptor(deepFreeze({
      ...field, dynamic: false, declaredCapabilities: getFieldCapabilities(field.id),
      capabilities: getCapabilities(field.id), source: getFieldSource(field.id),
    }), Object.freeze({ kind: "fixed", fieldId: field.id })));
    return fixedDescriptors.get(field.id);
  }
  return registerResolvedDescriptor(deepFreeze({ ...field, dynamic: false, declaredCapabilities: getFieldCapabilities(field.id),
    capabilities: getCapabilities(field.id, context), source: getFieldSource(field.id) }), Object.freeze({ kind: "fixed", fieldId: field.id }));
}

// Resolve IDs in a trusted shop context before passing dynamic descriptors to
// value validation. Resolution alone does not grant access or write capability.
export function resolveField(fieldId, context = {}) {
  checkedContext(context);
  const fixed = getCanonicalField(fieldId);
  if (fixed) return resolveFixed(fixed, context);
  if (!parseMetafieldId(fieldId)) return null;
  return scopedRegistry(context)?.get(fieldId) ?? null;
}

export function requireResolvedField(fieldId, context) {
  const field = resolveField(fieldId, context);
  if (!field) fail("FIELD_NOT_FOUND", "Unknown or unavailable field");
  return field;
}

export function listResolvedFields(context = {}) {
  checkedContext(context);
  const registry = ownValue(context, "metafields");
  // Validate identity before invoking any dynamic lookup or exposing its list.
  const dynamic = registry === undefined || registry === null ? [] : [...scopedRegistry(context).values()];
  return Object.freeze([...CANONICAL_FIELDS.map(field => resolveFixed(field, context)), ...dynamic]);
}

export function resolveSource(fieldId, source = "mirror") {
  const field = getFieldDefinition(fieldId);
  const descriptor = typeof source === "string" ? ownValue(field.sources, source) : undefined;
  if (!descriptor) throw new FieldError("UNKNOWN_FIELD_SOURCE", "Unsupported field source", field.id);
  return descriptor;
}

// Pure projection only. Callers must fetch records using verified tenant/snapshot
// context; this function never authenticates, queries a database, or fetches Shopify.
export function resolveFieldValue(fieldReference, record, options) {
  const field = requireValueField(fieldReference);
  if (field.dynamic)
    throw new FieldError("NOT_SUPPORTED", "Dynamic field record extraction requires an active metafield adapter", field.id);
  return requireValidFieldValue(field, readSourceValue(field, record, options), { purpose: "read" });
}

function atPath(record, path) {
  let value = record;
  for (const key of path) {
    if (value === null) return null;
    value = ownValue(value, key);
    if (value === undefined) return undefined;
  }
  return value;
}

export function readSourceValue(definition, record, { source = "mirror", variantId } = {}) {
  const descriptor = typeof source === "string" ? ownValue(definition.sources, source) : undefined;
  if (!descriptor) throw new FieldError("UNKNOWN_FIELD_SOURCE", "Unsupported field source", definition.id);
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new FieldError("INVALID_FIELD_SOURCE", "An entity record is required", definition.id);
  if (descriptor.precisionPath && atPath(record, descriptor.precisionPath) !== "EXACT")
    throw new FieldError("INEXACT_FIELD_SOURCE", "An exact count is required", definition.id);
  let selected = record;
  if (descriptor.collectionPath) {
    if (typeof variantId !== "string" || !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(variantId))
      throw new FieldError("VARIANT_TARGET_REQUIRED", "An explicit variant GID is required", definition.id);
    const variants = atPath(record, descriptor.collectionPath);
    if (!Array.isArray(variants) || variants.length > FIELD_LIMITS.variants)
      throw new FieldError("INVALID_FIELD_SOURCE", "A complete bounded variant array is required", definition.id);
    const matches = [];
    for (let i = 0; i < variants.length; i++) {
      const variant = ownValue(variants, String(i));
      if (ownValue(variant, "id") === variantId) matches.push(variant);
    }
    if (matches.length !== 1)
      throw new FieldError("VARIANT_TARGET_MISMATCH", "Variant must match exactly one source record", definition.id);
    selected = matches[0];
  }
  if (descriptor.quantityName) {
    if (source === "shopify") {
      const quantities = ownValue(record, "quantities");
      if (!Array.isArray(quantities) || quantities.length > 1000)
        throw new FieldError("INVALID_FIELD_SOURCE", "Inventory quantities are required", definition.id);
      const matches = [];
      for (let i = 0; i < quantities.length; i++) {
        const quantity = ownValue(quantities, String(i));
        if (ownValue(quantity, "name") === descriptor.quantityName) matches.push(quantity);
      }
      if (matches.length !== 1)
        throw new FieldError("QUANTITY_TARGET_MISMATCH", "Quantity must match exactly one source record", definition.id);
      selected = matches[0];
    } else if (ownValue(record, "name") !== descriptor.quantityName) {
      throw new FieldError("QUANTITY_TARGET_MISMATCH", "Inventory quantity name does not match the field", definition.id);
    }
  }
  const value = atPath(selected, descriptor.path);
  if (value === undefined)
    throw new FieldError("FIELD_VALUE_MISSING", "The requested field was not loaded", definition.id);
  return value;
}
