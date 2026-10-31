import {
  FieldError,
  FIELD_ERROR_CODES as C,
  deepFreeze,
  isFieldType,
} from "./types.js";
import { createDynamicFieldPolicy } from "./constraints.js";
import {
  DYNAMIC_METAFIELD_ID_PATTERN, METAFIELD_DEFINITION_TOKEN_PATTERN, METAFIELD_DEFINITION_ID_PATTERN,
  METAFIELD_LOCATOR_PATTERN, validateMetafieldShop, validateDynamicMetafieldId,
} from "./metafield-identity.js";
export {
  DYNAMIC_METAFIELD_ID_PATTERN, METAFIELD_DEFINITION_TOKEN_PATTERN,
  METAFIELD_LOCATOR_PATTERN, validateMetafieldShop, validateDynamicMetafieldId,
} from "./metafield-identity.js";

export const METAFIELD_ADAPTER_VERSION = 3;

export const METAFIELD_LIMITS = Object.freeze({
  MAX_FIELDS: 1000,
  MAX_SHOP_LENGTH: 255,
  MAX_LABEL_LENGTH: 120,
  MAX_LOCATOR_LENGTH: 255,
});

export const METAFIELD_READ_ADAPTER = "metafieldReader";
export const METAFIELD_WRITE_ADAPTER = "metafieldWriter";

const DEFINITION_GID_PATTERN = METAFIELD_DEFINITION_ID_PATTERN;

const NAMESPACE_PATTERN =
  /^[a-zA-Z0-9_$-][a-zA-Z0-9_$.-]{0,254}$/;

const KEY_PATTERN =
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const OWNER_TYPES = Object.freeze({
  product: "PRODUCT",
  variant: "PRODUCTVARIANT",
});

export const SUPPORTED_METAFIELD_TYPES = Object.freeze({
  single_line_text_field: "string",
  multi_line_text_field: "string",
  boolean: "boolean",
  number_integer: "integer",
  number_decimal: "decimal",
  date: "date",
  date_time: "datetime",
  json: "json",
  "list.single_line_text_field": "string_list",
});

const ALLOWED_ROW_KEYS = new Set([
  "shopId",
  "fieldId",
  "status",
  "definitionVerified",
  "shopifyDefinitionId",
  "locatorId",
  "namespace",
  "key",
  "ownerEntity",
  "shopifyOwnerType",
  "shopifyType",
  "label",
  "nullable",
  "writable",
  "mutationSupported",
  "readerAdapterId",
  "writerAdapterId",
  "definitionToken",
  "precision",
  "scale",
  "verifiedAt",
  "verificationExpiresAt",
  "constraints",
]);

function reject(code, message, fieldId = null) {
  throw new FieldError(code, message, {
    fieldId,
  });
}

function isRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function readDataRecord(value, fieldId) {
  if (!isRecord(value)) {
    reject(
      C.INVALID_DEFINITION,
      "Invalid metafield record",
      fieldId
    );
  }

  const result = Object.create(null);

  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !ALLOWED_ROW_KEYS.has(key)
    ) {
      reject(
        C.INVALID_DEFINITION,
        "Unexpected metafield record property",
        fieldId
      );
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(value, key);

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      reject(
        C.INVALID_DEFINITION,
        "Metafield record accessors are prohibited",
        fieldId
      );
    }

    result[key] = descriptor.value;
  }

  return result;
}

function validString(value, pattern) {
  return (
    typeof value === "string" &&
    pattern.test(value)
  );
}

function readDenseArray(values, maximum, code) {
  if (!Array.isArray(values) || Object.getPrototypeOf(values) !== Array.prototype ||
      values.length > maximum) {
    reject(code, "Invalid dense array");
  }
  const keys = Reflect.ownKeys(values);
  if (keys.length !== values.length + 1 || keys[values.length] !== "length") {
    reject(code, "Unexpected array properties");
  }
  const result = [];
  for (let index = 0; index < values.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (keys[index] !== String(index) || !descriptor || !Object.hasOwn(descriptor, "value")) {
      reject(code, "Sparse or accessor-backed array");
    }
    result.push(descriptor.value);
  }
  return result;
}

function validateFieldIds(fieldIds) {
  fieldIds = readDenseArray(fieldIds, METAFIELD_LIMITS.MAX_FIELDS, C.INVALID_VALUE);
  if (
    !Array.isArray(fieldIds) ||
    fieldIds.length < 1 ||
    fieldIds.length > METAFIELD_LIMITS.MAX_FIELDS
  ) {
    reject(C.INVALID_VALUE, "Invalid field batch");
  }

  const unique = new Set();

  for (let index = 0; index < fieldIds.length; index++) {
    if (!Object.hasOwn(fieldIds, index)) {
      reject(C.INVALID_VALUE, "Sparse field batch");
    }

    const fieldId =
      validateDynamicMetafieldId(fieldIds[index]);

    if (unique.has(fieldId)) {
      reject(C.INVALID_VALUE, "Duplicate field identifier");
    }

    unique.add(fieldId);
  }

  return [...unique];
}

function validateDecimal(row, type) {
  if (type !== "decimal") {
    if (
      row.precision !== undefined &&
      row.precision !== null
    ) {
      reject(
        C.INVALID_DEFINITION,
        "Unexpected decimal precision",
        row.fieldId
      );
    }

    if (
      row.scale !== undefined &&
      row.scale !== null
    ) {
      reject(
        C.INVALID_DEFINITION,
        "Unexpected decimal scale",
        row.fieldId
      );
    }

    return {};
  }

  if (
    !Number.isSafeInteger(row.precision) ||
    !Number.isSafeInteger(row.scale) ||
    row.precision < 1 ||
    row.precision > 38 ||
    row.scale < 0 ||
    row.scale > row.precision
  ) {
    reject(
      C.INVALID_DEFINITION,
      "Invalid metafield decimal constraints",
      row.fieldId
    );
  }

  return {
    precision: row.precision,
    scale: row.scale,
  };
}

function validateVerification(row, nowMs) {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    row.definitionVerified !== true
  ) {
    reject(
      C.INVALID_DEFINITION,
      "Definition is not verified",
      row.fieldId
    );
  }

  if (typeof row.verifiedAt !== "string" || typeof row.verificationExpiresAt !== "string") {
    reject(C.INVALID_DEFINITION, "Invalid verification timestamps", row.fieldId);
  }
  const verifiedAt = Date.parse(row.verifiedAt);
  const expiresAt =
    Date.parse(row.verificationExpiresAt);

  if (
    typeof row.verifiedAt !== "string" ||
    typeof row.verificationExpiresAt !== "string" ||
    !Number.isFinite(verifiedAt) ||
    !Number.isFinite(expiresAt) ||
    verifiedAt > nowMs ||
    expiresAt <= nowMs ||
    expiresAt <= verifiedAt
  ) {
    reject(
      C.INVALID_DEFINITION,
      "Metafield verification expired or invalid",
      row.fieldId
    );
  }
}

function toResolvedRecord(raw, shopId, nowMs) {
  const row = readDataRecord(raw);

  validateDynamicMetafieldId(row.fieldId);

  if (
    row.shopId !== shopId ||
    row.status !== "ACTIVE"
  ) {
    reject(
      C.INVALID_DEFINITION,
      "Metafield definition unavailable",
      row.fieldId
    );
  }

  validateVerification(row, nowMs);

  const entity = row.fieldId.split(".")[0];

  if (
    row.ownerEntity !== entity ||
    row.shopifyOwnerType !== OWNER_TYPES[entity]
  ) {
    reject(
      C.INVALID_DEFINITION,
      "Metafield owner mismatch",
      row.fieldId
    );
  }

  if (
    !validString(
      row.shopifyDefinitionId,
      DEFINITION_GID_PATTERN
    ) ||
    !validString(row.locatorId, METAFIELD_LOCATOR_PATTERN) ||
    !validString(row.definitionToken, METAFIELD_DEFINITION_TOKEN_PATTERN) ||
    !validString(row.namespace, NAMESPACE_PATTERN) ||
    !validString(row.key, KEY_PATTERN)
  ) {
    reject(
      C.INVALID_DEFINITION,
      "Invalid stored metafield locator",
      row.fieldId
    );
  }

  if (
    typeof row.label !== "string" ||
    row.label.length === 0 ||
    row.label.length >
      METAFIELD_LIMITS.MAX_LABEL_LENGTH ||
    row.label.trim() !== row.label ||
    /[\u0000-\u001f\u007f]/.test(row.label)
  ) {
    reject(
      C.INVALID_DEFINITION,
      "Invalid metafield label",
      row.fieldId
    );
  }

  if (
    typeof row.nullable !== "boolean" ||
    typeof row.writable !== "boolean" ||
    typeof row.mutationSupported !== "boolean"
  ) {
    reject(
      C.INVALID_DEFINITION,
      "Invalid metafield capabilities",
      row.fieldId
    );
  }

  const type = typeof row.shopifyType === "string" &&
    Object.hasOwn(SUPPORTED_METAFIELD_TYPES, row.shopifyType)
      ? SUPPORTED_METAFIELD_TYPES[row.shopifyType] : null;

  if (!type || !isFieldType(type)) {
    reject(
      C.INVALID_TYPE,
      "Unsupported canonical metafield type",
      row.fieldId
    );
  }

  // An approved reader is mandatory even when
  // the definition is read-only.
  if (
    row.readerAdapterId !== METAFIELD_READ_ADAPTER
  ) {
    reject(
      C.INVALID_SOURCE,
      "Approved metafield reader missing",
      row.fieldId
    );
  }

  // A write capability requires every component:
  // stored permission, supported mutation,
  // and the approved writer adapter.
  const hasWriter = row.writerAdapterId === METAFIELD_WRITE_ADAPTER;

  // Contradictory writer metadata fails closed.
  if (
    row.writable === true &&
    (row.mutationSupported !== true || !hasWriter)
  ) {
    reject(
      C.INVALID_SOURCE,
      "Incomplete metafield writer binding",
      row.fieldId
    );
  }

  if (
    row.writerAdapterId != null &&
    row.writerAdapterId !== METAFIELD_WRITE_ADAPTER
  ) {
    reject(
      C.INVALID_SOURCE,
      "Unapproved metafield writer",
      row.fieldId
    );
  }

  if (row.writable === false && hasWriter) {
    reject(C.INVALID_SOURCE, "Unexpected writer on read-only metafield", row.fieldId);
  }

  if (
    type === "json" &&
    (row.writable === true ||
      row.mutationSupported === true ||
      row.writerAdapterId != null)
  ) {
    reject(
      C.INVALID_SOURCE,
      "JSON metafields cannot be writable",
      row.fieldId
    );
  }
  const writable = row.writable === true;

  const decimal = validateDecimal(row, type);

  const definition = deepFreeze({
    id: row.fieldId,
    label: row.label,
    entity,
    type,
    nullable: row.nullable,
    editable: writable,
    derived: false,
    ...decimal,
  });

  // No SQL, Prisma model or GraphQL expression.
  // The reader/writer must resolve the locator
  // through a trusted, shop-scoped repository.
  const source = deepFreeze({
    fieldId: row.fieldId,
    entity,
    sourceKind: "metafield",
    adapterId: METAFIELD_READ_ADAPTER,
    mutationAdapterId:
      writable ? METAFIELD_WRITE_ADAPTER : null,
    definitionId: row.shopifyDefinitionId,
    definitionRevision: row.definitionToken,
    locatorId: row.locatorId,
    datasets: ["metafields"],
    accessAnyOf: ["read_products"],
    accessAllOf: [],
  });

  return deepFreeze({
    fieldId: row.fieldId,
    shopId,
    definition,
    source,
    policy: createDynamicFieldPolicy({
      shopId, field: definition, definitionToken: row.definitionToken,
      constraints: row.constraints ?? {},
    }),
    verification: {
      definitionToken: row.definitionToken,
      shopifyDefinitionId: row.shopifyDefinitionId,
      verifiedAt: row.verifiedAt,
      verificationExpiresAt: row.verificationExpiresAt,
    },
  });
}

export function createMetafieldAdapter({
  repository,
  clock = Date.now,
} = {}) {
  if (
    !repository ||
    typeof repository.findVerifiedDefinitions !==
      "function"
  ) {
    throw new TypeError(
      "Trusted metafield repository required"
    );
  }

  if (typeof clock !== "function") {
    throw new TypeError("Invalid adapter clock");
  }

  async function resolveBatch({ shopId, fieldIds }) {
    validateMetafieldShop(shopId);

    const ids = validateFieldIds(fieldIds);

    const rows =
      await repository.findVerifiedDefinitions({
        shopId,
        fieldIds: Object.freeze([...ids]),
      });

    const nowMs = clock();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new TypeError("Invalid adapter clock value");
    }
    const safeRows = readDenseArray(rows, ids.length, C.INVALID_SOURCE);

    const requested = new Set(ids);
    const resolved = new Map();
    // Catch ambiguity in this response. The repository must also enforce these
    // uniqueness constraints in storage, including across separate lookups.
    const uniqueBindings = [new Set(), new Set(), new Set()];

    for (let index = 0; index < safeRows.length; index++) {
      const row = readDataRecord(safeRows[index]);

      if (
        !isRecord(row) ||
        typeof row.fieldId !== "string" ||
        !requested.has(row.fieldId) ||
        resolved.has(row.fieldId)
      ) {
        reject(
          C.INVALID_SOURCE,
          "Unexpected or duplicate metafield row"
        );
      }

      const record = toResolvedRecord(row, shopId, nowMs);
      const bindings = [
        row.shopifyDefinitionId,
        row.locatorId,
        JSON.stringify([row.ownerEntity, row.namespace, row.key]),
      ];
      for (let binding = 0; binding < bindings.length; binding++) {
        if (uniqueBindings[binding].has(bindings[binding])) {
          reject(C.INVALID_SOURCE, "Ambiguous metafield definition binding", row.fieldId);
        }
        uniqueBindings[binding].add(bindings[binding]);
      }
      resolved.set(row.fieldId, record);
    }

    if (resolved.size !== ids.length) {
      reject(
        C.UNKNOWN_FIELD,
        "Metafield definition unavailable"
      );
    }

    return resolved;
  }

  async function resolveOne({ shopId, fieldId }) {
    const records = await resolveBatch({
      shopId,
      fieldIds: [fieldId],
    });

    return records.get(fieldId);
  }

  return Object.freeze({
    resolveOne,
    resolveBatch,
  });
}

