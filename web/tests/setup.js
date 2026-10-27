import { after } from "node:test";
import { inventoryQueue } from "../queues/inventory.queue.js";
import { reconcileQueue } from "../queues/reconcile.queue.js";
import { syncQueue } from "../queues/sync.queue.js";
after(async () => {
  // File-specific DB cleanup can fail after a setup/connection error. Always
  // close queue handles independently, so that failure cannot strand the runner.
  await Promise.all([
    inventoryQueue.close(),
    reconcileQueue.close(),
    syncQueue.close(),
  ]);
});
