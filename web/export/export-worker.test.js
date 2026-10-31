import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {createExportWorker} from "./export-worker.server.js";
import {EXPORT_ERROR_CODES as C,ExportContractError} from "./export-contract.js";
const eventId=randomUUID(),jobId=randomUUID(),delivery={id:randomUUID(),data:{eventId}};
function fixture() {
  const claim={leaseToken:randomUUID(),fenceEpoch:"1"};
  let job={id:jobId,state:"QUEUED",shop_id:"worker.myshopify.com",installation_id:"install",checkpoint:{},checkpoint_version:"0"};
  const calls=[];
  const repository={
    async getJob(){return {...job};},
    async claimNext(){job={...job,state:"RUNNING",lease_token:claim.leaseToken,fence_epoch:claim.fenceEpoch};return {job:{...job},claim};},
    async commitPart(input){calls.push("commit");job={...job,checkpoint:input.cursor,checkpoint_version:"1"};return {...job};},
    async heartbeat(){calls.push("heartbeat");},async renewGenerationProtection(){},
    async transitionWorker(input){calls.push(input.toState);job={...job,state:input.toState};return {...job};},
    async finalizeArtifact(){calls.push("finalize");job={...job,state:"COMPLETED"};return {job:{...job}};},
    async acknowledgeCancellation(){calls.push("ack-cancel");job={...job,state:"CANCELLED"};},
    async resolveRecoveredJob(){},async getCommittedParts(){return [];},
  };
  const storage={async writePart(){calls.push("write");return {storageKey:"key",storageVersion:"v1",checksum:"hash",rowCount:1,byteCount:1};},
    async assemble(){calls.push("assemble");return {};},async verifyRecoveryEvidence(){}};
  const source={async readPage(){calls.push("read");return {rows:[["value"]],checkpoint:{afterProductId:"1",done:true}};}};
  const evidence={async observeDelivery(){calls.push("observe");return {job_id:jobId,shop_id:job.shop_id,installation_id:job.installation_id};}};
  const options={repository,storage,source,evidence,workerId:"test-worker",heartbeatMs:100,leaseMs:5000,logger:{error(){}}};
  return {options,calls,setJob(value){job={...job,...value};},get job(){return job;}};
}
test("export queue token cannot supply shop, cursor or execution authority",async()=>{
  const f=fixture(),worker=createExportWorker(f.options);
  await assert.rejects(()=>worker.process({...delivery,data:{eventId,shopId:"forged"}}),TypeError);
  assert.deepEqual(f.calls,[]);
});
test("clean redundant delivery returns before source or storage calls",async()=>{
  const f=fixture();f.setJob({state:"COMPLETED"});
  assert.deepEqual(await createExportWorker(f.options).process(delivery),{skipped:true});assert.deepEqual(f.calls,["observe"]);
});
test("worker checkpoints before assembly and finalizes once",async()=>{
  const f=fixture();assert.equal((await createExportWorker(f.options).process(delivery)).state,"COMPLETED");
  assert.deepEqual(f.calls,["observe","read","write","commit","FINALIZING","assemble","finalize"]);
});
test("uncertain storage failure persists a retry instead of using a local cursor",async()=>{
  const f=fixture();f.options.storage.writePart=async()=>{throw Error("upload response lost");};
  await assert.rejects(()=>createExportWorker(f.options).process(delivery),/upload response lost/);
  assert.equal(f.job.state,"RETRY_WAIT");assert.ok(!f.calls.includes("commit"));assert.ok(!f.calls.includes("assemble"));
});
test("heartbeat loss aborts work and never acknowledges a newer fence",{timeout:3000},async()=>{
  const f=fixture();
  f.options.source.readPage=async({signal})=>{await once(signal,"abort");throw signal.reason;};
  f.options.repository.heartbeat=async()=>{f.setJob({state:"RECOVERING",lease_token:randomUUID(),fence_epoch:"2"});throw new ExportContractError(C.LEASE_LOST,"superseded");};
  await assert.rejects(()=>createExportWorker(f.options).process(delivery),{code:C.LEASE_LOST});
  assert.equal(f.job.state,"RECOVERING");assert.ok(!f.calls.includes("commit"));assert.ok(!f.calls.includes("RETRY_WAIT"));
});
test("cancellation aborts in-flight storage before fenced acknowledgement",{timeout:3000},async()=>{
  const f=fixture();
  f.options.storage.writePart=async({signal})=>{f.setJob({state:"CANCELLING"});await once(signal,"abort");throw signal.reason;};
  assert.equal((await createExportWorker(f.options).process(delivery)).state,"CANCELLED");
  assert.equal(f.calls.at(-1),"ack-cancel");assert.ok(!f.calls.includes("finalize"));
});
test("worker startup rejects missing verification and recovery dependencies",()=>{
  const f=fixture();for(const key of ["repository","source","storage","evidence"])assert.throws(()=>createExportWorker({...f.options,[key]:null}),TypeError);
});
