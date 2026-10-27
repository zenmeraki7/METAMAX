import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../../db/client.js";
import { fetchCurrentProduct } from "../products/products.service.js";
import {
  completeProductReconciliation,
  commitCurrentProduct,
} from "./webhooks.repository.js";

export { commitCurrentProduct };

export async function deferUntilSnapshot(
  shop,
  productId,
  token,
  revision
) {
  const released = await prisma.catalogChange.updateMany({
    where: {
      shop,
      productId,
      revision,
      leaseToken: token,
      dirty: true,
    },
    data: {
      leaseToken: null,
      leasedUntil: null,
      waitingForSnapshot: true,
      nextAttemptAt: new Date(Date.now() + 60000),
    },
  });

  if (released.count !== 1) {
    await releaseLease(shop, productId, token);
  }

  return {
    status: "waiting_for_snapshot",
    shop,
    productId,
  };
}

export const LEASE_MS = 5 * 60 * 1000;
export const MAX_RECONCILIATION_ATTEMPTS = 8;

export function calculateBackoff(attempt = 0) {
  return Math.min(300000, 5000 * 2 ** Math.min(Math.max(attempt, 0), 7));
}

function retryDelay(attempt) {
  const base = calculateBackoff(attempt);
  const spread = Math.floor(base * 0.2);
  return Math.min(300000, base - spread + randomInt(spread * 2 + 1));
}

function validateIdentity(shop, productId) {
  if (
    typeof shop !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(shop)
  )
    throw new TypeError("Invalid canonical shop domain");
  if (
    typeof productId !== "string" ||
    !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(productId)
  )
    throw new TypeError("Invalid product GID");
}

function messageOf(error) {
  return (
    (error instanceof Error ? error.message : String(error)).slice(0, 500) ||
    "Product reconciliation failed"
  );
}

// Capture revision and ownership in the same transaction. All mutation paths
// lock Shop before CatalogChange, matching webhook receipt and uninstall order.
async function claim(shop, productId, token) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const shops = await tx.$queryRaw`
          SELECT "status", "generation", "activeSnapshotId" FROM "Shop"
          WHERE "domain" = ${shop} FOR SHARE`;
          if (shops[0]?.status !== "ACTIVE") return { reason: "inactive" };
          const changes = await tx.$queryRaw`
          UPDATE "CatalogChange" SET "leaseToken" = ${token},
            "leasedUntil" = clock_timestamp() + (${LEASE_MS} * interval '1 millisecond'),
            "updatedAt" = clock_timestamp()
          WHERE "shop" = ${shop} AND "productId" = ${productId}
            AND "dirty" = true AND "appliedRevision" < "revision"
            AND "deadLetterAt" IS NULL
            AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp())
            AND ("leasedUntil" IS NULL OR "leasedUntil" <= clock_timestamp())
          RETURNING "revision", "attempts"`;
          if (changes.length) {
            if (!shops[0].activeSnapshotId) {
              await tx.catalogChange.updateMany({
                where: {
                  shop,
                  productId,
                  leaseToken: token,
                  revision: changes[0].revision,
                },
                data: {
                  leaseToken: null,
                  leasedUntil: null,
                  waitingForSnapshot: true,
                  nextAttemptAt: new Date(Date.now() + 60000),
                },
              });
              return { waiting: true };
            }
            return {
              ...changes[0],
              generation: shops[0].generation,
              snapshotId: shops[0].activeSnapshotId,
            };
          }
          const change = await tx.catalogChange.findUnique({
            where: { shop_productId: { shop, productId } },
            select: { dirty: true, revision: true, appliedRevision: true },
          });
          return {
            reason:
              !change ||
              !change.dirty ||
              change.appliedRevision >= change.revision
                ? "clean"
                : "not-due",
          };
        },
        { maxWait: 1000, timeout: 10000 }
      );
    } catch (error) {
      if (!["P2002", "P2034"].includes(error?.code) || attempt >= 1)
        throw error;
      await delay(randomInt(20, 61));
    }
  }
}

async function releaseLease(shop, productId, token) {
  await prisma.catalogChange.updateMany({
    where: { shop, productId, leaseToken: token },
    data: { leaseToken: null, leasedUntil: null },
  });
}

// A lease is an execution claim, never proof that a revision was applied.
// The JSON mirror and exact revision acknowledgment still commit together.
export async function reconcileProduct(shop, productId, options = {}) {
  validateIdentity(shop, productId);
  const token = randomUUID();
  const claimed = await claim(shop, productId, token);
  if (claimed.waiting)
    return { status: "waiting_for_snapshot", shop, productId };
  if (claimed.reason)
    return { status: "skipped", reason: claimed.reason, shop, productId };
  const { revision, attempts, generation, snapshotId } = claimed;
  const superseded = () => ({
    status: "superseded",
    revision: revision.toString(),
    shop,
    productId,
  });
  try {
    const shopRecord =
      await prisma.shop.findUnique({
        where: { domain: shop },
        select: { activeSnapshotId: true },
      });

    if (!shopRecord?.activeSnapshotId) {
      return await deferUntilSnapshot(
        shop,
        productId,
        token,
        revision
      );
    }

    const expectedSnapshotId =
      shopRecord.activeSnapshotId;

    const current = await (options.fetchProduct || fetchCurrentProduct)(
      shop,
      productId,
      { generation }
    );

    const result = await commitCurrentProduct({
      shop,
      productId,
      token,
      revision,
      current,
      expectedSnapshotId,
      generation,
      writeReconciledProduct: options.writeReconciledProduct,
    });

    if (result.status === "no_active_snapshot") {
      return await deferUntilSnapshot(
        shop,
        productId,
        token,
        revision
      );
    }

    if (result.status === "snapshot_changed") {
      const rescheduled =
        await prisma.catalogChange.updateMany({
          where: {
            shop,
            productId,
            revision,
            leaseToken: token,
            dirty: true,
          },

          data: {
            leaseToken: null,
            leasedUntil: null,

            // Fresh Shopify read required.
            nextAttemptAt: new Date(),
          },
        });

      if (rescheduled.count !== 1) {
        // Another webhook or lease owner may
        // have superseded this worker.
        await releaseLease(
          shop,
          productId,
          token
        );
      }

      return {
        status: "snapshot_changed",
      };
    }

    if (result.status !== "applied" && result !== true) {
      await releaseLease(shop, productId, token);
      return superseded();
    }

    return {
      status: "reconciled",
      revision: revision.toString(),
      shop,
      productId,
    };
  } catch (error) {
    const original = error instanceof Error ? error : new Error(String(error));
    try {
      const dead = attempts + 1 >= MAX_RECONCILIATION_ATTEMPTS;
      const failed = await prisma.catalogChange.updateMany({
        where: {
          shop,
          productId,
          revision,
          leaseToken: token,
          attempts,
          dirty: true,
          appliedRevision: { lt: revision },
          merchant: { status: "ACTIVE", generation },
        },
        data: {
          leaseToken: null,
          leasedUntil: null,
          attempts: { increment: 1 },
          lastError: messageOf(original),
          nextAttemptAt: dead
            ? null
            : new Date(Date.now() + retryDelay(attempts)),
          deadLetterAt: dead ? new Date() : null,
        },
      });
      if (failed.count !== 1) {
        await releaseLease(shop, productId, token);
        return superseded();
      }
    } catch (persistError) {
      // Ownership expires in Neon even if both queue and database were down.
      // Do not mask either failure or clear an unpersisted recovery claim.
      throw new AggregateError(
        [original, persistError],
        "Reconciliation and retry-state persistence both failed"
      );
    }
    throw original;
  }
}
