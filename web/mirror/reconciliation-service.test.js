import test from "node:test";
import assert from "node:assert/strict";
import { createReconciliationService } from "./reconciliation-service.server.js";
const shopId = "unit.myshopify.com",
  productId = "gid://shopify/Product/1";
const never = {
  connect() {
    assert.fail("Invalid input reached database");
  },
};

test('dirty scanner scopes its transaction, preserves bigint tokens and rolls back read failures',async()=>{
  let active=false,scope=null,failRead=false,rolledBack=false;
  const failure=Error('read failed');
  const database={query(){assert.fail('Unscoped pool read');},async connect(){return {
    async query(sql,params){
      if(sql.startsWith('BEGIN'))active=true;
      if(sql.includes("set_config('app.shop_id'")){assert.equal(active,true);scope=params[0];}
      if(sql.includes('FROM mirror.catalog_changes WHERE')){
        assert.equal(active,true);assert.equal(scope,shopId);assert.deepEqual(params,[shopId,2]);
        if(failRead)throw failure;
        return {rows:[{productId,revision:'9007199254740993',appliedRevision:'2',fence:'3',dirty:true}]};
      }
      if(sql==='ROLLBACK')rolledBack=true;
      if(sql==='COMMIT'||sql==='ROLLBACK'){active=false;scope=null;}
      return {rows:[]};
    },release(){assert.equal(active,false);assert.equal(scope,null);}
  };}};
  const service=createReconciliationService({database});
  const rows=await service.scanDueDirtyProducts({shopId,limit:2});
  assert.equal(rows[0].revision,9007199254740993n);assert.equal(rows[0].appliedRevision,2n);assert.equal(rows[0].fence,3n);
  failRead=true;await assert.rejects(()=>service.scanDueDirtyProducts({shopId,limit:2}),error=>error===failure);
  assert.equal(rolledBack,true);
});
test("event identity and tenant validation precede persistence", async () => {
  const service = createReconciliationService({ database: never });
  for (const input of [
    { shopId: "bad", productId, sourceKey: "e" },
    { shopId, productId: "bad", sourceKey: "e" },
    { shopId, productId, sourceKey: "" },
    { shopId, productId, sourceKey: "e", payloadHash: "bad" },
  ])
    await assert.rejects(() => service.recordMutationEvent(input));
});
test("reconciliation requires complete authoritative state or explicit deletion", async () => {
  const service = createReconciliationService({ database: never });
  for (const productPayload of [null, {}, { id: productId, title: "partial" }])
    await assert.rejects(() =>
      service.reconcileProduct({
        shopId,
        productId,
        generationId: "g",
        workerId: "w",
        observedRevision: 1n,
        fence: 1n,
        productPayload,
      }),
    );
});
test("scanner and retry limits reject NaN, infinity and excessive budgets", async () => {
  const service = createReconciliationService({ database: never });
  for (const limit of [NaN, Infinity, 0, 201])
    await assert.rejects(() => service.scanDueDirtyProducts({ shopId, limit }));
  await assert.rejects(() =>
    service.recordFailure({
      shopId,
      productId,
      fence: 1n,
      maxAttempts: 21,
      error: Error(),
    }),
  );
});
test("cancellation before claim makes no external or database request", async () => {
  const service = createReconciliationService({ database: never });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      service.reconcileLatestProduct({
        shopId,
        productId,
        workerId: "w",
        signal: controller.signal,
        fetchProduct() {
          assert.fail("Remote request after abort");
        },
      }),
    { name: "AbortError" },
  );
});
