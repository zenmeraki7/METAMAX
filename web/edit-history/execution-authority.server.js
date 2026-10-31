
/**
 * METAMAX — Edit History Execution Authority V2
 *
 * web/edit-history/execution-authority.server.js
 *
 * Requires History Contract V3.
 *
 * PURPOSE
 * -------
 * Establish an explicit, fail-closed admission boundary
 * between the Edit History journal and the existing
 * Bulk Edit Execution Engine.
 *
 * This module:
 * - Resolves authenticated tenant identity
 * - Validates current installation identity
 * - Loads an approved, authoritative execution plan
 * - Requires transaction-held execution ownership
 * - Validates the complete mutation field set
 * - Validates BEFORE snapshots and intent bindings
 * - Validates attempt/fence consistency
 * - Delegates actual Field Engine authorization
 * - Delegates observation receipt authentication
 *
 * This module NEVER:
 * - Performs Shopify mutations
 * - Issues a mutation lease or a worker fence
 * - Validates browser-provided SQL
 * - Reconstructs Mirror Engine schema relationships
 * - Treats a fingerprint as authorization
 * - Treats an ordinary SELECT as sufficient fencing
 * - Commits or rolls back a PostgreSQL transaction
 *
 * IMPORTANT
 * ---------
 * The caller MUST provide a live PostgreSQL client
 * inside an active write transaction.
 *
 * The verifyExecutionOwnership adapter MUST acquire
 * or validate an authoritative row lock protecting
 * mirror.job_commands ownership until that transaction
 * commits or rolls back.
 *
 * A returned ownership assertion is only trustworthy
 * if its producer implements that contract.
 * Callback clients are scoped to this connection and expire after each call.
 * Ownership, current tenant, installation and field authorization are rechecked
 * after asynchronous evidence verification. Returned metadata is not a cached
 * authorization grant. See docs/edit-history-execution-authority.md for the
 * current journal's one-resource envelope compatibility boundary.
 *
 * Node.js 22+ / ESM.
 */

import {
  HISTORY_CONTRACT_VERSION,
  HISTORY_LIMITS,
  HISTORY_ERROR_CODES as C,
  HistoryContractError,
  SNAPSHOT_KINDS,
  SNAPSHOT_VALUE_KINDS,
  canonicalHistoryJson,
  normalizeHistoryIdentity,
  normalizeHistoryBinding,
  normalizeHistorySnapshot,
  normalizeMutationIntent,
  normalizeMutationAttempt,
  assertSnapshotIntentConsistency,
  requireHistoryId,
} from "./history-contract.js";
import { createHistoryHookInvoker } from "./transaction-hooks.server.js";

const MAX_FIELDS = 64;
const MAX_PG_BIGINT = 9223372036854775807n;

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

const OWNERSHIP_LOCK_SCOPE =
  "AUTHORITATIVE_EXECUTION_JOB_UNTIL_TRANSACTION_END";

const REQUIRED_ADAPTERS = Object.freeze([
  "resolveTenant",
  "verifyInstallation",
  "loadApprovedExecutionPlan",
  "verifyExecutionOwnership",
  "verifyFieldAuthorization",
  "verifyObservationProvenance",
]);

function fail(code, message) {
  throw new HistoryContractError(code, message);
}

function assertAdapter(adapter, name) {
  if (typeof adapter !== "function") {
    throw new TypeError(
      `Missing required History Authority adapter: ${name}`,
    );
  }

  return adapter;
}

function ownData(object, key) {
  if (
    object === null ||
    typeof object !== "object"
  ) {
    fail(C.INVALID_INPUT, "Plain data object required");
  }

  const descriptor =
    Object.getOwnPropertyDescriptor(object, key);

  if (!descriptor) return undefined;

  if (
    !Object.hasOwn(descriptor, "value") ||
    descriptor.enumerable !== true
  ) {
    fail(
      C.INVALID_INPUT,
      "Accessor or hidden property is forbidden",
    );
  }

  return descriptor.value;
}

function dataRecord(value, allowedKeys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(C.INVALID_INPUT, `Invalid ${name}`);
  }

  const prototype = Object.getPrototypeOf(value);

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    fail(C.INVALID_INPUT, `Invalid ${name} prototype`);
  }

  const allowed = new Set(allowedKeys);
  const result = Object.create(null);

  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key)
    ) {
      fail(
        C.INVALID_INPUT,
        `Unexpected ${name} property`,
      );
    }

    const descriptor =
      Object.getOwnPropertyDescriptor(value, key);

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      fail(
        C.INVALID_INPUT,
        `Invalid ${name} property descriptor`,
      );
    }

    result[key] = descriptor.value;
  }

  return result;
}

function bigintId(value, name) {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value)
  ) {
    fail(C.INVALID_INPUT, `Invalid ${name}`);
  }

  const number = BigInt(value);

  if (number > MAX_PG_BIGINT) {
    fail(C.INVALID_INPUT, `${name} exceeds BIGINT`);
  }

  return value;
}

function requireHash(value, name) {
  if (
    typeof value !== "string" ||
    !SHA256_RE.test(value)
  ) {
    fail(C.BINDING_CONFLICT, `Invalid ${name}`);
  }

  return value;
}

function requiredValueKind(value, name) {
  if (
    value !== SNAPSHOT_VALUE_KINDS.VALUE &&
    value !== SNAPSHOT_VALUE_KINDS.ABSENT
  ) {
    fail(C.BINDING_CONFLICT, `Invalid ${name}`);
  }

  return value;
}

function requireArray(value, name) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_FIELDS
  ) {
    fail(
      C.LIMIT_EXCEEDED,
      `${name} must contain 1–${MAX_FIELDS} fields`,
    );
  }

  if (
    Reflect.ownKeys(value).length !==
    value.length + 1
  ) {
    fail(C.INVALID_INPUT, `Invalid ${name} array`);
  }

  const output = [];

  for (let index = 0; index < value.length; index++) {
    const descriptor =
      Object.getOwnPropertyDescriptor(
        value,
        String(index),
      );

    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      fail(
        C.INVALID_INPUT,
        `Invalid ${name} array element`,
      );
    }

    output.push(descriptor.value);
  }

  return output;
}

function normalizeTenant(input) {
  const record = dataRecord(
    input,
    ["shopId", "installationId"],
    "trusted tenant",
  );

  return Object.freeze({
    shopId: requireHistoryId(
      record.shopId,
      "shopId",
      255,
    ),
    installationId: requireHistoryId(
      record.installationId,
      "installationId",
    ),
  });
}

function normalizeClaim(input) {
  const claim = dataRecord(
    input,
    [
      "fenceEpoch",
      "executionClaimId",
      "leaseToken",
    ],
    "execution claim",
  );

  return Object.freeze({
    fenceEpoch: bigintId(
      claim.fenceEpoch,
      "fenceEpoch",
    ),
    executionClaimId: requireHistoryId(
      claim.executionClaimId,
      "executionClaimId",
    ),
    leaseToken: requireHistoryId(
      claim.leaseToken,
      "leaseToken",
    ),
  });
}

function assertEquivalent(actual, expected, name) {
  const maximum = HISTORY_LIMITS.MAX_RECORD_BYTES;

  const left = canonicalHistoryJson(actual, {
    maxBytes: maximum,
  });

  const right = canonicalHistoryJson(expected, {
    maxBytes: maximum,
  });

  if (
    JSON.stringify(left) !== JSON.stringify(right)
  ) {
    fail(C.BINDING_CONFLICT, `${name} mismatch`);
  }
}

function fieldKey(identity) {
  // Collision-free encoding of an ordered string pair.
  // Do not concatenate GID and field ID with a delimiter.
  return JSON.stringify([
    identity.resourceGid,
    identity.fieldId,
  ]);
}

function normalizeIntendedValue(input, name) {
  const valueKind = requiredValueKind(
    ownData(input, "intendedValueKind"),
    `${name}.intendedValueKind`,
  );

  const present = Object.hasOwn(
    input,
    "intendedValue",
  );

  if (
    (valueKind === "VALUE" && !present) ||
    (valueKind === "ABSENT" && present)
  ) {
    fail(
      C.BINDING_CONFLICT,
      `${name} intended value presence mismatch`,
    );
  }

  return Object.freeze({
    valueKind,
    ...(present
      ? {
          value: canonicalHistoryJson(
            ownData(input, "intendedValue"),
          ),
        }
      : {}),
  });
}

function normalizeApprovedField(input) {
  const data = dataRecord(
    input,
    [
      "identity",
      "binding",
      "resourceFamilyGid",
      "mutationPlanFingerprint",
      "intendedValueKind",
      "intendedValue",
    ],
    "approved field",
  );

  const identity = normalizeHistoryIdentity(
    data.identity,
  );

  const binding = normalizeHistoryBinding(
    data.binding,
  );

  const intended = normalizeIntendedValue(
    data,
    "approved field",
  );

  return Object.freeze({
    identity,
    binding,
    resourceFamilyGid: requireHistoryId(
      data.resourceFamilyGid,
      "resourceFamilyGid",
    ),
    mutationPlanFingerprint: requireHash(
      data.mutationPlanFingerprint,
      "mutationPlanFingerprint",
    ),
    intendedValueKind: intended.valueKind,
    ...(Object.hasOwn(intended, "value")
      ? { intendedValue: intended.value }
      : {}),
  });
}

function normalizeAuthorityPlan(input) {
  const data = dataRecord(
    input,
    [
      "shopId",
      "installationId",
      "executionJobId",
      "executionItemId",
      "editOperationId",
      "executionContractId",
      "mutationId",
      "mutationPlanFingerprint",
      "executionFingerprint",
      "filterFingerprint",
      "approvedContractFingerprint",
      "attemptId",
      "attemptNumber",
      "fenceEpoch",
      "executionClaimId",
      "startedAt",
      "fields",
    ],
    "authoritative execution plan",
  );

  const plan = {
    shopId: requireHistoryId(
      data.shopId,
      "shopId",
      255,
    ),
    installationId: requireHistoryId(
      data.installationId,
      "installationId",
    ),
    executionJobId: bigintId(
      data.executionJobId,
      "executionJobId",
    ),
    executionItemId: bigintId(
      data.executionItemId,
      "executionItemId",
    ),
    editOperationId: data.editOperationId == null
      ? null
      : bigintId(
          data.editOperationId,
          "editOperationId",
        ),
    executionContractId: data.executionContractId == null
      ? null
      : requireHistoryId(
          data.executionContractId,
          "executionContractId",
        ),
    mutationId: requireHistoryId(
      data.mutationId,
      "mutationId",
    ),
    mutationPlanFingerprint: requireHash(
      data.mutationPlanFingerprint,
      "mutationPlanFingerprint",
    ),
    executionFingerprint: requireHash(
      data.executionFingerprint,
      "executionFingerprint",
    ),
    filterFingerprint: requireHash(
      data.filterFingerprint,
      "filterFingerprint",
    ),
    approvedContractFingerprint:
      data.approvedContractFingerprint == null
        ? null
        : requireHash(
            data.approvedContractFingerprint,
            "approvedContractFingerprint",
          ),
    attemptId: requireHistoryId(
      data.attemptId,
      "attemptId",
    ),
    attemptNumber: data.attemptNumber,
    fenceEpoch: bigintId(
      data.fenceEpoch,
      "fenceEpoch",
    ),
    executionClaimId: requireHistoryId(
      data.executionClaimId,
      "executionClaimId",
    ),
    startedAt: data.startedAt,
    fields: Object.freeze(
      requireArray(data.fields, "approved field set")
        .map(normalizeApprovedField),
    ),
  };

  if (
    !Number.isSafeInteger(plan.attemptNumber) ||
    plan.attemptNumber < 1 ||
    plan.attemptNumber >
      HISTORY_LIMITS.MAX_ATTEMPT_NUMBER
  ) {
    fail(
      C.BINDING_CONFLICT,
      "Invalid approved attempt number",
    );
  }

  const fieldKeys = new Set();

  for (const field of plan.fields) {
    const id = field.identity;
    const key = fieldKey(id);

    if (fieldKeys.has(key)) {
      fail(
        C.BINDING_CONFLICT,
        "Duplicate resource/field in approved plan",
      );
    }

    fieldKeys.add(key);

    if (
      id.shopId !== plan.shopId ||
      id.installationId !== plan.installationId ||
      bigintId(
        id.executionJobId,
        "field executionJobId",
      ) !== plan.executionJobId ||
      bigintId(
        id.executionItemId,
        "field executionItemId",
      ) !== plan.executionItemId ||
      id.mutationId !== plan.mutationId
    ) {
      fail(
        C.BINDING_CONFLICT,
        "Mixed execution identity in approved plan",
      );
    }

    if (
      field.binding.executionFingerprint !==
        plan.executionFingerprint ||
      field.binding.filterFingerprint !==
        plan.filterFingerprint ||
      field.mutationPlanFingerprint !==
        plan.mutationPlanFingerprint
    ) {
      fail(
        C.BINDING_CONFLICT,
        "Field binding differs from approved plan",
      );
    }

  }

  // This adapter supports a mutation request covering
  // multiple resources belonging to an approved
  // execution item. The authoritative engine must
  // establish whether that grouping is actually valid.
  //
  // No assumption is made that field IDs are unique
  // across different Shopify resources.
  // Validate time and attempt coordinates before calling privileged adapters.
  normalizeMutationAttempt({
    identity: plan.fields[0].identity,
    attemptId: plan.attemptId,
    attemptNumber: plan.attemptNumber,
    fenceEpoch: plan.fenceEpoch,
    executionClaimId: plan.executionClaimId,
    startedAt: plan.startedAt,
  });
  return canonicalHistoryJson(plan, { maxBytes: HISTORY_LIMITS.MAX_RECORD_BYTES });
}

function normalizeEntry(input) {
  const data = dataRecord(
    input,
    [
      "beforeSnapshot",
      "intent",
      "attempt",
      "resourceFamilyGid",
    ],
    "journal entry",
  );

  const snapshotInput = dataRecord(
    data.beforeSnapshot,
    [
      "snapshotVersion",
      "identity",
      "binding",
      "kind",
      "valueKind",
      "value",
      "fingerprint",
      "observation",
      "evidenceBindingFingerprint",
    ],
    "BEFORE snapshot",
  );

  const observationInput = dataRecord(
    snapshotInput.observation,
    [
      "observationVersion",
      "observationId",
      "source",
      "observedAt",
      "resourceGid",
      "fieldId",
      "sourceRevision",
      "receiptId",
      "receiptFingerprint",
      "evidenceFingerprint",
    ],
    "observation evidence",
  );

  const cleanObservation = {
    observationId: observationInput.observationId,
    source: observationInput.source,
    observedAt: observationInput.observedAt,
    resourceGid: observationInput.resourceGid,
    fieldId: observationInput.fieldId,
    sourceRevision: observationInput.sourceRevision,
    receiptId: observationInput.receiptId,
    receiptFingerprint:
      observationInput.receiptFingerprint,
  };

  const beforeSnapshot = normalizeHistorySnapshot({
    identity: snapshotInput.identity,
    binding: snapshotInput.binding,
    kind: snapshotInput.kind,
    valueKind: snapshotInput.valueKind,
    ...(Object.hasOwn(snapshotInput, "value")
      ? { value: snapshotInput.value }
      : {}),
    observation: cleanObservation,
  });

  assertEquivalent(
    snapshotInput,
    beforeSnapshot,
    "BEFORE snapshot",
  );

  if (beforeSnapshot.kind !== SNAPSHOT_KINDS.BEFORE) {
    fail(
      C.BINDING_CONFLICT,
      "A BEFORE snapshot is required",
    );
  }

  const intentInput = dataRecord(
    data.intent,
    [
      "contractVersion",
      "identity",
      "binding",
      "beforeSnapshotFingerprint",
      "intendedValueKind",
      "intendedValue",
      "mutationPlanFingerprint",
      "fingerprint",
    ],
    "mutation intent",
  );

  const intent = normalizeMutationIntent({
    identity: intentInput.identity,
    binding: intentInput.binding,
    beforeSnapshotFingerprint:
      intentInput.beforeSnapshotFingerprint,
    intendedValueKind:
      intentInput.intendedValueKind,
    ...(Object.hasOwn(intentInput, "intendedValue")
      ? { intendedValue: intentInput.intendedValue }
      : {}),
    mutationPlanFingerprint:
      intentInput.mutationPlanFingerprint,
  });

  assertEquivalent(
    intentInput,
    intent,
    "Mutation intent",
  );

  assertSnapshotIntentConsistency({
    beforeSnapshot,
    intent,
  });

  const attemptInput = dataRecord(
    data.attempt,
    [
      "attemptVersion",
      "identity",
      "attemptId",
      "attemptNumber",
      "fenceEpoch",
      "executionClaimId",
      "startedAt",
      "fingerprint",
    ],
    "mutation attempt",
  );

  const attempt = normalizeMutationAttempt({
    identity: attemptInput.identity,
    attemptId: attemptInput.attemptId,
    attemptNumber: attemptInput.attemptNumber,
    fenceEpoch: attemptInput.fenceEpoch,
    executionClaimId: attemptInput.executionClaimId,
    startedAt: attemptInput.startedAt,
  });

  assertEquivalent(
    attemptInput,
    attempt,
    "Mutation attempt",
  );

  assertEquivalent(
    attempt.identity,
    intent.identity,
    "Attempt/intent identity",
  );

  return Object.freeze({
    beforeSnapshot,
    intent,
    attempt,
    resourceFamilyGid: requireHistoryId(
      data.resourceFamilyGid,
      "resourceFamilyGid",
    ),
  });
}

function requireClient(client) {
  if (
    !client ||
    typeof client.query !== "function"
  ) {
    fail(
      C.INVALID_INPUT,
      "Active transaction client required",
    );
  }
}

function verifyInstallationProof(proof, tenant) {
  const result = dataRecord(
    proof,
    [
      "verified",
      "shopId",
      "installationId",
      "current",
    ],
    "installation proof",
  );

  if (
    result.verified !== true ||
    result.current !== true ||
    result.shopId !== tenant.shopId ||
    result.installationId !== tenant.installationId
  ) {
    fail(
      C.UNAUTHORIZED,
      "Current installation was not verified",
    );
  }
}

function verifyOwnershipProof(
  proof,
  tenant,
  plan,
  claim,
) {
  const result = dataRecord(
    proof,
    [
      "verified",
      "shopId",
      "installationId",
      "executionJobId",
      "executionItemId",
      "mutationId",
      "fenceEpoch",
      "executionClaimId",
      "leaseToken",
      "lockScope",
    ],
    "execution ownership proof",
  );

  if (
    result.verified !== true ||
    result.shopId !== tenant.shopId ||
    result.installationId !== tenant.installationId ||
    bigintId(
      result.executionJobId,
      "proof executionJobId",
    ) !== plan.executionJobId ||
    bigintId(
      result.executionItemId,
      "proof executionItemId",
    ) !== plan.executionItemId ||
    result.mutationId !== plan.mutationId ||
    bigintId(
      result.fenceEpoch,
      "proof fenceEpoch",
    ) !== claim.fenceEpoch ||
    result.executionClaimId !==
      claim.executionClaimId ||
    result.leaseToken !== claim.leaseToken ||
    result.lockScope !== OWNERSHIP_LOCK_SCOPE
  ) {
    fail(
      C.OWNERSHIP_LOST,
      "Execution claim or transaction lock not verified",
    );
  }

  // Returning the lock scope asserts a required
  // integration contract. The authority adapter must
  // actually hold the protecting PostgreSQL lock.
}

function verifyAuthorizationProof(proof, tenant, plan) {
  const result = dataRecord(
    proof,
    [
      "verified",
      "shopId",
      "installationId",
      "executionJobId",
      "mutationId",
      "approvedPlanFingerprint",
    ],
    "field authorization proof",
  );

  if (
    result.verified !== true ||
    result.shopId !== tenant.shopId ||
    result.installationId !== tenant.installationId ||
    bigintId(
      result.executionJobId,
      "authorization executionJobId",
    ) !== plan.executionJobId ||
    result.mutationId !== plan.mutationId ||
    result.approvedPlanFingerprint !==
      plan.mutationPlanFingerprint
  ) {
    fail(
      C.UNAUTHORIZED,
      "Field Engine authorization was not verified",
    );
  }
}

function verifyObservationProof(
  proof,
  field,
  entry,
  tenant,
) {
  const result = dataRecord(
    proof,
    [
      "verified",
      "shopId",
      "installationId",
      "observationId",
      "snapshotFingerprint",
      "evidenceBindingFingerprint",
      "receiptFingerprint",
    ],
    "observation provenance proof",
  );

  if (
    result.verified !== true ||
    result.shopId !== tenant.shopId ||
    result.installationId !== tenant.installationId ||
    result.observationId !==
      entry.beforeSnapshot.observation.observationId ||
    result.snapshotFingerprint !==
      entry.beforeSnapshot.fingerprint ||
    result.evidenceBindingFingerprint !==
      entry.beforeSnapshot.evidenceBindingFingerprint ||
    result.receiptFingerprint !==
      entry.beforeSnapshot.observation.receiptFingerprint
  ) {
    fail(
      C.EVIDENCE_CONFLICT,
      "BEFORE observation provenance is invalid",
    );
  }

  assertEquivalent(
    entry.beforeSnapshot.identity,
    field.identity,
    "BEFORE observation identity",
  );

  assertEquivalent(
    entry.beforeSnapshot.binding,
    field.binding,
    "BEFORE observation binding",
  );
}

/**
 * Required adapters:
 *
 * resolveTenant({
 *   client, authContext
 * })
 *
 * verifyInstallation({
 *   client, authContext, tenant
 * })
 *
 * loadApprovedExecutionPlan({
 *   client, authContext, tenant,
 *   executionJobId, mutationId
 * })
 *
 * verifyExecutionOwnership({
 *   client, authContext, tenant, plan, claim
 * })
 *
 * verifyFieldAuthorization({
 *   client, authContext, tenant, plan
 * })
 *
 * verifyObservationProvenance({
 *   client, authContext, tenant, plan,
 *   approvedField, beforeSnapshot
 * })
 *
 * All supplied functions are privileged server-side
 * integrations. The application must never select them
 * based on a browser request.
 */

export function createHistoryExecutionAuthority(
  dependencies = {},
) {
  const config = dataRecord(
    dependencies,
    REQUIRED_ADAPTERS,
    "authority dependencies",
  );

  for (const name of REQUIRED_ADAPTERS) {
    assertAdapter(config[name], name);
  }

  async function authorizeAdmission(input) {
    const { client, authContext, executionJobId, mutationId, claim, entries } =
      dataRecord(input, ["client", "authContext", "executionJobId", "mutationId", "claim", "entries"], "admission request");
    requireClient(client);

    if (!authContext) {
      fail(
        C.UNAUTHORIZED,
        "Authenticated server context required",
      );
    }

    const requestedJobId = bigintId(
      executionJobId,
      "executionJobId",
    );

    const requestedMutationId = requireHistoryId(
      mutationId,
      "mutationId",
    );

    const normalizedClaim = normalizeClaim(claim);

    const normalizedEntries = requireArray(
      entries,
      "journal entries",
    ).map(normalizeEntry);

    // Each callback uses this exact connection through a short-lived read/lock
    // capability. This does not establish an active transaction or certify a
    // producer's lock assertion; the trusted integration must establish both.
    const invoke = createHistoryHookInvoker(client);

    const tenant = normalizeTenant(
      await invoke(config.resolveTenant, {
        client,
        authContext,
      }),
    );

    verifyInstallationProof(
      await invoke(config.verifyInstallation, {
        client,
        authContext,
        tenant,
      }),
      tenant,
    );

    const plan = normalizeAuthorityPlan(
      await invoke(config.loadApprovedExecutionPlan, {
        client,
        authContext,
        tenant,
        executionJobId: requestedJobId,
        mutationId: requestedMutationId,
      }),
    );

    if (
      plan.shopId !== tenant.shopId ||
      plan.installationId !== tenant.installationId ||
      plan.executionJobId !== requestedJobId ||
      plan.mutationId !== requestedMutationId
    ) {
      fail(
        C.BINDING_CONFLICT,
        "Approved plan does not match request scope",
      );
    }

    if (
      plan.fenceEpoch !== normalizedClaim.fenceEpoch ||
      plan.executionClaimId !==
        normalizedClaim.executionClaimId
    ) {
      fail(
        C.OWNERSHIP_LOST,
        "Claim differs from the approved execution attempt",
      );
    }

    // The authority adapter must acquire the existing
    // execution job's protecting lock and retain it
    // until the repository transaction ends.
    verifyOwnershipProof(
      await invoke(config.verifyExecutionOwnership, {
        client,
        authContext,
        tenant,
        plan,
        claim: normalizedClaim,
      }),
      tenant,
      plan,
      normalizedClaim,
    );

    verifyAuthorizationProof(
      await invoke(config.verifyFieldAuthorization, {
        client,
        authContext,
        tenant,
        plan,
      }),
      tenant,
      plan,
    );

    const supplied = new Map();

    for (const entry of normalizedEntries) {
      const key = fieldKey(entry.intent.identity);

      if (supplied.has(key)) {
        fail(
          C.BINDING_CONFLICT,
          "Duplicate resource/field journal entry",
        );
      }

      supplied.set(key, entry);
    }

    if (supplied.size !== plan.fields.length) {
      fail(
        C.BINDING_CONFLICT,
        "Journal does not cover the entire approved field set",
      );
    }

    const accepted = [];

    for (const approvedField of plan.fields) {
      const key = fieldKey(approvedField.identity);
      const entry = supplied.get(key);

      if (!entry) {
        fail(
          C.BINDING_CONFLICT,
          "Missing approved resource/field journal entry",
        );
      }

      assertEquivalent(
        entry.intent.identity,
        approvedField.identity,
        "Intent identity",
      );

      assertEquivalent(
        entry.intent.binding,
        approvedField.binding,
        "Intent field/filter binding",
      );

      assertEquivalent(
        entry.beforeSnapshot.identity,
        approvedField.identity,
        "BEFORE snapshot identity",
      );

      assertEquivalent(
        entry.beforeSnapshot.binding,
        approvedField.binding,
        "BEFORE snapshot binding",
      );

      assertEquivalent(
        entry.attempt.identity,
        approvedField.identity,
        "Execution attempt identity",
      );

      assertEquivalent(
        entry.resourceFamilyGid,
        approvedField.resourceFamilyGid,
        "Resource family",
      );

      assertEquivalent(
        [
          entry.attempt.attemptId,
          entry.attempt.attemptNumber,
          entry.attempt.fenceEpoch,
          entry.attempt.executionClaimId,
          entry.attempt.startedAt,
        ],
        [
          plan.attemptId,
          plan.attemptNumber,
          plan.fenceEpoch,
          plan.executionClaimId,
          plan.startedAt,
        ],
        "Attempt/fence coordinates",
      );

      assertEquivalent(
        entry.intent.mutationPlanFingerprint,
        plan.mutationPlanFingerprint,
        "Mutation plan fingerprint",
      );

      assertEquivalent(
        [
          entry.intent.intendedValueKind,
          Object.hasOwn(entry.intent, "intendedValue"),
          ...(Object.hasOwn(entry.intent, "intendedValue")
            ? [entry.intent.intendedValue]
            : []),
        ],
        [
          approvedField.intendedValueKind,
          Object.hasOwn(approvedField, "intendedValue"),
          ...(Object.hasOwn(
            approvedField,
            "intendedValue",
          )
            ? [approvedField.intendedValue]
            : []),
        ],
        "Intended field value",
      );

      verifyObservationProof(
        await invoke(config.verifyObservationProvenance, {
          client,
          authContext,
          tenant,
          plan,
          approvedField,
          beforeSnapshot: entry.beforeSnapshot,
        }),
        approvedField,
        entry,
        tenant,
      );

      accepted.push(
        Object.freeze({
          resourceGid:
            approvedField.identity.resourceGid,
          fieldId:
            approvedField.identity.fieldId,
          resourceFamilyGid:
            approvedField.resourceFamilyGid,
          identity:
            approvedField.identity,
          binding:
            approvedField.binding,
          beforeSnapshotFingerprint:
            entry.beforeSnapshot.fingerprint,
          evidenceBindingFingerprint:
            entry.beforeSnapshot.evidenceBindingFingerprint,
          mutationIntentFingerprint:
            entry.intent.fingerprint,
          mutationAttemptFingerprint:
            entry.attempt.fingerprint,
        }),
      );
    }

    // Recheck installation and authoritative execution
    // ownership after all asynchronous verification.
    // The protecting lock must still be held by the
    // supplied transaction client.
    assertEquivalent(
      normalizeTenant(await invoke(config.resolveTenant, { authContext })),
      tenant,
      "Authenticated tenant changed during admission",
    );
    verifyInstallationProof(
      await invoke(config.verifyInstallation, {
        client,
        authContext,
        tenant,
      }),
      tenant,
    );

    verifyAuthorizationProof(
      await invoke(config.verifyFieldAuthorization, { authContext, tenant, plan }),
      tenant,
      plan,
    );
    verifyOwnershipProof(
      await invoke(config.verifyExecutionOwnership, {
        client,
        authContext,
        tenant,
        plan,
        claim: normalizedClaim,
      }),
      tenant,
      plan,
      normalizedClaim,
    );

    return Object.freeze({
      contractVersion: HISTORY_CONTRACT_VERSION,
      tenant,
      executionJobId: plan.executionJobId,
      executionItemId: plan.executionItemId,
      editOperationId: plan.editOperationId,
      executionContractId: plan.executionContractId,
      mutationId: plan.mutationId,
      mutationPlanFingerprint:
        plan.mutationPlanFingerprint,
      executionFingerprint:
        plan.executionFingerprint,
      filterFingerprint:
        plan.filterFingerprint,
      approvedContractFingerprint:
        plan.approvedContractFingerprint,
      attemptId: plan.attemptId,
      attemptNumber: plan.attemptNumber,
      fenceEpoch: plan.fenceEpoch,
      executionClaimId: plan.executionClaimId,
      fields: Object.freeze(accepted),
    });
  }

  return Object.freeze({
    authorizeAdmission,
  });
}
