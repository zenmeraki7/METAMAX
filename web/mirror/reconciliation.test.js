import test from "node:test";
import assert from "node:assert/strict";
import {
  createCatalogReconciliationService,
  ReconciliationError,
} from "./reconciliation.server.js";

const shopId = "reconcile-test.myshopify.com";
const productId = "gid://shopify/Product/123456";
const generationId = "gen-stage-1";
const leaseToken = "worker-lease-token-1";
const revision = "42";

const validClaim = Object.freeze({
  shopId,
  productId,
  generationId,
  leaseToken,
  revision,
});

const sampleProduct = Object.freeze({
  id: productId,
  title: "Test Product",
  variants: [{ id: "gid://shopify/ProductVariant/10", title: "Default" }],
});

test("createCatalogReconciliationService: enforces required adapter methods", () => {
  assert.throws(
    () => createCatalogReconciliationService({}),
    /Required adapter method missing: readCompleteProduct/,
  );
  assert.throws(
    () =>
      createCatalogReconciliationService({
        shopifyReader: { readCompleteProduct() {} },
      }),
    /Required adapter method missing: normalizeProduct/,
  );
  assert.throws(
    () =>
      createCatalogReconciliationService({
        shopifyReader: { readCompleteProduct() {} },
        catalogNormalizer: { normalizeProduct() {} },
      }),
    /Required adapter method missing: commitReconciliation/,
  );
});

test("reconciliation: claim validation rejects invalid claim structures and values", async () => {
  const service = createCatalogReconciliationService({
    shopifyReader: { async readCompleteProduct() {} },
    catalogNormalizer: { async normalizeProduct() {} },
    repository: { async commitReconciliation() {} },
  });

  const invalidClaims = [
    null,
    "claim",
    [],
    { ...validClaim, shopId: "invalid-domain.com" },
    { ...validClaim, productId: "123456" },
    { ...validClaim, generationId: "" },
    { ...validClaim, leaseToken: "" },
    { ...validClaim, revision: "0" },
    { ...validClaim, revision: "bad" },
  ];

  for (const claim of invalidClaims) {
    await assert.rejects(
      () => service.reconcile(claim),
      (err) => err instanceof ReconciliationError && err.code === "INVALID_CLAIM",
    );
  }
});

test("reconciliation: handles authoritative FOUND response, normalizes and commits APPLIED", async () => {
  let readArgs = null;
  let normalizeArgs = null;
  let commitArgs = null;

  const service = createCatalogReconciliationService({
    shopifyReader: {
      async readCompleteProduct(args) {
        readArgs = args;
        return {
          kind: "FOUND",
          product: sampleProduct,
          complete: true,
          shopId,
        };
      },
    },
    catalogNormalizer: {
      async normalizeProduct(args) {
        normalizeArgs = args;
        return {
          kind: "REPLACE",
          productId,
          product: sampleProduct,
        };
      },
    },
    repository: {
      async commitReconciliation(args) {
        commitArgs = args;
        return { kind: "APPLIED" };
      },
    },
  });

  const result = await service.reconcile(validClaim);

  assert.equal(result.kind, "APPLIED");
  assert.equal(result.shopId, shopId);
  assert.equal(result.productId, productId);
  assert.equal(result.generationId, generationId);
  assert.equal(result.revision, revision);

  assert.deepEqual(readArgs, { shopId, productId });
  assert.deepEqual(normalizeArgs, { shopId, generationId, product: sampleProduct });
  assert.equal(commitArgs.claim.shopId, shopId);
  assert.equal(commitArgs.observedRevision, revision);
  assert.equal(commitArgs.replacement.kind, "REPLACE");
});

test("reconciliation: handles authoritative DELETED response without calling normalizer", async () => {
  let normalizerCalled = false;
  let commitArgs = null;

  const service = createCatalogReconciliationService({
    shopifyReader: {
      async readCompleteProduct() {
        return { kind: "DELETED" };
      },
    },
    catalogNormalizer: {
      async normalizeProduct() {
        normalizerCalled = true;
      },
    },
    repository: {
      async commitReconciliation(args) {
        commitArgs = args;
        return { kind: "APPLIED" };
      },
    },
  });

  const result = await service.reconcile(validClaim);

  assert.equal(result.kind, "APPLIED");
  assert.equal(normalizerCalled, false);
  assert.deepEqual(commitArgs.replacement, { kind: "DELETE", productId });
});

test("reconciliation: protects tenant isolation and rejects cross-shop response", async () => {
  const service = createCatalogReconciliationService({
    shopifyReader: {
      async readCompleteProduct() {
        return {
          kind: "FOUND",
          product: sampleProduct,
          complete: true,
          shopId: "other-store.myshopify.com",
        };
      },
    },
    catalogNormalizer: { async normalizeProduct() {} },
    repository: { async commitReconciliation() {} },
  });

  await assert.rejects(
    () => service.reconcile(validClaim),
    (err) =>
      err instanceof ReconciliationError &&
      err.code === "RESOURCE_IDENTITY_MISMATCH" &&
      err.message.includes("belongs to another shop"),
  );
});

test("reconciliation: rejects incomplete Shopify result and marks error retryable", async () => {
  const service = createCatalogReconciliationService({
    shopifyReader: {
      async readCompleteProduct() {
        return {
          kind: "FOUND",
          product: sampleProduct,
          complete: false, // Incomplete product-family (e.g. truncated variants)
          shopId,
        };
      },
    },
    catalogNormalizer: { async normalizeProduct() {} },
    repository: { async commitReconciliation() {} },
  });

  await assert.rejects(
    () => service.reconcile(validClaim),
    (err) =>
      err instanceof ReconciliationError &&
      err.code === "INCOMPLETE_SHOPIFY_RESULT" &&
      err.retryable === true,
  );
});

test("reconciliation: marks Shopify read network/rate-limit failures retryable", async () => {
  const service = createCatalogReconciliationService({
    shopifyReader: {
      async readCompleteProduct() {
        throw new Error("Throttled / 429 Too Many Requests");
      },
    },
    catalogNormalizer: { async normalizeProduct() {} },
    repository: { async commitReconciliation() {} },
  });

  await assert.rejects(
    () => service.reconcile(validClaim),
    (err) =>
      err instanceof ReconciliationError &&
      err.code === "SHOPIFY_READ_FAILED" &&
      err.retryable === true,
  );
});

test("reconciliation: handles repository outcomes (SUPERSEDED, LEASE_LOST, GENERATION_UNAVAILABLE)", async () => {
  for (const outcome of ["SUPERSEDED", "LEASE_LOST", "GENERATION_UNAVAILABLE"]) {
    const service = createCatalogReconciliationService({
      shopifyReader: {
        async readCompleteProduct() {
          return { kind: "DELETED" };
        },
      },
      catalogNormalizer: { async normalizeProduct() {} },
      repository: {
        async commitReconciliation() {
          return { kind: outcome };
        },
      },
    });

    const res = await service.reconcile(validClaim);
    assert.equal(res.kind, outcome);
  }
});
