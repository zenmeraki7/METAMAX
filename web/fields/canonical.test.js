import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_FIELDS,
  CANONICAL_FIELD_COUNT,
  CANONICAL_REGISTRY_METADATA_USAGE,
  CANONICAL_REGISTRY_METADATA_BUDGETS,
  assertCanonicalRegistry,
  getCanonicalField,
  requireCanonicalField,
  listCanonicalFields,
} from "./canonical.js";

test("canonical registry contains 58 fields", () => {
  assert.equal(CANONICAL_FIELD_COUNT, 58);
  assert.equal(Object.keys(CANONICAL_FIELDS).length, 58);
});

test("registry invariants hold", () => {
  assert.equal(assertCanonicalRegistry(), true);
});

test("canonical field definitions are immutable", () => {
  assert.ok(Object.isFrozen(CANONICAL_FIELDS));

  for (const field of Object.values(CANONICAL_FIELDS)) {
    assert.ok(Object.isFrozen(field));
  }
});

test("field lookups preserve identity", () => {
  const field = getCanonicalField("product.title");

  assert.equal(field.type, "string");
  assert.equal(field.editable, true);
  assert.strictEqual(
    requireCanonicalField("product.title"),
    field
  );
});

test("unknown fields are rejected", () => {
  assert.equal(getCanonicalField("product.missing"), null);
  assert.throws(() =>
    requireCanonicalField("product.missing")
  );
});

test("filtered lists reuse cached references", () => {
  const first = listCanonicalFields({
    entity: "product",
    editable: true,
  });

  const second = listCanonicalFields({
    entity: "product",
    editable: true,
  });

  assert.strictEqual(first, second);
  assert.ok(Object.isFrozen(first));
});

test("registry stays within measured budgets", () => {
  const stats = CANONICAL_REGISTRY_METADATA_USAGE;
  const limits = CANONICAL_REGISTRY_METADATA_BUDGETS;

  assert.ok(stats.nodes <= limits.maxNodes);
  assert.ok(stats.properties <= limits.maxProperties);
  assert.ok(stats.visits <= limits.maxVisits);
  assert.ok(stats.maxDepthObserved <= limits.maxDepth);
});
