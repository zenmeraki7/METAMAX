import { setTimeout as delay } from "node:timers/promises";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { FILTER_SQL_SCHEMA } from "../fields/sources.js";
const barrierTransactions = new WeakSet();

export function invalid(message) {
  throw new FieldError(C.CONTRACT_MISMATCH, message);
}
export function shop(value) {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)
  )
    invalid("Authenticated shop required");
}
export function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    invalid(`Invalid ${name}`);
  return value;
}
export function token(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    invalid("Opaque identity required");
}
/** Coarse existing barrier; acquire BEFORE any protected data read. LOCK itself
 * fails outside an explicit transaction, preventing autocommit callers. */
export async function lockMirror(client) {
  if (barrierTransactions.has(client)) return;
  await client.query("LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE");
}
export async function transaction(database, callback) {
  for (let attempt = 0; ; attempt++) {
    const client = await database.connect();
    let discard;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      // A fresh facade is scoped to this one transaction, never the pooled
      // connection. Nested services can avoid reacquiring an already-held lock
      // without accidentally reusing that proof after COMMIT or pool release.
      let open = true;
      const scoped = {query(...args) {
        if (!open) throw new Error('Mirror transaction has ended');
        return client.query(...args);
      }};
      await lockMirror(scoped);
      barrierTransactions.add(scoped);
      let result;
      try { result = await callback(scoped); }
      finally { open = false;barrierTransactions.delete(scoped); }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = rollbackError;
      }
      if (
        attempt >= 2 ||
        !["40001", "40P01", "55P03", "23505", "P2002", "P2034"].includes(
          error.code,
        )
      )
        throw error;
    } finally {
      client.release(discard);
    }
    await delay(20 * 2 ** attempt);
  }
}
export async function staging(
  client,
  shopId,
  generationId,
  statuses = ["INGESTING", "RECONCILING"],
) {
  shop(shopId);
  token(generationId);
  await lockMirror(client);
  const row = (
    await client.query(
      `SELECT * FROM mirror.generations
    WHERE shop_id=$1 AND id=$2 FOR UPDATE`,
      [shopId, generationId],
    )
  ).rows[0];
  if (!row || !statuses.includes(row.status))
    invalid("Generation is not eligible staging");
  if (
    statuses.some((s) =>
      ["INGESTING", "RECONCILING", "VERIFIED"].includes(s),
    ) &&
    (row.mirror_schema_version !== FILTER_SQL_SCHEMA.mirrorSchemaVersion ||
      row.source_contract_version !== FILTER_SQL_SCHEMA.sourceContractVersion ||
      row.mapping_version !== "mapping_v1")
  ) {
    invalid("Generation source/mapping version is incompatible");
  }
  const SUPPORTED_DATASETS = new Set([
    "products",
    "variants",
    "inventory_items",
    "inventory_levels",
    "locations",
    "collections",
    "product_options",
    "categories",
    "metafields",
  ]);
  if (
    statuses.some((s) =>
      ["INGESTING", "RECONCILING", "VERIFIED"].includes(s),
    ) &&
    (!Array.isArray(row.required_datasets) ||
      row.required_datasets.length === 0 ||
      !row.required_datasets.includes("products") ||
      (row.required_datasets.includes("products") &&
        !row.required_datasets.includes("variants")) ||
      row.required_datasets.some((d) => !SUPPORTED_DATASETS.has(d)))
  ) {
    invalid("Unsupported dataset replacement contract");
  }
  return row;
}
export async function runLease(client, { shopId, generationId, runId, fence }) {
  const generation = await staging(client, shopId, generationId, ["INGESTING"]);
  const run = (
    await client.query(
      `SELECT *, lease_until > clock_timestamp() AS live
    FROM mirror.ingestion_runs WHERE shop_id=$1 AND generation_id=$2 AND id=$3 FOR UPDATE`,
      [shopId, generationId, runId],
    )
  ).rows[0];
  if (
    !run ||
    run.status !== "RUNNING" ||
    !run.live ||
    BigInt(run.fence) !== BigInt(fence)
  )
    invalid("Expired or superseded ingestion lease");
  await assertIngestionExecution(client, run);
  return { run, generation };
}

// Phase-managed ingestion is subordinate to the orchestration lease. A stale
// child cannot write even if its own lease has not yet elapsed.
export async function assertIngestionExecution(client, run) {
  if (!run.execution_id) return;
  const owned = await client.query(`SELECT 1 FROM mirror.catalog_import_executions e
    JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id AND j.generation_id=e.generation_id
    JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
    WHERE e.id=$1 AND e.shop_id=$2 AND e.generation_id=$3 AND e.fence=$4
      AND e.lease_token=$5 AND e.lease_until>clock_timestamp() AND NOT e.cancel_requested
      AND NOT e.review_required AND NOT e.outcome_uncertain AND e.completed_at IS NULL
      AND NOT j.cancel_requested AND j.execution_mode='PHASE'`,
  [run.execution_id,run.shop_id,run.generation_id,run.execution_fence,run.lease_token]);
  if (owned.rowCount !== 1) invalid("Ingestion orchestration authority changed");
}
