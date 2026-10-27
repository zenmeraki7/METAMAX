import { prisma } from "../db/client.js";
import {
  enqueueProductChange,
  reconcileQueue,
} from "../queues/reconcile.queue.js";
import { readWorkerConfig, positiveInteger } from "./reconcile.config.js";
import {
  inventoryQueue,
  enqueueInventoryChange,
} from "../queues/inventory.queue.js";

// Each process rotates through due shops. Database leases remain authoritative;
// the queue count is a soft cap shared with other scanner and HTTP producers.
export function createDirtyScanner(defaults = {}) {
  const inventory = defaults.resource === "inventory";
  const idField = inventory ? "inventoryItemId" : "productId";
  let afterShop = "";
  return async function scan(options = {}) {
    const config = readWorkerConfig();
    const {
      db = prisma,
      enqueue = inventory ? enqueueInventoryChange : enqueueProductChange,
      queue = inventory ? inventoryQueue : reconcileQueue,
      shopsPerScan = config.shopsPerScan,
      productsPerShop = config.productsPerShop,
      maxQueuedJobs = config.maxQueuedJobs,
      scanLimit = config.scanLimit,
      // Compatibility for earlier callers that set the product batch size.
      batchSize = productsPerShop,
    } = { ...defaults, ...options };
    const ledger = inventory ? db.inventoryChange : db.catalogChange;
    positiveInteger(shopsPerScan, "shopsPerScan");
    positiveInteger(batchSize, "productsPerShop");
    positiveInteger(maxQueuedJobs, "maxQueuedJobs");
    positiveInteger(scanLimit, "scanLimit");
    const counts = await queue.getJobCounts(
      "wait",
      "active",
      "delayed",
      "prioritized",
      "waiting-children",
      "paused"
    );
    const depth = Object.values(counts).reduce((sum, count) => sum + count, 0);
    let capacity = Math.min(scanLimit, Math.max(0, maxQueuedJobs - depth));
    if (!capacity) return 0;
    const now = new Date();
    const due = {
      dirty: true,
      deadLetterAt: null,
      merchant: { status: "ACTIVE", activeSnapshotId: { not: null } },
      AND: [
        inventory
          ? { nextAttemptAt: { lte: now } }
          : { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { OR: [{ leasedUntil: null }, { leasedUntil: { lte: now } }] },
      ],
    };
    // GROUP BY bounds the result in Postgres instead of fetching every product
    // and deduplicating shops in application memory.
    const shops = await ledger.groupBy({
      by: ["shop"],
      where: { ...due, shop: { gt: afterShop } },
      orderBy: { shop: "asc" },
      take: shopsPerScan,
    });
    if (shops.length < shopsPerScan && afterShop) {
      shops.push(
        ...(await ledger.groupBy({
          by: ["shop"],
          where: { ...due, shop: { lte: afterShop } },
          orderBy: { shop: "asc" },
          take: shopsPerScan - shops.length,
        }))
      );
    }
    const batches = [];
    for (const { shop } of shops) {
      batches.push(
        await ledger.findMany({
          where: { ...due, shop },
          orderBy: [{ updatedAt: "asc" }, { [idField]: "asc" }],
          take: Math.min(batchSize, capacity),
          select: { shop: true, [idField]: true, revision: true },
        })
      );
    }
    let scheduled = 0;
    outer: for (let round = 0; round < batchSize; round++) {
      for (let i = 0; i < shops.length; i++) {
        const row = batches[i][round];
        if (!row) continue;
        await enqueue(row.shop, row[idField], row.revision.toString());
        scheduled++;
        capacity--;
        afterShop = row.shop;
        if (!capacity) break outer;
      }
    }
    if (!shops.length) afterShop = "";
    return scheduled;
  };
}

export const scanDirtyChanges = createDirtyScanner();
export const scanDirtyInventoryChanges = createDirtyScanner({
  resource: "inventory",
});

export function startScanner({
  intervalMs = readWorkerConfig().scanIntervalMs,
  scan = scanDirtyChanges,
} = {}) {
  let stopped = false;
  let timer;
  let pending;
  const tick = () => {
    pending = Promise.resolve()
      .then(scan)
      .catch((error) => {
        console.error("[recovery-scanner] Pass failed:", error.message);
      })
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
