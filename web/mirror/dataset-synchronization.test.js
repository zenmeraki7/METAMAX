import test from "node:test";
import assert from "node:assert/strict";
import {
  validateInventoryItems,
  writeInventoryItems,
  validateLocations,
  writeLocations,
  validateInventoryLevels,
  writeInventoryLevels,
  validateCollections,
  writeCollections,
  validateCollectionMemberships,
  writeCollectionMemberships,
  validateProductOptions,
  writeProductOptions,
  validateMetafieldValues,
  writeMetafieldValues,
  createDatasetSynchronizationService,
} from "./dataset-synchronization.server.js";
import { createSyncRunService } from "./sync-run-service.server.js";

const shopId = "datasets-test.myshopify.com";
const generationId = "gen-ds-1";

test("dataset-sync: inventory items validation and write", async () => {
  assert.throws(() => validateInventoryItems([]), /Non-empty/);
  assert.throws(() => validateInventoryItems([{ id: "bad-id" }]), /Invalid inventory item/);
  assert.throws(() => validateInventoryItems([{ id: "gid://shopify/InventoryItem/1", tracked: "not-bool" }]), /tracked/);

  const items = [
    {
      id: "gid://shopify/InventoryItem/101",
      sku: "SKU-101",
      tracked: true,
      requiresShipping: true,
      unitCost: "15.50",
      currencyCode: "USD",
      countryCodeOfOrigin: "US",
    },
  ];

  assert.doesNotThrow(() => validateInventoryItems(items));

  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };

  await writeInventoryItems({ client: mockClient, shopId, generationId, records: items });
  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes("INSERT INTO mirror.inventory_items"));
  assert.equal(queries[0].params[0], shopId);
  assert.equal(queries[0].params[1], generationId);
  assert.equal(queries[0].params[2], "gid://shopify/InventoryItem/101");
  assert.equal(queries[0].params[3], "SKU-101");
  assert.equal(queries[0].params[4], true);
  assert.equal(queries[0].params[6], "15.50");
});

test("dataset-sync: locations validation and write", async () => {
  assert.throws(() => validateLocations([]), /Non-empty/);
  assert.throws(() => validateLocations([{ id: "bad-loc" }]), /Invalid location/);
  assert.throws(() => validateLocations([{ id: "gid://shopify/Location/1", name: "", active: true }]), /name required/);

  const locs = [
    { id: "gid://shopify/Location/201", name: "Main Warehouse", active: true },
  ];
  assert.doesNotThrow(() => validateLocations(locs));

  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };

  await writeLocations({ client: mockClient, shopId, generationId, records: locs });
  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes("INSERT INTO mirror.locations"));
  assert.equal(queries[0].params[0], shopId);
  assert.equal(queries[0].params[1], generationId);
  assert.equal(queries[0].params[2], "gid://shopify/Location/201");
  assert.equal(queries[0].params[3], "Main Warehouse");
  assert.equal(queries[0].params[4], true);
});

test("dataset-sync: inventory levels validation and write with resolved foreign keys", async () => {
  assert.throws(() => validateInventoryLevels([]), /Non-empty/);
  assert.throws(
    () => validateInventoryLevels([{ id: "gid://shopify/InventoryLevel/1" }]),
    /Inventory item reference required/,
  );

  const levels = [
    {
      id: "gid://shopify/InventoryLevel/101?location_id=201",
      inventoryItemShopifyId: "gid://shopify/InventoryItem/101",
      locationShopifyId: "gid://shopify/Location/201",
      available: 50,
      onHand: 60,
      committed: 10,
      incoming: 20,
    },
  ];
  assert.doesNotThrow(() => validateInventoryLevels(levels));

  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };

  await writeInventoryLevels({ client: mockClient, shopId, generationId, records: levels });
  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes("INSERT INTO mirror.inventory_levels"));
  assert.equal(queries[0].params[0], shopId);
  assert.equal(queries[0].params[1], generationId);
  assert.equal(queries[0].params[4], "gid://shopify/InventoryItem/101");
  assert.equal(queries[0].params[6], "gid://shopify/Location/201");
  assert.equal(queries[0].params[7], "50");
  assert.equal(queries[0].params[8], "60");
});

test("dataset-sync: collections and memberships validation and write", async () => {
  assert.throws(() => validateCollections([]), /Non-empty/);
  assert.throws(() => validateCollections([{ id: "bad" }]), /Invalid collection/);

  const collections = [
    { id: "gid://shopify/Collection/301", title: "Summer Sale", handle: "summer-sale" },
  ];
  assert.doesNotThrow(() => validateCollections(collections));

  const memberships = [
    { collectionShopifyId: "gid://shopify/Collection/301", productShopifyId: "gid://shopify/Product/1" },
  ];
  assert.doesNotThrow(() => validateCollectionMemberships(memberships));

  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };

  await writeCollections({ client: mockClient, shopId, generationId, records: collections });
  await writeCollectionMemberships({ client: mockClient, shopId, generationId, records: memberships });

  assert.equal(queries.length, 2);
  assert.ok(queries[0].sql.includes("INSERT INTO mirror.collections"));
  assert.equal(queries[0].params[2], "gid://shopify/Collection/301");
  assert.ok(queries[1].sql.includes("INSERT INTO mirror.product_collections"));
  assert.equal(queries[1].params[3], "gid://shopify/Collection/301");
  assert.equal(queries[1].params[5], "gid://shopify/Product/1");
});

test("dataset-sync: product options validation and write", async () => {
  assert.throws(() => validateProductOptions([]), /Non-empty/);
  assert.throws(() => validateProductOptions([{ id: "bad" }]), /Invalid product option/);

  const options = [
    {
      id: "gid://shopify/ProductOption/401",
      productShopifyId: "gid://shopify/Product/1",
      name: "Size",
      position: 1,
      values: ["S", "M", "L", "XL"],
    },
  ];
  assert.doesNotThrow(() => validateProductOptions(options));

  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };

  await writeProductOptions({ client: mockClient, shopId, generationId, records: options });
  assert.equal(queries.length, 1);
  assert.ok(queries[0].sql.includes("INSERT INTO mirror.product_options"));
  assert.equal(queries[0].params[2], "gid://shopify/ProductOption/401");
  assert.equal(queries[0].params[4], "gid://shopify/Product/1");
  assert.equal(queries[0].params[5], "Size");
  assert.deepEqual(queries[0].params[7], ["S", "M", "L", "XL"]);
});

test("dataset-sync: typed metafield values validation and write", async () => {
  assert.throws(() => validateMetafieldValues([]), /Non-empty/);
  assert.throws(
    () => validateMetafieldValues([{ definitionId: 1, definitionToken: "tok", ownerEntity: "invalid" }]),
    /ownerEntity must be product or variant/,
  );

  const values = [
    {
      definitionId: 10n,
      definitionToken: "token_abc123",
      ownerEntity: "product",
      productShopifyId: "gid://shopify/Product/1",
      valueType: "string",
      isNull: false,
      value: "Premium Quality",
    },
    {
      definitionId: 20n,
      definitionToken: "token_def456",
      ownerEntity: "variant",
      variantShopifyId: "gid://shopify/ProductVariant/10",
      valueType: "decimal",
      isNull: false,
      value: "99.95",
    },
  ];
  assert.doesNotThrow(() => validateMetafieldValues(values));

  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };

  await writeMetafieldValues({ client: mockClient, shopId, generationId, records: values });
  assert.equal(queries.length, 2);
  assert.ok(queries[0].sql.includes("INSERT INTO mirror.metafield_values"));
  assert.equal(queries[0].params[3], "gid://shopify/Product/1");
  assert.equal(queries[0].params[4], 10n);
  assert.equal(queries[0].params[6], "string");
  assert.equal(queries[0].params[8], "Premium Quality");

  assert.equal(queries[1].params[3], "gid://shopify/ProductVariant/10");
  assert.equal(queries[1].params[4], 20n);
  assert.equal(queries[1].params[6], "decimal");
  assert.equal(queries[1].params[11], "99.95");
});

test("dataset-sync: createDatasetSynchronizationService coordinates batch staging and checkpointing", async () => {
  let checkpointRecorded = false;
  const mockSyncRunService = {
    async recordCheckpoint({ ordinal, checksum, lineCount }) {
      checkpointRecorded = true;
      assert.equal(ordinal, 0);
      assert.ok(checksum);
      assert.equal(lineCount, 1n);
    },
  };

  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("mirror.generations")) {
        return {
          rows: [
            {
              id: generationId,
              status: "INGESTING",
              mirror_schema_version: "metamax_mirror_v1",
              source_contract_version: "metamax_sources_v1",
              mapping_version: "mapping_v1",
              required_datasets: ["products", "variants", "inventory_items"],
            },
          ],
        };
      }
      if (sql.includes("mirror.ingestion_runs")) {
        return { rows: [{ id: 101n, status: "RUNNING", live: true, fence: 1n }] };
      }
      if (sql.includes("mirror.ingestion_chunks")) {
        // No duplicate chunk
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };

  const mockDatabase = {
    async connect() { return mockClient; },
  };

  const syncService = createDatasetSynchronizationService({
    database: mockDatabase,
    syncRunService: mockSyncRunService,
  });

  const res = await syncService.syncDatasetBatch({
    client: mockClient,
    shopId,
    generationId,
    runId: 101n,
    fence: 1n,
    dataset: "inventory_items",
    ordinal: 0,
    records: [
      {
        id: "gid://shopify/InventoryItem/500",
        tracked: true,
        requiresShipping: false,
      },
    ],
  });

  assert.equal(res.replayed, false);
  assert.equal(res.lineCount, 1);
  assert.equal(res.dataset, "inventory_items");
  assert.equal(checkpointRecorded, true);
});

test("dataset-sync: extended dataset coverage verification verifies all declared required datasets", async () => {
  const coverageInserts = [];
  const mockClient = {
    async query(sql, params) {
      if (sql.includes("FROM mirror.generations") && sql.includes("FOR UPDATE")) {
        return {
          rows: [
            {
              id: generationId,
              status: "RECONCILING",
              mirror_schema_version: "metamax_mirror_v1",
              source_contract_version: "metamax_sources_v1",
              mapping_version: "mapping_v1",
              required_datasets: [
                "products",
                "variants",
                "inventory_items",
                "locations",
                "collections",
                "product_options",
                "metafields",
              ],
            },
          ],
        };
      }
      if (sql.includes("catalog_changes WHERE shop_id=$1 AND dirty")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT count(*)::text AS count")) {
        return { rows: [{ count: "42" }] };
      }
      if (sql.includes("INSERT INTO mirror.coverage")) {
        coverageInserts.push({ name: params[2], durableRows: params[3] });
        return { rows: [] };
      }
      if (sql.includes("UPDATE mirror.generations SET status='VERIFIED'")) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    },
  };

  const service = createSyncRunService({ database: { async connect() { return mockClient; } } });

  const verified = await service.completeCoverageAndVerify({
    client: mockClient,
    shopId,
    generationId,
  });

  assert.equal(verified, true);
  assert.equal(coverageInserts.length, 7);
  const names = coverageInserts.map((c) => c.name);
  assert.deepEqual(names, [
    "products",
    "variants",
    "inventory_items",
    "locations",
    "collections",
    "product_options",
    "metafields",
  ]);
});
