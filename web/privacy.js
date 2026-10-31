import { createHash, randomUUID } from "node:crypto";
import { DeliveryMethod } from "@shopify/shopify-api";
import { createReconciliationService } from "./mirror/reconciliation-service.server.js";
import { database as defaultDatabase } from "./db/postgres.js";
import { FieldError, FIELD_ERROR_CODES as C } from "./fields/types.js";
import { transaction } from "./mirror/transactions.server.js";

const SHOP_REGEX = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function calculatePayloadHash(rawBody) {
  return createHash("sha256")
    .update(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody || {}))
    .digest("hex");
}

export function validateShop(shop) {
  if (
    typeof shop !== "string" ||
    shop.length === 0 ||
    shop.length > 255 ||
    !SHOP_REGEX.test(shop)
  ) {
    throw new FieldError(C.PERMISSION_DENIED, "Valid authenticated shop domain required");
  }
}

export async function extractProductIds(topic, payload, database, shopId) {
  if (!payload || typeof payload !== "object") return [];
  const normalizedTopic = (topic || "").toUpperCase();

  // 1. Direct GraphQL ID
  if (
    typeof payload.admin_graphql_api_id === "string" &&
    /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(payload.admin_graphql_api_id)
  ) {
    return [payload.admin_graphql_api_id];
  }

  // 2. Direct product ID on product topics
  if (normalizedTopic.includes("PRODUCT") && payload.id) {
    const rawId = String(payload.id);
    return [rawId.startsWith("gid://") ? rawId : `gid://shopify/Product/${rawId}`];
  }

  // 3. Variant or option webhook with parent product_id
  if (payload.product_id) {
    const rawId = String(payload.product_id);
    return [rawId.startsWith("gid://") ? rawId : `gid://shopify/Product/${rawId}`];
  }

  // 4. Collections with product lists
  if (Array.isArray(payload.product_ids) && payload.product_ids.length > 0) {
    return payload.product_ids
      .map(id => (String(id).startsWith("gid://") ? String(id) : `gid://shopify/Product/${id}`))
      .filter(id => /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(id));
  }
  if (Array.isArray(payload.products) && payload.products.length > 0) {
    return payload.products
      .map(p => p?.admin_graphql_api_id || (p?.id ? (String(p.id).startsWith("gid://") ? String(p.id) : `gid://shopify/Product/${p.id}`) : null))
      .filter(id => typeof id === "string" && /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(id));
  }

  // 5. Database lookup for inventory levels or inventory items
  if (database && shopId) {
    if (normalizedTopic.includes("INVENTORY_LEVEL") && payload.inventory_item_id) {
      try {
        const res = await database.query(
          `SELECT DISTINCT p.shopify_id FROM mirror.variants v
           JOIN mirror.products p ON p.shop_id=v.shop_id AND p.generation_id=v.generation_id AND p.id=v.product_id
           WHERE v.shop_id=$1 AND v.inventory_item_id=$2`,
          [shopId, BigInt(payload.inventory_item_id)],
        );
        return res.rows.map(r => r.shopify_id);
      } catch {
        return [];
      }
    }
    if (normalizedTopic.includes("INVENTORY_ITEM") && payload.id) {
      try {
        const res = await database.query(
          `SELECT DISTINCT p.shopify_id FROM mirror.variants v
           JOIN mirror.products p ON p.shop_id=v.shop_id AND p.generation_id=v.generation_id AND p.id=v.product_id
           WHERE v.shop_id=$1 AND v.inventory_item_id=$2`,
          [shopId, BigInt(payload.id)],
        );
        return res.rows.map(r => r.shopify_id);
      } catch {
        return [];
      }
    }
    if (normalizedTopic.includes("COLLECTION") && payload.id) {
      try {
        const colGid = String(payload.id).startsWith("gid://") ? String(payload.id) : `gid://shopify/Collection/${payload.id}`;
        const res = await database.query(
          `SELECT DISTINCT p.shopify_id FROM mirror.product_collections pc
           JOIN mirror.products p ON p.shop_id=pc.shop_id AND p.generation_id=pc.generation_id AND p.id=pc.product_id
           JOIN mirror.collections c ON c.shop_id=pc.shop_id AND c.generation_id=pc.generation_id AND c.id=pc.collection_id
           WHERE pc.shop_id=$1 AND c.shopify_id=$2`,
          [shopId, colGid],
        );
        return res.rows.map(r => r.shopify_id);
      } catch {
        return [];
      }
    }
  }

  return [];
}

export async function handleWebhookEvent({
  topic,
  shop,
  body,
  webhookId,
  apiVersion,
  sessionStorage,
  reconciliationService,
  database,
  historyPrivacyService,
}) {
  validateShop(shop);
  const normalizedTopic = (topic || "").toUpperCase();

  if (database && (normalizedTopic === "APP_UNINSTALLED" || normalizedTopic === "SHOP_REDACT")) {
    const payloadHash = calculatePayloadHash(body);
    const eventId = webhookId || `event_${payloadHash.slice(0, 32)}`;
    if (typeof eventId !== "string" || !eventId || eventId.length > 255)
      throw new FieldError(C.CONTRACT_MISMATCH, "Valid event identity required");
    return transaction(database, async client => {
      // Keep a tombstone even when installation scheduling never committed.
      await client.query(`INSERT INTO mirror.shops(id,installation_version,uninstalled_at)
        VALUES ($1,$2,clock_timestamp()) ON CONFLICT(id) DO NOTHING`, [shop,randomUUID()]);
      const previous = (await client.query("SELECT payload_hash FROM mirror.webhook_receipts WHERE shop_id=$1 AND event_id=$2", [shop,eventId])).rows[0];
      if (previous) {
        if (previous.payload_hash !== payloadHash) throw new FieldError(C.CONTRACT_MISMATCH, "Event identity reused for different intent");
        return {acknowledged:true,duplicate:true};
      }
      // The uninstall trigger records the exact historical installation and
      // fences its history jobs in this transaction. Delayed redaction must not
      // tombstone, cancel or delete sessions belonging to a newer installation.
      if(normalizedTopic==='APP_UNINSTALLED'){
        await client.query("UPDATE mirror.shops SET uninstalled_at=COALESCE(uninstalled_at,clock_timestamp()) WHERE id=$1", [shop]);
        await client.query(`UPDATE mirror.catalog_import_jobs SET cancel_requested=true,updated_at=now()
          WHERE shop_id=$1 AND status IN ('QUEUED','RUNNING','RETRY')`, [shop]);
      }else if(historyPrivacyService)await historyPrivacyService.redactShop(shop);
      else await client.query('SELECT edit_history.request_shop_redaction($1)',[shop]);
      const active=(await client.query('SELECT uninstalled_at IS NULL AS active FROM mirror.shops WHERE id=$1 FOR SHARE',[shop])).rows[0]?.active===true;
      if (sessionStorage && !active) {
        const sessions = await sessionStorage.findSessionsByShop(shop);
        if (sessions?.length) await sessionStorage.deleteSessions(sessions.map(s => s.id));
      }
      await client.query(`INSERT INTO mirror.webhook_receipts(shop_id,event_id,topic,payload_hash,received_at,processed_at)
        VALUES ($1,$2,$3,$4,now(),now())`, [shop,eventId,normalizedTopic,payloadHash]);
      return {acknowledged:true};
    });
  }

  // 1. Session cleanup compliance for APP_UNINSTALLED and SHOP_REDACT
  if (sessionStorage && (normalizedTopic === "APP_UNINSTALLED" || normalizedTopic === "SHOP_REDACT")) {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions && sessions.length > 0) {
      await sessionStorage.deleteSessions(sessions.map(s => s.id));
    }
  }

  // If no reconciliationService or database is configured, early return
  if (!reconciliationService && !database) {
    return { acknowledged: true };
  }

  const effectiveReconciliationService =
    reconciliationService || (database ? createReconciliationService({ database }) : null);

  const payloadHash = calculatePayloadHash(body);
  const eventId = webhookId || `event_${payloadHash.slice(0, 32)}`;

  let payload = {};
  if (body) {
    try {
      payload = typeof body === "string" ? JSON.parse(body) : body;
    } catch {
      throw new FieldError(C.CONTRACT_MISMATCH, "Malformed webhook JSON payload");
    }
  }

  const productIds = await extractProductIds(normalizedTopic, payload, database, shop);
  const deleted = normalizedTopic.includes("DELETE");

  if (productIds.length > 0) {
    // Persist verified event identity and mutation journal for each affected product
    for (const productId of productIds) {
      const sourceKey = productIds.length === 1 ? `webhook:${eventId}` : `webhook:${eventId}:${productId}`;
      await effectiveReconciliationService.recordMutationEvent({
        shopId: shop,
        productId,
        sourceKey,
        source: "WEBHOOK",
        deleted,
        payloadHash,
        eventId,
        topic: normalizedTopic,
      });
    }
  } else {
    // Persist verified event identity for related resource or non-product webhook
    await effectiveReconciliationService.recordWebhookReceipt({
      shopId: shop,
      eventId,
      topic: normalizedTopic,
      payloadHash,
    });
  }

  return { acknowledged: true };
}

export function createWebhookHandlers(sessionStorageOrOptions, maybeOptions = {}) {
  let sessionStorage = null;
  let options = {};
  if (sessionStorageOrOptions && typeof sessionStorageOrOptions.findSessionsByShop === "function") {
    sessionStorage = sessionStorageOrOptions;
    options = maybeOptions || {};
  } else if (sessionStorageOrOptions && typeof sessionStorageOrOptions === "object") {
    sessionStorage = sessionStorageOrOptions.sessionStorage;
    options = sessionStorageOrOptions;
  } else {
    options = maybeOptions || {};
  }

  const database = options.database ?? null;
  const reconciliationService = options.reconciliationService ?? (database ? createReconciliationService({ database }) : null);

  const handler = callback => ({ deliveryMethod: DeliveryMethod.Http, callbackUrl: "/api/webhooks", callback });

  const makeHandler = defaultTopic =>
    handler(async (topic, shop, body, webhookId, apiVersion) => {
      const effectiveTopic = topic || defaultTopic;
      await handleWebhookEvent({
        topic: effectiveTopic,
        shop,
        body,
        webhookId,
        apiVersion,
        sessionStorage,
        reconciliationService,
        database,
        historyPrivacyService:options.historyPrivacyService,
      });
    });

  return {
    CUSTOMERS_DATA_REQUEST: makeHandler("CUSTOMERS_DATA_REQUEST"),
    CUSTOMERS_REDACT: makeHandler("CUSTOMERS_REDACT"),
    SHOP_REDACT: makeHandler("SHOP_REDACT"),
    APP_UNINSTALLED: makeHandler("APP_UNINSTALLED"),
    PRODUCTS_CREATE: makeHandler("PRODUCTS_CREATE"),
    PRODUCTS_UPDATE: makeHandler("PRODUCTS_UPDATE"),
    PRODUCTS_DELETE: makeHandler("PRODUCTS_DELETE"),
    COLLECTIONS_CREATE: makeHandler("COLLECTIONS_CREATE"),
    COLLECTIONS_UPDATE: makeHandler("COLLECTIONS_UPDATE"),
    COLLECTIONS_DELETE: makeHandler("COLLECTIONS_DELETE"),
    INVENTORY_LEVELS_CONNECT: makeHandler("INVENTORY_LEVELS_CONNECT"),
    INVENTORY_LEVELS_UPDATE: makeHandler("INVENTORY_LEVELS_UPDATE"),
    INVENTORY_LEVELS_DISCONNECT: makeHandler("INVENTORY_LEVELS_DISCONNECT"),
    INVENTORY_ITEMS_CREATE: makeHandler("INVENTORY_ITEMS_CREATE"),
    INVENTORY_ITEMS_UPDATE: makeHandler("INVENTORY_ITEMS_UPDATE"),
    INVENTORY_ITEMS_DELETE: makeHandler("INVENTORY_ITEMS_DELETE"),
  };
}
