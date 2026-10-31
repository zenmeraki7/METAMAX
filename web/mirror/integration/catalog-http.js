import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp } from "../../app.js";
import { createInstalledFilterHttpRuntime } from "../../services/filter-engine.server.js";
import { getFilterBindingRegistry } from "../../filters/bindings.js";

/** Real HTTP -> live session -> authorization -> compiler -> migrated PostgreSQL. */
export async function testCatalogHttp({ pool, shopId, generationId }) {
  const session = { id: "catalog-live-session", shop: shopId, scope: "read_products", accessToken: "test-token" };
  const runtime = await createInstalledFilterHttpRuntime({ database: pool,
    sessionStorage: { loadSession: async id => id === session.id ? session : null }, cursorSecret: randomBytes(32), logger: { error() {} } });
  const pass = () => (_req, _res, next) => next();
  const shopify = { config: { auth: { path: "/auth", callbackPath: "/auth/callback" }, webhooks: { path: "/webhooks" }, sessionStorage: {} },
    cspHeaders: pass, auth: { begin: pass, callback: pass }, redirectToShopifyOrAppRoot: pass,
    processWebhooks: pass, ensureInstalledOnShop: pass,
    validateAuthenticatedSession: () => (_req, res, next) => { res.locals.shopify = { session: { ...session } }; next(); } };
  const server = createApp({ shopify, staticPath: ".", filterRuntime: runtime }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (params = {}, path = "/api/mirror/products") => {
    const response = await fetch(`${base}${path}?${new URLSearchParams(params)}`);
    return { response, body: await response.json() };
  };
  const filters = conditions => ({ filters: JSON.stringify(conditions) });
  const one = (field, operator, value) => ({ field, operator, ...(value === undefined ? {} : { value }) });
  try {
    let result = await get({ limit: "1" });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.snapshotId, generationId);
    assert.deepEqual(result.body.summary, { productCount: 2, activeCount: 2, variantCount: 3 });
    assert.equal(result.body.filteredCount, 2);
    assert.equal(result.body.products[0].id, "gid://shopify/Product/10");
    assert.equal(result.body.products[0].vendor, "North");
    assert.equal(result.body.products[0].variantCount, 2);
    assert.equal(result.body.pageInfo.hasNextPage, true);
    const cursor = result.body.pageInfo.endCursor;
    result = await get({ limit: "1", cursor });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.products[0].id, "gid://shopify/Product/11");
    assert.equal(result.body.filteredCount, 2); // Count is independent of keyset.
    assert.equal(result.body.pageInfo.hasNextPage, false);
    assert.equal((await get({ cursor: `${cursor}x` })).response.status, 400);

    for (const [conditions, expected] of [
      [[one("product.title", "contains", "install")], 2],
      [[one("product.vendor", "eq", "North")], 1],
      [[one("product.vendor", "neq", "North")], 1],
      [[one("product.status", "eq", "ACTIVE")], 2],
      [[one("variant.price", "gt", "100"), one("variant.sku", "eq", "ABC")], 1],
      [[one("product.tags", "list_contains", "Summer")], 1],
      [[one("product.tags", "list_not_contains", "Summer")], 1],
      [[one("product.tags", "list_contains", "summer")], 0],
      [[one("product.tags", "list_contains", "100%_literal")], 1],
      [[one("product.tags", "is_empty")], 1],
      [[one("product.tags", "is_not_empty")], 1],
      [[one("product.title", "contains", "' OR true --")], 0],
    ]) {
      result = await get(filters(conditions));
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.filteredCount, expected, JSON.stringify(conditions));
      assert.equal(result.body.products.length, expected);
    }
    // Every installed binding traverses the genuine runtime, not a source mock.
    for (const field of getFilterBindingRegistry().listFieldIds()) {
      result = await get(filters([one(field, "is_not_null")]));
      assert.equal(result.response.status, 200, `${field}: ${JSON.stringify(result.body)}`);
    }
    result = await get({ search: "North", status: "ACTIVE", ...filters([one("variant.sku", "eq", "ABC")]) });
    assert.equal(result.body.filteredCount, 1);
    assert.equal((await get(filters([one("product.vendor", "ne", "North")]))).response.status, 400);
    assert.equal((await get(filters([{ field: { id: "product.title", type: "string" }, operator: "eq", value: "Installed" }]))).response.status, 400);
    assert.equal((await get({ shop: "other.myshopify.com" })).response.status, 400);
    const count = await get(filters([one("product.vendor", "eq", "North")]), "/api/products/count");
    assert.deepEqual(count.body, { count: 1, precision: "EXACT" });
    assert.equal((await get({}, "/api/mirror/status")).body.publishedRevision, "installed-r1");
    session.scope = "";
    assert.equal((await get()).response.status, 403);
    session.scope = "read_products";
    const changed = await pool.query("UPDATE mirror.shops SET uninstalled_at=now() WHERE id=$1 RETURNING id", [shopId]);
    assert.equal(changed.rowCount, 1);
    try { assert.equal((await get()).response.status, 403); }
    finally { await pool.query("UPDATE mirror.shops SET uninstalled_at=NULL WHERE id=$1", [shopId]); }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
