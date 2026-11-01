import test from "node:test";
import assert from "node:assert/strict";
import { createPublicationRepository } from "./publication-repository.server.js";
import { createMirrorCoverageService } from "./coverage.js";

const shopId = "a.myshopify.com", generationId = "g1";
const request = { shopId, generationId, datasets: ["products", "variants"] };
const row = name => ({ shopId, generationId, coverageRevision: "r1", status: "PUBLISHED",
  mirrorSchemaVersion: "metamax_mirror_v1", sourceContractVersion: "metamax_sources_v1",
  name, datasetGenerationId: generationId, datasetStatus: "COMPLETE" });
function fixture(rows = [row("products"), row("variants")], failure = null) {
  const calls = [], releases = [];
  let connections = 0;
  const client = { async query(text, values) {
    calls.push({ text, values });
    if (text.startsWith("SELECT")) {
      if (failure) throw failure;
      return { rows };
    }
    return { rows: [] };
  }, release(error) { releases.push(error); } };
  const database = { async connect() { connections++; return client; } };
  return { repository: createPublicationRepository({ database }), client, calls, releases,
    connections: () => connections };
}

test("publication reads bind tenant/generation/datasets and protect the first SELECT", async () => {
  const f = fixture(), snapshot = await f.repository.getPublishedSnapshot(request);
  const query = f.calls.find(call => call.values?.length === 3);
  assert.deepEqual(query.values, [shopId, generationId, ["products", "variants"]]);
  assert.ok(f.calls.findIndex(call => call.text.startsWith("LOCK TABLE")) < f.calls.indexOf(query));
  assert.equal(f.calls.at(-1).text, "COMMIT");
  assert.equal(f.releases.length, 1);
  assert.ok(Object.isFrozen(snapshot.datasets[0]));
});

test("executor coverage reads reuse its transaction without opening or ending another", async () => {
  const f = fixture();
  const coverage = createMirrorCoverageService({ repository: f.repository });
  const snapshot = await f.repository.getPublishedSnapshot({ ...request, client: f.client });
  assert.equal(snapshot.generationId, generationId);
  assert.equal(f.connections(), 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.releases.length, 0);
  assert.equal(await coverage.verifyCoverage({ shopId, datasets: request.datasets,
    executionContext: { generationId, coverageRevision: "r1" } }), true);
});

test("missing and incomplete coverage never issue readiness", async () => {
  for (const rows of [[], [row("products")], [row("products"), { ...row("variants"), datasetStatus: "INGESTING" }]]) {
    const f = fixture(rows), coverage = createMirrorCoverageService({ repository: f.repository });
    assert.equal(await coverage.getVerifiedCoverage({ shopId, datasets: request.datasets,
      executionContext: { generationId, coverageRevision: "r1" } }), false);
  }
});

test("catalog context is stable and contains no readiness grant", async () => {
  const f = fixture([{ ...row(null), datasetGenerationId: null, datasetStatus: null }]);
  assert.deepEqual(await f.repository.getPublishedContext({ shopId }),
    { operationId: "catalog", generationId, coverageRevision: "r1" });
  assert.equal(await fixture([]).repository.getPublishedContext({ shopId }), null);
});

test("target approval and malformed scopes fail before connecting", async () => {
  const f = fixture();
  await assert.rejects(() => f.repository.getPublishedSnapshot({ ...request, targetingSnapshotId: "approved" }),
    { code: "FIELD_EXECUTION_UNAVAILABLE" });
  for (const changes of [{ shopId: "other' OR true" }, { generationId: "bad'" },
    { datasets: ["products", "products"] }, { datasets: ["products; DROP TABLE x"] }, { datasets: Array(1) }]) {
    await assert.rejects(() => f.repository.getPublishedSnapshot({ ...request, ...changes }));
  }
  assert.equal(f.connections(), 0);
});

test("database failures roll back and release while preserving the cause", async () => {
  const failure = new Error("database unavailable"), f = fixture([], failure);
  await assert.rejects(() => f.repository.getPublishedSnapshot(request), error => error === failure);
  assert.equal(f.calls.at(-1).text, "ROLLBACK");
  assert.equal(f.releases.length, 1);
});
