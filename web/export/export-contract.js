/**
 * METAMAX Export Engine — pure request/lifecycle contract (v2).
 *
 * Structural validation is NOT Field Engine authorization or
 * Filter Engine semantic validation.
 *
 * No I/O, DB, Redis, Shopify calls or implicit trust.
 */

import { createHash } from "node:crypto";

export const EXPORT_CONTRACT_VERSION = 2;
export const EXPORT_MANIFEST_VERSION = 1;

export const EXPORT_FORMATS = Object.freeze({
  CSV: "CSV",
  JSONL: "JSONL",
  XLSX: "XLSX",
});

export const EXPORT_STATES = Object.freeze({
  PENDING: "PENDING",
  VALIDATING: "VALIDATING",
  WAITING_FOR_CAPACITY: "WAITING_FOR_CAPACITY",
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  RETRY_WAIT: "RETRY_WAIT",
  FINALIZING: "FINALIZING",
  RECOVERING: "RECOVERING",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  COMPLETED: "COMPLETED",
  CANCELLING: "CANCELLING",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
});

export const EXPORT_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: "EXPORT_INVALID_REQUEST",
  UNSUPPORTED_FORMAT: "EXPORT_UNSUPPORTED_FORMAT",
  TOO_MANY_FIELDS: "EXPORT_TOO_MANY_FIELDS",
  INVALID_STATE_TRANSITION: "EXPORT_INVALID_STATE_TRANSITION",
  MISSING_COVERAGE: "EXPORT_MISSING_COVERAGE",
  UNAUTHORIZED: "EXPORT_UNAUTHORIZED",
  SNAPSHOT_EXPIRED: "EXPORT_SNAPSHOT_EXPIRED",
  TOO_LARGE: "EXPORT_TOO_LARGE",
  STORAGE_UNAVAILABLE: "EXPORT_STORAGE_UNAVAILABLE",
  EXECUTION_FAILED: "EXPORT_EXECUTION_FAILED",
  IDEMPOTENCY_CONFLICT: "EXPORT_IDEMPOTENCY_CONFLICT",
  RATE_LIMITED: "EXPORT_RATE_LIMITED",
  CAPACITY_EXCEEDED: "EXPORT_CAPACITY_EXCEEDED",
  LEASE_LOST: "EXPORT_LEASE_LOST",
  CHECKPOINT_CONFLICT: "EXPORT_CHECKPOINT_CONFLICT",
  SCHEMA_DRIFT: "EXPORT_SCHEMA_DRIFT",
  ARTIFACT_INTEGRITY_FAILED: "EXPORT_ARTIFACT_INTEGRITY_FAILED",
});

export const EXPORT_LIMITS = Object.freeze({
  MAX_FIELDS: 150,
  MAX_FIELD_ID_BYTES: 256,
  MAX_REQUEST_BYTES: 128 * 1024,

  MAX_FILTER_NODES: 1000,
  MAX_FILTER_DEPTH: 32,
  MAX_FILTER_BYTES: 96 * 1024,

  MIN_BATCH_SIZE: 100,
  DEFAULT_BATCH_SIZE: 1000,
  MAX_BATCH_SIZE: 5000,

  MAX_CSV_JSONL_ROWS: 5_000_000,

  MAX_XLSX_ROWS_PER_SHEET: 1_048_575,
  MAX_XLSX_COLUMNS: 16_384,

  MAX_OUTPUT_BYTES: 2 * 1024 ** 3,
  // Stored intermediate objects may expand before format-specific packaging.
  MAX_INTERMEDIATE_BYTES: 8 * 1024 ** 3,

  DEFAULT_ARTIFACT_RETENTION_MS: 7 * 86400_000,
  MAX_ARTIFACT_RETENTION_MS: 30 * 86400_000,

  MAX_ATTEMPTS: 5,
  MAX_IDEMPOTENCY_KEY_BYTES: 128,
});

const STATES = new Set(Object.values(EXPORT_STATES));
const FORMATS = new Set(Object.values(EXPORT_FORMATS));

const REQUEST_KEYS = new Set([
  "format",
  "fieldIds",
  "filter",
  "batchSize",
  "includeHeader",
  "fileName",
]);

const PROHIBITED_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const TRANSITIONS = Object.freeze({
  PENDING: [
    "VALIDATING",
    "CANCELLING",
    "FAILED",
  ],

  VALIDATING: [
    "WAITING_FOR_CAPACITY",
    "QUEUED",
    "CANCELLING",
    "FAILED",
  ],

  WAITING_FOR_CAPACITY: [
    "QUEUED",
    "CANCELLING",
    "FAILED",
  ],

  QUEUED: [
    "RUNNING",
    "FINALIZING",
    "RETRY_WAIT",
    "CANCELLING",
    "FAILED",
  ],

  RUNNING: [
    "RECOVERING",
    "FINALIZING",
    "RETRY_WAIT",
    "CANCELLING",
    "FAILED",
  ],

  FINALIZING: [
    "RECOVERING",
    "COMPLETED",
    "RETRY_WAIT",
    "CANCELLING",
    "FAILED",
  ],

  RETRY_WAIT: [
    "RECOVERING",
    "QUEUED",
    "CANCELLING",
    "FAILED",
  ],

  RECOVERING: ["RETRY_WAIT", "CANCELLING", "FAILED", "REVIEW_REQUIRED"],
  REVIEW_REQUIRED: ["CANCELLING", "FAILED"],

  CANCELLING: [
    "CANCELLED",
    "FAILED",
  ],

  COMPLETED: ["EXPIRED"],

  CANCELLED: [],
  FAILED: [],
  EXPIRED: [],
});

for (const transitions of Object.values(TRANSITIONS)) {
  Object.freeze(transitions);
}

const ERROR_HTTP = Object.freeze({
  [EXPORT_ERROR_CODES.INVALID_REQUEST]: 400,
  [EXPORT_ERROR_CODES.UNSUPPORTED_FORMAT]: 400,
  [EXPORT_ERROR_CODES.TOO_MANY_FIELDS]: 400,
  [EXPORT_ERROR_CODES.TOO_LARGE]: 413,

  [EXPORT_ERROR_CODES.INVALID_STATE_TRANSITION]: 409,
  [EXPORT_ERROR_CODES.IDEMPOTENCY_CONFLICT]: 409,

  [EXPORT_ERROR_CODES.UNAUTHORIZED]: 403,
  [EXPORT_ERROR_CODES.RATE_LIMITED]: 429,
  [EXPORT_ERROR_CODES.CAPACITY_EXCEEDED]: 429,

  [EXPORT_ERROR_CODES.MISSING_COVERAGE]: 409,
  [EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED]: 409,
  [EXPORT_ERROR_CODES.SCHEMA_DRIFT]: 409,

  [EXPORT_ERROR_CODES.LEASE_LOST]: 409,
  [EXPORT_ERROR_CODES.CHECKPOINT_CONFLICT]: 409,

  [EXPORT_ERROR_CODES.STORAGE_UNAVAILABLE]: 503,
  [EXPORT_ERROR_CODES.EXECUTION_FAILED]: 500,
  [EXPORT_ERROR_CODES.ARTIFACT_INTEGRITY_FAILED]: 500,
});

export class ExportContractError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    if (!Object.values(EXPORT_ERROR_CODES).includes(code)) {
      throw new TypeError("Unknown export error code");
    }

    super(message);

    this.name = "ExportContractError";
    this.code = code;
    this.status = ERROR_HTTP[code];
    this.retryable = retryable;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
      },
    };
  }
}

function fail(code, message) {
  throw new ExportContractError(code, message);
}

function record(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}

function ownDataEntries(value) {
  if (Object.getOwnPropertySymbols(value).length) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Symbol keys are not permitted",
    );
  }

  const out = [];

  for (const key of Object.keys(value)) {
    if (PROHIBITED_KEYS.has(key)) {
      fail(
        EXPORT_ERROR_CODES.INVALID_REQUEST,
        "Prohibited object key",
      );
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(value, key);

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      fail(
        EXPORT_ERROR_CODES.INVALID_REQUEST,
        "Accessor properties are not permitted",
      );
    }

    out.push([key, descriptor.value]);
  }

  return out;
}

function bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function requiredString(value, label, maxBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    bytes(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      `Invalid ${label}`,
    );
  }

  return value;
}

function fields(input) {
  if (!Array.isArray(input) || input.length === 0) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "At least one field ID is required",
    );
  }

  if (input.length > EXPORT_LIMITS.MAX_FIELDS) {
    fail(
      EXPORT_ERROR_CODES.TOO_MANY_FIELDS,
      "Too many fields",
    );
  }

  const ids = input.map((id) =>
    requiredString(
      id,
      "field ID",
      EXPORT_LIMITS.MAX_FIELD_ID_BYTES,
    ),
  );

  if (new Set(ids).size !== ids.length) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Duplicate field IDs",
    );
  }

  return Object.freeze(ids);
}

function filename(value) {
  if (value === undefined) {
    return "metamax-export";
  }

  requiredString(value, "fileName", 120);

  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value) ||
    value.endsWith(".")
  ) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Invalid filename stem",
    );
  }

  return value;
}

/**
 * Produce a detached canonical JSON tree.
 *
 * Guarantees:
 * - Plain JSON-compatible values only
 * - Sorted object keys
 * - Original array ordering
 * - Rejection of cyclic/shared references
 * - Rejection of accessor properties
 * - Rejection of dangerous prototype keys
 * - Recursive immutability
 * - Bounded depth, nodes and bytes
 *
 * This does NOT perform Filter AST semantic validation.
 */
export function canonicalizeJson(
  input,
  {
    maxDepth = EXPORT_LIMITS.MAX_FILTER_DEPTH,
    maxNodes = EXPORT_LIMITS.MAX_FILTER_NODES,
    maxBytes = EXPORT_LIMITS.MAX_FILTER_BYTES,
  } = {},
) {
  const seen = new WeakSet();
  let nodes = 0;

  function visit(value, depth) {
    if (++nodes > maxNodes || depth > maxDepth) {
      fail(
        EXPORT_ERROR_CODES.TOO_LARGE,
        "JSON tree exceeds depth/node limit",
      );
    }

    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return value;
    }

    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        (!Number.isSafeInteger(value) &&
          Number.isInteger(value))
      ) {
        fail(
          EXPORT_ERROR_CODES.INVALID_REQUEST,
          "Unsafe numeric JSON value",
        );
      }

      return value;
    }

    if (typeof value !== "object") {
      fail(
        EXPORT_ERROR_CODES.INVALID_REQUEST,
        "Non-JSON value",
      );
    }

    if (seen.has(value)) {
      fail(
        EXPORT_ERROR_CODES.INVALID_REQUEST,
        "Shared/cyclic objects are not permitted",
      );
    }

    seen.add(value);

    if (Array.isArray(value)) {
      if (
        Object.getOwnPropertySymbols(value).length ||
        Object.keys(value).length !== value.length
      ) {
        fail(
          EXPORT_ERROR_CODES.INVALID_REQUEST,
          "Sparse or decorated arrays not permitted",
        );
      }

      const result = Array.from(
        { length: value.length },
        (_, i) => {
          const descriptor =
            Object.getOwnPropertyDescriptor(
              value,
              String(i),
            );

          if (
            !descriptor ||
            !Object.hasOwn(descriptor, "value")
          ) {
            fail(
              EXPORT_ERROR_CODES.INVALID_REQUEST,
              "Accessor arrays not permitted",
            );
          }

          return visit(descriptor.value, depth + 1);
        },
      );

      return Object.freeze(result);
    }

    if (!record(value)) {
      fail(
        EXPORT_ERROR_CODES.INVALID_REQUEST,
        "Non-plain object",
      );
    }

    const entries = ownDataEntries(value).sort(
      ([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
    );

    const result = Object.create(null);

    for (const [key, val] of entries) {
      result[key] = visit(val, depth + 1);
    }

    return Object.freeze(result);
  }

  const canonical = visit(input, 0);

  if (
    bytes(JSON.stringify(canonical)) > maxBytes
  ) {
    fail(
      EXPORT_ERROR_CODES.TOO_LARGE,
      "JSON bytes exceed limit",
    );
  }

  return canonical;
}

function stableJson(value) {
  // Only pass canonicalized values.
  return JSON.stringify(value);
}

/**
 * Structural request fingerprint.
 *
 * This is NOT the trusted execution-manifest fingerprint.
 */
export function exportRequestFingerprint(request) {
  const canonical = normalizeExportRequest(request);

  const scope = {
    contractVersion: EXPORT_CONTRACT_VERSION,
    request: canonical,
  };

  return `sha256:${
    createHash("sha256")
      .update(stableJson(scope))
      .digest("hex")
  }`;
}

export function normalizeIdempotencyKey(value) {
  requiredString(
    value,
    "idempotencyKey",
    EXPORT_LIMITS.MAX_IDEMPOTENCY_KEY_BYTES,
  );

  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)
  ) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Invalid idempotency key",
    );
  }

  return value;
}

/**
 * Validate and normalize the export request.
 *
 * Field authorization, Filter AST semantics and
 * published-generation checks remain external
 * responsibilities.
 */
export function normalizeExportRequest(input) {
  if (!record(input)) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Export request must be an object",
    );
  }

  const entries = ownDataEntries(input);

  for (const [key] of entries) {
    if (!REQUEST_KEYS.has(key)) {
      fail(
        EXPORT_ERROR_CODES.INVALID_REQUEST,
        `Unknown export option: ${key}`,
      );
    }
  }

  const values = Object.fromEntries(entries);

  const format =
    values.format === undefined
      ? EXPORT_FORMATS.CSV
      : values.format;

  if (!FORMATS.has(format)) {
    fail(
      EXPORT_ERROR_CODES.UNSUPPORTED_FORMAT,
      "Unsupported export format",
    );
  }

  const fieldIds = fields(values.fieldIds);

  const batchSize =
    values.batchSize === undefined
      ? EXPORT_LIMITS.DEFAULT_BATCH_SIZE
      : values.batchSize;

  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < EXPORT_LIMITS.MIN_BATCH_SIZE ||
    batchSize > EXPORT_LIMITS.MAX_BATCH_SIZE
  ) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Invalid batch size",
    );
  }

  const includeHeader =
    values.includeHeader === undefined
      ? true
      : values.includeHeader;

  if (typeof includeHeader !== "boolean") {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "includeHeader must be boolean",
    );
  }

  if (
    values.filter !== undefined &&
    values.filter !== null &&
    !record(values.filter)
  ) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Filter must be an object",
    );
  }

  const filter =
    values.filter == null
      ? null
      : canonicalizeJson(values.filter);

  const output = Object.freeze({
    format,
    fieldIds,
    filter,
    batchSize,
    includeHeader,
    fileName: filename(values.fileName),
  });

  if (
    bytes(stableJson(output)) >
    EXPORT_LIMITS.MAX_REQUEST_BYTES
  ) {
    fail(
      EXPORT_ERROR_CODES.TOO_LARGE,
      "Export request too large",
    );
  }

  return output;
}

export function assertExportState(state) {
  if (!STATES.has(state)) {
    fail(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Unknown export state",
    );
  }

  return state;
}

export function canTransitionExport(
  fromState,
  toState,
) {
  assertExportState(fromState);
  assertExportState(toState);

  return TRANSITIONS[fromState].includes(toState);
}

export function assertExportTransition(
  fromState,
  toState,
) {
  if (
    !canTransitionExport(fromState, toState)
  ) {
    fail(
      EXPORT_ERROR_CODES.INVALID_STATE_TRANSITION,
      `Invalid export transition ${fromState} -> ${toState}`,
    );
  }

  return true;
}

export function maxExportRows(format) {
  if (!FORMATS.has(format)) {
    fail(
      EXPORT_ERROR_CODES.UNSUPPORTED_FORMAT,
      "Unsupported format",
    );
  }

  return format === EXPORT_FORMATS.XLSX
    ? EXPORT_LIMITS.MAX_XLSX_ROWS_PER_SHEET
    : EXPORT_LIMITS.MAX_CSV_JSONL_ROWS;
}

export function exportMimeType(format) {
  switch (format) {
    case "CSV":
      return "text/csv; charset=utf-8";

    case "JSONL":
      return "application/x-ndjson";

    case "XLSX":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    default:
      fail(
        EXPORT_ERROR_CODES.UNSUPPORTED_FORMAT,
        "Unsupported format",
      );
  }
}

export function exportExtension(format) {
  switch (format) {
    case "CSV":
      return ".csv";

    case "JSONL":
      return ".jsonl";

    case "XLSX":
      return ".xlsx";

    default:
      fail(
        EXPORT_ERROR_CODES.UNSUPPORTED_FORMAT,
        "Unsupported format",
      );
  }
}

