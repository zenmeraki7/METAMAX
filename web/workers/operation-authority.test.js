import test from "node:test";
import assert from "node:assert/strict";
import { createOperationWorker } from "./operation.worker.js";

const shopId = "worker.myshopify.com";
function fixture({ intended = {title:"Approved"}, contractShop = shopId, revoke = false, deny = false, missingRead = false } = {}) {
  const calls = [], mutations = [];
  let approvals = 0;
  const database = { async query(sql,params) {
    calls.push({sql,params});
    if (sql.includes("FOR UPDATE SKIP LOCKED") || sql.includes("SET status = 'RUNNING'")) {
      return { rows:[{id:"command",shop_id:shopId,contract_id:"contract",kind:"bulk_edit",fence:1,attempts:1}] };
    }
    if (sql.includes("status IN ('PENDING', 'RETRY')")) return {rows:[{id:"item",resource_id:"gid://shopify/Product/1",intended_values:intended,attempts:0}]};
    if (sql.includes("INSERT INTO mirror.product_snapshots")) return {rows:[{id:"before"}]};
    if (sql.includes("status != 'SUCCEEDED'")) return {rows:[{remaining:1}]};
    return {rows:[],rowCount:1};
  } };
  const worker = createOperationWorker({ database,logger:{error() {}},
    approvalService:{async getApprovedContract() {
      if (++approvals >= 2 && revoke) return null;
      return {shop_id:contractShop,status:"APPROVED",operation:"bulk_edit",contract:{updates:{title:"Approved"}}};
    }},authorizeWrite:async () => !deny,
    shopifyClientFactory:async () => ({
      ...(missingRead ? {} : {async readProduct() {return {title:"Before"};}}),
      async applyMutation({values}) {mutations.push(values);return values;},
    }),
  });
  return {worker,calls,mutations};
}

for (const [name,options] of [
  ["display metadata",{intended:{title:"Approved",targetTitle:"Metadata"}}],
  ["unapproved fields",{intended:{title:"Approved",vendor:"Injected"}}],
  ["changed approved values",{intended:{title:"Changed"}}],
  ["another shop's approval",{contractShop:"other.myshopify.com"}],
  ["revoked approval",{revoke:true}],
  ["missing current write permission",{deny:true}],
  ["missing authoritative product reader",{missingRead:true}],
  ["malformed item JSON",{intended:"{"}],
]) {
  test(`operation worker never mutates with ${name}`, async () => {
    const f = fixture(options);
    await f.worker.processOne({workerId:"worker"});
    assert.deepEqual(f.mutations,[]);
    assert.ok(f.calls.some(call => call.sql.includes("SET status = CASE")));
  });
}

test("operation worker sends only the exact canonical approved fields", async () => {
  const f = fixture();
  await f.worker.processOne({workerId:"worker"});
  assert.deepEqual(f.mutations,[{title:"Approved"}]);
});
