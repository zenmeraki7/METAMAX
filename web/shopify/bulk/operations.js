import {
  CATALOG_BULK_QUERY,
  START_BULK_QUERY,
  GET_BULK_OPERATION,
} from "./queries.js";

async function graph(client, query, variables) {
  if (!client || typeof client.request !== "function") {
    throw new TypeError("An authenticated Shopify GraphQL client with request() is required");
  }

  const response = await client.request(query, {
    variables,
  });

  if (response.errors?.length) {
    const error = new Error(
      `Shopify GraphQL error: ${
        JSON.stringify(response.errors)
      }`
    );
    error.errors = response.errors;
    throw error;
  }

  if (!response.data) {
    throw new Error("Missing Shopify GraphQL data");
  }

  return response.data;
}

/**
 * Initiates a catalog snapshot bulk query against the Shopify GraphQL Admin API.
 *
 * @param {object} client - Authenticated Shopify GraphQL client
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function startCatalogBulk(client) {
  const data = await graph(
    client,
    START_BULK_QUERY,
    { query: CATALOG_BULK_QUERY }
  );

  const result = data.bulkOperationRunQuery;

  if (result?.userErrors?.length) {
    const error = new Error(
      JSON.stringify(result.userErrors)
    );
    error.userErrors = result.userErrors;
    throw error;
  }

  if (!result?.bulkOperation?.id) {
    throw new Error("Bulk operation was not created");
  }

  return result.bulkOperation;
}

/**
 * Retrieves the status and manifest metadata of a Shopify bulk operation.
 *
 * @param {object} client - Authenticated Shopify GraphQL client
 * @param {string} id - Bulk operation GID
 * @returns {Promise<object>}
 */
export async function getBulkStatus(client, id) {
  if (!id || typeof id !== "string") {
    throw new TypeError("A valid bulk operation ID is required");
  }

  const data = await graph(
    client,
    GET_BULK_OPERATION,
    { id }
  );

  if (!data.bulkOperation) {
    throw new Error(`Bulk operation not found: ${id}`);
  }

  return data.bulkOperation;
}

/**
 * Asserts that a bulk operation is terminal, completed, and yields a valid catalog URL.
 *
 * Invariant: A failed operation's partialDataUrl must never be treated as a complete catalog snapshot.
 *
 * @param {object} operation - Shopify bulkOperation object
 * @returns {string|null} The verified download URL (or null for a verified empty catalog)
 */
export function requireCompletedBulk(operation) {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("A valid bulk operation object is required");
  }

  if (operation.status !== "COMPLETED") {
    if (operation.partialDataUrl) {
      const error = new Error(
        "A failed operation's partialDataUrl must never be treated as a complete catalog snapshot"
      );
      error.code = "PARTIAL_DATA_REJECTED";
      error.status = operation.status;
      throw error;
    }

    throw new Error(
      `Bulk operation not completed: ${operation.status}`
    );
  }

  // A successful empty dataset may have no URL.
  if (
    !operation.url &&
    BigInt(operation.objectCount ?? "0") !== 0n
  ) {
    throw new Error("Missing completed bulk result");
  }

  return operation.url ?? null;
}
