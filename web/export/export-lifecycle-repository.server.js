
/**
 * METAMAX — Export Repository V2
 *
 * web/export/export-repository.server.js
 *
 * Requires:
 * - PostgreSQL (pg-compatible pool)
 * - export_engine V2 migration
 * - export-contract.js V2
 *
 * PostgreSQL is authoritative for:
 * - Idempotency
 * - State transitions
 * - Worker claims and fencing
 * - Output checkpoints
 * - Final artifact registration
 * - Durable outbox delivery
 *
 * This module NEVER calls Shopify, Redis or BullMQ.
 *
 * Security-critical adapters are mandatory.
 */

import {
  randomUUID,
  createHash,
} from "node:crypto";

import {
  EXPORT_STATES as S,
  EXPORT_LIMITS as L,
  EXPORT_ERROR_CODES as C,
  EXPORT_CONTRACT_VERSION,
  EXPORT_MANIFEST_VERSION,
  ExportContractError,
  assertExportTransition,
  normalizeIdempotencyKey,
  canonicalizeJson,
} from "./export-contract.js";
import { assertTrustedExportPrepared } from "./export-service.server.js";

// =====================================================
// CONSTANTS
// =====================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SHA_RE = /^sha256:[a-f0-9]{64}$/;

const MAX_BIGINT = 9223372036854775807n;

const WORKER_LEASE_MIN = 5_000;
const WORKER_LEASE_MAX = 300_000;

const OUTBOX_STATES = Object.freeze({
  PENDING: "PENDING",
  CLAIMED: "CLAIMED",
  UNKNOWN: "UNKNOWN",
  RECONCILING: "RECONCILING",
  RETRY_ELIGIBLE: "RETRY_ELIGIBLE",
  DELIVERED: "DELIVERED",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
});

const TERMINAL = new Set([
  S.COMPLETED,
  S.CANCELLED,
  S.FAILED,
  S.EXPIRED,
]);

// =====================================================
// ERRORS AND VALIDATION
// =====================================================

function fail(code, message, retryable = false) {
  throw new ExportContractError(code, message, {
    retryable,
  });
}

function requiredString(value, name, maxBytes = 255) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }

  return value;
}

function uuid(value, name) {
  if (
    typeof value !== "string" ||
    !UUID_RE.test(value)
  ) {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }

  return value.toLowerCase();
}

function sha(value, name) {
  if (
    typeof value !== "string" ||
    !SHA_RE.test(value)
  ) {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }

  return value;
}

function int(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }

  return value;
}

function pgBigint(value, name) {
  if (
    typeof value !== "string" &&
    typeof value !== "bigint" &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  ) {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }

  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }
  let n;

  try {
    n = BigInt(value);
  } catch {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }

  if (n < 0n || n > MAX_BIGINT) {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }

  return n.toString();
}

function identityOf(identity) {
  if (
    !identity ||
    typeof identity !== "object"
  ) {
    fail(C.UNAUTHORIZED, "Trusted shop identity required");
  }

  return Object.freeze({
    shopId: requiredString(
      identity.shopId,
      "shopId",
    ),
    installationId: requiredString(
      identity.installationId,
      "installationId",
    ),
  });
}

function claimOf(claim) {
  if (!claim || typeof claim !== "object") {
    fail(C.LEASE_LOST, "Worker claim required");
  }

  return Object.freeze({
    leaseToken: uuid(
      claim.leaseToken,
      "leaseToken",
    ),
    fenceEpoch: pgBigint(
      claim.fenceEpoch,
      "fenceEpoch",
    ),
  });
}

function outboxClaimOf(claim) {
  if (!claim || typeof claim !== "object") {
    fail(C.LEASE_LOST, "Outbox claim required");
  }

  return Object.freeze({
    claimToken: uuid(
      claim.claimToken,
      "claimToken",
    ),
    fenceEpoch: pgBigint(
      claim.fenceEpoch,
      "fenceEpoch",
    ),
  });
}

function jsonObject(value, name, maxBytes = L.MAX_REQUEST_BYTES) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    fail(C.INVALID_REQUEST, `Invalid ${name}`);
  }

  return canonicalizeJson(value, {
    maxDepth: 32,
    maxNodes: 10_000,
    maxBytes,
  });
}

function requireAdapter(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(
      `Required Export Repository adapter missing: ${name}`,
    );
  }

  return value;
}

function hashJson(value) {
  return `sha256:${
    createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex")
  }`;
}

function verifyEqual(actual, expected, name) {
  if (String(actual) !== String(expected)) {
    fail(C.ARTIFACT_INTEGRITY_FAILED, `${name} mismatch`);
  }
}

const accountingVersion = format => ({ CSV: "csv-assembled-v1", JSONL: "jsonl-assembled-v1", XLSX: "xlsx-packaged-v1" })[format];

function requireImmutableReceipt(receipt, expected) {
  if (receipt?.verified !== true || receipt.immutable !== true || receipt.rowCountVerified !== true) {
    fail(C.ARTIFACT_INTEGRITY_FAILED, "Independent immutable object and row-count verification required");
  }
  for (const key of ["storageKey", "storageVersion", "checksum", "rowCount", "byteCount"]) {
    verifyEqual(receipt[key], expected[key], key);
  }
}

function partHash(parts) {
  return hashJson(parts.map(p => ({ partNumber: p.part_number, storageKey: p.storage_key,
    storageVersion: p.storage_version, checksum: p.checksum, rowCount: String(p.row_count), byteCount: String(p.byte_count) })));
}

// pg bigint values must remain lossless even when a deployment changes pg parsers.
const BIGINT_KEYS = new Set(["fence_epoch", "committed_fence", "checkpoint_version", "rows_committed", "bytes_committed",
  "row_count", "byte_count", "source_byte_count"]);
function encode(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encode);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    BIGINT_KEYS.has(key) && entry != null ? pgBigint(entry, key) : encode(entry)]));
}

// =====================================================
// TRANSACTIONS
// =====================================================

async function withTransaction(pool, work) {
  const client = await pool.connect();
  let active = false;

  try {
    await client.query("BEGIN");
    active = true;

    await client.query("SET LOCAL lock_timeout = '2000ms'");
    await client.query("SET LOCAL statement_timeout = '10000ms'");
    // Mirror writers use this same barrier before any row locks.
    await client.query("LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE");
    const result = await work(client);

    await client.query("COMMIT");
    active = false;

    return result;
  } catch (error) {
    if (active) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve original error.
      }
    }

    if (error instanceof ExportContractError) throw error;
    fail(C.EXECUTION_FAILED, "Export transaction failed", ["40001", "40P01", "55P03", "08006", "ECONNRESET"].includes(error?.code));
  } finally {
    client.release();
  }
}

// =====================================================
// REPOSITORY FACTORY
// =====================================================

export function createExportLifecycleRepository({
  pool,

  // Must verify publication eligibility and an active
  // generation read lease in the supplied transaction.
  generationProtection,

  // Must independently inspect immutable private storage.
  verifyStoredPart,

  // Must verify the final artifact and bind it to
  // the exact committed part-set hash.
  verifyFinalArtifact,

  // Must verify queue delivery evidence.
  verifyDeliveryEvidence,

  // Must use authoritative execution/queue evidence
  // to classify an uncertain delivery.
  reconcileDelivery,
  // Independently establishes external part/final-artifact outcome during recovery.
  verifyRecoveryEvidence,

  maxExecutionAttempts = L.MAX_ATTEMPTS,
  maxReconciliationAttempts = 5, maxAdmittedPerShop = 20, maxConcurrentPerShop = 2, maxGlobalConcurrent = 32,
  retryBaseMs = 1000,
  retryMaxMs = 300000,

  logger = console,
} = {}) {
  if (
    !pool ||
    typeof pool.connect !== "function" ||
    typeof pool.query !== "function"
  ) {
    throw new TypeError(
      "A pg-compatible PostgreSQL pool is required",
    );
  }

  for (const method of ["verify", "renew", "release"]) {
    requireAdapter(generationProtection?.[method], `generationProtection.${method}`);
  }
  const verifyGenerationLease = input => generationProtection.verify(input);
  requireAdapter(
    verifyStoredPart,
    "verifyStoredPart",
  );
  requireAdapter(
    verifyFinalArtifact,
    "verifyFinalArtifact",
  );
  requireAdapter(
    verifyDeliveryEvidence,
    "verifyDeliveryEvidence",
  );
  requireAdapter(
    reconcileDelivery,
    "reconcileDelivery",
  );
  requireAdapter(verifyRecoveryEvidence, "verifyRecoveryEvidence");

  int(
    maxExecutionAttempts,
    "maxExecutionAttempts",
    1,
    100,
  );

  int(maxReconciliationAttempts, "maxReconciliationAttempts", 1, 100); int(maxAdmittedPerShop, "maxAdmittedPerShop", 1, 10000); int(maxConcurrentPerShop, "maxConcurrentPerShop", 1, 1000); int(maxGlobalConcurrent, "maxGlobalConcurrent", 1, 10000);
  int(retryBaseMs, "retryBaseMs", 1, 300000);
  int(retryMaxMs, "retryMaxMs", retryBaseMs, 3600000);
  const retryDelay = attempt => Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(Number(attempt), 20));

  // ===================================================
  // PRIVATE JOB LOCKING
  // ===================================================

  async function lockJob(
    client,
    identity,
    jobId,
  ) {
    const result = await client.query(
      `SELECT *, lease_expires_at > clock_timestamp() AS lease_valid
       FROM export_engine.jobs
       WHERE id = $1
         AND shop_id = $2
         AND installation_id = $3
       FOR UPDATE`,
      [
        jobId,
        identity.shopId,
        identity.installationId,
      ],
    );

    return result.rows[0] ?? null;
  }

  function assertOwner(job, claim, states) {
    if (
      !job ||
      !states.includes(job.state) ||
      (job.cancel_requested && !states.includes(S.CANCELLING)) ||
      !job.lease_token ||
      job.lease_token !== claim.leaseToken ||
      String(job.fence_epoch) !== claim.fenceEpoch ||
      !job.lease_expires_at ||
      job.lease_valid !== true
    ) {
      fail(C.LEASE_LOST, "Export worker claim is invalid");
    }
  }

  // ===================================================
  // GENERATION MANIFEST
  // ===================================================

  function validateManifest({
    manifest,
    identity,
    manifestFingerprint,
  }) {
    const document = jsonObject(manifest, "manifest");
    if (!["CSV", "JSONL", "XLSX"].includes(document.format)) fail(C.UNSUPPORTED_FORMAT, "Manifest format required");

    const required = [
      "generationId",
      "coverageRevision",
      "mappingVersion",
      "compilerVersion",
      "filterFingerprint",
      "fieldProjectionFingerprint",
    ];

    for (const key of required) {
      if (
        document[key] === undefined ||
        document[key] === null ||
        document[key] === ""
      ) {
        fail(C.INVALID_REQUEST, `Missing manifest field: ${key}`);
      }
    }

    verifyEqual(
      document.shopId,
      identity.shopId,
      "Manifest shop",
    );

    verifyEqual(
      document.installationId,
      identity.installationId,
      "Manifest installation",
    );

    const actualFingerprint = hashJson(document);

    if (actualFingerprint !== manifestFingerprint) {
      fail(
        C.INVALID_REQUEST,
        "Manifest fingerprint mismatch",
      );
    }

    return document;
  }

  // ===================================================
  // ===================================================
  // IDEMPOTENT JOB CREATION
  function assertJobManifestPin(job) {
    if (!job?.manifest || typeof job.manifest !== "object") fail(C.SCHEMA_DRIFT, "Export job manifest is missing");
    if (job.manifest_fingerprint !== undefined && hashJson(jsonObject(job.manifest, "manifest")) !== job.manifest_fingerprint) fail(C.SCHEMA_DRIFT, "Export job manifest fingerprint drifted");
    if (job.manifest.generationId !== undefined && String(job.manifest.generationId) !== String(job.generation_id)) fail(C.SCHEMA_DRIFT, "Export job generationId drifted from manifest");
    if (job.manifest.coverageRevision !== undefined && String(job.manifest.coverageRevision) !== String(job.coverage_revision)) fail(C.SCHEMA_DRIFT, "Export job coverageRevision drifted from manifest");
    if (job.manifest.mappingVersion !== undefined && String(job.manifest.mappingVersion) !== String(job.mapping_version)) fail(C.SCHEMA_DRIFT, "Export job mappingVersion drifted from manifest");
    if (job.manifest.compilerVersion !== undefined && job.compiler_version !== undefined && String(job.manifest.compilerVersion) !== String(job.compiler_version)) fail(C.SCHEMA_DRIFT, "Export job compilerVersion drifted from manifest");
  }
  // ===================================================

  async function createJob({
    identity,
    idempotencyKey,
    requestFingerprint,
    manifestFingerprint,
    manifest,
    admit = false,
  }) {
    const id = identityOf(identity);

    const key = normalizeIdempotencyKey(
      idempotencyKey,
    );

    const requestHash = sha(
      requestFingerprint,
      "requestFingerprint",
    );

    const manifestHash = sha(
      manifestFingerprint,
      "manifestFingerprint",
    );

    const document = validateManifest({
      manifest,
      identity: id,
      manifestFingerprint: manifestHash,
    });

    return withTransaction(pool, async (client) => {
      // Serialize equal idempotency identities even when
      // there is no existing row yet.
      //
      // Hash collisions only introduce extra serialization,
      // not incorrect identity matches.
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended($1::text, 0)
         )`,
        [
          JSON.stringify([
            "export-idempotency-v2",
            id.shopId,
            id.installationId,
            key,
          ]),
        ],
      );

      const existing = await client.query(
        `SELECT *
         FROM export_engine.jobs
         WHERE shop_id = $1
           AND installation_id = $2
           AND idempotency_key = $3`,
        [
          id.shopId,
          id.installationId,
          key,
        ],
      );

      if (existing.rows.length) {
        const job = existing.rows[0];

        if (job.request_fingerprint !== requestHash) {
          fail(
            C.IDEMPOTENCY_CONFLICT,
            "Idempotency key belongs to another request",
          );
        }

        return {
          created: false,
          job,
        };
      }

      // The adapter MUST perform authoritative
      // transaction-scoped publication/lease checks.
      //
      // It must not simply trust manifest fields.
      const admittedCount = Number((await client.query(`SELECT count(*)::int AS c FROM export_engine.jobs WHERE shop_id = $1 AND installation_id = $2 AND state NOT IN ('COMPLETED','CANCELLED','FAILED','EXPIRED')`, [id.shopId, id.installationId])).rows[0].c);
      if (admittedCount >= maxAdmittedPerShop) fail(C.CAPACITY_EXCEEDED, "Shop export admission limit exceeded", true);
      const jobId = randomUUID();
      const lease = await verifyGenerationLease({
        client,
        identity: id,
        manifest: document,
        purpose: "ADMISSION",
        jobId,
      });

      if (
        !lease ||
        lease.verified !== true ||
        !lease.leaseId ||
        !lease.expiresAt
      ) {
        fail(
          C.MISSING_COVERAGE,
          "Verified generation read lease required",
        );
      }

      verifyEqual(
        lease.generationId,
        document.generationId,
        "Generation",
      );

      verifyEqual(
        lease.coverageRevision,
        document.coverageRevision,
        "Coverage revision",
      );

      const inserted = await client.query(
        `INSERT INTO export_engine.jobs (
           id,
           shop_id,
           installation_id,
           idempotency_key,
           request_fingerprint,
           manifest_fingerprint,
           contract_version,
           manifest_version,
           manifest,
           generation_id,
           coverage_revision,
           mapping_version,
           compiler_version,
           generation_lease_id,
           generation_lease_expires_at,
           state
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,
           $9::jsonb,$10,$11,$12,$13,
           $14,$15::timestamptz,'PENDING'
         )
         RETURNING *`,
        [
          jobId,
          id.shopId,
          id.installationId,
          key,
          requestHash,
          manifestHash,
          EXPORT_CONTRACT_VERSION,
          EXPORT_MANIFEST_VERSION,
          JSON.stringify(document),
          String(document.generationId),
          String(document.coverageRevision),
          String(document.mappingVersion),
          String(document.compilerVersion),
          String(lease.leaseId),
          lease.expiresAt,
        ],
      );

      let created = inserted.rows[0];
      if (admit) {
        await client.query("UPDATE export_engine.jobs SET state='VALIDATING' WHERE id=$1",[jobId]);
        created=(await client.query("UPDATE export_engine.jobs SET state='WAITING_FOR_CAPACITY' WHERE id=$1 RETURNING *",[jobId])).rows[0];
      }
      return {created:true,job:created};
    });
  }

  // ===================================================
  // READ JOB
  // ===================================================

  async function getJob({
    identity,
    jobId,
  }) {
    const id = identityOf(identity);
    uuid(jobId, "jobId");

    const result = await pool.query(
      `SELECT *
       FROM export_engine.jobs
       WHERE id = $1
         AND shop_id = $2
         AND installation_id = $3`,
      [
        jobId,
        id.shopId,
        id.installationId,
      ],
    );

    return result.rows[0] ?? null;
  }

  // ===================================================
  // DURABLE OUTBOX APPEND
  // ===================================================

  async function appendOutbox(client, jobId) {
    const eventId = randomUUID();

    await client.query(
      `INSERT INTO export_engine.outbox (
         id,
         job_id,
         event_type,
         delivery_key,
         payload,
         state
       ) VALUES (
         $1,$2,'EXPORT_READY',$3,
         $4::jsonb,'PENDING'
       )`,
      [
        eventId,
        jobId,
        eventId,
        JSON.stringify({
          exportJobId: jobId,
        }),
      ],
    );

    return eventId;
  }

  // ===================================================
  // CONDITIONAL ADMINISTRATIVE TRANSITION
  // ===================================================

  async function transition({
    identity,
    jobId,
    fromState,
    toState,
    failureCode = null,
  }) {
    const id = identityOf(identity);
    uuid(jobId, "jobId");
    if (failureCode !== null && !Object.values(C).includes(failureCode)) fail(C.INVALID_REQUEST, "Unknown failure code");

    assertExportTransition(fromState, toState);

    // Active worker transitions must use fencing.
    if (
      [S.RUNNING, S.FINALIZING, S.COMPLETED, S.RECOVERING, S.RETRY_WAIT, S.CANCELLING].includes(toState) ||
      [S.RUNNING, S.FINALIZING, S.RECOVERING, S.RETRY_WAIT, S.CANCELLING, S.REVIEW_REQUIRED].includes(fromState) ||
      TERMINAL.has(fromState) ||
      toState === S.CANCELLED
    ) {
      fail(
        C.INVALID_STATE_TRANSITION,
        "Worker or terminal transition requires dedicated method",
      );
    }

    return withTransaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE export_engine.jobs
         SET state = $4,
             failure_code = $5,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND shop_id = $2
           AND installation_id = $3
           AND state = $6
           AND cancel_requested = FALSE
           AND lease_token IS NULL
         RETURNING *`,
        [
          jobId,
          id.shopId,
          id.installationId,
          toState,
          failureCode,
          fromState,
        ],
      );

      if (!result.rows.length) {
        fail(
          C.INVALID_STATE_TRANSITION,
          "Stale export state transition",
        );
      }

      if (toState === S.QUEUED) {
        await appendOutbox(client, jobId);
      }

      return result.rows[0];
    });
  }

  // ===================================================
  // FENCED WORKER CLAIM
  // ===================================================

  async function claimNext({
    workerId,
    leaseMs = 60_000,
    jobId = null,
  }) {
    if(jobId!==null)uuid(jobId,"jobId");
    requiredString(workerId, "workerId", 128);

    int(
      leaseMs,
      "leaseMs",
      WORKER_LEASE_MIN,
      WORKER_LEASE_MAX,
    );

    return withTransaction(pool, async (client) => {
      const result = await client.query(
        `SELECT id, shop_id, installation_id
         FROM export_engine.jobs
         WHERE state = 'QUEUED'
           AND cancel_requested = FALSE
           AND ($4::uuid IS NULL OR id=$4)
           AND attempts < $1 AND (SELECT count(*)::int FROM export_engine.jobs active WHERE active.state IN ('RUNNING','FINALIZING','RECOVERING')) < $3 AND (SELECT count(*)::int FROM export_engine.jobs active WHERE active.shop_id = export_engine.jobs.shop_id AND active.state IN ('RUNNING','FINALIZING','RECOVERING')) < $2
           AND (
             next_attempt_at IS NULL
             OR next_attempt_at <= clock_timestamp()
           )
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [maxExecutionAttempts, maxConcurrentPerShop, maxGlobalConcurrent, jobId],
      );

      if (!result.rows.length) {
        return null;
      }

      const candidate = await lockJob(client, {shopId: result.rows[0].shop_id, installationId: result.rows[0].installation_id}, result.rows[0].id);
      await client.query("SAVEPOINT export_claim_authorization");
      try {
        assertJobManifestPin(candidate);
        const protection=await generationProtection.renew({client, identity: identityOf({shopId:candidate.shop_id, installationId:candidate.installation_id}), job:candidate, purpose:"CLAIM"});
        if(protection?.verified!==true)fail(C.SNAPSHOT_EXPIRED,"Verified claim generation protection required");
        await client.query("RELEASE SAVEPOINT export_claim_authorization");
      } catch(error) {
        if(!(error instanceof ExportContractError)||![C.SNAPSHOT_EXPIRED,C.SCHEMA_DRIFT,C.MISSING_COVERAGE,C.UNAUTHORIZED].includes(error.code))throw error;
        await client.query("ROLLBACK TO SAVEPOINT export_claim_authorization");
        await client.query("RELEASE SAVEPOINT export_claim_authorization");
        await client.query("UPDATE export_engine.jobs SET state='FAILED',failure_code=$2,updated_at=clock_timestamp() WHERE id=$1",[candidate.id,error.code]);
        return null;
      }
      const token = randomUUID();

      const updated = await client.query(
        `UPDATE export_engine.jobs
         SET state = resume_state,
             retry_verified = FALSE,
             attempts = attempts + 1,
             fence_epoch = fence_epoch + 1,
             lease_owner = $2,
             lease_token = $3,
             lease_expires_at =
               clock_timestamp() +
               ($4::integer * interval '1 millisecond'),
             heartbeat_at = clock_timestamp(),
             started_at = COALESCE(
               started_at, clock_timestamp()
             ),
             updated_at = clock_timestamp()
         WHERE id = $1
           AND state = 'QUEUED'
           AND cancel_requested = FALSE
           AND attempts < $5
         RETURNING *,
           fence_epoch::text AS fence_epoch_text`,
        [
          result.rows[0].id,
          workerId,
          token,
          leaseMs,
          maxExecutionAttempts,
        ],
      );

      const job = updated.rows[0];

      if (!job) {
        return null;
      }

      return {
        job,
        claim: {
          leaseToken: token,
          fenceEpoch: job.fence_epoch_text,
        },
      };
    });
  }

  // ===================================================
  // WORKER HEARTBEAT
  // ===================================================

  async function heartbeat({
    identity,
    jobId,
    claim,
    leaseMs = 60_000,
  }) {
    const id = identityOf(identity);
    const owner = claimOf(claim);

    uuid(jobId, "jobId");

    int(
      leaseMs,
      "leaseMs",
      WORKER_LEASE_MIN,
      WORKER_LEASE_MAX,
    );

    const result = await pool.query(
      `UPDATE export_engine.jobs
       SET lease_expires_at =
             clock_timestamp() +
             ($6::integer * interval '1 millisecond'),
           heartbeat_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1
         AND shop_id = $2
         AND installation_id = $3
         AND lease_token = $4
         AND fence_epoch = $5::bigint
         AND lease_expires_at > clock_timestamp()
         AND state IN ('RUNNING','FINALIZING')
         AND cancel_requested = FALSE
       RETURNING id, lease_expires_at`,
      [
        jobId,
        id.shopId,
        id.installationId,
        owner.leaseToken,
        owner.fenceEpoch,
        leaseMs,
      ],
    );

    if (!result.rows.length) {
      fail(C.LEASE_LOST, "Worker lease lost");
    }

    return result.rows[0];
  }

  // ===================================================
  // COMMIT VERIFIED STORAGE PART
  // ===================================================

  async function commitPart({
    identity,
    jobId,
    claim,
    expectedVersion,
    partNumber,
    storageKey,
    storageVersion,
    checksum,
    rowCount,
    byteCount,
    cursor,
  }) {
    const id = identityOf(identity);
    const owner = claimOf(claim);

    uuid(jobId, "jobId");

    int(expectedVersion, "expectedVersion");
    int(partNumber, "partNumber");
    int(rowCount, "rowCount");
    int(byteCount, "byteCount");

    requiredString(
      storageKey,
      "storageKey",
      1024,
    );

    requiredString(storageVersion, "storageVersion", 1024);
    sha(checksum, "checksum");

    if (partNumber !== expectedVersion) {
      fail(
        C.CHECKPOINT_CONFLICT,
        "Part sequence does not match checkpoint",
      );
    }

    const nextCursor = jsonObject(
      cursor,
      "checkpoint cursor",
      8192,
    );

    // Verify storage before acquiring PostgreSQL locks.
    //
    // The adapter must check the actual immutable object,
    // checksum, size and job-specific storage namespace.
    const verified = await verifyStoredPart({
      identity: id,
      jobId,
      partNumber,
      storageKey,
      storageVersion,
      checksum,
      rowCount,
      byteCount,
    });

    if (!verified || verified.verified !== true) {
      fail(
        C.ARTIFACT_INTEGRITY_FAILED,
        "Storage part verification failed",
      );
    }

    verifyEqual(
      verified.storageKey,
      storageKey,
      "Storage key",
    );

    verifyEqual(
      verified.checksum,
      checksum,
      "Part checksum",
    );

    verifyEqual(
      verified.byteCount,
      byteCount,
      "Part size",
    );

    requireImmutableReceipt(verified, {storageKey, storageVersion, checksum, rowCount, byteCount});
    return withTransaction(pool, async (client) => {
      const job = await lockJob(client, id, jobId);
      assertOwner(job, owner, [S.RUNNING]);

      if (
        BigInt(job.checkpoint_version) !==
        BigInt(expectedVersion)
      ) {
        fail(
          C.CHECKPOINT_CONFLICT,
          "Checkpoint version changed",
        );
      }

      // Validate authoritative generation retention
      assertJobManifestPin(job);
      // inside the transaction.
      const lease = await verifyGenerationLease({
        client,
        identity: id,
        job,
        purpose: "CHECKPOINT",
      });

      if (
        !lease ||
        lease.verified !== true ||
        String(lease.generationId) !==
          String(job.generation_id) ||
        String(lease.coverageRevision) !==
          String(job.coverage_revision)
      ) {
        fail(
          C.SNAPSHOT_EXPIRED,
          "Generation protection is unavailable",
        );
      }

      const nextRows =
        BigInt(job.rows_committed) +
        BigInt(rowCount);

      const nextBytes =
        BigInt(job.bytes_committed) +
        BigInt(byteCount);

      const format = job.manifest?.format;

      if (!["CSV", "JSONL", "XLSX"].includes(format)) {
        fail(C.INVALID_REQUEST, "Invalid manifest format");
      }

      const maxRows =
        format === "XLSX"
          ? BigInt(L.MAX_XLSX_ROWS_PER_SHEET)
          : BigInt(L.MAX_CSV_JSONL_ROWS);

      if (
        nextRows > maxRows ||
        nextBytes > BigInt(L.MAX_INTERMEDIATE_BYTES)
      ) {
        fail(
          C.TOO_LARGE,
          "Export resource budget exceeded",
        );
      }

      await client.query(
        `INSERT INTO export_engine.parts (
           job_id,
           part_number,
           storage_key,
           checksum,
           row_count,
           byte_count,
           checkpoint_after,
           committed_fence, storage_version
         ) VALUES (
           $1,$2,$3,$4,$5,$6,
           $7::jsonb,$8::bigint,$9
         )`,
        [
          jobId,
          partNumber,
          storageKey,
          checksum,
          rowCount,
          byteCount,
          JSON.stringify(nextCursor),
          owner.fenceEpoch,
          storageVersion,
        ],
      );

      const updated = await client.query(
        `UPDATE export_engine.jobs
         SET checkpoint_version =
               checkpoint_version + 1,
             checkpoint = $6::jsonb,
             rows_committed = $7,
             bytes_committed = $8,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND shop_id = $2
           AND installation_id = $3
           AND fence_epoch = $4::bigint
           AND lease_token = $5
           AND lease_expires_at > clock_timestamp()
           AND state = 'RUNNING'
           AND cancel_requested = FALSE
           AND checkpoint_version = $9
         RETURNING *`,
        [
          jobId,
          id.shopId,
          id.installationId,
          owner.fenceEpoch,
          owner.leaseToken,
          JSON.stringify(nextCursor),
          nextRows.toString(),
          nextBytes.toString(),
          expectedVersion,
        ],
      );

      if (!updated.rows.length) {
        fail(
          C.CHECKPOINT_CONFLICT,
          "Checkpoint update lost ownership",
        );
      }

      return updated.rows[0];
    });
  }

  // ===================================================
  // WORKER STATE TRANSITION
  // ===================================================

  async function transitionWorker({
    identity,
    jobId,
    claim,
    fromState,
    toState,
    failureCode = null,
  }) {
    const id = identityOf(identity);
    const owner = claimOf(claim);
    if (failureCode !== null && !Object.values(C).includes(failureCode)) fail(C.INVALID_REQUEST, "Unknown failure code");

    uuid(jobId, "jobId");

    assertExportTransition(fromState, toState);

    // Completion belongs exclusively to finalizeArtifact.
    if (toState === S.COMPLETED) {
      fail(
        C.INVALID_STATE_TRANSITION,
        "Use finalizeArtifact for completion",
      );
    }

    if (
      ![S.RUNNING, S.FINALIZING].includes(fromState) ||
      ![
        S.FINALIZING,
        S.RETRY_WAIT,
        S.CANCELLING,
        S.FAILED,
      ].includes(toState)
    ) {
      fail(
        C.INVALID_STATE_TRANSITION,
        "Unsupported worker transition",
      );
    }

    // Preserve V2's requested retry state, but do not authorize execution replay.
    // Due unverified retries are claimed by recovery, never by the dispatcher.
    if (toState === S.RETRY_WAIT) {
      const result = await pool.query(`UPDATE export_engine.jobs SET state='RETRY_WAIT',resume_state=$6,
        retry_verified=FALSE,failure_code=$7,fence_epoch=fence_epoch+1,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
        next_attempt_at=clock_timestamp()+$8::integer*interval '1 millisecond',updated_at=clock_timestamp()
        WHERE id=$1 AND shop_id=$2 AND installation_id=$3 AND lease_token=$4 AND fence_epoch=$5::bigint
          AND state=$6 AND NOT cancel_requested AND lease_expires_at>clock_timestamp() RETURNING *`,
        [jobId,id.shopId,id.installationId,owner.leaseToken,owner.fenceEpoch,fromState,failureCode,retryDelay(1)]);
      if (!result.rows[0]) fail(C.LEASE_LOST,"Retry lost worker ownership");
      return result.rows[0];
    }

    const release =
      ![S.FINALIZING, S.CANCELLING].includes(toState);

    const result = await pool.query(
      `UPDATE export_engine.jobs
       SET state = $6,
           failure_code = $7,
           cancel_requested = CASE WHEN $6='CANCELLING' THEN TRUE ELSE cancel_requested END,
           next_attempt_at = NULL,
           lease_owner = CASE
             WHEN $9::boolean THEN NULL
             ELSE lease_owner END,
           lease_token = CASE
             WHEN $9::boolean THEN NULL
             ELSE lease_token END,
           lease_expires_at = CASE
             WHEN $9::boolean THEN NULL
             ELSE lease_expires_at END,
           updated_at = clock_timestamp()
       WHERE id = $1
         AND shop_id = $2
         AND installation_id = $3
         AND lease_token = $4
         AND fence_epoch = $5::bigint
         AND state = $8
         AND lease_expires_at > clock_timestamp()
         AND cancel_requested = FALSE
       RETURNING *`,
      [
        jobId,
        id.shopId,
        id.installationId,
        owner.leaseToken,
        owner.fenceEpoch,
        toState,
        failureCode,
        fromState,
        release,
      ],
    );

    if (!result.rows.length) {
      fail(C.LEASE_LOST, "Stale worker transition");
    }

    return result.rows[0];
  }

  // ===================================================
  // FINAL ARTIFACT
  // ===================================================

  async function finalizeArtifact({
    identity,
    jobId,
    claim,
    expectedCheckpointVersion,
    artifact,
  }) {
    const id = identityOf(identity);
    const owner = claimOf(claim);

    uuid(jobId, "jobId");

    int(
      expectedCheckpointVersion,
      "expectedCheckpointVersion",
    );

    const spec = jsonObject(
      artifact,
      "artifact",
      16 * 1024,
    );

    requiredString(
      spec.storageKey,
      "storageKey",
      1024,
    );

    requiredString(spec.storageVersion, "storageVersion", 1024);
    sha(spec.checksum, "checksum");

    if (!["CSV", "JSONL", "XLSX"].includes(spec.format)) {
      fail(C.UNSUPPORTED_FORMAT, "Invalid artifact format");
    }

    int(spec.rowCount, "rowCount");
    int(spec.byteCount, "byteCount");
    int(spec.partCount, "partCount");
    if (spec.byteCount > L.MAX_OUTPUT_BYTES) fail(C.TOO_LARGE, "Final artifact exceeds output budget");

    if (
      spec.partCount !== expectedCheckpointVersion
    ) {
      fail(
        C.CHECKPOINT_CONFLICT,
        "Artifact part count mismatch",
      );
    }

    const expiresAt = new Date(spec.expiresAt);

    if (!Number.isFinite(expiresAt.getTime())) {
      fail(C.INVALID_REQUEST, "Invalid artifact expiry");
    }

    // Fetch the committed part manifest before storage
    // verification. It will be checked again under lock.
    const partResult = await pool.query(
      `SELECT p.part_number, p.storage_key, p.storage_version, p.checksum,
              p.row_count, p.byte_count, p.checkpoint_after
       FROM export_engine.parts p JOIN export_engine.jobs j ON j.id=p.job_id
       WHERE p.job_id = $1 AND j.shop_id=$2 AND j.installation_id=$3
       ORDER BY part_number ASC`,
      [jobId, id.shopId, id.installationId],
    );

    const parts = partResult.rows;

    if (parts.length !== spec.partCount) {
      fail(
        C.ARTIFACT_INTEGRITY_FAILED,
        "Incomplete part sequence",
      );
    }

    for (let index = 0; index < parts.length; index++) {
      if (parts[index].part_number !== index) {
        fail(
          C.ARTIFACT_INTEGRITY_FAILED,
          "Non-contiguous part sequence",
        );
      }
    }

    const partSetHash = hashJson(
      parts.map((part) => ({
        partNumber: part.part_number,
        storageKey: part.storage_key,
        storageVersion: part.storage_version,
        checksum: part.checksum,
        rowCount: String(part.row_count),
        byteCount: String(part.byte_count),
      })),
    );

    // Trusted adapter must independently inspect the final
    // object, not trust the caller's artifact description.
    //
    // It must also attest that the object was constructed
    // from precisely this ordered, immutable set of parts.
    const receipt = await verifyFinalArtifact({
      identity: id,
      jobId,
      artifact: spec,
      parts,
      partSetHash,
    });

    if (
      !receipt ||
      receipt.verified !== true ||
      receipt.partSetHash !== partSetHash
    ) {
      fail(
        C.ARTIFACT_INTEGRITY_FAILED,
        "Final artifact verification failed",
      );
    }

    for (const key of [
      "storageKey",
      "checksum",
      "format",
      "rowCount",
      "byteCount",
    ]) {
      verifyEqual(
        receipt[key],
        spec[key],
        `Artifact ${key}`,
      );
    }

    requireImmutableReceipt(receipt, spec);
    const storageReceipt = jsonObject(
      receipt,
      "storage receipt",
      16 * 1024,
    );

    return withTransaction(pool, async (client) => {
      const job = await lockJob(client, id, jobId);

      // A competing finalizer or an unknown COMMIT outcome may already have
      // registered this exact immutable artifact. Return that durable outcome;
      // never update terminal execution or register a second artifact.
      if (job?.state === S.COMPLETED) {
        verifyEqual(job.checkpoint_version, expectedCheckpointVersion, "Final checkpoint");
        const stored = (await client.query(`SELECT a.* FROM export_engine.artifacts a
          JOIN export_engine.jobs j ON j.id=a.job_id WHERE a.job_id=$1 AND j.shop_id=$2 AND j.installation_id=$3`,
          [jobId,id.shopId,id.installationId])).rows[0];
        if (!stored) fail(C.ARTIFACT_INTEGRITY_FAILED,"Completed export artifact missing");
        for (const [column,key] of [["storage_key","storageKey"],["storage_version","storageVersion"],
          ["checksum","checksum"],["format","format"],["row_count","rowCount"],["byte_count","byteCount"],["part_count","partCount"]]) {
          verifyEqual(stored[column],spec[key],`Registered artifact ${key}`);
        }
        verifyEqual(new Date(stored.expires_at).toISOString(),expiresAt.toISOString(),"Artifact expiry");
        return {job,artifact:spec,replayed:true};
      }

      assertOwner(job, owner, [S.FINALIZING]);

      if (
        BigInt(job.checkpoint_version) !==
        BigInt(expectedCheckpointVersion)
      ) {
        fail(
          C.CHECKPOINT_CONFLICT,
          "Checkpoint changed before finalization",
        );
      }

      verifyEqual(
        job.rows_committed,
        spec.rowCount,
        "Committed row count",
      );

      verifyEqual(
        job.manifest?.format,
        spec.format,
        "Artifact format",
      );

      verifyEqual(receipt.accountingVersion, accountingVersion(spec.format), "Accounting version");
      verifyEqual(receipt.sourceByteCount, job.bytes_committed, "Intermediate byte count");
      const totalBytes = parts.reduce((n, p) => n + BigInt(p.byte_count), 0n);
      const totalRows = parts.reduce((n, p) => n + BigInt(p.row_count), 0n);
      verifyEqual(totalBytes, job.bytes_committed, "Durable intermediate bytes");
      verifyEqual(totalRows, job.rows_committed, "Durable rows");

      // Verify that the part set has not changed since
      // external storage verification.
      const lockedParts = await client.query(
        `SELECT p.part_number, p.storage_key, p.storage_version, p.checksum,
                p.row_count, p.byte_count
         FROM export_engine.parts p JOIN export_engine.jobs j ON j.id=p.job_id
         WHERE p.job_id = $1 AND j.shop_id=$2 AND j.installation_id=$3
         ORDER BY part_number ASC`,
        [jobId, id.shopId, id.installationId],
      );

      const lockedHash = hashJson(
        lockedParts.rows.map((part) => ({
          partNumber: part.part_number,
          storageKey: part.storage_key,
          storageVersion: part.storage_version,
          checksum: part.checksum,
          rowCount: String(part.row_count),
          byteCount: String(part.byte_count),
        })),
      );

      if (
        lockedHash !== partSetHash ||
        lockedParts.rows.length !== spec.partCount
      ) {
        fail(
          C.ARTIFACT_INTEGRITY_FAILED,
          "Committed part set changed",
        );
      }

      const lease = await verifyGenerationLease({
        client,
        identity: id,
        job,
        purpose: "FINALIZATION",
      });

      if (
        !lease ||
        lease.verified !== true ||
        String(lease.generationId) !==
          String(job.generation_id) ||
        String(lease.coverageRevision) !==
          String(job.coverage_revision)
      ) {
        fail(
          C.SNAPSHOT_EXPIRED,
          "Generation protection lost",
        );
      }

      await client.query(
        `INSERT INTO export_engine.artifacts (
           job_id,
           storage_key,
           checksum,
           format,
           byte_count,
           row_count,
           part_count,
           storage_receipt,
           expires_at, storage_version, source_byte_count, accounting_version
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12
         )`,
        [
          jobId,
          spec.storageKey,
          spec.checksum,
          spec.format,
          spec.byteCount,
          spec.rowCount,
          spec.partCount,
          JSON.stringify(storageReceipt),
          expiresAt,
          spec.storageVersion,
          job.bytes_committed,
          accountingVersion(spec.format),
        ],
      );

      const updated = await client.query(
        `UPDATE export_engine.jobs
         SET state = 'COMPLETED',
             completed_at = clock_timestamp(),
             expires_at = $6,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND shop_id = $2
           AND installation_id = $3
           AND lease_token = $4
           AND fence_epoch = $5::bigint
           AND lease_expires_at > clock_timestamp()
           AND state = 'FINALIZING'
           AND cancel_requested = FALSE
           AND $6::timestamptz > clock_timestamp()
           AND $6::timestamptz <= clock_timestamp() + interval '30 days'
         RETURNING *`,
        [
          jobId,
          id.shopId,
          id.installationId,
          owner.leaseToken,
          owner.fenceEpoch,
          expiresAt,
        ],
      );

      if (!updated.rows.length) {
        fail(
          C.LEASE_LOST,
          "Finalization lost worker ownership",
        );
      }

      return {
        job: updated.rows[0],
        artifact: spec,
      };
    });
  }

  // ===================================================
  // CANCELLATION
  // ===================================================

  async function requestCancellation({
    identity,
    jobId,
  }) {
    const id = identityOf(identity);
    uuid(jobId, "jobId");

    const result = await pool.query(
      `UPDATE export_engine.jobs
       SET cancel_requested = TRUE,
           state = 'CANCELLING',
           updated_at = clock_timestamp()
       WHERE id = $1
         AND shop_id = $2
         AND installation_id = $3
         AND state NOT IN (
           'COMPLETED','CANCELLED','FAILED','EXPIRED'
         )
       RETURNING *`,
      [
        jobId,
        id.shopId,
        id.installationId,
      ],
    );

    return result.rows[0] ?? null;
  }

  async function finalizeCancellation({
    identity,
    jobId,
  }) {
    const id = identityOf(identity);
    uuid(jobId, "jobId");

    const result = await pool.query(
      `UPDATE export_engine.jobs
       SET state = 'CANCELLED',
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           fence_epoch = fence_epoch + 1,
           updated_at = clock_timestamp()
       WHERE id = $1
         AND shop_id = $2
         AND installation_id = $3
         AND cancel_requested = TRUE
         AND state IN (
           'CANCELLING'
         )
         AND (
           lease_token IS NULL
           OR lease_expires_at <= clock_timestamp()
         )
       RETURNING *`,
      [
        jobId,
        id.shopId,
        id.installationId,
      ],
    );

    return result.rows[0] ?? null;
  }

  // ===================================================
  // OUTBOX: CLAIM ONLY SAFE-TO-DELIVER EVENTS
  // ===================================================

  async function claimOutbox({
    dispatcherId,
    batchSize = 20,
    leaseMs = 60_000,
  }) {
    requiredString(
      dispatcherId,
      "dispatcherId",
      128,
    );

    int(batchSize, "batchSize", 1, 100);

    int(
      leaseMs,
      "leaseMs",
      WORKER_LEASE_MIN,
      WORKER_LEASE_MAX,
    );

    return withTransaction(pool, async (client) => {
      const selected = await client.query(
        `SELECT o.id
         FROM export_engine.outbox o
         JOIN export_engine.jobs j ON j.id=o.job_id
         JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_id
         WHERE o.state IN ('PENDING','RETRY_ELIGIBLE')
           AND j.state='QUEUED' AND NOT j.cancel_requested
           AND s.uninstalled_at IS NULL
           AND j.attempts < $2
           AND o.attempts < $3
           AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= clock_timestamp())
           AND o.available_at <= clock_timestamp()
         ORDER BY o.created_at, o.id
         FOR UPDATE OF o, j SKIP LOCKED
         LIMIT $1`,
        [batchSize, maxExecutionAttempts, maxReconciliationAttempts],
      );

      const output = [];

      for (const row of selected.rows) {
        const token = randomUUID();

        const updated = await client.query(
          `UPDATE export_engine.outbox
           SET state = 'CLAIMED',
               claim_owner = $2,
               claim_token = $3,
               claim_expires_at =
                 clock_timestamp() +
                 ($4::integer * interval '1 millisecond'),
               fence_epoch = fence_epoch + 1,
               attempts = attempts + 1,
               updated_at = clock_timestamp()
           WHERE id = $1
             AND state IN (
               'PENDING','RETRY_ELIGIBLE'
             )
           RETURNING *,
             fence_epoch::text AS fence_epoch_text`,
          [
            row.id,
            dispatcherId,
            token,
            leaseMs,
          ],
        );

        const event = updated.rows[0];

        if (!event) continue;

        output.push({
          event,
          claim: {
            claimToken: token,
            fenceEpoch: event.fence_epoch_text,
          },
        });
      }

      return output;
    });
  }

  // ===================================================
  // OUTBOX: CONFIRMED ACKNOWLEDGEMENT
  // ===================================================

  async function acknowledgeOutbox({
    eventId,
    claim,
    evidence,
  }) {
    uuid(eventId, "eventId");

    const owner = outboxClaimOf(claim);

    const result = await withTransaction(
      pool,
      async (client) => {
        const locked = await client.query(
          `SELECT *, claim_expires_at > clock_timestamp() AS claim_valid
           FROM export_engine.outbox
           WHERE id = $1
           FOR UPDATE`,
          [eventId],
        );

        const event = locked.rows[0];

        if (
          !event ||
          event.state !== OUTBOX_STATES.CLAIMED ||
          event.claim_token !== owner.claimToken ||
          String(event.fence_epoch) !== owner.fenceEpoch ||
          event.claim_valid !== true
        ) {
          fail(C.LEASE_LOST, "Outbox claim is invalid");
        }

        const proof = await verifyDeliveryEvidence({
          event,
          evidence,
          client,
        });

        if (
          !proof ||
          proof.confirmed !== true
        ) {
          fail(
            C.EXECUTION_FAILED,
            "Confirmed delivery evidence required",
          );
        }

        const verifiedProof = jsonObject(
          proof,
          "delivery evidence",
          16 * 1024,
        );

        const updated = await client.query(
          `UPDATE export_engine.outbox
           SET state = 'DELIVERED',
               delivery_evidence = $4::jsonb,
               delivered_at = clock_timestamp(),
               claim_owner = NULL,
               claim_token = NULL,
               claim_expires_at = NULL,
               updated_at = clock_timestamp()
           WHERE id = $1
             AND state = 'CLAIMED'
             AND claim_token = $2
             AND fence_epoch = $3::bigint
             AND claim_expires_at > clock_timestamp()
           RETURNING *`,
          [
            eventId,
            owner.claimToken,
            owner.fenceEpoch,
            JSON.stringify(verifiedProof),
          ],
        );

        if (!updated.rows.length) {
          fail(C.LEASE_LOST, "Outbox acknowledgement lost ownership");
        }

        return updated.rows[0];
      },
    );

    return result;
  }

  // ===================================================
  // OUTBOX: EXPLICIT UNKNOWN OUTCOME
  // ===================================================

  async function markOutboxUnknown({
    eventId,
    claim,
    errorCode = "DELIVERY_OUTCOME_UNKNOWN",
  }) {
    uuid(eventId, "eventId");

    const owner = outboxClaimOf(claim);

    requiredString(errorCode, "errorCode", 128);

    const result = await pool.query(
      `UPDATE export_engine.outbox
       SET state = 'UNKNOWN',
           last_error_code = $4,
           claim_owner = NULL,
           claim_token = NULL,
           claim_expires_at = NULL,
           last_checked_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1
         AND state = 'CLAIMED'
         AND claim_token = $2
         AND fence_epoch = $3::bigint
         AND claim_expires_at > clock_timestamp()
       RETURNING *`,
      [
        eventId,
        owner.claimToken,
        owner.fenceEpoch,
        errorCode,
      ],
    );

    if (!result.rows.length) {
      fail(C.LEASE_LOST, "Outbox claim is no longer valid");
    }

    return result.rows[0];
  }

  // ===================================================
  // OUTBOX: RECOVER EXPIRED CLAIMS AS UNKNOWN
  // ===================================================

  async function recoverExpiredOutbox({
    batchSize = 100,
  } = {}) {
    int(batchSize, "batchSize", 1, 1000);

    return withTransaction(pool, async (client) => {
      const updated = await client.query(
        `WITH expired AS (
           SELECT id
           FROM export_engine.outbox
           WHERE state = 'CLAIMED'
             AND claim_expires_at <= clock_timestamp()
           ORDER BY claim_expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE export_engine.outbox o
         SET state = 'UNKNOWN',
             claim_owner = NULL,
             claim_token = NULL,
             claim_expires_at = NULL,
             fence_epoch = o.fence_epoch + 1,
             last_error_code = 'DELIVERY_CLAIM_EXPIRED',
             updated_at = clock_timestamp()
         FROM expired
         WHERE o.id = expired.id
         RETURNING o.id`,
        [batchSize],
      );

      return updated.rows;
    });
  }

  // ===================================================
  // OUTBOX: UNCERTAIN DELIVERY RECONCILIATION
  // ===================================================

  async function reconcileUnknownOutbox({
    eventId,
    reconcilerId,
    leaseMs = 60_000,
  }) {
    uuid(eventId, "eventId");

    requiredString(
      reconcilerId,
      "reconcilerId",
      128,
    );

    int(
      leaseMs,
      "leaseMs",
      WORKER_LEASE_MIN,
      WORKER_LEASE_MAX,
    );

    const token = randomUUID();

    const claimed = await pool.query(
      `UPDATE export_engine.outbox
       SET state = 'RECONCILING',
           reconciliation_attempts = reconciliation_attempts + 1,
           claim_owner = $2,
           claim_token = $3,
           claim_expires_at =
             clock_timestamp() +
             ($4::integer * interval '1 millisecond'),
           fence_epoch = fence_epoch + 1,
           updated_at = clock_timestamp()
       WHERE id = $1
         AND state = 'UNKNOWN'
         AND available_at <= clock_timestamp()
         AND reconciliation_attempts < $5
       RETURNING *,
         fence_epoch::text AS fence_epoch_text`,
      [
        eventId,
        reconcilerId,
        token,
        leaseMs,
        maxReconciliationAttempts,
      ],
    );

    const event = claimed.rows[0];

    if (!event) {
      return null;
    }

    const claim = {
      claimToken: token,
      fenceEpoch: event.fence_epoch_text,
    };

    // IMPORTANT:
    // Reconciliation is an evidence-based decision.
    // Redis job absence alone must NEVER be treated
    // as proof that the event was not delivered.
    let assessment;

    try {
      assessment = await reconcileDelivery({
        event,
        claim,
      });
    } catch (error) {
      logger.error?.(
        {
          eventId,
          errorCode: "EXPORT_OUTBOX_RECONCILE_FAILED",
        },
        "Export outbox reconciliation failed",
      );

      assessment = {
        decision: event.reconciliation_attempts >= maxReconciliationAttempts ? "REVIEW_REQUIRED" : "UNKNOWN",
        reason: "RECONCILIATION_FAILED",
      };
    }

    const allowed = new Set([
      "DELIVERED",
      "RETRY_ELIGIBLE",
      "REVIEW_REQUIRED",
      "UNKNOWN",
    ]);

    const decision = assessment?.decision;

    if (!allowed.has(decision)) {
      assessment = {
        decision: "REVIEW_REQUIRED",
        reason: "INSUFFICIENT_EVIDENCE",
      };
    }

    // A retry must have positive safety evidence,
    // not simply absence of a BullMQ job.
    if (
      assessment.decision === "RETRY_ELIGIBLE" &&
      assessment.safeToRetry !== true
    ) {
      assessment = {
        decision: "REVIEW_REQUIRED",
        reason: "RETRY_NOT_PROVEN_SAFE",
      };
    }

    // An accepted delivery must have positive proof.
    if (
      assessment.decision === "DELIVERED" &&
      assessment.confirmed !== true
    ) {
      assessment = {
        decision: "REVIEW_REQUIRED",
        reason: "DELIVERY_NOT_CONFIRMED",
      };
    }

    const decisionEvidence = jsonObject(
      assessment,
      "reconciliation evidence",
      16 * 1024,
    );

    return withTransaction(pool, async (client) => {
      const result = await client.query(
        `UPDATE export_engine.outbox
         SET state = $4,
             delivery_evidence = $5::jsonb,
             delivered_at = CASE
               WHEN $4 = 'DELIVERED'
                 THEN clock_timestamp()
               ELSE delivered_at
             END,
             last_checked_at = clock_timestamp(),
             claim_owner = NULL,
             claim_token = NULL,
             claim_expires_at = NULL,
             available_at = CASE
               WHEN $4 IN ('RETRY_ELIGIBLE','UNKNOWN')
                 THEN clock_timestamp() + $6::integer * interval '1 millisecond' 
               ELSE available_at
             END,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND state = 'RECONCILING'
           AND claim_token = $2
           AND fence_epoch = $3::bigint
           AND claim_expires_at > clock_timestamp()
         RETURNING *`,
        [
          eventId,
          claim.claimToken,
          claim.fenceEpoch,
          assessment.decision,
          JSON.stringify(decisionEvidence),
          retryDelay(event.reconciliation_attempts),
        ],
      );

      if (!result.rows.length) {
        fail(
          C.LEASE_LOST,
          "Reconciliation lost ownership",
        );
      }

      return result.rows[0];
    });
  }

  // ===================================================
  // RECOVERY AND GENERATION PROTECTION
  // ===================================================

  async function recoverExpiredJobs({batchSize=100, recoveryOwner, recoveryLeaseMs=60000}={}) {
    int(batchSize,"batchSize",1,1000);
    requiredString(recoveryOwner,"recoveryOwner",128);
    int(recoveryLeaseMs,"recoveryLeaseMs",WORKER_LEASE_MIN,WORKER_LEASE_MAX);
    return withTransaction(pool, async client => {
      // Cancellation needs no external replay: revoke expired owners and finish.
      await client.query(`WITH cancelled AS (SELECT id FROM export_engine.jobs WHERE state='CANCELLING'
        AND cancel_requested AND (lease_token IS NULL OR lease_expires_at<=clock_timestamp())
        ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT $1)
        UPDATE export_engine.jobs j SET state='CANCELLED',fence_epoch=j.fence_epoch+1,
          lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        FROM cancelled WHERE j.id=cancelled.id`,[batchSize]);
      const rows = (await client.query(`SELECT id FROM export_engine.jobs
        WHERE ((state IN ('RUNNING','FINALIZING','RECOVERING') AND lease_expires_at <= clock_timestamp())
          OR (state='RETRY_WAIT' AND NOT retry_verified AND next_attempt_at<=clock_timestamp()))
          AND NOT cancel_requested ORDER BY COALESCE(lease_expires_at,next_attempt_at),id FOR UPDATE SKIP LOCKED LIMIT $1`,[batchSize])).rows;
      const claims=[];
      for (const row of rows) {
        const token=randomUUID();
        const job=(await client.query(`UPDATE export_engine.jobs SET
          resume_state=CASE WHEN state IN ('RECOVERING','RETRY_WAIT') THEN resume_state ELSE state END,
          state='RECOVERING', recovery_attempts=recovery_attempts+1, fence_epoch=fence_epoch+1,
          lease_owner=$2,lease_token=$3,lease_expires_at=clock_timestamp()+$4::integer*interval '1 millisecond',
          updated_at=clock_timestamp() WHERE id=$1 RETURNING *,fence_epoch::text AS fence_epoch_text`,
          [row.id,recoveryOwner,token,recoveryLeaseMs])).rows[0];
        // Repeated coordinator crashes eventually require review, never auto-resume.
        if (job.recovery_attempts > maxReconciliationAttempts) {
          await client.query(`UPDATE export_engine.jobs SET state='REVIEW_REQUIRED',lease_owner=NULL,
            lease_token=NULL,lease_expires_at=NULL,failure_code=$2 WHERE id=$1`,[job.id,C.EXECUTION_FAILED]);
        } else claims.push({job,recoveryClaim:{leaseToken:token,fenceEpoch:job.fence_epoch_text}});
      }
      return claims;
    });
  }

  async function loadParts(client, identity, jobId) {
    return (await client.query(`SELECT p.* FROM export_engine.parts p JOIN export_engine.jobs j ON j.id=p.job_id
      WHERE p.job_id=$1 AND j.shop_id=$2 AND j.installation_id=$3 ORDER BY part_number`,
      [jobId,identity.shopId,identity.installationId])).rows;
  }

  function verifyCheckpoint(job,parts) {
    if (BigInt(parts.length)!==BigInt(job.checkpoint_version)) fail(C.CHECKPOINT_CONFLICT,"Incomplete durable checkpoint");
    let rows=0n,bytes=0n;
    for (const [index,p] of parts.entries()) {
      if(p.part_number!==index) fail(C.CHECKPOINT_CONFLICT,"Non-contiguous durable parts");
      rows+=BigInt(p.row_count); bytes+=BigInt(p.byte_count);
    }
    verifyEqual(rows,job.rows_committed,"Checkpoint rows");
    verifyEqual(bytes,job.bytes_committed,"Checkpoint bytes");
    if (hashJson(parts.at(-1)?.checkpoint_after ?? {})!==hashJson(job.checkpoint)) fail(C.CHECKPOINT_CONFLICT,"Checkpoint cursor differs from last committed part");
  }

  async function resolveRecoveredJob({identity,jobId,recoveryClaim,decision,evidence}={}) {
    const id=identityOf(identity),owner=claimOf(recoveryClaim); uuid(jobId,"jobId");
    if(!["RESUME","FAIL","REVIEW"].includes(decision)) fail(C.INVALID_REQUEST,"Unknown recovery decision");
    // Read and independently verify outside row locks; compare the same state under lock below.
    const before=await getJob({identity:id,jobId});
    if(!before) fail(C.LEASE_LOST,"Recovery job unavailable");
    const parts=await loadParts(pool,id,jobId);
    let proof;
    if(decision==="RESUME") {
      verifyCheckpoint(before,parts);
      for(const p of parts) {
        const expected={storageKey:p.storage_key,storageVersion:p.storage_version,checksum:p.checksum,
          rowCount:Number(p.row_count),byteCount:Number(p.byte_count)};
        requireImmutableReceipt(await verifyStoredPart({identity:id,jobId,partNumber:p.part_number,...expected}),expected);
      }
      proof=await verifyRecoveryEvidence({identity:id,job:encode(before),parts:encode(parts),evidence,
        partSetHash:partHash(parts),checkpointVersion:String(before.checkpoint_version),checkpointHash:hashJson(before.checkpoint)});
      // "safe to resume" means no uncertain uncommitted storage/assembly result remains.
      const isolated=proof?.artifactStatus==="FENCED_UNREGISTERED" && proof.fencedNamespaceVerified===true && String(proof.fenceEpoch)===String(before.fence_epoch);
      if(proof?.verified!==true || proof.safeToResume!==true || (proof.artifactStatus!=="ABSENT" && !isolated) ||
        proof.partSetHash!==partHash(parts) || String(proof.checkpointVersion)!==String(before.checkpoint_version) ||
        proof.checkpointHash!==hashJson(before.checkpoint)) fail(C.ARTIFACT_INTEGRITY_FAILED,"Independent recovery evidence required");
    }
    return withTransaction(pool,async client=>{
      const job=await lockJob(client,id,jobId); assertOwner(job,owner,[S.RECOVERING]);
      if(hashJson(job.checkpoint)!==hashJson(before.checkpoint) || String(job.checkpoint_version)!==String(before.checkpoint_version) ||
        partHash(await loadParts(client,id,jobId))!==partHash(parts)) fail(C.CHECKPOINT_CONFLICT,"Recovery snapshot changed");
      let next=decision==="FAIL" ? S.FAILED : decision==="REVIEW" ? S.REVIEW_REQUIRED : S.RETRY_WAIT;
      if(next===S.RETRY_WAIT) {
        if(job.attempts>=maxExecutionAttempts) next=S.FAILED;
        else {
          if((await client.query("SELECT 1 FROM export_engine.artifacts WHERE job_id=$1",[jobId])).rowCount) fail(C.ARTIFACT_INTEGRITY_FAILED,"Final artifact already registered");
          assertJobManifestPin(job);
          await generationProtection.renew({client,identity:id,job,purpose:"RECOVERY"});
          verifyCheckpoint(job,parts);
        }
      }
      const result=await client.query(`UPDATE export_engine.jobs SET state=$6,recovery_evidence=$7::jsonb,
        retry_verified=($6='RETRY_WAIT'),
        next_attempt_at=CASE WHEN $6='RETRY_WAIT' THEN clock_timestamp()+$8::integer*interval '1 millisecond' ELSE NULL END,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND shop_id=$2 AND installation_id=$3 AND lease_token=$4 AND fence_epoch=$5::bigint
          AND state='RECOVERING' AND NOT cancel_requested AND lease_expires_at>clock_timestamp() RETURNING *`,
        [jobId,id.shopId,id.installationId,owner.leaseToken,owner.fenceEpoch,next,
          JSON.stringify(jsonObject(proof ?? {decision},"recovery evidence",16384)),retryDelay(job.attempts)]);
      if(!result.rows[0]) fail(C.LEASE_LOST,"Recovery claim expired");
      return result.rows[0];
    });
  }

  async function releaseRetryWaitJobs({batchSize=100}={}) {
    int(batchSize,"batchSize",1,1000);
    return withTransaction(pool,async client=>{
      const due=(await client.query(`SELECT * FROM export_engine.jobs WHERE state='RETRY_WAIT' AND retry_verified
        AND NOT cancel_requested AND next_attempt_at<=clock_timestamp()
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $1`,[batchSize])).rows;
      const output=[];
      for(const job of due) {
        let state=job.attempts>=maxExecutionAttempts ? S.FAILED : S.QUEUED;
        if(state===S.QUEUED) {
          try { assertJobManifestPin(job); await generationProtection.verify({client,identity:identityOf({shopId:job.shop_id,installationId:job.installation_id}),job,purpose:"RETRY"}); }
          catch(error) { if(!(error instanceof ExportContractError) || ![C.SNAPSHOT_EXPIRED,C.SCHEMA_DRIFT,C.MISSING_COVERAGE,C.UNAUTHORIZED].includes(error.code)) throw error; state=S.FAILED; job._failureCode=error.code; }
        }
        output.push((await client.query(`UPDATE export_engine.jobs SET state=$2,next_attempt_at=NULL,
          failure_code=CASE WHEN $2='FAILED' THEN $3 ELSE NULL END,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
          [job.id,state,job._failureCode ?? C.SNAPSHOT_EXPIRED])).rows[0]);
        if(state===S.QUEUED) await appendOutbox(client,job.id);
      }
      return output;
    });
  }

  async function acknowledgeCancellation({identity,jobId,claim}={}) {
    const id=identityOf(identity),owner=claimOf(claim); uuid(jobId,"jobId");
    return withTransaction(pool,async client=>{
      const job=await lockJob(client,id,jobId); assertOwner(job,owner,[S.CANCELLING]);
      if(!job.cancel_requested) fail(C.INVALID_STATE_TRANSITION,"Cancellation was not requested");
      const result=await client.query(`UPDATE export_engine.jobs SET state='CANCELLED',fence_epoch=fence_epoch+1,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND shop_id=$2 AND installation_id=$3 AND lease_token=$4 AND fence_epoch=$5::bigint
          AND state='CANCELLING' AND cancel_requested AND lease_expires_at>clock_timestamp() RETURNING *`,
        [jobId,id.shopId,id.installationId,owner.leaseToken,owner.fenceEpoch]);
      if(!result.rows[0]) fail(C.LEASE_LOST,"Cancellation claim expired");
      return result.rows[0];
    });
  }

  async function recoverStalledReconciliations({batchSize=100}={}) {
    int(batchSize,"batchSize",1,1000);
    return withTransaction(pool,async client=>(await client.query(`WITH due AS (
      SELECT id FROM export_engine.outbox WHERE
        (state='RECONCILING' AND claim_expires_at<=clock_timestamp()) OR
        (state='UNKNOWN' AND reconciliation_attempts >= $2) OR
        (state IN ('PENDING','RETRY_ELIGIBLE') AND attempts >= $2)
      ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT $1)
      UPDATE export_engine.outbox o SET state=CASE WHEN o.reconciliation_attempts >= $2 OR o.attempts >= $2 THEN 'REVIEW_REQUIRED' ELSE 'UNKNOWN' END,
        fence_epoch=o.fence_epoch+1,claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL,
        available_at=clock_timestamp()+$3::integer*interval '1 millisecond',
        last_error_code='RECONCILIATION_CLAIM_EXPIRED',updated_at=clock_timestamp()
      FROM due WHERE o.id=due.id RETURNING o.*`,[batchSize,maxReconciliationAttempts,retryMaxMs])).rows);
  }

  async function renewGenerationProtection({identity,jobId,claim}={}) {
    const id=identityOf(identity),owner=claimOf(claim); uuid(jobId,"jobId");
    return withTransaction(pool,async client=>{
      const job=await lockJob(client,id,jobId); assertOwner(job,owner,[S.RUNNING,S.FINALIZING,S.RECOVERING]);
      const receipt=await generationProtection.renew({client,identity:id,job,purpose:job.state===S.RECOVERING?"RECOVERY":"RENEW"});
      // Recheck PostgreSQL time after the adapter returns.
      assertOwner(await lockJob(client,id,jobId),owner,[job.state]);
      return receipt;
    });
  }

  async function releaseProtection(client,id,job,reason) {
    if(!job || !TERMINAL.has(job.state)) fail(C.INVALID_STATE_TRANSITION,"Only terminal jobs release generation protection");
    if(job.generation_protection_released_at) return false;
    await generationProtection.release({client,identity:id,job});
    await client.query(`UPDATE export_engine.jobs SET generation_protection_released_at=clock_timestamp(),
      generation_release_reason=$2 WHERE id=$1`,[job.id,reason]);
    return true;
  }

  async function releaseGenerationProtection({identity,jobId,reason}={}) {
    const id=identityOf(identity); uuid(jobId,"jobId"); requiredString(reason,"release reason",128);
    return withTransaction(pool,async client=>releaseProtection(client,id,await lockJob(client,id,jobId),reason));
  }

  async function releaseTerminalGenerationProtections({batchSize=100}={}) {
    int(batchSize,"batchSize",1,1000);
    return withTransaction(pool,async client=>{
      const jobs=(await client.query(`SELECT * FROM export_engine.jobs WHERE state IN ('COMPLETED','FAILED','CANCELLED','EXPIRED')
        AND generation_protection_released_at IS NULL ORDER BY updated_at,id FOR UPDATE SKIP LOCKED LIMIT $1`,[batchSize])).rows;
      for(const job of jobs) await releaseProtection(client,identityOf({shopId:job.shop_id,installationId:job.installation_id}),job,"TERMINAL_CLEANUP");
      return jobs.map(j=>j.id);
    });
  }

  async function renewPendingGenerationProtection({batchSize=100}={}) {
    int(batchSize,"batchSize",1,1000);
    return withTransaction(pool,async client=>{
      const jobs=(await client.query(`SELECT j.* FROM export_engine.jobs j WHERE j.state IN ('PENDING','VALIDATING','WAITING_FOR_CAPACITY','QUEUED','RETRY_WAIT')
        AND NOT j.cancel_requested AND (j.generation_lease_expires_at <= clock_timestamp()+interval '10 minutes'
          OR NOT EXISTS(SELECT 1 FROM mirror.shops s WHERE s.id=j.shop_id AND s.installation_version=j.installation_id AND s.uninstalled_at IS NULL))
        ORDER BY j.generation_lease_expires_at,j.id FOR UPDATE OF j SKIP LOCKED LIMIT $1`,[batchSize])).rows;
      for(const job of jobs) {
        try { assertJobManifestPin(job); await generationProtection.renew({client,identity:identityOf({shopId:job.shop_id,installationId:job.installation_id}),job,purpose:"RENEW"}); }
        catch(error) {
          if(!(error instanceof ExportContractError) || ![C.SNAPSHOT_EXPIRED,C.SCHEMA_DRIFT,C.MISSING_COVERAGE,C.UNAUTHORIZED].includes(error.code)) throw error;
          await client.query(`UPDATE export_engine.jobs SET state='FAILED',failure_code=$2,updated_at=clock_timestamp() WHERE id=$1`,[job.id,error.code]);
        }
      }
      return jobs.map(j=>j.id);
    });
  }

  async function scheduleWaitingJobs({batchSize=100}={}) {
    int(batchSize,"batchSize",1,1000);
    return withTransaction(pool,async client=>{
      const waiting=(await client.query(`SELECT * FROM export_engine.jobs WHERE state='WAITING_FOR_CAPACITY' AND NOT cancel_requested ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1`,[batchSize])).rows;
      const promoted=[];
      for(const job of waiting) {
        const globalActive=Number((await client.query(`SELECT count(*)::int AS c FROM export_engine.jobs WHERE state IN ('QUEUED','RUNNING','FINALIZING','RECOVERING')`)).rows[0].c);
        if(globalActive>=maxGlobalConcurrent) break;
        const shopActive=Number((await client.query(`SELECT count(*)::int AS c FROM export_engine.jobs WHERE shop_id=$1 AND state IN ('QUEUED','RUNNING','FINALIZING','RECOVERING')`,[job.shop_id])).rows[0].c);
        if(shopActive>=maxConcurrentPerShop) continue;
        try { assertJobManifestPin(job); await generationProtection.verify({client,identity:identityOf({shopId:job.shop_id,installationId:job.installation_id}),job,purpose:"SCHEDULE"}); }
        catch(error) {
          if(!(error instanceof ExportContractError) || ![C.SNAPSHOT_EXPIRED,C.SCHEMA_DRIFT,C.MISSING_COVERAGE,C.UNAUTHORIZED].includes(error.code)) throw error;
          await client.query(`UPDATE export_engine.jobs SET state='FAILED',failure_code=$2,updated_at=clock_timestamp() WHERE id=$1`,[job.id,error.code]);
          continue;
        }
        const updated=(await client.query(`UPDATE export_engine.jobs SET state='QUEUED',updated_at=clock_timestamp() WHERE id=$1 AND state='WAITING_FOR_CAPACITY' AND NOT cancel_requested RETURNING *`,[job.id])).rows[0];
        if(updated) { await appendOutbox(client,job.id); promoted.push(updated); }
      }
      return promoted;
    });
  }
  async function createPreparedJob({prepared}={}) {
    assertTrustedExportPrepared(prepared);
    if(!prepared.manifest.approvedTargetingSnapshot || prepared.manifest.operationId==null)
      fail(C.UNAUTHORIZED,"Approved export targeting snapshot required");
    return createJob({identity:{shopId:prepared.shopId,installationId:prepared.installationId},
      idempotencyKey:prepared.idempotencyKey,requestFingerprint:prepared.requestFingerprint,
      manifestFingerprint:prepared.manifestFingerprint,manifest:prepared.manifest,admit:true});
  }
  async function findByIdempotencyKey({shopId,installationId,idempotencyKey}={}) {
    const id=identityOf({shopId,installationId});
    return (await pool.query(`SELECT * FROM export_engine.jobs WHERE shop_id=$1 AND installation_id=$2 AND idempotency_key=$3`,
      [id.shopId,id.installationId,normalizeIdempotencyKey(idempotencyKey)])).rows[0]??null;
  }
  async function getCommittedParts({identity,jobId}={}) {
    const id=identityOf(identity);uuid(jobId,"jobId");return loadParts(pool,id,jobId);
  }
  const api = { scheduleWaitingJobs,createPreparedJob,findByIdempotencyKey,getCommittedParts,
    createJob,
    getJob,
    transition,

    claimNext,
    heartbeat,
    commitPart,
    transitionWorker,
    finalizeArtifact,

    requestCancellation,
    finalizeCancellation,

    claimOutbox,
    acknowledgeOutbox,
    markOutboxUnknown,
    recoverExpiredOutbox,
    reconcileUnknownOutbox,
    recoverExpiredJobs, resolveRecoveredJob, releaseRetryWaitJobs,
    recoverStalledReconciliations, acknowledgeCancellation,
    renewGenerationProtection, releaseGenerationProtection,
    renewPendingGenerationProtection, releaseTerminalGenerationProtections,
  };
  return Object.freeze(Object.fromEntries(Object.entries(api).map(([name, method]) => [name, async args => {
    try { return encode(await method(args)); }
    catch (error) {
      if (error instanceof ExportContractError) throw error;
      fail(C.EXECUTION_FAILED, "Export operation failed", ["40001", "40P01", "55P03", "08006", "ECONNRESET"].includes(error?.code));
    }
  }])));
}
