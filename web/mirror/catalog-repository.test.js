import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogCount,
  clearCatalogSummaryCache,
  readCatalogPage,
} from "./catalog-repository.server.js";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";

test("catalogCount parses valid safe integers and rejects invalid counts", () => {
  assert.equal(catalogCount(0), 0);
  assert.equal(catalogCount("0"), 0);
  assert.equal(catalogCount(42), 42);
  assert.equal(catalogCount("1500"), 1500);

  assert.throws(
    () => catalogCount(-1),
    (err) => err instanceof FieldError && err.code === C.CONTRACT_MISMATCH,
  );
  assert.throws(
    () => catalogCount("-5"),
    (err) => err instanceof FieldError && err.code === C.CONTRACT_MISMATCH,
  );
  assert.throws(
    () => catalogCount(1.5),
    (err) => err instanceof FieldError && err.code === C.CONTRACT_MISMATCH,
  );
  assert.throws(
    () => catalogCount(NaN),
    (err) => err instanceof FieldError && err.code === C.CONTRACT_MISMATCH,
  );
  assert.throws(
    () => catalogCount("invalid"),
    (err) => err instanceof FieldError && err.code === C.CONTRACT_MISMATCH,
  );
  assert.throws(
    () => catalogCount(Number.MAX_SAFE_INTEGER + 10),
    (err) => err instanceof FieldError && err.code === C.CONTRACT_MISMATCH,
  );
});

test("readCatalogPage projects image and tracksInventory correctly", async () => {
  clearCatalogSummaryCache();

  const mockRows = [
    {
      id: "gid://shopify/Product/1",
      title: "Tracked Product With Image",
      handle: "tracked-product",
      vendor: "Acme",
      productType: "Apparel",
      status: "ACTIVE",
      tags: ["summer"],
      variantCount: "3",
      totalInventory: "15",
      image: "https://cdn.shopify.com/products/shirt.png",
      tracksInventory: true,
    },
    {
      id: "gid://shopify/Product/2",
      title: "Untracked Product Without Image",
      handle: "untracked-product",
      vendor: "Acme",
      productType: "Digital",
      status: "ACTIVE",
      tags: [],
      variantCount: "1",
      totalInventory: "0",
      image: null,
      tracksInventory: false,
    },
  ];

  const queries = [];
  const mockClient = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes("FROM mirror.products p WHERE")) {
        return { rows: mockRows };
      }
      if (sql.includes("SELECT") && sql.includes("activeCount")) {
        return {
          rows: [
            {
              productCount: "2",
              activeCount: "2",
              variantCount: "4",
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL in mock: ${sql}`);
    },
  };

  const result = await readCatalogPage(mockClient, {
    shopId: "test-shop.myshopify.com",
    generationId: "gen-1",
    productIds: [1n, 2n],
  });

  assert.equal(result.products.length, 2);

  // First product: tracked and has image
  assert.equal(result.products[0].id, "gid://shopify/Product/1");
  assert.equal(result.products[0].variantCount, 3);
  assert.equal(result.products[0].image, "https://cdn.shopify.com/products/shirt.png");
  assert.equal(result.products[0].tracksInventory, true);

  // Second product: untracked and no image
  assert.equal(result.products[1].id, "gid://shopify/Product/2");
  assert.equal(result.products[1].variantCount, 1);
  assert.equal(result.products[1].image, null);
  assert.equal(result.products[1].tracksInventory, false);

  // Summary counts
  assert.deepEqual(result.summary, {
    productCount: 2,
    activeCount: 2,
    variantCount: 4,
  });

  // Every read uses persisted summary counts in its own protected transaction
  const queryCountBefore = queries.length;
  await readCatalogPage(mockClient, {
    shopId: "test-shop.myshopify.com",
    generationId: "gen-1",
    productIds: [1n, 2n],
  });
  // Product rows and summary are both read again
  assert.equal(queries.length, queryCountBefore + 2);

  // Clear cache for this shop
  clearCatalogSummaryCache("test-shop.myshopify.com");
  await readCatalogPage(mockClient, {
    shopId: "test-shop.myshopify.com",
    generationId: "gen-1",
    productIds: [1n, 2n],
  });
  // Summary query was run again
  assert.equal(queries.length, queryCountBefore + 4);
});

test("readCatalogPage throws when projection loses selected rows", async () => {
  clearCatalogSummaryCache();

  const mockClient = {
    async query(sql) {
      if (sql.includes("FROM mirror.products p WHERE")) {
        // Return only 1 row when 2 were requested
        return {
          rows: [
            {
              id: "gid://shopify/Product/1",
              title: "Product 1",
              variantCount: "1",
              totalInventory: "0",
              image: null,
              tracksInventory: true,
            },
          ],
        };
      }
      return { rows: [{ productCount: "1", activeCount: "1", variantCount: "1" }] };
    },
  };

  await assert.rejects(
    () =>
      readCatalogPage(mockClient, {
        shopId: "test-shop.myshopify.com",
        generationId: "gen-1",
        productIds: [1n, 2n],
      }),
    (err) =>
      err instanceof FieldError &&
      err.code === C.CONTRACT_MISMATCH &&
      err.message.includes("Catalog projection lost selected rows"),
  );
});


test('same-generation incremental and recovery counts are read fresh across transactions',async()=>{
 let counts={productCount:'2',activeCount:'2',variantCount:'3'};
 const client={async query(sql){return {rows:sql.includes('activeCount')?[counts]:[]};}};
 const input={shopId:'incremental.myshopify.com',generationId:'same-generation',productIds:[]};
 const first=await readCatalogPage(client,input);
 counts={productCount:'1',activeCount:'0',variantCount:'1'};
 const second=await readCatalogPage(client,input);
 assert.deepEqual(first.summary,{productCount:2,activeCount:2,variantCount:3});
 assert.deepEqual(second.summary,{productCount:1,activeCount:0,variantCount:1});
});
