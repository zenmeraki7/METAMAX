import { Worker } from "bullmq";
import { consumerRedis } from "../integrations/redis/connection.js";
import {
  INVENTORY_QUEUE,
  INVENTORY_PREFIX,
} from "../queues/inventory.queue.js";
import { reconcileInventoryItem } from "../domains/inventory/inventory.reconcile.js";
import { readWorkerConfig, positiveInteger } from "./reconcile.config.js";

export function createInventoryWorker(options = {}) {
  const worker = new Worker(
    INVENTORY_QUEUE,
    (job) =>
      reconcileInventoryItem(job.data.shop, job.data.inventoryItemId, options),
    {
      prefix: INVENTORY_PREFIX,
      connection: consumerRedis,
      concurrency: positiveInteger(
        options.concurrency,
        "inventory concurrency",
        readWorkerConfig().concurrency
      ),
    }
  );
  worker.on("error", (error) =>
    console.error("[inventory-worker] Error:", error.message)
  );
  worker.on("failed", (job, error) =>
    console.error("[inventory-worker] Job failed:", job?.id, error.message)
  );
  return worker;
}
