/** Read-only PostgreSQL catalog verification. No merchant-controlled mappings. */
import { createHash } from "node:crypto";
import { assertMirrorSqlSchema } from "../filters/mirror-schema.js";
import { FieldError, FIELD_ERROR_CODES as C, deepFreeze } from "../fields/types.js";
import { FilterInfrastructureError } from "../filters/errors.js";
import { requireCanonicalField } from "../fields/canonical.js";

const VERIFIED = new WeakMap();
const TYPES = Object.freeze({ text: "text", bool: "boolean", int8: "bigint", numeric: "numeric",
  date: "date", timestamptz: "timestamptz", _text: "text[]", uuid: "uuid", jsonb: "jsonb" });
const COLUMNS = `SELECT c.oid::text AS "tableOid", a.attname AS name,
  t.typname AS type, a.atttypmod AS modifier, a.attnotnull AS "notNull", a.attcollation::text AS collation, a.attnum AS number
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r','p')
  AND a.attnum > 0 AND NOT a.attisdropped AND tn.nspname = 'pg_catalog'
ORDER BY a.attnum`;
const INDEXES = `SELECT i.indisunique AS "unique",
  ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.num
    WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS columns,
  ARRAY(SELECT COALESCE(cn.nspname || '.' || co.collname, '') FROM pg_catalog.unnest(i.indcollation::oid[]) WITH ORDINALITY k(num, ord)
    LEFT JOIN pg_catalog.pg_collation co ON co.oid = k.num
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
    ORDER BY k.ord) AS collations
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_index i ON i.indrelid = c.oid
JOIN pg_catalog.pg_class ix ON ix.oid = i.indexrelid
JOIN pg_catalog.pg_am am ON am.oid = ix.relam
WHERE n.nspname = $1 AND c.relname = $2 AND am.amname = 'btree'
  AND i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
  AND i.indpred IS NULL AND i.indexprs IS NULL ORDER BY i.indexrelid`;

function fail(message) { throw new FieldError(C.CONTRACT_MISMATCH, message); }
function sameSet(values, expected) {
  return Array.isArray(values) && values.length === expected.length &&
    new Set(values).size === values.length && expected.every(value => values.includes(value));
}

function readFields(raw) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > 1000 ||
      Reflect.ownKeys(raw).length !== raw.length + 1) fail("Invalid approved physical field mappings");
  const seen = new Set(), result = [];
  const storage = { string: "text", enum: "text", id: "text", boolean: "boolean", integer: "bigint",
    decimal: "numeric", money: "numeric", percentage: "numeric", date: "date", datetime: "timestamptz", string_list: "text[]" };
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    const entry = descriptor && Object.hasOwn(descriptor, "value") && descriptor.value;
    if (!entry || ![Object.prototype, null].includes(Object.getPrototypeOf(entry)) ||
        Reflect.ownKeys(entry).length !== 4) fail("Invalid approved physical field mapping");
    const field = {};
    for (const key of ["fieldId", "entity", "column", "type"]) {
      const value = Object.getOwnPropertyDescriptor(entry, key);
      if (!value || !Object.hasOwn(value, "value")) fail("Missing or accessor-backed physical field mapping");
      field[key] = value.value;
    }
    const canonical = requireCanonicalField(field.fieldId);
    if (seen.has(field.fieldId) || !["product", "variant"].includes(field.entity) || canonical.entity !== field.entity ||
        !Object.hasOwn(storage, canonical.type) || storage[canonical.type] !== field.type ||
        typeof field.column !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(field.column)) {
      fail("Incompatible canonical physical field mapping");
    }
    seen.add(field.fieldId); result.push(Object.freeze(field));
  }
  return Object.freeze(result.sort((a, b) => a.fieldId < b.fieldId ? -1 : 1));
}

export async function verifyMirrorSqlSchema({ database, schema, mirrorSchemaVersion, sourceContractVersion, fieldMappings = [] } = {}) {
  assertMirrorSqlSchema(schema);
  const approvedFields = readFields(fieldMappings);
  for (const version of [mirrorSchemaVersion, sourceContractVersion]) {
    if (typeof version !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(version)) fail("Physical schema revision required");
  }
  if (!database || typeof database.connect !== "function") throw new TypeError("Trusted PostgreSQL pool required");
  for (const table of [schema.products, schema.variants]) if (!table.schema) fail("Explicit PostgreSQL namespace required");
  if (schema.products.schema === schema.variants.schema && schema.products.table === schema.variants.table) fail("Distinct mirror tables required");
  let client;
  const catalog = {};
  try {
    client = await database.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const limit = await client.query("SHOW max_identifier_length");
    const maximum = Number(limit.rows?.[0]?.max_identifier_length);
    if (!Number.isSafeInteger(maximum) || maximum < 1) fail("Invalid PostgreSQL identifier configuration");
    for (const [entity, table] of [["product", schema.products], ["variant", schema.variants]]) {
      if (Object.values(table).some(value => Buffer.byteLength(value, "utf8") > maximum)) fail("Database identifier limit exceeded");
      const args = [table.schema, table.table];
      const columns = (await client.query(COLUMNS, args)).rows;
      const indexes = (await client.query(INDEXES, args)).rows;
      if (!Array.isArray(columns) || !columns.length || !Array.isArray(indexes)) fail("Mapped mirror table unavailable");
      const byName = Object.create(null);
      const oid = columns[0].tableOid;
      for (const column of columns) {
        if (typeof column.name !== "string" || Object.hasOwn(byName, column.name) || column.tableOid !== oid) fail("Invalid mirror catalog metadata");
        byName[column.name] = { type: TYPES[column.type] ?? null, modifier: column.modifier, notNull: column.notNull,
          collation: column.collation, number: column.number };
      }
      const identity = entity === "product" ? table.id : table.productId;
      for (const name of [identity, table.shop, table.generation]) {
        if (!byName[name] || byName[name].notNull !== true) fail("Missing or nullable mirror identity column");
      }
      if (byName[table.shop].type !== "text" || byName[table.generation].type !== "text" ||
          !["text", "bigint", "uuid"].includes(byName[identity].type)) fail("Unsupported mirror identity storage type");
      const keys = [table.shop, table.generation, identity];
      if (!indexes.some(index => entity === "product"
        ? index.unique === true && sameSet(index.columns, keys)
        : sameSet(index.columns?.slice(0, 3), keys))) fail("Required scoped mirror index unavailable");
      catalog[entity] = { oid, columns: byName, indexes };
    }
    if (catalog.product.columns[schema.products.id].type !== catalog.variant.columns[schema.variants.productId].type) {
      fail("Incompatible variant/product identity types");
    }
    for (const [left, right] of [[schema.products.id, schema.variants.productId],
      [schema.products.shop, schema.variants.shop], [schema.products.generation, schema.variants.generation]]) {
      if (catalog.product.columns[left].collation !== catalog.variant.columns[right].collation) fail("Incompatible mirror identity collations");
    }
    for (const field of approvedFields) {
      const column = catalog[field.entity].columns[field.column];
      if (!column || column.type !== field.type || (column.modifier !== -1 && field.type === "numeric")) {
        fail("Approved field does not match the physical table column");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    if (client) { try { await client.query("ROLLBACK"); } catch {} }
    if (error instanceof FieldError) throw error;
    throw new FilterInfrastructureError(error);
  } finally { client?.release(); }
  const fingerprint = createHash("sha256").update(JSON.stringify({ schema, catalog, approvedFields, mirrorSchemaVersion, sourceContractVersion })).digest("hex");
  const capability = deepFreeze({ schema, mirrorSchemaVersion, sourceContractVersion, fingerprint,
    productIdType: catalog.product.columns[schema.products.id].type, fieldMappings: approvedFields });
  VERIFIED.set(capability, { active: true, database, catalog: deepFreeze(catalog), fields: new Map(approvedFields.map(field => [field.fieldId, field])) });
  return capability;
}

export function assertVerifiedMirrorSqlSchema(capability) {
  if (!capability || typeof capability !== "object" || VERIFIED.get(capability)?.active !== true) fail("Active database-verified mirror schema required");
  return capability;
}

/** Bootstrap/migration fence. Revocation is permanent for this capability. */
export function invalidateVerifiedMirrorSqlSchema(capability) {
  if (!capability || typeof capability !== "object" || !VERIFIED.has(capability)) fail("Database-verified mirror schema required");
  VERIFIED.get(capability).active = false;
}

export function assertPhysicalColumn(capability, entity, column, type) {
  assertVerifiedMirrorSqlSchema(capability);
  const info = VERIFIED.get(capability).catalog[entity]?.columns[column];
  // Constrained typmods need a separate precision/scale compatibility contract.
  if (!info || info.type !== type || (info.modifier !== -1 && type === "numeric")) fail("SQL binding differs from verified physical column");
}

export function assertVerifiedFieldBinding(capability, fieldId, entity, column, type) {
  assertVerifiedMirrorSqlSchema(capability);
  const approved = VERIFIED.get(capability).fields.get(fieldId);
  if (!approved || approved.entity !== entity || approved.column !== column || approved.type !== type) {
    fail("Canonical field differs from its approved physical binding");
  }
  assertPhysicalColumn(capability, entity, column, type);
  return approved;
}

export function assertCursorOrdering(capability) {
  assertVerifiedMirrorSqlSchema(capability);
  const p = capability.schema.products;
  const indexes = VERIFIED.get(capability).catalog.product.indexes;
  if (!indexes.some(index => sameSet(index.columns?.slice(0, 2), [p.shop, p.generation]) && index.columns?.[2] === p.id &&
      (capability.productIdType !== "text" || index.collations?.[2] === "pg_catalog.C"))) {
    fail("Cursor ordering requires a compatible scoped B-tree index");
  }
}

export async function revalidateMirrorSqlSchema(capability) {
  assertVerifiedMirrorSqlSchema(capability);
  try {
    const current = await verifyMirrorSqlSchema({ ...capability, database: VERIFIED.get(capability).database });
    if (current.fingerprint !== capability.fingerprint) fail("Physical mirror schema changed after bootstrap");
  } catch (error) {
    invalidateVerifiedMirrorSqlSchema(capability);
    throw error;
  }
  return capability;
}
