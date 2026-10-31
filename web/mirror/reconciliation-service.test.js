import test from "node:test";
import assert from "node:assert/strict";
import { createReconciliationService } from "./reconciliation-service.server.js";
const shopId = "unit.myshopify.com",
  productId = "gid://shopify/Product/1";
const never = {
  connect() {
    assert.fail("Invalid input reached database");
  },
};
test("event identity and tenant validation precede persistence", async () => {
  const service = createReconciliationService({ database: never });
  for (const input of [
    { shopId: "bad", productId, sourceKey: "e" },
    { shopId, productId: "bad", sourceKey: "e" },
    { shopId, productId, sourceKey: "" },
    { shopId, productId, sourceKey: "e", payloadHash: "bad" },
  ])
    await assert.rejects(() => service.recordMutationEvent(input));
});
test("reconciliation requires complete authoritative state or explicit deletion", async () => {
  const service = createReconciliationService({ database: never });
  for (const productPayload of [null, {}, { id: productId, title: "partial" }])
    await assert.rejects(() =>
      service.reconcileProduct({
        shopId,
        productId,
        generationId: "g",
        workerId: "w",
        observedRevision: 1n,
        fence: 1n,
        productPayload,
      }),
    );
});
test("scanner and retry limits reject NaN, infinity and excessive budgets", async () => {
  const service = createReconciliationService({ database: never });
  for (const limit of [NaN, Infinity, 0, 201])
    await assert.rejects(() => service.scanDueDirtyProducts({ shopId, limit }));
  await assert.rejects(() =>
    service.recordFailure({
      shopId,
      productId,
      fence: 1n,
      maxAttempts: 21,
      error: Error(),
    }),
  );
});
test("cancellation before claim makes no external or database request", async () => {
  const service = createReconciliationService({ database: never });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      service.reconcileLatestProduct({
        shopId,
        productId,
        workerId: "w",
        signal: controller.signal,
        fetchProduct() {
          assert.fail("Remote request after abort");
        },
      }),
    { name: "AbortError" },
  );
});
