import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {createExportStorage,exportPartSetHash} from "./export-storage.server.js";
import {EXPORT_ERROR_CODES as C} from "./export-contract.js";

// Test transport only. Production verification/serialization is not mocked:
// every receipt below comes from the real adapter reading stored byte streams.
import {versionedS3TestTransport} from "./test-support/versioned-s3.js";

function fixture(format,includeHeader=true) {
  const identity={shopId:"storage.myshopify.com",installationId:"install"},jobId=randomUUID();
  const job={id:jobId,shop_id:identity.shopId,installation_id:identity.installationId,fence_epoch:"1",state:"RUNNING",
    manifest:{format,includeHeader,fields:[{id:"product.title"},{id:"product.vendor"}]}};
  const client=versionedS3TestTransport(),parts=[];
  const storage=createExportStorage({client,bucket:"private-exports",loadJob:async()=>job,loadParts:async()=>parts});
  const common={identity,jobId,claim:{fenceEpoch:"1",leaseToken:randomUUID()}};
  return {storage,client,job,parts,common};
}
for(const format of ["CSV","JSONL","XLSX"])test(`real ${format} serialization verifies immutable bytes and ordered part content`,async()=>{
  const f=fixture(format);await f.storage.verifyConfiguration();
  for(const [index,rows] of [[["A, \"quoted\"\nline","=formula"],[null,"Unicode \u03bb"]],[["trailing","last"]]].entries()) {
    const stored=await f.storage.writePart({...f.common,partNumber:index,rows});
    const receipt=await f.storage.verifyStoredPart({...f.common,partNumber:index,...stored});
    assert.equal(receipt.rowCount,rows.length);assert.equal(receipt.immutable,true);
    f.parts.push({part_number:index,storage_key:stored.storageKey,storage_version:stored.storageVersion,
      checksum:stored.checksum,row_count:stored.rowCount,byte_count:stored.byteCount});
  }
  const artifact=await f.storage.assemble(f.common);
  const result=await f.storage.verifyFinalArtifact({...f.common,artifact,parts:f.parts,partSetHash:exportPartSetHash(f.parts)});
  assert.equal(result.rowCount,3);assert.equal(result.rowCountVerified,true);assert.equal(result.byteCount,artifact.byteCount);
  assert.equal(result.sourceByteCount,f.parts.reduce((n,p)=>n+p.byte_count,0).toString());
  // Keep count, length and syntax valid: only actual comparison to immutable
  // source rows can detect this malicious final-object content substitution.
  if(format!=="XLSX") {
    const key=`${artifact.storageKey}:${artifact.storageVersion}`;
    const tampered=Buffer.from(f.client.objects.get(key).toString().replace("trailing","changed!"));
    f.client.objects.set(key,tampered);
    const altered={...artifact,checksum:`sha256:${createHash("sha256").update(tampered).digest("hex")}`,byteCount:tampered.length};
    await assert.rejects(()=>f.storage.verifyFinalArtifact({...f.common,artifact:altered,parts:f.parts,partSetHash:exportPartSetHash(f.parts)}),{code:C.ARTIFACT_INTEGRITY_FAILED});
  }
});
for(const format of ["CSV","JSONL","XLSX"])test(`${format} empty output is independently verifiable`,async()=>{
  const f=fixture(format,false),artifact=await f.storage.assemble(f.common);
  const receipt=await f.storage.verifyFinalArtifact({...f.common,artifact,parts:[],partSetHash:exportPartSetHash([])});
  assert.equal(receipt.rowCount,0);
});
test("S3 versioning, private access, exact versions and tenant namespaces fail closed",async()=>{
  const f=fixture("JSONL");
  const invalid=createExportStorage({client:{send:async()=>({Status:"Suspended"})},bucket:"private",loadJob:async()=>f.job,loadParts:async()=>[]});
  await assert.rejects(()=>invalid.verifyConfiguration(),/versioning/);
  const spec=await f.storage.writePart({...f.common,partNumber:0,rows:[["a","b"]]});
  await assert.rejects(()=>f.storage.verifyStoredPart({...f.common,...spec,storageVersion:"null"}),{code:C.ARTIFACT_INTEGRITY_FAILED});
  await assert.rejects(()=>f.storage.verifyStoredPart({...f.common,...spec,identity:{...f.common.identity,shopId:"other.myshopify.com"}}),{code:C.ARTIFACT_INTEGRITY_FAILED});
});
