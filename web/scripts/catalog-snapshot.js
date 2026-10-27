import "../env.js";
import { parseArgs } from "node:util";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { prisma } from "../db/client.js";
import { reconcileQueue } from "../queues/reconcile.queue.js";
import { inventoryQueue } from "../queues/inventory.queue.js";
import { syncQueue } from "../queues/sync.queue.js";
import { requestPeriodicFullSnapshot } from "../workers/reconcile.worker.js";
import {
  startCatalogSnapshot,
  stageSnapshotProducts,
  cancelCatalogSnapshot,
} from "../domains/snapshots/snapshots.service.js";

import { reconcileAndPublishSnapshot } from "../domains/sync/sync.coordinator.js";
import { closeGraphqlSessions } from "../integrations/shopify/graphql.js";
import { closeGraphqlBudget } from "../integrations/shopify/graphql-budget.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    shop: { type: "string" },
    run: { type: "string" },
    file: { type: "string" },
    "expected-products": { type: "string" },
  },
});
try {
  const merchant = await prisma.shop.findUnique({
    where: { domain: values.shop || "" },
  });
  if (merchant?.status !== "ACTIVE")
    throw Error("An active registered --shop is required");
  const args = {
    shop: merchant.domain,
    generation: merchant.generation,
    runId: values.run,
  };
  let result;
  switch (positionals[0]) {
    case "request":
      result = await requestPeriodicFullSnapshot(merchant.domain, { reason: "MANUAL" });
      break;
    case "start":
      result = await startCatalogSnapshot({
        ...args,
        expectedProducts: Number(values["expected-products"]),
      });
      break;
    case "stage": {
      if (!values.run || !values.file)
        throw Error("stage requires --run and --file");
      const stream = createReadStream(values.file, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      let products = [];
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          if (line.length > 32 * 1024 * 1024)
            throw Error("Snapshot product line exceeds 32 MB");
          products.push(JSON.parse(line));
          if (products.length === 25) {
            result = await stageSnapshotProducts({ ...args, products });
            products = [];
          }
        }
        if (products.length)
          result = await stageSnapshotProducts({ ...args, products });
      } finally {
        lines.close();
        stream.destroy();
      }
      break;
    }
    case "publish":
      if (!values.run) throw Error("publish requires --run");
      result = await reconcileAndPublishSnapshot(args);
      break;
    case "cancel":
      if (!values.run) throw Error("cancel requires --run");
      result = await cancelCatalogSnapshot(args);
      break;
    default:
      throw Error(
        "Use request, start, stage, publish, or cancel; see docs/reconciliation-operations.md"
      );
  }
  console.log(JSON.stringify(result || { status: "no_products_staged" }));
} catch (error) {
  console.error("[catalog-snapshot]", error.message);
  process.exitCode = 1;
} finally {
  await reconcileQueue.close();
  await inventoryQueue.close();
  await syncQueue.close();
  await closeGraphqlBudget();
  await closeGraphqlSessions();
  await prisma.$disconnect();
}
