import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import useModalOverlay from "../hooks/useModalOverlay.js";

const dom = new JSDOM("<!doctype html><div id='root'></div>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.customElements = dom.window.customElements;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class Modal extends dom.window.HTMLElement {
  shows = 0;
  hides = 0;
  showOverlay() {
    this.shows++;
    this.dispatchEvent(new dom.window.Event("show"));
  }
  hideOverlay() {
    this.hides++;
    this.dispatchEvent(new dom.window.Event("hide"));
  }
}
customElements.define("s-modal", Modal);

let root, setSelection, modal, cleanups;
function Harness() {
  const [selection, set] = useState(null);
  setSelection = set;
  const ref = useRef(null);
  useModalOverlay(ref, Boolean(selection), () => {
    cleanups++;
    set(null);
  });
  return React.createElement("s-modal", { ref }, selection?.title);
}
beforeEach(async () => {
  cleanups = 0;
  root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(Harness)));
  modal = document.querySelector("s-modal");
});
afterEach(async () => {
  await act(async () => root.unmount());
});

test("open and parent-driven close use the overlay methods", async () => {
  assert.equal(modal.shows, 0);
  assert.equal(modal.hides, 0);
  await act(async () => setSelection({ title: "First" }));
  assert.equal(modal.shows, 1);
  await act(async () => setSelection(null));
  assert.equal(modal.hides, 1);
  assert.equal(cleanups, 1);
});

test("native dismissal cleans up once without a second hide request", async () => {
  await act(async () => setSelection({ title: "First" }));
  await act(async () => modal.hideOverlay()); // Native --hide, Escape, or close control.
  assert.equal(modal.hides, 1);
  assert.equal(cleanups, 1);
  assert.equal(modal.textContent, "");
  await act(async () => setSelection({ title: "Reopened" }));
  assert.equal(modal.shows, 2);
});

test("changing the selected content keeps the existing overlay open", async () => {
  await act(async () => setSelection({ title: "Templates" }));
  await act(async () => setSelection({ title: "Selected template" }));
  assert.equal(modal.shows, 1);
  assert.equal(modal.hides, 0);
  assert.equal(modal.textContent, "Selected template");
});

test("unmount removes dismissal listeners", async () => {
  await act(async () => setSelection({ title: "First" }));
  await act(async () => root.render(null));
  modal.hideOverlay();
  assert.equal(cleanups, 0);
});
