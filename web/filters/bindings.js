/** Server-bootstrap binding metadata. No caller-supplied handlers or issuer. */
import { requireCanonicalField } from "../fields/canonical.js";
import { listOperatorsForType, assertOperatorCompatible } from "../fields/operators.js";
import { deepFreeze, isPlainObject, FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import * as sources from "../fields/sources.js";
import { createHash } from "node:crypto";

export const FILTER_BINDING_VERSION = 2;
export const FILTER_CORRELATION = Object.freeze({ PRODUCT: "product", VARIANT_EXISTS: "variant_exists" });
const ISSUED_REGISTRIES = new WeakSet();
let installed;
const ID = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
// Storage models and dataset registration do not install SQL field adapters.
// Keep the family gate independent of handler metadata and caller definitions.
const SUPPORTED_ENTITIES = Object.freeze(["product", "variant"]);
const HANDLERS = Object.freeze({
  product_column_v1: Object.freeze({ entity: "product", sourceKind: "column", correlation: "product", cost: 1 }),
  variant_exists_v1: Object.freeze({ entity: "variant", sourceKind: "column", correlation: "variant_exists", cost: 2 }),
});
function invalid(message) { throw new FieldError(C.INVALID_DEFINITION, message); }
function data(raw, keys) {
  if (!isPlainObject(raw)) invalid("Invalid binding metadata");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== "string" || !keys.includes(key) || !d || !Object.hasOwn(d, "value")) invalid("Unsupported binding property or accessor");
    result[key] = d.value;
  }
  return result;
}
function dense(raw, max, empty = false) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype ||
      raw.length > max || (!empty && raw.length === 0) || Reflect.ownKeys(raw).length !== raw.length + 1) invalid("Invalid binding definitions array");
  return Array.from({ length: raw.length }, (_, index) => {
    const d = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!d || !Object.hasOwn(d, "value")) invalid("Sparse or accessor-backed binding array");
    return d.value;
  });
}
function strings(raw, max = 32) {
  const values = dense(raw, max);
  if (values.some(value => typeof value !== "string" || !value || value.length > 128) || new Set(values).size !== values.length) invalid("Invalid binding string list");
  return Object.freeze(values);
}
function version(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) invalid("Invalid binding compatibility version");
  return value;
}
function scope(raw, variant) {
  const keys = variant
    ? ["schema", "table", "alias", "shopColumn", "generationColumn", "productIdColumn"]
    : ["alias", "shopColumn", "generationColumn", "idColumn"];
  const value = data(raw, keys);
  for (const key of keys) if (typeof value[key] !== "string" || value[key].trim() !== value[key] || !ID.test(value[key])) invalid("Invalid verified SQL scope identifier");
  return deepFreeze(value);
}

// Private constructor: only the immutable, source-module bootstrap definitions
// are accepted by the no-argument accessor below. SQL functions are never data.
function createFilterBindingRegistry(definitions, rawSchema) {
  const schema = data(rawSchema, ["mirrorSchemaVersion", "sourceContractVersion", "product", "variant"]);
  schema.mirrorSchemaVersion = version(schema.mirrorSchemaVersion);
  schema.sourceContractVersion = version(schema.sourceContractVersion);
  schema.product = scope(schema.product, false);
  schema.variant = scope(schema.variant, true);
  if (schema.product.alias === schema.variant.alias) invalid("Product and variant aliases must differ");
  const registry = new Map();
  for (const raw of dense(definitions, 1000)) {
    const binding = data(raw, ["fieldId", "entity", "sourceKind", "datasets", "correlation", "handlerId", "operators", "cost", "mirrorSchemaVersion", "sourceContractVersion"]);
    const field = requireCanonicalField(binding.fieldId);
    if (!SUPPORTED_ENTITIES.includes(field.entity)) {
      throw new FieldError(C.UNSUPPORTED_OPERATION, "SQL filtering supports only canonical product and variant fields", { fieldId: field.id });
    }
    const sourceDescriptor = sources.FIELD_SOURCES && Object.getOwnPropertyDescriptor(sources.FIELD_SOURCES, field.id);
    const sourceRaw = sourceDescriptor && Object.hasOwn(sourceDescriptor, "value") && sourceDescriptor.value;
    if (!isPlainObject(sourceRaw)) invalid("Trusted field source required");
    const source = Object.create(null);
    for (const key of ["fieldId", "entity", "kind", "canonicalType", "canonicalDerived", "datasets"]) {
      const descriptor = Object.getOwnPropertyDescriptor(sourceRaw, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid("Missing or accessor-backed field source");
      source[key] = descriptor.value;
    }
    const handler = typeof binding.handlerId === "string" && Object.hasOwn(HANDLERS, binding.handlerId) ? HANDLERS[binding.handlerId] : null;
    if (!source || registry.has(field.id) ||
        binding.entity !== field.entity || source.fieldId !== field.id || source.entity !== field.entity ||
        source.canonicalType !== field.type || source.canonicalDerived !== field.derived ||
        typeof binding.sourceKind !== "string" || !binding.sourceKind || binding.sourceKind !== source.kind || !handler || handler.entity !== field.entity || binding.sourceKind !== handler.sourceKind ||
        binding.correlation !== handler.correlation || binding.cost !== handler.cost ||
        binding.mirrorSchemaVersion !== schema.mirrorSchemaVersion || binding.sourceContractVersion !== schema.sourceContractVersion) invalid("Invalid or duplicate compiler binding");
    const expected = strings(source.datasets, 16), actual = strings(binding.datasets, 16);
    // Dataset dependencies have canonical ordered equality, not set membership.
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index]) ||
        actual.some(name => !Object.values(sources.SOURCE_DATASETS).includes(name))) invalid("Binding dataset order mismatch");
    if (!actual.includes(sources.SOURCE_DATASETS.PRODUCTS) ||
        (field.entity === "variant" && !actual.includes(sources.SOURCE_DATASETS.VARIANTS))) invalid("Correlation datasets must include the parent product and variant sources");
    const operators = strings(binding.operators, 32);
    for (const operator of operators) assertOperatorCompatible(operator, field.type);
    // Handlers implement the type-compatible fixed operator catalog only.
    const supported = listOperatorsForType(field.type).map(item => typeof item === "string" ? item : item.id);
    if (operators.some(operator => !supported.includes(operator))) invalid("Unsupported handler operator");
    registry.set(field.id, deepFreeze({ ...binding, datasets: actual, operators }));
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({
    version: FILTER_BINDING_VERSION, schema, definitions: [...registry.values()],
  })).digest("hex");
  const api = Object.freeze({
    version: FILTER_BINDING_VERSION, fingerprint, schema: deepFreeze(schema),
    hasBinding: fieldId => registry.has(fieldId),
    requireBinding(fieldId) {
      const binding = registry.get(fieldId);
      if (!binding) throw new FieldError(C.UNSUPPORTED_OPERATION, "SQL binding not available", { fieldId });
      return binding; // metadata only; no compile function escapes
    },
    listFieldIds: () => Object.freeze([...registry.keys()].sort()),
  });
  ISSUED_REGISTRIES.add(api);
  return api;
}

export function getFilterBindingRegistry(...args) {
  if (args.length) invalid("Binding configuration belongs to server bootstrap");
  if (!installed) {
    if (!sources.FIELD_SOURCES || !sources.FILTER_BINDING_DEFINITIONS || !sources.FILTER_SQL_SCHEMA) {
      throw new FieldError(C.CONTRACT_MISMATCH, "Verified compiler bootstrap bindings unavailable");
    }
    installed = createFilterBindingRegistry(sources.FILTER_BINDING_DEFINITIONS, sources.FILTER_SQL_SCHEMA);
  }
  return installed;
}

export function assertFilterBindingRegistry(value) {
  if (!value || typeof value !== "object" || !ISSUED_REGISTRIES.has(value)) invalid("Trusted binding registry required");
  return value;
}
