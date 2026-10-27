import "../env.js";
import { Worker } from "bullmq";
import { consumerRedis } from "../integrations/redis/connection.js";
import {
  RECONCILE_QUEUE,
  RECONCILE_PREFIX,
} from "../queues/reconcile.queue.js";
import { fetchCurrentProduct } from "../domains/products/products.service.js";
import { reconcileProduct } from "../domains/webhooks/webhooks.service.js";
import { readWorkerConfig, positiveInteger } from "./reconcile.config.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reserveCatalogSync } from "../domains/sync/sync.request.js";
import { syncTransaction } from "../domains/sync/sync.lease.js";
import { enqueueSyncRun } from "../queues/sync.queue.js";
import { startCatalogRepairScheduler } from "../domains/repair/repair.scheduler.js";

export {
  calculateBackoff,
  MAX_RECONCILIATION_ATTEMPTS,
} from "../domains/webhooks/webhooks.service.js";

export async function defaultFetchProduct(shop, productId, context = {}) {
  return fetchCurrentProduct(shop, productId, context);
}

// Queued revisions are scheduling signals; the service claims current Neon state.
export async function processReconciliationJob(jobData, options = {}) {
  return reconcileProduct(jobData?.shop, jobData?.productId, {
    ...options,
    fetchProduct: options.fetchProduct || defaultFetchProduct,
  });
}

/**
 * Adapter to request a periodic full snapshot run.
 * Atomically verifies shop ownership, creates the durable SyncRun (status PENDING),
 * assigns Shop.activeRunId, and enqueues to the sync queue.
 */
export async function requestPeriodicFullSnapshot(shop, { reason } = {}) {
  const run = await syncTransaction(
    async (tx) => {
      // 1. Atomically ensure this shop has no other active full-sync run.
      const shops = await tx.$queryRaw`
        SELECT "domain", "status", "generation", "activeRunId"
        FROM "Shop"
        WHERE "domain" = ${shop}
        FOR UPDATE
      `;
      const merchant = shops[0];
      if (!merchant || merchant.status !== "ACTIVE") {
        throw new Error(`Shop ${shop} is not active or registered`);
      }
      if (merchant.activeRunId) {
        return null;
      }

      return reserveCatalogSync(tx, merchant);
    },
    { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 15000 }
  );

  if (!run) {
    return { status: "already_running" };
  }

  // 4. Enqueue using the existing sync queue.
  try {
    await enqueueSyncRun(shop, run.id, "PENDING");
  } catch (error) {
    console.error("[catalog-sync] Queue unavailable; durable scanner will recover:", error.code ?? "QUEUE_UNAVAILABLE");
  }

  // 5. Return after durable scheduling.
  return { status: "enqueued", runId: run.id };
}

/**
 * Create BullMQ Worker for the catalog reconciliation queue.
 */
export function createReconcileWorker(options = {}) {
  const worker = new Worker(
    RECONCILE_QUEUE,
    (job) => processReconciliationJob(job.data, options),
    {
      prefix: RECONCILE_PREFIX,
      connection: consumerRedis,
      concurrency: positiveInteger(
        options.concurrency,
        "concurrency",
        readWorkerConfig().concurrency
      ),
    }
  );

  worker.on("error", (error) => {
    console.error("[catalog-reconcile] Worker error:", error);
  });

  const stopRepair =
    options.startRepairScheduler === false
      ? null
      : startCatalogRepairScheduler({
          requestFullSnapshot:
            options.requestFullSnapshot || requestPeriodicFullSnapshot,
        });

  worker.stopRepair = stopRepair;

  const originalClose = worker.close.bind(worker);
  worker.close = async () => {
    if (worker.stopRepair) {
      await worker.stopRepair();
      worker.stopRepair = null;
    }
    return originalClose();
  };

  return worker;
}

// Imports expose the processor for tests; direct execution starts the complete
// runtime, including durable recovery, retention, and graceful shutdown.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { startWorkerRuntime } = await import("./runtime.js");
  await startWorkerRuntime({ createWorker: createReconcileWorker });
}
