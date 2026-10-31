import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationRepository } from "./generation-repository.server.js";

const shopId = "repo-test.myshopify.com";

function createMockDbStore() {
  const store = {
    generations: new Map(),
    publications: new Map(),
    coverage: new Map(),
    catalogChanges: new Map(),
    ingestionRuns: new Map(),
    readLeases: new Map(),
    selectionSnapshots: new Map(),
    products: new Map(),
    variants: new Map(),
    jobCommands: new Map(),
  };

  const client = {
    async query(rawSql, params = []) {
      const sql = rawSql.replace(/\s+/g, " ").trim();

      if (
        sql.startsWith("BEGIN") ||
        sql.startsWith("COMMIT") ||
        sql.startsWith("ROLLBACK") ||
        sql.startsWith("SET LOCAL") ||
        sql.startsWith("LOCK TABLE")
      ) {
        return { rows: [], rowCount: 0 };
      }

      // Handle DELETE statements first
      if (sql.startsWith("DELETE FROM mirror.generations")) {
        const key = `${params[0]}:${params[1]}`;
        const existed = store.generations.delete(key);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }

      if (sql.startsWith("DELETE FROM mirror.products")) {
        for (const [k, p] of store.products.entries()) {
          if (p.shop_id === params[0] && p.generation_id === params[1]) store.products.delete(k);
        }
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith("DELETE FROM mirror.variants")) {
        for (const [k, v] of store.variants.entries()) {
          if (v.shop_id === params[0] && v.generation_id === params[1]) store.variants.delete(k);
        }
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith("DELETE FROM mirror.coverage")) {
        for (const [k, c] of store.coverage.entries()) {
          if (c.shop_id === params[0] && c.generation_id === params[1]) store.coverage.delete(k);
        }
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith("DELETE FROM mirror.generation_read_leases")) {
        const key = `${params[0]}:${params[2]}`;
        const existed = store.readLeases.delete(key);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }

      if (sql.startsWith("DELETE FROM mirror.")) {
        return { rows: [], rowCount: 0 };
      }

      // mirror.generations SELECT
      if (sql.includes("FROM mirror.generations WHERE shop_id = $1 AND id = $2")) {
        const key = `${params[0]}:${params[1]}`;
        const gen = store.generations.get(key);
        return { rows: gen ? [gen] : [], rowCount: gen ? 1 : 0 };
      }

      if (sql.includes("SELECT 1 FROM mirror.generations old")) {
        const oldGen = store.generations.get(`${params[0]}:${params[1]}`);
        if (oldGen) {
          const oldTime = new Date(oldGen.created_at).getTime();
          const newTime = new Date(params[2]).getTime();
          if (oldTime > newTime || (oldTime === newTime && oldGen.id >= params[3])) {
            return { rows: [{ "?column?": 1 }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // mirror.generations UPDATE
      if (sql.includes("UPDATE mirror.generations")) {
        const gen = store.generations.get(`${params[0]}:${params[1]}`);
        if (gen) {
          if (sql.includes("SET status = 'PUBLISHED'")) {
            gen.status = "PUBLISHED";
            gen.published_at = new Date().toISOString();
          }
          if (sql.includes("SET status = 'RETIRED'")) {
            gen.status = "RETIRED";
            gen.retired_at = new Date().toISOString();
          }
          if (sql.includes("retain_until = GREATEST")) {
            gen.retain_until = new Date(Date.now() + 25 * 3600000).toISOString();
          }
          return { rows: [gen], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // mirror.publications
      if (sql.includes("FROM mirror.publications WHERE shop_id = $1")) {
        const pub = store.publications.get(params[0]);
        return { rows: pub ? [pub] : [], rowCount: pub ? 1 : 0 };
      }

      if (sql.includes("INSERT INTO mirror.publications")) {
        const pub = {
          shop_id: params[0],
          generation_id: params[1],
          coverage_revision: params[2],
          mapping_version: params[3],
          published_at: new Date().toISOString(),
        };
        store.publications.set(params[0], pub);
        return { rows: [pub], rowCount: 1 };
      }

      // mirror.coverage SELECT
      if (sql.includes("FROM mirror.coverage")) {
        const recs = [];
        const names = params[2] || [];
        for (const name of names) {
          const rec = store.coverage.get(`${params[0]}:${params[1]}:${name}`);
          if (rec) recs.push(rec);
        }
        return { rows: recs, rowCount: recs.length };
      }

      // mirror.catalog_changes
      if (sql.includes("FROM mirror.catalog_changes WHERE shop_id = $1 AND dirty")) {
        for (const change of store.catalogChanges.values()) {
          if (change.shop_id === params[0] && change.dirty) {
            return { rows: [{ "?column?": 1 }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // mirror.ingestion_runs
      if (sql.includes("FROM mirror.ingestion_runs WHERE shop_id = $1 AND generation_id = $2")) {
        const run = store.ingestionRuns.get(`${params[0]}:${params[1]}`);
        return { rows: run ? [run] : [], rowCount: run ? 1 : 0 };
      }

      // mirror.generation_read_leases INSERT
      if (sql.includes("INSERT INTO mirror.generation_read_leases")) {
        const lease = {
          shop_id: params[0],
          id: params[1],
          generation_id: params[2],
          expires_at: params[6],
        };
        store.readLeases.set(`${params[0]}:${params[1]}`, lease);
        return { rows: [lease], rowCount: 1 };
      }

      // Reference checks: publications, snapshots, read leases
      if (sql.includes("UNION ALL")) {
        const s = params[0];
        const g = params[1];
        const pub = store.publications.get(s);
        if (pub && pub.generation_id === g) return { rows: [{ "?column?": 1 }], rowCount: 1 };
        for (const snap of store.selectionSnapshots.values()) {
          if (snap.shop_id === s && snap.generation_id === g) return { rows: [{ "?column?": 1 }], rowCount: 1 };
        }
        for (const lease of store.readLeases.values()) {
          if (lease.shop_id === s && lease.generation_id === g && new Date(lease.expires_at).getTime() > Date.now()) {
            return { rows: [{ "?column?": 1 }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // Durable deletion completion verification query
      if (sql.includes("remaining_rows")) {
        let count = 0;
        for (const p of store.products.values()) {
          if (p.shop_id === params[0] && p.generation_id === params[1]) count++;
        }
        for (const v of store.variants.values()) {
          if (v.shop_id === params[0] && v.generation_id === params[1]) count++;
        }
        for (const c of store.coverage.values()) {
          if (c.shop_id === params[0] && c.generation_id === params[1]) count++;
        }
        return { rows: [{ remaining_rows: count.toString() }], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  const database = {
    async connect() { return client; },
  };

  return { store, database };
}

test("generation repository: verifyEligibility validates status, versions, coverage completeness and clean catalog", async () => {
  const { store, database } = createMockDbStore();
  const repo = createGenerationRepository({ database });

  store.generations.set(`${shopId}:gen-1`, {
    shop_id: shopId,
    id: "gen-1",
    status: "VERIFIED",
    coverage_revision: "cov-1",
    mirror_schema_version: "1.0.0",
    source_contract_version: "1.0.0",
    mapping_version: "mapping_v1",
  });

  store.coverage.set(`${shopId}:gen-1:products`, {
    shop_id: shopId, generation_id: "gen-1", name: "products",
    status: "COMPLETE", verified_at: new Date().toISOString(), verification_hash: "hash-prod",
  });
  store.coverage.set(`${shopId}:gen-1:variants`, {
    shop_id: shopId, generation_id: "gen-1", name: "variants",
    status: "COMPLETE", verified_at: new Date().toISOString(), verification_hash: "hash-var",
  });

  const ok = await repo.verifyEligibility({
    shopId,
    generationId: "gen-1",
    coverageRevision: "cov-1",
    mirrorSchemaVersion: "1.0.0",
    sourceContractVersion: "1.0.0",
    mappingVersion: "mapping_v1",
    requiredDatasets: ["products", "variants"],
  });

  assert.equal(ok.kind, "ELIGIBLE");

  // Dirty changes make it not eligible
  store.catalogChanges.set(`${shopId}:p1`, { shop_id: shopId, product_id: "p1", dirty: true });
  const notOk = await repo.verifyEligibility({
    shopId,
    generationId: "gen-1",
    coverageRevision: "cov-1",
    mirrorSchemaVersion: "1.0.0",
    sourceContractVersion: "1.0.0",
    mappingVersion: "mapping_v1",
    requiredDatasets: ["products", "variants"],
  });
  assert.equal(notOk.kind, "NOT_ELIGIBLE");
});

test("generation repository: promoteAtomically enforces pointer matching, stale fence detection, and retention", async () => {
  const { store, database } = createMockDbStore();
  const repo = createGenerationRepository({ database });

  store.generations.set(`${shopId}:gen-1`, {
    shop_id: shopId, id: "gen-1", status: "VERIFIED",
    coverage_revision: "cov-1", mirror_schema_version: "1.0.0",
    source_contract_version: "1.0.0", mapping_version: "mapping_v1",
    created_at: new Date().toISOString(),
  });

  store.coverage.set(`${shopId}:gen-1:products`, {
    shop_id: shopId, generation_id: "gen-1", name: "products",
    status: "COMPLETE", verified_at: new Date().toISOString(), verification_hash: "h1",
  });

  store.ingestionRuns.set(`${shopId}:gen-1`, {
    shop_id: shopId, generation_id: "gen-1", fence: 50n,
  });

  // Stale fence rejection
  const staleRes = await repo.promoteAtomically({
    shopId,
    publisherFence: "49", // stale
    generationId: "gen-1",
    coverageRevision: "cov-1",
    mirrorSchemaVersion: "1.0.0",
    sourceContractVersion: "1.0.0",
    mappingVersion: "mapping_v1",
    requiredDatasets: ["products"],
    expectedCurrentGenerationId: null,
  });
  assert.equal(staleRes.kind, "STALE_FENCE");

  // Conflict on unexpected pointer
  store.publications.set(shopId, { shop_id: shopId, generation_id: "gen-other" });
  const conflictRes = await repo.promoteAtomically({
    shopId,
    publisherFence: "50",
    generationId: "gen-1",
    coverageRevision: "cov-1",
    mirrorSchemaVersion: "1.0.0",
    sourceContractVersion: "1.0.0",
    mappingVersion: "mapping_v1",
    requiredDatasets: ["products"],
    expectedCurrentGenerationId: null, // expected null, but active is gen-other
  });
  assert.equal(conflictRes.kind, "CONFLICT");

  // Success when matching expected current pointer
  const successRes = await repo.promoteAtomically({
    shopId,
    publisherFence: "50",
    generationId: "gen-1",
    coverageRevision: "cov-1",
    mirrorSchemaVersion: "1.0.0",
    sourceContractVersion: "1.0.0",
    mappingVersion: "mapping_v1",
    requiredDatasets: ["products"],
    expectedCurrentGenerationId: "gen-other",
  });
  assert.equal(successRes.kind, "PUBLISHED");
  assert.equal(store.publications.get(shopId).generation_id, "gen-1");
  assert.equal(store.generations.get(`${shopId}:gen-1`).status, "PUBLISHED");
});

test("generation repository: completeReclamationAtomically enforces durable deletion verification before marking reclaimed", async () => {
  const { store, database } = createMockDbStore();
  const repo = createGenerationRepository({ database });

  // Generation in RETIRED state
  store.generations.set(`${shopId}:gen-old`, {
    shop_id: shopId, id: "gen-old", status: "RETIRED",
    retain_until: new Date(Date.now() - 1000).toISOString(),
  });

  // Snapshot data exists for this generation
  store.products.set(`${shopId}:gen-old:prod-1`, {
    shop_id: shopId, generation_id: "gen-old", id: "prod-1",
  });
  store.coverage.set(`${shopId}:gen-old:products`, {
    shop_id: shopId, generation_id: "gen-old", name: "products",
  });

  // Reclaim executes and durably deletes child rows, verifying 0 remaining rows
  const result = await repo.completeReclamationAtomically({
    shopId,
    cleanupFence: "fence-1",
    generationId: "gen-old",
  });

  assert.equal(result.kind, "RECLAIMED");
  assert.equal(store.products.has(`${shopId}:gen-old:prod-1`), false);
  assert.equal(store.coverage.has(`${shopId}:gen-old:products`), false);
  assert.equal(store.generations.has(`${shopId}:gen-old`), false);
});
