/** PostgreSQL/Prisma persistence boundary for the phase repository.
 * Transaction policy and physical verification stay in dedicated modules;
 * this adapter owns scoped locks, claim CAS and phase-evidence gates.
 */
import { runSyncDbTransaction, assertSyncDriver } from "./sync-db-transaction.server.js";
import { requireSyncRunDbMapping, revalidateSyncRunDbMapping, quoteSyncTable, quoteSyncIdentifier } from "./sync-run-schema.server.js";
import {consumeFreshDispatchClaim} from './sync-dispatch-consumption.server.js';
export { runSyncDbTransaction, SyncOutcomeUnknownError } from "./sync-db-transaction.server.js";
export { verifySyncRunDbMapping } from "./sync-run-schema.server.js";

const PHASES = new Set(["STARTING", "WAITING", "INGESTING", "RECONCILING", "PUBLISHING"]);
const NEXT = Object.freeze({ STARTING:"WAITING", WAITING:"INGESTING", INGESTING:"RECONCILING", RECONCILING:"PUBLISHING" });
const CLAIM_KEYS = ["runId", "shopId", "generationId", "phase", "leaseToken", "fence", "attempt"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export class SyncDbAdapterError extends Error {
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "SyncDbAdapterError";
    this.code = code;
  }
}
const fail = (code, message) => { throw new SyncDbAdapterError(code, message); };
function id(value) {
  if (typeof value !== "string" || !ID.test(value)) fail("INVALID_ID", "Opaque identity required");
  return value;
}
function shop(value) {
  if (typeof value !== "string" || value.length > 255 || !SHOP.test(value)) fail("INVALID_SHOP", "Authenticated shop identity required");
  return value;
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail("INVALID_INTEGER", "Bounded integer required");
  return value;
}
function fence(value) {
  if ((typeof value !== "string" && typeof value !== "bigint") || !/^(0|[1-9][0-9]{0,18})$/.test(String(value)) ||
      BigInt(value) > 9223372036854775807n) fail("INVALID_FENCE", "Exact bigint fence required");
  return String(value);
}
function captureClaim(input, runId, maxAttempts) {
  if (!input || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail("INVALID_CLAIM", "Plain claim required");
  const claim = {};
  for (const key of CLAIM_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID_CLAIM", "Claim data properties required");
    claim[key] = descriptor.value;
  }
  id(runId); shop(claim.shopId); id(claim.generationId); id(claim.leaseToken);
  claim.fence = fence(claim.fence);
  integer(claim.attempt, 1, maxAttempts);
  if (claim.runId !== runId || !PHASES.has(claim.phase) || claim.fence === "0") fail("INVALID_CLAIM", "Exact phase claim required");
  return Object.freeze(claim);
}
function sameClaim(row, claim) {
  return row && row.id === claim.runId && row.shopId === claim.shopId && row.generationId === claim.generationId &&
    row.phase === claim.phase && row.leaseToken === claim.leaseToken && row.fence === claim.fence && row.attempt === claim.attempt;
}

function createSqlLayout(mapping) {
  const c = Object.freeze(Object.fromEntries(Object.entries(mapping.runs.columns).map(([key, value]) => [key, quoteSyncIdentifier(value)])));
  return Object.freeze({
    c,
    runTable: quoteSyncTable(mapping.runs.table),
    shopTable: quoteSyncTable(mapping.shops.table),
    shopColumn: quoteSyncIdentifier(mapping.shops.columns.shopId),
    projection: Object.keys(c).map(key => `${c[key]} AS "${key}"`).join(", "),
    eligible: `${c.completedAt} IS NULL AND NOT ${c.reviewRequired} AND NOT ${c.outcomeUncertain}` +
      (c.cancelRequested ? ` AND NOT ${c.cancelRequested}` : ""),
  });
}

/** Reads and writes share the barrier, schema checks and transaction policy.
 * SQL capabilities also close when the callback exits on the Prisma path.
 */
function createVerifiedTransaction(settings, mapping) {
  return (work, readOnly = false) => runSyncDbTransaction({ ...settings, readOnly,
    work: async raw => {
      let active = true;
      const assertActive = () => { if (!active) fail("TRANSACTION_CLOSED", "Synchronization transaction has ended"); };
      const tx = Object.freeze({
        $queryRawUnsafe: (...args) => { assertActive(); return raw.$queryRawUnsafe(...args); },
        $executeRawUnsafe: (...args) => { assertActive(); return raw.$executeRawUnsafe(...args); },
      });
      try {
        await revalidateSyncRunDbMapping(tx, mapping);
        return await work(tx);
      } finally { active = false; }
    },
  });
}

function createTransactionAdapter({ tx, sql, maxAttempts, normalize, validators }) {
  const { c, runTable, shopTable, shopColumn, projection, eligible } = sql;
  const rows = (text, ...values) => tx.$queryRawUnsafe(text, ...values);
  let lockedShop = null, lockedRun = null, evidence = null, authorityVersion = 0;
  const invalidateEvidence = () => { evidence = null; authorityVersion++; };
  function scope(shopId) {
    if (lockedShop !== shopId) fail("LOCK_REQUIRED", "Shop authority lock required");
  }
  function ownedClaim(input, runId) {
    const claim = captureClaim(input, runId, maxAttempts);
    scope(claim.shopId);
    if (!lockedRun || lockedRun.id !== runId || lockedRun.shopId !== claim.shopId || lockedRun.generationId !== claim.generationId) {
      fail("LOCK_REQUIRED", "Tenant-bound run lock required");
    }
    return claim;
  }
  function remember(result) {
    if (result.length > 1) fail("INVALID_ROW", "Synchronization write affected multiple runs");
    const row = normalize(result[0]);
    invalidateEvidence();
    if (row) lockedRun = row;
    return row;
  }
  async function update(claim, assignments, values) {
    if (!sameClaim(lockedRun, claim)) return null;
    const p = n => `$${values.length + n}`;
    return remember(await rows(`UPDATE ${runTable} SET ${assignments}
      WHERE ${c.id}=${p(1)} AND ${c.shopId}=${p(2)} AND ${c.generationId}=${p(3)} AND ${c.phase}=${p(4)}
        AND ${c.leaseToken}=${p(5)} AND ${c.fence}=${p(6)}::bigint AND ${c.attempt}=${p(7)}::integer
        AND ${c.leaseExpiresAt}>clock_timestamp() AND ${eligible}
      RETURNING ${projection}`, ...values,
    claim.runId, claim.shopId, claim.generationId, claim.phase, claim.leaseToken, claim.fence, claim.attempt));
  }
  function requireEvidence(claim, kind) {
    if (!evidence || evidence.kind !== kind || !sameClaim(evidence.run, claim)) {
      fail(kind === "COMPLETE" ? "PUBLICATION_MISSING" : "EVIDENCE_MISSING", "Verified evidence required in the current claim transaction");
    }
    invalidateEvidence();
  }
  async function verifyEvidence(run, kind, result) {
    if (!run || ![Object.prototype, null].includes(Object.getPrototypeOf(run))) fail("INVALID_CLAIM", "Plain run data required");
    const identity = {};
    for (const key of CLAIM_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(run, key === "runId" ? "id" : key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("INVALID_CLAIM", "Run identity data properties required");
      identity[key] = descriptor.value;
    }
    const claim = ownedClaim(identity, identity.runId);
    invalidateEvidence();
    if (!sameClaim(lockedRun, claim)) return false;
    if (kind === "ADVANCE" && (result?.kind !== "ADVANCE" || !NEXT[claim.phase])) return false;
    if (kind === "COMPLETE" && claim.phase !== "PUBLISHING") return false;
    const authorizedRun = lockedRun, version = authorityVersion;
    // Validators receive the authoritative locked row, never a caller's copy.
    const verified = kind === "COMPLETE"
      ? await validators.verifyPublished({ tx, run:authorizedRun })
      : await validators.verifyStepEvidence({ tx, run:authorizedRun, result });
    if (verified !== true || lockedRun !== authorizedRun || authorityVersion !== version) return false;
    evidence = { kind, run:authorizedRun };
    return true;
  }
  return Object.freeze({
    now: async () => (await rows("SELECT clock_timestamp() AS now"))[0].now,
    async lockShop(shopId) {
      shop(shopId);
      await tx.$queryRawUnsafe("SELECT set_config('app.shop_id',$1,true)",shopId);
      await tx.$queryRawUnsafe("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,581834147::bigint))",shopId);
      if (lockedShop && lockedShop !== shopId) fail("LOCK_ORDER", "One shop authority per transaction");
      lockedShop = null; lockedRun = null; invalidateEvidence();
      const result = await rows(`SELECT ${shopColumn} FROM ${shopTable} WHERE ${shopColumn}=$1 FOR UPDATE`, shopId);
      if (result.length !== 1 || await validators.verifyShop({ tx, shopId }) !== true) return false;
      lockedShop = shopId;
      return true;
    },
    async lockRun(runId) {
      id(runId);
      if (!lockedShop) fail("LOCK_ORDER", "Shop must be locked before run");
      lockedRun = null; invalidateEvidence();
      const result = await rows(`SELECT ${projection} FROM ${runTable} WHERE ${c.id}=$1 AND ${c.shopId}=$2 FOR UPDATE`, runId, lockedShop);
      const row = normalize(result[0]);
      if (row && validators.verifyRun && await validators.verifyRun({ tx, run:row }) !== true) return null;
      lockedRun = row;
      return row;
    },
    async hasOtherLiveRun(shopId, runId) {
      scope(shop(shopId)); id(runId);
      return (await rows(`SELECT 1 FROM ${runTable} WHERE ${c.shopId}=$1 AND ${c.id}<>$2
        AND ${c.leaseToken} IS NOT NULL AND ${c.leaseExpiresAt}>clock_timestamp() AND ${c.completedAt} IS NULL LIMIT 1`, shopId, runId)).length > 0;
    },
    async claimRun(runId, patch) {
      id(runId); scope(shop(patch.shopId)); id(patch.workerId); id(patch.leaseToken); id(patch.expectedGenerationId);
      integer(patch.leaseSeconds, 1, 3600); integer(patch.attempt, 1, maxAttempts);
      const oldFence = fence(patch.expectedPreviousFence), newFence = fence(patch.fence);
      if (!lockedRun || lockedRun.id !== runId || lockedRun.generationId !== patch.expectedGenerationId ||
          !PHASES.has(patch.expectedPhase) || patch.maxAttempts !== maxAttempts || BigInt(newFence) !== BigInt(oldFence) + 1n) {
        fail("INVALID_CLAIM_UPDATE", "Non-monotonic or unbound claim");
      }
      invalidateEvidence();
      const claimed=remember(await rows(`UPDATE ${runTable} SET ${c.workerId}=$1,${c.leaseToken}=$2,
        ${c.leaseExpiresAt}=clock_timestamp()+$3::integer*interval '1 second',${c.fence}=$4::bigint,${c.attempt}=$5,${c.nextEligibleAt}=NULL
        WHERE ${c.id}=$6 AND ${c.generationId}=$7 AND ${c.phase}=$8 AND ${c.fence}=$9::bigint AND ${c.attempt}=$10
          AND ${c.shopId}=$11 AND ${c.attempt}<$12
          AND ${c.leaseToken} IS NULL AND (${c.leaseExpiresAt} IS NULL OR ${c.leaseExpiresAt}<=clock_timestamp())
          AND (${c.nextEligibleAt} IS NULL OR ${c.nextEligibleAt}<=clock_timestamp()) AND ${eligible}
        RETURNING ${projection}`, patch.workerId, patch.leaseToken, patch.leaseSeconds, newFence, patch.attempt, runId,
      patch.expectedGenerationId, patch.expectedPhase, oldFence, patch.attempt - 1, patch.shopId, maxAttempts));
      if(claimed&&runTable==='"mirror"."catalog_import_executions"')await consumeFreshDispatchClaim({tx,
        claim:Object.freeze({runId,shopId:claimed.shopId,generationId:claimed.generationId,phase:claimed.phase,
          fence:claimed.fence,leaseToken:claimed.leaseToken}),kind:'SYNC',acknowledge:validators.dispatchConsumption});
      return claimed;
    },
    async renewRun(runId, patch) {
      const claim = ownedClaim(patch.claim, runId);
      integer(patch.leaseSeconds, 1, 3600); invalidateEvidence();
      return update(claim, `${c.leaseExpiresAt}=GREATEST(${c.leaseExpiresAt}+interval '1 millisecond',clock_timestamp()+$1::integer*interval '1 second')`, [patch.leaseSeconds]);
    },
    async commitStep(runId, patch) {
      const claim = ownedClaim(patch.claim, runId);
      if (patch.expectedGenerationId !== claim.generationId) fail("CLAIM_MISMATCH", "Generation cannot change");
      if (!sameClaim(lockedRun, claim)) return null;
      // Successful polling/chunking resets the failure streak, never the fence.
      const release = `${c.leaseToken}=NULL,${c.leaseExpiresAt}=NULL,${c.workerId}=NULL,${c.attempt}=0`;
      if (patch.kind === "ADVANCE" && NEXT[claim.phase] === patch.nextPhase) {
        requireEvidence(claim, "ADVANCE");
        return update(claim, `${c.phase}=$1,${release},${c.nextEligibleAt}=NULL`, [patch.nextPhase]);
      }
      if (patch.kind === "DEFER") {
        integer(patch.delayMs, 1000, 900000); invalidateEvidence();
        return update(claim, `${c.nextEligibleAt}=clock_timestamp()+$1::integer*interval '1 millisecond',${release}`, [patch.delayMs]);
      }
      if (patch.kind === "COMPLETE" && claim.phase === "PUBLISHING") {
        requireEvidence(claim, "COMPLETE");
        return update(claim, `${c.completedAt}=clock_timestamp(),${release},${c.nextEligibleAt}=NULL`, []);
      }
      fail("INVALID_TRANSITION", "Unsupported synchronization transition");
    },
    async commitFailure(runId, patch) {
      const claim = ownedClaim(patch.claim, runId);
      if (patch.attempt !== claim.attempt || typeof patch.outcomeUncertain !== "boolean" || typeof patch.reviewRequired !== "boolean" ||
          typeof patch.retryable !== "boolean" || !/^[A-Z_]{1,64}$/.test(patch.code) ||
          (patch.outcomeUncertain ? patch.retryable || patch.reviewRequired : patch.reviewRequired === patch.retryable) ||
          (patch.retryable && claim.attempt >= maxAttempts)) {
        fail("INVALID_FAILURE", "Bounded failure disposition required");
      }
      if (patch.retryable || patch.outcomeUncertain) integer(patch.retryAfterMs, 1000, 900000);
      else if (patch.retryAfterMs !== null) fail("INVALID_FAILURE", "Review cannot schedule an ordinary retry");
      invalidateEvidence();
      const values = [patch.outcomeUncertain, patch.reviewRequired, patch.retryAfterMs];
      if (c.lastError) values.push(patch.code);
      return update(claim, `${c.outcomeUncertain}=$1,${c.reviewRequired}=$2,
        ${c.nextEligibleAt}=CASE WHEN $3::integer IS NULL THEN NULL ELSE clock_timestamp()+$3::integer*interval '1 millisecond' END,
        ${c.leaseToken}=NULL,${c.leaseExpiresAt}=NULL,${c.workerId}=NULL${c.lastError ? `,${c.lastError}=$4` : ""}`, values);
    },
    verifyStepEvidence: (run, result) => verifyEvidence(run, "ADVANCE", result),
    verifyPublished: run => verifyEvidence(run, "COMPLETE"),
  });
}

export function createSyncRunDbAdapter({ database, prisma, mapping, verifyShop, verifyStepEvidence, verifyPublished, verifyRun,
  dispatchConsumption,maxAttempts, maxRetries = 3, statementTimeoutMs = 5000, lockTimeoutMs = 1000, transactionTimeoutMs = 10000 } = {}) {
  assertSyncDriver({ database, prisma });
  const physical = requireSyncRunDbMapping(mapping, database || prisma);
  maxAttempts ??= physical.attemptLimit;
  integer(maxAttempts, 1, physical.attemptLimit);
  const validators = Object.freeze({ verifyShop, verifyStepEvidence, verifyPublished, verifyRun,dispatchConsumption });
  if(dispatchConsumption!==undefined&&typeof dispatchConsumption!=='function')throw new TypeError('Dispatch consumption callback required');
  for (const name of ["verifyShop", "verifyStepEvidence", "verifyPublished"]) {
    if (typeof validators[name] !== "function") throw new TypeError(`${name} is required`);
  }
  if (verifyRun !== undefined && typeof verifyRun !== "function") throw new TypeError("verifyRun must be a function");
  integer(maxRetries, 0, 5);
  for (const value of [statementTimeoutMs, lockTimeoutMs, transactionTimeoutMs]) integer(value, 100, 30000);
  const sql = createSqlLayout(physical);
  const verifiedTransaction = createVerifiedTransaction({ database, prisma, maxRetries, statementTimeoutMs, lockTimeoutMs, transactionTimeoutMs }, mapping);
  const normalize = row => {
    if (!row) return null;
    id(row.id); shop(row.shopId); id(row.generationId);
    if (!PHASES.has(row.phase)) fail("INVALID_ROW", "Known synchronization phase required");
    return Object.freeze({ ...row, fence:fence(row.fence), attempt:integer(row.attempt, 0, physical.attemptLimit) });
  };
  return Object.freeze({
    maxAttempts,
    transaction(work, options = {}) {
      if (typeof work !== "function") throw new TypeError("Database callback required");
      if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) fail("INVALID_ISOLATION", "Serializable synchronization options required");
      if (options.isolationLevel !== undefined && options.isolationLevel !== "Serializable") fail("INVALID_ISOLATION", "Serializable synchronization transaction required");
      return verifiedTransaction(tx => work(createTransactionAdapter({ tx, sql, maxAttempts, normalize, validators })));
    },
    async getRunShop(runId) {
      id(runId);
      return verifiedTransaction(async tx => (await tx.$queryRawUnsafe(
        `SELECT ${sql.c.shopId} AS "shopId" FROM ${sql.runTable} WHERE ${sql.c.id}=$1`, runId))[0]?.shopId ?? null, true);
    },
    async getRunState({ runId, shopId }) {
      id(runId); shop(shopId);
      return verifiedTransaction(async tx => normalize((await tx.$queryRawUnsafe(
        `SELECT ${sql.projection} FROM ${sql.runTable} WHERE ${sql.c.id}=$1 AND ${sql.c.shopId}=$2`, runId, shopId))[0]), true);
    },
  });
}
