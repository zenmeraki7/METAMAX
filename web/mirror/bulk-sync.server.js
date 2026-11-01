import {boundBulkStatus} from './bulk-cleanup-result.server.js';
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from 'node:crypto';
import { SyncOutcomeUnknownError } from './sync-db-transaction.server.js';
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
     * Contract: docs/backend-interface-contracts.md#legacy-bulk-start-and-ingestion-recovery
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

      if (typeof query !== 'string' || !query || Buffer.byteLength(query) > 1024 * 1024) invalid('Bounded bulk query required');
      for (const method of ['prepareBulkStart','recordBulkStartResponse','rejectBulkStart']) {
        if (typeof syncRunService[method] !== 'function') invalid('Durable bulk start protocol required');
      }
      const inputHash = createHash('sha256').update(query).digest('hex');
      const scope = {shopId,runId:syncRun.runId,fence:syncRun.fence,inputHash};
      // Commit intent before sending. Lost commit/remote responses never permit
      // automatic redispatch. Only exact saved response evidence may be bound.
      const prepared = await syncRunService.prepareBulkStart(scope);
      if (prepared.operationId) return service.getStatus({shopId,bulkOperationId:prepared.operationId});
      if (String(prepared.dispatchFence) !== String(syncRun.fence)) invalid('Durable dispatch receipt required');
      let response;
      try {
        response = await shopifyClient.request(BULK_START_MUTATION, { variables: { query } });
      } catch (error) {
        throw new SyncOutcomeUnknownError('Bulk start response was lost; recovery required', error);
      }
      const payload = response?.data?.bulkOperationRunQuery;
      if (!response?.errors && payload?.userErrors?.length && !payload.bulkOperation) {
        await syncRunService.rejectBulkStart(scope);
        invalid('Bulk start rejected');
      }
      const operationId = payload?.bulkOperation?.id;
      if (response?.errors || payload?.userErrors?.length || !/^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/.test(operationId ?? ''))
        throw new SyncOutcomeUnknownError('Ambiguous bulk start response; recovery required');
      try {
        await syncRunService.recordBulkStartResponse({...scope,dispatchFence:prepared.dispatchFence,bulkOperationId:operationId});
        const confirmed = await syncRunService.prepareBulkStart(scope);
        if (confirmed.operationId !== operationId) throw new SyncOutcomeUnknownError('Bulk binding requires recovery');
      } catch (error) {
        throw new SyncOutcomeUnknownError('Bulk start binding could not be confirmed; recovery required', error);
      }
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

    /** Local fencing commits first. Input: owned run and optional reconciliation
     * hint. Output separates requested/cancelling/terminal cleanup and uncertainty.
     * A nonterminal result is not an error or a terminal acknowledgment. Caller
     * must keep durable cancellation intent eligible until exact terminal proof.
     */
    async cancelBulkQuery({ shopId, runId, reconcile = false }) {
      shop(shopId);
      const run = await syncRunService.getSyncRun({ shopId, runId });
      if (!run) invalid("Owned run required");
      await syncRunService.cancelGeneration({ shopId, generationId: run.generationId });
      const result=(observed=null)=>Object.freeze({
        cancelled:observed?.terminal===true,remote:observed?.terminal===true,
        state:observed?.terminal?'CANCELLED':observed?.status==='CANCELING'?'CANCELLING':'CANCELLATION_REQUESTED',
        cancelPending:observed?.terminal!==true,outcomeUncertain:!observed||!observed.terminal&&observed.status!=='CANCELING',
        remoteStatus:observed?.status??null,
      });
      // A missing binding does not prove that an interrupted start never reached
      // Shopify. Preserve cleanup uncertainty instead of adopting an orphan.
      if (!run.bulkOperationId) return result();
      const observe=async()=>boundBulkStatus(await shopifyClient.request(BULK_STATUS_QUERY,
        {variables:{id:run.bulkOperationId}}),run.bulkOperationId);
      try {
        if(reconcile){const current=await observe();if(current.terminal||current.status==='CANCELING')return result(current);}
        const observed=boundBulkStatus(await shopifyClient.request(BULK_CANCEL_MUTATION,
          {variables:{id:run.bulkOperationId}}),run.bulkOperationId,{cancellation:true});
        return result(observed);
      } catch {
        try{return result(await observe());}catch{return result();}
      }
    },

    /** Alias for cancelBulkCatalogExport */
    async cancelBulkCatalogExport({ shopId, runId, reconcile = false }) {
      return service.cancelBulkQuery({ shopId, runId, reconcile });
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
