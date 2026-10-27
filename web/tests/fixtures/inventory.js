import { INVENTORY_QUANTITY_NAMES } from "../../domains/inventory/inventory.queries.js";
export const itemId = "gid://shopify/InventoryItem/123";
export const version = "2026-10-25T00:00:00Z";
export function level(index = 1) {
  return {
    id: `gid://shopify/InventoryLevel/${index}?inventory_item_id=123`,
    isActive: index % 2 === 0,
    updatedAt: version,
    location: {
      id: `gid://shopify/Location/${index}`,
      name: `Location ${index}`,
      isActive: true,
      fulfillsOnlineOrders: false,
      updatedAt: version,
    },
    quantities: INVENTORY_QUANTITY_NAMES.map((name, i) => ({
      name,
      quantity: i === 0 ? -3 : i,
      updatedAt: i === 0 ? null : version,
    })),
  };
}
export function observation(count = 1) {
  return {
    item: {
      id: itemId,
      sku: null,
      tracked: true,
      requiresShipping: false,
      updatedAt: version,
    },
    levels: Array.from({ length: count }, (_, i) => level(i + 1)),
  };
}
