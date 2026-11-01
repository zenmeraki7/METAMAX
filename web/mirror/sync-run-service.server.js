import { randomUUID, createHash } from "node:crypto";
import { getInstalledFilterSchemaOptions } from "../services/filter-schema.server.js";
import {
  transaction,
  lockMirror,
  staging,
  shop,
  token,
  integer,
  invalid,
  assertIngestionExecution,
} from "./transactions.server.js";

export function createSyncRunService({ database }) {
  if (typeof database?.connect !== "function")
    throw new TypeError("PostgreSQL pool required");
  async function lockedRun(client, shopId, runId, fence) {
    shop(shopId);
    await lockMirror(client,shopId);
    const row = (
      await client.query(
        `SELECT r.*, r.lease_until > clock_timestamp() AS live, g.status AS generation_status
      FROM mirror.ingestion_runs r JOIN mirror.generations g ON g.shop_id=r.shop_id AND g.id=r.generation_id
      WHERE r.shop_id=$1 AND r.id=$2 FOR UPDATE OF r,g`,
        [shopId, runId],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== "RUNNING" ||
      !row.live ||
      row.generation_status !== "INGESTING" ||
      BigInt(row.fence) !== BigInt(fence)
    )
      invalid("Expired or superseded run");
    await staging(client, shopId, row.generation_id, ["INGESTING"]);
    await assertIngestionExecution(client, row);
    return row;
  }
  async function bindBulkOperationIdInTransaction({client,shopId,runId,fence,bulkOperationId}) {
    if(typeof bulkOperationId!=="string"||!/^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/.test(bulkOperationId))invalid("Bulk operation ID required");
    const run=await lockedRun(client,shopId,runId,fence);
    if(run.bulk_operation_id&&run.bulk_operation_id!==bulkOperationId)invalid("Cannot replace run input");
    await client.query("UPDATE mirror.ingestion_runs SET bulk_operation_id=$3 WHERE shop_id=$1 AND id=$2",[shopId,runId,bulkOperationId]);
  }
  return Object.freeze({
    bindBulkOperationIdInTransaction,
    async startIngestionRun({
      shopId,
      dataset = "products",
      workerId,
      leaseMs = 60000,
      requiredDatasets = ["products", "variants"],
      client: suppliedClient,
    } = {}) {
      shop(shopId);
      token(workerId);
      integer(leaseMs, 1000, 300000, "lease duration");
      const SUPPORTED_DATASETS = new Set([
        "products",
        "variants",
        "inventory_items",
        "inventory_levels",
        "locations",
        "collections",
        "product_options",
        "categories",
        "metafields",
      ]);
      if (
        !SUPPORTED_DATASETS.has(dataset) ||
        !Array.isArray(requiredDatasets) ||
        requiredDatasets.length === 0 ||
        !requiredDatasets.includes("products") ||
        (requiredDatasets.includes("products") &&
          !requiredDatasets.includes("variants")) ||
        !requiredDatasets.includes(dataset) ||
        requiredDatasets.some((d) => !SUPPORTED_DATASETS.has(d))
      )
        invalid("Unsupported dataset replacement contract");
      const allocate = async (client) => {
        await lockMirror(client,shopId);
        if (
          !(
            await client.query(
              `SELECT id FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR UPDATE`,
              [shopId],
            )
          ).rowCount
        )
          invalid("Active installation required");
        let generation = (
          await client.query(
            `SELECT * FROM mirror.generations WHERE shop_id=$1
          AND status IN ('INGESTING','RECONCILING','VERIFIED') ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
            [shopId],
          )
        ).rows[0];
        if (generation && generation.status !== "INGESTING")
          invalid("Finish or cancel existing staging generation");
        if (!generation) {
          const versions = getInstalledFilterSchemaOptions();
          generation = (
            await client.query(
              `INSERT INTO mirror.generations
            (shop_id,id,coverage_revision,status,mirror_schema_version,source_contract_version,mapping_version,required_datasets)
            VALUES ($1,$2,$3,'INGESTING',$4,$5,$6,$7) RETURNING *`,
              [
                shopId,
                randomUUID(),
                randomUUID(),
                versions.mirrorSchemaVersion,
                versions.sourceContractVersion,
                "mapping_v1",
                requiredDatasets,
              ],
            )
          ).rows[0];
          // Requeue even clean rows: their previous acknowledgements may belong
          // to failed staging. Revisions stay monotonic; journal intent is retained.
          await client.query(
            `WITH changes AS (UPDATE mirror.catalog_changes SET revision=revision+1,dirty=true,
            attempts=0,next_attempt_at=NULL,dead_letter_at=NULL,lease_token=NULL,lease_until=NULL,fence=fence+1,updated_at=now()
            WHERE shop_id=$1 RETURNING product_id,revision)
            INSERT INTO mirror.mutation_journal(shop_id,product_id,revision,source_key,source)
            SELECT $1,product_id,revision,$2::text||':'||product_id,'GENERATION_REPLAY' FROM changes`,
            [shopId, generation.id],
          );
        }
        await staging(client, shopId, generation.id, ["INGESTING"]);
        const existing = (
          await client.query(
            `SELECT *,lease_until>clock_timestamp() AS live FROM mirror.ingestion_runs WHERE shop_id=$1 AND generation_id=$2 AND dataset=$3 FOR UPDATE`,
            [shopId, generation.id, dataset],
          )
        ).rows[0];
        let run;
        if (existing) {
          if (existing.execution_id) invalid("Phase-managed ingestion must be claimed through its catalog execution");
          if (existing.status === "CANCELLED")
            invalid("Cancelled runs cannot resume");
          if (existing.status === "SUCCEEDED") run = existing;
          else {
            if (BigInt(existing.fence) >= 20n)
              invalid(
                "Run resume limit reached; cancel and restart generation",
              );
            if (existing.live && existing.lease_token !== workerId)
              invalid("Run already leased");
            run = (
              await client.query(
                `UPDATE mirror.ingestion_runs SET status='RUNNING',lease_token=$3,
              lease_until=clock_timestamp()+$4::integer*interval '1 millisecond',fence=fence+1,last_error=NULL
              WHERE shop_id=$1 AND id=$2 RETURNING *`,
                [shopId, existing.id, workerId, leaseMs],
              )
            ).rows[0];
          }
        } else
          run = (
            await client.query(
              `INSERT INTO mirror.ingestion_runs
          (shop_id,generation_id,dataset,status,lease_token,lease_until,fence)
          VALUES ($1,$2,$3,'RUNNING',$4,clock_timestamp()+$5::integer*interval '1 millisecond',1) RETURNING *`,
              [shopId, generation.id, dataset, workerId, leaseMs],
            )
          ).rows[0];
        return {
          runId: run.id,
          generationId: generation.id,
          dataset: run.dataset,
          status: run.status,
          bulkOperationId: run.bulk_operation_id,
          fence: run.fence,
          processedLines: BigInt(run.processed_lines),
        };
      };
      return suppliedClient ? allocate(suppliedClient) : transaction(database, allocate, shopId);
    },
    async bindBulkOperationId({ shopId, runId, fence, bulkOperationId }) {
      if (
        typeof bulkOperationId !== "string" ||
        !/^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/.test(bulkOperationId)
      )
        invalid("Bulk operation ID required");
      return transaction(database, async (client) => {
        const run = await lockedRun(client, shopId, runId, fence);
        if (run.bulk_operation_id && run.bulk_operation_id !== bulkOperationId)
          invalid("Cannot replace run input");
        await client.query(
          `UPDATE mirror.ingestion_runs SET bulk_operation_id=$3 WHERE shop_id=$1 AND id=$2`,
          [shopId, runId, bulkOperationId],
        );
      }, shopId);
    },
    async renewRunLease({ shopId, runId, fence, workerId, leaseMs = 60000 }) {
      integer(leaseMs, 1000, 300000, "lease duration");
      token(workerId);
      return transaction(database, async (client) => {
        const run = await lockedRun(client, shopId, runId, fence);
        if (run.lease_token !== workerId) invalid("Wrong lease owner");
        await client.query(
          `UPDATE mirror.ingestion_runs SET lease_until=clock_timestamp()+$3::integer*interval '1 millisecond' WHERE shop_id=$1 AND id=$2`,
          [shopId, runId, leaseMs],
        );
        return true;
      }, shopId);
    },
    async recordCheckpoint({
      client,
      shopId,
      runId,
      fence,
      ordinal,
      checksum,
      lineCount,
    }) {
      const run = await lockedRun(client, shopId, runId, fence);
      integer(ordinal, 0, 2147483647, "chunk ordinal");
      if (!/^[a-f0-9]{64}$/.test(checksum) || BigInt(lineCount) <= 0n)
        invalid("Invalid checkpoint");
      const previous = (
        await client.query(
          `SELECT count(*)::integer AS chunks,COALESCE(sum(line_count),0)::text AS lines FROM mirror.ingestion_chunks WHERE shop_id=$1 AND run_id=$2`,
          [shopId, runId],
        )
      ).rows[0];
      if (
        previous.chunks !== ordinal ||
        BigInt(previous.lines) !== BigInt(run.processed_lines)
      )
        invalid("Checkpoint sequence/count mismatch");
      await client.query(
        `INSERT INTO mirror.ingestion_chunks(shop_id,run_id,ordinal,checksum,line_count) VALUES($1,$2,$3,$4,$5)`,
        [shopId, runId, ordinal, checksum, lineCount.toString()],
      );
      const result = await client.query(
        `UPDATE mirror.ingestion_runs SET processed_lines=processed_lines+$3::bigint WHERE shop_id=$1 AND id=$2 RETURNING processed_lines`,
        [shopId, runId, lineCount.toString()],
      );
      return BigInt(result.rows[0].processed_lines);
    },
    async completeIngestionRun({
      client,
      shopId,
      runId,
      fence,
      expectedLines,
      processedLines,
      invalidLines = 0n,
      eofVerified = false,
    }) {
      const run = await lockedRun(client, shopId, runId, fence);
      const exp = BigInt(expectedLines),
        proc = BigInt(processedLines);
      const counts = (
        await client.query(
          `SELECT COALESCE(sum(line_count),0)::text AS lines,count(*)::integer AS chunks,
        COALESCE(max(ordinal),-1) AS last FROM mirror.ingestion_chunks WHERE shop_id=$1 AND run_id=$2`,
          [shopId, runId],
        )
      ).rows[0];
      if (
        exp < 0n ||
        exp !== proc ||
        proc !== BigInt(run.processed_lines) ||
        proc !== BigInt(counts.lines) ||
        counts.last !== counts.chunks - 1 ||
        BigInt(run.invalid_lines) !== 0n ||
        BigInt(invalidLines) !== 0n ||
        !eofVerified
      )
        invalid("Durable ingestion is incomplete");
      await client.query(
        `UPDATE mirror.ingestion_runs SET status='SUCCEEDED',expected_lines=$3,invalid_lines=0,eof_verified=true,
        writes_finished_at=now(),lease_token=NULL,lease_until=NULL WHERE shop_id=$1 AND id=$2`,
        [shopId, runId, exp.toString()],
      );
      // For products stream, variants are also certified in the same run if required.
      const genRow = (
        await client.query(
          `SELECT required_datasets FROM mirror.generations WHERE shop_id=$1 AND id=$2`,
          [shopId, run.generation_id],
        )
      ).rows[0];
      const required = genRow?.required_datasets || [];
      if (run.dataset === "products" && required.includes("variants")) {
        await client.query(
          `INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at)
          VALUES($1,$2,'variants','SUCCEEDED',$3,$3,true,now())
          ON CONFLICT(shop_id,generation_id,dataset) DO UPDATE SET
            status='SUCCEEDED',expected_lines=EXCLUDED.expected_lines,processed_lines=EXCLUDED.processed_lines,
            eof_verified=true,writes_finished_at=now()`,
          [shopId, run.generation_id, exp.toString()],
        );
      }
      return true;
    },
    async transitionGenerationToReconciling({ client, shopId, generationId }) {
      await staging(client, shopId, generationId, ["INGESTING"]);
      await client.query(
        `UPDATE mirror.generations SET status='RECONCILING' WHERE shop_id=$1 AND id=$2`,
        [shopId, generationId],
      );
      return true;
    },
    async completeCoverageAndVerify({ client, shopId, generationId }) {
      const gen = await staging(client, shopId, generationId, ["RECONCILING"]);
      if (
        (
          await client.query(
            `SELECT 1 FROM mirror.catalog_changes WHERE shop_id=$1 AND dirty LIMIT 1`,
            [shopId],
          )
        ).rowCount
      )
        invalid("Unreconciled mutations remain");

      const DATASET_COUNT_QUERIES = {
        products: `SELECT count(*)::text AS count FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND deleted_at IS NULL`,
        variants: `SELECT count(*)::text AS count FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2 AND deleted_at IS NULL`,
        inventory_items: `SELECT count(*)::text AS count FROM mirror.inventory_items WHERE shop_id=$1 AND generation_id=$2`,
        locations: `SELECT count(*)::text AS count FROM mirror.locations WHERE shop_id=$1 AND generation_id=$2`,
        inventory_levels: `SELECT count(*)::text AS count FROM mirror.inventory_levels WHERE shop_id=$1 AND generation_id=$2`,
        collections: `SELECT count(*)::text AS count FROM mirror.collections WHERE shop_id=$1 AND generation_id=$2`,
        product_options: `SELECT count(*)::text AS count FROM mirror.product_options WHERE shop_id=$1 AND generation_id=$2`,
        categories: `SELECT count(*)::text AS count FROM mirror.categories WHERE shop_id=$1 AND generation_id=$2`,
        metafields: `SELECT count(*)::text AS count FROM mirror.metafield_values WHERE shop_id=$1 AND generation_id=$2`,
      };

      const requiredDatasets = gen.required_datasets || ["products", "variants"];
      for (const name of requiredDatasets) {
        const sql = DATASET_COUNT_QUERIES[name];
        if (!sql) invalid(`Unknown required dataset: ${name}`);
        const count = (await client.query(sql, [shopId, generationId])).rows[0]
          .count;
        const hash = createHash("sha256")
          .update(JSON.stringify([shopId, generationId, name, count]))
          .digest("hex");
        await client.query(
          `INSERT INTO mirror.coverage(shop_id,generation_id,name,status,durable_rows,verified_at,verification_hash)
          VALUES($1,$2,$3,'COMPLETE',$4,now(),$5) ON CONFLICT(shop_id,generation_id,name) DO UPDATE
          SET status='COMPLETE',durable_rows=EXCLUDED.durable_rows,verified_at=now(),verification_hash=EXCLUDED.verification_hash`,
          [shopId, generationId, name, count, hash],
        );
      }
      await client.query(
        `UPDATE mirror.generations SET status='VERIFIED',verified_at=now() WHERE shop_id=$1 AND id=$2`,
        [shopId, generationId],
      );
      return true;
    },
    async publishGeneration({
      client,
      shopId,
      generationId,
      expectedGenerationId,
    }) {
      const generation = await staging(client, shopId, generationId, [
        "VERIFIED",
      ]);
      if (expectedGenerationId === undefined)
        invalid(
          "Expected current publication required (null for first publication)",
        );
      const current =
        (
          await client.query(
            `SELECT generation_id FROM mirror.publications WHERE shop_id=$1`,
            [shopId],
          )
        ).rows[0]?.generation_id ?? null;
      if (current !== expectedGenerationId)
        invalid("Publication was superseded");
      if (
        (
          await client.query(
            `SELECT 1 FROM mirror.catalog_changes WHERE shop_id=$1 AND dirty LIMIT 1`,
            [shopId],
          )
        ).rowCount
      )
        invalid("New mutations arrived after verification");
      if (
        current &&
        (
          await client.query(
            `SELECT 1 FROM mirror.generations old WHERE old.shop_id=$1 AND old.id=$2 AND
        (old.created_at,old.id)>=($3::timestamptz,$4::text)`,
            [shopId, current, generation.created_at, generationId],
          )
        ).rowCount
      )
        invalid("Older snapshot cannot replace newer publication");
      await client.query(
        `UPDATE mirror.generations SET status='PUBLISHED',published_at=now(),retain_until=GREATEST(retain_until,now()+interval '25 hours') WHERE shop_id=$1 AND id=$2`,
        [shopId, generationId],
      );
      await client.query(
        `INSERT INTO mirror.publications(shop_id,generation_id,coverage_revision,mapping_version)
        VALUES($1,$2,$3,$4) ON CONFLICT(shop_id) DO UPDATE SET generation_id=EXCLUDED.generation_id,
        coverage_revision=EXCLUDED.coverage_revision,mapping_version=EXCLUDED.mapping_version,published_at=now()`,
        [
          shopId,
          generationId,
          generation.coverage_revision,
          generation.mapping_version,
        ],
      );
      return true;
    },
    async failIngestionRun({ shopId, runId, fence, error }) {
      return transaction(database, async (client) => {
        await lockedRun(client, shopId, runId, fence);
        await client.query(
          `UPDATE mirror.ingestion_runs SET status='FAILED',last_error=$3,lease_token=NULL,lease_until=NULL WHERE shop_id=$1 AND id=$2`,
          [shopId, runId, String(error?.message ?? error).slice(0, 2000)],
        );
      }, shopId);
    },
    async cancelGeneration({ shopId, generationId }) {
      return transaction(database, async (client) => {
        const gen = await staging(client, shopId, generationId, [
          "INGESTING",
          "RECONCILING",
          "VERIFIED",
          "FAILED",
          "RETIRED",
        ]);
        if (["FAILED", "RETIRED"].includes(gen.status)) return true;
        if (gen.status !== "VERIFIED")
          await client.query(
            `UPDATE mirror.ingestion_runs SET status='CANCELLED',fence=fence+1,lease_token=NULL,lease_until=NULL WHERE shop_id=$1 AND generation_id=$2 AND status<>'SUCCEEDED'`,
            [shopId, generationId],
          );
        await client.query(
          `UPDATE mirror.generations SET status=$3::mirror."GenerationStatus",retain_until=GREATEST(retain_until,now()+interval '25 hours') WHERE shop_id=$1 AND id=$2`,
          [
            shopId,
            generationId,
            gen.status === "VERIFIED" ? "RETIRED" : "FAILED",
          ],
        );
        return true;
      }, shopId);
    },
    async retainGeneration({ shopId, generationId, until }) {
      const date = new Date(until);
      if (
        !Number.isFinite(date.getTime()) ||
        date.getTime() <= Date.now() ||
        date.getTime() > Date.now() + 7 * 86400000
      )
        invalid("Bounded retention required");
      return transaction(database, async (client) => {
        await staging(client, shopId, generationId, ["PUBLISHED"]);
        await client.query(
          `UPDATE mirror.generations SET retain_until=GREATEST(retain_until,$3) WHERE shop_id=$1 AND id=$2`,
          [shopId, generationId, date],
        );
      }, shopId);
    },
    async reclaimGeneration({ shopId, generationId }) {
      return transaction(database, async (client) => {
        const gen = await staging(client, shopId, generationId, [
          "FAILED",
          "RETIRED",
          "PUBLISHED",
        ]);
        if (
          !gen.retain_until ||
          new Date(gen.retain_until).getTime() > Date.now()
        )
          invalid("Generation is retained");
        if (
          (
            await client.query(
              `SELECT 1 FROM mirror.publications WHERE shop_id=$1 AND generation_id=$2 UNION ALL SELECT 1 FROM mirror.selection_snapshots WHERE shop_id=$1 AND generation_id=$2 LIMIT 1`,
              [shopId, generationId],
            )
          ).rowCount
        )
          invalid("Generation remains referenced");
        if (gen.status === "PUBLISHED")
          await client.query(
            `UPDATE mirror.generations SET status='RETIRED',retired_at=now() WHERE shop_id=$1 AND id=$2`,
            [shopId, generationId],
          );
        await client.query(
          `DELETE FROM mirror.generations WHERE shop_id=$1 AND id=$2`,
          [shopId, generationId],
        );
      }, shopId);
    },
    async getSyncRun({ shopId, runId }) {
      shop(shopId);
      return (
        (
          await database.query(
            `SELECT id AS "runId",shop_id AS "shopId",generation_id AS "generationId",dataset,status,
        bulk_operation_id AS "bulkOperationId",fence,processed_lines AS "processedLines",lease_token AS "leaseToken"
        FROM mirror.ingestion_runs WHERE shop_id=$1 AND id=$2`,
            [shopId, runId],
          )
        ).rows[0] ?? null
      );
    },
  });
}
