import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRODUCT_PREFIX,
  VARIANT_PREFIX,
  assertId,
  productRow,
  variantRow,
  resolveOption1,
  ingestCatalogBatch,
} from "../../mirror/ingest.js";

test("assertId validates Shopify GID prefixes", () => {
  assert.equal(
    assertId("gid://shopify/Product/123", PRODUCT_PREFIX),
    "gid://shopify/Product/123"
  );
  assert.equal(
    assertId("gid://shopify/ProductVariant/456", VARIANT_PREFIX),
    "gid://shopify/ProductVariant/456"
  );

  assert.throws(
    () => assertId("123", PRODUCT_PREFIX),
    /Invalid Shopify resource ID/
  );
  assert.throws(
    () => assertId("gid://shopify/Collection/123", PRODUCT_PREFIX),
    /Invalid Shopify resource ID/
  );
  assert.throws(
    () => assertId(null, PRODUCT_PREFIX),
    /Invalid Shopify resource ID/
  );
});

test("productRow maps GraphQL node into mirror_products shape", () => {
  const node = {
    id: "gid://shopify/Product/100",
    title: "Awesome Sneakers",
    handle: "awesome-sneakers",
    vendor: "Acme Shoes",
    productType: "Footwear",
    status: "ACTIVE",
    tags: ["shoes", "summer"],
    totalInventory: 42,
    updatedAt: "2026-10-26T12:00:00Z",
  };

  const row = productRow(node);
  assert.deepEqual(row, {
    id: "gid://shopify/Product/100",
    title: "Awesome Sneakers",
    handle: "awesome-sneakers",
    vendor: "Acme Shoes",
    productType: "Footwear",
    status: "ACTIVE",
    tags: ["shoes", "summer"],
    inventoryTotal: 42,
    updatedAt: "2026-10-26T12:00:00Z",
  });
});

test("variantRow maps GraphQL node into mirror_variants shape with parent ID assertion", () => {
  const node = {
    id: "gid://shopify/ProductVariant/200",
    __parentId: "gid://shopify/Product/100",
    sku: "SNEAKERS-10",
    barcode: "123456789012",
    price: "129.99",
    compareAtPrice: "149.99",
    selectedOptions: [{ name: "Size", value: "10" }],
    inventoryItem: { id: "gid://shopify/InventoryItem/500" },
  };

  const row = variantRow(node);
  assert.deepEqual(row, {
    id: "gid://shopify/ProductVariant/200",
    productId: "gid://shopify/Product/100",
    sku: "SNEAKERS-10",
    barcode: "123456789012",
    price: "129.99",
    compareAtPrice: "149.99",
    option1: "10",
    inventoryItemId: "gid://shopify/InventoryItem/500",
  });

  // Missing or invalid parentId throws
  assert.throws(
    () => variantRow({ ...node, __parentId: "invalid" }),
    /Invalid Shopify resource ID/
  );
});

test("resolveOption1 resolves against option definitions instead of blind index 0", () => {
  const node = {
    selectedOptions: [
      { name: "Size", value: "Large" },
      { name: "Color", value: "Navy" },
    ],
  };

  // When option definitions establish Color as position 1
  const optionDefs = [
    { name: "Color", position: 1 },
    { name: "Size", position: 2 },
  ];

  assert.equal(resolveOption1(node, optionDefs), "Navy");

  // When no option definitions are available, falls back to index 0
  assert.equal(resolveOption1(node), "Large");

  // Empty or missing selectedOptions returns null
  assert.equal(resolveOption1({ selectedOptions: [] }), null);
  assert.equal(resolveOption1({}), null);
});

test("ingestCatalogBatch validates parameters and batch boundary (<= 500)", async () => {
  const mockDb = { query: async () => ({ rows: [] }) };

  await assert.rejects(
    ingestCatalogBatch(mockDb, { shopId: "", generationId: "gen-1", nodes: [] }),
    /Shop and generation are required/
  );

  await assert.rejects(
    ingestCatalogBatch(mockDb, { shopId: "shop-1", generationId: "", nodes: [] }),
    /Shop and generation are required/
  );

  await assert.rejects(
    ingestCatalogBatch(mockDb, {
      shopId: "shop-1",
      generationId: "gen-1",
      nodes: "not an array",
    }),
    /Invalid ingestion batch/
  );

  const oversized = Array.from({ length: 501 }, (_, i) => ({
    id: `gid://shopify/Product/${i + 1}`,
  }));

  await assert.rejects(
    ingestCatalogBatch(mockDb, {
      shopId: "shop-1",
      generationId: "gen-1",
      nodes: oversized,
    }),
    /Invalid ingestion batch/
  );

  await assert.rejects(
    ingestCatalogBatch(mockDb, {
      shopId: "shop-1",
      generationId: "gen-1",
      nodes: [{ id: "gid://shopify/Customer/1" }],
    }),
    /Unexpected catalog record/
  );
});

test("ingestCatalogBatch rejects when generation is not BUILDING", async () => {
  const queries = [];
  const mockDb = {
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT status FROM mirror_generations")) {
          return { rows: [{ status: "COMPLETED" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  };

  const nodes = [
    {
      id: "gid://shopify/Product/1",
      title: "P1",
      handle: "p1",
      status: "ACTIVE",
    },
  ];

  await assert.rejects(
    ingestCatalogBatch(mockDb, {
      shopId: "shop-1",
      generationId: "gen-1",
      nodes,
    }),
    /Generation is not writable/
  );

  assert.ok(queries.some((q) => q.sql === "BEGIN"));
  assert.ok(queries.some((q) => q.sql === "ROLLBACK"));
});

test("ingestCatalogBatch inserts products before variants inside transaction", async () => {
  const queries = [];
  let released = false;

  const mockDb = {
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("mirror_generations")) {
          return { rows: [{ status: "BUILDING" }] };
        }
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  };

  const product = {
    id: "gid://shopify/Product/1",
    title: "Chair",
    handle: "chair",
    status: "ACTIVE",
    options: [{ name: "Material", position: 1 }],
  };

  const variant = {
    id: "gid://shopify/ProductVariant/10",
    __parentId: product.id,
    price: "49.00",
    selectedOptions: [{ name: "Material", value: "Oak" }],
  };

  // Even if variant appears first in nodes, products are sorted and inserted first
  const result = await ingestCatalogBatch(mockDb, {
    shopId: "test-shop",
    generationId: "gen-100",
    nodes: [variant, product],
  });

  assert.deepEqual(result, { products: 1, variants: 1 });
  assert.ok(released);

  // Assert transaction sequence: BEGIN -> GUARD -> INSERT mirror_products -> INSERT mirror_variants -> COMMIT
  const sqlSequence = queries.map((q) => q.sql);
  assert.equal(sqlSequence[0], "BEGIN");
  assert.ok(sqlSequence[1].includes("mirror_generations"));
  assert.ok(sqlSequence[2].includes("INSERT INTO mirror_products"));
  assert.ok(sqlSequence[3].includes("INSERT INTO mirror_variants"));
  assert.equal(sqlSequence[4], "COMMIT");

  // Verify parameters in product insert
  assert.equal(queries[2].params[0], "test-shop");
  assert.equal(queries[2].params[1], "gen-100");
  const insertedProducts = JSON.parse(queries[2].params[2]);
  assert.equal(insertedProducts[0].id, product.id);

  // Verify option1 resolution was resolved from product options
  const insertedVariants = JSON.parse(queries[3].params[2]);
  assert.equal(insertedVariants[0].id, variant.id);
  assert.equal(insertedVariants[0].option1, "Oak");
});
