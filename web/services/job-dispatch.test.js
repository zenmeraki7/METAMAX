import test from "node:test";
import assert from "node:assert/strict";
import { createJobDispatchService } from "./job-dispatch.server.js";

const shopId = "dispatch.myshopify.com", authContext = Object.freeze({});
function fixture({count = 100000, kind = "bulk_edit", loseRace = false, failItems = false, deny = false} = {}) {
  const calls = [], commands = new Map();
  let current;
  const contract = { id:"approved",shop_id:shopId,status:"APPROVED",operation:kind,snapshot_id:"snapshot",
    contract:kind === "undo" ? { sourceCommandId:"source",fields:["title"] } : { updates:{title:"Approved"},targetTitle:"Display metadata" } };
  const query = async (sql, params) => {
    calls.push({sql,params});
    if (sql.includes("FROM mirror.job_commands c")) return { rows:current ? [{...current,operation_id:"op",item_count:count}] : [] };
    if (sql.includes("INSERT INTO mirror.job_commands")) {
      assert.match(sql, /ON CONFLICT DO NOTHING/);
      const identity = JSON.stringify([params[0],params[3],params[1]]);
      if (commands.has(identity)) return {rows:[]};
      current = { id:"command",status:"PENDING" };
      commands.set(identity,current);
      if (loseRace) return {rows:[]};
      return {rows:[current]};
    }
    if (sql.includes("INSERT INTO mirror.edit_operations")) return {rows:[{id:"op"}]};
    if (sql.includes("SELECT id FROM mirror.edit_operations")) return {rows:[{id:"source-op"}]};
    if (sql.includes("SELECT s.selected_count")) return {rows:[{selected_count:count,target_count:String(count)}]};
    if (sql.includes("INSERT INTO mirror.job_items")) {
      if (failItems) throw new Error("membership failed");
      return {rowCount:count};
    }
    return {rows:[],rowCount:1};
  };
  const database = { query,async connect() { return {query,release() {}}; } };
  const options = { database, resolveShop:async context => {
    if (context !== authContext) throw new Error("unverified"); return shopId;
  },approvalService:{async getApprovedContract() {return structuredClone(contract);}},authorizeWrite:async () => !deny };
  return { service:createJobDispatchService(options),options,contract,calls,commands };
}

for (const kind of ["bulk_edit","undo"]) {
  const run = f => f.service[kind === "undo" ? "dispatchUndo" : "dispatchBulkEdit"].bind(f.service);
  test(`${kind} dispatch derives a stable identity despite retries and changing caller keys`, async () => {
    const f = fixture({kind});
    const options = {authContext,contractId:"approved",sourceCommandId:"source"};
    const first = await run(f)(options);
    const retried = await run(f)({...options,idempotencyKey:"changed"});
    assert.equal(first.commandId,retried.commandId);
    assert.equal(first.idempotencyKey,retried.idempotencyKey);
    assert.equal(retried.existing,true);
    assert.equal(f.commands.size,1);
    assert.equal(f.calls.filter(call => call.sql.includes("INSERT INTO mirror.outbox_events")).length,1);
    const inserts = f.calls.filter(call => call.sql.includes("INSERT INTO mirror.job_items"));
    assert.equal(inserts.length,1);
    assert.match(inserts[0].sql,/SELECT si.shop_id/);
    assert.match(inserts[0].sql,/si.shop_id=\$1 AND si.snapshot_id=\$3/);
    assert.equal(inserts[0].params[0],shopId);
    assert.equal(inserts[0].params.length,kind === "undo" ? 5 : 4);
    assert.equal(first.itemCount,100000);
    if (kind === "bulk_edit") assert.deepEqual(JSON.parse(inserts[0].params[3]),{title:"Approved"});
  });
  test(`${kind} dispatch returns the concurrent winner without inserting items again`, async () => {
    const f = fixture({kind,loseRace:true});
    const result = await run(f)({authContext,contractId:"approved",sourceCommandId:"source"});
    assert.equal(result.existing,true);
    assert.equal(f.calls.some(call => call.sql.includes("INSERT INTO mirror.job_items")),false);
  });
  test(`${kind} dispatch rejects forged context, browser shop and revoked write permission`, async () => {
    for (const override of [{authContext:null},{authContext:{}},{shopId:"other.myshopify.com"}]) {
      const f = fixture({kind});
      await assert.rejects(() => run(f)({authContext,contractId:"approved",sourceCommandId:"source",...override}));
      assert.equal(f.calls.length,0);
    }
    const f = fixture({kind,deny:true});
    await assert.rejects(() => run(f)({authContext,contractId:"approved",sourceCommandId:"source"}), /authorization/);
    assert.equal(f.commands.size,0);
    assert.equal(f.calls.at(-1).sql,"ROLLBACK");
  });
}

test("dispatch rolls back materialization failures without publishing queue notifications", async () => {
  const f = fixture({failItems:true});
  const service = createJobDispatchService({...f.options,queue:{add() {assert.fail("Uncommitted job published");}}});
  await assert.rejects(() => service.dispatchBulkEdit({authContext,contractId:"approved"}),/membership failed/);
  assert.equal(f.calls.at(-1).sql,"ROLLBACK");
  assert.equal(f.calls.some(call => call.sql.includes("INSERT INTO mirror.outbox_events")),false);
});

test("undo requires a new undo approval bound to the source; bulk metadata is never a write", async () => {
  const f = fixture({kind:"undo"});
  await assert.rejects(() => f.service.dispatchUndo({authContext,contractId:"approved",sourceCommandId:"different"}),/differs from approval/);
  const bulk = fixture();
  bulk.contract.contract.updates.targetTitle = "Unapproved write";
  await assert.rejects(() => bulk.service.dispatchBulkEdit({authContext,contractId:"approved"}),/Unsupported approved/);
  assert.equal(bulk.commands.size,0);
});
