import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { producerRedis } from "../integrations/redis/connection.js";

export const INVENTORY_QUEUE = "inventory-reconcile";
export const INVENTORY_JOB = "reconcile-inventory-item";
export const INVENTORY_PREFIX = process.env.QUEUE_PREFIX || "newmeta";
export const inventoryQueue = new Queue(INVENTORY_QUEUE, {
  prefix: INVENTORY_PREFIX,
  connection: producerRedis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true,
  },
});
inventoryQueue.on("error", (error) =>
  console.error("[inventory-reconcile] Queue error:", error.message)
);
export async function enqueueInventoryChange(shop, inventoryItemId, revision) {
  if (
    typeof shop !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(shop) ||
    typeof inventoryItemId !== "string" ||
    !/^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/.test(inventoryItemId)
  )
    throw TypeError("Canonical inventory identity required");
  if (
    !(
      typeof revision === "bigint" ||
      (typeof revision === "string" && /^\d+$/.test(revision)) ||
      (typeof revision === "number" && Number.isSafeInteger(revision))
    )
  )
    throw TypeError("Invalid inventory revision");
  const value = BigInt(revision);
  if (value < 1n || value > 9223372036854775807n)
    throw RangeError("Invalid inventory revision");
  const key = createHash("sha256")
    .update(shop)
    .update("\0")
    .update(inventoryItemId)
    .digest("hex");
  return inventoryQueue.add(
    INVENTORY_JOB,
    { shop, inventoryItemId },
    { jobId: `inventory-${key}-${value}` }
  );
}
