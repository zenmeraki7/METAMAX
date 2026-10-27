import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProductsService,
  writeCurrentProduct,
} from "../domains/products/products.service.js";
import { mapCurrentProduct } from "../domains/products/products.mapper.js";
import {
  GET_PRODUCT,
  GET_PRODUCT_VARIANTS,
  GET_PRODUCT_VERSION,
} from "../domains/products/products.queries.js";

const shop = "example.myshopify.com";
const id = "gid://shopify/Product/123";
const version = "2026-10-25T00:00:00Z";
const money = "9007199254740993.123456";
const variant = (index, total = 101) => ({
  id: `gid://shopify/ProductVariant/${index}`,
  position: total - index + 1,
  title: `Variant ${index}`,
  sku: `SKU-${index}`,
  barcode: null,
  price: money,
  compareAtPrice: null,
  inventoryQuantity: 2,
  createdAt: version,
  updatedAt: version,
  inventoryItem: { id: `gid://shopify/InventoryItem/${index}` },
  selectedOptions: [{ name: "Size", value: `${index}` }],
});
function connection(nodes, more = false, cursor = null) {
  return {
    edges: nodes.map((node) => ({ node })),
    pageInfo: { hasNextPage: more, endCursor: cursor },
  };
}
function product(total = 101) {
  return {
    id,
    title: "Test product",
    handle: "test-product",
    descriptionHtml: "<p>Test</p>",
    status: "ACTIVE",
    vendor: "Example",
    productType: "Example",
    tags: [],
    totalInventory: total * 2,
    tracksInventory: true,
    createdAt: version,
    updatedAt: version,
    featuredImage: null,
    options: [{ name: "Size", position: 1, values: ["1"] }],
    variantsCount: { count: total, precision: "EXACT" },
  };
}
function paginated(total = 101, transform = (value) => value) {
  const calls = [];
  const service = createProductsService({
    graphql: async (_shop, query, variables, context) => {
      const index = calls.length;
      calls.push({ query, variables, context });
      if (query === GET_PRODUCT_VERSION)
        return transform(
          {
            data: {
              product: {
                id,
                updatedAt: version,
                variantsCount: { count: total, precision: "EXACT" },
              },
            },
          },
          index,
          query
        );
      const start = variables.after ? Number(variables.after.split("-")[1]) : 0;
      const end = Math.min(total, start + 100);
      const nodes = Array.from({ length: end - start }, (_, offset) =>
        variant(start + offset + 1, total)
      );
      return transform(
        {
          data: {
            product: {
              ...(query === GET_PRODUCT
                ? product(total)
                : { id, updatedAt: version }),
              variants: connection(nodes, end < total, `cursor-${end}`),
            },
          },
        },
        index,
        query
      );
    },
  });
  return { ...service, calls };
}

test("101 variants use one full page, one light page, then version verification; positions and decimal prices are preserved", async () => {
  const service = paginated();
  const current = await service.fetchCurrentProduct(shop, id);
  assert.equal(current.variants.length, 101);
  assert.deepEqual(
    service.calls.map((call) => call.query),
    [GET_PRODUCT, GET_PRODUCT_VARIANTS, GET_PRODUCT_VERSION]
  );
  assert.deepEqual(
    service.calls.map((call) => call.variables.after),
    [null, "cursor-100", undefined]
  );
  assert.deepEqual(
    service.calls.map((call) => call.context.requestedCost),
    [400, 400, 10]
  );
  assert.ok(
    service.calls.every(
      (call) =>
        call.context.installation === service.calls[0].context.installation
    )
  );
  assert.equal(current.variants[0].position, 1);
  const data = mapCurrentProduct(id, current);
  assert.equal(data.variants.length, 101);
  assert.equal(data.variants[0].id, "gid://shopify/ProductVariant/101");
  assert.equal(data.variants[0].price, money);
  assert.equal(Object.hasOwn(data.variants[0], "__parentId"), false);
});

test("exactly 2048 variants are read completely within 21 pages plus final verification", async () => {
  const service = paginated(2048);
  const current = await service.fetchCurrentProduct(shop, id);
  assert.equal(current.variants.length, 2048);
  assert.equal(service.calls.length, 22);
  assert.equal(mapCurrentProduct(id, current).variants.length, 2048);
});

test("a missing product requires a second error-free absence confirmation", async () => {
  let calls = 0;
  const service = createProductsService({
    graphql: async () => {
      calls++;
      return { data: { product: null } };
    },
  });
  assert.equal(await service.fetchCurrentProduct(shop, id), null);
  assert.equal(calls, 2);
  const appeared = createProductsService({
    graphql: async (_shop, query) => ({
      data: { product: query === GET_PRODUCT ? null : product(1) },
    }),
  });
  await assert.rejects(
    appeared.fetchCurrentProduct(shop, id),
    (error) => error.code === "INCONSISTENT_PRODUCT_READ"
  );
});

test("malformed and error-bearing responses cannot be treated as deletions", async () => {
  for (const response of [
    null,
    {},
    { data: {} },
    { data: { product: undefined } },
    { data: { product: [] } },
    { data: { product: null }, errors: [{ message: "Denied" }] },
    { data: { product: null }, errors: "bad" },
  ]) {
    await assert.rejects(
      createProductsService({
        graphql: async () => response,
      }).fetchCurrentProduct(shop, id)
    );
  }
});

test("normalized data objects and empty GraphQL error lists are accepted", async () => {
  const normalized = paginated(1, (response) => ({
    ...response.data,
    errors: [],
  }));
  assert.equal(
    (await normalized.fetchCurrentProduct(shop, id)).variants.length,
    1
  );
});

test("product mutation or disappearance between pages or final verification aborts the read", async () => {
  for (const mode of [
    "page-version",
    "page-delete",
    "final-version",
    "final-delete",
    "final-count",
  ]) {
    const service = paginated(101, (response, index, query) => {
      if (mode === "page-version" && index === 1)
        response.data.product.updatedAt = "2026-10-25T00:00:01Z";
      if (mode === "page-delete" && index === 1) response.data.product = null;
      if (query === GET_PRODUCT_VERSION) {
        if (mode === "final-version")
          response.data.product.updatedAt = "2026-10-25T00:00:01Z";
        if (mode === "final-delete") response.data.product = null;
        if (mode === "final-count") response.data.product.variantsCount.count++;
      }
      return response;
    });
    await assert.rejects(
      service.fetchCurrentProduct(shop, id),
      (error) => error.code === "INCONSISTENT_PRODUCT_READ"
    );
  }
});

test("duplicate variants, invalid positions, and duplicate positions are rejected", async () => {
  for (const mode of [
    "duplicate-id",
    "invalid-position",
    "duplicate-position",
  ]) {
    const service = paginated(101, (response, index) => {
      if (index === 1) {
        const node = response.data.product.variants.edges[0].node;
        if (mode === "duplicate-id") node.id = "gid://shopify/ProductVariant/1";
        if (mode === "invalid-position") node.position = 0;
        if (mode === "duplicate-position") node.position = 101;
      }
      return response;
    });
    await assert.rejects(
      service.fetchCurrentProduct(shop, id),
      (error) => error.code === "INVALID_VARIANT_PAGE"
    );
  }
});

test("missing, repeated, or nonadvancing cursors cannot loop pagination", async () => {
  for (const mode of ["missing", "repeated", "empty-page", "wrong-type"]) {
    const service = paginated(301, (response, index) => {
      if (index === 0 && mode === "missing")
        response.data.product.variants.pageInfo.endCursor = null;
      if (index === 1 && mode === "repeated")
        response.data.product.variants.pageInfo.endCursor = "cursor-100";
      if (index === 0 && mode === "empty-page")
        response.data.product.variants.edges = [];
      if (index === 0 && mode === "wrong-type")
        response.data.product.variants.pageInfo.endCursor = 10;
      return response;
    });
    await assert.rejects(
      service.fetchCurrentProduct(shop, id),
      (error) => error.code === "INVALID_VARIANT_CURSOR"
    );
  }
});

test("inexact, mismatched, or excessive counts reject full-set replacement", async () => {
  for (const mode of ["inexact", "too-many", "incomplete"]) {
    const service = paginated(2, (response) => {
      if (mode === "inexact")
        response.data.product.variantsCount.precision = "AT_LEAST";
      if (mode === "too-many") response.data.product.variantsCount.count = 2049;
      if (mode === "incomplete") response.data.product.variants.edges.pop();
      return response;
    });
    await assert.rejects(service.fetchCurrentProduct(shop, id));
  }
});

test("invalid product identity and malformed variant connections are rejected", async () => {
  for (const mode of ["identity", "missing-connection", "bad-page-info"]) {
    const service = paginated(1, (response) => {
      if (mode === "identity")
        response.data.product.id = "gid://shopify/Product/999";
      if (mode === "missing-connection") delete response.data.product.variants;
      if (mode === "bad-page-info")
        response.data.product.variants.pageInfo.hasNextPage = "false";
      return response;
    });
    await assert.rejects(service.fetchCurrentProduct(shop, id));
  }
});

test("short pages cannot exceed the hard page limit", async () => {
  let calls = 0;
  const service = createProductsService({
    graphql: async (_shop, query) => {
      calls++;
      return {
        data: {
          product: {
            ...product(2048),
            variants: connection(
              [variant(calls, 2048)],
              true,
              `cursor-${calls}`
            ),
          },
        },
      };
    },
  });
  await assert.rejects(
    service.fetchCurrentProduct(shop, id),
    (error) => error.code === "VARIANT_PAGE_LIMIT"
  );
  assert.equal(calls, 21);
});

test("JSON mirror replacement validates the entire set before writing and keeps prices exact", async () => {
  const current = await paginated(101).fetchCurrentProduct(shop, id);
  const writes = [];
  const tx = {
    productMirror: {
      upsert: async (row) => writes.push(row),
      deleteMany: async (row) => writes.push(row),
    },
  };
  await writeCurrentProduct(tx, shop, id, 1n, current);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].create.data.variants.length, 101);
  assert.equal(writes[0].create.data.variants[0].price, money);
  const malformed = structuredClone(current);
  malformed.variants[0].price = 0.1;
  await assert.rejects(writeCurrentProduct(tx, shop, id, 2n, malformed));
  assert.equal(writes.length, 1);
  await writeCurrentProduct(tx, shop, id, 3n, null);
  assert.deepEqual(writes[1], { where: { shop, productId: id } });
});


test("transport and permission failures never become a confirmed product deletion", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let calls = 0;
    const service = createProductsService({ graphql: async () => {
      calls++;
      throw Object.assign(new Error("Shopify request failed"), { status, code: "SHOPIFY_HTTP_ERROR" });
    } });
    await assert.rejects(() => service.fetchCurrentProduct(shop, id), { code: "SHOPIFY_HTTP_ERROR" });
    assert.equal(calls, 1);
  }
  for (const code of ["ACCESS_DENIED", "THROTTLED", "INTERNAL_SERVER_ERROR", "NOT_FOUND"]) {
    let calls = 0;
    const service = createProductsService({ graphql: async () => {
      calls++;
      return calls === 1 ? { data: { product: null } } : { data: { product: null }, errors: [{ message: "Request failed", extensions: { code } }] };
    } });
    await assert.rejects(() => service.fetchCurrentProduct(shop, id), { code: "SHOPIFY_GRAPHQL_ERRORS" });
    assert.equal(calls, 2);
  }
});
