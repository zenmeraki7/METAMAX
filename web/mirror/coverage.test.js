import test, { describe, mock } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_FIELDS } from "../fields/canonical.js";
import { SOURCE_DATASETS } from "../fields/sources.js";
import { deepFreeze, FIELD_ERROR_CODES as C } from "../fields/types.js";

import {
  createMirrorCoverageService,
} from "./coverage.js";
import { withCoverageTransaction } from "./coverage-transaction.server.js";

const SHOP = "alpha.myshopify.com";
const GENERATION = "generation123";

const goodSnapshot = {
  shopId: SHOP,
  generationId: GENERATION,
  status: "PUBLISHED",
  datasets: [
    {
      name: "products",
      generationId: GENERATION,
      status: "COMPLETE",
      published: true,
    },
  ],
};

function service(snapshot) {
  return createMirrorCoverageService({
    repository: {
      async getPublishedSnapshot() {
        return snapshot;
      },
    },
  });
}

const request = {
  shopId: SHOP,
  datasets: ["products"],
  executionContext: {
    generationId: GENERATION,
  },
};

test("accept complete published coverage", async () => {
  assert.equal(
    await service(goodSnapshot).verifyCoverage(request),
    true
  );
});

test("execution coverage uses its protected client without leaking between concurrent requests", async () => {
  const first = { query() {} }, second = { query() {} };
  const seen = [];
  const coverage = createMirrorCoverageService({repository:{async getPublishedSnapshot(input) {
    seen.push(input.client);
    return goodSnapshot;
  }}});
  await Promise.all([first,second].map(client => withCoverageTransaction(client, async () => {
    await new Promise(resolve => setImmediate(resolve));
    const scoped = createMirrorCoverageService({repository:{async getPublishedSnapshot(input) {
      assert.strictEqual(input.client,client);
      return goodSnapshot;
    }}});
    assert.equal(await scoped.verifyCoverage(request),true);
    await coverage.verifyCoverage(request);
  })));
  assert.ok(seen.includes(first) && seen.includes(second));
  await assert.rejects(() => withCoverageTransaction(first, async () => { throw new Error("revoked"); }), /revoked/);
  await coverage.verifyCoverage({...request,client:first});
  assert.equal(seen.at(-1),undefined);
});

test("reject unpublished snapshot", async () => {
  assert.equal(
    await service({
      ...goodSnapshot,
      status: "IMPORTING",
    }).verifyCoverage(request),
    false
  );
});

test("reject different generation", async () => {
  assert.equal(
    await service({
      ...goodSnapshot,
      generationId: "oldGeneration",
    }).verifyCoverage(request),
    false
  );
});

test("reject another shop's snapshot", async () => {
  assert.equal(
    await service({
      ...goodSnapshot,
      shopId: "other.myshopify.com",
    }).verifyCoverage(request),
    false
  );
});

test("reject incomplete dataset", async () => {
  assert.equal(
    await service({
      ...goodSnapshot,
      datasets: [{
        ...goodSnapshot.datasets[0],
        status: "PARTIAL",
      }],
    }).verifyCoverage(request),
    false
  );
});

test("reject missing dataset", async () => {
  assert.equal(
    await service(goodSnapshot).verifyCoverage({
      ...request,
      datasets: ["products", "metafields"],
    }),
    false
  );
});

test("reject duplicate coverage rows", async () => {
  assert.equal(
    await service({
      ...goodSnapshot,
      datasets: [
        goodSnapshot.datasets[0],
        goodSnapshot.datasets[0],
      ],
    }).verifyCoverage(request),
    false
  );
});

test("reject missing pinned generation", async () => {
  assert.equal(
    await service(goodSnapshot).verifyCoverage({
      ...request,
      executionContext: {},
    }),
    false
  );
});

test("factory requires the published snapshot repository", () => {
  for (const repository of [undefined, {}, { getPublishedSnapshot: true }]) {
    assert.throws(() => createMirrorCoverageService({ repository }), TypeError);
  }
  assert.ok(Object.isFrozen(service(goodSnapshot)));
});

test("repository receives the authenticated shop and pinned generation", async () => {
  let received;
  const coverage = createMirrorCoverageService({ repository: {
    getPublishedSnapshot: async input => { received = input; return goodSnapshot; },
  } });
  assert.equal(await coverage.verifyCoverage(request), true);
  assert.deepEqual(received, { shopId: SHOP, generationId: GENERATION, datasets: ["products"] });
  assert.notStrictEqual(received.datasets, request.datasets);
  assert.ok(Object.isFrozen(received.datasets));
});

test("reject mixed-generation, unpublished and unexpected dataset rows", async () => {
  for (const changes of [
    { generationId: "otherGeneration" }, { published: false }, { published: "true" },
    { name: "metafields" }, { status: "IMPORTING" },
  ]) {
    assert.equal(await service({ ...goodSnapshot, datasets: [{
      ...goodSnapshot.datasets[0], ...changes,
    }] }).verifyCoverage(request), false);
  }
});

test("all requested datasets must be complete in one generation regardless of row order", async () => {
  const metafields = { ...goodSnapshot.datasets[0], name: "metafields" };
  const snapshot = { ...goodSnapshot, datasets: [metafields, goodSnapshot.datasets[0]] };
  const input = { ...request, datasets: ["products", "metafields"] };
  assert.equal(await service(snapshot).verifyCoverage(input), true);
  assert.equal(await service({ ...snapshot, datasets: [metafields] }).verifyCoverage(input), false);
  assert.equal(await service(snapshot).verifyCoverage(request), false);
});

test("invalid dataset requests fail before repository access", async () => {
  let calls = 0;
  const coverage = createMirrorCoverageService({ repository: {
    getPublishedSnapshot: async () => { calls++; return goodSnapshot; },
  } });
  for (const datasets of [
    null, {}, "products", new Array(1), ["products", "products"],
    Array(33).fill("products"), ["UPPERCASE"], ["a".repeat(129)], ["products\n"],
    Object.assign(["products"], { sql: "unexpected" }),
  ]) {
    assert.equal(await coverage.verifyCoverage({ ...request, datasets }), false);
  }
  assert.equal(calls, 0);
});

test("invalid shop and generation identities never reach the repository", async () => {
  let calls = 0;
  const coverage = createMirrorCoverageService({ repository: {
    getPublishedSnapshot: async () => { calls++; return goodSnapshot; },
  } });
  for (const shopId of [null, "", " bad ", "bad\nshop", "a".repeat(256)]) {
    assert.equal(await coverage.verifyCoverage({ ...request, shopId }), false);
  }
  for (const generationId of [null, "", " bad ", "a\nb", "a".repeat(129)]) {
    assert.equal(await coverage.verifyCoverage({ ...request, executionContext: { generationId } }), false);
  }
  for (const options of [undefined, null, {}, []]) {
    assert.equal(await coverage.verifyCoverage(options), false);
  }
  assert.equal(calls, 0);
});

test("malformed snapshots and sparse or excessive coverage rows fail closed", async () => {
  for (const snapshot of [
    null, {}, [], { ...goodSnapshot, datasets: null },
    { ...goodSnapshot, datasets: new Array(1) },
    { ...goodSnapshot, datasets: Array(33).fill(goodSnapshot.datasets[0]) },
    { ...goodSnapshot, datasets: [null] },
    { ...goodSnapshot, datasets: [{ name: "products" }] },
  ]) {
    assert.equal(await service(snapshot).verifyCoverage(request), false);
  }
});

test("accessor-backed request, snapshot and coverage rows are rejected without execution", async () => {
  const getter = () => assert.fail("Getter must not execute");
  const datasets = ["products"];
  Object.defineProperty(datasets, "0", { get: getter });
  assert.equal(await service(goodSnapshot).verifyCoverage({ ...request, datasets }), false);
  const snapshot = { ...goodSnapshot };
  Object.defineProperty(snapshot, "status", { get: getter });
  assert.equal(await service(snapshot).verifyCoverage(request), false);
  const dataset = { ...goodSnapshot.datasets[0] };
  Object.defineProperty(dataset, "published", { get: getter });
  assert.equal(await service({ ...goodSnapshot, datasets: [dataset] }).verifyCoverage(request), false);
  const rows = [goodSnapshot.datasets[0]];
  Object.defineProperty(rows, "0", { get: getter });
  assert.equal(await service({ ...goodSnapshot, datasets: rows }).verifyCoverage(request), false);
});

test("request mutation during retrieval cannot switch required datasets or generation", async () => {
  const input = { shopId: SHOP, datasets: ["products"], executionContext: { generationId: GENERATION } };
  const coverage = createMirrorCoverageService({ repository: {
    getPublishedSnapshot: async () => {
      input.datasets[0] = "metafields";
      input.executionContext.generationId = "newGeneration";
      return goodSnapshot;
    },
  } });
  assert.equal(await coverage.verifyCoverage(input), true);
});

test("requireCoverage returns true or the standard missing-dependency error", async () => {
  assert.equal(await service(goodSnapshot).requireCoverage(request), true);
  await assert.rejects(() => service(null).requireCoverage(request), { code: C.MISSING_DEPENDENCY });
  await assert.rejects(() => service(goodSnapshot).requireCoverage({ ...request, datasets: ["metafields"] }), { code: C.MISSING_DEPENDENCY });
});

test("repository errors propagate rather than admitting an operation", async () => {
  const failure = new Error("repository unavailable");
  const coverage = createMirrorCoverageService({ repository: {
    getPublishedSnapshot: async () => { throw failure; },
  } });
  await assert.rejects(() => coverage.verifyCoverage(request), error => error === failure);
  await assert.rejects(() => coverage.requireCoverage(request), error => error === failure);
});

test("empty dependencies still require a matching published generation", async () => {
  const input = { ...request, datasets: [] };
  assert.equal(await service({ ...goodSnapshot, datasets: [] }).verifyCoverage(input), true);
  assert.equal(await service(null).verifyCoverage(input), false);
});

test("coverage receipt requires a repository-owned revision from the same snapshot read", async () => {
  assert.equal(await service(goodSnapshot).getVerifiedCoverage(request), false);
  let reads = 0;
  const coverage = createMirrorCoverageService({ repository: { getPublishedSnapshot: async () => {
    reads++;
    return { ...goodSnapshot, coverageRevision: "revision123" };
  } } });
  const receipt = await coverage.getVerifiedCoverage(request);
  assert.deepEqual(receipt, { ready: true, generationId: GENERATION, coverageRevision: "revision123" });
  assert.ok(Object.isFrozen(receipt));
  assert.equal(reads, 1);
});

test("pinned coverage revision rejects replacement publication metadata", async () => {
  const coverage = service({ ...goodSnapshot, coverageRevision: "revision123" });
  const input = { ...request, executionContext: { generationId: GENERATION, coverageRevision: "revision123" } };
  assert.equal(await coverage.verifyCoverage(input), true);
  assert.equal((await coverage.getVerifiedCoverage(input)).coverageRevision, "revision123");
  const stale = { ...input, executionContext: { ...input.executionContext, coverageRevision: "oldRevision" } };
  assert.equal(await coverage.verifyCoverage(stale), false);
  assert.equal(await coverage.getVerifiedCoverage(stale), false);
});

test("malformed or accessor-backed publication revisions cannot issue receipts", async () => {
  for (const coverageRevision of [null, "", " bad ", "a".repeat(129), 1]) {
    assert.equal(await service({ ...goodSnapshot, coverageRevision }).getVerifiedCoverage(request), false);
  }
  const snapshot = { ...goodSnapshot };
  Object.defineProperty(snapshot, "coverageRevision", { get() { assert.fail("Getter executed"); } });
  assert.equal(await service(snapshot).getVerifiedCoverage(request), false);
});

const approvedTarget = Object.freeze({
  snapshotId: "target123", shopId: SHOP, generationId: GENERATION, coverageRevision: "revision123",
});
function targetingRequest() {
  return { ...request, executionContext: {
    generationId: GENERATION, approvedTargetingSnapshot: approvedTarget,
  } };
}
function targetingSnapshot(changes = {}) {
  return { ...goodSnapshot, coverageRevision: "revision123", targetingSnapshot: {
    id: "target123", shopId: SHOP, generationId: GENERATION, coverageRevision: "revision123",
    status: "APPROVED", datasets: ["products"], ...changes,
  } };
}

test("approved targeting compatibility is verified from the same published snapshot read", async () => {
  let calls = 0;
  const coverage = createMirrorCoverageService({ repository: { getPublishedSnapshot: async input => {
    calls++;
    assert.deepEqual(input, { shopId: SHOP, generationId: GENERATION, datasets: ["products"], targetingSnapshotId: "target123" });
    return targetingSnapshot();
  } } });
  assert.deepEqual(await coverage.getVerifiedCoverage(targetingRequest()), {
    ready: true, generationId: GENERATION, coverageRevision: "revision123", targetingSnapshotId: "target123",
  });
  assert.equal(calls, 1);
});

test("published complete coverage is insufficient for missing or incompatible approved targets", async () => {
  for (const changes of [
    { id: "anotherTarget" }, { shopId: "beta.myshopify.com" }, { generationId: "oldGeneration" },
    { coverageRevision: "oldRevision" }, { status: "DRAFT" }, { status: "REVOKED" },
    { datasets: [] }, { datasets: ["metafields"] }, { datasets: ["products", "products"] },
  ]) {
    assert.equal(await service(targetingSnapshot(changes)).getVerifiedCoverage(targetingRequest()), false);
    assert.equal(await service(targetingSnapshot(changes)).verifyCoverage(targetingRequest()), false);
  }
  assert.equal(await service({ ...goodSnapshot, coverageRevision: "revision123" }).getVerifiedCoverage(targetingRequest()), false);
  assert.equal(await service({ ...targetingSnapshot(), coverageRevision: "replacementRevision" }).getVerifiedCoverage(targetingRequest()), false);
});

test("compatible approved targets never bypass publication, completeness or generation checks", async () => {
  for (const changes of [
    { status: "IMPORTING" }, { generationId: "oldGeneration" },
    { datasets: [{ ...goodSnapshot.datasets[0], status: "PARTIAL" }] },
    { datasets: [{ ...goodSnapshot.datasets[0], published: false }] },
    { datasets: [{ ...goodSnapshot.datasets[0], generationId: "oldGeneration" }] },
  ]) {
    assert.equal(await service({ ...targetingSnapshot(), ...changes }).getVerifiedCoverage(targetingRequest()), false);
  }
});

test("invalid approved target identities are rejected before repository lookup", async () => {
  let calls = 0;
  const coverage = createMirrorCoverageService({ repository: { getPublishedSnapshot: async () => { calls++; return targetingSnapshot(); } } });
  for (const target of [null, {}, { ...approvedTarget, snapshotId: "" },
    { ...approvedTarget, shopId: "beta.myshopify.com" }, { ...approvedTarget, generationId: "oldGeneration" }]) {
    assert.equal(await coverage.getVerifiedCoverage({ ...request, executionContext: {
      generationId: GENERATION, approvedTargetingSnapshot: target,
    } }), false);
  }
  assert.equal(calls, 0);
});

test("target snapshot requirements are captured before repository awaits", async () => {
  const target = { ...approvedTarget };
  const coverage = createMirrorCoverageService({ repository: { getPublishedSnapshot: async () => {
    target.snapshotId = "changedTarget";
    target.coverageRevision = "changedRevision";
    return targetingSnapshot();
  } } });
  const receipt = await coverage.getVerifiedCoverage({ ...request, executionContext: {
    generationId: GENERATION, approvedTargetingSnapshot: target,
  } });
  assert.equal(receipt.targetingSnapshotId, "target123");
  assert.equal(receipt.coverageRevision, "revision123");
});

describe("coverage service and field resolver integration", {
  skip: typeof mock.module !== "function" && "Requires --experimental-test-module-mocks",
}, async () => {
  if (typeof mock.module !== "function") return;
  const FIELD_SOURCES = deepFreeze(Object.fromEntries(Object.values(CANONICAL_FIELDS).map(field => [field.id, {
    fieldId: field.id, entity: field.entity, canonicalType: field.type,
    canonicalDerived: field.derived, datasets: ["products"],
  }])));
  const dependency = mock.module("../fields/sources.js", { namedExports: { FIELD_SOURCES, SOURCE_DATASETS } });
  let R;
  try { R = await import("../fields/resolve.js?coverage-integration"); } finally { dependency.restore(); }

  test("shared coverage callback gates every supported operation using its pinned generation", async () => {
    const coverage = service(goodSnapshot);
    for (const operation of Object.values(R.FIELD_OPERATIONS)) {
      const options = {
        shopId: SHOP, operation, actor: { id: "staff" },
        executionContext: { operationId: "operation", generationId: GENERATION },
        authorizeAccess: async () => true, verifyCoverage: coverage.verifyCoverage,
      };
      const access = ["filter", "export"].includes(operation) ? "read" : "write";
      assert.equal((await R.requireFieldForAccess("product.title", access, options)).id, "product.title");
      await assert.rejects(() => R.requireFieldForAccess("product.title", access, {
        ...options, executionContext: { operationId: "operation", generationId: "otherGeneration" },
      }), { code: C.MISSING_DEPENDENCY });
    }
  });
});
