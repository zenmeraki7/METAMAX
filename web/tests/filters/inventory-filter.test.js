import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVENTORY_FILTER_CATEGORY,
  REQUIRED_INVENTORY_DATASETS,
  INVENTORY_FILTER_FIELDS,
  isInventoryFilterAvailable,
  assertInventoryFilterAvailable,
} from "../../filters/categories/inventory.js";

test("inventory filter category requires exact datasets and defined aggregation semantics", () => {
  assert.equal(INVENTORY_FILTER_CATEGORY, "inventory");
  assert.deepEqual(REQUIRED_INVENTORY_DATASETS, [
    "inventory_items",
    "inventory_levels",
    "inventory_quantities",
    "locations",
  ]);
  assert.equal(INVENTORY_FILTER_FIELDS.AVAILABLE, "inventoryLevel.available");
});

test("isInventoryFilterAvailable rejects if aggregation semantics are not defined", () => {
  const completeDatasets = [
    "inventory_items",
    "inventory_levels",
    "inventory_quantities",
    "locations",
  ];

  // Invariant: Even if datasets are complete, inventory availability remains unavailable to filters without aggregation semantics
  assert.equal(
    isInventoryFilterAvailable({
      completedDatasets: completeDatasets,
      aggregationSemanticsDefined: false,
    }),
    false
  );

  assert.equal(
    isInventoryFilterAvailable({
      completedDatasets: completeDatasets,
    }),
    false
  );
});

test("isInventoryFilterAvailable rejects if any required inventory dataset is incomplete", () => {
  const partial = ["inventory_items", "inventory_levels"];

  assert.equal(
    isInventoryFilterAvailable({
      completedDatasets: partial,
      aggregationSemanticsDefined: true,
    }),
    false
  );
});

test("isInventoryFilterAvailable allows filtering only when datasets are complete and semantics defined", () => {
  const completeDatasets = [
    "inventory_items",
    "inventory_levels",
    "inventory_quantities",
    "locations",
  ];

  assert.equal(
    isInventoryFilterAvailable({
      completedDatasets: completeDatasets,
      aggregationSemanticsDefined: true,
    }),
    true
  );
});

test("assertInventoryFilterAvailable fails closed with structured error", () => {
  assert.throws(
    () =>
      assertInventoryFilterAvailable({
        completedDatasets: ["inventory_items"],
        aggregationSemanticsDefined: false,
      }),
    (err) => {
      assert.equal(err.code, "INVENTORY_FILTER_UNAVAILABLE");
      assert.match(
        err.message,
        /Inventory availability should remain unavailable to filters until the required inventory datasets are complete and the aggregation semantics are defined/
      );
      return true;
    }
  );
});
