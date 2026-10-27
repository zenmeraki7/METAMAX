import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Session } from "@shopify/shopify-api";
import express from "express";

if (process.env.RUN_INTEGRATION_TESTS !== "1")
  throw new Error("Run with npm test");
const { prisma } = await import("../db/client.js");
const { sessionStorage } = await import("../session-storage.js");
const { persistOfflineInstallation } = await import(
  "../domains/lifecycle/offline-session.js"
);
const { processLifecycle, shopHash, registerShopInTransaction } = await import(
  "../domains/lifecycle/lifecycle.repository.js"
);
const { recordProductWebhook } = await import(
  "../domains/webhooks/webhooks.repository.js"
);
const { createWebhookRouter } = await import(
  "../domains/webhooks/webhooks.routes.js"
);
const { repairShopRegistrations } = await import(
  "../workers/registration-repair.js"
);
const { reconcileQueue } = await import("../queues/reconcile.queue.js");

const shops = [];
const fixtureShop = () => {
  const shop = `test-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  return shop;
};
const offline = (shop) =>
  new Session({
    id: `offline_${shop}`,
    shop,
    isOnline: false,
    state: "test",
    scope: "read_products",
    accessToken: "test-offline-token",
  });
const input = (shop) => ({
  id: randomUUID(),
  shop,
  topic: "products/update",
  productId: "gid://shopify/Product/321",
  eventId: randomUUID(),
  payloadHash: "d".repeat(64),
  triggeredAt: new Date(),
});
const secret = "installation-test-secret-only";
let server,
  base,
  queued = 0;
before(async () => {
  process.env.SHOPIFY_API_SECRET = secret;
  const app = express();
  app.use(
    "/api/webhooks/catalog",
    createWebhookRouter({
      enqueue: async () => {
        queued++;
      },
    })
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/webhooks/catalog`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const shop of shops) {
    await prisma.shop.deleteMany({ where: { domain: shop } });
    await prisma.$executeRaw`DELETE FROM "shopify_sessions" WHERE "shop"=${shop}`;
    await prisma.installationState.deleteMany({
      where: { shopHash: shopHash(shop) },
    });
    await prisma.lifecycleReceipt.deleteMany({
      where: { shopHash: shopHash(shop) },
    });
  }
  await sessionStorage.disconnect();
  await reconcileQueue.close();
  await prisma.$disconnect();
});
async function send(shop, id = randomUUID()) {
  const body = '{"id":321}';
  return fetch(base, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-shopify-shop-domain": shop,
      "x-shopify-topic": "products/update",
      "x-shopify-webhook-id": id,
      "x-shopify-event-id": id,
      "x-shopify-triggered-at": "2026-10-25T00:00:00Z",
      "x-shopify-hmac-sha256": createHmac("sha256", secret)
        .update(body)
        .digest("base64"),
    },
  });
}

test("offline persistence registers Shop and sync state before the first webhook, without an OAuth callback", async () => {
  const shop = fixtureShop();
  assert.equal(await sessionStorage.storeSession(offline(shop)), true);
  const merchant = await prisma.shop.findUnique({ where: { domain: shop } });
  const state = await prisma.catalogSyncState.findUnique({ where: { shop } });
  assert.equal(state.status, "PENDING");
  assert.ok(merchant.activeRunId);
  assert.equal((await prisma.snapshotRun.findUnique({ where: { id: merchant.activeRunId } })).status, "PENDING");
  assert.equal(state.generation, merchant.generation);
  assert.equal(
    (await sessionStorage.loadSession(`offline_${shop}`)).accessToken,
    "test-offline-token"
  );
  assert.equal((await send(shop)).status, 200);
});

test("repeated registration preserves installation identity, dates, and sync progress", async () => {
  const shop = fixtureShop();
  await sessionStorage.storeSession(offline(shop));
  const first = await prisma.shop.findUnique({ where: { domain: shop } });
  await prisma.catalogSyncState.update({
    where: { shop },
    data: { status: "RUNNING" },
  });
  await sessionStorage.storeSession(offline(shop));
  const second = await prisma.shop.findUnique({ where: { domain: shop } });
  assert.equal(second.generation, first.generation);
  assert.equal(second.installedAt.getTime(), first.installedAt.getTime());
  assert.equal(
    (await prisma.catalogSyncState.findUnique({ where: { shop } })).status,
    "RUNNING"
  );
});

test("session, registration, and sync initialization roll back together on failure", async () => {
  const shop = fixtureShop();
  await assert.rejects(
    persistOfflineInstallation(offline(shop), {
      initialize: async (tx, domain) => {
        await registerShopInTransaction(tx, domain);
        throw new Error("initialization failure");
      },
    }),
    /initialization failure/
  );
  assert.equal(await sessionStorage.loadSession(`offline_${shop}`), undefined);
  assert.equal(await prisma.shop.count({ where: { domain: shop } }), 0);
  assert.equal(await prisma.catalogSyncState.count({ where: { shop } }), 0);
  assert.equal(
    await prisma.installationState.count({
      where: { shopHash: shopHash(shop) },
    }),
    0
  );
});

test("online and invalid offline sessions cannot create installations", async () => {
  const shop = fixtureShop();
  await sessionStorage.storeSession(
    new Session({
      id: `online_${shop}`,
      shop,
      isOnline: true,
      state: "test",
      accessToken: "test",
    })
  );
  assert.equal(await prisma.shop.count({ where: { domain: shop } }), 0);
  const invalid = offline(shop);
  invalid.accessToken = "";
  await assert.rejects(
    sessionStorage.storeSession(invalid),
    /valid authenticated offline/
  );
  assert.equal(await sessionStorage.loadSession(`offline_${shop}`), undefined);
});

test("registration in flight returns 503; the retry is accepted only after the atomic commit", async () => {
  const shop = fixtureShop();
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const pending = persistOfflineInstallation(offline(shop), {
    initialize: async (tx, domain) => {
      await registerShopInTransaction(tx, domain);
      started();
      await gate;
    },
  });
  const id = randomUUID();
  try {
    await ready;
    assert.equal((await send(shop, id)).status, 503);
    assert.equal(await prisma.webhookEvent.count({ where: { id } }), 0);
  } finally {
    release();
    await pending;
  }
  assert.equal((await send(shop, id)).status, 200);
});

test("missing installed Shop is diagnosed, repaired from its offline session, and then accepted", async () => {
  const shop = fixtureShop();
  await sessionStorage.storeSession(offline(shop));
  const generation = (await prisma.shop.findUnique({ where: { domain: shop } }))
    .generation;
  await prisma.shop.delete({ where: { domain: shop } });
  await assert.rejects(
    recordProductWebhook(input(shop)),
    (error) =>
      error.code === "SHOP_REGISTRATION_MISSING" && error.statusCode === 503
  );
  assert.equal((await send(shop)).status, 503);
  await repairShopRegistrations();
  assert.equal(
    (await prisma.shop.findUnique({ where: { domain: shop } })).generation,
    generation
  );
  assert.equal(
    (await prisma.catalogSyncState.findUnique({ where: { shop } })).status,
    "PENDING"
  );
  assert.equal((await send(shop)).status, 200);
});

test("confirmed uninstall and redaction return 200 without receipts, revisions, or resurrection", async () => {
  const shop = fixtureShop();
  await sessionStorage.storeSession(offline(shop));
  await processLifecycle({
    id: randomUUID(),
    shop,
    topic: "app/uninstalled",
    payloadHash: "e".repeat(64),
    triggeredAt: new Date(Date.now() + 1),
  });
  const initial = queued;
  assert.equal((await send(shop)).status, 200);
  assert.equal(await prisma.webhookEvent.count({ where: { shop } }), 0);
  assert.equal(await prisma.catalogChange.count({ where: { shop } }), 0);
  await prisma.$executeRaw`INSERT INTO "shopify_sessions" ("id","shop","state","isOnline","accessToken") VALUES (${`offline_${shop}`},${shop},'test',false,'stale-test-token')`;
  await repairShopRegistrations();
  assert.equal(
    (await prisma.shop.findUnique({ where: { domain: shop } })).status,
    "UNINSTALLED"
  );
  await processLifecycle({
    id: randomUUID(),
    shop,
    topic: "shop/redact",
    payloadHash: "f".repeat(64),
    triggeredAt: new Date(),
  });
  assert.equal((await send(shop)).status, 200);
  assert.equal(await prisma.shop.count({ where: { domain: shop } }), 0);
  assert.equal(queued, initial);
});

test("unknown shops without a persisted installation remain retryable and are not auto-registered", async () => {
  const shop = fixtureShop();
  await assert.rejects(
    recordProductWebhook(input(shop)),
    (error) => error.code === "SHOP_REGISTRATION_PENDING"
  );
  assert.equal((await send(shop)).status, 503);
  assert.equal(await prisma.shop.count({ where: { domain: shop } }), 0);
});
