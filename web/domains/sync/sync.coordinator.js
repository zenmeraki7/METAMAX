import { prisma } from "../../db/client.js";
import {
  sealCatalogSnapshot,
  publishCatalogSnapshot,
} from "../snapshots/snapshots.service.js";
import {
  claimSnapshotLease,
  releaseSnapshotLease,
  syncError,
} from "./sync.lease.js";
import {
  applySnapshotChanges,
  applySnapshotInventoryChanges,
} from "./sync.changes.js";
export async function finishSnapshot(...args) {
  return (await import("./sync.worker.js")).finishSnapshot(...args);
}

// Importers/CLI resume a sealed run with a new claim. This shares the same lease
// policy as batch heartbeats, and never starts a competing renewal timer.
export async function reconcileAndPublishSnapshot(args, options = {}) {
  const run = await prisma.snapshotRun.findUnique({
    where: { id: args.runId },
  });
  if (!run || run.shop !== args.shop || run.generation !== args.generation)
    throw syncError(
      "SYNC_RUN_NOT_ACTIVE",
      "Installation changed or snapshot belongs to another shop"
    );
  if (run.status === "COMPLETED") return publishCatalogSnapshot(args, options);
  if (run.status === "INGESTING") await sealCatalogSnapshot(args);
  const maxBatches = options.maxBatches ?? 100;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000)
    throw RangeError("maxBatches must be between 1 and 1000");
  const { token } = await claimSnapshotLease(run);
  let originalError;
  try {
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await applySnapshotChanges(
        run,
        token,
        options.batchSize ?? 25,
        options
      );
      const inventory = await applySnapshotInventoryChanges(
        run,
        token,
        options.batchSize ?? 25,
        options
      );
      if (inventory.fetched !== 0) continue;
      if (result.fetched !== 0) continue;
      try {
        return await publishCatalogSnapshot(
          { ...args, leaseToken: token },
          options
        );
      } catch (error) {
        if (error.code !== "SNAPSHOT_CHANGES_PENDING") throw error;
        // A webhook may commit between the empty batch and the exclusive barrier.
      }
    }
    throw syncError(
      "SNAPSHOT_BATCH_LIMIT",
      "Snapshot is still changing; resume reconciliation later"
    );
  } catch (error) {
    originalError = error;
    throw error;
  } finally {
    try {
      await releaseSnapshotLease(run, token);
    } catch (releaseError) {
      if (originalError)
        throw new AggregateError(
          [originalError, releaseError],
          "Sync failed and lease release failed"
        );
      // A successful publication has already cleared the lease. An ambiguous
      // release failure must not turn that durable publication into a failure.
      console.error(
        "[snapshot] Lease release failed; ownership expires:",
        releaseError.message
      );
    }
  }
}
