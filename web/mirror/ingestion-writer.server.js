import { createHash } from "node:crypto";
import {
  validateProducts,
  writeCatalogProducts,
} from "./catalog-writer.server.js";
import { runLease, invalid, integer } from "./transactions.server.js";
export function createIngestionWriter({ syncRunService }) {
  if (typeof syncRunService?.recordCheckpoint !== "function")
    throw new TypeError("Sync run service required");
  return Object.freeze({
    async writeStagingBatch({
      client,
      shopId,
      generationId,
      runId,
      fence,
      ordinal,
      records,
    }) {
      validateProducts(records);
      integer(ordinal, 0, 2147483647, "ordinal");
      const checksum = createHash("sha256")
        .update(JSON.stringify(records))
        .digest("hex");
      const lineCount = records.reduce((n, p) => n + 1 + p.variants.length, 0);
      await runLease(client, { shopId, generationId, runId, fence });
      const checkpoint = (
        await client.query(
          `SELECT checksum,line_count FROM mirror.ingestion_chunks WHERE shop_id=$1 AND run_id=$2 AND ordinal=$3`,
          [shopId, runId, ordinal],
        )
      ).rows[0];
      if (checkpoint) {
        if (
          checkpoint.checksum !== checksum ||
          BigInt(checkpoint.line_count) !== BigInt(lineCount)
        )
          invalid("Resumed chunk input changed");
        return { lineCount, replayed: true, checksum };
      }
      if (
        (
          await client.query(
            `SELECT 1 FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=ANY($3::text[]) LIMIT 1`,
            [shopId, generationId, records.map((p) => p.id)],
          )
        ).rowCount
      )
        invalid("Duplicate product across import chunks");
      await writeCatalogProducts({ client, shopId, generationId, records });
      await syncRunService.recordCheckpoint({
        client,
        shopId,
        runId,
        fence,
        ordinal,
        checksum,
        lineCount: BigInt(lineCount),
      });
      return {
        productCount: records.length,
        variantCount: lineCount - records.length,
        lineCount,
        checksum,
        replayed: false,
      };
    },
  });
}
