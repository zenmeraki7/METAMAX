import test from "node:test";
import assert from "node:assert/strict";
import { createFilterAuthentication } from "../../middleware/filter-auth.server.js";
import { FIELD_ERROR_CODES as C } from "../../fields/types.js";

test("missing and empty session verification adapters cannot initialize filter authentication", () => {
  for (const options of [undefined, {}, { sessionStorage: {} }, { sessionStorage: { loadSession: null } }]) {
    assert.throws(() => createFilterAuthentication(options), TypeError);
  }
});

test("filter authentication issues opaque request contexts and rechecks stored shop sessions", async () => {
  let stored = { id: "session", shop: "shop.myshopify.com", accessToken: "server-token" };
  const auth = createFilterAuthentication({ sessionStorage: { async loadSession(id) { assert.equal(id, "session"); return stored; } } });
  const req = { body: { shopId: "attacker.myshopify.com", authContext: {} } };
  assert.equal(await auth.authenticate(req), null);
  auth.capture(req, { locals: { shopify: { session: stored } } }, () => {});
  const context = await auth.authenticate(req);
  assert.deepEqual(context, {});
  assert.ok(Object.isFrozen(context));
  assert.equal(await auth.resolveShop(context), "shop.myshopify.com");
  await assert.rejects(() => auth.resolveShop({ ...context }), { code: C.PERMISSION_DENIED });
  for (const replacement of [undefined,
    { ...stored, shop: "other.myshopify.com" }, { ...stored, accessToken: "" },
    { ...stored, expires: new Date(0) }, { ...stored, expires: new Date(NaN) },
  ]) {
    const previous = stored; stored = replacement;
    await assert.rejects(() => auth.resolveShop(context), { code: C.PERMISSION_DENIED });
    stored = previous;
  }
});

test("filter authentication never captures missing or expired middleware sessions", async () => {
  const auth = createFilterAuthentication({ sessionStorage: { loadSession() { assert.fail("Invalid session reached storage"); } } });
  const valid = { id: "session", shop: "shop.myshopify.com", accessToken: "token" };
  for (const session of [undefined,
    { ...valid, expires: new Date(0) }, { ...valid, expires: new Date(NaN) },
    { ...valid, id: " " }, { ...valid, accessToken: " " },
    { ...valid, shop: `${"a".repeat(256)}.myshopify.com` },
  ]) {
    const req = {};
    auth.capture(req, { locals: { shopify: { session } } }, () => {});
    assert.equal(await auth.authenticate(req), null);
  }
});

test("request session authentication rechecks revocation without duplicate reads", async () => {
  let stored = { id: "session", shop: "shop.myshopify.com", accessToken: "token" };
  let reads = 0;
  const auth = createFilterAuthentication({ sessionStorage: { async loadSession() { reads++; return stored; } } });
  const req = {};
  assert.equal(await auth.authenticateSession(req), null);
  assert.equal(reads, 0);
  auth.capture(req, { locals: { shopify: { session: stored } } }, () => {});
  assert.equal(await auth.authenticateSession(req), stored);
  assert.equal(reads, 1);
  stored = null;
  await assert.rejects(() => auth.authenticateSession(req), { code: C.PERMISSION_DENIED });
  assert.equal(reads, 2);
});
