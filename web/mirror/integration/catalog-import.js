import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createCatalogImportService } from "../../services/catalog-import.server.js";
import { createReconciliationService } from "../reconciliation-service.server.js";
import { createApp } from "../../app.js";
import { product, variant } from "./sync-hardening.js";
import {createSyncRunService} from '../sync-run-service.server.js';
import {writeCatalogProducts} from '../catalog-writer.server.js';
import {transaction} from '../transactions.server.js';

export async function testCatalogImports(t, pool) {
  const states = new Map(), sessions = new Map();
  let operation = 5000;
  function fixture(name, products = [product(1)]) {
    const shopId = `${name}.myshopify.com`;
    const session = { id: `offline_${shopId}`, shop: shopId, accessToken: "fixture", isOnline: false, scope: "read_products" };
    sessions.set(session.id, session);
    const lines = products.flatMap(({ variants, ...p }) => [JSON.stringify(p), ...variants.map(v => JSON.stringify({ ...v, __parentId: p.id }))]);
    const state = { session, products, lines, operationId: `gid://shopify/BulkOperation/${++operation}`, starts: 0, reads: 0, failDownload: false };
    states.set(shopId, state);
    return state;
  }
  const pass = () => (_req,_res,next) => next();
  const shopify = {
    config: { auth: { path: "/auth", callbackPath: "/auth/callback" }, webhooks: { path: "/webhooks" },
      sessionStorage: { loadSession: async id => sessions.get(id), findSessionsByShop: async shop => [...sessions.values()].filter(s => s.shop === shop) } },
    api: { clients: { Graphql: class {
      constructor({ session }) { this.shop = session.shop; }
      async request(query, { variables } = {}) {
        const state = states.get(this.shop);
        if (query.includes("StartBulkOperation")) {
          state.starts++;
          return { data: { bulkOperationRunQuery: { bulkOperation: { id: state.operationId, status: "CREATED" }, userErrors: [] } } };
        }
        if (query.includes("CancelMirrorBulk")) return { data: { bulkOperationCancel: { bulkOperation: { id: state.operationId, status: "CANCELLED" }, userErrors: [] } } };
        if (query.includes("MirrorProductSnapshot")) {
          state.reads++;
          const p = state.latest?.get(variables.id) ?? null;
          if (!p) return { data: { product: null } };
          const { variants, ...scalars } = p;
          const offset = variables.after ? Number(variables.after) : 0;
          return { data: { product: { ...scalars, variants: { nodes: variants.slice(offset,offset+1),
            pageInfo: { hasNextPage: offset+1 < variants.length, endCursor: String(offset+1) } } } } };
        }
        return { data: { bulkOperation: { id: variables.id, status: state.remoteStatus ?? "COMPLETED", objectCount: String(state.lines.length),
          url: `https://storage.googleapis.com/${this.shop}` } } };
      }
    } } },
    cspHeaders: pass, auth: { begin: pass, callback: pass }, redirectToShopifyOrAppRoot: pass,
    processWebhooks: pass, ensureInstalledOnShop: pass,
    validateAuthenticatedSession: () => (req,res,next) => {
      const session = sessions.get(req.headers["x-test-session"]);
      if (!session) return res.status(401).json({ error: "UNAUTHENTICATED" });
      res.locals.shopify = { session }; next();
    },
  };
  const fetchImpl = async (url, { signal }) => {
    const state = states.get(new URL(url).pathname.slice(1));
    if (state.onDownload) await state.onDownload();
    async function* source() {
      for (let i = 0; i < state.lines.length; i++) {
        signal?.throwIfAborted();
        if (state.failDownload && i === 54) throw new Error("download interrupted");
        yield Buffer.from(`${state.lines[i]}\n`);
      }
      await state.afterStream?.();
    }
    return { ok: true, body: Readable.from(source(), { objectMode: false, highWaterMark: 1 }) };
  };
  const makeService = () => createCatalogImportService({ database: pool, shopify, fetchImpl, logger: { error() {} } });
  let service = makeService();
  const full = fixture("import-http", [product(1),product(2)]);
  const other = fixture("import-other");
  const server = createApp({ shopify, staticPath: ".", catalogImportService: service, database: pool }).listen(0,"127.0.0.1");
  await new Promise(resolve => server.once("listening",resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/mirror/sync`;
  const post = (path, session = full.session, body = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type":"application/json", "x-test-session":session.id }, body: JSON.stringify(body) });
  try {
    await t.test('batched catalog writes match individual writes, delete stale variants and reject cross-product reassignment',async()=>{
      const inputs=[product(801,[{...variant(8010),sku:'EXACT',price:'123456.7890',inventoryQuantity:-2},variant(8011)]),
        {...product(802),tags:['one','two'],vendor:'Fixture',descriptionHtml:'<p>Fixture</p>',seo:{title:'SEO',description:'Description'}}];
      const runs=[];
      for(const mode of ['batch','single']){
        const s=fixture(`import-writer-${mode}`);
        await pool.query("INSERT INTO mirror.shops(id,installation_version) VALUES ($1,'writer-fixture')",[s.session.shop]);
        runs.push({shopId:s.session.shop,...await createSyncRunService({database:pool}).startIngestionRun({shopId:s.session.shop,workerId:'writer-fixture'})});
      }
      const [batch,single]=runs;
      await transaction(pool,c=>writeCatalogProducts({client:c,...batch,records:inputs}));
      await transaction(pool,async c=>{for(const p of inputs)await writeCatalogProducts({client:c,...single,records:[p]});});
      const read=async run=>({products:(await pool.query(`SELECT to_jsonb(p)-ARRAY['id','shop_id','generation_id'] AS value FROM mirror.products p WHERE shop_id=$1 ORDER BY shopify_id`,[run.shopId])).rows,
        variants:(await pool.query(`SELECT (to_jsonb(v)-ARRAY['id','shop_id','generation_id','product_id'])||jsonb_build_object('parent',p.shopify_id) AS value
          FROM mirror.variants v JOIN mirror.products p ON p.id=v.product_id AND p.shop_id=v.shop_id AND p.generation_id=v.generation_id
          WHERE v.shop_id=$1 ORDER BY v.shopify_id`,[run.shopId])).rows});
      assert.deepEqual(await read(batch),await read(single));
      const changed=[{...inputs[0],variants:[inputs[0].variants[0]]},inputs[1]];
      await transaction(pool,c=>writeCatalogProducts({client:c,...batch,records:changed}));
      assert.equal((await pool.query('SELECT count(*) FROM mirror.variants WHERE shop_id=$1',[batch.shopId])).rows[0].count,'2');
      const before=await read(batch);
      await assert.rejects(transaction(pool,c=>writeCatalogProducts({client:c,...batch,records:[{...changed[0],variants:[]},{...changed[1],variants:[changed[0].variants[0]]}]})),/another product/);
      assert.deepEqual(await read(batch),before);
    });
    await t.test("authenticated HTTP import downloads, reconciles all variant pages and publishes real rows", async () => {
      assert.equal((await fetch(base,{method:"POST"})).status,401);
      await service.onInstall(full.session);await service.onInstall(other.session);
      assert.equal((await post("",full.session,{shop:other.session.shop})).status,400);
      const response = await post(""); assert.equal(response.status,202);
      const queued = (await response.json()).data;
      const duplicate = (await (await post("")).json()).data;
      assert.equal(duplicate.id,queued.id);
      assert.equal((await fetch(`${base}/${queued.id}`,{headers:{"x-test-session":other.session.id}})).status,404);
      const rec = createReconciliationService({ database: pool });
      for (const p of full.products) await rec.recordMutationEvent({shopId:full.session.shop,productId:p.id,sourceKey:`import-event-${p.id}`});
      const latest = { ...product(1,[variant(10),variant(11)]), title:"Current title" };
      full.latest = new Map([[latest.id,latest]]);
      const result = await service.processOne(); assert.equal(result.status,"SUCCEEDED");
      assert.equal(full.reads,3);
      const published = (await pool.query("SELECT generation_id FROM mirror.publications WHERE shop_id=$1",[full.session.shop])).rows[0];
      assert.equal(published.generation_id,result.generationId);
      const rows = (await pool.query("SELECT title FROM mirror.products WHERE shop_id=$1 AND generation_id=$2",[full.session.shop,result.generationId])).rows;
      assert.deepEqual(rows,[{title:"Current title"}]);
      assert.equal((await pool.query("SELECT count(*) FROM mirror.variants WHERE shop_id=$1 AND generation_id=$2",[full.session.shop,result.generationId])).rows[0].count,"2");
      const status = await fetch(`${base}/${queued.id}`,{headers:{"x-test-session":full.session.id}});
      assert.equal((await status.json()).data.status,"SUCCEEDED");
      const foreignStatus=await fetch(`${base}/${queued.id}`,{headers:{"x-test-session":other.session.id}});
      assert.equal(foreignStatus.status,404);
      assert.deepEqual(await foreignStatus.json(),{error:"IMPORT_NOT_FOUND"});
      assert.equal((await post(`/${queued.id}/cancel`,other.session)).status,404);
      const untouched=(await pool.query("SELECT shop_id,status,cancel_requested FROM mirror.catalog_import_jobs WHERE id=$1",[queued.id])).rows[0];
      assert.equal(untouched.shop_id,full.session.shop);
      assert.equal(untouched.status,"SUCCEEDED");
      assert.equal(untouched.cancel_requested,false);
      const otherJob=(await (await post("",other.session)).json()).data;
      const cancelled=await post(`/${otherJob.id}/cancel`,other.session);
      assert.equal(cancelled.status,200);
      assert.equal((await cancelled.json()).data.status,"CANCELLED");
    });

    await t.test("interrupted imports resume durable chunks after constructing a new worker", async () => {
      const state = fixture("import-restart",Array.from({length:30},(_,i)=>product(i+100)));
      state.failDownload = true;
      const queued = await service.enqueue(state.session);
      assert.equal((await service.processOne()).status,"RETRY");
      const first = (await pool.query("SELECT generation_id,run_id FROM mirror.catalog_import_jobs WHERE id=$1",[queued.id])).rows[0];
      assert.equal((await pool.query("SELECT count(*) FROM mirror.ingestion_chunks WHERE shop_id=$1 AND run_id=$2",[state.session.shop,first.run_id])).rows[0].count,"1");
      assert.equal((await pool.query("SELECT count(*) FROM mirror.publications WHERE shop_id=$1",[state.session.shop])).rows[0].count,"0");
      state.failDownload = false;
      await pool.query("UPDATE mirror.catalog_import_jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[queued.id]);
      service = makeService();
      const result = await service.processOne(); assert.equal(result.status,"SUCCEEDED");
      assert.equal(result.generationId,first.generation_id);
      assert.equal(state.starts,1);
      assert.equal((await pool.query("SELECT count(*) FROM mirror.products WHERE shop_id=$1",[state.session.shop])).rows[0].count,"30");
    });

    await t.test("cancellation during download fences staging and cannot publish", async () => {
      const state = fixture("import-cancel");
      const queued = await service.enqueue(state.session);
      state.onDownload = () => service.cancel(state.session,queued.id);
      assert.equal((await service.processOne()).status,"CANCELLED");
      assert.equal((await pool.query("SELECT count(*) FROM mirror.publications WHERE shop_id=$1",[state.session.shop])).rows[0].count,"0");
      assert.equal((await service.status(state.session,queued.id)).status,"CANCELLED");
      assert.equal((await pool.query("SELECT status FROM mirror.generations WHERE shop_id=$1",[state.session.shop])).rows[0].status,"FAILED");
    });

    await t.test("failed remote exports cannot publish and a fresh job can start after terminal failure", async () => {
      const state = fixture("import-remote-failed"); state.remoteStatus="FAILED";
      await service.enqueue(state.session);
      assert.equal((await service.processOne()).status,"FAILED");
      assert.equal((await pool.query("SELECT count(*) FROM mirror.publications WHERE shop_id=$1",[state.session.shop])).rows[0].count,"0");
      state.remoteStatus="COMPLETED";
      await service.enqueue(state.session);
      assert.equal((await service.processOne()).status,"SUCCEEDED");
    });

    await t.test("two workers cannot own the same job and expired leases can be reclaimed", async () => {
      const state = fixture("import-claims");
      await service.enqueue(state.session);
      const results=await Promise.all([service.processOne(),makeService().processOne()]);
      assert.equal(results.filter(result=>result?.status==="SUCCEEDED").length,1);
      const expired=fixture("import-expired");const job=await service.enqueue(expired.session);
      await pool.query("UPDATE mirror.catalog_import_jobs SET status='RUNNING',attempts=1,fence=1,lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
      assert.equal((await service.processOne()).status,"SUCCEEDED");
      assert.equal((await service.status(expired.session,job.id)).attempts,2);
    });

    await t.test("shutdown preserves replayable staging rather than cancelling the import", async () => {
      const state=fixture("import-shutdown");
      const job=await service.enqueue(state.session);
      state.onDownload=()=>service.stop();
      assert.equal((await service.processOne()).status,"RETRY");
      const generation=(await pool.query("SELECT status FROM mirror.generations WHERE shop_id=$1",[state.session.shop])).rows[0];
      assert.equal(generation.status,"INGESTING");
      state.onDownload=null;
      service=makeService();
      await pool.query("UPDATE mirror.catalog_import_jobs SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[job.id]);
      assert.equal((await service.processOne()).status,"SUCCEEDED");
      assert.equal(state.starts,1);
    });

    await t.test("scope revocation after ingestion prevents verification and publication", async () => {
      const state=fixture("import-revoked");
      const job=await service.enqueue(state.session);
      state.afterStream=()=>{state.session.scope="";};
      assert.equal((await service.processOne()).status,"RETRY");
      assert.equal((await pool.query("SELECT count(*) FROM mirror.publications WHERE shop_id=$1",[state.session.shop])).rows[0].count,"0");
      state.session.scope="read_products";state.afterStream=null;
      await service.cancel(state.session,job.id);
      assert.equal((await service.processOne()).status,"CANCELLED");
    });

    await t.test("a worker crash on its final attempt cannot strand an active job", async () => {
      const state=fixture("import-exhausted");const job=await service.enqueue(state.session);
      await pool.query("UPDATE mirror.catalog_import_jobs SET status='RUNNING',attempts=8,fence=8,lease_until=now()-interval '1 second' WHERE id=$1",[job.id]);
      assert.equal(await service.processOne(),null);
      assert.equal((await service.status(state.session,job.id)).status,"FAILED");
    });

    await t.test("cancelling a failed legacy job preserves retry history and runs only cancellation cleanup", async () => {
      const state=fixture("import-cancel-failed");
      state.remoteStatus="FAILED";
      const job=await service.enqueue(state.session);
      assert.equal((await service.processOne()).status,"FAILED");
      await pool.query("UPDATE mirror.catalog_import_jobs SET attempts=8 WHERE id=$1",[job.id]);
      await pool.query("UPDATE mirror.generations SET status='INGESTING' WHERE shop_id=$1 AND id=$2",[state.session.shop,job.generationId]);
      const cancelled=await service.cancel(state.session,job.id);
      assert.equal(cancelled.status,"FAILED");
      assert.equal(cancelled.cancelRequested,true);
      assert.equal(cancelled.cancelPending,true);
      assert.equal(cancelled.attempts,8);
      const startsBefore=state.starts;
      const cleanup=await service.processOne();
      assert.equal(cleanup.status,"CANCELLED");
      assert.equal(state.starts,startsBefore);
      const after=await service.status(state.session,job.id);
      assert.equal(after.status,"CANCELLED");
      assert.equal(after.attempts,8);
      assert.equal(after.cancelPending,false);
    });

    await t.test("the startup worker picks up persisted requests without an HTTP request staying open", async () => {
      const state=fixture("import-startup");const job=await service.enqueue(state.session);
      const worker=makeService();
      try {
        await worker.verifyStorage();worker.start();
        let status;
        for (let attempt=0; attempt<150; attempt++) {
          status=await service.status(state.session,job.id);
          if (status.status==="SUCCEEDED" || status.status==="FAILED" || status.status==="RETRY") break;
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(status.status,"SUCCEEDED");
      } finally { await worker.stop(); }
    });
  } finally {
    await new Promise(resolve=>server.close(resolve));
    await service.stop();
  }
}
