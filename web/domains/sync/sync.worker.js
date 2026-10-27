import {
  applySnapshotChanges,
  applySnapshotInventoryChanges,
} from "./sync.changes.js";

import { publishRun } from "./sync.repository.js";

import { finalizeSnapshot } from "./sync.service.js";

import { releaseSnapshotLease } from "./sync.lease.js";

/**
 * Called only after:
 * - Shopify bulk operation is finished
 * - JSONL ingestion is fully committed
 * - The owned run is RECONCILING
 */
export async function finishSnapshot(run, token, expectedLines, options = {}) {
  const MAX_ROUNDS = options.maxRounds ?? 1000;
  const BATCH_SIZE = options.batchSize ?? 25;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = await applySnapshotChanges(run, token, BATCH_SIZE, options);

    // More staged changes were observed.
    // Continue draining before publication.
    const inventory = await applySnapshotInventoryChanges(
      run,
      token,
      BATCH_SIZE,
      options
    );
    if (inventory.fetched > 0) continue;
    if (result.fetched > 0) {
      continue;
    }

    try {
      return await publishRun(run, token, expectedLines);
    } catch (error) {
      if (error?.code === "SNAPSHOT_CHANGES_PENDING") {
        // A webhook committed between the
        // empty scan and publication attempt.
        continue;
      }

      throw error;
    }
  }

  const error = new Error("Snapshot reconciliation exceeded its drain budget");

  error.code = "SNAPSHOT_DRAIN_BUDGET_EXCEEDED";

  throw error;
}

/**
 * Worker process handler for a sync run.
 * Dispatches based on run status.
 */
export async function processSync(run, token, options = {}) {
  let leaseManagedByFinalizer = false;

  try {
    // Add this branch before the existing WAITING / INGESTING handling:
    if (run.status === "RECONCILING") {
      leaseManagedByFinalizer = true;
      return await finalizeSnapshot(run, token, options);
    }

    if (run.status === "WAITING") {
      if (typeof options.handleWaiting === "function") {
        return await options.handleWaiting(run, token);
      }
      return { status: "WAITING" };
    }

    if (run.status === "INGESTING") {
      if (typeof options.handleIngesting === "function") {
        return await options.handleIngesting(run, token);
      }
      return { status: "INGESTING" };
    }

    throw new Error(`Unsupported sync run status: ${run.status}`);
  } finally {
    // Coordinate lease release with continueReconciliation():
    // The finalizer intentionally releases the lease when yielding or completing,
    // so RECONCILING runs must not have their lease released here.
    if (!leaseManagedByFinalizer && options.releaseLeaseOnFinish) {
      try {
        await releaseSnapshotLease(run, token);
      } catch (releaseErr) {
        console.error("[processSync] Lease release error:", releaseErr.message);
      }
    }
  }
}
