/**
 * METAMAX Export Engine — PostgreSQL Repository (v2).
 *
 * Enforces inside a single database transaction:
 * 1. Atomic idempotency lookup and `request_fingerprint` comparison
 *    (never using unconditional `ON CONFLICT DO NOTHING` success).
 * 2. Publication barrier lock (`ACCESS SHARE`) and active shop/generation
 *    verification before pinning.
 * 3. Durable `mirror.generation_read_leases` creation so the pinned
 *    generation cannot be retired or reclaimed while the export runs.
 * 4. Atomic creation of `mirror.export_manifest_jobs` and the durable
 *    dispatch outbox record in `mirror.export_dispatch_outbox`.
 */

import { randomUUID } from "node:crypto";
import { createExportLifecycleRepository } from "./export-lifecycle-repository.server.js";
import {
  EXPORT_CONTRACT_VERSION,
  EXPORT_MANIFEST_VERSION,
  EXPORT_ERROR_CODES,
  EXPORT_STATES,
  ExportContractError,
  assertExportTransition,
  normalizeIdempotencyKey,
} from "./export-contract.js";

const DEFAULT_READ_LEASE_SECONDS = 3600;

function formatJobRow(row) {
  if (!row) return null;

  return Object.freeze({
    id: row.id,
    shopId: row.shop_id,
    installationId: row.installation_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    manifestFingerprint: row.manifest_fingerprint,
    contractVersion: Number(row.contract_version),
    manifestVersion: Number(row.manifest_version),
    generationId: row.generation_id,
    coverageRevision: row.coverage_revision,
    mappingVersion: row.mapping_version,
    readLeaseId: row.read_lease_id,
    manifest: row.manifest,
    state: row.state,
    attempts: Number(row.attempts),
    fenceEpoch: String(row.fence_epoch),
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at
      ? new Date(row.lease_expires_at).toISOString()
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

function buildManifestPayload(prepared) {
  if (prepared?.manifest && typeof prepared.manifest === "object") {
    return prepared.manifest;
  }

  return {
    contractVersion:
      prepared?.contractVersion ?? EXPORT_CONTRACT_VERSION,
    manifestVersion:
      prepared?.manifestVersion ?? EXPORT_MANIFEST_VERSION,
    shopId: prepared?.shopId,
    installationId: prepared?.installationId,
    generationId: prepared?.generationId,
    coverageRevision: prepared?.coverageRevision,
    requestFingerprint: prepared?.requestFingerprint,
    manifestFingerprint: prepared?.manifestFingerprint,
    request: prepared?.request,
    fields: Array.isArray(prepared?.authorizedFields?.fields)
      ? prepared.authorizedFields.fields.map((f) => ({
          id: f.id ?? f.field?.id,
          origin: f.origin ?? f.field?.origin ?? "canonical",
          type: f.type ?? f.field?.type ?? null,
          entity: f.entity ?? f.field?.entity ?? null,
          definitionRevision:
            f.source?.definitionRevision ??
            f.definitionRevision ??
            null,
        }))
      : [],
    filterFingerprint:
      prepared?.validatedFilter?.fingerprint ?? null,
  };
}

export function createExportRepository(options = {}) {
  // The supplied V2 execution API uses its own versioned storage contract.
  // Keep the existing admission API available to existing callers.
  if (options.pool) return createExportLifecycleRepository(options);
  return createManifestRepository(options);
}

function createManifestRepository({
  database,
  defaultReadLeaseSeconds = DEFAULT_READ_LEASE_SECONDS,
  maxAdmittedPerShop = 20,
  maxConcurrentPerShop = 5,
  maxGlobalConcurrent = 100,
  queueWhenFull: defaultQueueWhenFull = false,
} = {}) {
  if (typeof database?.connect !== "function") {
    throw new TypeError(
      "Transactional PostgreSQL database pool with connect() is required",
    );
  }
  if (
    !Number.isSafeInteger(maxAdmittedPerShop) ||
    maxAdmittedPerShop < 1 ||
    !Number.isSafeInteger(maxConcurrentPerShop) ||
    maxConcurrentPerShop < 1 ||
    !Number.isSafeInteger(maxGlobalConcurrent) ||
    maxGlobalConcurrent < 1
  ) {
    throw new TypeError("Bounded repository admission and concurrency limits are required");
  }

  async function withTransaction(callback) {
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL statement_timeout = '10000ms'");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors after failure
      }
      throw error;
    } finally {
      client.release?.();
    }
  }

  async function verifyJobRetentionAndDrift(
    client,
    job,
    { renewLease = false, readLeaseSeconds = defaultReadLeaseSeconds } = {},
  ) {
    await client.query(
      'LOCK TABLE "mirror"."publications" IN ACCESS SHARE MODE',
    );

    if (job.manifest && typeof job.manifest === "object") {
      if (
        (job.manifest.generationId !== undefined &&
          String(job.manifest.generationId) !== String(job.generation_id)) ||
        (job.manifest.coverageRevision !== undefined &&
          String(job.manifest.coverageRevision) !==
            String(job.coverage_revision)) ||
        (job.manifest.mappingVersion !== undefined &&
          job.mapping_version !== undefined &&
          String(job.manifest.mappingVersion) !== String(job.mapping_version))
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Export job pin drifted from immutable manifest",
        );
      }
    }

    const genRes = await client.query(
      `SELECT g.id,
              g.coverage_revision,
              g.mapping_version,
              g.mirror_schema_version,
              g.source_contract_version,
              g.status,
              g.retain_until,
              (p.generation_id IS NOT NULL) AS is_current_publication
       FROM mirror.generations g
       LEFT JOIN mirror.publications p
         ON p.shop_id = g.shop_id
        AND p.generation_id = g.id
       WHERE g.shop_id = $1
         AND g.id = $2
       FOR SHARE OF g`,
      [job.shop_id, job.generation_id],
    );

    if (genRes.rowCount === 0) {
      throw new ExportContractError(
        EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
        "Pinned export generation no longer exists",
      );
    }

    const generation = genRes.rows[0];
    if (generation.status !== "PUBLISHED") {
      throw new ExportContractError(
        EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
        "Pinned export generation is no longer published",
      );
    }

    if (
      String(generation.coverage_revision) !== String(job.coverage_revision) ||
      (job.mapping_version &&
        generation.mapping_version &&
        String(generation.mapping_version) !== String(job.mapping_version))
    ) {
      throw new ExportContractError(
        EXPORT_ERROR_CODES.SCHEMA_DRIFT,
        "Pinned export generation coverage revision or mapping version drifted",
      );
    }

    if (
      (job.manifest?.mirrorSchemaVersion &&
        generation.mirror_schema_version &&
        String(generation.mirror_schema_version) !==
          String(job.manifest.mirrorSchemaVersion)) ||
      (job.manifest?.sourceContractVersion &&
        generation.source_contract_version &&
        String(generation.source_contract_version) !==
          String(job.manifest.sourceContractVersion))
    ) {
      throw new ExportContractError(
        EXPORT_ERROR_CODES.SCHEMA_DRIFT,
        "Pinned export generation schema or source contract drifted",
      );
    }

    let lease = null;
    if (job.read_lease_id) {
      const leaseRes = await client.query(
        `SELECT *,
                (expires_at > clock_timestamp()) AS active
         FROM mirror.generation_read_leases
         WHERE shop_id = $1
           AND id = $2
           AND owner = $3
           AND operation = 'export'
         FOR UPDATE`,
        [job.shop_id, job.read_lease_id, job.id],
      );

      if (leaseRes.rowCount === 0) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
          "Pinned export generation read lease is missing or released",
        );
      }

      lease = leaseRes.rows[0];
      const leaseActive =
        lease.active !== undefined
          ? lease.active === true
          : new Date(lease.expires_at).getTime() > Date.now();

      if (!leaseActive) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
          "Pinned export generation read lease expired",
        );
      }

      if (
        String(lease.generation_id) !== String(job.generation_id) ||
        String(lease.coverage_revision) !== String(job.coverage_revision) ||
        (job.mapping_version &&
          lease.mapping_version &&
          String(lease.mapping_version) !== String(job.mapping_version))
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Generation read lease pin drifted from export job",
        );
      }

      if (renewLease) {
        const renewedRes = await client.query(
          `UPDATE mirror.generation_read_leases
           SET expires_at = clock_timestamp() + ($3 || ' seconds')::interval
           WHERE shop_id = $1
             AND id = $2
           RETURNING *`,
          [job.shop_id, job.read_lease_id, String(readLeaseSeconds)],
        );
        if (renewedRes.rowCount > 0) {
          lease = renewedRes.rows[0];
        }
      }
    } else {
      const isRetained =
        generation.is_current_publication ||
        (generation.retain_until &&
          new Date(generation.retain_until).getTime() > Date.now());
      if (!isRetained) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
          "Pinned export generation is no longer retained",
        );
      }
    }

    return Object.freeze({
      verified: true,
      generationId: generation.id,
      coverageRevision: generation.coverage_revision,
      mappingVersion: generation.mapping_version,
      readLeaseId: lease?.id ?? job.read_lease_id ?? null,
      expiresAt: lease?.expires_at
        ? new Date(lease.expires_at).toISOString()
        : null,
    });
  }

  return Object.freeze({
    async getJob({ shopId, installationId, jobId } = {}) {
      return withTransaction(async (client) => {
        const res = await client.query(
          `SELECT *
           FROM mirror.export_manifest_jobs
           WHERE shop_id = $1
             AND installation_id = $2
             AND id = $3`,
          [shopId, installationId, jobId],
        );
        return res.rowCount > 0 ? formatJobRow(res.rows[0]) : null;
      });
    },

    async verifyRetention({
      shopId,
      installationId,
      jobId,
      renewLease = false,
      readLeaseSeconds = defaultReadLeaseSeconds,
    } = {}) {
      return withTransaction(async (client) => {
        const res = await client.query(
          `SELECT *
           FROM mirror.export_manifest_jobs
           WHERE shop_id = $1
             AND installation_id = $2
             AND id = $3
           FOR UPDATE`,
          [shopId, installationId, jobId],
        );
        if (res.rowCount === 0) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.INVALID_REQUEST,
            "Export job not found",
          );
        }
        return verifyJobRetentionAndDrift(client, res.rows[0], {
          renewLease,
          readLeaseSeconds,
        });
      });
    },

    async releaseReadLease({ shopId, installationId, jobId } = {}) {
      return withTransaction(async (client) => {
        const res = await client.query(
          `SELECT *
           FROM mirror.export_manifest_jobs
           WHERE shop_id = $1
             AND installation_id = $2
             AND id = $3
           FOR UPDATE`,
          [shopId, installationId, jobId],
        );
        if (res.rowCount === 0) return false;
        const job = res.rows[0];
        if (!job.read_lease_id) return false;
        await client.query(
          `DELETE FROM mirror.generation_read_leases
           WHERE shop_id = $1
             AND id = $2
             AND owner = $3
             AND operation = 'export'`,
          [shopId, job.read_lease_id, job.id],
        );
        return true;
      });
    },

    async findByIdempotencyKey({
      shopId,
      installationId,
      idempotencyKey,
    } = {}) {
      if (
        typeof shopId !== "string" ||
        !shopId ||
        typeof installationId !== "string" ||
        !installationId
      ) {
        return null;
      }
      const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
      return withTransaction(async (client) => {
        const res = await client.query(
          `SELECT *
           FROM mirror.export_manifest_jobs
           WHERE shop_id = $1
             AND installation_id = $2
             AND idempotency_key = $3`,
          [shopId, installationId, normalizedKey],
        );
        return res.rowCount > 0 ? formatJobRow(res.rows[0]) : null;
      });
    },

    /**
     * Atomically creates a new export job (with generation read lease and
     * dispatch outbox event) or returns the existing job if the idempotency
     * key was already committed with the exact same `requestFingerprint`.
     */
    async createOrGet({
      shopId,
      installationId,
      idempotencyKey,
      requestFingerprint,
      manifestFingerprint,
      state = EXPORT_STATES.QUEUED,
      queueWhenFull = defaultQueueWhenFull,
      prepared,
      readLeaseSeconds = defaultReadLeaseSeconds,
    } = {}) {
      if (
        typeof shopId !== "string" ||
        !shopId ||
        typeof installationId !== "string" ||
        !installationId ||
        typeof requestFingerprint !== "string" ||
        !requestFingerprint ||
        typeof manifestFingerprint !== "string" ||
        !manifestFingerprint
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.INVALID_REQUEST,
          "Shop, installation, and fingerprints are required",
        );
      }

      const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
      const generationId = prepared?.generationId;
      const coverageRevision = prepared?.coverageRevision;

      if (!generationId || !coverageRevision) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.MISSING_COVERAGE,
          "Pinned generationId and coverageRevision are required",
        );
      }

      return withTransaction(async (client) => {
        // 1. Serialize concurrent requests for the same (shop, installation, idempotencyKey)
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
          [`${shopId}:${installationId}`, normalizedKey],
        );

        // 2. Check for an existing idempotency record and compare request_fingerprint FIRST
        //    (before any admission or concurrency slot reservation).
        const existingRes = await client.query(
          `SELECT *
           FROM mirror.export_manifest_jobs
           WHERE shop_id = $1
             AND installation_id = $2
             AND idempotency_key = $3
           FOR UPDATE`,
          [shopId, installationId, normalizedKey],
        );

        if (existingRes.rowCount > 0) {
          const existing = existingRes.rows[0];

          if (existing.request_fingerprint !== requestFingerprint) {
            throw new ExportContractError(
              EXPORT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              "Idempotency key already used with different export request parameters",
            );
          }

          return Object.freeze({
            created: false,
            job: formatJobRow(existing),
          });
        }

        // 3. Acquire publication barrier protection in ACCESS SHARE mode
        await client.query(
          'LOCK TABLE "mirror"."publications" IN ACCESS SHARE MODE',
        );

        // 4. Verify active tenant installation
        const shopRes = await client.query(
          `SELECT id, installation_version
           FROM mirror.shops
           WHERE id = $1
             AND installation_version = $2
             AND uninstalled_at IS NULL
           FOR SHARE`,
          [shopId, installationId],
        );

        if (shopRes.rowCount === 0) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.UNAUTHORIZED,
            "Authenticated shop installation is not active",
          );
        }

        // 4b. Atomic admission, per-shop concurrency, and global worker capacity checks
        const capacityRes = await client.query(
          `SELECT
             count(*) FILTER (
               WHERE shop_id = $1
                 AND installation_id = $2
                 AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED', 'EXPIRED')
             )::int AS shop_admitted,
             count(*) FILTER (
               WHERE shop_id = $1
                 AND state IN ('QUEUED', 'RUNNING', 'FINALIZING', 'RECOVERING')
             )::int AS shop_active,
             count(*) FILTER (
               WHERE state IN ('QUEUED', 'RUNNING', 'FINALIZING', 'RECOVERING')
             )::int AS global_active
           FROM mirror.export_manifest_jobs`,
          [shopId, installationId],
        );

        const capacity = capacityRes.rows[0] ?? {
          shop_admitted: 0,
          shop_active: 0,
          global_active: 0,
        };

        if (Number(capacity.shop_admitted) >= maxAdmittedPerShop) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.CAPACITY_EXCEEDED,
            "Shop export admission limit exceeded",
            { retryable: true },
          );
        }

        let effectiveState = state;
        if (
          Number(capacity.shop_active) >= maxConcurrentPerShop ||
          Number(capacity.global_active) >= maxGlobalConcurrent
        ) {
          if (queueWhenFull || state === EXPORT_STATES.WAITING_FOR_CAPACITY) {
            effectiveState = EXPORT_STATES.WAITING_FOR_CAPACITY;
          } else {
            throw new ExportContractError(
              EXPORT_ERROR_CODES.CAPACITY_EXCEEDED,
              "Export execution concurrency or global worker capacity exceeded",
              { retryable: true },
            );
          }
        }

        // 5. Verify target generation eligibility and lock generation row FOR SHARE
        const genRes = await client.query(
          `SELECT g.id,
                  g.coverage_revision,
                  g.mapping_version,
                  g.status,
                  g.retain_until,
                  (p.generation_id IS NOT NULL) AS is_current_publication
           FROM mirror.generations g
           LEFT JOIN mirror.publications p
             ON p.shop_id = g.shop_id
            AND p.generation_id = g.id
           WHERE g.shop_id = $1
             AND g.id = $2
           FOR SHARE OF g`,
          [shopId, generationId],
        );

        if (genRes.rowCount === 0) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
            "Pinned export generation does not exist",
          );
        }

        const generation = genRes.rows[0];
        if (generation.coverage_revision !== coverageRevision) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.SCHEMA_DRIFT,
            "Generation coverage revision changed before export creation",
          );
        }

        const expectedMappingVersion =
          prepared?.mappingVersion ?? prepared?.manifest?.mappingVersion;
        if (
          expectedMappingVersion &&
          generation.mapping_version &&
          generation.mapping_version !== expectedMappingVersion
        ) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.SCHEMA_DRIFT,
            "Generation mapping version drifted before export creation",
          );
        }

        if (
          prepared?.manifest?.mirrorSchemaVersion &&
          generation.mirror_schema_version &&
          generation.mirror_schema_version !==
            prepared.manifest.mirrorSchemaVersion
        ) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.SCHEMA_DRIFT,
            "Generation mirror schema version drifted before export creation",
          );
        }

        if (
          prepared?.manifest?.sourceContractVersion &&
          generation.source_contract_version &&
          generation.source_contract_version !==
            prepared.manifest.sourceContractVersion
        ) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.SCHEMA_DRIFT,
            "Generation source contract version drifted before export creation",
          );
        }

        const isEligiblePublished =
          generation.status === "PUBLISHED" &&
          (generation.is_current_publication ||
            (generation.retain_until &&
              new Date(generation.retain_until).getTime() > Date.now()));

        if (!isEligiblePublished) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
            "Pinned export generation is no longer published or retained",
          );
        }

        // 6. Acquire durable read lease on the generation
        const jobId = randomUUID();
        const readLeaseId = randomUUID();

        await client.query(
          `INSERT INTO mirror.generation_read_leases (
             shop_id, id, generation_id, coverage_revision, mapping_version,
             operation, owner, expires_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             'export', $6, clock_timestamp() + ($7 || ' seconds')::interval
           )`,
          [
            shopId,
            readLeaseId,
            generation.id,
            generation.coverage_revision,
            generation.mapping_version,
            jobId,
            String(readLeaseSeconds),
          ],
        );

        // 7. Insert the export manifest job
        const manifestPayload = buildManifestPayload(prepared);

        const jobRes = await client.query(
          `INSERT INTO mirror.export_manifest_jobs (
             id, shop_id, installation_id,
             idempotency_key, request_fingerprint, manifest_fingerprint,
             contract_version, manifest_version,
             generation_id, coverage_revision, mapping_version, read_lease_id,
             manifest, state
           ) VALUES (
             $1, $2, $3,
             $4, $5, $6,
             $7, $8,
             $9, $10, $11, $12,
             $13::jsonb, $14
           )
           RETURNING *`,
          [
            jobId,
            shopId,
            installationId,
            normalizedKey,
            requestFingerprint,
            manifestFingerprint,
            prepared?.contractVersion ?? EXPORT_CONTRACT_VERSION,
            prepared?.manifestVersion ?? EXPORT_MANIFEST_VERSION,
            generation.id,
            generation.coverage_revision,
            generation.mapping_version,
            readLeaseId,
            JSON.stringify(manifestPayload),
            effectiveState,
          ],
        );

        const createdJob = jobRes.rows[0];

        // 8. Insert durable dispatch outbox event inside the same transaction when queued
        if (effectiveState === EXPORT_STATES.QUEUED) {
          const dedupeKey = `export:${shopId}:${installationId}:${jobId}`;
          await client.query(
            `INSERT INTO mirror.export_dispatch_outbox (
               shop_id, installation_id, export_job_id, dedupe_key, payload
             ) VALUES (
               $1, $2, $3, $4, $5::jsonb
             )`,
            [
              shopId,
              installationId,
              jobId,
              dedupeKey,
              JSON.stringify({
                exportJobId: jobId,
                shopId,
                installationId,
                generationId: generation.id,
                coverageRevision: generation.coverage_revision,
              }),
            ],
          );
        }

        return Object.freeze({
          created: true,
          job: formatJobRow(createdJob),
        });
      });
    },

    /**
     * Scheduler: promotes WAITING_FOR_CAPACITY jobs to QUEUED when per-shop
     * and global capacity slots become available.
     */
    async scheduleWaitingJobs({ batchSize = 50 } = {}) {
      return withTransaction(async (client) => {
        const globalActiveRes = await client.query(
          `SELECT count(*)::int AS count
           FROM mirror.export_manifest_jobs
           WHERE state IN ('QUEUED', 'RUNNING', 'FINALIZING', 'RECOVERING')`,
        );

        let globalRemaining = Math.max(
          0,
          maxGlobalConcurrent - (globalActiveRes.rows[0]?.count ?? 0),
        );

        if (globalRemaining <= 0) {
          return Object.freeze({ promoted: 0, jobs: Object.freeze([]) });
        }

        const waitingRes = await client.query(
          `SELECT *
           FROM mirror.export_manifest_jobs
           WHERE state = 'WAITING_FOR_CAPACITY'
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED`,
          [Math.min(batchSize, globalRemaining * 4)],
        );

        const promotedJobs = [];
        const shopActiveCache = new Map();

        for (const row of waitingRes.rows) {
          if (globalRemaining <= 0) break;

          let shopActive = shopActiveCache.get(row.shop_id);
          if (shopActive === undefined) {
            const shopActiveRes = await client.query(
              `SELECT count(*)::int AS count
               FROM mirror.export_manifest_jobs
               WHERE shop_id = $1
                 AND state IN ('QUEUED', 'RUNNING', 'FINALIZING', 'RECOVERING')`,
              [row.shop_id],
            );
            shopActive = shopActiveRes.rows[0]?.count ?? 0;
          }

          if (shopActive >= maxConcurrentPerShop) {
            shopActiveCache.set(row.shop_id, shopActive);
            continue;
          }

          try {
            await verifyJobRetentionAndDrift(client, row, {
              renewLease: true,
              readLeaseSeconds: defaultReadLeaseSeconds,
            });
          } catch (error) {
            if (
              error instanceof ExportContractError &&
              [
                EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
                EXPORT_ERROR_CODES.SCHEMA_DRIFT,
                EXPORT_ERROR_CODES.MISSING_COVERAGE,
              ].includes(error.code)
            ) {
              await client.query(
                `UPDATE mirror.export_manifest_jobs
                 SET state = 'FAILED',
                     updated_at = clock_timestamp()
                 WHERE shop_id = $1
                   AND id = $2`,
                [row.shop_id, row.id],
              );
              continue;
            }
            throw error;
          }

          const updatedRes = await client.query(
            `UPDATE mirror.export_manifest_jobs
             SET state = 'QUEUED',
                 updated_at = clock_timestamp()
             WHERE shop_id = $1
               AND id = $2
               AND state = 'WAITING_FOR_CAPACITY'
             RETURNING *`,
            [row.shop_id, row.id],
          );

          if (updatedRes.rowCount === 1) {
            const updated = updatedRes.rows[0];
            const dedupeKey = `export:${updated.shop_id}:${updated.installation_id}:${updated.id}`;
            await client.query(
              `INSERT INTO mirror.export_dispatch_outbox (
                 shop_id, installation_id, export_job_id, dedupe_key, payload
               ) VALUES (
                 $1, $2, $3, $4, $5::jsonb
               )
               ON CONFLICT (shop_id, dedupe_key) DO NOTHING`,
              [
                updated.shop_id,
                updated.installation_id,
                updated.id,
                dedupeKey,
                JSON.stringify({
                  exportJobId: updated.id,
                  shopId: updated.shop_id,
                  installationId: updated.installation_id,
                  generationId: updated.generation_id,
                  coverageRevision: updated.coverage_revision,
                }),
              ],
            );

            shopActiveCache.set(row.shop_id, shopActive + 1);
            globalRemaining -= 1;
            promotedJobs.push(formatJobRow(updated));
          }
        }

        return Object.freeze({
          promoted: promotedJobs.length,
          jobs: Object.freeze(promotedJobs),
        });
      });
    },

    /**
     * Worker claim enforcing per-shop concurrency, global worker capacity,
     * generation retention renewal, and zero schema/coverage drift across retries.
     */
    async claimNext({
      leaseSeconds = 60,
      readLeaseSeconds = defaultReadLeaseSeconds,
    } = {}) {
      return withTransaction(async (client) => {
        const globalActiveRes = await client.query(
          `SELECT count(*)::int AS count
           FROM mirror.export_manifest_jobs
           WHERE state IN ('RUNNING', 'FINALIZING', 'RECOVERING')`,
        );

        if ((globalActiveRes.rows[0]?.count ?? 0) >= maxGlobalConcurrent) {
          return null;
        }

        const candidateRes = await client.query(
          `SELECT j.*
           FROM mirror.export_manifest_jobs j
           WHERE j.state = 'QUEUED'
             AND (
               SELECT count(*)
               FROM mirror.export_manifest_jobs active
               WHERE active.shop_id = j.shop_id
                 AND active.state IN ('RUNNING', 'FINALIZING', 'RECOVERING')
             ) < $1
           ORDER BY j.created_at ASC
           LIMIT 1
           FOR UPDATE OF j SKIP LOCKED`,
          [maxConcurrentPerShop],
        );

        if (candidateRes.rowCount === 0) {
          return null;
        }

        const candidate = candidateRes.rows[0];
        await verifyJobRetentionAndDrift(client, candidate, {
          renewLease: true,
          readLeaseSeconds,
        });

        const leaseToken = randomUUID();
        const claimRes = await client.query(
          `UPDATE mirror.export_manifest_jobs j
           SET state = 'RUNNING',
               attempts = j.attempts + 1,
               fence_epoch = j.fence_epoch + 1,
               lease_token = $3::uuid,
               lease_expires_at = clock_timestamp() + ($4 || ' seconds')::interval,
               updated_at = clock_timestamp()
           WHERE j.shop_id = $1
             AND j.id = $2
             AND j.state = 'QUEUED'
           RETURNING j.*`,
          [
            candidate.shop_id,
            candidate.id,
            leaseToken,
            String(leaseSeconds),
          ],
        );

        if (claimRes.rowCount === 0) {
          return null;
        }

        return formatJobRow(claimRes.rows[0]);
      });
    },

    /**
     * Fenced state transition on an existing export job with generation
     * retention & drift verification across retries and terminal lease cleanup.
     */
    async transitionState({
      shopId,
      jobId,
      expectedFenceEpoch,
      leaseToken,
      toState,
      readLeaseSeconds = defaultReadLeaseSeconds,
    } = {}) {
      return withTransaction(async (client) => {
        const currentRes = await client.query(
          `SELECT *
           FROM mirror.export_manifest_jobs
           WHERE shop_id = $1 AND id = $2
           FOR UPDATE`,
          [shopId, jobId],
        );

        if (currentRes.rowCount === 0) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.INVALID_REQUEST,
            "Export job not found",
          );
        }

        const current = currentRes.rows[0];
        if (
          expectedFenceEpoch !== undefined &&
          String(current.fence_epoch) !== String(expectedFenceEpoch)
        ) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.LEASE_LOST,
            "Export job fence epoch mismatch",
          );
        }

        if (
          leaseToken !== undefined &&
          current.lease_token !== leaseToken
        ) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.LEASE_LOST,
            "Export job lease token mismatch",
          );
        }

        assertExportTransition(current.state, toState);

        if (
          [
            EXPORT_STATES.QUEUED,
            EXPORT_STATES.RUNNING,
            EXPORT_STATES.FINALIZING,
            EXPORT_STATES.COMPLETED,
          ].includes(toState)
        ) {
          await verifyJobRetentionAndDrift(client, current, {
            renewLease:
              toState === EXPORT_STATES.QUEUED ||
              toState === EXPORT_STATES.RUNNING,
            readLeaseSeconds,
          });
        }

        const updatedRes = await client.query(
          `UPDATE mirror.export_manifest_jobs
           SET state = $3,
               updated_at = clock_timestamp()
           WHERE shop_id = $1
             AND id = $2
             AND fence_epoch = $4
           RETURNING *`,
          [shopId, jobId, toState, current.fence_epoch],
        );

        if (
          [
            EXPORT_STATES.COMPLETED,
            EXPORT_STATES.CANCELLED,
            EXPORT_STATES.FAILED,
            EXPORT_STATES.EXPIRED,
          ].includes(toState) &&
          current.read_lease_id
        ) {
          await client.query(
            `DELETE FROM mirror.generation_read_leases
             WHERE shop_id = $1
               AND id = $2
               AND owner = $3
               AND operation = 'export'`,
            [shopId, current.read_lease_id, current.id],
          );
        }

        return formatJobRow(updatedRes.rows[0]);
      });
    },
  });
}

