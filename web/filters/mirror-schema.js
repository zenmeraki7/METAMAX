/**
 * METAMAX — PostgreSQL Mirror Schema Contract
 *
 * Server-bootstrap-only structural validation of verified physical mappings.
 * Never construct from req.body or merchant metadata. Factory provenance does
 * not prove table existence, column types, indexes or publication compatibility.
 * This module does not install mappings or grant compiler/execution authority.
 */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ISSUED = new WeakSet();

function identifier(value) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 63 || !IDENT.test(value)) {
    throw new TypeError("Invalid SQL identifier");
  }
  return value;
}

export function quoteIdentifier(value) {
  return `"${identifier(value)}"`;
}

export function quoteQualifiedTable(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function readData(raw, required, optional = []) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    throw new TypeError("Invalid mirror schema record");
  }
  const expected = new Set([...required, ...optional]);
  const output = {};
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !expected.has(key)) throw new TypeError("Unexpected mirror schema key");
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Accessor-backed mirror schema mapping");
    output[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(output, key))) throw new TypeError("Missing mirror schema identifier");
  return output;
}

function readTable(raw, columns) {
  // Legacy structural callers may omit schema. Production table references
  // must explicitly supply it and use quoteQualifiedTable, never search_path.
  const values = readData(raw, ["table", ...columns], ["schema"]);
  const output = {};
  for (const [key, value] of Object.entries(values)) output[key] = identifier(value);
  if (new Set(columns.map(name => output[name])).size !== columns.length) {
    throw new TypeError("Conflicting mirror identity columns");
  }
  return Object.freeze(output);
}

export function createMirrorSqlSchema(raw) {
  const { products, variants } = readData(raw, ["products", "variants"]);
  const result = Object.freeze({
    products: readTable(products, ["id", "shop", "generation"]),
    variants: readTable(variants, ["productId", "shop", "generation"]),
  });
  ISSUED.add(result);
  return result;
}

/** Structural provenance only; not physical database verification. */
export function assertMirrorSqlSchema(schema) {
  if (!schema || typeof schema !== "object" || !ISSUED.has(schema)) {
    throw new TypeError("Trusted mirror SQL schema required");
  }
  return schema;
}
