import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_FIELDS } from "../../fields/canonical.js";
import { SOURCE_DATASETS } from "../../fields/sources.js";
import { deepFreeze, FIELD_ERROR_CODES as C } from "../../fields/types.js";
import { createMirrorCoverageService } from "../../mirror/coverage.js";
import { FILTER_NULL_SEMANTICS_VERSION } from "../semantics.js";
import { listOperatorsForType } from "../../fields/operators.js";
import { createMirrorSqlSchema } from "../mirror-schema.js";
import { verifyMirrorSqlSchema, invalidateVerifiedMirrorSqlSchema } from "../../services/mirror-schema.server.js";
import { catalogPool, physicalMapping, physicalColumn } from "./catalog-fixture.js";
import { createCursorService } from "../pagination.js";

describe("private parameterized PostgreSQL predicate compiler", {
  skip: typeof mock.module !== "function" && "Requires --experimental-test-module-mocks",
}, async () => {
  if (typeof mock.module !== "function") return;
  // Test-only mappings. No production table or source contract is fabricated.
  const sql = (alias, column, storageType = "text", extra = {}) => ({
    kind: "column", alias, column, storageType, shopColumn: "shop_id", generationColumn: "generation_id", ...extra,
  });
  const columns = {
    "product.title": sql("p", "title"), "product.vendor": sql("p", "vendor"),
    "product.tags": sql("p", "tags", "text[]"), "variant.price": sql("v", "price", "numeric"),
    "variant.taxable": sql("v", "taxable", "boolean"),
    "variant.sku": sql("v", "sku"),
    "product.createdAt": sql("p", "created_at", "timestamptz"),
    "product.handle": sql("p", 'handle"; DROP TABLE products; --'),
    "product.descriptionHtml": sql("p", "description", "numeric"),
    "product.productType": sql("p", "product_type", "text", { expression: "untrusted()" }),
    "product.templateSuffix": sql("p", "template_suffix", "text", { shopColumn: "other_shop" }),
    "product.seoTitle": sql("p; DELETE FROM products", "seo_title"),
    "product.seoDescription": sql("p", "seo_description"),
  };
  const FIELD_SOURCES = deepFreeze(Object.fromEntries(Object.values(CANONICAL_FIELDS).map(field => [field.id, {
    fieldId: field.id, entity: field.entity, canonicalType: field.type,
    canonicalDerived: field.derived, kind: "column", datasets: field.entity === "variant" ? ["products", "variants"] : ["products"],
    ...(columns[field.id] ? { sql: columns[field.id] } : {}),
  }])));
  const FILTER_SQL_SCHEMA = {
    mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
    product: { alias: "p", shopColumn: "shop_id", generationColumn: "generation_id", idColumn: "id" },
    variant: { schema: "mirror", table: "variants", alias: "v", shopColumn: "shop_id", generationColumn: "generation_id", productIdColumn: "product_id" },
  };
  const FILTER_BINDING_DEFINITIONS = Object.keys(columns).map(fieldId => {
    const field = CANONICAL_FIELDS[fieldId], source = FIELD_SOURCES[fieldId];
    return { fieldId, entity: field.entity, sourceKind: source.kind, datasets: [...source.datasets],
      correlation: field.entity === "variant" ? "variant_exists" : "product",
      handlerId: field.entity === "variant" ? "variant_exists_v1" : "product_column_v1",
      operators: fieldId === "product.seoDescription" ? ["eq", "contains"] : listOperatorsForType(field.type).map(op => typeof op === "string" ? op : op.id),
      cost: field.entity === "variant" ? 2 : 1, mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1" };
  });
  const dependency = mock.module("../../fields/sources.js", { namedExports: { FIELD_SOURCES, SOURCE_DATASETS, FILTER_SQL_SCHEMA, FILTER_BINDING_DEFINITIONS } });
  let R, V, Q, Resolver;
  try {
    R = await import("../../fields/resolve.js");
    V = await import("../validate.js");
    Q = await import("../compile.js");
    Resolver = await import("../resolver.js");
  } finally { dependency.restore(); }
  const SHOP = "alpha.myshopify.com", GENERATION = "generation123";
  function fixture() {
    let published = true;
    const authorizationState = { granted: true, reads: 0 };
    let mirrorSchemaVersion = "mirror_v1", sourceContractVersion = "sources_v1";
    const coverage = createMirrorCoverageService({ repository: { getPublishedSnapshot: async input => ({
      shopId: SHOP, generationId: GENERATION, coverageRevision: "revision123", status: published ? "PUBLISHED" : "RETIRED",
      mirrorSchemaVersion, sourceContractVersion,
      datasets: input.datasets.map(name => ({ name, generationId: GENERATION, status: "COMPLETE", published: true })),
    }) } });
    const fieldService = R.createFieldService({
      adapter: { resolveOne() { assert.fail("Unexpected dynamic lookup"); }, resolveBatch() { assert.fail("Unexpected dynamic lookup"); } },
      resolveShop: async () => SHOP, authorizeAccess: async () => {
        authorizationState.reads++;
        return authorizationState.granted;
      }, verifyCoverage: coverage.getVerifiedCoverage,
    });
    const service = V.createFilterService({ fieldService });
    const context = { authContext: { sessionId: "verified-session" }, operation: "filter",
      executionContext: { operationId: "operation123", generationId: GENERATION } };
    return {
      service, fieldService, context, authorizationState, retire() { published = false; },
      compatibility(mirror, source) { mirrorSchemaVersion = mirror; sourceContractVersion = source; },
      async compile(root) {
        const validated = await service.validateFilter({ version: 1, root }, context);
        return service.compileFilter(validated, { authContext: context.authContext });
      },
    };
  }
  const node = (field = "product.title", operator = "eq", value = "Summer") => ({ kind: "condition", field, operator, value });
  const presence = (field, operator) => ({ kind: "condition", field, operator });

  async function queryFixture(productColumns = { title: physicalColumn("text") }, variantColumns = { price: physicalColumn("numeric") }, cursorService, configureCatalog) {
    const f = fixture(), catalog = catalogPool(productColumns, variantColumns);
    configureCatalog?.(catalog);
    const physicalSchema = await verifyMirrorSqlSchema({ database: catalog.pool, schema: createMirrorSqlSchema(physicalMapping()),
      mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1", fieldMappings: [
        { fieldId: "product.title", entity: "product", column: "title", type: "text" },
        { fieldId: "variant.price", entity: "variant", column: "price", type: "numeric" },
        ...(variantColumns.sku ? [{ fieldId: "variant.sku", entity: "variant", column: "sku", type: "text" }] : []),
      ] });
    return { ...f, catalog, physicalSchema, compiler: Q.createFilterCompiler({ fieldService: f.fieldService, physicalSchema, cursorService }) };
  }

  async function executionFixture() {
    const { createFilterExecutor } = await import("../execute.js");
    const f = await queryFixture(undefined, undefined, createCursorService({ secret: Buffer.alloc(32, 7) }));
    const contract = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    const query = await f.compiler.compileFilter(contract, { authContext: f.context.authContext, pageSize: 2 });
    const events = [];
    const state = { shop: SHOP, rows: [["123"], ["456"], ["789"]], fields: [{ name: "product_id" }] };
    const client = {
      async query(command, values) {
        events.push({ command, values });
        if (typeof command === "object") {
          if (state.queryError) throw state.queryError;
          return { fields: state.fields, rows: state.rows };
        }
        if (command === "ROLLBACK" && state.rollbackError) throw state.rollbackError;
        return {};
      },
      release() { events.push("release"); },
    };
    const executor = createFilterExecutor({
      database: { async connect() { events.push("connect"); return client; } },
      resolveShop: async auth => { assert.strictEqual(auth, f.context.authContext); return state.shop; },
      publicationService: { async requirePublished(input) {
        events.push("publication");
        assert.deepEqual(input, { client, shopId: SHOP, generationId: GENERATION,
          coverageRevision: query.binding.coverageRevision, datasets: ["products"] });
        if (state.publicationError) throw state.publicationError;
      } },
      compiler: f.compiler,
    });
    return { ...f, query, events, state,
      execute: overrides => executor.execute({ query, authContext: f.context.authContext, ...overrides }) };
  }

  test("executor holds a read-only repeatable-read transaction through publication verification and returns a signed cursor", async () => {
    const f = await executionFixture();
    const result = await f.execute();
    assert.deepEqual(f.events, ["connect",
      { command: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", values: undefined },
      { command: "SET LOCAL statement_timeout = '5000ms'", values: undefined },
      { command: "SET LOCAL lock_timeout = '1000ms'", values: undefined },
      "publication", { command: { text: f.query.text, values: f.query.values, rowMode: "array" }, values: undefined },
      { command: "COMMIT", values: undefined }, "release"]);
    assert.deepEqual(result.productIds, ["123", "456"]);
    assert.equal(result.hasMore, true);
    assert.equal(result.generationId, GENERATION);
    assert.equal(result.coverageRevision, f.query.binding.coverageRevision);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.productIds));
    const contract = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    const next = await f.compiler.compileFilter(contract, { authContext: f.context.authContext, cursor: result.nextCursor });
    assert.equal(next.values.at(-2), "456");
    f.state.rows = [["789"]];
    const last = await f.execute();
    assert.equal(last.hasMore, false);
    assert.equal(last.nextCursor, null);
  });

  test("executor rejects forged queries, cross-shop access, revoked schemas and invalid coverage before connecting", async () => {
    const f = await executionFixture();
    await assert.rejects(() => f.execute({ query: { ...f.query } }), { code: C.PERMISSION_DENIED });
    f.state.shop = "other.myshopify.com";
    await assert.rejects(() => f.execute(), { code: C.PERMISSION_DENIED });
    f.state.shop = SHOP;
    for (const datasets of [[], ["variants"], ["products", "variants"], ["products", "products"], ["products;DROP TABLE"]]) {
      await assert.rejects(() => f.execute({ datasets }), { code: C.CONTRACT_MISMATCH });
    }
    invalidateVerifiedMirrorSqlSchema(f.physicalSchema);
    await assert.rejects(() => f.execute(), { code: C.CONTRACT_MISMATCH });
    assert.deepEqual(f.events, []);
  });

  test("genuine compiler issuance does not retain revoked field permissions at execution", async () => {
    const f = await executionFixture();
    assert.strictEqual(Q.assertCompiledFilter(f.query), f.query);
    f.authorizationState.granted = false;
    await assert.rejects(() => f.execute(), {code:C.PERMISSION_DENIED});
    assert.ok(!f.events.some(event => typeof event?.command === "object"));
    assert.deepEqual(f.events.slice(-2),[{command:"ROLLBACK",values:undefined},"release"]);
    f.authorizationState.granted = true;
    assert.deepEqual((await f.execute()).productIds,["123","456"]);
  });

  test("execution requires the configured compiler owner even for genuine same-shop queries and short pages", async () => {
    const { createFilterExecutor } = await import("../execute.js");
    const f = await executionFixture();
    const other = Q.createFilterCompiler({ fieldService: f.fieldService, physicalSchema: f.physicalSchema });
    assert.strictEqual(Q.assertCompiledFilter(f.query), f.query);
    assert.throws(() => other.getExecutionPlan(f.query), { code: C.PERMISSION_DENIED });
    for (const compiler of [other, { createCursor() {}, authorizeExecution() {}, getExecutionPlan: () => f.compiler.getExecutionPlan(f.query) }]) {
      const executor = createFilterExecutor({ compiler, resolveShop: async () => SHOP,
        publicationService: { requirePublished() { assert.fail("Foreign query reached publication"); } },
        database: { connect() { assert.fail("Foreign query reached the database"); } } });
      await assert.rejects(() => executor.execute({ query: f.query }), { code: C.PERMISSION_DENIED });
    }
  });

  test("compiler dependency plans are immutable and execution derives coverage without preparation metadata", async () => {
    const f = await executionFixture();
    const plan = f.compiler.getExecutionPlan(f.query);
    assert.deepEqual(plan.datasets, ["products"]);
    assert.strictEqual(plan.binding, f.query.binding);
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.datasets));
    await f.execute();
    const contract = await f.compiler.validateFilter({ version: 1, root: node("variant.price", "gt", "100") }, f.context);
    const query = await f.compiler.compileFilter(contract, { authContext: f.context.authContext });
    assert.deepEqual(f.compiler.getExecutionPlan(query).datasets, ["products", "variants"]);
    const { createFilterExecutor } = await import("../execute.js");
    const executor = createFilterExecutor({ compiler: f.compiler, resolveShop: async () => SHOP,
      publicationService: { requirePublished() { assert.fail("Incomplete coverage reached publication"); } },
      database: { connect() { assert.fail("Incomplete coverage reached SQL"); } } });
    await assert.rejects(() => executor.execute({ query, datasets: ["products"] }), { code: C.CONTRACT_MISMATCH });
  });

  test("compiler retains the exact immutable resolver plan and attaches it to every issued query", async () => {
    const f = await queryFixture();
    const contract = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    const plan = f.compiler.getResolutionPlan(contract);
    assert.strictEqual(plan.ast, contract.ast);
    assert.strictEqual(plan.versions, contract.versions);
    assert.deepEqual(plan.fieldIds, ["product.title"]);
    assert.deepEqual(plan.datasets, ["products"]);
    assert.deepEqual(plan.physicalColumns, [{ fieldId: "product.title", entity: "product", column: "title", type: "text" }]);
    assert.strictEqual(plan.fields[0].field, CANONICAL_FIELDS["product.title"]);
    assert.equal(plan.binding.shopId, SHOP);
    assert.equal(plan.binding.operationId, f.context.executionContext.operationId);
    assert.equal(plan.binding.generationId, GENERATION);
    assert.equal(plan.binding.coverageRevision, contract.coverageRevision);
    assert.equal(plan.binding.registryVersion, contract.registryVersion);
    assert.equal(plan.binding.filterFingerprint, contract.fingerprint);
    assert.equal(plan.schemaFingerprint, f.physicalSchema.fingerprint);
    assert.equal(plan.bindingRegistryVersion, plan.binding.bindingRegistryVersion);
    for (const value of [plan, plan.ast, plan.versions, plan.binding, plan.fields, plan.fields[0], plan.fields[0].source,
      plan.fieldIds, plan.datasets, plan.physicalColumns, plan.physicalColumns[0], plan.definitionRevisions]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.equal(Reflect.set(plan.physicalColumns[0], "column", "other"), false);
    assert.equal(Reflect.set(plan.binding, "shopId", "other.myshopify.com"), false);
    assert.throws(() => plan.datasets.push("variants"), TypeError);
    for (const pageSize of [1, 25]) {
      const query = await f.compiler.compileFilter(contract, { authContext: f.context.authContext, pageSize });
      assert.equal(query.version, 4);
      assert.equal(query.values.at(-1), pageSize + 1);
      assert.strictEqual(query.requiredDatasets, plan.datasets);
      assert.equal(query.resolverVersion, plan.physicalPlan.version);
      const execution = f.compiler.getExecutionPlan(query);
      assert.strictEqual(execution.resolutionPlan, plan);
      assert.strictEqual(execution.datasets, plan.datasets);
      assert.deepEqual(execution.binding, plan.binding);
    }
  });

  test("compiler resolution ownership rejects copies, injected plans and other validation services", async () => {
    const f = await queryFixture();
    const input = { version: 1, root: node() };
    const contract = await f.compiler.validateFilter(input, f.context);
    const plan = f.compiler.getResolutionPlan(contract);
    const other = Q.createFilterCompiler({ fieldService: f.fieldService, physicalSchema: f.physicalSchema });
    assert.throws(() => other.getResolutionPlan(contract), { code: C.PERMISSION_DENIED });
    const independent = await f.service.validateFilter(input, f.context);
    for (const unowned of [input, independent, { ...contract }, structuredClone(contract),
      Object.freeze({ ...contract, resolutionPlan: plan }), plan]) {
      assert.throws(() => f.compiler.getResolutionPlan(unowned), { code: C.PERMISSION_DENIED });
      await assert.rejects(() => f.compiler.compileFilter(unowned, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
    }
    await assert.rejects(() => f.compiler.compileFilter(contract, { authContext: f.context.authContext, resolutionPlan: plan }), { code: C.PERMISSION_DENIED });
  });

  test("retained plans do not cache authorization and identical filters get independent plans", async () => {
    const f = await queryFixture();
    const input = { version: 1, root: node() };
    const contract = await f.compiler.validateFilter(input, f.context);
    const plan = f.compiler.getResolutionPlan(contract);
    const same = await f.compiler.validateFilter(input, f.context);
    assert.notStrictEqual(f.compiler.getResolutionPlan(same), plan);
    const before = f.authorizationState.reads;
    await f.compiler.compileFilter(contract, { authContext: f.context.authContext });
    await f.compiler.compileFilter(contract, { authContext: f.context.authContext });
    assert.ok(f.authorizationState.reads >= before + 2);
    f.authorizationState.granted = false;
    assert.strictEqual(f.compiler.getResolutionPlan(contract), plan);
    await assert.rejects(() => f.compiler.compileFilter(contract, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
    f.authorizationState.granted = true;
    f.retire();
    await assert.rejects(() => f.compiler.compileFilter(contract, { authContext: f.context.authContext }), { code: C.MISSING_DEPENDENCY });
  });

  test("executor rolls back publication and query failures, preserves causes and releases the client", async () => {
    const { FieldError } = await import("../../fields/types.js");
    for (const stage of ["publicationError", "queryError"]) {
      const f = await executionFixture();
      const error = stage === "publicationError" ? new FieldError(C.MISSING_DEPENDENCY, "Retired generation") : new Error("statement timeout");
      f.state[stage] = error;
      f.state.rollbackError = new Error("connection lost");
      await assert.rejects(() => f.execute(), actual => stage === "publicationError" ? actual === error :
        actual.name === "FilterInfrastructureError" && actual.cause === error);
      assert.deepEqual(f.events.slice(-2), [{ command: "ROLLBACK", values: undefined }, "release"]);
      assert.ok(!f.events.some(event => event.command === "COMMIT"));
      if (stage === "publicationError") assert.ok(!f.events.some(event => typeof event.command === "object"));
    }
  });

  test("executor rejects unexpected projections, excessive results, invalid IDs and oversized responses", async () => {
    for (const override of [
      { fields: [{ name: "title" }] }, { rows: [["1"], ["2"], ["3"], ["4"]] },
      { rows: [[null]] }, { rows: [["bad\0id"]] }, { rows: [["x".repeat(512 * 1024 + 1)]] },
    ]) {
      const f = await executionFixture();
      Object.assign(f.state, override);
      await assert.rejects(() => f.execute(), { code: override.rows?.[0]?.[0]?.length > 512 * 1024 ? C.INVALID_VALUE : C.CONTRACT_MISMATCH });
      assert.deepEqual(f.events.slice(-2), [{ command: "ROLLBACK", values: undefined }, "release"]);
    }
  });

  test("complete query compilation requires a physical capability and derives execution identity server-side", async () => {
    const f = await queryFixture();
    assert.throws(() => Q.createFilterCompiler({ fieldService: f.fieldService, physicalSchema: createMirrorSqlSchema(physicalMapping()) }));
    const validated = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext, pageSize: 25 });
    assert.strictEqual(Q.assertCompiledFilter(query), query);
    assert.throws(() => Q.assertCompiledFilter({ ...query }));
    assert.match(query.text, /FROM "mirror"\."products" AS "p"/);
    assert.match(query.text, /ORDER BY "p"\."id" COLLATE "pg_catalog"\."C" ASC LIMIT \$4::integer$/);
    assert.deepEqual(query.values, [SHOP, GENERATION, "Summer", 26]);
    for (const extra of [{ cursorProductId: "merchant-forged" }, { expectedShopId: SHOP }, { expectedGenerationId: GENERATION }]) {
      await assert.rejects(() => f.compiler.compileFilter(validated, { authContext: f.context.authContext, ...extra }), { code: C.PERMISSION_DENIED });
    }
    await assert.rejects(() => f.compiler.compileFilter({ version: 1, root: node() }, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
  });

  test("copied and deserialized queries cannot acquire compiler provenance or dependency plans", async () => {
    const f = await executionFixture();
    for (const copy of [{ ...f.query }, structuredClone(f.query), JSON.parse(JSON.stringify(f.query)),
      Object.assign(Object.create(null), f.query)]) {
      assert.throws(() => Q.assertCompiledFilter(copy, f.compiler), { code: C.PERMISSION_DENIED });
      assert.throws(() => f.compiler.getExecutionPlan(copy), { code: C.PERMISSION_DENIED });
      assert.throws(() => f.compiler.createCursor(copy, "123"), { code: C.PERMISSION_DENIED });
      await assert.rejects(() => f.execute({ query: copy }), { code: C.PERMISSION_DENIED });
    }
    assert.deepEqual(f.events, []);
    assert.strictEqual(Q.assertCompiledFilter(f.query, f.compiler), f.query);
  });

  test("compiler context rejects symbols, hidden overrides and accessors without invoking getters", async () => {
    const f = await queryFixture();
    const contract = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    const context = () => ({ authContext: f.context.authContext });
    const symbol = Object.assign(context(), { [Symbol("sql")]: "SELECT 1" });
    const hidden = Object.defineProperty(context(), "sql", { value: "SELECT 1" });
    let getterCalls = 0;
    const accessors = ["authContext", "pageSize", "cursor", "sql"].map(key =>
      Object.defineProperty(context(), key, { get() { getterCalls++; throw new Error("Getter invoked"); } }));
    for (const raw of [undefined, null, [], new Date(), symbol, hidden, ...accessors]) {
      await assert.rejects(() => f.compiler.compileFilter(contract, raw), { code: C.PERMISSION_DENIED });
    }
    assert.equal(getterCalls, 0);
    const query = await f.compiler.compileFilter(contract, Object.assign(Object.create(null), context()));
    assert.strictEqual(Q.assertCompiledFilter(query, f.compiler), query);
  });

  test("HTTP runtime bootstraps verified compilation and derives variant coverage from semantic validation", async () => {
    const { createFilterHttpRuntime } = await import("../../services/filter-engine.server.js");
    const catalog = catalogPool({ title: physicalColumn("text") }, { price: physicalColumn("numeric") });
    const commands = [], coverageReads = [];
    const database = { async connect() {
      const client = await catalog.pool.connect();
      return { release: () => client.release(), async query(command, values) {
        commands.push(command);
        if (typeof command === "object") return { fields: [{ name: "product_id" }], rows: [["123"]] };
        return client.query(command, values);
      } };
    } };
    const session = { id: "runtime-session", shop: SHOP, accessToken: "server-token" };
    const runtime = await createFilterHttpRuntime({ database,
      sessionStorage: { async loadSession(id) { assert.equal(id, session.id); return session; } },
      fieldServiceFactory: ({ resolveShop, verifyCoverage }) => R.createFieldService({ resolveShop, verifyCoverage,
        authorizeAccess: async () => true,
        adapter: { resolveOne() { assert.fail("Unexpected dynamic lookup"); }, resolveBatch() { assert.fail("Unexpected dynamic lookup"); } } }),
      coverageRepository: { async getPublishedSnapshot(input) {
        coverageReads.push(input);
        return { shopId: SHOP, generationId: GENERATION, coverageRevision: "revision123", status: "PUBLISHED",
          mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
          datasets: input.datasets.map(name => ({ name, generationId: GENERATION, status: "COMPLETE", published: true })) };
      } },
      publishedContextRepository: { async getPublishedContext(input) {
        assert.deepEqual(input, { shopId: SHOP });
        return { operationId: "operation123", generationId: GENERATION };
      } },
      barrierTable: { schema: "mirror", table: "publications" },
      schema: createMirrorSqlSchema(physicalMapping()),
      fieldMappings: [
        { fieldId: "product.title", entity: "product", column: "title", type: "text" },
        { fieldId: "variant.price", entity: "variant", column: "price", type: "numeric" },
      ],
      mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1", cursorSecret: Buffer.alloc(32, 7),
      logger: { error() { assert.fail("Valid runtime request failed"); } },
    });
    const req = { body: { filter: { version: 1, root: node("variant.price", "gt", "100") } } };
    const res = { locals: { shopify: { session } }, setHeader() {}, status(value) { this.code = value; return this; }, json(value) { this.body = value; } };
    runtime.capture(req, res, () => {});
    await runtime.search(req, res, error => { throw error; });
    assert.equal(res.code, 200);
    assert.deepEqual(res.body.data.productIds, ["123"]);
    const executionCoverage = coverageReads.filter(input => input.client);
    assert.equal(executionCoverage.length, 2);
    assert.strictEqual(executionCoverage[0].client,executionCoverage[1].client);
    assert.deepEqual(executionCoverage[0].datasets, ["products", "variants"]);
    assert.deepEqual(executionCoverage[1].datasets, ["products", "variants"]);
    const barrierIndex = commands.indexOf('LOCK TABLE "mirror"."publications" IN ACCESS SHARE MODE');
    assert.ok(barrierIndex >= 0);
    assert.equal(typeof commands[barrierIndex + 1], "object");
  });

  test("physical column existence, type and table ownership gate complete query compilation", async () => {
    for (const [products, variants] of [[{}, { title: physicalColumn("text") }], [{ title: physicalColumn("bool") }, {}]]) {
      await assert.rejects(() => queryFixture(products, variants), { code: C.CONTRACT_MISMATCH });
    }
    const f = await queryFixture();
    const validated = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    invalidateVerifiedMirrorSqlSchema(f.physicalSchema);
    delete f.catalog.state.tables.products.columns.title;
    await assert.rejects(() => f.compiler.compileFilter(validated, { authContext: f.context.authContext }), { code: C.CONTRACT_MISMATCH });
  });

  test("compilation rechecks the real catalog while migration revocation fences issued contracts and queries", async () => {
    const f = await queryFixture();
    const catalogReads = f.catalog.state.commands.length;
    const contract = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    const query = await f.compiler.compileFilter(contract, { authContext: f.context.authContext });
    const afterFirst = f.catalog.state.commands.length;
    assert.ok(afterFirst > catalogReads);
    await f.compiler.compileFilter(contract, { authContext: f.context.authContext });
    assert.ok(f.catalog.state.commands.length > afterFirst);
    invalidateVerifiedMirrorSqlSchema(f.physicalSchema);
    assert.throws(() => Q.assertCompiledFilter(query), { code: C.CONTRACT_MISMATCH });
    await assert.rejects(() => f.compiler.validateFilter({ version: 1, root: node() }, f.context), { code: C.CONTRACT_MISMATCH });
    await assert.rejects(() => f.compiler.compileFilter(contract, { authContext: f.context.authContext }), { code: C.CONTRACT_MISMATCH });
  });

  test("catalog drift between validation and compilation revokes the schema before a query can be issued", async () => {
    const f = await queryFixture();
    const contract = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    const reads = f.authorizationState.reads;
    f.catalog.state.tables.products.columns.title.type = "bool";
    await assert.rejects(() => f.compiler.compileFilter(contract, { authContext: f.context.authContext }), { code: C.CONTRACT_MISMATCH });
    assert.equal(f.authorizationState.reads, reads);
    assert.throws(() => f.compiler.getResolutionPlan(contract), { code: C.CONTRACT_MISMATCH });
  });

  test("physical planner uses installed bindings, verified scopes and immutable provenance without issuing authorization", async () => {
    const f = await queryFixture(undefined, { price: physicalColumn("numeric"), sku: physicalColumn("text") });
    const resolver = Resolver.createFilterResolver({ physicalSchema: f.physicalSchema });
    const plan = resolver.resolve({ version: 1, root: { kind: "group", operator: "AND", children: [
      node("product.title"), node("variant.sku"), node("variant.price", "gt", "100"), node("variant.price", "lt", "200"),
    ] } });
    assert.strictEqual(Resolver.assertResolvedFilterPlan(plan), plan);
    assert.deepEqual(plan.datasets, ["products", "variants"]);
    assert.deepEqual(plan.correlations, ["product", "variant_exists"]);
    assert.equal(plan.estimatedCost, 5);
    assert.equal(plan.fields.length, 3);
    assert.equal(f.authorizationState.reads, 0);
    for (const value of [plan, plan.fields, ...plan.fields, ...plan.fields.map(field => field.physicalColumn), plan.datasets]) assert.ok(Object.isFrozen(value));
    assert.throws(() => Resolver.assertResolvedFilterPlan({ ...plan }), { code: C.PERMISSION_DENIED });
    assert.throws(() => resolver.resolve({ version: 1, root: node("product.vendor") }), { code: C.UNSUPPORTED_OPERATION });
    assert.throws(() => Resolver.createFilterResolver({ physicalSchema: f.physicalSchema, bindingRegistry: {} }));
    await assert.rejects(() => f.compiler.compileFilter(plan, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
    invalidateVerifiedMirrorSqlSchema(f.physicalSchema);
    assert.throws(() => Resolver.assertResolvedFilterPlan(plan), { code: C.CONTRACT_MISMATCH });
    assert.throws(() => resolver.resolve({ version: 1, root: node() }), { code: C.CONTRACT_MISMATCH });
  });

  test("physical planner rejects forged schemas, dynamic IDs, conflicting scopes and malformed sources", async () => {
    const f = await queryFixture();
    assert.throws(() => Resolver.createFilterResolver({ physicalSchema: { ...f.physicalSchema } }), { code: C.CONTRACT_MISMATCH });
    assert.throws(() => Resolver.createFilterResolver({ physicalSchema: f.physicalSchema, fieldService: f.fieldService }), TypeError);
    const resolver = Resolver.createFilterResolver({ physicalSchema: f.physicalSchema });
    for (const field of ["product.metafield.m01234567", "collection.title", "inventoryItem.unitCost"]) {
      assert.throws(() => resolver.resolve({ version: 1, root: node(field) }), { code: C.UNSUPPORTED_OPERATION });
    }
    // Approval alone cannot make a malformed source safe for physical planning.
    const bad = await verifyMirrorSqlSchema({ database: f.catalog.pool,
      schema: createMirrorSqlSchema(physicalMapping()), mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
      fieldMappings: [{ fieldId: "product.templateSuffix", entity: "product", column: "title", type: "text" }],
    });
    const mismatch = Resolver.createFilterResolver({ physicalSchema: bad });
    assert.throws(() => mismatch.resolve({ version: 1, root: node("product.templateSuffix") }), { code: C.INVALID_SOURCE });
  });

  test("unsupported SQL fields fail before authorization and coverage adapters are invoked", async () => {
    const f = await queryFixture();
    for (const field of ["inventoryItem.unitCost", "collection.title", "variant.productId", "product.metafield.m01234567"]) {
      await assert.rejects(() => f.compiler.validateFilter({ version: 1, root: node(field) }, f.context), { code: C.UNSUPPORTED_OPERATION });
    }
    assert.equal(f.authorizationState.reads, 0);
  });

  test("a canonical field cannot target a different valid physical column", async () => {
    const f = fixture(), catalog = catalogPool({ title: physicalColumn("text"), vendor: physicalColumn("text") });
    const physicalSchema = await verifyMirrorSqlSchema({ database: catalog.pool, schema: createMirrorSqlSchema(physicalMapping()),
      mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1", fieldMappings: [
        { fieldId: "product.title", entity: "product", column: "vendor", type: "text" },
      ] });
    assert.throws(() => Q.createFilterCompiler({ fieldService: f.fieldService, physicalSchema }), { code: C.CONTRACT_MISMATCH });
  });

  test("signed keyset cursors bind position to shop, generation, filter and physical ordering", async () => {
    let time = 1000;
    const cursorService = createCursorService({ secret: Buffer.alloc(32, 7), clock: () => time, maxAgeMs: 1000 });
    const f = await queryFixture(undefined, undefined, cursorService);
    const contract = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
    const first = await f.compiler.compileFilter(contract, { authContext: f.context.authContext });
    const cursor = f.compiler.createCursor(first, "gid://shopify/Product/123");
    const next = await f.compiler.compileFilter(contract, { authContext: f.context.authContext, cursor });
    assert.match(next.text, /"p"\."id" COLLATE "pg_catalog"\."C" > \$4::text COLLATE "pg_catalog"\."C"/);
    assert.equal(next.values.at(-2), "gid://shopify/Product/123");
    for (const forged of ["raw-id", `${cursor.slice(0, 10)}x${cursor.slice(11)}`]) {
      await assert.rejects(() => f.compiler.compileFilter(contract, { authContext: f.context.authContext, cursor: forged }));
    }
    const changed = await f.compiler.validateFilter({ version: 1, root: node("product.title", "eq", "Other") }, f.context);
    await assert.rejects(() => f.compiler.compileFilter(changed, { authContext: f.context.authContext, cursor }));
    time = 2000;
    await assert.rejects(() => f.compiler.compileFilter(contract, { authContext: f.context.authContext, cursor }));
    assert.throws(() => f.compiler.createCursor({ ...first }, "123"), { code: C.PERMISSION_DENIED });
  });

  test("complete query budget counts the LIMIT parameter after all predicate parameters", async () => {
    const f = await queryFixture(undefined, undefined, createCursorService({ secret: Buffer.alloc(32, 4) }));
    const values = Array.from({ length: 100 }, (_, i) => String(i));
    const root = last => ({ kind: "group", operator: "AND", children: [
      ...Array.from({ length: 4 }, () => node("variant.price", "in", [...values])),
      node("variant.price", "in", values.slice(0, last)),
    ] });
    const compile = async last => {
      const validated = await f.compiler.validateFilter({ version: 1, root: root(last) }, f.context);
      return f.compiler.compileFilter(validated, { authContext: f.context.authContext });
    };
    assert.equal((await compile(97)).parameterCount, 500);
    await assert.rejects(() => compile(98), { code: C.INVALID_VALUE });
    const contract = await f.compiler.validateFilter({ version: 1, root: root(97) }, f.context);
    const first = await f.compiler.compileFilter(contract, { authContext: f.context.authContext });
    const cursor = f.compiler.createCursor(first, "123");
    await assert.rejects(() => f.compiler.compileFilter(contract, { authContext: f.context.authContext, cursor }), { code: C.INVALID_VALUE });
  });

  test("bigint and UUID cursor parameters preserve native physical ordering", async () => {
    for (const [type, value, cast] of [["int8", "9223372036854775807", "bigint"], ["uuid", "550e8400-e29b-41d4-a716-446655440000", "uuid"]]) {
      const service = createCursorService({ secret: Buffer.alloc(32, 6) });
      const f = await queryFixture(undefined, undefined, service, catalog => {
        catalog.state.tables.products.columns.id.type = type;
        catalog.state.tables.variants.columns.product_id.type = type;
      });
      const contract = await f.compiler.validateFilter({ version: 1, root: node() }, f.context);
      const first = await f.compiler.compileFilter(contract, { authContext: f.context.authContext });
      const cursor = f.compiler.createCursor(first, value);
      const next = await f.compiler.compileFilter(contract, { authContext: f.context.authContext, cursor });
      assert.ok(next.text.includes(`"p"."id" > $4::${cast}`));
      assert.equal(next.text.includes("COLLATE"), false);
      assert.equal(next.values.at(-2), value);
    }
  });

  test("compiler metadata and membership cannot change after validation", async () => {
    const f = fixture();
    const resolution = await f.fieldService.requireFields({ ...f.context, access: "read", fieldIds: ["product.title"] });
    const validated = await f.service.validateFilter({ version: 1, root: node() }, f.context);
    const before = await f.service.compileFilter(validated, { authContext: f.context.authContext });
    assert.throws(() => resolution.fields.push(resolution.fields[0]), TypeError);
    assert.throws(() => { resolution.fields[0].source.sql.column = "injected_column"; }, TypeError);
    assert.throws(() => { resolution.fields[0].policy.filter.allowEmpty = false; }, TypeError);
    assert.throws(() => { validated.ast.root.field = "variant.price"; }, TypeError);
    const after = await f.service.compileFilter(validated, { authContext: f.context.authContext });
    assert.deepEqual(after, before);
  });

  test("SQL and values remain separate, with registry identifiers quoted", async () => {
    const payload = "x' OR 1=1; DROP TABLE products; --";
    const result = await fixture().compile(node("product.title", "eq", payload));
    assert.equal(result.kind, "where");
    assert.equal(result.text, '(("p"."shop_id" = $1::text AND "p"."generation_id" = $2::text) AND ("p"."title" = $3::text))');
    assert.deepEqual(result.values, [SHOP, GENERATION, payload]);
    assert.equal(result.text.includes(payload), false);
    assert.equal(result.binding.shopId, SHOP);
    assert.equal(result.binding.generationId, GENERATION);
    assert.match(result.binding.registryVersion, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(result.values));
  });

  test("validation rejects a type-compatible operator absent from the installed handler", async () => {
    const f = fixture();
    await f.service.validateFilter({ version: 1, root: node("product.seoDescription", "contains", "summer") }, f.context);
    await assert.rejects(() => f.service.validateFilter({ version: 1,
      root: node("product.seoDescription", "not_contains", "summer") }, f.context), { code: C.UNSUPPORTED_OPERATION });
  });

  test("correlation restrictions apply before provenance using resolved binding scopes", async () => {
    const f = fixture();
    const group = (operator, children) => ({ version: 1, root: { kind: "group", operator, children } });
    await f.service.validateFilter(group("AND", [node("variant.sku"), node("variant.price", "gt", "100")]), f.context);
    for (const input of [group("OR", [node("product.title"), node("variant.price", "gt", "100")]),
      group("NOT", [node("variant.sku")])]) {
      await assert.rejects(() => f.service.validateFilter(input, f.context), { code: C.UNSUPPORTED_OPERATION });
    }
  });

  test("shop and generation guards constrain the parent and correlated variant", async () => {
    const result = await fixture().compile({ kind: "group", operator: "AND", children: [
      node("product.title", "eq", "x"),
      node("variant.price", "gt", "10.00"),
    ] });
    assert.match(result.text, /^\(\("p"\."shop_id" = \$1::text/);
    assert.match(result.text, /"v"\."shop_id" = \$1::text AND "v"\."generation_id" = \$2::text/);
    assert.match(result.text, /EXISTS \(SELECT 1 FROM "mirror"\."variants" AS "v"/);
    assert.match(result.text, /"v"\."product_id" = "p"\."id"/);
    assert.deepEqual(result.values, [SHOP, GENERATION, "x", "10"]);
  });

  test("comparison, set and range operators use typed positional parameters", async () => {
    for (const [operator, value, expected] of [
      ["eq", "1", "="], ["neq", "1", "<>"], ["gt", "1", ">"],
      ["gte", "1", ">="], ["lt", "1", "<"], ["lte", "1", "<="],
      ["in", ["1", "2"], "IN"], ["not_in", ["1", "2"], "NOT IN"],
      ["between", ["1", "2"], "BETWEEN"],
    ]) {
      const result = await fixture().compile(node("variant.price", operator, value));
      assert.ok(result.text.includes(` ${expected} `));
      assert.match(result.text, /\$3::numeric/);
      if (Array.isArray(value)) assert.match(result.text, /\$4::numeric/);
    }
    const boolean = await fixture().compile(node("variant.taxable", "eq", false));
    assert.equal(boolean.values[2], false);
    assert.match(boolean.text, /\$3::boolean/);
  });

  test("text matching escapes literal wildcard characters in the parameter", async () => {
    const result = await fixture().compile(node("product.title", "contains", "100%_\\done"));
    assert.equal(result.values[2], "%100\\%\\_\\\\done%");
    assert.match(result.text, /ILIKE \$3::text/);
    assert.ok(result.text.includes("ESCAPE E'\\\\'"));
    assert.equal(result.text.includes("100"), false);
    for (const [operator, pattern] of [["not_contains", "%x%"], ["starts_with", "x%"], ["ends_with", "%x"]]) {
      assert.equal((await fixture().compile(node("product.title", operator, "x"))).values[2], pattern);
    }
  });

  test("presence and list predicates preserve SQL null exclusion", async () => {
    assert.match((await fixture().compile(presence("product.vendor", "is_null"))).text, /"vendor" IS NULL/);
    assert.match((await fixture().compile(presence("product.vendor", "is_not_null"))).text, /"vendor" IS NOT NULL/);
    for (const operator of ["is_empty", "is_not_empty"]) {
      const list = await fixture().compile(presence("product.tags", operator));
      assert.match(list.text, /cardinality\("p"\."tags"\)/);
      assert.equal(list.values[2], 0);
      assert.equal((await fixture().compile(presence("product.title", operator))).values[2], "");
    }
    for (const operator of ["list_contains", "list_not_contains"]) {
      const result = await fixture().compile(node("product.tags", operator, "tag"));
      assert.match(result.text, /\$3::text = ANY\("p"\."tags"\)/);
      assert.equal(result.values[2], "tag");
    }
  });

  test("unsupported field, operator and operand combinations are rejected before compilation", async () => {
    for (const root of [
      node("variant.taxable", "contains", "x"), node("product.title", "gt", "x"),
      node("product.title", "list_contains", "x"), node("variant.price", "eq", 1.25),
      node("variant.price", "in", []), node("variant.price", "between", ["2", "1"]),
      node("product.title", "is_null", null), node("product.title", "raw_sql", "TRUE"),
      presence("product.title", "eq"), node("product.notReal", "eq", "x"),
    ]) await assert.rejects(() => fixture().compile(root));
  });

  test("identifiers, expressions, storage types and conflicting alias scopes fail closed", async () => {
    for (const field of ["product.handle", "product.seoTitle", "product.productType", "product.descriptionHtml"]) {
      await assert.rejects(() => fixture().compile(node(field)));
    }
    await assert.rejects(() => fixture().compile({ kind: "group", operator: "AND", children: [
      node("product.title"), node("product.templateSuffix"),
    ] }), { code: C.INVALID_SOURCE });
  });

  test("request metadata cannot override SQL mappings and stale coverage still blocks compilation", async () => {
    const f = fixture();
    const validated = await f.service.validateFilter({ version: 1, root: node() }, f.context);
    await assert.rejects(() => f.service.compileFilter(validated, { authContext: f.context.authContext, column: "secret" }), { code: C.PERMISSION_DENIED });
    f.retire();
    await assert.rejects(() => f.service.compileFilter(validated, { authContext: f.context.authContext }), { code: C.MISSING_DEPENDENCY });
  });

  test("SQL parameter complexity is bounded independently of AST size", async () => {
    const values = Array.from({ length: 100 }, (_, i) => String(i));
    await assert.rejects(() => fixture().compile({ kind: "group", operator: "AND", children:
      Array.from({ length: 5 }, () => node("variant.price", "in", [...values])),
    }), { code: C.INVALID_VALUE });
  });

  test("all negative predicates preserve UNKNOWN for null columns", async () => {
    for (const root of [
      node("product.vendor", "neq", "Nike"), node("product.vendor", "not_in", ["Nike", "Puma"]),
      node("product.vendor", "not_contains", "Nike"), node("product.tags", "list_not_contains", "Summer"),
    ]) {
      const result = await fixture().compile(root);
      assert.equal(result.binding.nullSemanticsVersion, FILTER_NULL_SEMANTICS_VERSION);
      assert.doesNotMatch(result.text, /COALESCE|IS DISTINCT FROM|OR .*IS NULL|IS NOT NULL/);
      assert.equal(result.values.includes(null), false);
      const negated = await fixture().compile({ kind: "group", operator: "NOT", children: [root] });
      assert.match(negated.text, /\(NOT /);
      assert.doesNotMatch(negated.text, /COALESCE|OR .*IS NULL|IS NOT NULL/);
    }
  });

  test("negative predicates reject null operands and null set members", async () => {
    for (const root of [
      node("product.vendor", "neq", null), node("product.vendor", "not_in", ["Nike", null]),
      node("product.vendor", "not_contains", null), node("product.tags", "list_not_contains", null),
    ]) await assert.rejects(() => fixture().compile(root));
  });

  test("NULL inspection stays explicit and separate from empty values", async () => {
    const nullQuery = await fixture().compile(presence("product.vendor", "is_null"));
    const emptyQuery = await fixture().compile(presence("product.vendor", "is_empty"));
    assert.match(nullQuery.text, /IS NULL/);
    assert.doesNotMatch(emptyQuery.text, /IS NULL/);
    assert.equal(emptyQuery.values[2], "");
    assert.match(nullQuery.binding.filterFingerprint, /^[a-f0-9]{64}$/);
  });

  test("actual compiled plan accepts 500 parameters including scope and rejects 501", async () => {
    const values = Array.from({ length: 100 }, (_, i) => String(i));
    const root = last => ({ kind: "group", operator: "AND", children: [
      ...Array.from({ length: 4 }, () => node("variant.price", "in", [...values])),
      node("variant.price", "in", values.slice(0, last)),
    ] });
    const result = await fixture().compile(root(98));
    assert.equal(result.values.length, 500);
    assert.deepEqual(result.plan, { parameters: 500, correlatedSubqueries: 1, estimatedCost: 10 });
    await assert.rejects(() => fixture().compile(root(99)), { code: C.INVALID_VALUE });
  });

  test("SKU and price constraints share exactly one correlated variant row", async () => {
    const root = { kind: "group", operator: "AND", children: [
      node("variant.sku", "eq", "ABC"), node("variant.price", "gt", "100"),
    ] };
    const result = await fixture().compile(root);
    assert.equal((result.text.match(/EXISTS/g) ?? []).length, 1);
    assert.match(result.text, /"v"\."sku" = \$3::text/);
    assert.match(result.text, /"v"\."price" > \$4::numeric/);
    assert.equal(result.plan.correlatedSubqueries, 1);
    assert.equal(result.plan.estimatedCost, 4);
    const mixed = await fixture().compile({ kind: "group", operator: "AND", children: [
      node("variant.sku", "eq", "ABC"), { kind: "group", operator: "AND", children: [
        node("product.title", "eq", "Title"), node("variant.price", "gt", "100"),
      ] },
    ] });
    assert.equal((mixed.text.match(/EXISTS/g) ?? []).length, 1);
    assert.ok(mixed.text.includes('"v"."sku"'));
    assert.ok(mixed.text.includes('"v"."price"'));
  });

  test("complete queries preserve the predicate compiler's same-variant correlation and rejection rules", async () => {
    const f = await queryFixture(undefined, { price: physicalColumn("numeric"), sku: physicalColumn("text") });
    const input = { version: 1, root: { kind: "group", operator: "AND", children: [
      node("variant.sku", "eq", "ABC"), { kind: "group", operator: "AND", children: [
        node("product.title", "eq", "Summer"), node("variant.price", "gt", "100"),
      ] },
    ] } };
    const validated = await f.compiler.validateFilter(input, f.context);
    const query = await f.compiler.compileFilter(validated, { authContext: f.context.authContext });
    assert.equal((query.text.match(/EXISTS/g) ?? []).length, 1);
    for (const clause of ['"v"."sku"', '"v"."price"', '"v"."shop_id" = $1::text',
      '"v"."generation_id" = $2::text', '"v"."product_id" = "p"."id"']) assert.ok(query.text.includes(clause));
    assert.deepEqual(f.compiler.getExecutionPlan(query).datasets, ["products", "variants"]);
    assert.deepEqual(f.compiler.getResolutionPlan(validated).fieldIds, ["product.title", "variant.price", "variant.sku"]);
    for (const root of [
      { kind: "group", operator: "OR", children: [node("product.title"), node("variant.price", "gt", "100")] },
      { kind: "group", operator: "NOT", children: [node("variant.sku", "eq", "ABC")] },
    ]) await assert.rejects(() => f.compiler.validateFilter({ version: 1, root }, f.context), { code: C.UNSUPPORTED_OPERATION });
  });

  test("ambiguous mixed OR and variant NOT are not silently split into EXISTS clauses", async () => {
    for (const root of [
      { kind: "group", operator: "OR", children: [node("product.title"), node("variant.price", "gt", "100")] },
      { kind: "group", operator: "NOT", children: [node("variant.price", "gt", "100")] },
    ]) await assert.rejects(() => fixture().compile(root), { code: C.UNSUPPORTED_OPERATION });
  });

  test("compiler requires declared published mirror and source versions", async () => {
    for (const [mirror, source] of [["mirror_v2", "sources_v1"], ["mirror_v1", "sources_v2"], [undefined, undefined]]) {
      const f = fixture(); f.compatibility(mirror, source);
      await assert.rejects(() => f.compile(node()), { code: mirror === undefined ? C.MISSING_DEPENDENCY : C.CONTRACT_MISMATCH });
    }
  });

  test("compiler compatibility changes after validation reject the issued contract", async () => {
    for (const [mirror, source] of [["mirror_v2", "sources_v1"], ["mirror_v1", "sources_v2"]]) {
      const f = fixture();
      const validated = await f.service.validateFilter({ version: 1, root: node() }, f.context);
      f.compatibility(mirror, source);
      await assert.rejects(() => f.service.compileFilter(validated,
        { authContext: f.context.authContext }), { code: C.CONTRACT_MISMATCH });
    }
  });
});
