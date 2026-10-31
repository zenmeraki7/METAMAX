import { setTimeout as delay } from "node:timers/promises";
import { invalid, shop } from "./transactions.server.js";

export const PRODUCTS_BULK_QUERY = `
  query {
    products {
      edges {
        node {
          id
          title
          handle
          descriptionHtml
          vendor
          productType
          status
          tags
          templateSuffix
          seo { title description }
          category { id name fullName }
          createdAt
          updatedAt
          publishedAt
          variants {
            edges {
              node {
                id
                title
                sku
                barcode
                price
                compareAtPrice
                inventoryPolicy
                inventoryQuantity
                requiresComponents
                taxable
                position
                createdAt
                updatedAt
              }
            }
          }
        }
      }
    }
  }
`;

export const BULK_STATUS_QUERY = `query MirrorBulkStatus($id: ID!) {
  bulkOperation(id: $id) {
    id
    status
    objectCount
    url
    partialDataUrl
    errorCode
    fileSize
    rootObjectCount
  }
}`;

export const CURRENT_BULK_OPERATION_QUERY = `query CurrentMirrorBulkOperation {
  currentBulkOperation {
    id
    status
    objectCount
    url
    errorCode
    fileSize
    rootObjectCount
  }
}`;

export const BULK_START_MUTATION = `mutation StartBulkOperation($query: String!) {
  bulkOperationRunQuery(query: $query, groupObjects: true) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

export const BULK_CANCEL_MUTATION = `mutation CancelMirrorBulk($id: ID!) {
  bulkOperationCancel(id: $id) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

export function createBulkSyncService({ shopifyClient, syncRunService }) {
  if (!shopifyClient || typeof shopifyClient.request !== "function") {
    throw new TypeError("Shopify client required");
  }
  if (!syncRunService || typeof syncRunService.getSyncRun !== "function") {
    throw new TypeError("Sync run service required");
  }

  const service = Object.freeze({
    /**
     * Start a new Shopify bulk operation query bound to a running SyncRun.
     */
    async startBulkQuery({ shopId, syncRun, query = PRODUCTS_BULK_QUERY }) {
      shop(shopId);
      if (!syncRun?.runId || syncRun.fence === undefined) {
        invalid("SyncRun identity required");
      }

      const persisted = await syncRunService.getSyncRun({
        shopId,
        runId: syncRun.runId,
      });

      if (
        !persisted ||
        BigInt(persisted.fence) !== BigInt(syncRun.fence) ||
        persisted.status !== "RUNNING"
      ) {
        invalid("Live owned run required");
      }

      // If already started and bound, return current status.
      if (persisted.bulkOperationId) {
        return service.getStatus({
          shopId,
          bulkOperationId: persisted.bulkOperationId,
        });
      }

      // Never adopt another run's currentBulkOperation. An uncertain remote
      // start may leave an orphan export, but cannot authorize its publication.
      const response = await shopifyClient.request(BULK_START_MUTATION, {
        variables: { query },
      });

      const payload = response.data?.bulkOperationRunQuery;
      if (
        response.errors ||
        !payload?.bulkOperation ||
        payload.userErrors?.length
      ) {
        invalid("Bulk start rejected");
      }

      await syncRunService.bindBulkOperationId({
        shopId,
        runId: syncRun.runId,
        fence: syncRun.fence,
        bulkOperationId: payload.bulkOperation.id,
      });

      return payload.bulkOperation;
    },

    /** Alias for initiateBulkCatalogExport */
    async initiateBulkCatalogExport({ shopId, syncRun, query }) {
      return service.startBulkQuery({ shopId, syncRun, query });
    },

    /**
     * Get the status of an owned bulk operation.
     */
    async getStatus({ shopId, bulkOperationId }) {
      shop(shopId);
      if (!bulkOperationId) {
        invalid("Persisted operation identity required");
      }

      const response = await shopifyClient.request(BULK_STATUS_QUERY, {
        variables: { id: bulkOperationId },
      });

      const op = response.data?.bulkOperation;
      if (response.errors || !op || op.id !== bulkOperationId) {
        invalid("Owned bulk operation unavailable");
      }

      return op;
    },

    /** Alias for getStatus */
    async getBulkOperationStatus({ shopId, bulkOperationId }) {
      return service.getStatus({ shopId, bulkOperationId });
    },

    /**
     * Monitor a bulk operation until it reaches a terminal status or times out.
     */
    async monitorBulkOperation({
      shopId,
      bulkOperationId,
      runId,
      timeoutMs = 600000,
      intervalMs = 1000,
      signal,
    }) {
      shop(shopId);
      let opId = bulkOperationId;
      if (!opId && runId) {
        const run = await syncRunService.getSyncRun({ shopId, runId });
        if (!run?.bulkOperationId) {
          invalid("Persisted operation identity required");
        }
        opId = run.bulkOperationId;
      }
      if (!opId) {
        invalid("Bulk operation identity required");
      }

      const startTime = Date.now();
      while (true) {
        signal?.throwIfAborted();
        const op = await service.getStatus({ shopId, bulkOperationId: opId });
        if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(op.status)) {
          return op;
        }
        if (Date.now() - startTime > timeoutMs) {
          invalid("Bulk operation monitoring timed out");
        }
        await delay(intervalMs, undefined, { signal });
      }
    },

    /**
     * Cancel an owned bulk query, persisting local cancellation first.
     */
    async cancelBulkQuery({ shopId, runId }) {
      shop(shopId);
      const run = await syncRunService.getSyncRun({ shopId, runId });
      if (!run) invalid("Owned run required");

      // Persist cancellation locally first, even if network request subsequently fails.
      await syncRunService.cancelGeneration({
        shopId,
        generationId: run.generationId,
      });

      if (!run.bulkOperationId) {
        return { cancelled: true, remote: false };
      }

      const response = await shopifyClient.request(BULK_CANCEL_MUTATION, {
        variables: { id: run.bulkOperationId },
      });

      if (
        response.errors ||
        response.data?.bulkOperationCancel?.bulkOperation?.id !==
          run.bulkOperationId ||
        response.data?.bulkOperationCancel?.userErrors?.length
      ) {
        invalid("Remote cancellation requires retry");
      }

      return { cancelled: true, remote: true };
    },

    /** Alias for cancelBulkCatalogExport */
    async cancelBulkCatalogExport({ shopId, runId }) {
      return service.cancelBulkQuery({ shopId, runId });
    },

    /**
     * Recover state of a bulk query after worker restart or network interruption.
     */
    async recoverBulkQuery({ shopId, runId }) {
      shop(shopId);
      const run = await syncRunService.getSyncRun({ shopId, runId });
      if (!run) invalid("Owned run required");

      if (run.bulkOperationId) {
        const op = await service.getStatus({
          shopId,
          bulkOperationId: run.bulkOperationId,
        });
        return {
          runId: run.runId,
          generationId: run.generationId,
          fence: run.fence,
          bulkOperationId: run.bulkOperationId,
          status: op.status,
          bulkOperation: op,
          bound: true,
          readyToIngest: op.status === "COMPLETED",
        };
      }

      // Check currentBulkOperation on Shopify without adopting unowned operations.
      const response = await shopifyClient.request(CURRENT_BULK_OPERATION_QUERY);
      const currentOp = response.data?.currentBulkOperation;

      return {
        runId: run.runId,
        generationId: run.generationId,
        fence: run.fence,
        bulkOperationId: null,
        bulkOperation: null,
        bound: false,
        orphanOperation: currentOp || null,
        readyToIngest: false,
      };
    },
  });

  return service;
}
