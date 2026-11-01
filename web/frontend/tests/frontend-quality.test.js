import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
const entry = new URL(`./.quality-${process.pid}.mjs`, import.meta.url);
const output = await build({
  stdin: {
    contents: `export { default as ProductsTable } from './components/products/ProductsTable.jsx'; export { default as ProductRow } from './components/products/ProductRow.jsx'; export { default as SyncSummary } from './components/settings/SyncSummary.jsx'; export { default as useSettingsDashboard } from './hooks/useSettingsDashboard.js'; export {default as HomeSearch} from './components/home/HomeHeroSearch.jsx'; export {default as ProductsPage} from './pages/ProductsPage.jsx'; export {default as useShopifyData} from './hooks/useShopifyData.js'; export {default as AutomationNotice} from './components/automations/AutomationNotice.jsx'; export {default as HistoryTabs} from './components/history/HistoryTabs.jsx'; export { default as HistoryDetailDialog } from './components/history/HistoryDetailDialog.jsx'; export { default as HistoryActionMenu } from './components/history/HistoryActionMenu.jsx'; export { default as SyncSourcesTable } from './components/settings/SyncSourcesTable.jsx';`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "jsx",
  },
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime", "react-router-dom"],
  loader: { ".css": "empty" },
  define: {
    "import.meta.env": JSON.stringify({ VITE_SYNC_DEMO_MODE: "false" }),
  },
});
await writeFile(entry, output.outputFiles[0].text);
let components;
try {
  components = await import(entry.href);
} finally {
  await unlink(entry);
}
const setup = () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  class Modal extends dom.window.HTMLElement {
    showOverlay() {}
    hideOverlay() {}
  }
  if (!dom.window.customElements.get('s-modal')) {
    dom.window.customElements.define('s-modal', Modal);
  }
  globalThis.customElements = dom.window.customElements;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { dom, root: createRoot(document.getElementById("root")) };
};

test("home search preserves its query when navigating to products", async () => {
  const { dom, root } = setup();
  let location;
  function Location() {
    location = useLocation();
    return null;
  }
  try {
    await act(async () =>
      root.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(components.HomeSearch),
          React.createElement(Location),
        ),
      ),
    );
    const input = document.querySelector("s-search-field");
    await act(async () => {
      input.value = "Blue shirt";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => document.querySelector("s-button").click());
    assert.equal(location.pathname, "/products");
    assert.equal(
      new URLSearchParams(location.search).get("search"),
      "Blue shirt",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("products initialize the catalog request from the search URL", async () => {
  const { dom, root } = setup(),
    original = globalThis.fetch;
  let requested;
  globalThis.fetch = (url) => {
    requested = url;
    return new Promise(() => {});
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/products?search=Blue+shirt"] },
          React.createElement(components.ProductsPage),
        ),
      ),
    );
    assert.equal(
      new URL(requested, "https://example.test").searchParams.get("search"),
      "Blue shirt",
    );
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    dom.window.close();
  }
});

test("native Polaris table pagination events, selection, unlisted status and admin links work", async () => {
  const { dom, root } = setup();
  let next = 0,
    previous = 0,
    selected;
  const props = {
    products: [
      {
        id: "gid://shopify/Product/1",
        title: "A very long product title",
        status: "UNLISTED",
        variantCount: 1,
      },
    ],
    visibleColumns: ["status"],
    selection: {
      selectedIds: new Set(),
      setOneSelected: (id, value) => (selected = [id, value]),
      setAllVisibleSelected() {},
    },
    onNext: () => next++,
    onPrevious: () => previous++,
    hasNextPage: true,
    hasPreviousPage: true,
    density: "compact",
  };
  try {
    await act(async () =>
      root.render(React.createElement(components.ProductsTable, props)),
    );
    const table = document.querySelector("s-table");
    await act(async () => {
      table.dispatchEvent(new dom.window.Event("nextpage"));
      table.dispatchEvent(new dom.window.Event("previouspage"));
    });
    assert.equal(next, 1);
    assert.equal(previous, 1);
    assert.match(document.body.textContent, /Unlisted/);
    assert.equal(
      document.querySelector("s-link").getAttribute("href"),
      "shopify://admin/products/1",
    );
    const checkbox = document.querySelector("s-table-body s-checkbox");
    await act(async () => {
      checkbox.checked = true;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.deepEqual(selected, ["gid://shopify/Product/1", true]);
    await act(async () =>
      root.render(
        React.createElement(components.ProductsTable, {
          ...props,
          loading: true,
        }),
      ),
    );
    await act(async () =>
      table.dispatchEvent(new dom.window.Event("nextpage")),
    );
    assert.equal(next, 1, "loading prevents pagination");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("ProductRow renders 'Not tracked' for untracked products and primary image thumbnail", async () => {
  const { dom, root } = setup();
  const trackedProduct = {
    id: "gid://shopify/Product/1",
    title: "Tracked Product",
    status: "ACTIVE",
    variantCount: 1,
    totalInventory: 0,
    tracksInventory: true,
    image: "https://cdn.shopify.com/shirt.png",
  };
  const untrackedProduct = {
    id: "gid://shopify/Product/2",
    title: "Untracked Product",
    status: "ACTIVE",
    variantCount: 1,
    totalInventory: 0,
    tracksInventory: false,
    image: null,
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(
          "s-table",
          null,
          React.createElement(
            "s-table-body",
            null,
            React.createElement(components.ProductRow, {
              product: trackedProduct,
              columns: [{ key: "inventory" }],
            }),
            React.createElement(components.ProductRow, {
              product: untrackedProduct,
              columns: [{ key: "inventory" }],
            }),
          ),
        ),
      ),
    );
    const thumbnails = document.querySelectorAll("s-thumbnail");
    assert.equal(thumbnails.length, 2);
    assert.equal(
      thumbnails[0].getAttribute("src"),
      "https://cdn.shopify.com/shirt.png",
    );
    assert.equal(thumbnails[1].getAttribute("src"), null);
    assert.equal(thumbnails[1].getAttribute("alt"), "No product image");

    assert.match(document.body.textContent, /Out of stock/);
    assert.match(document.body.textContent, /Not tracked/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("SyncSummary evaluates supported sources and dashboard reflects isUpToDate freshness", async () => {
  const { dom, root } = setup();
  const healthyOverview = {
    shopTimeZone: "UTC",
    isUpToDate: true,
    sources: [
      {
        id: "products",
        name: "Products & Variants",
        supported: true,
        status: "healthy",
        syncType: "automatic",
        lastFullSyncAt: "2026-10-01T01:02:03.000Z",
      },
      {
        id: "collections",
        name: "Collections",
        supported: false,
        status: "unavailable",
        syncType: "unavailable",
        lastFullSyncAt: null,
      },
      {
        id: "inventory",
        name: "Inventory Levels",
        supported: false,
        status: "unavailable",
        syncType: "unavailable",
        lastFullSyncAt: null,
      },
      {
        id: "metafields",
        name: "Metafield Definitions",
        supported: false,
        status: "unavailable",
        syncType: "unavailable",
        lastFullSyncAt: null,
      },
    ],
  };

  const unhealthyOverview = {
    ...healthyOverview,
    isUpToDate: false,
    sources: [
      {
        ...healthyOverview.sources[0],
        status: "failed",
      },
      ...healthyOverview.sources.slice(1),
    ],
  };

  try {
    // 1. Render SyncSummary with healthy supported source
    await act(async () =>
      root.render(
        React.createElement(components.SyncSummary, {
          overview: healthyOverview,
          loading: false,
        }),
      ),
    );
    assert.match(document.body.textContent, /All systems operational/);
    assert.ok(document.querySelector(".sd-tone--green"));

    // 2. Render SyncSummary with failed supported source
    await act(async () =>
      root.render(
        React.createElement(components.SyncSummary, {
          overview: unhealthyOverview,
          loading: false,
        }),
      ),
    );
    assert.match(document.body.textContent, /Needs attention/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("sync status shares overlapping requests and aborts on unmount", async () => {
  const { dom, root } = setup(),
    original = globalThis.fetch;
  const calls = [];
  let latest;
  globalThis.fetch = (url, options) =>
    new Promise((resolve) => calls.push({ url, options, resolve }));
  function Harness() {
    latest = components.useShopifyData();
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(calls.length, 1);
    let reload;
    await act(async () => {
      reload = latest.reload();
    });
    assert.equal(calls.length, 1);
    await act(async () => {
      calls[0].resolve({
        ok: true,
        json: async () => ({ shopTimeZone: "UTC", sources: [] }),
      });
      await reload;
    });
    assert.equal(latest.loading, false);
    await act(async () => root.unmount());
    assert.equal(calls[0].options.signal.aborted, true);
  } finally {
    globalThis.fetch = original;
    dom.window.close();
  }
});

test("automation banners handle the native dismiss event", async () => {
  const { dom, root } = setup();
  let dismissed = 0;
  try {
    await act(async () =>
      root.render(
        React.createElement(components.AutomationNotice, {
          onDismiss: () => dismissed++,
        }),
      ),
    );
    await act(async () =>
      document
        .querySelector("s-banner")
        .dispatchEvent(new dom.window.Event("dismiss")),
    );
    assert.equal(dismissed, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("history arrow navigation moves selection and keyboard focus together", async () => {
  const { dom, root } = setup();
  let active = "All",
    focused;
  function Harness() {
    const [value, setValue] = React.useState("All");
    active = value;
    return React.createElement(components.HistoryTabs, {
      active: value,
      onChange: setValue,
    });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    for (const button of document.querySelectorAll("s-button"))
      button.focus = () => {
        focused = button.textContent;
      };
    await act(async () =>
      document.querySelector('[role="tablist"]').dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
        }),
      ),
    );
    assert.equal(active, "Edit");
    assert.match(focused, /Edit/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("catalog contract errors show a working manual Try again action", async () => {
  const { dom, root } = setup(),
    original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = () => new Promise((resolve) => requests.push(resolve));
  try {
    await act(async () =>
      root.render(
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(components.ProductsPage),
        ),
      ),
    );
    await act(async () =>
      requests[0]({ ok: true, status: 200, json: async () => null }),
    );
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /response was incomplete/,
    );
    const retry = [...document.querySelectorAll("s-button")].find(
      (button) => button.textContent === "Try again",
    );
    assert.ok(retry);
    await act(async () => retry.click());
    assert.equal(requests.length, 2);
    await act(async () =>
      requests[1]({
        ok: true,
        status: 200,
        json: async () => ({
          snapshotId: "snapshot-1",
          publishedRevision: "revision-1",
          syncStatus: "READY",
          products: [
            { id: "gid://shopify/Product/1", title: "Recovered shirt" },
          ],
          summary: { productCount: 1, variantCount: 1, activeCount: 1 },
          filteredCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
        }),
      }),
    );
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(document.body.textContent, /Recovered shirt/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    dom.window.close();
  }
});


test("HistoryDetailDialog gates demo note on isDemo or operation.isDemo", async () => {
  const { dom, root } = setup();
  const liveOp = {
    id: "op-live-1",
    title: "Live bulk edit",
    type: "Edit",
    status: "Completed",
    processed: 100,
    total: 100,
    startedLabel: "Oct 31 at 12:00 PM",
    duration: "45s",
    user: "Merchant Admin",
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(components.HistoryDetailDialog, {
          operation: liveOp,
          isDemo: false,
          onClose: () => {},
        })
      )
    );
    assert.match(document.body.textContent, /Live bulk edit/);
    assert.doesNotMatch(document.body.textContent, /This is a demo record/);

    await act(async () =>
      root.render(
        React.createElement(components.HistoryDetailDialog, {
          operation: { ...liveOp, isDemo: true },
          isDemo: true,
          onClose: () => {},
        })
      )
    );
    assert.match(document.body.textContent, /This is a demo record/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("HistoryActionMenu hides Retry operation when operation is not retryable", async () => {
  const { dom, root } = setup();
  const unretryable = {
    id: "op-failed-1",
    title: "Failed job",
    status: "Failed",
  };
  let retried = false;
  try {
    await act(async () =>
      root.render(
        React.createElement(components.HistoryActionMenu, {
          item: unretryable,
          onRetry: () => { retried = true; },
        })
      )
    );
    const buttons = [...document.querySelectorAll("s-button")];
    assert.ok(!buttons.some((b) => b.textContent?.includes("Retry operation")));

    await act(async () =>
      root.render(
        React.createElement(components.HistoryActionMenu, {
          item: { ...unretryable, retryable: true },
          onRetry: () => { retried = true; },
        })
      )
    );
    const retryButton = [...document.querySelectorAll("s-button")].find(
      (b) => b.textContent?.includes("Retry operation")
    );
    assert.ok(retryButton);
    await act(async () => retryButton.click());
    assert.equal(retried, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("SyncSourcesTable displays 'Refresh catalog mirror' instead of 'Refresh all'", async () => {
  const { dom, root } = setup();
  let refreshedAll = false;
  try {
    await act(async () =>
      root.render(
        React.createElement(components.SyncSourcesTable, {
          sources: [{ id: "products", name: "Products", status: "healthy", syncType: "automatic" }],
          totalCount: 1,
          timeZone: "UTC",
          search: "",
          onSearchChange: () => {},
          loading: false,
          busyKeys: [],
          onRefreshSource: () => {},
          onRefreshAll: () => { refreshedAll = true; },
        })
      )
    );
    const buttons = [...document.querySelectorAll("s-button")];
    const refreshMirrorBtn = buttons.find((b) => b.textContent?.includes("Refresh catalog mirror"));
    assert.ok(refreshMirrorBtn, "Expected 'Refresh catalog mirror' button to exist");
    assert.ok(!buttons.some((b) => b.textContent === "Refresh all"), "Did not expect 'Refresh all' button");
    await act(async () => refreshMirrorBtn.click());
    assert.equal(refreshedAll, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
