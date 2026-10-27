import { prisma } from "../../db/client.js";
import { createBulkQueryCoordinator } from "../../integrations/shopify/bulk-query-coordinator.js";
import { graphql } from "../../integrations/shopify/graphql.js";
import {
  stageSnapshotProducts,
  sealCatalogSnapshot,
} from "../snapshots/snapshots.service.js";
import {
  stageSnapshotInventoryItem,
  stageSnapshotInventoryItems,
  sealSnapshotInventory,
} from "../inventory/inventory.contract.js";
import {
  lockSyncShop,
  renewSnapshotLeaseTx,
  renewSnapshotLease,
  syncTransaction,
  syncError,
} from "./sync.lease.js";
import {
  exportQuery,
  START_EXPORT,
  FIND_EXPORT,
  READ_EXPORT,
} from "./sync.bulk.queries.js";
import {
  downloadExport,
  ingestGroupedExport,
  exactCount,
} from "./sync.importer.js";

const NAMES = ["products", "inventory_items", "inventory_locations"];
const POLL_MS = 15000;
export const MAX_IMPORT_ATTEMPTS = 8;
function body(response) {
  if (
    !response ||
    (response.errors != null &&
      (!Array.isArray(response.errors) || response.errors.length))
  )
    throw syncError(
      "BULK_GRAPHQL_ERROR",
      "Shopify bulk request returned errors",
    );
  const data = response.data ?? response;
  if (!data || typeof data !== "object")
    throw syncError("BULK_GRAPHQL_ERROR", "Missing bulk response");
  return data;
}
export async function importTransaction(run, token, fn) {
  return syncTransaction(async (tx) => {
    const merchant = await lockSyncShop(tx, run);
    await renewSnapshotLeaseTx(tx, run, token, merchant.generation, {
      includeIngestion: true,
    });
    return fn(tx);
  });
}
async function update(run, token, data) {
  return importTransaction(run, token, async (tx) => {
    const row = await tx.snapshotRun.update({ where: { id: run.id }, data });
    await tx.catalogSyncState.update({
      where: { shop: run.shop },
      data: { status: row.status },
    });
    return row;
  });
}
async function yieldRun(run, token, data = {}) {
  await update(run, token, {
    attempts: 0,
    lastError: null,
    ...data,
    nextCheckAt: new Date(Date.now() + POLL_MS),
    leaseToken: null,
    leasedUntil: null,
  });
  return { status: data.status ?? run.status };
}

// Recover a mutation whose response or DB acknowledgment was lost. The query
// operation name uniquely binds an export to this run and dataset. Never adopt
// an arbitrary currentBulkOperation from another run/app task.
async function findExport(run, query, request, context) {
  let after = null;
  const seen = new Set();
  for (let page = 0; page < 100; page++) {
    const connection = body(
      await request(
        run.shop,
        FIND_EXPORT,
        {
          after,
          // Shopify timestamps may have lower precision than Neon. Include an
          // overlap and identify ownership by the unique query, never by time.
          filter: `operation_type:query created_at:>='${new Date(
            run.createdAt.getTime() - 60000,
          ).toISOString()}'`,
        },
        context,
      ),
    ).bulkOperations;
    if (
      !Array.isArray(connection?.nodes) ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    )
      throw syncError("BULK_LOOKUP_FAILED", "Invalid bulk history response");
    const match = connection.nodes.find((row) => row.query === query);
    if (match) return match.id;
    if (!connection.pageInfo.hasNextPage) return null;
    const next = connection.pageInfo.endCursor;
    if (typeof next !== "string" || !next || seen.has(next)) break;
    seen.add(next);
    after = next;
  }
  throw syncError(
    "BULK_LOOKUP_FAILED",
    "Bulk history exceeded safe pagination limit",
  );
}

async function writeLocation(run, token, location) {
  if (
    !/^gid:\/\/shopify\/Location\/[1-9]\d*$/.test(location.id) ||
    typeof location.name !== "string" ||
    typeof location.isActive !== "boolean" ||
    typeof location.fulfillsOnlineOrders !== "boolean" ||
    typeof location.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(location.updatedAt))
  )
    throw syncError("INVALID_BULK_EXPORT", "Invalid exported location");
  return importTransaction(run, token, async (tx) => {
    const stored = await tx.snapshotRun.findUnique({ where: { id: run.id } });
    if (stored.status !== "INGESTING")
      throw syncError("SYNC_LEASE_LOST", "Location ingestion is closed");
    const data = {
      name: location.name,
      isActive: location.isActive,
      fulfillsOnlineOrders: location.fulfillsOnlineOrders,
      sourceUpdatedAt: new Date(location.updatedAt),
    };
    await tx.inventoryLocation.createMany({
      data: [{ shop: run.shop, snapshotId: run.id, id: location.id, ...data }],
      skipDuplicates: true,
    });
    await tx.inventoryLocation.updateMany({
      where: {
        shop: run.shop,
        snapshotId: run.id,
        id: location.id,
        sourceUpdatedAt: { lte: data.sourceUpdatedAt },
      },
      data,
    });
  });
}

async function completeDataset(run, token, manifest, counts) {
  const name = run.exportName;
  const exported = {
    ...run.exportManifest,
    [name]: {
      roots: counts.roots,
      objects: counts.objects,
      quantities: counts.quantities,
      operationId: run.bulkOperationId,
    },
  };
  // Match durable unique rows against the independent Shopify export manifest.
  await importTransaction(run, token, async (tx) => {
    if (name === "products") {
      const products = await tx.snapshotProduct.count({
        where: { runId: run.id },
      });
      const variants = await tx.variant.count({
        where: { shop: run.shop, snapshotId: run.id },
      });
      if (
        products !== exactCount(manifest.rootObjectCount) ||
        variants !== counts.children
      )
        throw syncError(
          "INVALID_BULK_EXPORT",
          "Product/variant durable counts do not match export",
        );
    } else if (name === "inventory_items") {
      const where = { shop: run.shop, snapshotId: run.id };
      const items = await tx.inventoryItem.count({ where });
      const levels = await tx.inventoryLevel.count({ where });
      const quantities = await tx.inventoryQuantity.count({ where });
      if (
        items !== counts.roots ||
        levels !== counts.children ||
        quantities !== counts.quantities
      )
        throw syncError(
          "INVALID_BULK_EXPORT",
          "Inventory durable counts do not match export",
        );
    }
  });
  const index = NAMES.indexOf(name);
  if (index === NAMES.length - 1) {
    const args = {
      shop: run.shop,
      generation: run.generation,
      runId: run.id,
      leaseToken: token,
    };
    await sealSnapshotInventory({
      ...args,
      expectedRecords: {
        inventory_items: exported.inventory_items.roots,
        inventory_levels:
          exported.inventory_items.objects - exported.inventory_items.roots,
        inventory_quantities: exported.inventory_items.quantities,
        inventory_locations: exported.inventory_locations.roots,
      },
    });
    await update(run, token, { exportManifest: exported });
    await sealCatalogSnapshot({
      ...args,
      committedProducts: exported.products.roots,
    });
    return yieldRun(run, token, {
      status: "RECONCILING",
      attempts: 0,
      lastError: null,
    });
  }
  return yieldRun(run, token, {
    status: "PENDING",
    exportName: NAMES[index + 1],
    bulkOperationId: null,
    exportManifest: exported,
    attempts: 0,
    lastError: null,
  });
}

export async function processCatalogImport(run, token, options = {}) {
  const request = options.graphql ?? graphql;
  const bulk = createBulkQueryCoordinator({ db: prisma, appId: options.bulkAppId ?? process.env.SHOPIFY_API_KEY });
  const controller = new AbortController();
  let heartbeat,
    inflight = null,
    heartbeatError;
  const context = { generation: run.generation, signal: controller.signal };
  try {
    await renewSnapshotLease(run, token, { includeIngestion: true });
    heartbeat = setInterval(() => {
      if (inflight || heartbeatError) return;
      inflight = renewSnapshotLease(run, token, { includeIngestion: true })
        .catch((error) => {
          heartbeatError = error;
          controller.abort(error);
        })
        .finally(() => {
          inflight = null;
        });
    }, 30000);
    heartbeat.unref();
    if (["PENDING", "STARTING"].includes(run.status)) {
      const query = exportQuery(run);
      run = await update(run, token, { status: "STARTING" });
      let id;
      try {
        id = await bulk.launch({ shop: run.shop, generation: run.generation,
          key: `${run.id}:${run.exportName}`, consumer: "sync",
          find: () => findExport(run, query, request, context),
          start: async () => {
            const payload = body(await request(run.shop, START_EXPORT, { query }, context)).bulkOperationRunQuery;
            if (!Array.isArray(payload?.userErrors) || payload.userErrors.length || !payload.bulkOperation?.id) {
              const failure = syncError("BULK_START_FAILED", "Shopify rejected or did not confirm the catalog export");
              failure.definitiveBulkRejection = Array.isArray(payload?.userErrors) && payload.userErrors.length > 0 && !payload.bulkOperation?.id;
              throw failure;
            }
            return payload.bulkOperation.id;
          },
        });
      } catch (failure) {
        if (["BULK_CAPACITY_UNAVAILABLE", "BULK_LAUNCH_UNCERTAIN"].includes(failure.code))
          return await yieldRun(run, token, { lastError: failure.code });
        throw failure;
      }
      if (!/^gid:\/\/shopify\/BulkOperation\/[1-9]\d*$/.test(id))
        throw syncError("BULK_START_FAILED", "Invalid export identity");
      return await yieldRun(run, token, {
        status: "WAITING",
        bulkOperationId: id,
      });
    }
    if (!["WAITING", "INGESTING"].includes(run.status) || !run.bulkOperationId)
      throw syncError(
        "INVALID_IMPORT_STATE",
        "Missing export identity or invalid import stage",
      );
    const operation = body(
      await request(
        run.shop,
        READ_EXPORT,
        { id: run.bulkOperationId },
        context,
      ),
    ).bulkOperation;
    if (!operation || operation.id !== run.bulkOperationId)
      throw syncError(
        "BULK_EXPORT_MISSING",
        "The catalog export is unavailable",
      );
    if (["COMPLETED", "FAILED", "CANCELED", "EXPIRED"].includes(operation.status))
      await bulk.complete({ shop: run.shop, id: operation.id, status: operation.status });
    if (["CREATED", "RUNNING", "CANCELING"].includes(operation.status))
      return await yieldRun(run, token);
    if (operation.status !== "COMPLETED")
      throw syncError(
        "BULK_EXPORT_FAILED",
        "Shopify did not complete the catalog export",
      );
    const roots = exactCount(operation.rootObjectCount),
      objects = exactCount(operation.objectCount);
    if (roots > objects || (objects > 0 && !operation.url))
      throw syncError(
        "INVALID_BULK_EXPORT",
        "Missing completed export results",
      );
    run = await update(run, token, {
      status: "INGESTING",
      ...(run.exportName === "products" ? { expectedProducts: roots } : {}),
    });
    const args = {
      shop: run.shop,
      generation: run.generation,
      runId: run.id,
      leaseToken: token,
    };
    const writeRoot =
      run.exportName === "products"
        ? (current) => stageSnapshotProducts({ ...args, products: [current] })
        : run.exportName === "inventory_items"
          ? (current) =>
              stageSnapshotInventoryItem({
                ...args,
                inventoryItemId: current.item.id,
                current,
              })
          : (location) => writeLocation(run, token, location);
    const lines =
      objects === 0
        ? []
        : options.download
          ? options.download(operation.url, context)
          : downloadExport(operation.url, context);
    const counts = await ingestGroupedExport({
      name: run.exportName,
      lines,
      manifest: operation,
      writeRoot,
      writeBatch:
        run.exportName === "products"
          ? (products) => stageSnapshotProducts({ ...args, products })
          : run.exportName === "inventory_items"
            ? (observations) =>
                stageSnapshotInventoryItems({ ...args, observations })
            : undefined,
      signal: context.signal,
    });
    return await completeDataset(run, token, operation, counts);
  } finally {
    clearInterval(heartbeat);
    if (inflight) await inflight;
    controller.abort();
  }
}

// Persist retries for all phases, including reconciliation. Terminal failures
// remain visible until explicitly cancelled/retried; they cannot publish.
export async function recordSyncFailure(run, token, error) {
  return importTransaction(run, token, async (tx) => {
    const stored = await tx.snapshotRun.findUnique({ where: { id: run.id } });
    const attempts = stored.attempts + 1;
    const failed = attempts >= MAX_IMPORT_ATTEMPTS;
    await tx.snapshotRun.update({
      where: { id: run.id },
      data: {
        attempts,
        lastError: String(error.code || "SYNC_FAILED").slice(0, 100),
        ...(failed ? { status: "FAILED", completedAt: new Date() } : {}),
        nextCheckAt: new Date(
          Date.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6)),
        ),
        leaseToken: null,
        leasedUntil: null,
      },
    });
    if (failed)
      await tx.catalogSyncState.update({
        where: { shop: run.shop },
        data: { status: "FAILED" },
      });
    return { status: failed ? "FAILED" : "RETRY", attempts };
  });
}
