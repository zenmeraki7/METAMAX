import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createSelectionService } from "./selection.server.js";

const shopId = "selection-test.myshopify.com";
const authContext = Object.freeze({});
const resolveShop = async context => {
  if (context !== authContext) throw new Error("Authenticated selection context required");
  return shopId;
};
const filter = { version: 1, root: { kind: "condition", field: "product.vendor", operator: "eq", value: "Selected" } };

function fixture(pages, { mapRows, failItems = false } = {}) {
  const calls = [], cursors = [], snapshots = [], items = [];
  let committed = false, rolledBack = false;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM mirror.publications")) return { rows: [{ generation_id: "gen", coverage_revision: "rev", mapping_version: "mapping",installation_version:"installation" }] };
      if (sql.includes("FROM mirror.products")) {
        const ids = [...params[2], ...params[3]];
        return { rows: mapRows ? mapRows(ids) : ids.map(id => ({ id: id.replace("gid://shopify/Product/", ""), shopify_id: `gid://shopify/Product/${id.replace("gid://shopify/Product/", "")}` })) };
      }
      if (sql.includes("INSERT INTO mirror.selection_snapshots")) snapshots.push(params);
      if(sql.includes("SELECT s.* FROM mirror.selection_snapshots"))return {rows:snapshots.filter(p=>p[1]===params[1]).map(p=>({id:p[1],shop_id:p[0],generation_id:p[2],coverage_revision:p[3],status:"APPROVED",expires_at:p[12],mapping_version:p[4],operation:p[5],operation_id:p[6],target_mode:p[14],installation_version:p[15],selected_count:String(items.length),selection_hash:p[11],frozen_at:p[13],registry_version:p[9],definition_revisions:JSON.parse(p[10])}))};
      if (sql.includes("INSERT INTO mirror.selection_items")) {
        if (failItems) throw new Error("membership write failed");
        for(const id of params[3]){if(items.includes(id))throw new Error("Duplicate product across selection pages");items.push(id);}
      }
      if(sql.includes("DELETE FROM mirror.selection_items")) {
        const excluded=new Set([...params[2],...params[3].map(id=>id.replace("gid://shopify/Product/",""))]);
        for(let i=items.length-1;i>=0;i--)if(excluded.has(items[i]))items.splice(i,1);
      }
      if(sql.includes("SELECT product_id FROM mirror.selection_items"))return {rows:items.filter(id=>BigInt(id)>BigInt(params[2])).sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0).slice(0,params[3]??1000).map(product_id=>({product_id}))};
      if(sql.includes("UPDATE mirror.selection_snapshots SET status")) {snapshots[0][8]=params[6];snapshots[0][9]=params[7];snapshots[0][10]=params[8];snapshots[0][11]=params[4];}
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const database = { query: client.query, connect: async () => client };
  const catalogQueryService = {
    async withSelectionSnapshot(context, callback) {
      assert.strictEqual(context.authContext, authContext);
      assert.equal(context.shopId, shopId);
      try {
        calls.push({sql:"BEGIN ISOLATION LEVEL REPEATABLE READ"});
        const result = await callback({ client,generationId:"gen",coverageRevision:"rev", queryPage: async cursor => {
          cursors.push(cursor);
          const page = pages[cursors.length - 1];
          if (page instanceof Error) throw page;
          return { shopId, generationId: "gen", coverageRevision: "rev", registryVersion: "trusted-registry",
            filterAst: filter, filterFingerprint: "trusted-fingerprint", definitionRevisions: [],
            productIds:[],hasMore: false, nextCursor: null, ...page };
        } });
        committed = true;
        calls.push({sql:"COMMIT"});
        return result;
      } catch (error) { rolledBack = true;calls.push({sql:"ROLLBACK"});snapshots.length=0;items.length=0;throw error; }
    },
  };
  const service = createSelectionService({ database, catalogQueryService, resolveShop, logger: { error() {} } });
  return { service, database, catalogQueryService,calls, cursors, snapshots, items,
    state: () => ({ committed, rolledBack }),
    select: overrides => service.createSelection({ authContext, mode: "ALL_MATCHING", filter, ...overrides }),
  };
}

test("all-matching fails closed without the protected query service, authentication, or an explicit filter", async () => {
  const f = fixture([]);
  assert.throws(() => createSelectionService({ database: f.database, resolveShop }), /Protected catalog query service/);
  await assert.rejects(() => f.select({ authContext: null }), /Authenticated selection/);
  await assert.rejects(() => f.select({ filter: null }));
  await assert.rejects(() => f.select({ client: { query() {} } }), /SQL clients/);
  assert.equal(f.calls.length, 0);
});

test("all-matching drains every page, applies GID and numeric exclusions, then freezes exact membership", async () => {
  const f = fixture([
    { productIds: ["101", "102"], hasMore: true, nextCursor: "page-2" },
    { productIds: ["103", "104"], hasMore: true, nextCursor: "page-3" },
    { productIds: ["105"] },
  ]);
  const result = await f.select({ mode: "ALL_MATCHING_WITH_EXCLUSIONS", excludedProductIds: ["102", "gid://shopify/Product/104"] });
  assert.deepEqual(f.cursors, [undefined, "page-2", "page-3"]);
  assert.deepEqual(f.items, ["101", "103", "105"]);
  assert.equal(Object.hasOwn(result,"productIds"),false);
  assert.equal(result.selectedCount, 3);
  assert.equal(result.selectionHash, createHash("sha256").update("101,103,105").digest("hex"));
  assert.deepEqual([result.generationId, result.coverageRevision, result.mappingVersion], ["gen", "rev", "mapping"]);
  assert.equal(f.snapshots[0][8], "trusted-fingerprint");
  assert.equal(f.snapshots[0][9], "trusted-registry");
  assert.equal(f.snapshots[0][10], "[]");
  const draft = f.calls.findIndex(c => c.sql.includes("INSERT INTO mirror.selection_snapshots"));
  const membership = f.calls.findIndex(c => c.sql.includes("INSERT INTO mirror.selection_items"));
  const approved = f.calls.findIndex(c => c.sql.includes("SET status = 'APPROVED'"));
  assert.match(f.calls[draft].sql, /'DRAFT'/);
  assert.ok(draft < membership && membership < approved);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(f.state(), { committed: true, rolledBack: false });
});

test("exclusions are honored even when the caller uses ALL_MATCHING", async () => {
  const f = fixture([{ productIds: ["101", "102"] }]);
  await f.select({ excludedProductIds: ["102"] });
  assert.deepEqual(f.items,["101"]);
});

test("empty matches freeze an empty selection without querying all products", async () => {
  const f = fixture([{ productIds: [] }]);
  assert.equal((await f.select()).selectedCount, 0);
  assert.equal(f.calls.filter(c => c.sql.includes("FROM mirror.products")).length, 0);
  assert.deepEqual(f.items, []);
});

for (const change of [
  { generationId: "other" }, { coverageRevision: "other" }, { shopId: "other.myshopify.com" },
  { registryVersion: "changed" }, { definitionRevisions: [{ fieldId: "changed" }] },
  { filterFingerprint: "changed" }, { filterAst: { changed: true } },
  { nextCursor: "page-2", hasMore: true }, { nextCursor: null, hasMore: true },
  { hasMore: undefined }, { productIds: ["101"] }, { productIds: [] , hasMore: true },
]) {
  test(`all-matching rejects changed or incomplete pages: ${JSON.stringify(change)}`, async () => {
    const f = fixture([{ productIds: ["101"], hasMore: true, nextCursor: "page-2" }, { productIds: ["102"], ...change }]);
    await assert.rejects(() => f.select());
    assert.equal(f.snapshots.length, 0);
    assert.deepEqual(f.state(), { committed: false, rolledBack: true });
  });
}

test("a failed later page cannot approve a partial selection", async () => {
  const f = fixture([{ productIds: ["101"], hasMore: true, nextCursor: "page-2" }, new Error("revoked")]);
  await assert.rejects(() => f.select(), /revoked/);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.state().rolledBack, true);
});

test("mapping cannot drop an authorized ID or introduce an extra product", async () => {
  for (const mapRows of [() => [], () => [{ id: "999" }]]) {
    const f = fixture([{ productIds: ["101"] }], { mapRows });
    await assert.rejects(() => f.select(), /mapping/);
    assert.equal(f.snapshots.length, 0);
  }
});

test("invalid exclusions fail before any database query", async () => {
  for (const excludedProductIds of [["bad"], ["gid://shopify/Order/1"], [9007199254740992], null]) {
    const f = fixture([]);
    await assert.rejects(() => f.select({ excludedProductIds }));
    assert.equal(f.calls.length, 0);
  }
});

test("membership write errors abort the transaction before freezing", async () => {
  const f = fixture([{ productIds: ["101"] }], { failItems: true });
  await assert.rejects(() => f.select(), /membership write failed/);
  assert.equal(f.calls.some(c => c.sql.includes("SET status = 'APPROVED'")), false);
  assert.equal(f.state().rolledBack, true);
});

test("explicit selection uses a transaction and follows draft, materialize, freeze ordering", async () => {
  const f = fixture([]);
  const result = await f.service.createSelection({ authContext, productIds: ["101", "102"] });
  assert.deepEqual(f.items, ["101", "102"]);
  assert.equal(f.calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ");
  assert.equal(f.calls.at(-1).sql, "COMMIT");
});

test("a query-only database cannot partially commit a selection", async () => {
  assert.throws(() => createSelectionService({ resolveShop, database: { query() { assert.fail("Autocommit query must not run"); } } }), /Protected catalog query service/);
});

test("every selection mode requires authentication and rejects a caller shop before SQL", async () => {
  for (const mode of ["EXPLICIT", "ALL_MATCHING", "ALL_MATCHING_WITH_EXCLUSIONS"]) {
    for (const override of [{ authContext: null }, { authContext: {} }, { shopId: "other.myshopify.com" }]) {
      const f = fixture([]);
      await assert.rejects(() => f.service.createSelection({ mode, authContext, productIds:["101"], filter, ...override }));
      assert.equal(f.calls.length, 0);
    }
  }
  assert.throws(() => createSelectionService({ database: fixture([]).database }), /Trusted selection shop resolver/);
});

test("explicit SQL derives its tenant only from the authenticated context", async () => {
  const f = fixture([]);
  await f.service.createSelection({ authContext, productIds:["101"] });
  for (const {sql,params} of f.calls.filter(call => /FROM mirror\.(publications|products)|INSERT INTO mirror\.selection_/.test(call.sql))) {
    assert.equal(params[0], shopId, sql);
  }
});

test("explicit selection rechecks authentication before freezing commits", async () => {
  const f = fixture([]);
  let resolves = 0;
  const service = createSelectionService({ database:f.database, catalogQueryService:f.catalogQueryService,logger:{error() {}}, resolveShop:async () => {
    if (++resolves >= 3) throw new Error("revoked");
    return shopId;
  } });
  await assert.rejects(() => service.createSelection({ authContext, productIds:["101"] }), /revoked/);
  assert.equal(f.calls.some(call => call.sql === "COMMIT"), false);
  assert.equal(f.calls.at(-1).sql, "ROLLBACK");
});

test("selection returns bounded metadata and membership pages use numeric ID order", async () => {
  const f=fixture([{productIds:["100","20","3"]}]);
  const result=await f.select();
  assert.equal(Object.hasOwn(result,"productIds"),false);
  const stored=await f.service.getSelectionSnapshot({authContext,snapshotId:result.snapshotId});
  assert.deepEqual(stored,result);assert.ok(Object.isFrozen(stored));
  assert.equal(Object.hasOwn(stored,'selected_count'),false);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<2048);
  assert.equal(result.selectionHash,createHash("sha256").update("3,20,100").digest("hex"));
  const first=await f.service.getSelectionItems({authContext,snapshotId:result.snapshotId,limit:2});
  assert.deepEqual(first,{productIds:["3","20"],hasMore:true,nextAfter:"20"});
  assert.deepEqual(await f.service.getSelectionItems({authContext,snapshotId:result.snapshotId,after:first.nextAfter,limit:2}),
    {productIds:["100"],hasMore:false,nextAfter:null});
  await assert.rejects(()=>f.service.getSelectionItems({authContext,snapshotId:result.snapshotId,limit:1001}));
  await assert.rejects(()=>f.service.getSelectionItems({authContext,snapshotId:result.snapshotId,shopId:"other.myshopify.com"}));
});

test("protected transaction callback shares selection client and aborts membership on failure", async () => {
  const f=fixture([{productIds:["101"]}]);
  await assert.rejects(()=>f.service.withSelectionTransaction({authContext,mode:"ALL_MATCHING",filter},async({client,snapshot})=>{
    assert.equal(snapshot.selectedCount,1);
    await client.query("CHECKPOINT CALLBACK");throw new Error("checkpoint failed");
  }),/checkpoint failed/);
  assert.equal(f.calls.some(call=>call.sql==="CHECKPOINT CALLBACK"),true);
  assert.deepEqual(f.state(),{committed:false,rolledBack:true});
  assert.deepEqual(f.items,[]);
});

test('explicit selections reject unresolved IDs rather than reducing merchant scope',async()=>{
 const f=fixture([{productIds:['1']}],{mapRows:()=>[]});
 await assert.rejects(()=>f.service.createSelection({authContext,productIds:['1']}),{code:'FIELD_CONTRACT_MISMATCH'});
 assert.equal(f.calls.some(call=>call.sql.includes("SET status='APPROVED'")),false);
});
