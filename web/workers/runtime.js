import "../env.js";
import { prisma, connectDatabase, disconnectDatabase } from "../db/client.js";
import { startScanner } from "./reconcile.scanner.js";
import { scanDirtyChanges } from "./reconcile.scanner.js";
import { scanDirtyInventoryChanges } from "./reconcile.scanner.js";
import { inventoryQueue } from "../queues/inventory.queue.js";
import { createInventoryWorker } from "./inventory.worker.js";
import { createSyncWorker } from "./sync.worker.js";
import { scanDueSyncRuns } from "../domains/sync/sync.scanner.js";
import { scanInitialSyncRequests } from "../domains/sync/initial-sync.consumer.js";
import { repairShopRegistrations } from "./registration-repair.js";
import { reconcileQueue } from "../queues/reconcile.queue.js";
import { syncQueue } from "../queues/sync.queue.js";
import { closeGraphqlBudget } from "../integrations/shopify/graphql-budget.js";
import { closeGraphqlSessions } from "../integrations/shopify/graphql.js";
import { startRetention } from "./retention.js";
import { readWorkerConfig } from "./reconcile.config.js";

export async function startWorkerRuntime({ createWorker }) {
  const config = readWorkerConfig();
  await connectDatabase();
  // Fail startup if the migration was not deployed.
  await Promise.all([
    prisma.catalogChange.findFirst({
      select: {
        shop: true,
        leaseToken: true,
        leasedUntil: true,
        waitingForSnapshot: true,
      },
    }),
    prisma.shop.findFirst({ select: { activeSnapshotId: true } }),
    prisma.snapshotRun.findFirst({
      select: { leaseToken: true, leasedUntil: true, nextCheckAt: true, exportName: true },
    }),
    prisma.snapshotChange.findFirst({ select: { appliedRevision: true } }),
    prisma.catalogSyncState.findFirst({ select: { shop: true } }),
    prisma.initialSyncRequest.findFirst({ select: { generation: true, leaseToken: true } }),
    prisma.installationState.findFirst({ select: { shopHash: true } }),
    prisma.inventoryChange.findFirst({
      select: { revision: true, leaseToken: true },
    }),
    prisma.snapshotInventoryChange.findFirst({
      select: { appliedRevision: true },
    }),
  ]);
  const worker = createWorker({ concurrency: config.concurrency });
  const inventoryWorker = createInventoryWorker({
    concurrency: config.concurrency,
  });
  const syncWorker = createSyncWorker();
  worker.on("failed", (job, error) =>
    console.error("[reconcile-worker] Job failed", job?.id, error.message)
  );
  const stopScanner = startScanner({
    scan: async () => {
      await repairShopRegistrations();
      await scanInitialSyncRequests().catch((error) =>
        console.error("[initial-sync] Scanner failed:", error.message)
      );
      await scanDueSyncRuns().catch((error) =>
        console.error("[sync-scanner] Pass failed:", error.message)
      );
      return Promise.all([scanDirtyChanges(), scanDirtyInventoryChanges()]);
    },
  });
  const stopRetention = startRetention();
  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(
      () => process.exit(1),
      config.shutdownTimeoutMs
    );
    deadline.unref();
    // close() stops new claims while in-flight jobs drain. Keep Redis and the
    // database available until those jobs and scheduled tasks have finished.
    await Promise.all([
      stopScanner(),
      stopRetention(),
      typeof worker.stopRepair === "function"
        ? worker.stopRepair()
        : Promise.resolve(),
      worker.close(),
      inventoryWorker.close(),
      syncWorker.close(),
    ]);
    await reconcileQueue.close();
    await inventoryQueue.close();
    await syncQueue.close();
    await closeGraphqlBudget();
    await closeGraphqlSessions();
    await disconnectDatabase();
    clearTimeout(deadline);
  }
  process.once("SIGTERM", () => shutdown().catch(() => process.exit(1)));
  process.once("SIGINT", () => shutdown().catch(() => process.exit(1)));
  console.log("Reconciliation worker and durable recovery scanner started.");

  return shutdown;
}
