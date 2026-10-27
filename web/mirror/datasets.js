/**
 * Mirror Engine dataset registry and dependency graph.
 *
 * Dataset names align strictly with source declarations in fields/sources.js.
 * Dependency resolution and coverage tracking are precise: ingesting a parent
 * dataset does not automatically imply completeness of dependent or auxiliary datasets.
 *
 * Google Shopping remains unavailable until its authoritative source is verified,
 * preventing queries and filters from interpreting missing mirror data as empty values.
 */

export const MIRROR_DATASETS = Object.freeze({
  PRODUCTS: "products",
  VARIANTS: "variants",
  INVENTORY_ITEMS: "inventory_items",
  INVENTORY_LEVELS: "inventory_levels",
  INVENTORY_QUANTITIES: "inventory_quantities",
  LOCATIONS: "locations",
  METAFIELDS: "metafields",
  GOOGLE_SHOPPING: "google_shopping",
});

export const DATASET_DEPENDENCIES = Object.freeze({
  products: Object.freeze([]),
  variants: Object.freeze(["products"]),
  inventory_items: Object.freeze(["variants"]),
  inventory_levels: Object.freeze([
    "inventory_items",
    "locations",
  ]),
  inventory_quantities: Object.freeze(["inventory_levels"]),
  locations: Object.freeze([]),
  metafields: Object.freeze(["products", "variants"]),
  google_shopping: Object.freeze(["products"]),
});

export const CORE_DATASETS = Object.freeze([
  MIRROR_DATASETS.PRODUCTS,
  MIRROR_DATASETS.VARIANTS,
]);

export const DATASET_AVAILABILITY = Object.freeze({
  [MIRROR_DATASETS.PRODUCTS]: Object.freeze({ available: true, verifiedSource: "shopify_products" }),
  [MIRROR_DATASETS.VARIANTS]: Object.freeze({ available: true, verifiedSource: "shopify_variants" }),
  [MIRROR_DATASETS.INVENTORY_ITEMS]: Object.freeze({ available: true, verifiedSource: "shopify_inventory_items" }),
  [MIRROR_DATASETS.INVENTORY_LEVELS]: Object.freeze({ available: true, verifiedSource: "shopify_inventory_levels" }),
  [MIRROR_DATASETS.INVENTORY_QUANTITIES]: Object.freeze({ available: true, verifiedSource: "shopify_inventory_quantities" }),
  [MIRROR_DATASETS.LOCATIONS]: Object.freeze({ available: true, verifiedSource: "shopify_locations" }),
  [MIRROR_DATASETS.METAFIELDS]: Object.freeze({ available: true, verifiedSource: "shopify_metafields" }),
  [MIRROR_DATASETS.GOOGLE_SHOPPING]: Object.freeze({
    available: false,
    verifiedSource: null,
    reason: "UNVERIFIED_AUTHORITATIVE_SOURCE",
  }),
});

export function requireDataset(dataset) {
  if (typeof dataset !== "string" || !Object.hasOwn(DATASET_DEPENDENCIES, dataset)) {
    throw new TypeError(
      "Unknown mirror dataset"
    );
  }

  return dataset;
}

export function isDatasetAvailable(dataset) {
  requireDataset(dataset);
  return DATASET_AVAILABILITY[dataset].available;
}

export function requireAvailableDataset(dataset) {
  requireDataset(dataset);
  const info = DATASET_AVAILABILITY[dataset];
  if (!info.available) {
    throw new TypeError(
      `Mirror dataset is unavailable: ${String(dataset)} (${info.reason || "unverified"})`
    );
  }
  return dataset;
}

export function expandDatasets(datasets) {
  if (!Array.isArray(datasets) && !(datasets instanceof Set)) {
    throw new TypeError("Expected an iterable array or Set of datasets");
  }

  const result = new Set();

  function visit(dataset) {
    requireDataset(dataset);

    if (result.has(dataset)) return;

    result.add(dataset);

    for (const dependency of DATASET_DEPENDENCIES[dataset]) {
      visit(dependency);
    }
  }

  for (const dataset of datasets) visit(dataset);

  return Object.freeze([...result]);
}

/**
 * Builds an explicit dataset coverage map from a verified list of completed datasets.
 *
 * Invariant: Successfully ingesting core datasets (products, variants) does NOT
 * automatically mark auxiliary datasets (metafields, inventory levels) complete.
 * Unverified datasets (google_shopping) are always false.
 */
export function buildDatasetCoverage(completedDatasets = []) {
  if (!Array.isArray(completedDatasets) && !(completedDatasets instanceof Set)) {
    throw new TypeError("Expected an array or Set of completed datasets");
  }

  const completed = new Set([...completedDatasets].map(requireDataset));
  const coverage = {};

  for (const dataset of Object.values(MIRROR_DATASETS)) {
    const isAvailable = isDatasetAvailable(dataset);
    coverage[dataset] = isAvailable && completed.has(dataset);
  }

  return Object.freeze(coverage);
}
