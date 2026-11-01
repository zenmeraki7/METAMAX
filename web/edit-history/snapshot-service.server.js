/**
 * Server-side bridge from issued Field/Filter Engine contracts to history.
 * No database writes or evidence attestation happen here. The repository must
 * verify durable execution, observation receipts, snapshots and worker claims.
 * Only MIRROR_PINNED is supported by the installed engines; no invented direct
 * or execution-snapshot bindings are supplied as a fallback.
 *
 * Engine mapping (no history-domain hashes substitute for engine outputs):
 * - identity.fieldId: an exact ID present in the issued write resolution.
 * - value/intendedValue: Field Engine read/write normalization respectively.
 * - filterFingerprint: Filter Engine AST digest of its normalized issued AST.
 * - executionFingerprint: issued Filter Engine execution-bound digest.
 * - fieldResolutionFingerprint: issued Field Engine registry/mappings digest.
 * - fieldDefinitionRevision: canonical registry version or dynamic definition
 *   revision from the issued Field Engine descriptor.
 * - mappingVersion: Field Engine resolved registry/mappings version. This is
 *   NOT the database mirror publication's separate mapping_version coordinate;
 *   repository publication checks must independently verify that coordinate.
 *
 * A mutation plan fingerprint and observation receipt are still references
 * requiring independent durable repository verification, not engine grants.
 */
import { assertAuthorizedFieldService, getResolvedFieldPolicy } from "../fields/resolve.js";
import { normalizeFieldValue } from "../fields/normalize.js";
import { CANONICAL_REGISTRY_INFO } from "../fields/canonical.js";
import { assertAuthorizedFilterService } from "../filters/validate.js";
import { fingerprintFilterAst } from "../filters/fingerprint.js";
import {isDeepStrictEqual} from 'node:util';
import {NORMALIZE_CONTRACT_VERSION} from '../fields/normalize.js';
import {CONSTRAINTS_VERSION} from '../fields/constraints.js';
import {OPERATOR_CONTRACT_VERSION} from '../fields/operators.js';
import {FILTER_BINDING_VERSION} from '../filters/bindings.js';
import {FILTER_VALIDATION_VERSION} from '../filters/contracts.js';
import {
  HISTORY_ERROR_CODES as C, HistoryContractError,
  normalizeHistoryIdentity, normalizeHistoryBinding,
  normalizeHistorySnapshot, normalizeMutationIntent,
  assertSnapshotIntentConsistency,
} from "./history-contract.js";

function reject(message) {
  throw new HistoryContractError(C.BINDING_CONFLICT, message);
}

function data(input, allowed) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    reject("History integration input must be a plain record");
  }
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!allowed.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
      reject("Unsupported history integration property");
    }
    result[key] = descriptor.value;
  }
  return result;
}

// Preserve the exact engine digest. History adds an encoding prefix only;
// historyFingerprint must never be used to fabricate engine fingerprints.
function engineDigest(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    reject("Invalid engine-issued digest");
  }
  return `sha256:${value}`;
}

const CONTEXT_KEYS = ["authContext", "fieldResolution", "validatedFilter", "identity"];
const EDIT_OPERATIONS = new Set(["bulk_edit", "scheduled_edit", "recurring_edit", "import", "undo"]);

export function createHistorySnapshotService({ fieldService, filterService } = {}) {
  assertAuthorizedFieldService(fieldService);
  assertAuthorizedFilterService(filterService);

  async function resolve(input) {
    // Check issuance before inspecting caller-supplied resolution properties.
    fieldService.assertResolution(input.fieldResolution);
    const fieldResolution = await fieldService.revalidateResolution(input.fieldResolution, { authContext: input.authContext });
    const filter = await filterService.revalidateFilter(input.validatedFilter, { authContext: input.authContext });
    // Filter and mutation fields may differ. Resolve the filter's exact field
    // set again, then compare its complete issued read-resolution identity.
    const plan=filterService.getResolutionPlan(filter);
    if(!isDeepStrictEqual(filter.versions,{validation:FILTER_VALIDATION_VERSION,ast:1,canonical:CANONICAL_REGISTRY_INFO.registryVersion,
      operators:OPERATOR_CONTRACT_VERSION,bindings:FILTER_BINDING_VERSION,normalization:NORMALIZE_CONTRACT_VERSION,constraints:CONSTRAINTS_VERSION})||
      !isDeepStrictEqual(plan.versions,filter.versions))reject('Filter code version coordinates differ');
    const readResolution=await fieldService.requireFields({authContext:input.authContext,fieldIds:plan.fieldIds,access:'read',operation:fieldResolution.operation,
      executionContext:{phase:fieldResolution.phase,operationId:fieldResolution.operationId,generationId:fieldResolution.generationId,
       coverageRevision:fieldResolution.coverageRevision,approvedTargetingSnapshot:{shopId:fieldResolution.shopId,snapshotId:fieldResolution.targetingSnapshotId,
        generationId:fieldResolution.generationId,coverageRevision:fieldResolution.coverageRevision}}});
    if(readResolution.registryVersion!==filter.registryVersion||!isDeepStrictEqual(readResolution.definitionRevisions,filter.definitionRevisions)||
      !isDeepStrictEqual(readResolution.fields,plan.fields)||!isDeepStrictEqual([...readResolution.datasets].sort(),plan.datasets))reject('Complete filter field-resolution identity differs');
    if(!isDeepStrictEqual(fieldResolution.definitionRevisions,input.fieldResolution.definitionRevisions)||
      fieldResolution.registryVersion!==input.fieldResolution.registryVersion||fieldResolution.writeCapabilityVersion!==input.fieldResolution.writeCapabilityVersion||
      !isDeepStrictEqual(fieldResolution.fields,input.fieldResolution.fields))reject('Complete write field-resolution identity changed');
    const identity = normalizeHistoryIdentity(input.identity);
    if (fieldResolution.shopId !== identity.shopId || fieldResolution.access !== "write" ||
        fieldResolution.phase !== "execute" || !EDIT_OPERATIONS.has(fieldResolution.operation) ||
        !fieldResolution.executionContractId || !fieldResolution.approvalRevision || !fieldResolution.targetingSnapshotId) {
      reject("An approved execution-phase write resolution is required");
    }
    for (const key of ["shopId", "operation", "operationId", "phase", "generationId", "coverageRevision",
      "targetingSnapshotId", "executionContractId", "approvalRevision", "mirrorSchemaVersion", "sourceContractVersion"]) {
      if (fieldResolution[key] !== filter[key]) reject(`Field/filter execution binding mismatch: ${key}`);
    }
    // executionJobId is not operationId. The repository must load the job
    // and verify its relationship to this approved operation/contract.
    const field = fieldResolution.fields.find(entry => entry.id === identity.fieldId);
    if (!field) reject("History field is absent from the issued field resolution");
    const binding = normalizeHistoryBinding({
      mode: "MIRROR_PINNED",
      filterFingerprint: engineDigest(fingerprintFilterAst(filter.ast)),
      executionFingerprint: engineDigest(filter.fingerprint),
      fieldResolutionFingerprint: engineDigest(fieldResolution.registryVersion),
      fieldDefinitionRevision: field.origin === "canonical"
        ? String(CANONICAL_REGISTRY_INFO.registryVersion) : field.source.definitionRevision,
      generationId: fieldResolution.generationId,
      coverageRevision: fieldResolution.coverageRevision,
      mappingVersion: fieldResolution.registryVersion,
    });
    return { identity, binding, field };
  }

  function value(input, field, context, shopId) {
    if (input.valueKind === "ABSENT") {
      if (Object.hasOwn(input, "value")) reject("Absent values cannot carry a value");
      // Canonical columns have null/value semantics; absence requires an
      // explicitly resolved dynamic field, not a missing/undefined column.
      if (field.origin !== "dynamic") reject("Canonical fields cannot be absent");
      return { valueKind: "ABSENT" };
    }
    if (input.valueKind !== "VALUE" || !Object.hasOwn(input, "value")) reject("A field value is required");
    const policy = getResolvedFieldPolicy(field, context, { shopId });
    return { valueKind: "VALUE", value: normalizeFieldValue(field.field, input.value, { constraints: policy.constraints }) };
  }

  return Object.freeze({
    async createSnapshot(raw) {
      const input = data(raw, [...CONTEXT_KEYS, "kind", "valueKind", "value", "observation"]);
      const { identity, binding, field } = await resolve(input);
      return normalizeHistorySnapshot({ identity, binding, kind: input.kind,
        ...value(input, field, "read", identity.shopId), observation: input.observation });
    },
    async createIntent(raw) {
      const input = data(raw, [...CONTEXT_KEYS, "beforeSnapshot", "valueKind", "value", "mutationPlanFingerprint"]);
      const { identity, binding, field } = await resolve(input);
      const normalized = value(input, field, "write", identity.shopId);
      const intent = normalizeMutationIntent({ identity, binding,
        beforeSnapshotFingerprint: input.beforeSnapshot?.fingerprint,
        intendedValueKind: normalized.valueKind,
        ...(Object.hasOwn(normalized, "value") ? { intendedValue: normalized.value } : {}),
        // This plan belongs to the execution engine, not the Field/Filter
        // Engines. Its durable issuance is still the repository's obligation.
        mutationPlanFingerprint: input.mutationPlanFingerprint });
      assertSnapshotIntentConsistency({ beforeSnapshot: input.beforeSnapshot, intent });
      return intent;
    },
  });
}
