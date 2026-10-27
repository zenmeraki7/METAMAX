import { Router, raw } from "express";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import JSONbig from "json-bigint";

import { recordProductWebhook } from "./webhooks.repository.js";

// Load the delivery accelerator only when needed. Receipt durability does not
// depend on opening a Redis connection (including during receiver tests).
async function enqueueProductChange(...args) {
  const queue = await import("../../queues/reconcile.queue.js");
  return queue.enqueueProductChange(...args);
}

const RECONCILE_TOPICS = new Set([
  "products/create",
  "products/update",
  "products/delete",
]);

const SHOP_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;

const IDENTIFIER_PATTERN = /^[\x21-\x7e]{1,255}$/;

const HMAC_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i;

const PRODUCT_GID_PATTERN = /^gid:\/\/shopify\/Product\/([1-9]\d{0,39})$/;

const NUMERIC_ID_PATTERN = /^\d{1,40}$/;

const parser = JSONbig({
  storeAsString: true,
  strict: true,
  protoAction: "error",
  constructorAction: "error",
});

/**
 * Shopify HMAC verification.
 *
 * Shopify signs the original request body.
 * Never verify parsed or reserialized JSON.
 *
 * The previous secret is optional and should
 * be configured only during credential rotation.
 */
export function verifyHmac(body, header) {
  if (
    !Buffer.isBuffer(body) ||
    typeof header !== "string" ||
    !HMAC_PATTERN.test(header)
  ) {
    return false;
  }

  const received = Buffer.from(header, "base64");

  if (received.length !== 32) {
    return false;
  }

  const secrets = [
    process.env.SHOPIFY_API_SECRET,
    process.env.SHOPIFY_API_SECRET_PREVIOUS,
  ].filter((secret) => typeof secret === "string" && secret.length > 0);

  let valid = false;

  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(body).digest();

    // Evaluate all configured secrets.
    valid = timingSafeEqual(received, expected) || valid;
  }

  return valid;
}

/**
 * Normalize Shopify's shop domain.
 *
 * Must match the Shop.domain value in Neon.
 */
function readShop(req) {
  const value = req.get("x-shopify-shop-domain");

  if (typeof value !== "string") {
    return null;
  }

  const shop = value.trim().toLowerCase();

  return SHOP_PATTERN.test(shop) ? shop : null;
}

/**
 * Read a bounded delivery identifier.
 *
 * Do not enforce UUID format: Shopify describes
 * webhook IDs as delivery identifiers rather
 * than guaranteeing a single UUID representation.
 */
function readIdentifier(req, header) {
  const value = req.get(header);

  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    return null;
  }

  return value;
}

/**
 * Preserve Shopify's triggering time.
 *
 * Do not silently substitute receipt time.
 * A missing header should not produce
 * inconsistent receipt metadata on redelivery.
 */
function readTriggeredAt(req) {
  const value = req.get("x-shopify-triggered-at");

  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    return null;
  }

  const date = new Date(value);

  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Normalize large numeric Shopify IDs.
 *
 * json-bigint returns unsafe integers as strings.
 * Safe integers may remain JavaScript numbers.
 *
 * All IDs are converted to exact decimal strings.
 */
export function numericProductId(value) {
  let text;

  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    text = String(value);
  } else if (typeof value === "string" && NUMERIC_ID_PATTERN.test(value)) {
    text = value;
  } else {
    return null;
  }

  const id = BigInt(text);

  return id > 0n ? id.toString() : null;
}

/**
 * Return a canonical Product GID.
 *
 * products/delete commonly supplies only
 * the numeric product ID.
 *
 * When numeric ID and GID both exist,
 * they must identify the same product.
 */
function extractProductId(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const numericId = payload.id == null ? null : numericProductId(payload.id);

  if (payload.id != null && numericId === null) {
    return null;
  }

  const gid = payload.admin_graphql_api_id;

  let gidId = null;

  if (gid != null) {
    if (typeof gid !== "string") {
      return null;
    }

    const match = PRODUCT_GID_PATTERN.exec(gid);

    if (!match) {
      return null;
    }

    gidId = match[1];
  }

  if (numericId !== null && gidId !== null && numericId !== gidId) {
    return null;
  }

  const id = gidId ?? numericId;

  if (id === null) {
    return null;
  }

  return `gid://shopify/Product/${id}`;
}

/**
 * Accelerate reconciliation without delaying
 * Shopify's HTTP acknowledgment.
 *
 * The Neon scanner must recover dirty rows
 * if enqueue fails or this process crashes.
 */
function scheduleReconciliation(
  { shop, productId, revision },
  enqueue = enqueueProductChange
) {
  try {
    void enqueue(shop, productId, revision).catch((error) => {
      console.error("[webhooks] Reconciliation enqueue failed", {
        shop,
        productId,
        message: error?.message,
      });
    });
  } catch (error) {
    // Defensive guard for synchronous producer errors.
    console.error("[webhooks] Reconciliation scheduling failed", {
      shop,
      productId,
      message: error?.message,
    });
  }
}

/**
 * Shopify product webhook receiver.
 *
 * 1. Read original request bytes.
 * 2. Verify HMAC.
 * 3. Validate headers and product identity.
 * 4. Atomically commit receipt and dirty revision.
 * 5. Acknowledge Shopify.
 * 6. Best-effort BullMQ scheduling.
 */
export function createWebhookRouter({
  record = recordProductWebhook,
  enqueue = enqueueProductChange,
  topics = RECONCILE_TOPICS,
  extractIdentity = extractProductId,
  identityField = "productId",
} = {}) {
  const router = Router();
  router.post(
    "/",

    raw({
      type: "application/json",
      limit: process.env.SHOPIFY_WEBHOOK_BODY_LIMIT || "5mb",

      // Reject compressed content instead of changing
      // the bytes used for HMAC verification.
      inflate: false,
    }),

    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        return res.sendStatus(415);
      }

      // Missing credentials are a server configuration
      // problem, not an invalid Shopify signature.
      if (!process.env.SHOPIFY_API_SECRET) {
        console.error("[webhooks] SHOPIFY_API_SECRET is missing");

        return res.sendStatus(503);
      }

      if (!verifyHmac(req.body, req.get("x-shopify-hmac-sha256"))) {
        return res.sendStatus(401);
      }

      // Do not trust Shopify metadata until after
      // successful HMAC verification.
      const shop = readShop(req);

      const topic = req.get("x-shopify-topic");

      const id = readIdentifier(req, "x-shopify-webhook-id");

      const eventId = readIdentifier(req, "x-shopify-event-id");

      const triggeredAt = readTriggeredAt(req);

      if (!shop || !topics.has(topic) || !id || !eventId || !triggeredAt) {
        console.warn("[webhooks] Invalid webhook metadata", {
          shop,
          topic,
          deliveryId: id,
        });

        return res.sendStatus(400);
      }

      let payload;

      try {
        payload = parser.parse(req.body.toString("utf8"));
      } catch {
        return res.sendStatus(400);
      }

      const productId = extractIdentity(payload, topic);

      if (!productId) {
        console.warn("[webhooks] Invalid product identity", {
          shop,
          topic,
          deliveryId: id,
        });

        return res.sendStatus(400);
      }

      const payloadHash = createHash("sha256").update(req.body).digest("hex");

      let result;

      try {
        // Must commit before acknowledging Shopify.
        result = await record({
          id,
          shop,
          topic,
          [identityField]: productId,
          eventId,
          payloadHash,
          triggeredAt,
        });
      } catch (error) {
        const log =
          error?.code === "SHOP_REGISTRATION_PENDING"
            ? console.warn
            : console.error;
        log("[webhooks] Receipt commit failed", {
          shop,
          topic,
          deliveryId: id,
          code: error?.code,
          message: error?.message,
        });

        if (
          error?.statusCode === 503 ||
          error?.name?.startsWith("Prisma") ||
          /^P\d{4}$/.test(error?.code || "")
        ) {
          return res.sendStatus(503);
        }

        if (error?.statusCode === 409) {
          return res.sendStatus(409);
        }

        return res.sendStatus(500);
      }

      // At this point, Neon has durably committed:
      //  - the delivery receipt
      //  - the catalog revision
      //  - the snapshot invalidation, when applicable
      res.sendStatus(200);

      // Redis is only an acceleration mechanism.
      // Do not await it before HTTP acknowledgment.
      if (!result.duplicate && !result.ignored) {
        scheduleReconciliation(
          {
            shop,
            productId,
            revision: result.revision,
          },
          enqueue
        );
      }
    }
  );

  /**
   * Handle errors from express.raw().
   *
   * Keep parsing failures separate from repository
   * failures, and avoid exposing internal details.
   */
  router.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error?.type === "entity.too.large") {
      return res.sendStatus(413);
    }

    if (error?.status === 415) {
      return res.sendStatus(415);
    }

    if (error?.status === 400) {
      return res.sendStatus(400);
    }

    return next(error);
  });

  return router;
}

export default createWebhookRouter();
