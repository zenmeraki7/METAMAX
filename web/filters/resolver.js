/** Server-only authenticated field resolution and verified physical planning.
 * Both profiles produce metadata; semantic validation remains service-bound.
 * No SQL, source overrides or browser-controlled identifiers are accepted.
 */
import { inspectFilterAst } from "./ast.js";
import { assertAuthorizedFieldService, assertResolvedFieldAccess } from "../fields/resolve.js";
import { requireCanonicalField } from "../fields/canonical.js";
import { FieldError, FIELD_ERROR_CODES as C, isPlainObject } from "../fields/types.js";
import * as sources from "../fields/sources.js";
import { getFilterBindingRegistry, assertFilterBindingRegistry, FILTER_CORRELATION } from "./bindings.js";
import { assertVerifiedMirrorSqlSchema, assertVerifiedFieldBinding } from "../services/mirror-schema.server.js";

function data(raw, allowed) {
  if (!isPlainObject(raw)) throw new FieldError(C.PERMISSION_DENIED, "Trusted filter resolution context required");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== "string" || !allowed.includes(key) || !descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new FieldError(C.PERMISSION_DENIED, "Unsupported filter resolution context");
    }
    result[key] = descriptor.value;
  }
  return result;
}

// Provenance is mandatory, and dependencies must match the exact requested set.
function assertResolutionContract(resolution, requestedIds, operation) {
  const reject = () => { throw new FieldError(C.CONTRACT_MISMATCH, "Invalid authorized field resolution"); };
  if (!Object.isFrozen(resolution) || resolution.operation !== operation || resolution.access !== "read" ||
      !Array.isArray(resolution.fields) || !Object.isFrozen(resolution.fields) || resolution.fields.length !== requestedIds.length ||
      !Array.isArray(resolution.datasets) || !Object.isFrozen(resolution.datasets)) reject();
  const remaining = new Set(requestedIds);
  const datasets = new Set();
  for (const resolved of resolution.fields) {
    assertResolvedFieldAccess(resolved, "read", { shopId: resolution.shopId });
    if (!remaining.delete(resolved.id) || !Object.isFrozen(resolved) ||
        !Object.isFrozen(resolved.field) || !Object.isFrozen(resolved.source)) reject();
    if (resolved.origin === "canonical" && resolved.field !== requireCanonicalField(resolved.id)) reject();
    const dependencies = resolved.source.datasets;
    if (!Array.isArray(dependencies) || !dependencies.length || new Set(dependencies).size !== dependencies.length ||
        dependencies.some(name => typeof name !== "string" || !name)) reject();
    for (const name of dependencies) datasets.add(name);
  }
  if (remaining.size || new Set(resolution.datasets).size !== resolution.datasets.length ||
      datasets.size !== resolution.datasets.length || resolution.datasets.some(name => !datasets.has(name))) reject();
}

function createAuthenticatedResolver(options = {}) {
  const { fieldService } = data(options, ["fieldService"]);
  if (!fieldService || typeof fieldService.requireFields !== "function" ||
      typeof fieldService.revalidateResolution !== "function") {
    throw new TypeError("Authorized field service with live revalidation required");
  }
  assertAuthorizedFieldService(fieldService);
  if (typeof fieldService.assertResolution !== "function") throw new TypeError("Field resolution provenance assertion required");
  const requireFields = fieldService.requireFields.bind(fieldService);
  const assertIssued = fieldService.assertResolution.bind(fieldService);
  const revalidate = fieldService.revalidateResolution.bind(fieldService);
  const issued = new WeakMap();

  return Object.freeze({
    async resolveFilterFields(input, trustedContext) {
      const fieldIds = inspectFilterAst(input).fieldIds;
      const context = data(trustedContext, ["authContext", "operation", "executionContext"]);
      const operation = context.operation === undefined ? "filter" : context.operation;
      const resolution = await requireFields({ ...context, fieldIds, operation, access: "read" });
      assertIssued(resolution);
      assertResolutionContract(resolution, fieldIds, operation);
      issued.set(resolution, Object.freeze({ fieldIds, operation }));
      return resolution;
    },
    async revalidateFilterFields(resolution, trustedContext) {
      const proof = resolution && typeof resolution === "object" && issued.get(resolution);
      if (!proof) throw new FieldError(C.PERMISSION_DENIED, "Resolution belongs to another filter resolver");
      const context = data(trustedContext, ["authContext"]);
      // Field Service reruns authentication, definitions, authorization, pinned
      // coverage and registry checks; membership alone is never a live grant.
      const current = await revalidate(resolution, context);
      assertIssued(current);
      assertResolutionContract(current, proof.fieldIds, proof.operation);
      issued.set(current, proof);
      return current;
    },
  });
}

const MAX_FIELDS = 100;
const MAX_DATASETS = 32;

const ISSUED_PLANS = new WeakMap();

const SUPPORTED_HANDLERS = Object.freeze({
  product_column_v1: Object.freeze({
    entity: "product",
    correlation: FILTER_CORRELATION.PRODUCT,
  }),
  variant_exists_v1: Object.freeze({
    entity: "variant",
    correlation: FILTER_CORRELATION.VARIANT_EXISTS,
  }),
});

function reject(code, message, details) {
  throw new FieldError(code, message, details);
}

function own(object, key) {
  if (
    object === null ||
    typeof object !== "object"
  ) {
    return undefined;
  }

  const descriptor =
    Object.getOwnPropertyDescriptor(object, key);

  return descriptor &&
    Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
}

function assertArray(value, max) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    reject(
      C.CONTRACT_MISMATCH,
      "Invalid trusted resolution array",
    );
  }

  for (let i = 0; i < value.length; i++) {
    if (
      !Object.hasOwn(
        Object.getOwnPropertyDescriptor(value, String(i)) ?? {},
        "value",
      )
    ) {
      reject(
        C.CONTRACT_MISMATCH,
        "Invalid trusted array element",
      );
    }
  }

  return value;
}

function assertSource(field, binding) {
  const source = own(
    sources.FIELD_SOURCES,
    field.id,
  );

  if (!source) {
    reject(
      C.UNSUPPORTED_OPERATION,
      "Field SQL source is not installed",
      { fieldId: field.id },
    );
  }

  if (
    own(source, "fieldId") !== field.id ||
    own(source, "entity") !== field.entity ||
    own(source, "canonicalType") !== field.type ||
    own(source, "canonicalDerived") !== field.derived ||
    own(source, "kind") !== "column"
  ) {
    reject(
      C.CONTRACT_MISMATCH,
      "Canonical field and SQL source mismatch",
      { fieldId: field.id },
    );
  }

  const rawSql = own(source, "sql");
  const sql = rawSql && data(rawSql, ["kind", "column", "storageType", "alias", "shopColumn", "generationColumn"]);

  if (
    !sql ||
    own(sql, "kind") !== "column"
  ) {
    reject(
      C.UNSUPPORTED_OPERATION,
      "Approved SQL column is unavailable",
      { fieldId: field.id },
    );
  }

  const datasets = assertArray(
    own(source, "datasets"),
    16,
  );
  if (datasets.some(name => !["products", "variants"].includes(name))) {
    reject(C.UNSUPPORTED_OPERATION, "Only product/variant scalar datasets are enabled", { fieldId: field.id });
  }

  if (
    datasets.length !== binding.datasets.length ||
    datasets.some(
      (name, index) =>
        name !== binding.datasets[index],
    )
  ) {
    reject(
      C.CONTRACT_MISMATCH,
      "Field dataset dependencies disagree",
      { fieldId: field.id },
    );
  }

  return sql;
}

function resolveOne(
  fieldId,
  registry,
  physicalSchema,
  approved,
) {
  if (!approved.has(fieldId)) {
    reject(
      C.UNSUPPORTED_OPERATION,
      "Field has no approved physical binding",
      { fieldId },
    );
  }

  const field = requireCanonicalField(fieldId);
  const binding = registry.requireBinding(fieldId);

  const handler = own(
    SUPPORTED_HANDLERS,
    binding.handlerId,
  );

  if (
    !handler ||
    handler.entity !== binding.entity ||
    handler.entity !== field.entity ||
    handler.correlation !== binding.correlation
  ) {
    reject(
      C.UNSUPPORTED_OPERATION,
      "Trusted SQL handler is not installed",
      { fieldId },
    );
  }

  const sql = assertSource(field, binding);

  const column = own(sql, "column");
  const storageType = own(sql, "storageType");
  const alias = own(sql, "alias");
  const shopColumn = own(sql, "shopColumn");
  const generationColumn = own(
    sql,
    "generationColumn",
  );

  const scope =
    binding.correlation === FILTER_CORRELATION.PRODUCT
      ? registry.schema.product
      : registry.schema.variant;

  if (
    typeof column !== "string" ||
    typeof storageType !== "string" ||
    alias !== scope.alias ||
    shopColumn !== scope.shopColumn ||
    generationColumn !== scope.generationColumn
  ) {
    reject(
      C.INVALID_SOURCE,
      "SQL source scope is not verified",
      { fieldId },
    );
  }

  assertVerifiedFieldBinding(
    physicalSchema,
    fieldId,
    binding.entity,
    column,
    storageType,
  );

  const physicalColumns = Object.freeze({
    fieldId,
    entity: binding.entity,
    column,
    type: storageType,
  });

  return Object.freeze({
    fieldId,
    entity: binding.entity,
    handlerId: binding.handlerId,
    correlation: binding.correlation,
    datasets: binding.datasets,
    physicalColumn: physicalColumns,
    cost: binding.cost,
  });
}

export function assertResolvedFilterPlan(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !ISSUED_PLANS.has(value)
  ) {
    reject(
      C.PERMISSION_DENIED,
      "Untrusted filter resolution plan",
    );
  }

  assertVerifiedMirrorSqlSchema(ISSUED_PLANS.get(value));
  return value;
}

function createPhysicalFilterResolver({
  physicalSchema,
  bindingRegistry = getFilterBindingRegistry(),
} = {}) {
  assertVerifiedMirrorSqlSchema(physicalSchema);
  assertFilterBindingRegistry(bindingRegistry);
  const declared = bindingRegistry.schema, physical = physicalSchema.schema;
  if (declared.mirrorSchemaVersion !== physicalSchema.mirrorSchemaVersion ||
      declared.sourceContractVersion !== physicalSchema.sourceContractVersion ||
      declared.product.idColumn !== physical.products.id || declared.product.shopColumn !== physical.products.shop ||
      declared.product.generationColumn !== physical.products.generation ||
      declared.variant.schema !== physical.variants.schema || declared.variant.table !== physical.variants.table ||
      declared.variant.productIdColumn !== physical.variants.productId || declared.variant.shopColumn !== physical.variants.shop ||
      declared.variant.generationColumn !== physical.variants.generation) {
    reject(C.CONTRACT_MISMATCH, "Planner registry and verified physical schema disagree");
  }

  const approvedMappings = assertArray(
    physicalSchema.fieldMappings,
    1000,
  );

  const approved = new Set();

  for (const mapping of approvedMappings) {
    const fieldId = own(mapping, "fieldId");

    if (
      typeof fieldId !== "string" ||
      approved.has(fieldId)
    ) {
      reject(
        C.CONTRACT_MISMATCH,
        "Duplicate or invalid approved field mapping",
      );
    }

    approved.add(fieldId);
  }

  function resolve(ast) {
    assertVerifiedMirrorSqlSchema(physicalSchema);
    const inspection = inspectFilterAst(ast);

    const fieldIds = assertArray(
      inspection.fieldIds,
      MAX_FIELDS,
    );

    const unique = new Set(fieldIds);

    if (unique.size !== fieldIds.length) {
      reject(
        C.CONTRACT_MISMATCH,
        "Duplicate inspected field IDs",
      );
    }

    const fields = fieldIds.map(
      id => resolveOne(
        id,
        bindingRegistry,
        physicalSchema,
        approved,
      ),
    );

    const datasets = new Set(["products"]);
    const correlations = new Set();
    let estimatedCost = 0;

    for (const field of fields) {
      correlations.add(field.correlation);
      estimatedCost += field.cost;

      for (const dataset of field.datasets) {
        datasets.add(dataset);

        if (datasets.size > MAX_DATASETS) {
          reject(
            C.INVALID_VALUE,
            "Filter dataset limit exceeded",
          );
        }
      }
    }

    const plan = Object.freeze({
      version: 1,
      registryFingerprint:
        bindingRegistry.fingerprint,
      schemaFingerprint:
        physicalSchema.fingerprint,
      fieldIds: Object.freeze([...fieldIds]),
      fields: Object.freeze(fields),
      datasets: Object.freeze(
        [...datasets].sort(),
      ),
      correlations: Object.freeze(
        [...correlations].sort(),
      ),
      estimatedCost,
    });

    ISSUED_PLANS.set(plan, physicalSchema);

    return plan;
  }

  return Object.freeze({
    resolve,
  });
}

export function createFilterResolver(options = {}) {
  const config = data(options, ["fieldService", "physicalSchema", "bindingRegistry"]);
  if (Object.hasOwn(config, "physicalSchema") || Object.hasOwn(config, "bindingRegistry")) {
    if (Object.hasOwn(config, "fieldService")) throw new TypeError("Choose authenticated resolution or physical planning explicitly");
    return createPhysicalFilterResolver(config);
  }
  return createAuthenticatedResolver(config);
}
