import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { CatalogImportError, IMPORT_ERROR_CODES as C } from "./catalog-import-errors.server.js";
import { createCatalogImportRouter } from "../routes/catalog-import.routes.js";
import { createCatalogImportService } from "./catalog-import.server.js";

const cases = [
  [new CatalogImportError(C.UNAUTHENTICATED), 401, C.UNAUTHENTICATED],
  [new CatalogImportError(C.FORBIDDEN), 403, C.FORBIDDEN],
  [new CatalogImportError(C.INVALID_REQUEST), 400, C.INVALID_REQUEST],
  [new CatalogImportError(C.NOT_FOUND), 404, C.NOT_FOUND],
  [new CatalogImportError(C.UNAVAILABLE), 503, C.UNAVAILABLE],
  [new Error("session installation dependency secret"), 500, C.INTERNAL],
  [Object.assign(new Error("session storage failed"), { code: "ECONNRESET" }), 503, C.UNAVAILABLE],
  [Object.assign(new Error("installation database unavailable"), { code: "57P03" }), 503, C.UNAVAILABLE],
  [{ code: C.FORBIDDEN, message: "untyped failure" }, 500, C.INTERNAL],
  [null, 500, C.INTERNAL],
];

test("import HTTP failures use stable types and codes in both authentication and service phases", async () => {
  for (const phase of ["authentication", "service"]) {
    let failure;
    const app = express();
    app.use(createCatalogImportRouter({
      authentication: {
        async authenticate() { if (phase === "authentication") throw failure; return {}; },
        async resolveSession() { return { shop: "owner.myshopify.com" }; },
      },
      service: { async current() { throw failure; } },
    }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    try {
      for (const [error, status, code] of cases) {
        failure = error;
        const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { error: code });
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

function serviceFixture({ stored, queryError } = {}) {
  return createCatalogImportService({
    database: { async connect() { if(queryError)throw queryError; return {async query(){return {rows:[]};},release(){}}; },
      async query() { if (queryError) throw queryError; return { rows: [] }; } },
    shopify: { config: { sessionStorage: { async loadSession() { return stored; } } } },
  });
}

test("import service emits typed credential, scope, and dependency failures", async () => {
  const session = { id: "stored", shop: "owner.myshopify.com", accessToken: "token", scope: "read_products" };
  for (const [stored, expected] of [
    [undefined, C.UNAUTHENTICATED],
    [{ ...session, shop: "other.myshopify.com" }, C.UNAUTHENTICATED],
    [{ ...session, expires: new Date(0) }, C.UNAUTHENTICATED],
    [{ ...session, scope: "" }, C.FORBIDDEN],
  ]) {
    const service = serviceFixture({ stored });
    for (const action of ["enqueue", "current", "status", "cancel"]) {
      await assert.rejects(() => service[action](session, "id"), error =>
        error instanceof CatalogImportError && error.code === expected);
    }
  }
  for (const [queryError, expected] of [
    [Object.assign(new Error("session database failed"), { code: "ECONNREFUSED" }), C.UNAVAILABLE],
    [new Error("installation bug"), C.INTERNAL],
  ]) {
    await assert.rejects(() => serviceFixture({ stored: session, queryError }).status(session, "12345678-1234-4234-9234-123456789abc"),
      error => error instanceof CatalogImportError && error.code === expected);
  }
});

test("imports absent from the authenticated shop return 404 for status and cancellation", async () => {
  const app = express();
  app.use(createCatalogImportRouter({
    authentication: { async authenticate() { return {}; }, async resolveSession() { return {}; } },
    service: { async status() { return null; }, async cancel() { return null; } },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/12345678-1234-4234-9234-123456789abc`;
  try {
    for (const [url, method] of [[base, "GET"], [`${base}/cancel`, "POST"]]) {
      const response = await fetch(url, { method });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: C.NOT_FOUND });
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test("import service rejects malformed IDs before opening job queries or transactions", async () => {
  const session = { id: "stored", shop: "owner.myshopify.com", accessToken: "token", scope: "read_products" };
  const service = createCatalogImportService({
    database: { query() { assert.fail("Invalid ID reached SQL"); }, connect() { assert.fail("Invalid ID opened transaction"); } },
    shopify: { config: { sessionStorage: { async loadSession() { return session; } } } },
  });
  for (const action of ["status", "cancel"]) {
    for (const value of [undefined, null, {}, "-".repeat(36), "12345678-1234-1234-1234-123456789abc"]) {
      await assert.rejects(() => service[action](session, value), error =>
        error instanceof CatalogImportError && error.code === C.INVALID_REQUEST);
    }
  }
});

test("valid UUIDs never bypass the import service's stored-session shop predicates", async () => {
  const id = "12345678-1234-4234-9234-123456789abc";
  const owner = { id: "owner-session", shop: "owner.myshopify.com", accessToken: "token", scope: "read_products" };
  const other = { ...owner, id: "other-session", shop: "other.myshopify.com" };
  const row = { id, shop_id: owner.shop, status: "QUEUED", cancel_requested: false };
  let reads = 0, writes = 0;
  const database = {
    async query(sql, values) {
      if (!sql.includes("mirror.catalog_import_jobs")) return { rows: [] };
      // Check the actual service SQL and bindings, including both identities.
      assert.match(sql, /WHERE (?:j\.)?shop_id=\$1 AND (?:j\.)?id=\$2/);
      assert.equal(values[1], id);
      const matched = values[0] === row.shop_id;
      if (sql.startsWith("UPDATE")) {
        writes++;
        if (matched) row.cancel_requested = true;
      } else reads++;
      return { rows: matched ? [{ ...row }] : [] };
    },
    async connect() { return { query: database.query, release() {} }; },
  };
  const service = createCatalogImportService({ database,
    shopify: { config: { sessionStorage: { async loadSession(sessionId) {
      return [owner, other].find(session => session.id === sessionId);
    } } } },
  });
  assert.equal((await service.status(owner, id)).id, id);
  assert.equal(await service.status(other, id), undefined);
  assert.equal(await service.cancel(other, id), undefined);
  assert.equal(row.cancel_requested, false);
  assert.equal((await service.cancel(owner, id)).id, id);
  assert.equal(row.cancel_requested, true);
  assert.equal(reads, 2);
  assert.equal(writes, 2);
});
