import test from "node:test";
import assert from "node:assert/strict";
import { createInstalledFilterHttpRuntime } from "./filter-engine.server.js";
import { createPublicationRepository } from "../mirror/publication-repository.server.js";
import { catalogPool, physicalColumn } from "../filters/__tests__/catalog-fixture.js";

const shopId = "runtime-test.myshopify.com";

function createInstalledCatalogPool() {
  const productColumns = {
    shopify_id: physicalColumn("text"),
    title: physicalColumn("text"),
    handle: physicalColumn("text"),
    description_html: physicalColumn("text"),
    vendor: physicalColumn("text"),
    product_type: physicalColumn("text"),
    status: physicalColumn("text"),
    tags: physicalColumn("_text"),
    template_suffix: physicalColumn("text"),
    created_at: physicalColumn("timestamptz"),
    updated_at: physicalColumn("timestamptz"),
    published_at: physicalColumn("timestamptz"),
    seo_title: physicalColumn("text"),
    seo_description: physicalColumn("text"),
    category_id: physicalColumn("text"),
  };
  const variantColumns = {
    shopify_id: physicalColumn("text"),
    title: physicalColumn("text"),
    sku: physicalColumn("text"),
    barcode: physicalColumn("text"),
    price: physicalColumn("numeric"),
    compare_at_price: physicalColumn("numeric"),
    inventory_policy: physicalColumn("text"),
    inventory_quantity: physicalColumn("int8"),
    taxable: physicalColumn("bool"),
    requires_components: physicalColumn("bool"),
    position: physicalColumn("int8"),
    created_at: physicalColumn("timestamptz"),
    updated_at: physicalColumn("timestamptz"),
  };
  const fixture = catalogPool(productColumns, variantColumns);
  fixture.pool.query = async (...args) => {
    const client = await fixture.pool.connect();
    try { return await client.query(...args); } finally { client.release(); }
  };
  return fixture;
}

test("runtime composition: initializes real database adapters, field authorization, and dynamic metafield repository", async () => {
  const f = createInstalledCatalogPool();

  const runtime = await createInstalledFilterHttpRuntime({
    database: f.pool,
    sessionStorage: {
      async loadSession() {
        return { shop: shopId, scope: "read_products,write_products" };
      },
    },
    cursorSecret: "test-secret-at-least-32-characters-long!!",
  });

  assert.ok(runtime);
  assert.equal(typeof runtime.capture, "function");
  assert.equal(typeof runtime.search, "function");
  assert.equal(typeof runtime.catalog, "function");
  assert.equal(typeof runtime.catalogStatus, "function");
  assert.equal(typeof runtime.catalogCount, "function");
  assert.ok(runtime.fieldService);
  assert.ok(runtime.compiler);
  assert.ok(runtime.executor);
  assert.ok(runtime.physicalSchema);
});

test("runtime fail-closed: fails closed before serving if physical mirror schema is missing or invalid", async () => {
  const f = createInstalledCatalogPool();
  // Corrupt mirror schema by deleting products table definition
  delete f.state.tables.products;

  await assert.rejects(
    () =>
      createInstalledFilterHttpRuntime({
        database: f.pool,
        sessionStorage: {
          async loadSession() {
            return { shop: shopId, scope: "read_products" };
          },
        },
        cursorSecret: "test-secret-at-least-32-characters-long!!",
      }),
    { code: "FIELD_CONTRACT_MISMATCH" },
  );
});

test("safe cleanup: never reclaims a generation if published, active lease, approved operation, or retained", async () => {
  const dummyPool = { connect: async () => ({ query: async () => ({ rows: [] }), release() {} }) };
  const repo = createPublicationRepository({ database: dummyPool });

  // 1. Currently published: blocked by publication check
  const publishedMock = {
    async query(sql) {
      if (sql.includes("FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE")) {
        return { rows: [{ id: "gen-pub", status: "PUBLISHED", retain_until: null }] };
      }
      if (sql.includes("UNION ALL")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    () => repo.reclaimGeneration({ client: publishedMock, shopId: "test.myshopify.com", generationId: "gen-pub" }),
    /Generation remains referenced/,
  );

  // 2. Active lease: blocked by generation_read_leases check
  const leaseMock = {
    async query(sql) {
      if (sql.includes("FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE")) {
        return { rows: [{ id: "gen-lease", status: "RETIRED", retain_until: null }] };
      }
      if (sql.includes("UNION ALL")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    () => repo.reclaimGeneration({ client: leaseMock, shopId: "test.myshopify.com", generationId: "gen-lease" }),
    /Generation remains referenced/,
  );

  // 3. Approved operation: blocked by selection_snapshots check
  const opMock = {
    async query(sql) {
      if (sql.includes("FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE")) {
        return { rows: [{ id: "gen-op", status: "RETIRED", retain_until: null }] };
      }
      if (sql.includes("UNION ALL")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    () => repo.reclaimGeneration({ client: opMock, shopId: "test.myshopify.com", generationId: "gen-op" }),
    /Generation remains referenced/,
  );

  // 4. Within mandatory retention period: blocked by retain_until check
  const retainedMock = {
    async query(sql) {
      if (sql.includes("FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE")) {
        return {
          rows: [{
            id: "gen-ret",
            status: "RETIRED",
            retain_until: new Date(Date.now() + 60000).toISOString(),
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  await assert.rejects(
    () => repo.reclaimGeneration({ client: retainedMock, shopId: "test.myshopify.com", generationId: "gen-ret" }),
    /Generation is retained/,
  );

  // 5. Unreferenced and retention expired: reclamation succeeds
  let deleted = false;
  const safeMock = {
    async query(sql) {
      if (sql.includes("FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE")) {
        return {
          rows: [{
            id: "gen-safe",
            status: "RETIRED",
            retain_until: new Date(Date.now() - 60000).toISOString(),
          }],
        };
      }
      if (sql.includes("UNION ALL")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("DELETE FROM mirror.generations WHERE shop_id = $1 AND id = $2")) {
        deleted = true;
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const reclaimed = await repo.reclaimGeneration({ client: safeMock, shopId: "test.myshopify.com", generationId: "gen-safe" });
  assert.equal(reclaimed, true);
  assert.equal(deleted, true);
});

