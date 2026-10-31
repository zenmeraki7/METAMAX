import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeExportRequest,
  exportRequestFingerprint,
  normalizeIdempotencyKey,
  canonicalizeJson,
  assertExportTransition,
  canTransitionExport,
  EXPORT_STATES,
  EXPORT_LIMITS,
  ExportContractError,
  exportExtension,
  exportMimeType,
  maxExportRows,
} from "./export-contract.js";

const base = () => ({
  fieldIds: [
    "product.title",
    "product.status",
  ],
  filter: {
    operator: "eq",
    field: "product.status",
    value: "ACTIVE",
  },
});

test("defaults and deep immutability", () => {
  const original = base();

  const result = normalizeExportRequest(original);

  original.filter.value = "DRAFT";

  assert.equal(result.filter.value, "ACTIVE");
  assert.equal(result.batchSize, 1000);

  assert.ok(Object.isFrozen(result.filter));
  assert.ok(Object.isFrozen(result.fieldIds));
});

test(
  "structurally identical filters with different key ordering hash equally",
  () => {
    const a = base();

    const b = {
      fieldIds: [
        "product.title",
        "product.status",
      ],
      filter: {
        value: "ACTIVE",
        field: "product.status",
        operator: "eq",
      },
    };

    assert.equal(
      exportRequestFingerprint(a),
      exportRequestFingerprint(b),
    );
  },
);

test("field column order affects fingerprint", () => {
  const a = base();
  const b = base();

  b.fieldIds.reverse();

  assert.notEqual(
    exportRequestFingerprint(a),
    exportRequestFingerprint(b),
  );
});

test("rejects cycles and shared object references", () => {
  const loop = {};
  loop.self = loop;

  assert.throws(
    () =>
      normalizeExportRequest({
        fieldIds: ["x"],
        filter: loop,
      }),
    ExportContractError,
  );

  const node = { x: 1 };

  assert.throws(
    () =>
      canonicalizeJson({
        a: node,
        b: node,
      }),
    ExportContractError,
  );
});

test(
  "rejects accessors and prototype keys without executing getters",
  () => {
    let called = false;

    const request = {
      fieldIds: ["x"],
    };

    Object.defineProperty(request, "format", {
      enumerable: true,

      get() {
        called = true;
        throw Error("getter");
      },
    });

    assert.throws(
      () => normalizeExportRequest(request),
      ExportContractError,
    );

    assert.equal(called, false);

    const poisoned = JSON.parse(
      '{"__proto__":{"isAdmin":true}}',
    );

    assert.throws(
      () => canonicalizeJson(poisoned),
      ExportContractError,
    );
  },
);

test("rejects malformed and oversized inputs", () => {
  for (const request of [
    { fieldIds: [] },
    { fieldIds: ["x", "x"] },
    {
      fieldIds: ["x"],
      batchSize: 999999,
    },
    {
      fieldIds: ["x"],
      fileName: "../oops",
    },
    {
      fieldIds: ["x"],
      unsupported: true,
    },
    {
      fieldIds: ["x"],
      filter: [],
    },
  ]) {
    assert.throws(
      () => normalizeExportRequest(request),
      ExportContractError,
    );
  }

  assert.throws(
    () =>
      normalizeExportRequest({
        fieldIds: ["x"],
        filter: {
          value: "z".repeat(
            EXPORT_LIMITS.MAX_FILTER_BYTES,
          ),
        },
      }),
    ExportContractError,
  );
});

test("idempotency key syntax", () => {
  assert.equal(
    normalizeIdempotencyKey(
      "export:request-123",
    ),
    "export:request-123",
  );

  for (const key of [
    "short",
    " spaces test ",
    "../oops!",
    "a".repeat(129),
  ]) {
    assert.throws(
      () => normalizeIdempotencyKey(key),
    );
  }
});

test(
  "state transitions fail closed and terminal states remain terminal",
  () => {
    assert.equal(
      canTransitionExport(
        EXPORT_STATES.VALIDATING,
        EXPORT_STATES.WAITING_FOR_CAPACITY,
      ),
      true,
    );

    assertExportTransition(
      EXPORT_STATES.RUNNING,
      EXPORT_STATES.FINALIZING,
    );

    assert.throws(() =>
      assertExportTransition(
        EXPORT_STATES.COMPLETED,
        EXPORT_STATES.RUNNING,
      ),
    );
  },
);

test("format helpers remain backwards compatible", () => {
  assert.equal(
    exportExtension("XLSX"),
    ".xlsx",
  );

  assert.match(
    exportMimeType("JSONL"),
    /ndjson/,
  );

  assert.equal(
    maxExportRows("XLSX"),
    1048575,
  );
});

