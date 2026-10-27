import { createHash } from "node:crypto";
import { Queue } from "bullmq";

import { producerRedis } from "../integrations/redis/connection.js";

export const RECONCILE_QUEUE = "catalog-reconcile";
export const RECONCILE_JOB = "reconcile-product";
export const RECONCILE_PREFIX = process.env.QUEUE_PREFIX || "newmeta";

const MAX_REVISION = 9223372036854775807n;
const MAX_PRODUCT_ID_LENGTH = 512;

const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

/**
 * Normalize Shopify's permanent shop domain.
 *
 * The resulting value must match the canonical
 * shop identifier stored in Neon.
 */
function normalizeShop(shop) {
  if (typeof shop !== "string") {
    throw new TypeError("shop must be a string");
  }

  const normalized = shop.trim().toLowerCase();

  if (!SHOP_DOMAIN.test(normalized)) {
    throw new TypeError("shop must be a valid myshopify.com domain");
  }

  return normalized;
}

/**
 * Keep product identity consistent with CatalogChange.
 *
 * Both Shopify numeric IDs represented as strings
 * and GraphQL GIDs are accepted.
 */
function normalizeProductId(productId) {
  if (typeof productId !== "string") {
    throw new TypeError("productId must be a string");
  }

  const normalized = productId.trim();

  if (
    normalized.length === 0 ||
    normalized.length > MAX_PRODUCT_ID_LENGTH ||
    normalized.includes("\0")
  ) {
    throw new TypeError("productId is invalid");
  }

  return normalized;
}

/**
 * Revisions are PostgreSQL BIGINT values.
 *
 * Use canonical decimal strings so:
 *  - BigInt never enters Redis job data
 *  - unsafe JavaScript integers are rejected
 *  - "00042" and 42n produce the same job ID
 */
function normalizeRevision(revision) {
  let value;

  if (typeof revision === "bigint") {
    value = revision;
  } else if (typeof revision === "number" && Number.isSafeInteger(revision)) {
    value = BigInt(revision);
  } else if (typeof revision === "string" && /^\d+$/.test(revision)) {
    value = BigInt(revision);
  } else {
    throw new TypeError("revision must be a positive integer");
  }

  if (value < 1n || value > MAX_REVISION) {
    throw new RangeError("revision is outside the PostgreSQL BIGINT range");
  }

  return value.toString();
}

/**
 * Stable identity across application instances.
 *
 * Hash the canonical shop and product ID with a
 * separator to prevent ambiguous concatenation.
 */
function productKey(shop, productId) {
  return createHash("sha256")
    .update(shop)
    .update("\0")
    .update(productId)
    .digest("hex")
    .slice(0, 32);
}

/**
 * BullMQ provides scheduling, not durable truth.
 *
 * Neon owns:
 *  - pending reconciliation
 *  - applied revision
 *  - retry eligibility
 *  - failure details
 *
 * Jobs must be removable after terminal states
 * so the recovery scanner can enqueue them again.
 */
export const reconcileQueue = new Queue(RECONCILE_QUEUE, {
  prefix: RECONCILE_PREFIX,
  connection: producerRedis,

  defaultJobOptions: {
    // Durable retries are controlled by Neon.
    attempts: 1,

    // Do not retain terminal jobs that could
    // block scheduling the same revision again.
    removeOnComplete: true,
    removeOnFail: true,
  },
});

/**
 * Avoid unhandled queue-level error events.
 *
 * Individual enqueue failures still reject and
 * must be handled by their callers.
 */
reconcileQueue.on("error", (error) => {
  console.error("[catalog-reconcile] Queue error:", error);
});

/**
 * Enqueue a product reconciliation signal.
 *
 * Multiple calls for the same shop/product/revision
 * deduplicate while the job remains in Redis.
 *
 * A newer revision gets a different job ID.
 *
 * The worker must fetch the authoritative pending
 * revision from Neon, not trust the job ID.
 */
export async function enqueueProductChange(shop, productId, revision) {
  const normalizedShop = normalizeShop(shop);

  const normalizedProductId = normalizeProductId(productId);

  const normalizedRevision = normalizeRevision(revision);

  const key = productKey(normalizedShop, normalizedProductId);

  const jobId = `product-${key}-${normalizedRevision}`;

  return reconcileQueue.add(
    RECONCILE_JOB,
    {
      shop: normalizedShop,
      productId: normalizedProductId,
    },
    {
      jobId,
    }
  );
}
