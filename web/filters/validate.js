/**
 * Semantic validation owns the validated-filter trust boundary.
 *
 * No brand issuer is exported. Configured services resolve fields through the
 * authorized field service, validate operators, normalize operands, and bind
 * their private provenance to shop, operation, generation and registry version.
 * Validation is exposed only by a configured service; no standalone entry point.
 * resolver.js owns authenticated field resolution and live receipt revalidation.
 *
 * Compilation stays private and revalidates live bindings before generating
 * a parameterized WHERE predicate from allowlisted source columns.
 */
import { parseFilterAst, inspectFilterAst } from "./ast.js";
import { normalizeOperatorOperand, NORMALIZE_CONTRACT_VERSION } from "../fields/normalize.js";
import { CONSTRAINTS_VERSION } from "../fields/constraints.js";
import { FieldError, FIELD_ERROR_CODES as C, isPlainObject, FIELD_TYPES as T } from "../fields/types.js";
import { createFilterResolver } from "./resolver.js";
import { requireOperator } from "../fields/operators.js";
import { FILTER_NEGATIVE_OPERATORS, FILTER_NULL_SEMANTICS_VERSION } from "./semantics.js";
import { fingerprintFilterExecution } from "./fingerprint.js";
import { getFilterBindingRegistry, assertFilterBindingRegistry, FILTER_CORRELATION, FILTER_BINDING_VERSION } from "./bindings.js";
import { FILTER_VALIDATION_VERSION } from "./contracts.js";
import { CANONICAL_REGISTRY_INFO } from "../fields/canonical.js";
import { OPERATOR_CONTRACT_VERSION } from "../fields/operators.js";
import { assertSqlParameter, assertSqlParameters } from "./sql-parameters.js";

export const FILTER_EXECUTION_LIMITS = Object.freeze({
  MAX_CONDITIONS: 100,
  MAX_DEPTH: 12,
  MAX_OR_BRANCHES: 32,
  MAX_CORRELATED_SUBQUERIES: 16,
  MAX_SQL_PARAMETERS: 500,
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 100,
});

function assertExecutionBudget(ast) {
  const info = inspectFilterAst(ast);
  if (info.conditions > FILTER_EXECUTION_LIMITS.MAX_CONDITIONS || info.maxDepth > FILTER_EXECUTION_LIMITS.MAX_DEPTH) {
    throw new FieldError(C.INVALID_VALUE, "Filter execution complexity exceeded");
  }
  // Sum child counts for every OR group, including nested OR groups.
  let branches = 0;
  const stack = [ast.root];
  while (stack.length) {
    const node = stack.pop();
    if (node.kind !== "group") continue;
    if (node.operator === "OR") branches += node.children.length;
    if (branches > FILTER_EXECUTION_LIMITS.MAX_OR_BRANCHES) {
      throw new FieldError(C.INVALID_VALUE, "Filter OR fan-out exceeded");
    }
    stack.push(...node.children);
  }
}

function contextData(raw, allowed) {
  if (!isPlainObject(raw)) throw new FieldError(C.PERMISSION_DENIED, "Trusted filter context required");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== "string" || !allowed.has(key) || !descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new FieldError(C.PERMISSION_DENIED, "Invalid trusted filter context");
    }
    result[key] = descriptor.value;
  }
  return result;
}

const SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const SQL_STORAGE = Object.freeze({
  [T.STRING]: "text", [T.ENUM]: "text", [T.ID]: "text",
  [T.BOOLEAN]: "boolean", [T.INTEGER]: "bigint", [T.DECIMAL]: "numeric",
  [T.MONEY]: "numeric", [T.PERCENTAGE]: "numeric", [T.DATE]: "date",
  [T.DATETIME]: "timestamptz", [T.STRING_LIST]: "text[]", [T.ID_LIST]: "text[]", [T.JSON]: "jsonb",
});
const SQL_COMPARISONS = Object.freeze({ eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" });

// Not exported: only compileFilter's privately issued, freshly revalidated
// input reaches this implementation. It cannot compile arbitrary AST objects.
function compileSql(ast, resolution, filterFingerprint, fields = new Map(resolution.fields.map(field => [field.id, field]))) {
  assertExecutionBudget(ast);
  const registry = assertFilterBindingRegistry(getFilterBindingRegistry());
  const schema = registry.schema;
  if (resolution.mirrorSchemaVersion !== schema.mirrorSchemaVersion || resolution.sourceContractVersion !== schema.sourceContractVersion) {
    throw new FieldError(C.CONTRACT_MISMATCH, "Published mirror schema is incompatible with compiler bindings");
  }
  const values = [];
  const parameterTypes = [];
  let correlatedSubqueries = 0;
  let estimatedCost = 0;
  function parameter(value, type) {
    if (values.length >= FILTER_EXECUTION_LIMITS.MAX_SQL_PARAMETERS) throw new FieldError(C.INVALID_VALUE, "SQL parameter limit exceeded");
    assertSqlParameter(value, type);
    values.push(value);
    parameterTypes.push(type);
    return `$${values.length}::${type}`;
  }
  function identifier(value) {
    if (typeof value !== "string" || value.trim() !== value || !SQL_IDENTIFIER.test(value)) {
      throw new FieldError(C.INVALID_SOURCE, "Invalid allowlisted SQL identifier");
    }
    return `"${value}"`;
  }
  const mappings = new Map();
  for (const field of resolution.fields) {
    const binding = registry.requireBinding(field.id);
    // Dynamic families need dedicated query adapters, never invented mappings.
    if (field.origin !== "canonical" || !isPlainObject(field.source.sql)) {
      throw new FieldError(C.UNSUPPORTED_OPERATION, "Field has no registered SQL column mapping", { fieldId: field.id });
    }
    const mapping = contextData(field.source.sql, new Set([
      "kind", "alias", "column", "storageType", "shopColumn", "generationColumn",
    ]));
    const type = SQL_STORAGE[field.type];
    if (mapping.kind !== "column" || !type || mapping.storageType !== type) {
      throw new FieldError(C.UNSUPPORTED_OPERATION, "Unsupported SQL storage mapping", { fieldId: field.id });
    }
    const alias = identifier(mapping.alias);
    const column = `${alias}.${identifier(mapping.column)}`;
    const shop = `${alias}.${identifier(mapping.shopColumn)}`;
    const generation = `${alias}.${identifier(mapping.generationColumn)}`;
    const expectedScope = binding.correlation === FILTER_CORRELATION.PRODUCT ? schema.product : schema.variant;
    if (mapping.alias !== expectedScope.alias || mapping.shopColumn !== expectedScope.shopColumn || mapping.generationColumn !== expectedScope.generationColumn) {
      throw new FieldError(C.INVALID_SOURCE, "Conflicting SQL binding scope");
    }
    mappings.set(field.id, { column, type, binding, physicalColumn: mapping.column });
  }
  // Tenant and generation predicates remain outside all browser AND/OR/NOT groups.
  parameter(resolution.shopId, "text");
  parameter(resolution.generationId, "text");
  function predicate(node) {
    if (node.kind === "group") {
      const children = node.children.map(predicate);
      if (node.operator === "NOT") return `(NOT ${children[0]})`;
      if (node.operator !== "AND" && node.operator !== "OR") throw new FieldError(C.UNSUPPORTED_OPERATION, "Unsupported SQL group");
      return `(${children.join(` ${node.operator} `)})`;
    }
    const field = fields.get(node.field);
    const { column, type, binding } = mappings.get(node.field);
    estimatedCost += binding.cost;
    if (!binding.operators.includes(node.operator)) throw new FieldError(C.UNSUPPORTED_OPERATION, "Operator not installed for SQL binding", { fieldId: node.field });
    // Defense in depth: compatibility, presence/shape and types are checked
    // again at the SQL boundary using the trusted field and filter policy.
    const value = normalizeOperatorOperand(field.field, node.operator, node.value, {
      hasValue: Object.hasOwn(node, "value"), constraints: field.policy.filter,
    });
    if (FILTER_NEGATIVE_OPERATORS.includes(node.operator) && requireOperator(node.operator).nullPolicy !== "exclude") {
      throw new FieldError(C.CONTRACT_MISMATCH, "Negative predicate NULL policy mismatch");
    }
    // Preserve SQL UNKNOWN for null operands/columns. Do not coalesce a leaf
    // to false: NOT would then turn missing/null values into matches.
    if (Object.hasOwn(SQL_COMPARISONS, node.operator)) {
      return `(${column} ${SQL_COMPARISONS[node.operator]} ${parameter(value, type)})`;
    }
    switch (node.operator) {
      case "in": case "not_in":
        return `(${column} ${node.operator === "in" ? "IN" : "NOT IN"} (${value.map(item => parameter(item, type)).join(", ")}))`;
      case "between":
        return `(${column} BETWEEN ${parameter(value[0], type)} AND ${parameter(value[1], type)})`;
      case "contains": case "not_contains": case "starts_with": case "ends_with": {
        const escaped = value.replace(/[\\%_]/g, "\\$&");
        const pattern = (node.operator === "starts_with" ? "" : "%") + escaped + (node.operator === "ends_with" ? "" : "%");
        return `(${column} ${node.operator === "not_contains" ? "NOT ILIKE" : "ILIKE"} ${parameter(pattern, "text")} ESCAPE E'\\\\')`;
      }
      case "list_contains": case "list_not_contains":
        return `(${node.operator === "list_not_contains" ? "NOT " : ""}(${parameter(value, "text")} = ANY(${column})))`;
      case "is_null": return `(${column} IS NULL)`;
      case "is_not_null": return `(${column} IS NOT NULL)`;
      case "is_empty": case "is_not_empty": {
        const list = field.type === T.STRING_LIST || field.type === T.ID_LIST;
        return `(${list ? `cardinality(${column})` : column} ${node.operator === "is_empty" ? "=" : "<>"} ${parameter(list ? 0 : "", list ? "integer" : "text")})`;
      }
      default: throw new FieldError(C.UNSUPPORTED_OPERATION, "Unsupported SQL field operation", { fieldId: node.field });
    }
  }
  const p = schema.product, v = schema.variant;
  function entity(node) {
    if (node.kind === "condition") return mappings.get(node.field).binding.correlation === FILTER_CORRELATION.VARIANT_EXISTS ? "variant" : "product";
    const entities = new Set(node.children.map(entity));
    return entities.size === 1 ? [...entities][0] : "mixed";
  }
  function variantExists(nodes) {
    if (++correlatedSubqueries > FILTER_EXECUTION_LIMITS.MAX_CORRELATED_SUBQUERIES) {
      throw new FieldError(C.INVALID_VALUE, "Correlated subquery limit exceeded");
    }
    function rejectNot(node) {
      if (node.kind === "group") {
        if (node.operator === "NOT") throw new FieldError(C.UNSUPPORTED_OPERATION, "Variant NOT requires an explicit quantifier contract");
        node.children.forEach(rejectNot);
      }
    }
    nodes.forEach(rejectNot);
    const table = `${identifier(v.schema)}.${identifier(v.table)}`;
    return `(EXISTS (SELECT 1 FROM ${table} AS ${identifier(v.alias)} WHERE ` +
      `${identifier(v.alias)}.${identifier(v.shopColumn)} = $1::text AND ` +
      `${identifier(v.alias)}.${identifier(v.generationColumn)} = $2::text AND ` +
      `${identifier(v.alias)}.${identifier(v.productIdColumn)} = ${identifier(p.alias)}.${identifier(p.idColumn)} AND ` +
      `${nodes.map(predicate).join(" AND ")}))`;
  }
  function correlated(node) {
    const kind = entity(node);
    if (kind === "product") return predicate(node);
    if (kind === "variant") return variantExists([node]);
    if (node.operator !== "AND") throw new FieldError(C.UNSUPPORTED_OPERATION, "Mixed product/variant OR or NOT requires an explicit correlation scope");
    // Flatten positive conjunctions before grouping: nested AND cannot split
    // variant requirements into EXISTS clauses that match different rows.
    const terms = [];
    function flatten(child) {
      if (child.kind === "group" && child.operator === "AND") child.children.forEach(flatten);
      else terms.push(child);
    }
    flatten(node);
    const variants = terms.filter(term => entity(term) === "variant");
    const products = terms.filter(term => entity(term) !== "variant").map(correlated);
    if (variants.length) products.push(variantExists(variants));
    return `(${products.join(" AND ")})`;
  }
  const expression = correlated(ast.root);
  const text = `((${identifier(p.alias)}.${identifier(p.shopColumn)} = $1::text AND ${identifier(p.alias)}.${identifier(p.generationColumn)} = $2::text) AND ${expression})`;
  // Final count includes every parameter emitted by this predicate compiler,
  // including tenant/generation guards. A future full-query executor must also
  // budget any parameters it appends for pagination or query infrastructure.
  if (values.length > FILTER_EXECUTION_LIMITS.MAX_SQL_PARAMETERS ||
      correlatedSubqueries > FILTER_EXECUTION_LIMITS.MAX_CORRELATED_SUBQUERIES) {
    throw new FieldError(C.INVALID_VALUE, "Compiled SQL complexity exceeded");
  }
  if (Buffer.byteLength(text, "utf8") > 131072) throw new FieldError(C.INVALID_VALUE, "SQL byte limit exceeded");
  assertSqlParameters(values, parameterTypes, FILTER_EXECUTION_LIMITS.MAX_SQL_PARAMETERS);
  return Object.freeze({ kind: "where", text, values: Object.freeze(values),
    parameterTypes: Object.freeze(parameterTypes),
    physicalColumns: Object.freeze([...mappings.values()].map(mapping => Object.freeze({
      fieldId: mapping.binding.fieldId, entity: mapping.binding.entity, column: mapping.physicalColumn, type: mapping.type,
    }))),
    plan: Object.freeze({ parameters: values.length, correlatedSubqueries,
      estimatedCost }),
    binding: Object.freeze({ shopId: resolution.shopId, operation: resolution.operation,
      operationId: resolution.operationId, phase: resolution.phase, generationId: resolution.generationId,
      coverageRevision: resolution.coverageRevision, registryVersion: resolution.registryVersion,
      targetingSnapshotId: resolution.targetingSnapshotId, filterFingerprint,
      executionContractId: resolution.executionContractId, approvalRevision: resolution.approvalRevision,
      bindingRegistryVersion: registry.fingerprint, mirrorSchemaVersion: schema.mirrorSchemaVersion,
      sourceContractVersion: schema.sourceContractVersion,
      nullSemanticsVersion: FILTER_NULL_SEMANTICS_VERSION }) });
}

/** Configure once in trusted backend code. No brand issuer is exposed. */
const AUTHORIZED_FILTER_SERVICES = new WeakSet();

/** Assertion only; a lookalike service cannot attest to filter provenance. */
export function assertAuthorizedFilterService(service) {
  if (!service || !AUTHORIZED_FILTER_SERVICES.has(service)) {
    throw new FieldError(C.PERMISSION_DENIED, "Untrusted filter service");
  }
  return service;
}

export function createFilterService({ fieldService } = {}) {
  const resolver = createFilterResolver({ fieldService });
  const validatedFilters = new WeakMap();

  async function validate(input, trustedContext) {
    const ast = parseFilterAst(input);
    assertExecutionBudget(ast);
    const resolution = await resolver.resolveFilterFields(ast, trustedContext);
    const fields = new Map(resolution.fields.map(field => [field.id, field]));
    function normalize(node) {
      if (node.kind === "group") {
        return Object.freeze({ kind: "group", operator: node.operator,
          children: Object.freeze(node.children.map(normalize)) });
      }
      const resolved = fields.get(node.field);
      if (!resolved) throw new FieldError(C.UNKNOWN_FIELD, "Authorized field mapping missing");
      const hasValue = Object.hasOwn(node, "value");
      const value = normalizeOperatorOperand(resolved.field, node.operator, node.value, {
        hasValue, constraints: resolved.policy.filter,
      });
      return Object.freeze({ kind: "condition", field: node.field, operator: node.operator,
        ...(hasValue ? { value } : {}) });
    }
    const normalizedAst = parseFilterAst({ version: ast.version, root: normalize(ast.root) });
    // Prove the registered binding supports each operator, mapping and resolved
    // correlation before issuing provenance. This private preflight emits no
    // query and executes no SQL. Compilation repeats it after live revalidation.
    const preflight = compileSql(normalizedAst, resolution, null);
    const binding = {
      shopId: resolution.shopId, operation: resolution.operation, phase: resolution.phase, operationId: resolution.operationId,
      generationId: resolution.generationId, coverageRevision: resolution.coverageRevision,
      targetingSnapshotId: resolution.targetingSnapshotId, registryVersion: resolution.registryVersion,
      executionContractId: resolution.executionContractId, approvalRevision: resolution.approvalRevision,
      mirrorSchemaVersion: resolution.mirrorSchemaVersion, sourceContractVersion: resolution.sourceContractVersion,
    };
    const versions = Object.freeze({ validation: FILTER_VALIDATION_VERSION, ast: normalizedAst.version,
      canonical: CANONICAL_REGISTRY_INFO.registryVersion, operators: OPERATOR_CONTRACT_VERSION,
      bindings: FILTER_BINDING_VERSION, normalization: NORMALIZE_CONTRACT_VERSION, constraints: CONSTRAINTS_VERSION });
    const validated = Object.freeze({
      ast: normalizedAst, ...binding, nullSemanticsVersion: FILTER_NULL_SEMANTICS_VERSION,
      definitionRevisions: resolution.definitionRevisions, versions,
      // Construct explicitly from issued resolution and code contracts, never
      // spread request-supplied identity metadata into the fingerprint.
      fingerprint: fingerprintFilterExecution({ ast: normalizedAst, ...binding,
        definitionRevisions: resolution.definitionRevisions,
        validationVersion: versions.validation, astVersion: versions.ast,
        canonicalVersion: versions.canonical, operatorVersion: versions.operators, bindingVersion: versions.bindings,
        normalizationVersion: versions.normalization, constraintsVersion: versions.constraints,
      }),
    });
    // All semantic checks above must succeed before issuing private provenance.
    // Retain the issued resolution solely as a live-revalidation capability.
    // Compiler membership and metadata come from independent immutable arrays
    // and records. Nested descriptors/policies/sources are already deeply frozen
    // by the genuine Field Service, whose provenance was checked above.
    const snapshot = Object.freeze({ ...resolution,
      fields: Object.freeze(resolution.fields.map(field => Object.freeze({ ...field }))),
      datasets: Object.freeze([...resolution.datasets]),
      definitionRevisions: Object.freeze(resolution.definitionRevisions.map(entry => Object.freeze({ ...entry }))),
    });
    // Read-only metadata for trusted compiler consumers. Issuance remains below
    // every semantic check; this plan cannot brand or authorize another AST.
    const resolutionPlan = Object.freeze({
      ast: normalizedAst,
      versions,
      binding: Object.freeze({ ...preflight.binding, filterFingerprint: validated.fingerprint }),
      fieldIds: inspectFilterAst(normalizedAst).fieldIds,
      fields: snapshot.fields,
      datasets: Object.freeze([...snapshot.datasets].sort()),
      physicalColumns: preflight.physicalColumns,
      definitionRevisions: snapshot.definitionRevisions,
    });
    validatedFilters.set(validated, Object.freeze({ resolution, snapshot, resolutionPlan,
      fieldMap: new Map(snapshot.fields.map(field => [field.id, field])),
    }));
    return validated;
  }

  async function compileFilter(validated, trustedContext) {
    const state = validated && typeof validated === "object" && validatedFilters.get(validated);
    if (!state) throw new FieldError(C.PERMISSION_DENIED, "Untrusted validated filter");
    const context = contextData(trustedContext, new Set(["authContext"]));
    // Same authenticated shop, original operation, exact generation/revision,
    // approved target and field mappings must still be valid at compilation.
    await resolver.revalidateFilterFields(state.resolution, context);
    return compileSql(validated.ast, state.snapshot, validated.fingerprint, state.fieldMap);
  }
  const service = Object.freeze({ validateFilter: validate, compileFilter,
    async revalidateFilter(validated, trustedContext) {
      const state = validated && typeof validated === "object" && validatedFilters.get(validated);
      if (!state) throw new FieldError(C.PERMISSION_DENIED, "Untrusted validated filter");
      const context = contextData(trustedContext, new Set(["authContext"]));
      await resolver.revalidateFilterFields(state.resolution, context);
      return validated;
    },
    getResolutionPlan(validated) {
      const state = validated && typeof validated === "object" && validatedFilters.get(validated);
      if (!state) throw new FieldError(C.PERMISSION_DENIED, "Untrusted validated filter");
      return state.resolutionPlan;
    },
  });
  AUTHORIZED_FILTER_SERVICES.add(service);
  return service;
}

