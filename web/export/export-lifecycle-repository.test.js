import test from "node:test";
import assert from "node:assert/strict";
import { createExportRepository } from "./export-repository.server.js";
import { EXPORT_ERROR_CODES as C } from "./export-contract.js";
import { createExportGenerationProtection } from "./export-generation-protection.server.js";

const adapters = {
  generationProtection:{verify(){},renew(){},release(){}},
  verifyStoredPart(){},verifyFinalArtifact(){},verifyDeliveryEvidence(){},reconcileDelivery(){},verifyRecoveryEvidence(){},
};
const pool = {async query(){return {rows:[]};}, async connect(){throw Object.assign(Error("private database details"),{code:"ECONNRESET"});}};

test("lifecycle repository requires every security-critical adapter",()=>{
  for(const key of Object.keys(adapters)) {
    assert.throws(()=>createExportRepository({pool,...adapters,[key]:undefined}),TypeError,key);
  }
  assert.throws(()=>createExportGenerationProtection({publicationService:{}}),TypeError);
});

test("export database failures expose a stable retryable code without connection details",async()=>{
  const repo=createExportRepository({pool,...adapters});
  await assert.rejects(()=>repo.recoverExpiredJobs({recoveryOwner:"recovery"}),error=>{
    assert.equal(error.code,C.EXECUTION_FAILED);assert.equal(error.retryable,true);
    assert.doesNotMatch(error.message,/private database/);return true;
  });
});

test("coordinator batch sizes and unsafe numeric fences fail before any work",async()=>{
  const repo=createExportRepository({pool,...adapters});
  for(const batchSize of [0,-1,1001,1.5,"10"]) {
    await assert.rejects(()=>repo.releaseRetryWaitJobs({batchSize}),{code:C.INVALID_REQUEST});
  }
  for(const fenceEpoch of ["", " 1", "+1", "01", Number.MAX_SAFE_INTEGER+1]) {
    await assert.rejects(()=>repo.heartbeat({identity:{shopId:"test.myshopify.com",installationId:"install"},
      jobId:"00000000-0000-4000-8000-000000000001",claim:{leaseToken:"00000000-0000-4000-8000-000000000002",fenceEpoch}}),{code:C.INVALID_REQUEST});
  }
});
