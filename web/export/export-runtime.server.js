/** Production composition root. No mocks, guessed approvals, or disabled verifiers. */
import {randomUUID,createHash} from "node:crypto";
import {Queue,Worker} from "bullmq";
import {S3Client} from "@aws-sdk/client-s3";
import {createInstalledFilterHttpRuntime} from "../services/filter-engine.server.js";
import {createPublicationRepository} from "../mirror/publication-repository.server.js";
import {createMirrorPublicationService} from "../mirror/publication-service.server.js";
import {createExportGenerationProtection,withExportExecutionAuthorization} from "./export-generation-protection.server.js";
import {createExportStorage} from "./export-storage.server.js";
import {createExportSource,createExportCoverageRepository} from "./export-source.server.js";
import {createExportRepository} from "./export-repository.server.js";
import {createExportControlAdapter} from './export-control-adapter.server.js';
import {createExportService} from "./export-service.server.js";
import {createExportQueueEvidence,createExportDispatcher,EXPORT_QUEUE_NAME} from "./export-dispatch.server.js";
import {createExportWorker} from "./export-worker.server.js";

export function exportProductionConfig(env=process.env) {
  if(env.EXPORTS_ENABLED!=="true") {
    if(env.EXPORTS_ENABLED&&env.EXPORTS_ENABLED!=="false")throw new TypeError("EXPORTS_ENABLED must be true or false");
    return null;
  }
  if(!env.EXPORT_S3_BUCKET||!env.EXPORT_S3_REGION||!env.REDIS_URL)throw new TypeError("Enabled exports require EXPORT_S3_BUCKET, EXPORT_S3_REGION and REDIS_URL");
  const redis=new URL(env.REDIS_URL);
  if(!["redis:","rediss:"].includes(redis.protocol))throw new TypeError("Supported export Redis URL required");
  const db=Number(redis.pathname.slice(1)||0);
  if(!Number.isSafeInteger(db)||db<0||db>15)throw new TypeError("Bounded export Redis database required");
  let endpoint;
  if(env.EXPORT_S3_ENDPOINT) {
    endpoint=new URL(env.EXPORT_S3_ENDPOINT);
    if(endpoint.username||endpoint.password||!(["https:"].includes(endpoint.protocol)||
      env.NODE_ENV!=="production"&&endpoint.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(endpoint.hostname)))throw new TypeError("HTTPS S3 endpoint required in production");
  }
  return Object.freeze({bucket:env.EXPORT_S3_BUCKET,region:env.EXPORT_S3_REGION,endpoint:endpoint?.href,
    forcePathStyle:env.EXPORT_S3_FORCE_PATH_STYLE!=="false",prefix:env.EXPORT_S3_PREFIX||"metamax-exports",
    connection:{host:redis.hostname,port:Number(redis.port||6379),username:redis.username?decodeURIComponent(redis.username):undefined,
      password:redis.password?decodeURIComponent(redis.password):undefined,db,tls:redis.protocol==="rediss:"?{}:undefined,
      connectTimeout:5000,maxRetriesPerRequest:1,retryStrategy:attempt=>attempt>5?null:Math.min(attempt*200,2000)}});
}

async function waitForReady(resource) {
  let timer;
  try {await Promise.race([resource.waitUntilReady(),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error("Export Redis readiness timed out")),15000);timer.unref?.();
  })]);}finally{clearTimeout(timer);}
}

export async function createExportRuntime({database,sessionStorage,cursorSecret,config,logger=console}={}) {
  if(!config||typeof database?.connect!=="function"||typeof sessionStorage?.loadSession!=="function"||!cursorSecret)
    throw new TypeError("Enabled exports require PostgreSQL, authenticated session storage, cursor secret and production configuration");
  // Fail before starting workers or exposing admission when migration is missing.
  await database.query(`SELECT j.retry_verified,j.generation_lease_id,j.lease_token,j.fence_epoch,j.checkpoint_version,j.cancel_requested,
    j.generation_protection_released_at,p.storage_version,p.row_count,p.byte_count,p.committed_fence,a.accounting_version,a.storage_receipt,
    o.delivery_key,o.state,o.fence_epoch,o.claim_token,o.claim_expires_at,o.reconciliation_attempts,r.delivery_key,t.datasets
    FROM export_engine.jobs j LEFT JOIN export_engine.parts p ON p.job_id=j.id
    LEFT JOIN export_engine.artifacts a ON a.job_id=j.id LEFT JOIN export_engine.delivery_receipts r ON r.job_id=j.id
    LEFT JOIN export_engine.outbox o ON o.job_id=j.id
    LEFT JOIN export_engine.target_approvals t ON t.shop_id=j.shop_id WHERE false`);
  const guards=(await database.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
    AND tgrelid IN ('export_engine.jobs'::regclass,'export_engine.parts'::regclass,'export_engine.artifacts'::regclass,
      'export_engine.outbox'::regclass,'export_engine.delivery_receipts'::regclass,'export_engine.target_approvals'::regclass)
    AND tgenabled IN ('O','A')`)).rows.map(row=>row.tgname);
  for(const name of ["guard_export_job","export_parts_immutable","export_artifacts_immutable","export_outbox_identity","export_receipts_immutable","export_target_immutable"])
    if(!guards.includes(name))throw new TypeError(`Export migration guard missing: ${name}`);
  const historical=(await database.query(`SELECT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a
    ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1] WHERE c.conrelid='export_engine.jobs'::regclass
      AND c.confrelid='mirror.shops'::regclass AND c.contype='f' AND cardinality(c.conkey)=1 AND a.attname='shop_id') AS safe`)).rows[0];
  if(historical?.safe!==true)throw new TypeError("Export installation-history migration is required");
  const mirror=createPublicationRepository({database});
  const publicationService=createMirrorPublicationService({repository:mirror,barrierTable:{schema:"mirror",table:"publications"}});
  const mirrorProtection=createExportGenerationProtection({publicationService});
  const runtime=await createInstalledFilterHttpRuntime({database,sessionStorage,cursorSecret,
    coverageRepository:createExportCoverageRepository({database,repository:mirror})});
  const source=createExportSource({database,runtime,publicationService,sessionStorage});
  const generationProtection=withExportExecutionAuthorization({generationProtection:mirrorProtection,source});
  const s3=new S3Client({region:config.region,endpoint:config.endpoint,forcePathStyle:config.forcePathStyle,maxAttempts:2,
    requestHandler:{connectionTimeout:5000,requestTimeout:30000}});
  let queue,bullWorker,repository;
  try {
    const storage=createExportStorage({client:s3,bucket:config.bucket,prefix:config.prefix,
      loadJob:input=>repository.getJob(input),loadParts:input=>repository.getCommittedParts(input)});
    await storage.verifyConfiguration();
    queue=new Queue(EXPORT_QUEUE_NAME,{connection:config.connection});
    queue.on("error",error=>logger.error?.({code:error.code??"EXPORT_QUEUE_ERROR"},"Export queue connection failed"));
    await waitForReady(queue);
    const evidence=createExportQueueEvidence({database,queue,generationProtection});
    repository=createExportRepository({pool:database,generationProtection,
      verifyStoredPart:storage.verifyStoredPart,verifyFinalArtifact:storage.verifyFinalArtifact,verifyRecoveryEvidence:storage.verifyRecoveryEvidence,
      verifyDeliveryEvidence:evidence.verifyDeliveryEvidence,reconcileDelivery:evidence.reconcileDelivery});
    const worker=createExportWorker({repository,storage,source,evidence,workerId:`export-${randomUUID()}`,logger});
    bullWorker=new Worker(EXPORT_QUEUE_NAME,job=>worker.process(job),{connection:{...config.connection,maxRetriesPerRequest:null,retryStrategy:attempt=>Math.min(200*attempt,5000)},
      concurrency:2,autorun:false,lockDuration:60000,maxStalledCount:1});
    bullWorker.on("error",error=>logger.error?.({code:error.code??"EXPORT_WORKER_ERROR"},"Export BullMQ worker failed"));
    bullWorker.on("failed",job=>logger.error?.({queueJobId:job?.id},"Export scheduling token failed; database recovery remains authoritative"));
    await waitForReady(bullWorker);
    const dispatcher=createExportDispatcher({repository,queue,worker,database,logger});
    const service=createExportService({repository,resolveShop:source.resolveShop,resolveExecutionContext:source.resolveExecutionContext,
      rateLimiter:{async consume({shopId,installationId}) {
        const key=`metamax:export:admission:${createHash("sha256").update(JSON.stringify([shopId,installationId])).digest("hex")}`;
        return Number(await (await queue.client).eval(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n`,1,key))<=5;
      }},
      fieldService:runtime.fieldService,filterService:runtime.compiler});
    let started=false;
    return Object.freeze({authentication:runtime.authentication,service,repository,controlRepository:createExportControlAdapter(repository),storage,source,
      start(){if(started)return;started=true;dispatcher.start();void bullWorker.run().catch(error=>logger.error?.({code:error.code??"EXPORT_WORKER_STOPPED"},"Export BullMQ runner stopped"));},
      async stop(){await dispatcher.stop();await bullWorker.pause(true);await worker.stop();await bullWorker.close();await queue.close();s3.destroy();},
    });
  } catch(error) {
    await bullWorker?.close(true).catch(()=>{});await queue?.close().catch(()=>{});s3.destroy();throw error;
  }
}
