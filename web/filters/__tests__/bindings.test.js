import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { SOURCE_DATASETS } from "../../fields/sources.js";
import { CANONICAL_FIELDS } from "../../fields/canonical.js";
import { describeFilterFailure } from "../errors.js";

describe("server-bootstrap compiler binding registry", {
  skip: typeof mock.module !== "function" && "Requires --experimental-test-module-mocks",
}, async () => {
  if (typeof mock.module !== "function") return;
  const source = () => ({ fieldId: "product.title", entity: "product", kind: "column",
    canonicalType: "string", canonicalDerived: false, datasets: ["products", "collections"] });
  const schema = () => ({ mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
    product: { alias: "p", shopColumn: "shop_id", generationColumn: "generation_id", idColumn: "id" },
    variant: { schema: "mirror", table: "variants", alias: "v", shopColumn: "shop_id", generationColumn: "generation_id", productIdColumn: "product_id" } });
  const definition = () => ({ fieldId: "product.title", entity: "product", sourceKind: "column",
    datasets: ["products", "collections"], correlation: "product", handlerId: "product_column_v1",
    operators: ["eq", "neq", "contains"], cost: 1, mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1" });
  let serial = 0;
  async function load(definitions = [definition()], changes = {}) {
    const dependency = mock.module("../../fields/sources.js", { namedExports: {
      SOURCE_DATASETS, FIELD_SOURCES: { "product.title": source() },
      FILTER_SQL_SCHEMA: schema(), FILTER_BINDING_DEFINITIONS: definitions, ...changes,
    } });
    try { return await import(`../bindings.js?test-${serial++}`); } finally { dependency.restore(); }
  }

  test("constructor is private; accessors accept no caller-supplied definitions or functions", async () => {
    const module = await load();
    assert.equal(Object.hasOwn(module, "createFilterBindingRegistry"), false);
    assert.throws(() => module.getFilterBindingRegistry([{ compile() { assert.fail("Handler executed"); } }]));
    const registry = module.getFilterBindingRegistry();
    assert.strictEqual(module.assertFilterBindingRegistry(registry), registry);
    assert.throws(() => module.assertFilterBindingRegistry({ ...registry }));
    assert.strictEqual(module.getFilterBindingRegistry(), registry);
  });

  test("missing server bindings are an internal contract failure, not malformed merchant input", async () => {
    for (const key of ["FIELD_SOURCES", "FILTER_BINDING_DEFINITIONS", "FILTER_SQL_SCHEMA"]) {
      for (const value of [undefined, null]) {
        const changes = { [key]: value };
        const module = await load([definition()], changes);
        assert.throws(() => module.getFilterBindingRegistry(), error => {
          assert.equal(error.code, "FIELD_CONTRACT_MISMATCH");
          assert.equal(describeFilterFailure(error).code, "FILTER_CONTRACT_FAILURE");
          assert.equal(describeFilterFailure(error).status, 500);
          return true;
        });
      }
    }
  });

  test("lookup returns immutable capability and cost metadata, never a raw compiler", async () => {
    const registry = (await load()).getFilterBindingRegistry();
    const binding = registry.requireBinding("product.title");
    assert.equal(binding.compile, undefined);
    assert.equal(binding.handlerId, "product_column_v1");
    assert.equal(binding.cost, 1);
    assert.deepEqual(binding.operators, ["eq", "neq", "contains"]);
    assert.ok(Object.isFrozen(binding));
    assert.ok(Object.isFrozen(binding.operators));
    assert.deepEqual(registry.listFieldIds(), ["product.title"]);
    assert.equal(registry.hasBinding("__proto__"), false);
    assert.throws(() => registry.requireBinding("__proto__"));
  });

  test("definitions arrays reject holes, indexed accessors and extra properties without execution", async () => {
    const getter = [definition()];
    Object.defineProperty(getter, "0", { get() { assert.fail("Getter executed"); } });
    for (const definitions of [[], new Array(1), getter, Object.assign([definition()], { extra: true }), Array(1001).fill(definition())]) {
      const module = await load(definitions);
      assert.throws(() => module.getFilterBindingRegistry());
    }
  });

  test("binding metadata rejects duplicate fields, functions, unsupported handlers and capabilities", async () => {
    for (const changes of [
      { compile() { assert.fail("Handler executed"); } }, { handlerId: "unverified" },
      { handlerId: () => assert.fail("Handler executed") }, { operators: ["gt"] },
      { operators: ["eq", "eq"] }, { cost: 0 }, { entity: "variant" },
      { correlation: "variant_exists" }, { mirrorSchemaVersion: "other_v1" },
    ]) {
      const module = await load([{ ...definition(), ...changes }]);
      assert.throws(() => module.getFilterBindingRegistry());
    }
  });

  test("dataset dependencies use ordered equality", async () => {
    for (const datasets of [["collections", "products"], ["products"], ["products", "products"]]) {
      const module = await load([{ ...definition(), datasets }]);
      assert.throws(() => module.getFilterBindingRegistry());
    }
  });

  test("canonical source metadata and schema identifiers are checked", async () => {
    for (const changes of [
      { FIELD_SOURCES: { "product.title": { ...source(), canonicalType: "boolean" } } },
      { FILTER_SQL_SCHEMA: { ...schema(), sourceContractVersion: "" } },
      { FILTER_SQL_SCHEMA: { ...schema(), variant: { ...schema().variant, table: "variants; SELECT 1" } } },
    ]) {
      const module = await load([definition()], changes);
      assert.throws(() => module.getFilterBindingRegistry());
    }
    const duplicate = await load([definition(), definition()]);
    assert.throws(() => duplicate.getFilterBindingRegistry());
    const dynamic = await load([{ ...definition(), fieldId: "product.metafield.abcdefgh1234" }]);
    assert.throws(() => dynamic.getFilterBindingRegistry());
  });

  test("unsupported entities and incorrect variant correlations are rejected", async () => {
    const inventory = await load([{ ...definition(), fieldId: "inventoryItem.unitCost", entity: "inventoryItem" }], {
      FIELD_SOURCES: { "inventoryItem.unitCost": { fieldId: "inventoryItem.unitCost", entity: "inventoryItem", kind: "column",
        canonicalType: "money", canonicalDerived: false, datasets: ["products"] } },
    });
    assert.throws(() => inventory.getFilterBindingRegistry());
    const variant = await load([{ ...definition(), fieldId: "variant.sku", entity: "variant",
      datasets: ["products", "variants"], handlerId: "variant_exists_v1", cost: 2 }], {
      FIELD_SOURCES: { "variant.sku": { fieldId: "variant.sku", entity: "variant", kind: "column",
        canonicalType: "string", canonicalDerived: false, datasets: ["products", "variants"] } },
    });
    assert.throws(() => variant.getFilterBindingRegistry());
  });

  test("all non-product/variant canonical families remain disabled despite registered storage or datasets", async () => {
    for (const fieldId of ["inventoryItem.unitCost", "inventoryLevel.available", "location.name", "collection.title", "productOption.name", "category.name"]) {
      const field = CANONICAL_FIELDS[fieldId];
      const module = await load([{ ...definition(), fieldId, entity: field.entity }], {
        FIELD_SOURCES: { [fieldId]: { fieldId, entity: field.entity, kind: "column", canonicalType: field.type,
          canonicalDerived: field.derived, datasets: ["products"] } },
      });
      assert.throws(() => module.getFilterBindingRegistry(), { code: "FIELD_UNSUPPORTED_OPERATION" });
    }
  });

  test("dynamic metafields and invented SQL handlers cannot acquire fixed-field bindings", async () => {
    for (const fieldId of ["product.metafield.m01234567", "variant.metafield.m01234567"]) {
      const module = await load([{ ...definition(), fieldId }], {
        FIELD_SOURCES: { [fieldId]: { ...source(), fieldId } },
      });
      assert.throws(() => module.getFilterBindingRegistry());
    }
    for (const handlerId of ["inventory_level_v1", "collection_exists_v1", "metafield_value_v1", "json_path_v1"]) {
      const module = await load([{ ...definition(), handlerId }]);
      assert.throws(() => module.getFilterBindingRegistry(), { code: "FIELD_INVALID_DEFINITION" });
    }
    for (const sourceKind of ["metafield", "json_path", "aggregate", "derived"]) {
      const module = await load([{ ...definition(), sourceKind }], {
        FIELD_SOURCES: { "product.title": { ...source(), kind: sourceKind } },
      });
      assert.throws(() => module.getFilterBindingRegistry(), { code: "FIELD_INVALID_DEFINITION" });
    }
  });

  test("the existing variant column handler remains available with its exact correlation", async () => {
    const field = CANONICAL_FIELDS["variant.sku"];
    const module = await load([{ ...definition(), fieldId: field.id, entity: field.entity,
      datasets: ["products", "variants"], handlerId: "variant_exists_v1", correlation: "variant_exists", cost: 2 }], {
      FIELD_SOURCES: { [field.id]: { fieldId: field.id, entity: field.entity, kind: "column", canonicalType: field.type,
        canonicalDerived: field.derived, datasets: ["products", "variants"] } },
    });
    assert.equal(module.getFilterBindingRegistry().requireBinding(field.id).handlerId, "variant_exists_v1");
  });
});
