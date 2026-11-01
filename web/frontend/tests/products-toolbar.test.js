import {getFieldCapability} from '../../fields/capabilities.js';
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
  assert.deepEqual(filterOperand("number", "between", "15, 15"), [
    "15",
    "15",
  ]);
  assert.throws(
    () => filterOperand("number", "between", "10.01"),
    /exactly two comma-separated values/
  );
  assert.throws(
    () => filterOperand("number", "between", "10.01, 20.02, 30.03"),
    /exactly two comma-separated values/
  );
  assert.throws(
    () => filterOperand("number", "between", "10.01,"),
    /Both range boundaries must be provided/
  );
  assert.throws(
    () => filterOperand("number", "between", "20.02, 10.01"),
    /lower range boundary must be less than or equal/
  );
  assert.throws(
    () => filterOperand("date", "between", "2026-10-31, 2026-10-01"),
    /start date must be earlier than or equal/
  );
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
    "money",
  );
  assert.equal(
    getFieldType("variant.inventoryPolicy"),
    "enum",
  );
  assert.equal(filterOperand("enum", "eq", "deny","variant.inventoryPolicy"), "DENY");
  assert.equal(filterOperand("enum", "eq", "continue","variant.inventoryPolicy"), "CONTINUE");
  assert.deepEqual(filterOperand("enum", "in", "deny, continue","variant.inventoryPolicy"), ["DENY", "CONTINUE"]);
  assert.throws(
    () => filterOperand("boolean", "is_empty", ""),
    /incompatible/,
  );
  assert.throws(
    () => filterOperand("number", "is_empty", ""),
    /incompatible/,
  );
  assert.throws(
    () => filterOperand("enum", "is_not_empty", ""),
    /incompatible/,
  );
});

test('boolean operands reject unknown tokens rather than silently broadening targeting',()=>{
  assert.equal(filterOperand('boolean','eq',' True '),true);
  assert.deepEqual(filterOperand('boolean','in','True, FALSE'),[true,false]);
  for(const value of ['typo','1','0','true,','true, typo',',false'])assert.throws(()=>filterOperand('boolean','in',value),/true or false/);
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

test('production picker ignores tag globals and never invents dynamic metafield bindings',async()=>{
  const dom=new JSDOM('<div id="root"></div>');globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;window.__TAGS_VERIFIED__=true;
  const root=createRoot(document.getElementById('root'));
  const props={search:'',setSearch(){},status:'ALL',setStatus(){},visibleColumns:[],toggleColumn(){},setAdvancedFilters(){}};
  try {
    await act(async()=>root.render(React.createElement(Toolbar,props)));assert.equal(document.querySelectorAll('.products-field-option').length,0);
    const search=document.querySelector('s-search-field[placeholder="Start typing"]');
    await act(async()=>{search.value='product.metafield.customField01';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    assert.equal(document.querySelectorAll('.products-field-option').length,0);assert.doesNotMatch(document.body.textContent,/Add metafield/);
    await act(async()=>{search.value='';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    await act(async()=>root.render(React.createElement(Toolbar,{...props,capabilities:[{id:'product.tags',operators:['list_not_contains']}]})));
    assert.deepEqual([...document.querySelectorAll('.products-field-option')].map(row=>row.textContent),['Tag']);
    await act(async()=>document.querySelector('.products-field-option').click());
    assert.deepEqual([...document.querySelectorAll('s-select[label="Condition"] s-option')].map(row=>row.getAttribute('value')),['list_not_contains']);
  }finally{await act(async()=>root.unmount());dom.window.close();}
});
test('invalid boolean list is visible and cannot be applied even if the button is invoked',async()=>{
  const dom=new JSDOM('<div id="root"></div>');globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const root=createRoot(document.getElementById('root'));let conditions=[];
  try {
    await act(async()=>root.render(React.createElement(Toolbar,{search:'',setSearch(){},status:'ALL',setStatus(){},visibleColumns:[],toggleColumn(){},
      capabilities:[{id:'variant.taxable',operators:['eq','in']}],setAdvancedFilters:value=>{conditions=value;}})));
    await act(async()=>document.querySelector('.products-field-option').click());
    const operator=document.querySelector('s-select[label="Condition"]');
    await act(async()=>{operator.value='in';operator.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
    const input=document.querySelector('s-text-field[label="Value"]');
    const apply=[...document.querySelectorAll('s-button')].find(button=>button.textContent==='Apply filter');
    await act(async()=>{input.value='true, typo';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    assert.match(document.querySelector('s-banner').textContent,/true or false/);await act(async()=>apply.click());assert.deepEqual(conditions,[]);
    await act(async()=>{input.value='TRUE, false';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    await act(async()=>apply.click());assert.deepEqual(conditions[0].value,[true,false]);
  }finally{await act(async()=>root.unmount());dom.window.close();}
});

test('boolean filter defaults value to true without requiring manual select interaction', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let conditions = [];
  try {
    await act(async () =>
      root.render(
        React.createElement(Toolbar, {
          search: '',
          setSearch() {},
          status: 'ALL',
          setStatus() {},
          visibleColumns: [],
          toggleColumn() {},
          capabilities: [{ id: 'variant.taxable', operators: ['eq'] }],
          setAdvancedFilters: (value) => {
            conditions = value;
          },
        }),
      ),
    );
    await act(async () => document.querySelector('.products-field-option').click());
    const apply = [...document.querySelectorAll('s-button')].find(
      (b) => b.textContent === 'Apply filter',
    );
    assert.equal(apply.hasAttribute('disabled'), false, 'Apply filter must be enabled immediately for boolean field');
    await act(async () => apply.click());
    assert.deepEqual(conditions, [{ field: 'variant.taxable', operator: 'eq', value: true }]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test('variant.inventoryPolicy renders dropdown with DENY and CONTINUE options and applies selected enum', async () => {
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let conditions = [];
  try {
    await act(async () =>
      root.render(
        React.createElement(Toolbar, {
          search: '',
          setSearch() {},
          status: 'ALL',
          setStatus() {},
          visibleColumns: [],
          toggleColumn() {},
          capabilities: [getFieldCapability('variant.inventoryPolicy',{bindingOperators:['eq']})],
          setAdvancedFilters: (value) => {
            conditions = value;
          },
        }),
      ),
    );
    await act(async () => document.querySelector('.products-field-option').click());
    const valueSelect = document.querySelector('s-select[label="Value"]');
    assert.ok(valueSelect, 'Inventory policy must render a select dropdown');
    const options = [...valueSelect.querySelectorAll('s-option')].map((opt) => opt.getAttribute('value'));
    assert.deepEqual(options, ['DENY', 'CONTINUE']);

    const apply = [...document.querySelectorAll('s-button')].find(
      (b) => b.textContent === 'Apply filter',
    );
    assert.equal(apply.hasAttribute('disabled'), false, 'Apply filter must be enabled for enum field');
    await act(async () => apply.click());
    assert.deepEqual(conditions, [{ field: 'variant.inventoryPolicy', operator: 'eq', value: 'DENY' }]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

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
          capabilities: installedFilterFields.map(([id,,type])=>getFieldCapability(id,{bindingOperators:filterOperators[type].map(([op])=>op)})),
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

test('mixed product and variant filters cannot request Match any or be added to an any group', async()=>{
  const dom=new JSDOM('<div id="root"></div>');globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
  const root=createRoot(document.getElementById('root'));let calls=[];
  const product={field:'product.vendor',operator:'eq',value:'Acme'},variant={field:'variant.price',operator:'gt',value:'10'};
  const render=(conditions,match)=>root.render(React.createElement(Toolbar,{search:'',setSearch(){},status:'ALL',setStatus(){},visibleColumns:[],toggleColumn(){},conditions,match,
    capabilities:[{id:'variant.price',operators:['gt']}],setAdvancedFilters:(...args)=>calls.push(args)}));
  try {
    await act(async()=>render([product,variant],'all'));
    const select=document.querySelector('s-select[label="Match filters"]');
    await act(async()=>{select.value='any';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
    assert.deepEqual(calls,[]);assert.equal(select.value,'all');assert.match(document.body.textContent,/Use Match all/);
    await act(async()=>render([product],'any'));
    await act(async()=>document.querySelector('.products-field-option').click());
    const input=document.querySelector('s-text-field[label="Value"]');
    await act(async()=>{input.value='10';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});
    await act(async()=>[...document.querySelectorAll('s-button')].find(x=>x.textContent==='Apply filter').click());
    assert.deepEqual(calls,[]);assert.match(document.body.textContent,/Use Match all/);
    await act(async()=>render([variant],'any'));
    await act(async()=>[...document.querySelectorAll('s-button')].find(x=>x.textContent==='Apply filter').click());
    assert.equal(calls.length,1);assert.equal(calls[0][1],'any');assert.equal(calls[0][0].length,2);
  }finally{await act(async()=>root.unmount());dom.window.close();}
});