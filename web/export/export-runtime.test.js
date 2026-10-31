import test from "node:test";
import assert from "node:assert/strict";
import {exportProductionConfig,createExportRuntime} from "./export-runtime.server.js";
test("disabled exports do not invent storage or credential defaults",()=>{
  assert.equal(exportProductionConfig({}),null);assert.equal(exportProductionConfig({EXPORTS_ENABLED:"false"}),null);
  assert.throws(()=>exportProductionConfig({EXPORTS_ENABLED:"yes"}),TypeError);
});
test("enabled exports fail before startup when a production dependency is absent",async()=>{
  assert.throws(()=>exportProductionConfig({EXPORTS_ENABLED:"true"}),/require/);
  await assert.rejects(()=>createExportRuntime({config:{}}),TypeError);
});
test("production endpoints require TLS and configuration stays server-owned",()=>{
  const config={EXPORTS_ENABLED:"true",EXPORT_S3_BUCKET:"private",EXPORT_S3_REGION:"region",REDIS_URL:"rediss://redis.internal:6380/1",NODE_ENV:"production"};
  assert.throws(()=>exportProductionConfig({...config,EXPORT_S3_ENDPOINT:"http://s3.internal"}),/HTTPS/);
  assert.throws(()=>exportProductionConfig({...config,EXPORT_S3_ENDPOINT:"https://user:secret@s3.internal"}),/HTTPS/);
  assert.equal(exportProductionConfig({...config,EXPORT_S3_ENDPOINT:"https://s3.internal"}).connection.db,1);
});
