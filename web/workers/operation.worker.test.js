import {approvedContractFixture} from '../security/test-support/approved-contract.js';
import {createInstallationResolver} from '../security/installation-lifecycle.server.js';
import test,{mock} from "node:test";
import assert from "node:assert/strict";
const actualRuntime=await import('../security/runtime-database.server.js');
mock.module('../security/runtime-database.server.js',{namedExports:{...actualRuntime,assertRuntimeDatabaseProfile(){}}});
const {createJobDispatchService}=await import("../services/job-dispatch.server.js");
const {createOperationWorker}=await import("./operation.worker.js");

test("job dispatch: creates durable job command, outbox event, and edit items with idempotency", async () => {
  const shopId = "dispatch-test.myshopify.com";
  const contractId = "contract-123";
  const commands = [];
  const items = [];
  const outbox = [];

  const mockDb = {
    async query(sql, params) {
      if(sql.includes('FROM mirror.shops'))return {rows:[{installation_version:'install-1'}]};
      if (sql.includes("FROM mirror.job_commands c")) {
        // First check: does not exist
        return { rows: [] };
      }
      if (sql.includes("FROM mirror.execution_contracts")) {
        return {
          rows: [{
            id: contractId,
            shop_id: shopId,
            snapshot_id: "snap-123",
            status: "APPROVED",
            operation: "bulk_edit",
            contract: { writeCapabilityVersion:'product-set-v1',updates: { status: "ACTIVE" } },
          }],
        };
      }
      if (sql.includes("SELECT s.selected_count")) return { rows: [{ selected_count: 2, target_count: "2" }] };
      if (sql.startsWith("SELECT") && sql.includes("FROM mirror.selection_items si")) {
        return {
          rows: [
            { id: "1", shopify_id: "gid://shopify/Product/1", title: "Product 1" },
            { id: "2", shopify_id: "gid://shopify/Product/2", title: "Product 2" },
          ],
        };
      }
      if (sql.includes("INSERT INTO mirror.job_commands")) {
        commands.push(params);
        return { rows: [{ id: "cmd-1", status: "PENDING" }] };
      }
      if (sql.includes("INSERT INTO mirror.edit_operations")) {
        return { rows: [{ id: "edit-op-1" }] };
      }
      if (sql.includes("INSERT INTO mirror.job_items")) {
        items.push(params);
        return { rowCount: 2 };
      }
      if (sql.includes("INSERT INTO mirror.outbox_events")) {
        outbox.push(params);
        return { rowCount: 1 };
      }
      if (sql.includes("INSERT INTO mirror.audit_events")) {
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  mockDb.connect = async () => ({ query:mockDb.query,release() {} });
  const authContext = Object.freeze({});
  const dispatch = createJobDispatchService({ database: mockDb,resolveTenant:async()=>createInstallationResolver({readInstallation:async()=>({installation_version:'install-1'})})(shopId),
    resolveShop: async context => { assert.equal(context,authContext); return shopId; },
    authorizeWrite: async () => true,
    approvalService: { async getApprovedContract() { return approvedContractFixture((await mockDb.query("FROM mirror.execution_contracts")).rows[0]); } },
  });

  const result = await dispatch.dispatchBulkEdit({
    authContext,
    contractId,
    idempotencyKey: "unique-key-1",
  });

  assert.equal(result.status, "PENDING");
  assert.equal(result.commandId, "cmd-1");
  assert.equal(result.itemCount, 2);
  assert.equal(commands.length, 1);
  assert.equal(items.length, 1);
  assert.deepEqual(JSON.parse(items[0][3]), { status: "ACTIVE" });
  assert.equal(outbox.length, 1);
});

test("operation worker refuses the legacy unjournaled transport", () => {
  assert.throws(() => createOperationWorker({database:{query(){},async connect(){}},shopifyClientFactory:async()=>({}),
    approvalService:{async getApprovedContract(){}},authorizeWrite:async()=>true}),/Issued durable history execution/);
  assert.throws(() => createOperationWorker({database:{query(){},async connect(){}},shopifyClientFactory:async()=>({}),
    approvalService:{async getApprovedContract(){}},authorizeWrite:async()=>true,historyExecution:{async execute(){}}}),/Issued durable history execution/);
});