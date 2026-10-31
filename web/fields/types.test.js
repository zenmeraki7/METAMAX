import test from "node:test";
import assert from "node:assert/strict";

import {
  deepFreeze,
  measureFieldMetadata,
  FIELD_METADATA_BUDGETS,
  FIELD_TYPES,
  FIELD_TYPE_CAPABILITIES,
  FIELD_ERROR_CODES,
  FieldError,
  isDecimalString,
  isBoundedDecimalString,
  isISODate,
  isISODateTime,
  FIELD_ID_LIMITS,
  DYNAMIC_FIELD_ID_PATTERN,
  isValidFieldId,
  isDynamicFieldId,
  isCanonicalFieldId,
  hasUnpairedSurrogate,
  isSupportedFieldId,
  isDynamicMetafieldId,
} from "./types.js";

test("structural field IDs validate syntax without checking field existence", () => {
  for (const value of ["product.title", "product.notRegistered", "product.metafield.short"]) {
    assert.equal(isValidFieldId(value), true);
    assert.equal(isDynamicFieldId(value), false);
  }
  for (const value of [null, undefined, 1, {}, "", "Product.title", "product..title", "product.", "product.title-foo", "product.കേരളം"]) {
    assert.equal(isValidFieldId(value), false);
    assert.equal(isDynamicFieldId(value), false);
  }
});

test("structural byte budget and legacy canonical length limit remain distinct", () => {
  assert.ok(Object.isFrozen(FIELD_ID_LIMITS));
  const atLimit = `product.${"a".repeat(FIELD_ID_LIMITS.MAX_BYTES - 8)}`;
  assert.equal(Buffer.byteLength(atLimit, "utf8"), 160);
  assert.equal(isValidFieldId(atLimit), true);
  assert.equal(isValidFieldId(`${atLimit}a`), false);
  assert.equal(isCanonicalFieldId(atLimit), false);
  assert.equal(isCanonicalFieldId(`product.${"a".repeat(120)}`), true);
  assert.equal(isCanonicalFieldId(`product.${"a".repeat(121)}`), false);
});

test("dynamic field identification is a subset of general structural syntax", () => {
  for (const value of ["product.metafield.abcdefgh1234", "variant.metafield.m01234567"]) {
    assert.equal(isValidFieldId(value), true);
    assert.equal(isDynamicFieldId(value), true);
    assert.equal(isCanonicalFieldId(value), true);
    assert.equal(DYNAMIC_FIELD_ID_PATTERN.test(value), true);
  }
  for (const value of ["product.metafield.short", "customer.metafield.abcdefgh1234", "product.metafield.namespace.key"]) {
    assert.equal(isValidFieldId(value), true);
    assert.equal(isDynamicFieldId(value), false);
  }
});

test("Unicode validation distinguishes well-formed pairs from unpaired surrogates", () => {
  for (const value of [null, 1, {}, "", "കേരളം", "🙂", "a🙂b"]) assert.equal(hasUnpairedSurrogate(value), false);
  for (const value of ["\ud800", "\udfff", "a\ud800b", "\ud800\ud800", "\udc00\ud800"]) {
    assert.equal(hasUnpairedSurrogate(value), true);
  }
});

test("supported syntax preserves canonical compatibility and central dynamic recognition", () => {
  for (const value of ["product.title", "product.notRegistered", "product.metafield.abcdefgh1234"]) {
    assert.equal(isSupportedFieldId(value), true);
  }
  assert.equal(isDynamicMetafieldId("product.metafield.abcdefgh1234"), true);
  assert.equal(isDynamicMetafieldId("product.metafield.short"), false);
  assert.equal(isSupportedFieldId(`product.${"a".repeat(121)}`), false);
  assert.equal(isValidFieldId(`product.${"a".repeat(121)}`), true);
  assert.equal(isSupportedFieldId("product.\ud800"), false);
});

test("every canonical type has capabilities", () => {
  for (const type of Object.values(FIELD_TYPES)) {
    assert.ok(
      Object.hasOwn(FIELD_TYPE_CAPABILITIES, type)
    );
  }
});

test("shared references remain valid", () => {
  const shared = { enabled: true };
  const root = { first: shared, second: shared };

  const stats = measureFieldMetadata(root);

  assert.equal(stats.nodes, 2);
  assert.equal(stats.properties, 3);

  deepFreeze(root);

  assert.ok(Object.isFrozen(root));
  assert.ok(Object.isFrozen(shared));
});

test("shared paths obey maximum depth", () => {
  const shared = { nested: { enabled: true } };

  const root = {
    shallow: shared,
    deeper: { reference: shared },
  };

  assert.throws(
    () => deepFreeze(root, { maxDepth: 2 }),
    /depth exceeded/
  );

  assert.equal(Object.isFrozen(root), false);
});

test("cycles cannot be frozen", () => {
  const root = {};
  root.self = root;

  assert.throws(
    () => deepFreeze(root),
    /Cyclic field metadata/
  );
});

test("property budget counts unique objects", () => {
  const shared = { a: 1, b: 2 };
  const root = { first: shared, second: shared };

  assert.doesNotThrow(() =>
    measureFieldMetadata(root, {
      maxProperties: 4,
    })
  );

  assert.throws(
    () => measureFieldMetadata(root, {
      maxProperties: 3,
    }),
    /property limit exceeded/
  );
});

test("visit budget rejects excessive traversal", () => {
  const root = {
    first: { value: 1 },
    second: { value: 2 },
  };

  assert.throws(
    () => deepFreeze(root, {
      maxVisits: 2,
    }),
    /traversal limit exceeded/
  );
});

test("rejects forbidden metadata primitives", () => {
  for (const value of [
    Symbol("invalid"),
    10n,
    Infinity,
    NaN,
    () => true,
  ]) {
    assert.throws(() => deepFreeze({ value }));
  }
});

test("public serialization excludes internals", () => {
  const error = new FieldError(
    FIELD_ERROR_CODES.INVALID_VALUE,
    "Sensitive internal database information",
    {
      fieldId: "product.title",
      details: { token: "private" },
    }
  );

  assert.deepEqual(error.toJSON(), {
    error: FIELD_ERROR_CODES.INVALID_VALUE,
    message: "Invalid field operation",
    fieldId: "product.title",
  });

  assert.ok(
    !JSON.stringify(error).includes("Sensitive")
  );
});

test("decimal values enforce input length", () => {
  assert.equal(
    isDecimalString("1".repeat(256)),
    true
  );
  assert.equal(
    isDecimalString("1".repeat(257)),
    false
  );
});

test("DECIMAL(p,p) accepts valid fractions", () => {
  const constraints = {
    precision: 2,
    scale: 2,
  };

  assert.equal(
    isBoundedDecimalString("0.12", constraints),
    true
  );
  assert.equal(
    isBoundedDecimalString("1.12", constraints),
    false
  );
});

test("dates and canonical UTC timestamps", () => {
  assert.equal(isISODate("2024-02-29"), true);
  assert.equal(isISODate("2025-02-29"), false);

  assert.equal(
    isISODateTime("2026-10-27T14:30:00.000Z"),
    true
  );

  assert.equal(
    isISODateTime("2026-10-27T14:30:00+05:30"),
    false
  );
});

test("metadata budgets are explicit", () => {
  assert.deepEqual(FIELD_METADATA_BUDGETS, {
    maxDepth: 32,
    maxNodes: 10000,
    maxProperties: 50000,
    maxVisits: 100000,
  });
});
