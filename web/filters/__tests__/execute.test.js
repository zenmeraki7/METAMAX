import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { normalizePageSize, createFilterExecutor } from "../execute.js";
import { FieldError, FIELD_ERROR_CODES as C } from "../../fields/types.js";
import { FilterInfrastructureError } from "../errors.js";

test("page size defaults to 50 and accepts positive sizes through 100", () => {
  assert.equal(normalizePageSize(), 50);
  for (const value of [1, 50, 100]) assert.equal(normalizePageSize(value), value);
});

test("page size rejects oversized, missing-like, coerced and unsafe input", () => {
  for (const value of [null, "50", 0, -0, -1, 101, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => normalizePageSize(value), { code: C.INVALID_VALUE });
  }
});

test("the real executor compiler boundary rejects browser-supplied SQL", async () => {
  const executor = createFilterExecutor({
    database: { connect() { assert.fail("Untrusted SQL reached the database"); } },
    publicationService: { requirePublished() { assert.fail("Untrusted SQL reached publication validation"); } },
    resolveShop: async () => "alpha.myshopify.com",
    compiler: {
      authorizeExecution() { assert.fail("Untrusted SQL reached authorization"); },
      getExecutionPlan() { assert.fail("Untrusted SQL reached dependency planning"); },
      createCursor() { assert.fail("Untrusted SQL reached cursor issuance"); },
    },
  });
  await assert.rejects(executor.execute({
    query: { version: 4, kind: "product_ids", text: "SELECT * FROM products", values: [],
      parameterCount: 0, pageSize: 50, binding: { shopId: "alpha.myshopify.com", generationId: "g1", coverageRevision: "r1" } },
    authContext: {},
  }), { code: C.PERMISSION_DENIED });
});

describe("transactional filter executor", async () => {
  // Only the compiler boundary is mocked. Compiler provenance is covered by
  // compile.test.js; this suite exercises database and publication failures.
  const issued = new WeakSet();
  const dependency = mock.module("../compile.js", { namedExports: {
    FILTER_COMPILER_VERSION: 4,
    assertCompiledFilter(query) {
      if (!issued.has(query)) throw new FieldError(C.PERMISSION_DENIED, "Untrusted compiled query");
    },
  } });
  let createFilterExecutor;
  try { ({ createFilterExecutor } = await import("../execute.js?transaction-tests")); }
  finally { dependency.restore(); }

  function fixture(options = {}) {
    const events = [];
    const requiredDatasets = Object.freeze(["products", "variants"]);
    const query = Object.freeze({ version: 4,
      resolverVersion: 1, requiredDatasets, kind: "product_ids", text: "SELECT product_id FROM trusted_plan",
      values: Object.freeze([]), parameterCount: 0, pageSize: 2,
      binding: Object.freeze({ shopId: "alpha.myshopify.com", generationId: "g1", coverageRevision: "r1" }),
      ...options.query });
    issued.add(query);
    const client = {
      async query(sql, values) {
        events.push({ sql, values });
        if (options.failAt === sql || (typeof sql === "object" && options.failAt === "select")) throw options.error;
        if (typeof sql === "object") return options.result ?? { fields: [{ name: "product_id" }], rows: [["a"], ["b"], ["c"]] };
      },
      release() { events.push("release"); },
    };
    const dependencies = {
      database: { async connect() { events.push("connect"); if (options.connectError) throw options.connectError; return client; } },
      publicationService: { async requirePublished(input) {
        events.push({ publication: input });
        if (options.publicationError) throw options.publicationError;
      } },
      async resolveShop(auth) { events.push({ auth }); return options.shop ?? "alpha.myshopify.com"; },
      compiler: {
        async authorizeExecution(plan, auth) {
          assert.equal(plan, query); events.push({ authorize: auth });
          if (options.authorizationError) throw options.authorizationError;
        },
        getExecutionPlan(plan) { assert.equal(plan, query); return { binding: query.binding, datasets: requiredDatasets }; },
        createCursor(plan, id) { assert.equal(plan, query); events.push({ cursor: id }); return "signed-cursor"; },
      },
    };
    const executor = createFilterExecutor(dependencies);
    return { events, query, client, dependencies, run: changes => executor.execute({
      query, authContext: "verified-session", ...changes,
    }) };
  }

  test("requires every trusted dependency at construction", () => {
    const { dependencies } = fixture();
    for (const key of Object.keys(dependencies)) assert.throws(() => createFilterExecutor({ ...dependencies, [key]: null }), TypeError);
  });

  test("authenticates, protects publication and sets local timeouts before selecting", async () => {
    const f = fixture();
    const result = await f.run();
    assert.deepEqual(f.events, [
      { auth: "verified-session" }, "connect",
      { sql: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY", values: undefined },
      { sql: "SET LOCAL statement_timeout = '5000ms'", values: undefined },
      { sql: "SET LOCAL lock_timeout = '1000ms'", values: undefined },
      { publication: { client: f.client, shopId: "alpha.myshopify.com", generationId: "g1", coverageRevision: "r1", datasets: ["products", "variants"] } },
      { auth: "verified-session" }, { authorize: "verified-session" },
      { sql: { text: f.query.text, values: f.query.values, rowMode: "array" }, values: undefined },
      { sql: "COMMIT", values: undefined }, { cursor: "b" }, "release",
    ]);
    assert.deepEqual(result, { productIds: ["a", "b"], pageSize: 2, hasMore: true, nextCursor: "signed-cursor", generationId: "g1", coverageRevision: "r1" });
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.productIds));
  });

  test("compiler provenance cannot bypass revoked execution permissions", async () => {
    const error = new FieldError(C.PERMISSION_DENIED, "Permission revoked after compilation");
    const f = fixture({ authorizationError:error });
    await assert.rejects(f.run(), error);
    assert.ok(!f.events.some(event => typeof event?.sql === "object"));
    assert.equal(f.events.at(-2).sql,"ROLLBACK");
    assert.equal(f.events.at(-1),"release");
  });

  test("rejects forged queries and other tenants before connecting", async () => {
    for (const changes of [{ query: {} }, { query: { ...fixture().query } }]) {
      const f = fixture();
      await assert.rejects(f.run(changes), { code: C.PERMISSION_DENIED });
      assert.ok(!f.events.includes("connect"));
    }
    for (const shop of ["other.myshopify.com", "", "x\0y", "x".repeat(256)]) {
      const f = fixture({ shop });
      await assert.rejects(f.run(), { code: C.PERMISSION_DENIED });
      assert.ok(!f.events.includes("connect"));
    }
  });

  test("rejects incomplete bindings, parameter budgets and invalid trusted datasets", async () => {
    for (const query of [{ binding: { shopId: "alpha.myshopify.com" } }, { parameterCount: 1 }, { text: "x".repeat(65537) }, { pageSize: 101 },
      { requiredDatasets: undefined }, { requiredDatasets: [] }, { requiredDatasets: Object.freeze(["products", "variants"]) }, { resolverVersion: 2 }]) {
      const f = fixture({ query });
      await assert.rejects(f.run(), FieldError);
      assert.ok(!f.events.includes("connect"));
    }
    for (const datasets of [undefined, [], ["products"], ["products", "variants"], ["products", "products"], ["products; DROP TABLE"], [null], Array(33).fill("products")]) {
      const f = fixture();
      await assert.rejects(f.run({ datasets }), { code: C.CONTRACT_MISMATCH });
      assert.ok(!f.events.includes("connect"));
    }
  });

  test("short, empty and exactly full final pages need no cursor", async () => {
    for (const rows of [[], [["a"]], [["a"], ["b"]]]) {
      const f = fixture({ result: { fields: [{ name: "product_id" }], rows } });
      const result = await f.run();
      assert.equal(result.hasMore, false);
      assert.equal(result.nextCursor, null);
      assert.deepEqual(result.productIds, rows.flat());
    }
  });

  test("old execution contracts are rejected and lookahead metadata cannot be supplied by the caller", async () => {
    const f = fixture({ query: { version: 3 } });
    await assert.rejects(f.run(), { code: C.PERMISSION_DENIED });
    assert.ok(!f.events.includes("connect"));
    const current = fixture();
    const raw = Object.defineProperty({ query: current.query, authContext: "verified-session" }, "datasets", {
      get() { assert.fail("Caller dataset getter executed"); },
    });
    await assert.rejects(() => createFilterExecutor(current.dependencies).execute(raw), { code: C.CONTRACT_MISMATCH });
    assert.deepEqual(current.events, []);
  });

  test("publication denial rolls back without running the product query", async () => {
    const error = new FieldError(C.MISSING_DEPENDENCY, "Retired generation");
    const f = fixture({ publicationError: error });
    await assert.rejects(f.run(), e => e === error);
    assert.ok(!f.events.some(event => typeof event.sql === "object"));
    assert.deepEqual(f.events.slice(-2), [{ sql: "ROLLBACK", values: undefined }, "release"]);
  });

  test("database failures roll back and preserve their cause behind a safe error", async () => {
    for (const failAt of ["select", "COMMIT", "SET LOCAL statement_timeout = '5000ms'"]) {
      const error = new Error("private database detail");
      const f = fixture({ failAt, error });
      await assert.rejects(f.run(), e => e instanceof FilterInfrastructureError && e.cause === error && !e.message.includes("private"));
      assert.deepEqual(f.events.slice(-2), [{ sql: "ROLLBACK", values: undefined }, "release"]);
    }
    const error = new Error("connection unavailable");
    const f = fixture({ connectError: error });
    await assert.rejects(f.run(), e => e.cause === error);
    assert.ok(!f.events.includes("release"));
  });

  test("invalid projections, IDs, row counts and response bytes roll back", async () => {
    for (const result of [
      { fields: [], rows: [] },
      { fields: [{ name: "wrong" }], rows: [] },
      ...[[["a"], ["b"], ["c"], ["d"]], [["a"], ["b"], [null]], [["a"], ["b"], ["c","extra"]],
        [[null]], [[""]], [["a\0b"]], [["x".repeat(512 * 1024 + 1)]]].map(rows => ({ fields: [{ name: "product_id" }], rows })),
    ]) {
      const f = fixture({ result });
      await assert.rejects(f.run(), FieldError);
      assert.deepEqual(f.events.slice(-2), [{ sql: "ROLLBACK", values: undefined }, "release"]);
    }
  });
});
