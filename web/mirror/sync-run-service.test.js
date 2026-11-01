import test from "node:test";
import assert from "node:assert/strict";
import { createSyncRunService } from "./sync-run-service.server.js";
import { transaction } from "./transactions.server.js";
const shopId = "unit.myshopify.com";
const never = {
  connect() {
    assert.fail("Invalid input reached database");
  },
};

test('getSyncRun reads only through a transaction with local shop scope and preserves absence',async()=>{
  let active=false,scope=null,found=true,reads=0;
  const database={query(){assert.fail('Unscoped pool read');},async connect(){return {
    async query(sql,params){
      if(sql.startsWith('BEGIN'))active=true;
      if(sql.includes("set_config('app.shop_id'")){assert.equal(active,true);scope=params[0];}
      if(sql.includes('FROM mirror.ingestion_runs WHERE')){
        assert.equal(active,true);assert.equal(scope,shopId);assert.deepEqual(params,[shopId,7n]);reads++;
        return {rows:found?[{runId:7n,shopId,status:'RUNNING'}]:[]};
      }
      if(sql==='COMMIT'||sql==='ROLLBACK'){active=false;scope=null;}
      return {rows:[]};
    },release(){assert.equal(active,false);assert.equal(scope,null);}
  };}};
  const service=createSyncRunService({database});
  assert.equal((await service.getSyncRun({shopId,runId:7n})).runId,7n);
  found=false;assert.equal(await service.getSyncRun({shopId,runId:7n}),null);assert.equal(reads,2);
  await assert.rejects(()=>service.getSyncRun({shopId:'invalid',runId:7n}));assert.equal(reads,2);
});
test("ingestion rejects unsupported datasets and absent worker identity before connecting", async () => {
  const service = createSyncRunService({ database: never });
  for (const input of [
    { shopId: "bad", workerId: "w" },
    { shopId, workerId: "w", dataset: "metafields" },
    { shopId, workerId: "w", requiredDatasets: ["products"] },
    { shopId },
  ])
    await assert.rejects(() => service.startIngestionRun(input));
});
test("lease and retention durations are bounded", async () => {
  const service = createSyncRunService({ database: never });
  await assert.rejects(() =>
    service.renewRunLease({ shopId, workerId: "w", leaseMs: Infinity }),
  );
  await assert.rejects(() =>
    service.retainGeneration({
      shopId,
      generationId: "g",
      until: Date.now() + 8 * 86400000,
    }),
  );
});
test("transaction retries conflicts after rollback and never retries arbitrary failures", async () => {
  const commands = [];
  let attempts = 0,
    released = 0;
  const database = {
    async connect() {
      return {
        async query(sql) {
          commands.push(sql);
          return { rows: [] };
        },
        release() {
          released++;
        },
      };
    },
  };
  assert.equal(
    await transaction(database, async () => {
      if (++attempts < 3)
        throw Object.assign(Error("serialization"), { code: "40001" });
      return "ok";
    }),
    "ok",
  );
  assert.equal(released, 3);
  assert.equal(commands.filter((s) => s === "ROLLBACK").length, 2);
  attempts = 0;
  await assert.rejects(() =>
    transaction(database, async () => {
      attempts++;
      throw Error("bad payload");
    }),
  );
  assert.equal(attempts, 1);
});
