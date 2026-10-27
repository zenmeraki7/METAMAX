import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import { createWebhookRouter } from "../domains/webhooks/webhooks.routes.js";
let record, enqueue, server, url, finished;
const secret = "test-webhook-boundary-secret";
const previousSecret = process.env.SHOPIFY_API_SECRET;
before(async () => {
  process.env.SHOPIFY_API_SECRET = secret;
  const app = express();
  app.use((req, res, next) => { finished = false; res.on("finish", () => { finished = true; }); next(); });
  app.use("/catalog", createWebhookRouter({ record: input => record(input), enqueue: (...args) => enqueue(...args) }));
  server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}/catalog`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  if (previousSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
  else process.env.SHOPIFY_API_SECRET = previousSecret;
});
function send({ signature, topic = "products/update", payload = { id: 123, title: "Stale webhook", variants: [] } } = {}) {
  const body = JSON.stringify(payload);
  return fetch(url, { method: "POST", signal: AbortSignal.timeout(5000), headers: {
    "content-type": "application/json", "x-shopify-topic": topic,
    "x-shopify-shop-domain": "example.myshopify.com", "x-shopify-webhook-id": "delivery-1",
    "x-shopify-event-id": "event-1", "x-shopify-triggered-at": "2026-10-26T00:00:00Z",
    "x-shopify-hmac-sha256": signature ?? createHmac("sha256", secret).update(body).digest("base64"),
  }, body });
}
test("HTTP acknowledgment waits for durable commit and the webhook payload is only an invalidation", async () => {
  let enter, commit, input, scheduled = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  record = current => { input = current; enter(); return new Promise(resolve => { commit = resolve; }); };
  enqueue = async () => { scheduled++; };
  const response = send(); await entered;
  assert.equal(finished, false); assert.equal(scheduled, 0);
  assert.equal(input.productId, "gid://shopify/Product/123");
  assert.equal(Object.hasOwn(input, "title"), false); assert.equal(Object.hasOwn(input, "variants"), false);
  commit({ duplicate: false, revision: "1" });
  assert.equal((await response).status, 200); assert.equal(scheduled, 1);
});
test("receipt failure cannot acknowledge success or schedule work", async () => {
  let scheduled = 0;
  record = async () => { throw Object.assign(Error("database unavailable"), { code: "P1001" }); };
  enqueue = async () => { scheduled++; };
  assert.equal((await send()).status, 503); assert.equal(scheduled, 0);
});
test("duplicate deliveries return success without scheduling another worker", async () => {
  let scheduled = 0;
  record = async () => ({ duplicate: true, revision: "1" }); enqueue = async () => { scheduled++; };
  assert.equal((await send()).status, 200); assert.equal((await send()).status, 200); assert.equal(scheduled, 0);
});
test("queue failure follows successful receipt and does not change the acknowledgment", async () => {
  record = async () => ({ duplicate: false, revision: "2" });
  enqueue = async () => { throw Error("Redis unavailable"); };
  assert.equal((await send({ topic: "products/delete" })).status, 200);
});
test("invalid signatures cannot reach persistence", async () => {
  let writes = 0;
  record = async () => { writes++; return {}; }; enqueue = async () => {};
  assert.equal((await send({ signature: "invalid" })).status, 401); assert.equal(writes, 0);
});
