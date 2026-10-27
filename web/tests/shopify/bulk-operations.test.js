import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startCatalogBulk,
  getBulkStatus,
  requireCompletedBulk,
} from "../../shopify/bulk/operations.js";
import {
  readBulkJsonl,
  catalogBatches,
  validateBulkDownloadUrl,
} from "../../shopify/bulk/download.js";

test("startCatalogBulk submits CATALOG_BULK_QUERY mutation and returns operation", async () => {
  let capturedQuery = null;
  let capturedVariables = null;

  const mockClient = {
    request: async (query, { variables }) => {
      capturedQuery = query;
      capturedVariables = variables;
      return {
        data: {
          bulkOperationRunQuery: {
            bulkOperation: {
              id: "gid://shopify/BulkOperation/100",
              status: "CREATED",
            },
            userErrors: [],
          },
        },
      };
    },
  };

  const op = await startCatalogBulk(mockClient);
  assert.equal(op.id, "gid://shopify/BulkOperation/100");
  assert.equal(op.status, "CREATED");
  assert.ok(capturedQuery.includes("mutation StartBulkQuery"));
  assert.ok(capturedVariables.query.includes("products"));
});

test("startCatalogBulk throws on GraphQL errors or userErrors", async () => {
  const errorClient = {
    request: async () => ({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ field: ["query"], message: "A bulk query is already running" }],
        },
      },
    }),
  };

  await assert.rejects(
    startCatalogBulk(errorClient),
    /A bulk query is already running/
  );

  const gqlErrorClient = {
    request: async () => ({
      errors: [{ message: "Throttled" }],
    }),
  };

  await assert.rejects(
    startCatalogBulk(gqlErrorClient),
    /Shopify GraphQL error/
  );
});

test("getBulkStatus retrieves bulk operation status by ID", async () => {
  const mockClient = {
    request: async (query, { variables }) => {
      assert.equal(variables.id, "gid://shopify/BulkOperation/200");
      return {
        data: {
          bulkOperation: {
            id: variables.id,
            status: "COMPLETED",
            objectCount: "42",
            url: "https://storage.googleapis.com/test.jsonl",
          },
        },
      };
    },
  };

  const status = await getBulkStatus(mockClient, "gid://shopify/BulkOperation/200");
  assert.equal(status.id, "gid://shopify/BulkOperation/200");
  assert.equal(status.status, "COMPLETED");
  assert.equal(status.objectCount, "42");
});

test("requireCompletedBulk enforces completion, empty dataset handling, and partialDataUrl rejection", () => {
  // Completed with url
  const completed = {
    status: "COMPLETED",
    objectCount: "5",
    url: "https://storage.googleapis.com/result.jsonl",
  };
  assert.equal(
    requireCompletedBulk(completed),
    "https://storage.googleapis.com/result.jsonl"
  );

  // Completed with empty dataset (objectCount 0, no URL)
  const emptyCompleted = {
    status: "COMPLETED",
    objectCount: "0",
    url: null,
  };
  assert.equal(requireCompletedBulk(emptyCompleted), null);

  // Completed with non-zero objects but missing URL
  assert.throws(
    () => requireCompletedBulk({ status: "COMPLETED", objectCount: "1", url: null }),
    /Missing completed bulk result/
  );

  // Incomplete operation
  assert.throws(
    () => requireCompletedBulk({ status: "RUNNING", url: null }),
    /Bulk operation not completed: RUNNING/
  );

  // Invariant: partialDataUrl on failed operation
  assert.throws(
    () =>
      requireCompletedBulk({
        status: "FAILED",
        partialDataUrl: "https://storage.googleapis.com/partial.jsonl",
      }),
    /A failed operation's partialDataUrl must never be treated as a complete catalog snapshot/
  );
});

test("validateBulkDownloadUrl enforces HTTPS and allowlisted hosts", () => {
  assert.doesNotThrow(() => {
    validateBulkDownloadUrl("https://storage.googleapis.com/shopify/file.jsonl");
  });
  assert.doesNotThrow(() => {
    validateBulkDownloadUrl("https://sub.shopify.com/file.jsonl");
  });

  assert.throws(
    () => validateBulkDownloadUrl("http://storage.googleapis.com/file.jsonl"),
    /Unexpected bulk download host/
  );
  assert.throws(
    () => validateBulkDownloadUrl("https://attacker.com/file.jsonl"),
    /Unexpected bulk download host/
  );
  assert.throws(
    () => validateBulkDownloadUrl("https://user:pass@storage.googleapis.com/file.jsonl"),
    /Unexpected bulk download host/
  );
});

test("readBulkJsonl streams JSON records and enforces limits", async () => {
  const records = [
    { id: "gid://shopify/Product/1", title: "Item 1" },
    { id: "gid://shopify/Product/2", title: "Item 2" },
  ];
  const bodyText = records.map((r) => JSON.stringify(r)).join("\n") + "\n";

  const mockFetch = async () => new Response(bodyText);

  const streamed = [];
  for await (const record of readBulkJsonl(
    "https://storage.googleapis.com/shopify-bulk/test.jsonl",
    { fetchImpl: mockFetch }
  )) {
    streamed.push(record);
  }

  assert.deepEqual(streamed, records);
});

test("readBulkJsonl rejects lines exceeding maxLineBytes", async () => {
  const overlongLine = JSON.stringify({ data: "x".repeat(100) });
  const mockFetch = async () => new Response(overlongLine + "\n");

  await assert.rejects(
    async () => {
      for await (const _ of readBulkJsonl(
        "https://storage.googleapis.com/test.jsonl",
        { maxLineBytes: 50, fetchImpl: mockFetch }
      )) {
        // unreachable
      }
    },
    /JSONL line exceeds limit/
  );
});

test("catalogBatches batches stream items up to specified size", async () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ index: i }));

  const batches = [];
  for await (const batch of catalogBatches(items, 4)) {
    batches.push(batch);
  }

  assert.equal(batches.length, 3);
  assert.equal(batches[0].length, 4);
  assert.equal(batches[1].length, 4);
  assert.equal(batches[2].length, 1);

  // Invalid batch size
  await assert.rejects(
    async () => {
      for await (const _ of catalogBatches(items, 0)) {}
    },
    /Invalid catalog batch size/
  );
  await assert.rejects(
    async () => {
      for await (const _ of catalogBatches(items, 600)) {}
    },
    /Invalid catalog batch size/
  );
});
