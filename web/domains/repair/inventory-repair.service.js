import { randomUUID, createHash } from "node:crypto";
import { prisma } from "../../db/client.js";
import { graphql as requestGraphql } from "../../integrations/shopify/graphql.js";
import { syncTransaction } from "../sync/sync.lease.js";
import { GET_UPDATED_INVENTORY_ITEMS } from "./repair.queries.js";

export const INVENTORY_REPAIR_MAX_ATTEMPTS = 8;
export const INVENTORY_REPAIR_POLICIES = Object.freeze({
  DEFAULT_TARGETED_SCAN_INTERVAL_MS: 15 * 60 * 1000,
  HIGH_PRIORITY_HOURLY_SCAN_MS: 60 * 60 * 1000,
  FULL_RECONCILIATION_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000,
});

export function resolveInventoryRepairInterval({ priority = "NORMAL" } = {}) {
  if (priority === "HIGH") {
    return INVENTORY_REPAIR_POLICIES.HIGH_PRIORITY_HOURLY_SCAN_MS;
  }
  return INVENTORY_REPAIR_POLICIES.DEFAULT_TARGETED_SCAN_INTERVAL_MS;
}

const LEASE_MS = 300000;
const INTERVAL_MS = 15 * 60000;
const ITEM_ID = /^gid:\/\/shopify\/InventoryItem\/[1-9]\d*$/;
const key = (shop, kind) => ({ shop_kind: { shop, kind } });
const hash = (shop) => createHash("sha256").update(shop).digest("hex");

async function lockShop(tx, shop) {
  const [merchant] =
    await tx.$queryRaw`SELECT "status","generation","installationVerified","activeSnapshotId","activeRunId"
    FROM "Shop" WHERE "domain"=${shop} FOR SHARE`;
  return merchant;
}
async function finishSchedule(tx, shop, kind, token, data) {
  await tx.catalogRepair.update({ where: key(shop, kind), data });
  const acknowledged =
    await tx.$executeRaw`UPDATE "CatalogRepair" SET "leaseToken"=NULL,"leasedUntil"=NULL
    WHERE "shop"=${shop} AND "kind"::text=${kind} AND "leaseToken"=${token} AND "leasedUntil">clock_timestamp()`;
  if (acknowledged !== 1)
    throw Error("Inventory repair lease lost before cursor commit");
}
function remotePage(response, previousCursor) {
  if (
    response?.errors != null &&
    (!Array.isArray(response.errors) || response.errors.length)
  )
    throw Error("Shopify returned inventory repair errors");
  const connection = (response?.data ?? response)?.resources;
  if (
    !Array.isArray(connection?.edges) ||
    connection.edges.length > 100 ||
    typeof connection.pageInfo?.hasNextPage !== "boolean"
  )
    throw Error("Incomplete inventory repair connection");
  const ids = connection.edges.map(({ node } = {}) => {
    if (
      !ITEM_ID.test(node?.id) ||
      typeof node.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(node.updatedAt))
    )
      throw Error("Malformed inventory repair item");
    return node.id;
  });
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate inventory repair item");
  const { hasNextPage, endCursor } = connection.pageInfo;
  if (
    hasNextPage &&
    (!ids.length ||
      typeof endCursor !== "string" ||
      !endCursor ||
      endCursor === previousCursor)
  )
    throw Error("Inventory repair cursor did not advance");
  return { ids, hasNextPage, after: hasNextPage ? endCursor : null };
}

// Discovery invalidates the same ledger used by inventory webhooks. Only the
// existing revision-fenced inventory worker fetches/writes the mirror.
export async function processInventoryRepairStep(
  shop,
  kind,
  { db = prisma, graphql = requestGraphql } = {}
) {
  if (!["INVENTORY_ITEM", "INVENTORY_LEVEL"].includes(kind))
    throw TypeError("Invalid inventory repair kind");
  const transaction = (fn) => syncTransaction(fn, undefined, db);
  const token = randomUUID();
  const claim = await transaction(async (tx) => {
    const merchant = await lockShop(tx, shop);
    const marker = await tx.installationState.findUnique({
      where: { shopHash: hash(shop) },
    });
    if (
      merchant?.status !== "ACTIVE" ||
      !merchant.installationVerified ||
      marker?.status !== "ACTIVE" ||
      marker.generation !== merchant.generation
    )
      return null;
    const [state] =
      await tx.$queryRaw`UPDATE "CatalogRepair" SET "leaseToken"=${token},
      "leasedUntil"=clock_timestamp()+(${LEASE_MS} * interval '1 millisecond')
      WHERE "shop"=${shop} AND "kind"::text=${kind} AND "attempts">=0 AND "attempts"<${INVENTORY_REPAIR_MAX_ATTEMPTS}
      AND "nextCheckAt"<=clock_timestamp() AND ("leasedUntil" IS NULL OR "leasedUntil"<=clock_timestamp()) RETURNING *`;
    return state ? { state, merchant } : null;
  });
  if (!claim) return { status: "not_due_or_leased" };
  const { state, merchant } = claim;
  try {
    const snapshot = merchant.activeSnapshotId
      ? await db.snapshotRun.findUnique({
          where: { id: merchant.activeSnapshotId },
        })
      : null;
    if (
      snapshot &&
      (snapshot.shop !== shop ||
        snapshot.generation !== merchant.generation ||
        snapshot.status !== "COMPLETED" ||
        !snapshot.completedAt)
    )
      throw Error(
        "Inventory repair baseline is not published for this installation"
      );
    if (merchant.activeSnapshotId && !snapshot)
      throw Error("Inventory repair baseline is missing");
    let saved = null;
    if (state.afterCursor) {
      try {
        saved = JSON.parse(state.afterCursor);
      } catch {
        throw Error("Invalid inventory repair cursor");
      }
    }
    const continuing =
      saved?.snapshotId === merchant.activeSnapshotId &&
      saved?.generation === merchant.generation;
    const after = continuing ? saved.after : null;
    if (after !== null && typeof after !== "string")
      throw Error("Invalid inventory repair page cursor");
    const pages = continuing ? state.pagesInWindow : 0;
    if (pages >= 10000) throw Error("Inventory repair page limit exceeded");
    const now = new Date();
    const until =
      continuing && state.windowTo
        ? state.windowTo
        : new Date(now.getTime() - (kind === "INVENTORY_ITEM" ? 300000 : 0));
    const from =
      continuing && state.windowFrom
        ? state.windowFrom
        : new Date(
            (state.coveredThrough ?? snapshot?.createdAt ?? now).getTime() -
              3600000
          );
    let page = { ids: [], hasNextPage: false, after: null };
    let status = !snapshot
      ? "awaiting_snapshot"
      : kind === "INVENTORY_ITEM" && from >= until
      ? "not_due"
      : null;
    if (!status && kind === "INVENTORY_ITEM") {
      page = remotePage(
        await graphql(
          shop,
          GET_UPDATED_INVENTORY_ITEMS,
          {
            filter: `updated_at:>='${from.toISOString()}' AND updated_at:<'${until.toISOString()}'`,
            after,
          },
          {
            generation: merchant.generation,
            signal: AbortSignal.timeout(60000),
          }
        ),
        after
      );
    } else if (!status) {
      // Sweep known items, even when their updatedAt has not changed. This also
      // rediscovers deletions absent from Shopify's updated-item connection.
      if (after !== null && !ITEM_ID.test(after))
        throw Error("Invalid local inventory repair cursor");
      const rows = await db.inventoryItem.findMany({
        where: {
          shop,
          snapshotId: snapshot.id,
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: "asc" },
        take: 101,
        select: { id: true },
      });
      page = {
        ids: rows.slice(0, 100).map((row) => row.id),
        hasNextPage: rows.length > 100,
        after: rows.length > 100 ? rows[99].id : null,
      };
    }
    if (page.ids.some((id) => !ITEM_ID.test(id)))
      throw Error("Malformed local inventory repair item");
    return await transaction(async (tx) => {
      const current = await lockShop(tx, shop);
      const [owned] =
        await tx.$queryRaw`SELECT "leaseToken","leasedUntil">clock_timestamp() AS valid
        FROM "CatalogRepair" WHERE "shop"=${shop} AND "kind"::text=${kind} FOR UPDATE`;
      if (owned?.leaseToken !== token || !owned.valid)
        return { status: "superseded" };
      if (
        current?.status !== "ACTIVE" ||
        current.generation !== merchant.generation
      )
        return { status: "superseded" };
      if (current.activeSnapshotId !== merchant.activeSnapshotId) {
        await finishSchedule(tx, shop, kind, token, {
          afterCursor: null,
          windowFrom: null,
          windowTo: null,
          pagesInWindow: 0,
          nextCheckAt: now,
        });
        return { status: "snapshot_changed" };
      }
      for (const inventoryItemId of page.ids) {
        const change = await tx.inventoryChange.upsert({
          where: { shop_inventoryItemId: { shop, inventoryItemId } },
          create: {
            shop,
            inventoryItemId,
            revision: 1n,
            appliedRevision: 0n,
            dirty: true,
            nextAttemptAt: now,
          },
          update: {
            revision: { increment: 1n },
            dirty: true,
            attempts: 0,
            nextAttemptAt: now,
            lastError: null,
            deadLetterAt: null,
            waitingForSnapshot: false,
          },
        });
        if (current.activeRunId)
          await tx.snapshotInventoryChange.upsert({
            where: {
              runId_inventoryItemId: {
                runId: current.activeRunId,
                inventoryItemId,
              },
            },
            create: {
              runId: current.activeRunId,
              inventoryItemId,
              revision: change.revision,
              appliedRevision: 0n,
              dirty: true,
            },
            update: { revision: change.revision, dirty: true },
          });
      }
      const more = !status && page.hasNextPage;
      await finishSchedule(tx, shop, kind, token, {
        afterCursor: more
          ? JSON.stringify({
              generation: merchant.generation,
              snapshotId: snapshot.id,
              after: page.after,
            })
          : null,
        windowFrom: more ? from : null,
        windowTo: more ? until : null,
        pagesInWindow: more ? pages + 1 : 0,
        ...(!status && !more ? { coveredThrough: until } : {}),
        nextCheckAt: new Date(Date.now() + (more ? 1000 : INTERVAL_MS)),
        attempts: 0,
        lastError: null,
      });
      return {
        status: status ?? (more ? "more_pages" : "complete"),
        discovered: page.ids.length,
      };
    });
  } catch (error) {
    await transaction(async (tx) => {
      const current = await lockShop(tx, shop);
      if (current?.generation !== merchant.generation) return;
      const attempts = state.attempts + 1;
      await tx.$executeRaw`UPDATE "CatalogRepair" SET "attempts"=${attempts},"lastError"=${String(
        error.message ?? error
      ).slice(0, 500)},
        "nextCheckAt"=clock_timestamp()+(${Math.min(
          300000,
          5000 * 2 ** (attempts - 1)
        )} * interval '1 millisecond'),"leaseToken"=NULL,"leasedUntil"=NULL
        WHERE "shop"=${shop} AND "kind"::text=${kind} AND "leaseToken"=${token} AND "leasedUntil">clock_timestamp()`;
    });
    throw error;
  }
}
