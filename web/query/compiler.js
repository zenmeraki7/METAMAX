import { requireValueField, requireFieldSource } from "../fields/sources.js";
import { requireValidFieldValue } from "../fields/validate.js";
import { checkFieldAvailability } from "../fields/capabilities.js";
import { FieldError, isPlainRecord, ownValue, isCoverageToken, deepFreeze } from "../fields/types.js";
const fail = (code, message) => { throw new FieldError(code, message); };
// SQL identifiers and JSON paths are code-owned constants, never interpolated
// from canonical metadata, a descriptor, AST or caller-provided mapping.
const mappings = Object.freeze({
  "product.id": { key: "id", sql: `p."data"->>'id'` },
  "product.title": { key: "title", sql: `p."data"->>'title'` },
  "product.handle": { key: "handle", sql: `p."data"->>'handle'` },
  "product.status": { key: "status", sql: `p."data"->>'status'` },
  "product.vendor": { key: "vendor", sql: `p."data"->>'vendor'` },
  "product.productType": { key: "productType", sql: `p."data"->>'productType'` },
  "product.tags": { key: "tags", sql: `p."data"->'tags'` },
  "product.tracksInventory": { key: "tracksInventory", sql: `(p."data"->>'tracksInventory')::boolean` },
});
function shape(value, allowed) {
  if (!isPlainRecord(value)) fail("INVALID_QUERY", "Expected a plain query object");
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.includes(key)) fail("INVALID_QUERY", "Unsupported query property");
    ownValue(value, key);
  }
}
function array(value, max = 100) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) fail("INVALID_QUERY", "Expected a bounded nonempty operand array");
  const result = [];
  for (let i = 0; i < value.length; i++) result.push(ownValue(value, String(i)));
  return result;
}
export function listSqlFields() { return Object.freeze(Object.keys(mappings)); }

// Returns node-postgres {text, values}; it never executes SQL or opens a DB.
export function compileProductQuery(ast, context, options = {}) {
  if (!isPlainRecord(context)) fail("QUERY_CONTEXT_REQUIRED", "Trusted published snapshot context is required");
  const shop = ownValue(context, "shopId"), generation = ownValue(context, "generation"), snapshot = ownValue(context, "snapshotId");
  if (typeof shop !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !isCoverageToken(generation) || !isCoverageToken(snapshot))
    fail("QUERY_CONTEXT_REQUIRED", "Verified shop, installation generation and published snapshot are required");
  const available = checkFieldAvailability("product.id", "filter", context);
  if (!available.available) fail("QUERY_ACCESS_DENIED", available.reason);
  shape(options, ["limit", "after"]);
  const suppliedLimit = ownValue(options, "limit"), after = ownValue(options, "after");
  const limit = suppliedLimit === undefined ? 100 : suppliedLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250) fail("INVALID_QUERY_LIMIT", "Query limit must be between 1 and 250");
  const values = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const shopParam = bind(shop), generationParam = bind(generation), snapshotParam = bind(snapshot);
  let nodes = 0;
  function predicate(node, depth) {
    if (++nodes > 100 || depth > 8) fail("QUERY_TOO_COMPLEX", "Query exceeds node or depth limits");
    shape(node, ["type", "children", "child", "field", "operator", "value"]);
    const type = ownValue(node, "type");
    if (["and", "or"].includes(type)) {
      shape(node, ["type", "children"]);
      return `(${array(ownValue(node, "children"), 50).map(child => predicate(child, depth + 1)).join(type === "and" ? " AND " : " OR ")})`;
    }
    if (type === "not") {
      shape(node, ["type", "child"]);
      return `(NOT ${predicate(ownValue(node, "child"), depth + 1)})`;
    }
    if (type !== "predicate") fail("INVALID_QUERY", "Unknown query node type");
    shape(node, ["type", "field", "operator", "value"]);
    const field = requireValueField(ownValue(node, "field"));
    const mapping = Object.hasOwn(mappings, field.id) ? mappings[field.id] : null;
    if (!mapping || field.dynamic) fail("UNSUPPORTED_SQL_SOURCE", "No verified SQL adapter exists for this field source");
    const source = requireFieldSource(field);
    if (source.mode !== "direct" || source.storage.model !== "SnapshotProduct" || source.dataset !== "products" ||
        source.storage.path.length !== 2 || source.storage.path[0] !== "data" || source.storage.path[1] !== mapping.key)
      fail("UNSUPPORTED_SQL_SOURCE", "Field source does not match the recognized SQL adapter");
    const gate = checkFieldAvailability(field.id, "filter", context);
    if (!gate.available) fail("QUERY_ACCESS_DENIED", gate.reason);
    const op = ownValue(node, "operator"), input = ownValue(node, "value"), expression = mapping.sql;
    const normalize = operand => {
      if (operand === null || operand === undefined) fail("INVALID_QUERY_OPERAND", "A non-null operand is required");
      return requireValidFieldValue(field, operand, { purpose: "filter" });
    };
    if (["contains_any", "contains_all"].includes(op) && field.type === "string_list") {
      const list = normalize(array(input));
      return `(${expression} ${op === "contains_any" ? "?|" : "?&"} ${bind(list)}::text[])`;
    }
    if (field.type === "string_list") fail("UNSUPPORTED_QUERY_OPERATOR", "This list operator is not implemented");
    if (op === "eq" || op === "ne") return `(${expression} ${op === "eq" ? "=" : "<>"} ${bind(normalize(input))})`;
    if (op === "in") return `(${expression} IN (${array(input).map(item => bind(normalize(item))).join(", ")}))`;
    if (["contains", "starts_with", "ends_with"].includes(op) && field.type === "text") {
      const text = normalize(input).replace(/[!%_]/g, item => `!${item}`);
      const pattern = (op !== "starts_with" ? "%" : "") + text + (op !== "ends_with" ? "%" : "");
      return `(${expression} ILIKE ${bind(pattern)} ESCAPE '!')`;
    }
    fail("UNSUPPORTED_QUERY_OPERATOR", "Operator is not implemented for this field type");
  }
  const filter = ast === null ? "TRUE" : predicate(ast, 0);
  const cursor = after === undefined ? "" : ` AND p."productId">${bind(requireValidFieldValue("product.id", after, { purpose: "read" }))}`;
  const text = `SELECT p."productId", p."data" FROM "SnapshotProduct" p
JOIN "SnapshotRun" r ON r."id"=p."runId"
JOIN "Shop" s ON s."domain"=r."shop" AND s."activeSnapshotId"=r."id" AND s."generation"=r."generation"
WHERE r."shop"=${shopParam} AND r."generation"=${generationParam} AND p."runId"=${snapshotParam}
AND r."status"='COMPLETED' AND s."status"='ACTIVE' AND s."installationVerified"=true
AND (${filter})${cursor} ORDER BY p."productId" ASC LIMIT ${bind(limit)}`;
  return deepFreeze({ text, values });
}
