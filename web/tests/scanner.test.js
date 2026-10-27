import { test, after } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { createDirtyScanner } from "../workers/reconcile.scanner.js";
import { readWorkerConfig } from "../workers/reconcile.config.js";
import { redisConnection } from "../queues.js";
import { reconcileQueue } from "../queues/reconcile.queue.js";

after(async () => {
  await reconcileQueue.close();
});

// Model enough of the read interface to exercise scheduling limits and rotation
// without altering retry state or creating hundreds of remote test records.
function fixture(shopCount, productCount) {
  const shops = Array.from(
    { length: shopCount },
    (_, i) => `shop-${String(i).padStart(3, "0")}.myshopify.com`
  );
  const calls = [],
    queued = [];
  let depth = 0;
  const db = {
    catalogChange: {
      groupBy: async ({ where, take }) =>
        shops
          .filter((shop) =>
            where.shop.gt !== undefined
              ? shop > where.shop.gt
              : shop <= where.shop.lte
          )
          .slice(0, take)
          .map((shop) => ({ shop })),
      findMany: async ({ where, take }) => {
        calls.push(where.shop);
        return Array.from({ length: Math.min(take, productCount) }, (_, i) => ({
          shop: where.shop,
          productId: `gid://shopify/Product/${i + 1}`,
          revision: 1n,
        }));
      },
    },
  };
  const scanner = createDirtyScanner({
    db,
    queue: {
      getJobCounts: async () => ({ wait: depth, active: 0, paused: 0 }),
    },
    enqueue: async (...args) => {
      queued.push(args);
    },
  });
  return {
    scanner,
    calls,
    queued,
    setDepth: (value) => {
      depth = value;
    },
  };
}

test("bounded scans rotate through shops and wrap without starving later shops", async () => {
  const { scanner, calls, queued } = fixture(45, 10);
  assert.equal(await scanner(), 100);
  assert.equal(calls.length, 20);
  assert.equal(await scanner(), 100);
  assert.equal(calls.length, 40);
  assert.equal(await scanner(), 100);
  assert.equal(new Set(calls).size, 45);
  const firstPass = queued.slice(0, 100);
  assert.equal(new Set(firstPass.map(([shop]) => shop)).size, 20);
  assert.equal(new Set(firstPass.slice(0, 20).map(([shop]) => shop)).size, 20);
  assert.ok(
    [...new Set(firstPass.map(([shop]) => shop))].every(
      (shop) => firstPass.filter(([domain]) => domain === shop).length === 5
    )
  );
});

test("explicit scan limit bounds attempted additions independently of the backlog", async () => {
  const { scanner, queued } = fixture(20, 5);
  assert.equal(await scanner({ scanLimit: 7 }), 7);
  assert.equal(new Set(queued.map(([shop]) => shop)).size, 7);
  assert.equal(
    readWorkerConfig({
      RECONCILE_MAX_BACKLOG: "123",
      RECONCILE_MAX_QUEUED_JOBS: "999",
    }).maxQueuedJobs,
    123
  );
  assert.equal(
    readWorkerConfig({ RECONCILE_MAX_QUEUED_JOBS: "999" }).maxQueuedJobs,
    999
  );
});

test("soft backlog cap bounds enqueues in a pass and includes existing queue work", async () => {
  const { scanner, calls, setDepth } = fixture(3, 10);
  setDepth(1998);
  assert.equal(await scanner(), 2);
  assert.equal(calls.length, 3);
  setDepth(2000);
  assert.equal(await scanner(), 0);
  assert.equal(calls.length, 3);
});

test("queue failures abort a scan without acknowledging durable work", async () => {
  const { scanner } = fixture(3, 2);
  await assert.rejects(
    scanner({
      queue: {
        getJobCounts: async () => {
          throw Error("Redis unavailable");
        },
      },
    }),
    /Redis unavailable/
  );
  await assert.rejects(
    scanner({
      enqueue: async () => {
        throw Error("Enqueue failed");
      },
    }),
    /Enqueue failed/
  );
  assert.equal(await scanner(), 6);
});

test("worker environment defaults are configurable and invalid settings fail early", () => {
  assert.deepEqual(readWorkerConfig({}), {
    concurrency: 5,
    scanIntervalMs: 5000,
    shopsPerScan: 20,
    productsPerShop: 5,
    scanLimit: 100,
    maxQueuedJobs: 2000,
    shutdownTimeoutMs: 360000,
  });
  assert.equal(readWorkerConfig({ RECONCILE_CONCURRENCY: "9" }).concurrency, 9);
  for (const value of [
    "0",
    "-1",
    "",
    "garbage",
    "1.5",
    "Infinity",
    "2147483648",
  ])
    assert.throws(
      () => readWorkerConfig({ RECONCILE_SCAN_INTERVAL_MS: value }),
      /positive integer/
    );
});

test("disconnected producers fail immediately while workers retain durable reconnect settings", async () => {
  const producer = redisConnection();
  assert.equal(producer.maxRetriesPerRequest, 1);
  assert.equal(producer.connectTimeout, 1500);
  assert.equal(producer.enableOfflineQueue, false);
  const worker = redisConnection({ worker: true });
  assert.equal(worker.maxRetriesPerRequest, null);
  assert.equal(worker.enableOfflineQueue, true);
  const client = new Redis({ ...producer, lazyConnect: true });
  try {
    await assert.rejects(
      client.ping(),
      /offlineQueue|offline queue|Stream isn't writeable/i
    );
  } finally {
    client.disconnect();
  }
});
