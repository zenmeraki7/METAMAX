import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_FIELDS } from "./canonical.js";
import { SOURCE_DATASETS } from "./sources.js";
import { deepFreeze, FIELD_ERROR_CODES as C } from "./types.js";
import { createMetafieldAdapter } from "./metafield-adapter.js";
import { createMirrorCoverageService } from "../mirror/coverage.js";

describe("server-owned field service", {
  skip: typeof mock.module !== "function" && "Requires --experimental-test-module-mocks",
}, async () => {
  if (typeof mock.module !== "function") return;
  const FIELD_SOURCES = deepFreeze(Object.fromEntries(Object.values(CANONICAL_FIELDS).map(field => [field.id, {
    fieldId: field.id, entity: field.entity, canonicalType: field.type,
    canonicalDerived: field.derived, datasets: ["products"],
  }])));
  const dependency = mock.module("./sources.js", { namedExports: { FIELD_SOURCES, SOURCE_DATASETS } });
  // Explicit isolated adapter for generic future metafield revision tests.
  const capability = mock.module('./write-capabilities.js',{namedExports:{WRITE_CAPABILITY_VERSION:'fixture-v1',requireInstalledWriteCapability(){}}});
  let R;
  try { R = await import("./resolve.js?field-service"); } finally { dependency.restore(); capability.restore(); }
  const SHOP = "alpha.myshopify.com";
  const ID = "product.metafield.m01234567";
  const GENERATION = "generation123";
  const REVISION = "coverage123";
  const targetingSnapshot = Object.freeze({ snapshotId: "target123", shopId: SHOP, generationId: GENERATION, coverageRevision: REVISION });
  const authContext = Object.freeze({ sessionId: "authenticated-session" });
  function request(changes = {}) {
    return {
      authContext, fieldIds: ["product.title"], operation: "filter",
      executionContext: { operationId: "operation123", generationId: GENERATION },
      ...changes,
    };
  }
  function rawRow() {
    return {
      shopId: SHOP, fieldId: ID, status: "ACTIVE", definitionVerified: true,
      shopifyDefinitionId: "gid://shopify/MetafieldDefinition/123", definitionToken: "Definition_token-123456",
      locatorId: "locator:material_123", namespace: "$app", key: "material", label: "Material",
      ownerEntity: "product", shopifyOwnerType: "PRODUCT", shopifyType: "single_line_text_field",
      nullable: true, writable: true, mutationSupported: true,
      readerAdapterId: "metafieldReader", writerAdapterId: "metafieldWriter",
      verifiedAt: "2026-10-27T09:00:00Z", verificationExpiresAt: "2026-10-27T11:00:00Z",
    };
  }
  function configured(overrides = {}) {
    return {
      adapter: createMetafieldAdapter({
        clock: () => Date.parse("2026-10-27T10:00:00Z"),
        repository: { findVerifiedDefinitions: async () => [rawRow()] },
      }),
      resolveShop: async context => { assert.strictEqual(context, authContext); return SHOP; },
      authorizeAccess: async () => true,
      verifyExecutionContext: async ({ shopId, operation, executionContext, targetingSnapshot }) => ({
        approved: true, shopId, operation, operationId: executionContext.operationId,
        generationId: executionContext.generationId, targetingSnapshotId: targetingSnapshot.snapshotId,
        executionContractId: "approved-contract123", approvalRevision: "approval123",
      }),
      verifyCoverage: async input => ({ ready: true, generationId: GENERATION, coverageRevision: REVISION,
        ...(input.executionContext.approvedTargetingSnapshot ? { targetingSnapshotId: input.executionContext.approvedTargetingSnapshot.snapshotId } : {}),
      }),
      ...overrides,
    };
  }

  test("factory requires all trusted dependencies", () => {
    assert.throws(() => R.createFieldService(), TypeError);
    for (const key of ["adapter", "resolveShop", "authorizeAccess", "verifyCoverage"]) {
      assert.throws(() => R.createFieldService(configured({ [key]: null })), TypeError);
    }
  });

  test("sensitive execution requires freshly verified persisted approval for its operation", async () => {
    for (const operation of ["bulk_edit", "scheduled_edit", "recurring_edit", "import", "undo"]) {
      const args = request({ operation, executionContext: { operationId: "operation123", generationId: GENERATION,
        approvedTargetingSnapshot: targetingSnapshot } });
      const missing = R.createFieldService(configured({ verifyExecutionContext: undefined }));
      await assert.rejects(() => missing.requireFields(args), { code: C.EXECUTION_UNAVAILABLE });
      let reads = 0, approved = true, approvalRevision = "approval123";
      const service = R.createFieldService(configured({ verifyExecutionContext: async input => {
        reads++;
        return { ...(await configured().verifyExecutionContext(input)), approved, approvalRevision };
      } }));
      const result = await service.requireFields(args);
      assert.equal(result.executionContractId, "approved-contract123");
      approved = false;
      await assert.rejects(() => service.revalidateResolution(result, { authContext }), { code: C.PERMISSION_DENIED });
      approved = true; approvalRevision = "changedApproval";
      await assert.rejects(() => service.revalidateResolution(result, { authContext }), { code: C.CONTRACT_MISMATCH });
      assert.equal(reads, 3);
    }
  });

  test("a forged operation context or a boolean cannot substitute for persisted approval", async () => {
    const args = request({ operation: "bulk_edit", executionContext: { operationId: "operation123", generationId: GENERATION,
      approvedTargetingSnapshot: targetingSnapshot, approved: true, executionContractId: "forged" } });
    for (const change of [{ shopId: "other.myshopify.com" }, { operation: "scheduled_edit" },
      { operationId: "otherOperation" }, { targetingSnapshotId: "otherTarget" }, { generationId: "otherGeneration" }]) {
      const service = R.createFieldService(configured({ verifyExecutionContext: async input => ({
        ...(await configured().verifyExecutionContext(input)), ...change,
      }) }));
      await assert.rejects(() => service.requireFields(args), { code: C.PERMISSION_DENIED });
    }
    const service = R.createFieldService(configured({ verifyExecutionContext: async () => true }));
    await assert.rejects(() => service.requireFields(args));
    await assert.rejects(() => service.requireFields({ ...args, executionContext: null }), { code: C.PERMISSION_DENIED });
  });

  test("canonical and dynamic fields produce one immutable approved contract", async () => {
    const events = [];
    const service = R.createFieldService(configured({
      authorizeAccess: async input => {
        events.push(input.field.id);
        assert.equal(input.shopId, SHOP);
        assert.strictEqual(input.authContext, authContext);
        assert.ok(Object.isFrozen(input.policy));
        return true;
      },
      verifyCoverage: async input => {
        events.push("coverage");
        assert.deepEqual(input.datasets, ["metafields", "products"]);
        assert.ok(Object.isFrozen(input.executionContext));
        return { ready: true, generationId: GENERATION, coverageRevision: REVISION };
      },
    }));
    const result = await service.requireFields(request({ fieldIds: [ID, "product.title", ID] }));
    assert.deepEqual(result.fields.map(field => field.id), [ID, "product.title"]);
    assert.deepEqual(events, [ID, "product.title", "coverage"]);
    assert.equal(result.shopId, SHOP);
    assert.equal(result.generationId, GENERATION);
    assert.equal(result.coverageRevision, REVISION);
    assert.deepEqual(result.definitionRevisions, [{ fieldId: ID, definitionToken: rawRow().definitionToken }]);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.fields));
    assert.ok(Object.isFrozen(result.definitionRevisions[0]));
  });

  test("single-field entry returns the same contract shape", async () => {
    const { fieldIds, ...args } = request();
    const result = await R.createFieldService(configured()).requireField({ ...args, fieldId: fieldIds[0] });
    assert.equal(result.fields.length, 1);
    assert.deepEqual(result.definitionRevisions, []);
  });

  test("request-level dependencies and shop or actor overrides are rejected before authentication", async () => {
    let called = false;
    const service = R.createFieldService(configured({ resolveShop: async () => { called = true; return SHOP; } }));
    for (const changes of [
      { shopId: "beta.myshopify.com" }, { actor: { id: "forged" } },
      { authorizeAccess: async () => true }, { verifyCoverage: async () => true },
      { dynamicResolver: async () => ({}) }, { adapter: {} },
    ]) {
      await assert.rejects(() => service.requireFields(request(changes)), { code: C.INVALID_DEFINITION });
    }
    assert.equal(called, false);
  });

  test("auth, operation, access and pinned generation are mandatory", async () => {
    const service = R.createFieldService(configured());
    for (const changes of [
      { authContext: null }, { authContext: [] }, { operation: "invented" },
      { access: null }, { executionContext: null }, { executionContext: { operationId: "operation" } },
      { executionContext: { operationId: "", generationId: GENERATION } },
    ]) {
      await assert.rejects(() => service.requireFields(request(changes)));
    }
  });

  test("malformed batches and accessors are rejected before authentication", async () => {
    let calls = 0;
    const service = R.createFieldService(configured({ resolveShop: async () => { calls++; return SHOP; } }));
    const accessor = ["product.title"];
    Object.defineProperty(accessor, "0", { get() { assert.fail("Getter executed"); } });
    for (const fieldIds of [[], new Array(1), Array(1001).fill("product.title"), accessor,
      Object.assign(["product.title"], { extra: true }), [{ id: "product.title" }]]) {
      await assert.rejects(() => service.requireFields(request({ fieldIds })));
    }
    assert.equal(calls, 0);
  });

  test("no partial authorization contract or coverage check when any field is denied", async () => {
    let coverageCalls = 0;
    const service = R.createFieldService(configured({
      authorizeAccess: async ({ field }) => field.id !== "product.vendor",
      verifyCoverage: async () => { coverageCalls++; return {}; },
    }));
    await assert.rejects(() => service.requireFields(request({ fieldIds: ["product.title", "product.vendor"] })), { code: C.PERMISSION_DENIED });
    assert.equal(coverageCalls, 0);
  });

  test("authorization accepts only exact true", async () => {
    for (const verdict of [false, null, 1, "true", {}]) {
      const service = R.createFieldService(configured({ authorizeAccess: async () => verdict }));
      await assert.rejects(() => service.requireFields(request()), { code: C.PERMISSION_DENIED });
    }
  });

  test("boolean coverage or missing and mismatched receipt fields never grant access", async () => {
    for (const receipt of [true, false, null, {},
      { ready: true, generationId: GENERATION },
      { ready: "true", generationId: GENERATION, coverageRevision: REVISION },
      { ready: true, generationId: "otherGeneration", coverageRevision: REVISION },
      { ready: true, generationId: GENERATION, coverageRevision: "" },
    ]) {
      const service = R.createFieldService(configured({ verifyCoverage: async () => receipt }));
      await assert.rejects(() => service.requireFields(request()), { code: C.MISSING_DEPENDENCY });
    }
  });

  test("execution may pin the coverage revision as well as the generation", async () => {
    const service = R.createFieldService(configured());
    const executionContext = { operationId: "operation", generationId: GENERATION, coverageRevision: REVISION };
    assert.equal((await service.requireFields(request({ executionContext }))).coverageRevision, REVISION);
    await assert.rejects(() => service.requireFields(request({ executionContext: { ...executionContext, coverageRevision: "oldRevision" } })), { code: C.MISSING_DEPENDENCY });
  });

  test("structurally read-only fields cannot be used for writes", async () => {
    await assert.rejects(() => R.createFieldService(configured()).requireFields(request({
      fieldIds: ["variant.id"], access: "write", operation: "bulk_edit",
    })), { code: C.READ_ONLY });
  });

  test("cross-shop adapter records cannot enter an execution contract", async () => {
    const adapter = createMetafieldAdapter({ clock: () => Date.parse("2026-10-27T10:00:00Z"),
      repository: { findVerifiedDefinitions: async () => [rawRow()] } });
    const service = R.createFieldService(configured({ adapter, resolveShop: async () => "beta.myshopify.com" }));
    await assert.rejects(() => service.requireFields(request({ fieldIds: [ID] })), { code: C.INVALID_DEFINITION });
  });

  test("field service accepts receipts from the real coverage module", async () => {
    let reads = 0;
    const coverage = createMirrorCoverageService({ repository: { getPublishedSnapshot: async input => {
      reads++;
      assert.equal(input.shopId, SHOP);
      return { shopId: SHOP, generationId: GENERATION, coverageRevision: REVISION, status: "PUBLISHED",
        datasets: input.datasets.map(name => ({ name, generationId: GENERATION, status: "COMPLETE", published: true })) };
    } } });
    const service = R.createFieldService(configured({ verifyCoverage: coverage.getVerifiedCoverage }));
    const result = await service.requireFields(request({ fieldIds: [ID, "product.title"] }));
    assert.equal(result.coverageRevision, REVISION);
    assert.equal(reads, 1);
  });

  function revisionFixture() {
    let rows = [rawRow()];
    let authorizations = 0;
    let coverageCalls = 0;
    const dependencies = configured({
      adapter: createMetafieldAdapter({
        clock: () => Date.parse("2026-10-27T10:00:00Z"),
        repository: { findVerifiedDefinitions: async () => rows },
      }),
      // Deliberately permissive: the service itself must enforce revisions.
      authorizeAccess: async () => { authorizations++; return true; },
      verifyCoverage: async input => { coverageCalls++; return { ready: true, generationId: GENERATION, coverageRevision: REVISION,
        ...(input.executionContext.approvedTargetingSnapshot ? { targetingSnapshotId: input.executionContext.approvedTargetingSnapshot.snapshotId } : {}),
      }; },
    });
    return {
      service: R.createFieldService(dependencies),
      replace(next) { rows = next; },
      get authorizations() { return authorizations; },
      get coverageCalls() { return coverageCalls; },
    };
  }
  function writeRequest(executionChanges = {}, changes = {}) {
    return request({
      fieldIds: [ID], access: "write", operation: "bulk_edit", ...changes,
      executionContext: { operationId: "operation123", generationId: GENERATION,
        approvedTargetingSnapshot: targetingSnapshot, ...executionChanges },
    });
  }

  test("dynamic apply requires the approved preview revisions even with permissive authorization", async () => {
    const fixture = revisionFixture();
    await assert.rejects(() => fixture.service.requireFields(writeRequest()), { code: C.CONTRACT_MISMATCH });
    assert.equal(fixture.authorizations, 0);
    assert.equal(fixture.coverageCalls, 0);
    const preview = await fixture.service.requireFields(writeRequest({ phase: "preview" }));
    assert.equal(preview.phase, "preview");
    const applied = await fixture.service.requireFields(writeRequest({
      expectedDefinitionRevisions: preview.definitionRevisions,
    }));
    assert.equal(applied.phase, "execute");
    assert.deepEqual(applied.definitionRevisions, preview.definitionRevisions);
  });

  test("changed preview revision rejects apply before authorization and coverage", async () => {
    const fixture = revisionFixture();
    const preview = await fixture.service.requireFields(writeRequest({ phase: "preview" }));
    fixture.replace([{ ...rawRow(), definitionToken: "Definition_token-987654" }]);
    await assert.rejects(() => fixture.service.requireFields(writeRequest({
      phase: "execute", expectedDefinitionRevisions: preview.definitionRevisions,
    })), { code: C.CONTRACT_MISMATCH });
    assert.equal(fixture.authorizations, 1);
    assert.equal(fixture.coverageCalls, 1);
  });

  test("approved revisions are matched by field identity rather than batch order", async () => {
    const secondId = "product.metafield.m98765432";
    const second = { ...rawRow(), fieldId: secondId,
      shopifyDefinitionId: "gid://shopify/MetafieldDefinition/456",
      locatorId: "locator:second_456", key: "second", definitionToken: "Definition_token-987654" };
    const fixture = revisionFixture();
    fixture.replace([second, rawRow()]);
    const preview = await fixture.service.requireFields(writeRequest({ phase: "preview" }, { fieldIds: [ID, secondId] }));
    const expected = [...preview.definitionRevisions].reverse();
    const result = await fixture.service.requireFields(writeRequest({ expectedDefinitionRevisions: expected }, { fieldIds: [ID, secondId, ID] }));
    assert.deepEqual(result.definitionRevisions, preview.definitionRevisions);
    for (const invalid of [
      expected.slice(1), [...expected, expected[0]], [expected[0], expected[0]],
      [expected[0], { fieldId: "product.metafield.m00000000", definitionToken: rawRow().definitionToken }],
    ]) {
      await assert.rejects(() => fixture.service.requireFields(writeRequest({ expectedDefinitionRevisions: invalid }, { fieldIds: [ID, secondId] })), { code: C.CONTRACT_MISMATCH });
    }
  });

  test("single-field and approved read resolutions enforce expected revisions too", async () => {
    const fixture = revisionFixture();
    const expectedDefinitionRevisions = [{ fieldId: ID, definitionToken: "Definition_token-987654" }];
    const { fieldIds, ...args } = writeRequest({ expectedDefinitionRevisions });
    await assert.rejects(() => fixture.service.requireField({ ...args, fieldId: fieldIds[0] }), { code: C.CONTRACT_MISMATCH });
    await assert.rejects(() => fixture.service.requireFields(request({
      fieldIds: [ID], executionContext: { ...args.executionContext, phase: "preview" },
    })), { code: C.CONTRACT_MISMATCH });
  });

  test("malformed approved revision metadata and invalid phases fail closed", async () => {
    const fixture = revisionFixture();
    for (const expectedDefinitionRevisions of [null, {}, [], new Array(1),
      [{ fieldId: ID, definitionToken: "short" }],
      [{ fieldId: "product.title", definitionToken: rawRow().definitionToken }]]) {
      await assert.rejects(() => fixture.service.requireFields(writeRequest({ expectedDefinitionRevisions })));
    }
    await assert.rejects(() => fixture.service.requireFields(writeRequest({ phase: "unapproved" })), { code: C.INVALID_VALUE });
    assert.equal(fixture.authorizations, 0);
    assert.equal(fixture.coverageCalls, 0);
  });

  test("deletion before apply cannot reuse approved preview resolution", async () => {
    const fixture = revisionFixture();
    const preview = await fixture.service.requireFields(writeRequest({ phase: "preview" }));
    fixture.replace([]);
    await assert.rejects(() => fixture.service.requireFields(writeRequest({
      expectedDefinitionRevisions: preview.definitionRevisions,
    })), { code: C.UNKNOWN_FIELD });
    assert.equal(fixture.authorizations, 1);
  });

  test("dynamic export execution requires approved revisions even with read access", async () => {
    const fixture = revisionFixture();
    const args = request({ fieldIds: [ID], operation: "export",
      executionContext: { operationId: "operation123", generationId: GENERATION, approvedTargetingSnapshot: targetingSnapshot },
    });
    await assert.rejects(() => fixture.service.requireFields(args), { code: C.CONTRACT_MISMATCH });
    const preview = await fixture.service.requireFields({ ...args, executionContext: { ...args.executionContext, phase: "preview" } });
    const exported = await fixture.service.requireFields({
      ...args, executionContext: { ...args.executionContext, expectedDefinitionRevisions: preview.definitionRevisions },
    });
    assert.equal(exported.phase, "execute");
  });

  test("canonical execution also requires approved targeting and a matching receipt", async () => {
    const service = R.createFieldService(configured());
    const args = request({ access: "write", operation: "bulk_edit" });
    await assert.rejects(() => service.requireFields(args), { code: C.CONTRACT_MISMATCH });
    const executionContext = { ...args.executionContext, approvedTargetingSnapshot: targetingSnapshot };
    assert.equal((await service.requireFields({ ...args, executionContext })).targetingSnapshotId, targetingSnapshot.snapshotId);
    for (const targetingSnapshotId of [undefined, "anotherTarget"]) {
      const wrongReceipt = R.createFieldService(configured({ verifyCoverage: async () => ({
        ready: true, generationId: GENERATION, coverageRevision: REVISION, targetingSnapshotId,
      }) }));
      await assert.rejects(() => wrongReceipt.requireFields({ ...args, executionContext }), { code: C.MISSING_DEPENDENCY });
    }
  });

  test("execution rejects targeting identity or revision conflicts before authorization", async () => {
    let authorizations = 0;
    const service = R.createFieldService(configured({ authorizeAccess: async () => { authorizations++; return true; } }));
    for (const changes of [{ shopId: "beta.myshopify.com" }, { generationId: "oldGeneration" }, { snapshotId: "" }]) {
      await assert.rejects(() => service.requireFields(request({ executionContext: {
        operationId: "operation123", generationId: GENERATION,
        approvedTargetingSnapshot: { ...targetingSnapshot, ...changes },
      } })), { code: C.CONTRACT_MISMATCH });
    }
    assert.equal(authorizations, 0);
  });

  test("real coverage implementation rejects incompatible targets despite published complete coverage", async () => {
    let targetChanges = {};
    const coverage = createMirrorCoverageService({ repository: { getPublishedSnapshot: async input => ({
      shopId: SHOP, generationId: GENERATION, coverageRevision: REVISION, status: "PUBLISHED",
      datasets: input.datasets.map(name => ({ name, generationId: GENERATION, status: "COMPLETE", published: true })),
      targetingSnapshot: { id: targetingSnapshot.snapshotId, shopId: SHOP, generationId: GENERATION,
        coverageRevision: REVISION, status: "APPROVED", datasets: ["products"], ...targetChanges },
    }) } });
    const service = R.createFieldService(configured({ verifyCoverage: coverage.getVerifiedCoverage }));
    const args = request({ access: "write", operation: "bulk_edit", executionContext: {
      operationId: "operation123", generationId: GENERATION, approvedTargetingSnapshot: targetingSnapshot,
    } });
    assert.equal((await service.requireFields(args)).targetingSnapshotId, targetingSnapshot.snapshotId);
    for (const changes of [{ generationId: "oldGeneration" }, { coverageRevision: "oldRevision" }, { status: "REVOKED" }, { datasets: [] }]) {
      targetChanges = changes;
      await assert.rejects(() => service.requireFields(args), { code: C.MISSING_DEPENDENCY });
    }
  });
});
