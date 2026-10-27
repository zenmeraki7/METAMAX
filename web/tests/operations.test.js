import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import Redis from "ioredis";

if (process.env.RUN_INTEGRATION_TESTS !== "1")
  throw new Error("Run with npm run test:integration");
const { prisma } = await import("../db/client.js");
const { recordProductWebhook, completeProductReconciliation } = await import(
  "../domains/webhooks/webhooks.repository.js"
);
const { processLifecycle, registerShop, shopHash } = await import(
  "../domains/lifecycle/lifecycle.repository.js"
);
const { createRecoveryRouter } = await import(
  "../domains/recovery/recovery.routes.js"
);
const { createGraphqlBudget, closeGraphqlBudget } = await import(
  "../integrations/shopify/graphql-budget.js"
);
const { defaultFetchProduct } = await import("../workers/reconcile.worker.js");
const { redisConnection } = await import("../queues.js");
const { reconcileQueue } = await import("../queues/reconcile.queue.js");
const { runRetention } = await import("../workers/retention.js");

const shop = `test-${randomUUID()}.myshopify.com`;
const productId = "gid://shopify/Product/987";
const input = () => {
  const id = randomUUID();
  return {
    id,
    shop,
    productId,
    topic: "products/update",
    eventId: id,
    payloadHash: "b".repeat(64),
    triggeredAt: new Date(),
  };
};
const lifecycle = (topic, date = new Date(Date.now() + 1)) => ({
  id: randomUUID(),
  shop,
  topic,
  payloadHash: "c".repeat(64),
  triggeredAt: date,
});
const redis = new Redis({ ...redisConnection(), retryStrategy: () => null });
const namespace = `test-budget-${randomUUID()}`;
let server, base;
async function attachPublishedFixture() {
  const merchant = await prisma.shop.findUnique({ where: { domain: shop } });
  const snapshot = await prisma.snapshotRun.create({ data: { shop, generation: merchant.generation,
    status: "COMPLETED", expectedProducts: 0, importedProducts: 0,
    completedAt: new Date(Date.now() - 60 * 86400000) } });
  await prisma.shop.update({ where: { domain: shop }, data: { activeSnapshotId: snapshot.id } });
}

before(async () => {
  await registerShop(shop);
  // This fixture represents an already published installation; discard the
  // automatically reserved initial import before constructing its catalog.
  await prisma.shop.update({ where: { domain: shop }, data: { activeRunId: null } });
  await prisma.snapshotRun.deleteMany({ where: { shop } });
  await attachPublishedFixture();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.shopify = { session: { shop } };
    next();
  });
  app.use(
    createRecoveryRouter({
      enqueue: async () => {
        throw new Error("Redis down");
      },
    })
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await prisma.shop.deleteMany({ where: { domain: shop } });
  await prisma.installationState.deleteMany({
    where: { shopHash: shopHash(shop) },
  });
  await prisma.lifecycleReceipt.deleteMany({
    where: { shopHash: shopHash(shop) },
  });
  // The namespace is unique to this test run; no application Redis keys match it.
  const keys = await redis.keys(`${namespace}*`);
  if (keys.length) await redis.del(...keys);
  const budgetKeys = await redis.keys(
    `newmeta-gql:{${createHash("sha256").update(shop).digest("hex")}}:*`
  );
  if (budgetKeys.length) await redis.del(...budgetKeys);
  await closeGraphqlBudget();
  await redis.quit();
  await reconcileQueue.close();
  const { syncQueue } = await import("../queues/sync.queue.js");
  await syncQueue.close();
  await prisma.$disconnect();
});

test("independent worker budgets enforce shared per-shop concurrency", async () => {
  const budgets = [
    createGraphqlBudget({ client: redis, namespace, concurrency: 2 }),
    createGraphqlBudget({ client: redis, namespace, concurrency: 2 }),
  ];
  let active = 0,
    peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      budgets[index % 2](shop, async () => {
        active++;
        peak = Math.max(peak, active);
        await delay(35);
        active--;
        return {
          extensions: {
            cost: {
              actualQueryCost: 2,
              throttleStatus: {
                maximumAvailable: 1000,
                currentlyAvailable: 900,
                restoreRate: 100,
              },
            },
          },
        };
      })
    )
  );
  assert.equal(peak, 2);
});

test("uncertain requests spend their reservation and cost pressure prevents another request", async () => {
  const budget = createGraphqlBudget({
    client: redis,
    namespace: `${namespace}-cost`,
    concurrency: 2,
    capacity: 10,
    restoreRate: 1,
    reservedCost: 10,
    waitMs: 50,
  });
  await assert.rejects(
    budget(shop, async () => {
      throw new Error("network uncertainty");
    })
  );
  let requested = false;
  await assert.rejects(
    budget(shop, async () => {
      requested = true;
    }),
    /budget is busy/
  );
  assert.equal(requested, false);
});

test("mixed page and verification queries reserve their actual outstanding costs", async () => {
  const mixedNamespace = `${namespace}-mixed`;
  const budget = createGraphqlBudget({
    client: redis,
    namespace: mixedNamespace,
    capacity: 500,
    restoreRate: 1,
  });
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const page = budget(
    shop,
    async () => {
      started();
      await gate;
      return {
        extensions: {
          cost: {
            actualQueryCost: 200,
            throttleStatus: {
              maximumAvailable: 1000,
              currentlyAvailable: 250,
              restoreRate: 100,
            },
          },
        },
      };
    },
    { requestedCost: 400 }
  );
  try {
    await ready;
    await budget(
      shop,
      async () => ({
        extensions: {
          cost: {
            actualQueryCost: 1,
            throttleStatus: {
              maximumAvailable: 1000,
              currentlyAvailable: 300,
              restoreRate: 100,
            },
          },
        },
      }),
      { requestedCost: 10 }
    );
    const key = `${mixedNamespace}:{${createHash("sha256")
      .update(shop)
      .digest("hex")}}:budget`;
    assert.equal(Number(await redis.hget(key, "tokens")), 0);
  } finally {
    release();
    await page;
  }
});

test("dead letters are tenant-scoped and manual repair commits retry eligibility before queueing", async () => {
  await recordProductWebhook(input());
  await prisma.catalogChange.update({
    where: { shop_productId: { shop, productId } },
    data: { attempts: 8, deadLetterAt: new Date() },
  });
  const response = await fetch(`${base}/dead-letters`);
  const { changes } = await response.json();
  assert.equal(changes.length, 1);
  assert.equal(changes[0].productId, productId);
  const retry = () =>
    fetch(`${base}/repair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId, revision: "1" }),
    });
  assert.equal((await retry()).status, 202);
  assert.equal((await retry()).status, 409);
  const change = await prisma.catalogChange.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  assert.equal(change.dirty, true);
  assert.equal(change.deadLetterAt, null);
  assert.ok(change.nextAttemptAt);
  assert.equal(change.attempts, 0);
});

test("retention protects pending changes and active snapshots, then removes only eligible old rows", async () => {
  const old = new Date(Date.now() - 60 * 86400000);
  await prisma.webhookEvent.updateMany({
    where: { shop },
    data: { createdAt: old },
  });
  const active = await prisma.snapshotRun.create({
    data: {
      shop,
      status: "COMPLETED",
      completedAt: old,
      generation: (
        await prisma.shop.findUnique({ where: { domain: shop } })
      ).generation,
    },
  });
  const obsolete = await prisma.snapshotRun.create({
    data: {
      shop,
      status: "COMPLETED",
      completedAt: old,
      generation: (
        await prisma.shop.findUnique({ where: { domain: shop } })
      ).generation,
    },
  });
  await prisma.shop.update({
    where: { domain: shop },
    data: { activeRunId: active.id, activeSnapshotId: active.id },
  });
  await runRetention();
  assert.equal(await prisma.webhookEvent.count({ where: { shop } }), 1);
  assert.equal(await prisma.snapshotRun.count({ where: { shop } }), 3);
  const merchant = await prisma.shop.findUnique({ where: { domain: shop } });
  await completeProductReconciliation({
    shop,
    productId,
    generation: merchant.generation,
    observedRevision: 1n,
    product: { id: productId, variants: [] },
  });
  await runRetention();
  assert.equal(await prisma.webhookEvent.count({ where: { shop } }), 0);
  assert.equal(await prisma.snapshotRun.count({ where: { id: active.id } }), 1);
  assert.equal(
    await prisma.snapshotRun.count({ where: { id: obsolete.id } }),
    0
  );
});

test("uninstall deletes tenant data and sessions; reinstallation fences all prior worker results", async () => {
  await recordProductWebhook(input());
  const previous = await prisma.shop.findUnique({ where: { domain: shop } });
  await prisma.$executeRaw`INSERT INTO "shopify_sessions" ("id","shop","state","isOnline") VALUES (${`offline_${shop}`},${shop},'test',false)`;
  const event = lifecycle("app/uninstalled");
  assert.equal(
    await processLifecycle(event),
    "SHOP_DATA_DELETED_WORKERS_FENCED"
  );
  assert.equal(
    await processLifecycle(event),
    "SHOP_DATA_DELETED_WORKERS_FENCED"
  );
  assert.equal(await prisma.catalogChange.count({ where: { shop } }), 0);
  assert.equal(await prisma.productMirror.count({ where: { shop } }), 0);
  assert.equal(await prisma.snapshotRun.count({ where: { shop } }), 0);
  const sessions =
    await prisma.$queryRaw`SELECT "id" FROM "shopify_sessions" WHERE "shop"=${shop}`;
  assert.equal(sessions.length, 0);
  const installed = await registerShop(shop);
  await attachPublishedFixture();
  assert.notEqual(installed.generation, previous.generation);
  await recordProductWebhook(input());
  assert.equal(
    await completeProductReconciliation({
      shop,
      productId,
      generation: previous.generation,
      observedRevision: 1n,
      product: { id: productId, title: "Obsolete installation" },
    }),
    false
  );
  assert.equal(
    await processLifecycle(lifecycle("shop/redact")),
    "NEW_INSTALLATION_PRESERVED"
  );
  assert.equal(
    await processLifecycle(
      lifecycle("app/uninstalled", new Date(previous.installedAt))
    ),
    "STALE_OR_UNKNOWN_INSTALLATION"
  );
  assert.equal(await prisma.productMirror.count({ where: { shop } }), 0);
  assert.equal(
    (
      await prisma.catalogChange.findUnique({
        where: { shop_productId: { shop, productId } },
      })
    ).dirty,
    true
  );
});

test("default worker fetch requires a complete error-free response before accepting a deletion", async () => {
  const merchant = await prisma.shop.findUnique({ where: { domain: shop } });
  await prisma.$executeRaw`INSERT INTO "shopify_sessions" ("id","shop","state","isOnline","accessToken") VALUES (${`offline_${shop}`},${shop},'test',false,'test-token-only')`;
  const originalFetch = globalThis.fetch;
  let data = {
    data: {
      product: {
        id: productId,
        title: "Fetched",
        updatedAt: "2026-10-25T00:00:00Z",
        variantsCount: { count: 0, precision: "EXACT" },
        variants: {
          edges: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, `https://${shop}/admin/api/2026-10/graphql.json`);
    assert.equal(options.headers["X-Shopify-Access-Token"], "test-token-only");
    return new Response(
      JSON.stringify({
        ...data,
        extensions: {
          cost: {
            actualQueryCost: 2,
            throttleStatus: {
              maximumAvailable: 1000,
              currentlyAvailable: 900,
              restoreRate: 100,
            },
          },
        },
      }),
      { status: 200 }
    );
  };
  try {
    assert.equal(
      (
        await defaultFetchProduct(shop, productId, {
          generation: merchant.generation,
        })
      ).product.title,
      "Fetched"
    );
    data = { errors: [{ message: "Access denied" }], data: { product: null } };
    await assert.rejects(
      defaultFetchProduct(shop, productId, { generation: merchant.generation }),
      /GraphQL errors/
    );
    data = { data: {} };
    await assert.rejects(
      defaultFetchProduct(shop, productId, { generation: merchant.generation }),
      /missing product field/
    );
    data = { data: { product: null } };
    assert.equal(
      await defaultFetchProduct(shop, productId, {
        generation: merchant.generation,
      }),
      null
    );
  } finally {
    globalThis.fetch = originalFetch;
    const { sessionStorage } = await import("../session-storage.js");
    await sessionStorage.disconnect();
  }
});

test("Shopify HTTP and GraphQL throttles establish a shared cooldown before another request", async () => {
  const { Session } = await import("@shopify/shopify-api");
  const { sessionStorage } = await import("../session-storage.js");
  const { graphql } = await import("../integrations/shopify/graphql.js");
  const { GET_PRODUCT_VERSION } = await import(
    "../domains/products/products.queries.js"
  );
  await sessionStorage.storeSession(
    new Session({
      id: `offline_${shop}`,
      shop,
      state: "test",
      isOnline: false,
      accessToken: "test-token-only",
      scope: "read_products,read_inventory",
    })
  );
  const generation = (await prisma.shop.findUnique({ where: { domain: shop } }))
    .generation;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response("", { status: 429, headers: { "retry-after": "0.025" } })
      : new Response(
          JSON.stringify({
            errors: [
              { message: "Throttled", extensions: { code: "THROTTLED" } },
            ],
          }),
          { status: 200 }
        );
  };
  try {
    const context = { generation, requestedCost: 10 };
    await assert.rejects(
      graphql(shop, GET_PRODUCT_VERSION, { id: productId }, context),
      (error) => error.throttled && error.retryAfterMs === 25
    );
    await assert.rejects(
      graphql(shop, GET_PRODUCT_VERSION, { id: productId }, context),
      (error) => error.code === "SHOPIFY_THROTTLED"
    );
    await assert.rejects(
      graphql(
        shop,
        GET_PRODUCT_VERSION,
        { id: productId },
        { ...context, signal: AbortSignal.timeout(30) }
      )
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await sessionStorage.disconnect();
  }
});

test("mandatory customer privacy processing stores no customer payload; final shop redaction deletes the tenant", async () => {
  assert.equal(
    await processLifecycle(lifecycle("customers/data_request")),
    "NO_CUSTOMER_DATA_STORED"
  );
  assert.equal(
    await processLifecycle(lifecycle("customers/redact")),
    "NO_CUSTOMER_DATA_TO_REDACT"
  );
  const reports = await (await fetch(`${base}/privacy-requests`)).json();
  assert.equal(reports.requests.length, 2);
  await processLifecycle(lifecycle("app/uninstalled"));
  assert.equal(
    await processLifecycle(lifecycle("shop/redact")),
    "SHOP_REDACTED"
  );
  assert.equal(await prisma.shop.count({ where: { domain: shop } }), 0);
});

test("shop redaction also cleans up when the earlier uninstall delivery was missed", async () => {
  await registerShop(shop);
  await attachPublishedFixture();
  // This uniquely named fixture exists only on the disposable test branch.
  await prisma.shop.update({
    where: { domain: shop },
    data: { installedAt: new Date(Date.now() - 7 * 86400000) },
  });
  await recordProductWebhook(input());
  assert.equal(
    await processLifecycle(lifecycle("shop/redact")),
    "SHOP_REDACTED"
  );
  assert.equal(await prisma.shop.count({ where: { domain: shop } }), 0);
  assert.equal(await prisma.catalogChange.count({ where: { shop } }), 0);
});
