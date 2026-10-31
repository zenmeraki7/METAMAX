/**
 * METAMAX — Durable Catalog Reconciliation Worker
 *
 * One work attempt per processOne() invocation.
 *
 * Database is the source of truth.
 * Redis/BullMQ may trigger this worker but MUST NOT
 * be the only record of pending changes.
 *
 * Required queueRepository methods:
 *
 * claimNext({ workerId, leaseSeconds })
 * recordFailure({
 *   claim, code, retryable, retryAfterSeconds
 * })
 *
 * Claim must atomically acquire a durable lease and
 * return a shop/generation/product/revision/fence.
 */

import {
  ReconciliationError,
} from "../mirror/reconciliation.server.js";

const DEFAULT_LEASE_SECONDS = 120;
const MAX_RETRY_SECONDS = 900;

function assertMethod(object, name) {
  if (typeof object?.[name] !== "function") {
    throw new TypeError(
      `Required queue repository method: ${name}`
    );
  }
}

function retryDelay(attempt) {
  const bounded = Math.max(
    0,
    Math.min(8, Number.isSafeInteger(attempt)
      ? attempt
      : 0)
  );

  return Math.min(
    MAX_RETRY_SECONDS,
    5 * (2 ** bounded)
  );
}

function classifyFailure(error) {
  if (error instanceof ReconciliationError) {
    return {
      code: error.code,
      retryable: error.retryable,
    };
  }

  return {
    code: "RECONCILIATION_UNEXPECTED",
    retryable: true,
  };
}

export function createCatalogWorker({
  reconciliationService,
  queueRepository,
  logger,
  workerId,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
} = {}) {
  assertMethod(
    reconciliationService,
    "reconcile"
  );

  assertMethod(
    queueRepository,
    "claimNext"
  );

  assertMethod(
    queueRepository,
    "recordFailure"
  );

  if (
    typeof workerId !== "string" ||
    workerId.length < 1 ||
    workerId.length > 128
  ) {
    throw new TypeError(
      "Unique worker identity required"
    );
  }

  if (
    !Number.isSafeInteger(leaseSeconds) ||
    leaseSeconds < 10 ||
    leaseSeconds > 3600
  ) {
    throw new RangeError(
      "Invalid reconciliation lease duration"
    );
  }

  const log = logger ?? console;

  async function processOne() {
    const claim = await queueRepository.claimNext({
      workerId,
      leaseSeconds,
    });

    if (claim == null) {
      return Object.freeze({ kind: "EMPTY" });
    }

    if (
      typeof claim !== "object" ||
      !claim.shopId ||
      !claim.productId ||
      !claim.generationId ||
      !claim.leaseToken
    ) {
      throw new Error(
        "Invalid durable queue claim"
      );
    }

    try {
      const outcome =
        await reconciliationService.reconcile(
          claim
        );

      if (typeof log.info === "function") {
        log.info({
          event: "catalog_reconciliation",
          outcome: outcome.kind,
          shopId: claim.shopId,
          generationId: claim.generationId,
          productId: claim.productId,
        });
      }

      return outcome;
    } catch (error) {
      const failure = classifyFailure(error);

      /*
       * Must conditionally update the SAME claimed
       * revision and fence. A stale worker cannot
       * modify a newer worker's retry state.
       *
       * recordFailure may reject if the claim expired
       * or was superseded. Do not overwrite that.
       */
      await queueRepository.recordFailure({
        claim,
        code: failure.code,
        retryable: failure.retryable,
        retryAfterSeconds: failure.retryable
          ? retryDelay(claim.attempt)
          : null,
      });

      if (typeof log.error === "function") {
        log.error({
          event: "catalog_reconciliation_failure",
          code: failure.code,
          retryable: failure.retryable,
          shopId: claim.shopId,
          productId: claim.productId,
        });
      }

      return Object.freeze({
        kind: failure.retryable
          ? "RETRY_SCHEDULED"
          : "REVIEW_REQUIRED",
        code: failure.code,
      });
    }
  }

  return Object.freeze({ processOne });
}
