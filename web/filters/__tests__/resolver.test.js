import test, { mock } from "node:test";
import assert from "node:assert/strict";
import * as resolver from "../resolver.js";
import * as filters from "../index.js";
import { CANONICAL_FIELDS } from "../../fields/canonical.js";
import { SOURCE_DATASETS } from "../../fields/sources.js";
import { createMirrorSqlSchema } from "../mirror-schema.js";
import { verifyMirrorSqlSchema } from "../../services/mirror-schema.server.js";
import { catalogPool, physicalMapping, physicalColumn } from "./catalog-fixture.js";

test("filter resolution exposes configured factories and a plan assertion, without a validation brand issuer", () => {
  assert.deepEqual(Object.keys(resolver), ["assertResolvedFilterPlan", "createFilterResolver"]);
  assert.strictEqual(filters.createFilterResolver, resolver.createFilterResolver);
  assert.strictEqual(filters.assertResolvedFilterPlan, resolver.assertResolvedFilterPlan);
  assert.throws(() => resolver.assertResolvedFilterPlan({ fields: [], datasets: ["products"], trusted: true }), { code: "FIELD_PERMISSION_DENIED" });
  for (const options of [undefined, {}, { fieldService: {} }]) {
    assert.throws(() => resolver.createFilterResolver(options), TypeError);
  }
  let called = false;
  assert.throws(() => resolver.createFilterResolver({ fieldService: {
    requireFields() { called = true; }, revalidateResolution() { called = true; }, assertResolution() { called = true; },
  } }), { code: "FIELD_PERMISSION_DENIED" });
  assert.equal(called, false);
});

test("physical resolver plans exact approved mappings and coverage through the existing registry", {
  skip: typeof mock.module !== "function",
}, async () => {
  const fields = Object.fromEntries(Object.values(CANONICAL_FIELDS).map(field => [field.id, {
    fieldId: field.id, entity: field.entity, canonicalType: field.type, canonicalDerived: field.derived,
    kind: "column", datasets: field.entity === "variant" ? ["products", "variants"] : ["products"],
  }]));
  fields["product.title"].sql = { kind: "column", alias: "p", column: "title", storageType: "text", shopColumn: "shop_id", generationColumn: "generation_id" };
  fields["variant.price"].sql = { kind: "column", alias: "v", column: "price", storageType: "numeric", shopColumn: "shop_id", generationColumn: "generation_id" };
  const definitions = ["product.title", "variant.price"].map(fieldId => ({ fieldId,
    entity: fields[fieldId].entity, sourceKind: "column", datasets: fields[fieldId].datasets,
    handlerId: fieldId === "product.title" ? "product_column_v1" : "variant_exists_v1",
    correlation: fieldId === "product.title" ? "product" : "variant_exists",
    operators: ["eq"], cost: fieldId === "product.title" ? 1 : 2,
    mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
  }));
  const sourceMock = mock.module("../../fields/sources.js", { namedExports: {
    SOURCE_DATASETS, FIELD_SOURCES: fields, FILTER_BINDING_DEFINITIONS: definitions,
    FILTER_SQL_SCHEMA: { mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1",
      product: { alias: "p", idColumn: "id", shopColumn: "shop_id", generationColumn: "generation_id" },
      variant: { schema: "mirror", table: "variants", alias: "v", productIdColumn: "product_id", shopColumn: "shop_id", generationColumn: "generation_id" } },
  } });
  let bindingMock;
  try {
    const realBindings = await import("../bindings.js?physical-resolver-test");
    bindingMock = mock.module("../bindings.js", { namedExports: { ...realBindings } });
    const actual = await import("../resolver.js?physical-resolver-test");
    const f = catalogPool({ title: physicalColumn("text") }, { price: physicalColumn("numeric") });
    const physicalSchema = await verifyMirrorSqlSchema({ database: f.pool, schema: createMirrorSqlSchema(physicalMapping()),
      mirrorSchemaVersion: "mirror_v1", sourceContractVersion: "sources_v1", fieldMappings: [
        { fieldId: "product.title", entity: "product", column: "title", type: "text" },
        { fieldId: "variant.price", entity: "variant", column: "price", type: "numeric" },
      ] });
    const planner = actual.createFilterResolver({ physicalSchema });
    const plan = planner.resolve({ version: 1, root: { kind: "group", operator: "AND", children: [
      { kind: "condition", field: "product.title", operator: "eq", value: "One" },
      { kind: "condition", field: "variant.price", operator: "eq", value: "1" },
    ] } });
    assert.strictEqual(actual.assertResolvedFilterPlan(plan), plan);
    assert.deepEqual(plan.datasets, ["products", "variants"]);
    assert.equal(plan.estimatedCost, 3);
    assert.deepEqual(plan.fields.map(field => field.physicalColumn.column), ["title", "price"]);
    assert.ok(Object.isFrozen(plan.fields[1].datasets));
    assert.throws(() => actual.assertResolvedFilterPlan({ ...plan }), { code: "FIELD_PERMISSION_DENIED" });
    assert.throws(() => planner.resolve({ version: 1, root: { kind: "condition", field: "product.vendor", operator: "eq", value: "Other" } }), { code: "FIELD_UNSUPPORTED_OPERATION" });
  } finally {
    bindingMock?.restore();
    sourceMock.restore();
  }
});

test("filter resolver refuses caller-supplied services, mapping overrides and accessors", () => {
  for (const options of [{ resolveShop() {} }, { sources: {} }, { sql: "SELECT 1" },
    { [Symbol("fieldService")]: {} }, Object.defineProperty({}, "fieldService", { get() { assert.fail("Getter invoked"); } })]) {
    assert.throws(() => resolver.createFilterResolver(options), { code: "FIELD_PERMISSION_DENIED" });
  }
});
