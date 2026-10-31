import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalService, computeContractHash } from "./approval.server.js";

test("approval service: binds immutable contract and verifies contractHash against tampering", async () => {
  const shopId = "approval-test.myshopify.com";
  const snapshotId = "snap-123";
  let storedContract = null;

  const mockDb = {
    async query(sql, params) {
      if (sql.includes("FROM mirror.selection_snapshots") && sql.includes("FOR SHARE")) {
        return {
          rows: [{
            id: snapshotId,
            status: "APPROVED",
            selection_hash: "selection-sha256-hash",
            expires_at: new Date(Date.now() + 100000).toISOString(),
            generation_id: "gen-active",
          }],
        };
      }
      if (sql.includes("INSERT INTO mirror.execution_contracts")) {
        storedContract = {
          shop_id: params[0],
          id: params[1],
          snapshot_id: params[2],
          operation: params[3],
          approval_revision: params[4],
          status: "APPROVED",
          contract: JSON.parse(params[5]),
          contract_hash: params[6],
          approved_by: params[7],
          approved_at: params[8],
          expires_at: params[9],
          selection_hash: "selection-sha256-hash",
          hash_version: "canonical-v2",
          canonical_contract: params[10],
        };
        return { rowCount: 1 };
      }
      if (sql.includes("FROM mirror.execution_contracts c")) {
        return { rows: storedContract ? [storedContract] : [] };
      }
      if (sql.includes("UPDATE mirror.execution_contracts SET status='APPROVED'")) return {rowCount:1};
      return { rows: [], rowCount: 0 };
    },
  };

  const service = createApprovalService({ database: mockDb });

  const approved = await service.approveContract({
    shopId,
    snapshotId,
    contractPayload: { field: "product.title", action: "prefix", value: "[Sale] " },
    approvedBy: "actor:merchant_1",
  });

  assert.equal(approved.status, "APPROVED");
  assert.ok(approved.contractId);
  assert.ok(approved.contractHash);

  // Verify retrieval and hash validation
  const retrieved = await service.getApprovedContract({
    shopId,
    contractId: approved.contractId,
  });
  assert.ok(retrieved);
  assert.equal(retrieved.status, "APPROVED");
  assert.equal(retrieved.hash_version,"canonical-v2");
  const savedCanonical=storedContract.canonical_contract;
  storedContract.canonical_contract=` ${savedCanonical}`;
  await assert.rejects(()=>service.getApprovedContract({shopId,contractId:approved.contractId}),/contractHash mismatch/);
  storedContract.canonical_contract=savedCanonical;
  storedContract.hash_version="unsupported-v99";
  await assert.rejects(()=>service.getApprovedContract({shopId,contractId:approved.contractId}),/contractHash mismatch/);
  storedContract.hash_version="canonical-v2";

  // Tampering detection test: modify stored contract payload
  storedContract.contract.value = "MALICIOUS";
  await assert.rejects(
    () => service.getApprovedContract({ shopId, contractId: approved.contractId }),
    /contractHash mismatch/,
  );
});

test("approval hashes are stable across JSONB object key ordering and still bind values", () => {
  const context = {shopId:"approval.myshopify.com",snapshotId:"snapshot",operation:"bulk_edit",selectionHash:"selection",approvedBy:"merchant"};
  const first = {updates:{title:"Title",status:"ACTIVE"},source:{revision:1,registry:"v1"}};
  const reordered = {source:{registry:"v1",revision:1},updates:{status:"ACTIVE",title:"Title"}};
  assert.equal(computeContractHash({...context,contract:first}),computeContractHash({...context,contract:reordered}));
  reordered.updates.title="Changed";
  assert.notEqual(computeContractHash({...context,contract:first}),computeContractHash({...context,contract:reordered}));
});
