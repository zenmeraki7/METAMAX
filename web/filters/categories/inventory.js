/**
 * Inventory Filter Category and Availability Gating.
 *
 * Invariant: Inventory availability remains unavailable to filters until
 * the required inventory datasets ('inventory_items', 'inventory_levels', 'inventory_quantities', 'locations')
 * are complete and verified in coverage, and aggregation semantics are formally defined.
 */

export const INVENTORY_FILTER_CATEGORY = "inventory";

export const REQUIRED_INVENTORY_DATASETS = Object.freeze([
  "inventory_items",
  "inventory_levels",
  "inventory_quantities",
  "locations",
]);

export const INVENTORY_FILTER_FIELDS = Object.freeze({
  AVAILABLE: "inventoryLevel.available",
  LOCATION_ID: "inventoryLevel.locationId",
  TRACKED: "inventoryItem.tracked",
});

/**
 * Checks whether inventory availability can be used in filters.
 *
 * @param {object} context
 * @param {string[]} [context.completedDatasets=[]] - List of durable verified datasets
 * @param {boolean} [context.aggregationSemanticsDefined=false] - Whether aggregation semantics (e.g. multi-location sum) are defined
 * @returns {boolean}
 */
export function isInventoryFilterAvailable({
  completedDatasets = [],
  aggregationSemanticsDefined = false,
} = {}) {
  // Inventory availability remains unavailable until aggregation semantics are explicitly defined
  if (!aggregationSemanticsDefined) {
    return false;
  }

  const completed = new Set(Array.isArray(completedDatasets) ? completedDatasets : []);

  for (const dataset of REQUIRED_INVENTORY_DATASETS) {
    if (!completed.has(dataset)) {
      return false;
    }
  }

  return true;
}

/**
 * Asserts that inventory filtering is permitted under the current coverage and aggregation policy.
 *
 * @param {object} context
 * @throws {Error} If inventory datasets are incomplete or aggregation semantics are undefined.
 */
export function assertInventoryFilterAvailable(context) {
  if (!isInventoryFilterAvailable(context)) {
    const error = new Error(
      "Inventory availability should remain unavailable to filters until the required inventory datasets are complete and the aggregation semantics are defined"
    );
    error.code = "INVENTORY_FILTER_UNAVAILABLE";
    error.requiredDatasets = REQUIRED_INVENTORY_DATASETS;
    error.aggregationSemanticsDefined = Boolean(context?.aggregationSemanticsDefined);
    throw error;
  }
}
