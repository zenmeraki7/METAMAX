/** Real PostgreSQL only. Run via scripts/test-filter-postgres.js --exports. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { createExportRepository } from "../export-repository.server.js";
import { createExportGenerationProtection } from "../export-generation-protection.server.js";
import { canonicalizeJson, EXPORT_ERROR_CODES as C } from "../export-contract.js";
import { createPublicationRepository } from "../../mirror/publication-repository.server.js";
import { createMirrorPublicationService } from "../../mirror/publication-service.server.js";
import {testProductionExportAdapters} from "./production-adapters.js";

const hash = value => `sha256:${createHash("sha256").update(JSON.stringify(canonicalizeJson(value))).digest("hex")}`;
const checksum = hash("object");

test("export lifecycle recovery against isolated PostgreSQL", {skip:process.env.FILTER_TEST_DATABASE_ISOLATED!=="1"}, async t => {
  const pool=new pg.Pool({connectionString:process.env.FILTER_TEST_DATABASE_URL,max:8});
  const query=(sql,args)=>pool.query(sql,args);
  try {
    const root=new URL("../../prisma/migrations/",import.meta.url);
    for(const directory of (await readdir(root)).filter(n=>/^\d+_/.test(n)).sort()) {
      await query(await readFile(new URL(`${directory}/migration.sql`,root),"utf8"));
    }
    const publicationService=createMirrorPublicationService({repository:createPublicationRepository({database:pool}),barrierTable:{schema:"mirror",table:"publications"}});
    const generationProtection=createExportGenerationProtection({publicationService});
    let sequence=0;
    async function fixture({format="CSV",...overrides}={}) {
      const identity={shopId:`export-${++sequence}.myshopify.com`,installationId:randomUUID()};
      await query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2)",[identity.shopId,identity.installationId]);
      await query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mapping_version,mirror_schema_version,source_contract_version)
        VALUES($1,'gen','cov','mapping','metamax_mirror_v1','metamax_sources_v1')`,[identity.shopId]);
      for (const dataset of ["products","variants"]) {
        await query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at)
          VALUES($1,'gen',$2,'SUCCEEDED',0,0,true,clock_timestamp())`,[identity.shopId,dataset]);
        await query(`INSERT INTO mirror.coverage(shop_id,generation_id,name,status,durable_rows,verified_at,verification_hash)
          VALUES($1,'gen',$2,'COMPLETE',0,clock_timestamp(),'verified-empty-fixture')`,[identity.shopId,dataset]);
      }
      for(const [state,column] of [["RECONCILING",""],["VERIFIED",",verified_at=clock_timestamp()"],["PUBLISHED",",published_at=clock_timestamp()"]]) {
        await query(`UPDATE mirror.generations SET status=$2${column} WHERE shop_id=$1`,[identity.shopId,state]);
      }
      await query("INSERT INTO mirror.publications(shop_id,generation_id,coverage_revision,mapping_version) VALUES($1,'gen','cov','mapping')",[identity.shopId]);
      const objects=new Map();
      const options={pool,generationProtection,retryBaseMs:1,retryMaxMs:2,
        verifyStoredPart:async spec=>objects.get(spec.storageKey),
        verifyFinalArtifact:async ({artifact,partSetHash})=>({...artifact,verified:true,immutable:true,rowCountVerified:true,
          sourceByteCount:20,accountingVersion:{CSV:"csv-assembled-v1",JSONL:"jsonl-assembled-v1",XLSX:"xlsx-packaged-v1"}[format],partSetHash}),
        verifyDeliveryEvidence:async ({event,evidence})=>({...evidence,deliveryKey:event.delivery_key}),
        reconcileDelivery:async()=>({decision:"RETRY_ELIGIBLE",safeToRetry:true}),
        verifyRecoveryEvidence:async ({partSetHash,checkpointVersion,checkpointHash})=>({verified:true,safeToResume:true,artifactStatus:"ABSENT",partSetHash,checkpointVersion,checkpointHash}),
        logger:{error(){}},...overrides};
      const repo=createExportRepository(options);
      const manifest={...identity,format,generationId:"gen",coverageRevision:"cov",mappingVersion:"mapping",compilerVersion:"compiler-v1",
        filterFingerprint:hash("filter"),fieldProjectionFingerprint:hash("projection")};
      const input={identity,idempotencyKey:"export:test-key",requestFingerprint:hash({format}),manifestFingerprint:hash(manifest),manifest};
      const {job}=await repo.createJob(input);
      const common={identity,jobId:job.id};
      const get=()=>repo.getJob(common);
      async function queue() {
        await repo.transition({...common,fromState:"PENDING",toState:"VALIDATING"});
        await repo.transition({...common,fromState:"VALIDATING",toState:"QUEUED"});
      }
      async function claim() {await queue(); return repo.claimNext({workerId:"worker"});}
      async function commit(claim, extra={}) {
        const spec={...common,claim,expectedVersion:0,partNumber:0,storageKey:randomUUID(),storageVersion:"version-1",
          checksum,rowCount:2,byteCount:20,cursor:{after:"2"},...extra};
        objects.set(spec.storageKey,{...spec,verified:true,immutable:true,rowCountVerified:true});
        return {spec,job:await repo.commitPart(spec)};
      }
      return {repo,identity,job,common,get,queue,claim,commit,input,objects,options};
    }
    const expire=job=>query("UPDATE export_engine.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);

    await t.test("admission and exact Mirror lease commit atomically; replay keeps original pins",async()=>{
      const f=await fixture();
      assert.equal((await query("SELECT owner FROM mirror.generation_read_leases WHERE id=$1",[f.job.generation_lease_id])).rows[0].owner,f.job.id);
      const otherManifest={...f.input.manifest,generationId:"different-generation"};
      const replay=await f.repo.createJob({...f.input,manifest:otherManifest,manifestFingerprint:hash(otherManifest)});
      assert.equal(replay.created,false);assert.equal(replay.job.generation_id,"gen");
      await assert.rejects(()=>f.repo.createJob({...f.input,requestFingerprint:hash("different")}),{code:C.IDEMPOTENCY_CONFLICT});
      assert.equal(await f.repo.getJob({...f.common,identity:{...f.identity,shopId:"other.myshopify.com"}}),null);
    });

    await t.test("expired worker gets a new fence, resumes durable checkpoint, stale worker cannot write",async()=>{
      const f=await fixture(); const first=await f.claim(); await f.commit(first.claim); await expire(first.job);
      const [recovered]=await f.repo.recoverExpiredJobs({recoveryOwner:"recovery"});
      assert.ok(BigInt(recovered.recoveryClaim.fenceEpoch)>BigInt(first.claim.fenceEpoch));
      assert.notEqual(recovered.recoveryClaim.leaseToken,first.claim.leaseToken);
      await assert.rejects(()=>f.repo.heartbeat({...f.common,claim:first.claim}),{code:C.LEASE_LOST});
      await f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovered.recoveryClaim,decision:"RESUME"});
      await query("UPDATE export_engine.jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.id]);
      await f.repo.releaseRetryWaitJobs();
      const second=await f.repo.claimNext({workerId:"resumed"});
      assert.equal(second.job.checkpoint_version,"1");assert.deepEqual(second.job.checkpoint,{after:"2"});
      assert.equal(second.job.rows_committed,"2");
      await f.repo.requestCancellation(f.common);await f.repo.acknowledgeCancellation({...f.common,claim:second.claim});
    });

    await t.test("concurrent recovery coordinators cannot own the same expired execution",async()=>{
      const f=await fixture(); const first=await f.claim();await expire(first.job);
      const outcomes=await Promise.all(["a","b"].map(recoveryOwner=>f.repo.recoverExpiredJobs({recoveryOwner})));
      assert.equal(outcomes.flat().filter(r=>r.job.id===f.job.id).length,1);
      const recovered=outcomes.flat().find(r=>r.job.id===f.job.id);
      await f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovered.recoveryClaim,decision:"FAIL"});
    });

    await t.test("uncertain external artifact cannot authorize resume",async()=>{
      const f=await fixture({verifyRecoveryEvidence:async()=>({verified:true,safeToResume:false,artifactStatus:"UNKNOWN"})});
      const first=await f.claim();await expire(first.job);
      const recovered=(await f.repo.recoverExpiredJobs({recoveryOwner:"recovery"})).find(r=>r.job.id===f.job.id);
      await assert.rejects(()=>f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovered.recoveryClaim,decision:"RESUME"}),{code:C.ARTIFACT_INTEGRITY_FAILED});
      assert.equal((await f.get()).state,"RECOVERING");
      await f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovered.recoveryClaim,decision:"REVIEW"});
    });

    await t.test("crashed recovery coordinator is fenced on reclaim",async()=>{
      const f=await fixture();const first=await f.claim();await expire(first.job);
      const [a]=await f.repo.recoverExpiredJobs({recoveryOwner:"a"});await expire(a.job);
      const [b]=await f.repo.recoverExpiredJobs({recoveryOwner:"b"});
      await assert.rejects(()=>f.repo.resolveRecoveredJob({...f.common,recoveryClaim:a.recoveryClaim,decision:"FAIL"}),{code:C.LEASE_LOST});
      await f.repo.resolveRecoveredJob({...f.common,recoveryClaim:b.recoveryClaim,decision:"FAIL"});
    });

    await t.test("live cancellation acknowledgement is fenced; queued and crashed cancellation also finish",async()=>{
      const f=await fixture();const running=await f.claim();await f.repo.requestCancellation(f.common);
      await assert.rejects(()=>f.repo.acknowledgeCancellation({...f.common,claim:{...running.claim,fenceEpoch:"0"}}),{code:C.LEASE_LOST});
      assert.equal(await f.repo.finalizeCancellation(f.common),null);
      assert.equal((await f.repo.acknowledgeCancellation({...f.common,claim:running.claim})).state,"CANCELLED");
      const queued=await fixture();await queued.queue();await queued.repo.requestCancellation(queued.common);
      assert.equal((await queued.repo.finalizeCancellation(queued.common)).state,"CANCELLED");
      const crashed=await fixture();const old=await crashed.claim();await crashed.repo.requestCancellation(crashed.common);await expire(old.job);
      assert.equal((await crashed.repo.finalizeCancellation(crashed.common)).state,"CANCELLED");
      await assert.rejects(()=>crashed.repo.acknowledgeCancellation({...crashed.common,claim:old.claim}),{code:C.LEASE_LOST});
    });

    await t.test("part commits reject unverified row counts and changed immutable versions",async()=>{
      const f=await fixture();const running=await f.claim();
      for(const receipt of [{rowCountVerified:false},{storageVersion:"replaced"},{rowCount:3},{immutable:false}]) {
        const spec={...f.common,claim:running.claim,expectedVersion:0,partNumber:0,storageKey:randomUUID(),storageVersion:"v1",checksum,rowCount:2,byteCount:20,cursor:{after:"2"}};
        f.objects.set(spec.storageKey,{...spec,verified:true,immutable:true,rowCountVerified:true,...receipt});
        await assert.rejects(()=>f.repo.commitPart(spec),{code:C.ARTIFACT_INTEGRITY_FAILED});
      }
      assert.equal((await f.get()).checkpoint_version,"0");
      await f.repo.requestCancellation(f.common);await f.repo.acknowledgeCancellation({...f.common,claim:running.claim});
    });

    for(const format of ["CSV","JSONL","XLSX"]) await t.test(`${format} final bytes differ from intermediate bytes under a verified accounting contract`,async()=>{
      const f=await fixture({format});const running=await f.claim();await f.commit(running.claim);
      await f.repo.transitionWorker({...f.common,claim:running.claim,fromState:"RUNNING",toState:"FINALIZING"});
      const artifact={storageKey:randomUUID(),storageVersion:"final-v1",checksum,format,rowCount:2,byteCount:15,partCount:1,expiresAt:new Date(Date.now()+60000).toISOString()};
      const finalized=await f.repo.finalizeArtifact({...f.common,claim:running.claim,expectedCheckpointVersion:1,artifact});
      assert.equal(finalized.job.state,"COMPLETED");
      const row=(await query("SELECT * FROM export_engine.artifacts WHERE job_id=$1",[f.job.id])).rows[0];
      assert.equal(row.byte_count,"15");assert.equal(row.source_byte_count,"20");
      await f.repo.releaseTerminalGenerationProtections();
      assert.equal((await query("SELECT 1 FROM mirror.generation_read_leases WHERE id=$1",[f.job.generation_lease_id])).rowCount,0);
      assert.equal(await f.repo.releaseGenerationProtection({...f.common,reason:"repeat"}),false);
    });

    await t.test("wrong accounting receipt rolls back final artifact registration",async()=>{
      const f=await fixture({verifyFinalArtifact:async ({artifact,partSetHash})=>({...artifact,verified:true,immutable:true,rowCountVerified:true,partSetHash,accountingVersion:"wrong",sourceByteCount:20})});
      const running=await f.claim();await f.commit(running.claim);
      await f.repo.transitionWorker({...f.common,claim:running.claim,fromState:"RUNNING",toState:"FINALIZING"});
      await assert.rejects(()=>f.repo.finalizeArtifact({...f.common,claim:running.claim,expectedCheckpointVersion:1,artifact:{storageKey:randomUUID(),storageVersion:"v1",checksum,format:"CSV",rowCount:2,byteCount:15,partCount:1,expiresAt:new Date(Date.now()+60000).toISOString()}}),{code:C.ARTIFACT_INTEGRITY_FAILED});
      assert.equal((await query("SELECT 1 FROM export_engine.artifacts WHERE job_id=$1",[f.job.id])).rowCount,0);
      await f.repo.requestCancellation(f.common);await f.repo.acknowledgeCancellation({...f.common,claim:running.claim});
    });

    await t.test("outbox claim joins authoritative job cancellation and active installation",async()=>{
      const f=await fixture();await f.queue();await f.repo.requestCancellation(f.common);
      assert.equal((await f.repo.claimOutbox({dispatcherId:"dispatch"})).filter(e=>e.event.job_id===f.job.id).length,0);
      await f.repo.finalizeCancellation(f.common);
      const inactive=await fixture();await inactive.queue();
      await query("UPDATE mirror.shops SET uninstalled_at=clock_timestamp() WHERE id=$1",[inactive.identity.shopId]);
      assert.equal((await inactive.repo.claimOutbox({dispatcherId:"dispatch"})).filter(e=>e.event.job_id===inactive.job.id).length,0);
      await inactive.repo.requestCancellation(inactive.common);await inactive.repo.finalizeCancellation(inactive.common);
    });

    await t.test("crashed reconciliation becomes UNKNOWN with revoked fence, not safe-to-redeliver",async()=>{
      const f=await fixture();await f.queue();const [delivery]=await f.repo.claimOutbox({dispatcherId:"dispatch"});
      await f.repo.markOutboxUnknown({eventId:delivery.event.id,claim:delivery.claim});
      // Simulate an owner dying after the durable reconciliation claim.
      await query(`UPDATE export_engine.outbox SET state='RECONCILING',claim_owner='dead',claim_token=$2,
        claim_expires_at=clock_timestamp()-interval '1 second',reconciliation_attempts=1 WHERE id=$1`,[delivery.event.id,randomUUID()]);
      await f.repo.recoverStalledReconciliations();
      const event=(await query("SELECT * FROM export_engine.outbox WHERE id=$1",[delivery.event.id])).rows[0];
      assert.equal(event.state,"UNKNOWN");assert.ok(BigInt(event.fence_epoch)>BigInt(delivery.claim.fenceEpoch));
      assert.equal((await f.repo.claimOutbox({dispatcherId:"retry"})).length,0);
      await f.repo.requestCancellation(f.common);await f.repo.finalizeCancellation(f.common);
    });

    await t.test("transient reconciliation errors retry with backoff and eventually require review",async()=>{
      const f=await fixture({maxReconciliationAttempts:2,reconcileDelivery:async()=>{throw Error("temporary queue failure");}});
      await f.queue();const [delivery]=await f.repo.claimOutbox({dispatcherId:"dispatch"});
      await f.repo.markOutboxUnknown({eventId:delivery.event.id,claim:delivery.claim});
      for(const state of ["UNKNOWN","REVIEW_REQUIRED"]) {
        await query("UPDATE export_engine.outbox SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[delivery.event.id]);
        assert.equal((await f.repo.reconcileUnknownOutbox({eventId:delivery.event.id,reconcilerId:"reconcile"})).state,state);
      }
      await f.repo.requestCancellation(f.common);await f.repo.finalizeCancellation(f.common);
    });

    await t.test("generation renewal preserves exact lease; expired protection cannot be silently replaced",async()=>{
      const f=await fixture();const running=await f.claim();
      const renewed=await f.repo.renewGenerationProtection({...f.common,claim:running.claim});
      assert.equal(renewed.leaseId,f.job.generation_lease_id);
      await query("UPDATE mirror.generation_read_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.generation_lease_id]);
      await assert.rejects(()=>f.repo.renewGenerationProtection({...f.common,claim:running.claim}),{code:C.SNAPSHOT_EXPIRED});
      await expire(running.job);const [recovery]=await f.repo.recoverExpiredJobs({recoveryOwner:"recovery"});
      await f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovery.recoveryClaim,decision:"RESUME"});
      assert.equal((await f.get()).generation_lease_id,f.job.generation_lease_id);
      await f.repo.requestCancellation(f.common);await f.repo.finalizeCancellation(f.common);
    });

    await t.test("PostgreSQL time controls ownership despite a skewed application clock",async()=>{
      const f=await fixture();const running=await f.claim();const now=Date.now;
      try {Date.now=()=>0;await expire(running.job);await assert.rejects(()=>f.commit(running.claim),{code:C.LEASE_LOST});}
      finally{Date.now=now;}
      await f.repo.requestCancellation(f.common);await f.repo.finalizeCancellation(f.common);
    });

    for (const fromState of ["RUNNING","FINALIZING"]) await t.test(`${fromState} retry persists RETRY_WAIT and passes recovery before redispatch`,async()=>{
      const f=await fixture();const running=await f.claim();
      if (fromState==="FINALIZING") await f.repo.transitionWorker({...f.common,claim:running.claim,fromState:"RUNNING",toState:"FINALIZING"});
      const yielded=await f.repo.transitionWorker({...f.common,claim:running.claim,fromState,toState:"RETRY_WAIT"});
      assert.equal(yielded.state,"RETRY_WAIT");assert.equal(yielded.retry_verified,false);
      assert.equal(yielded.lease_token,null);
      await assert.rejects(()=>f.repo.heartbeat({...f.common,claim:running.claim}),{code:C.LEASE_LOST});
      assert.equal((await f.repo.releaseRetryWaitJobs()).length,0);
      await assert.rejects(()=>query("UPDATE export_engine.jobs SET state='QUEUED' WHERE id=$1",[f.job.id]),{code:"23514"});
      await query("UPDATE export_engine.jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.id]);
      const [recovery]=await f.repo.recoverExpiredJobs({recoveryOwner:"recovery"});
      await f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovery.recoveryClaim,decision:"RESUME"});
      await query("UPDATE export_engine.jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.id]);
      const released=await Promise.all([f.repo.releaseRetryWaitJobs(),f.repo.releaseRetryWaitJobs()]);
      assert.equal(released.flat().filter(j=>j.id===f.job.id).length,1);
      assert.equal((await query("SELECT count(*) FROM export_engine.outbox WHERE job_id=$1",[f.job.id])).rows[0].count,"2");
      const resumed=await f.repo.claimNext({workerId:"resumed-finalizer"});
      assert.equal(resumed.job.state,fromState);
      await f.repo.requestCancellation(f.common);await f.repo.acknowledgeCancellation({...f.common,claim:resumed.claim});
    });

    await t.test("recovery scanner finishes crashed cancellation; terminal cleanup survives restart",async()=>{
      const f=await fixture();const running=await f.claim();await f.repo.requestCancellation(f.common);await expire(running.job);
      await f.repo.recoverExpiredJobs({recoveryOwner:"recovery"});
      assert.equal((await f.get()).state,"CANCELLED");
      const restarted=createExportRepository(f.options);
      await restarted.releaseTerminalGenerationProtections();
      assert.equal((await query("SELECT 1 FROM mirror.generation_read_leases WHERE id=$1",[f.job.generation_lease_id])).rowCount,0);
    });

    await t.test("exhausted worker attempts fail instead of replaying",async()=>{
      const f=await fixture({maxExecutionAttempts:1});const running=await f.claim();await expire(running.job);
      const [recovery]=await f.repo.recoverExpiredJobs({recoveryOwner:"recovery"});
      assert.equal((await f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovery.recoveryClaim,decision:"RESUME"})).state,"FAILED");
    });

    await t.test("pending renewal fails closed after generation lease expiry",async()=>{
      const f=await fixture();await f.queue();
      await query("UPDATE mirror.generation_read_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.generation_lease_id]);
      await query("UPDATE export_engine.jobs SET generation_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.job.id]);
      await f.repo.renewPendingGenerationProtection();assert.equal((await f.get()).state,"FAILED");
    });

    await t.test("job insertion failure rolls back the actual Mirror lease acquisition",async()=>{
      const f=await fixture();
      const count=async()=>(await query("SELECT count(*) FROM mirror.generation_read_leases WHERE shop_id=$1",[f.identity.shopId])).rows[0].count;
      const before=await count();
      const failingPool={query:pool.query.bind(pool),async connect(){
        const client=await pool.connect();
        return {release:()=>client.release(),async query(sql,params){
          if(sql.includes("INSERT INTO export_engine.jobs")) throw Error("simulated insert failure");
          return client.query(sql,params);
        }};
      }};
      const repo=createExportRepository({...f.options,pool:failingPool});
      await assert.rejects(()=>repo.createJob({...f.input,idempotencyKey:"export:failed-insert"}),{code:C.EXECUTION_FAILED});
      assert.equal(await count(),before);
      assert.equal((await query("SELECT 1 FROM export_engine.jobs WHERE shop_id=$1 AND idempotency_key='export:failed-insert'",[f.identity.shopId])).rowCount,0);
    });

    await t.test("recovery independently rechecks committed object versions",async()=>{
      const f=await fixture();const running=await f.claim();const {spec}=await f.commit(running.claim);
      f.objects.set(spec.storageKey,{...f.objects.get(spec.storageKey),storageVersion:"unexpected-replacement"});
      await expire(running.job);const [recovery]=await f.repo.recoverExpiredJobs({recoveryOwner:"recovery"});
      await assert.rejects(()=>f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovery.recoveryClaim,decision:"RESUME"}),{code:C.ARTIFACT_INTEGRITY_FAILED});
      await f.repo.resolveRecoveredJob({...f.common,recoveryClaim:recovery.recoveryClaim,decision:"REVIEW"});
    });

    await t.test("released terminal execution pins do not create a permanent generation FK hold",async()=>{
      const f=await fixture();await f.repo.requestCancellation(f.common);await f.repo.finalizeCancellation(f.common);
      await f.repo.releaseGenerationProtection({...f.common,reason:"terminal"});
      assert.equal((await query(`SELECT 1 FROM pg_constraint WHERE conrelid='export_engine.jobs'::regclass
        AND confrelid='mirror.generations'::regclass AND contype='f'`)).rowCount,0);
      assert.equal((await query("SELECT 1 FROM mirror.generation_read_leases WHERE id=$1",[f.job.generation_lease_id])).rowCount,0);
      assert.equal((await f.get()).generation_id,"gen");
    });

    await t.test("concurrent checkpoint commits apply one part and increment counters once",async()=>{
      const f=await fixture();const running=await f.claim();
      const outcomes=await Promise.allSettled([f.commit(running.claim),f.commit(running.claim)]);
      assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
      assert.equal(outcomes.find(r=>r.status==="rejected").reason.code,C.CHECKPOINT_CONFLICT);
      const job=await f.get();assert.equal(job.checkpoint_version,"1");assert.equal(job.rows_committed,"2");assert.equal(job.bytes_committed,"20");
      assert.equal((await query("SELECT count(*) FROM export_engine.parts WHERE job_id=$1",[f.job.id])).rows[0].count,"1");
      await f.repo.requestCancellation(f.common);await f.repo.acknowledgeCancellation({...f.common,claim:running.claim});
    });

    await t.test("concurrent finalizers and repeated completion register the same immutable artifact once",async()=>{
      let arrivals=0,release;
      const bothVerified=new Promise(resolve=>{release=resolve;});
      const f=await fixture({verifyFinalArtifact:async({artifact,partSetHash})=>{
        if(++arrivals===2)release();
        await bothVerified;
        return {...artifact,verified:true,immutable:true,rowCountVerified:true,sourceByteCount:20,accountingVersion:"csv-assembled-v1",partSetHash};
      }});
      const running=await f.claim();await f.commit(running.claim);
      await f.repo.transitionWorker({...f.common,claim:running.claim,fromState:"RUNNING",toState:"FINALIZING"});
      const input={...f.common,claim:running.claim,expectedCheckpointVersion:1,artifact:{storageKey:randomUUID(),storageVersion:"final-v1",
        checksum,format:"CSV",rowCount:2,byteCount:15,partCount:1,expiresAt:new Date(Date.now()+60000).toISOString()}};
      const results=await Promise.all([f.repo.finalizeArtifact(input),f.repo.finalizeArtifact(input)]);
      assert.equal(results.filter(r=>r.replayed===true).length,1);
      assert.ok(results.every(r=>r.job.state==="COMPLETED"));
      const repeated=await f.repo.finalizeArtifact(input);assert.equal(repeated.replayed,true);
      assert.equal(repeated.job.fence_epoch,results[0].job.fence_epoch);
      assert.equal((await query("SELECT count(*) FROM export_engine.artifacts WHERE job_id=$1",[f.job.id])).rows[0].count,"1");
      await assert.rejects(()=>f.repo.finalizeArtifact({...input,artifact:{...input.artifact,storageVersion:"different-final"}}),{code:C.ARTIFACT_INTEGRITY_FAILED});
    });

    await t.test("atomic admission limits, per-shop concurrency, global capacity, and idempotent replay without reserving slots",async()=>{
      const shopA = await fixture({
        maxAdmittedPerShop: 2,
        maxConcurrentPerShop: 1,
        maxGlobalConcurrent: 2,
      });

      // shopA already has 1 admitted job from fixture() ("export:test-key")
      // 1. Create a second job for shopA (reaches maxAdmittedPerShop = 2)
      const secondInput = {
        ...shopA.input,
        idempotencyKey: "export:test-key-2",
      };
      const second = await shopA.repo.createJob(secondInput);
      assert.equal(second.created, true);

      // 2. Third distinct job for shopA exceeds maxAdmittedPerShop (2) and fails with EXPORT_CAPACITY_EXCEEDED
      await assert.rejects(
        () =>
          shopA.repo.createJob({
            ...shopA.input,
            idempotencyKey: "export:test-key-3",
          }),
        { code: C.CAPACITY_EXCEEDED },
      );

      // 3. Repeated idempotent request for an existing key succeeds with created: false
      //    even though shopA is at maxAdmittedPerShop (2/2)
      const idempotentReplay = await shopA.repo.createJob(secondInput);
      assert.equal(idempotentReplay.created, false);
      assert.equal(idempotentReplay.job.id, second.job.id);

      // 4. Transition first job to QUEUED and second job to WAITING_FOR_CAPACITY
      await shopA.queue();
      const secondCommon = { identity: shopA.identity, jobId: second.job.id };
      await shopA.repo.transition({ ...secondCommon, fromState: "PENDING", toState: "VALIDATING" });
      await shopA.repo.transition({ ...secondCommon, fromState: "VALIDATING", toState: "WAITING_FOR_CAPACITY" });

      // 5. Scheduler cannot promote second job while first job is QUEUED (maxConcurrentPerShop = 1)
      const blockedSchedule = await shopA.repo.scheduleWaitingJobs();
      assert.equal(blockedSchedule.length, 0);

      // 6. Worker claims first job; attempting to claim another job for shopA returns null (per-shop concurrency = 1)
      const claim1 = await shopA.repo.claimNext({ workerId: "w-1" });
      assert.equal(claim1.job.id, shopA.job.id);
      assert.equal(await shopA.repo.claimNext({ workerId: "w-2" }), null);

      // 7. Cancel and finish first job; now scheduler promotes second job from WAITING_FOR_CAPACITY to QUEUED
      await shopA.repo.requestCancellation(shopA.common);
      await shopA.repo.acknowledgeCancellation({ ...shopA.common, claim: claim1.claim });

      const promoted = await shopA.repo.scheduleWaitingJobs();
      assert.equal(promoted.length, 1);
      assert.equal(promoted[0].id, second.job.id);
      assert.equal(promoted[0].state, "QUEUED");

      // Clean up second job
      await shopA.repo.requestCancellation(secondCommon);
      await shopA.repo.finalizeCancellation(secondCommon);
    });
    await testProductionExportAdapters(t,pool);
  } finally {await pool.end();}
});
