import test from "node:test";
import assert from "node:assert/strict";
import { createSyncRunService } from "./sync-run-service.server.js";
import { transaction } from "./transactions.server.js";
const shopId = "unit.myshopify.com";
const never = {
  connect() {
    assert.fail("Invalid input reached database");
  },
};
test("ingestion rejects unsupported datasets and absent worker identity before connecting", async () => {
  const service = createSyncRunService({ database: never });
  for (const input of [
    { shopId: "bad", workerId: "w" },
    { shopId, workerId: "w", dataset: "metafields" },
    { shopId, workerId: "w", requiredDatasets: ["products"] },
    { shopId },
  ])
    await assert.rejects(() => service.startIngestionRun(input));
});
test("lease and retention durations are bounded", async () => {
  const service = createSyncRunService({ database: never });
  await assert.rejects(() =>
    service.renewRunLease({ shopId, workerId: "w", leaseMs: Infinity }),
  );
  await assert.rejects(() =>
    service.retainGeneration({
      shopId,
      generationId: "g",
      until: Date.now() + 8 * 86400000,
    }),
  );
});
test("transaction retries conflicts after rollback and never retries arbitrary failures", async () => {
  const commands = [];
  let attempts = 0,
    released = 0;
  const database = {
    async connect() {
      return {
        async query(sql) {
          commands.push(sql);
          return { rows: [] };
        },
        release() {
          released++;
        },
      };
    },
  };
  assert.equal(
    await transaction(database, async () => {
      if (++attempts < 3)
        throw Object.assign(Error("serialization"), { code: "40001" });
      return "ok";
    }),
    "ok",
  );
  assert.equal(released, 3);
  assert.equal(commands.filter((s) => s === "ROLLBACK").length, 2);
  attempts = 0;
  await assert.rejects(() =>
    transaction(database, async () => {
      attempts++;
      throw Error("bad payload");
    }),
  );
  assert.equal(attempts, 1);
});
