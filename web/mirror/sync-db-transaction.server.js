import { setTimeout as delay } from "node:timers/promises";

export class SyncOutcomeUnknownError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "SyncOutcomeUnknownError";
    this.code = "OUTCOME_UNKNOWN";
    this.outcomeUncertain = true;
  }
}

function codes(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return [];
  seen.add(error);
  return [error.code, error.meta?.code, ...codes(error.cause, seen)].filter(Boolean);
}
function hasUncertainOutcome(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  return error.outcomeUncertain === true || hasUncertainOutcome(error.cause, seen);
}
const conflicts = new Set(["40001", "40P01", "P2034"]);
const connections = new Set(["P1001", "P1002", "P1017", "ECONNRESET", "ETIMEDOUT", "EPIPE", "08000", "08003", "08006", "57P01"]);

async function acquire(database) {
  let expired = false, timer;
  const pending = Promise.resolve().then(() => database.connect());
  // A connection acquired after our wait has ended must not leak into the pool.
  void pending.then(client => { if (expired) client.release(); }, () => {}).catch(() => {});
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(Object.assign(new Error("Synchronization connection deadline exceeded"), { code: "ETIMEDOUT" })); }, 5000);
    })]);
  } finally { clearTimeout(timer); }
}

export function assertSyncDriver({ database, prisma }) {
  if (Boolean(database) === Boolean(prisma)) throw new TypeError("Supply one PostgreSQL pool or Prisma client");
  if (database && typeof database.connect !== "function") throw new TypeError("PostgreSQL pool required");
  if (prisma && (typeof prisma.$transaction !== "function" || typeof prisma.$queryRawUnsafe !== "function")) throw new TypeError("Prisma transaction client required");
}

/** Vetted DB-only callbacks. No Shopify, HTTP, Redis or nontransactional effects.
 * Preserve the existing publication barrier BEFORE establishing a data snapshot.
 * Row lock order after the barrier: shop -> run -> intent -> evidence/publication.
 */
export async function runSyncDbTransaction({ database, prisma, work, maxRetries = 3,
  statementTimeoutMs = 5000, lockTimeoutMs = 1000, transactionTimeoutMs = 10000,
  readOnly = false, isolationLevel = "Serializable" } = {}) {
  assertSyncDriver({ database, prisma });
  if (typeof work !== "function") throw new TypeError("Database callback required");
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw new RangeError("Invalid retry limit");
  for (const value of [statementTimeoutMs, lockTimeoutMs, transactionTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 100 || value > 30000) throw new RangeError("Invalid database timeout");
  }
  if (typeof readOnly !== "boolean") throw new TypeError("Read-only flag required");
  if (!['Serializable','ReadCommitted'].includes(isolationLevel)) throw new TypeError('Unsupported synchronization isolation');
  for (let retry = 0; ; retry++) {
    let callbackCompleted = false;
    try {
      const setup = async tx => {
        // SET is a command, not SELECT set_config(): no early MVCC snapshot.
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
        await tx.$executeRawUnsafe(`LOCK TABLE "mirror"."publications" IN ACCESS SHARE MODE`);
        const result = await work(tx);
        callbackCompleted = true;
        return result;
      };
      if (prisma) {
        return await prisma.$transaction(async tx => {
          if (typeof tx.$queryRawUnsafe !== "function" || typeof tx.$executeRawUnsafe !== "function") throw new TypeError("Prisma SQL transaction methods required");
          if (readOnly) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          return setup(tx);
        }, { isolationLevel, maxWait: 5000, timeout: transactionTimeoutMs });
      }

      const client = await acquire(database);
      let active = true, timer, discard, commitSent = false;
      const query = async (sql, values) => {
        if (!active) throw Object.assign(new Error("Synchronization transaction has ended"), { code: "TRANSACTION_CLOSED" });
        return client.query(sql, values);
      };
      const tx = Object.freeze({
        $queryRawUnsafe: async (sql, ...values) => (await query(sql, values)).rows,
        $executeRawUnsafe: async (sql, ...values) => (await query(sql, values)).rowCount,
      });
      // BEGIN and rollback cleanup share the deadline with setup/work/COMMIT.
      // Otherwise an unresponsive connection can stall before timeouts are set.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("Synchronization transaction deadline exceeded"), { code: "TRANSACTION_DEADLINE" })), transactionTimeoutMs);
      });
      try {
        await Promise.race([client.query(`BEGIN ISOLATION LEVEL ${isolationLevel === 'Serializable' ? 'SERIALIZABLE' : 'READ COMMITTED'}${readOnly ? " READ ONLY" : ""}`), deadline]);
        const result = await Promise.race([setup(tx), deadline]);
        active = false;
        commitSent = true;
        await Promise.race([client.query("COMMIT"), deadline]);
        return result;
      } catch (error) {
        active = false;
        const deadlineExceeded = error?.code === "TRANSACTION_DEADLINE";
        if (deadlineExceeded || codes(error).some(code => connections.has(code))) discard = error;
        // Do not queue ROLLBACK behind a hung COMMIT/query. Discarding the pg
        // client closes that connection; any sent COMMIT remains uncertain.
        if (!discard) {
          try { await Promise.race([client.query("ROLLBACK"), deadline]); } catch (rollbackError) { discard = rollbackError; }
        }
        if (deadlineExceeded && commitSent) throw new SyncOutcomeUnknownError("COMMIT deadline exceeded; verify durable state", error);
        if (deadlineExceeded) throw error; // No COMMIT was sent; all late SQL is disabled.
        if (discard && !codes(error).some(code => conflicts.has(code))) throw new SyncOutcomeUnknownError("Database transaction outcome is unknown", error);
        throw error;
      } finally {
        clearTimeout(timer);
        active = false;
        client.release(discard);
      }
    } catch (error) {
      const found = codes(error);
      // An ambiguous result is never permission to rerun a callback, even when
      // a wrapper also carries a retryable code. Recover by durable-state lookup.
      if (hasUncertainOutcome(error) || found.some(code => connections.has(code))) {
        if (error instanceof SyncOutcomeUnknownError) throw error;
        throw new SyncOutcomeUnknownError(callbackCompleted ? "Commit outcome requires durable verification" : "Database connection outcome requires durable verification", error);
      }
      if (found.some(code => conflicts.has(code)) && retry < maxRetries) {
        await delay(20 * 2 ** retry);
        continue;
      }
      throw error;
    }
  }
}
