/** Scripted pg double: contract/order assertions only, not SQL/concurrency proof.
 * Verification adapters in this file are test fixtures, never production adapters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createExportRepository } from "./export-repository.server.js";
import { EXPORT_ERROR_CODES as C } from "./export-contract.js";

const ID = { shopId: "example.myshopify.com", installationId: "installation-1" };
const JOB_ID = "c5a854ce-5590-46ad-a38b-27a71c0f4601";
const TOKEN = "bd3dc1f0-bf80-475e-9452-9d351b3b0a39";
const HASH = `sha256:${"a".repeat(64)}`;
const CLAIM = { leaseToken: TOKEN, fenceEpoch: "5" };
const empty = () => ({ rows: [], rowCount: 0 });

function makePool(handler) {
  const statements = [];
  const pool = {
    statements,
    releases: 0,
    async query(sql, params = []) {
      statements.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
          sql.startsWith("SET LOCAL ") || sql.startsWith("LOCK TABLE mirror.publications ")) return empty();
      const result = await handler(sql, params);
      assert.ok(result, `Unexpected SQL in scripted double: ${sql}`);
      return { rowCount: result.rows.length, ...result };
    },
    async connect() {
      return { query: pool.query.bind(pool), release() { pool.releases++; } };
    },
  };
  return pool;
}

function repository(pool, overrides = {}) {
  return createExportRepository({
    pool,
    generationProtection: {
      async verify() {
        return { verified: true, leaseId: "mirror-lease-1", generationId: "generation-1",
          coverageRevision: "1", mappingVersion: "mapping-1" };
      },
      async renew() { assert.fail("Unexpected generation renewal"); },
      async release() { assert.fail("Unexpected generation release"); },
    },
    async verifyStoredPart(part) {
      return { ...part, verified: true, immutable: true, rowCountVerified: true };
    },
    async verifyFinalArtifact() { assert.fail("Unexpected final artifact verification"); },
    async verifyDeliveryEvidence() { assert.fail("Unexpected delivery acknowledgement"); },
    async reconcileDelivery() { return { decision: "REVIEW_REQUIRED", reason: "INSUFFICIENT_EVIDENCE" }; },
    async verifyRecoveryEvidence() { assert.fail("Unexpected worker recovery verification"); },
    ...overrides,
  });
}

const part = overrides => ({
  identity: ID, jobId: JOB_ID, claim: CLAIM, expectedVersion: 0, partNumber: 0,
  storageKey: "exports/job/part-0", storageVersion: "immutable-version-1",
  checksum: HASH, rowCount: 100, byteCount: 500, cursor: { lastId: "100" }, ...overrides,
});

test("scripted export repository rejects missing trusted identity before database access", async () => {
  const pool = makePool(() => assert.fail("Identity failure reached database"));
  await assert.rejects(() => repository(pool).getJob({ identity: null, jobId: JOB_ID }), { code: C.UNAUTHORIZED });
  assert.equal(pool.statements.length, 0);
});

test("scripted stale heartbeat cannot renew ownership", async () => {
  const pool = makePool(sql => sql.includes("UPDATE export_engine.jobs") ? empty() : undefined);
  await assert.rejects(() => repository(pool).heartbeat({ identity: ID, jobId: JOB_ID, claim: CLAIM }), { code: C.LEASE_LOST });
  assert.equal(pool.statements.length, 1);
  assert.match(pool.statements[0].sql, /lease_expires_at > clock_timestamp\(\)/);
  assert.deepEqual(pool.statements[0].params.slice(0, 5), [JOB_ID, ID.shopId, ID.installationId, TOKEN, "5"]);
});

test("scripted checkpoint sequence fails before storage verification or transaction", async () => {
  let storageCalls = 0;
  const pool = makePool(() => assert.fail("Invalid sequence reached database"));
  const repo = repository(pool, { async verifyStoredPart() { storageCalls++; } });
  await assert.rejects(() => repo.commitPart(part({ partNumber: 3 })), { code: C.CHECKPOINT_CONFLICT });
  assert.equal(storageCalls, 0);
  assert.equal(pool.statements.length, 0);
});

test("scripted checkpoint failure rolls back after part insertion and releases connection", async () => {
  const pool = makePool(sql => {
    if (sql.includes("SELECT *") && sql.includes("FROM export_engine.jobs")) {
      return { rows: [{ id: JOB_ID, shop_id: ID.shopId, installation_id: ID.installationId,
        state: "RUNNING", cancel_requested: false, lease_token: TOKEN, fence_epoch: "5",
        // PostgreSQL's evaluated ownership predicate, not the Node clock.
        lease_valid: true, lease_expires_at: "2099-01-01T00:00:00Z",
        checkpoint_version: "0", rows_committed: "0", bytes_committed: "0",
        generation_id: "generation-1", coverage_revision: "1", mapping_version: "mapping-1", manifest: { format: "CSV" } }] };
    }
    if (sql.includes("INSERT INTO export_engine.parts") || sql.includes("UPDATE export_engine.jobs")) return empty();
  });
  await assert.rejects(() => repository(pool).commitPart(part()), { code: C.CHECKPOINT_CONFLICT });
  const sql = pool.statements.map(entry => entry.sql);
  const barrier = sql.findIndex(s => s.startsWith("LOCK TABLE mirror.publications"));
  const read = sql.findIndex(s => s.includes("FROM export_engine.jobs"));
  const insert = sql.findIndex(s => s.includes("INSERT INTO export_engine.parts"));
  const update = sql.findIndex(s => s.includes("UPDATE export_engine.jobs"));
  assert.equal(sql[0], "BEGIN");
  assert.ok(barrier > 0 && read > barrier && insert > read && update > insert);
  assert.equal(sql.at(-1), "ROLLBACK");
  assert.ok(!sql.includes("COMMIT"));
  assert.equal(pool.releases, 1);
});

test("scripted expired outbox ownership becomes UNKNOWN with a revoked fence", async () => {
  const pool = makePool(sql => sql.includes("UPDATE export_engine.outbox") ? { rows: [{ id: JOB_ID }] } : undefined);
  const result = await repository(pool).recoverExpiredOutbox({ batchSize: 10 });
  assert.deepEqual(result, [{ id: JOB_ID }]);
  const recovery = pool.statements.find(entry => entry.sql.includes("UPDATE export_engine.outbox"));
  assert.match(recovery.sql, /state = 'UNKNOWN'/);
  assert.match(recovery.sql, /fence_epoch = o\.fence_epoch \+ 1/);
  assert.match(recovery.sql, /claim_expires_at <= clock_timestamp\(\)/);
  assert.doesNotMatch(recovery.sql, /SET state = '(PENDING|RETRY_ELIGIBLE)'/);
  assert.deepEqual(recovery.params, [10]);
  assert.equal(pool.statements.at(-1).sql, "COMMIT");
});

function reconciliationPool({ lostClaim = false } = {}) {
  return makePool((sql, params) => {
    if (sql.includes("reconciliation_attempts = reconciliation_attempts + 1")) {
      return { rows: [{ id: JOB_ID, state: "RECONCILING", claim_token: params[2], fence_epoch_text: "3",
        fence_epoch: "3", reconciliation_attempts: 1, delivery_key: JOB_ID }] };
    }
    if (sql.includes("UPDATE export_engine.outbox") && sql.includes("delivery_evidence = $5::jsonb")) {
      return lostClaim ? empty() : { rows: [{ id: JOB_ID, state: params[3] }] };
    }
  });
}

for (const assessment of [
  { decision: "RETRY_ELIGIBLE", safeToRetry: false, queueJob: null },
  { queueJob: null },
  { decision: "DELIVERED", confirmed: false },
]) test(`scripted reconciliation fails closed without positive evidence: ${JSON.stringify(assessment)}`, async () => {
  const pool = reconciliationPool();
  const repo = repository(pool, { async reconcileDelivery() { return assessment; } });
  const result = await repo.reconcileUnknownOutbox({ eventId: JOB_ID, reconcilerId: "reconciler-1" });
  assert.equal(result.state, "REVIEW_REQUIRED");
  const update = pool.statements.find(entry => entry.sql.includes("delivery_evidence = $5::jsonb"));
  assert.equal(update.params[3], "REVIEW_REQUIRED");
  assert.match(update.sql, /claim_expires_at > clock_timestamp\(\)/);
  assert.equal(pool.statements.at(-1).sql, "COMMIT");
});

test("scripted reconciliation cannot commit a decision after losing its claim", async () => {
  const pool = reconciliationPool({ lostClaim: true });
  const repo = repository(pool, { async reconcileDelivery() { return { decision: "RETRY_ELIGIBLE", safeToRetry: true }; } });
  await assert.rejects(() => repo.reconcileUnknownOutbox({ eventId: JOB_ID, reconcilerId: "reconciler-1" }), { code: C.LEASE_LOST });
  assert.equal(pool.statements.at(-1).sql, "ROLLBACK");
  assert.ok(!pool.statements.some(entry => entry.sql === "COMMIT"));
});
