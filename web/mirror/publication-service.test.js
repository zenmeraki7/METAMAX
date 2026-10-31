import test from "node:test";
import assert from "node:assert/strict";
import { createMirrorPublicationService } from "./publication-service.server.js";
import { FIELD_ERROR_CODES as C } from "../fields/types.js";

function fixture() {
  const events = [];
  const client = { async query(sql) { events.push(sql); } };
  const snapshot = { shopId: "shop.myshopify.com", generationId: "g1", coverageRevision: "r1", status: "PUBLISHED",
    datasets: [{ name: "products", generationId: "g1", status: "COMPLETE", published: true }] };
  const service = createMirrorPublicationService({ barrierTable: { schema: "mirror", table: "publications" },
    repository: { async getPublishedSnapshot(input) { events.push(input); return snapshot; } } });
  const input = { client, shopId: snapshot.shopId, generationId: "g1", coverageRevision: "r1", datasets: ["products"] };
  return { events, client, snapshot, service, input };
}

test("publication checks acquire a read-only-compatible barrier before reading on the same client", async () => {
  const f = fixture();
  assert.equal((await f.service.requirePublished(f.input)).ready, true);
  assert.deepEqual(f.events, ['LOCK TABLE "mirror"."publications" IN ACCESS SHARE MODE', {
    client: f.client, shopId: "shop.myshopify.com", generationId: "g1", datasets: ["products"],
  }]);
  await f.service.lockForWrite(f.client);
  assert.equal(f.events.at(-1), 'LOCK TABLE "mirror"."publications" IN ACCESS EXCLUSIVE MODE');
});

test("publication checks reject cross-tenant, retired, changed and incomplete snapshots", async () => {
  for (const change of [
    { shopId: "other.myshopify.com" }, { generationId: "g2" }, { coverageRevision: "r2" },
    { status: "RETIRED" }, { datasets: [] },
    { datasets: [{ name: "products", generationId: "g1", status: "INGESTING", published: true }] },
  ]) {
    const f = fixture(); Object.assign(f.snapshot, change);
    await assert.rejects(() => f.service.requirePublished(f.input), { code: C.MISSING_DEPENDENCY });
  }
});

test("publication barrier requires configured server identifiers and a transaction client", async () => {
  assert.throws(() => createMirrorPublicationService(), TypeError);
  assert.throws(() => createMirrorPublicationService({ repository: { getPublishedSnapshot() {} },
    barrierTable: { schema: "mirror", table: "publications; DROP TABLE" } }), TypeError);
  await assert.rejects(() => fixture().service.lockForWrite(null), TypeError);
});
