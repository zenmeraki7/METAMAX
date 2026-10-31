import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import useProductCatalog from "../hooks/useProductCatalog.js";
import { catalogNotice } from "../data/products.sync.js";
import { retainCatalogData } from "../services/products.api.js";

const dom = new JSDOM("<!doctype html><div id='root'></div>", {
  url: "https://app.example.test/products",
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root, latest, calls;
let visibility = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => visibility,
});
const originalFetch = globalThis.fetch;
const payload = (overrides = {}) => ({
  snapshotId: "snapshot-1",
  publishedRevision: "revision-1",
  syncStatus: "READY",
  products: [{ id: "gid://shopify/Product/1", title: "Real shirt" }],
  summary: { productCount: 1, variantCount: 1, activeCount: 1 },
  filteredCount: 1,
  pageInfo: { hasNextPage: false, endCursor: null },
  ...overrides,
});
function Harness() {
  latest = useProductCatalog();
  return React.createElement(
    "div",
    null,
    latest.error ?? latest.data?.products[0]?.title ?? "Loading",
  );
}
beforeEach(async () => {
  calls = [];
  visibility = "visible";
  latest = null;
  globalThis.fetch = (url, options) =>
    new Promise((resolve, reject) =>
      calls.push({ url, options, resolve, reject }),
    );
  root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(Harness)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
});
async function respond(index, data = payload(), status = 200) {
  await act(async () =>
    calls[index].resolve({ ok: status < 400, status, json: async () => data }),
  );
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("initial unpublished coverage waits and polls without a generic product error", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  await respond(0,{error:"FILTER_COVERAGE_UNAVAILABLE",retryable:true},503);
  assert.equal(latest.error,null);assert.equal(latest.awaitingInitialSync,true);
  assert.equal(latest.data,null);
  await act(async()=>t.mock.timers.tick(5000));
  assert.equal(calls.length,2);assert.match(calls[1].url,/\/api\/mirror\/products/);
  await respond(1,payload());
  assert.equal(latest.awaitingInitialSync,false);assert.equal(latest.data.products[0].title,"Real shirt");
});

test("the page requests the authenticated catalog and exposes real results without a demo fallback", async () => {
  assert.match(calls[0].url, /^\/api\/mirror\/products\?/);
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(latest.loading, true);
  await respond(0);
  assert.equal(latest.data.products[0].title, "Real shirt");
  assert.equal(latest.loading, false);
  await act(async () => {
    await wait(330);
  });
  assert.equal(
    calls.length,
    1,
    "initial debounce must not duplicate the first request",
  );
});
test("search aborts old requests immediately and ignores a late old response", async () => {
  await act(async () => latest.setSearch("new shirt"));
  assert.equal(calls[0].options.signal.aborted, true);
  await respond(
    0,
    payload({ products: [{ id: "old", title: "Old response" }] }),
  );
  assert.equal(latest.data, null);
  await act(async () => {
    await wait(330);
  });
  assert.equal(calls.length, 2);
  assert.equal(
    new URL(calls[1].url, window.location.origin).searchParams.get("search"),
    "new shirt",
  );
  await respond(1, payload({ products: [{ id: "new", title: "New shirt" }] }));
  assert.equal(latest.data.products[0].title, "New shirt");
});
test("pagination sends the server cursor and changing status restarts at the first page", async () => {
  await respond(
    0,
    payload({ pageInfo: { hasNextPage: true, endCursor: "next-cursor" } }),
  );
  await act(async () => latest.nextPage());
  assert.equal(
    new URL(calls[1].url, window.location.origin).searchParams.get("cursor"),
    "next-cursor",
  );
  await respond(1);
  assert.equal(latest.page, 2);
  await act(async () => latest.setStatus("Draft"));
  const url = new URL(calls[2].url, window.location.origin);
  assert.equal(url.searchParams.get("status"), "DRAFT");
  assert.equal(url.searchParams.has("cursor"), false);
  assert.equal(latest.page, 1);
});
test("publication invalidates the old cursor and reloads a fresh first page", async () => {
  await respond(
    0,
    payload({ pageInfo: { hasNextPage: true, endCursor: "old-cursor" } }),
  );
  await act(async () => latest.nextPage());
  await respond(1, { error: "CATALOG_SNAPSHOT_CHANGED" }, 409);
  assert.equal(latest.page, 1);
  assert.equal(
    new URL(calls[2].url, window.location.origin).searchParams.has("cursor"),
    false,
  );
  await respond(2, payload({ snapshotId: "snapshot-2" }));
  assert.equal(latest.data.snapshotId, "snapshot-2");
});
test("failed requests show an error and Retry fetches real data", async () => {
  await respond(0, { error: "DATABASE_UNAVAILABLE" }, 503);
  assert.ok(latest.error);
  assert.equal(latest.data, null);
  await act(async () => latest.reload());
  await respond(1);
  assert.equal(latest.error, null);
  assert.equal(latest.data.products[0].title, "Real shirt");
});
test("initial import polls serially until a published catalog is ready", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(
    0,
    payload({ snapshotId: null, syncStatus: "INGESTING", products: [] }),
  );
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(calls.length, 2);
  await act(async () => t.mock.timers.tick(10000));
  assert.equal(
    calls.length,
    2,
    "a pending poll must not overlap another request",
  );
  await respond(1);
  assert.match(calls[1].url, /\/api\/mirror\/status$/);
  await respond(2);
  assert.equal(latest.data.syncStatus, "READY");
  assert.equal(latest.data.products[0].title, "Real shirt");
});

test("reconciliation stays unpublished until READY, then polls webhook changes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(
    0,
    payload({ snapshotId: null, syncStatus: "RECONCILING", products: [] }),
  );
  assert.equal(latest.data.products.length, 0);
  assert.match(
    catalogNotice(latest.data.syncStatus, false).message,
    /Applying changes received during import/,
  );
  await act(async () => t.mock.timers.tick(5000));
  await respond(1);
  await respond(2);
  assert.match(
    catalogNotice(latest.data.syncStatus, true).message,
    /Catalog ready/,
  );
  await act(async () => t.mock.timers.tick(30000));
  await respond(3, {
    snapshotId: "snapshot-1",
    publishedRevision: "revision-2",
    syncStatus: "READY",
  });
  await respond(
    4,
    payload({
      publishedRevision: "revision-2",
      products: [
        { id: "gid://shopify/Product/1", title: "Updated by webhook" },
      ],
    }),
  );
  assert.equal(latest.data.products[0].title, "Updated by webhook");
});

test("temporary outages retain products and recover with serial bounded backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  await act(async () => t.mock.timers.tick(30000));
  await respond(1, { error: "DATABASE_UNAVAILABLE" }, 503);
  assert.equal(latest.data.products[0].title, "Real shirt");
  assert.ok(latest.error);
  for (const [index, delay] of [
    [2, 5000],
    [3, 10000],
    [4, 20000],
    [5, 30000],
  ]) {
    await act(async () => t.mock.timers.tick(delay - 1));
    assert.equal(calls.length, index);
    await act(async () => t.mock.timers.tick(1));
    assert.equal(calls.length, index + 1);
    await act(async () => t.mock.timers.tick(60000));
    assert.equal(calls.length, index + 1, "pending retries must not overlap");
    if (index < 5) await respond(index, null, 503);
  }
  await respond(5);
  assert.equal(latest.error, null);
  await act(async () => t.mock.timers.tick(30000));
  await respond(6, null, 503);
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(calls.length, 8, "successful responses reset the backoff");
});

test("authentication failures do not automatically retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0, { error: "AUTHENTICATED_SHOP_REQUIRED" }, 401);
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 1);
  assert.ok(latest.error);
});

test("leaving the page cancels a scheduled recovery request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0, null, 503);
  await act(async () => root.render(null));
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 1);
});

test("catalog notices distinguish export, failure, and published readiness", () => {
  assert.match(
    catalogNotice("WAITING", false).message,
    /preparing your catalog export/,
  );
  assert.match(catalogNotice("FAILED", true).message, /last published catalog/);
  assert.equal(catalogNotice("FAILED", false).failed, true);
  assert.doesNotMatch(catalogNotice("READY", false).message, /Catalog ready/);
  assert.equal(catalogNotice(undefined, false), null);
});

test("advanced filter changes abort stale requests, reset pages and serialize match mode", async () => {
  await respond(
    0,
    payload({ pageInfo: { hasNextPage: true, endCursor: "page-2" } }),
  );
  await act(async () => latest.nextPage());
  const previous = calls.at(-1);
  const conditions = [
    { field: "product.vendor", operator: "eq", value: "North" },
  ];
  await act(async () => latest.setAdvancedFilters(conditions, "any"));
  assert.equal(previous.options.signal.aborted, true);
  assert.equal(latest.page, 1);
  const params = new URL(calls.at(-1).url, "https://example.test").searchParams;
  assert.deepEqual(JSON.parse(params.get("filters")), conditions);
  assert.equal(params.get("match"), "any");
  assert.equal(params.has("cursor"), false);
  await act(async () => latest.setAdvancedFilters([], "all"));
  assert.equal(
    new URL(calls.at(-1).url, "https://example.test").searchParams.has(
      "filters",
    ),
    false,
  );
});

test("background catalog polling keeps current rows interactive", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  await act(async () => t.mock.timers.tick(30000));
  assert.equal(calls.length, 2);
  assert.equal(latest.loading, false);
  assert.equal(latest.data.products[0].title, "Real shirt");
  await respond(1);
});

test("unchanged status polls retain catalog identity and never download rows again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  const original = latest.data;
  for (let index = 1; index <= 3; index++) {
    await act(async () => t.mock.timers.tick(30000));
    assert.equal(calls[index].url, "/api/mirror/status");
    await respond(index, {
      snapshotId: "snapshot-1",
      publishedRevision: "revision-1",
      syncStatus: "READY",
    });
    assert.equal(latest.data, original);
  }
  assert.equal(
    calls.filter((call) => call.url.startsWith("/api/mirror/products?")).length,
    1,
  );
});

test("a changed published revision refetches rows serially even within the same snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  await act(async () => t.mock.timers.tick(30000));
  await respond(1, {
    snapshotId: "snapshot-1",
    publishedRevision: "revision-2",
    syncStatus: "READY",
  });
  assert.match(calls[2].url, /^\/api\/mirror\/products\?/);
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 3, "row refresh must finish before another poll");
  await respond(
    2,
    payload({
      publishedRevision: "revision-2",
      products: [{ id: "gid://shopify/Product/1", title: "Changed" }],
    }),
  );
  assert.equal(latest.data.products[0].title, "Changed");
});

test("sync-status-only changes preserve product references", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  const products = latest.data.products;
  await act(async () => t.mock.timers.tick(30000));
  await respond(1, {
    snapshotId: "snapshot-1",
    publishedRevision: "revision-1",
    syncStatus: "INGESTING",
  });
  assert.equal(calls.length, 2);
  assert.equal(latest.data.products, products);
  assert.equal(latest.data.syncStatus, "INGESTING");
});

test("manual refresh retains unchanged response and product identities", async () => {
  await respond(0);
  const original = latest.data;
  await act(async () => latest.reload());
  await respond(1);
  assert.equal(latest.data, original);
  const changed = retainCatalogData(original, {
    ...original,
    lastSyncedAt: "2026-10-27T01:00:00Z",
  });
  assert.equal(changed.products, original.products);
});

test("hidden pages pause requests and check status immediately when visible", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  await act(async () => {
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 1);
  await act(async () => {
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  assert.equal(calls[1].url, "/api/mirror/status");
  await respond(1);
});

test("hiding cancels an in-flight status request and ignores its late result", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  const original = latest.data;
  await act(async () => t.mock.timers.tick(30000));
  await act(async () => {
    visibility = "hidden";
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  assert.equal(calls[1].options.signal.aborted, true);
  await act(async () => {
    visibility = "visible";
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  assert.equal(calls.length, 2, "wait for the canceled request to settle");
  await respond(1, {
    snapshotId: "obsolete",
    publishedRevision: "obsolete",
    syncStatus: "READY",
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, "/api/mirror/status");
  assert.equal(latest.data, original);
  await respond(2);
});

test("unsupported status polling stops automatic work without falling back to full requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  const original = latest.data;
  await act(async () => t.mock.timers.tick(30000));
  await respond(1, { error: "API_NOT_IMPLEMENTED" }, 404);
  assert.equal(latest.autoRefreshAvailable, false);
  assert.equal(latest.error, null);
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 2);
  assert.equal(latest.data, original);
  await act(async () => latest.reload());
  assert.match(calls[2].url, /^\/api\/mirror\/products\?/);
  await respond(2);
});

test("a backend without a shared revision token cannot enable automatic row polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0, payload({ publishedRevision: undefined }));
  await act(async () => t.mock.timers.tick(30000));
  await respond(1);
  assert.equal(latest.autoRefreshAvailable, false);
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 2);
});

test("a new snapshot restarts pagination before fetching its rows", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(
    0,
    payload({ pageInfo: { hasNextPage: true, endCursor: "old-page" } }),
  );
  await act(async () => latest.nextPage());
  await respond(1);
  await act(async () => t.mock.timers.tick(30000));
  await respond(2, {
    snapshotId: "snapshot-2",
    publishedRevision: "revision-2",
    syncStatus: "READY",
  });
  assert.equal(latest.page, 1);
  assert.equal(
    new URL(calls[3].url, window.location.origin).searchParams.has("cursor"),
    false,
  );
  await respond(
    3,
    payload({ snapshotId: "snapshot-2", publishedRevision: "revision-2" }),
  );
});

for (const [name, malformed] of [
  ["null body", null],
  ["missing fields", {}],
  ["invalid product row", payload({ products: [null] })],
  ["invalid summary", payload({ summary: {} })],
  ["invalid count", payload({ filteredCount: "1" })],
  [
    "missing next cursor",
    payload({ pageInfo: { hasNextPage: true, endCursor: "" } }),
  ],
])
  test(`invalid successful catalog response (${name}) stops retries and permits manual recovery`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await respond(0, malformed);
    assert.match(latest.error, /response was incomplete/);
    assert.equal(latest.loading, false);
    await act(async () => t.mock.timers.tick(120000));
    await act(async () =>
      document.dispatchEvent(new window.Event("visibilitychange")),
    );
    assert.equal(
      calls.length,
      1,
      "contract failures must not retry on timers or visibility",
    );
    await act(async () => latest.reload());
    await respond(1);
    assert.equal(latest.error, null);
    assert.equal(latest.data.products[0].title, "Real shirt");
  });

test("HTTP 200 invalid JSON stops retries and remains manually recoverable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await act(async () =>
    calls[0].resolve({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    }),
  );
  assert.match(latest.error, /invalid JSON/);
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 1);
  await act(async () => latest.reload());
  await respond(1);
  assert.equal(latest.error, null);
});

test("invalid background row refresh preserves valid rows and stops all automatic retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  const original = latest.data;
  await act(async () => t.mock.timers.tick(30000));
  await respond(1, {
    snapshotId: "snapshot-1",
    publishedRevision: "revision-2",
    syncStatus: "READY",
  });
  await respond(2, { products: "invalid" });
  assert.equal(latest.data, original);
  assert.match(latest.error, /response was incomplete/);
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 3);
  await act(async () => latest.reload());
  await respond(3, payload({ publishedRevision: "revision-2" }));
  assert.equal(latest.error, null);
});

test("invalid status schema exposes an error and retains valid rows without retrying", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await respond(0);
  const original = latest.data;
  await act(async () => t.mock.timers.tick(30000));
  await respond(1, { syncStatus: "READY" });
  assert.match(latest.error, /valid published revision/);
  assert.equal(latest.data, original);
  await act(async () => t.mock.timers.tick(120000));
  assert.equal(calls.length, 2);
});

test("network transport failures retain automatic retry eligibility", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await act(async () => calls[0].reject(new TypeError("Failed to fetch")));
  assert.ok(latest.error);
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(calls.length, 2);
  await respond(1);
  assert.equal(latest.error, null);
});

test("invalid error bodies do not hide retryable HTTP 503 status", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await act(async () =>
    calls[0].resolve({
      ok: false,
      status: 503,
      json: async () => {
        throw new SyntaxError("Not JSON");
      },
    }),
  );
  await act(async () => t.mock.timers.tick(5000));
  assert.equal(calls.length, 2);
  await respond(1);
  assert.equal(latest.error, null);
});
