import {
  createWebhookRouter,
  numericProductId,
} from "../webhooks/webhooks.routes.js";
import { recordInventoryWebhook } from "../webhooks/webhooks.repository.js";
import { enqueueInventoryChange } from "../../queues/inventory.queue.js";

export const INVENTORY_TOPICS = new Set([
  "inventory_levels/update",
  "inventory_levels/connect",
  "inventory_levels/disconnect",
  "inventory_items/create",
  "inventory_items/update",
  "inventory_items/delete",
]);

export function extractInventoryItemId(payload, topic) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  if (topic.startsWith("inventory_levels/")) {
    const item = numericProductId(payload.inventory_item_id);
    const location = numericProductId(payload.location_id);
    return item && location ? `gid://shopify/InventoryItem/${item}` : null;
  }
  const numeric = payload.id == null ? null : numericProductId(payload.id);
  if (payload.id != null && !numeric) return null;
  const gid = payload.admin_graphql_api_id;
  if (
    gid != null &&
    (typeof gid !== "string" ||
      !/^gid:\/\/shopify\/InventoryItem\/[1-9]\d{0,39}$/.test(gid))
  )
    return null;
  if (numeric && gid && gid !== `gid://shopify/InventoryItem/${numeric}`)
    return null;
  return gid ?? (numeric ? `gid://shopify/InventoryItem/${numeric}` : null);
}
export function createInventoryWebhookRouter(options = {}) {
  return createWebhookRouter({
    record: recordInventoryWebhook,
    enqueue: enqueueInventoryChange,
    topics: INVENTORY_TOPICS,
    extractIdentity: extractInventoryItemId,
    identityField: "inventoryItemId",
    ...options,
  });
}
export default createInventoryWebhookRouter();
