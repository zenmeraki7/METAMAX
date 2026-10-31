import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { createCatalogImportRouter } from "../routes/catalog-import.routes.js";

const id = "12345678-1234-4234-9234-123456789abc";

async function withRouter(callback, options = {}) {
  const { authenticated = true } = options;
  const result = Object.hasOwn(options, "result") ? options.result : { id };
  const app = express(), calls = [];
  // Deliberately no upstream body parser: the router must own this contract.
  app.use(createCatalogImportRouter({
    authentication: {
      async authenticateSession() { return authenticated ? { shop: "owner.myshopify.com" } : null; },
    },
    service: Object.fromEntries(["enqueue", "current", "status", "cancel"].map(action => [action, async () => {
      calls.push(action);
      return result;
    }])),
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try { await callback(`http://127.0.0.1:${server.address().port}`, calls); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("standalone import parser enforces empty-object schema, media type and byte limit", async () => {
  await withRouter(async (base, calls) => {
    for (const path of ["/", `/${id}/cancel`]) {
      for (const body of [undefined, "{}", " ".repeat(4094) + "{}"]) {
        const response = await fetch(`${base}${path}`, { method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" }, body });
        assert.equal(response.status, path === "/" ? 202 : 200);
      }
      for (const body of ['{"options":{}}', '{"shop":"attacker.myshopify.com"}', "[]", "null", "false", "0", '""', "{"]) {
        const before = calls.length;
        const response = await fetch(`${base}${path}`, { method: "POST",
          headers: { "Content-Type": "application/json" }, body });
        assert.equal(response.status, 400, body);
        assert.deepEqual(await response.json(), { error: "INVALID_IMPORT_REQUEST" });
        assert.equal(calls.length, before);
      }
      for (const [body, headers, status, code] of [
        [" ".repeat(4095) + "{}", { "Content-Type": "application/json" }, 413, "IMPORT_REQUEST_TOO_LARGE"],
        ["{}", { "Content-Type": "text/plain" }, 415, "IMPORT_UNSUPPORTED_MEDIA_TYPE"],
        [new Uint8Array([123, 125]), {}, 415, "IMPORT_UNSUPPORTED_MEDIA_TYPE"],
        [gzipSync("{}"), { "Content-Type": "application/json", "Content-Encoding": "gzip" }, 415, "IMPORT_UNSUPPORTED_MEDIA_TYPE"],
        ["{}", { "Content-Type": "application/json; charset=iso-8859-1" }, 415, "IMPORT_UNSUPPORTED_MEDIA_TYPE"],
      ]) {
        const before = calls.length;
        const response = await fetch(`${base}${path}`, { method: "POST", headers, body });
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { error: code });
        assert.equal(calls.length, before);
      }
    }
  });
});

test("standalone import authentication precedes JSON parsing and size checks", async () => {
  await withRouter(async (base, calls) => {
    for (const body of ["{", " ".repeat(4097)]) {
      const response = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      assert.equal(response.status, 401);
    }
    assert.deepEqual(calls, []);
  }, { authenticated: false });
});

test("import size limits also apply to chunked requests without Content-Length", async () => {
  await withRouter(async (base, calls) => {
    const response = await fetch(base, { method: "POST", duplex: "half",
      headers: { "Content-Type": "application/json" },
      body: Readable.from([" ".repeat(2048), " ".repeat(2048), "{}"]),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "IMPORT_REQUEST_TOO_LARGE" });
    assert.deepEqual(calls, []);
  });
});

for (const result of [null, undefined]) {
  test(`current import absence (${result}) has an explicit 200/null contract`, async () => {
    await withRouter(async (base) => {
      const response = await fetch(base);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data: null });
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    }, { result });
  });
}

test("enqueue cannot report acceptance without a durable job", async () => {
  await withRouter(async base => {
    const response = await fetch(base, { method: "POST" });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "IMPORT_INTERNAL_ERROR" });
  }, { result: null });
});

test("import routes validate UUID grouping, version and variant before invoking services", async () => {
  await withRouter(async (base, calls) => {
    const invalidIds = [
      "-".repeat(36), "a".repeat(36),
      "1234567-81234-4234-9234-123456789abc",
      "12345678-1234-1234-9234-123456789abc",
      "12345678-1234-4234-1234-123456789abc",
      "12345678-1234-4234-c234-123456789abc",
      "00000000-0000-0000-0000-000000000000", id.toUpperCase(), `${id}\n`,
    ];
    for (const value of invalidIds) {
      for (const [path, method] of [[`/${encodeURIComponent(value)}`, "GET"], [`/${encodeURIComponent(value)}/cancel`, "POST"]]) {
        const response = await fetch(`${base}${path}`, { method });
        assert.equal(response.status, 400, value);
        assert.deepEqual(await response.json(), { error: "INVALID_IMPORT_REQUEST" });
      }
    }
    assert.deepEqual(calls, []);
    for (const value of [randomUUID(), id, ...["8", "9", "a", "b"].map(variant => id.replace("-9234-", `-${variant}234-`))]) {
      assert.equal((await fetch(`${base}/${value}`)).status, 200);
      assert.equal((await fetch(`${base}/${value}/cancel`, { method: "POST" })).status, 200);
    }
  });
});
