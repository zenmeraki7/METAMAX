import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { streamLinesFromReadable, createJsonlIngestionService } from "./jsonl-ingestion.server.js";
import { readCompleteProduct, openBulkExport, createShopifyCatalogClient } from "./shopify-catalog-source.server.js";
import { product, variant } from "./integration/sync-hardening.js";

test("a supplied count cannot bypass remote status, identity, or count verification", async () => {
  const id = "gid://shopify/BulkOperation/1";
  for (const op of [
    { id, status: "FAILED", objectCount: "0" },
    { id, status: "RUNNING", objectCount: "0" },
    { id: "gid://shopify/BulkOperation/2", status: "COMPLETED", objectCount: "0" },
    { id, status: "COMPLETED", objectCount: "100" },
    { id, status: "COMPLETED", objectCount: 9007199254740992 },
  ]) {
    let reads = 0, failed = false;
    const service = createJsonlIngestionService({ database: { connect() { assert.fail("Unverified source reached SQL"); } },
      ingestionWriter: {}, bulkSyncService: { getStatus: async () => { reads++; return op; } },
      syncRunService: { getSyncRun: async () => ({ generationId: "generation", status: "RUNNING", fence: 1, bulkOperationId: id }),
        failIngestionRun: async () => { failed = true; } } });
    await assert.rejects(() => service.ingestJsonlLines({ shopId: "source.myshopify.com", generationId: "generation", runId: 1, fence: 1, lines: [], expectedLines: 0 }));
    assert.equal(reads, 1);
    assert.equal(failed, true);
  }
});

test("a count alone cannot authorize an import without a source reader", async () => {
  const service = createJsonlIngestionService({ database: {}, ingestionWriter: {}, syncRunService: {
    getSyncRun: async () => ({ generationId: "g", status: "RUNNING", fence: 1, bulkOperationId: "gid://shopify/BulkOperation/1" }),
  } });
  await assert.rejects(() => service.ingestJsonlLines({ shopId: "source.myshopify.com", generationId: "g", runId: 1, fence: 1, lines: [], expectedLines: 0 }), /reader required/);
});

test("unterminated oversized lines stop consuming the source at the byte limit", async () => {
  let consumed = 0, closed = false;
  async function* bytes() {
    try { for (let i = 0; i < 10000; i++) { consumed++; yield Buffer.alloc(16, 65); } }
    finally { closed = true; }
  }
  await assert.rejects(async () => { for await (const _line of streamLinesFromReadable(bytes(), { maxLineBytes: 32 })) {} }, /Bounded JSONL/);
  assert.equal(consumed, 3);
  assert.equal(closed, true);
});

test("chunk boundaries preserve UTF-8, CRLF, empty lines and a final unterminated line", async () => {
  const bytes = Buffer.from('é\r\n\r\n猫\nlast');
  const lines = [];
  for await (const line of streamLinesFromReadable(Readable.from([...bytes].map(byte => Buffer.from([byte]))), { maxLineBytes: 8 })) lines.push(line);
  assert.deepEqual(lines, ["é", "猫", "last"]);
});

test("oversized lines in one chunk and invalid UTF-8 fail closed", async () => {
  for (const bytes of [Buffer.from("12345\n"), Buffer.from([0xff,10])]) {
    await assert.rejects(async () => { for await (const _line of streamLinesFromReadable(Readable.from([bytes]), { maxLineBytes: 4 })) {} });
  }
});

test("authoritative product rereads drain variants and reject partial or unstable pages", async () => {
  const p = product(1), calls = [];
  const { variants: _variants, ...scalars } = p;
  const client = { request: async (_query, { variables }) => {
    calls.push(variables.after);
    return { data: { product: { ...scalars, variants: { nodes: [variant(calls.length)],
      pageInfo: { hasNextPage: calls.length === 1, endCursor: "second" } } } } };
  } };
  const snapshot = await readCompleteProduct({ client, productId: p.id });
  assert.deepEqual(calls, [null, "second"]);
  assert.equal(snapshot.product.variants.length, 2);
  for (const response of [{ errors: ["denied"] }, { data: {} }, { data: { product: { ...scalars, variants: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }]) {
    await assert.rejects(() => readCompleteProduct({ client: { request: async () => response }, productId: p.id }));
  }
  assert.deepEqual(await readCompleteProduct({ client: { request: async () => ({ data: { product: null } }) }, productId: p.id }), { complete: true, product: null });
  let n = 0;
  await assert.rejects(() => readCompleteProduct({ productId: p.id, client: { request: async () => ({ data: { product: {
    ...scalars, title: String(++n), variants: { nodes: [variant(n)], pageInfo: { hasNextPage: true, endCursor: String(n) } },
  } } }) } }), /changed during/);
});

test("export downloads reject non-complete, private and redirected sources", async () => {
  for (const op of [{ status: "FAILED", objectCount: "0" }, { status: "COMPLETED", objectCount: "1", url: "http://127.0.0.1/private" },
    { status: "COMPLETED", objectCount: "1", url: "https://example.com/data" }]) {
    await assert.rejects(() => openBulkExport(op, { fetchImpl() { assert.fail("Untrusted download"); } }));
  }
  assert.deepEqual(await openBulkExport({ status: "COMPLETED", objectCount: "0", url: null }), []);
  let options;
  const body = Readable.from(["data"]);
  assert.strictEqual(await openBulkExport({ status: "COMPLETED", objectCount: "1", url: "https://storage.googleapis.com/export" }, {
    fetchImpl: async (_url, input) => { options = input; return { ok: true, body }; },
  }), body);
  assert.equal(options.redirect, "error");
});

test("shop-bound Shopify clients reject stale installations and online-only credentials", async () => {
  const session = { shop: "source.myshopify.com", accessToken: "test", scope: "read_products", isOnline: true };
  const shopify = { config: { sessionStorage: { findSessionsByShop: async () => [session] } }, api: { clients: { Graphql: class { request() { assert.fail("Unauthorized network call"); } } } } };
  for (const rowCount of [0,1]) {
    const client = createShopifyCatalogClient({ shopify, shopId: session.shop, installationVersion: "install", database: { query: async () => ({ rowCount }) } });
    await assert.rejects(() => client.request("query { shop { id } }"));
  }
});
