import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_FIELDS } from "../../fields/canonical.js";
import { SOURCE_DATASETS } from "../../fields/sources.js";
import { deepFreeze, FIELD_ERROR_CODES as C } from "../../fields/types.js";
import { createMirrorCoverageService } from "../../mirror/coverage.js";
import { createMetafieldAdapter } from "../../fields/metafield-adapter.js";
import { parseFilterAst, inspectFilterAst } from "../ast.js";
import { listOperatorsForType } from "../../fields/operators.js";

describe("validated filter trust and live compilation guard", {
  skip: typeof mock.module !== "function" && "Requires --experimental-test-module-mocks",
}, async () => {
  if (typeof mock.module !== "function") return;
  const FIELD_SOURCES = deepFreeze(Object.fromEntries(Object.values(CANONICAL_FIELDS).map(field => [field.id, {
    fieldId: field.id, entity: field.entity, canonicalType: field.type,
    canonicalDerived: field.derived, kind: "column", datasets: field.entity === "variant" ? ["products", "variants"] : ["products"],
    sql: { kind: "column", alias: field.entity === "variant" ? "v" : "p",
      column: field.id.split(".").at(-1), storageType: field.id === "variant.price" ? "numeric" : "text",
      shopColumn: "shop_id", generationColumn: "generation_id" },
  }])));
  const FILTER_SQL_SCHEMA = {
    mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
    product: { alias: "p", shopColumn: "shop_id", generationColumn: "generation_id", idColumn: "id" },
    variant: { schema: "mirror", table: "variants", alias: "v", shopColumn: "shop_id", generationColumn: "generation_id", productIdColumn: "product_id" },
  };
  const FILTER_BINDING_DEFINITIONS = ["product.title", "variant.price"].map(fieldId => {
    const field = CANONICAL_FIELDS[fieldId], source = FIELD_SOURCES[fieldId];
    return { fieldId, entity: field.entity, sourceKind: "column", datasets: [...source.datasets],
      correlation: field.entity === "variant" ? "variant_exists" : "product",
      handlerId: field.entity === "variant" ? "variant_exists_v1" : "product_column_v1",
      operators: listOperatorsForType(field.type).map(op => typeof op === "string" ? op : op.id),
      cost: field.entity === "variant" ? 2 : 1, mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1" };
  });
  const dependency = mock.module("../../fields/sources.js", { namedExports: { FIELD_SOURCES, SOURCE_DATASETS, FILTER_SQL_SCHEMA, FILTER_BINDING_DEFINITIONS } });
  let R, V, fingerprintFilterExecution, createFilterEngine, createFilterResolver;
  try {
    R = await import("../../fields/resolve.js");
    V = await import("../validate.js");
    ({ createFilterResolver } = await import("../resolver.js"));
    ({ fingerprintFilterExecution } = await import("../fingerprint.js"));
    ({ createFilterEngine } = await import("../../services/filter-engine.server.js"));
  } finally { dependency.restore(); }
  const SHOP = "alpha.myshopify.com";
  const ID = "product.metafield.m01234567";
  const GENERATION = "generation123";
  const REVISION = "coverage123";
  const ast = (changes = {}) => ({ version: 1, root: {
    kind: "condition", field: "variant.price", operator: "eq", value: "12.5000", ...changes,
  } });

  function fixture(withTarget = false) {
    const state = {
      shopId: SHOP, generationId: GENERATION, status: "PUBLISHED", complete: true,
      coverageRevision: REVISION, targetStatus: "APPROVED", authorizations: 0, coverageReads: 0,
      granted: true, infrastructureError: null,
      approvalGranted: true, approvalRevision: "approval123", approvalReads: 0,
      allowedOperations: new Set(["filter"]), operations: [],
      definition: {
        shopId: SHOP, fieldId: ID, status: "ACTIVE", definitionVerified: true,
        shopifyDefinitionId: "gid://shopify/MetafieldDefinition/123", definitionToken: "Definition_token-123456",
        locatorId: "locator:material_123", namespace: "$app", key: "material", label: "Material",
        ownerEntity: "product", shopifyOwnerType: "PRODUCT", shopifyType: "single_line_text_field",
        nullable: true, writable: false, mutationSupported: false,
        readerAdapterId: "metafieldReader", writerAdapterId: null,
        verifiedAt: "2026-10-27T09:00:00Z", verificationExpiresAt: "2026-10-27T11:00:00Z",
      },
    };
    const coverage = createMirrorCoverageService({ repository: { getPublishedSnapshot: async input => {
      state.coverageReads++;
      return {
        shopId: SHOP, generationId: state.generationId, coverageRevision: state.coverageRevision, status: state.status,
        mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
        datasets: (state.coverageDatasets ?? input.datasets).map(name => ({ name, generationId: state.generationId,
          status: state.complete ? "COMPLETE" : "PARTIAL", published: true })),
        targetingSnapshot: {
          id: "target123", shopId: SHOP, generationId: GENERATION, coverageRevision: REVISION,
          status: state.targetStatus, datasets: ["products", "variants", "metafields"],
        },
      };
    } } });
    const fieldService = R.createFieldService({
      adapter: createMetafieldAdapter({ clock: () => Date.parse("2026-10-27T10:00:00Z"),
        repository: { findVerifiedDefinitions: async () => [state.definition] } }),
      resolveShop: async () => state.shopId,
      authorizeAccess: async ({ operation }) => {
        if (state.infrastructureError) throw state.infrastructureError;
        state.authorizations++; state.operations.push(operation);
        return state.granted && state.allowedOperations.has(operation);
      },
      verifyCoverage: coverage.getVerifiedCoverage,
      verifyExecutionContext: async ({ shopId, operation, executionContext, targetingSnapshot }) => {
        state.approvalReads++;
        return { approved: state.approvalGranted, shopId, operation, operationId: executionContext.operationId,
          generationId: executionContext.generationId, targetingSnapshotId: targetingSnapshot.snapshotId,
          executionContractId: "contract123", approvalRevision: state.approvalRevision };
      },
    });
    const context = {
      authContext: { sessionId: "verified-session" }, operation: "filter",
      executionContext: { operationId: "operation123", generationId: GENERATION,
        ...(withTarget ? { approvedTargetingSnapshot: {
          snapshotId: "target123", shopId: SHOP, generationId: GENERATION, coverageRevision: REVISION,
        } } : {}),
      },
    };
    return { state, fieldService, service: V.createFilterService({ fieldService }), context };
  }

  test("semantic validation binds normalized predicates to shop, operation, generation and mappings", async () => {
    const f = fixture();
    const validated = await f.service.validateFilter(ast(), f.context);
    assert.equal(validated.ast.root.value, "12.5");
    assert.equal(validated.shopId, SHOP);
    assert.equal(validated.operation, "filter");
    assert.equal(validated.operationId, "operation123");
    assert.equal(validated.generationId, GENERATION);
    assert.equal(validated.coverageRevision, REVISION);
    assert.match(validated.registryVersion, /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(validated));
    assert.ok(Object.isFrozen(validated.ast.root));
  });

  test("trusted filter resolver returns authorized fields without issuing a semantic validation grant", async () => {
    const f = fixture(), resolver = createFilterResolver({ fieldService: f.fieldService });
    const resolution = await resolver.resolveFilterFields(ast(), f.context);
    assert.ok(Object.isFrozen(resolver));
    assert.ok(Object.isFrozen(resolution));
    assert.equal(resolution.shopId, SHOP);
    assert.equal(resolution.generationId, GENERATION);
    assert.equal(resolution.coverageRevision, REVISION);
    assert.equal(resolution.access, "read");
    assert.deepEqual(resolution.fields.map(field => field.id), ["variant.price"]);
    assert.deepEqual(resolution.datasets, ["products", "variants"]);
    assert.ok(f.state.authorizations > 0 && f.state.coverageReads > 0);
    await assert.rejects(() => f.service.compileFilter(resolution, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
    const current = await resolver.revalidateFilterFields(resolution, { authContext: f.context.authContext });
    assert.equal(current.shopId, SHOP);
  });

  test("filter resolver rejects copied and foreign receipts before invoking revalidation", async () => {
    const f = fixture(), resolver = createFilterResolver({ fieldService: f.fieldService });
    const other = createFilterResolver({ fieldService: f.fieldService });
    const resolution = await resolver.resolveFilterFields(ast(), f.context);
    const foreign = await other.resolveFilterFields(ast(), f.context);
    const direct = await f.fieldService.requireFields({ ...f.context, fieldIds: ["variant.price"], access: "read" });
    const before = f.state.authorizations;
    for (const receipt of [{ ...resolution }, structuredClone(resolution), foreign, direct, null]) {
      await assert.rejects(() => resolver.revalidateFilterFields(receipt, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
    }
    assert.equal(f.state.authorizations, before);
  });

  test("filter resolver refuses request-owned identity, services, write access and accessor properties", async () => {
    const f = fixture(), resolver = createFilterResolver({ fieldService: f.fieldService });
    const getter = Object.defineProperty({ ...f.context }, "authContext", { get() { assert.fail("Getter invoked"); } });
    for (const context of [getter,
      { ...f.context, shopId: SHOP }, { ...f.context, access: "write" }, { ...f.context, fieldIds: [] },
      { ...f.context, sources: {} }, { ...f.context, authorizeAccess: () => true }, { ...f.context, [Symbol("mapping")]: {} },
    ]) await assert.rejects(() => resolver.resolveFilterFields(ast(), context), { code: C.PERMISSION_DENIED });
    assert.equal(f.state.authorizations, 0);
    assert.equal(f.state.coverageReads, 0);
  });

  test("filter resolver revalidates live shop, permissions, coverage and definition tokens", async () => {
    for (const change of [state => { state.shopId = "other.myshopify.com"; },
      state => { state.granted = false; }, state => { state.status = "RETIRED"; }]) {
      const f = fixture(), resolver = createFilterResolver({ fieldService: f.fieldService });
      const resolution = await resolver.resolveFilterFields(ast(), f.context);
      change(f.state);
      await assert.rejects(() => resolver.revalidateFilterFields(resolution, { authContext: f.context.authContext }));
    }
    const f = fixture(), resolver = createFilterResolver({ fieldService: f.fieldService });
    const resolution = await resolver.resolveFilterFields(ast({ field: ID, value: "Cotton" }), f.context);
    f.state.definition.definitionToken = "Changed_definition_token-123";
    await assert.rejects(() => resolver.revalidateFilterFields(resolution, { authContext: f.context.authContext }), { code: C.CONTRACT_MISMATCH });
  });

  test("server bootstrap authenticates both validation and compilation with a real shop domain", async () => {
    const f = fixture();
    let calls = 0;
    const engine = createFilterEngine({ fieldService: f.fieldService, authenticatedSessionService: {
      requireAuthenticatedShop: async context => {
        assert.strictEqual(context, f.context.authContext); calls++;
        return { shopId: SHOP };
      },
    } });
    const validated = await engine.validateFilter(ast(), f.context);
    const plan = await engine.compileFilter(validated, { authContext: f.context.authContext });
    assert.equal(validated.shopId, SHOP); assert.equal(plan.binding.shopId, SHOP);
    assert.equal(calls, 2); assert.ok(Object.isFrozen(engine));
    await assert.rejects(() => engine.compileFilter(ast(), { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
  });

  test("server bootstrap refuses cross-shop and revoked sessions on each call", async () => {
    const f = fixture();
    let shopId = SHOP, revoked = false;
    const engine = createFilterEngine({ fieldService: f.fieldService, authenticatedSessionService: {
      requireAuthenticatedShop: async () => {
        if (revoked) throw new Error("Session revoked");
        return { shopId };
      },
    } });
    const validated = await engine.validateFilter(ast(), f.context);
    shopId = "other.myshopify.com";
    await assert.rejects(() => engine.validateFilter(ast(), f.context), { code: C.PERMISSION_DENIED });
    await assert.rejects(() => engine.compileFilter(validated, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
    revoked = true;
    const reads = f.state.coverageReads;
    await assert.rejects(() => engine.compileFilter(validated, { authContext: f.context.authContext }), /Session revoked/);
    assert.equal(f.state.coverageReads, reads);
  });

  test("server bootstrap rejects unverified session results and request-supplied bindings", async () => {
    const f = fixture();
    assert.throws(() => createFilterEngine({ fieldService: f.fieldService }), /Authenticated session service/);
    const accessor = {};
    Object.defineProperty(accessor, "shopId", { get() { assert.fail("Unverified session getter executed"); } });
    for (const result of [null, {}, { shopId: "" }, { shopId: " shop.myshopify.com" }, accessor]) {
      const engine = createFilterEngine({ fieldService: f.fieldService, authenticatedSessionService: {
        requireAuthenticatedShop: async () => result,
      } });
      await assert.rejects(() => engine.validateFilter(ast(), f.context), { code: C.PERMISSION_DENIED });
    }
    assert.equal(f.state.authorizations, 0);
    assert.throws(() => createFilterEngine({ fieldService: f.fieldService,
      authenticatedSessionService: { requireAuthenticatedShop: async () => ({ shopId: SHOP }) }, verifiedSqlBindings: [],
    }), /Unsupported/);
  });

  test("duplicate products coverage cannot stand in for required variants coverage", async () => {
    const f = fixture();
    f.state.coverageDatasets = ["products", "products"];
    await assert.rejects(() => f.service.validateFilter(ast(), f.context), { code: C.MISSING_DEPENDENCY });
  });

  test("explicit null operation is rejected rather than defaulting authorization to filter", async () => {
    const f = fixture();
    await assert.rejects(() => f.service.validateFilter(ast(), { ...f.context, operation: null }));
    assert.equal(f.state.authorizations, 0);
  });

  test("resolution provenance rejects copies, replacement canonical descriptors and another service", async () => {
    const f = fixture();
    const resolution = await f.fieldService.requireFields({ ...f.context, access: "read", fieldIds: ["product.title"] });
    assert.strictEqual(f.fieldService.assertResolution(resolution), resolution);
    assert.strictEqual(resolution.fields[0].field, CANONICAL_FIELDS["product.title"]);
    const replacement = Object.freeze({ ...resolution, fields: Object.freeze([
      Object.freeze({ ...resolution.fields[0], field: Object.freeze({ ...resolution.fields[0].field }) }),
    ]) });
    const accessorFields = [];
    Object.defineProperty(accessorFields, "0", { get() { assert.fail("Untrusted field getter executed"); } });
    for (const forged of [{ ...resolution }, replacement,
      Object.freeze({ ...resolution, fields: Object.freeze(new Array(1)) }),
      Object.freeze({ ...resolution, fields: Object.freeze(accessorFields) })]) {
      assert.throws(() => f.fieldService.assertResolution(forged), { code: C.PERMISSION_DENIED });
    }
    assert.throws(() => fixture().fieldService.assertResolution(resolution), { code: C.PERMISSION_DENIED });
    assert.throws(() => R.assertResolvedFieldAccess(replacement.fields[0], "read", { shopId: SHOP }), { code: C.PERMISSION_DENIED });
  });

  test("semantic validation rejects incompatible operators, unknown fields and invalid operands", async () => {
    const f = fixture();
    for (const input of [ast({ field: "variant.taxable", operator: "contains", value: "yes" }),
      ast({ field: "product.notRegistered" }), ast({ value: 12.5 })]) {
      await assert.rejects(() => f.service.validateFilter(input, f.context));
    }
  });

  test("authorization infrastructure failures retain their identity rather than becoming invalid filters", async () => {
    const f = fixture();
    const failure = new Error("Authorization service unavailable");
    f.state.infrastructureError = failure;
    await assert.rejects(() => f.service.validateFilter(ast(), f.context), error => error === failure);
    assert.equal(f.state.coverageReads, 0);
  });

  test("authorization and coverage must succeed before semantic provenance is issued", async () => {
    const denied = fixture(); denied.state.granted = false;
    await assert.rejects(() => denied.service.validateFilter(ast(), denied.context), { code: C.PERMISSION_DENIED });
    const incomplete = fixture(); incomplete.state.complete = false;
    await assert.rejects(() => incomplete.service.validateFilter(ast(), incomplete.context), { code: C.MISSING_DEPENDENCY });
    const revoked = fixture();
    const validated = await revoked.service.validateFilter(ast(), revoked.context);
    revoked.state.granted = false;
    await assert.rejects(() => revoked.service.compileFilter(validated, { authContext: revoked.context.authContext }), { code: C.PERMISSION_DENIED });
  });

  test("a plain object impersonating the field service cannot mint validated filters", () => {
    assert.throws(() => V.createFilterService({ fieldService: {
      requireFields: async () => ({}), revalidateResolution: async () => ({}),
    } }), { code: C.PERMISSION_DENIED });
  });

  test("inconsistent field-service implementations are rejected before reading their responses", () => {
    const f = fixture();
    const accessorFields = [];
    Object.defineProperty(accessorFields, "0", { get() { assert.fail("Forged response getter executed"); } });
    for (const response of [
      { shopId: "other.myshopify.com", operation: "bulk_edit", fields: [] },
      { shopId: SHOP, operation: "filter", fields: new Array(1) },
      { shopId: SHOP, operation: "filter", fields: accessorFields },
      { shopId: SHOP, operation: "filter", fields: [{ id: "product.title", type: "boolean" }] },
    ]) {
      const impostor = Object.freeze({ ...f.fieldService,
        requireFields: async () => { assert.fail("Untrusted service invoked"); return response; },
        revalidateResolution: async () => response,
        assertResolution: () => true,
      });
      assert.throws(() => V.createFilterService({ fieldService: impostor }), { code: C.PERMISSION_DENIED });
    }
    assert.equal(Reflect.set(f.fieldService, "requireFields", async () => ({})), false);
  });

  test("bulk targeting compilation rechecks persisted approvals and cannot switch operations", async () => {
    for (const changes of [{ approvalGranted: false }, { approvalRevision: "replacedApproval" },
      { allowedOperations: new Set(["filter"]) }]) {
      const f = fixture(true);
      f.state.allowedOperations.add("bulk_edit");
      const context = { ...f.context, operation: "bulk_edit" };
      const validated = await f.service.validateFilter(ast(), context);
      assert.equal(validated.executionContractId, "contract123");
      assert.equal(validated.operation, "bulk_edit");
      await assert.rejects(() => f.service.compileFilter(validated, {
        authContext: context.authContext, operation: "filter",
      }), { code: C.PERMISSION_DENIED });
      Object.assign(f.state, changes);
      await assert.rejects(() => f.service.compileFilter(validated, { authContext: context.authContext }));
      assert.equal(f.state.approvalReads, 2);
    }
  });

  test("changed definition revisions cannot reuse an issued field-service resolution", async () => {
    const f = fixture();
    const resolution = await f.fieldService.requireFields({ ...f.context, access: "read", fieldIds: [ID] });
    const stableId = resolution.fields[0].source.definitionId;
    f.state.definition = { ...f.state.definition, definitionToken: "Definition_token-987654" };
    await assert.rejects(() => f.fieldService.revalidateResolution(resolution,
      { authContext: f.context.authContext }), { code: C.CONTRACT_MISMATCH });
    assert.equal(f.state.definition.shopifyDefinitionId, stableId);
  });

  test("compiler rejects copied, forged and cross-service validated filters", async () => {
    const f = fixture();
    const validated = await f.service.validateFilter(ast(), f.context);
    for (const forged of [{ ...validated }, { ...validated, shopId: "beta.myshopify.com" }, ast()]) {
      await assert.rejects(() => f.service.compileFilter(forged, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
    }
    await assert.rejects(() => fixture().service.compileFilter(validated, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
  });

  test("cross-shop authentication cannot reuse a genuine validated filter", async () => {
    const f = fixture();
    const validated = await f.service.validateFilter(ast(), f.context);
    f.state.shopId = "beta.myshopify.com";
    await assert.rejects(() => f.service.compileFilter(validated, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
  });

  test("compilation rechecks published completeness and the exact pinned generation", async () => {
    for (const changes of [{ status: "RETIRED" }, { status: "IMPORTING" },
      { complete: false }, { generationId: "replacementGeneration" }, { coverageRevision: "replacementRevision" }]) {
      const f = fixture();
      const validated = await f.service.validateFilter(ast(), f.context);
      Object.assign(f.state, changes);
      await assert.rejects(() => f.service.compileFilter(validated, { authContext: f.context.authContext }), { code: C.MISSING_DEPENDENCY });
      assert.equal(f.state.coverageReads, 2);
    }
  });

  test("revoked approved targeting snapshots prevent compilation", async () => {
    const f = fixture(true);
    const validated = await f.service.validateFilter(ast(), f.context);
    f.state.targetStatus = "REVOKED";
    await assert.rejects(() => f.service.compileFilter(validated, { authContext: f.context.authContext }), { code: C.MISSING_DEPENDENCY });
  });

  test("mapping drift is rejected even if the definition token was not rotated", async () => {
    const f = fixture();
    const resolution = await f.fieldService.requireFields({ ...f.context, access: "read", fieldIds: [ID] });
    f.state.definition = { ...f.state.definition, locatorId: "locator:changed_456" };
    await assert.rejects(() => f.fieldService.revalidateResolution(resolution, { authContext: f.context.authContext }), { code: C.CONTRACT_MISMATCH });
  });

  test("approved registry version pins reject mismatched field mappings", async () => {
    const f = fixture();
    const result = await f.fieldService.requireFields({ ...f.context, fieldIds: ["product.title"] });
    await assert.rejects(() => f.fieldService.requireFields({ ...f.context, fieldIds: ["product.title"],
      executionContext: { ...f.context.executionContext, expectedRegistryVersion: "a".repeat(64) },
    }), { code: C.CONTRACT_MISMATCH });
    const current = await f.fieldService.requireFields({ ...f.context, fieldIds: ["product.title"],
      executionContext: { ...f.context.executionContext, expectedRegistryVersion: result.registryVersion },
    });
    assert.equal(current.registryVersion, result.registryVersion);
  });

  test("fields without registered SQL bindings cannot receive validated provenance", async () => {
    const f = fixture();
    await assert.rejects(() => f.service.validateFilter(ast({ field: ID, value: "cotton" }), f.context), {
      code: C.UNSUPPORTED_OPERATION,
    });
    assert.equal(f.state.coverageReads, 1);
    assert.equal(f.state.authorizations, 1);
    const validated = await f.service.validateFilter(ast(), f.context);
    await assert.rejects(() => f.service.compileFilter(validated, {
      authContext: f.context.authContext, generationId: "anotherGeneration",
    }), { code: C.PERMISSION_DENIED });
  });

  test("the same AST is reauthorized when requested for a different operation", async () => {
    const f = fixture(true);
    const input = ast();
    const filtered = await f.service.validateFilter(input, f.context);
    await assert.rejects(() => f.service.validateFilter(input, { ...f.context, operation: "export" }), { code: C.PERMISSION_DENIED });
    f.state.allowedOperations.add("export");
    const exported = await f.service.validateFilter(input, { ...f.context, operation: "export" });
    assert.deepEqual(f.state.operations, ["filter", "export", "export"]);
    assert.equal(filtered.operation, "filter");
    assert.equal(exported.operation, "export");
    assert.notEqual(filtered.fingerprint, exported.fingerprint);
    await assert.rejects(() => f.service.compileFilter(filtered, {
      authContext: f.context.authContext, operation: "export",
    }), { code: C.PERMISSION_DENIED });
  });

  test("authorization is never cached by canonical content or a bound fingerprint", async () => {
    const f = fixture();
    const first = await f.service.validateFilter(ast(), f.context);
    const second = await f.service.validateFilter(ast(), f.context);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.notStrictEqual(first, second);
    assert.equal(f.state.authorizations, 2);
    f.state.granted = false;
    await assert.rejects(() => f.service.validateFilter(ast(), f.context), { code: C.PERMISSION_DENIED });
    assert.equal(f.state.authorizations, 3);
    f.state.shopId = "beta.myshopify.com";
    await assert.rejects(() => f.service.compileFilter(first, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
  });

  test("execution condition budget is separate from saved-view structural limits", async () => {
    const f = fixture();
    const input = count => ({ version: 1, root: { kind: "group", operator: "AND",
      children: Array.from({ length: count }, () => ast().root) } });
    assert.equal(inspectFilterAst(input(101)).conditions, 101);
    await assert.rejects(() => f.service.validateFilter(input(101), f.context), { code: C.INVALID_VALUE });
    assert.equal(f.state.authorizations, 0);
    assert.equal(f.state.coverageReads, 0);
    assert.equal((await f.service.validateFilter(input(100), f.context)).ast.root.children.length, 100);
  });

  test("execution depth is limited to twelve while structural parsing permits thirty-two", async () => {
    const f = fixture();
    function input(depth) {
      let root = ast({ field: "product.title", value: "x" }).root;
      for (let i = 1; i < depth; i++) root = { kind: "group", operator: "NOT", children: [root] };
      return { version: 1, root };
    }
    assert.equal(inspectFilterAst(parseFilterAst(input(32))).maxDepth, 32);
    await assert.rejects(() => f.service.validateFilter(input(13), f.context), { code: C.INVALID_VALUE });
    await f.service.validateFilter(input(12), f.context);
  });

  test("OR budget measures total fan-out across all nested groups", async () => {
    const f = fixture();
    const or = count => ({ kind: "group", operator: "OR", children: Array.from({ length: count }, () => ast().root) });
    await f.service.validateFilter({ version: 1, root: or(32) }, f.context);
    await assert.rejects(() => f.service.validateFilter({ version: 1, root: or(33) }, f.context), { code: C.INVALID_VALUE });
    // Two outer branches plus 31 inner branches = 33, despite only 32 leaves.
    const nested = { version: 1, root: { kind: "group", operator: "OR", children: [ast().root, or(31)] } };
    await assert.rejects(() => f.service.validateFilter(nested, f.context), { code: C.INVALID_VALUE });
  });

  test("production fingerprints use issued resolution revisions and actual code versions", async t => {
    t.mock.method(String.prototype, "localeCompare", () => assert.fail("Locale-dependent identity ordering used"));
    const f = fixture();
    const context = { ...f.context, executionContext: { ...f.context.executionContext,
      operatorVersion: 999, normalizationVersion: 999, constraintsVersion: 999,
      definitionRevisions: [{ fieldId: ID, definitionToken: "forged_token-987654" }],
    } };
    const validated = await f.service.validateFilter(ast(), context);
    assert.deepEqual(validated.definitionRevisions, []);
    assert.equal(validated.versions.operators, 1);
    assert.equal(validated.versions.normalization, 1);
    assert.equal(validated.versions.constraints, 3);
    assert.equal(validated.fingerprint, fingerprintFilterExecution({
      ast: validated.ast, shopId: validated.shopId, operation: validated.operation, operationId: validated.operationId,
      generationId: validated.generationId, coverageRevision: validated.coverageRevision,
      registryVersion: validated.registryVersion, targetingSnapshotId: validated.targetingSnapshotId,
      mirrorSchemaVersion: validated.mirrorSchemaVersion, sourceContractVersion: validated.sourceContractVersion,
      validationVersion: validated.versions.validation, astVersion: validated.versions.ast,
      canonicalVersion: validated.versions.canonical, operatorVersion: validated.versions.operators,
      bindingVersion: validated.versions.bindings, definitionRevisions: validated.definitionRevisions,
    }));
    await assert.rejects(() => f.service.validateFilter(ast(), { ...f.context, shopId: "beta.myshopify.com" }), { code: C.PERMISSION_DENIED });
    await assert.rejects(() => f.service.compileFilter({ ...validated }, { authContext: f.context.authContext }), { code: C.PERMISSION_DENIED });
  });
});
