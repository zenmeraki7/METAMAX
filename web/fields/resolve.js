import {
  deepFreeze,
  FieldError,
  FIELD_ERROR_CODES as C,
  isCanonicalFieldId,
  isFieldType,
  isPlainObject,
  FIELD_TYPES,
} from "./types.js";

import {
  CANONICAL_FIELDS,
  getCanonicalField,
} from "./canonical.js";

import * as sourceRegistry from "./sources.js";
import {
  METAFIELD_READ_ADAPTER, METAFIELD_WRITE_ADAPTER,
  METAFIELD_DEFINITION_TOKEN_PATTERN, METAFIELD_LOCATOR_PATTERN,
} from "./metafield-adapter.js";
import { METAFIELD_DEFINITION_ID_PATTERN } from "./metafield-identity.js";
import {
  FIELD_CONSTRAINT_REGISTRY, POLICY_CONTEXT, getFieldPolicy,
  validateDynamicFieldPolicy,
} from "./constraints.js";
import { createMetafieldResolverBridge } from "./metafield-resolver-bridge.js";
import { createHash } from "node:crypto";

const { FIELD_SOURCES, SOURCE_DATASETS } = sourceRegistry;

export const FIELD_RESOLVE_CONTRACT_VERSION = 10;

export const FIELD_ORIGINS = Object.freeze({
  CANONICAL: "canonical",
  DYNAMIC: "dynamic",
});

export const FIELD_ACCESS = Object.freeze({
  READ: "read",
  WRITE: "write",
});

export const FIELD_OPERATIONS = Object.freeze({
  FILTER: "filter",
  EXPORT: "export",
  IMPORT: "import",
  BULK_EDIT: "bulk_edit",
  SCHEDULED_EDIT: "scheduled_edit",
  RECURRING_EDIT: "recurring_edit",
  UNDO: "undo",
});

export const FIELD_RESOLVE_LIMITS = Object.freeze({
  maxFields: 1000,
  maxShopIdLength: 255,
  maxLabelLength: 120,
  maxAdapterIdLength: 80,
  maxLocatorLength: 255,
  maxDatasets: 16,
  maxScopes: 32,
  maxBatchBytes: 131072,
});

// Must remain compatible with types.js.
//
// The final component is a server-issued opaque token,
// NOT a concatenation of Shopify namespace and key.
//
// Example:
// product.metafield.m01ab239d
//
// The trusted adapter maps this token to the actual
// shop-scoped Shopify metafield definition.
const DYNAMIC_ID =
  /^(product|variant)\.metafield\.[a-z][a-zA-Z0-9]{7,95}$/;

const TOKEN = /^[a-z][a-zA-Z0-9_]*$/;
const SCOPE = /^[a-z][a-z0-9_]*$/;

const DATASETS = new Set(
  Object.values(SOURCE_DATASETS ?? {})
);

const OPERATIONS = new Set(
  Object.values(FIELD_OPERATIONS)
);

const DECIMAL_TYPES = new Set([
  FIELD_TYPES.DECIMAL,
  FIELD_TYPES.MONEY,
  FIELD_TYPES.PERCENTAGE,
]);

const DEFINITION_KEYS = new Set([
  "id",
  "label",
  "entity",
  "type",
  "nullable",
  "editable",
  "derived",
  "precision",
  "scale",
]);

const SOURCE_KEYS = new Set([
  "fieldId",
  "entity",
  "datasets",
  "accessAnyOf",
  "accessAllOf",
  "sourceKind",
  "adapterId",
  "definitionId",
  "definitionRevision",
  "locatorId",
  "mutationAdapterId",
]);

const RECORD_KEYS = new Set([
  "fieldId",
  "shopId",
  "definition",
  "source",
  "policy",
  "verification",
]);

const ISSUED_RESULTS = new WeakMap();
const CANONICAL_CACHE = new Map();
const AUTHORIZED_FIELD_SERVICES = new WeakSet();
let registryVersion = null;

// Only validated, immutable server-owned metadata reaches this serializer.
function mappingFingerprint(value) {
  function stable(item) {
    if (Array.isArray(item)) return item.map(stable);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, stable(item[key])]));
    }
    return item;
  }
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function fail(code, message, fieldId = null) {
  throw new FieldError(code, message, { fieldId });
}

function assertId(id) {
  if (!isCanonicalFieldId(id)) {
    fail(C.UNKNOWN_FIELD, "Invalid field identity");
  }
  return id;
}

function assertShop(shopId) {
  if (
    typeof shopId !== "string" ||
    shopId.length === 0 ||
    shopId.length > 255 ||
    shopId.trim() !== shopId ||
    /[\u0000-\u001f\u007f]/.test(shopId)
  ) {
    fail(C.INVALID_VALUE, "Invalid shop identity");
  }
  return shopId;
}

function assertAccess(access) {
  if (!Object.values(FIELD_ACCESS).includes(access)) {
    fail(C.UNSUPPORTED_OPERATION, "Invalid access mode");
  }
}

function assertOperation(operation) {
  if (!OPERATIONS.has(operation)) {
    fail(
      C.UNSUPPORTED_OPERATION,
      "Unsupported field operation"
    );
  }
}

function ownData(raw, allowed, fieldId) {
  if (!isPlainObject(raw)) {
    fail(
      C.INVALID_DEFINITION,
      "Invalid trusted descriptor",
      fieldId
    );
  }

  const result = Object.create(null);

  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      fail(
        C.INVALID_DEFINITION,
        "Unknown descriptor property",
        fieldId
      );
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(raw, key);

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Descriptor accessors are forbidden",
        fieldId
      );
    }

    result[key] = descriptor.value;
  }

  return result;
}

function validatedArray(
  values,
  predicate,
  maximum,
  fieldId,
  allowEmpty = false,
  allowDuplicates = false,
  errorCode = C.INVALID_DEFINITION
) {
  if (
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    values.length > maximum ||
    (!allowEmpty && values.length === 0)
  ) {
    fail(errorCode, "Invalid array", fieldId);
  }

  const keys = Reflect.ownKeys(values);
  if (keys.length !== values.length + 1 || keys[values.length] !== "length") {
    fail(errorCode, "Unexpected array properties", fieldId);
  }

  const seen = new Set();
  const items = [];

  for (let i = 0; i < values.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(i));
    if (
      keys[i] !== String(i) ||
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string" ||
      !predicate(descriptor.value) ||
      (!allowDuplicates && seen.has(descriptor.value))
    ) {
      fail(
        errorCode,
        "Invalid array entry",
        fieldId
      );
    }
    seen.add(descriptor.value);
    items.push(descriptor.value);
  }

  return items;
}

function validToken(value, max = 128) {
  return (
    typeof value === "string" &&
    value.length <= max &&
    TOKEN.test(value)
  );
}

function makeResult(field, source, origin, shopId, policy = FIELD_CONSTRAINT_REGISTRY[field.id], verification = null) {
  const result = deepFreeze({
    id: field.id,
    origin,
    field,
    source,
    policy,
    verification,
    entity: field.entity,
    type: field.type,
    nullable: field.nullable,
    editable: field.editable,
    derived: field.derived,

    // These describe field structure, not permission.
    structurallyReadable: true,
    structurallyWritable:
      field.editable === true &&
      field.derived === false &&
      policy?.writePolicy !== null &&
      policy?.writePolicy !== undefined &&
      (
        origin === FIELD_ORIGINS.CANONICAL ||
        source.mutationAdapterId !== null
      ),
  });

  ISSUED_RESULTS.set(result, {
    origin,
    shopId,
  });

  return result;
}

// --------------------------------------------------
// 1. Canonical registry and caching
// --------------------------------------------------

function initializeCanonicalCache() {
  // Source metadata is mandatory. Uninstalled SQL families remain explicit
  // unavailable entries; metadata alone never proves coverage or authorization.
  if (!isPlainObject(FIELD_SOURCES) || !isPlainObject(SOURCE_DATASETS)) {
    fail(C.MISSING_DEPENDENCY, "Trusted source registry required");
  }

  const ids = Object.keys(CANONICAL_FIELDS);

  if (ids.length !== Object.keys(FIELD_SOURCES).length) {
    fail(
      C.CONTRACT_MISMATCH,
      "Canonical/source coverage mismatch"
    );
  }

  for (const id of ids) {
    const field = CANONICAL_FIELDS[id];
    const source = FIELD_SOURCES[id];

    if (
      !source ||
      field.id !== id ||
      source.fieldId !== id ||
      source.entity !== field.entity ||
      source.canonicalType !== field.type ||
      source.canonicalDerived !== field.derived
    ) {
      fail(
        C.CONTRACT_MISMATCH,
        "Canonical/source contract mismatch",
        id
      );
    }

    CANONICAL_CACHE.set(
      id,
      makeResult(
        field,
        source,
        FIELD_ORIGINS.CANONICAL,
        null
      )
    );
  }
}

export function getResolvedCanonicalField(id) {
  ensureCanonicalCache();
  if (typeof id !== "string") return null;
  return CANONICAL_CACHE.get(id) ?? null;
}

export function requireResolvedCanonicalField(id) {
  assertId(id);
  const resolved = getResolvedCanonicalField(id);

  if (!resolved) {
    fail(C.UNKNOWN_FIELD, "Unknown canonical field", id);
  }

  return resolved;
}

// --------------------------------------------------
// 2. Dynamic definition validation
// --------------------------------------------------

function validateDynamicDefinition(raw, id) {
  const d = ownData(raw, DEFINITION_KEYS, id);

  if (
    d.id !== id ||
    !DYNAMIC_ID.test(id) ||
    d.entity !== id.split(".")[0]
  ) {
    fail(
      C.INVALID_DEFINITION,
      "Dynamic definition identity mismatch",
      id
    );
  }

  if (
    typeof d.label !== "string" ||
    d.label.length === 0 ||
    d.label.length > 120 ||
    d.label.trim() !== d.label ||
    /[\u0000-\u001f\u007f]/.test(d.label)
  ) {
    fail(
      C.INVALID_DEFINITION,
      "Invalid dynamic field label",
      id
    );
  }

  if (!isFieldType(d.type)) {
    fail(C.INVALID_TYPE, "Invalid dynamic type", id);
  }

  for (const key of [
    "nullable",
    "editable",
    "derived",
  ]) {
    if (typeof d[key] !== "boolean") {
      fail(
        C.INVALID_DEFINITION,
        "Invalid dynamic capability",
        id
      );
    }
  }

  if (d.derived && d.editable) {
    fail(
      C.INVALID_DEFINITION,
      "Derived field cannot be editable",
      id
    );
  }

  if (d.type === FIELD_TYPES.JSON && d.editable) {
    fail(
      C.INVALID_DEFINITION,
      "JSON field cannot be editable",
      id
    );
  }

  if (DECIMAL_TYPES.has(d.type)) {
    if (
      !Number.isSafeInteger(d.precision) ||
      !Number.isSafeInteger(d.scale) ||
      d.precision < 1 ||
      d.precision > 38 ||
      d.scale < 0 ||
      d.scale > d.precision
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Invalid decimal metadata",
        id
      );
    }
  } else if (
    d.precision !== undefined ||
    d.scale !== undefined
  ) {
    fail(
      C.INVALID_DEFINITION,
      "Unexpected decimal metadata",
      id
    );
  }

  return deepFreeze(d);
}

// --------------------------------------------------
// 3. Trusted dynamic source identity
// --------------------------------------------------

function validateDynamicSource(
  raw,
  field,
  allowedAdapters,
  allowedMutationAdapters
) {
  const s = ownData(raw, SOURCE_KEYS, field.id);

  if (
    s.fieldId !== field.id ||
    s.entity !== field.entity ||
    s.sourceKind !== "metafield" ||
    s.adapterId !== METAFIELD_READ_ADAPTER
  ) {
    fail(
      C.INVALID_SOURCE,
      "Invalid dynamic source identity",
      field.id
    );
  }

  if (
    !validToken(s.adapterId, 80) ||
    !(allowedAdapters instanceof Set) ||
    !allowedAdapters.has(s.adapterId)
  ) {
    fail(
      C.INVALID_SOURCE,
      "Unregistered source adapter",
      field.id
    );
  }

  if (
    typeof s.definitionId !== "string" ||
    !METAFIELD_DEFINITION_ID_PATTERN.test(s.definitionId) ||
    typeof s.definitionRevision !== "string" ||
    !METAFIELD_DEFINITION_TOKEN_PATTERN.test(s.definitionRevision) ||
    typeof s.locatorId !== "string" ||
    !METAFIELD_LOCATOR_PATTERN.test(s.locatorId)
  ) {
    fail(
      C.INVALID_SOURCE,
      "Invalid trusted field locator",
      field.id
    );
  }

  const mutationAdapterId =
    s.mutationAdapterId ?? null;

  if (mutationAdapterId !== null) {
    if (
      mutationAdapterId !== METAFIELD_WRITE_ADAPTER ||
      !(allowedMutationAdapters instanceof Set) ||
      !allowedMutationAdapters.has(mutationAdapterId)
    ) {
      fail(
        C.INVALID_SOURCE,
        "Unregistered mutation adapter",
        field.id
      );
    }
  }

  if (field.type === FIELD_TYPES.JSON && mutationAdapterId !== null) {
    fail(
      C.INVALID_SOURCE,
      "JSON field cannot declare mutation adapter",
      field.id
    );
  }

  if (
    field.editable &&
    mutationAdapterId === null
  ) {
    fail(
      C.INVALID_SOURCE,
      "Editable field lacks mutation adapter",
      field.id
    );
  }

  if (
    !field.editable &&
    mutationAdapterId !== null
  ) {
    fail(
      C.INVALID_SOURCE,
      "Read-only field declares mutation adapter",
      field.id
    );
  }

  const datasets = validatedArray(
    s.datasets,
    (value) => DATASETS.has(value),
    FIELD_RESOLVE_LIMITS.maxDatasets,
    field.id
  );

  if (datasets.length !== 1 || datasets[0] !== "metafields") {
    fail(C.INVALID_SOURCE, "Unexpected dynamic source dataset", field.id);
  }

  const accessAnyOf = validatedArray(
    s.accessAnyOf,
    (value) => SCOPE.test(value),
    FIELD_RESOLVE_LIMITS.maxScopes,
    field.id
  );

  const accessAllOf = validatedArray(
    s.accessAllOf ?? [],
    (value) => SCOPE.test(value),
    FIELD_RESOLVE_LIMITS.maxScopes,
    field.id,
    true
  );

  return deepFreeze({
    fieldId: field.id,
    entity: field.entity,
    sourceKind: "metafield",
    adapterId: s.adapterId,
    definitionId: s.definitionId,
    definitionRevision: s.definitionRevision,
    locatorId: s.locatorId,
    mutationAdapterId,
    datasets,
    accessAnyOf,
    accessAllOf,
  });
}

// --------------------------------------------------
// 4. Trusted shop-scoped records
// --------------------------------------------------

function validateDynamicRecord(
  raw,
  id,
  shopId,
  adapters
) {
  const record = ownData(
    raw,
    RECORD_KEYS,
    id
  );

  if (
    record.shopId !== shopId ||
    record.fieldId !== id
  ) {
    fail(
      C.PERMISSION_DENIED,
      "Dynamic record ownership mismatch",
      id
    );
  }

  const field = validateDynamicDefinition(
    record.definition,
    id
  );

  const source = validateDynamicSource(
    record.source,
    field,
    adapters.read,
    adapters.write
  );

  const policy = validateDynamicFieldPolicy(record.policy, {
    shopId, field, definitionToken: source.definitionRevision,
  });
  if (field.editable && (policy.writePolicy === null || policy.writePolicy === undefined)) {
    fail(
      C.INVALID_DEFINITION,
      "Editable dynamic field requires write policy",
      id
    );
  }
  if (!field.editable && policy.writePolicy !== null && policy.writePolicy !== undefined) {
    fail(
      C.INVALID_DEFINITION,
      "Read-only dynamic field cannot declare write policy",
      id
    );
  }
  let verification = null;
  if (record.verification !== undefined) {
    verification = ownData(record.verification, new Set([
      "definitionToken", "shopifyDefinitionId", "verifiedAt", "verificationExpiresAt",
    ]), id);
    if (verification.definitionToken !== source.definitionRevision || verification.shopifyDefinitionId !== source.definitionId ||
        typeof verification.shopifyDefinitionId !== "string" ||
        !/^gid:\/\/shopify\/MetafieldDefinition\/[0-9]+$/.test(verification.shopifyDefinitionId) ||
        typeof verification.verifiedAt !== "string" || typeof verification.verificationExpiresAt !== "string" ||
        !Number.isFinite(Date.parse(verification.verifiedAt)) ||
        !Number.isFinite(Date.parse(verification.verificationExpiresAt)) ||
        Date.parse(verification.verificationExpiresAt) <= Date.parse(verification.verifiedAt)) {
      fail(C.INVALID_DEFINITION, "Invalid definition verification binding", id);
    }
  }

  return makeResult(
    field,
    source,
    FIELD_ORIGINS.DYNAMIC,
    shopId,
    policy,
    verification
  );
}

function assertAdapters(adapters) {
  if (
    !adapters ||
    !isPlainObject(adapters) ||
    !(adapters.read instanceof Set) ||
    !(adapters.write instanceof Set)
  ) {
    fail(
      C.MISSING_DEPENDENCY,
      "Trusted adapter registry required"
    );
  }
}

// --------------------------------------------------
// 5. Metadata-only resolution
// --------------------------------------------------

export async function resolveFieldDefinition(
  id,
  {
    shopId,
    dynamicResolver,
    adapters,
  } = {}
) {
  assertId(id);
  ensureCanonicalCache();

  const fixed = CANONICAL_CACHE.get(id);
  if (fixed) return fixed;

  if (!DYNAMIC_ID.test(id)) {
    fail(C.UNKNOWN_FIELD, "Unknown field", id);
  }

  assertShop(shopId);
  assertAdapters(adapters);

  if (typeof dynamicResolver !== "function") {
    fail(
      C.MISSING_DEPENDENCY,
      "Dynamic field resolver required"
    );
  }

  const raw = await dynamicResolver({
    shopId,
    fieldId: id,
  });

  if (raw == null) {
    fail(C.UNKNOWN_FIELD, "Unknown dynamic field", id);
  }

  return validateDynamicRecord(
    raw,
    id,
    shopId,
    adapters
  );
}

// --------------------------------------------------
// 6. Keyed, bounded batch resolution
// --------------------------------------------------

export async function resolveFieldDefinitions(
  fieldIds,
  {
    shopId,
    dynamicResolver,
    dynamicBatchResolver,
    adapters,
  } = {}
) {
  ensureCanonicalCache();
  if (
    !Array.isArray(fieldIds) ||
    fieldIds.length > FIELD_RESOLVE_LIMITS.maxFields
  ) {
    fail(C.INVALID_VALUE, "Invalid resolution batch");
  }

  const ids = [];
  const seen = new Set();

  const safeIds = validatedArray(
    fieldIds, () => true, FIELD_RESOLVE_LIMITS.maxFields,
    null, true, true, C.INVALID_VALUE
  );
  let batchBytes = 0;
  for (const fieldId of safeIds) {
    const id = assertId(fieldId);
    batchBytes += Buffer.byteLength(id, "utf8");
    if (batchBytes > FIELD_RESOLVE_LIMITS.maxBatchBytes) {
      fail(C.INVALID_VALUE, "Field batch too large");
    }

    if (!seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }

  const dynamicIds = ids.filter(
    (id) => !CANONICAL_CACHE.has(id)
  );

  const resolvedDynamic = new Map();

  if (dynamicIds.length > 0) {
    assertShop(shopId);
    assertAdapters(adapters);

    for (const id of dynamicIds) {
      if (!DYNAMIC_ID.test(id)) {
        fail(C.UNKNOWN_FIELD, "Unknown field", id);
      }
    }

    let records;

    if (typeof dynamicBatchResolver === "function") {
      records = await dynamicBatchResolver({
        shopId,
        fieldIds: Object.freeze([...dynamicIds]),
      });
    } else if (
      dynamicIds.length === 1 &&
      typeof dynamicResolver === "function"
    ) {
      const raw = await dynamicResolver({
        shopId,
        fieldId: dynamicIds[0],
      });

      records = new Map([[dynamicIds[0], raw]]);
    } else {
      fail(
        C.MISSING_DEPENDENCY,
        "Batch dynamic resolver required"
      );
    }

    // Map keys are authoritative field identities.
    // Arrays and positional records are not accepted.
    if (
      !(records instanceof Map) ||
      records.size !== dynamicIds.length
    ) {
      fail(
        C.INVALID_DEFINITION,
        "Invalid keyed batch response"
      );
    }

    const requested = new Set(dynamicIds);

    for (const [id, raw] of records) {
      if (
        typeof id !== "string" ||
        !requested.has(id)
      ) {
        fail(
          C.INVALID_DEFINITION,
          "Unexpected dynamic batch field"
        );
      }

      if (raw == null) {
        fail(C.UNKNOWN_FIELD, "Missing dynamic field", id);
      }

      resolvedDynamic.set(
        id,
        validateDynamicRecord(
          raw,
          id,
          shopId,
          adapters
        )
      );
    }

    for (const id of dynamicIds) {
      if (!resolvedDynamic.has(id)) {
        fail(
          C.INVALID_DEFINITION,
          "Incomplete dynamic field batch",
          id
        );
      }
    }
  }

  return Object.freeze(
    ids.map(
      (id) =>
        CANONICAL_CACHE.get(id) ??
        resolvedDynamic.get(id)
    )
  );
}

// --------------------------------------------------
// 7. Provenance and structural access
// --------------------------------------------------

export function assertResolvedFieldAccess(
  resolved,
  access,
  { shopId } = {}
) {
  assertAccess(access);

  const provenance =
    resolved !== null &&
    typeof resolved === "object"
      ? ISSUED_RESULTS.get(resolved)
      : null;

  if (!provenance) {
    fail(
      C.PERMISSION_DENIED,
      "Untrusted field resolution"
    );
  }

  if (provenance.origin === FIELD_ORIGINS.DYNAMIC) {
    assertShop(shopId);

    if (provenance.shopId !== shopId) {
      fail(
        C.PERMISSION_DENIED,
        "Field resolution belongs to another shop"
      );
    }
  }

  if (
    access === FIELD_ACCESS.WRITE &&
    (!resolved.structurallyWritable || !resolved.policy?.writePolicy)
  ) {
    fail(
      C.READ_ONLY,
      "Field is not structurally writable",
      resolved.id
    );
  }

  return resolved;
}

/** Metadata lookup only: provenance and ownership do not authorize an action. */
export function getResolvedFieldPolicy(resolved, context = POLICY_CONTEXT.READ, { shopId } = {}) {
  assertResolvedFieldAccess(resolved, FIELD_ACCESS.READ, { shopId });
  if (!Object.values(POLICY_CONTEXT).includes(context)) {
    fail(C.INVALID_VALUE, "Invalid policy context", resolved.id);
  }
  if (resolved.origin === FIELD_ORIGINS.CANONICAL) return getFieldPolicy(resolved.id, context);
  return deepFreeze({
    fieldId: resolved.id, shopId, definitionToken: resolved.policy.definitionToken,
    context, type: resolved.type, nullable: resolved.nullable,
    constraints: resolved.policy[context],
    operations: context === POLICY_CONTEXT.WRITE ? resolved.policy.writePolicy?.operations ?? [] : [],
  });
}

// --------------------------------------------------
// 8. Authorization and mirror coverage
// --------------------------------------------------

function assertAuthorizationContext({
  shopId,
  access,
  operation,
  actor,
  executionContext,
  authorizeAccess,
  verifyCoverage,
}) {
  assertShop(shopId);
  assertAccess(access);
  assertOperation(operation);

  if (
    actor === null ||
    typeof actor !== "object" ||
    !isPlainObject(actor)
  ) {
    fail(
      C.PERMISSION_DENIED,
      "Authenticated actor required"
    );
  }

  if (
    !isPlainObject(executionContext) ||
    typeof executionContext.operationId !== "string" ||
    executionContext.operationId.length === 0 ||
    executionContext.operationId.length > 128
  ) {
    fail(
      C.PERMISSION_DENIED,
      "Trusted execution context required"
    );
  }

  if (
    typeof authorizeAccess !== "function" ||
    typeof verifyCoverage !== "function"
  ) {
    fail(
      C.MISSING_DEPENDENCY,
      "Authorization and coverage services required"
    );
  }
}

function collectDatasets(fields) {
  const datasets = new Set();

  for (const resolved of fields) {
    for (const dataset of resolved.source.datasets) {
      datasets.add(dataset);
    }
  }

  return Object.freeze([...datasets].sort());
}

/**
 * This check must run against server-owned services.
 *
 * authorizeAccess verifies:
 * - authenticated shop and actor
 * - Shopify scopes
 * - definition ownership
 * - mutation adapter capability
 * - operation-specific permissions
 * - approved preview/execution contract for writes
 *
 * verifyCoverage verifies:
 * - published datasets
 * - completeness
 * - generation consistency
 * - operation-specific freshness
 *
 * Only an exact boolean true is accepted.
 */
async function authorizeResolvedBatch(
  fields,
  options
) {
  assertAuthorizationContext(options);

  const {
    shopId,
    access,
    operation,
    actor,
    executionContext,
    authorizeAccess,
    verifyCoverage,
  } = options;

  for (const resolved of fields) {
    assertResolvedFieldAccess(
      resolved,
      access,
      { shopId }
    );
  }

  const datasets = collectDatasets(fields);

  // Fail closed for all operations.
  // An empty dataset set is valid only for an
  // explicitly empty field batch.
  if (fields.length > 0) {
    const covered = await verifyCoverage({
      shopId,
      operation,
      access,
      datasets,
      fields: Object.freeze([...fields]),
      executionContext,
    });

    if (covered !== true) {
      fail(
        C.MISSING_DEPENDENCY,
        "Published source coverage unavailable"
      );
    }
  }

  for (const resolved of fields) {
    const allowed = await authorizeAccess({
      shopId,
      actor,
      operation,
      executionContext,
      access,
      field: resolved.field,
      source: resolved.source,
      policy: resolved.policy,
      verification: resolved.verification,
    });

    if (allowed !== true) {
      fail(
        C.PERMISSION_DENIED,
        "Field access denied",
        resolved.id
      );
    }
  }

  return fields;
}

// --------------------------------------------------
// 9. Authorized single and batch entry points
// --------------------------------------------------

export async function requireFieldForAccess(
  fieldId,
  access,
  options = {}
) {
  assertAccess(access);

  const [resolved] = await requireFieldsForAccess(
    [fieldId],
    access,
    options
  );

  return resolved;
}

export async function requireFieldsForAccess(
  fieldIds,
  access,
  options = {}
) {
  assertAccess(access);

  // Validate authorization dependencies BEFORE
  // touching shop-scoped dynamic metadata.
  assertAuthorizationContext({
    ...options,
    access,
  });

  const fields = await resolveFieldDefinitions(
    fieldIds,
    options
  );

  return authorizeResolvedBatch(fields, {
    ...options,
    access,
  });
}

// --------------------------------------------------
// 10. Registry integrity
// --------------------------------------------------

/**
 * Execution consumers configure this factory in trusted backend code.
 * authContext and executionContext must come from server authentication and
 * approval services. Older require*ForAccess exports are low-level APIs only.
 */
export function createFieldService({ adapter, authorizeAccess, verifyCoverage, resolveShop, verifyExecutionContext } = {}) {
  if (!adapter || typeof adapter.resolveOne !== "function" || typeof adapter.resolveBatch !== "function" ||
      typeof authorizeAccess !== "function" || typeof verifyCoverage !== "function" || typeof resolveShop !== "function") {
    throw new TypeError("Trusted field service dependencies required");
  }
  if (verifyExecutionContext !== undefined && typeof verifyExecutionContext !== "function") {
    throw new TypeError("Invalid persisted execution verifier");
  }
  const bridge = createMetafieldResolverBridge({
    resolveOne: adapter.resolveOne.bind(adapter), resolveBatch: adapter.resolveBatch.bind(adapter),
  });
  const adapters = {
    read: new Set([METAFIELD_READ_ADAPTER]), write: new Set([METAFIELD_WRITE_ADAPTER]),
  };
  const keys = new Set(["authContext", "fieldIds", "access", "operation", "executionContext"]);
  const issuedResolutions = new WeakMap();

  function assertDefinitionRevisions(fields, access, operation, executionContext, phase) {
    const dynamic = fields.filter(field => field.origin === FIELD_ORIGINS.DYNAMIC);
    const expected = executionContext.expectedDefinitionRevisions;
    if (expected === undefined) {
      if (dynamic.length && phase !== "preview" &&
          (access === FIELD_ACCESS.WRITE || operation !== FIELD_OPERATIONS.FILTER)) {
        fail(C.CONTRACT_MISMATCH, "Approved definition revisions required");
      }
      return;
    }
    if (!Array.isArray(expected) || Object.getPrototypeOf(expected) !== Array.prototype ||
        expected.length > FIELD_RESOLVE_LIMITS.maxFields || expected.length !== dynamic.length ||
        Reflect.ownKeys(expected).length !== expected.length + 1) {
      fail(C.CONTRACT_MISMATCH, "Invalid approved definition revisions");
    }
    const revisions = new Map();
    for (let index = 0; index < expected.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(expected, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        fail(C.CONTRACT_MISMATCH, "Invalid approved definition revision entry");
      }
      const revision = ownData(descriptor.value, new Set(["fieldId", "definitionToken"]));
      if (typeof revision.fieldId !== "string" || !DYNAMIC_ID.test(revision.fieldId) ||
          typeof revision.definitionToken !== "string" || !METAFIELD_DEFINITION_TOKEN_PATTERN.test(revision.definitionToken) ||
          revisions.has(revision.fieldId)) {
        fail(C.CONTRACT_MISMATCH, "Invalid approved definition revision entry");
      }
      revisions.set(revision.fieldId, revision.definitionToken);
    }
    for (const resolved of dynamic) {
      if (revisions.get(resolved.id) !== resolved.source.definitionRevision) {
        fail(C.CONTRACT_MISMATCH, "Definition changed since approved preview", resolved.id);
      }
    }
  }

  async function requireFields(raw) {
    const args = ownData(raw, keys);
    const access = args.access === undefined ? FIELD_ACCESS.READ : args.access;
    assertAccess(access);
    assertOperation(args.operation);
    if (!isPlainObject(args.authContext)) fail(C.PERMISSION_DENIED, "Authenticated context required");
    const execution = args.executionContext;
    if (!isPlainObject(execution)) fail(C.PERMISSION_DENIED, "Trusted execution context required");
    const executionContext = deepFreeze(ownData(execution, new Set(Reflect.ownKeys(execution))));
    const phase = executionContext.phase === undefined ? "execute" : executionContext.phase;
    if (phase !== "preview" && phase !== "execute") {
      fail(C.INVALID_VALUE, "Invalid field service phase");
    }
    for (const key of ["operationId", "generationId"]) {
      const value = executionContext[key];
      if (typeof value !== "string" || value.length === 0 || value.length > 128 ||
          value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
        fail(C.PERMISSION_DENIED, "Pinned execution identity required");
      }
    }
    if (executionContext.coverageRevision !== undefined &&
        (typeof executionContext.coverageRevision !== "string" || !executionContext.coverageRevision ||
         executionContext.coverageRevision.length > 128 || executionContext.coverageRevision.trim() !== executionContext.coverageRevision ||
         /[\u0000-\u001f\u007f]/.test(executionContext.coverageRevision))) {
      fail(C.PERMISSION_DENIED, "Invalid coverage revision");
    }
    const ids = validatedArray(args.fieldIds, () => true, FIELD_RESOLVE_LIMITS.maxFields,
      null, false, true, C.INVALID_VALUE);
    let bytes = 0;
    for (const id of ids) { assertId(id); bytes += Buffer.byteLength(id, "utf8"); }
    if (bytes > FIELD_RESOLVE_LIMITS.maxBatchBytes) fail(C.INVALID_VALUE, "Field batch too large");

    const shopId = assertShop(await resolveShop(args.authContext));
    const fields = await resolveFieldDefinitions(ids, { shopId, adapters, ...bridge });
    const resolvedRegistryVersion = mappingFingerprint({
      registryVersion,
      mappings: [...fields].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(field => ({
        id: field.id, definition: field.field, source: field.source, policy: field.policy,
      })),
    });
    if (executionContext.expectedRegistryVersion !== undefined &&
        executionContext.expectedRegistryVersion !== resolvedRegistryVersion) {
      fail(C.CONTRACT_MISMATCH, "Trusted field registry changed");
    }
    assertDefinitionRevisions(fields, access, args.operation, executionContext, phase);
    const datasetSet = new Set();
    for (const resolved of fields) {
      assertResolvedFieldAccess(resolved, access, { shopId });
      for (const dataset of resolved.source.datasets) {
        if (!DATASETS.has(dataset)) fail(C.INVALID_SOURCE, "Unsupported source dataset", resolved.id);
        datasetSet.add(dataset);
      }
    }
    const rawTarget = executionContext.approvedTargetingSnapshot;
    const requiresTarget = phase !== "preview" &&
      (access === FIELD_ACCESS.WRITE || args.operation !== FIELD_OPERATIONS.FILTER);
    if (rawTarget === undefined && requiresTarget) {
      fail(C.CONTRACT_MISMATCH, "Approved targeting snapshot required");
    }
    let target = null;
    if (rawTarget !== undefined) {
      target = ownData(rawTarget, new Set(["snapshotId", "shopId", "generationId", "coverageRevision"]));
      if (typeof target.snapshotId !== "string" || !target.snapshotId || target.snapshotId.length > 128 ||
          target.snapshotId.trim() !== target.snapshotId || /[\u0000-\u001f\u007f]/.test(target.snapshotId) ||
          target.shopId !== shopId || target.generationId !== executionContext.generationId ||
          typeof target.coverageRevision !== "string" || !target.coverageRevision || target.coverageRevision.length > 128 ||
          target.coverageRevision.trim() !== target.coverageRevision || /[\u0000-\u001f\u007f]/.test(target.coverageRevision) ||
          (executionContext.coverageRevision !== undefined && target.coverageRevision !== executionContext.coverageRevision)) {
        fail(C.CONTRACT_MISMATCH, "Approved targeting snapshot mismatch");
      }
    }
    let approval = null;
    // Mutable operations require a persisted, operation-specific approval check
    // in addition to field permissions and the coverage repository's target check.
    // The pure engine never treats request context or a generic true as approval.
    const sensitive = access === FIELD_ACCESS.WRITE ||
      ["bulk_edit", "scheduled_edit", "recurring_edit", "import", "undo"].includes(args.operation);
    if (sensitive && phase === "execute") {
      if (!verifyExecutionContext) fail(C.EXECUTION_UNAVAILABLE, "Persisted execution verification unavailable");
      const rawApproval = await verifyExecutionContext({ shopId, authContext: args.authContext,
        operation: args.operation, phase, access, executionContext, fields, targetingSnapshot: target });
      if (!isPlainObject(rawApproval)) fail(C.PERMISSION_DENIED, "Persisted execution approval required");
      approval = ownData(rawApproval, new Set(["approved", "shopId", "operation", "operationId", "generationId",
        "targetingSnapshotId", "executionContractId", "approvalRevision"]));
      if (approval.approved !== true || approval.shopId !== shopId || approval.operation !== args.operation ||
          approval.operationId !== executionContext.operationId || approval.generationId !== executionContext.generationId ||
          approval.targetingSnapshotId !== target?.snapshotId ||
          typeof approval.executionContractId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(approval.executionContractId) ||
          typeof approval.approvalRevision !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(approval.approvalRevision)) {
        fail(C.PERMISSION_DENIED, "Persisted execution approval mismatch");
      }
    }
    const datasets = Object.freeze([...datasetSet].sort());
    for (const resolved of fields) {
      const allowed = await authorizeAccess({
        shopId, authContext: args.authContext, access, phase, operation: args.operation,
        executionContext, field: resolved.field, source: resolved.source,
        policy: resolved.policy, verification: resolved.verification,
      });
      if (allowed !== true) fail(C.PERMISSION_DENIED, "Field access denied", resolved.id);
    }
    const rawCoverage = await verifyCoverage({
      shopId, authContext: args.authContext, datasets, fields, access, phase,
      operation: args.operation, executionContext,
    });
    if (!isPlainObject(rawCoverage)) fail(C.MISSING_DEPENDENCY, "Published mirror coverage unavailable");
    const coverage = ownData(rawCoverage, new Set(["ready", "generationId", "coverageRevision", "targetingSnapshotId", "mirrorSchemaVersion", "sourceContractVersion"]));
    if (coverage.ready !== true || coverage.generationId !== executionContext.generationId ||
        typeof coverage.coverageRevision !== "string" || !coverage.coverageRevision ||
        coverage.coverageRevision.length > 128 || coverage.coverageRevision.trim() !== coverage.coverageRevision ||
        /[\u0000-\u001f\u007f]/.test(coverage.coverageRevision) ||
        (executionContext.coverageRevision !== undefined && coverage.coverageRevision !== executionContext.coverageRevision) ||
        (target && (coverage.targetingSnapshotId !== target.snapshotId || coverage.coverageRevision !== target.coverageRevision))) {
      fail(C.MISSING_DEPENDENCY, "Published mirror coverage unavailable");
    }
    const resolution = deepFreeze({
      shopId, access, phase, operation: args.operation, operationId: executionContext.operationId, fields, datasets,
      generationId: coverage.generationId, coverageRevision: coverage.coverageRevision,
      targetingSnapshotId: target?.snapshotId ?? null,
      executionContractId: approval?.executionContractId ?? null,
      approvalRevision: approval?.approvalRevision ?? null,
      registryVersion: resolvedRegistryVersion,
      mirrorSchemaVersion: coverage.mirrorSchemaVersion ?? null,
      sourceContractVersion: coverage.sourceContractVersion ?? null,
      definitionRevisions: fields.filter(field => field.origin === FIELD_ORIGINS.DYNAMIC)
        .map(field => ({ fieldId: field.id, definitionToken: field.source.definitionRevision })),
    });
    issuedResolutions.set(resolution, { executionContext, fieldIds: Object.freeze([...ids]) });
    return resolution;
  }

  async function requireField(raw) {
    const args = ownData(raw, new Set(["authContext", "fieldId", "access", "operation", "executionContext"]));
    const { fieldId, ...options } = args;
    return requireFields({ ...options, fieldIds: [fieldId] });
  }
  function assertResolution(resolution) {
    if (!resolution || typeof resolution !== "object" || !issuedResolutions.has(resolution)) {
      fail(C.PERMISSION_DENIED, "Untrusted field resolution contract");
    }
    return resolution;
  }

  async function revalidateResolution(resolution, context) {
    assertResolution(resolution);
    const proof = resolution && typeof resolution === "object" && issuedResolutions.get(resolution);
    if (!proof) fail(C.PERMISSION_DENIED, "Untrusted field resolution contract");
    const { authContext } = ownData(context, new Set(["authContext"]));
    if (!isPlainObject(authContext) || assertShop(await resolveShop(authContext)) !== resolution.shopId) {
      fail(C.PERMISSION_DENIED, "Field resolution belongs to another authenticated shop");
    }
    // Re-read definitions and re-run authorization and actual coverage, rather
    // than considering a previously returned receipt proof of current readiness.
    const current = await requireFields({
      authContext, fieldIds: proof.fieldIds, access: resolution.access, operation: resolution.operation,
      executionContext: {
        ...proof.executionContext, phase: resolution.phase,
        coverageRevision: resolution.coverageRevision,
        expectedDefinitionRevisions: resolution.definitionRevisions,
        expectedRegistryVersion: resolution.registryVersion,
      },
    });
    if (current.shopId !== resolution.shopId) {
      fail(C.PERMISSION_DENIED, "Authenticated shop changed during revalidation");
    }
    for (const key of ["access", "phase", "operation", "operationId", "generationId", "coverageRevision", "targetingSnapshotId", "executionContractId", "approvalRevision", "registryVersion", "mirrorSchemaVersion", "sourceContractVersion"]) {
      if (current[key] !== resolution[key]) fail(C.CONTRACT_MISMATCH, "Field resolution binding changed during revalidation");
    }
    return current;
  }
  const service = Object.freeze({ requireField, requireFields, assertResolution, revalidateResolution });
  AUTHORIZED_FIELD_SERVICES.add(service);
  return service;
}

// Assertion only, never an issuer. Internal filter services reject lookalike
// objects that claim to provide authorized resolution methods.
export function assertAuthorizedFieldService(service) {
  if (!service || typeof service !== "object" || !AUTHORIZED_FIELD_SERVICES.has(service)) {
    fail(C.PERMISSION_DENIED, "Untrusted field service");
  }
  return service;
}

export function assertFieldResolutionRegistry() {
  ensureCanonicalCache();
  if (
    CANONICAL_CACHE.size !==
    Object.keys(CANONICAL_FIELDS).length
  ) {
    fail(
      C.CONTRACT_MISMATCH,
      "Incomplete canonical resolution cache"
    );
  }

  for (const [id, resolved] of CANONICAL_CACHE) {
    const field = getCanonicalField(id);
    const source = FIELD_SOURCES[id];

    if (
      resolved.field !== field ||
      resolved.source !== source ||
      source.fieldId !== id ||
      source.entity !== field.entity ||
      source.canonicalType !== field.type ||
      source.canonicalDerived !== field.derived
    ) {
      fail(
        C.CONTRACT_MISMATCH,
        "Field resolution registry mismatch",
        id
      );
    }
  }

  return true;
}

export const FIELD_RESOLVE_INFO = deepFreeze({
  version: FIELD_RESOLVE_CONTRACT_VERSION,
  origins: Object.values(FIELD_ORIGINS),
  access: Object.values(FIELD_ACCESS),
  operations: Object.values(FIELD_OPERATIONS),
  limits: FIELD_RESOLVE_LIMITS,
});

function ensureCanonicalCache() {
  if (CANONICAL_CACHE.size !== Object.keys(CANONICAL_FIELDS).length) {
    // A failed initialization must not leave a partially usable cache.
    CANONICAL_CACHE.clear();
    try {
      initializeCanonicalCache();
      registryVersion = mappingFingerprint({
        contractVersion: FIELD_RESOLVE_CONTRACT_VERSION, fields: CANONICAL_FIELDS,
        sources: FIELD_SOURCES, policies: FIELD_CONSTRAINT_REGISTRY,
        compilerBindings: sourceRegistry.FILTER_BINDING_DEFINITIONS !== undefined || sourceRegistry.FILTER_SQL_SCHEMA !== undefined
          ? deepFreeze({ definitions: sourceRegistry.FILTER_BINDING_DEFINITIONS ?? null, schema: sourceRegistry.FILTER_SQL_SCHEMA ?? null }) : null,
      });
    } catch (error) {
      CANONICAL_CACHE.clear();
      registryVersion = null;
      throw error;
    }
  }
}

if (FIELD_SOURCES !== undefined && SOURCE_DATASETS !== undefined) {
  ensureCanonicalCache();
  assertFieldResolutionRegistry();
}
