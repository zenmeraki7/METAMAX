import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPORT_ERROR_CODES,
  EXPORT_STATES,
  ExportContractError,
  exportRequestFingerprint,
  normalizeExportRequest,
} from "./export-contract.js";
import { createExportRepository } from "./export-repository.server.js";

function createMockDatabase({
  existingRow = null,
  shopActive = true,
  shopAdmitted = 0,
  shopActiveCount = 0,
  globalActiveCount = 0,
  generationStatus = "PUBLISHED",
  isCurrentPublication = true,
  coverageRevision = "cov-1",
} = {}) {
  const queries = [];
  const leases = [];
  const jobs = [];
  const outbox = [];

  const client = {
    released: false,
    release() {
      this.released = true;
    },
    async query(sql, params = []) {
      queries.push({ sql, params });

      if (sql.includes("FROM mirror.export_manifest_jobs") && sql.includes("idempotency_key")) {
        return existingRow
          ? { rowCount: 1, rows: [existingRow] }
          : { rowCount: 0, rows: [] };
      }

      if (sql.includes("FROM mirror.export_manifest_jobs") && sql.includes("shop_admitted")) {
        return {
          rowCount: 1,
          rows: [
            {
              shop_admitted: shopAdmitted,
              shop_active: shopActiveCount,
              global_active: globalActiveCount,
            },
          ],
        };
      }

      if (sql.includes("FROM mirror.shops")) {
        return shopActive
          ? {
              rowCount: 1,
              rows: [{ id: params[0], installation_version: params[1] }],
            }
          : { rowCount: 0, rows: [] };
      }

      if (sql.includes("FROM mirror.generations g")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: params[1],
              coverage_revision: coverageRevision,
              mapping_version: "mapping_v1",
              status: generationStatus,
              retain_until: new Date(Date.now() + 3600_000).toISOString(),
              is_current_publication: isCurrentPublication,
            },
          ],
        };
      }

      if (sql.includes("INSERT INTO mirror.generation_read_leases")) {
        leases.push(params);
        return { rowCount: 1, rows: [] };
      }

      if (sql.includes("INSERT INTO mirror.export_manifest_jobs")) {
        const row = {
          id: params[0],
          shop_id: params[1],
          installation_id: params[2],
          idempotency_key: params[3],
          request_fingerprint: params[4],
          manifest_fingerprint: params[5],
          contract_version: params[6],
          manifest_version: params[7],
          generation_id: params[8],
          coverage_revision: params[9],
          mapping_version: params[10],
          read_lease_id: params[11],
          manifest: JSON.parse(params[12]),
          state: params[13],
          attempts: 0,
          fence_epoch: "0",
          lease_token: null,
          lease_expires_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        jobs.push(row);
        return { rowCount: 1, rows: [row] };
      }

      if (sql.includes("INSERT INTO mirror.export_dispatch_outbox")) {
        outbox.push(params);
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    },
  };

  return {
    database: {
      async connect() {
        return client;
      },
    },
    queries,
    leases,
    jobs,
    outbox,
    client,
  };
}

const sampleRequest = normalizeExportRequest({
  fieldIds: ["product.title", "product.status"],
});
const sampleRequestFp = exportRequestFingerprint(sampleRequest);

const samplePrepared = Object.freeze({
  contractVersion: 2,
  manifestVersion: 1,
  shopId: "alpha.myshopify.com",
  installationId: "inst-1",
  generationId: "gen-1",
  coverageRevision: "cov-1",
  requestFingerprint: sampleRequestFp,
  manifestFingerprint: "sha256:manifest-1",
  request: sampleRequest,
  authorizedFields: {
    fields: [
      { id: "product.title", origin: "canonical", type: "string", entity: "product" },
      { id: "product.status", origin: "canonical", type: "string", entity: "product" },
    ],
  },
  validatedFilter: null,
});

test("createOrGet acquires publication barrier, creates generation read lease, job, and outbox atomically in one transaction", async () => {
  const mock = createMockDatabase();
  const repo = createExportRepository({ database: mock.database });

  const outcome = await repo.createOrGet({
    shopId: "alpha.myshopify.com",
    installationId: "inst-1",
    idempotencyKey: "export:create-001",
    requestFingerprint: sampleRequestFp,
    manifestFingerprint: "sha256:manifest-1",
    prepared: samplePrepared,
  });

  assert.equal(outcome.created, true);
  assert.equal(outcome.job.shopId, "alpha.myshopify.com");
  assert.equal(outcome.job.state, EXPORT_STATES.QUEUED);
  assert.equal(mock.leases.length, 1);
  assert.equal(mock.jobs.length, 1);
  assert.equal(mock.outbox.length, 1);

  const sqls = mock.queries.map((q) => q.sql);
  assert.ok(sqls.includes("BEGIN"));
  assert.ok(
    sqls.some((s) =>
      s.includes('LOCK TABLE "mirror"."publications" IN ACCESS SHARE MODE'),
    ),
  );
  assert.ok(sqls.includes("COMMIT"));
  assert.equal(mock.client.released, true);
});

test("createOrGet compares stored request_fingerprint on existing idempotency key and rejects mismatches before any write", async () => {
  const existingRow = {
    id: "00000000-0000-4000-8000-000000000001",
    shop_id: "alpha.myshopify.com",
    installation_id: "inst-1",
    idempotency_key: "export:create-001",
    request_fingerprint: sampleRequestFp,
    manifest_fingerprint: "sha256:manifest-1",
    contract_version: 2,
    manifest_version: 1,
    generation_id: "gen-1",
    coverage_revision: "cov-1",
    mapping_version: "mapping_v1",
    read_lease_id: "lease-1",
    manifest: {},
    state: "QUEUED",
    attempts: 0,
    fence_epoch: "0",
    lease_token: null,
    lease_expires_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // 1. Matching request_fingerprint returns created: false without creating new leases or outbox events
  const mockMatch = createMockDatabase({ existingRow });
  const repoMatch = createExportRepository({ database: mockMatch.database });

  const replay = await repoMatch.createOrGet({
    shopId: "alpha.myshopify.com",
    installationId: "inst-1",
    idempotencyKey: "export:create-001",
    requestFingerprint: sampleRequestFp,
    manifestFingerprint: "sha256:manifest-1",
    prepared: samplePrepared,
  });

  assert.equal(replay.created, false);
  assert.equal(replay.job.id, existingRow.id);
  assert.equal(mockMatch.leases.length, 0);
  assert.equal(mockMatch.outbox.length, 0);

  // 2. Mismatched request_fingerprint throws EXPORT_IDEMPOTENCY_CONFLICT and rolls back
  const mockConflict = createMockDatabase({ existingRow });
  const repoConflict = createExportRepository({
    database: mockConflict.database,
  });

  await assert.rejects(
    () =>
      repoConflict.createOrGet({
        shopId: "alpha.myshopify.com",
        installationId: "inst-1",
        idempotencyKey: "export:create-001",
        requestFingerprint: "sha256:different-request-fingerprint",
        manifestFingerprint: "sha256:manifest-2",
        prepared: samplePrepared,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );

  assert.ok(mockConflict.queries.some((q) => q.sql === "ROLLBACK"));
  assert.equal(mockConflict.leases.length, 0);
  assert.equal(mockConflict.outbox.length, 0);
});

test("createOrGet rejects retired generations and coverage revision drift", async () => {
  const mockRetired = createMockDatabase({
    generationStatus: "RETIRED",
    isCurrentPublication: false,
  });
  const repoRetired = createExportRepository({
    database: mockRetired.database,
  });

  await assert.rejects(
    () =>
      repoRetired.createOrGet({
        shopId: "alpha.myshopify.com",
        installationId: "inst-1",
        idempotencyKey: "export:create-002",
        requestFingerprint: sampleRequestFp,
        manifestFingerprint: "sha256:manifest-1",
        prepared: samplePrepared,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
  );

  const mockDrift = createMockDatabase({
    coverageRevision: "cov-drifted",
  });
  const repoDrift = createExportRepository({ database: mockDrift.database });

  await assert.rejects(
    () =>
      repoDrift.createOrGet({
        shopId: "alpha.myshopify.com",
        installationId: "inst-1",
        idempotencyKey: "export:create-003",
        requestFingerprint: sampleRequestFp,
        manifestFingerprint: "sha256:manifest-1",
        prepared: samplePrepared,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.SCHEMA_DRIFT,
  );
});

test("idempotent replay returns existing job without reserving another slot even when admission or concurrency limits are saturated", async () => {
  const existingRow = {
    id: "00000000-0000-4000-8000-000000000099",
    shop_id: "alpha.myshopify.com",
    installation_id: "inst-1",
    idempotency_key: "export:idem-saturated",
    request_fingerprint: sampleRequestFp,
    manifest_fingerprint: "sha256:manifest-1",
    contract_version: 2,
    manifest_version: 1,
    generation_id: "gen-1",
    coverage_revision: "cov-1",
    mapping_version: "mapping_v1",
    read_lease_id: "lease-99",
    manifest: {},
    state: "RUNNING",
    attempts: 1,
    fence_epoch: "1",
    lease_token: "00000000-0000-4000-8000-000000000100",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const mockSaturated = createMockDatabase({
    existingRow,
    shopAdmitted: 20,
    shopActiveCount: 5,
    globalActiveCount: 100,
  });
  const repo = createExportRepository({
    database: mockSaturated.database,
    maxAdmittedPerShop: 2,
    maxConcurrentPerShop: 1,
    maxGlobalConcurrent: 2,
  });

  // Repeated idempotent request succeeds with created: false
  const replay = await repo.createOrGet({
    shopId: "alpha.myshopify.com",
    installationId: "inst-1",
    idempotencyKey: "export:idem-saturated",
    requestFingerprint: sampleRequestFp,
    manifestFingerprint: "sha256:manifest-1",
    prepared: samplePrepared,
  });

  assert.equal(replay.created, false);
  assert.equal(replay.job.id, existingRow.id);
  assert.equal(mockSaturated.leases.length, 0);
  assert.equal(mockSaturated.jobs.length, 0);

  // Distinct idempotency key when admission limit is saturated throws EXPORT_CAPACITY_EXCEEDED
  const mockNewExceeded = createMockDatabase({
    existingRow: null,
    shopAdmitted: 2,
    shopActiveCount: 1,
    globalActiveCount: 1,
  });
  const repoNewExceeded = createExportRepository({
    database: mockNewExceeded.database,
    maxAdmittedPerShop: 2,
    maxConcurrentPerShop: 2,
    maxGlobalConcurrent: 10,
  });

  await assert.rejects(
    () =>
      repoNewExceeded.createOrGet({
        shopId: "alpha.myshopify.com",
        installationId: "inst-1",
        idempotencyKey: "export:new-over-limit",
        requestFingerprint: sampleRequestFp,
        manifestFingerprint: "sha256:manifest-1",
        prepared: samplePrepared,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.CAPACITY_EXCEEDED,
  );

  // When per-shop or global concurrency is full but admission limit is not exceeded,
  // job enters WAITING_FOR_CAPACITY without prematurely dispatching outbox
  const mockConcurrencyFull = createMockDatabase({
    existingRow: null,
    shopAdmitted: 1,
    shopActiveCount: 1,
    globalActiveCount: 1,
  });
  const repoQueue = createExportRepository({
    database: mockConcurrencyFull.database,
    maxAdmittedPerShop: 5,
    maxConcurrentPerShop: 1,
    maxGlobalConcurrent: 10,
  });

  const waiting = await repoQueue.createOrGet({
    queueWhenFull: true,
    shopId: "alpha.myshopify.com",
    installationId: "inst-1",
    idempotencyKey: "export:waiting-slot",
    requestFingerprint: sampleRequestFp,
    manifestFingerprint: "sha256:manifest-1",
    prepared: samplePrepared,
  });

  assert.equal(waiting.created, true);
  assert.equal(waiting.job.state, EXPORT_STATES.WAITING_FOR_CAPACITY);
  assert.equal(mockConcurrencyFull.outbox.length, 0);
});


