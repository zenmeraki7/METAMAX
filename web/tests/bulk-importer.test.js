import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ingestGroupedExport,
  downloadExport,
} from "../domains/sync/sync.importer.js";
const product = {
  id: "gid://shopify/Product/1",
  variantsCount: { count: 1, precision: "EXACT" },
};
const variant = {
  id: "gid://shopify/ProductVariant/1",
  __parentId: product.id,
  position: 1,
  price: "9007199254740993.123456",
  compareAtPrice: null,
};
const lines = (rows) =>
  rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row)));
const manifest = { rootObjectCount: "1", objectCount: "2" };

test("batched JSONL commits bounded complete product groups before acknowledging EOF", async () => {
  const rows = Array.from({ length: 205 }, (_, i) => {
    const root = { ...product, id: `gid://shopify/Product/${i + 1}` };
    return [
      root,
      {
        ...variant,
        id: `gid://shopify/ProductVariant/${i + 1}`,
        __parentId: root.id,
      },
    ];
  }).flat();
  const committed = [];
  const result = await ingestGroupedExport({
    name: "products",
    lines: lines(rows),
    manifest: { rootObjectCount: "205", objectCount: "410" },
    writeBatch: async (batch) => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(batch.every((item) => item.variants.length === 1));
      committed.push(batch.length);
    },
  });
  assert.deepEqual(committed, [100, 100, 5]);
  assert.equal(result.roots, 205);
});

test("batching preserves complete groups on a broken stream but never its unfinished root", async () => {
  const committed = [];
  const second = { ...product, id: "gid://shopify/Product/2" };
  await assert.rejects(
    ingestGroupedExport({
      name: "products",
      lines: (async function* () {
        for (const row of [product, variant, second]) yield JSON.stringify(row);
        throw Error("download disconnected");
      })(),
      manifest: { rootObjectCount: "2", objectCount: "4" },
      writeBatch: async (batch) => committed.push(...batch),
    }),
    /download disconnected/,
  );
  assert.equal(committed.length, 1);
  assert.equal(committed[0].product.id, product.id);
});

test("a rejected database batch cannot acknowledge completion or be silently retried", async () => {
  let attempts = 0;
  await assert.rejects(
    ingestGroupedExport({
      name: "products",
      lines: lines([product, variant]),
      manifest,
      writeBatch: async () => {
        attempts++;
        throw Error("batch rollback");
      },
    }),
    /batch rollback/,
  );
  assert.equal(attempts, 1);
});

test("large root payloads flush batches before accumulating multiple megabytes", async () => {
  const rows = Array.from({ length: 4 }, (_, i) => {
    const root = {
      ...product,
      id: `gid://shopify/Product/${i + 1}`,
      descriptionHtml: "x".repeat(1024 * 1024),
    };
    return [
      root,
      {
        ...variant,
        id: `gid://shopify/ProductVariant/${i + 1}`,
        __parentId: root.id,
      },
    ];
  }).flat();
  const sizes = [];
  await ingestGroupedExport({
    name: "products",
    lines: lines(rows),
    manifest: { rootObjectCount: "4", objectCount: "8" },
    writeBatch: async (batch) => sizes.push(batch.length),
  });
  assert.deepEqual(sizes, [1, 1, 1, 1]);
});

test("JSONL ingestion awaits validated product writes and preserves decimal money", async () => {
  let committed = false;
  const result = await ingestGroupedExport({
    name: "products",
    lines: lines([product, variant]),
    manifest,
    writeRoot: async (current) => {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(current.variants[0].price, variant.price);
      committed = true;
    },
  });
  assert.ok(committed);
  assert.equal(result.roots, 1);
  assert.equal(result.children, 1);
});
test("truncated, ungrouped, malformed, duplicate, and overlong variant sets fail closed", async () => {
  for (const rows of [
    [product],
    [variant, product],
    [product, "{"],
    [product, variant, variant],
    [product, { ...variant, __parentId: "gid://shopify/Product/2" }],
  ]) {
    await assert.rejects(
      ingestGroupedExport({
        name: "products",
        lines: lines(rows),
        manifest,
        writeRoot: async () => {},
      }),
    );
  }
});
test("a database write failure cannot produce ingestion completion", async () => {
  await assert.rejects(
    ingestGroupedExport({
      name: "products",
      lines: lines([product, variant]),
      manifest,
      writeRoot: async () => {
        throw Error("database unavailable");
      },
    }),
    /database unavailable/,
  );
});
test("empty exports accept only a verified zero manifest", async () => {
  const result = await ingestGroupedExport({
    name: "products",
    lines: [],
    manifest: { rootObjectCount: "0", objectCount: "0" },
    writeRoot: async () => assert.fail(),
  });
  assert.equal(result.roots, 0);
  await assert.rejects(
    ingestGroupedExport({
      name: "products",
      lines: [],
      manifest,
      writeRoot: async () => {},
    }),
    /Truncated/,
  );
});
test("export download rejects unsafe hosts before sending any request", async () => {
  for (const url of [
    "http://storage.googleapis.com/a",
    "https://example.com/a",
    "https://shopify.com.evil.test/a",
  ]) {
    await assert.rejects(async () => {
      for await (const line of downloadExport(url, {
        fetchImpl: async () => assert.fail("must not fetch"),
      }))
        void line;
    }, /Unexpected export download host/);
  }
});

test("signed export downloads stream split UTF-8/CRLF lines without authentication headers", async () => {
  const expected = lines([{ ...product, title: "Café" }, variant]);
  const encoded = new TextEncoder().encode(expected.join("\r\n") + "\r\n");
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < encoded.length; i += 7)
        controller.enqueue(encoded.slice(i, i + 7));
      controller.close();
    },
  });
  const received = [];
  for await (const line of downloadExport(
    "https://storage.googleapis.com/catalog/result.jsonl?signature=test",
    {
      fetchImpl: async (_url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(options.headers, undefined);
        return new Response(body);
      },
    },
  ))
    received.push(line);
  assert.deepEqual(received, expected);
});

test("a failed response stream cannot be accepted as a completed export", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.error(Error("connection reset"));
    },
  });
  await assert.rejects(async () => {
    for await (const line of downloadExport(
      "https://storage.googleapis.com/result",
      {
        fetchImpl: async () => new Response(body),
      },
    ))
      void line;
  }, /connection reset/);
});
