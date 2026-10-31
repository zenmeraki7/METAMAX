import {
  transaction,
  staging,
  shop,
  token,
  integer,
  invalid,
} from "./transactions.server.js";
import {
  validateProducts,
  writeCatalogProducts,
} from "./catalog-writer.server.js";
function product(value) {
  if (
    typeof value !== "string" ||
    !/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(value)
  )
    invalid("Shopify product ID required");
}

export function createReconciliationService({ database, authorizeWrite }) {
  if (typeof database?.connect !== "function")
    throw new TypeError("PostgreSQL pool required");
  const service = Object.freeze({
    async recordWebhookReceipt({ shopId, eventId, topic, payloadHash }) {
      shop(shopId);
      if (typeof eventId !== "string" || !eventId || eventId.length > 255)
        invalid("Valid event identity required");
      if (typeof topic !== "string" || !topic || topic.length > 100)
        invalid("Valid webhook topic required");
      if (!/^[a-f0-9]{64}$/.test(payloadHash))
        invalid("Invalid event hash");
      return transaction(database, async (client) => {
        const existingReceipt = (
          await client.query(
            `SELECT payload_hash FROM mirror.webhook_receipts WHERE shop_id=$1 AND event_id=$2`,
            [shopId, eventId],
          )
        ).rows[0];
        if (existingReceipt) {
          if (existingReceipt.payload_hash !== payloadHash)
            invalid("Event identity reused for different intent");
          return { duplicate: true, eventId };
        }
        await client.query(
          `INSERT INTO mirror.webhook_receipts(shop_id,event_id,topic,payload_hash,received_at,processed_at)
          VALUES($1,$2,$3,$4,now(),now())`,
          [shopId, eventId, topic, payloadHash],
        );
        return { duplicate: false, eventId };
      });
    },
    async recordMutationEvent({
      shopId,
      productId,
      sourceKey,
      source = "WEBHOOK",
      deleted = false,
      payloadHash = null,
      syncRunId = null,
      eventId = null,
      topic = null,
    }) {
      shop(shopId);
      product(productId);
      if (
        typeof sourceKey !== "string" ||
        !sourceKey ||
        sourceKey.length > 255 ||
        typeof source !== "string" ||
        !source ||
        source.length > 80 ||
        typeof deleted !== "boolean"
      )
        invalid("Valid event identity required");
      if (payloadHash !== null && !/^[a-f0-9]{64}$/.test(payloadHash))
        invalid("Invalid event hash");
      if (eventId !== null && (typeof eventId !== "string" || !eventId || eventId.length > 255))
        invalid("Valid event identity required");
      return transaction(database, async (client) => {
        if (eventId) {
          const existingReceipt = (
            await client.query(
              `SELECT payload_hash FROM mirror.webhook_receipts WHERE shop_id=$1 AND event_id=$2`,
              [shopId, eventId],
            )
          ).rows[0];
          if (existingReceipt) {
            if (existingReceipt.payload_hash !== payloadHash)
              invalid("Event identity reused for different intent");
            return { duplicate: true, eventId, revision: 0n };
          }
          await client.query(
            `INSERT INTO mirror.webhook_receipts(shop_id,event_id,topic,payload_hash,received_at,processed_at)
            VALUES($1,$2,$3,$4,now(),now())`,
            [shopId, eventId, topic || source || "WEBHOOK", payloadHash || "0".repeat(64)],
          );
        }
        const duplicate = (
          await client.query(
            `SELECT * FROM mirror.mutation_journal WHERE shop_id=$1 AND source_key=$2`,
            [shopId, sourceKey],
          )
        ).rows[0];
        if (duplicate) {
          if (
            duplicate.product_id !== productId ||
            duplicate.payload_hash !== payloadHash ||
            duplicate.source !== source ||
            duplicate.deleted !== deleted
          )
            invalid("Event identity reused for different intent");
          return { revision: BigInt(duplicate.revision), duplicate: true };
        }
        const change = (
          await client.query(
            `INSERT INTO mirror.catalog_changes(shop_id,product_id,revision,applied_revision,dirty,deleted,updated_at)
          VALUES($1,$2,1,0,true,$3,now()) ON CONFLICT(shop_id,product_id) DO UPDATE SET
          revision=mirror.catalog_changes.revision+1,dirty=true,deleted=EXCLUDED.deleted,attempts=0,
          next_attempt_at=NULL,dead_letter_at=NULL,last_error=NULL,lease_token=NULL,lease_until=NULL,
          fence=mirror.catalog_changes.fence+1,updated_at=now() RETURNING revision`,
            [shopId, productId, deleted],
          )
        ).rows[0];
        await client.query(
          `INSERT INTO mirror.mutation_journal(shop_id,product_id,revision,source_key,source,deleted,payload_hash,sync_run_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            shopId,
            productId,
            change.revision,
            sourceKey,
            source,
            deleted,
            payloadHash,
            syncRunId,
          ],
        );
        return {
          revision: BigInt(change.revision),
          dirty: true,
          duplicate: false,
        };
      });
    },
    async scanDueDirtyProducts({ shopId, limit = 50 }) {
      shop(shopId);
      integer(limit, 1, 200, "scanner limit");
      const rows = (
        await database.query(
          `SELECT product_id AS "productId",revision,applied_revision AS "appliedRevision",dirty,deleted,attempts,fence
        FROM mirror.catalog_changes WHERE shop_id=$1 AND dirty AND dead_letter_at IS NULL
        AND (next_attempt_at IS NULL OR next_attempt_at<=now()) AND (lease_until IS NULL OR lease_until<=now())
        ORDER BY next_attempt_at ASC NULLS FIRST,product_id LIMIT $2`,
          [shopId, limit],
        )
      ).rows;
      return rows.map((r) => ({
        ...r,
        revision: BigInt(r.revision),
        appliedRevision: BigInt(r.appliedRevision),
        fence: BigInt(r.fence),
      }));
    },
    async claimDirtyProduct({ shopId, productId, workerId, leaseMs = 30000 }) {
      shop(shopId);
      product(productId);
      token(workerId);
      integer(leaseMs, 1000, 300000, "lease duration");
      return transaction(database, async (client) => {
        const row = (
          await client.query(
            `UPDATE mirror.catalog_changes SET lease_token=$3,
          lease_until=clock_timestamp()+$4::integer*interval '1 millisecond',fence=fence+1
          WHERE shop_id=$1 AND product_id=$2 AND dirty AND dead_letter_at IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at<=now()) AND (lease_until IS NULL OR lease_until<=now())
          RETURNING revision,applied_revision,fence,deleted`,
            [shopId, productId, workerId, leaseMs],
          )
        ).rows[0];
        return row
          ? {
              revision: BigInt(row.revision),
              appliedRevision: BigInt(row.applied_revision),
              fence: BigInt(row.fence),
              deleted: row.deleted,
            }
          : null;
      });
    },
    async reconcileProduct({
      shopId,
      generationId,
      productId,
      observedRevision,
      productPayload = null,
      deleted = false,
      workerId,
      fence,
    }) {
      shop(shopId);
      product(productId);
      token(workerId);
      const rev = BigInt(observedRevision);
      if (
        rev <= 0n ||
        typeof deleted !== "boolean" ||
        (!deleted && !productPayload)
      )
        invalid("Authoritative product or explicit deletion required");
      if (!deleted) {
        validateProducts([productPayload]);
        if (productPayload.id !== productId)
          invalid("Reread product identity mismatch");
      }
      return transaction(database, async (client) => {
        await staging(client, shopId, generationId, ["RECONCILING"]);
        if (authorizeWrite) await authorizeWrite(client);
        const applied = await client.query(
          `UPDATE mirror.catalog_changes SET applied_revision=$3,dirty=false,deleted=$6,
          next_attempt_at=NULL,last_error=NULL,attempts=0,lease_token=NULL,lease_until=NULL
          WHERE shop_id=$1 AND product_id=$2 AND revision=$3 AND applied_revision<$3 AND dirty
          AND fence=$4 AND lease_token=$5 AND lease_until>clock_timestamp()`,
          [
            shopId,
            productId,
            rev.toString(),
            fence.toString(),
            workerId,
            deleted,
          ],
        );
        if (applied.rowCount !== 1) return { applied: false, superseded: true };
        if (deleted) {
          // Tombstone intent stays in catalog_changes/journal, never in searchable rows.
          await client.query(
            `DELETE FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3`,
            [shopId, generationId, productId],
          );
        } else {
          // This generation currently advertises products/variants only. Drop
          // obsolete dependent projections rather than retaining stale relations.
          for (const sql of [
            `DELETE FROM mirror.product_collections WHERE shop_id=$1 AND generation_id=$2 AND product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3)`,
            `DELETE FROM mirror.product_options WHERE shop_id=$1 AND generation_id=$2 AND product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3)`,
            `DELETE FROM mirror.metafield_values WHERE shop_id=$1 AND generation_id=$2 AND (product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3) OR variant_id IN (SELECT v.id FROM mirror.variants v JOIN mirror.products p ON p.shop_id=v.shop_id AND p.generation_id=v.generation_id AND p.id=v.product_id WHERE p.shop_id=$1 AND p.generation_id=$2 AND p.shopify_id=$3))`,
          ])
            await client.query(sql, [shopId, generationId, productId]);
          await writeCatalogProducts({
            client,
            shopId,
            generationId,
            records: [
              {
                ...productPayload,
                sourceRevision: rev.toString(),
                variants: productPayload.variants.map((v) => ({
                  ...v,
                  sourceRevision: rev.toString(),
                })),
              },
            ],
          });
        }
        await client.query(
          `UPDATE mirror.mutation_journal SET applied_at=now() WHERE shop_id=$1 AND product_id=$2 AND revision<=$3 AND applied_at IS NULL`,
          [shopId, productId, rev.toString()],
        );
        return { applied: true, revision: rev };
      });
    },
    async recordFailure({
      shopId,
      productId,
      fence,
      error,
      maxAttempts = 8,
      backoffBaseMs = 1000,
    }) {
      shop(shopId);
      product(productId);
      integer(maxAttempts, 1, 20, "attempt limit");
      integer(backoffBaseMs, 1, 60000, "backoff");
      return transaction(
        database,
        async (client) =>
          (
            await client.query(
              `UPDATE mirror.catalog_changes SET attempts=attempts+1,
        last_error=$4,lease_token=NULL,lease_until=NULL,
        dead_letter_at=CASE WHEN attempts+1 >= $5 THEN now() ELSE NULL END,
        next_attempt_at=CASE WHEN attempts+1 >= $5 THEN NULL ELSE now()+LEAST(3600000::numeric,$6::numeric*power(2,LEAST(attempts,20)))*interval '1 millisecond' END
        WHERE shop_id=$1 AND product_id=$2 AND fence=$3 AND dirty AND dead_letter_at IS NULL
        RETURNING attempts,dead_letter_at,next_attempt_at`,
              [
                shopId,
                productId,
                fence.toString(),
                String(error?.message ?? error).slice(0, 2000),
                maxAttempts,
                backoffBaseMs,
              ],
            )
          ).rows[0] ?? null,
      );
    },
    /** Scheduling tokens never supply authoritative revisions or deletion state. */
    async reconcileLatestProduct({
      shopId,
      generationId,
      productId,
      workerId,
      fetchProduct,
      signal,
    }) {
      if (typeof fetchProduct !== "function")
        throw new TypeError("Complete authoritative product reader required");
      signal?.throwIfAborted();
      const claim = await service.claimDirtyProduct({
        shopId,
        productId,
        workerId,
      });
      if (!claim) return { applied: false, skipped: true };
      try {
        const snapshot = await fetchProduct({ shopId, productId, signal });
        signal?.throwIfAborted();
        // Adapter must finish every variant page; partial responses must reject.
        if (
          !snapshot ||
          snapshot.complete !== true ||
          !(snapshot.product === null || typeof snapshot.product === "object")
        )
          invalid("Complete authoritative reread required");
        return await service.reconcileProduct({
          shopId,
          generationId,
          productId,
          workerId,
          fence: claim.fence,
          observedRevision: claim.revision,
          deleted: snapshot.product === null,
          productPayload: snapshot.product,
        });
      } catch (error) {
        await service.recordFailure({
          shopId,
          productId,
          fence: claim.fence,
          error,
        });
        throw error;
      }
    },
  });
  return service;
}
