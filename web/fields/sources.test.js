import test from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_FIELDS } from "./canonical.js";
import { FIELD_SOURCES, FILTER_BINDING_DEFINITIONS, FILTER_SQL_SCHEMA } from "./sources.js";
import { getFilterBindingRegistry } from "../filters/bindings.js";

test("installed source definitions cover every canonical identity without adding fields or mutable mappings", () => {
  assert.deepEqual(Object.keys(FIELD_SOURCES).sort(), Object.keys(CANONICAL_FIELDS).sort());
  for (const field of Object.values(CANONICAL_FIELDS)) {
    const source = FIELD_SOURCES[field.id];
    assert.equal(source.fieldId, field.id);
    assert.equal(source.entity, field.entity);
    assert.equal(source.canonicalType, field.type);
    assert.equal(source.canonicalDerived, field.derived);
    assert.ok(Object.isFrozen(source));
    assert.ok(Object.isFrozen(source.datasets));
    if (source.kind === "column") assert.ok(Object.isFrozen(source.sql));
    else {
      assert.equal(source.kind, "unavailable");
      assert.equal(Object.hasOwn(source, "sql"), false);
      assert.ok(source.unavailableReason);
    }
  }
});

test("Shopify identities remain text mappings while internal foreign keys never masquerade as GIDs", () => {
  assert.equal(FIELD_SOURCES["product.id"].sql.column, "shopify_id");
  assert.equal(FIELD_SOURCES["variant.id"].sql.column, "shopify_id");
  assert.equal(FIELD_SOURCES["product.id"].sql.storageType, "text");
  assert.equal(FIELD_SOURCES["variant.productId"].kind, "unavailable");
  assert.equal(FIELD_SOURCES["variant.price"].sql.storageType, "numeric");
  assert.equal(FIELD_SOURCES["variant.inventoryQuantity"].sql.storageType, "bigint");
  assert.equal(FIELD_SOURCES["product.createdAt"].sql.column, "created_at");
  assert.equal(FIELD_SOURCES["product.createdAt"].sql.storageType, "timestamptz");
});

test("fixed bindings install reviewed product/variant columns and tags; unsupported families remain closed", () => {
  const registry = getFilterBindingRegistry();
  assert.equal(registry.schema.mirrorSchemaVersion, FILTER_SQL_SCHEMA.mirrorSchemaVersion);
  assert.equal(registry.schema.sourceContractVersion, FILTER_SQL_SCHEMA.sourceContractVersion);
  assert.equal(registry.listFieldIds().length, 28);
  assert.deepEqual(registry.requireBinding("product.tags").operators, ["list_contains", "list_not_contains", "is_empty", "is_not_empty", "is_null", "is_not_null"]);
  assert.ok(Object.isFrozen(FILTER_BINDING_DEFINITIONS));
  for (const binding of FILTER_BINDING_DEFINITIONS) {
    assert.ok(["product", "variant"].includes(binding.entity));
    assert.ok(["product_column_v1", "variant_exists_v1"].includes(binding.handlerId));
    assert.ok(Object.isFrozen(binding) && Object.isFrozen(binding.operators));
    assert.strictEqual(registry.requireBinding(binding.fieldId).operators.length, binding.operators.length);
  }
  for (const id of ["variant.productId", "inventoryItem.unitCost", "inventoryLevel.available",
    "collection.title", "location.name", "productOption.name", "category.name", "product.metafield.m01234567",
    "product.title;DROP TABLE products", "product.attributes.secret"]) {
    assert.throws(() => registry.requireBinding(id), { code: "FIELD_UNSUPPORTED_OPERATION" });
  }
  assert.equal(FILTER_BINDING_DEFINITIONS.find(binding => binding.fieldId === "product.status").operators.includes("contains"), false);
});
