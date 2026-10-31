import test from "node:test";
import assert from "node:assert/strict";
import { createPerformanceProfiler } from "./database-performance.server.js";

test("database performance: keyset pagination eliminates offset-based degradation across catalog scales", () => {
  const profiler = createPerformanceProfiler();

  for (const scale of [100, 10000, 100000]) {
    const evalResult = profiler.evaluatePaginationComplexity({
      pageSize: 25,
      totalCatalogSize: scale,
      targetPage: 200,
    });

    assert.equal(evalResult.hasOffsetDegradation, false);
    assert.equal(evalResult.keysetRowsScanned, 25);
    assert.ok(evalResult.offsetRowsScanned > evalResult.keysetRowsScanned);
    assert.ok(evalResult.btreeDepth <= 17); // B-tree index depth is bounded
  }
});

test("database performance: tenant isolation and publication consistency verification", () => {
  const profiler = createPerformanceProfiler();

  const validRows = [
    { id: "1", shop_id: "shop.myshopify.com", generation_id: "gen-1" },
    { id: "2", shop_id: "shop.myshopify.com", generation_id: "gen-1" },
    { id: "3", shop_id: "shop.myshopify.com", generation_id: "gen-1" },
  ];

  const validCheck = profiler.verifyTenantIsolation({
    rows: validRows,
    expectedShopId: "shop.myshopify.com",
    expectedGenerationId: "gen-1",
  });

  assert.equal(validCheck.isolated, true);
  assert.equal(validCheck.unauthorizedRows, 0);
  assert.equal(validCheck.mixedGenerations, 0);

  // Cross-tenant breach simulation
  const crossTenantRows = [
    { id: "1", shop_id: "shop.myshopify.com", generation_id: "gen-1" },
    { id: "2", shop_id: "attacker.myshopify.com", generation_id: "gen-1" },
  ];

  const breachCheck = profiler.verifyTenantIsolation({
    rows: crossTenantRows,
    expectedShopId: "shop.myshopify.com",
    expectedGenerationId: "gen-1",
  });

  assert.equal(breachCheck.isolated, false);
  assert.equal(breachCheck.unauthorizedRows, 1);

  // Mixed generation simulation
  const mixedGenRows = [
    { id: "1", shop_id: "shop.myshopify.com", generation_id: "gen-1" },
    { id: "2", shop_id: "shop.myshopify.com", generation_id: "gen-2" },
  ];

  const mixedCheck = profiler.verifyTenantIsolation({
    rows: mixedGenRows,
    expectedShopId: "shop.myshopify.com",
    expectedGenerationId: "gen-1",
  });

  assert.equal(mixedCheck.isolated, false);
  assert.equal(mixedCheck.mixedGenerations, 1);
});

test("database performance: query plan analyzer verifies index usage", async () => {
  const mockDb = {
    async query(sql) {
      if (sql.startsWith("EXPLAIN (FORMAT JSON)")) {
        return {
          rows: [
            {
              "QUERY PLAN": [
                {
                  Plan: {
                    "Node Type": "Index Scan",
                    "Scan Direction": "Forward",
                    "Index Name": "products_shop_id_generation_id_id_key",
                    "Startup Cost": 0.42,
                    "Total Cost": 8.45,
                    "Plan Rows": 25,
                    Plans: [
                      {
                        "Node Type": "Index Only Scan",
                        "Index Name": "variants_shop_id_generation_id_product_id_id_idx",
                        "Total Cost": 4.1,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const profiler = createPerformanceProfiler({ database: mockDb });

  const planResult = await profiler.analyzeQueryPlan({
    sql: "SELECT p.id FROM mirror.products p WHERE p.shop_id = $1 AND p.generation_id = $2 AND p.id > $3 LIMIT $4",
    params: ["shop.myshopify.com", "gen-1", 100, 25],
  });

  assert.equal(planResult.usesIndex, true);
  assert.equal(planResult.nodeType, "Index Scan");
  assert.ok(planResult.indexNames.includes("products_shop_id_generation_id_id_key"));
  assert.ok(planResult.indexNames.includes("variants_shop_id_generation_id_product_id_id_idx"));
  assert.ok(planResult.totalCost < 50);
});

test("database performance: partial index efficiency eliminates write amplification on clean rows", () => {
  const profiler = createPerformanceProfiler();

  const efficiency = profiler.evaluatePartialIndexEfficiency({
    totalCatalogRows: 100000,
    dirtyRows: 50, // 50 pending webhook updates
    dueOperations: 5,
  });

  assert.equal(efficiency.writeAmplificationEliminated, true);
  assert.equal(Number(efficiency.dirtyIndexReductionPercent) > 99.9, true);
  assert.equal(efficiency.dirtyRows, 50);
});
