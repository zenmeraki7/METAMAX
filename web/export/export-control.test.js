import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import {Readable} from "node:stream";
import {randomUUID} from "node:crypto";
import {createExportControlRouter} from "./export-control.routes.js";
import {ExportContractError,EXPORT_ERROR_CODES as C} from "./export-contract.js";
async function fixture(callback) {
  const id=randomUUID(),identity={shopId:"controls.myshopify.com",installationId:"install"};
  const auth={},calls=[];let deny=false,authenticated=true,expired=false;
  const job={id,shop_id:identity.shopId,installation_id:identity.installationId,state:"COMPLETED",lease_token:"never-return-this",
    rows_committed:"2",bytes_committed:"4",manifest:{format:"JSONL",fileName:"products.jsonl"}};
  const options={
    authentication:{async authenticate(){return authenticated?auth:null;}},
    source:{async resolveShop(context){assert.equal(context,auth);return {id:identity.shopId,installationId:identity.installationId};},
      async authorizeDownload(){calls.push("authorize");if(deny)throw new ExportContractError(C.UNAUTHORIZED,"Denied");}},
    repository:{async getJob(common){assert.deepEqual(common.identity,identity);return common.jobId===id?job:null;},
      async requestCancellation(){calls.push("cancel");return {...job,state:"CANCELLING"};}},
    storage:{async openRegisteredArtifact({artifact}){calls.push("open");assert.equal(artifact.storage_version,"v1");return Readable.from([Buffer.from("{}\n")]);}},
    database:{async query(sql,params){assert.deepEqual(params,[id,identity.shopId,identity.installationId]);assert.match(sql,/expires_at>clock_timestamp/);
      return {rows:expired?[]:[{format:"JSONL",byte_count:"3",storage_version:"v1"}]};}},
  };
  const app=express();app.use(createExportControlRouter(options));
  const server=app.listen(0,"127.0.0.1");await new Promise(resolve=>server.once("listening",resolve));
  try{await callback({url:`http://127.0.0.1:${server.address().port}`,id,calls,setDeny(){deny=true;},setExpired(){expired=true;},setUnauthenticated(){authenticated=false;}});}
  finally{await new Promise(resolve=>server.close(resolve));}
}
test("export status redacts worker authority and object storage metadata",async()=>fixture(async f=>{
  const response=await fetch(`${f.url}/${f.id}`),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.data.id,f.id);
  assert.equal("lease_token" in body.data,false);assert.equal("manifest" in body.data,false);
  assert.equal(response.headers.get("cache-control"),"private, no-store");
}));
test("private download authorizes current identity before opening exact stored version",async()=>fixture(async f=>{
  const response=await fetch(`${f.url}/${f.id}/download`);assert.equal(response.status,200);assert.equal(await response.text(),"{}\n");
  assert.deepEqual(f.calls,["authorize","open"]);
  f.setDeny();assert.equal((await fetch(`${f.url}/${f.id}/download`)).status,403);
  assert.deepEqual(f.calls,["authorize","open","authorize"]);
}));
test("foreign jobs, unauthenticated requests and expired artifacts never open storage",async()=>fixture(async f=>{
  assert.equal((await fetch(`${f.url}/${randomUUID()}/download`)).status,404);
  f.setExpired();assert.equal((await fetch(`${f.url}/${f.id}/download`)).status,410);
  f.setUnauthenticated();assert.equal((await fetch(`${f.url}/${f.id}`)).status,401);
  assert.ok(!f.calls.includes("open"));
}));
test("cancellation rejects browser tenant overrides and bounded malformed JSON",async()=>fixture(async f=>{
  const post=body=>fetch(`${f.url}/${f.id}/cancel`,{method:"POST",headers:{"Content-Type":"application/json"},body});
  assert.equal((await post('{"shopId":"forged"}')).status,400);
  assert.equal((await post('{')).status,400);
  assert.equal((await post(' '.repeat(4097))).status,413);
  assert.ok(!f.calls.includes("cancel"));
  assert.equal((await post('{}')).status,202);assert.ok(f.calls.includes("cancel"));
}));
