import {
  createBulkSyncService,
  PRODUCTS_BULK_QUERY,
  BULK_STATUS_QUERY,
  BULK_START_MUTATION,
  BULK_CANCEL_MUTATION,
} from "./bulk-sync.server.js";
import { createJsonlIngestionService } from "./jsonl-ingestion.server.js";

export {
  PRODUCTS_BULK_QUERY,
  BULK_STATUS_QUERY,
  BULK_START_MUTATION,
  BULK_CANCEL_MUTATION,
};

export function createBulkOperationRunner({
  shopifyClient,
  syncRunService,
  ingestionWriter,
  database,
}) {
  const bulkSync = createBulkSyncService({ shopifyClient, syncRunService });
  const jsonlIngestion = createJsonlIngestionService({
    syncRunService,
    ingestionWriter,
    database,
    shopifyClient,
    bulkSyncService: bulkSync,
  });

  return Object.freeze({
    async cancelBulkCatalogExport({ shopId, runId }) {
      return bulkSync.cancelBulkQuery({ shopId, runId });
    },
    async initiateBulkCatalogExport({ shopId, syncRun }) {
      return bulkSync.startBulkQuery({ shopId, syncRun });
    },
    async ingestJsonlLines(options) {
      return jsonlIngestion.ingestJsonlLines(options);
    },
    async completeEmptyStoreIngestion(options) {
      return jsonlIngestion.completeEmptyStoreIngestion(options);
    },
    bulkSync,
    jsonlIngestion,
  });
}
