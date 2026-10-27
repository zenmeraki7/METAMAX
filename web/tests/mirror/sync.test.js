import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestCatalogSync,
  getCatalogRun,
  transitionCatalogRun,
  failCatalogRun,
  allocateNextGeneration,
} from "../../mirror/sync.js";

test("requestCatalogSync validates shop ID argument", async () => {
  const mockDb = { query: async () => ({ rows: [] }) };

  await assert.rejects(
    requestCatalogSync(mockDb, ""),
    /Trusted shop ID required/
  );
  await assert.rejects(
    requestCatalogSync(mockDb, null),
    /Trusted shop ID required/
  );
  await assert.rejects(
    requestCatalogSync(null, "example.myshopify.com"),
    /A PostgreSQL client or connection pool/
  );
});

test("requestCatalogSync returns existing active run without allocating a new generation", async () => {
  const queries = [];
  let released = false;

  const mockDb = {
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("FROM mirror_catalog_runs") && sql.includes("state IN")) {
          return {
            rows: [
              {
                id: "run-active-1",
                generation_id: "gen-1",
                state: "INGESTING",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  };

  const result = await requestCatalogSync(mockDb, "test-store.myshopify.com");

  assert.deepEqual(result, {
    id: "run-active-1",
    generation_id: "gen-1",
    state: "INGESTING",
    existing: true,
  });
  assert.ok(released);

  // Assert transaction sequence: BEGIN -> LOCK -> SELECT active -> COMMIT
  const sqls = queries.map((q) => q.sql);
  assert.equal(sqls[0], "BEGIN");
  assert.ok(sqls[1].includes("pg_advisory_xact_lock"));
  assert.ok(sqls[2].includes("FROM mirror_catalog_runs"));
  assert.equal(sqls[3], "COMMIT");

  // Verify advisory lock parameter
  assert.equal(queries[1].params[0], "catalog-request:test-store.myshopify.com");
});

test("requestCatalogSync allocates next generation and creates fresh catalog run", async () => {
  const queries = [];
  let released = false;

  const mockDb = {
    connect: async () => ({
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes("FROM mirror_catalog_runs") && sql.includes("LIMIT 1")) {
          return { rows: [] }; // No active run
        }
        if (sql.includes("SELECT COALESCE(MAX(sequence)")) {
          return { rows: [{ next: "4" }] };
        }
        if (sql.includes("INSERT INTO mirror_generations")) {
          return { rows: [{ id: "gen-uuid-4" }] };
        }
        if (sql.includes("INSERT INTO mirror_catalog_runs")) {
          return {
            rows: [
              {
                id: "run-uuid-1",
                generation_id: "gen-uuid-4",
                state: "REQUESTED",
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  };

  const result = await requestCatalogSync(mockDb, "test-store.myshopify.com");

  assert.deepEqual(result, {
    id: "run-uuid-1",
    generation_id: "gen-uuid-4",
    state: "REQUESTED",
    existing: false,
  });
  assert.ok(released);

  const sqls = queries.map((q) => q.sql);
  assert.equal(sqls[0], "BEGIN");
  assert.ok(sqls[1].includes("pg_advisory_xact_lock"));
  assert.ok(sqls[2].includes("FROM mirror_catalog_runs"));
  assert.ok(sqls[3].includes("pg_advisory_xact_lock")); // in allocateNextGeneration
  assert.ok(sqls[4].includes("MAX(sequence)"));
  assert.ok(sqls[5].includes("INSERT INTO mirror_generations"));
  assert.ok(sqls[6].includes("INSERT INTO mirror_catalog_runs"));
  assert.equal(sqls[7], "COMMIT");
});

test("getCatalogRun retrieves run by ID", async () => {
  const mockDb = {
    query: async (sql, params) => {
      assert.ok(sql.includes("FROM mirror_catalog_runs") && sql.includes("WHERE id = $1"));
      assert.equal(params[0], "run-100");
      return { rows: [{ id: "run-100", state: "RUNNING" }] };
    },
  };

  const run = await getCatalogRun(mockDb, "run-100");
  assert.equal(run.id, "run-100");
  assert.equal(run.state, "RUNNING");

  const notFound = await getCatalogRun(
    { query: async () => ({ rows: [] }) },
    "non-existent"
  );
  assert.equal(notFound, null);
});

test("transitionCatalogRun applies compare-and-set updates safely", async () => {
  let executedSql = null;
  let executedParams = null;

  const mockDb = {
    query: async (sql, params) => {
      executedSql = sql;
      executedParams = params;
      return {
        rowCount: 1,
        rows: [
          {
            id: "run-1",
            state: "RUNNING",
            bulk_operation_id: "gid://shopify/BulkOperation/1",
          },
        ],
      };
    },
  };

  const updated = await transitionCatalogRun(mockDb, {
    runId: "run-1",
    from: "REQUESTED",
    to: "RUNNING",
    values: {
      bulkOperationId: "gid://shopify/BulkOperation/1",
    },
  });

  assert.equal(updated.state, "RUNNING");
  assert.ok(executedSql.includes("WHERE id = $1 AND state = $2"));
  assert.equal(executedParams[0], "run-1");
  assert.equal(executedParams[1], "REQUESTED");
  assert.equal(executedParams[2], "RUNNING");
  assert.equal(executedParams[3], "gid://shopify/BulkOperation/1");
});

test("transitionCatalogRun fails closed on state conflict or invalid fields", async () => {
  const mockDbConflict = {
    query: async () => ({
      rowCount: 0,
      rows: [],
    }),
  };

  await assert.rejects(
    transitionCatalogRun(mockDbConflict, {
      runId: "run-1",
      from: "REQUESTED",
      to: "RUNNING",
    }),
    /Catalog sync state conflict: REQUESTED -> RUNNING/
  );

  // Unsupported transition field throws
  await assert.rejects(
    transitionCatalogRun(mockDbConflict, {
      runId: "run-1",
      from: "REQUESTED",
      to: "RUNNING",
      values: { maliciousColumn: "value" },
    }),
    /Unsupported transition field: maliciousColumn/
  );
});

test("failCatalogRun updates state to FAILED with message", async () => {
  let executedSql = null;
  let executedParams = null;

  const mockDb = {
    query: async (sql, params) => {
      executedSql = sql;
      executedParams = params;
      return { rowCount: 1 };
    },
  };

  await failCatalogRun(mockDb, "run-1", new Error("Shopify API timeout"));

  assert.ok(executedSql.includes("SET state = 'FAILED'"));
  assert.ok(executedSql.includes("error_message = $2"));
  assert.ok(executedSql.includes("state NOT IN") && executedSql.includes("'NEEDS_REVIEW'"));
  assert.equal(executedParams[0], "run-1");
  assert.equal(executedParams[1], "Shopify API timeout");
});

test("allocateNextGeneration serializes sequence generation per shop", async () => {
  const queries = [];
  const mockClient = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes("SELECT COALESCE(MAX(sequence)")) {
        return { rows: [{ next: "10" }] };
      }
      if (sql.includes("INSERT INTO mirror_generations")) {
        return { rows: [{ id: "new-gen-id" }] };
      }
      return { rows: [] };
    },
  };

  const gen = await allocateNextGeneration(mockClient, "test-shop.myshopify.com");
  assert.equal(gen.id, "new-gen-id");
  assert.equal(gen.sequence, 10);
  assert.equal(queries[0].params[0], "catalog-request:test-shop.myshopify.com");
});
