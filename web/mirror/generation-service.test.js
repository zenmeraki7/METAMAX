import test from "node:test";
import assert from "node:assert/strict";
import {
  createGenerationService,
  GenerationServiceError,
  normalizeRetentionTimestamp,
} from "./generation-service.server.js";

const VALID_DATASETS = new Set(["products", "variants", "inventory_levels"]);

function createMockRepository(overrides = {}) {
  return {
    verifyEligibility: async (req) => ({ kind: "ELIGIBLE" }),
    promoteAtomically: async (req) => ({ kind: "PUBLISHED" }),
    retainAtomically: async (req) => ({ kind: "RETAINED" }),
    releaseRetentionAtomically: async (req) => ({ kind: "RELEASED" }),
    claimReclamationAtomically: async (req) => ({ kind: "RECLAIMING" }),
    completeReclamationAtomically: async (req) => ({ kind: "RECLAIMED" }),
    ...overrides,
  };
}

function createMockAuthority(overrides = {}) {
  return {
    authorize: async ({ action, context }) => {
      if (context?.unauthorized) throw new Error("Unauthorized");
      return {
        shopId: context?.shopId || "test-shop.myshopify.com",
        publisherFence: action === "publish" ? "fence-pub-1" : undefined,
        cleanupFence:
          action === "claimCleanup" || action === "finishCleanup"
            ? "fence-clean-1"
            : undefined,
        ...overrides,
      };
    },
  };
}

const mockDatasetRegistry = {
  has: (name) => VALID_DATASETS.has(name),
};

test("checkDependencies: validates required methods on repository and dependencies", () => {
  assert.throws(
    () => createGenerationService({}),
    /Missing generation repository method: verifyEligibility/,
  );

  const repo = createMockRepository();
  assert.throws(
    () => createGenerationService({ repository: repo }),
    /Trusted authority provider required/,
  );

  const auth = createMockAuthority();
  assert.throws(
    () =>
      createGenerationService({
        repository: repo,
        authorityProvider: auth,
      }),
    /Canonical dataset registry required/,
  );

  const service = createGenerationService({
    repository: repo,
    authorityProvider: auth,
    datasetRegistry: mockDatasetRegistry,
  });
  assert.ok(service);
});

test("normalizeRetentionTimestamp: validates strict RFC 3339 format, calendar dates, and offsets", () => {
  // Valid UTC timestamps
  assert.equal(
    normalizeRetentionTimestamp("2026-10-29T10:00:00Z"),
    "2026-10-29T10:00:00.000Z",
  );
  assert.equal(
    normalizeRetentionTimestamp("2026-10-29T10:00:00.123Z"),
    "2026-10-29T10:00:00.123Z",
  );

  // Valid timezone offsets
  assert.equal(
    normalizeRetentionTimestamp("2026-10-29T12:00:00+02:00"),
    "2026-10-29T10:00:00.000Z",
  );
  assert.equal(
    normalizeRetentionTimestamp("2026-10-29T05:00:00-05:00"),
    "2026-10-29T10:00:00.000Z",
  );

  // Invalid formats / non-strings
  assert.throws(
    () => normalizeRetentionTimestamp(123456789),
    (err) => err instanceof GenerationServiceError && err.code === "INVALID_TIMESTAMP",
  );
  assert.throws(
    () => normalizeRetentionTimestamp("not-a-timestamp"),
    (err) => err instanceof GenerationServiceError && err.code === "INVALID_TIMESTAMP",
  );

  // Invalid calendar dates (e.g. Feb 31, April 31)
  assert.throws(
    () => normalizeRetentionTimestamp("2026-02-31T10:00:00Z"),
    (err) => err instanceof GenerationServiceError && err.code === "INVALID_TIMESTAMP",
  );
  assert.throws(
    () => normalizeRetentionTimestamp("2026-04-31T10:00:00Z"),
    (err) => err instanceof GenerationServiceError && err.code === "INVALID_TIMESTAMP",
  );

  // Offset out of range (> 14 hours)
  assert.throws(
    () => normalizeRetentionTimestamp("2026-10-29T10:00:00+14:01"),
    (err) => err instanceof GenerationServiceError && err.code === "INVALID_TIMESTAMP",
  );
});

test("verifyGeneration: validates parameters and verifies eligibility", async () => {
  let capturedRequest = null;
  const repository = createMockRepository({
    verifyEligibility: async (req) => {
      capturedRequest = req;
      return { kind: "ELIGIBLE" };
    },
  });

  const service = createGenerationService({
    repository,
    authorityProvider: createMockAuthority(),
    datasetRegistry: mockDatasetRegistry,
  });

  const res = await service.verifyGeneration({
    context: { shopId: "shop1.myshopify.com" },
    generationId: "gen-1",
    coverageRevision: "100",
    mirrorSchemaVersion: "1.0.0",
    sourceContractVersion: "1.0.0",
    mappingVersion: "mapping_v1",
    requiredDatasets: ["products", "variants"],
  });

  assert.equal(res.kind, "ELIGIBLE");
  assert.equal(capturedRequest.shopId, "shop1.myshopify.com");
  assert.equal(capturedRequest.generationId, "gen-1");
  assert.equal(capturedRequest.coverageRevision, "100");
  assert.deepEqual(capturedRequest.requiredDatasets, ["products", "variants"]);

  // Rejects unsupported datasets
  await assert.rejects(
    () =>
      service.verifyGeneration({
        context: { shopId: "shop1.myshopify.com" },
        generationId: "gen-1",
        coverageRevision: "100",
        mirrorSchemaVersion: "1.0.0",
        sourceContractVersion: "1.0.0",
        mappingVersion: "mapping_v1",
        requiredDatasets: ["unsupported_dataset"],
      }),
    (err) => err instanceof GenerationServiceError && err.code === "UNSUPPORTED_DATASET",
  );

  // Rejects invalid generation ID
  await assert.rejects(
    () =>
      service.verifyGeneration({
        context: { shopId: "shop1.myshopify.com" },
        generationId: "invalid/id",
        coverageRevision: "100",
        mirrorSchemaVersion: "1.0.0",
        sourceContractVersion: "1.0.0",
        mappingVersion: "mapping_v1",
        requiredDatasets: ["products"],
      }),
    (err) => err instanceof GenerationServiceError && err.code === "INVALID_REQUEST",
  );
});

test("publishGeneration: enforces expectedCurrentGenerationId and promotes atomically with publisher fence", async () => {
  let capturedRequest = null;
  const repository = createMockRepository({
    promoteAtomically: async (req) => {
      capturedRequest = req;
      return { kind: "PUBLISHED" };
    },
  });

  const logs = [];
  const logger = {
    info: (entry) => logs.push(entry),
  };

  const service = createGenerationService({
    repository,
    authorityProvider: createMockAuthority(),
    datasetRegistry: mockDatasetRegistry,
    logger,
  });

  // Missing expectedCurrentGenerationId must fail
  await assert.rejects(
    () =>
      service.publishGeneration({
        context: { shopId: "shop1.myshopify.com" },
        generationId: "gen-2",
        coverageRevision: "200",
        mirrorSchemaVersion: "1.0.0",
        sourceContractVersion: "1.0.0",
        mappingVersion: "mapping_v1",
        requiredDatasets: ["products"],
      }),
    (err) => err instanceof GenerationServiceError && err.code === "INVALID_REQUEST",
  );

  // Success with expectedCurrentGenerationId: null (first publication)
  const res1 = await service.publishGeneration({
    context: { shopId: "shop1.myshopify.com" },
    generationId: "gen-2",
    coverageRevision: "200",
    mirrorSchemaVersion: "1.0.0",
    sourceContractVersion: "1.0.0",
    mappingVersion: "mapping_v1",
    requiredDatasets: ["products"],
    expectedCurrentGenerationId: null,
  });

  assert.equal(res1.kind, "PUBLISHED");
  assert.equal(capturedRequest.publisherFence, "fence-pub-1");
  assert.equal(capturedRequest.expectedCurrentGenerationId, null);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "mirror_generation_published");
  assert.equal(logs[0].generationId, "gen-2");

  // Conflict / stale fence outcome check
  const conflictRepo = createMockRepository({
    promoteAtomically: async () => ({ kind: "STALE_FENCE" }),
  });
  const conflictService = createGenerationService({
    repository: conflictRepo,
    authorityProvider: createMockAuthority(),
    datasetRegistry: mockDatasetRegistry,
  });

  const res2 = await conflictService.publishGeneration({
    context: { shopId: "shop1.myshopify.com" },
    generationId: "gen-2",
    coverageRevision: "200",
    mirrorSchemaVersion: "1.0.0",
    sourceContractVersion: "1.0.0",
    mappingVersion: "mapping_v1",
    requiredDatasets: ["products"],
    expectedCurrentGenerationId: "gen-1",
  });
  assert.equal(res2.kind, "STALE_FENCE");
});

test("retainGeneration and releaseRetention: validates retention reference and timestamp", async () => {
  let capturedRetain = null;
  let capturedRelease = null;

  const repository = createMockRepository({
    retainAtomically: async (req) => {
      capturedRetain = req;
      return { kind: "RETAINED" };
    },
    releaseRetentionAtomically: async (req) => {
      capturedRelease = req;
      return { kind: "RELEASED" };
    },
  });

  const service = createGenerationService({
    repository,
    authorityProvider: createMockAuthority(),
    datasetRegistry: mockDatasetRegistry,
  });

  // Retain
  const retainRes = await service.retainGeneration({
    context: { shopId: "shop1.myshopify.com" },
    generationId: "gen-1",
    referenceId: "ref-job-123",
    expiresAt: "2026-10-30T12:00:00Z",
  });
  assert.equal(retainRes.kind, "RETAINED");
  assert.equal(capturedRetain.referenceId, "ref-job-123");
  assert.equal(capturedRetain.expiresAt, "2026-10-30T12:00:00.000Z");

  // Release
  const releaseRes = await service.releaseRetention({
    context: { shopId: "shop1.myshopify.com" },
    generationId: "gen-1",
    referenceId: "ref-job-123",
  });
  assert.equal(releaseRes.kind, "RELEASED");
  assert.equal(capturedRelease.referenceId, "ref-job-123");
});

test("beginReclamation and finishReclamation: manages two-stage reclamation with cleanup fence", async () => {
  let capturedClaim = null;
  let capturedFinish = null;

  const repository = createMockRepository({
    claimReclamationAtomically: async (req) => {
      capturedClaim = req;
      return { kind: "RECLAIMING" };
    },
    completeReclamationAtomically: async (req) => {
      capturedFinish = req;
      return { kind: "RECLAIMED" };
    },
  });

  const logs = [];
  const logger = { info: (e) => logs.push(e) };

  const service = createGenerationService({
    repository,
    authorityProvider: createMockAuthority(),
    datasetRegistry: mockDatasetRegistry,
    logger,
  });

  const claimRes = await service.beginReclamation({
    context: { shopId: "shop1.myshopify.com" },
    generationId: "gen-old",
  });
  assert.equal(claimRes.kind, "RECLAIMING");
  assert.equal(capturedClaim.cleanupFence, "fence-clean-1");

  const finishRes = await service.finishReclamation({
    context: { shopId: "shop1.myshopify.com" },
    generationId: "gen-old",
  });
  assert.equal(finishRes.kind, "RECLAIMED");
  assert.equal(capturedFinish.cleanupFence, "fence-clean-1");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, "mirror_generation_reclaimed");
  assert.equal(logs[0].generationId, "gen-old");
});

test("repository error handling: wraps network/db errors with outcome uncertainty semantics", async () => {
  const failingRepo = createMockRepository({
    verifyEligibility: async () => {
      throw new Error("Connection reset");
    },
    promoteAtomically: async () => {
      throw new Error("Database timeout after commit");
    },
  });

  const service = createGenerationService({
    repository: failingRepo,
    authorityProvider: createMockAuthority(),
    datasetRegistry: mockDatasetRegistry,
  });

  // Read error: retryable, outcome certain
  await assert.rejects(
    () =>
      service.verifyGeneration({
        context: { shopId: "shop1.myshopify.com" },
        generationId: "gen-1",
        coverageRevision: "100",
        mirrorSchemaVersion: "1.0.0",
        sourceContractVersion: "1.0.0",
        mappingVersion: "mapping_v1",
        requiredDatasets: ["products"],
      }),
    (err) => {
      return (
        err instanceof GenerationServiceError &&
        err.code === "REPOSITORY_READ_FAILED" &&
        err.retryable === true &&
        err.outcomeUncertain === false
      );
    },
  );

  // Mutation error: outcome uncertain, not blindly retryable
  await assert.rejects(
    () =>
      service.publishGeneration({
        context: { shopId: "shop1.myshopify.com" },
        generationId: "gen-1",
        coverageRevision: "100",
        mirrorSchemaVersion: "1.0.0",
        sourceContractVersion: "1.0.0",
        mappingVersion: "mapping_v1",
        requiredDatasets: ["products"],
        expectedCurrentGenerationId: null,
      }),
    (err) => {
      return (
        err instanceof GenerationServiceError &&
        err.code === "REPOSITORY_OUTCOME_UNKNOWN" &&
        err.retryable === false &&
        err.outcomeUncertain === true
      );
    },
  );
});
