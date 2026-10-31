/** Fenced recovery orchestration. External verification is read-only and runs
 * outside transactions. The repository alone owns eligibility, leases, durable
 * intent, retry budgets and the decision to clear uncertainty.
 */
import { SyncOutcomeUnknownError } from "./sync-db-transaction.server.js";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PHASES = new Set(["STARTING", "WAITING", "INGESTING", "RECONCILING", "PUBLISHING"]);
const validId = value => typeof value === "string" && ID.test(value);
const bad = message => { throw Object.assign(new Error(message), { code:"INVALID_RECOVERY_CONTRACT" }); };
const deadlineError = stage => Object.assign(new Error(`${stage} deadline exceeded`), { code:"RECOVERY_DEADLINE" });

function snapshot(value, budget = { nodes:0 }, depth = 0) {
  if (++budget.nodes > 1000 || depth > 8) bad("Recovery evidence exceeds its budget");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Buffer.byteLength(value) <= 32768) return value;
  if (typeof value !== "object" || !value) bad("Plain recovery evidence required");
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) bad("Plain recovery evidence required");
  const copy = array ? [] : Object.create(null);
  const keys = Reflect.ownKeys(value).filter(key => !(array && key === "length"));
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) bad("Dense recovery evidence required");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key) || !Object.hasOwn(descriptor, "value")) {
      bad("Recovery accessors are not permitted");
    }
    copy[key] = snapshot(descriptor.value, budget, depth + 1);
  }
  if (depth === 0 && Buffer.byteLength(JSON.stringify(copy)) > 65536) bad("Recovery evidence exceeds its byte budget");
  return Object.freeze(copy);
}

function validateScope(value, claim) {
  for (const key of ["runId", "shopId", "generationId", "fence", "leaseToken"]) {
    if (Object.hasOwn(value, key) && value[key] !== claim[key]) bad("Recovery scope mismatch");
  }
  if (Object.hasOwn(value, "intentId") && value.intentId !== claim.intent.id) bad("Recovery intent mismatch");
}
function validateClaim(raw, runId) {
  const claim = snapshot(raw);
  if (!claim || Array.isArray(claim) || claim.runId !== runId || !validId(claim.generationId) || !validId(claim.leaseToken) ||
      typeof claim.shopId !== "string" || claim.shopId.length > 255 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(claim.shopId) ||
      typeof claim.fence !== "string" || !/^[1-9][0-9]{0,18}$/.test(claim.fence) || BigInt(claim.fence) > 9223372036854775807n ||
      !PHASES.has(claim.phase) || !claim.intent || Array.isArray(claim.intent) || !validId(claim.intent.id)) {
    bad("Exact durable recovery claim and intent required");
  }
  validateScope(claim.intent, claim);
  if (Object.hasOwn(claim.intent, "recoveryFence") && claim.intent.recoveryFence !== claim.fence) bad("Recovery intent fence mismatch");
  return claim;
}
function validateVerification(raw, claim) {
  const result = snapshot(raw);
  if (!result || !["CONFIRMED", "SAFE_TO_RETRY", "UNRESOLVED"].includes(result.kind)) bad("Invalid authoritative recovery result");
  validateScope(result, claim);
  if (Object.hasOwn(result,"phase") && result.phase !== claim.phase) bad("Recovery phase mismatch");
  if (result.kind !== "UNRESOLVED") {
    if (result.authoritative !== true || !result.evidence || typeof result.evidence !== "object" ||
        Array.isArray(result.evidence) || !Object.keys(result.evidence).length) bad("Authoritative recovery evidence required");
    validateScope(result.evidence, claim);
    if (Object.hasOwn(result.evidence,"phase") && result.evidence.phase !== claim.phase) bad("Recovery phase mismatch");
  }
  return result;
}
function validateReceipt(raw, claim, allowed) {
  const receipt = snapshot(raw);
  if (!receipt || !allowed.includes(receipt.kind)) bad("Unverified recovery acknowledgment");
  validateScope(receipt, claim);
  if (Object.hasOwn(receipt,"phase") && receipt.phase !== claim.phase) bad("Recovery phase mismatch");
  for (const key of ["reviewRequired", "retryable", "outcomeUncertain"]) {
    if (Object.hasOwn(receipt, key) && typeof receipt[key] !== "boolean") bad("Invalid recovery disposition");
  }
  if (receipt.kind === "RESUMED" && (receipt.reviewRequired === true || receipt.outcomeUncertain === true)) bad("Contradictory recovery acknowledgment");
  if (receipt.kind === "RECORDED" && receipt.outcomeUncertain === false) bad("Recovery failure cannot clear uncertainty");
  if ((receipt.kind === "REVIEW_REQUIRED" && receipt.reviewRequired === false) ||
      (receipt.reviewRequired === true && receipt.retryable === true)) bad("Contradictory recovery disposition");
  return receipt;
}
function checkDeadline(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError("Invalid recovery deadline");
}
function method(object, name, label) {
  if (typeof object?.[name] !== "function") throw new TypeError(`Missing ${label}.${name}`);
  return object[name].bind(object);
}

/** A timer ends our wait, not a transaction already sent to the database.
 * Repository implementations must still enforce their own deadlines and CAS.
 * Late results are observed by Promise.race but never trigger another stage.
 */
async function bounded(work, timeoutMs, stage, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => {
        const error = deadlineError(stage);onTimeout?.(error);reject(error);
      }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
function abortableVerification(work, timeoutMs, callerSignal) {
  const controller = new AbortController();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => { controller.abort(callerSignal.reason);reject(Object.assign(new Error("Recovery cancelled"), { code:"RECOVERY_CANCELLED" })); };
    if (callerSignal?.aborted) onAbort();
    else callerSignal?.addEventListener("abort", onAbort, { once:true });
  });
  return bounded(() => Promise.race([
    Promise.resolve().then(() => { controller.signal.throwIfAborted();return work(controller.signal); }), aborted,
  ]), timeoutMs, "Verification", error => controller.abort(error)).finally(() => {
    callerSignal?.removeEventListener("abort", onAbort);
    controller.abort();
  });
}

export function createSyncRecoveryOrchestrator({ recoveryRepository, externalVerifier,
  verificationTimeoutMs = 30000, repositoryTimeoutMs = 15000 } = {}) {
  const repository = Object.freeze(Object.fromEntries(["claimRecovery", "finishRecovery", "recordRecoveryFailure"].map(name =>
    [name, method(recoveryRepository, name, "recoveryRepository")])));
  if (typeof externalVerifier?.verify !== "function") throw new TypeError("Read-only external verifier required");
  const verify = externalVerifier.verify.bind(externalVerifier);
  checkDeadline(verificationTimeoutMs, 90000);checkDeadline(repositoryTimeoutMs, 30000);

  async function persist(name, input, validate) {
    try {
      const raw = await bounded(() => repository[name](input), repositoryTimeoutMs, name);
      return validate(raw);
    } catch (error) {
      if (error instanceof SyncOutcomeUnknownError) throw error;
      throw new SyncOutcomeUnknownError(`${name} outcome requires durable verification`, error);
    }
  }
  async function defer(claim, reason) {
    const receipt = await persist("recordRecoveryFailure", { claim, reason }, raw =>
      validateReceipt(raw, claim, ["RECORDED", "STALE_CLAIM"]));
    return Object.freeze({ kind:receipt.kind === "STALE_CLAIM" ? "STALE_CLAIM"
      : receipt.reviewRequired === true ? "REVIEW_REQUIRED" : "RECOVERY_DEFERRED" });
  }
  return Object.freeze({
    async recoverRun(runId, { signal } = {}) {
      if (!validId(runId)) bad("Opaque recovery run identity required");
      if (signal !== undefined && !(signal instanceof AbortSignal)) bad("AbortSignal required");
      if (signal?.aborted) return Object.freeze({ kind:"RECOVERY_CANCELLED" });

      // Claim calls are bounded but never abandoned as though cancellation proved
      // rollback. If they commit late, the durable lease/recovery scanner wins.
      const claim = await persist("claimRecovery", { runId }, raw => raw === null ? null : validateClaim(raw, runId));
      if (claim === null) return Object.freeze({ kind:"NOT_CLAIMED" });
      if (signal?.aborted) return defer(claim, "VERIFICATION_ABORTED");

      let verification;
      try {
        verification = validateVerification(await abortableVerification(verificationSignal => verify({
          shopId:claim.shopId,generationId:claim.generationId,runId:claim.runId,
          phase:claim.phase,fence:claim.fence,intent:claim.intent,signal:verificationSignal,
        }), verificationTimeoutMs, signal), claim);
      } catch (error) {
        const code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error,"code")?.value : undefined;
        return defer(claim, signal?.aborted ? "VERIFICATION_ABORTED"
          : code === "INVALID_RECOVERY_CONTRACT" ? "VERIFICATION_INVALID"
          : code === "RECOVERY_DEADLINE" ? "VERIFICATION_TIMEOUT" : "VERIFICATION_FAILED");
      }
      if (signal?.aborted) return defer(claim, "VERIFICATION_ABORTED");

      // An authoritative flag or SAFE_TO_RETRY is not a permission grant. The
      // repository must validate evidence against the locked claim and intent.
      // Once a final write is sent, cancellation cannot prove it did not commit.
      return persist("finishRecovery", { claim, verification }, raw => {
        const receipt = validateReceipt(raw, claim, ["RESUMED", "REVIEW_REQUIRED", "STALE_CLAIM"]);
        if (verification.kind === "UNRESOLVED" && receipt.kind === "RESUMED") bad("Unresolved recovery cannot resume");
        return receipt;
      });
    },
  });
}

// Compatibility for existing integrations; both names issue the same workflow.
export const createSyncRecoveryService = createSyncRecoveryOrchestrator;
