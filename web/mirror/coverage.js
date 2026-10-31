import {
  FieldError,
  FIELD_ERROR_CODES as C,
  isPlainObject,
  deepFreeze,
} from "../fields/types.js";
import { currentCoverageTransaction } from "./coverage-transaction.server.js";

const MAX_DATASETS = 32;
const DATASET_PATTERN = /^[a-z][a-z0-9_]*$/;

function readRecord(raw, keys) {
  if (!isPlainObject(raw)) return null;
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function readArray(raw) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype ||
      raw.length > MAX_DATASETS) return null;
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== raw.length + 1 || keys[raw.length] !== "length") return null;
  const items = [];
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (keys[index] !== String(index) || !descriptor || !Object.hasOwn(descriptor, "value")) return null;
    items.push(descriptor.value);
  }
  return items;
}

function validIdentity(value, maximum) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximum && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function fail(message) {
  throw new FieldError(
    C.MISSING_DEPENDENCY,
    message
  );
}

function validateDatasets(datasets) {
  if (
    !Array.isArray(datasets) ||
    datasets.length > MAX_DATASETS
  ) {
    return false;
  }

  const seen = new Set();

  for (let i = 0; i < datasets.length; i++) {
    const value = datasets[i];

    if (
      !Object.hasOwn(datasets, i) ||
      typeof value !== "string" ||
      value.length > 128 ||
      !DATASET_PATTERN.test(value) ||
      seen.has(value)
    ) {
      return false;
    }

    seen.add(value);
  }

  return true;
}

/**
 * Repository contract:
 *
 * repository.getPublishedSnapshot({
 *   shopId,
 *   generationId,
 *   datasets
 *   targetingSnapshotId // when an approved targeting snapshot is required
 * })
 *
 * Must read publication and coverage data from
 * a transactionally consistent database view.
 *
 * Return:
 * {
 *   shopId,
 *   generationId,
 *   coverageRevision, // required for getVerifiedCoverage receipts
 *   status: "PUBLISHED",
 *   targetingSnapshot: { // required when targetingSnapshotId is requested
 *     id, shopId, generationId, coverageRevision, status: "APPROVED", datasets
 *   },
 *   datasets: [
 *     {
 *       name,
 *       generationId,
 *       status: "COMPLETE",
 *       published: true
 *     }
 *   ]
 * }
 *
 * A valid result must represent a snapshot whose
 * publication barrier has committed.
 * The targeting record must be loaded from stored approval data, never echoed
 * from the request. Read it in the same consistent view as generation metadata.
 */
export function createMirrorCoverageService({
  repository,
} = {}) {
  if (
    !repository ||
    typeof repository.getPublishedSnapshot !== "function"
  ) {
    throw new TypeError(
      "Mirror coverage repository required"
    );
  }

  async function checkCoverage(options, withReceipt = false) {
    const input = readRecord(options, ["shopId", "datasets", "executionContext"]);
    if (!input) return false;
    const { shopId } = input;
    // Capture trusted execution identity and a defensive dataset copy before
    // awaiting the repository. Later request mutations cannot change the check.
    const datasets = readArray(input.datasets);
    const executionContext = readRecord(input.executionContext, ["generationId"]);
    if (
      !validIdentity(shopId, 255) ||
      !datasets ||
      !validateDatasets(datasets)
    ) {
      return false;
    }

    if (
      !executionContext ||
      !validIdentity(executionContext.generationId, 128)
    ) {
      return false;
    }

    const generationId =
      executionContext.generationId;
    const revisionDescriptor = Object.getOwnPropertyDescriptor(input.executionContext, "coverageRevision");
    if (revisionDescriptor && (!Object.hasOwn(revisionDescriptor, "value") ||
        !validIdentity(revisionDescriptor.value, 128))) return false;
    const expectedRevision = revisionDescriptor?.value;
    const targetingDescriptor = Object.getOwnPropertyDescriptor(input.executionContext, "approvedTargetingSnapshot");
    let approvedTarget = null;
    if (targetingDescriptor) {
      if (!Object.hasOwn(targetingDescriptor, "value")) return false;
      approvedTarget = readRecord(targetingDescriptor.value, ["snapshotId", "shopId", "generationId", "coverageRevision"]);
      if (!approvedTarget || !validIdentity(approvedTarget.snapshotId, 128) ||
          approvedTarget.shopId !== shopId || approvedTarget.generationId !== generationId ||
          !validIdentity(approvedTarget.coverageRevision, 128) ||
          (expectedRevision !== undefined && approvedTarget.coverageRevision !== expectedRevision)) return false;
    }

    const rawSnapshot =
      await repository.getPublishedSnapshot({
        shopId,
        generationId,
        datasets: Object.freeze([...datasets]),
        ...(currentCoverageTransaction() ? { client: currentCoverageTransaction() } : {}),
        ...(approvedTarget ? { targetingSnapshotId: approvedTarget.snapshotId } : {}),
      });

    const snapshot = readRecord(rawSnapshot, ["shopId", "generationId", "status", "datasets"]);

    if (
      !snapshot ||
      snapshot.shopId !== shopId ||
      snapshot.generationId !== generationId ||
      snapshot.status !== "PUBLISHED" ||
      !Array.isArray(snapshot.datasets)
    ) {
      return false;
    }

    const coverageRows = readArray(snapshot.datasets);
    if (!coverageRows || coverageRows.length !== datasets.length) return false;

    const expected = new Set(datasets);
    const confirmed = new Set();

    for (const rawDataset of coverageRows) {
      const dataset = readRecord(rawDataset, ["name", "generationId", "status", "published"]);
      if (
        !dataset ||
        typeof dataset.name !== "string" ||
        !expected.has(dataset.name) ||
        confirmed.has(dataset.name) ||
        dataset.generationId !== generationId ||
        dataset.status !== "COMPLETE" ||
        dataset.published !== true
      ) {
        return false;
      }

      confirmed.add(dataset.name);
    }

    if (confirmed.size !== expected.size) return false;
    const revision = readRecord(rawSnapshot, ["coverageRevision"]);
    if (expectedRevision !== undefined && revision?.coverageRevision !== expectedRevision) return false;
    if (approvedTarget) {
      // The repository must return this approved record from the same
      // transactionally consistent view as publication and coverage metadata.
      const targetContainer = readRecord(rawSnapshot, ["targetingSnapshot"]);
      const target = readRecord(targetContainer?.targetingSnapshot,
        ["id", "shopId", "generationId", "coverageRevision", "status", "datasets"]);
      const targetDatasets = target && readArray(target.datasets);
      if (!target || target.id !== approvedTarget.snapshotId || target.shopId !== shopId ||
          target.status !== "APPROVED" || target.generationId !== generationId ||
          target.coverageRevision !== approvedTarget.coverageRevision ||
          target.coverageRevision !== revision?.coverageRevision ||
          !targetDatasets || !validateDatasets(targetDatasets) ||
          datasets.some(name => !targetDatasets.includes(name))) return false;
    }
    if (!withReceipt) return true;
    if (!revision || !validIdentity(revision.coverageRevision, 128)) return false;
    const compatibility = readRecord(rawSnapshot, ["mirrorSchemaVersion", "sourceContractVersion"]);
    const hasCompatibility = Object.hasOwn(rawSnapshot, "mirrorSchemaVersion") || Object.hasOwn(rawSnapshot, "sourceContractVersion");
    if (hasCompatibility && (!compatibility || !validIdentity(compatibility.mirrorSchemaVersion, 80) ||
        !validIdentity(compatibility.sourceContractVersion, 80))) return false;
    return deepFreeze({ ready: true, generationId, coverageRevision: revision.coverageRevision,
      ...(approvedTarget ? { targetingSnapshotId: approvedTarget.snapshotId } : {}),
      ...(compatibility ?? {}),
    });
  }

  const verifyCoverage = options => checkCoverage(options);

  return Object.freeze({
    verifyCoverage,
    // Receipt and publication data are checked from the same repository read.
    getVerifiedCoverage: options => checkCoverage(options, true),

    async requireCoverage(options) {
      const valid = await verifyCoverage(options);

      if (!valid) {
        fail(
          "Required published mirror coverage unavailable"
        );
      }

      return true;
    },
  });
}
