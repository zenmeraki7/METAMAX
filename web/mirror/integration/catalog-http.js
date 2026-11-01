import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp } from "../../app.js";
import { createInstalledFilterHttpRuntime } from "../../services/filter-engine.server.js";
import { getFilterBindingRegistry } from "../../filters/bindings.js";
import pg from 'pg';
import {verifyRuntimeDatabase,createVerifiedRuntimePool} from '../../security/runtime-database.server.js';

/** Real HTTP -> live session -> authorization -> compiler -> migrated PostgreSQL. */
export async function testCatalogHttp({ pool, shopId, generationId }) {
  const session = { id: "catalog-live-session", shop: shopId, scope: "read_products", accessToken: "test-token",isOnline:false };
  const password=randomBytes(24).toString('hex');
  await pool.query(`CREATE ROLE catalog_http_reader LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await pool.query('GRANT metamax_tenant_reader TO catalog_http_reader');
  const restrictedUrl=new URL(process.env.FILTER_TEST_DATABASE_URL);restrictedUrl.username='catalog_http_reader';restrictedUrl.password=password;
  const tenantReadPool=new pg.Pool({connectionString:restrictedUrl.href,max:2});
  await pool.query(`CREATE ROLE catalog_http_engine LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await pool.query('GRANT metamax_engine_runtime TO catalog_http_engine');
  const engineUrl=new URL(restrictedUrl);engineUrl.username='catalog_http_engine';
  const enginePool=new pg.Pool({connectionString:engineUrl.href,max:3});
  const verified=await verifyRuntimeDatabase(enginePool);assert.equal(verified.bypassRls,false);
  const audited=createVerifiedRuntimePool(enginePool);
  const statements=[];
  const record=sql=>statements.push(typeof sql === 'string' ? sql : sql.text);
  const measured={async query(sql,values){record(sql);return audited.query(sql,values);},async connect(){
    const client=await audited.connect();return {query(sql,values){record(sql);return client.query(sql,values);},release:error=>client.release(error)};
  }};
  const runtime = await createInstalledFilterHttpRuntime({ database: measured,
    sessionStorage: { loadSession: async id => id === session.id ? session : null }, cursorSecret: randomBytes(32), logger: { error() {} } });
  const pass = () => (_req, _res, next) => next();
  const shopify = { config: { auth: { path: "/auth", callbackPath: "/auth/callback" }, webhooks: { path: "/webhooks" }, sessionStorage: {} },
    cspHeaders: pass, auth: { begin: pass, callback: pass }, redirectToShopifyOrAppRoot: pass,
    processWebhooks: pass, ensureInstalledOnShop: pass,
    validateAuthenticatedSession: () => (_req, res, next) => { res.locals.shopify = { session: { ...session } }; next(); } };
  const server = createApp({ shopify, staticPath: ".", filterRuntime: runtime,database:measured,tenantReadPool }).listen(0, "127.0.0.1");
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
    statements.length=0;
    const count = await get(filters([one("product.vendor", "eq", "North")]), "/api/products/count");
    assert.deepEqual(count.body, { count: 1, precision: "EXACT" });
    assert.equal(statements.filter(sql=>/SELECT count\(\*\).*FROM "mirror"\."products"/.test(sql)).length,1);
    assert.equal(statements.some(sql=>/AS product_id FROM|FROM mirror\.products p/.test(sql)),false);
    statements.length=0;
    assert.equal((await get({}, "/api/mirror/status")).body.publishedRevision, "installed-r1");
    assert.equal(statements.some(sql=>/FROM (?:"mirror"\."products"|mirror\.products|mirror\.variants)/.test(sql)),false,'Status must not scan product or variant data');
    const unlisted=await get({status:'UNLISTED'});assert.equal(unlisted.response.status,200,JSON.stringify(unlisted.body));assert.equal(unlisted.body.filteredCount,0);
    statements.length=0;
    const capabilities=await get({},'/api/catalog/capabilities');
    assert.equal(capabilities.response.status,200,JSON.stringify(capabilities.body));
    assert.deepEqual(capabilities.body.fields.map(field=>field.id).sort(),getFilterBindingRegistry().listFieldIds().slice().sort());
    assert.ok(capabilities.body.fields.find(field=>field.id==='product.tags').operators.includes('list_contains'));
    assert.ok(capabilities.body.fields.every(field=>!field.id.includes('metafield')));
    assert.equal(statements.some(sql=>/FROM (?:"mirror"\."products"|mirror\.products|mirror\.variants)/.test(sql)),false);
    assert.equal((await get({shopId:'forged.myshopify.com'},'/api/catalog/capabilities')).response.status,400);
    const sourcesPath='/api/shopify-data/sources';
    await pool.query(`INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,status,generation_id)
      VALUES('source-test-prior',$1,'previous-installation','SUCCEEDED',$2)`,[shopId,generationId]);
    const noJob=await get({},sourcesPath);assert.equal(noJob.response.status,200,JSON.stringify(noJob.body));
    assert.equal(noJob.body.sources[0].status,'unavailable');assert.equal(noJob.body.sources[0].lastFullSyncAt,null);
    await pool.query(`INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,status,generation_id)
      SELECT 'source-test-success',id,installation_version,'SUCCEEDED',$2 FROM mirror.shops WHERE id=$1`,[shopId,generationId]);
    const healthy=(await get({},sourcesPath)).body;
    assert.equal(healthy.sources[0].status,'healthy');assert.ok(healthy.sources[0].lastFullSyncAt);
    assert.equal((await get({},sourcesPath)).body.sources[0].lastFullSyncAt,healthy.sources[0].lastFullSyncAt);
    assert.ok(healthy.sources.slice(1).every(source=>source.status==='unavailable'&&source.supported===false&&source.lastFullSyncAt===null));
    await pool.query(`INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,status,created_at)
      SELECT 'source-test-failure',id,installation_version,'FAILED',clock_timestamp()+interval '1 second' FROM mirror.shops WHERE id=$1`,[shopId]);
    assert.equal((await get({},sourcesPath)).body.sources[0].status,'failed');
    await pool.query(`DELETE FROM mirror.catalog_import_jobs WHERE shop_id=$1 AND id IN ('source-test-success','source-test-failure','source-test-prior')`,[shopId]);
    session.scope = "";
    assert.equal((await get({},'/api/catalog/capabilities')).response.status,403);
    assert.equal((await get({},sourcesPath)).response.status,403);
    assert.equal((await get({}, "/api/mirror/status")).response.status,403);
    assert.equal((await get()).response.status, 403);
    session.scope = "read_products";
    session.isOnline=true;session.onlineAccessInfo={associated_user:{id:77},associated_user_scope:'read_orders'};
    assert.equal((await get()).response.status,403);
    assert.equal((await get({},sourcesPath)).response.status,403);
    assert.equal((await get({},'/api/catalog/capabilities')).response.status,403);
    session.onlineAccessInfo.associated_user_scope='read_products';
    assert.equal((await get()).response.status,200);
    session.isOnline=false;delete session.onlineAccessInfo;
    const changed = await pool.query("UPDATE mirror.shops SET uninstalled_at=now() WHERE id=$1 RETURNING id", [shopId]);
    assert.equal(changed.rowCount, 1);
    try { assert.equal((await get()).response.status, 403);assert.equal((await get({},sourcesPath)).response.status,403);assert.equal((await get({},'/api/catalog/capabilities')).response.status,403); }
    finally { await pool.query("UPDATE mirror.shops SET uninstalled_at=NULL WHERE id=$1", [shopId]); }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await tenantReadPool.end();await pool.query('DROP OWNED BY catalog_http_reader');await pool.query('DROP ROLE catalog_http_reader');
    await enginePool.end();await pool.query('DROP OWNED BY catalog_http_engine');await pool.query('DROP ROLE catalog_http_engine');
  }
}
