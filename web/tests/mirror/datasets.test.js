import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIRROR_DATASETS,
  DATASET_DEPENDENCIES,
  CORE_DATASETS,
  DATASET_AVAILABILITY,
  requireDataset,
  isDatasetAvailable,
  requireAvailableDataset,
  expandDatasets,
  buildDatasetCoverage,
  createSnapshotCoverage,
  checkDatasetCoverage,
} from "../../mirror/index.js";
import { DATASETS as SOURCE_DATASETS, checkSourceCoverage } from "../../fields/sources.js";

test("MIRROR_DATASETS aligns strictly with fields/sources.js DATASETS", () => {
  assert.equal(MIRROR_DATASETS.PRODUCTS, SOURCE_DATASETS.PRODUCTS);
  assert.equal(MIRROR_DATASETS.VARIANTS, SOURCE_DATASETS.VARIANTS);
  assert.equal(MIRROR_DATASETS.INVENTORY_ITEMS, SOURCE_DATASETS.INVENTORY_ITEMS);
  assert.equal(MIRROR_DATASETS.INVENTORY_LEVELS, SOURCE_DATASETS.INVENTORY_LEVELS);
  assert.equal(MIRROR_DATASETS.LOCATIONS, SOURCE_DATASETS.LOCATIONS);
  assert.equal(MIRROR_DATASETS.METAFIELDS, SOURCE_DATASETS.METAFIELDS);
  assert.equal(MIRROR_DATASETS.GOOGLE_SHOPPING, SOURCE_DATASETS.GOOGLE_SHOPPING);

  assert.deepEqual(CORE_DATASETS, ["products", "variants"]);
  assert.ok(Object.isFrozen(MIRROR_DATASETS));
  assert.ok(Object.isFrozen(DATASET_DEPENDENCIES));
  assert.ok(Object.isFrozen(CORE_DATASETS));
});

test("requireDataset validates known datasets and rejects unknown datasets", () => {
  for (const dataset of Object.values(MIRROR_DATASETS)) {
    assert.equal(requireDataset(dataset), dataset);
  }

  assert.throws(() => requireDataset("unknown_dataset"), {
    name: "TypeError",
    message: "Unknown mirror dataset: unknown_dataset",
  });
  assert.throws(() => requireDataset(null), TypeError);
  assert.throws(() => requireDataset(undefined), TypeError);
});

test("expandDatasets traverses the dependency DAG correctly and immutably", () => {
  assert.deepEqual(expandDatasets(["products"]), ["products"]);
  assert.deepEqual(expandDatasets(["variants"]), ["variants", "products"]);
  assert.deepEqual(expandDatasets(["inventory_items"]), ["inventory_items", "variants", "products"]);
  assert.deepEqual(
    expandDatasets(["inventory_levels"]),
    ["inventory_levels", "inventory_items", "variants", "products", "locations"]
  );
  assert.deepEqual(expandDatasets(["metafields"]), ["metafields", "products", "variants"]);
  assert.deepEqual(expandDatasets(["google_shopping"]), ["google_shopping", "products"]);

  // Combining datasets preserves deduplication:
  const expanded = expandDatasets(["metafields", "inventory_levels"]);
  assert.ok(expanded.includes("products"));
  assert.ok(expanded.includes("variants"));
  assert.ok(expanded.includes("inventory_items"));
  assert.ok(expanded.includes("inventory_levels"));
  assert.ok(expanded.includes("locations"));
  assert.ok(expanded.includes("metafields"));
  assert.ok(Object.isFrozen(expanded));

  assert.throws(() => expandDatasets(["products", "nonexistent"]), TypeError);
  assert.throws(() => expandDatasets("not-an-array"), TypeError);
});

test("coverage is precise: ingesting core products and variants never marks metafields or inventory levels complete", () => {
  const coverage = buildDatasetCoverage(["products", "variants"]);

  assert.equal(coverage.products, true);
  assert.equal(coverage.variants, true);

  // Invariant: Auxiliary datasets MUST remain false
  assert.equal(coverage.inventory_items, false);
  assert.equal(coverage.inventory_levels, false);
  assert.equal(coverage.locations, false);
  assert.equal(coverage.metafields, false);
  assert.equal(coverage.google_shopping, false);

  assert.ok(Object.isFrozen(coverage));
});

test("Google Shopping integration remains unavailable until its authoritative source is verified", () => {
  assert.equal(isDatasetAvailable(MIRROR_DATASETS.GOOGLE_SHOPPING), false);
  assert.equal(DATASET_AVAILABILITY[MIRROR_DATASETS.GOOGLE_SHOPPING].available, false);
  assert.equal(
    DATASET_AVAILABILITY[MIRROR_DATASETS.GOOGLE_SHOPPING].reason,
    "UNVERIFIED_AUTHORITATIVE_SOURCE"
  );

  assert.throws(
    () => requireAvailableDataset(MIRROR_DATASETS.GOOGLE_SHOPPING),
    /Mirror dataset is unavailable: google_shopping/
  );

  // Even if a caller attempts to mark google_shopping as complete, it remains false:
  const coverage = buildDatasetCoverage(["products", "google_shopping"]);
  assert.equal(coverage.products, true);
  assert.equal(coverage.google_shopping, false);
});

test("createSnapshotCoverage and checkDatasetCoverage enforce exact snapshot binding and completeness", () => {
  const shopId = "mirror-test.myshopify.com";
  const generation = "gen-1";
  const snapshotId = "snap-1";

  const snapshotCoverage = createSnapshotCoverage({
    shopId,
    generation,
    snapshotId,
    completedDatasets: ["products", "variants", "locations"],
  });

  assert.equal(snapshotCoverage.shopId, shopId);
  assert.equal(snapshotCoverage.generation, generation);
  assert.equal(snapshotCoverage.snapshotId, snapshotId);
  assert.equal(snapshotCoverage.datasets.products, true);
  assert.equal(snapshotCoverage.datasets.variants, true);
  assert.equal(snapshotCoverage.datasets.locations, true);
  assert.equal(snapshotCoverage.datasets.inventory_levels, false);
  assert.equal(snapshotCoverage.datasets.metafields, false);
  assert.equal(snapshotCoverage.datasets.google_shopping, false);

  // Check dataset coverage helper:
  const satisfied = checkDatasetCoverage(snapshotCoverage, ["products", "variants"]);
  assert.equal(satisfied.ready, true);
  assert.deepEqual(satisfied.missing, []);

  const unsatisfied = checkDatasetCoverage(snapshotCoverage, ["products", "inventory_levels", "metafields"]);
  assert.equal(unsatisfied.ready, false);
  assert.deepEqual(unsatisfied.missing, ["inventory_levels", "metafields"]);

  // Requesting unavailable google_shopping always reports missing:
  const missingGoogle = checkDatasetCoverage(snapshotCoverage, ["products", "google_shopping"]);
  assert.equal(missingGoogle.ready, false);
  assert.deepEqual(missingGoogle.missing, ["google_shopping"]);

  // Integrates cleanly with fields/sources.js checkSourceCoverage:
  const sourceResult = checkSourceCoverage(["product.title", "variant.price"], snapshotCoverage, {
    shopId,
    generation,
    snapshotId,
  });
  assert.equal(sourceResult.ready, true);
});
