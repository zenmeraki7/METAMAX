/**
 * METAMAX — Edit History Contract V3
 *
 * web/edit-history/history-contract.js
 *
 * Pure, server-only validation and normalization.
 * Node.js 22+ / ECMAScript modules.
 *
 * INTEGRATION:
 * - Field Engine issues canonical field identities/values.
 * - Filter Engine issues filter/execution fingerprints.
 * - Mirror Engine issues generation/coverage authority.
 * - Bulk Edit Engine issues mutation IDs, attempts and fences.
 * - History Repository enforces durable journal ordering.
 * - snapshot-service.server.js maps issued Field/Filter Engine results into
 *   these records. Application entry points must use that bridge; these pure
 *   normalizers alone do not establish field semantics or engine provenance.
 *
 * TRUST BOUNDARY:
 * Normalized records and successful assertions establish only local
 * structural consistency. They do not authorize execution or attest to
 * evidence provenance, persisted snapshots, or current worker ownership.
 * Before accepting a journal transition, the repository must independently
 * load tenant-scoped execution authorization, snapshots, evidence, and the
 * worker claim from trusted storage; verify their exact identity, binding,
 * content fingerprints, attempt and fencing epoch; and atomically enforce
 * current ownership and journal ordering with the write. Caller-supplied
 * records, hashes and claim IDs are references, never proof of authority.
 * The journal transaction must also compare each BEFORE snapshot's execution
 * fingerprint with its persisted operation, and its filter and field-resolution
 * fingerprints with the authoritative execution plan loaded server-side.
 * Validate the shared mutation/attempt ID, attempt number, execution fence,
 * claim, job/item ownership and mutation-plan fingerprint across every field
 * belonging to one execution request. Per-field consistency alone is not
 * sufficient. Browser-supplied hashes cannot establish any of these bindings.
 *
 * NEVER:
 * - Interpret a fingerprint as authorization.
 * - Interpret a caller-supplied receipt as trusted evidence.
 * - Infer Shopify mutation success from an intended value.
 * - Classify a timed-out Shopify write as FAILED_NO_WRITE.
 * - Execute Shopify mutations or undo operations here.
 */

import { createHash } from "node:crypto";

// ========================================================
// 1. VERSIONS AND LIMITS
// ========================================================

export const HISTORY_CONTRACT_VERSION = 3;
export const HISTORY_SNAPSHOT_VERSION = 3;
export const HISTORY_OBSERVATION_VERSION = 1;
export const HISTORY_ATTEMPT_VERSION = 1;
export const HISTORY_UNDO_PREFLIGHT_VERSION = 1;

export const HISTORY_LIMITS = Object.freeze({
  MAX_ID_BYTES: 512,
  MAX_FIELD_ID_BYTES: 512,
  MAX_REVISION_BYTES: 256,
  MAX_VALUE_BYTES: 32 * 1024,
  MAX_RECORD_BYTES: 128 * 1024,
  MAX_JSON_DEPTH: 32,
  MAX_JSON_NODES: 2000,
  MAX_HISTORY_PAGE_SIZE: 100,
  DEFAULT_HISTORY_PAGE_SIZE: 25,
  MAX_ATTEMPT_NUMBER: 1_000_000,
});

const CODES = {
  INVALID_INPUT: "HISTORY_INVALID_INPUT",
  LIMIT_EXCEEDED: "HISTORY_LIMIT_EXCEEDED",
  INVALID_TRANSITION: "HISTORY_INVALID_TRANSITION",
  UNSUPPORTED_VERSION: "HISTORY_UNSUPPORTED_VERSION",
  UNAUTHORIZED: "HISTORY_UNAUTHORIZED",
  IDEMPOTENCY_CONFLICT: "HISTORY_IDEMPOTENCY_CONFLICT",
  OWNERSHIP_LOST: "HISTORY_OWNERSHIP_LOST",
  EVIDENCE_REQUIRED: "HISTORY_EVIDENCE_REQUIRED",
  EVIDENCE_CONFLICT: "HISTORY_EVIDENCE_CONFLICT",
  BINDING_CONFLICT: "HISTORY_BINDING_CONFLICT",
  UNSUPPORTED_UNDO: "HISTORY_UNSUPPORTED_UNDO",
  CONFLICT: "HISTORY_CONFLICT",
};

export const HISTORY_ERROR_CODES = Object.freeze(CODES);

const ERROR_HTTP = Object.freeze({
  [CODES.INVALID_INPUT]: 400,
  [CODES.LIMIT_EXCEEDED]: 413,
  [CODES.INVALID_TRANSITION]: 409,
  [CODES.UNSUPPORTED_VERSION]: 409,
  [CODES.UNAUTHORIZED]: 403,
  [CODES.IDEMPOTENCY_CONFLICT]: 409,
  [CODES.OWNERSHIP_LOST]: 409,
  [CODES.EVIDENCE_REQUIRED]: 409,
  [CODES.EVIDENCE_CONFLICT]: 409,
  [CODES.BINDING_CONFLICT]: 409,
  [CODES.UNSUPPORTED_UNDO]: 422,
  [CODES.CONFLICT]: 409,
});

const ERROR_SET = new Set(Object.values(CODES));

export class HistoryContractError extends Error {
  constructor(code, message, options = {}) {
    if (!ERROR_SET.has(code)) {
      throw new TypeError("Unknown history error code");
    }

    super(message);

    this.name = "HistoryContractError";
    this.code = code;
    this.status = ERROR_HTTP[code];
    this.retryable = options.retryable === true;
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
  throw new HistoryContractError(code, message);
}

// ========================================================
// 2. SAFE STRUCTURAL VALIDATION
// ========================================================

const FORBIDDEN_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function utf8(value) {
  return Buffer.byteLength(value, "utf8");
}

function plainObject(value) {
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

/**
 * Reads own data descriptors without invoking getters.
 * Nonenumerable unexpected properties are rejected.
 */
function record(value, allowedKeys, name) {
  if (!plainObject(value)) {
    fail(CODES.INVALID_INPUT, `${name} must be a plain object`);
  }

  const allowed = new Set(allowedKeys);
  const output = Object.create(null);

  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      FORBIDDEN_KEYS.has(key) ||
      !allowed.has(key)
    ) {
      fail(CODES.INVALID_INPUT, `Invalid ${name} property`);
    }

    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      key,
    );

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      fail(CODES.INVALID_INPUT, `Invalid ${name} descriptor`);
    }

    output[key] = descriptor.value;
  }

  return output;
}

function has(value, key) {
  return Object.hasOwn(value, key);
}

function requiredString(value, name, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8(value) > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(CODES.INVALID_INPUT, `Invalid ${name}`);
  }

  return value;
}

export function requireHistoryId(
  value,
  name = "identifier",
  maximum = HISTORY_LIMITS.MAX_ID_BYTES,
) {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 4096
  ) {
    fail(CODES.INVALID_INPUT, "Invalid identifier budget");
  }

  return requiredString(value, name, maximum);
}

function optionalString(value, name, maximum = 512) {
  return value === null || value === undefined
    ? null
    : requiredString(value, name, maximum);
}

function fingerprint(value, name) {
  if (
    typeof value !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value)
  ) {
    fail(CODES.INVALID_INPUT, `Invalid ${name}`);
  }

  return value;
}

// Mirror execution identifiers are PostgreSQL BIGINT, not opaque strings.
// Keep exact decimal digits across JSON; neither JS Number nor a Shopify GID
// can stand in for a command/item key.
function executionId(value, name) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value) ||
      BigInt(value) > 9223372036854775807n) {
    fail(CODES.INVALID_INPUT, `Invalid ${name}: positive signed-64-bit decimal string required`);
  }
  return value;
}

function integer(value, name, min, max) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(CODES.INVALID_INPUT, `Invalid ${name}`);
  }

  return value;
}

function enumValue(value, choices, name) {
  if (!Object.values(choices).includes(value)) {
    fail(CODES.INVALID_INPUT, `Invalid ${name}`);
  }

  return value;
}

function isoTime(value, name) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    fail(CODES.INVALID_INPUT, `Invalid ${name}`);
  }

  const time = new Date(value);

  if (
    !Number.isFinite(time.getTime()) ||
    time.toISOString() !== value
  ) {
    fail(CODES.INVALID_INPUT, `Invalid ${name}`);
  }

  return value;
}

function epoch(value) {
  const encoded =
    typeof value === "bigint"
      ? value.toString()
      : value;

  if (
    typeof encoded !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(encoded)
  ) {
    fail(CODES.INVALID_INPUT, "Invalid fencing epoch");
  }

  const number = BigInt(encoded);

  if (number > 9223372036854775807n) {
    fail(CODES.INVALID_INPUT, "Fencing epoch overflow");
  }

  return number.toString();
}

// ========================================================
// 3. CANONICAL JSON
// ========================================================

/**
 * Detached, deeply immutable JSON tree.
 *
 * Rejects:
 * - Non-JSON values
 * - Cyclic/shared objects
 * - Accessors
 * - Symbols
 * - Unsafe integers
 * - Sparse/decorated arrays
 * - Unexpected prototypes
 * - Prototype-pollution keys
 *
 * Object keys are sorted; array order is preserved.
 *
 * Note: This protects structure, not field semantics.
 * Decimal, date, enum, list and metafield rules remain
 * the responsibility of METAMAX's Field Engine.
 */

export function canonicalHistoryJson(
  input,
  options = {},
) {
  const opts = record(
    options,
    ["maxDepth", "maxNodes", "maxBytes"],
    "canonical options",
  );

  const depthLimit = integer(
    opts.maxDepth ?? HISTORY_LIMITS.MAX_JSON_DEPTH,
    "maxDepth",
    1,
    HISTORY_LIMITS.MAX_JSON_DEPTH,
  );

  const nodeLimit = integer(
    opts.maxNodes ?? HISTORY_LIMITS.MAX_JSON_NODES,
    "maxNodes",
    1,
    HISTORY_LIMITS.MAX_JSON_NODES,
  );

  const byteLimit = integer(
    opts.maxBytes ?? HISTORY_LIMITS.MAX_VALUE_BYTES,
    "maxBytes",
    1,
    HISTORY_LIMITS.MAX_RECORD_BYTES,
  );

  const visited = new WeakSet();
  let nodes = 0;

  function walk(value, depth) {
    nodes++;

    if (
      depth > depthLimit ||
      nodes > nodeLimit
    ) {
      fail(CODES.LIMIT_EXCEEDED, "JSON complexity exceeded");
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
        (
          Number.isInteger(value) &&
          !Number.isSafeInteger(value)
        )
      ) {
        fail(CODES.INVALID_INPUT, "Unsafe JSON number");
      }

      return Object.is(value, -0) ? 0 : value;
    }

    if (typeof value !== "object") {
      fail(CODES.INVALID_INPUT, "Unsupported JSON value");
    }

    if (visited.has(value)) {
      fail(CODES.INVALID_INPUT, "Shared/cyclic JSON object");
    }

    visited.add(value);

    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);

      if (
        keys.length !== value.length + 1 ||
        keys.some((key) => {
          if (key === "length") return false;

          return (
            typeof key !== "string" ||
            !/^(0|[1-9]\d*)$/.test(key) ||
            Number(key) >= value.length
          );
        })
      ) {
        fail(CODES.INVALID_INPUT, "Sparse/decorated array");
      }

      const output = [];

      for (let i = 0; i < value.length; i++) {
        const descriptor =
          Object.getOwnPropertyDescriptor(
            value,
            String(i),
          );

        if (
          !descriptor ||
          !Object.hasOwn(descriptor, "value") ||
          descriptor.enumerable !== true
        ) {
          fail(CODES.INVALID_INPUT, "Invalid array element");
        }

        output.push(walk(descriptor.value, depth + 1));
      }

      return Object.freeze(output);
    }

    if (!plainObject(value)) {
      fail(CODES.INVALID_INPUT, "Unsupported object prototype");
    }

    const keys = Reflect.ownKeys(value);

    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          FORBIDDEN_KEYS.has(key),
      )
    ) {
      fail(CODES.INVALID_INPUT, "Forbidden JSON key");
    }

    const output = Object.create(null);

    for (const key of keys.sort()) {
      const descriptor =
        Object.getOwnPropertyDescriptor(value, key);

      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        fail(CODES.INVALID_INPUT, "JSON accessor forbidden");
      }

      output[key] = walk(
        descriptor.value,
        depth + 1,
      );
    }

    return Object.freeze(output);
  }

  const output = walk(input, 0);

  if (utf8(JSON.stringify(output)) > byteLimit) {
    fail(CODES.LIMIT_EXCEEDED, "JSON byte budget exceeded");
  }

  return output;
}

// ========================================================
// 4. VERSIONED FINGERPRINTS
// ========================================================

/**
 * V3 has its own canonical fingerprint domain.
 *
 * Never recalculate V1/V2 fingerprints with V3 rules.
 * Historical readers must explicitly dispatch to the
 * matching legacy implementation.
 */

export const HISTORY_FINGERPRINT_SCHEME =
  "metamax-history-sha256-v3";

export function historyFingerprint(
  value,
  domain = "history-record",
) {
  requiredString(domain, "fingerprint domain", 64);

  const normalized = canonicalHistoryJson(value, {
    maxBytes: HISTORY_LIMITS.MAX_RECORD_BYTES,
  });

  const payload = JSON.stringify([
    HISTORY_FINGERPRINT_SCHEME,
    HISTORY_CONTRACT_VERSION,
    domain,
    normalized,
  ]);

  return (
    "sha256:" +
    createHash("sha256")
      .update(payload, "utf8")
      .digest("hex")
  );
}

export function assertHistoryVersion(
  version,
  expected = HISTORY_CONTRACT_VERSION,
) {
  if (version !== expected) {
    fail(
      CODES.UNSUPPORTED_VERSION,
      "Unsupported history contract version",
    );
  }

  return true;
}

/**
 * Reader policy:
 *
 * V3: Native read/write.
 * V1/V2: Legacy reader required; no implicit migration.
 * Future versions: Explicitly unsupported.
 */
export const HISTORY_VERSION_POLICY = Object.freeze({
  writeVersion: HISTORY_CONTRACT_VERSION,
  nativeReadVersions: Object.freeze([3]),
  legacyReaderRequired: Object.freeze([1, 2]),
});

export function requireHistoryReader(version) {
  integer(version, "history version", 1, 2147483647);

  if (
    !HISTORY_VERSION_POLICY.nativeReadVersions.includes(
      version,
    )
  ) {
    fail(
      CODES.UNSUPPORTED_VERSION,
      "Record requires a version-specific history reader",
    );
  }

  return version;
}

// ========================================================
// 5. IDENTITIES AND FIELD ENGINE BINDINGS
// ========================================================

export function normalizeHistoryIdentity(input) {
  const data = record(
    input,
    [
      "shopId",
      "installationId",
      "executionJobId",
      "executionItemId",
      "mutationId",
      "resourceGid",
      "fieldId",
    ],
    "history identity",
  );

  return Object.freeze({
    shopId: requiredString(data.shopId, "shopId", 255),
    installationId: requireHistoryId(
      data.installationId,
      "installationId",
    ),
    executionJobId: executionId(
      data.executionJobId,
      "executionJobId",
    ),
    executionItemId: executionId(
      data.executionItemId,
      "executionItemId",
    ),
    mutationId: requireHistoryId(
      data.mutationId,
      "mutationId",
    ),
    resourceGid: requireHistoryId(
      data.resourceGid,
      "resourceGid",
    ),
    fieldId: requireHistoryId(
      data.fieldId,
      "fieldId",
      HISTORY_LIMITS.MAX_FIELD_ID_BYTES,
    ),
  });
}

export const HISTORY_BINDING_MODES = Object.freeze({
  MIRROR_PINNED: "MIRROR_PINNED",
  SHOPIFY_DIRECT: "SHOPIFY_DIRECT",
  EXECUTION_SNAPSHOT: "EXECUTION_SNAPSHOT",
});

/**
 * Engine fingerprints are opaque.
 * Their validity and issuance must be independently
 * established by the corresponding METAMAX services.
 *
 * MIRROR_PINNED requires full generation coordinates.
 * SHOPIFY_DIRECT has no mirror generation coordinates.
 * EXECUTION_SNAPSHOT refers to a persisted execution
 * snapshot, not to a browser-provided value.
 */

export function normalizeHistoryBinding(input) {
  const data = record(
    input,
    [
      "mode",
      "filterFingerprint",
      "executionFingerprint",
      "fieldResolutionFingerprint",
      "fieldDefinitionRevision",
      "generationId",
      "coverageRevision",
      "mappingVersion",
      "executionSnapshotId",
    ],
    "history binding",
  );

  const mode = enumValue(
    data.mode,
    HISTORY_BINDING_MODES,
    "binding mode",
  );

  const base = {
    mode,
    filterFingerprint: fingerprint(
      data.filterFingerprint,
      "filterFingerprint",
    ),
    executionFingerprint: fingerprint(
      data.executionFingerprint,
      "executionFingerprint",
    ),
    fieldResolutionFingerprint: fingerprint(
      data.fieldResolutionFingerprint,
      "fieldResolutionFingerprint",
    ),
    fieldDefinitionRevision: requireHistoryId(
      data.fieldDefinitionRevision,
      "fieldDefinitionRevision",
      HISTORY_LIMITS.MAX_REVISION_BYTES,
    ),
  };

  const mirrorCoordinates = [
    data.generationId,
    data.coverageRevision,
    data.mappingVersion,
  ];

  if (mode === HISTORY_BINDING_MODES.MIRROR_PINNED) {
    if (data.executionSnapshotId != null) {
      fail(CODES.INVALID_INPUT, "Unexpected snapshot reference");
    }

    return Object.freeze({
      ...base,
      generationId: requireHistoryId(
        data.generationId,
        "generationId",
      ),
      coverageRevision: requireHistoryId(
        data.coverageRevision,
        "coverageRevision",
      ),
      mappingVersion: requireHistoryId(
        data.mappingVersion,
        "mappingVersion",
      ),
      executionSnapshotId: null,
    });
  }

  if (mirrorCoordinates.some((value) => value != null)) {
    fail(
      CODES.BINDING_CONFLICT,
      "Mirror coordinates require MIRROR_PINNED mode",
    );
  }

  if (mode === HISTORY_BINDING_MODES.EXECUTION_SNAPSHOT) {
    return Object.freeze({
      ...base,
      generationId: null,
      coverageRevision: null,
      mappingVersion: null,
      executionSnapshotId: requireHistoryId(
        data.executionSnapshotId,
        "executionSnapshotId",
      ),
    });
  }

  if (data.executionSnapshotId != null) {
    fail(
      CODES.BINDING_CONFLICT,
      "Unexpected execution snapshot reference",
    );
  }

  return Object.freeze({
    ...base,
    generationId: null,
    coverageRevision: null,
    mappingVersion: null,
    executionSnapshotId: null,
  });
}

function identityMatches(a, b) {
  return (
    a.shopId === b.shopId &&
    a.installationId === b.installationId &&
    a.executionJobId === b.executionJobId &&
    a.executionItemId === b.executionItemId &&
    a.mutationId === b.mutationId &&
    a.resourceGid === b.resourceGid &&
    a.fieldId === b.fieldId
  );
}

function bindingMatches(a, b) {
  return (
    a.mode === b.mode &&
    a.filterFingerprint === b.filterFingerprint &&
    a.executionFingerprint === b.executionFingerprint &&
    a.fieldResolutionFingerprint ===
      b.fieldResolutionFingerprint &&
    a.fieldDefinitionRevision ===
      b.fieldDefinitionRevision &&
    a.generationId === b.generationId &&
    a.coverageRevision === b.coverageRevision &&
    a.mappingVersion === b.mappingVersion &&
    a.executionSnapshotId === b.executionSnapshotId
  );
}

// ========================================================
// 6. SNAPSHOT VALUES AND PROVENANCE
// ========================================================

export const SNAPSHOT_KINDS = Object.freeze({
  BEFORE: "BEFORE",
  OBSERVED_AFTER: "OBSERVED_AFTER",
});

export const SNAPSHOT_VALUE_KINDS = Object.freeze({
  VALUE: "VALUE",
  ABSENT: "ABSENT",
});

export const OBSERVATION_SOURCES = Object.freeze({
  SHOPIFY_GRAPHQL: "SHOPIFY_GRAPHQL",
  MIRROR_PINNED: "MIRROR_PINNED",
  EXECUTION_SNAPSHOT: "EXECUTION_SNAPSHOT",
});

/**
 * Observation evidence records provenance.
 *
 * sourceRevision may be null when Shopify provides
 * no authoritative revision for this field/resource.
 *
 * Receipt IDs and hashes are references only.
 * The verification service must independently load and
 * authenticate the underlying observation evidence.
 */

export function normalizeObservationEvidence(input) {
  const data = record(
    input,
    [
      "observationId",
      "source",
      "observedAt",
      "resourceGid",
      "fieldId",
      "sourceRevision",
      "receiptId",
      "receiptFingerprint",
    ],
    "observation evidence",
  );

  const core = {
    observationVersion: HISTORY_OBSERVATION_VERSION,
    observationId: requireHistoryId(
      data.observationId,
      "observationId",
    ),
    source: enumValue(
      data.source,
      OBSERVATION_SOURCES,
      "observation source",
    ),
    observedAt: isoTime(data.observedAt, "observedAt"),
    resourceGid: requireHistoryId(
      data.resourceGid,
      "resourceGid",
    ),
    fieldId: requireHistoryId(
      data.fieldId,
      "fieldId",
      HISTORY_LIMITS.MAX_FIELD_ID_BYTES,
    ),
    sourceRevision: optionalString(
      data.sourceRevision,
      "sourceRevision",
      HISTORY_LIMITS.MAX_REVISION_BYTES,
    ),
    receiptId: requireHistoryId(
      data.receiptId,
      "receiptId",
    ),
    receiptFingerprint: fingerprint(
      data.receiptFingerprint,
      "receiptFingerprint",
    ),
  };

  return Object.freeze({
    ...core,
    evidenceFingerprint: historyFingerprint(
      core,
      "observation-evidence-v3",
    ),
  });
}

function normalizeValuePair(data, kindKey, valueKey) {
  const valueKind = enumValue(
    data[kindKey],
    SNAPSHOT_VALUE_KINDS,
    kindKey,
  );

  const present = has(data, valueKey);

  if (
    (valueKind === "VALUE" && !present) ||
    (valueKind === "ABSENT" && present)
  ) {
    fail(
      CODES.INVALID_INPUT,
      "Value presence does not match value kind",
    );
  }

  return {
    valueKind,
    ...(present
      ? {
          value: canonicalHistoryJson(data[valueKey]),
        }
      : {}),
  };
}

export function normalizeHistorySnapshot(input) {
  const data = record(
    input,
    [
      "identity",
      "binding",
      "kind",
      "valueKind",
      "value",
      "observation",
    ],
    "history snapshot",
  );

  const identity = normalizeHistoryIdentity(data.identity);
  const binding = normalizeHistoryBinding(data.binding);

  const observation = normalizeObservationEvidence(
    data.observation,
  );

  const kind = enumValue(
    data.kind,
    SNAPSHOT_KINDS,
    "snapshot kind",
  );

  if (
    observation.resourceGid !== identity.resourceGid ||
    observation.fieldId !== identity.fieldId
  ) {
    fail(
      CODES.EVIDENCE_CONFLICT,
      "Observation does not identify snapshot field",
    );
  }

  const expectedSource = {
    MIRROR_PINNED: "MIRROR_PINNED",
    SHOPIFY_DIRECT: "SHOPIFY_GRAPHQL",
    EXECUTION_SNAPSHOT: "EXECUTION_SNAPSHOT",
  }[binding.mode];

  if (observation.source !== expectedSource && !(kind === 'OBSERVED_AFTER' && observation.source === 'SHOPIFY_GRAPHQL')) {
    fail(
      CODES.EVIDENCE_CONFLICT,
      "Observation source does not match binding",
    );
  }

  const value = normalizeValuePair(
    data,
    "valueKind",
    "value",
  );

  const core = canonicalHistoryJson(
    {
      snapshotVersion: HISTORY_SNAPSHOT_VERSION,
      identity,
      binding,
      kind,
      ...value,
    },
    {
      maxBytes: HISTORY_LIMITS.MAX_RECORD_BYTES,
    },
  );

  const snapshotFingerprint = historyFingerprint(
    core,
    "field-snapshot-v3",
  );

  const linked = canonicalHistoryJson(
    {
      snapshotFingerprint,
      observationFingerprint:
        observation.evidenceFingerprint,
    },
    {
      maxBytes: HISTORY_LIMITS.MAX_RECORD_BYTES,
    },
  );

  return Object.freeze({
    ...core,
    fingerprint: snapshotFingerprint,
    observation,
    evidenceBindingFingerprint: historyFingerprint(
      linked,
      "snapshot-observation-link-v3",
    ),
  });
}

// ========================================================
// 7. IMMUTABLE MUTATION INTENT
// ========================================================

export function normalizeMutationIntent(input) {
  const data = record(
    input,
    [
      "identity",
      "binding",
      "beforeSnapshotFingerprint",
      "intendedValueKind",
      "intendedValue",
      "mutationPlanFingerprint",
    ],
    "mutation intent",
  );

  const value = normalizeValuePair(
    data,
    "intendedValueKind",
    "intendedValue",
  );

  const core = canonicalHistoryJson(
    {
      contractVersion: HISTORY_CONTRACT_VERSION,
      identity: normalizeHistoryIdentity(data.identity),
      binding: normalizeHistoryBinding(data.binding),
      beforeSnapshotFingerprint: fingerprint(
        data.beforeSnapshotFingerprint,
        "beforeSnapshotFingerprint",
      ),
      mutationPlanFingerprint: fingerprint(
        data.mutationPlanFingerprint,
        "mutationPlanFingerprint",
      ),
      intendedValueKind: value.valueKind,
      ...(has(value, "value")
        ? { intendedValue: value.value }
        : {}),
    },
    {
      maxBytes: HISTORY_LIMITS.MAX_RECORD_BYTES,
    },
  );

  return Object.freeze({
    ...core,
    fingerprint: historyFingerprint(
      core,
      "mutation-intent-v3",
    ),
  });
}

/**
 * This pure helper establishes local consistency.
 *
 * PostgreSQL MUST independently load the persisted
 * BEFORE snapshot, enforce tenant-scoped relationships
 * and verify the referenced fingerprint transactionally.
 */
export function assertSnapshotIntentConsistency(input) {
  const { beforeSnapshot, intent } = record(input, ["beforeSnapshot", "intent"], "snapshot intent pair");
  if (!beforeSnapshot || !intent) fail(CODES.BINDING_CONFLICT, "Snapshot and intent are required");
  const before = record(beforeSnapshot, ["snapshotVersion", "identity", "binding", "kind", "valueKind", "value",
    "fingerprint", "observation", "evidenceBindingFingerprint"], "history snapshot");
  const mutation = record(intent, ["contractVersion", "identity", "binding", "beforeSnapshotFingerprint",
    "mutationPlanFingerprint", "intendedValueKind", "intendedValue", "fingerprint"], "mutation intent");

  if (
    !before ||
    !mutation ||
    before.snapshotVersion !== HISTORY_SNAPSHOT_VERSION ||
    mutation.contractVersion !== HISTORY_CONTRACT_VERSION
  ) {
    fail(
      CODES.BINDING_CONFLICT,
      "Invalid snapshot/intent contract versions",
    );
  }

  const observation = record(before.observation, ["observationVersion", "observationId", "source", "observedAt", "resourceGid",
    "fieldId", "sourceRevision", "receiptId", "receiptFingerprint", "evidenceFingerprint"], "observation evidence");
  const rebuilt = normalizeHistorySnapshot({ identity: before.identity, binding: before.binding, kind: before.kind,
    valueKind: before.valueKind, ...(has(before, "value") ? { value: before.value } : {}),
    observation: Object.fromEntries(["observationId", "source", "observedAt", "resourceGid", "fieldId", "sourceRevision", "receiptId", "receiptFingerprint"]
      .filter(key => has(observation, key)).map(key => [key, observation[key]])) });
  const rebuiltIntent = normalizeMutationIntent({ identity: mutation.identity, binding: mutation.binding,
    beforeSnapshotFingerprint: mutation.beforeSnapshotFingerprint, mutationPlanFingerprint: mutation.mutationPlanFingerprint,
    intendedValueKind: mutation.intendedValueKind, ...(has(mutation, "intendedValue") ? { intendedValue: mutation.intendedValue } : {}) });
  if (observation.observationVersion !== HISTORY_OBSERVATION_VERSION ||
      observation.evidenceFingerprint !== rebuilt.observation.evidenceFingerprint ||
      before.fingerprint !== rebuilt.fingerprint ||
      before.evidenceBindingFingerprint !== rebuilt.evidenceBindingFingerprint ||
      mutation.fingerprint !== rebuiltIntent.fingerprint) {
    fail(CODES.EVIDENCE_CONFLICT, "Snapshot observation binding or intent fingerprint is invalid");
  }

  const normalizedIdentity = normalizeHistoryIdentity(
    before.identity,
  );

  const intentIdentity = normalizeHistoryIdentity(
    mutation.identity,
  );

  const normalizedBinding = normalizeHistoryBinding(
    before.binding,
  );

  const intentBinding = normalizeHistoryBinding(
    mutation.binding,
  );

  if (
    before.kind !== SNAPSHOT_KINDS.BEFORE ||
    !identityMatches(normalizedIdentity, intentIdentity) ||
    !bindingMatches(normalizedBinding, intentBinding) ||
    before.fingerprint !== mutation.beforeSnapshotFingerprint
  ) {
    fail(
      CODES.BINDING_CONFLICT,
      "Before snapshot and mutation intent do not match",
    );
  }

  // Recomputed fingerprints establish local consistency only; they do not
  // authenticate a snapshot, receipt, plan or issuer.
  return true;
}

// ========================================================
// 8. EXECUTION ATTEMPT AND FENCING
// ========================================================

/**
 * A logical mutation may have multiple attempts.
 * A retry is NOT automatically permitted because the
 * previous attempt's lease expired.
 *
 * The Execution Engine must verify durable attempt
 * ownership and unknown-outcome recovery before retry.
 *
 * Lease tokens are deliberately excluded from this
 * serializable evidence contract to avoid exposing secrets.
 */

export function normalizeMutationAttempt(input) {
  const data = record(
    input,
    [
      "identity",
      "attemptId",
      "attemptNumber",
      "fenceEpoch",
      "executionClaimId",
      "startedAt",
    ],
    "mutation attempt",
  );

  const core = canonicalHistoryJson({
    attemptVersion: HISTORY_ATTEMPT_VERSION,
    identity: normalizeHistoryIdentity(data.identity),
    attemptId: requireHistoryId(
      data.attemptId,
      "attemptId",
    ),
    attemptNumber: integer(
      data.attemptNumber,
      "attemptNumber",
      1,
      HISTORY_LIMITS.MAX_ATTEMPT_NUMBER,
    ),
    fenceEpoch: epoch(data.fenceEpoch),
    executionClaimId: requireHistoryId(
      data.executionClaimId,
      "executionClaimId",
    ),
    startedAt: isoTime(data.startedAt, "startedAt"),
  });

  return Object.freeze({
    ...core,
    fingerprint: historyFingerprint(
      core,
      "mutation-attempt-v3",
    ),
  });
}

// ========================================================
// 9. EVIDENCE-AWARE MUTATION STATES
// ========================================================

export const MUTATION_STATES = Object.freeze({
  PREPARED: "PREPARED",
  DISPATCHING: "DISPATCHING",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  VERIFIED: "VERIFIED",
  FAILED_NO_WRITE: "FAILED_NO_WRITE",
  CONFLICT: "CONFLICT",
});

export const VERIFICATION_STATES = Object.freeze({
  NOT_CHECKED: "NOT_CHECKED",
  PENDING: "PENDING",
  MATCHED: "MATCHED",
  MISMATCHED: "MISMATCHED",
  INCONCLUSIVE: "INCONCLUSIVE",
});

export const OUTCOME_EVIDENCE_KINDS = Object.freeze({
  NONE: "NONE",
  AMBIGUOUS: "AMBIGUOUS",
  SHOPIFY_ACKNOWLEDGEMENT: "SHOPIFY_ACKNOWLEDGEMENT",
  AUTHORITATIVE_NO_WRITE: "AUTHORITATIVE_NO_WRITE",
  VERIFIED_OBSERVATION: "VERIFIED_OBSERVATION",
  CONFLICT_OBSERVATION: "CONFLICT_OBSERVATION",
});

export const UNDO_ELIGIBILITY = Object.freeze({
  ELIGIBLE: "ELIGIBLE",
  CONFLICT: "CONFLICT",
  UNVERIFIED: "UNVERIFIED",
  UNSUPPORTED: "UNSUPPORTED",
  EXPIRED: "EXPIRED",
  ALREADY_UNDONE: "ALREADY_UNDONE",
});

const TRANSITIONS = Object.freeze({
  PREPARED: Object.freeze([
    MUTATION_STATES.DISPATCHING,
    MUTATION_STATES.FAILED_NO_WRITE,
  ]),

  DISPATCHING: Object.freeze([
    MUTATION_STATES.OUTCOME_UNKNOWN,
    MUTATION_STATES.ACKNOWLEDGED,
    MUTATION_STATES.FAILED_NO_WRITE,
  ]),

  OUTCOME_UNKNOWN: Object.freeze([
    MUTATION_STATES.ACKNOWLEDGED,
    MUTATION_STATES.VERIFIED,
    MUTATION_STATES.FAILED_NO_WRITE,
    MUTATION_STATES.CONFLICT,
  ]),

  ACKNOWLEDGED: Object.freeze([
    MUTATION_STATES.OUTCOME_UNKNOWN,
    MUTATION_STATES.VERIFIED,
    MUTATION_STATES.CONFLICT,
  ]),

  VERIFIED: Object.freeze([]),
  FAILED_NO_WRITE: Object.freeze([]),
  CONFLICT: Object.freeze([]),
});

const EVIDENCE_REQUIREMENTS = Object.freeze({
  OUTCOME_UNKNOWN: Object.freeze([
    OUTCOME_EVIDENCE_KINDS.AMBIGUOUS,
  ]),
  ACKNOWLEDGED: Object.freeze([
    OUTCOME_EVIDENCE_KINDS.SHOPIFY_ACKNOWLEDGEMENT,
  ]),
  VERIFIED: Object.freeze([
    OUTCOME_EVIDENCE_KINDS.VERIFIED_OBSERVATION,
  ]),
  FAILED_NO_WRITE: Object.freeze([
    OUTCOME_EVIDENCE_KINDS.AUTHORITATIVE_NO_WRITE,
  ]),
  CONFLICT: Object.freeze([
    OUTCOME_EVIDENCE_KINDS.CONFLICT_OBSERVATION,
  ]),
});

export function canTransitionMutation(from, to) {
  return (
    typeof from === "string" && typeof to === "string" &&
    Object.hasOwn(TRANSITIONS, from) &&
    TRANSITIONS[from].includes(to)
  );
}

/**
 * Evidence is mandatory for post-dispatch classifications.
 *
 * Evidence kind validation alone cannot establish proof.
 * The History Repository must verify:
 * - Durable evidence record
 * - Trusted evidence issuer
 * - Exact execution and mutation identity
 * - Worker fence / reconciliation authority
 * - Evidence completeness
 *
 * A timeout is never AUTHORITATIVE_NO_WRITE.
 */
export function assertMutationTransition(
  from,
  to,
  options = {},
) {
  if (!canTransitionMutation(from, to)) {
    fail(
      CODES.INVALID_TRANSITION,
      typeof from === "string" && typeof to === "string"
        ? `Invalid mutation transition: ${from} -> ${to}` : "Invalid mutation transition",
    );
  }

  const data = record(options, ["evidenceKind"], "transition evidence");
  const evidenceKind = data.evidenceKind ?? null;
  if (evidenceKind !== null) enumValue(evidenceKind, OUTCOME_EVIDENCE_KINDS, "evidence kind");

  const required = EVIDENCE_REQUIREMENTS[to];

  if (
    required &&
    !required.includes(evidenceKind)
  ) {
    fail(
      CODES.EVIDENCE_REQUIRED,
      `Transition to ${to} requires suitable evidence`,
    );
  }

  return true;
}

// ========================================================
// 10. APPEND-ONLY CORRECTION CONTRACT
// ========================================================

/**
 * Terminal history must not be silently rewritten.
 *
 * A later contradictory observation is attached as a
 * correction event. The repository determines whether
 * the event supersedes a previous classification.
 */

export function normalizeHistoryCorrection(input) {
  const data = record(
    input,
    [
      "identity",
      "previousEventFingerprint",
      "newEvidenceFingerprint",
      "reasonCode",
      "recordedAt",
    ],
    "history correction",
  );

  const core = canonicalHistoryJson({
    contractVersion: HISTORY_CONTRACT_VERSION,
    identity: normalizeHistoryIdentity(data.identity),
    previousEventFingerprint: fingerprint(
      data.previousEventFingerprint,
      "previousEventFingerprint",
    ),
    newEvidenceFingerprint: fingerprint(
      data.newEvidenceFingerprint,
      "newEvidenceFingerprint",
    ),
    reasonCode: requireHistoryId(
      data.reasonCode,
      "reasonCode",
      128,
    ),
    recordedAt: isoTime(data.recordedAt, "recordedAt"),
  });

  return Object.freeze({
    ...core,
    fingerprint: historyFingerprint(
      core,
      "history-correction-v3",
    ),
  });
}

// ========================================================
// 11. UNDO PREFLIGHT CONTRACT
// ========================================================

export const UNDO_CONFLICT_POLICIES = Object.freeze({
  ABORT_ON_CONFLICT: "ABORT_ON_CONFLICT",
  SKIP_CONFLICTED: "SKIP_CONFLICTED",
});

/**
 * A successful preflight is NOT permission to write.
 *
 * The executor must:
 * - Verify the current Shopify resource again.
 * - Apply its supported concurrency protections.
 * - Reject unsupported inverse operations.
 * - Preserve resource-family ordering.
 * - Record the undo as a new durable mutation.
 *
 * There is deliberately no FORCE_OVERWRITE policy here.
 */

export function normalizeUndoPreflight(input) {
  const data = record(
    input,
    [
      "identity",
      "originalMutationFingerprint",
      "beforeSnapshotFingerprint",
      "verifiedAfterSnapshotFingerprint",
      "currentObservationFingerprint",
      "fieldDefinitionRevision",
      "inversePlanFingerprint",
      "conflictPolicy",
      "checkedAt",
    ],
    "undo preflight",
  );

  const core = canonicalHistoryJson({
    preflightVersion: HISTORY_UNDO_PREFLIGHT_VERSION,

    identity: normalizeHistoryIdentity(data.identity),

    originalMutationFingerprint: fingerprint(
      data.originalMutationFingerprint,
      "originalMutationFingerprint",
    ),

    beforeSnapshotFingerprint: fingerprint(
      data.beforeSnapshotFingerprint,
      "beforeSnapshotFingerprint",
    ),

    verifiedAfterSnapshotFingerprint: fingerprint(
      data.verifiedAfterSnapshotFingerprint,
      "verifiedAfterSnapshotFingerprint",
    ),

    currentObservationFingerprint: fingerprint(
      data.currentObservationFingerprint,
      "currentObservationFingerprint",
    ),

    fieldDefinitionRevision: requireHistoryId(
      data.fieldDefinitionRevision,
      "fieldDefinitionRevision",
      HISTORY_LIMITS.MAX_REVISION_BYTES,
    ),

    inversePlanFingerprint: fingerprint(
      data.inversePlanFingerprint,
      "inversePlanFingerprint",
    ),

    conflictPolicy: enumValue(
      data.conflictPolicy,
      UNDO_CONFLICT_POLICIES,
      "undo conflict policy",
    ),

    checkedAt: isoTime(data.checkedAt, "checkedAt"),
  });

  return Object.freeze({
    ...core,
    fingerprint: historyFingerprint(
      core,
      "undo-preflight-v3",
    ),
  });
}

// ========================================================
// 12. HISTORY PAGINATION
// ========================================================

export function normalizeHistoryPageSize(
  value = HISTORY_LIMITS.DEFAULT_HISTORY_PAGE_SIZE,
) {
  return integer(
    value,
    "history page size",
    1,
    HISTORY_LIMITS.MAX_HISTORY_PAGE_SIZE,
  );
}
