import {
  transaction,
  shop,
  token,
  integer,
  invalid,
} from "./transactions.server.js";
import { writeCatalogProducts } from "./catalog-writer.server.js";
import { FILTER_SQL_SCHEMA } from "../fields/sources.js";

function productGid(value) {
  if (
    typeof value !== "string" ||
    !/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(value)
  ) {
    invalid("Shopify product ID required");
  }
}

export function createReconciliationRepository({ database }) {
  if (typeof database?.connect !== "function") {
    throw new TypeError("PostgreSQL pool required");
  }

  return Object.freeze({
    async claimNext({ workerId, leaseSeconds = 120, shopId = null, generationId = null }) {
      token(workerId);
      integer(leaseSeconds, 10, 3600, "lease duration");
      if (shopId !== null) shop(shopId);
      if (generationId !== null) token(generationId);

      return transaction(database, async (client) => {
        let targetGenId = generationId;
        let targetShopId = shopId;

        // 1. Resolve destination staging generation
        if (targetGenId && targetShopId) {
          const gen = (
            await client.query(
              `SELECT id, status FROM mirror.generations
               WHERE shop_id = $1 AND id = $2 AND status IN ('INGESTING', 'RECONCILING')
               FOR UPDATE`,
              [targetShopId, targetGenId],
            )
          ).rows[0];
          if (!gen) return null;
        } else if (targetShopId) {
          const gen = (
            await client.query(
              `SELECT id FROM mirror.generations
               WHERE shop_id = $1 AND status IN ('INGESTING', 'RECONCILING')
               ORDER BY created_at DESC LIMIT 1`,
              [targetShopId],
            )
          ).rows[0];
          if (!gen) return null;
          targetGenId = gen.id;
        } else {
          const gen = (
            await client.query(
              `SELECT g.id, g.shop_id FROM mirror.generations g
               JOIN mirror.catalog_changes c ON c.shop_id = g.shop_id
               WHERE g.status IN ('INGESTING', 'RECONCILING')
                 AND c.dirty
                 AND c.dead_letter_at IS NULL
                 AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= clock_timestamp())
                 AND (c.lease_until IS NULL OR c.lease_until <= clock_timestamp())
               ORDER BY g.created_at DESC LIMIT 1`,
            )
          ).rows[0];
          if (!gen) return null;
          targetGenId = gen.id;
          targetShopId = gen.shop_id;
        }

        // 2. Atomically lock and claim one due dirty product
        const row = (
          await client.query(
            `WITH next_row AS (
               SELECT shop_id, product_id FROM mirror.catalog_changes
               WHERE shop_id = $1
                 AND dirty
                 AND dead_letter_at IS NULL
                 AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
                 AND (lease_until IS NULL OR lease_until <= clock_timestamp())
               ORDER BY next_attempt_at ASC NULLS FIRST, product_id
               LIMIT 1
               FOR UPDATE SKIP LOCKED
             )
             UPDATE mirror.catalog_changes c
             SET lease_token = $2,
                 lease_until = clock_timestamp() + $3::integer * interval '1 second',
                 fence = fence + 1,
                 updated_at = clock_timestamp()
             FROM next_row
             WHERE c.shop_id = next_row.shop_id AND c.product_id = next_row.product_id
             RETURNING c.shop_id, c.product_id, c.revision, c.applied_revision, c.fence, c.attempts, c.deleted`,
            [targetShopId, workerId, leaseSeconds],
          )
        ).rows[0];

        if (!row) return null;

        return Object.freeze({
          shopId: row.shop_id,
          productId: row.product_id,
          generationId: targetGenId,
          leaseToken: workerId,
          revision: String(row.revision),
          fence: BigInt(row.fence),
          attempt: row.attempts,
        });
      });
    },

    async recordFailure({ claim, code, retryable, retryAfterSeconds }) {
      if (!claim || typeof claim !== "object") invalid("Claim required");
      shop(claim.shopId);
      productGid(claim.productId);
      if (typeof code !== "string" || !code) invalid("Failure code required");

      return transaction(database, async (client) => {
        const row = (
          await client.query(
            `UPDATE mirror.catalog_changes
             SET attempts = attempts + 1,
                 last_error = $4,
                 lease_token = NULL,
                 lease_until = NULL,
                 dead_letter_at = CASE WHEN $5::boolean = false OR attempts + 1 >= 10 THEN clock_timestamp() ELSE NULL END,
                 next_attempt_at = CASE WHEN $5::boolean = false OR attempts + 1 >= 10 THEN NULL ELSE clock_timestamp() + $6::integer * interval '1 second' END,
                 updated_at = clock_timestamp()
             WHERE shop_id = $1
               AND product_id = $2
               AND fence = $3
               AND dirty
               AND dead_letter_at IS NULL
             RETURNING attempts, dead_letter_at, next_attempt_at`,
            [
              claim.shopId,
              claim.productId,
              String(claim.fence),
              code.slice(0, 2000),
              Boolean(retryable),
              retryAfterSeconds && Number.isSafeInteger(retryAfterSeconds) ? retryAfterSeconds : 0,
            ],
          )
        ).rows[0];

        return { updated: Boolean(row) };
      });
    },

    async commitReconciliation({ claim, observedRevision, replacement }) {
      if (!claim || typeof claim !== "object") invalid("Claim required");
      shop(claim.shopId);
      productGid(claim.productId);
      token(claim.generationId);
      token(claim.leaseToken);
      const rev = BigInt(observedRevision);

      return transaction(database, async (client) => {
        // 1. Destination generation check
        const gen = (
          await client.query(
            `SELECT id, status, mirror_schema_version, source_contract_version, mapping_version
             FROM mirror.generations
             WHERE shop_id = $1 AND id = $2
             FOR UPDATE`,
            [claim.shopId, claim.generationId],
          )
        ).rows[0];

        if (!gen || !["INGESTING", "RECONCILING"].includes(gen.status)) {
          return { kind: "GENERATION_UNAVAILABLE" };
        }

        if (
          gen.mirror_schema_version !== FILTER_SQL_SCHEMA.mirrorSchemaVersion ||
          gen.source_contract_version !== FILTER_SQL_SCHEMA.sourceContractVersion ||
          gen.mapping_version !== "mapping_v1"
        ) {
          return { kind: "GENERATION_UNAVAILABLE" };
        }

        // 2. Destination generation revision receipt check
        const receipt = (
          await client.query(
            `SELECT revision, deleted
             FROM mirror.generation_product_revisions
             WHERE shop_id = $1 AND generation_id = $2 AND product_id = $3
             FOR UPDATE`,
            [claim.shopId, claim.generationId, claim.productId],
          )
        ).rows[0];

        if (receipt && BigInt(receipt.revision) >= rev) {
          return { kind: "SUPERSEDED" };
        }

        // 3. Fencing & Lease check on mirror.catalog_changes
        const change = (
          await client.query(
            `SELECT revision, applied_revision, fence, lease_token, lease_until
             FROM mirror.catalog_changes
             WHERE shop_id = $1 AND product_id = $2
             FOR UPDATE`,
            [claim.shopId, claim.productId],
          )
        ).rows[0];

        if (!change) {
          return { kind: "SUPERSEDED" };
        }

        if (change.lease_token !== claim.leaseToken) {
          return { kind: "LEASE_LOST" };
        }

        if (claim.fence != null && BigInt(change.fence) !== BigInt(claim.fence)) {
          return { kind: "LEASE_LOST" };
        }

        if (!change.lease_until || new Date(change.lease_until).getTime() <= Date.now()) {
          return { kind: "LEASE_LOST" };
        }

        if (BigInt(change.revision) !== rev) {
          // A newer webhook arrived while worker was processing!
          return { kind: "SUPERSEDED" };
        }

        if (BigInt(change.applied_revision) >= rev) {
          return { kind: "SUPERSEDED" };
        }

        // 4. Apply product-family replacement to destination generation
        if (replacement.kind === "DELETE") {
          for (const deleteSql of [
            `DELETE FROM mirror.product_collections WHERE shop_id=$1 AND generation_id=$2 AND product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3)`,
            `DELETE FROM mirror.product_options WHERE shop_id=$1 AND generation_id=$2 AND product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3)`,
            `DELETE FROM mirror.metafield_values WHERE shop_id=$1 AND generation_id=$2 AND (product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3) OR variant_id IN (SELECT v.id FROM mirror.variants v JOIN mirror.products p ON p.shop_id=v.shop_id AND p.generation_id=v.generation_id AND p.id=v.product_id WHERE p.shop_id=$1 AND p.generation_id=$2 AND p.shopify_id=$3))`,
            `DELETE FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2 AND product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3)`,
            `DELETE FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3`,
          ]) {
            await client.query(deleteSql, [claim.shopId, claim.generationId, claim.productId]);
          }
        } else if (replacement.kind === "REPLACE") {
          for (const deleteSql of [
            `DELETE FROM mirror.product_collections WHERE shop_id=$1 AND generation_id=$2 AND product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3)`,
            `DELETE FROM mirror.product_options WHERE shop_id=$1 AND generation_id=$2 AND product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3)`,
            `DELETE FROM mirror.metafield_values WHERE shop_id=$1 AND generation_id=$2 AND (product_id IN (SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 AND shopify_id=$3) OR variant_id IN (SELECT v.id FROM mirror.variants v JOIN mirror.products p ON p.shop_id=v.shop_id AND p.generation_id=v.generation_id AND p.id=v.product_id WHERE p.shop_id=$1 AND p.generation_id=$2 AND p.shopify_id=$3))`,
          ]) {
            await client.query(deleteSql, [claim.shopId, claim.generationId, claim.productId]);
          }

          await writeCatalogProducts({
            client,
            shopId: claim.shopId,
            generationId: claim.generationId,
            records: [
              {
                ...replacement.product,
                sourceRevision: String(rev),
                variants: (replacement.product.variants || []).map((v) => ({
                  ...v,
                  sourceRevision: String(rev),
                })),
              },
            ],
          });
        } else {
          invalid("Unsupported replacement kind");
        }

        // 5. Persist destination generation revision receipt
        await client.query(
          `INSERT INTO mirror.generation_product_revisions (shop_id, generation_id, product_id, revision, deleted, applied_at)
           VALUES ($1, $2, $3, $4, $5, clock_timestamp())
           ON CONFLICT (shop_id, generation_id, product_id) DO UPDATE SET
             revision = EXCLUDED.revision,
             deleted = EXCLUDED.deleted,
             applied_at = clock_timestamp()`,
          [claim.shopId, claim.generationId, claim.productId, String(rev), replacement.kind === "DELETE"],
        );

        // 6. Conditional revision acknowledgment on catalog_changes
        const updateParams = [claim.shopId, claim.productId, String(rev), replacement.kind === "DELETE"];
        let paramIndex = 5;
        let fenceClause = "";
        if (claim.fence != null) {
          fenceClause = `AND fence = $${paramIndex++}`;
          updateParams.push(String(claim.fence));
        }
        updateParams.push(claim.leaseToken);
        const leaseTokenClause = `AND lease_token = $${paramIndex++}`;

        const applied = await client.query(
          `UPDATE mirror.catalog_changes SET
             applied_revision = $3,
             dirty = false,
             deleted = $4,
             attempts = 0,
             next_attempt_at = NULL,
             dead_letter_at = NULL,
             last_error = NULL,
             lease_token = NULL,
             lease_until = NULL,
             fence = fence + 1,
             updated_at = clock_timestamp()
           WHERE shop_id = $1
             AND product_id = $2
             AND revision = $3
             AND applied_revision < $3
             ${fenceClause}
             ${leaseTokenClause}
             AND lease_until > clock_timestamp()`,
          updateParams,
        );

        if (applied.rowCount !== 1) {
          return { kind: "SUPERSEDED" };
        }

        // 7. Acknowledge mutation journal
        await client.query(
          `UPDATE mirror.mutation_journal
           SET applied_at = clock_timestamp()
           WHERE shop_id = $1 AND product_id = $2 AND revision <= $3 AND applied_at IS NULL`,
          [claim.shopId, claim.productId, String(rev)],
        );

        return { kind: "APPLIED" };
      });
    },
  });
}
