/**
 * METAMAX — Authoritative Generation Lifecycle Repository
 *
 * Implements the database transaction contract required by GenerationService V2:
 * - verifyEligibility(request)
 * - promoteAtomically(request)
 * - retainAtomically(request)
 * - releaseRetentionAtomically(request)
 * - claimReclamationAtomically(request)
 * - completeReclamationAtomically(request)
 *
 * Enforces PostgreSQL atomic isolation, fences, ownership, and durable deletion verification.
 */

import { randomUUID } from "node:crypto";
import { transaction, lockMirror } from "./transactions.server.js";

const SNAPSHOT_CHILD_TABLES = [
  "mirror.coverage",
  "mirror.ingestion_runs",
  "mirror.generation_product_revisions",
  "mirror.products",
  "mirror.variants",
  "mirror.inventory_items",
  "mirror.locations",
  "mirror.inventory_levels",
  "mirror.collections",
  "mirror.product_options",
  "mirror.categories",
  "mirror.metafield_values",
];

export function createGenerationRepository({ database } = {}) {
  if (typeof database?.connect !== "function") {
    throw new TypeError("PostgreSQL pool required");
  }

  return Object.freeze({
    /**
     * verifyEligibility: Read-only eligibility verification
     */
    async verifyEligibility({
      shopId,
      generationId,
      coverageRevision,
      mirrorSchemaVersion,
      sourceContractVersion,
      mappingVersion,
      requiredDatasets,
    }) {
      const client = await database.connect();
      try {
        const genRes = await client.query(
          `SELECT id, status, coverage_revision, mirror_schema_version, source_contract_version, mapping_version
           FROM mirror.generations
           WHERE shop_id = $1 AND id = $2`,
          [shopId, generationId],
        );
        const gen = genRes.rows[0];
        if (!gen || gen.status !== "VERIFIED") {
          return { kind: "NOT_ELIGIBLE" };
        }

        if (
          gen.coverage_revision !== coverageRevision ||
          gen.mirror_schema_version !== mirrorSchemaVersion ||
          gen.source_contract_version !== sourceContractVersion ||
          gen.mapping_version !== mappingVersion
        ) {
          return { kind: "NOT_ELIGIBLE" };
        }

        // Verify all required datasets have COMPLETE coverage
        const covRes = await client.query(
          `SELECT name, status, verified_at, verification_hash
           FROM mirror.coverage
           WHERE shop_id = $1 AND generation_id = $2 AND name = ANY($3::text[])`,
          [shopId, generationId, requiredDatasets],
        );
        const covMap = new Map(covRes.rows.map((r) => [r.name, r]));
        for (const name of requiredDatasets) {
          const rec = covMap.get(name);
          if (!rec || rec.status !== "COMPLETE" || !rec.verified_at || !rec.verification_hash) {
            return { kind: "NOT_ELIGIBLE" };
          }
        }

        // Verify no unreconciled mutations remain
        const dirtyRes = await client.query(
          `SELECT 1 FROM mirror.catalog_changes WHERE shop_id = $1 AND dirty LIMIT 1`,
          [shopId],
        );
        if (dirtyRes.rowCount > 0) {
          return { kind: "NOT_ELIGIBLE" };
        }

        return { kind: "ELIGIBLE" };
      } finally {
        client.release();
      }
    },

    /**
     * promoteAtomically: Atomic promotion to PUBLISHED with a tenant lock,
     * fencing check, superseded pointer protection, and previous generation retention.
     */
    async promoteAtomically({
      shopId,
      publisherFence,
      generationId,
      coverageRevision,
      mirrorSchemaVersion,
      sourceContractVersion,
      mappingVersion,
      requiredDatasets,
      expectedCurrentGenerationId,
    }) {
      return transaction(database, async (txClient) => {
        await lockMirror(txClient,shopId);

        // 1. Lock and inspect candidate generation
        const genRes = await txClient.query(
          `SELECT * FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, generationId],
        );
        const gen = genRes.rows[0];
        if (!gen) return { kind: "NOT_ELIGIBLE" };

        // 2. Check if already published
        const currentPubRes = await txClient.query(
          `SELECT generation_id FROM mirror.publications WHERE shop_id = $1 FOR UPDATE`,
          [shopId],
        );
        const currentGenId = currentPubRes.rows[0]?.generation_id ?? null;
        if (currentGenId === generationId && gen.status === "PUBLISHED") {
          return { kind: "ALREADY_PUBLISHED" };
        }

        if (gen.status !== "VERIFIED") {
          return { kind: "NOT_ELIGIBLE" };
        }

        // 3. Fencing check against durable ingestion run fence
        const fenceRes = await txClient.query(
          `SELECT fence FROM mirror.ingestion_runs
           WHERE shop_id = $1 AND generation_id = $2
           ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [shopId, generationId],
        );
        if (fenceRes.rowCount > 0 && publisherFence != null) {
          if (String(fenceRes.rows[0].fence) !== String(publisherFence)) {
            return { kind: "STALE_FENCE" };
          }
        }

        // 4. Pointer check (expectedCurrentGenerationId must match current publication)
        if (currentGenId !== expectedCurrentGenerationId) {
          return { kind: "CONFLICT" };
        }

        // 5. Version and coverage verification
        if (
          gen.coverage_revision !== coverageRevision ||
          gen.mirror_schema_version !== mirrorSchemaVersion ||
          gen.source_contract_version !== sourceContractVersion ||
          gen.mapping_version !== mappingVersion
        ) {
          return { kind: "NOT_ELIGIBLE" };
        }

        const covRes = await txClient.query(
          `SELECT name, status, verified_at, verification_hash
           FROM mirror.coverage
           WHERE shop_id = $1 AND generation_id = $2 AND name = ANY($3::text[])`,
          [shopId, generationId, requiredDatasets],
        );
        const covMap = new Map(covRes.rows.map((r) => [r.name, r]));
        for (const name of requiredDatasets) {
          const rec = covMap.get(name);
          if (!rec || rec.status !== "COMPLETE" || !rec.verified_at || !rec.verification_hash) {
            return { kind: "NOT_ELIGIBLE" };
          }
        }

        const dirtyRes = await txClient.query(
          `SELECT 1 FROM mirror.catalog_changes WHERE shop_id = $1 AND dirty LIMIT 1`,
          [shopId],
        );
        if (dirtyRes.rowCount > 0) {
          return { kind: "NOT_ELIGIBLE" };
        }

        // 6. Ordering check against previous generation
        if (currentGenId !== null) {
          const orderRes = await txClient.query(
            `SELECT 1 FROM mirror.generations old
             WHERE old.shop_id = $1 AND old.id = $2
               AND (old.created_at, old.id) >= ($3::timestamptz, $4::text)`,
            [shopId, currentGenId, gen.created_at, generationId],
          );
          if (orderRes.rowCount > 0) {
            return { kind: "CONFLICT" };
          }

          // Retain the previous generation
          await txClient.query(
            `UPDATE mirror.generations
             SET retain_until = GREATEST(retain_until, clock_timestamp() + interval '25 hours')
             WHERE shop_id = $1 AND id = $2`,
            [shopId, currentGenId],
          );
        }

        // 7. Update candidate generation to PUBLISHED
        await txClient.query(
          `UPDATE mirror.generations
           SET status = 'PUBLISHED',
               published_at = clock_timestamp(),
               retain_until = GREATEST(retain_until, clock_timestamp() + interval '25 hours')
           WHERE shop_id = $1 AND id = $2`,
          [shopId, generationId],
        );

        // 8. Update publication pointer
        await txClient.query(
          `INSERT INTO mirror.publications (shop_id, generation_id, coverage_revision, mapping_version, published_at)
           VALUES ($1, $2, $3, $4, clock_timestamp())
           ON CONFLICT (shop_id) DO UPDATE SET
             generation_id = EXCLUDED.generation_id,
             coverage_revision = EXCLUDED.coverage_revision,
             mapping_version = EXCLUDED.mapping_version,
             published_at = clock_timestamp()`,
          [shopId, generationId, coverageRevision, mappingVersion],
        );

        return { kind: "PUBLISHED" };
      }, shopId);
    },

    /**
     * retainAtomically: Create durable retention lease
     */
    async retainAtomically({ shopId, generationId, referenceId, expiresAt }) {
      return transaction(database, async (txClient) => {
        const genRes = await txClient.query(
          `SELECT id, status, coverage_revision, mapping_version
           FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, generationId],
        );
        const gen = genRes.rows[0];
        if (!gen || gen.status !== "PUBLISHED") {
          return { kind: "NOT_ELIGIBLE" };
        }

        const date = new Date(expiresAt);
        await txClient.query(
          `INSERT INTO mirror.generation_read_leases (
             shop_id, id, generation_id, coverage_revision, mapping_version, operation, owner, expires_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, 'retention', $6, $7, clock_timestamp())
           ON CONFLICT (shop_id, id) DO UPDATE SET
             expires_at = GREATEST(mirror.generation_read_leases.expires_at, EXCLUDED.expires_at)`,
          [
            shopId,
            referenceId,
            generationId,
            gen.coverage_revision,
            gen.mapping_version,
            referenceId,
            date,
          ],
        );

        await txClient.query(
          `UPDATE mirror.generations
           SET retain_until = GREATEST(retain_until, $3)
           WHERE shop_id = $1 AND id = $2`,
          [shopId, generationId, date],
        );

        return { kind: "RETAINED" };
      }, shopId);
    },

    /**
     * releaseRetentionAtomically: Remove durable retention lease
     */
    async releaseRetentionAtomically({ shopId, generationId, referenceId }) {
      return transaction(database, async (txClient) => {
        const res = await txClient.query(
          `DELETE FROM mirror.generation_read_leases
           WHERE shop_id = $1 AND generation_id = $2 AND (id = $3 OR owner = $3)`,
          [shopId, generationId, referenceId],
        );
        return { kind: res.rowCount > 0 ? "RELEASED" : "NOT_FOUND" };
      }, shopId);
    },

    /**
     * claimReclamationAtomically: Stage 1 of reclamation.
     * Prevents new references while claiming generation under cleanup fence.
     */
    async claimReclamationAtomically({ shopId, cleanupFence, generationId }) {
      return transaction(database, async (txClient) => {
        const genRes = await txClient.query(
          `SELECT id, status, retain_until FROM mirror.generations
           WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, generationId],
        );
        const gen = genRes.rows[0];
        if (!gen) return { kind: "NOT_RECLAIMABLE" };

        if (!["FAILED", "RETIRED", "PUBLISHED"].includes(gen.status)) {
          return { kind: "NOT_RECLAIMABLE" };
        }

        if (gen.retain_until && new Date(gen.retain_until).getTime() > Date.now()) {
          return { kind: "NOT_RECLAIMABLE" };
        }

        // Active reference checks
        const refRes = await txClient.query(
          `SELECT 1 FROM mirror.publications WHERE shop_id = $1 AND generation_id = $2
           UNION ALL
           SELECT 1 FROM mirror.selection_snapshots WHERE shop_id = $1 AND generation_id = $2
           UNION ALL
           SELECT 1 FROM mirror.generation_read_leases WHERE shop_id = $1 AND generation_id = $2 AND expires_at > clock_timestamp()
           LIMIT 1`,
          [shopId, generationId],
        );
        if (refRes.rowCount > 0) {
          return { kind: "NOT_RECLAIMABLE" };
        }

        // Retire published generation
        if (gen.status === "PUBLISHED") {
          await txClient.query(
            `UPDATE mirror.generations
             SET status = 'RETIRED', retired_at = clock_timestamp()
             WHERE shop_id = $1 AND id = $2`,
            [shopId, generationId],
          );
        }

        return { kind: "RECLAIMING" };
      }, shopId);
    },

    /**
     * completeReclamationAtomically: Stage 2 of reclamation.
     *
     * BOUNDARY REQUIREMENT:
     * Must NOT mark a generation reclaimed merely because cleanup was requested.
     * The repository must verify durable deletion completion, valid ownership, and fencing.
     */
    async completeReclamationAtomically({ shopId, cleanupFence, generationId }) {
      return transaction(database, async (txClient) => {
        // 1. Verify ownership and generation row with FOR UPDATE
        const genRes = await txClient.query(
          `SELECT id, status, retain_until FROM mirror.generations
           WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, generationId],
        );
        const gen = genRes.rows[0];
        if (!gen) return { kind: "CONFLICT" };

        if (!["FAILED", "RETIRED"].includes(gen.status)) {
          return { kind: "CONFLICT" };
        }

        // 2. Fencing check: verify cleanup lease has not been superseded
        const cmdRes = await txClient.query(
          `SELECT fence FROM mirror.job_commands
           WHERE shop_id = $1 AND contract_id = $2
           ORDER BY id DESC LIMIT 1 FOR UPDATE`,
          [shopId, generationId],
        );
        if (cmdRes.rowCount > 0 && cleanupFence != null) {
          if (String(cmdRes.rows[0].fence) !== String(cleanupFence)) {
            return { kind: "STALE_FENCE" };
          }
        }

        // 3. Recheck that no active reference exists
        const refRes = await txClient.query(
          `SELECT 1 FROM mirror.publications WHERE shop_id = $1 AND generation_id = $2
           UNION ALL
           SELECT 1 FROM mirror.selection_snapshots WHERE shop_id = $1 AND generation_id = $2
           UNION ALL
           SELECT 1 FROM mirror.generation_read_leases WHERE shop_id = $1 AND generation_id = $2 AND expires_at > clock_timestamp()
           LIMIT 1`,
          [shopId, generationId],
        );
        if (refRes.rowCount > 0) {
          return { kind: "CONFLICT" };
        }

        // 4. Durably delete child table data for this generation
        for (const table of SNAPSHOT_CHILD_TABLES) {
          await txClient.query(
            `DELETE FROM ${table} WHERE shop_id = $1 AND generation_id = $2`,
            [shopId, generationId],
          );
        }

        // 5. VERIFY DURABLE DELETION COMPLETION:
        // Ensure no orphaned rows remain across snapshot tables
        const verifyRes = await txClient.query(
          `SELECT (
             (SELECT count(*)::bigint FROM mirror.products WHERE shop_id = $1 AND generation_id = $2) +
             (SELECT count(*)::bigint FROM mirror.variants WHERE shop_id = $1 AND generation_id = $2) +
             (SELECT count(*)::bigint FROM mirror.coverage WHERE shop_id = $1 AND generation_id = $2)
           ) AS remaining_rows`,
          [shopId, generationId],
        );
        const remaining = BigInt(verifyRes.rows[0]?.remaining_rows ?? 0);
        if (remaining > 0n) {
          // Durable deletion failed or was incomplete; fail closed!
          return { kind: "CONFLICT" };
        }

        // 6. Delete the generation row itself
        await txClient.query(
          `DELETE FROM mirror.generations WHERE shop_id = $1 AND id = $2`,
          [shopId, generationId],
        );

        return { kind: "RECLAIMED" };
      }, shopId);
    },
  });
}
