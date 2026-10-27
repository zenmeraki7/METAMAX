import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG_BULK_QUERY,
  START_BULK_QUERY,
  GET_BULK_OPERATION,
  SHOPIFY_API_VERSION,
  isBulkOperationComplete,
  assertCompleteBulkOperation,
  getBulkSnapshotUrl,
} from "../../shopify/bulk/queries.js";
import {
  streamGroupedCatalog,
  consumeGroupedCatalog,
  downloadBulkResult,
  validateBulkResultUrl,
  streamJsonlRecords,
} from "../../shopify/bulk/results.js";

test("Shopify API version is pinned", () => {
  assert.equal(SHOPIFY_API_VERSION, "2026-10");
});

test("CATALOG_BULK_QUERY retrieves products and nested variants", () => {
  assert.ok(CATALOG_BULK_QUERY.includes("products"));
  assert.ok(CATALOG_BULK_QUERY.includes("variants"));
  assert.ok(CATALOG_BULK_QUERY.includes("totalInventory"));
  assert.ok(CATALOG_BULK_QUERY.includes("selectedOptions"));
  assert.ok(CATALOG_BULK_QUERY.includes("inventoryItem"));
  assert.ok(CATALOG_BULK_QUERY.includes("compareAtPrice"));
});

test("START_BULK_QUERY and GET_BULK_OPERATION are valid GraphQL documents", () => {
  assert.ok(START_BULK_QUERY.includes("mutation StartBulkQuery($query: String!)"));
  assert.ok(START_BULK_QUERY.includes("bulkOperationRunQuery(query: $query)"));
  assert.ok(START_BULK_QUERY.includes("userErrors"));

  assert.ok(GET_BULK_OPERATION.includes("query GetBulkOperation($id: ID!)"));
  assert.ok(GET_BULK_OPERATION.includes("bulkOperation(id: $id)"));
  assert.ok(GET_BULK_OPERATION.includes("partialDataUrl"));
  assert.ok(GET_BULK_OPERATION.includes("rootObjectCount"));
});

test("isBulkOperationComplete accurately reports operation completion", () => {
  assert.equal(
    isBulkOperationComplete({
      status: "COMPLETED",
      url: "https://storage.googleapis.com/test.jsonl",
    }),
    true
  );

  assert.equal(
    isBulkOperationComplete({
      status: "RUNNING",
      url: null,
    }),
    false
  );

  assert.equal(
    isBulkOperationComplete({
      status: "FAILED",
      url: null,
      partialDataUrl: "https://storage.googleapis.com/partial.jsonl",
    }),
    false
  );

  assert.equal(isBulkOperationComplete(null), false);
  assert.equal(isBulkOperationComplete({ status: "COMPLETED", url: "" }), false);
});

test("Invariant: A failed operation's partialDataUrl must never be treated as a complete catalog snapshot", () => {
  // Failed with partialDataUrl
  const failedOp = {
    id: "gid://shopify/BulkOperation/1",
    status: "FAILED",
    errorCode: "ACCESS_DENIED",
    url: null,
    partialDataUrl: "https://storage.googleapis.com/shopify-bulk/partial-1.jsonl",
  };

  assert.throws(
    () => assertCompleteBulkOperation(failedOp),
    (err) => {
      assert.equal(err.code, "PARTIAL_DATA_REJECTED");
      assert.match(
        err.message,
        /A failed operation's partialDataUrl must never be treated as a complete catalog snapshot/
      );
      return true;
    }
  );

  // Canceled with partialDataUrl
  const canceledOp = {
    id: "gid://shopify/BulkOperation/2",
    status: "CANCELED",
    url: null,
    partialDataUrl: "https://storage.googleapis.com/shopify-bulk/partial-2.jsonl",
  };

  assert.throws(
    () => assertCompleteBulkOperation(canceledOp),
    (err) => {
      assert.equal(err.code, "PARTIAL_DATA_REJECTED");
      assert.match(
        err.message,
        /A failed operation's partialDataUrl must never be treated as a complete catalog snapshot/
      );
      return true;
    }
  );

  // Still running without url
  assert.throws(
    () => assertCompleteBulkOperation({ status: "RUNNING", url: null }),
    (err) => {
      assert.equal(err.code, "INCOMPLETE_BULK_OPERATION");
      return true;
    }
  );

  // Completed with valid url
  const completedOp = {
    id: "gid://shopify/BulkOperation/3",
    status: "COMPLETED",
    url: "https://storage.googleapis.com/shopify-bulk/complete.jsonl",
  };

  assert.equal(
    assertCompleteBulkOperation(completedOp),
    "https://storage.googleapis.com/shopify-bulk/complete.jsonl"
  );
  assert.equal(
    getBulkSnapshotUrl(completedOp),
    "https://storage.googleapis.com/shopify-bulk/complete.jsonl"
  );
});

test("streamGroupedCatalog groups products and variants via __parentId with bounded memory", async () => {
  const p1 = {
    id: "gid://shopify/Product/100",
    title: "T-Shirt",
    handle: "t-shirt",
    status: "ACTIVE",
  };
  const v1 = {
    id: "gid://shopify/ProductVariant/1001",
    __parentId: p1.id,
    sku: "TSHIRT-S",
    price: "19.99",
  };
  const v2 = {
    id: "gid://shopify/ProductVariant/1002",
    __parentId: p1.id,
    sku: "TSHIRT-M",
    price: "19.99",
  };

  const p2 = {
    id: "gid://shopify/Product/200",
    title: "Hoodie",
    handle: "hoodie",
    status: "ACTIVE",
  };
  const v3 = {
    id: "gid://shopify/ProductVariant/2001",
    __parentId: p2.id,
    sku: "HOODIE-L",
    price: "49.99",
  };

  const jsonlLines = [
    JSON.stringify(p1),
    JSON.stringify(v1),
    JSON.stringify(v2),
    JSON.stringify(p2),
    JSON.stringify(v3),
  ];

  const groups = [];
  for await (const group of streamGroupedCatalog(jsonlLines)) {
    groups.push(group);
  }

  assert.equal(groups.length, 2);
  assert.equal(groups[0].product.id, p1.id);
  assert.equal(groups[0].variants.length, 2);
  assert.equal(groups[0].variants[0].id, v1.id);
  assert.equal(groups[0].variants[1].id, v2.id);

  assert.equal(groups[1].product.id, p2.id);
  assert.equal(groups[1].variants.length, 1);
  assert.equal(groups[1].variants[0].id, v3.id);
});

test("streamGroupedCatalog fails closed on orphan variants", async () => {
  const orphanVariant = {
    id: "gid://shopify/ProductVariant/999",
    __parentId: "gid://shopify/Product/NON_EXISTENT",
    sku: "ORPHAN",
  };

  await assert.rejects(
    async () => {
      for await (const _ of streamGroupedCatalog([JSON.stringify(orphanVariant)])) {
        // unreachable
      }
    },
    (err) => {
      assert.equal(err.code, "UNGROUPED_BULK_RECORD");
      return true;
    }
  );
});

test("consumeGroupedCatalog accurately counts products and variants", async () => {
  const p = { id: "gid://shopify/Product/1", title: "Shoes" };
  const v = { id: "gid://shopify/ProductVariant/10", __parentId: p.id };

  const processed = [];
  const counts = await consumeGroupedCatalog(
    [p, v],
    async (group) => {
      processed.push(group);
    }
  );

  assert.equal(counts.productsCount, 1);
  assert.equal(counts.variantsCount, 1);
  assert.equal(processed.length, 1);
  assert.equal(processed[0].product.id, p.id);
  assert.equal(processed[0].variants[0].id, v.id);
});

test("streamJsonlRecords parses valid lines and rejects malformed records", async () => {
  const lines = ['{"a": 1}', '{"b": 2}'];
  const records = [];
  for await (const r of streamJsonlRecords(lines)) {
    records.push(r);
  }
  assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);

  await assert.rejects(
    async () => {
      for await (const _ of streamJsonlRecords(["{ not json }"])) {
        // unreachable
      }
    },
    (err) => {
      assert.equal(err.code, "MALFORMED_JSON");
      return true;
    }
  );
});

test("validateBulkResultUrl rejects untrusted and non-HTTPS hosts", () => {
  assert.doesNotThrow(() => {
    validateBulkResultUrl("https://storage.googleapis.com/shopify-bulk-output/export.jsonl");
  });
  assert.doesNotThrow(() => {
    validateBulkResultUrl("https://shopify.com/export.jsonl");
  });

  assert.throws(
    () => validateBulkResultUrl("http://storage.googleapis.com/export.jsonl"),
    /Unexpected bulk result download host/
  );
  assert.throws(
    () => validateBulkResultUrl("https://malicious.com/export.jsonl"),
    /Unexpected bulk result download host/
  );
  assert.throws(
    () => validateBulkResultUrl("https://shopify.com.attacker.com/export.jsonl"),
    /Unexpected bulk result download host/
  );
});

test("downloadBulkResult rejects operations with partialDataUrl", async () => {
  const failedOp = {
    status: "FAILED",
    partialDataUrl: "https://storage.googleapis.com/partial.jsonl",
  };

  await assert.rejects(
    async () => {
      for await (const _ of downloadBulkResult(failedOp)) {
        // unreachable
      }
    },
    (err) => {
      assert.equal(err.code, "PARTIAL_DATA_REJECTED");
      assert.match(
        err.message,
        /A failed operation's partialDataUrl must never be treated as a complete catalog snapshot/
      );
      return true;
    }
  );
});
