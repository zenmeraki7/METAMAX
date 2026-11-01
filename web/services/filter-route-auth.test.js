import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createFiltersRouter } from "../routes/filters.routes.js";
import { createShopifyAuthMiddleware } from "../middleware/shopify-auth.js";

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

for (const mode of ["missing", "forged", "late", "denied", "swapped", "valid"]) {
  test(`filter router enforces Shopify request verification: ${mode}`, async () => {
    const app = express(), calls = [];
    const session = { id: "verified", shop: "owner.myshopify.com", accessToken: "stored-token",isOnline:false };
    const guard = createShopifyAuthMiddleware({ shopify: {
      validateAuthenticatedSession: () => (_req, res, next) => {
        calls.push("verify");
        if (mode === "denied") return res.sendStatus(401);
        res.locals.shopify = { session: { ...session } };
        next();
      },
    } });
    if (["valid", "denied", "swapped"].includes(mode)) app.use(guard);
    if (mode === "swapped") app.use((_req, res, next) => {
      res.locals.shopify.session.shop = "attacker.myshopify.com";
      next();
    });
    if (mode === "forged") app.use((_req, res, next) => {
      res.locals.shopify = { session };
      next();
    });
    app.use(createFiltersRouter({ runtime: {
      capture(_req, _res, next) { calls.push("capture"); next(); },
      search(_req, res) { calls.push("search"); res.json({ data: [] }); },
    } }));
    if (mode === "late") app.use(guard);
    await withServer(app, async base => {
      const response = await fetch(`${base}/search`, { method: "POST",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(response.status, mode === "valid" ? 200 : 401);
      assert.deepEqual(calls, mode === "valid" ? ["verify", "capture", "search"]
        : ["denied", "swapped"].includes(mode) ? ["verify"] : []);
      if (mode !== "valid") {
        // Authentication must win even over malformed JSON.
        assert.equal((await fetch(`${base}/search`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: "{" })).status, 401);
      }
    });
  });
}

test("unavailable filter runtime still rejects requests without Shopify verification", async () => {
  const app = express();
  app.use(createFiltersRouter());
  await withServer(app, async base => {
    assert.equal((await fetch(`${base}/search`, { method: "POST" })).status, 401);
  });
});
