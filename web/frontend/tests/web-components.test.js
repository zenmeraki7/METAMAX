import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM("<!doctype html><div id='root'></div>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Model the properties and native events exposed by the CDN components.
class Select extends dom.window.HTMLElement {
  value = "ALL";
}
class Checkbox extends dom.window.HTMLElement {
  checked = false;
}
dom.window.customElements.define("s-select", Select);
dom.window.customElements.define("s-checkbox", Checkbox);

test("controlled web-component properties and change events stay in sync", async () => {
  const root = createRoot(document.getElementById("root"));
  let reset;
  function Harness() {
    const [status, setStatus] = useState("ACTIVE");
    const [selected, setSelected] = useState(true);
    reset = () => { setStatus("ALL"); setSelected(false); };
    return React.createElement("div", null,
      React.createElement("s-select", {
        value: status,
        onChange: (event) => setStatus(event.currentTarget.value),
      }),
      React.createElement("s-checkbox", {
        checked: selected,
        onChange: (event) => setSelected(event.currentTarget.checked),
      }),
      React.createElement("output", null, `${status}:${selected}`)
    );
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const select = document.querySelector("s-select");
    const checkbox = document.querySelector("s-checkbox");
    assert.equal(select.value, "ACTIVE");
    assert.equal(checkbox.checked, true);
    await act(async () => {
      select.value = "DRAFT";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      checkbox.checked = false;
      checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(document.querySelector("output").textContent, "DRAFT:false");
    await act(async () => reset());
    assert.equal(select.value, "ALL");
    assert.equal(checkbox.checked, false);
  } finally {
    await act(async () => root.unmount());
  }
});
