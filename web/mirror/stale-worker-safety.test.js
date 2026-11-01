import test from "node:test";
import assert from "node:assert/strict";
import { createReconciliationRepository } from "./reconciliation-repository.server.js";
import { createCatalogReconciliationService, ReconciliationError } from "./reconciliation.server.js";
import { createCatalogWorker } from "../workers/catalog.worker.js";

const shopId = "safety-test.myshopify.com";
const productId = "gid://shopify/Product/999";
const generationId = "gen-staging-test";

function makeProduct(id = productId, title = "Product Title") {
  const numericId = id.split("/").pop() || "999";
  return {
    id,
    title,
    handle: `product-${numericId}`,
    status: "ACTIVE",
    tags: [],
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
    variants: [
      {
        id: `gid://shopify/ProductVariant/${numericId}1`,
        title: "Default",
        price: "10.00",
        compareAtPrice: null,
        inventoryPolicy: "DENY",
        inventoryQuantity: 2,
        taxable: true,
        requiresComponents: false,
        position: 1,
        createdAt: "2026-10-28T10:00:00.000Z",
        updatedAt: "2026-10-28T10:00:00.000Z",
      },
    ],
  };
}

function createMockDbStore() {
  const store = {
    generations: new Map([
      [
        `${shopId}:${generationId}`,
        {
          id: generationId,
          shop_id: shopId,
          status: "RECONCILING",
          mirror_schema_version: "metamax_mirror_v1",
          source_contract_version: "metamax_sources_v1",
          mapping_version: "mapping_v1",
        },
      ],
    ]),
    catalogChanges: new Map([
      [
        `${shopId}:${productId}`,
        {
          shop_id: shopId,
          product_id: productId,
          revision: 10n,
          applied_revision: 0n,
          dirty: true,
          deleted: false,
          attempts: 0,
          next_attempt_at: null,
          dead_letter_at: null,
          last_error: null,
          lease_token: null,
          lease_until: null,
          fence: 0n,
        },
      ],
    ]),
    generationRevisions: new Map(),
    products: new Map(),
    journal: new Map(),
  };

  let transactionBackup;
  const client = {
    async query(sql, params = []) {
      if(sql.startsWith("BEGIN"))transactionBackup=structuredClone(store);
      if(sql === "ROLLBACK")Object.assign(store,transactionBackup);
      // 1. Generation queries
      if (sql.includes("JOIN mirror.catalog_changes") && sql.includes("FROM mirror.generations")) {
        for (const gen of store.generations.values()) {
          if (["INGESTING", "RECONCILING"].includes(gen.status)) {
            return { rows: [{ id: gen.id, shop_id: gen.shop_id }] };
          }
        }
        return { rows: [] };
      }

      if (sql.includes("FROM mirror.generations")) {
        if (params.length === 1) {
          for (const gen of store.generations.values()) {
            if (gen.shop_id === params[0] && ["INGESTING", "RECONCILING"].includes(gen.status)) {
              return { rows: [{ id: gen.id }] };
            }
          }
          return { rows: [] };
        }
        const key = `${params[0]}:${params[1]}`;
        const gen = store.generations.get(key);
        return { rows: gen ? [gen] : [] };
      }

      // 2. Generation product revision receipt queries
      if (sql.includes("FROM mirror.generation_product_revisions") && sql.includes("FOR UPDATE")) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        const rec = store.generationRevisions.get(key);
        return { rows: rec ? [rec] : [] };
      }
      if (sql.includes("INSERT INTO mirror.generation_product_revisions")) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        const rec = {
          shop_id: params[0],
          generation_id: params[1],
          product_id: params[2],
          revision: BigInt(params[3]),
          deleted: Boolean(params[4]),
        };
        store.generationRevisions.set(key, rec);
        return { rows: [rec] };
      }

      // 3. Catalog changes queries
      if (sql.includes("WITH next_row AS")) {
        // claimNext CTE query
        const key = `${params[0]}:${productId}`;
        const row = store.catalogChanges.get(key);
        if (
          row &&
          row.dirty &&
          row.dead_letter_at === null &&
          (!row.next_attempt_at || new Date(row.next_attempt_at).getTime() <= Date.now()) &&
          (!row.lease_until || new Date(row.lease_until).getTime() <= Date.now())
        ) {
          row.lease_token = params[1];
          row.lease_until = new Date(Date.now() + params[2] * 1000);
          row.fence += 1n;
          return { rows: [row] };
        }
        return { rows: [] };
      }

      if (sql.includes("FROM mirror.catalog_changes") && sql.includes("FOR UPDATE")) {
        const key = `${params[0]}:${params[1]}`;
        const row = store.catalogChanges.get(key);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes("UPDATE mirror.catalog_changes") && sql.includes("applied_revision")) {
        // commitReconciliation conditional update
        const key = `${params[0]}:${params[1]}`;
        const row = store.catalogChanges.get(key);
        const targetRev = BigInt(params[2]);
        let targetFence = null;
        let targetToken = null;
        if (params.length === 6) {
          targetFence = BigInt(params[4]);
          targetToken = params[5];
        } else {
          targetToken = params[4];
        }

        if (
          row &&
          row.revision === targetRev &&
          row.applied_revision < targetRev &&
          (targetFence === null || row.fence === targetFence) &&
          row.lease_token === targetToken &&
          new Date(row.lease_until).getTime() > Date.now()
        ) {
          row.applied_revision = targetRev;
          row.dirty = false;
          row.deleted = Boolean(params[3]);
          row.attempts = 0;
          row.next_attempt_at = null;
          row.dead_letter_at = null;
          row.last_error = null;
          row.lease_token = null;
          row.lease_until = null;
          row.fence += 1n;
          return { rowCount: 1, rows: [row] };
        }
        return { rowCount: 0, rows: [] };
      }

      if (sql.includes("UPDATE mirror.catalog_changes") && sql.includes("last_error")) {
        // recordFailure update
        const key = `${params[0]}:${params[1]}`;
        const row = store.catalogChanges.get(key);
        const targetFence = BigInt(params[2]);
        if (row && row.fence === targetFence && row.dirty && row.dead_letter_at === null) {
          row.attempts += 1;
          row.last_error = params[3];
          row.lease_token = null;
          row.lease_until = null;
          const retryable = Boolean(params[4]);
          const retryAfter = params[5];
          if (!retryable || row.attempts >= 10) {
            row.dead_letter_at = new Date();
            row.next_attempt_at = null;
          } else {
            row.next_attempt_at = new Date(Date.now() + retryAfter * 1000);
          }
          return { rowCount: 1, rows: [row] };
        }
        return { rowCount: 0, rows: [] };
      }

      // 4. Products mirror queries
      if (sql.includes("INSERT INTO mirror.products")) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        store.products.set(key, { shop_id: params[0], generation_id: params[1], shopify_id: params[2], title: params[3] });
        return { rows: [{ id: 100n }] };
      }
      if (sql.includes("DELETE FROM mirror.products")) {
        const key = `${params[0]}:${params[1]}:${params[2]}`;
        store.products.delete(key);
        return { rowCount: 1, rows: [] };
      }
      if (
        sql.includes("DELETE FROM mirror.variants") ||
        sql.includes("DELETE FROM mirror.product_options") ||
        sql.includes("DELETE FROM mirror.product_collections") ||
        sql.includes("DELETE FROM mirror.metafield_values")
      ) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT 1 FROM mirror.variants")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO mirror.variants")) {
        return { rows: [{ id: 200n }] };
      }

      // 5. Journal queries
      if (sql.includes("UPDATE mirror.mutation_journal")) {
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    },
    release() {},
  };

  const database = {
    async connect() { return client; },
  };

  return { store, database };
}

test("stale-worker safety: out-of-order events prevent stale worker from overwriting newer revision", async () => {
  const { store, database } = createMockDbStore();
  const repository = createReconciliationRepository({ database });

  // 1. Worker 1 claims Revision 10
  const claim1 = await repository.claimNext({
    workerId: "worker-1",
    leaseSeconds: 120,
    shopId,
    generationId,
  });

  assert.ok(claim1);
  assert.equal(claim1.revision, "10");
  assert.equal(claim1.fence, 1n);

  // 2. While Worker 1 is reading from Shopify, Webhook 2 arrives with Revision 11
  const changeRow = store.catalogChanges.get(`${shopId}:${productId}`);
  changeRow.revision = 11n; // bumped by newer webhook!

  // 3. Worker 1 finishes reading Shopify with Revision 10 snapshot and attempts commit
  const commitResult1 = await repository.commitReconciliation({
    claim: claim1,
    observedRevision: "10",
    replacement: {
      kind: "REPLACE",
      productId,
      product: makeProduct(productId, "Stale Revision 10 Title"),
    },
  });

  // MUST return SUPERSEDED!
  assert.equal(commitResult1.kind, "SUPERSEDED");

  // Invariants:
  // - Stale title must NOT be written to mirror
  assert.equal(store.products.has(`${shopId}:${generationId}:${productId}`), false);
  // - catalog_changes.applied_revision must NOT falsely acknowledge Revision 11
  assert.equal(changeRow.applied_revision, 0n);
  // - catalog_changes.dirty must REMAIN true so Revision 11 is not missed!
  assert.equal(changeRow.dirty, true);

  // 4. Worker 2 claims Revision 11
  // Clear lease to simulate next claim
  changeRow.lease_until = null;
  changeRow.lease_token = null;

  const claim2 = await repository.claimNext({
    workerId: "worker-2",
    leaseSeconds: 120,
    shopId,
    generationId,
  });

  assert.ok(claim2);
  assert.equal(claim2.revision, "11");
  assert.equal(claim2.fence, 2n);

  // 5. Worker 2 commits authoritative Revision 11
  const commitResult2 = await repository.commitReconciliation({
    claim: claim2,
    observedRevision: "11",
    replacement: {
      kind: "REPLACE",
      productId,
      product: makeProduct(productId, "Fresh Revision 11 Title"),
    },
  });

  assert.equal(commitResult2.kind, "APPLIED");
  assert.equal(store.products.get(`${shopId}:${generationId}:${productId}`).title, "Fresh Revision 11 Title");
  assert.equal(changeRow.applied_revision, 11n);
  assert.equal(changeRow.dirty, false);
  assert.equal(store.generationRevisions.get(`${shopId}:${generationId}:${productId}`).revision, 11n);
});

test("stale-worker safety: expired lease prevents delayed worker from committing stale snapshot", async () => {
  const { store, database } = createMockDbStore();
  const repository = createReconciliationRepository({ database });

  const claim = await repository.claimNext({
    workerId: "worker-delayed",
    leaseSeconds: 10,
    shopId,
    generationId,
  });

  assert.ok(claim);

  // Simulate worker being delayed beyond lease duration (lease expires)
  const changeRow = store.catalogChanges.get(`${shopId}:${productId}`);
  changeRow.lease_until = new Date(Date.now() - 5000); // 5 seconds in the past

  const result = await repository.commitReconciliation({
    claim,
    observedRevision: "10",
    replacement: {
      kind: "REPLACE",
      productId,
      product: makeProduct(productId, "Expired Write"),
    },
  });

  assert.equal(result.kind, "LEASE_LOST");
  assert.equal(store.products.has(`${shopId}:${generationId}:${productId}`), false);
  assert.equal(changeRow.applied_revision, 0n);
  assert.equal(changeRow.dirty, true);
});

test("stale-worker safety: concurrent workers and fencing prevents superseded worker from committing", async () => {
  const { store, database } = createMockDbStore();
  const repository = createReconciliationRepository({ database });

  const claim1 = await repository.claimNext({
    workerId: "worker-1",
    leaseSeconds: 10,
    shopId,
    generationId,
  });

  // Worker 1 paused. Lease expires, and Worker 2 claims the row
  const changeRow = store.catalogChanges.get(`${shopId}:${productId}`);
  changeRow.lease_until = null;
  changeRow.lease_token = null;

  const claim2 = await repository.claimNext({
    workerId: "worker-2",
    leaseSeconds: 120,
    shopId,
    generationId,
  });

  assert.equal(claim1.fence, 1n);
  assert.equal(claim2.fence, 2n);

  // Worker 1 wakes up and tries to commit with stale fence=1
  const result1 = await repository.commitReconciliation({
    claim: claim1,
    observedRevision: "10",
    replacement: {
      kind: "REPLACE",
      productId,
      product: makeProduct(productId, "Worker 1 Write"),
    },
  });

  assert.equal(result1.kind, "LEASE_LOST");
  assert.equal(store.products.has(`${shopId}:${generationId}:${productId}`), false);

  // Worker 2 commits with valid fence=2
  const result2 = await repository.commitReconciliation({
    claim: claim2,
    observedRevision: "10",
    replacement: {
      kind: "REPLACE",
      productId,
      product: makeProduct(productId, "Worker 2 Write"),
    },
  });

  assert.equal(result2.kind, "APPLIED");
  assert.equal(store.products.get(`${shopId}:${generationId}:${productId}`).title, "Worker 2 Write");
});

test("stale-worker safety: duplicate events do not re-apply clean rows", async () => {
  const { store, database } = createMockDbStore();
  const repository = createReconciliationRepository({ database });

  // First apply Revision 10
  const claim = await repository.claimNext({ workerId: "w1", leaseSeconds: 120, shopId, generationId });
  await repository.commitReconciliation({
    claim,
    observedRevision: "10",
    replacement: { kind: "REPLACE", productId, product: makeProduct(productId, "Initial") },
  });

  const changeRow = store.catalogChanges.get(`${shopId}:${productId}`);
  assert.equal(changeRow.applied_revision, 10n);
  assert.equal(changeRow.dirty, false);

  // A redundant duplicate job for Revision 10 tries to commit
  const dupResult = await repository.commitReconciliation({
    claim,
    observedRevision: "10",
    replacement: { kind: "REPLACE", productId, product: makeProduct(productId, "Duplicate") },
  });

  assert.equal(dupResult.kind, "SUPERSEDED");
  assert.equal(store.products.get(`${shopId}:${generationId}:${productId}`).title, "Initial");
});

test("stale-worker safety: deleted products remove rows from mirror and record destination receipt", async () => {
  const { store, database } = createMockDbStore();
  const repository = createReconciliationRepository({ database });

  // Seed product in mirror
  store.products.set(`${shopId}:${generationId}:${productId}`, { id: productId, title: "To Delete" });

  const claim = await repository.claimNext({ workerId: "w-del", leaseSeconds: 120, shopId, generationId });

  const service = createCatalogReconciliationService({
    shopifyReader: {
      async readCompleteProduct() {
        return { kind: "DELETED" }; // authoritative deletion!
      },
    },
    catalogNormalizer: {
      async normalizeProduct() {
        assert.fail("Normalizer should not be called on deletion");
      },
    },
    repository,
  });

  const outcome = await service.reconcile(claim);
  assert.equal(outcome.kind, "APPLIED");

  // Mirror product must be deleted
  assert.equal(store.products.has(`${shopId}:${generationId}:${productId}`), false);

  // Destination generation receipt must record deletion
  const receipt = store.generationRevisions.get(`${shopId}:${generationId}:${productId}`);
  assert.equal(receipt.deleted, true);
  assert.equal(receipt.revision, 10n);

  // Catalog change must be acknowledged as deleted
  const change = store.catalogChanges.get(`${shopId}:${productId}`);
  assert.equal(change.deleted, true);
  assert.equal(change.applied_revision, 10n);
  assert.equal(change.dirty, false);
});

test("stale-worker safety: unavailable Shopify APIs persist exponential retry backoff without losing change", async () => {
  const { store, database } = createMockDbStore();
  const repository = createReconciliationRepository({ database });

  const service = createCatalogReconciliationService({
    shopifyReader: {
      async readCompleteProduct() {
        throw new Error("HTTP 429 Too Many Requests");
      },
    },
    catalogNormalizer: { async normalizeProduct() {} },
    repository,
  });

  const worker = createCatalogWorker({
    reconciliationService: service,
    queueRepository: repository,
    workerId: "w-retry",
  });

  const outcome = await worker.processOne();

  assert.equal(outcome.kind, "RETRY_SCHEDULED");
  assert.equal(outcome.code, "SHOPIFY_READ_FAILED");

  const change = store.catalogChanges.get(`${shopId}:${productId}`);
  // Attempts incremented
  assert.equal(change.attempts, 1);
  // Dirty flag preserved so change is not lost!
  assert.equal(change.dirty, true);
  // Next attempt scheduled in future
  assert.ok(change.next_attempt_at !== null);
  // Lease cleared for next attempt
  assert.equal(change.lease_token, null);
});

test("stale-worker safety: retired or replacement staging generation returns GENERATION_UNAVAILABLE", async () => {
  const { store, database } = createMockDbStore();
  const repository = createReconciliationRepository({ database });

  const claim = await repository.claimNext({ workerId: "w-gen", leaseSeconds: 120, shopId, generationId });

  // Staging generation is replaced / retired / cancelled before worker commits
  const gen = store.generations.get(`${shopId}:${generationId}`);
  gen.status = "CANCELLED";

  const result = await repository.commitReconciliation({
    claim,
    observedRevision: "10",
    replacement: { kind: "REPLACE", productId, product: makeProduct(productId, "Orphaned") },
  });

  assert.equal(result.kind, "GENERATION_UNAVAILABLE");
  assert.equal(store.products.has(`${shopId}:${generationId}:${productId}`), false);
});

test("stale-worker safety: crash or transaction failure rolls back state and preserves due dirty row for next worker", async () => {
  const { store, database } = createMockDbStore();
  const repository = createReconciliationRepository({ database });

  const claim = await repository.claimNext({ workerId: "w-crash", leaseSeconds: 120, shopId, generationId });
  assert.ok(claim);

  // Simulate a worker crashing or database throwing an error midway during commit
  const client = await database.connect();
  const origQuery = client.query;
  client.query = async (sql, params) => {
    if (sql.includes("INSERT INTO mirror.products")) {
      throw new Error("Simulated database connection crash midway through write");
    }
    return origQuery(sql, params);
  };

  await assert.rejects(
    () =>
      repository.commitReconciliation({
        claim,
        observedRevision: "10",
        replacement: {
          kind: "REPLACE",
          productId,
          product: makeProduct(productId, "Crashed Write"),
        },
      }),
    /Simulated database connection crash/,
  );

  // Invariants after crash:
  // - Product was NOT committed
  assert.equal(store.products.has(`${shopId}:${generationId}:${productId}`), false);
  // - catalog_changes.applied_revision was NOT updated
  const change = store.catalogChanges.get(`${shopId}:${productId}`);
  assert.equal(change.applied_revision, 0n);
  // - catalog_changes.dirty remains TRUE
  assert.equal(change.dirty, true);
  // - Receipt was NOT persisted
  assert.equal(store.generationRevisions.has(`${shopId}:${generationId}:${productId}`), false);
});
