import test from "node:test";
import assert from "node:assert/strict";
import { createCatalogWorker } from "./catalog.worker.js";
import { ReconciliationError } from "../mirror/reconciliation.server.js";

const workerId = "worker-catalog-1";
const validClaim = Object.freeze({
  shopId: "worker-test.myshopify.com",
  productId: "gid://shopify/Product/123",
  generationId: "gen-1",
  leaseToken: "lease-abc",
  revision: "5",
  fence: 1n,
  attempt: 2,
});

test("createCatalogWorker: validates constructor arguments and lease bounds", () => {
  assert.throws(
    () => createCatalogWorker({}),
    /Required queue repository method: reconcile/,
  );
  assert.throws(
    () =>
      createCatalogWorker({
        reconciliationService: { reconcile() {} },
      }),
    /Required queue repository method: claimNext/,
  );
  assert.throws(
    () =>
      createCatalogWorker({
        reconciliationService: { reconcile() {} },
        queueRepository: { claimNext() {} },
      }),
    /Required queue repository method: recordFailure/,
  );
  assert.throws(
    () =>
      createCatalogWorker({
        reconciliationService: { reconcile() {} },
        queueRepository: { claimNext() {}, recordFailure() {} },
        workerId: "",
      }),
    /Unique worker identity required/,
  );
  assert.throws(
    () =>
      createCatalogWorker({
        reconciliationService: { reconcile() {} },
        queueRepository: { claimNext() {}, recordFailure() {} },
        workerId,
        leaseSeconds: 5, // < 10
      }),
    /Invalid reconciliation lease duration/,
  );
  assert.throws(
    () =>
      createCatalogWorker({
        reconciliationService: { reconcile() {} },
        queueRepository: { claimNext() {}, recordFailure() {} },
        workerId,
        leaseSeconds: 4000, // > 3600
      }),
    /Invalid reconciliation lease duration/,
  );
});

test("processOne: returns EMPTY when no claim is available", async () => {
  const worker = createCatalogWorker({
    reconciliationService: { async reconcile() {} },
    queueRepository: {
      async claimNext() { return null; },
      async recordFailure() {},
    },
    workerId,
  });

  const res = await worker.processOne();
  assert.equal(res.kind, "EMPTY");
});

test("processOne: throws when claimed item lacks mandatory fields", async () => {
  const worker = createCatalogWorker({
    reconciliationService: { async reconcile() {} },
    queueRepository: {
      async claimNext() { return { shopId: "store.myshopify.com" }; },
      async recordFailure() {},
    },
    workerId,
  });

  await assert.rejects(
    () => worker.processOne(),
    /Invalid durable queue claim/,
  );
});

test("processOne: reconciles claimed item successfully and returns outcome", async () => {
  let reconciledClaim = null;
  const logs = [];

  const worker = createCatalogWorker({
    reconciliationService: {
      async reconcile(claim) {
        reconciledClaim = claim;
        return { kind: "APPLIED", shopId: claim.shopId, productId: claim.productId };
      },
    },
    queueRepository: {
      async claimNext({ workerId: claimedBy, leaseSeconds }) {
        assert.equal(claimedBy, workerId);
        assert.equal(leaseSeconds, 120);
        return validClaim;
      },
      async recordFailure() {
        assert.fail("recordFailure should not be called on success");
      },
    },
    logger: {
      info(entry) { logs.push(entry); },
      error() {},
    },
    workerId,
  });

  const outcome = await worker.processOne();

  assert.equal(outcome.kind, "APPLIED");
  assert.deepEqual(reconciledClaim, validClaim);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "catalog_reconciliation");
  assert.equal(logs[0].outcome, "APPLIED");
});

test("processOne: records retryable failure with exponential backoff on retryable ReconciliationError", async () => {
  let failureRecorded = null;
  const logs = [];

  const worker = createCatalogWorker({
    reconciliationService: {
      async reconcile() {
        throw new ReconciliationError("SHOPIFY_READ_FAILED", "Network timeout", { retryable: true });
      },
    },
    queueRepository: {
      async claimNext() { return validClaim; },
      async recordFailure(args) { failureRecorded = args; },
    },
    logger: {
      info() {},
      error(entry) { logs.push(entry); },
    },
    workerId,
  });

  const outcome = await worker.processOne();

  assert.equal(outcome.kind, "RETRY_SCHEDULED");
  assert.equal(outcome.code, "SHOPIFY_READ_FAILED");

  assert.equal(failureRecorded.code, "SHOPIFY_READ_FAILED");
  assert.equal(failureRecorded.retryable, true);
  // retryDelay for attempt 2: 5 * (2 ** 2) = 20
  assert.equal(failureRecorded.retryAfterSeconds, 20);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "catalog_reconciliation_failure");
  assert.equal(logs[0].code, "SHOPIFY_READ_FAILED");
  assert.equal(logs[0].retryable, true);
});

test("processOne: records non-retryable failure on deterministic ReconciliationError", async () => {
  let failureRecorded = null;

  const worker = createCatalogWorker({
    reconciliationService: {
      async reconcile() {
        throw new ReconciliationError("RESOURCE_IDENTITY_MISMATCH", "Identity mismatch");
      },
    },
    queueRepository: {
      async claimNext() { return validClaim; },
      async recordFailure(args) { failureRecorded = args; },
    },
    workerId,
  });

  const outcome = await worker.processOne();

  assert.equal(outcome.kind, "REVIEW_REQUIRED");
  assert.equal(outcome.code, "RESOURCE_IDENTITY_MISMATCH");

  assert.equal(failureRecorded.code, "RESOURCE_IDENTITY_MISMATCH");
  assert.equal(failureRecorded.retryable, false);
  assert.equal(failureRecorded.retryAfterSeconds, null);
});

test("processOne: classifies unexpected non-ReconciliationError as retryable RECONCILIATION_UNEXPECTED", async () => {
  let failureRecorded = null;

  const worker = createCatalogWorker({
    reconciliationService: {
      async reconcile() {
        throw new Error("Crash in engine");
      },
    },
    queueRepository: {
      async claimNext() { return validClaim; },
      async recordFailure(args) { failureRecorded = args; },
    },
    workerId,
  });

  const outcome = await worker.processOne();

  assert.equal(outcome.kind, "RETRY_SCHEDULED");
  assert.equal(outcome.code, "RECONCILIATION_UNEXPECTED");
  assert.equal(failureRecorded.code, "RECONCILIATION_UNEXPECTED");
  assert.equal(failureRecorded.retryable, true);
});
