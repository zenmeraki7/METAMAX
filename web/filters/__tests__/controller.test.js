import test from "node:test";
import assert from "node:assert/strict";
import { createFiltersController } from "../../controllers/filters.controller.js";
import { FieldError, FIELD_ERROR_CODES as C } from "../../fields/types.js";
import { FilterInfrastructureError } from "../errors.js";

function fixture() {
  const calls = [];
  const authContext = Object.freeze({ session: "server-session" });
  const context = { executionContext: { generationId: "published", operationId: "server-operation" }, datasets: ["products"] };
  const validated = {}, query = {}, result = { productIds: ["123"] };
  const req = { body: { filter: { version: 1, root: { kind: "condition", field: "product.title", operator: "eq", value: "Summer" } } } };
  const res = {
    headers: {}, headersSent: false,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  const deps = {
    async authenticate(request) { calls.push(["authenticate", request]); return authContext; },
    async resolveDatasets(input) { calls.push(["resolve", input]); return context; },
    compiler: {
      async validateFilter(filter, options) { calls.push(["validate", filter, options]); return validated; },
      async compileFilter(contract, options) { calls.push(["compile", contract, options]); return query; },
    },
    executor: { async execute(input) { calls.push(["execute", input]); return result; } },
    logger: { error(...args) { calls.push(["log", ...args]); } },
  };
  return { calls, req, res, deps, authContext, context, validated, query, result,
    search: () => createFiltersController(deps).search(req, res, error => calls.push(["next", error])) };
}

test("controller requires all trusted dependencies", () => {
  for (const key of ["authenticate", "compiler", "executor", "resolveDatasets"]) {
    const f = fixture();
    delete f.deps[key];
    assert.throws(() => createFiltersController(f.deps), TypeError);
  }
  assert.ok(Object.isFrozen(createFiltersController(fixture().deps)));
});

test("controller passes only authenticated server context through validation, compilation and execution", async () => {
  for (const cursor of [undefined, "signed-cursor"]) {
    const f = fixture();
    if (cursor) Object.assign(f.req.body, { cursor, pageSize: 25 });
    await f.search();
    assert.deepEqual(f.calls, [
      ["authenticate", f.req],
      ["resolve", { authContext: f.authContext, filter: f.req.body.filter, ...(cursor ? {cursor} : {}) }],
      ["validate", f.req.body.filter, { authContext: f.authContext, operation: "filter", executionContext: f.context.executionContext }],
      ["compile", f.validated, { authContext: f.authContext, pageSize: cursor ? 25 : 50, ...(cursor ? { cursor } : {}) }],
      ["execute", { query: f.query, authContext: f.authContext }],
    ]);
    assert.equal(f.res.statusCode, 200);
    assert.strictEqual(f.res.body.data, f.result);
    assert.equal(f.res.headers["Cache-Control"], "private, no-store");
  }
});

test("controller does not read or forward a preparation dataset list", async () => {
  const f = fixture();
  Object.defineProperty(f.context, "datasets", { get() { assert.fail("Preparation datasets were trusted"); } });
  await f.search();
  assert.equal(f.res.statusCode, 200);
  assert.deepEqual(f.calls.find(([name]) => name === "execute"), ["execute", { query: f.query, authContext: f.authContext }]);
});

test("controller rejects unauthenticated requests before resolving dependencies", async () => {
  const f = fixture();
  f.deps.authenticate = async () => null;
  await f.search();
  assert.equal(f.res.statusCode, 401);
  assert.equal(f.res.body.error.code, "UNAUTHENTICATED");
  assert.deepEqual(f.calls, []);
  assert.equal(f.res.headers["Cache-Control"], "private, no-store");
});

test("controller rejects browser targeting overrides, invalid pagination and oversized bodies before planning", async () => {
  const bodies = [null, [], "filter", ...["shopId", "generationId", "sql", "datasets", "executionContext"].map(key => ({ filter: {}, [key]: "untrusted" })),
    ...[null, "50", 0, 101, 1.5].map(pageSize => ({ filter: {}, pageSize })),
    ...[null, 123, "", "x".repeat(4097)].map(cursor => ({ filter: {}, cursor }))];
  for (const body of bodies) {
    const f = fixture(); f.req.body = body;
    await f.search();
    assert.equal(f.res.statusCode, 400);
    assert.equal(f.res.body.error.code, "FILTER_INVALID_INPUT");
    assert.ok(!f.calls.some(([name]) => ["resolve", "validate", "compile", "execute"].includes(name)));
  }
  const f = fixture();
  f.req.body.filter = "界".repeat(45000);
  await f.search();
  assert.equal(f.res.statusCode, 413);
  assert.deepEqual(f.calls, [["authenticate", f.req]]);
});

test("controller sanitizes failures and stops the pipeline at the failing dependency", async () => {
  for (const [stage, error, status, code] of [
    ["resolveDatasets", new FieldError(C.MISSING_DEPENDENCY, "private coverage details"), 503, "FILTER_COVERAGE_UNAVAILABLE"],
    ["validateFilter", new FieldError(C.PERMISSION_DENIED, "private authorization details"), 403, "FILTER_PERMISSION_DENIED"],
    ["compileFilter", new FieldError(C.INVALID_VALUE, "private filter details"), 400, "FILTER_INVALID_INPUT"],
    ["execute", new FilterInfrastructureError(new Error("private database details")), 503, "FILTER_INFRASTRUCTURE_UNAVAILABLE"],
  ]) {
    const f = fixture();
    const owner = stage === "resolveDatasets" ? f.deps : stage === "execute" ? f.deps.executor : f.deps.compiler;
    owner[stage] = async () => { throw error; };
    await f.search();
    assert.equal(f.res.statusCode, status);
    assert.equal(f.res.body.error.code, code);
    assert.equal(JSON.stringify(f.res.body).includes("private"), false);
    assert.strictEqual(f.calls.at(-1)[1].cause, error);
    assert.ok(!f.calls.some(([name]) => name === "execute"));
  }
});

test("controller delegates failures to Express when headers have already been sent", async () => {
  const f = fixture(), error = new Error("connection failure");
  f.res.headersSent = true;
  f.deps.executor.execute = async () => { throw error; };
  await f.search();
  assert.deepEqual(f.calls.at(-1), ["next", error]);
  assert.equal(f.res.body, undefined);
});
