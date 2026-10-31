import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { createMetafieldAdapter, SUPPORTED_METAFIELD_TYPES } from "./metafield-adapter.js";
import { createMetafieldResolverBridge } from "./metafield-resolver-bridge.js";
import { CANONICAL_FIELDS } from "./canonical.js";
import { SOURCE_DATASETS } from "./sources.js";
import { deepFreeze, FIELD_ERROR_CODES as C } from "./types.js";
import { normalizeOperatorOperand } from "./normalize.js";

const SHOP = "alpha.myshopify.com";
const ID = "product.metafield.m01234567";
const OTHER = "variant.metafield.m98765432";
const NOW = Date.parse("2026-10-27T10:00:00Z");
function row(changes = {}) {
  return {
    shopId: SHOP, fieldId: ID, status: "ACTIVE", definitionVerified: true,
    shopifyDefinitionId: "gid://shopify/MetafieldDefinition/123",
    locatorId: "locator:material_123", namespace: "$app", key: "material",
    ownerEntity: "product", shopifyOwnerType: "PRODUCT",
    shopifyType: "single_line_text_field", label: "Material",
    nullable: true, writable: false, mutationSupported: false,
    readerAdapterId: "metafieldReader", writerAdapterId: null,
    definitionToken: "Definition_token-012345",
    verifiedAt: "2026-10-27T09:00:00Z", verificationExpiresAt: "2026-10-27T11:00:00Z",
    ...changes,
  };
}
function adapterFor(rows, clock = () => NOW) {
  return createMetafieldAdapter({ repository: { findVerifiedDefinitions: async () => rows }, clock });
}
const one = adapter => adapter.resolveOne({ shopId: SHOP, fieldId: ID });

test("stable Shopify definition identity is separate from a changed revision", async () => {
  const before = await one(adapterFor([row()]));
  const after = await one(adapterFor([row({ definitionToken: "Definition_token-987654", label: "Changed label" })]));
  assert.equal(before.source.definitionId, after.source.definitionId);
  assert.notEqual(before.source.definitionRevision, after.source.definitionRevision);
  assert.equal(after.policy.definitionToken, after.source.definitionRevision);
  assert.equal(after.verification.shopifyDefinitionId, after.source.definitionId);
});

test("identical opaque IDs in different shops cannot cross definition ownership", async () => {
  const secondShop = "beta.myshopify.com";
  const calls = [];
  const adapter = createMetafieldAdapter({
    clock: () => NOW,
    repository: { findVerifiedDefinitions: async input => {
      calls.push(input);
      // Identical field IDs and tokens do not make this record valid for B.
      return [row()];
    } },
  });
  assert.equal((await one(adapter)).shopId, SHOP);
  await assert.rejects(() => adapter.resolveOne({ shopId: secondShop, fieldId: ID }), {
    code: C.INVALID_DEFINITION,
  });
  assert.deepEqual(calls.map(call => call.shopId), [SHOP, secondShop]);
  assert.deepEqual(calls.map(call => call.fieldIds), [[ID], [ID]]);
});

test("valid identical opaque IDs resolve independently within their authenticated shops", async () => {
  const secondShop = "beta.myshopify.com";
  const adapter = createMetafieldAdapter({
    clock: () => NOW,
    repository: { findVerifiedDefinitions: async ({ shopId }) => [row({
      shopId, label: shopId === SHOP ? "Alpha material" : "Beta material",
    })] },
  });
  const alpha = await one(adapter);
  const beta = await adapter.resolveOne({ shopId: secondShop, fieldId: ID });
  assert.equal(alpha.fieldId, beta.fieldId);
  assert.equal(alpha.definition.label, "Alpha material");
  assert.equal(beta.definition.label, "Beta material");
  assert.notStrictEqual(alpha, beta);
});

test("disabled, unverified, expired and future-dated definitions fail independently", async t => {
  for (const [name, changes] of [
    ["disabled", { status: "DISABLED" }],
    ["unverified", { definitionVerified: false }],
    ["expired", { verificationExpiresAt: "2026-10-27T09:59:59Z" }],
    ["future verification", { verifiedAt: "2026-10-27T10:00:01Z" }],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(() => one(adapterFor([row(changes)])), { code: C.INVALID_DEFINITION });
    });
  }
});

test("unsupported metadata properties and malformed locator boundaries are rejected", async t => {
  for (const [name, changes] of [
    ["SQL metadata", { sql: "untrusted expression" }],
    ["column metadata", { column: "merchant_column" }],
    ["field path metadata", { fieldPath: "nested.value" }],
    ["empty locator", { locatorId: "" }],
    ["numeric locator prefix", { locatorId: "1locator" }],
    ["locator whitespace", { locatorId: "locator material" }],
    ["oversized locator", { locatorId: "a".repeat(256) }],
    ["locator control character", { locatorId: "locator\n" }],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(() => one(adapterFor([row(changes)])), { code: C.INVALID_DEFINITION });
    });
  }
});

test("partial batch resolution rejects the whole batch even if its first row is valid", async () => {
  await assert.rejects(() => adapterFor([row()]).resolveBatch({
    shopId: SHOP, fieldIds: [ID, OTHER],
  }), { code: C.UNKNOWN_FIELD });
});

test("repository must return dense plain arrays rather than positional wrappers or maps", async () => {
  for (const rows of [
    new Map([[ID, row()]]), { rows: [row()] }, "rows",
    Object.assign([row()], { extra: true }),
  ]) {
    await assert.rejects(() => one(adapterFor(rows)), { code: C.INVALID_SOURCE });
  }
  const sparse = new Array(2); sparse[1] = row();
  await assert.rejects(() => adapterFor(sparse).resolveBatch({
    shopId: SHOP, fieldIds: [ID, OTHER],
  }), { code: C.INVALID_SOURCE });
});

test("metafield adapter requires a repository and valid clock", async () => {
  assert.throws(() => createMetafieldAdapter(), TypeError);
  assert.throws(() => createMetafieldAdapter({ repository: {}, clock: () => NOW }), TypeError);
  assert.throws(() => createMetafieldAdapter({ repository: { findVerifiedDefinitions() {} }, clock: 1 }), TypeError);
  for (const value of [NaN, -1, 1.5, "1"]) {
    await assert.rejects(() => one(adapterFor([row()], () => value)), TypeError);
  }
});

test("repository lookup is shop-scoped and result metadata is immutable", async () => {
  let received;
  const adapter = createMetafieldAdapter({
    repository: { findVerifiedDefinitions: async input => { received = input; return [row()]; } },
    clock: () => NOW,
  });
  const result = await one(adapter);
  assert.deepEqual(received, { shopId: SHOP, fieldIds: [ID] });
  assert.ok(Object.isFrozen(received.fieldIds));
  assert.equal(result.definition.type, "string");
  assert.deepEqual(result.source.datasets, ["metafields"]);
  assert.equal(result.source.definitionRevision, "Definition_token-012345");
  assert.equal(result.source.definitionId, row().shopifyDefinitionId);
  assert.equal(result.source.locatorId, "locator:material_123");
  assert.equal(result.source.mutationAdapterId, null);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.definition));
  assert.ok(Object.isFrozen(result.source.datasets));
  assert.equal(Object.hasOwn(result.source, "namespace"), false);
  assert.equal(Object.hasOwn(result.source, "sql"), false);
});

test("batch results remain keyed when repository rows are reordered", async () => {
  const variant = row({
    fieldId: OTHER, ownerEntity: "variant", shopifyOwnerType: "PRODUCTVARIANT",
    locatorId: "locator:variant_123", shopifyDefinitionId: "gid://shopify/MetafieldDefinition/456",
  });
  const result = await adapterFor([variant, row()]).resolveBatch({ shopId: SHOP, fieldIds: [ID, OTHER] });
  assert.ok(result instanceof Map);
  assert.equal(result.get(ID).definition.entity, "product");
  assert.equal(result.get(OTHER).definition.entity, "variant");
});

test("distinct field IDs cannot alias definition IDs, locators or owner keys in a batch", async () => {
  const secondId = "product.metafield.m98765432";
  for (const collision of [
    { shopifyDefinitionId: "gid://shopify/MetafieldDefinition/123" },
    { locatorId: "locator:material_123" },
    { key: "material" },
  ]) {
    const second = row({
      fieldId: secondId, shopifyDefinitionId: "gid://shopify/MetafieldDefinition/456",
      locatorId: "locator:second_123", key: "second", ...collision,
    });
    await assert.rejects(() => adapterFor([row(), second]).resolveBatch({
      shopId: SHOP, fieldIds: [ID, secondId],
    }), { code: C.INVALID_SOURCE });
  }
});

test("invalid request batches are rejected before repository access", async () => {
  let calls = 0;
  const adapter = createMetafieldAdapter({ repository: { findVerifiedDefinitions: async () => { calls++; return []; } } });
  for (const fieldIds of [[], [ID, ID], new Array(1), Array(1001).fill(ID), "invalid", [{ id: ID }]]) {
    await assert.rejects(() => adapter.resolveBatch({ shopId: SHOP, fieldIds }));
  }
  for (const shopId of ["", " bad ", "a\n", "a".repeat(256), null]) {
    await assert.rejects(() => adapter.resolveBatch({ shopId, fieldIds: [ID] }), { code: C.INVALID_VALUE });
  }
  assert.equal(calls, 0);
});

test("unexpected, duplicate, missing and malformed repository rows fail closed", async () => {
  for (const rows of [null, {}, new Array(1), [row(), row()]]) {
    await assert.rejects(() => one(adapterFor(rows)), { code: C.INVALID_SOURCE });
  }
  await assert.rejects(() => one(adapterFor([])), { code: C.UNKNOWN_FIELD });
  await assert.rejects(() => one(adapterFor([row({ fieldId: OTHER })])), { code: C.INVALID_SOURCE });
  await assert.rejects(() => adapterFor([row(), row()]).resolveBatch({ shopId: SHOP, fieldIds: [ID, OTHER] }), { code: C.INVALID_SOURCE });
});

test("cross-shop, inactive, unverified and owner-mismatched metadata is rejected", async () => {
  for (const changes of [
    { shopId: "beta.myshopify.com" }, { status: "DELETED" }, { definitionVerified: false },
    { ownerEntity: "variant" }, { shopifyOwnerType: "PRODUCTVARIANT" },
  ]) {
    await assert.rejects(() => one(adapterFor([row(changes)])), { code: C.INVALID_DEFINITION });
  }
});

test("verification timestamps reject expiry, future verification and invalid intervals", async () => {
  for (const changes of [
    { verificationExpiresAt: "2026-10-27T10:00:00Z" },
    { verifiedAt: "2026-10-27T10:00:01Z" },
    { verificationExpiresAt: "2026-10-27T08:00:00Z" },
    { verifiedAt: "invalid" }, { verificationExpiresAt: null },
  ]) {
    await assert.rejects(() => one(adapterFor([row(changes)])), { code: C.INVALID_DEFINITION });
  }
});

test("clock is sampled after a slow repository lookup", async () => {
  let time = NOW;
  const adapter = createMetafieldAdapter({
    repository: { findVerifiedDefinitions: async () => {
      time = Date.parse("2026-10-27T12:00:00Z");
      return [row()];
    } },
    clock: () => time,
  });
  await assert.rejects(() => one(adapter), { code: C.INVALID_DEFINITION });
});

test("writer capability rejects contradictory and unapproved bindings", async () => {
  for (const changes of [
    { writable: true },
    { writable: true, mutationSupported: true },
    { writable: true, mutationSupported: false, writerAdapterId: "metafieldWriter" },
    { writable: false, mutationSupported: true, writerAdapterId: "metafieldWriter" },
    { writerAdapterId: "rogueWriter" }, { readerAdapterId: "rogueReader" },
  ]) {
    await assert.rejects(() => one(adapterFor([row(changes)])), { code: C.INVALID_SOURCE });
  }
  const result = await one(adapterFor([row({ writable: true, mutationSupported: true, writerAdapterId: "metafieldWriter" })]));
  assert.equal(result.definition.editable, true);
  assert.equal(result.source.mutationAdapterId, "metafieldWriter");
  const readOnly = await one(adapterFor([row({ mutationSupported: true })]));
  assert.equal(readOnly.definition.editable, false);
});

test("supported Shopify types map to canonical types with decimal bounds", async () => {
  for (const [shopifyType, type] of Object.entries(SUPPORTED_METAFIELD_TYPES)) {
    const decimal = type === "decimal" ? { precision: 20, scale: 4 } : {};
    assert.equal((await one(adapterFor([row({ shopifyType, ...decimal })]))).definition.type, type);
  }
  for (const changes of [
    { shopifyType: "number_decimal" },
    { shopifyType: "number_decimal", precision: 39, scale: 4 },
    { shopifyType: "number_decimal", precision: 10, scale: 11 },
    { precision: 20 }, { scale: 4 },
  ]) {
    await assert.rejects(() => one(adapterFor([row(changes)])), { code: C.INVALID_DEFINITION });
  }
  for (const shopifyType of ["toString", "__proto__", "unsupported", {}]) {
    await assert.rejects(() => one(adapterFor([row({ shopifyType })])), { code: C.INVALID_TYPE });
  }
});

test("stored identities, labels and capabilities are validated", async () => {
  for (const changes of [
    { shopifyDefinitionId: "gid://shopify/Product/123" }, { definitionToken: "short" },
    { locatorId: "table.column" }, { namespace: "bad space" }, { key: "bad.key" },
    { label: " bad " }, { label: "a".repeat(121) }, { nullable: "true" }, { writable: 1 },
  ]) {
    await assert.rejects(() => one(adapterFor([row(changes)])), { code: C.INVALID_DEFINITION });
  }
});

test("rows and arrays reject getters without executing them", async () => {
  const raw = row();
  Object.defineProperty(raw, "fieldId", { get() { assert.fail("Row getter executed"); } });
  await assert.rejects(() => one(adapterFor([raw])), { code: C.INVALID_DEFINITION });
  const rows = [row()];
  Object.defineProperty(rows, "0", { get() { assert.fail("Array getter executed"); } });
  await assert.rejects(() => one(adapterFor(rows)), { code: C.INVALID_SOURCE });
  const ids = [ID];
  Object.defineProperty(ids, "0", { get() { assert.fail("ID getter executed"); } });
  await assert.rejects(() => adapterFor([]).resolveBatch({ shopId: SHOP, fieldIds: ids }), { code: C.INVALID_VALUE });
  await assert.rejects(() => one(adapterFor([row({ verifiedAt: { toString() { assert.fail("Coercion executed"); } } })])), { code: C.INVALID_DEFINITION });
});

test("bridge preserves keyed results and validates missing, extra and positional responses", async () => {
  assert.throws(() => createMetafieldResolverBridge({}), TypeError);
  for (const records of [[], new Map(), new Map([[OTHER, row()]]), new Map([[ID, row()], [OTHER, row()]])]) {
    const bridge = createMetafieldResolverBridge({ resolveOne() {}, resolveBatch: async () => records });
    await assert.rejects(() => bridge.dynamicBatchResolver({ shopId: SHOP, fieldIds: [ID] }), TypeError);
  }
  const bridge = createMetafieldResolverBridge(adapterFor([row()]));
  const result = await bridge.dynamicBatchResolver({ shopId: SHOP, fieldIds: [ID] });
  assert.ok(result instanceof Map);
  assert.equal(result.get(ID).fieldId, ID);
  assert.equal((await bridge.dynamicResolver({ shopId: SHOP, fieldId: ID })).fieldId, ID);
});

test("adapter supplies verified type policies and revision metadata", async () => {
  const resolved = await one(adapterFor([row({
    shopifyType: "number_decimal", precision: 12, scale: 3,
    constraints: { read: {}, filter: { allowNegative: true }, write: { allowNegative: false } },
    writable: true, mutationSupported: true, writerAdapterId: "metafieldWriter",
  })]));
  assert.equal(resolved.policy.field.precision, 12);
  assert.equal(resolved.policy.field.scale, 3);
  assert.equal(resolved.policy.filter.allowNegative, true);
  assert.equal(resolved.policy.write.allowNegative, false);
  assert.equal(resolved.policy.definitionToken, resolved.source.definitionRevision);
  assert.equal(resolved.verification.definitionToken, resolved.policy.definitionToken);
  assert.equal(resolved.verification.shopifyDefinitionId, row().shopifyDefinitionId);
  assert.equal(resolved.verification.verificationExpiresAt, row().verificationExpiresAt);
  assert.ok(Object.isFrozen(resolved.policy));
  assert.ok(Object.isFrozen(resolved.verification));
});

test("adapter rejects malformed verified constraint metadata", async () => {
  for (const constraints of [
    { read: { maxLength: -1 } }, { read: { enumValues: ["A"] } },
    { filter: { allowNegative: false } }, { write: { operations: ["execute"] } },
    { browserContext: {} },
  ]) {
    await assert.rejects(() => one(adapterFor([row({ constraints })])), { code: C.INVALID_DEFINITION });
  }
});

test("bridge preserves complete identity and rejects cross-shop or changed adapter bindings", async () => {
  const raw = await one(adapterFor([row()]));
  const bridge = createMetafieldResolverBridge({
    resolveOne: async () => raw, resolveBatch: async () => new Map([[ID, raw]]),
  });
  assert.strictEqual(await bridge.dynamicResolver({ shopId: SHOP, fieldId: ID }), raw);
  assert.strictEqual((await bridge.dynamicBatchResolver({ shopId: SHOP, fieldIds: [ID] })).get(ID), raw);
  await assert.rejects(() => bridge.dynamicResolver({ shopId: "beta.myshopify.com", fieldId: ID }), { code: C.PERMISSION_DENIED });
  for (const changed of [
    { ...raw, source: { ...raw.source, adapterId: "rogueReader" } },
    { ...raw, source: { ...raw.source, mutationAdapterId: "metafieldWriter" } },
    { ...raw, verification: { ...raw.verification, definitionToken: "Changed_token-123456" } },
  ]) {
    const forged = createMetafieldResolverBridge({ resolveOne: async () => changed, resolveBatch: async () => new Map([[ID, changed]]) });
    await assert.rejects(() => forged.dynamicResolver({ shopId: SHOP, fieldId: ID }), { code: C.INVALID_SOURCE });
  }
});

describe("metafield adapter and v3 resolver integration", {
  skip: typeof mock.module !== "function" && "Requires --experimental-test-module-mocks",
}, async () => {
  if (typeof mock.module !== "function") return;
  const sources = deepFreeze(Object.fromEntries(Object.values(CANONICAL_FIELDS).map(field => [field.id, {
    fieldId: field.id, entity: field.entity, canonicalType: field.type,
    canonicalDerived: field.derived, datasets: ["products"],
  }])));
  const dependency = mock.module("./sources.js", { namedExports: { FIELD_SOURCES: sources, SOURCE_DATASETS } });
  let R;
  try { R = await import("./resolve.js?metafield-integration"); } finally { dependency.restore(); }
  const adapters = { read: new Set(["metafieldReader"]), write: new Set(["metafieldWriter"]) };

  test("adapter output resolves singly and in keyed batches", async () => {
    const bridge = createMetafieldResolverBridge(adapterFor([row()]));
    const options = { shopId: SHOP, adapters, ...bridge };
    assert.equal((await R.resolveFieldDefinition(ID, options)).source.locatorId, "locator:material_123");
    const result = await R.resolveFieldDefinitions([ID, "product.title", ID], options);
    assert.deepEqual(result.map(field => field.id), [ID, "product.title"]);
  });

  test("resolved policies remain revision-bound metadata and never authorize access", async () => {
    const bridge = createMetafieldResolverBridge(adapterFor([row({
      constraints: { filter: { maxLength: 25 } },
    })]));
    const opts = { shopId: SHOP, adapters, ...bridge };
    const resolved = await R.resolveFieldDefinition(ID, opts);
    const policy = R.getResolvedFieldPolicy(resolved, "filter", { shopId: SHOP });
    assert.equal(policy.constraints.maxLength, 25);
    assert.throws(() => normalizeOperatorOperand(resolved.field, "eq", "a".repeat(26), {
      constraints: policy.constraints,
    }), { code: C.INVALID_VALUE });
    assert.equal(policy.definitionToken, resolved.source.definitionRevision);
    assert.ok(Object.isFrozen(policy));
    assert.equal(resolved.verification.definitionToken, policy.definitionToken);
    assert.throws(() => R.getResolvedFieldPolicy({ ...resolved }, "read", { shopId: SHOP }), { code: C.PERMISSION_DENIED });
    assert.throws(() => R.getResolvedFieldPolicy(resolved, "read", { shopId: "beta.myshopify.com" }), { code: C.PERMISSION_DENIED });
    await assert.rejects(() => R.requireFieldForAccess(ID, "read", {
      ...opts, operation: "filter", actor: { id: "staff" }, executionContext: { operationId: "operation" },
      verifyCoverage: async () => true, authorizeAccess: async () => false,
    }), { code: C.PERMISSION_DENIED });
    const fixed = await R.resolveFieldDefinition("product.title");
    assert.equal(R.getResolvedFieldPolicy(fixed, "write").constraints.allowEmpty, false);
  });

  test("resolution rejects stale or altered dynamic policy envelopes", async () => {
    const raw = await one(adapterFor([row()]));
    for (const changes of [
      { definitionToken: "Changed_token-123456" }, { shopId: "beta.myshopify.com" },
      { field: { ...raw.definition, type: "boolean" } }, { read: { maxItems: 10 } },
    ]) {
      await assert.rejects(() => R.resolveFieldDefinition(ID, {
        shopId: SHOP, adapters, dynamicResolver: async () => ({ ...raw, policy: { ...raw.policy, ...changes } }),
      }), { code: C.INVALID_DEFINITION });
    }
  });

  test("reordered repository rows resolve in requested order and partial results are rejected", async () => {
    const variant = row({
      fieldId: OTHER, ownerEntity: "variant", shopifyOwnerType: "PRODUCTVARIANT",
      locatorId: "locator:variant_123", shopifyDefinitionId: "gid://shopify/MetafieldDefinition/456",
    });
    let rows = [variant, row()];
    const adapter = createMetafieldAdapter({
      repository: { findVerifiedDefinitions: async () => rows }, clock: () => NOW,
    });
    const opts = { shopId: SHOP, adapters, ...createMetafieldResolverBridge(adapter) };
    const result = await R.resolveFieldDefinitions([ID, OTHER], opts);
    assert.deepEqual(result.map(field => field.id), [ID, OTHER]);
    assert.equal(result[0].field.entity, "product");
    assert.equal(result[1].field.entity, "variant");
    rows = [variant];
    await assert.rejects(() => R.resolveFieldDefinitions([ID, OTHER], opts), { code: C.UNKNOWN_FIELD });
  });

  // No execution worker exists yet. These tests exercise fresh adapter reads
  // and the real resolver's server-owned authorization callback. The fixture
  // callback represents approval-contract comparison; it is not a write worker.
  function previewApplyFixture() {
    let rows = [row({ writable: true, mutationSupported: true, writerAdapterId: "metafieldWriter" })];
    let reads = 0;
    const adapter = createMetafieldAdapter({
      repository: { findVerifiedDefinitions: async () => { reads++; return rows; } },
      clock: () => NOW,
    });
    const base = { shopId: SHOP, adapters, ...createMetafieldResolverBridge(adapter) };
    return {
      base,
      replace(changes) { rows = [row({
        writable: true, mutationSupported: true, writerAdapterId: "metafieldWriter", ...changes,
      })]; },
      remove() { rows = []; },
      get reads() { return reads; },
      apply(approved) {
        return R.requireFieldForAccess(ID, "write", {
          ...base, operation: "bulk_edit", actor: { id: "staff" },
          executionContext: { operationId: "approved-operation", approved },
          verifyCoverage: async () => true,
          authorizeAccess: async ({ field, source, executionContext }) => {
            const contract = executionContext.approved;
            return field.id === contract.id && field.type === contract.type &&
              source.definitionRevision === contract.definitionToken && source.locatorId === contract.locatorId;
          },
        });
      },
    };
  }
  function approvedDefinition(preview) {
    return Object.freeze({
      id: preview.id, type: preview.type,
      definitionToken: preview.source.definitionRevision, locatorId: preview.source.locatorId,
    });
  }

  test("unchanged preview definition passes execution authorization after a fresh read", async () => {
    const fixture = previewApplyFixture();
    const preview = await R.resolveFieldDefinition(ID, fixture.base);
    const applied = await fixture.apply(approvedDefinition(preview));
    assert.equal(applied.source.definitionRevision, preview.source.definitionRevision);
    assert.notStrictEqual(applied, preview);
    assert.equal(fixture.reads, 2);
  });

  test("definition revision change between preview and apply denies the approved contract", async () => {
    const fixture = previewApplyFixture();
    const preview = await R.resolveFieldDefinition(ID, fixture.base);
    const approved = approvedDefinition(preview);
    fixture.replace({ definitionToken: "Definition_token-987654" });
    await assert.rejects(() => fixture.apply(approved), { code: C.PERMISSION_DENIED });
    assert.equal(preview.source.definitionRevision, approved.definitionToken);
    assert.equal(fixture.reads, 2);
  });

  test("definition deletion before execution cannot reuse preview metadata", async () => {
    for (const deletedStatus of [null, "DELETED"]) {
      const fixture = previewApplyFixture();
      const preview = await R.resolveFieldDefinition(ID, fixture.base);
      if (deletedStatus === null) fixture.remove();
      else fixture.replace({ status: deletedStatus });
      await assert.rejects(() => fixture.apply(approvedDefinition(preview)), {
        code: deletedStatus === null ? C.UNKNOWN_FIELD : C.INVALID_DEFINITION,
      });
      assert.equal(fixture.reads, 2);
    }
  });

  test("supported type changes before execution invalidate approval even without token rotation", async () => {
    for (const rotateToken of [false, true]) {
      const fixture = previewApplyFixture();
      const preview = await R.resolveFieldDefinition(ID, fixture.base);
      fixture.replace({ shopifyType: "boolean", ...(rotateToken ? { definitionToken: "Definition_token-987654" } : {}) });
      await assert.rejects(() => fixture.apply(approvedDefinition(preview)), { code: C.PERMISSION_DENIED });
      assert.equal(fixture.reads, 2);
    }
  });

  test("unsupported type changes before execution fail during fresh metadata validation", async () => {
    const fixture = previewApplyFixture();
    const preview = await R.resolveFieldDefinition(ID, fixture.base);
    fixture.replace({ shopifyType: "unsupported" });
    await assert.rejects(() => fixture.apply(approvedDefinition(preview)), { code: C.INVALID_TYPE });
    assert.equal(fixture.reads, 2);
  });

  test("metafield coverage and authorization still gate reads", async () => {
    const opts = {
      shopId: SHOP, adapters, ...createMetafieldResolverBridge(adapterFor([row()])),
      operation: "filter", actor: { id: "actor" }, executionContext: { operationId: "operation" },
      authorizeAccess: async () => true,
      verifyCoverage: async input => { assert.deepEqual(input.datasets, ["metafields"]); return false; },
    };
    await assert.rejects(() => R.requireFieldForAccess(ID, "read", opts), { code: C.MISSING_DEPENDENCY });
    await assert.rejects(() => R.requireFieldForAccess(ID, "read", { ...opts, verifyCoverage: async () => true, authorizeAccess: async () => false }), { code: C.PERMISSION_DENIED });
  });

  test("resolver rejects arbitrary adapters and other datasets even if registered", async () => {
    const raw = await one(adapterFor([row()]));
    const opts = { shopId: SHOP, adapters: { read: new Set(["metafieldReader", "rogueReader"]), write: adapters.write } };
    for (const change of [{ adapterId: "rogueReader" }, { datasets: ["products"] }]) {
      await assert.rejects(() => R.resolveFieldDefinition(ID, {
        ...opts, dynamicResolver: async () => ({ ...raw, source: { ...raw.source, ...change } }),
      }), { code: C.INVALID_SOURCE });
    }
  });
});

test("FIELD-001: JSON metafields fail closed if writer capability is declared", async () => {
  for (const changes of [
    { shopifyType: "json", writable: true, mutationSupported: true, writerAdapterId: "metafieldWriter" },
    { shopifyType: "json", writable: true },
    { shopifyType: "json", mutationSupported: true },
    { shopifyType: "json", writerAdapterId: "metafieldWriter" },
  ]) {
    await assert.rejects(() => one(adapterFor([row(changes)])), { code: C.INVALID_SOURCE });
  }

  // Read-only JSON metafield succeeds
  const jsonRecord = await one(adapterFor([row({ shopifyType: "json", writable: false, mutationSupported: false, writerAdapterId: null })]));
  assert.equal(jsonRecord.definition.type, "json");
  assert.equal(jsonRecord.definition.editable, false);
  assert.equal(jsonRecord.source.mutationAdapterId, null);
  assert.equal(jsonRecord.policy.writePolicy, null);
});
