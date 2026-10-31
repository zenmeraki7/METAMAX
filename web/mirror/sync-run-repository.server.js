/**
 * METAMAX — Durable SyncRun Repository Core
 *
 * web/mirror/sync-run-repository.server.js
 *
 * PostgreSQL is authoritative.
 * BullMQ delivers only runId notifications.
 *
 * The SQL adapter must implement real transactions,
 * locking, conditional writes, and evidence checks.
 *
 * Adapter contract:
 *
 * db.transaction(work, {
 *   isolationLevel: "Serializable"
 * })
 *
 * db.getRunShop(runId)
 *
 * Transaction methods:
 *
 * tx.lockShop(shopId)
 * tx.lockRun(runId)
 * tx.hasOtherLiveRun(shopId, runId)
 * tx.claimRun(runId, patch)
 * tx.renewRun(runId, patch)
 * tx.commitStep(runId, patch)
 * tx.commitFailure(runId, patch)
 * tx.verifyStepEvidence(run, result)
 * tx.verifyPublished(run)
 * tx.now()
 *
 * Each write must conditionally match:
 *
 * - shop
 * - run
 * - generation
 * - phase
 * - lease token
 * - fence
 * - unexpired lease (where applicable)
 *
 * claimRun increments attempt once.
 * commitFailure must not increment attempt.
 * commitStep resets attempt to zero, including successful DEFER polls/chunks.
 * Attempts bound consecutive unsuccessful claims; the fence is lifetime-monotonic.
 *
 * Uncertain outcomes block ordinary claims until
 * an authoritative recovery process clears them.
 */

import { randomUUID } from "node:crypto";

const PHASES = Object.freeze([
  "STARTING",
  "WAITING",
  "INGESTING",
  "RECONCILING",
  "PUBLISHING",
]);

const NEXT = Object.freeze({
  STARTING: "WAITING",
  WAITING: "INGESTING",
  INGESTING: "RECONCILING",
  RECONCILING: "PUBLISHING",
});

const RESULTS = Object.freeze([
  "ADVANCE",
  "DEFER",
  "COMPLETE",
]);

const MAX_DELAY_MS = 900_000;
const MAX_LEASE_SECONDS = 3600;
const MAX_ATTEMPTS = 12;
const MAX_RECOVERY_ATTEMPTS = 8;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

const SHOP =
  /^(?=.{1,255}$)[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const FENCE = /^[1-9]\d{0,18}$/;

const MAX_BIGINT = 9223372036854775807n;

export class SyncRepositoryError extends Error {
  constructor(
    code,
    message,
    { cause, uncertain = false } = {}
  ) {
    super(message, { cause });

    this.name = "SyncRepositoryError";
    this.code = code;
    this.outcomeUncertain = uncertain;
  }
}

function bad(message) {
  throw new SyncRepositoryError(
    "INVALID_INPUT",
    message
  );
}

function checkId(value, name) {
  if (
    typeof value !== "string" ||
    !ID.test(value)
  ) {
    bad(`Invalid ${name}`);
  }

  return value;
}

function checkShop(value) {
  if (
    typeof value !== "string" ||
    !SHOP.test(value)
  ) {
    bad("Invalid authoritative shop");
  }

  return value;
}

function checkFence(value) {
  if (
    typeof value !== "string" ||
    !FENCE.test(value) ||
    BigInt(value).toString() !== value ||
    BigInt(value) > MAX_BIGINT
  ) {
    bad("Invalid fence");
  }

  return value;
}

function checkInteger(
  value,
  min,
  max,
  name
) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    bad(`Invalid ${name}`);
  }

  return value;
}

function dateOf(value, name) {
  if (!(value instanceof Date) && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value))) {
    bad(`Invalid ${name}`);
  }
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : new Date(value);

  if (
    !Number.isFinite(date.getTime())
  ) {
    bad(`Invalid ${name}`);
  }

  return date;
}

function oneOf(value, values, name) {
  if (!values.includes(value)) {
    bad(`Invalid ${name}`);
  }

  return value;
}

function freeze(value) {
  return Object.freeze(value);
}

function dataRecord(value, keys, required = keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad("Plain synchronization data required");
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      if (required.includes(key)) bad(`Missing ${key}`);
      continue;
    }
    if (!Object.hasOwn(descriptor, "value")) bad("Synchronization accessors are not permitted");
    result[key] = descriptor.value;
  }
  return freeze(result);
}

function verifiedBoolean(value, operation) {
  if (typeof value !== "boolean") {
    throw new SyncRepositoryError("UNKNOWN_DB_OUTCOME", `Unverified ${operation} outcome`, { uncertain: true });
  }
  return value;
}

function validateClaim(claim, maxAttempts = MAX_ATTEMPTS) {
  claim = dataRecord(claim, ["runId", "shopId", "generationId", "phase", "leaseToken", "fence", "attempt"]);
  if (
    !claim ||
    typeof claim !== "object" ||
    Array.isArray(claim)
  ) {
    bad("Invalid claim");
  }

  return freeze({
    runId: checkId(
      claim.runId,
      "runId"
    ),

    shopId: checkShop(
      claim.shopId
    ),

    generationId: checkId(
      claim.generationId,
      "generationId"
    ),

    phase: oneOf(
      claim.phase,
      PHASES,
      "phase"
    ),

    leaseToken: checkId(
      claim.leaseToken,
      "leaseToken"
    ),

    fence: checkFence(
      claim.fence
    ),

    attempt: checkInteger(
      claim.attempt,
      1,
      maxAttempts,
      "attempt"
    ),
  });
}

function sameClaim(
  run,
  claim,
  now
) {
  return Boolean(
    run &&
    run.id === claim.runId &&
    run.shopId === claim.shopId &&
    run.generationId ===
      claim.generationId &&
    run.phase === claim.phase &&
    run.leaseToken ===
      claim.leaseToken &&
    String(run.fence) ===
      claim.fence &&
    run.attempt === claim.attempt &&
    dateOf(
      run.leaseExpiresAt,
      "lease expiry"
    ) > now &&
    !run.completedAt &&
    run.reviewRequired === false &&
    run.outcomeUncertain === false &&
    run.cancelRequested !== true
  );
}

function checkMethods(
  object,
  methods,
  name
) {
  for (const method of methods) {
    if (
      typeof object?.[method] !==
      "function"
    ) {
      throw new TypeError(
        `${name}.${method}() is required`
      );
    }
  }
}

function validateRun(
  run,
  id,
  shopId
) {
  if (
    !run ||
    run.id !== id ||
    run.shopId !== shopId
  ) {
    return false;
  }

  checkId(
    run.generationId,
    "generationId"
  );

  oneOf(
    run.phase,
    PHASES,
    "phase"
  );

  checkInteger(
    run.attempt,
    0,
    MAX_ATTEMPTS,
    "attempt"
  );

  if (typeof run.reviewRequired !== "boolean" || typeof run.outcomeUncertain !== "boolean") bad("Complete durable run flags required");
  if (Object.hasOwn(run,"cancelRequested") && typeof run.cancelRequested !== "boolean") bad("Invalid cancellation flag");
  if (!["string","bigint"].includes(typeof run.fence)) bad("Exact durable fence required");
  if (run.fence !== "0" && run.fence !== 0n) checkFence(String(run.fence));
  if (run.leaseToken != null) checkId(run.leaseToken,"leaseToken");
  for (const key of ["leaseExpiresAt","nextEligibleAt","completedAt"]) if (run[key] != null) dateOf(run[key],key);
  if ((run.leaseToken == null) !== (run.leaseExpiresAt == null)) bad("Complete durable lease required");
  if (run.leaseToken != null && run.attempt === 0 && !run.outcomeUncertain) bad("Ordinary leases require a positive attempt");
  if (run.recoveryAttempts !== undefined) checkInteger(run.recoveryAttempts,0,MAX_RECOVERY_ATTEMPTS,"recoveryAttempts");

  return true;
}

function nextFence(value) {
  const fence =
    BigInt(value ?? 0) + 1n;

  if (fence > MAX_BIGINT) {
    throw new SyncRepositoryError(
      "FENCE_EXHAUSTED",
      "Sync fence exhausted"
    );
  }

  return fence.toString();
}

async function readNow(tx) {
  return dateOf(
    await tx.now(),
    "database time"
  );
}

function ensurePersistedClaim(
  row,
  expected,
  now
) {
  if (
    !sameClaim(
      row,
      expected,
      now
    ) ||
    row.attempt !== expected.attempt
  ) {
    throw new SyncRepositoryError(
      "UNKNOWN_DB_OUTCOME",
      "Claim was not durably verified",
      { uncertain: true }
    );
  }
}

function isDue(run, now, maxAttempts) {
  return (
    (
      !run.nextEligibleAt ||
      dateOf(
        run.nextEligibleAt,
        "nextEligibleAt"
      ) <= now
    ) &&
    (
      !run.leaseExpiresAt ||
      dateOf(
        run.leaseExpiresAt,
        "leaseExpiresAt"
      ) <= now
    ) &&
    !run.completedAt &&
    !run.reviewRequired &&
    run.outcomeUncertain !== true &&
    run.cancelRequested !== true &&
    run.attempt < maxAttempts &&
    // A retained expired token represents an unacknowledged claim. Recovery
    // must establish its outcome before another ordinary claim is issued.
    run.leaseToken == null
  );
}

function recoveryDisposition(run, now) {
  if (run.completedAt) return "COMPLETED";
  if (run.cancelRequested === true) return "CANCELLED";
  if (run.reviewRequired) return "REVIEW_REQUIRED";
  if (run.leaseExpiresAt && dateOf(run.leaseExpiresAt,"lease expiry") > now) return "LEASE_ACTIVE";
  if (run.nextEligibleAt && dateOf(run.nextEligibleAt,"nextEligibleAt") > now) return "NOT_DUE";
  if (!run.outcomeUncertain && run.leaseToken == null) return "NOT_REQUIRED";
  if (run.recoveryAttempts === undefined) return "RECOVERY_STATE_UNAVAILABLE";
  if (run.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) return "RECOVERY_LIMIT";
  return "ELIGIBLE";
}

function releasedLease(run) {
  return run.leaseToken == null && run.leaseExpiresAt == null && run.workerId == null;
}

function backoff(value) {
  return checkInteger(
    value,
    1000,
    MAX_DELAY_MS,
    "retry delay"
  );
}

function requireTx(tx) {
  checkMethods(
    tx,
    [
      "lockShop",
      "lockRun",
      "hasOtherLiveRun",
      "claimRun",
      "renewRun",
      "commitStep",
      "commitFailure",
      "verifyStepEvidence",
      "verifyPublished",
      "now",
    ],
    "tx"
  );
}

/**
 * Repository factory.
 *
 * The database adapter must implement SERIALIZABLE
 * transactions, SQL fencing, and commit verification.
 */
export function createSyncRunRepository({
  db,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  checkMethods(
    db,
    [
      "transaction",
      "getRunShop",
    ],
    "db"
  );

  checkInteger(
    maxAttempts,
    1,
    MAX_ATTEMPTS,
    "maxAttempts"
  );
  if (db.maxAttempts !== undefined && db.maxAttempts !== maxAttempts) bad("Repository and SQL adapter attempt budgets must match");

  async function transaction(action) {
    return db.transaction(
      async (tx) => {
        requireTx(tx);
        return action(tx);
      },
      {
        isolationLevel: "Serializable",
      }
    );
  }

  return freeze({
    /** Scheduling information only, never a grant to clear uncertainty or issue
     * remote work. Recovery must recheck scope, lease, due time and budget in
     * its own fenced claim transaction before acting on this snapshot. */
    async getRecoveryEligibility({ runId, shopId } = {}) {
      checkId(runId,"runId");
      if (shopId !== undefined) checkShop(shopId);
      const hintedShop = await db.getRunShop(runId);
      const missing = () => freeze({kind:"NOT_FOUND",eligible:false,runId});
      if (hintedShop == null || (shopId !== undefined && hintedShop !== shopId)) return missing();
      checkShop(hintedShop);
      return transaction(async tx => {
        if (!verifiedBoolean(await tx.lockShop(hintedShop),"shop lock")) return missing();
        const run = await tx.lockRun(runId);
        if (!validateRun(run,runId,hintedShop)) return missing();
        let reason = recoveryDisposition(run,await readNow(tx));
        if (reason === "ELIGIBLE" && verifiedBoolean(await tx.hasOtherLiveRun(hintedShop,runId),"shop coordination")) reason="SHOP_BUSY";
        return freeze({kind:reason === "ELIGIBLE" ? "ELIGIBLE" : "INELIGIBLE",eligible:reason === "ELIGIBLE",reason,
          runId,shopId:hintedShop,generationId:run.generationId,phase:run.phase,fence:String(run.fence),
          attempt:run.attempt,recoveryAttempts:run.recoveryAttempts ?? null});
      });
    },
    /**
     * Claim one eligible SyncRun.
     *
     * Shop identity is resolved from durable state.
     * The adapter must enforce shop-level coordination.
     */
    async claimRun({
      runId,
      workerId,
      leaseSeconds,
    }) {
      checkId(runId, "runId");
      checkId(workerId, "workerId");

      checkInteger(
        leaseSeconds,
        1,
        MAX_LEASE_SECONDS,
        "leaseSeconds"
      );

      // A hint only. The locked run is authoritative.
      const hintedShop =
        await db.getRunShop(runId);

      if (hintedShop == null) {
        return null;
      }

      checkShop(hintedShop);

      return transaction(async (tx) => {
        if (
          !verifiedBoolean(await tx.lockShop(hintedShop), "shop lock")
        ) {
          return null;
        }

        const run =
          await tx.lockRun(runId);

        if (
          !validateRun(
            run,
            runId,
            hintedShop
          )
        ) {
          return null;
        }

        const now =
          await readNow(tx);

        if (
          !isDue(run, now, maxAttempts)
        ) {
          return null;
        }

        if (
          verifiedBoolean(await tx.hasOtherLiveRun(
            hintedShop,
            runId
          ), "shop coordination")
        ) {
          return null;
        }

        const fence =
          nextFence(run.fence);

        const leaseToken =
          randomUUID().replaceAll("-", "");

        // Successful claim increments attempt ONCE.
        const expected =
          validateClaim({
            runId,
            shopId: hintedShop,
            generationId:
              run.generationId,
            phase: run.phase,
            leaseToken,
            fence,
            attempt: run.attempt + 1,
          }, maxAttempts);

        const updated =
          await tx.claimRun(
            runId,
            {
              shopId: hintedShop,
              maxAttempts,
              workerId,
              leaseToken,
              leaseSeconds,
              fence,

              attempt:
                run.attempt + 1,

              expectedPhase:
                run.phase,

              expectedGenerationId:
                run.generationId,

              expectedPreviousFence:
                String(
                  run.fence ?? 0
                ),
            }
          );

        if (!updated) {
          throw new SyncRepositoryError(
            "UNKNOWN_DB_OUTCOME",
            "Claim commit not verified",
            {
              uncertain: true,
            }
          );
        }

        ensurePersistedClaim(
          updated,
          expected,
          await readNow(tx)
        );

        return expected;
      });
    },

    /**
     * Renew only the currently valid claim.
     */
    async renewLease({
      claim,
      leaseSeconds,
    }) {
      const c =
        validateClaim(claim, maxAttempts);

      checkInteger(
        leaseSeconds,
        1,
        MAX_LEASE_SECONDS,
        "leaseSeconds"
      );

      return transaction(async (tx) => {
        if (
          !verifiedBoolean(await tx.lockShop(c.shopId), "shop lock")
        ) {
          return freeze({
            kind: "STALE_CLAIM",
          });
        }

        const run =
          await tx.lockRun(
            c.runId
          );

        const now =
          await readNow(tx);

        if (
          !sameClaim(run, c, now)
        ) {
          return freeze({
            kind: "STALE_CLAIM",
          });
        }

        const oldExpiry = dateOf(run.leaseExpiresAt, "old lease expiry");
        const updated =
          await tx.renewRun(
            c.runId,
            {
              claim: c,
              leaseSeconds,
            }
          );

        if (
          !updated ||
          !sameClaim(
            updated,
            c,
            await readNow(tx)
          ) ||
          dateOf(
            updated.leaseExpiresAt,
            "new lease expiry"
          ) <=
          oldExpiry
        ) {
          throw new SyncRepositoryError(
            "UNKNOWN_DB_OUTCOME",
            "Renewal commit not verified",
            {
              uncertain: true,
            }
          );
        }

        return freeze({
          kind: "RENEWED",
        });
      });
    },

    /**
     * Record a successful phase outcome.
     *
     * An ADVANCE proposal is not sufficient evidence.
     * Durable receipts must be verified by the adapter.
     */
    async recordStep({
      claim,
      result,
    }) {
      const c =
        validateClaim(claim, maxAttempts);

      result = dataRecord(result, ["kind", "delayMs"], ["kind"]);

      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result)
      ) {
        bad("Invalid step result");
      }

      const kind = oneOf(
        result.kind,
        RESULTS,
        "step result"
      );

      const delayMs =
        kind === "DEFER"
          ? backoff(result.delayMs)
          : null;

      if (
        kind === "COMPLETE" &&
        c.phase !== "PUBLISHING"
      ) {
        bad(
          "Cannot complete before publication"
        );
      }

      if (
        kind === "ADVANCE" &&
        c.phase === "PUBLISHING"
      ) {
        bad(
          "Publishing requires COMPLETE"
        );
      }

      return transaction(async (tx) => {
        if (
          !verifiedBoolean(await tx.lockShop(c.shopId), "shop lock")
        ) {
          return freeze({
            kind: "STALE_CLAIM",
          });
        }

        const run =
          await tx.lockRun(
            c.runId
          );

        const now =
          await readNow(tx);

        if (
          !sameClaim(run, c, now)
        ) {
          return freeze({
            kind: "STALE_CLAIM",
          });
        }

        if (
          kind === "ADVANCE" &&
          (await tx.verifyStepEvidence(
            run,
            result
          )) !== true
        ) {
          throw new SyncRepositoryError(
            "EVIDENCE_MISSING",
            "Missing verified durable phase evidence"
          );
        }

        if (
          kind === "COMPLETE" &&
          (await tx.verifyPublished(
            run
          )) !== true
        ) {
          throw new SyncRepositoryError(
            "PUBLICATION_MISSING",
            "Missing committed publication evidence"
          );
        }

        // Evidence reads can take time while the row lock remains held. The
        // adapter must repeat this check in SQL using the live database clock.
        if (!sameClaim(run, c, await readNow(tx))) return freeze({ kind: "STALE_CLAIM" });

        const patch = {
          claim: c,
          kind,

          nextPhase:
            kind === "ADVANCE"
              ? NEXT[c.phase]
              : null,

          delayMs,

          expectedGenerationId:
            c.generationId,
        };

        const updated =
          await tx.commitStep(
            c.runId,
            patch
          );

        if (
          !updated ||
          updated.id !== c.runId ||
          updated.shopId !== c.shopId ||
          updated.generationId !==
            c.generationId ||
          String(updated.fence) !== c.fence ||
          updated.attempt !== 0 ||
          updated.reviewRequired !== false ||
          updated.outcomeUncertain !== false ||

          (
            kind === "ADVANCE" &&
            updated.phase !==
              NEXT[c.phase]
          ) ||

          (
            kind === "ADVANCE" &&
            (
              updated.completedAt ||
              updated.reviewRequired
            )
          ) ||

          (
            kind === "COMPLETE" &&
            (
              !updated.completedAt ||
              !Number.isFinite(dateOf(updated.completedAt, "completion time").getTime()) ||
              updated.phase !==
                "PUBLISHING"
            )
          ) ||

          (
            kind === "DEFER" &&
            (
              updated.phase !== c.phase ||
              updated.completedAt ||
              !(
                dateOf(
                  updated.nextEligibleAt,
                  "nextEligibleAt"
                ) > now
              )
            )
          ) ||

          !releasedLease(updated) ||
          updated.cancelRequested === true ||
          (kind !== "DEFER" && updated.nextEligibleAt != null)
        ) {
          throw new SyncRepositoryError(
            "UNKNOWN_DB_OUTCOME",
            "Step commit not verified",
            {
              uncertain: true,
            }
          );
        }

        return freeze({
          kind: "RECORDED",
        });
      });
    },

    /**
     * Record a failure without allowing a stale
     * worker to alter the newer claim.
     */
    async recordFailure({
      claim,
      failure,
    }) {
      const c =
        validateClaim(claim, maxAttempts);

      failure = dataRecord(failure, ["code", "retryable", "outcomeUncertain", "retryAfterMs"], ["code", "retryable", "outcomeUncertain"]);

      if (
        !failure ||
        typeof failure !== "object" ||
        Array.isArray(failure) ||

        typeof failure.code !== "string" ||
        !/^[A-Z_]{1,64}$/.test(
          failure.code
        ) ||

        typeof failure.retryable !==
          "boolean" ||

        typeof failure.outcomeUncertain !==
          "boolean"
      ) {
        bad("Invalid failure");
      }

      if (!failure.retryable && failure.retryAfterMs != null) bad("Non-retryable failures cannot request an ordinary retry delay");
      const delayMs = failure.retryable ? backoff(failure.retryAfterMs) : failure.outcomeUncertain ? 1000 : null;

      return transaction(async (tx) => {
        if (
          !verifiedBoolean(await tx.lockShop(c.shopId), "shop lock")
        ) {
          return freeze({
            kind: "STALE_CLAIM",
          });
        }

        const run =
          await tx.lockRun(
            c.runId
          );

        const now =
          await readNow(tx);

        if (
          !sameClaim(run, c, now)
        ) {
          return freeze({
            kind: "STALE_CLAIM",
          });
        }

        const retryable =
          !failure.outcomeUncertain && failure.retryable &&
          run.attempt < maxAttempts;
        const reviewRequired = !failure.outcomeUncertain && !retryable;
        const scheduled = retryable || failure.outcomeUncertain;

        const updated =
          await tx.commitFailure(
            c.runId,
            {
              claim: c,

              code: failure.code,

              retryable,

              outcomeUncertain:
                failure.outcomeUncertain,

              retryAfterMs:
                scheduled
                  ? delayMs
                  : null,

              attempt:
                c.attempt,

              reviewRequired:
                reviewRequired,
            }
          );

        if (
          !updated ||
          updated.id !== c.runId ||
          updated.shopId !== c.shopId ||
          updated.generationId !==
            c.generationId ||
          String(updated.fence) !== c.fence ||
          updated.completedAt ||

          updated.attempt !==
            c.attempt ||

          updated.phase !== c.phase ||

          updated.outcomeUncertain !==
            failure.outcomeUncertain ||

          !releasedLease(updated) || updated.cancelRequested === true ||

          (
            scheduled &&
            !(
              dateOf(
                updated.nextEligibleAt,
                "nextEligibleAt"
              ) > now
            )
          ) ||

          updated.reviewRequired !== reviewRequired ||
          (!scheduled && updated.nextEligibleAt != null)
        ) {
          throw new SyncRepositoryError(
            "UNKNOWN_DB_OUTCOME",
            "Failure commit not verified",
            {
              uncertain: true,
            }
          );
        }

        return freeze({
          kind: "RECORDED",
          retryable,
          reviewRequired,
          outcomeUncertain: failure.outcomeUncertain,
        });
      });
    },
  });
}
