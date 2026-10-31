import test, { describe, mock } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_FIELDS } from "./canonical.js";
import { deepFreeze } from "./types.js";
import { createDynamicFieldPolicy } from "./constraints.js";

// The production source registry is not implemented. This fixture supplies only
// contract metadata; "products" is a test dataset, not a production mapping.
// Run with --experimental-test-module-mocks to execute every scenario.
describe("adversarial field resolver scenarios", {
  skip: typeof mock.module !== "function" && "Requires --experimental-test-module-mocks",
}, async () => {
  if (typeof mock.module !== "function") return;
  const dependency = mock.module("./sources.js", { namedExports: {
    SOURCE_DATASETS: Object.freeze({ PRODUCTS: "products", METAFIELDS: "metafields" }),
    FIELD_SOURCES: deepFreeze(Object.fromEntries(
      Object.values(CANONICAL_FIELDS).map(field => [field.id, {
        fieldId: field.id,
        entity: field.entity,
        canonicalType: field.type,
        canonicalDerived: field.derived,
        datasets: ["products"],
      }])
    )),
  } });
  let resolver;
  try {
    resolver = await import("./resolve.js?security-fixture");
  } finally {
    dependency.restore();
  }
  const {
    resolveFieldDefinition,
    resolveFieldDefinitions,
    requireFieldForAccess,
    requireFieldsForAccess,
    assertResolvedFieldAccess,
    getResolvedCanonicalField,
    FIELD_ACCESS,
    FIELD_OPERATIONS,
  } = resolver;

  const SHOP_A = "alpha.myshopify.com";
  const SHOP_B = "beta.myshopify.com";

  const ID = "product.metafield.m01234567";

  const adapters = {
    read: new Set(["metafieldReader"]),
    write: new Set(["metafieldWriter"]),
  };

  function dynamicRecord({
    shopId = SHOP_A,
    id = ID,
    editable = false,
    adapterId = "metafieldReader",
    mutationAdapterId = null,
  } = {}) {
    const result = {
      shopId,
      fieldId: id,
      definition: {
        id,
        entity: "product",
        label: "Custom material",
        type: "string",
        nullable: true,
        editable,
        derived: false,
      },
      source: {
        fieldId: id,
        entity: "product",
        sourceKind: "metafield",
        adapterId,
        definitionId: "gid://shopify/MetafieldDefinition/123",
        definitionRevision: "d0123456789012345",
        locatorId: "l01234567",
        mutationAdapterId,
        datasets: ["metafields"],
        accessAnyOf: ["read_products"],
        accessAllOf: [],
      },
    };
    result.policy = createDynamicFieldPolicy({
      shopId, field: result.definition, definitionToken: result.source.definitionRevision,
    });
    return result;
  }

  function context(overrides = {}) {
    return {
      shopId: SHOP_A,
      adapters,
      operation: FIELD_OPERATIONS.FILTER,
      actor: { id: "staff123" },
      executionContext: {
        operationId: "operation123",
      },
      dynamicResolver: async () => dynamicRecord(),
      authorizeAccess: async () => true,
      verifyCoverage: async () => true,
      ...overrides,
    };
  }

  test("canonical lookup is cached", () => {
    const a = getResolvedCanonicalField("product.title");
    const b = getResolvedCanonicalField("product.title");

    assert.ok(a);
    assert.strictEqual(a, b);
    assert.ok(Object.isFrozen(a));
  });

  test("reject unknown field identity", async () => {
    await assert.rejects(
      resolveFieldDefinition("product.notReal"),
      { code: "FIELD_UNKNOWN_FIELD" }
    );
  });

  test("reject forged resolved objects", () => {
    const authentic = getResolvedCanonicalField(
      "product.title"
    );

    const forged = {
      ...authentic,
      editable: true,
      structurallyWritable: true,
    };

    assert.throws(
      () => assertResolvedFieldAccess(
        forged,
        FIELD_ACCESS.WRITE
      ),
      { code: "FIELD_PERMISSION_DENIED" }
    );
  });

  test("reject cross-shop dynamic record", async () => {
    await assert.rejects(
      resolveFieldDefinition(ID, {
        shopId: SHOP_B,
        adapters,
        dynamicResolver: async () =>
          dynamicRecord({ shopId: SHOP_A }),
      }),
      { code: "FIELD_PERMISSION_DENIED" }
    );
  });

  test("reject unregistered storage adapter", async () => {
    await assert.rejects(
      resolveFieldDefinition(ID, {
        shopId: SHOP_A,
        adapters,
        dynamicResolver: async () =>
          dynamicRecord({
            adapterId: "unauthorizedReader",
          }),
      }),
      { code: "FIELD_INVALID_SOURCE" }
    );
  });

  test("reject editable metafield without writer", async () => {
    await assert.rejects(
      resolveFieldDefinition(ID, {
        shopId: SHOP_A,
        adapters,
        dynamicResolver: async () =>
          dynamicRecord({ editable: true }),
      }),
      { code: "FIELD_INVALID_SOURCE" }
    );
  });

  test("reject unexpected keyed batch field", async () => {
    const extra = "product.metafield.m99999999";

    await assert.rejects(
      resolveFieldDefinitions([ID], {
        shopId: SHOP_A,
        adapters,
        dynamicBatchResolver: async () =>
          new Map([
            [extra, dynamicRecord({ id: extra })],
          ]),
      }),
      { code: "FIELD_INVALID_DEFINITION" }
    );
  });

  test("reject missing dynamic batch record", async () => {
    await assert.rejects(
      resolveFieldDefinitions([ID], {
        shopId: SHOP_A,
        adapters,
        dynamicBatchResolver: async () => new Map(),
      }),
      { code: "FIELD_INVALID_DEFINITION" }
    );
  });

  test("deduplicate fields before batch lookup", async () => {
    let requested = null;

    const result = await resolveFieldDefinitions(
      [ID, ID, "product.title", "product.title"],
      {
        shopId: SHOP_A,
        adapters,
        dynamicBatchResolver: async ({ fieldIds }) => {
          requested = [...fieldIds];
          return new Map([[ID, dynamicRecord()]]);
        },
      }
    );

    assert.deepEqual(requested, [ID]);
    assert.equal(result.length, 2);
  });

  test("reject missing published coverage", async () => {
    await assert.rejects(
      requireFieldForAccess(
        "product.title",
        FIELD_ACCESS.READ,
        context({
          verifyCoverage: async () => false,
        })
      ),
      { code: "FIELD_MISSING_DEPENDENCY" }
    );
  });

  test("reject unauthorized field access", async () => {
    await assert.rejects(
      requireFieldForAccess(
        "product.title",
        FIELD_ACCESS.READ,
        context({
          authorizeAccess: async () => false,
        })
      ),
      { code: "FIELD_PERMISSION_DENIED" }
    );
  });

  test("reject the whole batch if one field is denied", async () => {
    await assert.rejects(
      requireFieldsForAccess(
        ["product.title", "product.vendor"],
        FIELD_ACCESS.READ,
        context({
          authorizeAccess: async ({ field }) =>
            field.id !== "product.vendor",
        })
      ),
      { code: "FIELD_PERMISSION_DENIED" }
    );
  });

  test("reject untrusted actor context", async () => {
    await assert.rejects(
      requireFieldsForAccess(
        ["product.title"],
        FIELD_ACCESS.READ,
        context({ actor: null })
      ),
      { code: "FIELD_PERMISSION_DENIED" }
    );
  });

  test("reject oversized field batch", async () => {
    await assert.rejects(
      resolveFieldDefinitions(
        Array(1001).fill("product.title")
      ),
      { code: "FIELD_INVALID_VALUE" }
    );
  });

  test("reject sparse field arrays", async () => {
    const sparse = new Array(2);
    sparse[0] = "product.title";

    await assert.rejects(
      resolveFieldDefinitions(sparse),
      { code: "FIELD_INVALID_VALUE" }
    );
  });
});

