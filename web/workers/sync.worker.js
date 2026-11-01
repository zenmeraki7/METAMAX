/**
 * METAMAX — Durable Shopify Catalog Sync Worker
 *
 * web/workers/sync.worker.js
 *
 * PostgreSQL:
 *   SyncRun, leases, fencing, phase transitions,
 *   retry eligibility and publication evidence.
 *
 * BullMQ:
 *   At-least-once delivery of { runId } notifications.
 *
 * Shopify Sync Steps:
 *   Start bulk, poll, ingest, reconcile, publish.
 *
 * One invocation handles ONE bounded step.
 *
 * No SQL, GraphQL or catalog normalization here.
 */

import { randomUUID } from "node:crypto";

export const SYNC_QUEUE_NAME =
  "metamax-catalog-sync";

export const RECOVERY_QUEUE_NAME =
  "metamax-catalog-sync-recovery";

export const SYNC_PHASES = Object.freeze({
  STARTING: "STARTING",
  WAITING: "WAITING",
  INGESTING: "INGESTING",
  RECONCILING: "RECONCILING",
  PUBLISHING: "PUBLISHING",
});

export const SYNC_RESULTS = Object.freeze({
  ADVANCE: "ADVANCE",
  DEFER: "DEFER",
  COMPLETE: "COMPLETE",
});

const PHASE_METHOD = Object.freeze({
  STARTING: "startBulk",
  WAITING: "checkBulk",
  INGESTING: "ingestChunk",
  RECONCILING: "reconcile",
  PUBLISHING: "publish",
});

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FENCE_RE = /^[1-9][0-9]{0,18}$/;
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const DEFAULTS = Object.freeze({
  leaseSeconds: 120,
  stepTimeoutMs: 90_000,
  heartbeatMs: 20_000,
  concurrency: 2,
  maxDelayMs: 900_000,
});

export class SyncWorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });

    this.name = "SyncWorkerError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.outcomeUncertain =
      options.outcomeUncertain === true;
  }
}

function requireMethod(target, name, label) {
  if (typeof target?.[name] !== "function") {
    throw new TypeError(
      `${label}.${name}() is required`
    );
  }
}

function requireId(value, label) {
  if (
    typeof value !== "string" ||
    !ID_RE.test(value)
  ) {
    throw new SyncWorkerError(
      "INVALID_ID",
      `Invalid ${label}`
    );
  }

  return value;
}

function positiveInt(value, label, max) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new RangeError(`Invalid ${label}`);
  }

  return value;
}

function safeLog(logger, level, payload) {
  try {
    const result = logger?.[level]?.(payload);

    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Diagnostics cannot alter business outcomes.
  }
}

function dataRecord(value, keys, required) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new SyncWorkerError("INVALID_CONTRACT", "Plain synchronization data required");
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      if (required.includes(key)) throw new SyncWorkerError("INVALID_CONTRACT", "Incomplete synchronization data");
      continue;
    }
    if (!Object.hasOwn(descriptor, "value")) {
      throw new SyncWorkerError("INVALID_CONTRACT", "Synchronization accessors are not permitted");
    }
    result[key] = descriptor.value;
  }
  return result;
}

function validateClaim(value, runId) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new SyncWorkerError(
      "INVALID_CLAIM",
      "Durable execution claim required"
    );
  }

  const keys = ["runId", "shopId", "generationId", "leaseToken", "fence", "phase", "attempt"];
  value = dataRecord(value, keys, keys);

  requireId(value.runId, "claimed run");
  requireId(value.generationId, "generation");
  requireId(value.leaseToken, "lease token");

  if (value.runId !== runId) {
    throw new SyncWorkerError(
      "CLAIM_MISMATCH",
      "Claimed run does not match requested run"
    );
  }

  if (
    typeof value.shopId !== "string" ||
    value.shopId.length < 1 ||
    value.shopId.length > 255 ||
    !SHOP_RE.test(value.shopId)
  ) {
    throw new SyncWorkerError(
      "INVALID_CLAIM",
      "Invalid resolved shop identity"
    );
  }

  if (
    typeof value.fence !== "string" ||
    !FENCE_RE.test(value.fence) ||
    BigInt(value.fence) > 9223372036854775807n
  ) {
    throw new SyncWorkerError(
      "INVALID_CLAIM",
      "Invalid fencing token"
    );
  }

  if (
    !Object.hasOwn(PHASE_METHOD, value.phase)
  ) {
    throw new SyncWorkerError(
      "INVALID_PHASE",
      "Unsupported synchronization phase"
    );
  }

  if (
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 0
  ) {
    throw new SyncWorkerError(
      "INVALID_CLAIM",
      "Invalid attempt counter"
    );
  }

  return Object.freeze({
    runId: value.runId,
    shopId: value.shopId,
    generationId: value.generationId,
    leaseToken: value.leaseToken,
    fence: value.fence,
    phase: value.phase,
    attempt: value.attempt,
  });
}

function validateStepResult(value, phase) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new SyncWorkerError(
      "INVALID_STEP_RESULT",
      "Invalid synchronization result"
    );
  }

  value = dataRecord(value, ["kind", "delayMs"], ["kind"]);

  const kind = value.kind;

  if (!Object.values(SYNC_RESULTS).includes(kind)) {
    throw new SyncWorkerError(
      "INVALID_STEP_RESULT",
      "Unsupported step outcome"
    );
  }

  if (
    kind === "COMPLETE" &&
    phase !== SYNC_PHASES.PUBLISHING
  ) {
    throw new SyncWorkerError(
      "INVALID_STEP_RESULT",
      "Only publication may complete a sync"
    );
  }

  if (
    kind === "ADVANCE" &&
    phase === SYNC_PHASES.PUBLISHING
  ) {
    throw new SyncWorkerError(
      "INVALID_STEP_RESULT",
      "Publication requires verified completion"
    );
  }

  if (kind === "DEFER") {
    if (
      !Number.isSafeInteger(value.delayMs) ||
      value.delayMs < 1000 ||
      value.delayMs > DEFAULTS.maxDelayMs
    ) {
      throw new SyncWorkerError(
        "INVALID_STEP_RESULT",
        "Invalid synchronization delay"
      );
    }
  }

  return Object.freeze({
    kind,
    ...(kind === "DEFER"
      ? { delayMs: value.delayMs }
      : {}),
  });
}

function classifyError(error) {
  if (error instanceof SyncWorkerError) {
    return {
      code: error.code,
      retryable: error.retryable,
      outcomeUncertain: error.outcomeUncertain,
    };
  }

  return {
    code: "SYNC_OPERATION_FAILED",
    retryable: true,
    outcomeUncertain: true,
  };
}

function retryDelay(attempt) {
  const bounded = Math.max(
    0,
    Math.min(8, attempt)
  );

  return Math.min(
    5000 * 2 ** bounded,
    DEFAULTS.maxDelayMs
  );
}

function validateRecordOutcome(result, operation) {
  if (
    result?.kind !== "RECORDED" &&
    result?.kind !== "STALE_CLAIM"
  ) {
    throw new SyncWorkerError(
      "DURABLE_RESULT_UNKNOWN",
      `Unverified ${operation} database outcome`,
      { outcomeUncertain: true }
    );
  }

  return result.kind;
}

/**
 * Processor dependencies:
 *
 * repository.claimRun(...)
 * repository.renewLease(...)
 * repository.recordStep(...)
 * repository.recordFailure(...)
 *
 * syncSteps.startBulk(...)
 * syncSteps.checkBulk(...)
 * syncSteps.ingestChunk(...)
 * syncSteps.reconcile(...)
 * syncSteps.publish(...)
 *
 * All database writes MUST be fenced.
 */
export function createSyncProcessor({
  repository,
  syncSteps,
  workerId = randomUUID(),
  logger = console,
  leaseSeconds = DEFAULTS.leaseSeconds,
  stepTimeoutMs = DEFAULTS.stepTimeoutMs,
  heartbeatMs = DEFAULTS.heartbeatMs,
} = {}) {
  for (const method of [
    "claimRun",
    "renewLease",
    "recordStep",
    "recordFailure",
  ]) {
    requireMethod(repository, method, "repository");
  }

  for (const method of Object.values(
    PHASE_METHOD
  )) {
    requireMethod(syncSteps, method, "syncSteps");
  }

  requireId(workerId, "worker identity");

  positiveInt(leaseSeconds, "leaseSeconds", 3600);
  positiveInt(
    stepTimeoutMs,
    "stepTimeoutMs",
    3_600_000
  );
  positiveInt(
    heartbeatMs,
    "heartbeatMs",
    600_000
  );

  if (
    heartbeatMs * 2 >= leaseSeconds * 1000
  ) {
    throw new RangeError(
      "Heartbeat must be less than half the lease"
    );
  }

  // Database methods must also use server-side timeouts and conditional writes.
  // Ending our wait cannot cancel an already dispatched database transaction.
  async function callRepository(method, input) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => repository[method](input)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new SyncWorkerError(
            "DURABLE_RESULT_UNKNOWN",
            `Synchronization repository ${method} exceeded its deadline`,
            { retryable: true, outcomeUncertain: true },
          )), stepTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function processRun(runId) {
    requireId(runId, "SyncRun identity");

    /*
     * claimRun must:
     * - Verify the durable run and shop
     * - Check phase and next eligibility time
     * - Acquire a PostgreSQL execution lease
     * - Enforce per-shop execution coordination
     * - Increment its fencing value
     * - Return the authoritative claim
     */
    const raw = await callRepository("claimRun", {
      runId,
      workerId,
      leaseSeconds,
    });

    if (raw === null) {
      return Object.freeze({
        kind: "NOT_CLAIMED",
        runId,
      });
    }

    const claim = validateClaim(raw, runId);
    const method = PHASE_METHOD[claim.phase];

    const controller = new AbortController();

    let timedOut = false;
    let leaseLost = false;
    let heartbeatPending = null;
    let closed = false;
    let abortListener;

    const timeoutError = new SyncWorkerError(
      "STEP_TIMEOUT",
      "Sync step exceeded its execution deadline",
      {
        retryable: true,
        outcomeUncertain: true,
      }
    );

    let deadline;
    let heartbeatTimer;

    /*
     * A hard promise deadline prevents this worker
     * invocation waiting indefinitely.
     *
     * It does not kill the adapter. All adapter
     * writes must check the database fence.
     */
    const timeoutPromise = new Promise(
      (_, reject) => {
        deadline = setTimeout(() => {
          timedOut = true;
          controller.abort(timeoutError);
          reject(timeoutError);
        }, stepTimeoutMs);

      }
    );

    async function heartbeat() {
      if (
        closed || heartbeatPending ||
        controller.signal.aborted
      ) {
        return;
      }

      heartbeatPending = (async () => {
        try {
          const result =
            await repository.renewLease({
              claim,
              leaseSeconds,
            });

          if (result?.kind !== "RENEWED") {
            leaseLost = true;

            controller.abort(
              new SyncWorkerError(
                "LEASE_LOST",
                "Synchronization lease was lost",
                { outcomeUncertain: true }
              )
            );
          }
        } catch {
          leaseLost = true;

          controller.abort(
            new SyncWorkerError(
              "LEASE_RENEWAL_FAILED",
              "Unable to renew sync lease",
              { outcomeUncertain: true }
            )
          );
        }
      })().finally(() => {
        heartbeatPending = null;
      });

      await heartbeatPending;
    }

    heartbeatTimer = setInterval(
      () => { void heartbeat(); },
      heartbeatMs
    );

    heartbeatTimer.unref?.();

    let result;
    let failure;
    let source = {};

    try {
      const stepPromise = Promise.resolve().then(
        () => syncSteps[method]({
          claim,
          signal: controller.signal,
        })
      );

      /*
       * Observe adapter rejections even if the
       * timeout wins the Promise.race().
       */
      const abortPromise = new Promise(
        (_, reject) => {
          const onAbort = () => reject(
            controller.signal.reason ??
            new SyncWorkerError(
              "STEP_ABORTED",
              "Synchronization step aborted",
              { outcomeUncertain: true }
            )
          );
          abortListener = onAbort;

          if (controller.signal.aborted) {
            onAbort();
          } else {
            controller.signal.addEventListener(
              "abort",
              onAbort,
              { once: true }
            );
          }
        }
      );

      result = validateStepResult(
        await Promise.race([
          stepPromise,
          timeoutPromise,
          abortPromise,
        ]),
        claim.phase
      );
    } catch (error) {
      failure = classifyError(error);
      try {
        const value=(key,pattern)=>{
          const descriptor=Object.getOwnPropertyDescriptor(error??{},key);
          return descriptor && Object.hasOwn(descriptor,'value') && typeof descriptor.value==='string' && pattern.test(descriptor.value) ? descriptor.value : null;
        };
        source={sourceCode:value('code',/^[A-Z0-9_]{1,64}$/),sourceType:value('name',/^[A-Za-z]{1,64}$/),
          sourceConstraint:value('constraint',/^[a-z0-9_]{1,63}$/),sourceStage:value('catalogStage',/^(CONTEXT|DOWNLOAD|IMPORT)$/)};
      } catch { /* Diagnostics cannot prevent durable failure/recovery handling. */ }
    } finally {
      closed = true;
      clearInterval(heartbeatTimer);

      /*
       * No new heartbeat should overlap final
       * commit/failure handling.
       */
      if (heartbeatPending) {
        try {
          await Promise.race([heartbeatPending, timeoutPromise]);
        } catch {
          // A renewal whose outcome is unknown cannot authorize acknowledgment.
          leaseLost = true;
        }
      }
      clearTimeout(deadline);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
    }

    /*
     * A lost lease always overrides a step result.
     * The stale worker cannot acknowledge work.
     */
    if (leaseLost) {
      return Object.freeze({
        kind: "STALE_CLAIM",
        runId,
        phase: claim.phase,
      });
    }

    if (timedOut && !failure) {
      failure = classifyError(timeoutError);
    }

    if (failure) {
      /*
       * recordFailure must conditionally match:
       * shop, run, generation, phase,
       * lease token, fence and lease expiry.
       *
       * An uncertain external effect must be
       * reconciled before executing it again.
       */
      const receipt = await callRepository("recordFailure", {
          claim,
          failure: {
            ...failure,
            retryAfterMs: failure.retryable
              ? retryDelay(claim.attempt)
              : null,
          },
        });
      const recorded = validateRecordOutcome(receipt, "failure");

      safeLog(logger, "error", {
        event: "catalog_sync_failure",
        runId,
        phase: claim.phase,
        code: failure.code,
        ...source,
        recorded,
      });

      let kind;
      if (recorded === "STALE_CLAIM") kind = "STALE_CLAIM";
      else if (receipt.reviewRequired === true) kind = "REVIEW_REQUIRED";
      else if (receipt.outcomeUncertain === true) kind = "RECOVERY_REQUIRED";
      else if (receipt.retryable === false) kind = "REVIEW_REQUIRED";
      else kind = failure.retryable ? "RETRY_SCHEDULED" : "REVIEW_REQUIRED";

      return Object.freeze({
        kind,
        runId,
        phase: claim.phase,
      });
    }

    /*
     * An ADVANCE does not necessarily mean the
     * whole phase is complete.
     *
     * The repository decides whether durable
     * checkpoints permit phase advancement.
     *
     * DEFER persists the next eligible time.
     *
     * COMPLETE requires durable, verified
     * publication evidence.
     */
    const recorded = validateRecordOutcome(
      await callRepository("recordStep", {
        claim,
        result,
      }),
      "step"
    );

    safeLog(logger, "info", {
      event: "catalog_sync_step",
      runId,
      phase: claim.phase,
      outcome: result.kind,
      recorded,
    });

    return Object.freeze({
      kind: recorded === "STALE_CLAIM"
        ? "STALE_CLAIM"
        : result.kind,
      runId,
      phase: claim.phase,
      ...(recorded === "RECORDED" &&
          result.kind === "DEFER"
        ? { delayMs: result.delayMs }
        : {}),
    });
  }

  return Object.freeze({ processRun });
}

/**
 * BullMQ delivery adapter.
 *
 * Job data MUST contain only:
 * { runId: "durable_sync_run_id" }
 *
 * The authenticated shop, generation, lease,
 * fence and phase are loaded from PostgreSQL.
 */
export function createBullMQSyncWorker({
  Worker,
  connection,
  processor,
  logger = console,
  concurrency = DEFAULTS.concurrency,
} = {}) {
  if (typeof Worker !== "function") {
    throw new TypeError(
      "BullMQ Worker constructor required"
    );
  }

  if (!connection) {
    throw new TypeError(
      "Redis connection required"
    );
  }

  requireMethod(processor, "processRun", "processor");

  positiveInt(
    concurrency,
    "concurrency",
    32
  );

  const worker = new Worker(
    SYNC_QUEUE_NAME,
    async (job) => {
      const data = job?.data;

      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(data)) ||
        Reflect.ownKeys(data).length !== 1 ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(data, "runId") ?? {}, "value")
      ) {
        throw new SyncWorkerError(
          "INVALID_JOB",
          "Sync job must contain only runId"
        );
      }

      return processor.processRun(
        requireId(data.runId, "job runId")
      );
    },
    {
      connection,
      concurrency,
      autorun: false,
      maxStalledCount: 2,
    }
  );

  worker.on("failed", (job, error) => {
    safeLog(logger, "error", {
      event: "sync_job_failed",
      jobId: job?.id,
      code: error?.code ?? "UNKNOWN",
    });
  });

  worker.on("stalled", (jobId) => {
    safeLog(logger, "error", {
      event: "sync_job_stalled",
      jobId,
    });
  });

  worker.on("error", (error) => {
    safeLog(logger, "error", {
      event: "sync_worker_error",
      code: error?.code ?? "UNKNOWN",
    });
  });

  return worker;
}

/**
 * BullMQ recovery delivery adapter.
 *
 * Job data MUST contain only:
 * { runId: "durable_sync_run_id" }
 *
 * The authenticated shop, generation, lease,
 * fence and recovery state are loaded from PostgreSQL.
 */
export function createBullMQRecoveryWorker({
  Worker,
  connection,
  recovery,
  logger = console,
  concurrency = DEFAULTS.concurrency,
} = {}) {
  if (typeof Worker !== "function") {
    throw new TypeError(
      "BullMQ Worker constructor required"
    );
  }

  if (!connection) {
    throw new TypeError(
      "Redis connection required"
    );
  }

  requireMethod(recovery, "recoverRun", "recovery");

  positiveInt(
    concurrency,
    "concurrency",
    32
  );

  const worker = new Worker(
    RECOVERY_QUEUE_NAME,
    async (job) => {
      const data = job?.data;

      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(data)) ||
        Reflect.ownKeys(data).length !== 1 ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(data, "runId") ?? {}, "value")
      ) {
        throw new SyncWorkerError(
          "INVALID_JOB",
          "Recovery job must contain only runId"
        );
      }

      return recovery.recoverRun(
        requireId(data.runId, "job runId")
      );
    },
    {
      connection,
      concurrency,
      autorun: false,
      maxStalledCount: 2,
    }
  );

  worker.on("failed", (job, error) => {
    safeLog(logger, "error", {
      event: "sync_recovery_job_failed",
      jobId: job?.id,
      code: error?.code ?? "UNKNOWN",
    });
  });

  worker.on("stalled", (jobId) => {
    safeLog(logger, "error", {
      event: "sync_recovery_job_stalled",
      jobId,
    });
  });

  worker.on("error", (error) => {
    safeLog(logger, "error", {
      event: "sync_recovery_worker_error",
      code: error?.code ?? "UNKNOWN",
    });
  });

  return worker;
}
