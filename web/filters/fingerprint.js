import { createHash } from "node:crypto";
import { serializeCanonicalFilter } from "./serialization.js";
import { FILTER_NULL_SEMANTICS_VERSION } from "./semantics.js";
import { isPlainObject, isDynamicMetafieldId } from "../fields/types.js";
import { parseFilterAst, inspectFilterAst } from "./ast.js";
import { FILTER_VALIDATION_VERSION } from "./contracts.js";
import { CANONICAL_REGISTRY_INFO } from "../fields/canonical.js";
import { OPERATOR_CONTRACT_VERSION } from "../fields/operators.js";
import { FILTER_BINDING_VERSION } from "./bindings.js";
import { METAFIELD_DEFINITION_TOKEN_PATTERN } from "../fields/metafield-identity.js";
import { NORMALIZE_CONTRACT_VERSION } from "../fields/normalize.js";
import { CONSTRAINTS_VERSION } from "../fields/constraints.js";

// v3 adds normalization/policy and persisted execution approval identities.
export const FILTER_FINGERPRINT_VERSION = 3;
function hash(domain, value) {
  return createHash("sha256").update(`metamax:${domain}:v${FILTER_FINGERPRINT_VERSION}:`, "utf8").update(value, "utf8").digest("hex");
}

/** Content identity only. Never use as an authorization grant or auth-cache key. */
export function fingerprintFilterAst(input) {
  return hash("ast", serializeCanonicalFilter(input));
}
export const fingerprintFilter = fingerprintFilterAst;

/** Pure correlation identity; does not issue validated-filter provenance. */
export function fingerprintBoundFilter(input, binding) {
  const keys = ["shopId", "operation", "operationId", "generationId", "coverageRevision", "registryVersion", "targetingSnapshotId"];
  const result = ownData(binding, [...keys, "definitionRevisions"], keys);
  return fingerprintFilterExecution({ ast: input, ...result,
    validationVersion: FILTER_VALIDATION_VERSION, astVersion: parseFilterAst(input).version,
    canonicalVersion: CANONICAL_REGISTRY_INFO.registryVersion, operatorVersion: OPERATOR_CONTRACT_VERSION,
    bindingVersion: FILTER_BINDING_VERSION,
  });
}

const TOKEN = /^[A-Za-z0-9_-]{1,256}$/;
const OPERATIONS = new Set(["filter", "export", "import", "bulk_edit", "scheduled_edit", "recurring_edit", "undo"]);
const EXECUTION_KEYS = ["ast", "shopId", "operation", "operationId", "generationId", "coverageRevision", "registryVersion", "targetingSnapshotId", "validationVersion", "astVersion", "canonicalVersion", "operatorVersion", "bindingVersion", "definitionRevisions", "mirrorSchemaVersion", "sourceContractVersion", "normalizationVersion", "constraintsVersion", "executionContractId", "approvalRevision"];

function ownData(raw, allowed, required = allowed) {
  if (!isPlainObject(raw)) throw new TypeError("Invalid fingerprint metadata");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== "string" || !allowed.includes(key) || !descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("Unsupported fingerprint property or accessor");
    }
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) throw new TypeError("Missing fingerprint metadata");
  return result;
}
function identity(value, label) {
  if (typeof value !== "string" || !value || value.length > 255 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}
function requireShopIdentity(value) {
  return identity(value, "shop identity");
}
function token(value, label) {
  if (typeof value !== "string" || value.trim() !== value || !TOKEN.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid contract version");
  return value;
}
function canonicalRevisions(raw, ast) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > 1000 ||
      Reflect.ownKeys(raw).length !== raw.length + 1) throw new TypeError("Invalid definition revisions");
  const seen = new Set(), result = [];
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Sparse or accessor-backed revisions");
    const entry = ownData(descriptor.value, ["fieldId", "definitionToken"]);
    if (!isDynamicMetafieldId(entry.fieldId) || seen.has(entry.fieldId)) throw new TypeError("Invalid or duplicate revision field");
    if (typeof entry.definitionToken !== "string" || !METAFIELD_DEFINITION_TOKEN_PATTERN.test(entry.definitionToken)) {
      throw new TypeError("Invalid definition token");
    }
    seen.add(entry.fieldId);
    result.push({ fieldId: entry.fieldId, definitionToken: token(entry.definitionToken, "definition token") });
  }
  result.sort((a, b) => a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0);
  const expected = inspectFilterAst(ast).fieldIds.filter(isDynamicMetafieldId).sort();
  if (expected.length !== result.length || expected.some((id, index) => id !== result[index].fieldId)) {
    throw new TypeError("Dynamic definition revision mismatch");
  }
  return result;
}

/** Pure hash helper, not proof of authentic metadata or current revision tokens.
 * Production options must be constructed from authorized server resolution.
 */
export function fingerprintFilterExecution(raw) {
  const options = ownData(raw, [...EXECUTION_KEYS, "phase"], ["ast", "shopId", "operation", "generationId", "coverageRevision", "validationVersion", "astVersion", "canonicalVersion", "operatorVersion", "bindingVersion"]);
  const ast = parseFilterAst(options.ast);
  if (!OPERATIONS.has(options.operation)) throw new TypeError("Invalid filter operation");
  const phase = options.phase === undefined ? "execute" : options.phase;
  if (phase !== "preview" && phase !== "execute") throw new TypeError("Invalid execution phase");
  if (version(options.astVersion) !== ast.version) throw new TypeError("AST contract version mismatch");
  const metadata = {
    fingerprintVersion: FILTER_FINGERPRINT_VERSION, astHash: fingerprintFilterAst(ast),
    shopId: requireShopIdentity(options.shopId), operation: options.operation, phase,
    operationId: options.operationId === undefined ? null : identity(options.operationId, "operation identity"),
    generationId: token(options.generationId, "generation"), coverageRevision: token(options.coverageRevision, "coverage revision"),
    registryVersion: options.registryVersion === undefined ? null : identity(options.registryVersion, "registry version"),
    targetingSnapshotId: options.targetingSnapshotId == null ? null : identity(options.targetingSnapshotId, "targeting snapshot"),
    executionContractId: options.executionContractId == null ? null : identity(options.executionContractId, "execution contract"),
    approvalRevision: options.approvalRevision == null ? null : token(options.approvalRevision, "approval revision"),
    mirrorSchemaVersion: options.mirrorSchemaVersion == null ? null : token(options.mirrorSchemaVersion, "mirror schema version"),
    sourceContractVersion: options.sourceContractVersion == null ? null : token(options.sourceContractVersion, "source contract version"),
    versions: { validation: version(options.validationVersion), ast: options.astVersion,
      canonical: version(options.canonicalVersion), operators: version(options.operatorVersion),
      bindings: version(options.bindingVersion), nullSemantics: FILTER_NULL_SEMANTICS_VERSION,
      normalization: version(options.normalizationVersion === undefined ? NORMALIZE_CONTRACT_VERSION : options.normalizationVersion),
      constraints: version(options.constraintsVersion === undefined ? CONSTRAINTS_VERSION : options.constraintsVersion) },
    definitionRevisions: canonicalRevisions(options.definitionRevisions === undefined ? [] : options.definitionRevisions, ast),
  };
  return hash("execution", JSON.stringify(metadata));
}
