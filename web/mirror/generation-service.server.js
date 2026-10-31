/**
 * METAMAX — Hardened Mirror Generation Service V2
 *
 * Server-only lifecycle orchestration.
 *
 * TRUST BOUNDARY
 * --------------
 * The caller supplies an opaque trusted context.
 *
 * authorityProvider.authorize({ action, context })
 * resolves server-side authority and returns:
 *
 * {
 *   shopId,
 *   publisherFence?,  // publish only
 *   cleanupFence?,    // cleanup only
 * }
 *
 * This provider MUST validate the authenticated
 * actor or durable worker claim against authoritative
 * server-side state.
 *
 * Never authorize from browser-provided identifiers.
 *
 * REPOSITORY CONTRACT
 * -------------------
 * repository.verifyEligibility(request)
 * repository.promoteAtomically(request)
 * repository.retainAtomically(request)
 * repository.releaseRetentionAtomically(request)
 * repository.claimReclamationAtomically(request)
 * repository.completeReclamationAtomically(request)
 *
 * Each mutation method owns its complete database
 * transaction and must recheck lifecycle conditions,
 * ownership, fencing and relevant revisions.
 *
 * This service does not implement database SQL.
 */

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DATASET_RE = /^[a-z][a-z0-9_]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;

const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

const MAX_DATASETS = 32;
const MAX_REVISION = 9223372036854775807n;

const METHODS = Object.freeze([
  "verifyEligibility",
  "promoteAtomically",
  "retainAtomically",
  "releaseRetentionAtomically",
  "claimReclamationAtomically",
  "completeReclamationAtomically",
]);

const OUTCOMES = Object.freeze({
  verify: new Set([
    "ELIGIBLE",
    "NOT_ELIGIBLE",
  ]),
  publish: new Set([
    "PUBLISHED",
    "ALREADY_PUBLISHED",
    "NOT_ELIGIBLE",
    "STALE_FENCE",
    "CONFLICT",
  ]),
  retain: new Set([
    "RETAINED",
    "NOT_ELIGIBLE",
    "CONFLICT",
  ]),
  release: new Set([
    "RELEASED",
    "NOT_FOUND",
    "CONFLICT",
  ]),
  claimCleanup: new Set([
    "RECLAIMING",
    "NOT_RECLAIMABLE",
    "STALE_FENCE",
    "CONFLICT",
  ]),
  finishCleanup: new Set([
    "RECLAIMED",
    "STALE_FENCE",
    "CONFLICT",
  ]),
});

export class GenerationServiceError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });

    this.name = "GenerationServiceError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.outcomeUncertain =
      options.outcomeUncertain === true;
  }
}

function fail(code, message) {
  throw new GenerationServiceError(code, message);
}

/**
 * Accept only an ordinary record with own data
 * properties. No accessors, symbol keys, arrays,
 * class instances or unexpected properties.
 */
function record(value, allowedKeys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail("INVALID_REQUEST", `Invalid ${name}`);
  }

  const prototype = Object.getPrototypeOf(value);

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    fail("INVALID_REQUEST", `Invalid ${name}`);
  }

  const keys = Reflect.ownKeys(value);

  for (const key of keys) {
    if (
      typeof key !== "string" ||
      !allowedKeys.includes(key)
    ) {
      fail("INVALID_REQUEST", `Unexpected ${name} field`);
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(value, key);

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      fail("INVALID_REQUEST", `Accessor ${name} rejected`);
    }
  }

  return value;
}

function field(value, key) {
  return Object.getOwnPropertyDescriptor(
    value,
    key
  )?.value;
}

function identifier(value, name) {
  if (
    typeof value !== "string" ||
    !IDENTIFIER_RE.test(value)
  ) {
    fail("INVALID_REQUEST", `Invalid ${name}`);
  }

  return value;
}

function shopIdentity(value) {
  /*
   * Shop identity is opaque.
   *
   * It may be an internal UUID, canonical domain,
   * or another verified database identity.
   *
   * Authorization is NOT performed here.
   */
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    fail("INVALID_AUTHORITY", "Invalid resolved shop");
  }

  return value;
}

function version(value, name) {
  if (
    typeof value !== "string" ||
    !VERSION_RE.test(value)
  ) {
    fail("INVALID_REQUEST", `Invalid ${name}`);
  }

  return value;
}

function revision(value) {
  if (
    typeof value !== "string" ||
    value.length > 19 ||
    !DECIMAL_RE.test(value)
  ) {
    fail("INVALID_REQUEST", "Invalid coverage revision");
  }

  if (BigInt(value) > MAX_REVISION) {
    fail("INVALID_REQUEST", "Coverage revision exceeds range");
  }

  return value;
}

/**
 * Strict RFC 3339 subset:
 * - Four-digit years
 * - Mandatory seconds and timezone
 * - 0–3 fractional digits
 * - No leap seconds
 * - Offset not exceeding +/-14:00
 *
 * Validates the actual local calendar date before
 * applying the offset.
 */
export function normalizeRetentionTimestamp(value) {
  if (typeof value !== "string") {
    fail("INVALID_TIMESTAMP", "Timestamp must be a string");
  }

  const match = TIMESTAMP_RE.exec(value);

  if (!match) {
    fail(
      "INVALID_TIMESTAMP",
      "Strict RFC 3339 timestamp required"
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number(
    (match[7] ?? "").padEnd(3, "0") || "0"
  );

  if (
    year < 1 ||
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    fail("INVALID_TIMESTAMP", "Invalid timestamp fields");
  }

  /*
   * Avoid Date.UTC(year, ...) handling of years 0–99
   * by explicitly setting the full UTC year.
   */
  const local = new Date(0);

  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millis);

  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    fail(
      "INVALID_TIMESTAMP",
      "Nonexistent calendar date"
    );
  }

  let offsetMinutes = 0;

  if (match[8] !== "Z") {
    const offsetHours = Number(match[10]);
    const offsetMins = Number(match[11]);

    if (
      offsetHours > 14 ||
      offsetMins > 59 ||
      (offsetHours === 14 && offsetMins !== 0)
    ) {
      fail("INVALID_TIMESTAMP", "Invalid timezone offset");
    }

    const sign = match[9] === "+" ? 1 : -1;

    offsetMinutes =
      sign * (offsetHours * 60 + offsetMins);
  }

  const utcTime =
    local.getTime() - offsetMinutes * 60_000;

  const utc = new Date(utcTime);

  if (!Number.isFinite(utcTime)) {
    fail("INVALID_TIMESTAMP", "Invalid UTC timestamp");
  }

  // Restrict to a canonical four-digit-year output.
  if (
    utc.getUTCFullYear() < 1 ||
    utc.getUTCFullYear() > 9999
  ) {
    fail("INVALID_TIMESTAMP", "UTC year out of range");
  }

  return utc.toISOString();
}

function datasets(value, registry) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > MAX_DATASETS
  ) {
    fail("INVALID_REQUEST", "Invalid required datasets");
  }

  const accepted = [];
  const seen = new Set();

  for (let i = 0; i < value.length; i++) {
    const descriptor =
      Object.getOwnPropertyDescriptor(value, String(i));

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      fail("INVALID_REQUEST", "Invalid dataset entry");
    }

    const name = descriptor.value;

    if (
      typeof name !== "string" ||
      !DATASET_RE.test(name) ||
      seen.has(name)
    ) {
      fail("INVALID_REQUEST", "Invalid dataset identity");
    }

    if (registry.has(name) !== true) {
      fail("UNSUPPORTED_DATASET", "Unsupported dataset");
    }

    seen.add(name);
    accepted.push(name);
  }

  return Object.freeze(accepted.sort());
}

function verification(input, registry) {
  record(input, [
    "context",
    "generationId",
    "coverageRevision",
    "mirrorSchemaVersion",
    "sourceContractVersion",
    "mappingVersion",
    "requiredDatasets",
  ], "verification request");

  return Object.freeze({
    context: field(input, "context"),
    generationId: identifier(
      field(input, "generationId"),
      "generation"
    ),
    coverageRevision: revision(
      field(input, "coverageRevision")
    ),
    mirrorSchemaVersion: version(
      field(input, "mirrorSchemaVersion"),
      "mirror schema version"
    ),
    sourceContractVersion: version(
      field(input, "sourceContractVersion"),
      "source contract version"
    ),
    mappingVersion: version(
      field(input, "mappingVersion"),
      "mapping version"
    ),
    requiredDatasets: datasets(
      field(input, "requiredDatasets"),
      registry
    ),
  });
}

function publication(input, registry) {
  record(input, [
    "context",
    "generationId",
    "coverageRevision",
    "mirrorSchemaVersion",
    "sourceContractVersion",
    "mappingVersion",
    "requiredDatasets",
    "expectedCurrentGenerationId",
  ], "publication request");

  const expected =
    field(input, "expectedCurrentGenerationId");

  if (
    !Object.hasOwn(
      input,
      "expectedCurrentGenerationId"
    )
  ) {
    fail(
      "INVALID_REQUEST",
      "Expected publication pointer required"
    );
  }

  if (expected !== null) {
    identifier(expected, "expected generation");
  }

  const base = verification({
    context: field(input, "context"),
    generationId: field(input, "generationId"),
    coverageRevision: field(input, "coverageRevision"),
    mirrorSchemaVersion: field(input, "mirrorSchemaVersion"),
    sourceContractVersion: field(input, "sourceContractVersion"),
    mappingVersion: field(input, "mappingVersion"),
    requiredDatasets: field(input, "requiredDatasets"),
  }, registry);

  return Object.freeze({
    ...base,
    expectedCurrentGenerationId: expected,
  });
}

function basic(input, extra = []) {
  record(input, [
    "context",
    "generationId",
    ...extra,
  ], "generation request");

  return {
    context: field(input, "context"),
    generationId: identifier(
      field(input, "generationId"),
      "generation"
    ),
  };
}

/**
 * Logging is a non-authoritative side effect.
 * It must never change an already committed result.
 */
function safeLog(logger, entry) {
  try {
    const result = logger?.info?.(entry);

    if (
      result &&
      typeof result.catch === "function"
    ) {
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Best-effort diagnostic logging only.
  }
}

function checkResult(value, allowed) {
  record(value, ["kind"], "repository result");

  const kind = field(value, "kind");

  if (!allowed.has(kind)) {
    throw new GenerationServiceError(
      "REPOSITORY_CONTRACT_VIOLATION",
      "Unexpected repository outcome"
    );
  }

  return Object.freeze({ kind });
}

function checkDependencies({
  repository,
  authorityProvider,
  datasetRegistry,
}) {
  for (const name of METHODS) {
    if (typeof repository?.[name] !== "function") {
      throw new TypeError(
        `Missing generation repository method: ${name}`
      );
    }
  }

  if (
    typeof authorityProvider?.authorize !== "function"
  ) {
    throw new TypeError(
      "Trusted authority provider required"
    );
  }

  if (typeof datasetRegistry?.has !== "function") {
    throw new TypeError(
      "Canonical dataset registry required"
    );
  }
}

export function createGenerationService({
  repository,
  authorityProvider,
  datasetRegistry,
  logger,
} = {}) {
  checkDependencies({
    repository,
    authorityProvider,
    datasetRegistry,
  });

  async function authorize(action, context) {
    /*
     * Provider must validate current authenticated
     * session or durable worker claim.
     *
     * A user-created context is never sufficient.
     */
    const raw = await authorityProvider.authorize({
      action,
      context,
    });

    record(raw, [
      "shopId",
      "publisherFence",
      "cleanupFence",
    ], "resolved authority");

    const shopId = shopIdentity(
      field(raw, "shopId")
    );

    const result = { shopId };

    if (action === "publish") {
      result.publisherFence = identifier(
        field(raw, "publisherFence"),
        "publisher fence"
      );
    }

    if (
      action === "claimCleanup" ||
      action === "finishCleanup"
    ) {
      result.cleanupFence = identifier(
        field(raw, "cleanupFence"),
        "cleanup fence"
      );
    }

    return Object.freeze(result);
  }

  async function callRepository(
    operation,
    method,
    request,
    allowed
  ) {
    let result;

    try {
      result = await repository[method](request);
    } catch (error) {
      if (error instanceof GenerationServiceError) {
        throw error;
      }

      /*
       * For mutations, a network/connection failure
       * may occur AFTER PostgreSQL commits.
       *
       * Never blindly retry with the same claim.
       * Read durable state before deciding.
       */
      throw new GenerationServiceError(
        operation === "verify"
          ? "REPOSITORY_READ_FAILED"
          : "REPOSITORY_OUTCOME_UNKNOWN",
        "Generation repository operation failed",
        {
          cause: error,
          retryable: operation === "verify",
          outcomeUncertain: operation !== "verify",
        }
      );
    }

    return checkResult(result, allowed);
  }

  async function verifyGeneration(input) {
    const v = verification(input, datasetRegistry);

    const authority = await authorize(
      "verify",
      v.context
    );

    return callRepository(
      "verify",
      "verifyEligibility",
      {
        ...authority,
        ...v,
        context: undefined,
      },
      OUTCOMES.verify
    );
  }

  async function publishGeneration(input) {
    const v = publication(input, datasetRegistry);

    const authority = await authorize(
      "publish",
      v.context
    );

    const request = Object.freeze({
      ...authority,
      ...v,
      context: undefined,
    });

    const result = await callRepository(
      "publish",
      "promoteAtomically",
      request,
      OUTCOMES.publish
    );

    if (result.kind === "PUBLISHED") {
      safeLog(logger, {
        event: "mirror_generation_published",
        shopId: authority.shopId,
        generationId: v.generationId,
      });
    }

    return result;
  }

  async function retainGeneration(input) {
    const b = basic(input, [
      "referenceId",
      "expiresAt",
    ]);

    const referenceId = identifier(
      field(input, "referenceId"),
      "retention reference"
    );

    const expiresAt = normalizeRetentionTimestamp(
      field(input, "expiresAt")
    );

    const authority = await authorize(
      "retain",
      b.context
    );

    return callRepository(
      "retain",
      "retainAtomically",
      {
        ...authority,
        generationId: b.generationId,
        referenceId,
        expiresAt,
      },
      OUTCOMES.retain
    );
  }

  async function releaseRetention(input) {
    const b = basic(input, ["referenceId"]);

    const referenceId = identifier(
      field(input, "referenceId"),
      "retention reference"
    );

    const authority = await authorize(
      "release",
      b.context
    );

    return callRepository(
      "release",
      "releaseRetentionAtomically",
      {
        ...authority,
        generationId: b.generationId,
        referenceId,
      },
      OUTCOMES.release
    );
  }

  /**
   * Stage 1: claim a generation for cleanup.
   *
   * Must atomically prevent creation of new
   * references while fencing the cleanup owner.
   *
   * Does NOT indicate that data was deleted.
   */
  async function beginReclamation(input) {
    const b = basic(input);

    const authority = await authorize(
      "claimCleanup",
      b.context
    );

    return callRepository(
      "claimCleanup",
      "claimReclamationAtomically",
      {
        ...authority,
        generationId: b.generationId,
      },
      OUTCOMES.claimCleanup
    );
  }

  /**
   * Stage 2: finalize cleanup.
   *
   * Repository may return RECLAIMED only after
   * durable, verified, fenced data deletion.
   */
  async function finishReclamation(input) {
    const b = basic(input);

    const authority = await authorize(
      "finishCleanup",
      b.context
    );

    const result = await callRepository(
      "finishCleanup",
      "completeReclamationAtomically",
      {
        ...authority,
        generationId: b.generationId,
      },
      OUTCOMES.finishCleanup
    );

    if (result.kind === "RECLAIMED") {
      safeLog(logger, {
        event: "mirror_generation_reclaimed",
        shopId: authority.shopId,
        generationId: b.generationId,
      });
    }

    return result;
  }

  return Object.freeze({
    verifyGeneration,
    publishGeneration,
    retainGeneration,
    releaseRetention,
    beginReclamation,
    finishReclamation,
  });
}
