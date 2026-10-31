import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
  EXPORT_ERROR_CODES,
  EXPORT_LIMITS,
  ExportContractError,
} from "./export-contract.js";
import {
  prepareExportRequest,
  exportManifestFingerprint,
  assertTrustedExportPrepared,
  EFFECTIVE_EXPORT_FILTER_LIMITS,
  createExportService,
} from "./export-service.server.js";
import { createExportRouter } from "../routes/export.routes.js";
import { FieldError, FIELD_ERROR_CODES } from "../fields/types.js";

const shop = Object.freeze({
  id: "alpha.myshopify.com",
  installationId: "inst-001",
});

const executionContext = Object.freeze({
  operationId: "export-op-1",
  generationId: "gen-100",
  coverageRevision: "cov-200",
});

function createMockEngines({
  generationId = "gen-100",
  coverageRevision = "cov-200",
  definitionRevision = "def-v1",
  filterFingerprint = "fp:filter-v1",
} = {}) {
  const fieldCalls = [];
  const filterCalls = [];

  const fieldService = {
    async requireFields(args) {
      fieldCalls.push(args);
      return Object.freeze({
        shopId: shop.id,
        operation: args.operation,
        access: args.access,
        generationId,
        coverageRevision,
        registryVersion: "reg-v1",
        mirrorSchemaVersion: "schema-v1",
        sourceContractVersion: "src-v1",
        fields: args.fieldIds.map((id) => ({
          id,
          origin: id.includes("metafield") ? "dynamic" : "canonical",
          type: "string",
          entity: "product",
          source: { definitionRevision },
        })),
        definitionRevisions: args.fieldIds
          .filter((id) => id.includes("metafield"))
          .map((fieldId) => ({ fieldId, definitionToken: definitionRevision })),
      });
    },
  };

  const filterService = {
    async validateFilter(ast, context) {
      filterCalls.push({ ast, context });
      return Object.freeze({
        ast,
        shopId: shop.id,
        operation: context.operation,
        generationId,
        coverageRevision,
        registryVersion: "reg-v1",
        fingerprint: filterFingerprint,
        versions: Object.freeze({
          validation: 1,
          ast: 1,
        }),
        definitionRevisions: [],
      });
    },
  };

  return { fieldService, filterService, fieldCalls, filterCalls };
}

test("prepareExportRequest binds METAMAX Field/Filter engines and computes distinct request and manifest fingerprints", async () => {
  const engines1 = createMockEngines({
    generationId: "gen-100",
    coverageRevision: "cov-200",
  });

  const input = {
    format: "CSV",
    fieldIds: ["product.title", "product.status"],
    filter: {
      version: 1,
      root: {
        kind: "condition",
        field: "product.status",
        operator: "eq",
        value: "ACTIVE",
      },
    },
  };

  const prepared1 = await prepareExportRequest({
    input,
    idempotencyKey: "export:req-0001",
    authenticatedShop: shop,
    executionContext,
    fieldService: engines1.fieldService,
    filterService: engines1.filterService,
  });

  assert.equal(prepared1.shopId, shop.id);
  assert.equal(prepared1.installationId, shop.installationId);
  assert.equal(prepared1.generationId, "gen-100");
  assert.equal(prepared1.coverageRevision, "cov-200");
  assert.equal(engines1.fieldCalls.length, 1);
  assert.equal(engines1.fieldCalls[0].access, "read");
  assert.equal(engines1.fieldCalls[0].operation, "export");
  assert.equal(engines1.filterCalls.length, 1);

  // Same client request against a newer published generation produces the SAME
  // requestFingerprint, but a DIFFERENT manifestFingerprint.
  const engines2 = createMockEngines({
    generationId: "gen-101",
    coverageRevision: "cov-201",
  });

  const prepared2 = await prepareExportRequest({
    input,
    idempotencyKey: "export:req-0001",
    authenticatedShop: shop,
    executionContext: {
      ...executionContext,
      generationId: "gen-101",
      coverageRevision: "cov-201",
    },
    fieldService: engines2.fieldService,
    filterService: engines2.filterService,
  });

  assert.equal(prepared1.requestFingerprint, prepared2.requestFingerprint);
  assert.notEqual(prepared1.manifestFingerprint, prepared2.manifestFingerprint);
});

test("prepareExportRequest rejects unverified shop, generation drift, and maps FieldError codes", async () => {
  const engines = createMockEngines();

  await assert.rejects(
    () =>
      prepareExportRequest({
        input: { fieldIds: ["product.title"] },
        idempotencyKey: "export:req-0002",
        authenticatedShop: { id: "alpha.myshopify.com" }, // missing installationId
        executionContext,
        fieldService: engines.fieldService,
        filterService: engines.filterService,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.UNAUTHORIZED,
  );

  // Generation drift between fieldService and filterService fails closed
  const driftingFilterService = {
    async validateFilter(ast) {
      return {
        ast,
        shopId: shop.id,
        generationId: "gen-different",
        coverageRevision: "cov-200",
        fingerprint: "fp:1",
      };
    },
  };

  await assert.rejects(
    () =>
      prepareExportRequest({
        input: {
          fieldIds: ["product.title"],
          filter: { field: "product.title", operator: "eq", value: "A" },
        },
        idempotencyKey: "export:req-0003",
        authenticatedShop: shop,
        executionContext,
        fieldService: engines.fieldService,
        filterService: driftingFilterService,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.SCHEMA_DRIFT,
  );

  // FieldError(PERMISSION_DENIED) maps to EXPORT_UNAUTHORIZED (403)
  const denyingFieldService = {
    async requireFields() {
      throw new FieldError(
        FIELD_ERROR_CODES.PERMISSION_DENIED,
        "Read access denied for field",
      );
    },
  };

  await assert.rejects(
    () =>
      prepareExportRequest({
        input: { fieldIds: ["product.title"] },
        idempotencyKey: "export:req-0004",
        authenticatedShop: shop,
        executionContext,
        fieldService: denyingFieldService,
        filterService: engines.filterService,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.UNAUTHORIZED &&
      err.status === 403,
  );
});

test("createExportRouter enforces auth, rate limits by authenticated shop (ignoring X-Shop-Domain), body limits, and idempotency", async () => {
  const engines = createMockEngines();
  const ledger = new Map();
  const rateLimitKeys = [];
  let allowRate = true;

  const rateLimiter = {
    async consume({ shopId, operation }) {
      rateLimitKeys.push({ shopId, operation });
      return allowRate;
    },
  };

  const exportService = createExportService({
    resolveShop: async (authContext) => authContext.shop,
    resolveExecutionContext: async () => executionContext,
    fieldService: engines.fieldService,
    filterService: engines.filterService,
    rateLimiter,
    repository: {
      async createOrGet({
        shopId,
        idempotencyKey,
        requestFingerprint,
        manifestFingerprint,
        state,
      }) {
        const compositeKey = `${shopId}:${idempotencyKey}`;
        if (ledger.has(compositeKey)) {
          return { created: false, job: ledger.get(compositeKey) };
        }
        const job = Object.freeze({
          id: `job-${ledger.size + 1}`,
          shopId,
          idempotencyKey,
          requestFingerprint,
          manifestFingerprint,
          state,
        });
        ledger.set(compositeKey, job);
        return { created: true, job };
      },
    },
  });

  let currentAuth = { shop };
  const app = express();
  app.use(
    "/api/exports",
    createExportRouter({
      authenticate: async () => currentAuth,
      exportService,
    }),
  );

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/exports`;

  try {
    // 1. First creation returns 202 and ignores spoofed X-Shop-Domain
    const res1 = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "export:idem-key-1",
        "X-Shop-Domain": "spoofed-attacker.myshopify.com",
      },
      body: JSON.stringify({
        fieldIds: ["product.title", "product.status"],
      }),
    });

    assert.equal(res1.status, 202);
    assert.equal(res1.headers.get("cache-control"), "no-store");
    const body1 = await res1.json();
    assert.equal(body1.data.shopId, "alpha.myshopify.com");
    assert.equal(rateLimitKeys[0].shopId, "alpha.myshopify.com");

    // 2. Idempotent replay with identical payload returns 200 and same job
    const res2 = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "export:idem-key-1",
      },
      body: JSON.stringify({
        fieldIds: ["product.title", "product.status"],
      }),
    });

    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.data.id, body1.data.id);

    // 3. Idempotent key reuse with different payload returns 409 EXPORT_IDEMPOTENCY_CONFLICT
    const resConflict = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "export:idem-key-1",
      },
      body: JSON.stringify({
        fieldIds: ["product.title"],
      }),
    });

    assert.equal(resConflict.status, 409);
    const conflictBody = await resConflict.json();
    assert.equal(
      conflictBody.error.code,
      EXPORT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
    );

    // 4. Rate limit exceeded returns 429 EXPORT_RATE_LIMITED
    allowRate = false;
    const resRate = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "export:idem-key-2",
      },
      body: JSON.stringify({
        fieldIds: ["product.title"],
      }),
    });

    assert.equal(resRate.status, 429);
    const rateBody = await resRate.json();
    assert.equal(rateBody.error.code, EXPORT_ERROR_CODES.RATE_LIMITED);
    assert.equal(rateBody.error.retryable, true);
    allowRate = true;

    // 5. Unauthenticated request returns 401
    currentAuth = null;
    const resUnauth = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "export:idem-key-3",
      },
      body: JSON.stringify({
        fieldIds: ["product.title"],
      }),
    });

    assert.equal(resUnauth.status, 401);
    currentAuth = { shop };

    // 6. Malformed JSON returns 400 EXPORT_INVALID_REQUEST
    const resBadJson = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "export:idem-key-4",
      },
      body: "{bad json",
    });

    assert.equal(resBadJson.status, 400);
    const badJsonBody = await resBadJson.json();
    assert.equal(badJsonBody.error.code, "EXPORT_INVALID_REQUEST");

    // 7. Oversized payload (> 128KB) returns 413
    const resOversized = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "export:idem-key-5",
      },
      body: JSON.stringify({
        fieldIds: ["product.title"],
        filter: {
          padding: "x".repeat(EXPORT_LIMITS.MAX_REQUEST_BYTES + 1024),
        },
      }),
    });

    assert.equal(resOversized.status, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fingerprinting is not authorization: Field and Filter Engines must validate before a trusted manifest is constructed, and Filter Engine AST budgets remain authoritative", async () => {
  const engines = createMockEngines();

  // 1. Forged or unvalidated objects cannot claim trusted manifest provenance
  assert.throws(
    () =>
      assertTrustedExportPrepared({
        manifest: {},
        requestFingerprint: "sha256:00",
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.UNAUTHORIZED,
  );

  // 2. exportManifestFingerprint rejects calls lacking Field or Filter Engine validation receipts
  assert.throws(
    () =>
      exportManifestFingerprint({
        request: { fieldIds: ["product.title"] },
        shopId: shop.id,
        installationId: shop.installationId,
        authorizedFields: null,
        validatedFilter: { fingerprint: "fp:1" },
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.UNAUTHORIZED,
  );

  assert.throws(
    () =>
      exportManifestFingerprint({
        request: { fieldIds: ["product.title"] },
        shopId: shop.id,
        installationId: shop.installationId,
        authorizedFields: {
          generationId: "gen-100",
          coverageRevision: "cov-200",
          fields: [{ id: "product.title" }],
        },
        validatedFilter: null,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.UNAUTHORIZED,
  );

  // 3. Unfiltered export (filter: null) still validates through both Field and Filter Engines
  //    before constructing a trusted execution manifest
  const unfilteredPrepared = await prepareExportRequest({
    input: { fieldIds: ["product.title"] },
    idempotencyKey: "export:unfiltered-001",
    authenticatedShop: shop,
    executionContext,
    fieldService: engines.fieldService,
    filterService: engines.filterService,
  });

  assert.equal(engines.fieldCalls.length, 1);
  assert.equal(engines.filterCalls.length, 1);
  assert.ok(assertTrustedExportPrepared(unfilteredPrepared));
  assert.equal(unfilteredPrepared.manifest.shopId, shop.id);
  assert.equal(unfilteredPrepared.manifest.filterFingerprint, "fp:filter-v1");

  // 4. Filter Engine's stricter AST depth budget (MAX_DEPTH = 12) overrides
  //    Export Contract's generic MAX_FILTER_DEPTH (32)
  assert.equal(EFFECTIVE_EXPORT_FILTER_LIMITS.MAX_DEPTH, 12);
  assert.ok(EFFECTIVE_EXPORT_FILTER_LIMITS.MAX_DEPTH < EXPORT_LIMITS.MAX_FILTER_DEPTH);

  let deepFilterNode = {
    kind: "condition",
    field: "product.status",
    operator: "eq",
    value: "ACTIVE",
  };
  for (let i = 0; i < 13; i++) {
    deepFilterNode = {
      kind: "group",
      operator: "AND",
      children: [deepFilterNode],
    };
  }

  await assert.rejects(
    () =>
      prepareExportRequest({
        input: {
          fieldIds: ["product.title"],
          filter: { version: 1, root: deepFilterNode },
        },
        idempotencyKey: "export:deep-filter-001",
        authenticatedShop: shop,
        executionContext,
        fieldService: engines.fieldService,
        filterService: engines.filterService,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.INVALID_REQUEST,
  );

  // 5. Filter Engine's stricter OR fan-out budget (MAX_OR_BRANCHES = 32) is enforced
  const excessiveOrFilter = {
    version: 1,
    root: {
      kind: "group",
      operator: "OR",
      children: Array.from({ length: 33 }, (_, i) => ({
        kind: "condition",
        field: "product.title",
        operator: "eq",
        value: `Item-${i}`,
      })),
    },
  };

  await assert.rejects(
    () =>
      prepareExportRequest({
        input: {
          fieldIds: ["product.title"],
          filter: excessiveOrFilter,
        },
        idempotencyKey: "export:or-fanout-001",
        authenticatedShop: shop,
        executionContext,
        fieldService: engines.fieldService,
        filterService: engines.filterService,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.INVALID_REQUEST,
  );
});

test("idempotency is not rate limiting: repeated idempotent request returns the same job without consuming rate-limit budget or reserving another slot", async () => {
  const engines = createMockEngines();
  let remainingRateTokens = 1;
  let rateConsumeCalls = 0;
  let createOrGetCalls = 0;
  const jobsByIdempotency = new Map();

  const exportService = createExportService({
    resolveShop: async () => shop,
    resolveExecutionContext: async () => executionContext,
    fieldService: engines.fieldService,
    filterService: engines.filterService,
    rateLimiter: {
      async consume() {
        rateConsumeCalls += 1;
        if (remainingRateTokens <= 0) {
          return false;
        }
        remainingRateTokens -= 1;
        return true;
      },
    },
    repository: {
      async findByIdempotencyKey({ shopId, installationId, idempotencyKey }) {
        return (
          jobsByIdempotency.get(`${shopId}:${installationId}:${idempotencyKey}`) ??
          null
        );
      },
      async createOrGet({
        shopId,
        installationId,
        idempotencyKey,
        requestFingerprint,
        manifestFingerprint,
        state,
      }) {
        createOrGetCalls += 1;
        const key = `${shopId}:${installationId}:${idempotencyKey}`;
        if (jobsByIdempotency.has(key)) {
          return { created: false, job: jobsByIdempotency.get(key) };
        }
        const job = Object.freeze({
          id: `job-${jobsByIdempotency.size + 1}`,
          shopId,
          installationId,
          idempotencyKey,
          requestFingerprint,
          manifestFingerprint,
          state,
        });
        jobsByIdempotency.set(key, job);
        return { created: true, job };
      },
    },
  });

  // 1. Initial request consumes 1 rate-limit token and creates 1 job
  const first = await exportService.create({
    authContext: { shop },
    input: { fieldIds: ["product.title", "product.status"] },
    idempotencyKey: "export:idem-rate-test-1",
  });
  assert.equal(first.created, true);
  assert.equal(rateConsumeCalls, 1);
  assert.equal(createOrGetCalls, 1);

  // 2. Rate-limit bucket is now 0, yet a repeated idempotent request returns the existing job
  //    without consuming a rate-limit token or invoking createOrGet
  const second = await exportService.create({
    authContext: { shop },
    input: { fieldIds: ["product.title", "product.status"] },
    idempotencyKey: "export:idem-rate-test-1",
  });
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(rateConsumeCalls, 1);
  assert.equal(createOrGetCalls, 1);

  // 3. A genuinely new request with a different idempotency key is rejected by the exhausted rate limiter
  await assert.rejects(
    () =>
      exportService.create({
        authContext: { shop },
        input: { fieldIds: ["product.title", "product.status"] },
        idempotencyKey: "export:idem-rate-test-2",
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.RATE_LIMITED,
  );
  assert.equal(rateConsumeCalls, 2);
  assert.equal(createOrGetCalls, 1);
});

test("immutable requests do not guarantee immutable catalog data: publication verification, generation retention, and drift protection across retries", async () => {
  const engines = createMockEngines({
    generationId: "gen-100",
    coverageRevision: "cov-200",
    definitionRevision: "rev-field-1",
  });

  let retainedLeaseActive = true;
  let verifiedLeaseRenewals = 0;
  const store = new Map();

  const mockRepo = {
    async createOrGet({ shopId, installationId, idempotencyKey, requestFingerprint, manifestFingerprint, prepared }) {
      const key = `${shopId}:${installationId}:${idempotencyKey}`;
      const job = Object.freeze({
        id: "job-export-100",
        shopId,
        installationId,
        idempotencyKey,
        requestFingerprint,
        manifestFingerprint,
        generationId: prepared.generationId,
        coverageRevision: prepared.coverageRevision,
        mappingVersion: prepared.mappingVersion,
        manifest: prepared.manifest,
        state: "QUEUED",
      });
      store.set(job.id, job);
      return { created: true, job };
    },
    async getJob({ jobId }) {
      return store.get(jobId) ?? null;
    },
    async verifyRetention({ jobId, renewLease }) {
      if (!retainedLeaseActive) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
          "Pinned export generation read lease expired",
        );
      }
      if (renewLease) verifiedLeaseRenewals += 1;
      return { verified: true, generationId: "gen-100", coverageRevision: "cov-200" };
    },
  };

  const exportService = createExportService({
    resolveShop: async () => shop,
    resolveExecutionContext: async () => executionContext,
    fieldService: engines.fieldService,
    filterService: engines.filterService,
    repository: mockRepo,
  });

  // 1. Initial creation pins gen-100, cov-200 and stores the immutable manifest
  const created = await exportService.create({
    authContext: { shop },
    input: {
      fieldIds: ["product.title", "product.metafield.customField01"],
      filter: { field: "product.title", operator: "eq", value: "Widget" },
    },
    idempotencyKey: "export:retry-protect-1",
  });
  assert.equal(created.created, true);
  assert.equal(created.job.generationId, "gen-100");

  // 2. Across retries, even if the shop's live catalog publication advances to gen-101,
  //    verifyRetryExecution stays pinned to the original gen-100 and verifies retention & zero drift.
  const verifiedRetry = await exportService.verifyRetryExecution({
    authContext: { shop },
    jobId: created.job.id,
    renewLease: true,
  });
  assert.equal(verifiedRetry.verified, true);
  assert.equal(verifiedRetry.pinnedExecutionContext.generationId, "gen-100");
  assert.equal(verifiedLeaseRenewals, 1);

  // 3. If generation retention was lost (e.g., lease expired or generation evicted),
  //    the retry fails closed with EXPORT_SNAPSHOT_EXPIRED instead of executing against an unpinned generation.
  retainedLeaseActive = false;
  await assert.rejects(
    () =>
      exportService.verifyRetryExecution({
        authContext: { shop },
        jobId: created.job.id,
        renewLease: true,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
  );
  retainedLeaseActive = true;

  // 4. If dynamic field definitions or mapping version drifted on the pinned generation between attempt 1
  //    and the retry attempt, verifyRetryExecution rejects the retry with EXPORT_SCHEMA_DRIFT.
  const driftedEngines = createMockEngines({
    generationId: "gen-100",
    coverageRevision: "cov-200",
    definitionRevision: "rev-field-MUTATED-BY-USER",
  });
  const driftedService = createExportService({
    resolveShop: async () => shop,
    resolveExecutionContext: async () => executionContext,
    fieldService: driftedEngines.fieldService,
    filterService: driftedEngines.filterService,
    repository: mockRepo,
  });

  await assert.rejects(
    () =>
      driftedService.verifyRetryExecution({
        authContext: { shop },
        jobId: created.job.id,
        renewLease: true,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.SCHEMA_DRIFT,
  );

  // 5. If publicationService reports that a required dataset is missing or has incomplete coverage,
  //    export preparation fails closed with EXPORT_MISSING_COVERAGE.
  const missingCoveragePubService = {
    async getPublishedSnapshot() {
      return null;
    },
  };
  await assert.rejects(
    () =>
      prepareExportRequest({
        input: { fieldIds: ["product.title"] },
        idempotencyKey: "export:missing-cov-01",
        authenticatedShop: shop,
        executionContext,
        publicationService: missingCoveragePubService,
        fieldService: engines.fieldService,
        filterService: engines.filterService,
      }),
    (err) =>
      err instanceof ExportContractError &&
      err.code === EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
  );
});




