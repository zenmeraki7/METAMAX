import test from "node:test";
import assert from "node:assert/strict";
import { createJobDispatchService } from "../services/job-dispatch.server.js";
import { createOperationWorker } from "./operation.worker.js";

test("job dispatch: creates durable job command, outbox event, and edit items with idempotency", async () => {
  const shopId = "dispatch-test.myshopify.com";
  const contractId = "contract-123";
  const commands = [];
  const items = [];
  const outbox = [];

  const mockDb = {
    async query(sql, params) {
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
            contract: { updates: { status: "ACTIVE" } },
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
  const dispatch = createJobDispatchService({ database: mockDb,
    resolveShop: async context => { assert.equal(context,authContext); return shopId; },
    authorizeWrite: async () => true,
    approvalService: { async getApprovedContract() { return (await mockDb.query("FROM mirror.execution_contracts")).rows[0]; } },
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

test("operation worker: claims command, captures before-state, applies mutation, and verifies remote result", async () => {
  const shopId = "worker-test.myshopify.com";
  let commandState = {
    id: "cmd-10",
    shop_id: shopId,
    contract_id: "contract-10",
    kind: "bulk_edit",
    status: "PENDING",
    attempts: 0,
    max_attempts: 8,
    fence: 0,
    cancel_requested_at: null,
  };

  const snapshots = [];
  const updatedItems = [];

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("mirror.job_commands") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        if (commandState.status === "PENDING") {
          return { rows: [commandState] };
        }
        return { rows: [] };
      }
      if (sql.includes("mirror.job_commands") && sql.includes("SET status = 'RUNNING'")) {
        commandState.status = "RUNNING";
        commandState.fence += 1;
        commandState.attempts += 1;
        return { rows: [commandState] };
      }
      if (sql.includes("mirror.job_items") && sql.includes("status IN ('PENDING', 'RETRY')")) {
        return {
          rows: [
            {
              id: "item-101",
              resource_id: "gid://shopify/Product/101",
              intended_values: JSON.stringify({ title: "Updated Title" }),
              restore_snapshot_id: null,
              attempts: 0,
            },
          ],
        };
      }
      if (sql.includes("mirror.product_snapshots") && sql.includes("INSERT")) {
        snapshots.push(params);
        return { rows: [{ id: "snap-101" }] };
      }
      if (sql.includes("mirror.product_snapshots") && sql.includes("after_hash")) {
        return { rowCount: 1 };
      }
      if (sql.includes("mirror.job_items") && sql.includes("SET status = 'SUCCEEDED'")) {
        updatedItems.push(params);
        return { rowCount: 1 };
      }
      if (sql.includes("mirror.job_items") && sql.includes("status != 'SUCCEEDED'")) {
        return { rows: [{ remaining: 0 }] };
      }
      if (sql.includes("mirror.job_commands") && sql.includes("SET status = 'SUCCEEDED'")) {
        commandState.status = "SUCCEEDED";
        return { rowCount: 1 };
      }
      if (sql.includes("mirror.outbox_events") && sql.includes("dispatched_at")) {
        return { rowCount: 1 };
      }
      if (sql.includes("mirror.audit_events")) {
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  let remoteState = { title: "Original Title" };
  const mockShopify = {
    async readProduct() {
      return remoteState;
    },
    async applyMutation({ values }) {
      remoteState = { ...remoteState, ...values };
      return remoteState;
    },
  };

  const worker = createOperationWorker({
    database: mockDb,
    shopifyClientFactory: async () => mockShopify,
    approvalService: { async getApprovedContract() { return { shop_id: shopId, status:"APPROVED",operation:"bulk_edit",contract:{ updates:{title:"Updated Title"} } }; } },
    authorizeWrite: async () => true,
  });

  const outcome = await worker.processOne({ workerId: "worker-1" });

  assert.equal(outcome.kind, "SUCCEEDED");
  assert.equal(commandState.status, "SUCCEEDED");
  assert.equal(snapshots.length, 1);
  assert.equal(updatedItems.length, 1);
});

test("operation worker safe undo: detects concurrent intervening modifications and fails item safely", async () => {
  const shopId = "undo-test.myshopify.com";
  let commandState = {
    id: "cmd-undo-1",
    shop_id: shopId,
    contract_id: "contract-undo-1",
    kind: "undo",
    status: "PENDING",
    attempts: 0,
    max_attempts: 8,
    fence: 0,
    cancel_requested_at: null,
  };

  let itemFailedReason = null;

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("mirror.job_commands") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        if (commandState.status === "PENDING") return { rows: [commandState] };
        return { rows: [] };
      }
      if (sql.includes("mirror.job_commands") && sql.includes("SET status = 'RUNNING'")) {
        commandState.status = "RUNNING";
        commandState.fence += 1;
        return { rows: [commandState] };
      }
      if (sql.includes("mirror.job_items") && sql.includes("status IN ('PENDING', 'RETRY')")) {
        return {
          rows: [
            {
              id: "item-undo-1",
              resource_id: "gid://shopify/Product/201",
              intended_values: JSON.stringify({ title: "Old Title" }),
              restore_snapshot_id: "snap-201",
              attempts: 0,
            },
          ],
        };
      }
      if (sql.includes("mirror.product_snapshots") && sql.includes("after_hash")) {
        return {
          rows: [{
            before_values: { title: "Old Title" },
            after_hash: "expected-hash-before-intervening-change",
          }],
        };
      }
      if (sql.includes("mirror.job_items") && sql.includes("status = 'FAILED'")) {
        itemFailedReason = "CONCURRENT_INTERVENING_MODIFICATION";
        return { rowCount: 1 };
      }
      if (sql.includes("mirror.job_items") && sql.includes("status != 'SUCCEEDED'")) {
        return { rows: [{ remaining: 1 }] }; // 1 item failed
      }
      if (sql.includes("mirror.job_commands") && sql.includes("status =")) {
        commandState.status = "FAILED";
        return { rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  // Remote product was modified externally, producing different hash from after_hash
  const mockShopify = {
    async readProduct() {
      return { title: "Intervening Changed Title" };
    },
  };

  const worker = createOperationWorker({
    database: mockDb,
    shopifyClientFactory: async () => mockShopify,
    approvalService: { async getApprovedContract() { return { shop_id: shopId, status:"APPROVED",operation:"undo",contract:{ sourceCommandId:"source",fields:["title"] } }; } },
    authorizeWrite: async () => true,
  });

  const outcome = await worker.processOne({ workerId: "worker-undo" });

  assert.equal(outcome.kind, "PARTIAL");
  assert.ok(itemFailedReason);
});
