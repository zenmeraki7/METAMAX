import test from "node:test";
import assert from "node:assert/strict";
import { createCursorService, assertCursorService, requireCursorPosition } from "../pagination.js";

const identity = () => ({ fingerprint: "a".repeat(64), schemaFingerprint: "b".repeat(64), shopId: "test.myshopify.com",
  generationId: "generation123", idType: "text", ordering: "text:C" });

test("HMAC cursor binding rejects cross-shop, generation, filter, schema and ordering reuse", () => {
  const service = createCursorService({ secret: Buffer.alloc(32, 1), clock: () => 1000 });
  const cursor = service.issue(identity(), "gid://shopify/Product/123");
  assert.deepEqual(service.verify(cursor, identity()), { lastProductId: "gid://shopify/Product/123" });
  for (const changes of [{ shopId: "other.myshopify.com" }, { generationId: "generation456" },
    { fingerprint: "c".repeat(64) }, { schemaFingerprint: "d".repeat(64) }, { idType: "uuid", ordering: "uuid:native" }]) {
    assert.throws(() => service.verify(cursor, { ...identity(), ...changes }));
  }
  const other = createCursorService({ secret: Buffer.alloc(32, 2), clock: () => 1000 });
  assert.throws(() => other.verify(cursor, identity()));
  assert.throws(() => service.verify(`${cursor.split(".")[0]}.${"A".repeat(43)}`, identity()));
  assert.throws(() => service.verify("x".repeat(4097), identity()));
});

test("cursor lifetimes expire exactly and secret mutation cannot change the captured signing key", () => {
  let now = 1000;
  const secret = Buffer.alloc(32, 3);
  const service = createCursorService({ secret, clock: () => now, maxAgeMs: 100 });
  const cursor = service.issue(identity(), "123");
  secret.fill(0);
  now = 1099; service.verify(cursor, identity());
  now = 1100; assert.throws(() => service.verify(cursor, identity()));
  now = 999; assert.throws(() => service.verify(cursor, identity()));
  assert.strictEqual(assertCursorService(service), service);
  assert.throws(() => assertCursorService({ ...service }));
  assert.throws(() => createCursorService({ secret: Buffer.alloc(16) }));
});

test("positions follow native ID representations without numeric precision loss", () => {
  for (const value of ["9223372036854775807", "-9223372036854775808", "0"]) assert.equal(requireCursorPosition(value, "bigint"), value);
  for (const value of ["9223372036854775808", "-9223372036854775809", "01", "-0", 123, {}, []]) {
    assert.throws(() => requireCursorPosition(value, "bigint"));
  }
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(requireCursorPosition(uuid, "uuid"), uuid);
  assert.throws(() => requireCursorPosition(uuid.toUpperCase(), "uuid"));
  assert.throws(() => requireCursorPosition("x\0y", "text"));
});
