/** Actual PostgreSQL execution; run via npm run test:postgres (isolated Docker). */
import { describe, test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import express from "express";
import { setTimeout as delay } from "node:timers/promises";
import { createFiltersRouter } from "../../routes/filters.routes.js";
import { createShopifyAuthMiddleware } from "../../middleware/shopify-auth.js";
import { CANONICAL_FIELDS } from "../../fields/canonical.js";
import { SOURCE_DATASETS } from "../../fields/sources.js";
import { deepFreeze, FieldError, FIELD_ERROR_CODES as C } from "../../fields/types.js";
import { listOperatorsForType } from "../../fields/operators.js";
import { createMirrorSqlSchema, quoteIdentifier } from "../mirror-schema.js";
import { verifyMirrorSqlSchema } from "../../services/mirror-schema.server.js";
import { createMirrorCoverageService } from "../../mirror/coverage.js";
import { createCursorService } from "../pagination.js";
import { createMirrorPublicationService } from "../../mirror/publication-service.server.js";

const target = process.env.FILTER_TEST_DATABASE_URL;
describe("actual PostgreSQL filter semantics", { concurrency: false,
  skip: !target && "Requires the disposable PostgreSQL runner: npm run test:postgres",
}, async () => {
  if (!target) return;
  const url = new URL(target);
  assert.ok(process.env.FILTER_TEST_DATABASE_ISOLATED === "1" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.pathname === "/metamax_filter_test",
  "Only an explicitly isolated localhost test database is permitted");
  const pool = new pg.Pool({ connectionString: target, max: 5, connectionTimeoutMillis: 3000, query_timeout: 10000 });
  const namespace = `metamax_filter_qa_${randomBytes(6).toString("hex")}`;
  const ns = quoteIdentifier(namespace);
  after(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${ns} CASCADE`); } finally { await pool.end(); }
  });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS mirror;
    CREATE TABLE IF NOT EXISTS mirror.shops (id text PRIMARY KEY, installation_version text NOT NULL, uninstalled_at timestamptz);
    INSERT INTO mirror.shops(id, installation_version) VALUES ('shop.myshopify.com', 'test-inst-1'), ('other.myshopify.com', 'test-inst-2') ON CONFLICT (id) DO NOTHING;
    CREATE SCHEMA ${ns};
    CREATE TABLE ${ns}.products (
      id text COLLATE "pg_catalog"."C" NOT NULL, shop_id text NOT NULL, generation_id text NOT NULL,
      title text NOT NULL, vendor text, UNIQUE(shop_id, generation_id, id));
    CREATE TABLE ${ns}.variants (
      product_id text COLLATE "pg_catalog"."C" NOT NULL, shop_id text NOT NULL, generation_id text NOT NULL,
      sku text, price numeric, taxable boolean, deleted_at timestamptz);
    CREATE INDEX ON ${ns}.variants(shop_id, generation_id, product_id);
    CREATE TABLE ${ns}.publications (shop_id text, generation_id text, status text,
      coverage_revision text NOT NULL DEFAULT 'qa_coverage_v1', PRIMARY KEY(shop_id,generation_id));
    CREATE TABLE ${ns}.coverage (shop_id text, generation_id text, name text, PRIMARY KEY(shop_id,generation_id,name));
    INSERT INTO ${ns}.products VALUES
      ('a','shop.myshopify.com','g1','All',NULL), ('b','shop.myshopify.com','g1','All','Nike'),
      ('c','shop.myshopify.com','g1','All','Puma'), ('d','shop.myshopify.com','g1','All','Other'),
      ('e','shop.myshopify.com','g1','All','Other'), ('f','shop.myshopify.com','g1','All','Decimal'),
      ('g','shop.myshopify.com','g1','All','Other'), ('x','other.myshopify.com','g1','All','Other'),
      ('z','shop.myshopify.com','g2','All','Other');
    INSERT INTO ${ns}.variants VALUES
      ('b','shop.myshopify.com','g1','ABC',100,true), ('c','shop.myshopify.com','g1','XYZ',200,false),
      ('d','shop.myshopify.com','g1','ABC',50,true), ('d','shop.myshopify.com','g1','XYZ',150,false),
      ('e','shop.myshopify.com','g1','ABC',150,true), ('f','shop.myshopify.com','g1','DEC',9007199254740993.0001,NULL),
      ('g','shop.myshopify.com','g1',NULL,NULL,NULL), ('x','other.myshopify.com','g1','ABC',150,true);
    INSERT INTO ${ns}.publications (shop_id,generation_id,status) VALUES ('shop.myshopify.com','g1','PUBLISHED'),('shop.myshopify.com','g2','PUBLISHED');
    INSERT INTO ${ns}.coverage VALUES ('shop.myshopify.com','g1','products'),('shop.myshopify.com','g1','variants'),
      ('shop.myshopify.com','g2','products'),('shop.myshopify.com','g2','variants');
    ALTER TABLE ${ns}.variants ADD COLUMN inventory_quantity bigint;
    UPDATE ${ns}.variants SET inventory_quantity=CASE WHEN price IS NULL THEN NULL WHEN price>100 THEN 20 ELSE 0 END;`);

  const columns = {
    "product.title": { column: "title", type: "text" }, "product.vendor": { column: "vendor", type: "text" },
    "variant.price": { column: "price", type: "numeric" }, "variant.sku": { column: "sku", type: "text" },
    "variant.taxable": { column: "taxable", type: "boolean" },
    "variant.inventoryQuantity": { column: "inventory_quantity", type: "bigint" },
  };
  const fieldMappings = Object.entries(columns).map(([fieldId, entry]) => ({ fieldId,
    entity: CANONICAL_FIELDS[fieldId].entity, column: entry.column, type: entry.type }));
  const FIELD_SOURCES = deepFreeze(Object.fromEntries(Object.values(CANONICAL_FIELDS).map(field => [field.id, {
    fieldId: field.id, entity: field.entity, canonicalType: field.type, canonicalDerived: field.derived, kind: "column",
    datasets: field.entity === "variant" ? ["products", "variants"] : ["products"],
    ...(columns[field.id] ? { sql: { kind: "column", alias: field.entity === "variant" ? "v" : "p",
      column: columns[field.id].column, storageType: columns[field.id].type,
      shopColumn: "shop_id", generationColumn: "generation_id" } } : {}),
  }])));
  const FILTER_SQL_SCHEMA = {
    mirrorSchemaVersion: "sql_qa_v1", sourceContractVersion: "sql_qa_sources_v1",
    product: { alias: "p", shopColumn: "shop_id", generationColumn: "generation_id", idColumn: "id" },
    variant: { schema: namespace, table: "variants", alias: "v", shopColumn: "shop_id", generationColumn: "generation_id", productIdColumn: "product_id" },
  };
  const FILTER_BINDING_DEFINITIONS = fieldMappings.map(field => ({ fieldId: field.fieldId, entity: field.entity,
    sourceKind: "column", datasets: FIELD_SOURCES[field.fieldId].datasets,
    correlation: field.entity === "variant" ? "variant_exists" : "product",
    handlerId: field.entity === "variant" ? "variant_exists_v1" : "product_column_v1",
    operators: listOperatorsForType(CANONICAL_FIELDS[field.fieldId].type).map(op => typeof op === "string" ? op : op.id),
    cost: field.entity === "variant" ? 2 : 1, mirrorSchemaVersion: "sql_qa_v1", sourceContractVersion: "sql_qa_sources_v1" }));
  const dependency = mock.module("../../fields/sources.js", { namedExports: { SOURCE_DATASETS, FIELD_SOURCES, FILTER_SQL_SCHEMA, FILTER_BINDING_DEFINITIONS } });
  let R, Q, E, HTTP;
  try {
    R = await import("../../fields/resolve.js"); Q = await import("../compile.js"); E = await import("../execute.js");
    HTTP = await import("../../services/filter-engine.server.js");
  }
  finally { dependency.restore(); }
  const repository = { getPublishedSnapshot: async input => {
    const result = await (input.client ?? pool).query(`SELECT jsonb_build_object('shopId', p.shop_id, 'generationId', p.generation_id,
      'coverageRevision', p.coverage_revision, 'status', p.status, 'mirrorSchemaVersion', 'sql_qa_v1',
      'sourceContractVersion', 'sql_qa_sources_v1', 'datasets', jsonb_agg(jsonb_build_object(
        'name', c.name, 'generationId', c.generation_id, 'status', 'COMPLETE', 'published', true))) AS snapshot
      FROM ${ns}.publications p JOIN ${ns}.coverage c ON c.shop_id=p.shop_id AND c.generation_id=p.generation_id
      WHERE p.shop_id=$1 AND p.generation_id=$2 AND c.name=ANY($3::text[]) GROUP BY p.shop_id,p.generation_id,p.status,p.coverage_revision`,
    [input.shopId, input.generationId, input.datasets]);
    return result.rows[0]?.snapshot ?? null;
  } };
  const coverage = createMirrorCoverageService({ repository });
  const publicationService = createMirrorPublicationService({ repository,
    barrierTable: { schema: namespace, table: "publications" } });
  const authContext = Object.freeze({ sessionId: "isolated-qa-session" });
  let sessionActive = true, canFilter = true;
  const resolveShop = async auth => {
    assert.strictEqual(auth, authContext);
    if (!sessionActive) throw new FieldError(C.PERMISSION_DENIED,"Session revoked");
    return "shop.myshopify.com";
  };
  const fieldService = R.createFieldService({
    adapter: { resolveOne() { assert.fail("Unexpected dynamic field"); }, resolveBatch() { assert.fail("Unexpected dynamic field"); } },
    resolveShop,
    authorizeAccess: async () => canFilter, verifyCoverage: coverage.getVerifiedCoverage,
  });
  const schema = createMirrorSqlSchema({
    products: { schema: namespace, table: "products", id: "id", shop: "shop_id", generation: "generation_id" },
    variants: { schema: namespace, table: "variants", productId: "product_id", shop: "shop_id", generation: "generation_id" },
  });
  const verify = () => verifyMirrorSqlSchema({ database: pool, schema, fieldMappings,
    mirrorSchemaVersion: "sql_qa_v1", sourceContractVersion: "sql_qa_sources_v1" });
  const compiler = Q.createFilterCompiler({ fieldService, physicalSchema: await verify(),
    cursorService: createCursorService({ secret: randomBytes(32) }) });
  const node = (field, operator, value) => ({ kind: "condition", field, operator,
    ...(value === undefined ? {} : { value }) });
  const group = children => ({ kind: "group", operator: "AND", children });
  async function contract(root, generationId = "g1") {
    return compiler.validateFilter({ version: 1, root }, { authContext, operation: "filter",
      executionContext: { operationId: "sql_qa_operation", generationId } });
  }
  const query = (value, extra = {}) => compiler.compileFilter(value, { authContext, ...extra });
  const executor = E.createFilterExecutor({ database: pool, publicationService, compiler,
    resolveShop });
  const execute = compiled => executor.execute({ query: compiled, authContext });
  const ids = async root => {
    const compiled = await query(await contract(root));
    return (await execute(compiled)).productIds;
  };

  function observedDatabase() {
    const events = [], state = {};
    let notify;
    state.queryStarted = new Promise(resolve => { notify = resolve; });
    return { events, state, database: { async connect() {
      const client = await pool.connect(); state.pid = client.processID;
      return { release() { events.push("release"); client.release(); }, query(command, values) {
        events.push(command);
        const pending = client.query(command, values);
        if (typeof command === "object") notify();
        return pending;
      } };
    } } };
  }

  test("an issued query loses execution authority when field permission is revoked", async () => {
    const compiled = await query(await contract(node("product.vendor","eq","Nike")));
    canFilter = false;
    try { await assert.rejects(() => execute(compiled), {code:C.PERMISSION_DENIED}); }
    finally { canFilter = true; }
    assert.deepEqual((await execute(compiled)).productIds,["b"]);
  });

  test("session revocation during publication eligibility checking prevents SQL execution", async () => {
    const compiled = await query(await contract(node("product.vendor","eq","Nike")));
    const observed = observedDatabase();
    const guarded = E.createFilterExecutor({ database:observed.database,compiler,resolveShop,
      publicationService:{ async requirePublished(input) {
        await publicationService.requirePublished(input); sessionActive = false;
      } } });
    try {
      await assert.rejects(() => guarded.execute({query:compiled,authContext}), {code:C.PERMISSION_DENIED});
      assert.ok(!observed.events.some(event => typeof event === "object"));
      assert.deepEqual(observed.events.slice(-2),["ROLLBACK","release"]);
    } finally { sessionActive = true; }
  });

  test("executor enforces transaction settings and releases a clean connection after PostgreSQL cancellation", async () => {
    const compiled = await query(await contract(node("product.title", "eq", "All")));
    const observed = observedDatabase(), blocker = await pool.connect();
    const cancellable = E.createFilterExecutor({ database: observed.database, compiler,
      resolveShop: async () => "shop.myshopify.com", publicationService: { async requirePublished(input) {
        await publicationService.requirePublished(input);
        const settings = (await input.client.query(`SELECT current_setting('transaction_read_only') AS readonly,
          current_setting('transaction_isolation') AS isolation, current_setting('statement_timeout') AS statement,
          current_setting('lock_timeout') AS lock`)).rows[0];
        assert.deepEqual(settings, { readonly: "on", isolation: "read committed", statement: "5s", lock: "1s" });
      } } });
    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${ns}.products IN ACCESS EXCLUSIVE MODE`);
      const read = cancellable.execute({ query: compiled, authContext });
      const rejected = assert.rejects(read, error => error.name === "FilterInfrastructureError" && error.cause?.code === "57014");
      await observed.state.queryStarted;
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const activity = await pool.query("SELECT wait_event_type FROM pg_catalog.pg_stat_activity WHERE pid=$1", [observed.state.pid]);
        if (activity.rows[0]?.wait_event_type === "Lock") { waiting = true; break; }
        await delay(10);
      }
      assert.ok(waiting, "compiled product query must be blocked before cancellation");
      assert.equal((await pool.query("SELECT pg_catalog.pg_cancel_backend($1) AS cancelled", [observed.state.pid])).rows[0].cancelled, true);
      await rejected;
      assert.deepEqual(observed.events.slice(-2), ["ROLLBACK", "release"]);
      const reused = await pool.connect();
      try {
        assert.equal(reused.processID, observed.state.pid);
        assert.equal((await reused.query("SHOW transaction_read_only")).rows[0].transaction_read_only, "off");
        assert.equal((await reused.query("SHOW statement_timeout")).rows[0].statement_timeout, "0");
      } finally { reused.release(); }
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  });

  test("executor bounds actual PostgreSQL response bytes and rolls back before returning an oversized page", async () => {
    const writer = await pool.connect(), observed = observedDatabase();
    try {
      await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
      await writer.query(`INSERT INTO ${ns}.products (id,shop_id,generation_id,title)
        SELECT repeat('x',6000) || n::text,$1,$2,'Oversized' FROM generate_series(1,100) AS n`, ["shop.myshopify.com", "g1"]);
      await writer.query("COMMIT");
      const compiled = await query(await contract(node("product.title", "eq", "Oversized")), { pageSize: 100 });
      const bounded = E.createFilterExecutor({ database: observed.database, compiler, publicationService,
        resolveShop: async () => "shop.myshopify.com" });
      await assert.rejects(() => bounded.execute({ query: compiled, authContext }), { code: "FIELD_INVALID_VALUE" });
      assert.deepEqual(observed.events.slice(-2), ["ROLLBACK", "release"]);
    } finally {
      await writer.query("ROLLBACK");
      await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
      await writer.query(`DELETE FROM ${ns}.products WHERE shop_id=$1 AND generation_id=$2 AND title='Oversized'`, ["shop.myshopify.com", "g1"]);
      await writer.query("COMMIT"); writer.release();
    }
  });

  test("HTTP runtime uses the real compiler and executor for authenticated pages, invalid input and scoped cursor replay", async () => {
    const sessions = new Map([
      ["alpha", { id: "alpha", shop: "shop.myshopify.com", accessToken: "fixture-alpha", isOnline: false, scope: "read_products" }],
      ["beta", { id: "beta", shop: "other.myshopify.com", accessToken: "fixture-beta", isOnline: false, scope: "read_products" }],
    ]);
    const verifiedSessions = new Map(sessions);
    const writer = await pool.connect();
    let server;
    try {
      await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
      await writer.query(`INSERT INTO ${ns}.publications(shop_id,generation_id,status) VALUES ('other.myshopify.com','g1','PUBLISHED')`);
      await writer.query(`INSERT INTO ${ns}.coverage VALUES ('other.myshopify.com','g1','products'),('other.myshopify.com','g1','variants')`);
      await writer.query("COMMIT");
      const runtime = await HTTP.createFilterHttpRuntime({ database: pool, schema, fieldMappings,
        mirrorSchemaVersion: "sql_qa_v1", sourceContractVersion: "sql_qa_sources_v1", cursorSecret: randomBytes(32),
        sessionStorage: { async loadSession(id) { return sessions.get(id); } },
        fieldServiceFactory: ({ resolveShop, verifyCoverage }) => R.createFieldService({ resolveShop, verifyCoverage,
          adapter: { resolveOne() { assert.fail("Unexpected dynamic field"); }, resolveBatch() { assert.fail("Unexpected dynamic field"); } },
          authorizeAccess: async () => true }),
        coverageRepository: repository, barrierTable: { schema: namespace, table: "publications" },
        publishedContextRepository: { async getPublishedContext({ shopId }) {
          const result = await pool.query(`SELECT generation_id FROM ${ns}.publications WHERE shop_id=$1 AND generation_id='g1' AND status='PUBLISHED'`, [shopId]);
          return result.rows[0] ? { operationId: "http_qa_operation", generationId: result.rows[0].generation_id } : null;
        } }, logger: { error() {} },
      });
      const app = express();
      // Only identity verification is a test fixture. Field authorization,
      // coverage, catalog verification, compilation, HTTP handling and SQL use
      // their real implementations and isolated PostgreSQL state.
      app.use(createShopifyAuthMiddleware({ shopify: { validateAuthenticatedSession: () => (req, res, next) => {
        const session = verifiedSessions.get(req.headers.authorization);
        if (!session) return res.status(401).json({ error: "UNAUTHENTICATED" });
        res.locals.shopify = { session }; next();
      } } }));
      app.use("/api/filters", createFiltersRouter({ runtime }));
      server = app.listen(0, "127.0.0.1");
      await new Promise(resolve => server.once("listening", resolve));
      const endpoint = `http://127.0.0.1:${server.address().port}/api/filters/search`;
      const filter = { version: 1, root: node("product.title", "eq", "All") };
      const request = (body, session = "alpha") => fetch(endpoint, { method: "POST",
        headers: { "Content-Type": "application/json", ...(session ? { Authorization: session } : {}) },
        body: typeof body === "string" ? body : JSON.stringify(body) });
      const first = await request({ filter, pageSize: 2 });
      assert.equal(first.status, 200); assert.equal(first.headers.get("cache-control"), "private, no-store");
      const firstData = (await first.json()).data;
      assert.deepEqual(firstData.productIds, ["a", "b"]);
      const continuation = { filter, pageSize: 2, cursor: firstData.nextCursor };
      for (let replay = 0; replay < 2; replay++) {
        const next = await request(continuation); assert.equal(next.status, 200);
        assert.deepEqual((await next.json()).data.productIds, ["c", "d"]);
      }
      assert.equal((await request({ filter }, null)).status, 401);
      assert.equal((await request(continuation, "beta")).status, 400);
      assert.equal((await request({ ...continuation, filter: { version: 1, root: node("product.vendor", "eq", "Nike") } })).status, 400);
      assert.equal((await request({ ...continuation, cursor: `${firstData.nextCursor}x` })).status, 400);
      assert.equal((await request({ filter, shopId: "other.myshopify.com" })).status, 400);
      assert.equal((await request({ filter: { version: 1, root: {} } })).status, 400);
      assert.equal((await request("{")).status, 400);
      assert.equal((await request({ filter: "x".repeat(128 * 1024) })).status, 413);
      // The request fixture still recognizes the session, but production
      // authentication's independent storage lookup now sees it as revoked.
      const original = sessions.get("alpha");
      sessions.set("alpha", { ...original, expires: new Date(0) });
      assert.equal((await request(continuation)).status, 403);
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      await writer.query("ROLLBACK"); await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
      await writer.query(`DELETE FROM ${ns}.coverage WHERE shop_id='other.myshopify.com'`);
      await writer.query(`DELETE FROM ${ns}.publications WHERE shop_id='other.myshopify.com'`);
      await writer.query("COMMIT"); writer.release();
    }
  });

  test("real executor returns signed pages and rejects retirement, revision drift and missing coverage after compilation", async () => {
    const compiled = await query(await contract(node("product.title", "eq", "All")), { pageSize: 2 });
    const first = await execute(compiled);
    assert.deepEqual(first.productIds, ["a", "b"]);
    const next = await query(await contract(node("product.title", "eq", "All")), { pageSize: 2, cursor: first.nextCursor });
    assert.deepEqual((await execute(next)).productIds, ["c", "d"]);
    for (const mutation of [
      `UPDATE ${ns}.publications SET status='RETIRED' WHERE shop_id='shop.myshopify.com' AND generation_id='g1'`,
      `UPDATE ${ns}.publications SET coverage_revision='changed' WHERE shop_id='shop.myshopify.com' AND generation_id='g1'`,
      `DELETE FROM ${ns}.coverage WHERE shop_id='shop.myshopify.com' AND generation_id='g1' AND name='products'`,
    ]) {
      const writer = await pool.connect();
      try {
        await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
        await writer.query(mutation); await writer.query("COMMIT");
        await assert.rejects(() => execute(compiled), { code: "FIELD_MISSING_DEPENDENCY" });
      } finally {
        await writer.query("ROLLBACK");
        await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
        await writer.query(`UPDATE ${ns}.publications SET status='PUBLISHED',coverage_revision='qa_coverage_v1' WHERE shop_id='shop.myshopify.com' AND generation_id='g1'`);
        await writer.query(`INSERT INTO ${ns}.coverage VALUES ('shop.myshopify.com','g1','products') ON CONFLICT DO NOTHING`);
        await writer.query("COMMIT"); writer.release();
      }
    }
  });

  test("lookahead distinguishes exact final pages, preserves the sentinel for the next page and handles empty results", async () => {
    const value = await contract(node("product.title", "eq", "All"));
    const expected = ["a", "b", "c", "d", "e", "f", "g"];
    for (const pageSize of [1, 2, 7, 100]) {
      const seen = [];
      let cursor;
      for (let page = 0; ; page++) {
        assert.ok(page < 8, "pagination must terminate without an extra empty page");
        const compiled = await query(value, { pageSize, ...(cursor ? { cursor } : {}) });
        assert.equal(compiled.version, 4);
        assert.equal(compiled.values.at(-1), pageSize + 1);
        assert.strictEqual(compiled.requiredDatasets, compiler.getExecutionPlan(compiled).datasets);
        const result = await execute(compiled);
        assert.ok(result.productIds.length <= pageSize);
        seen.push(...result.productIds);
        if (!result.hasMore) {
          assert.equal(result.nextCursor, null);
          assert.equal(page + 1, Math.ceil(expected.length / pageSize));
          break;
        }
        assert.equal(result.productIds.length, pageSize);
        cursor = result.nextCursor;
      }
      assert.deepEqual(seen, expected);
    }
    const empty = await execute(await query(await contract(node("product.title", "eq", "No match")), { pageSize: 2 }));
    assert.deepEqual(empty.productIds, []);
    assert.equal(empty.hasMore, false);
    assert.equal(empty.nextCursor, null);
  });

  test("executor derives required variant coverage from the owned plan and checks its exact generation", async () => {
    const productQuery = await query(await contract(node("product.title", "eq", "All")));
    const variantQuery = await query(await contract(node("variant.price", "gt", "100")));
    const writer = await pool.connect();
    try {
      await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
      await writer.query(`DELETE FROM ${ns}.coverage WHERE shop_id=$1 AND generation_id=$2 AND name='variants'`, ["shop.myshopify.com", "g1"]);
      await writer.query("COMMIT");
      assert.ok((await execute(productQuery)).productIds.length > 0);
      // No request/preparation datasets are supplied. g2 still has complete
      // variant coverage, which cannot satisfy the g1 query's dependency plan.
      await assert.rejects(() => execute(variantQuery), { code: "FIELD_MISSING_DEPENDENCY" });
      await assert.rejects(() => executor.execute({ query: variantQuery, authContext, datasets: ["products"] }), { code: "FIELD_CONTRACT_MISMATCH" });
    } finally {
      await writer.query("ROLLBACK");
      await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
      await writer.query(`INSERT INTO ${ns}.coverage VALUES ('shop.myshopify.com','g1','variants') ON CONFLICT DO NOTHING`);
      await writer.query("COMMIT"); writer.release();
    }
  });

  test("publication writer cannot acquire its barrier while the executor holds a verified read", async () => {
    const compiled = await query(await contract(node("product.title", "eq", "All")));
    let notify, resume;
    const protectedRead = new Promise(resolve => { notify = resolve; });
    const continueRead = new Promise(resolve => { resume = resolve; });
    const gated = E.createFilterExecutor({ database: pool, compiler, resolveShop: async () => "shop.myshopify.com",
      publicationService: { async requirePublished(input) {
        await publicationService.requirePublished(input); notify(); await continueRead;
      } } });
    const read = gated.execute({ query: compiled, authContext });
    const writer = await pool.connect();
    try {
      await protectedRead;
      await writer.query("BEGIN");
      await assert.rejects(() => writer.query(`LOCK TABLE ${ns}.publications IN ACCESS EXCLUSIVE MODE NOWAIT`), { code: "55P03" });
    } finally {
      await writer.query("ROLLBACK"); writer.release(); resume();
      assert.deepEqual((await read).productIds, ["a", "b", "c", "d", "e", "f", "g"]);
    }
  });

  test("executor waiting behind a publisher sees its committed retirement rather than a stale snapshot", async () => {
    const compiled = await query(await contract(node("product.title", "eq", "All")));
    const writer = await pool.connect();
    const readerCommands = [];
    let readerReleased = false;
    let notify;
    const lockStarted = new Promise(resolve => { notify = resolve; });
    const observedPool = { async connect() {
      const client = await pool.connect();
      return { release: () => { readerReleased = true; client.release(); }, query(command, values) {
        readerCommands.push(command);
        const pending = client.query(command, values);
        if (typeof command === "string" && command.startsWith("LOCK TABLE")) notify();
        return pending;
      } };
    } };
    const waiting = E.createFilterExecutor({ database: observedPool, compiler, publicationService,
      resolveShop: async () => "shop.myshopify.com" });
    try {
      await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
      await writer.query(`UPDATE ${ns}.publications SET status='RETIRED' WHERE shop_id=$1 AND generation_id=$2`, ["shop.myshopify.com", "g1"]);
      const read = waiting.execute({ query: compiled, authContext });
      const rejected = assert.rejects(read, { code: "FIELD_MISSING_DEPENDENCY" });
      await lockStarted; await writer.query("COMMIT"); await rejected;
      assert.equal(readerCommands.some(command =>
        (typeof command === "string" ? command : command.text) === compiled.text), false,
      "retirement must deny execution before the compiled product query reaches PostgreSQL");
      assert.equal(readerCommands.at(-1), "ROLLBACK");
      assert.equal(readerReleased, true);
    } finally {
      await writer.query("ROLLBACK");
      await writer.query("BEGIN"); await publicationService.lockForWrite(writer,"shop.myshopify.com");
      await writer.query(`UPDATE ${ns}.publications SET status='PUBLISHED' WHERE shop_id=$1 AND generation_id=$2`, ["shop.myshopify.com", "g1"]);
      await writer.query("COMMIT"); writer.release();
    }
  });

  test("neq and not_in exclude actual SQL NULL values and isolate shop/generation", async () => {
    assert.deepEqual(await ids(node("product.vendor", "neq", "Nike")), ["c", "d", "e", "f", "g"]);
    assert.deepEqual(await ids(node("product.vendor", "not_in", ["Nike", "Puma"])), ["d", "e", "f", "g"]);
  });
  test("BETWEEN includes both PostgreSQL numeric endpoints", async () => {
    assert.deepEqual(await ids(node("variant.price", "between", ["100", "200"])), ["b", "c", "d", "e"]);
  });
  test("exact decimal strings compare numerically without JavaScript precision loss", async () => {
    assert.deepEqual(await ids(node("variant.price", "eq", "9007199254740993.0001")), ["f"]);
  });
  test("Boolean operators use actual Boolean storage and exclude NULL", async () => {
    assert.deepEqual(await ids(node("variant.taxable", "eq", true)), ["b", "d", "e"]);
    assert.deepEqual(await ids(node("variant.taxable", "eq", false)), ["c", "d"]);
    await pool.query(`ALTER TABLE ${ns}.variants ALTER COLUMN taxable TYPE text USING taxable::text`);
    try { await assert.rejects(verify, { code: "FIELD_CONTRACT_MISMATCH" }); }
    finally { await pool.query(`ALTER TABLE ${ns}.variants ALTER COLUMN taxable TYPE boolean USING taxable::boolean`); }
  });
  test("SKU and price must match the same physical variant row", async () => {
    assert.deepEqual(await ids(group([node("variant.sku", "eq", "ABC"), node("variant.price", "gt", "100")])), ["e"]);
  });
  test("nested conjunctions with product conditions preserve one-variant correlation", async () => {
    const sameVariant = group([node("product.title","eq","All"),group([
      node("variant.sku","eq","ABC"),group([node("variant.price","gt","100"),node("variant.taxable","eq",true)]),
    ])]);
    assert.deepEqual(await ids(sameVariant),["e"]);
    assert.deepEqual(await ids(group([node("product.vendor","eq","Other"),sameVariant])),["e"]);
    assert.deepEqual(await ids(group([node("product.title","eq","All"),group([
      node("variant.price","lt","100"),node("variant.inventoryQuantity","gt",10),
    ])])),[]);
  });
  test("nullable text, numeric and Boolean predicates preserve SQL UNKNOWN", async () => {
    assert.deepEqual(await ids(node("variant.price","neq","100")),["c","d","e","f"]);
    assert.deepEqual(await ids(node("variant.price","is_null")),["g"]);
    assert.deepEqual(await ids(node("variant.sku","not_contains","A")),["c","d","f"]);
    assert.deepEqual(await ids(node("variant.sku","is_null")),["g"]);
    assert.deepEqual(await ids(node("variant.taxable","neq",true)),["c","d"]);
    assert.deepEqual(await ids(node("variant.taxable","is_null")),["f","g"]);
    const not = child => ({kind:"group",operator:"NOT",children:[child]});
    assert.deepEqual(await ids(not(node("product.vendor","eq","Nike"))),["c","d","e","f","g"]);
    assert.deepEqual(await ids(group([node("product.title","eq","All"),
      not(not(node("product.vendor","eq","Nike")))])),["b"]);
  });
  test("bounded generated SQL can still scan tables; PostgreSQL enforces runtime cancellation separately", async () => {
    const compiled = await query(await contract(node("product.title", "eq", "All")));
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off");
      const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${compiled.text}`, compiled.values)).rows[0]["QUERY PLAN"];
      assert.match(JSON.stringify(plan), /Seq Scan/);
      await client.query("SET LOCAL statement_timeout='25ms'");
      await assert.rejects(() => client.query("SELECT pg_catalog.pg_sleep(0.2)"), { code: "57014" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  test("a held repeatable-read snapshot preserves pages across concurrent deletion", async () => {
    const value = await contract(node("product.title", "eq", "All"));
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const first = await query(value, { pageSize: 2 });
      const firstRows = (await client.query(first.text, first.values)).rows;
      assert.equal(firstRows.length, first.pageSize + 1);
      const page = firstRows.slice(0, first.pageSize).map(row => row.product_id);
      assert.deepEqual(page, ["a", "b"]);
      const cursor = compiler.createCursor(first, page.at(-1));
      await pool.query(`DELETE FROM ${ns}.products WHERE shop_id=$1 AND generation_id=$2 AND id=$3`, ["shop.myshopify.com", "g1", "c"]);
      const next = await query(value, { cursor, pageSize: 100 });
      const remainder = (await client.query(next.text, next.values)).rows.map(row => row.product_id);
      assert.deepEqual([...page, ...remainder], ["a", "b", "c", "d", "e", "f", "g"]);
    } finally {
      await client.query("ROLLBACK"); client.release();
      await pool.query(`INSERT INTO ${ns}.products VALUES ('c','shop.myshopify.com','g1','All','Puma') ON CONFLICT DO NOTHING`);
    }
  });
  test("retired generations and cross-generation cursors cannot produce a new page", async () => {
    const value = await contract(node("product.title", "eq", "All"));
    const first = await query(value, { pageSize: 2 });
    const cursor = compiler.createCursor(first, "b");
    await pool.query(`UPDATE ${ns}.publications SET status='RETIRED' WHERE shop_id=$1 AND generation_id=$2`, ["shop.myshopify.com", "g1"]);
    try { await assert.rejects(() => query(value, { cursor }), { code: "FIELD_MISSING_DEPENDENCY" }); }
    finally { await pool.query(`UPDATE ${ns}.publications SET status='PUBLISHED' WHERE shop_id=$1 AND generation_id=$2`, ["shop.myshopify.com", "g1"]); }
    const replacement = await contract(node("product.title", "eq", "All"), "g2");
    await assert.rejects(() => query(replacement, { cursor }));
  });
});
