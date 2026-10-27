import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Session } from "@shopify/shopify-api";
import { prisma } from "../db/client.js";
import { persistOfflineInstallation } from "../domains/lifecycle/offline-session.js";
import { randomUUID } from "node:crypto";
import {
  registerShopInTransaction,
  shopHash,
} from "../domains/lifecycle/lifecycle.repository.js";

after(() => prisma.$disconnect());
const shop = "install-dispatch.myshopify.com";
const session = () =>
  new Session({
    id: `offline_${shop}`,
    shop,
    isOnline: false,
    state: "test",
    scope: "read_products",
    accessToken: "unit-test-token",
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(overrides = {}) {
  const calls = [],
    errors = [];
  let committed = false;
  const run = { id: "initial-run", shop, status: "PENDING" };
  const merchant = {
    activeRunId: run.id,
    activeSnapshotId: null,
    generation: "installation-1",
    ...overrides,
  };
  const tx = {
    $executeRaw: async () => 1,
    snapshotRun: {
      findFirst: async (query) => {
        calls.push(query);
        return run;
      },
    },
  };
  const queued = [];
  const options = {
    db: {
      $transaction: async (fn) => {
        const result = await fn(tx);
        committed = true;
        return result;
      },
    },
    initialize: async () => merchant,
    enqueue: async (...args) => {
      assert.ok(committed, "dispatch requires a committed session");
      queued.push(args);
    },
    logger: { error: (...args) => errors.push(args) },
  };
  return { tx, options, merchant, calls, queued, errors };
}

test("installation immediately dispatches the committed pending run", async () => {
  const f = fixture();
  assert.equal(await persistOfflineInstallation(session(), f.options), true);
  await tick();
  assert.deepEqual(f.queued, [[shop, "initial-run", "PENDING"]]);
  assert.deepEqual(f.calls[0].where, {
    id: "initial-run",
    shop,
    generation: "installation-1",
    status: "PENDING",
    nextCheckAt: { lte: f.calls[0].where.nextCheckAt.lte },
  });
  assert.ok(f.calls[0].where.nextCheckAt.lte instanceof Date);
});

test("a failed commit never dispatches an import", async () => {
  const f = fixture();
  f.options.db.$transaction = async (fn) => {
    await fn(f.tx);
    throw Error("commit failed");
  };
  await assert.rejects(
    persistOfflineInstallation(session(), f.options),
    /commit failed/,
  );
  await tick();
  assert.equal(f.queued.length, 0);
});

test("authorization returns even while the queue is unavailable", async () => {
  const f = fixture();
  let rejectDispatch;
  f.options.enqueue = () =>
    new Promise((_, reject) => {
      rejectDispatch = reject;
    });
  assert.equal(await persistOfflineInstallation(session(), f.options), true);
  rejectDispatch(
    Object.assign(Error("do not log credentials"), { code: "ECONNREFUSED" }),
  );
  await tick();
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0][1], "ECONNREFUSED");
  assert.ok(!f.errors.flat().join(" ").includes("do not log credentials"));
});

test("synchronous queue failures also leave installation successful", async () => {
  const f = fixture();
  f.options.enqueue = () => {
    throw Error("queue failed");
  };
  assert.equal(await persistOfflineInstallation(session(), f.options), true);
  await tick();
  assert.equal(f.errors[0][1], "QUEUE_UNAVAILABLE");
});

test("reauthorization does not reschedule a published catalogue", async () => {
  const f = fixture({ activeSnapshotId: "published-snapshot" });
  await persistOfflineInstallation(session(), f.options);
  await tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.queued.length, 0);
});

test("in-progress, backed-off and terminal runs are not dispatched", async () => {
  const f = fixture();
  f.tx.snapshotRun.findFirst = async ({ where }) => {
    assert.equal(where.status, "PENDING");
    assert.ok(where.nextCheckAt.lte instanceof Date);
    return null;
  };
  await persistOfflineInstallation(session(), f.options);
  await tick();
  assert.equal(f.queued.length, 0);
});

test("invalid sessions cannot trigger installation or dispatch", async () => {
  const f = fixture();
  const invalid = session();
  invalid.accessToken = "";
  await assert.rejects(
    persistOfflineInstallation(invalid, f.options),
    /valid authenticated offline session/,
  );
  assert.equal(f.queued.length, 0);
});

test(
  "database: installation dispatches one durable reservation and respects reauthorization backoff",
  {
    skip: process.env.RUN_INTEGRATION_TESTS !== "1",
  },
  async () => {
    const domain = `test-${randomUUID()}.myshopify.com`;
    const saved = session();
    saved.shop = domain;
    saved.id = `offline_${domain}`;
    const queued = [];
    const options = { enqueue: async (...args) => queued.push(args) };
    try {
      // The installed PostgreSQL adapter normally creates this table on startup.
      await prisma.$queryRaw`SELECT "id" FROM "shopify_sessions" LIMIT 1`;
      await persistOfflineInstallation(saved, options);
      await tick();
      const merchant = await prisma.shop.findUniqueOrThrow({
        where: { domain },
      });
      assert.deepEqual(queued, [[domain, merchant.activeRunId, "PENDING"]]);
      const credentials =
        await prisma.$queryRaw`SELECT "id" FROM "shopify_sessions" WHERE "id"=${saved.id}`;
      assert.equal(credentials.length, 1);
      await persistOfflineInstallation(saved, options);
      await tick();
      assert.equal(
        await prisma.snapshotRun.count({ where: { shop: domain } }),
        1,
      );
      assert.equal(
        await prisma.initialSyncRequest.count({ where: { shop: domain } }),
        1,
      );
      assert.equal(queued[1][1], merchant.activeRunId);
      await prisma.snapshotRun.update({
        where: { id: merchant.activeRunId },
        data: {
          nextCheckAt: new Date(Date.now() + 60000),
        },
      });
      await persistOfflineInstallation(saved, options);
      await tick();
      assert.equal(
        queued.length,
        2,
        "reauthorization must honor durable retry eligibility",
      );
    } finally {
      await prisma.shop.deleteMany({ where: { domain } });
      await prisma.$executeRaw`DELETE FROM "shopify_sessions" WHERE "shop"=${domain}`;
      await prisma.installationState.deleteMany({
        where: { shopHash: shopHash(domain) },
      });
    }
  },
);

test(
  "database: initialization failure rolls back credentials and never dispatches",
  {
    skip: process.env.RUN_INTEGRATION_TESTS !== "1",
  },
  async () => {
    const domain = `test-${randomUUID()}.myshopify.com`;
    const saved = session();
    saved.shop = domain;
    saved.id = `offline_${domain}`;
    const queued = [];
    try {
      await assert.rejects(
        persistOfflineInstallation(saved, {
          initialize: async (tx, shop) => {
            await registerShopInTransaction(tx, shop);
            throw Error("initialization failed");
          },
          enqueue: async (...args) => queued.push(args),
        }),
        /initialization failed/,
      );
      await tick();
      assert.equal(queued.length, 0);
      assert.equal(await prisma.shop.count({ where: { domain } }), 0);
      const credentials =
        await prisma.$queryRaw`SELECT "id" FROM "shopify_sessions" WHERE "id"=${saved.id}`;
      assert.equal(credentials.length, 0);
    } finally {
      await prisma.shop.deleteMany({ where: { domain } });
      await prisma.$executeRaw`DELETE FROM "shopify_sessions" WHERE "shop"=${domain}`;
      await prisma.installationState.deleteMany({
        where: { shopHash: shopHash(domain) },
      });
    }
  },
);
