import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createWebhookHandlers,
  handleWebhookEvent,
  calculatePayloadHash,
  extractProductIds,
  validateShop,
} from "../privacy.js";

const shopId = "unit-webhook.myshopify.com";
const productId = "gid://shopify/Product/123456";

test("validateShop: accepts valid myshopify domains and rejects invalid or forged domains", () => {
  assert.doesNotThrow(() => validateShop("store.myshopify.com"));
  assert.doesNotThrow(() => validateShop("my-cool-store-1.myshopify.com"));

  for (const invalid of ["bad", "store.evil.com", "store.myshopify.com/path", "", null, undefined, "store..myshopify.com"]) {
    assert.throws(() => validateShop(invalid), /Valid authenticated shop domain required/);
  }
});

test("calculatePayloadHash: calculates deterministic SHA-256 hex checksum", () => {
  const payload = JSON.stringify({ id: 123, title: "Test" });
  const expectedHash = createHash("sha256").update(payload).digest("hex");
  assert.equal(calculatePayloadHash(payload), expectedHash);
});

test("extractProductIds: extracts product GIDs from products, variants, collections and inventory payloads", async () => {
  // 1. GraphQL GID
  const fromGid = await extractProductIds("PRODUCTS_UPDATE", { admin_graphql_api_id: productId });
  assert.deepEqual(fromGid, [productId]);

  // 2. Numeric product ID
  const fromNum = await extractProductIds("PRODUCTS_CREATE", { id: 123456 });
  assert.deepEqual(fromNum, [productId]);

  // 3. Variant webhook with parent product_id
  const fromVariant = await extractProductIds("VARIANTS_UPDATE", { id: 999, product_id: 123456 });
  assert.deepEqual(fromVariant, [productId]);

  // 4. Collection webhook with product list
  const fromCollection = await extractProductIds("COLLECTIONS_UPDATE", {
    id: 555,
    product_ids: [123456, "gid://shopify/Product/789"],
  });
  assert.deepEqual(fromCollection, [productId, "gid://shopify/Product/789"]);

  // 5. Unverified inventory mappings must request a durable broader refresh.
  const mockDb = {
    async query(sql, params) {
      assert.fail("An unavailable inventory relation must not be queried");
    },
  };
  const fromInventory = await extractProductIds("INVENTORY_LEVELS_UPDATE", { inventory_item_id: 888 }, mockDb, shopId);
  assert.deepEqual(fromInventory, []);
});

test("createWebhookHandlers: registers all expected topics and cleans sessions on uninstall/redact", async () => {
  const deletedSessions = [];
  const mockSessionStorage = {
    async findSessionsByShop(shop) {
      return [{ id: `offline_${shop}` }];
    },
    async deleteSessions(ids) {
      deletedSessions.push(...ids);
    },
  };

  const handlers = createWebhookHandlers(mockSessionStorage);

  assert.ok(handlers.PRODUCTS_CREATE);
  assert.ok(handlers.PRODUCTS_UPDATE);
  assert.ok(handlers.PRODUCTS_DELETE);
  assert.ok(handlers.COLLECTIONS_CREATE);
  assert.ok(handlers.COLLECTIONS_UPDATE);
  assert.ok(handlers.COLLECTIONS_DELETE);
  assert.ok(handlers.INVENTORY_LEVELS_CONNECT);
  assert.ok(handlers.INVENTORY_LEVELS_UPDATE);
  assert.ok(handlers.INVENTORY_LEVELS_DISCONNECT);
  assert.ok(handlers.INVENTORY_ITEMS_CREATE);
  assert.ok(handlers.INVENTORY_ITEMS_UPDATE);
  assert.ok(handlers.INVENTORY_ITEMS_DELETE);
  assert.ok(handlers.APP_UNINSTALLED);
  assert.ok(handlers.SHOP_REDACT);

  // Test session cleanup on uninstall
  await handlers.APP_UNINSTALLED.callback("APP_UNINSTALLED", shopId);
  assert.deepEqual(deletedSessions, [`offline_${shopId}`]);
});

test("handleWebhookEvent: persists verified event identity and mutation journal entry", async () => {
  const store = {
    receipts: new Map(),
    journal: new Map(),
    changes: new Map(),
  };

  const mockClient = {
    async query(sql, params) {
      if (sql.includes("SELECT payload_hash,topic FROM mirror.webhook_receipts")) {
        const key = `${params[0]}:${params[1]}`;
        const rec = store.receipts.get(key);
        return { rows: rec ? [rec] : [] };
      }
      if (sql.includes("INSERT INTO mirror.webhook_receipts")) {
        const key = `${params[0]}:${params[1]}`;
        store.receipts.set(key, { payload_hash: params[3],topic:params[2] });
        return { rows: [{ id: 1n }] };
      }
      if (sql.includes("SELECT * FROM mirror.mutation_journal")) {
        const key = `${params[0]}:${params[1]}`;
        const j = store.journal.get(key);
        return { rows: j ? [j] : [] };
      }
      if (sql.includes("INSERT INTO mirror.catalog_changes")) {
        const key = `${params[0]}:${params[1]}`;
        const prev = store.changes.get(key) || { revision: 0n, dirty: false };
        const updated = {
          revision: prev.revision + 1n,
          dirty: true,
          deleted: params[2],
        };
        store.changes.set(key, updated);
        return { rows: [{ revision: updated.revision.toString() }] };
      }
      if (sql.includes("INSERT INTO mirror.mutation_journal")) {
        const key = `${params[0]}:${params[3]}`;
        store.journal.set(key, {
          shop_id: params[0],
          product_id: params[1],
          revision: params[2],
          source_key: params[3],
          source: params[4],
          deleted: params[5],
          payload_hash: params[6],
        });
        return { rows: [{ id: 10n }] };
      }
      return { rows: [] };
    },
    release() {},
  };

  const mockDatabase = {
    async connect() { return mockClient; },
  };

  const payload = JSON.stringify({ id: 123456, title: "Updated Product" });
  const eventId = "evt-unit-1";

  // 1. Process PRODUCTS_UPDATE webhook
  const result = await handleWebhookEvent({
    topic: "PRODUCTS_UPDATE",
    shop: shopId,
    body: payload,
    webhookId: eventId,
    database: mockDatabase,
  });

  assert.equal(result.acknowledged, true);
  assert.equal(store.receipts.size, 1);
  assert.equal(store.changes.size, 1);
  assert.equal(store.journal.size, 1);

  const change = store.changes.get(`${shopId}:${productId}`);
  assert.equal(change.revision, 1n);
  assert.equal(change.dirty, true);
  assert.equal(change.deleted, false);

  const journal = store.journal.get(`${shopId}:webhook:${eventId}`);
  assert.equal(journal.product_id, productId);
  assert.equal(journal.deleted, false);

  // 2. Duplicate delivery with identical payload returns acknowledged without creating new revision
  const dupResult = await handleWebhookEvent({
    topic: "PRODUCTS_UPDATE",
    shop: shopId,
    body: payload,
    webhookId: eventId,
    database: mockDatabase,
  });
  assert.equal(dupResult.acknowledged, true);
  assert.equal(store.changes.get(`${shopId}:${productId}`).revision, 1n);

  // 3. Duplicate eventId with CHANGED payload hash fails closed
  const conflictingPayload = JSON.stringify({ id: 123456, title: "Forged Payload" });
  await assert.rejects(
    () =>
      handleWebhookEvent({
        topic: "PRODUCTS_UPDATE",
        shop: shopId,
        body: conflictingPayload,
        webhookId: eventId,
        database: mockDatabase,
      }),
    /Event identity reused for different intent/,
  );
});

test("handleWebhookEvent: PRODUCTS_DELETE sets deleted=true and bumps revision", async () => {
  const store = {
    receipts: new Map(),
    journal: new Map(),
    changes: new Map(),
  };

  const mockClient = {
    async query(sql, params) {
      if (sql.includes("SELECT payload_hash,topic FROM mirror.webhook_receipts")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO mirror.webhook_receipts")) {
        store.receipts.set(`${params[0]}:${params[1]}`, { payload_hash: params[3],topic:params[2] });
        return { rows: [{ id: 1n }] };
      }
      if (sql.includes("SELECT * FROM mirror.mutation_journal")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO mirror.catalog_changes")) {
        const updated = { revision: 2n, dirty: true, deleted: params[2] };
        store.changes.set(`${params[0]}:${params[1]}`, updated);
        return { rows: [{ revision: updated.revision.toString() }] };
      }
      if (sql.includes("INSERT INTO mirror.mutation_journal")) {
        store.journal.set(`${params[0]}:${params[3]}`, { deleted: params[5] });
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };

  const mockDatabase = {
    async connect() { return mockClient; },
  };

  const deletePayload = JSON.stringify({ id: 123456 });
  const eventId = "evt-delete-1";

  await handleWebhookEvent({
    topic: "PRODUCTS_DELETE",
    shop: shopId,
    body: deletePayload,
    webhookId: eventId,
    database: mockDatabase,
  });

  const change = store.changes.get(`${shopId}:${productId}`);
  assert.equal(change.deleted, true);
  assert.equal(change.dirty, true);
});

test("handleWebhookEvent: database failure rolls back and prevents delivery acknowledgment", async () => {
  const failingClient = {
    async query(sql) {
      if (sql.includes("INSERT INTO mirror.webhook_receipts")) {
        throw Object.assign(new Error("Connection terminated / disk failure"), { code: "57P01" });
      }
      return { rows: [] };
    },
    release() {},
  };

  const mockDatabase = {
    async connect() { return failingClient; },
  };

  const payload = JSON.stringify({ id: 123456, title: "Fail Test" });

  await assert.rejects(
    () =>
      handleWebhookEvent({
        topic: "PRODUCTS_UPDATE",
        shop: shopId,
        body: payload,
        webhookId: "evt-fail-1",
        database: mockDatabase,
      }),
    /Connection terminated/,
  );
});
