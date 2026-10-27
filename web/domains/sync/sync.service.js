import { prisma } from "../../db/client.js";
import { sealCatalogSnapshot } from "../snapshots/snapshots.service.js";
import { validateRun, validateToken } from "./sync.lease.js";
import {
  applySnapshotChanges,
  applySnapshotInventoryChanges,
} from "./sync.changes.js";
import { publishRun } from "./sync.repository.js";
import {
  claimSnapshotLease,
  releaseSnapshotLease,
  renewSnapshotLease,
  syncError,
} from "./sync.lease.js";

export { processSync } from "./sync.worker.js";
export {
  findDueSyncRuns,
  createSyncScanner,
  scanDueSyncRuns,
} from "./sync.scanner.js";
export { syncQueue, enqueueSyncRun } from "./sync.queue.js";
export { readActiveCatalogCounts } from "./sync.routes.js";
export { ACTIVE } from "./sync.repository.js";
export { requestPeriodicFullSnapshot } from "../../workers/reconcile.worker.js";

export const RECONCILE_BATCH_SIZE = 25;

export function syncFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Transition only after the JSONL importer
 * confirms all database writes are committed.
 *
 * The processed line count must already have
 * been persisted by the ingestion engine.
 */
export async function enterReconciliation(run, token, importedLines) {
  if (
    !(typeof importedLines === "bigint" && importedLines >= 0n) &&
    !(
      typeof importedLines === "number" &&
      Number.isSafeInteger(importedLines) &&
      importedLines >= 0
    )
  ) {
    throw new TypeError("Invalid committed import line count");
  }

  validateRun(run);
  validateToken(token);
  const stored = await prisma.snapshotRun.findUnique({
    where: { id: run.id },
    select: { shop: true, generation: true },
  });
  if (!stored || stored.shop !== run.shop || !stored.generation)
    throw syncFailure(
      "INGESTION_FINALIZATION_FAILED",
      "Import ownership changed"
    );
  await sealCatalogSnapshot({
    shop: run.shop,
    generation: run.generation ?? stored.generation,
    runId: run.id,
    leaseToken: token,
    committedProducts: importedLines,
  });

  return {
    status: "RECONCILING",
  };
}

/**
 * Yield the run to the recovery scheduler.
 *
 * Merely updating nextCheckAt is insufficient
 * if the existing lease remains active.
 *
 * This operation atomically:
 * - verifies run ownership
 * - preserves RECONCILING state
 * - schedules the next pass
 * - releases the current lease
 */
export async function continueReconciliation(run, token, reason) {
  const now = new Date();
  const syncRun = prisma.syncRun || prisma.snapshotRun;
  const syncRunFields = syncRun?.fields || {};

  const updated = await syncRun.updateMany({
    where: {
      id: run.id,
      shop: run.shop,
      status: "RECONCILING",
      leaseToken: token,

      leasedUntil: {
        gt: now,
      },
    },

    data: {
      ...("nextCheckAt" in syncRunFields ? { nextCheckAt: now } : {}),
      attempts: 0,
      lastError: null,
      leaseToken: null,
      leasedUntil: null,
    },
  });

  if (updated.count !== 1) {
    throw syncFailure(
      "SYNC_LEASE_LOST",
      "Cannot schedule reconciliation continuation"
    );
  }

  return {
    status: "CONTINUE",
    reason,
  };
}

/**
 * Apply one bounded staging reconciliation batch,
 * then attempt publication when appropriate.
 *
 * A publish attempt is authoritative:
 * publishRun locks the Shop row and verifies
 * that no dirty SnapshotChange remains.
 */
export async function finalizeSnapshot(run, token, options = {}) {
  const result = await applySnapshotChanges(run, token, RECONCILE_BATCH_SIZE, options);

  /**
   * A full batch may mean more work remains.
   *
   * A superseded row also requires another
   * opportunity to read the latest revision.
   *
   * Continue instead of running an unbounded
   * reconciliation loop in one BullMQ job.
   */
  const inventory = await applySnapshotInventoryChanges(
    run,
    token,
    RECONCILE_BATCH_SIZE,
    options
  );
  if (inventory.fetched === RECONCILE_BATCH_SIZE || inventory.superseded > 0) {
    return continueReconciliation(run, token, "INVENTORY_CHANGES_REMAIN");
  }

  if (result.fetched === RECONCILE_BATCH_SIZE || result.superseded > 0) {
    return continueReconciliation(run, token, "STAGED_CHANGES_REMAIN");
  }

  /**
   * Refresh durable run state before publication.
   *
   * The previously captured run object may
   * contain outdated ingestion progress.
   */
  const syncRun = prisma.syncRun || prisma.snapshotRun;
  const syncRunFields = syncRun?.fields || {};

  const fresh = await syncRun.findUnique({
    where: {
      id: run.id,
    },

    select: {
      id: true,
      shop: true,
      status: true,
      ...("processedLines" in syncRunFields
        ? { processedLines: true }
        : { importedProducts: true }),
    },
  });

  if (!fresh || fresh.shop !== run.shop || fresh.status !== "RECONCILING") {
    throw syncFailure(
      "SYNC_STATE_CHANGED",
      "Run is no longer eligible for publication"
    );
  }

  try {
    /**
     * The publication transaction performs:
     *
     * 1. Exclusive Shop lock
     * 2. Zero-dirty-change verification
     * 3. Sync lease and ingestion-count fence
     * 4. Atomic active snapshot switch
     *
     * A successful return means the new
     * snapshot is durably published.
     */
    return await publishRun(
      fresh,
      token,
      fresh.processedLines ?? fresh.importedProducts
    );
  } catch (error) {
    /**
     * Another webhook may have committed
     * after our last reconciliation read.
     *
     * That is expected concurrency,
     * not a failed synchronization.
     */
    if (error?.code === "SNAPSHOT_CHANGES_PENDING") {
      return continueReconciliation(run, token, "NEW_WEBHOOK_CHANGES");
    }

    throw error;
  }
}

/**
 * Handle bulk operation completion:
 * Fences completed ingestion into RECONCILING, then finalizes the snapshot.
 */
export async function checkBulk(freshRun, token, imported) {
  const lines =
    typeof imported === "object" && imported !== null && "lines" in imported
      ? imported.lines
      : imported;

  // Branch on persisted run status if partially finalized
  if (freshRun.status === "INGESTING") {
    // All importer writes must already be committed.
    await enterReconciliation(freshRun, token, lines);
  }

  return finalizeSnapshot(freshRun, token);
}
