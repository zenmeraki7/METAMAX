/**
 * METAMAX — Authoritative Catalog Reconciliation
 *
 * This service NEVER writes published generations.
 *
 * Required adapters:
 *
 * shopifyReader.readCompleteProduct({
 *   shopId, productId
 * })
 *
 * Returns:
 *   { kind: "FOUND", product: completeProduct }
 *   { kind: "DELETED" }
 *
 * DELETED is allowed ONLY after an authoritative,
 * unambiguous Shopify not-found determination.
 *
 * catalogNormalizer.normalizeProduct({
 *   shopId, product, generationId
 * })
 *
 * Returns a complete, validated product-family
 * replacement document, including variants.
 *
 * repository.commitReconciliation({
 *   claim, observedRevision, replacement
 * })
 *
 * MUST implement the atomic, fenced PostgreSQL
 * transaction specified in the integration contract.
 */

const SHOP_PATTERN =
  /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const PRODUCT_PATTERN =
  /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;

const REVISION_PATTERN =
  /^[1-9][0-9]*$/;

const RESULT_KINDS = new Set([
  "APPLIED",
  "SUPERSEDED",
  "GENERATION_UNAVAILABLE",
  "LEASE_LOST",
]);

export class ReconciliationError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "ReconciliationError";
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

function requireFunction(object, method) {
  if (typeof object?.[method] !== "function") {
    throw new TypeError(
      `Required adapter method missing: ${method}`
    );
  }
}

function requireNonemptyString(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256
  ) {
    throw new ReconciliationError(
      "INVALID_CLAIM",
      `Invalid ${name}`
    );
  }

  return value;
}

function validateClaim(claim) {
  if (
    claim === null ||
    typeof claim !== "object" ||
    Array.isArray(claim)
  ) {
    throw new ReconciliationError(
      "INVALID_CLAIM",
      "Durable reconciliation claim required"
    );
  }

  const shopId = requireNonemptyString(
    claim.shopId,
    "shop identity"
  );

  const productId = requireNonemptyString(
    claim.productId,
    "product identity"
  );

  const generationId = requireNonemptyString(
    claim.generationId,
    "generation identity"
  );

  const leaseToken = requireNonemptyString(
    claim.leaseToken,
    "lease token"
  );

  if (!SHOP_PATTERN.test(shopId)) {
    throw new ReconciliationError(
      "INVALID_CLAIM",
      "Invalid shop identity"
    );
  }

  if (!PRODUCT_PATTERN.test(productId)) {
    throw new ReconciliationError(
      "INVALID_CLAIM",
      "Invalid product identity"
    );
  }

  const revision = String(claim.revision ?? "");

  if (!REVISION_PATTERN.test(revision)) {
    throw new ReconciliationError(
      "INVALID_CLAIM",
      "Invalid product revision"
    );
  }

  return Object.freeze({
    ...claim,
    shopId,
    productId,
    generationId,
    leaseToken,
    revision,
  });
}

function validateAuthoritativeResult(result, claim) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result)
  ) {
    throw new ReconciliationError(
      "INVALID_SHOPIFY_RESULT",
      "Invalid Shopify reader response"
    );
  }

  if (result.kind === "DELETED") {
    return Object.freeze({ kind: "DELETED" });
  }

  if (result.kind !== "FOUND") {
    throw new ReconciliationError(
      "UNVERIFIED_SHOPIFY_RESULT",
      "Shopify state could not be verified",
      { retryable: true }
    );
  }

  const product = result.product;

  if (
    !product ||
    typeof product !== "object" ||
    Array.isArray(product) ||
    product.id !== claim.productId
  ) {
    throw new ReconciliationError(
      "RESOURCE_IDENTITY_MISMATCH",
      "Shopify returned an unexpected resource"
    );
  }

  if (
    typeof result.shopId === "string" &&
    result.shopId !== claim.shopId
  ) {
    throw new ReconciliationError(
      "RESOURCE_IDENTITY_MISMATCH",
      "Shopify response belongs to another shop"
    );
  }

  if (result.complete !== true) {
    throw new ReconciliationError(
      "INCOMPLETE_SHOPIFY_RESULT",
      "Complete product-family data required",
      { retryable: true }
    );
  }

  return Object.freeze({
    kind: "FOUND",
    product,
  });
}

function validateCommitResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    !RESULT_KINDS.has(result.kind)
  ) {
    throw new ReconciliationError(
      "INVALID_COMMIT_RESULT",
      "Repository returned an invalid outcome"
    );
  }

  return Object.freeze({ kind: result.kind });
}

export function createCatalogReconciliationService({
  shopifyReader,
  catalogNormalizer,
  repository,
} = {}) {
  requireFunction(
    shopifyReader,
    "readCompleteProduct"
  );

  requireFunction(
    catalogNormalizer,
    "normalizeProduct"
  );

  requireFunction(
    repository,
    "commitReconciliation"
  );

  async function reconcile(rawClaim) {
    const claim = validateClaim(rawClaim);

    let authoritative;

    try {
      authoritative =
        await shopifyReader.readCompleteProduct({
          shopId: claim.shopId,
          productId: claim.productId,
        });
    } catch (error) {
      throw new ReconciliationError(
        "SHOPIFY_READ_FAILED",
        "Authoritative Shopify read failed",
        { retryable: true, cause: error }
      );
    }

    const verified = validateAuthoritativeResult(
      authoritative,
      claim
    );

    let replacement;

    if (verified.kind === "DELETED") {
      replacement = Object.freeze({
        kind: "DELETE",
        productId: claim.productId,
      });
    } else {
      try {
        replacement =
          await catalogNormalizer.normalizeProduct({
            shopId: claim.shopId,
            generationId: claim.generationId,
            product: verified.product,
          });
      } catch (error) {
        throw new ReconciliationError(
          "NORMALIZATION_FAILED",
          "Catalog normalization failed",
          { cause: error }
        );
      }

      if (
        !replacement ||
        typeof replacement !== "object" ||
        replacement.kind !== "REPLACE" ||
        replacement.productId !== claim.productId
      ) {
        throw new ReconciliationError(
          "INVALID_REPLACEMENT",
          "Normalizer returned an invalid product replacement"
        );
      }
    }

    /*
     * The repository owns:
     * - Transaction and locking
     * - Generation eligibility
     * - Lease/fence verification
     * - Revision compare-and-swap
     * - Product-family replacement
     * - Generation revision receipt
     * - Conditional acknowledgment
     *
     * This call must be atomic.
     */
    const committed =
      await repository.commitReconciliation({
        claim,
        observedRevision: claim.revision,
        replacement,
      });

    const result = validateCommitResult(committed);

    return Object.freeze({
      ...result,
      shopId: claim.shopId,
      productId: claim.productId,
      generationId: claim.generationId,
      revision: claim.revision,
    });
  }

  return Object.freeze({ reconcile });
}
