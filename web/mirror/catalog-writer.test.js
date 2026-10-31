import test from "node:test";
import assert from "node:assert/strict";
import {
  createCatalogWriter,
  writeCatalogProducts,
  validateProducts,
} from "./catalog-writer.server.js";
import { product, variant } from "./integration/sync-hardening.js";

const shopId = "catalog-writer-test.myshopify.com";
const generationId = "gen-writer-1";

test("catalog-writer: rejects invalid shop domain or generation identity", async () => {
  const mockClient = { async query() { return { rows: [{ id: 1 }] }; } };

  await assert.rejects(
    () =>
      writeCatalogProducts({
        client: mockClient,
        shopId: "invalid-domain",
        generationId,
        records: [product()],
      }),
    /Authenticated shop required/,
  );

  await assert.rejects(
    () =>
      writeCatalogProducts({
        client: mockClient,
        shopId,
        generationId: "bad generation with spaces!",
        records: [product()],
      }),
    /Opaque identity required/,
  );
});

test("catalog-writer: validates product schema before SQL execution", async () => {
  let queried = false;
  const mockClient = {
    async query() {
      queried = true;
      return { rows: [{ id: 1 }] };
    },
  };

  await assert.rejects(
    () =>
      writeCatalogProducts({
        client: mockClient,
        shopId,
        generationId,
        records: [{ id: "gid://shopify/Product/1" }], // Missing required fields
      }),
    /Incomplete product snapshot/,
  );

  assert.equal(queried, false);
});

test("catalog-writer: inserts product and variants using parameterized queries and detects cross-product variant theft", async () => {
  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("INSERT INTO mirror.products")) {
        return { rows: [{ id: 501 }] };
      }
      if (sql.includes("SELECT 1 FROM mirror.variants")) {
        // No conflicts
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("DELETE FROM mirror.variants")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO mirror.variants")) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    },
  };

  const records = [
    product(10, [variant(101), variant(102)]),
  ];

  await writeCatalogProducts({
    client: mockClient,
    shopId,
    generationId,
    records,
  });

  // Verify product insert was parameterized
  const prodInsert = queries.find((q) => q.sql.includes("INSERT INTO mirror.products"));
  assert.ok(prodInsert);
  assert.equal(prodInsert.params[0], shopId);
  assert.equal(prodInsert.params[1], generationId);
  assert.equal(prodInsert.params[2], "gid://shopify/Product/10");

  // Verify variant cross-product check
  const varCheck = queries.find((q) => q.sql.includes("SELECT 1 FROM mirror.variants"));
  assert.ok(varCheck);
  assert.equal(varCheck.params[0], shopId);
  assert.equal(varCheck.params[1], generationId);
  assert.deepEqual(varCheck.params[2], [variant(101).id, variant(102).id]);
  assert.equal(varCheck.params[3], 501);

  // Verify variants were inserted
  const varInserts = queries.filter((q) => q.sql.includes("INSERT INTO mirror.variants"));
  assert.equal(varInserts.length, 2);
  assert.equal(varInserts[0].params[2], variant(101).id);
  assert.equal(varInserts[0].params[3], 501); // linked to internalProductId
  assert.equal(varInserts[1].params[2], variant(102).id);
});

test("catalog-writer: detects when a variant belongs to another product", async () => {
  const mockClient = {
    async query(sql) {
      if (sql.includes("INSERT INTO mirror.products")) {
        return { rows: [{ id: 501 }] };
      }
      if (sql.includes("SELECT 1 FROM mirror.variants")) {
        // Variant belongs to product 999 instead of 501
        return { rowCount: 1, rows: [{ id: 1 }] };
      }
      return { rows: [] };
    },
  };

  await assert.rejects(
    () =>
      writeCatalogProducts({
        client: mockClient,
        shopId,
        generationId,
        records: [product(10, [variant(101)])],
      }),
    /Variant identity belongs to another product/,
  );
});

test("catalog-writer: createCatalogWriter service factory wraps operations", async () => {
  let transactionOpened = false;
  const mockClient = {
    async query(sql) {
      if (sql.includes("INSERT INTO mirror.products")) {
        return { rows: [{ id: 1 }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const mockDatabase = {
    async connect() {
      transactionOpened = true;
      return mockClient;
    },
  };

  const writer = createCatalogWriter({ database: mockDatabase });
  assert.equal(typeof writer.validateProducts, "function");
  assert.equal(typeof writer.writeCatalogProducts, "function");
  assert.equal(typeof writer.writeProducts, "function");

  await writer.writeProducts({
    shopId,
    generationId,
    records: [product()],
  });

  assert.equal(transactionOpened, true);
});
