/** Current-publication reads and atomic publication for the installed mirror schema. Server use only. */
import { randomUUID } from "node:crypto";
import {
  deepFreeze,
  FieldError,
  FIELD_ERROR_CODES as C,
} from "../fields/types.js";
import { FILTER_SQL_SCHEMA } from "../fields/sources.js";
import { transaction, lockMirror } from "./transactions.server.js";

const SNAPSHOT = `SELECT g.shop_id AS "shopId", g.id AS "generationId",
  g.coverage_revision AS "coverageRevision", g.status::text AS status,
  g.mirror_schema_version AS "mirrorSchemaVersion",
  g.source_contract_version AS "sourceContractVersion",
  c.name, c.generation_id AS "datasetGenerationId", c.status::text AS "datasetStatus"
FROM mirror.generations g
LEFT JOIN mirror.publications p ON g.shop_id = p.shop_id AND g.id = p.generation_id
  AND g.coverage_revision = p.coverage_revision AND g.mapping_version = p.mapping_version
LEFT JOIN mirror.coverage c ON c.shop_id = g.shop_id AND c.generation_id = g.id
  AND c.name = ANY($3::text[])
WHERE g.shop_id = $1::text AND (($2::text IS NULL AND p.generation_id IS NOT NULL) OR
  (g.id = $2::text AND (p.generation_id IS NOT NULL OR g.retain_until > now())))
  AND g.status = 'PUBLISHED'
ORDER BY c.name LIMIT 33`;

function shop(value) {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)
  ) {
    throw new FieldError(C.PERMISSION_DENIED, "Authenticated shop required");
  }
  return value;
}

function token(value, name = "Opaque identity") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new FieldError(C.INVALID_VALUE, `${name} required`);
  }
  return value;
}

export function createPublicationRepository({ database } = {}) {
  if (typeof database?.connect !== "function")
    throw new TypeError("PostgreSQL pool required");

  async function read(client, values) {
    const { rows } = await client.query(SNAPSHOT, values);
    if (!rows.length) return null;
    if (rows.length > 32)
      throw new FieldError(C.CONTRACT_MISMATCH, "Coverage limit exceeded");
    const first = rows[0];
    return deepFreeze({
      shopId: first.shopId,
      generationId: first.generationId,
      coverageRevision: first.coverageRevision,
      status: first.status,
      mirrorSchemaVersion: first.mirrorSchemaVersion,
      sourceContractVersion: first.sourceContractVersion,
      datasets: rows
        .filter((row) => row.name !== null)
        .map((row) => ({
          name: row.name,
          generationId: row.datasetGenerationId,
          status: row.datasetStatus,
          published: row.status === "PUBLISHED",
        })),
    });
  }

  async function snapshot({
    shopId,
    generationId,
    datasets,
    client,
    targetingSnapshotId,
  } = {}) {
    shop(shopId);
    if (targetingSnapshotId !== undefined) {
      // SelectionSnapshot does not store the approved dataset contract required
      // by coverage.js. Never manufacture approval from request metadata.
      throw new FieldError(
        C.EXECUTION_UNAVAILABLE,
        "Target approval repository required",
      );
    }
    if (
      generationId !== null &&
      (typeof generationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(generationId))
    ) {
      throw new FieldError(C.INVALID_VALUE, "Pinned generation required");
    }
    if (
      !Array.isArray(datasets) ||
      datasets.length > 32 ||
      Object.getPrototypeOf(datasets) !== Array.prototype ||
      Reflect.ownKeys(datasets).length !== datasets.length + 1
    ) {
      throw new FieldError(C.INVALID_VALUE, "Bounded datasets required");
    }
    const names = [];
    for (let index = 0; index < datasets.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(
        datasets,
        String(index),
      );
      const name =
        descriptor && Object.hasOwn(descriptor, "value") && descriptor.value;
      if (
        typeof name !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(name) ||
        names.includes(name)
      ) {
        throw new FieldError(C.INVALID_VALUE, "Invalid dataset identity");
      }
      names.push(name);
    }
    const values = [shopId, generationId, names];
    if (client !== undefined) {
      if (typeof client?.query !== "function")
        throw new TypeError("Protected transaction client required");
      // The executor already holds publication protection on this transaction.
      return read(client, values);
    }
    const owned = await database.connect();
    let discard;
    try {
      await owned.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await owned.query("SET LOCAL statement_timeout = '5000ms'");
      await owned.query("SET LOCAL lock_timeout = '1000ms'");
      await owned.query("LOCK TABLE mirror.publications IN ACCESS SHARE MODE");
      const result = await read(owned, values);
      await owned.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await owned.query("ROLLBACK");
      } catch (rollbackError) {
        discard = rollbackError;
      }
      throw error;
    } finally {
      owned.release(discard);
    }
  }

  return Object.freeze({
    getPublishedSnapshot(input) {
      if (input?.generationId == null)
        throw new FieldError(C.INVALID_VALUE, "Pinned generation required");
      return snapshot(input);
    },

    async getPublishedContext({ shopId, generationId = null, client } = {}) {
      shop(shopId);
      const readContext = async (client) => {
        const current = await snapshot({
          shopId,
          generationId,
          datasets: [],
          client,
        });
        if (current)
          await client.query(
            `UPDATE mirror.generations SET retain_until=GREATEST(retain_until,now()+interval '25 hours') WHERE shop_id=$1 AND id=$2`,
            [shopId, current.generationId],
          );
        return current;
      };
      const current = client
        ? await snapshot({ shopId, generationId, datasets: [], client })
        : await transaction(database, readContext);
      // A stable operation identity permits paging within this publication.
      // This read context does not grant field access or operation approval.
      return (
        current &&
        Object.freeze({
          operationId: "catalog",
          generationId: current.generationId,
          coverageRevision: current.coverageRevision,
        })
      );
    },

    async publishGeneration({
      client,
      shopId,
      generationId,
      expectedGenerationId,
      installedOptions,
    } = {}) {
      shop(shopId);
      token(generationId, "Pinned generation");
      if (expectedGenerationId === undefined) {
        throw new FieldError(
          C.INVALID_VALUE,
          "Expected current publication required (null for first publication)",
        );
      }
      if (
        expectedGenerationId !== null &&
        (typeof expectedGenerationId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(expectedGenerationId))
      ) {
        throw new FieldError(C.INVALID_VALUE, "Invalid expected generation ID");
      }

      async function execute(txClient) {
        await lockMirror(txClient);

        // 1. Verify candidate generation eligibility and lock row
        const genRes = await txClient.query(
          `SELECT * FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, generationId],
        );
        const generation = genRes.rows[0];
        if (!generation) {
          throw new FieldError(C.INVALID_VALUE, "Generation not found");
        }
        if (generation.status !== "VERIFIED") {
          throw new FieldError(
            C.EXECUTION_UNAVAILABLE,
            "Generation is not verified for publication",
          );
        }

        // 2. Validate compatibility with installed SQL mappings and contracts
        const targetMirrorSchemaVersion =
          installedOptions?.mirrorSchemaVersion ||
          FILTER_SQL_SCHEMA.mirrorSchemaVersion;
        const targetSourceContractVersion =
          installedOptions?.sourceContractVersion ||
          FILTER_SQL_SCHEMA.sourceContractVersion;
        if (
          generation.mirror_schema_version !== targetMirrorSchemaVersion ||
          generation.source_contract_version !== targetSourceContractVersion ||
          generation.mapping_version !== "mapping_v1"
        ) {
          throw new FieldError(
            C.CONTRACT_MISMATCH,
            "Generation schema version incompatible with installed physical schema",
          );
        }

        // 3. Verify complete coverage for all required datasets
        const requiredDatasets =
          Array.isArray(generation.required_datasets) &&
          generation.required_datasets.length > 0
            ? generation.required_datasets
            : ["products", "variants"];

        const covRes = await txClient.query(
          `SELECT name, status, verified_at FROM mirror.coverage
           WHERE shop_id = $1 AND generation_id = $2 AND name = ANY($3::text[])`,
          [shopId, generationId, requiredDatasets],
        );
        const coveredMap = new Map(covRes.rows.map((r) => [r.name, r]));
        for (const datasetName of requiredDatasets) {
          const record = coveredMap.get(datasetName);
          if (!record || record.status !== "COMPLETE" || !record.verified_at) {
            throw new FieldError(
              C.MISSING_DEPENDENCY,
              `Required dataset ${datasetName} incomplete for publication`,
            );
          }
        }

        // 4. Verify no dirty unreconciled mutations remain
        const dirtyRes = await txClient.query(
          `SELECT 1 FROM mirror.catalog_changes WHERE shop_id = $1 AND dirty LIMIT 1`,
          [shopId],
        );
        if (dirtyRes.rowCount > 0) {
          throw new FieldError(
            C.EXECUTION_UNAVAILABLE,
            "New mutations arrived after verification",
          );
        }

        // 5. Protect against concurrent promotion and validate expected pointer
        const pubRes = await txClient.query(
          `SELECT generation_id, coverage_revision, mapping_version FROM mirror.publications WHERE shop_id = $1 FOR UPDATE`,
          [shopId],
        );
        const currentPub = pubRes.rows[0]?.generation_id ?? null;
        if (currentPub !== expectedGenerationId) {
          throw new FieldError(C.CONTRACT_MISMATCH, "Publication was superseded");
        }

        // 6. If replacing an existing publication, verify ordering and retain previous generation
        if (currentPub !== null) {
          const orderRes = await txClient.query(
            `SELECT 1 FROM mirror.generations old
             WHERE old.shop_id = $1 AND old.id = $2
               AND (old.created_at, old.id) >= ($3::timestamptz, $4::text)`,
            [shopId, currentPub, generation.created_at, generationId],
          );
          if (orderRes.rowCount > 0) {
            throw new FieldError(
              C.CONTRACT_MISMATCH,
              "Older snapshot cannot replace newer publication",
            );
          }

          // Retain the previous generation
          await txClient.query(
            `UPDATE mirror.generations
             SET retain_until = GREATEST(retain_until, clock_timestamp() + interval '25 hours')
             WHERE shop_id = $1 AND id = $2`,
            [shopId, currentPub],
          );
        }

        // 7. Publish eligible generation
        await txClient.query(
          `UPDATE mirror.generations
           SET status = 'PUBLISHED',
               published_at = clock_timestamp(),
               retain_until = GREATEST(retain_until, clock_timestamp() + interval '25 hours')
           WHERE shop_id = $1 AND id = $2`,
          [shopId, generationId],
        );

        // 8. Update active publication pointer
        await txClient.query(
          `INSERT INTO mirror.publications (shop_id, generation_id, coverage_revision, mapping_version, published_at)
           VALUES ($1, $2, $3, $4, clock_timestamp())
           ON CONFLICT (shop_id) DO UPDATE SET
             generation_id = EXCLUDED.generation_id,
             coverage_revision = EXCLUDED.coverage_revision,
             mapping_version = EXCLUDED.mapping_version,
             published_at = clock_timestamp()`,
          [
            shopId,
            generationId,
            generation.coverage_revision,
            generation.mapping_version,
          ],
        );

        return deepFreeze({
          shopId,
          generationId,
          coverageRevision: generation.coverage_revision,
          mappingVersion: generation.mapping_version,
          previousGenerationId: currentPub,
        });
      }

      if (client !== undefined) {
        if (typeof client?.query !== "function") {
          throw new TypeError("Protected transaction client required");
        }
        return execute(client);
      }
      return transaction(database, execute);
    },

    async acquireReadLease({
      client,
      shopId,
      generationId,
      operation,
      owner,
      leaseSeconds = 3600,
    } = {}) {
      shop(shopId);
      token(generationId, "Pinned generation");
      token(owner, "Owner");
      if (typeof operation !== "string" || !operation) {
        throw new FieldError(C.INVALID_VALUE, "Operation required");
      }
      if (
        !Number.isSafeInteger(leaseSeconds) ||
        leaseSeconds < 60 ||
        leaseSeconds > 86400 * 7
      ) {
        throw new FieldError(
          C.INVALID_VALUE,
          "Bounded lease duration required (60s to 7d)",
        );
      }

      async function execute(txClient) {
        const genRes = await txClient.query(
          `SELECT id, coverage_revision, mapping_version, status, retain_until
           FROM mirror.generations
           WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, generationId],
        );
        const gen = genRes.rows[0];
        if (!gen) {
          throw new FieldError(C.INVALID_VALUE, "Generation not found");
        }
        if (gen.status !== "PUBLISHED") {
          throw new FieldError(
            C.EXECUTION_UNAVAILABLE,
            "Read lease requires published generation",
          );
        }

        const leaseId = randomUUID();
        const leaseRes = await txClient.query(
          `INSERT INTO mirror.generation_read_leases (
             shop_id, id, generation_id, coverage_revision, mapping_version, operation, owner, expires_at, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp() + $8::integer * interval '1 second', clock_timestamp())
           RETURNING id, shop_id, generation_id, coverage_revision, mapping_version, operation, owner, expires_at, created_at`,
          [
            shopId,
            leaseId,
            generationId,
            gen.coverage_revision,
            gen.mapping_version,
            operation,
            owner,
            leaseSeconds,
          ],
        );

        await txClient.query(
          `UPDATE mirror.generations
           SET retain_until = GREATEST(retain_until, clock_timestamp() + $3::integer * interval '1 second')
           WHERE shop_id = $1 AND id = $2`,
          [shopId, generationId, leaseSeconds],
        );

        const row = leaseRes.rows[0];
        return deepFreeze({
          leaseId: row.id,
          shopId: row.shop_id,
          generationId: row.generation_id,
          coverageRevision: row.coverage_revision,
          mappingVersion: row.mapping_version,
          operation: row.operation,
          owner: row.owner,
          expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
        });
      }

      if (client !== undefined) {
        if (typeof client?.query !== "function")
          throw new TypeError("Protected transaction client required");
        return execute(client);
      }
      return transaction(database, execute);
    },

    async verifyReadLease({client,shopId,leaseId,generationId,coverageRevision,mappingVersion,owner,operation,allowExpired=false}={}) {
      shop(shopId);token(leaseId,"Lease ID");token(generationId,"Pinned generation");token(owner,"Lease owner");
      if(typeof client?.query!=="function"||!coverageRevision||!mappingVersion||typeof operation!=="string")throw new TypeError("Transaction-bound exact read-lease identity required");
      const row=(await client.query(`SELECT *,expires_at>clock_timestamp() AS active FROM mirror.generation_read_leases
        WHERE shop_id=$1 AND id=$2 AND owner=$3 AND operation=$4 FOR UPDATE`,[shopId,leaseId,owner,operation])).rows[0];
      if(row&&(row.generation_id!==generationId||row.coverage_revision!==coverageRevision||row.mapping_version!==mappingVersion))
        throw new FieldError(C.CONTRACT_MISMATCH,"Generation lease pins changed");
      return row&&(allowExpired||row.active===true)?Object.freeze(row):null;
    },

    async renewReadLease({ client, shopId, leaseId, leaseSeconds = 3600 } = {}) {
      shop(shopId);
      token(leaseId, "Lease ID");
      if (
        !Number.isSafeInteger(leaseSeconds) ||
        leaseSeconds < 60 ||
        leaseSeconds > 86400 * 7
      ) {
        throw new FieldError(
          C.INVALID_VALUE,
          "Bounded lease duration required (60s to 7d)",
        );
      }

      async function execute(txClient) {
        const leaseRes = await txClient.query(
          `UPDATE mirror.generation_read_leases
           SET expires_at = clock_timestamp() + $3::integer * interval '1 second'
           WHERE shop_id = $1 AND id = $2
           RETURNING shop_id, generation_id, expires_at`,
          [shopId, leaseId, leaseSeconds],
        );
        const row = leaseRes.rows[0];
        if (!row) {
          throw new FieldError(C.INVALID_VALUE, "Lease not found");
        }
        await txClient.query(
          `UPDATE mirror.generations
           SET retain_until = GREATEST(retain_until, $3)
           WHERE shop_id = $1 AND id = $2`,
          [shopId, row.generation_id, row.expires_at],
        );
        return deepFreeze({
          leaseId,
          shopId: row.shop_id,
          generationId: row.generation_id,
          expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
        });
      }

      if (client !== undefined) {
        if (typeof client?.query !== "function")
          throw new TypeError("Protected transaction client required");
        return execute(client);
      }
      return transaction(database, execute);
    },

    async releaseReadLease({ client, shopId, leaseId } = {}) {
      shop(shopId);
      token(leaseId, "Lease ID");
      async function execute(txClient) {
        const res = await txClient.query(
          `DELETE FROM mirror.generation_read_leases WHERE shop_id = $1 AND id = $2 RETURNING id`,
          [shopId, leaseId],
        );
        return res.rowCount === 1;
      }
      if (client !== undefined) {
        if (typeof client?.query !== "function")
          throw new TypeError("Protected transaction client required");
        return execute(client);
      }
      return transaction(database, execute);
    },

    async retainGeneration({ client, shopId, generationId, until } = {}) {
      shop(shopId);
      token(generationId, "Pinned generation");
      const date = new Date(until);
      if (
        !Number.isFinite(date.getTime()) ||
        date.getTime() <= Date.now() ||
        date.getTime() > Date.now() + 7 * 86400000
      ) {
        throw new FieldError(C.INVALID_VALUE, "Bounded retention required");
      }

      async function execute(txClient) {
        const genRes = await txClient.query(
          `SELECT id, status FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, generationId],
        );
        if (!genRes.rows[0] || genRes.rows[0].status !== "PUBLISHED") {
          throw new FieldError(
            C.EXECUTION_UNAVAILABLE,
            "Retention requires published generation",
          );
        }
        await txClient.query(
          `UPDATE mirror.generations SET retain_until = GREATEST(retain_until, $3) WHERE shop_id = $1 AND id = $2`,
          [shopId, generationId, date],
        );
        return true;
      }

      if (client !== undefined) {
        if (typeof client?.query !== "function")
          throw new TypeError("Protected transaction client required");
        return execute(client);
      }
      return transaction(database, execute);
    },

    async reclaimGeneration({ client, shopId, generationId } = {}) {
      shop(shopId);
      token(generationId, "Pinned generation");

      async function execute(txClient) {
        const genRes = await txClient.query(
          `SELECT id, status, retain_until FROM mirror.generations WHERE shop_id = $1 AND id = $2 FOR UPDATE`,
          [shopId, generationId],
        );
        const gen = genRes.rows[0];
        if (!gen) return false;
        if (!["FAILED", "RETIRED", "PUBLISHED"].includes(gen.status)) {
          throw new FieldError(
            C.EXECUTION_UNAVAILABLE,
            "Generation is not eligible for reclamation",
          );
        }
        if (
          gen.retain_until &&
          new Date(gen.retain_until).getTime() > Date.now()
        ) {
          throw new FieldError(C.CONTRACT_MISMATCH, "Generation is retained");
        }
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
          throw new FieldError(
            C.CONTRACT_MISMATCH,
            "Generation remains referenced",
          );
        }

        if (gen.status === "PUBLISHED") {
          await txClient.query(
            `UPDATE mirror.generations SET status = 'RETIRED', retired_at = clock_timestamp() WHERE shop_id = $1 AND id = $2`,
            [shopId, generationId],
          );
        }
        await txClient.query(
          `DELETE FROM mirror.generations WHERE shop_id = $1 AND id = $2`,
          [shopId, generationId],
        );
        return true;
      }

      if (client !== undefined) {
        if (typeof client?.query !== "function")
          throw new TypeError("Protected transaction client required");
        return execute(client);
      }
      return transaction(database, execute);
    },

    async cleanupGenerations({ client, shopId } = {}) {
      shop(shopId);
      async function execute(txClient) {
        const candidateRes = await txClient.query(
          `SELECT g.id, g.status, g.retain_until
           FROM mirror.generations g
           LEFT JOIN mirror.publications p ON p.shop_id = g.shop_id AND p.generation_id = g.id
           WHERE g.shop_id = $1
             AND p.generation_id IS NULL
             AND (g.retain_until IS NULL OR g.retain_until <= clock_timestamp())
             AND g.status IN ('FAILED', 'RETIRED', 'PUBLISHED')
           ORDER BY g.created_at ASC`,
          [shopId],
        );

        const reclaimed = [];
        for (const gen of candidateRes.rows) {
          const refRes = await txClient.query(
            `SELECT 1 FROM mirror.selection_snapshots WHERE shop_id = $1 AND generation_id = $2
             UNION ALL
             SELECT 1 FROM mirror.generation_read_leases WHERE shop_id = $1 AND generation_id = $2 AND expires_at > clock_timestamp()
             LIMIT 1`,
            [shopId, gen.id],
          );
          if (refRes.rowCount === 0) {
            if (gen.status === "PUBLISHED") {
              await txClient.query(
                `UPDATE mirror.generations SET status = 'RETIRED', retired_at = clock_timestamp() WHERE shop_id = $1 AND id = $2`,
                [shopId, gen.id],
              );
            }
            await txClient.query(
              `DELETE FROM mirror.generations WHERE shop_id = $1 AND id = $2`,
              [shopId, gen.id],
            );
            reclaimed.push(gen.id);
          }
        }
        return reclaimed;
      }

      if (client !== undefined) {
        if (typeof client?.query !== "function")
          throw new TypeError("Protected transaction client required");
        return execute(client);
      }
      return transaction(database, execute);
    },
  });
}
