import {createInstallationResolver} from '../security/installation-lifecycle.server.js';
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createCatalogRouter } from "../routes/catalog.routes.js";
import { createCatalogImportRouter } from "../routes/catalog-import.routes.js";
import { createFilterAuthentication } from "../middleware/filter-auth.server.js";
import { createShopifyAuthMiddleware } from "../middleware/shopify-auth.js";

const id = "12345678-1234-4234-9234-123456789abc";
const importRequests = [
  ["POST", "/", "enqueue"], ["GET", "/", "current"],
  ["GET", `/${id}`, "status"], ["POST", `/${id}/cancel`, "cancel"],
];
const catalogRequests = [
  ["GET", "/products", "queryProducts"], ["GET", "/status", "queryStatus"],
  ["GET", "/count", "queryCount"],
];

async function withRouter(kind, mode, callback) {
  const calls = [];
  const session = { id: "session", shop: "owner.myshopify.com", accessToken: "stored-token",isOnline:false };
  let stored = session;
  const authentication = createFilterAuthentication({
    resolveInstallation:createInstallationResolver({readInstallation:async()=>({installation_version:"test-installation"})}),
    sessionStorage: { async loadSession() { return stored; } },
  });
  const app = express();
  if (mode === "forged") {
    // A plausible res.locals session without Shopify verification/capture is
    // insufficient, even when the router is mounted independently.
    app.use((_req, res, next) => { res.locals.shopify = { session }; next(); });
  } else {
    app.use(createShopifyAuthMiddleware({ shopify: {
      validateAuthenticatedSession: () => (_req, res, next) => {
        if (mode === "denied") return res.sendStatus(401);
        res.locals.shopify = { session };
        next();
      },
    } }));
    app.use(authentication.capture);
    app.use((_req, _res, next) => {
      if (mode === "revoked") stored = undefined;
      if (mode === "expired") stored = { ...session, expires: new Date(0) };
      if (mode === "changed-shop") stored = { ...session, shop: "attacker.myshopify.com" };
      next();
    });
  }
  app.use(express.json());
  const methods = kind === "import" ? importRequests : catalogRequests;
  const service = Object.fromEntries(methods.map(([, , action]) => [action, async (...args) => {
    if (kind === "import") {
      assert.equal(args[0], stored);
      if (["status", "cancel"].includes(action)) assert.equal(args[1], id);
    } else {
      assert.equal(await authentication.resolveShop(args[0].authContext), session.shop);
    }
    calls.push(action);
    return { id };
  }]));
  app.use(kind === "import"
    ? createCatalogImportRouter({ service, authentication })
    : createCatalogRouter({ catalogQueryService: service, authentication, logger: {} }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("catalog routers reject missing or malformed authentication dependencies", () => {
  for (const authentication of [undefined, null, {}, { authenticate: true }]) {
    assert.throws(() => createCatalogRouter({ authentication }), /authentication is required/);
    assert.throws(() => createCatalogImportRouter({ authentication }), /authentication is required/);
  }
  assert.throws(() => createCatalogImportRouter({ authentication: { authenticate() {} } }), /authentication is required/);
});

for (const kind of ["import", "catalog"]) {
  const requests = kind === "import" ? importRequests : catalogRequests;
  for (const mode of ["forged", "denied", "revoked", "expired", "changed-shop"]) {
    test(`${kind} endpoints block ${mode} authentication before business services`, async () => {
      await withRouter(kind, mode, async (base, calls) => {
        for (const [method, path] of requests) {
          const response = await fetch(`${base}${path}?shop=attacker.myshopify.com`, { method });
          assert.ok([401, 403].includes(response.status), `${path}: ${response.status}`);
        }
        assert.deepEqual(calls, []);
      });
    });
  }
  test(`${kind} endpoints accept the verified owner session`, async () => {
    await withRouter(kind, "valid", async (base, calls) => {
      for (const [method, path, action] of requests) {
        const response = await fetch(`${base}${path}`, { method });
        assert.equal(response.status, action === "enqueue" ? 202 : 200);
      }
      assert.deepEqual(calls, requests.map(([, , action]) => action));
    });
  });
}

test("import authentication precedes request validation; invalid requests never invoke services", async () => {
  for (const mode of ["forged", "valid"]) {
    await withRouter("import", mode, async (base, calls) => {
      const response = await fetch(`${base}/invalid-id/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: "attacker.myshopify.com" }),
      });
      assert.equal(response.status, mode === "valid" ? 400 : 401);
      assert.deepEqual(calls, []);
    });
  }
});
