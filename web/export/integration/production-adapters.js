import express from 'express';
import {createExportControlAdapter} from '../export-control-adapter.server.js';
import {createExportControlRouter} from '../export-control.routes.js';
/** Real PostgreSQL + real production source/storage/evidence/worker code.
 * S3 and queue wire transports are test-only; their verification is not mocked.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createInstalledFilterHttpRuntime} from "../../services/filter-engine.server.js";
import {getInstalledFilterSchemaOptions} from "../../services/filter-schema.server.js";
import {createPublicationRepository} from "../../mirror/publication-repository.server.js";
import {createMirrorPublicationService} from "../../mirror/publication-service.server.js";
import {createExportCoverageRepository,createExportSource} from "../export-source.server.js";
import {createExportGenerationProtection,withExportExecutionAuthorization} from "../export-generation-protection.server.js";
import {createExportRepository} from "../export-repository.server.js";
import {createExportStorage} from "../export-storage.server.js";
import {createExportQueueEvidence,createExportDispatcher} from "../export-dispatch.server.js";
import {createExportWorker} from "../export-worker.server.js";
import {createExportService} from "../export-service.server.js";
import {versionedS3TestTransport} from "../test-support/versioned-s3.js";
import {FIELD_ERROR_CODES as F} from "../../fields/types.js";

export async function testProductionExportAdapters(t,pool) {
  await t.test("production adapters authorize frozen selections and generate versioned CSV, JSONL and XLSX",async productionTest=>{
    const shopId="production-export.myshopify.com",installationId=randomUUID(),generationId="production-gen";
    const query=(sql,values)=>pool.query(sql,values),installed=getInstalledFilterSchemaOptions();
    await query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2)",[shopId,installationId]);
    await query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mapping_version,mirror_schema_version,source_contract_version)
      VALUES($1,$2,'production-cov','production-map',$3,$4)`,[shopId,generationId,installed.mirrorSchemaVersion,installed.sourceContractVersion]);
    await query(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,tags,created_at,updated_at)
      VALUES($1,$2,'gid://shopify/Product/99001','=Formula,quoted','export-one','ACTIVE',ARRAY['one','two'],clock_timestamp(),clock_timestamp()),
        ($1,$2,'gid://shopify/Product/99002','Unicode \u03bb\nline','export-two','ACTIVE',ARRAY[]::text[],clock_timestamp(),clock_timestamp())`,[shopId,generationId]);
    const productIds=(await query("SELECT id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2 ORDER BY id",[shopId,generationId])).rows.map(r=>r.id);
    for(const [dataset,count] of [["products",2],["variants",0]]) {
      await query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at)
        VALUES($1,$2,$3,'SUCCEEDED',$4,$4,true,clock_timestamp())`,[shopId,generationId,dataset,count]);
      await query(`INSERT INTO mirror.coverage(shop_id,generation_id,name,status,durable_rows,verified_at,verification_hash)
        VALUES($1,$2,$3,'COMPLETE',$4,clock_timestamp(),'production-fixture')`,[shopId,generationId,dataset,count]);
    }
    for(const [state,column] of [["RECONCILING",""],["VERIFIED",",verified_at=clock_timestamp()"],["PUBLISHED",",published_at=clock_timestamp()"]])
      await query(`UPDATE mirror.generations SET status=$3${column} WHERE shop_id=$1 AND id=$2`,[shopId,generationId,state]);
    await query("INSERT INTO mirror.publications(shop_id,generation_id,coverage_revision,mapping_version) VALUES($1,$2,'production-cov','production-map')",[shopId,generationId]);
    await query(`INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,generation_id,status)
      VALUES($1,$2,$3,$4,'SUCCEEDED')`,[randomUUID(),shopId,installationId,generationId]);
    const session={id:`offline_${shopId}`,shop:shopId,isOnline:false,scope:"read_products",accessToken:"fixture-token"};
    const sessionStorage={async loadSession(id){return id===session.id?session:null;},async findSessionsByShop(shop){return shop===shopId?[session]:[];}};
    const mirror=createPublicationRepository({database:pool});
    const publication=createMirrorPublicationService({repository:mirror,barrierTable:{schema:"mirror",table:"publications"}});
    const fieldRuntime=await createInstalledFilterHttpRuntime({database:pool,sessionStorage,cursorSecret:"production-fixture-cursor-secret".repeat(3),
      coverageRepository:createExportCoverageRepository({database:pool,repository:mirror})});
    const source=createExportSource({database:pool,runtime:fieldRuntime,publicationService:publication,sessionStorage});
    const generationProtection=withExportExecutionAuthorization({generationProtection:createExportGenerationProtection({publicationService:publication}),source});
    const transport=versionedS3TestTransport(),queued=new Map();
    const queue={async getJob(id){return queued.get(id)??null;},async add(name,data,{jobId}){
      const job={id:jobId,name,data,async getState(){return "waiting";},async remove(){queued.delete(jobId);}};
      queued.set(jobId,job);return job;
    }};
    let repository;
    const storage=createExportStorage({client:transport,bucket:"private-test",loadJob:input=>repository.getJob(input),loadParts:input=>repository.getCommittedParts(input)});
    await storage.verifyConfiguration();
    const evidence=createExportQueueEvidence({database:pool,queue,generationProtection});
    repository=createExportRepository({pool,generationProtection,retryBaseMs:1,retryMaxMs:2,
      verifyStoredPart:storage.verifyStoredPart,verifyFinalArtifact:storage.verifyFinalArtifact,verifyRecoveryEvidence:storage.verifyRecoveryEvidence,
      verifyDeliveryEvidence:evidence.verifyDeliveryEvidence,reconcileDelivery:evidence.reconcileDelivery});
    const worker=createExportWorker({repository,storage,source,evidence,workerId:"production-worker"});
    const dispatcher=createExportDispatcher({repository,queue,worker,database:pool});
    const service=createExportService({repository,resolveShop:source.resolveShop,resolveExecutionContext:source.resolveExecutionContext,
      fieldService:fieldRuntime.fieldService,filterService:fieldRuntime.compiler});
    const req={};await fieldRuntime.authentication.capture(req,{locals:{shopify:{session}}},()=>{});
    const authContext=await fieldRuntime.authentication.authenticate(req);
    for(const format of ["CSV","JSONL","XLSX"]) {
      const request={authContext,idempotencyKey:`export:production-${format}`,input:{format,fieldIds:["product.title","product.tags"]}};
      const created=await service.create(request);assert.equal(created.created,true);
      assert.equal(created.job.state,"WAITING_FOR_CAPACITY");assert.equal("leaseToken" in created.job,false);assert.equal("lease_token" in created.job,false);
      await dispatcher.tick();
      const event=(await query("SELECT * FROM export_engine.outbox WHERE job_id=$1",[created.job.id])).rows[0];
      const delivery=queued.get(event.delivery_key);assert.ok(delivery);
      assert.equal((await worker.process(delivery)).state,"COMPLETED");
      const common={identity:{shopId,installationId},jobId:created.job.id};
      const done=await repository.getJob(common);assert.equal(done.rows_committed,"2");assert.equal(done.checkpoint.done,true);
      assert.equal(done.generation_id,generationId);
      const artifact=(await query("SELECT * FROM export_engine.artifacts WHERE job_id=$1",[created.job.id])).rows[0];
      assert.equal(artifact.row_count,"2");assert.ok(artifact.storage_version);
      const app=express();app.use('/api/exports',createExportControlRouter({authentication:{authenticate:async()=>authContext},source,
        controlRepository:createExportControlAdapter(repository),storage,database:pool}));
      const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
      try{
        const root=`http://127.0.0.1:${server.address().port}/api/exports/${done.id}`;
        const status=await fetch(root);assert.equal(status.status,200);assert.equal((await status.json()).data.state,'COMPLETED');
        const download=await fetch(`${root}/download`);assert.equal(download.status,200);assert.ok((await download.arrayBuffer()).byteLength>0);
      }finally{await new Promise(resolve=>server.close(resolve));}
      await source.authorizeDownload({authContext,job:await createExportControlAdapter(repository).getJob({identity:{shopId,installationId},jobId:done.id})});
      const opened=await storage.openRegisteredArtifact({...common,artifact});let downloaded=0;
      for await(const chunk of opened)downloaded+=chunk.length;
      assert.equal(String(downloaded),artifact.byte_count);
      session.scope="";
      await assert.rejects(async()=>source.authorizeDownload({authContext,job:await createExportControlAdapter(repository).getJob({identity:{shopId,installationId},jobId:done.id})}),{code:F.PERMISSION_DENIED});
      session.scope="read_products";
      const count=transport.objects.size;
      assert.deepEqual(await worker.process(delivery),{skipped:true});assert.equal(transport.objects.size,count);
      const replay=await service.create(request);assert.equal(replay.created,false);assert.equal(replay.job.id,created.job.id);
      assert.equal((await query("SELECT count(*) FROM export_engine.delivery_receipts WHERE job_id=$1",[created.job.id])).rows[0].count,"1");
      await repository.releaseTerminalGenerationProtections();
    }
    await productionTest.test("a failed source attempt resumes the durable S3 part rather than its local cursor",async()=>{
      const created=await service.create({authContext,idempotencyKey:"export:production-retry",input:{format:"JSONL",fieldIds:["product.title","product.tags"]}});
      await repository.scheduleWaitingJobs();
      const [schedule]=await repository.claimOutbox({dispatcherId:"retry-dispatch"});
      await queue.add("export",{eventId:schedule.event.id},{jobId:schedule.event.delivery_key});
      let split=true,failed=false;
      const flakySource={async readPage(input){
        if(split){split=false;const page=await source.readPage(input);return {rows:page.rows.slice(0,1),checkpoint:{afterProductId:String(productIds[0]),done:false}};}
        if(!failed){failed=true;throw Error("Transient source failure");}
        return source.readPage(input);
      }};
      const flaky=createExportWorker({repository,storage,source:flakySource,evidence,workerId:"flaky",logger:{error(){}}});
      await assert.rejects(()=>flaky.process(queued.get(schedule.event.delivery_key)),/Transient source failure/);
      const common={identity:{shopId,installationId},jobId:created.job.id};
      let job=await repository.getJob(common);assert.equal(job.state,"RETRY_WAIT");assert.equal(job.checkpoint_version,"1");
      await query("UPDATE export_engine.jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
      for(const recovery of await repository.recoverExpiredJobs({recoveryOwner:"recovery"}))await worker.recover(recovery);
      job=await repository.getJob(common);assert.equal(job.retry_verified,true);
      await query("UPDATE export_engine.jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
      await repository.releaseRetryWaitJobs();
      const [second]=await repository.claimOutbox({dispatcherId:"retry-dispatch"});
      const delivery=await queue.add("export",{eventId:second.event.id},{jobId:second.event.delivery_key});
      assert.equal((await worker.process(delivery)).state,"COMPLETED");
      job=await repository.getJob(common);assert.equal(job.rows_committed,"2");assert.equal(job.checkpoint_version,"2");
      assert.equal((await query("SELECT count(*) FROM export_engine.parts WHERE job_id=$1",[job.id])).rows[0].count,"2");
    });
    await productionTest.test("revoked scopes after storage verification cannot register a final artifact",async()=>{
      const created=await service.create({authContext,idempotencyKey:"export:revoke-before-final-commit",input:{format:"JSONL",fieldIds:["product.title","product.tags"]}});
      await repository.scheduleWaitingJobs();
      const [schedule]=await repository.claimOutbox({dispatcherId:"revocation-dispatch"});
      const delivery=await queue.add("export",{eventId:schedule.event.id},{jobId:schedule.event.delivery_key});
      const revokingRepo=createExportRepository({pool,generationProtection,
        verifyStoredPart:storage.verifyStoredPart,verifyRecoveryEvidence:storage.verifyRecoveryEvidence,
        verifyDeliveryEvidence:evidence.verifyDeliveryEvidence,reconcileDelivery:evidence.reconcileDelivery,
        async verifyFinalArtifact(input){const receipt=await storage.verifyFinalArtifact(input);session.scope="";return receipt;}});
      const revokingWorker=createExportWorker({repository:revokingRepo,storage,source,evidence,workerId:"revocation-worker",logger:{error(){}}});
      try {
        await assert.rejects(()=>revokingWorker.process(delivery),{code:"EXPORT_UNAUTHORIZED"});
        const job=await repository.getJob({identity:{shopId,installationId},jobId:created.job.id});
        assert.equal(job.state,"FAILED");
        assert.equal((await query("SELECT count(*) FROM export_engine.artifacts WHERE job_id=$1",[job.id])).rows[0].count,"0");
        await repository.releaseTerminalGenerationProtections();
        assert.equal((await query("SELECT 1 FROM mirror.generation_read_leases WHERE id=$1",[job.generation_lease_id])).rowCount,0);
      }finally{session.scope="read_products";await revokingWorker.stop();}
    });
    await productionTest.test("revocation before worker claim fails the queued job without uploading data",async()=>{
      const created=await service.create({authContext,idempotencyKey:"export:revoke-before-claim",input:{format:"CSV",fieldIds:["product.title"]}});
      await repository.scheduleWaitingJobs();
      const [schedule]=await repository.claimOutbox({dispatcherId:"revoked-claim-dispatch"});
      const delivery=await queue.add("export",{eventId:schedule.event.id},{jobId:schedule.event.delivery_key});
      const objectCount=transport.objects.size;
      session.scope="";
      try {
        assert.deepEqual(await worker.process(delivery),{skipped:true});
        const job=await repository.getJob({identity:{shopId,installationId},jobId:created.job.id});
        assert.equal(job.state,"FAILED");assert.equal(job.failure_code,"EXPORT_UNAUTHORIZED");
        assert.equal(transport.objects.size,objectCount);
        await repository.releaseTerminalGenerationProtections();
      }finally{session.scope="read_products";}
    });
    await productionTest.test("reinstallation revokes old jobs without rewriting export history",async()=>{
      const created=await service.create({authContext,idempotencyKey:"export:obsolete-installation",input:{format:"CSV",fieldIds:["product.title"]}});
      const common={identity:{shopId,installationId},jobId:created.job.id};
      await query("UPDATE mirror.shops SET installation_version=$2 WHERE id=$1",[shopId,randomUUID()]);
      await repository.renewPendingGenerationProtection();
      const stopped=await repository.getJob(common);assert.equal(stopped.state,"FAILED");assert.equal(stopped.installation_id,installationId);
      await repository.releaseTerminalGenerationProtections();
      assert.equal((await query("SELECT 1 FROM mirror.generation_read_leases WHERE id=$1",[stopped.generation_lease_id])).rowCount,0);
      await assert.rejects(async()=>source.authorizeDownload({authContext,job:await createExportControlAdapter(repository).getJob(common)}),{code:"EXPORT_UNAUTHORIZED"});
      await assert.rejects(()=>service.create({authContext,idempotencyKey:"export:old-generation-new-install",input:{format:"CSV",fieldIds:["product.title"]}}),{code:"EXPORT_UNAUTHORIZED"});
    });
    await worker.stop();
  });
}
