import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import express from "express";

if (process.env.RUN_INTEGRATION_TESTS !== "1")
  throw new Error("Run integration tests with npm run test:integration");
const { prisma } = await import("../db/client.js");
const { createWebhookRouter } = await import(
  "../domains/webhooks/webhooks.routes.js"
);
const { recordProductWebhook, completeProductReconciliation: completeRaw } =
  await import("../domains/webhooks/webhooks.repository.js");
const { scanDirtyChanges } = await import("../workers/reconcile.scanner.js");
const { processReconciliationJob, createReconcileWorker } = await import(
  "../workers/reconcile.worker.js"
);
const { reconcileQueue } = await import("../queues/reconcile.queue.js");
const { writeCurrentProduct } = await import(
  "../domains/products/products.service.js"
);

const shop = `test-${randomUUID()}.myshopify.com`;
const productId = "gid://shopify/Product/123";
const secret = "integration-test-secret-only";
const delivery = (id = randomUUID(), product = productId) => ({
  id,
  shop,
  productId: product,
  topic: "products/update",
  eventId: id,
  payloadHash: "a".repeat(64),
  triggeredAt: new Date("2026-10-25T00:00:00Z"),
});
let server,
  base,
  received = 0,
  injectedError,
  generation;
const completeProductReconciliation = (input, writer) =>
  completeRaw({ generation, ...input }, writer);
before(async () => {
  process.env.SHOPIFY_API_SECRET = secret;
  process.env.SHOPIFY_WEBHOOK_BODY_LIMIT = "1kb";
  generation = (
    await prisma.shop.create({
      data: { domain: shop },
    })
  ).generation;
  const snapshot = await prisma.snapshotRun.create({
    data: {
      shop,
      generation,
      status: "COMPLETED",
      expectedProducts: 0,
      importedProducts: 0,
      completedAt: new Date(),
    },
  });
  await prisma.shop.update({
    where: { domain: shop },
    data: { activeSnapshotId: snapshot.id },
  });
  const app = express();
  app.use(
    "/api/webhooks/catalog",
    createWebhookRouter({
      record: async (input) => {
        received++;
        if (injectedError) throw injectedError;
        return recordProductWebhook(input);
      },
      enqueue: async () => {
        throw new Error("simulated Redis outage after commit");
      },
    })
  );
  // A broader webhook handler and embedded-app authentication must not consume
  // catalog requests. The ordinary parser must see only non-webhook requests.
  app.use("/api/webhooks", (_req, res) => res.sendStatus(418));
  app.use("/api", (_req, res) => res.sendStatus(401));
  app.use(express.json({ limit: "1mb" }));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}/api/webhooks/catalog`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.shop.deleteMany({ where: { domain: shop } });
  await reconcileQueue.close();
  const { syncQueue } = await import("../queues/sync.queue.js");
  await syncQueue.close();
  await prisma.$disconnect();
});

async function send({ body = '{"id":123}', headers = {}, remove = [] } = {}) {
  const id = randomUUID();
  const h = {
    "content-type": "application/json",
    "x-shopify-hmac-sha256": createHmac("sha256", secret)
      .update(body)
      .digest("base64"),
    "x-shopify-shop-domain": shop,
    "x-shopify-topic": "products/update",
    "x-shopify-webhook-id": id,
    "x-shopify-event-id": id,
    "x-shopify-triggered-at": "2026-10-25T00:00:00Z",
    ...headers,
  };
  for (const key of remove) delete h[key];
  return fetch(base, { method: "POST", headers: h, body });
}

test("new delivery commits despite Redis failure; exact duplicate is idempotent; collision rolls back", async () => {
  const id = randomUUID();
  const headers = { "x-shopify-webhook-id": id, "x-shopify-event-id": id };
  assert.equal((await send({ headers })).status, 200);
  assert.equal((await send({ headers })).status, 200);
  assert.equal((await send({ headers, body: '{"id":456}' })).status, 409);
  const change = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  assert.equal(change.revision, 1n);
  assert.equal(change.dirty, true);
  assert.equal(await prisma.webhookEvent.count({ where: { id } }), 1);
});

test("invalid requests never reach persistence", async () => {
  const initial = received;
  const scenarios = [
    [{ headers: { "x-shopify-hmac-sha256": "bad" } }, 401],
    [{ remove: ["x-shopify-hmac-sha256"] }, 401],
    [{ remove: ["x-shopify-webhook-id"] }, 400],
    [{ body: '{"id":-1}' }, 400],
    [
      { body: '{"id":123,"admin_graphql_api_id":"gid://shopify/Product/456"}' },
      400,
    ],
    [{ body: '{"id":' }, 400],
    [{ body: JSON.stringify({ id: 123, padding: "x".repeat(2000) }) }, 413],
    [{ headers: { "content-type": "text/plain" } }, 415],
    [{ headers: { "content-encoding": "gzip" } }, 415],
  ];
  for (const [input, expected] of scenarios)
    assert.equal((await send(input)).status, expected);
  delete process.env.SHOPIFY_API_SECRET;
  assert.equal((await send()).status, 503);
  process.env.SHOPIFY_API_SECRET = secret;
  assert.equal(received, initial);
});

test("database outage is retryable and does not return 200", async () => {
  injectedError = new Error("simulated Neon outage");
  assert.equal((await send()).status, 500);
  injectedError.code = "P1001";
  assert.equal((await send()).status, 503);
  injectedError = null;
});

test("scanner recovers durable work without an enqueue and respects retry eligibility", async () => {
  const due = [];
  await scanDirtyChanges({
    enqueue: async (...args) => due.push(args),
    batchSize: 1,
  });
  assert.ok(due.some(([domain, id]) => domain === shop && id === productId));
  await prisma.catalogChange.update({
    where: { shop_productId: { shop, productId } },
    data: { nextAttemptAt: new Date(Date.now() + 60000) },
  });
  const future = [];
  await scanDirtyChanges({ enqueue: async (...args) => future.push(args) });
  assert.ok(!future.some(([domain]) => domain === shop));
  await prisma.catalogChange.update({
    where: { shop_productId: { shop, productId } },
    data: { nextAttemptAt: new Date(0) },
  });
});

test("mirror failure rolls back acknowledgment; superseded workers cannot overwrite newer data", async () => {
  await assert.rejects(
    completeProductReconciliation(
      { shop, productId, observedRevision: 1n, product: { id: productId } },
      async () => {
        throw new Error("mirror failure");
      }
    )
  );
  let change = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  assert.equal(change.dirty, true);
  assert.equal(change.appliedRevision, 0n);
  await recordProductWebhook(delivery());
  assert.equal(
    await completeProductReconciliation({
      shop,
      productId,
      observedRevision: 1n,
      product: null,
    }),
    false
  );
  assert.equal(
    await completeProductReconciliation({
      shop,
      productId,
      observedRevision: 2n,
      product: { id: productId, title: "Newest", variants: [] },
    }),
    true
  );
  const mirror = await prisma.productMirror.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  assert.equal(mirror.data.title, "Newest");
  assert.equal(mirror.revision, 2n);
  assert.equal(
    await completeProductReconciliation({
      shop,
      productId,
      observedRevision: 2n,
      product: null,
    }),
    false
  );
});

test("concurrent duplicate receipts increment exactly once", async () => {
  const input = delivery();
  const results = await Promise.all([
    recordProductWebhook(input),
    recordProductWebhook(input),
    recordProductWebhook(input),
  ]);
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  const change = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  assert.equal(change.revision, 3n);
});

test("worker writes the mirror by default and handles a confirmed deletion", async () => {
  assert.equal(
    (
      await processReconciliationJob(
        { shop, productId },
        { fetchProduct: async () => ({ id: productId, title: "Saved", variants: [] }) }
      )
    ).status,
    "reconciled"
  );
  await recordProductWebhook(delivery());
  assert.equal(
    (
      await processReconciliationJob(
        { shop, productId },
        { fetchProduct: async () => null }
      )
    ).status,
    "reconciled"
  );
  assert.equal(
    await prisma.productMirror.count({ where: { shop, productId } }),
    0
  );
  await assert.rejects(
    completeProductReconciliation({ shop, productId, observedRevision: 4n }),
    /explicit null/
  );
});

test("worker failures persist exponential backoff and eventually enter dead letter", async () => {
  await recordProductWebhook(delivery());
  for (let attempt = 0; attempt < 8; attempt++) {
    await prisma.catalogChange.update({
      where: { shop_productId: { shop, productId } },
      data: { nextAttemptAt: new Date(0) },
    });
    await assert.rejects(
      processReconciliationJob(
        { shop, productId },
        {
          fetchProduct: async () => {
            throw new Error("upstream failure");
          },
        }
      )
    );
  }
  const change = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  assert.equal(change.attempts, 8);
  assert.ok(change.deadLetterAt);
  assert.equal(change.dirty, true);
  assert.equal(
    (await processReconciliationJob({ shop, productId })).reason,
    "not-due"
  );
});

test("BullMQ worker plus scanner recovers a commit that never enqueued", async () => {
  await recordProductWebhook(delivery());
  const worker = createReconcileWorker({
    startRepairScheduler: false,
    fetchProduct: async () => ({
      id: productId,
      title: "Recovered after crash",
      variants: [],
    }),
  });
  try {
    await worker.waitUntilReady();
    await scanDirtyChanges();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const row = await prisma.catalogChange.findUnique({
        where: { shop_productId: { shop, productId } },
      });
      if (!row.dirty) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const row = await prisma.catalogChange.findUnique({
      where: { shop_productId: { shop, productId } },
    });
    assert.equal(row.dirty, false);
    assert.equal(
      (
        await prisma.productMirror.findUnique({
          where: { shop_productId: { shop, productId } },
        })
      ).data.title,
      "Recovered after crash"
    );
  } finally {
    await worker.close();
  }
});

test("field-filtered create, update, and delete payloads preserve exact numeric product identity", async () => {
  const numeric = "900719925474099312345";
  const filteredId = `gid://shopify/Product/${numeric}`;
  for (const [topic, body] of [
    [
      "products/create",
      `{"id":${numeric},"updated_at":"2026-10-25T01:00:00Z"}`,
    ],
    [
      "products/update",
      `{"id":${numeric},"updated_at":"2026-10-25T01:01:00Z"}`,
    ],
    ["products/delete", `{"id":${numeric}}`],
  ]) {
    assert.equal(
      (await send({ body, headers: { "x-shopify-topic": topic } })).status,
      200
    );
  }
  const change = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop, productId: filteredId } },
  });
  assert.equal(change.revision, 3n);
  assert.equal(change.dirty, true);
  assert.equal(
    await prisma.webhookEvent.count({
      where: { shop, resourceId: filteredId },
    }),
    3
  );
});

test("2048-variant mirror writes remain fenced and roll back with revision acknowledgment", async () => {
  const fullId = "gid://shopify/Product/555";
  const current = {
    product: {
      id: fullId,
      title: "Original",
      updatedAt: "2026-10-25T00:00:00Z",
      variantsCount: { count: 2048, precision: "EXACT" },
    },
    variants: Array.from({ length: 2048 }, (_, index) => ({
      id: `gid://shopify/ProductVariant/${index + 1}`,
      __parentId: fullId,
      position: index + 1,
      price: "9007199254740993.123456",
      compareAtPrice: null,
    })),
  };
  await recordProductWebhook(delivery(randomUUID(), fullId));
  assert.equal(
    await completeProductReconciliation({
      shop,
      productId: fullId,
      observedRevision: 1n,
      product: current,
    }),
    true
  );
  const stored = () =>
    prisma.productMirror.findUnique({
      where: { shop_productId: { shop, productId: fullId } },
    });
  assert.equal((await stored()).data.variants.length, 2048);
  assert.equal(
    (await stored()).data.variants[2047].price,
    "9007199254740993.123456"
  );
  await recordProductWebhook(delivery(randomUUID(), fullId));
  await recordProductWebhook(delivery(randomUUID(), fullId));
  current.product.title = "Newest";
  assert.equal(
    await completeProductReconciliation({
      shop,
      productId: fullId,
      observedRevision: 2n,
      product: current,
    }),
    false
  );
  await assert.rejects(
    completeProductReconciliation(
      { shop, productId: fullId, observedRevision: 3n, product: current },
      async (tx, value) => {
        await writeCurrentProduct(tx, shop, fullId, 3n, value);
        throw new Error("simulated failure after complete variant replacement");
      }
    )
  );
  assert.equal((await stored()).data.title, "Original");
  const dirty = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop, productId: fullId } },
  });
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.appliedRevision, 1n);
  assert.equal(
    await completeProductReconciliation({
      shop,
      productId: fullId,
      observedRevision: 3n,
      product: current,
    }),
    true
  );
  assert.equal((await stored()).data.title, "Newest");
});

test("catalog route keeps exact signed bytes and precedes broader webhook/auth middleware", async () => {
  const body = '{\n  "id": 789, "title": "Café"\n}\n';
  assert.equal((await send({ body })).status, 200);
  assert.equal(
    (await fetch(base.replace("/webhooks/catalog", "/products"))).status,
    401
  );
  assert.equal(
    (await fetch(base.replace("/catalog", ""), { method: "POST" })).status,
    418
  );
});
