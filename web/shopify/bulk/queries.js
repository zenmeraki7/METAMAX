/**
 * Shopify Admin GraphQL — Catalog snapshot.
 *
 * Pin the API version in Shopify configuration
 * and validate this document against that version.
 */

export const SHOPIFY_API_VERSION = "2026-10";

export const CATALOG_BULK_QUERY = `
{
  products {
    edges {
      node {
        id
        title
        handle
        vendor
        productType
        status
        tags
        totalInventory
        updatedAt
        variants {
          edges {
            node {
              id
              sku
              barcode
              price
              compareAtPrice
              selectedOptions {
                name
                value
              }
              inventoryItem {
                id
              }
            }
          }
        }
      }
    }
  }
}
`;

export const START_BULK_QUERY = `
  mutation StartBulkQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const GET_BULK_OPERATION = `
  query GetBulkOperation($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      errorCode
      objectCount
      rootObjectCount
      fileSize
      url
      partialDataUrl
      completedAt
    }
  }
`;

export const TERMINAL_BULK_STATUSES = Object.freeze([
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "EXPIRED",
]);

/**
 * Check if a bulk operation finished successfully with a complete download URL.
 *
 * @param {object} operation - Shopify bulkOperation response object
 * @returns {boolean}
 */
export function isBulkOperationComplete(operation) {
  return Boolean(
    operation &&
      typeof operation === "object" &&
      operation.status === "COMPLETED" &&
      typeof operation.url === "string" &&
      operation.url.length > 0
  );
}

/**
 * Validates that a bulk operation succeeded completely.
 *
 * Invariant: A failed operation's partialDataUrl must never be treated as a complete catalog snapshot.
 *
 * @param {object} operation - Shopify bulkOperation response object
 * @returns {string} The verified download URL for the complete snapshot.
 * @throws {Error} If the operation failed, canceled, expired, is incomplete, or offers only partialDataUrl.
 */
export function assertCompleteBulkOperation(operation) {
  if (!operation || typeof operation !== "object") {
    const error = new Error("A valid bulk operation response object is required");
    error.code = "INVALID_BULK_OPERATION";
    throw error;
  }

  // A failed operation's partialDataUrl must never be treated as a complete catalog snapshot.
  if (operation.status !== "COMPLETED") {
    const hasPartial = Boolean(operation.partialDataUrl);
    const message = hasPartial
      ? "A failed operation's partialDataUrl must never be treated as a complete catalog snapshot"
      : `Bulk operation is not completed (status: ${operation.status ?? "UNKNOWN"})`;
    const error = new Error(message);
    error.code = hasPartial ? "PARTIAL_DATA_REJECTED" : "INCOMPLETE_BULK_OPERATION";
    error.status = operation.status;
    if (operation.errorCode) {
      error.errorCode = operation.errorCode;
    }
    throw error;
  }

  if (!operation.url || typeof operation.url !== "string") {
    const error = new Error("Completed bulk operation is missing download URL");
    error.code = "MISSING_DOWNLOAD_URL";
    throw error;
  }

  return operation.url;
}

/**
 * Extract download URL for a completed catalog snapshot.
 *
 * @param {object} operation
 * @returns {string}
 */
export function getBulkSnapshotUrl(operation) {
  return assertCompleteBulkOperation(operation);
}
