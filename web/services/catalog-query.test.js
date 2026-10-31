import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCatalogQueryParams,
  createCatalogQueryService,
} from "./catalog-query.server.js";
import { createCatalogRouter } from "../routes/catalog.routes.js";

test("parseCatalogQueryParams: normalizes search, status, and corrects operator 'ne' to 'neq'", () => {
  const parsed = parseCatalogQueryParams({
    search: "summer shirt",
    status: "ACTIVE",
    filters: JSON.stringify([
      { field: "product.vendor", operator: "ne", value: "Nike" },
      { field: "variant.price", operator: "gt", value: "50" },
    ]),
    match: "all",
    limit: "10",
  });

  assert.equal(parsed.pageSize, 10);
  assert.equal(parsed.filter.version, 1);
  assert.equal(parsed.filter.root.kind, "group");
  assert.equal(parsed.filter.root.operator, "AND");

  // Check search group
  const searchGroup = parsed.filter.root.children[0];
  assert.equal(searchGroup.kind, "group");
  assert.equal(searchGroup.operator, "OR");
  assert.equal(searchGroup.children.length, 4);

  // Check status condition
  const statusCond = parsed.filter.root.children[1];
  assert.equal(statusCond.field, "product.status");
  assert.equal(statusCond.operator, "eq");
  assert.equal(statusCond.value, "ACTIVE");

  // Check advanced filters with 'ne' corrected to 'neq'
  const advGroup = parsed.filter.root.children[2];
  assert.equal(advGroup.kind, "group");
  assert.equal(advGroup.operator, "AND");
  assert.equal(advGroup.children[0].field, "product.vendor");
  assert.equal(advGroup.children[0].operator, "neq"); // Corrected from 'ne'!
  assert.equal(advGroup.children[0].value, "Nike");
});

test("parseCatalogQueryParams: rejects invalid parameters", () => {
  for (const params of [
    { fields: "product.title" }, { shop: "attacker.myshopify.com" },
    { limit: ["1", "2"] }, { filters: { field: "product.title" } },
    { cursor: "" }, { cursor: "x".repeat(4097) },
    { filters: JSON.stringify(Array.from({length: 11}, () => ({ field: "product.id", operator: "is_not_null" }))) },
  ]) {
    assert.throws(() => parseCatalogQueryParams(params));
  }
  assert.throws(
    () => parseCatalogQueryParams({ limit: "invalid" }),
    /Invalid limit parameter/,
  );
  assert.throws(
    () => parseCatalogQueryParams({ status: "UNKNOWN" }),
    /Invalid catalog query request/,
  );
  assert.throws(
    () => parseCatalogQueryParams({ filters: "not-json" }),
    /Invalid JSON in filters parameter/,
  );
});

test("createCatalogQueryService: executes product catalog queries through compiler and executor", async () => {
  const mockCompiler = {
    async validateFilter(filter, context) {
      return { filter, context };
    },
    async compileFilter(validated, options) {
      return { validated, options, version: 4, binding: { shopId: "test.myshopify.com" } };
    },
  };

  const mockExecutor = {
    async execute({ query, authContext }) {
      return {
        products: [{ id: "gid://shopify/Product/1", title: "Test Product" }],
        summary: { productCount: 1, variantCount: 1, activeCount: 1 },
        filteredCount: 1,
        hasMore: false,
        nextCursor: null,
        productIds: ["gid://shopify/Product/1"],
        generationId: "gen-1",
        coverageRevision: "rev-1",
      };
    },
  };

  const mockResolveDatasets = async () => ({
    executionContext: { generationId: "gen-1", coverageRevision: "rev-1" },
  });

  const service = createCatalogQueryService({
    compiler: mockCompiler,
    executor: mockExecutor,
    resolveDatasets: mockResolveDatasets,
    resolveShop: async () => "test.myshopify.com",
  });

  const result = await service.queryProducts({
    authContext: { shop: "test.myshopify.com" },
    params: { search: "test", limit: "25" },
  });

  assert.equal(result.products.length, 1);
  assert.equal(result.filteredCount, 1);
  assert.equal(result.snapshotId, "gen-1");
  assert.equal(result.pageInfo.hasNextPage, false);

  const countResult = await service.queryCount({
    authContext: { shop: "test.myshopify.com" },
    params: { status: "ACTIVE" },
  });
  assert.equal(countResult.count, 1);
  assert.equal(countResult.precision, "EXACT");

  const statusResult = await service.queryStatus({
    authContext: { shop: "test.myshopify.com" },
  });
  assert.equal(statusResult.snapshotId, "gen-1");
  assert.equal(statusResult.syncStatus, "READY");

  const idsResult = await service.queryProductIds({
    authContext: { shop: "test.myshopify.com" },
    filter: { version: 1, root: { kind: "condition", field: "product.id", operator: "is_not_null" } },
  });
  assert.deepEqual(idsResult.productIds, ["gid://shopify/Product/1"]);
});

test("createCatalogRouter: handles endpoints and 503 fallback when service is unavailable", async () => {
  const router = createCatalogRouter({
    catalogQueryService: null,
    authentication: { async authenticate() { return null; } },
  });
  assert.ok(router);

  let statusSent = null;
  let jsonSent = null;
  const mockRes = {
    setHeader() {},
    status(s) {
      statusSent = s;
      return this;
    },
    json(j) {
      jsonSent = j;
      return this;
    },
  };

  // Find the layer handling GET /products
  const route = router.stack.find((layer) => layer.route?.path === "/products");
  assert.ok(route);
  const handler = route.route.stack[0].handle;
  await handler({}, mockRes, () => {});

  assert.equal(statusSent, 503);
  assert.equal(jsonSent.error, "FILTER_COVERAGE_UNAVAILABLE");
});

test("withSelectionSnapshot: pins transaction client, generationId, and coverageRevision across every page", async () => {
  const txClient = { query: async () => ({ rows: [] }) };
  const resolveCalls = [];
  let currentRev = "rev-1";

  const mockCompiler = {
    async validateFilter(filter, context) {
      return {
        ast: filter,
        fingerprint: "fp-1",
        definitionRevisions: [],
        context,
      };
    },
    async compileFilter(validated, options) {
      return {
        validated,
        options,
        version: 4,
        binding: {
          shopId: "test.myshopify.com",
          generationId: validated.context.executionContext.generationId,
          coverageRevision: validated.context.executionContext.coverageRevision,
          registryVersion: "reg-v1",
        },
      };
    },
  };

  const mockExecutor = {
    async withSnapshot({ authContext }, callback) {
      return callback({ client: txClient, shopId: "test.myshopify.com" });
    },
    async execute({ query }) {
      return {
        productIds: ["1", "2"],
        hasMore: !query.options.cursor,
        nextCursor: query.options.cursor ? null : "cursor-2",
        generationId: query.binding.generationId,
        coverageRevision: query.binding.coverageRevision,
        filteredCount: 2,
      };
    },
  };

  const service = createCatalogQueryService({
    compiler: mockCompiler,
    executor: mockExecutor,
    resolveShop: async () => "test.myshopify.com",
    resolveDatasets: async (input) => {
      resolveCalls.push(input);
      return {
        executionContext: {
          generationId: input.generationId ?? "gen-1",
          coverageRevision: currentRev,
        },
      };
    },
  });

  await service.withSelectionSnapshot(
    {
      authContext: { shop: "test.myshopify.com" },
      shopId: "test.myshopify.com",
      filter: { version: 1, root: { kind: "condition", field: "product.id", operator: "is_not_null" } },
    },
    async ({ client, generationId, coverageRevision, queryPage }) => {
      assert.strictEqual(client, txClient);
      assert.equal(generationId, "gen-1");
      assert.equal(coverageRevision, "rev-1");

      const page1 = await queryPage(undefined, {
        client: txClient,
        generationId: "gen-1",
        coverageRevision: "rev-1",
      });
      assert.equal(page1.generationId, "gen-1");
      assert.equal(page1.coverageRevision, "rev-1");

      await assert.rejects(
        () => queryPage("cursor-2", { client: {}, generationId: "gen-1", coverageRevision: "rev-1" }),
        /protected snapshot transaction client/,
      );
      await assert.rejects(
        () => queryPage("cursor-2", { client: txClient, generationId: "gen-2", coverageRevision: "rev-1" }),
        /generation differs from pinned snapshot/,
      );

      currentRev = "rev-changed";
      await assert.rejects(
        () => queryPage("cursor-2", { client: txClient, generationId: "gen-1", coverageRevision: "rev-1" }),
        /dataset context differs from pinned snapshot/,
      );
    },
  );

  assert.equal(resolveCalls.length, 3);
  for (const call of resolveCalls) {
    assert.strictEqual(call.client, txClient);
  }
});

