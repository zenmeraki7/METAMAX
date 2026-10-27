import { test } from "node:test";
import assert from "node:assert/strict";
import { publishGeneration } from "../../mirror/publish.js";

test("publishGeneration validates input arguments", async () => {
  const mockDb = { query: async () => ({ rows: [] }) };

  await assert.rejects(
    publishGeneration(mockDb, { shopId: "", generationId: "gen-1" }),
    /shopId is required/
  );

  await assert.rejects(
    publishGeneration(mockDb, { shopId: "shop-1", generationId: "" }),
    /generationId is required/
  );

  await assert.rejects(
    publishGeneration(null, { shopId: "shop-1", generationId: "gen-1" }),
    /A PostgreSQL client or connection pool/
  );
});

test("publishGeneration rejects if generation is not READY", async () => {
  const queries = [];
  const mockDb = {
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("FROM mirror_generations")) {
          return { rows: [{ sequence: "1", status: "BUILDING" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  };

  await assert.rejects(
    publishGeneration(mockDb, { shopId: "shop-1", generationId: "gen-1" }),
    /Generation is not ready/
  );

  assert.ok(queries.some((q) => q.sql === "BEGIN"));
  assert.ok(queries.some((q) => q.sql === "ROLLBACK"));
});

test("publishGeneration rejects if CORE_DATASETS are not VERIFIED", async () => {
  const mockDb = {
    connect: async () => ({
      query: async (sql) => {
        if (sql.includes("FROM mirror_generations")) {
          return { rows: [{ sequence: "2", status: "READY" }] };
        }
        if (sql.includes("FROM mirror_coverage")) {
          // Only products verified, variants missing
          return { rows: [{ dataset: "products" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  };

  await assert.rejects(
    publishGeneration(mockDb, { shopId: "shop-1", generationId: "gen-2" }),
    /Dataset is not verified: variants/
  );
});

test("publishGeneration enforces monotonic progression over existing published generation", async () => {
  const mockDb = {
    connect: async () => ({
      query: async (sql) => {
        if (sql.includes("FROM mirror_generations")) {
          return { rows: [{ sequence: "5", status: "READY" }] };
        }
        if (sql.includes("FROM mirror_coverage")) {
          return { rows: [{ dataset: "products" }, { dataset: "variants" }] };
        }
        if (sql.includes("FROM mirror_publications")) {
          // Existing publication is already sequence 5
          return { rows: [{ sequence: "5" }] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  };

  await assert.rejects(
    publishGeneration(mockDb, { shopId: "shop-1", generationId: "gen-5" }),
    /Cannot publish an older generation/
  );
});

test("publishGeneration publishes verified newer generation and retires prior active generation", async () => {
  const queries = [];
  let released = false;

  const mockDb = {
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("FROM mirror_generations") && sql.includes("FOR UPDATE")) {
          return { rows: [{ sequence: "10", status: "READY" }] };
        }
        if (sql.includes("FROM mirror_coverage")) {
          return { rows: [{ dataset: "products" }, { dataset: "variants" }] };
        }
        if (sql.includes("FROM mirror_publications") && sql.includes("FOR UPDATE")) {
          return { rows: [{ sequence: "8" }] };
        }
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  };

  const result = await publishGeneration(mockDb, {
    shopId: "store.myshopify.com",
    generationId: "gen-10",
  });

  assert.deepEqual(result, {
    shopId: "store.myshopify.com",
    generationId: "gen-10",
    published: true,
  });
  assert.ok(released);

  const sqls = queries.map((q) => q.sql);
  assert.equal(sqls[0], "BEGIN");
  assert.ok(sqls[1].includes("pg_advisory_xact_lock"));
  assert.ok(sqls[2].includes("FROM mirror_generations"));
  assert.ok(sqls[3].includes("FROM mirror_coverage"));
  assert.ok(sqls[4].includes("FROM mirror_publications"));
  assert.ok(sqls[5].includes("INSERT INTO mirror_publications"));
  assert.ok(sqls[6].includes("status = 'RETIRED'"));
  assert.ok(sqls[7].includes("status = 'PUBLISHED'"));
  assert.equal(sqls[8], "COMMIT");

  // Verify advisory lock parameter
  assert.equal(queries[1].params[0], "mirror-publish:store.myshopify.com");
});
