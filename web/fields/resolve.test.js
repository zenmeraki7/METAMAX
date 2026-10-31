import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_FIELDS } from "./canonical.js";
import { deepFreeze, FIELD_ERROR_CODES as C } from "./types.js";
import * as productionSources from "./sources.js";
import { createDynamicFieldPolicy } from "./constraints.js";

// Fixtures below describe a test-only dataset,
// not actual mirror tables or Shopify mappings. Run with
// node --experimental-test-module-mocks --test web/fields/resolve.test.js
describe("field resolution contract", {
  skip: typeof mock.module !== "function" && "Requires --experimental-test-module-mocks",
}, async () => {
  if (typeof mock.module !== "function") return;
  const FIELD_SOURCES = deepFreeze(Object.fromEntries(
    Object.values(CANONICAL_FIELDS).map(field => [field.id, {
      fieldId: field.id,
      entity: field.entity,
      canonicalType: field.type,
      canonicalDerived: field.derived,
      datasets: ["testCatalog"],
    }])
  ));
  const dependency = mock.module("./sources.js", { namedExports: {
    FIELD_SOURCES,
    SOURCE_DATASETS: Object.freeze({ TEST_CATALOG: "testCatalog", METAFIELDS: "metafields" }),
  } });
  const R = await import("./resolve.js?fixture");
  // The resolver has captured its dependency. Restore imports for other tests.
  dependency.restore();

  const shopId = "one.myshopify.com";
  const id = "product.metafield.m01ab239d";
  const secondId = "variant.metafield.m02ab239d";
  const adapters = { read: new Set(["metafieldReader"]), write: new Set(["metafieldWriter"]) };
  function record(fieldId = id, changes = {}) {
    const entity = fieldId.split(".")[0];
    const result = {
      fieldId, shopId,
      definition: {
        id: fieldId, label: "Test field", entity, type: "string",
        nullable: true, editable: false, derived: false,
      },
      source: {
        fieldId, entity, sourceKind: "metafield", adapterId: "metafieldReader",
        definitionId: "gid://shopify/MetafieldDefinition/123", definitionRevision: "testDefinition0001", locatorId: "testLocator",
        datasets: ["metafields"], accessAnyOf: ["read_products"],
      },
      ...changes,
    };
    result.policy = createDynamicFieldPolicy({
      shopId, field: result.definition, definitionToken: result.source.definitionRevision,
    });
    return result;
  }
  function options(changes = {}) {
    return {
      shopId, adapters, dynamicResolver: async () => record(),
      operation: R.FIELD_OPERATIONS.FILTER,
      actor: { id: "testActor" }, executionContext: { operationId: "testOperation" },
      authorizeAccess: async () => true, verifyCoverage: async () => true,
      ...changes,
    };
  }
  const rejects = (fn, code) => assert.rejects(fn, { code });

  test("canonical resolution preserves trusted identity and bypasses dynamic resolvers", async () => {
    const resolved = await R.resolveFieldDefinition("variant.price", {
      dynamicResolver() { throw Error("Must not run"); },
      definition: { type: "string" },
    });
    assert.strictEqual(resolved.field, CANONICAL_FIELDS["variant.price"]);
    assert.strictEqual(resolved.source, FIELD_SOURCES["variant.price"]);
    assert.strictEqual(R.requireResolvedCanonicalField("variant.price"), resolved);
    assert.ok(Object.isFrozen(resolved));
    assert.equal(R.assertFieldResolutionRegistry(), true);
  });

  test("unknown IDs and browser descriptors are rejected", async () => {
    for (const value of ["product.fakeField", { id: "product.title", type: "boolean" }]) {
      await rejects(() => R.resolveFieldDefinition(value), C.UNKNOWN_FIELD);
    }
  });

  test("dynamic resolver receives only scoped identity and returns immutable metadata", async () => {
    let received;
    const resolved = await R.resolveFieldDefinition(id, options({
      dynamicResolver: async input => { received = input; return record(); },
    }));
    assert.deepEqual(received, { shopId, fieldId: id });
    assert.equal(resolved.origin, "dynamic");
    assert.equal(resolved.structurallyWritable, false);
    assert.ok(Object.isFrozen(resolved.field));
    assert.ok(Object.isFrozen(resolved.source.datasets));
  });

  test("dynamic resolution requires shop, adapters and resolver", async () => {
    await rejects(() => R.resolveFieldDefinition(id), C.INVALID_VALUE);
    await rejects(() => R.resolveFieldDefinition(id, { shopId }), C.MISSING_DEPENDENCY);
    await rejects(() => R.resolveFieldDefinition(id, { shopId, adapters }), C.MISSING_DEPENDENCY);
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => null })), C.UNKNOWN_FIELD);
  });

  test("dynamic records cannot cross shops or identities", async () => {
    for (const changes of [{ shopId: "two.myshopify.com" }, { fieldId: secondId }]) {
      await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => record(id, changes) })), C.PERMISSION_DENIED);
    }
  });

  test("dynamic definition identity, capabilities and precision are validated", async () => {
    for (const changes of [
      { id: secondId }, { entity: "variant" }, { label: " bad " },
      { editable: "true" }, { editable: true, derived: true },
      { type: "money", precision: 20, scale: 21 },
      { precision: 20 }, { browserOverride: true },
    ]) {
      const raw = record(); Object.assign(raw.definition, changes);
      await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw })), C.INVALID_DEFINITION);
    }
    const raw = record(); raw.definition.type = "invented";
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw })), C.INVALID_TYPE);
  });

  test("descriptor accessors are rejected without execution", async () => {
    const raw = record();
    Object.defineProperty(raw.definition, "label", { get() { assert.fail("Getter executed"); } });
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw })), C.INVALID_DEFINITION);
  });

  test("dynamic sources require explicit registered adapters and opaque locators", async () => {
    for (const changes of [
      { adapterId: "unregistered" }, { definitionId: "namespace.key" },
      { locatorId: "table.column" }, { sourceKind: "sql" }, { entity: "variant" },
      { mutationAdapterId: "unregistered" },
    ]) {
      const raw = record(); Object.assign(raw.source, changes);
      await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw })), C.INVALID_SOURCE);
    }
  });

  test("source datasets and scopes must be bounded, known and unique", async () => {
    for (const changes of [
      { datasets: [] }, { datasets: ["fabricated"] },
      { datasets: ["testCatalog", "testCatalog"] }, { accessAnyOf: [] },
      { accessAnyOf: ["INVALID"] }, { accessAllOf: ["read_products", "read_products"] },
      { accessAnyOf: Array(33).fill("read_products") },
    ]) {
      const raw = record(); Object.assign(raw.source, changes);
      await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw })), C.INVALID_DEFINITION);
    }
  });

  test("source arrays and request batches reject getters without invoking them", async () => {
    const values = ["testCatalog"];
    Object.defineProperty(values, "0", { get() { assert.fail("Array getter executed"); } });
    const raw = record(); raw.source.datasets = values;
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw })), C.INVALID_DEFINITION);
    await rejects(() => R.resolveFieldDefinitions(values, options()), C.INVALID_VALUE);
    const extra = ["testCatalog"]; extra.sql = "untrusted";
    raw.source.datasets = extra;
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw })), C.INVALID_DEFINITION);
  });

  test("editable dynamics require the approved registered mutation adapter", async () => {
    const raw = record(); raw.definition.editable = true;
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw })), C.INVALID_SOURCE);
    raw.source.mutationAdapterId = "metafieldWriter";
    raw.policy = createDynamicFieldPolicy({ shopId, field: raw.definition, definitionToken: raw.source.definitionRevision });
    const resolved = await R.resolveFieldDefinition(id, options({ dynamicResolver: async () => raw }));
    assert.equal(resolved.structurallyWritable, true);
    assert.strictEqual(R.assertResolvedFieldAccess(resolved, "write", { shopId }), resolved);
  });

  test("provenance rejects copies and cross-shop reuse", async () => {
    const resolved = await R.resolveFieldDefinition(id, options());
    for (const forged of [{ ...resolved }, JSON.parse(JSON.stringify(resolved)), null]) {
      assert.throws(() => R.assertResolvedFieldAccess(forged, "read", { shopId }), { code: C.PERMISSION_DENIED });
    }
    assert.throws(() => R.assertResolvedFieldAccess(resolved, "read", { shopId: "two.myshopify.com" }), { code: C.PERMISSION_DENIED });
    assert.throws(() => R.assertResolvedFieldAccess(resolved, "write", { shopId }), { code: C.READ_ONLY });
  });

  test("batches deduplicate and preserve requested order despite reordered results", async () => {
    let received;
    const result = await R.resolveFieldDefinitions([id, "product.title", secondId, id], options({
      dynamicBatchResolver: async input => {
        received = input;
        return new Map([[secondId, record(secondId)], [id, record()]]);
      },
    }));
    assert.deepEqual(received.fieldIds, [id, secondId]);
    assert.ok(Object.isFrozen(received.fieldIds));
    assert.deepEqual(result.map(field => field.id), [id, "product.title", secondId]);
    assert.ok(Object.isFrozen(result));
  });

  test("batches reject positional, incomplete, extra and mismatched records", async () => {
    for (const records of [
      [record()], new Map(), new Map([[id, null]]),
      new Map([[secondId, record(secondId)]]),
      new Map([[id, record()], [secondId, record(secondId)]]),
    ]) {
      await assert.rejects(() => R.resolveFieldDefinitions([id], options({ dynamicBatchResolver: async () => records })));
    }
  });

  test("batches are bounded and multiple dynamic IDs require a batch resolver", async () => {
    await rejects(() => R.resolveFieldDefinitions(Array(1001).fill("product.title")), C.INVALID_VALUE);
    await rejects(() => R.resolveFieldDefinitions(new Array(1)), C.INVALID_VALUE);
    await rejects(() => R.resolveFieldDefinitions([id, secondId], options()), C.MISSING_DEPENDENCY);
    assert.deepEqual(await R.resolveFieldDefinitions([]), []);
  });

  test("authorization dependencies are checked before dynamic metadata reads", async () => {
    let called = false;
    const invalidOptions = options({
      authorizeAccess: null,
      dynamicResolver: async () => { called = true; return record(); },
    });
    await rejects(() => R.requireFieldForAccess(id, "read", invalidOptions), C.MISSING_DEPENDENCY);
    assert.equal(called, false);
  });

  test("capability metadata never bypasses explicit authorization or coverage", async () => {
    for (const verdict of [false, undefined, null, 1, "true", {}]) {
      await rejects(() => R.requireFieldForAccess("variant.price", "read", options({ verifyCoverage: async () => verdict })), C.MISSING_DEPENDENCY);
      await rejects(() => R.requireFieldForAccess("variant.price", "read", options({ authorizeAccess: async () => verdict })), C.PERMISSION_DENIED);
    }
  });

  test("coverage receives the dataset union and approved execution context", async () => {
    const events = [];
    const opts = options({
      verifyCoverage: async input => {
        events.push("coverage");
        assert.equal(input.shopId, shopId);
        assert.deepEqual(input.datasets, ["metafields", "testCatalog"]);
        assert.strictEqual(input.executionContext, opts.executionContext);
        assert.ok(Object.isFrozen(input.fields));
        return true;
      },
      authorizeAccess: async input => {
        events.push(input.field.id);
        assert.strictEqual(input.actor, opts.actor);
        return true;
      },
    });
    await R.requireFieldsForAccess(["product.title", id], "read", opts);
    assert.deepEqual(events, ["coverage", "product.title", id]);
  });

  test("write access checks structure separately from operation authorization", async () => {
    await rejects(() => R.requireFieldForAccess("variant.id", "write", options({ operation: "bulk_edit" })), C.READ_ONLY);
    await rejects(() => R.requireFieldForAccess("variant.price", "write", options({ operation: "bulk_edit", authorizeAccess: async () => false })), C.PERMISSION_DENIED);
    const result = await R.requireFieldForAccess("variant.price", "write", options({ operation: "bulk_edit" }));
    assert.equal(result.id, "variant.price");
  });

  test("invalid actor, execution, shop, operation and access fail closed", async () => {
    for (const changes of [{ actor: null }, { executionContext: {} }, { shopId: " bad " }, { operation: "invented" }]) {
      await assert.rejects(() => R.requireFieldForAccess("product.title", "read", options(changes)));
    }
    await rejects(() => R.requireFieldForAccess("product.title", "invented", options()), C.UNSUPPORTED_OPERATION);
  });

  test("FIELD-001: JSON metafield cannot be advertised or authorized as writable", async () => {
    // Dynamic definition with type json and editable true is rejected
    const rawEditableJson = record();
    rawEditableJson.definition.type = "json";
    rawEditableJson.definition.editable = true;
    rawEditableJson.source.mutationAdapterId = "metafieldWriter";
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => rawEditableJson })), C.INVALID_DEFINITION);

    // Dynamic source with type json and mutation adapter is rejected
    const rawJsonWithWriter = record();
    rawJsonWithWriter.definition.type = "json";
    rawJsonWithWriter.definition.editable = false;
    rawJsonWithWriter.source.mutationAdapterId = "metafieldWriter";
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => rawJsonWithWriter })), C.INVALID_SOURCE);

    // Dynamic record with editable true and null writePolicy is rejected
    const rawEditableNoPolicy = record();
    rawEditableNoPolicy.definition.editable = true;
    rawEditableNoPolicy.source.mutationAdapterId = "metafieldWriter";
    rawEditableNoPolicy.policy = { ...rawEditableNoPolicy.policy, writePolicy: null };
    await rejects(() => R.resolveFieldDefinition(id, options({ dynamicResolver: async () => rawEditableNoPolicy })), C.INVALID_DEFINITION);

    // Read-only JSON metafield resolves correctly but write access is rejected
    const validJsonRaw = record();
    validJsonRaw.definition.type = "json";
    validJsonRaw.definition.editable = false;
    validJsonRaw.source.mutationAdapterId = null;
    validJsonRaw.policy = createDynamicFieldPolicy({ shopId, field: validJsonRaw.definition, definitionToken: validJsonRaw.source.definitionRevision });
    const resolvedJson = await R.resolveFieldDefinition(id, options({ dynamicResolver: async () => validJsonRaw }));
    assert.equal(resolvedJson.type, "json");
    assert.equal(resolvedJson.structurallyWritable, false);
    assert.equal(resolvedJson.policy.writePolicy, null);
    assert.throws(() => R.assertResolvedFieldAccess(resolvedJson, "write", { shopId }), { code: C.READ_ONLY });
  });
});

test("production resolution uses the installed canonical contract and preserves unavailable source metadata", async () => {
  const R = await import("./resolve.js");
  assert.equal(R.assertFieldResolutionRegistry(), true);
  assert.strictEqual(R.requireResolvedCanonicalField("product.title").source, productionSources.FIELD_SOURCES["product.title"]);
  const unsupported = R.requireResolvedCanonicalField("variant.productId");
  assert.equal(unsupported.source.kind, "unavailable");
  assert.equal(Object.hasOwn(unsupported.source, "sql"), false);
});

