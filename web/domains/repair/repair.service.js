import { randomUUID } from "node:crypto";

import { prisma } from "../../db/client.js";
import { processInventoryRepairStep } from "./inventory-repair.service.js";
import { graphql } from
  "../../integrations/shopify/graphql.js";

import {
  GET_UPDATED_PRODUCTS,
  GET_UPDATED_VARIANTS,
} from "./repair.queries.js";

const LEASE_MS = 5 * 60_000;
const SCAN_INTERVAL_MS = 15 * 60_000;
const OVERLAP_MS = 60 * 60_000;
const SETTLE_MS = 5 * 60_000;
const FULL_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const MAX_WINDOW_PAGES = 10_000;

const PRODUCT_GID =
  /^gid:\/\/shopify\/Product\/[1-9]\d*$/;

const VARIANT_GID =
  /^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/;

function nextDate(ms) {
  return new Date(Date.now() + ms);
}

function failureDelay(attempts) {
  return Math.min(
    300_000,
    5_000 * 2 ** Math.min(attempts, 6)
  );
}

async function finishStep(
  shop,
  kind,
  token,
  delayMs
) {
  await prisma.catalogRepair.updateMany({
    where: {
      shop,
      kind,
      leaseToken: token,
    },
    data: {
      leaseToken: null,
      leasedUntil: null,
      nextCheckAt: nextDate(delayMs),
      attempts: 0,
      lastError: null,
    },
  });
}

function readConnection(response) {
  if (
    response?.errors != null &&
    (
      !Array.isArray(response.errors) ||
      response.errors.length > 0
    )
  ) {
    throw new Error(
      "Shopify returned GraphQL errors"
    );
  }

  const data = response?.data ?? response;
  const connection = data?.resources;

  if (
    !connection ||
    !Array.isArray(connection.edges) ||
    connection.edges.length > 100 ||
    typeof connection.pageInfo?.hasNextPage !==
      "boolean"
  ) {
    throw new Error(
      "Invalid Shopify repair connection"
    );
  }

  return connection;
}

function productIdsFromPage(
  connection,
  kind,
  previousCursor
) {
  const ids = new Set();

  for (const edge of connection.edges) {
    const node = edge?.node;

    if (
      typeof node?.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(node.updatedAt))
    ) {
      throw new Error(
        "Invalid repair resource timestamp"
      );
    }

    if (kind === "PRODUCT") {
      if (!PRODUCT_GID.test(node.id)) {
        throw new Error(
          "Invalid Shopify product ID"
        );
      }

      ids.add(node.id);
    } else {
      if (
        !VARIANT_GID.test(node.id) ||
        !PRODUCT_GID.test(node.product?.id)
      ) {
        throw new Error(
          "Invalid Shopify variant parent"
        );
      }

      ids.add(node.product.id);
    }
  }

  const { hasNextPage, endCursor } =
    connection.pageInfo;

  if (
    hasNextPage &&
    (
      connection.edges.length === 0 ||
      typeof endCursor !== "string" ||
      !endCursor ||
      endCursor === previousCursor
    )
  ) {
    throw new Error(
      "Shopify repair cursor did not advance"
    );
  }

  return {
    productIds: [...ids],
    hasNextPage,
    nextCursor: hasNextPage
      ? endCursor
      : null,
  };
}

function searchWindow(from, until) {
  // These strings originate from validated Date
  // values, not from merchant-supplied query text.
  return (
    `updated_at:>='${from.toISOString()}' ` +
    `AND updated_at:<'${until.toISOString()}'`
  );
}

/**
 * One paginated discovery step.
 *
 * Every discovered product is invalidated
 * through the same durable revision pipeline
 * used by product webhooks.
 *
 * The cursor and invalidations commit together.
 */
async function scanIncrementalPage(
  shop,
  kind,
  token,
  state
) {
  const store = await prisma.shop.findUnique({
    where: { domain: shop },
    select: {
      activeSnapshotId: true,
      activeSnapshotId: true,
    },
  });

  // Initial catalog must be established by
  // the ordinary full-snapshot pipeline.
  if (!store?.activeSnapshotId) {
    await finishStep(
      shop, kind, token, SCAN_INTERVAL_MS
    );
    return { status: "awaiting_snapshot" };
  }

  const baseline =
    state.coveredThrough ??
    store.lastSyncedAt;

  if (!baseline && !state.windowFrom) {
    await finishStep(
      shop, kind, token, SCAN_INTERVAL_MS
    );
    return { status: "missing_baseline" };
  }

  const from = state.windowFrom ??
    new Date(
      baseline.getTime() - OVERLAP_MS
    );

  const until = state.windowTo ??
    new Date(
      Date.now() - SETTLE_MS
    );

  if (from >= until) {
    await finishStep(
      shop, kind, token, SCAN_INTERVAL_MS
    );
    return { status: "not_due" };
  }

  if (state.pagesInWindow >= MAX_WINDOW_PAGES) {
    throw new Error(
      "Incremental repair page limit exceeded"
    );
  }

  const query = kind === "PRODUCT"
    ? GET_UPDATED_PRODUCTS
    : GET_UPDATED_VARIANTS;

  const response = await graphql(
    shop,
    query,
    {
      filter: searchWindow(from, until),
      after: state.afterCursor,
    }
  );

  const connection = readConnection(response);

  const page = productIdsFromPage(
    connection,
    kind,
    state.afterCursor
  );

  const now = new Date();

  await prisma.$transaction(
    async (tx) => {
      // Coordinate with snapshot publication.
      const shops = await tx.$queryRaw`
        SELECT "activeRunId"
        FROM "Shop"
        WHERE "domain" = ${shop}
        FOR SHARE
      `;

      if (shops.length !== 1) {
        throw new Error(
          "Shop registration unavailable"
        );
      }

      // Fence this exact scanner invocation.
      const owned =
        await tx.catalogRepair.updateMany({
          where: {
            shop,
            kind,
            leaseToken: token,
            leasedUntil: { gt: now },
            windowFrom: state.windowFrom,
            windowTo: state.windowTo,
            afterCursor: state.afterCursor,
          },
          data: {
            leasedUntil:
              new Date(now.getTime() + LEASE_MS),
          },
        });

      if (owned.count !== 1) {
        throw new Error(
          "Repair scanner lease lost"
        );
      }

      for (const productId of page.productIds) {
        const change =
          await tx.catalogChange.upsert({
            where: {
              shop_productId: {
                shop,
                productId,
              },
            },
            create: {
              shop,
              productId,
              revision: 1n,
              appliedRevision: 0n,
              dirty: true,
              attempts: 0,
              nextAttemptAt: now,
            },
            update: {
              revision: { increment: 1n },
              dirty: true,
              attempts: 0,
              nextAttemptAt: now,
              lastError: null,
            },
          });

        // During full sync, also invalidate the
        // staging snapshot. Never write its
        // Product/Variant tables directly.
        const runId = shops[0].activeRunId;

        if (runId) {
          await tx.snapshotChange.upsert({
            where: {
              runId_productId: {
                runId,
                productId,
              },
            },
            create: {
              runId,
              productId,
              revision: change.revision,
              appliedRevision: 0n,
              dirty: true,
            },
            update: {
              revision: change.revision,
              dirty: true,
            },
          });
        }
      }

      // Cursor advances only AFTER every
      // invalidation has been persisted.
      await tx.catalogRepair.update({
        where: {
          shop_kind: { shop, kind },
        },
        data: page.hasNextPage
          ? {
              windowFrom: from,
              windowTo: until,
              afterCursor: page.nextCursor,
              pagesInWindow:
                state.pagesInWindow + 1,
              nextCheckAt:
                new Date(now.getTime() + 1_000),
              leaseToken: null,
              leasedUntil: null,
              attempts: 0,
              lastError: null,
            }
          : {
              coveredThrough: until,
              windowFrom: null,
              windowTo: null,
              afterCursor: null,
              pagesInWindow: 0,
              nextCheckAt:
                new Date(
                  now.getTime() +
                  SCAN_INTERVAL_MS
                ),
              leaseToken: null,
              leasedUntil: null,
              attempts: 0,
              lastError: null,
            },
      });
    },
    {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: "ReadCommitted",
    }
  );

  return {
    status: page.hasNextPage
      ? "more_pages"
      : "complete",
    discovered: page.productIds.length,
  };
}

/**
 * Scheduled full snapshots must enter through
 * the EXISTING durable sync starter.
 *
 * requestFullSnapshot is injected because the
 * exact starter function in sync.service.js has
 * not been supplied.
 */
async function checkFullSnapshot(
  shop,
  token,
  requestFullSnapshot
) {
  if (typeof requestFullSnapshot !== "function") {
    throw new TypeError(
      "A full snapshot starter is required"
    );
  }

  const store = await prisma.shop.findUnique({
    where: { domain: shop },
    select: {
      activeRunId: true,
      lastSyncedAt: true,
    },
  });

  if (!store) {
    await finishStep(
      shop, "FULL", token, FULL_INTERVAL_MS
    );
    return { status: "shop_missing" };
  }

  if (store.activeRunId) {
    await finishStep(
      shop, "FULL", token, 60 * 60_000
    );
    return { status: "sync_already_running" };
  }

  const published = store.activeSnapshotId ? await prisma.snapshotRun.findUnique({
    where: { id: store.activeSnapshotId }, select: { completedAt: true },
  }) : null;
  const due = !published?.completedAt ||
    Date.now() - published.completedAt.getTime() >=
      FULL_INTERVAL_MS;

  if (!due) {
    await finishStep(
      shop, "FULL", token, 60 * 60_000
    );
    return { status: "full_snapshot_not_due" };
  }

  // The existing sync starter MUST atomically
  // reserve Shop.activeRunId and be idempotent.
  // It must enqueue work, not run an entire
  // Shopify bulk operation in this call.
  await requestFullSnapshot(shop, {
    reason: "PERIODIC_REPAIR",
  });

  // Check again later if the sync fails.
  // A successful publication updates
  // the active snapshot's completedAt.
  await finishStep(
    shop, "FULL", token, 6 * 60 * 60_000
  );

  return { status: "full_snapshot_requested" };
}

/**
 * Atomic per-shop, per-kind ownership.
 *
 * Safe to invoke from multiple scanner replicas.
 */
export async function processRepairStep(
  shop,
  kind,
  options = {}
) {
  if (["INVENTORY_ITEM", "INVENTORY_LEVEL"].includes(kind))
    return processInventoryRepairStep(shop, kind, options);
  const { requestFullSnapshot } = options;
  if (!["PRODUCT", "VARIANT", "FULL"].includes(kind)) {
    throw new TypeError("Invalid repair kind");
  }

  const token = randomUUID();
  const now = new Date();

  const claimed =
    await prisma.catalogRepair.updateMany({
      where: {
        shop,
        kind,
        nextCheckAt: { lte: now },
        OR: [
          { leasedUntil: null },
          { leasedUntil: { lte: now } },
        ],
      },
      data: {
        leaseToken: token,
        leasedUntil:
          new Date(now.getTime() + LEASE_MS),
      },
    });

  if (claimed.count !== 1) {
    return { status: "not_due_or_leased" };
  }

  try {
    const state =
      await prisma.catalogRepair.findUniqueOrThrow({
        where: {
          shop_kind: { shop, kind },
        },
      });

    if (state.leaseToken !== token) {
      return { status: "superseded" };
    }

    if (kind === "FULL") {
      return await checkFullSnapshot(
        shop,
        token,
        requestFullSnapshot
      );
    }

    return await scanIncrementalPage(
      shop,
      kind,
      token,
      state
    );
  } catch (error) {
    const message = String(
      error?.message ?? error
    ).slice(0, 500);

    const current =
      await prisma.catalogRepair.findUnique({
        where: {
          shop_kind: { shop, kind },
        },
        select: {
          attempts: true,
          leaseToken: true,
        },
      });

    if (current?.leaseToken === token) {
      await prisma.catalogRepair.updateMany({
        where: {
          shop,
          kind,
          leaseToken: token,
        },
        data: {
          leaseToken: null,
          leasedUntil: null,
          attempts: { increment: 1 },
          nextCheckAt: nextDate(
            failureDelay(
              (current.attempts ?? 0) + 1
            )
          ),
          lastError: message,
        },
      });
    }

    throw error;
  }
}
