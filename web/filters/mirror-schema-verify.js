/** Server-only catalog bootstrap API. Private capability state never escapes. */
import { createMirrorSqlSchema, assertMirrorSqlSchema, quoteIdentifier, quoteQualifiedTable } from "./mirror-schema.js";
import { getFilterBindingRegistry } from "./bindings.js";
import {
  verifyMirrorSqlSchema as verifyPhysicalSchema, assertVerifiedMirrorSqlSchema,
} from "../services/mirror-schema.server.js";
import { isPlainObject } from "../fields/types.js";

export {
  assertVerifiedMirrorSqlSchema, assertPhysicalColumn, assertVerifiedFieldBinding,
  assertCursorOrdering, invalidateVerifiedMirrorSqlSchema, revalidateMirrorSqlSchema,
} from "../services/mirror-schema.server.js";
export { assertVerifiedMirrorSqlSchema as assertVerifiedMirrorSchema } from "../services/mirror-schema.server.js";

function data(raw, keys, required = keys) {
  if (!isPlainObject(raw)) throw new TypeError("Server-owned schema configuration required");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== "string" || !keys.includes(key) || !descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Unexpected schema configuration property or accessor");
    }
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw new TypeError("Missing schema configuration property");
  return result;
}

/** Bootstrap and post-migration only; accepts the current or supplied adapter contract. */
export async function verifyMirrorSqlSchema(options) {
  if (isPlainObject(options) && Object.hasOwn(options, "database")) {
    const current = data(options, ["database", "schema", "mirrorSchemaVersion", "sourceContractVersion", "fieldMappings"],
      ["database", "schema", "mirrorSchemaVersion", "sourceContractVersion"]);
    return verifyPhysicalSchema(current);
  }
  const config = data(options, ["db", "schema", "namespace", "revision", "columns", "sourceContractVersion"],
    ["db", "schema", "namespace", "revision", "columns"]);
  assertMirrorSqlSchema(config.schema);
  quoteIdentifier(config.namespace);
  for (const table of [config.schema.products, config.schema.variants]) {
    if (table.schema !== undefined && table.schema !== config.namespace) throw new TypeError("Conflicting physical namespace");
  }
  const schema = createMirrorSqlSchema({
    products: { ...config.schema.products, schema: config.namespace },
    variants: { ...config.schema.variants, schema: config.namespace },
  });
  if (!isPlainObject(config.columns) || Reflect.ownKeys(config.columns).length > 1000) throw new TypeError("Invalid approved columns");
  const fieldMappings = [];
  for (const fieldId of Reflect.ownKeys(config.columns)) {
    if (typeof fieldId !== "string") throw new TypeError("Invalid approved field ID");
    const descriptor = Object.getOwnPropertyDescriptor(config.columns, fieldId);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Accessor-backed approved field mapping");
    const entry = data(descriptor.value, ["entity", "column", "type"]);
    if (entry.type === "timestamp with time zone") entry.type = "timestamptz";
    fieldMappings.push({ fieldId, ...entry });
  }
  const sourceContractVersion = config.sourceContractVersion === undefined
    ? getFilterBindingRegistry().schema.sourceContractVersion : config.sourceContractVersion;
  return verifyPhysicalSchema({ database: config.db, schema, mirrorSchemaVersion: config.revision, sourceContractVersion, fieldMappings });
}

/** Immutable snapshot only; no mutable Map, database handle, or issuer is exposed. */
export function getVerifiedMirrorSchemaState(capability) {
  assertVerifiedMirrorSqlSchema(capability);
  return Object.freeze({ schema: capability.schema,
    revision: capability.mirrorSchemaVersion, sourceContractVersion: capability.sourceContractVersion,
    productsTable: quoteQualifiedTable(capability.schema.products.schema, capability.schema.products.table),
    variantsTable: quoteQualifiedTable(capability.schema.variants.schema, capability.schema.variants.table),
    columns: Object.freeze(Object.fromEntries(capability.fieldMappings.map(field => [field.fieldId, field]))),
  });
}
