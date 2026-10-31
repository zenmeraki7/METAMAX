import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { writeFile, unlink } from "node:fs/promises";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  productFilterFields,
  canonicalFilterFields,
  installedFilterFields,
  filterOperators,
  filterOperand,
  getFieldLabel,
  getFieldType,
  isDynamicMetafieldId,
} from "../data/products.filters.js";

test("all 58 canonical fields from backend registry plus tags use backend operator IDs and exact operands", () => {
  assert.equal(productFilterFields.length, 58);
  assert.equal(canonicalFilterFields.length, 58);
  assert.equal(installedFilterFields.length, 28);
  assert.equal(
    filterOperators.text.some(([id]) => id === "ne"),
    false,
  );
  assert.equal(
    filterOperators.text.some(([id]) => id === "neq"),
    true,
  );
  assert.equal(filterOperators.list[0][0], "list_contains");
  assert.equal(
    filterOperand("number", "gt", "9007199254740993.01"),
    "9007199254740993.01",
  );
  assert.deepEqual(filterOperand("number", "between", "10.01,20.02"), [
    "10.01",
    "20.02",
  ]);
  assert.equal(filterOperand("boolean", "eq", "false"), false);
  assert.deepEqual(filterOperand("boolean", "in", "true, false"), [true, false]);
  assert.equal(filterOperand("list", "is_empty", ""), undefined);
  assert.equal(
    filterOperand("list", "list_contains", " leading,tag "),
    " leading,tag ",
  );
  assert.equal(
    filterOperators.boolean.some(([id]) => id === "in"),
    true,
  );
  assert.equal(
    filterOperators.boolean.some(([id]) => id === "not_in"),
    true,
  );
  assert.equal(isDynamicMetafieldId("product.metafield.customField01"), true);
  assert.equal(isDynamicMetafieldId("variant.metafield.customField02"), true);
  assert.equal(isDynamicMetafieldId("product.metafield.short"), false);
  assert.equal(
    getFieldLabel("product.metafield.customField01"),
    "Product Metafield (customField01)",
  );
  assert.equal(
    getFieldLabel("inventoryItem.unitCost"),
    "Unit cost",
  );
  assert.equal(
    getFieldType("inventoryItem.unitCost"),
    "number",
  );
});

const compiled = new URL(`./.toolbar-${process.pid}.mjs`, import.meta.url);
const output = await build({
  entryPoints: [
    new URL(
      "../components/products/ProductsToolbar.jsx",
      import.meta.url,
    ).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  ],
  bundle: true,
  write: false,
  format: "esm",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
});
await writeFile(compiled, output.outputFiles[0].text);
let Toolbar;
try {
  Toolbar = (await import(compiled.href)).default;
} finally {
  await unlink(compiled);
}

for (const [label, term, fieldId, operatorId, operand, chip] of [
  ["Vendor", "vend", "product.vendor", "neq", "North", "Vendor is not North"],
  [
    "Tag",
    "tag",
    "product.tags",
    "list_contains",
    "Summer",
    "Tag contains tag Summer",
  ],
  [
    "Tag",
    "tag",
    "product.tags",
    "list_not_contains",
    "Summer",
    "Tag does not contain tag Summer",
  ],
])
  test(`searchable ${label} picker applies ${operatorId} and removes it while preserving search and selection`, async () => {
    const dom = new JSDOM("<div id='root'></div>");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.getElementById("root"));
    let conditions = [],
      match = "all";
    const render = () =>
      root.render(
        React.createElement(Toolbar, {
          search: "shirt",
          setSearch() {},
          status: "ALL",
          setStatus() {},
          conditions,
          match,
          visibleColumns: [],
          toggleColumn() {},
          selectedCount: 2,
          clearSelection() {},
          hasProducts: true,
          setAllVisibleSelected() {},
          setAdvancedFilters(next, mode) {
            conditions = next;
            match = mode;
            render();
          },
        }),
      );
    try {
      await act(async () => render());
      const search = document.querySelector(
        's-search-field[placeholder="Start typing"]',
      );
      await act(async () => {
        search.value = term;
        search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.deepEqual(
        [...document.querySelectorAll(".products-field-option")].map(
          (item) => item.textContent,
        ),
        [label],
      );
      await act(async () =>
        document.querySelector(".products-field-option").click(),
      );
      const value = document.querySelector("s-text-field");
      const operator = document.querySelector('s-select[label="Condition"]');
      await act(async () => {
        operator.value = operatorId;
        operator.dispatchEvent(
          new dom.window.Event("change", { bubbles: true }),
        );
      });
      await act(async () => {
        value.value = operand;
        value.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await act(async () =>
        [...document.querySelectorAll("s-button")]
          .find((item) => item.textContent === "Apply filter")
          .click(),
      );
      assert.deepEqual(conditions, [
        { field: fieldId, operator: operatorId, value: operand },
      ]);
      assert.ok(document.body.textContent.includes(chip));
      assert.match(document.body.textContent, /2 selected on this page/);
      assert.ok(
        document.querySelector(
          's-search-field[placeholder="Search title, vendor, type or handle"]',
        ),
      );
      const matching = document.querySelector(
        's-select[label="Match filters"]',
      );
      await act(async () => {
        matching.value = "any";
        matching.dispatchEvent(
          new dom.window.Event("change", { bubbles: true }),
        );
      });
      assert.equal(match, "any");
      await act(async () =>
        document
          .querySelector("s-clickable-chip")
          .dispatchEvent(new dom.window.Event("remove")),
      );
      assert.deepEqual(conditions, []);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  });
