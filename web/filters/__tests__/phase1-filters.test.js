import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CANONICAL_FIELDS } from "../../fields/canonical.js";
import { FIELD_ERROR_CODES as C, FieldError } from "../../fields/types.js";
import { createMirrorCoverageService } from "../../mirror/coverage.js";
import { createFieldService } from "../../fields/resolve.js";
import { createFilterService } from "../validate.js";
import { createFilterCompiler } from "../compile.js";
import { verifyMirrorSqlSchema } from "../../services/mirror-schema.server.js";
import { createMirrorSqlSchema } from "../mirror-schema.js";
import { catalogPool, physicalMapping, physicalColumn } from "./catalog-fixture.js";
import { FILTER_PRESETS, FILTER_PRESET_IDS } from "../presets.js";
import { normalizeOperatorOperand, APPROVED_SAME_ROW_COMPARISONS } from "../../fields/normalize.js";
import { serializeCanonicalFilter } from "../serialization.js";
import { fingerprintFilterAst, fingerprintBoundFilter } from "../fingerprint.js";
import { createCursorService } from "../pagination.js";
import { parseCatalogQueryParams } from "../../services/catalog-query.server.js";
import { createSelectionService } from "../../services/selection.server.js";

describe("Phase 1 filters: Specific Products, Blank Compare-At, and Price Comparisons", async () => {
  const SHOP = "test-shop.myshopify.com";
  const GENERATION = "gen-phase1-2026";
  const REVISION = "rev-phase1-001";

  async function createFixture(options = {}) {
    const coverage = createMirrorCoverageService({
      repository: {
        getPublishedSnapshot: async (input) => ({
          shopId: SHOP,
          generationId: GENERATION,
          coverageRevision: REVISION,
          status: "PUBLISHED",
          mirrorSchemaVersion: "metamax_mirror_v1",
          sourceContractVersion: "metamax_sources_v1",
          datasets: input.datasets.map((name) => ({
            name,
            generationId: GENERATION,
            status: "COMPLETE",
            published: true,
          })),
        }),
      },
    });

    const fieldService = createFieldService({
      adapter: {
        resolveOne() { assert.fail("Unexpected dynamic lookup"); },
        resolveBatch() { assert.fail("Unexpected dynamic lookup"); },
      },
      resolveShop: async () => SHOP,
      authorizeAccess: async () => true,
      verifyCoverage: coverage.getVerifiedCoverage,
    });

    const service = createFilterService({ fieldService });

    const catalog = catalogPool(
      {
        shopify_id: physicalColumn("text"),
        title: physicalColumn("text"),
        vendor: physicalColumn("text"),
      },
      {
        shopify_id: physicalColumn("text"),
        price: physicalColumn("numeric"),
        compare_at_price: physicalColumn("numeric"),
        sku: physicalColumn("text"),
      }
    );

    const physicalSchema = await verifyMirrorSqlSchema({
      database: catalog.pool,
      schema: createMirrorSqlSchema(physicalMapping()),
      mirrorSchemaVersion: "metamax_mirror_v1",
      sourceContractVersion: "metamax_sources_v1",
      fieldMappings: [
        { fieldId: "product.id", entity: "product", column: "shopify_id", type: "text" },
        { fieldId: "product.title", entity: "product", column: "title", type: "text" },
        { fieldId: "product.vendor", entity: "product", column: "vendor", type: "text" },
        { fieldId: "variant.id", entity: "variant", column: "shopify_id", type: "text" },
        { fieldId: "variant.price", entity: "variant", column: "price", type: "numeric" },
        { fieldId: "variant.compareAtPrice", entity: "variant", column: "compare_at_price", type: "numeric" },
        { fieldId: "variant.sku", entity: "variant", column: "sku", type: "text" },
      ],
    });

    const compiler = createFilterCompiler({
      fieldService,
      physicalSchema,
      ...(options.cursorService ? { cursorService: options.cursorService } : {}),
    });
    const context = {
      authContext: { sessionId: "session-p1" },
      operation: "filter",
      executionContext: { operationId: "op-p1", generationId: GENERATION },
    };

    return { service, compiler, context, fieldService, physicalSchema };
  }

  // ------------------------------------------------------------------
  // 1. Specific Products (product.id + in)
  // ------------------------------------------------------------------
  test("Specific products: compiles parameterized SQL with tenant & generation fencing", async () => {
    const f = await createFixture();
    const gids = ["gid://shopify/Product/1001", "gid://shopify/Product/1002"];
    const ast = {
      version: 1,
      root: {
        kind: "condition",
        field: "product.id",
        operator: "in",
        value: gids,
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });

    assert.match(query.text, /"p"\."shopify_id" IN \(\$3::text, \$4::text\)/);
    assert.match(query.text, /"p"\."shop_id" = \$1::text/);
    assert.match(query.text, /"p"\."generation_id" = \$2::text/);
    assert.equal(query.values[0], SHOP);
    assert.equal(query.values[1], GENERATION);
    assert.equal(query.values[2], gids[0]);
    assert.equal(query.values[3], gids[1]);
  });

  test("Specific products: strictly rejects empty in [] with INVALID_VALUE", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "condition",
        field: "product.id",
        operator: "in",
        value: [],
      },
    };

    await assert.rejects(
      () => f.compiler.validateFilter(ast, f.context),
      (error) => error instanceof FieldError && error.code === C.INVALID_VALUE
    );
  });

  // ------------------------------------------------------------------
  // 2. Compare-at Price is Blank (variant.compareAtPrice + is_null)
  // ------------------------------------------------------------------
  test("Compare-at Price Blank: compiles correlated EXISTS with soft-delete exclusion", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "condition",
        field: "variant.compareAtPrice",
        operator: "is_null",
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });

    assert.match(query.text, /EXISTS \(SELECT 1 FROM "mirror"\."variants" AS "v" WHERE/);
    assert.match(query.text, /"v"\."deleted_at" IS NULL/);
    assert.match(query.text, /\("v"\."compare_at_price" IS NULL\)/);
    assert.match(query.text, /"v"\."product_id" = "p"\."id"/);
    assert.equal(query.values[0], SHOP);
    assert.equal(query.values[1], GENERATION);
  });

  // ------------------------------------------------------------------
  // 3. Price Comparisons: lt, eq, gt
  // ------------------------------------------------------------------
  test("Price < Compare-at Price: compiles same-row column comparison without literals", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "condition",
        field: "variant.price",
        operator: "lt",
        value: {
          kind: "field",
          field: "variant.compareAtPrice",
        },
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });

    assert.match(query.text, /EXISTS \(SELECT 1 FROM "mirror"\."variants" AS "v"/);
    assert.match(query.text, /\("v"\."price" < "v"\."compare_at_price"\)/);
    assert.match(query.text, /"v"\."deleted_at" IS NULL/);

    // No literal value bound for compareAtPrice: values only contain tenant guards & pagination limit
    assert.equal(query.values[0], SHOP);
    assert.equal(query.values[1], GENERATION);
    assert.equal(query.values.length, 3); // shop, generation, limit
  });

  test("Price = Compare-at Price: compiles same-row equality comparison", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "condition",
        field: "variant.price",
        operator: "eq",
        value: {
          kind: "field",
          field: "variant.compareAtPrice",
        },
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });

    assert.match(query.text, /\("v"\."price" = "v"\."compare_at_price"\)/);
  });

  test("Price > Compare-at Price: compiles same-row greater-than comparison", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "condition",
        field: "variant.price",
        operator: "gt",
        value: {
          kind: "field",
          field: "variant.compareAtPrice",
        },
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });

    assert.match(query.text, /\("v"\."price" > "v"\."compare_at_price"\)/);
  });

  // ------------------------------------------------------------------
  // 4. Same-Variant Conjunctions & Fail-Closed Fencing
  // ------------------------------------------------------------------
  test("Same-variant correlation: flattens multiple variant conditions into single EXISTS", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "group",
        operator: "AND",
        children: [
          {
            kind: "condition",
            field: "variant.price",
            operator: "lt",
            value: { kind: "field", field: "variant.compareAtPrice" },
          },
          {
            kind: "condition",
            field: "variant.sku",
            operator: "eq",
            value: "SALE-SKU",
          },
        ],
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });

    const existsMatches = query.text.match(/EXISTS/g) ?? [];
    assert.equal(existsMatches.length, 1, "Must emit exactly one EXISTS subquery for same-variant AND");
    assert.match(query.text, /\("v"\."price" < "v"\."compare_at_price"\)/);
    assert.match(query.text, /\("v"\."sku" = \$3::text\)/);
  });

  test("Conjunction of Product and Variant filters combines product WHERE and variant EXISTS", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "group",
        operator: "AND",
        children: [
          {
            kind: "condition",
            field: "product.id",
            operator: "in",
            value: ["gid://shopify/Product/1"],
          },
          {
            kind: "condition",
            field: "variant.price",
            operator: "lt",
            value: { kind: "field", field: "variant.compareAtPrice" },
          },
        ],
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });

    assert.match(query.text, /"p"\."shopify_id" IN \(\$3::text\)/);
    assert.match(query.text, /EXISTS \(SELECT 1 FROM "mirror"\."variants" AS "v"/);
    assert.match(query.text, /\("v"\."price" < "v"\."compare_at_price"\)/);
  });

  test("Mixed product/variant OR fails closed with UNSUPPORTED_OPERATION", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "group",
        operator: "OR",
        children: [
          { kind: "condition", field: "product.title", operator: "eq", value: "Summer" },
          { kind: "condition", field: "variant.price", operator: "lt", value: { kind: "field", field: "variant.compareAtPrice" } },
        ],
      },
    };

    await assert.rejects(
      () => f.compiler.validateFilter(ast, f.context),
      (error) => error instanceof FieldError && error.code === C.UNSUPPORTED_OPERATION
    );
  });

  test("Variant condition inside NOT fails closed with UNSUPPORTED_OPERATION", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "group",
        operator: "NOT",
        children: [
          { kind: "condition", field: "variant.price", operator: "lt", value: { kind: "field", field: "variant.compareAtPrice" } },
        ],
      },
    };

    await assert.rejects(
      () => f.compiler.validateFilter(ast, f.context),
      (error) => error instanceof FieldError && error.code === C.UNSUPPORTED_OPERATION
    );
  });

  // ------------------------------------------------------------------
  // 5. Presets verification
  // ------------------------------------------------------------------
  test("FILTER_PRESETS constructs valid ASTs for all Phase 1 presets", async () => {
    const f = await createFixture();

    const specificAst = FILTER_PRESETS[FILTER_PRESET_IDS.SPECIFIC_PRODUCTS].createFilter(["gid://shopify/Product/1"]);
    const validatedSpecific = await f.compiler.validateFilter(specificAst, f.context);
    assert.ok(validatedSpecific);

    const blankCompareAst = FILTER_PRESETS[FILTER_PRESET_IDS.COMPARE_AT_PRICE_BLANK].createFilter();
    const validatedBlank = await f.compiler.validateFilter(blankCompareAst, f.context);
    assert.ok(validatedBlank);

    const priceLtAst = FILTER_PRESETS[FILTER_PRESET_IDS.PRICE_LESS_THAN_COMPARE_AT].createFilter();
    const validatedLt = await f.compiler.validateFilter(priceLtAst, f.context);
    assert.ok(validatedLt);

    const priceEqAst = FILTER_PRESETS[FILTER_PRESET_IDS.PRICE_EQUAL_TO_COMPARE_AT].createFilter();
    const validatedEq = await f.compiler.validateFilter(priceEqAst, f.context);
    assert.ok(validatedEq);

    const priceGtAst = FILTER_PRESETS[FILTER_PRESET_IDS.PRICE_GREATER_THAN_COMPARE_AT].createFilter();
    const validatedGt = await f.compiler.validateFilter(priceGtAst, f.context);
    assert.ok(validatedGt);
  });

  // ------------------------------------------------------------------
  // 6. Downstream Pipeline: Serialization, Fingerprinting, Cursors & Selection Snapshots
  // ------------------------------------------------------------------
  test("AST Serialization & Fingerprinting: canonical key order and deterministic hashing", () => {
    const astA = {
      version: 1,
      root: {
        kind: "condition",
        field: "variant.price",
        operator: "lt",
        value: {
          kind: "field",
          field: "variant.compareAtPrice",
        },
      },
    };

    const astB = {
      version: 1,
      root: {
        value: {
          field: "variant.compareAtPrice",
          kind: "field",
        },
        operator: "lt",
        field: "variant.price",
        kind: "condition",
      },
    };

    const serializedA = serializeCanonicalFilter(astA);
    const serializedB = serializeCanonicalFilter(astB);

    assert.equal(serializedA, serializedB);
    assert.equal(
      serializedA,
      '{"serializationVersion":1,"ast":{"root":{"field":"variant.price","kind":"condition","operator":"lt","value":{"field":"variant.compareAtPrice","kind":"field"}},"version":1}}'
    );

    const hashA = fingerprintFilterAst(astA);
    const hashB = fingerprintFilterAst(astB);
    assert.equal(hashA, hashB);
    assert.match(hashA, /^[a-f0-9]{64}$/);

    const binding = {
      shopId: SHOP,
      operation: "bulk_edit",
      operationId: "op-1",
      generationId: GENERATION,
      coverageRevision: REVISION,
      registryVersion: "registry-v1",
      targetingSnapshotId: "snap-1",
    };
    const boundA = fingerprintBoundFilter(astA, binding);
    const boundB = fingerprintBoundFilter(astB, binding);
    assert.equal(boundA, boundB);
  });

  test("Keyset Pagination: cursor issuance, signing and multi-page continuation", async () => {
    const cursorSecret = Buffer.alloc(32, 7);
    const cursorService = createCursorService({ secret: cursorSecret });
    const f = await createFixture({ cursorService });

    const ast = {
      version: 1,
      root: {
        kind: "condition",
        field: "variant.price",
        operator: "lt",
        value: { kind: "field", field: "variant.compareAtPrice" },
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);

    // Page 1: initial page with limit
    const page1Query = await f.compiler.compileFilter(validated, {
      authContext: f.context.authContext,
      pageSize: 2,
    });
    assert.match(page1Query.text, /LIMIT \$3/);
    assert.equal(page1Query.values[2], 3); // pageSize + 1

    // Issue cursor for continuation
    const cursor = f.compiler.createCursor(page1Query, "gid://shopify/Product/1002");
    assert.equal(typeof cursor, "string");

    // Page 2: pass cursor back
    const page2Query = await f.compiler.compileFilter(validated, {
      authContext: f.context.authContext,
      pageSize: 2,
      cursor,
    });
    assert.match(page2Query.text, /"p"\."id" COLLATE "pg_catalog"\."C" > \$3::text/);
    assert.match(page2Query.text, /LIMIT \$4/);
    assert.equal(page2Query.values[2], "gid://shopify/Product/1002");
    assert.equal(page2Query.values[3], 3);

    // Tampered cursor must fail closed with INVALID_VALUE
    await assert.rejects(
      () =>
        f.compiler.compileFilter(validated, {
          authContext: f.context.authContext,
          pageSize: 2,
          cursor: cursor.slice(0, -4) + "ffff",
        }),
      (err) => err instanceof FieldError && err.code === C.INVALID_VALUE
    );
  });

  test("Catalog Query Normalization: parseCatalogQueryParams parses structured operand filters", async () => {
    const f = await createFixture();

    const params = {
      filters: JSON.stringify([
        {
          field: "variant.price",
          operator: "lt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      ]),
    };

    const parsed = parseCatalogQueryParams(params);
    assert.equal(parsed.pageSize, 25);
    assert.equal(parsed.filter.version, 1);
    assert.equal(parsed.filter.root.children[0].children[0].field, "variant.price");
    assert.deepEqual(parsed.filter.root.children[0].children[0].value, {
      kind: "field",
      field: "variant.compareAtPrice",
    });

    const validated = await f.compiler.validateFilter(parsed.filter, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });
    assert.match(query.text, /\("v"\."price" < "v"\."compare_at_price"\)/);
  });

  test("Selection Snapshots: multi-page materialization preserves stable contract identity", async () => {
    const f = await createFixture();
    const ast = {
      version: 1,
      root: {
        kind: "condition",
        field: "variant.price",
        operator: "lt",
        value: { kind: "field", field: "variant.compareAtPrice" },
      },
    };

    const validated = await f.compiler.validateFilter(ast, f.context);

    const calls = [];
    const cursors = [];
    const snapshots = [];
    const items = [];

    const mockClient = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.includes("FROM mirror.publications")) {
          return {
            rows: [
              {
                generation_id: GENERATION,
                coverage_revision: REVISION,
                mapping_version: "mapping-v1",
                installation_version: "inst-1",
              },
            ],
          };
        }
        if (sql.includes("FROM mirror.products")) {
          const ids = [...params[2], ...params[3]];
          return {
            rows: ids.map((id) => ({
              id: id.replace("gid://shopify/Product/", ""),
              shopify_id: id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`,
            })),
          };
        }
        if (sql.includes("INSERT INTO mirror.selection_snapshots")) {
          snapshots.push([...params]);
        }
        if (sql.includes("SELECT s.* FROM mirror.selection_snapshots")) {
          return {
            rows: snapshots
              .filter((p) => p[1] === params[1])
              .map((p) => ({
                id: p[1],
                shop_id: p[0],
                generation_id: p[2],
                coverage_revision: p[3],
                status: "APPROVED",
                expires_at: p[12],
                mapping_version: p[4],
                operation: p[5],
                operation_id: p[6],
                target_mode: p[14],
                installation_version: p[15],
                selected_count: String(items.length),
                selection_hash: p[11],
                frozen_at: p[13],
                registry_version: p[9],
                definition_revisions: JSON.parse(p[10]),
              })),
          };
        }
        if (sql.includes("INSERT INTO mirror.selection_items")) {
          for (const id of params[3]) items.push(id);
        }
        if (sql.includes("SELECT product_id FROM mirror.selection_items")) {
          return {
            rows: items
              .filter((id) => BigInt(id) > BigInt(params[2]))
              .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
              .slice(0, params[3] ?? 1000)
              .map((product_id) => ({ product_id })),
          };
        }
        if (sql.includes("UPDATE mirror.selection_snapshots SET status")) {
          snapshots[0][8] = params[6]; // filter_fingerprint
          snapshots[0][9] = params[7]; // registry_version
          snapshots[0][10] = params[8]; // definition_revisions
          snapshots[0][11] = params[4]; // selection_hash
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };

    const database = { query: mockClient.query, connect: async () => mockClient };

    const catalogQueryService = {
      async withSelectionSnapshot(ctx, callback) {
        assert.equal(ctx.shopId, SHOP);
        return callback({
          client: mockClient,
          generationId: GENERATION,
          coverageRevision: REVISION,
          queryPage: async (cursor) => {
            cursors.push(cursor);
            const pageIndex = cursors.length;
            return {
              shopId: SHOP,
              generationId: GENERATION,
              coverageRevision: REVISION,
              registryVersion: "canonical-registry-v1",
              filterAst: validated.ast,
              filterFingerprint: validated.fingerprint,
              definitionRevisions: [],
              productIds: pageIndex === 1 ? ["1001", "1002"] : ["1003"],
              hasMore: pageIndex === 1,
              nextCursor: pageIndex === 1 ? "cursor-page-2" : null,
            };
          },
        });
      },
    };

    const selectionService = createSelectionService({
      database,
      catalogQueryService,
      resolveShop: async () => SHOP,
      logger: { error() {} },
    });

    const result = await selectionService.createSelection({
      authContext: f.context.authContext,
      mode: "ALL_MATCHING",
      filter: ast,
    });

    assert.equal(result.status, "APPROVED");
    assert.equal(result.selectedCount, 3);
    assert.deepEqual(cursors, [undefined, "cursor-page-2"]);
    assert.deepEqual(items, ["1001", "1002", "1003"]);

    // Verify snapshot stored serialized filter AST and fingerprint
    const storedAst = JSON.parse(snapshots[0][7]);
    assert.equal(storedAst.version, 1);
    assert.deepEqual(storedAst.root.value, { kind: "field", field: "variant.compareAtPrice" });
    assert.equal(snapshots[0][8], validated.fingerprint);
  });
});
