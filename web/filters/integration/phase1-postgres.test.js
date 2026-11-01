/**
 * Phase 1 — PostgreSQL Integration and End-to-End Verification
 *
 * Tests the three Phase 1 filters against actual PostgreSQL 18 with
 * the repository's real Prisma migrations, tenant isolation, generation fencing,
 * same-row variant correlation, keyset pagination, and selection snapshots.
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createMirrorSqlSchema } from "../mirror-schema.js";
import { verifyMirrorSqlSchema, assertCursorOrdering } from "../../services/mirror-schema.server.js";
import { getInstalledFilterSchemaOptions, createInstalledFilterCompiler } from "../../services/filter-schema.server.js";
import { createFieldService } from "../../fields/resolve.js";
import { createFilterExecutor } from "../execute.js";
import { createMirrorCoverageService } from "../../mirror/coverage.js";
import { createMirrorPublicationService } from "../../mirror/publication-service.server.js";
import { createPublicationRepository } from "../../mirror/publication-repository.server.js";
import { createCursorService } from "../pagination.js";
import { createSelectionService } from "../../services/selection.server.js";
import { createCatalogQueryService } from "../../services/catalog-query.server.js";
import { parseCatalogQueryParams } from "../../services/catalog-query.server.js";
import { serializeCanonicalFilter } from "../serialization.js";
import { fingerprintFilterAst, fingerprintBoundFilter } from "../fingerprint.js";
import { FILTER_PRESETS, FILTER_PRESET_IDS } from "../presets.js";
import { FieldError, FIELD_ERROR_CODES as C } from "../../fields/types.js";

const target = process.env.FILTER_TEST_DATABASE_URL;

describe("Phase 1 PostgreSQL Integration Suite", {
  concurrency: false,
  skip: !target && "Requires the disposable PostgreSQL runner: npm run test:phase1:postgres",
}, async () => {
  if (!target) return;

  const url = new URL(target);
  assert.ok(
    process.env.FILTER_TEST_DATABASE_ISOLATED === "1" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.pathname === "/metamax_filter_test",
    "Only an explicitly isolated localhost test database is permitted"
  );

  const pool = new pg.Pool({
    connectionString: target,
    max: 10,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });

  const query = (text, values) => pool.query(text, values);

  const SHOP_A = "shop-a.myshopify.com";
  const SHOP_B = "shop-b.myshopify.com";
  const GEN_PUBLISHED = "gen-published";
  const GEN_RETIRED = "gen-retired";
  const GEN_B_PUBLISHED = "gen-b-published";
  const REV_A = "rev-a-001";
  const REV_B = "rev-b-001";

  let compiler;
  let executor;
  let publicationService;
  let publicationRepo;
  let fieldService;
  let cursorService;
  let selectionService;
  let catalogQueryService;
  let physicalSchema;

  const productDbIds = {};

  after(async () => {
    await pool.end();
  });

  // --------------------------------------------------------------------------
  // 1. Database Setup: Migrations & Fixtures
  // --------------------------------------------------------------------------
  test("Database Setup: apply real migrations and populate multi-tenant fixtures", async () => {
    // 1.1 Apply actual repository Prisma migrations in lexicographical order
    const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
    const directories = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    for (const dir of directories) {
      const sqlFile = new URL(`${dir}/migration.sql`, migrationsDir);
      const sql = await readFile(sqlFile, "utf8");
      await query(sql);
    }

    // 1.2 Insert Shops
    await query(`
      INSERT INTO mirror.shops(id, installation_version, installed_at)
      VALUES 
        ($1, 'inst-a-v1', now()),
        ($2, 'inst-b-v1', now())
      ON CONFLICT (id) DO UPDATE SET installation_version = EXCLUDED.installation_version;
    `, [SHOP_A, SHOP_B]);

    // Helper function to setup generation through verified staging lifecycle
    async function setupGeneration(shopId, genId, revId, productsData, isRetired = false) {
      await query(`ALTER TABLE mirror.generations DISABLE TRIGGER guard_sync_retention;`);
      await query(`ALTER TABLE mirror.variants DISABLE TRIGGER guard_generation_data;`);
      try {
        // Step A: Insert generation in INGESTING state
        await query(`
          INSERT INTO mirror.generations(
            shop_id, id, coverage_revision, mirror_schema_version, source_contract_version, mapping_version, created_at
          ) VALUES ($1, $2, $3, 'metamax_mirror_v1', 'metamax_sources_v1', 'mapping_v1', now())
          ON CONFLICT (shop_id, id) DO NOTHING;
        `, [shopId, genId, revId]);

        // Step B: Insert products and variants while generation is in staging (INGESTING)
        for (const p of productsData) {
          const res = await query(`
            INSERT INTO mirror.products(
              shop_id, generation_id, shopify_id, title, handle, vendor, status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', now(), now())
            RETURNING id;
          `, [shopId, genId, p.shopifyId, p.title, p.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), p.vendor ?? "Acme"]);
          const productId = res.rows[0].id;
          productDbIds[p.key] = productId;

          for (const v of (p.variants || [])) {
            await query(`
              INSERT INTO mirror.variants(
                shop_id, generation_id, product_id, shopify_id, title, sku, price, compare_at_price,
                inventory_policy, inventory_quantity, taxable, requires_components, position,
                created_at, updated_at, deleted_at
              ) VALUES (
                $1, $2, $3, $4, 'Default Title', $5, $6, $7,
                'DENY', 10, true, false, 1,
                now(), now(), $8
              );
            `, [
              shopId, genId, productId, v.shopifyId, v.sku ?? `SKU-${v.shopifyId}`,
              v.price, v.compareAtPrice, v.deletedAt ?? null
            ]);
          }
        }

        // Step C: Record durable ingestion runs
        for (const dataset of ["products", "variants"]) {
          await query(`
            INSERT INTO mirror.ingestion_runs(
              shop_id, generation_id, dataset, status, expected_lines, processed_lines, eof_verified, writes_finished_at
            ) VALUES ($1, $2, $3, 'SUCCEEDED', 10, 10, true, now());
          `, [shopId, genId, dataset]);
        }

        // Step D: Advance to RECONCILING
        await query(`UPDATE mirror.generations SET status = 'RECONCILING' WHERE shop_id = $1 AND id = $2;`, [shopId, genId]);

        // Step E: Insert verified coverage
        for (const dataset of ["products", "variants"]) {
          await query(`
            INSERT INTO mirror.coverage(
              shop_id, generation_id, name, status, durable_rows, verified_at, verification_hash
            ) VALUES ($1, $2, $3, 'COMPLETE', 10, now(), 'verified-hash')
            ON CONFLICT (shop_id, generation_id, name) DO NOTHING;
          `, [shopId, genId, dataset]);
        }

        // Step F: Advance to VERIFIED
        await query(`UPDATE mirror.generations SET status = 'VERIFIED', verified_at = now() WHERE shop_id = $1 AND id = $2;`, [shopId, genId]);

        // Step G: Advance to PUBLISHED
        await query(`UPDATE mirror.generations SET status = 'PUBLISHED', published_at = now() WHERE shop_id = $1 AND id = $2;`, [shopId, genId]);

        if (isRetired) {
          // Step H: Advance to RETIRED
          await query(`UPDATE mirror.generations SET status = 'RETIRED', retired_at = now(), retain_until = now() + interval '1 day' WHERE shop_id = $1 AND id = $2;`, [shopId, genId]);
        } else {
          // Step I: Publish publication pointer
          await query(`
            INSERT INTO mirror.publications(shop_id, generation_id, coverage_revision, mapping_version, published_at)
            VALUES ($1, $2, $3, 'mapping_v1', now())
            ON CONFLICT (shop_id) DO UPDATE 
              SET generation_id = EXCLUDED.generation_id,
                  coverage_revision = EXCLUDED.coverage_revision;
          `, [shopId, genId, revId]);
        }
      } finally {
        await query(`ALTER TABLE mirror.generations ENABLE TRIGGER guard_sync_retention;`);
        await query(`ALTER TABLE mirror.variants ENABLE TRIGGER guard_generation_data;`);
      }
    }

    // 1.3 Setup Shop A Published Generation
    await setupGeneration(SHOP_A, GEN_PUBLISHED, REV_A, [
      // Product 101: Price EQUAL TO Compare-at Price ($25.00 == $25.00)
      {
        key: "101",
        shopifyId: "gid://shopify/Product/101",
        title: "Equal Price Item",
        variants: [{ shopifyId: "gid://shopify/ProductVariant/1011", price: "25.00", compareAtPrice: "25.00" }],
      },
      // Product 102: Price LESS THAN Compare-at Price ($19.99 < $29.99)
      {
        key: "102",
        shopifyId: "gid://shopify/Product/102",
        title: "Discounted Item",
        variants: [
          { shopifyId: "gid://shopify/ProductVariant/1021", price: "19.99", compareAtPrice: "29.99", sku: "DISC-1021" },
          { shopifyId: "gid://shopify/ProductVariant/1022", price: "45.00", compareAtPrice: "50.00" },
        ],
      },
      // Product 103: Price GREATER THAN Compare-at Price ($35.00 > $20.00)
      {
        key: "103",
        shopifyId: "gid://shopify/Product/103",
        title: "Marked Up Item",
        variants: [{ shopifyId: "gid://shopify/ProductVariant/1031", price: "35.00", compareAtPrice: "20.00" }],
      },
      // Product 104: Blank Compare-at Price (variant 1041 has NULL compare-at)
      {
        key: "104",
        shopifyId: "gid://shopify/Product/104",
        title: "Blank Compare At Item",
        variants: [
          { shopifyId: "gid://shopify/ProductVariant/1041", price: "15.00", compareAtPrice: null },
          { shopifyId: "gid://shopify/ProductVariant/1042", price: "18.00", compareAtPrice: "25.00" },
        ],
      },
      // Product 105: Zero Compare-at Price ($10.00 vs $0.00 - NOT NULL)
      {
        key: "105",
        shopifyId: "gid://shopify/Product/105",
        title: "Zero Compare At Item",
        variants: [{ shopifyId: "gid://shopify/ProductVariant/1051", price: "10.00", compareAtPrice: "0.00" }],
      },
      // Product 106: Soft-deleted variant exclusion
      {
        key: "106",
        shopifyId: "gid://shopify/Product/106",
        title: "Soft Deleted Variants Item",
        variants: [
          { shopifyId: "gid://shopify/ProductVariant/1061", price: "12.00", compareAtPrice: "20.00", deletedAt: new Date() },
          { shopifyId: "gid://shopify/ProductVariant/1062", price: "20.00", compareAtPrice: "20.00" },
          { shopifyId: "gid://shopify/ProductVariant/1063", price: "10.00", compareAtPrice: null, deletedAt: new Date() },
        ],
      },
      // Product 107: Product with NO variants
      {
        key: "107",
        shopifyId: "gid://shopify/Product/107",
        title: "No Variants Item",
        variants: [],
      },
      // Product 108: Multi-variant same-row correlation test
      {
        key: "108",
        shopifyId: "gid://shopify/Product/108",
        title: "Mixed Multi Variant Item",
        variants: [
          { shopifyId: "gid://shopify/ProductVariant/1081", price: "50.00", compareAtPrice: "40.00" },
          { shopifyId: "gid://shopify/ProductVariant/1082", price: "30.00", compareAtPrice: "35.00" },
        ],
      },
    ]);

    // 1.4 Setup Shop A Retired Generation
    await setupGeneration(SHOP_A, GEN_RETIRED, REV_A, [
      {
        key: "109",
        shopifyId: "gid://shopify/Product/109",
        title: "Retired Gen Item",
        variants: [{ shopifyId: "gid://shopify/ProductVariant/1091", price: "10.00", compareAtPrice: "20.00" }],
      },
    ], true);

    // 1.5 Setup Shop B Published Generation
    await setupGeneration(SHOP_B, GEN_B_PUBLISHED, REV_B, [
      {
        key: "201",
        shopifyId: "gid://shopify/Product/201",
        title: "Foreign Shop Item",
        variants: [{ shopifyId: "gid://shopify/ProductVariant/2011", price: "5.00", compareAtPrice: "10.00" }],
      },
    ]);

    // 1.6 Bootstrap Installed Filter Compiler and Services
    cursorService = createCursorService({ secret: Buffer.alloc(32, 9) });
    publicationRepo = createPublicationRepository({ database: pool });
    publicationService = createMirrorPublicationService({
      repository: publicationRepo,
      barrierTable: { schema: "mirror", table: "publications" },
    });

    const coverage = createMirrorCoverageService({ repository: publicationRepo });
    fieldService = createFieldService({
      resolveShop: async () => SHOP_A,
      verifyCoverage: coverage.getVerifiedCoverage,
      authorizeAccess: async () => true,
      adapter: {
        resolveOne() { assert.fail("Unexpected dynamic lookup"); },
        resolveBatch() { assert.fail("Unexpected dynamic lookup"); },
      },
    });

    const installed = await createInstalledFilterCompiler({
      database: pool,
      fieldService,
      cursorService,
    });
    compiler = installed.compiler;
    physicalSchema = installed.physicalSchema;

    assert.equal(physicalSchema.productIdType, "bigint");
    assertCursorOrdering(physicalSchema);

    executor = createFilterExecutor({
      database: pool,
      publicationService,
      resolveShop: async () => SHOP_A,
      compiler,
    });

    catalogQueryService = createCatalogQueryService({
      compiler,
      executor,
      resolveShop: async () => SHOP_A,
      resolveDatasets: async () => ({
        executionContext: {
          generationId: GEN_PUBLISHED,
          coverageRevision: REV_A,
          operationId: "qa-op",
        },
      }),
    });

    selectionService = createSelectionService({
      database: pool,
      catalogQueryService,
      resolveShop: async () => SHOP_A,
      logger: { error() {} },
    });
  });

  const authContextA = Object.freeze({ session: "shop-a-session", shop: SHOP_A });
  const execContextA = Object.freeze({ operationId: "op-a", generationId: GEN_PUBLISHED });

  async function executeFilter(ast, options = {}) {
    const validated = await compiler.validateFilter(ast, {
      authContext: authContextA,
      operation: "filter",
      executionContext: execContextA,
    });
    const query = await compiler.compileFilter(validated, {
      authContext: authContextA,
      pageSize: options.pageSize ?? 50,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    });
    const result = await executor.execute({ query, authContext: authContextA });
    return { validated, query, result };
  }

  // --------------------------------------------------------------------------
  // 2. Specific Products Filter
  // --------------------------------------------------------------------------
  describe("Filter 1: Specific Products (product.id IN [...])", () => {
    test("Matches exact Shopify GIDs and returns correct products", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "product.id",
          operator: "in",
          value: ["gid://shopify/Product/101", "gid://shopify/Product/102"],
        },
      };

      const { result } = await executeFilter(ast);
      assert.deepEqual([...result.productIds].sort(), [productDbIds["101"], productDbIds["102"]].sort());
      assert.equal(result.hasMore, false);
    });

    test("Deduplicates duplicate selected GIDs", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "product.id",
          operator: "in",
          value: ["gid://shopify/Product/101", "gid://shopify/Product/101", "gid://shopify/Product/101"],
        },
      };

      const { result } = await executeFilter(ast);
      assert.deepEqual(result.productIds, [productDbIds["101"]]);
    });

    test("Strictly rejects empty selection array with INVALID_VALUE", async () => {
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
        () => compiler.validateFilter(ast, { authContext: authContextA, operation: "filter", executionContext: execContextA }),
        (err) => err instanceof FieldError && err.code === C.INVALID_VALUE
      );
    });

    test("Foreign-shop GID returns 0 matches for authenticated Shop A", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "product.id",
          operator: "in",
          value: ["gid://shopify/Product/201"], // Belongs to Shop B
        },
      };

      const { result } = await executeFilter(ast);
      assert.deepEqual(result.productIds, []);
      assert.equal(result.productIds.length, 0);
    });

    test("Rejects selections exceeding maximum array item limits (100 items)", async () => {
      const oversized = Array.from({ length: 101 }, (_, i) => `gid://shopify/Product/${i + 1000}`);
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "product.id",
          operator: "in",
          value: oversized,
        },
      };

      await assert.rejects(
        () => compiler.validateFilter(ast, { authContext: authContextA, operation: "filter", executionContext: execContextA })
      );
    });
  });

  // --------------------------------------------------------------------------
  // 3. Compare-at Price is Blank Filter
  // --------------------------------------------------------------------------
  describe("Filter 2: Compare-at Price is Blank (variant.compareAtPrice IS NULL)", () => {
    test("Matches product with NULL compare-at price and excludes 0.00 and soft-deleted", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.compareAtPrice",
          operator: "is_null",
        },
      };

      const { result, query } = await executeFilter(ast);

      // Must match Product 104 (has NULL compare-at price)
      assert.ok(result.productIds.includes(productDbIds["104"]));

      // Must NOT match Product 105 (has 0.00 compare-at price, NOT NULL)
      assert.ok(!result.productIds.includes(productDbIds["105"]));

      // Must NOT match Product 101, 102, 103 (populated compare-at prices)
      assert.ok(!result.productIds.includes(productDbIds["101"]));
      assert.ok(!result.productIds.includes(productDbIds["102"]));
      assert.ok(!result.productIds.includes(productDbIds["103"]));

      // Must NOT match Product 106 (its only blank variant is soft-deleted!)
      assert.ok(!result.productIds.includes(productDbIds["106"]));

      // Must NOT match Product 107 (no variants)
      assert.ok(!result.productIds.includes(productDbIds["107"]));

      // Must NOT match Product 109 (retired gen) or 201 (foreign shop)
      assert.ok(!result.productIds.includes(productDbIds["109"]));
      assert.ok(!result.productIds.includes(productDbIds["201"]));

      // Verify query includes soft-delete exclusion
      assert.match(query.text, /"v"\."deleted_at" IS NULL/);
      assert.match(query.text, /\("v"\."compare_at_price" IS NULL\)/);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Price vs Compare-at Price Filters
  // --------------------------------------------------------------------------
  describe("Filter 3: Price vs Compare-at Price (Same-Row Column Comparisons)", () => {
    test("Price < Compare-at Price: matches discounted items with exact decimal comparisons", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "lt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      };

      const { result, query } = await executeFilter(ast);

      // Matches Product 102 (19.99 < 29.99) and Product 108 (variant 1082: 30.00 < 35.00)
      assert.ok(result.productIds.includes(productDbIds["102"]));
      assert.ok(result.productIds.includes(productDbIds["108"]));

      // Does NOT match Product 101 (equal: 25.00 == 25.00)
      assert.ok(!result.productIds.includes(productDbIds["101"]));

      // Does NOT match Product 103 (greater: 35.00 > 20.00)
      assert.ok(!result.productIds.includes(productDbIds["103"]));

      // Product 104 has variant 1042 (18.00 < 25.00), so 104 legitimately matches.
      assert.ok(result.productIds.includes(productDbIds["104"]));

      // Does NOT match Product 105 (10.00 > 0.00)
      assert.ok(!result.productIds.includes(productDbIds["105"]));

      // Crucial: Does NOT match Product 106 because its discounted variant (12 < 20) is soft-deleted!
      assert.ok(!result.productIds.includes(productDbIds["106"]));

      // Does NOT match Product 107 (no variants)
      assert.ok(!result.productIds.includes(productDbIds["107"]));

      // Does NOT match foreign shop (Product 201) or retired generation (Product 109)
      assert.ok(!result.productIds.includes(productDbIds["201"]));
      assert.ok(!result.productIds.includes(productDbIds["109"]));

      // Verify emitted SQL uses same-row column comparison
      assert.match(query.text, /\("v"\."price" < "v"\."compare_at_price"\)/);
    });

    test("Price = Compare-at Price: matches exactly equal prices", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "eq",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      };

      const { result } = await executeFilter(ast);

      // Matches Product 101 ($25.00 == $25.00) and Product 106 (active variant 1062: $20.00 == $20.00)
      assert.ok(result.productIds.includes(productDbIds["101"]));
      assert.ok(result.productIds.includes(productDbIds["106"]));

      // Does NOT match Product 102 (19.99 != 29.99), 103 (35 != 20), 105 (10 != 0)
      assert.ok(!result.productIds.includes(productDbIds["102"]));
      assert.ok(!result.productIds.includes(productDbIds["103"]));
      assert.ok(!result.productIds.includes(productDbIds["105"]));
    });

    test("Price > Compare-at Price: matches marked-up items and zero compare-at", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "gt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      };

      const { result } = await executeFilter(ast);

      // Matches Product 103 ($35.00 > $20.00), Product 105 ($10.00 > $0.00), and Product 108 (variant 1081: $50.00 > $40.00)
      assert.ok(result.productIds.includes(productDbIds["103"]));
      assert.ok(result.productIds.includes(productDbIds["105"]));
      assert.ok(result.productIds.includes(productDbIds["108"]));

      // Does NOT match Product 101 ($25.00 == $25.00) or Product 102 (discounted)
      assert.ok(!result.productIds.includes(productDbIds["101"]));
      assert.ok(!result.productIds.includes(productDbIds["102"]));
    });
  });

  // --------------------------------------------------------------------------
  // 5. Boolean Semantics & Fail-Closed Fencing
  // --------------------------------------------------------------------------
  describe("Boolean Semantics & Ambiguity Fencing", () => {
    test("Positive AND: conjunction of product filter and same-row variant price comparison", async () => {
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
              value: ["gid://shopify/Product/101", "gid://shopify/Product/102"],
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

      const { result } = await executeFilter(ast);
      // Only Product 102 is both in [101, 102] AND has price < compareAtPrice
      assert.deepEqual(result.productIds, [productDbIds["102"]]);
    });

    test("Same-variant correlation: multiple variant conditions flatten into single EXISTS", async () => {
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
              value: "DISC-1021",
            },
          ],
        },
      };

      const { result, query } = await executeFilter(ast);
      assert.deepEqual(result.productIds, [productDbIds["102"]]);
      const existsCount = (query.text.match(/EXISTS/g) ?? []).length;
      assert.equal(existsCount, 1, "Must flatten same-variant conditions into exactly one EXISTS clause");
    });

    test("Positive OR between product conditions works as expected", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "group",
          operator: "OR",
          children: [
            { kind: "condition", field: "product.title", operator: "eq", value: "Equal Price Item" },
            { kind: "condition", field: "product.title", operator: "eq", value: "Discounted Item" },
          ],
        },
      };

      const { result } = await executeFilter(ast);
      assert.deepEqual([...result.productIds].sort(), [productDbIds["101"], productDbIds["102"]].sort());
    });

    test("Mixed product and variant OR fails closed with UNSUPPORTED_OPERATION", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "group",
          operator: "OR",
          children: [
            { kind: "condition", field: "product.title", operator: "eq", value: "Equal Price Item" },
            {
              kind: "condition",
              field: "variant.price",
              operator: "lt",
              value: { kind: "field", field: "variant.compareAtPrice" },
            },
          ],
        },
      };

      await assert.rejects(
        () => compiler.validateFilter(ast, { authContext: authContextA, operation: "filter", executionContext: execContextA }),
        (err) => err instanceof FieldError && err.code === C.UNSUPPORTED_OPERATION
      );
    });

    test("Variant condition inside NOT fails closed with UNSUPPORTED_OPERATION", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "group",
          operator: "NOT",
          children: [
            {
              kind: "condition",
              field: "variant.price",
              operator: "lt",
              value: { kind: "field", field: "variant.compareAtPrice" },
            },
          ],
        },
      };

      await assert.rejects(
        () => compiler.validateFilter(ast, { authContext: authContextA, operation: "filter", executionContext: execContextA }),
        (err) => err instanceof FieldError && err.code === C.UNSUPPORTED_OPERATION
      );
    });
  });

  // --------------------------------------------------------------------------
  // 6. Tenant and Generation Isolation in Real PostgreSQL
  // --------------------------------------------------------------------------
  describe("Tenant and Generation Isolation", () => {
    test("Shop A query never returns Shop B rows even when Shop B matches identical filter", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "lt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      };

      const { result } = await executeFilter(ast);
      assert.ok(!result.productIds.includes(productDbIds["201"]), "Must not contain Product 201 from Shop B");
    });

    test("Shop B authentication returns only Shop B rows", async () => {
      const authContextB = Object.freeze({ session: "shop-b-session", shop: SHOP_B });
      const execContextB = Object.freeze({ operationId: "op-b", generationId: GEN_B_PUBLISHED });

      const fieldServiceB = createFieldService({
        resolveShop: async () => SHOP_B,
        verifyCoverage: createMirrorCoverageService({ repository: publicationRepo }).getVerifiedCoverage,
        authorizeAccess: async () => true,
        adapter: {
          resolveOne() { assert.fail("Unexpected dynamic lookup"); },
          resolveBatch() { assert.fail("Unexpected dynamic lookup"); },
        },
      });

      const { compiler: compilerB } = await createInstalledFilterCompiler({
        database: pool,
        fieldService: fieldServiceB,
        cursorService,
      });

      const executorB = createFilterExecutor({
        database: pool,
        publicationService,
        resolveShop: async () => SHOP_B,
        compiler: compilerB,
      });

      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "lt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      };

      const validated = await compilerB.validateFilter(ast, {
        authContext: authContextB,
        operation: "filter",
        executionContext: execContextB,
      });
      const query = await compilerB.compileFilter(validated, { authContext: authContextB, pageSize: 50 });
      const result = await executorB.execute({ query, authContext: authContextB });

      assert.deepEqual(result.productIds, [productDbIds["201"]]);
    });

    test("Shop A query on published generation never returns retired generation rows", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "lt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      };

      const { result } = await executeFilter(ast);
      assert.ok(!result.productIds.includes(productDbIds["109"]), "Must not contain Product 109 from gen-retired");
    });
  });

  // --------------------------------------------------------------------------
  // 7. Keyset Pagination & Signed Cursor Replay
  // --------------------------------------------------------------------------
  describe("Keyset Keyset Pagination on PostgreSQL", () => {
    test("Paginates through matching products with deterministic signed cursors", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "lt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      };

      // Page 1 with pageSize = 1
      const page1 = await executeFilter(ast, { pageSize: 1 });
      assert.equal(page1.result.productIds.length, 1);
      assert.equal(page1.result.hasMore, true);
      assert.ok(page1.result.nextCursor);

      // Page 2 using cursor from Page 1
      const page2 = await executeFilter(ast, { pageSize: 1, cursor: page1.result.nextCursor });
      assert.equal(page2.result.productIds.length, 1);
      assert.notEqual(page2.result.productIds[0], page1.result.productIds[0]);

      // Tampered cursor must fail closed with INVALID_VALUE
      await assert.rejects(
        () => executeFilter(ast, { pageSize: 1, cursor: page1.result.nextCursor.slice(0, -4) + "aaaa" }),
        (err) => err instanceof FieldError && err.code === C.INVALID_VALUE
      );
    });
  });

  // --------------------------------------------------------------------------
  // 8. Preview-to-Bulk-Edit Consistency
  // --------------------------------------------------------------------------
  describe("Preview-to-Bulk-Edit Selection Consistency", () => {
    test("Selection snapshot freezes exact membership, selection hash, and prevents post-preview drift", async () => {
      const ast = {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "lt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      };

      // Create approved selection snapshot using selectionService
      const snapshot = await selectionService.createSelection({
        authContext: authContextA,
        mode: "ALL_MATCHING",
        filter: ast,
      });

      assert.equal(snapshot.status, "APPROVED");
      assert.equal(snapshot.shopId, SHOP_A);
      assert.equal(snapshot.generationId, GEN_PUBLISHED);
      assert.ok(snapshot.selectionHash);
      assert.ok(Number(snapshot.selectedCount) >= 2);

      // Verify that selection items are durably stored in mirror.selection_items
      const items = (await query(`
        SELECT product_id FROM mirror.selection_items 
        WHERE shop_id = $1 AND snapshot_id = $2
        ORDER BY product_id ASC;
      `, [SHOP_A, snapshot.snapshotId])).rows.map((r) => r.product_id);

      assert.equal(items.length, Number(snapshot.selectedCount));

      // Simulate post-preview catalog change: update a variant price in the catalog
      await query(`ALTER TABLE mirror.variants DISABLE TRIGGER guard_generation_data;`);
      await query(`
        UPDATE mirror.variants 
        SET price = '999.00' 
        WHERE shop_id = $1 AND product_id = $2;
      `, [SHOP_A, productDbIds["102"]]);
      await query(`ALTER TABLE mirror.variants ENABLE TRIGGER guard_generation_data;`);

      // Verify that the approved selection snapshot in the database was NOT altered
      const frozenSnapshot = (await query(`
        SELECT * FROM mirror.selection_snapshots WHERE id = $1;
      `, [snapshot.snapshotId])).rows[0];

      assert.equal(frozenSnapshot.status, "APPROVED");
      assert.equal(frozenSnapshot.selection_hash, snapshot.selectionHash);
      assert.equal(Number(frozenSnapshot.selected_count), snapshot.selectedCount);

      // Verify trigger prevents modifying frozen selection items
      await assert.rejects(
        () => query(`DELETE FROM mirror.selection_items WHERE snapshot_id = $1`, [snapshot.snapshotId]),
        { code: "23514" } // check constraint / trigger violation
      );

      // Verify trigger prevents modifying frozen snapshot filter_ast
      await assert.rejects(
        () => query(`UPDATE mirror.selection_snapshots SET filter_ast = '{"drift":true}' WHERE id = $1`, [snapshot.snapshotId]),
        { code: "23514" }
      );

      // Reset variant price
      await query(`ALTER TABLE mirror.variants DISABLE TRIGGER guard_generation_data;`);
      await query(`
        UPDATE mirror.variants 
        SET price = '19.99' 
        WHERE shop_id = $1 AND product_id = $2;
      `, [SHOP_A, productDbIds["102"]]);
      await query(`ALTER TABLE mirror.variants ENABLE TRIGGER guard_generation_data;`);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Query Performance & EXPLAIN (ANALYZE, BUFFERS)
  // --------------------------------------------------------------------------
  describe("Query Performance & Execution Plan Analysis", () => {
    test("EXPLAIN (ANALYZE, BUFFERS) verifies index usage and correlation cost", async () => {
      const explainQuery = async (label, ast) => {
        const validated = await compiler.validateFilter(ast, {
          authContext: authContextA,
          operation: "filter",
          executionContext: execContextA,
        });
        const compiled = await compiler.compileFilter(validated, {
          authContext: authContextA,
          pageSize: 50,
        });
        const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${compiled.text}`;
        const explainRes = await query(explainSql, compiled.values);
        const planData = explainRes.rows[0]["QUERY PLAN"][0];
        assert.ok(planData.Plan);
        assert.ok(planData["Execution Time"] < 50, `${label} execution time was ${planData["Execution Time"]}ms`);
        console.log(`EXPLAIN PLAN [${label}]:`, JSON.stringify({
          executionTimeMs: planData["Execution Time"],
          planningTimeMs: planData["Planning Time"],
          nodeType: planData.Plan["Node Type"],
          sharedHitBlocks: planData.Plan["Shared Hit Blocks"] ?? 0,
          planRows: planData.Plan["Plan Rows"],
          actualRows: planData.Plan["Actual Rows"],
        }));
        return planData;
      };

      // 1. Specific Products
      await explainQuery("Specific Products", {
        version: 1,
        root: {
          kind: "condition",
          field: "product.id",
          operator: "in",
          value: ["gid://shopify/Product/101", "gid://shopify/Product/102"],
        },
      });

      // 2. Compare-at Price is Blank
      await explainQuery("Compare-at Price is Blank", {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.compareAtPrice",
          operator: "is_null",
        },
      });

      // 3. Price < Compare-at Price
      await explainQuery("Price < Compare-at Price", {
        version: 1,
        root: {
          kind: "condition",
          field: "variant.price",
          operator: "lt",
          value: { kind: "field", field: "variant.compareAtPrice" },
        },
      });

      // 4. Conjunction: Product AND Variant
      await explainQuery("Product AND Variant Conjunction", {
        version: 1,
        root: {
          kind: "group",
          operator: "AND",
          children: [
            { kind: "condition", field: "product.id", operator: "in", value: ["gid://shopify/Product/101"] },
            {
              kind: "condition",
              field: "variant.price",
              operator: "lt",
              value: { kind: "field", field: "variant.compareAtPrice" },
            },
          ],
        },
      });
    });
  });
});
