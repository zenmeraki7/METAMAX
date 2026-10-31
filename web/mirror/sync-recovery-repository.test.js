import test from "node:test";
import assert from "node:assert/strict";
import { createSyncRecoveryRepository } from "./sync-recovery-repository.server.js";

const inputHash="a".repeat(64);
const claim={runId:"run-1",shopId:"recover.myshopify.com",generationId:"generation-1",phase:"STARTING",fence:"2",
  leaseToken:"recovery-token",recoveryAttempt:1,intent:{id:"run-1",kind:"LOCAL_PHASE",operationId:null,inputHash:null,state:null,
    installationVersion:"install-1",recoveryFence:"2",dispatchFence:null}};
function fixture(overrides={}) {
  let connects=0,eligibilityReads=0;
  const settings={database:{connect(){connects++;throw new Error("Unexpected database access");}},
    syncRunRepository:{async getRecoveryEligibility(){eligibilityReads++;return {eligible:false};}},
    verifyRecoveryEvidence:()=>true,inputHash,...overrides};
  return {repository:createSyncRecoveryRepository(settings),settings,connects:()=>connects,eligibilityReads:()=>eligibilityReads};
}

test("recovery persistence requires a real driver, eligibility service and trusted evidence validator",()=>{
  assert.throws(()=>createSyncRecoveryRepository(),/PostgreSQL/);
  for(const overrides of [{syncRunRepository:{}},{verifyRecoveryEvidence:null},{inputHash:"browser-hash"},
    {leaseSeconds:0},{leaseSeconds:301},{leaseSeconds:1.5}])assert.throws(()=>fixture(overrides));
  assert.ok(Object.isFrozen(fixture().repository));
});

test("ineligible recovery and malformed scheduling hints cannot acquire a connection",async()=>{
  const f=fixture();assert.equal(await f.repository.claimRecovery({runId:"run-1"}),null);assert.equal(f.connects(),0);
  for(const hint of [null,{eligible:"yes"},{eligible:true,runId:"other",shopId:claim.shopId},
    {eligible:true,runId:"run-1",shopId:"invalid"},{get eligible(){assert.fail("Hint getter invoked");}}]) {
    const bad=fixture({syncRunRepository:{getRecoveryEligibility:async()=>hint}});
    await assert.rejects(()=>bad.repository.claimRecovery({runId:"run-1"}),{code:"INVALID_RECOVERY_INPUT"});
    assert.equal(bad.connects(),0);
  }
});

test("malformed scope, fences, counters and intent are rejected before any SQL",async()=>{
  const f=fixture();
  for(const changed of [{shopId:"invalid"},{generationId:"bad id"},{phase:"INVALID"},{fence:"0"},{fence:2},
    {fence:"9223372036854775808"},{leaseToken:null},{recoveryAttempt:0},{recoveryAttempt:9},{recoveryAttempt:"1"},
    {intent:{...claim.intent,recoveryFence:"3"}},{intent:{...claim.intent,dispatchFence:1}}]) {
    await assert.rejects(()=>f.repository.finishRecovery({claim:{...claim,...changed},verification:{kind:"UNRESOLVED"}}),{code:"INVALID_RECOVERY_INPUT"});
    await assert.rejects(()=>f.repository.recordRecoveryFailure({claim:{...claim,...changed},reason:"VERIFICATION_FAILED"}),{code:"INVALID_RECOVERY_INPUT"});
  }
  assert.equal(f.connects(),0);
});

test("accessor-backed claims and evidence cannot execute application code",async()=>{
  const f=fixture();
  await assert.rejects(()=>f.repository.finishRecovery({claim:{...claim,get fence(){assert.fail("Claim getter invoked");}},verification:{kind:"UNRESOLVED"}}),{code:"INVALID_RECOVERY_INPUT"});
  await assert.rejects(()=>f.repository.finishRecovery({claim,verification:{kind:"SAFE_TO_RETRY",evidence:{get ticket(){assert.fail("Evidence getter invoked");}}}}),{code:"INVALID_RECOVERY_INPUT"});
  for(const reason of ["arbitrary message",null,"X".repeat(65)])await assert.rejects(()=>f.repository.recordRecoveryFailure({claim,reason}),{code:"INVALID_RECOVERY_INPUT"});
  assert.equal(f.connects(),0);
});
