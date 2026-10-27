import { prisma } from "../../db/client.js";
import {
  fetchCurrentProduct,
  writeProductSnapshot,
} from "../products/products.service.js";
import {
  SYNC_HEARTBEAT_MS,
  validateRun,
  validateToken,
  syncError,
  syncTransaction,
  lockSyncShop,
  renewSnapshotLease,
  renewSnapshotLeaseTx,
} from "./sync.lease.js";

import {
  fetchInventoryItem,
  writeInventoryItemSnapshot,
} from "../inventory/inventory.service.js";

function checkRevision(change, inventory) {
  const id = inventory ? change.inventoryItemId : change.productId;
  if (
    typeof id !== "string" ||
    !(
      inventory
        ? /^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/
        : /^gid:\/\/shopify\/Product\/[1-9]\d*$/
    ).test(id) ||
    (typeof change.revision !== "bigint" &&
      !Number.isSafeInteger(change.revision)) ||
    BigInt(change.revision) < 1n ||
    BigInt(change.appliedRevision) >= BigInt(change.revision)
  )
    throw syncError(
      "INVALID_SNAPSHOT_CHANGE",
      "Invalid staged product identity or unapplied revision"
    );
}

async function fetchWithLease(
  run,
  token,
  productId,
  { fetchProduct, heartbeatMs }
) {
  const ownership = await renewSnapshotLease(run, token);
  const controller = new AbortController();
  let inflight = null,
    heartbeatError = null,
    fetchError = null,
    result;
  const timer = setInterval(() => {
    if (inflight || heartbeatError) return;
    inflight = renewSnapshotLease(run, token)
      .catch((error) => {
        heartbeatError = error;
        controller.abort(error);
      })
      .finally(() => {
        inflight = null;
      });
  }, heartbeatMs);
  timer.unref();
  try {
    result = await fetchProduct(run.shop, productId, {
      generation: ownership.generation,
      signal: controller.signal,
    });
  } catch (error) {
    fetchError = error instanceof Error ? error : new Error(String(error));
  } finally {
    clearInterval(timer);
    if (inflight) await inflight;
  }
  if (heartbeatError) throw heartbeatError;
  if (fetchError) throw fetchError;
  return result;
}

async function commitStagedProduct(
  run,
  token,
  change,
  current,
  writeProduct,
  inventory
) {
  return syncTransaction(async (tx) => {
    const merchant = await lockSyncShop(tx, run);
    await renewSnapshotLeaseTx(tx, run, token, merchant.generation);
    const accepted = await (inventory
      ? tx.snapshotInventoryChange
      : tx.snapshotChange
    ).updateMany({
      where: {
        runId: run.id,
        [inventory ? "inventoryItemId" : "productId"]: inventory
          ? change.inventoryItemId
          : change.productId,
        revision: change.revision,
        appliedRevision: { lt: change.revision },
        dirty: true,
      },
      data: { appliedRevision: change.revision, dirty: false },
    });
    if (accepted.count !== 1) return "superseded";
    await writeProduct(
      tx,
      run.shop,
      run.id,
      inventory ? change.inventoryItemId : change.productId,
      current
    );
    return "applied";
  });
}

// Ingestion must be sealed before a run enters RECONCILING. A batch never holds
// database locks across Shopify HTTP requests or distributed budget waits.
async function applyChanges(
  run,
  token,
  limit = 25,
  options = {},
  inventory = false
) {
  validateRun(run);
  validateToken(token);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw RangeError("limit must be between 1 and 100");
  const heartbeatMs = options.heartbeatMs ?? SYNC_HEARTBEAT_MS;
  if (
    !Number.isSafeInteger(heartbeatMs) ||
    heartbeatMs < 1 ||
    heartbeatMs > SYNC_HEARTBEAT_MS
  )
    throw RangeError("heartbeatMs must be between 1 and 30000");
  await renewSnapshotLease(run, token);
  const changes = await (inventory
    ? prisma.snapshotInventoryChange
    : prisma.snapshotChange
  ).findMany({
    where: { runId: run.id, dirty: true },
    orderBy: { [inventory ? "inventoryItemId" : "productId"]: "asc" },
    take: limit,
    select: {
      [inventory ? "inventoryItemId" : "productId"]: true,
      revision: true,
      appliedRevision: true,
    },
  });
  let applied = 0,
    superseded = 0;
  for (const change of changes) {
    checkRevision(change, inventory);
    const current = await fetchWithLease(
      run,
      token,
      inventory ? change.inventoryItemId : change.productId,
      {
        fetchProduct: inventory
          ? options.fetchInventory || fetchInventoryItem
          : options.fetchProduct || fetchCurrentProduct,
        heartbeatMs,
      }
    );
    const outcome = await commitStagedProduct(
      run,
      token,
      change,
      current,
      inventory
        ? options.writeInventory || writeInventoryItemSnapshot
        : options.writeProduct || writeProductSnapshot,
      inventory
    );
    if (outcome === "applied") applied++;
    else superseded++;
  }
  return { fetched: changes.length, applied, superseded };
}

export function applySnapshotChanges(run, token, limit = 25, options = {}) {
  return applyChanges(run, token, limit, options, false);
}
export function applySnapshotInventoryChanges(
  run,
  token,
  limit = 25,
  options = {}
) {
  return applyChanges(run, token, limit, options, true);
}
