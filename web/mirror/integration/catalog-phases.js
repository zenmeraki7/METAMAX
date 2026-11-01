import {createPublicationRepository} from '../publication-repository.server.js';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {createVerifiedRuntimePool} from '../../security/runtime-database.server.js';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCatalogPhaseRuntime } from '../../services/catalog-phase-runtime.server.js';
import { createCatalogImportService } from '../../services/catalog-import.server.js';
import { createSyncRunRepository } from '../sync-run-repository.server.js';
import { createSyncRunDbAdapter, verifySyncRunDbMapping } from '../sync-run-db-adapter.server.js';
import { CATALOG_EXECUTION_MAPPING, createCatalogEvidenceValidators } from '../catalog-execution.server.js';
import { createSyncRunService } from '../sync-run-service.server.js';
import { product } from './sync-hardening.js';
import { testSyncRecoveryRepository } from './sync-recovery-repository.js';
import { createSyncExternalOperations } from '../sync-external-operations.server.js';
import { CATALOG_INPUT_HASH } from '../catalog-sync-steps.server.js';
import { testSyncDispatchRepository } from './sync-dispatch-repository.js';
import { testInstallSync } from './install-sync.js';
import { testWebhookRefresh } from './webhook-refresh.js';

export async function testCatalogPhases(t,pool) {
  const password=randomBytes(24).toString('hex');
  await pool.query(`CREATE ROLE phase_engine_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await pool.query('GRANT metamax_catalog_worker TO phase_engine_runtime');
  const url=new URL(process.env.FILTER_TEST_DATABASE_URL);url.username='phase_engine_runtime';url.password=password;
  const enginePool=new pg.Pool({connectionString:url.href,max:10});
  try {

  const states=new Map(),sessions=new Map();let sequence=9000;
  function fixture(name,products=[product(31)]) {
    const shop=`${name}.myshopify.com`,session={id:`offline_${shop}`,shop,isOnline:false,scope:'read_products',accessToken:'fixture'};
    sessions.set(session.id,session);
    const lines=products.flatMap(({variants,...p})=>[JSON.stringify(p),...variants.map(v=>JSON.stringify({...v,__parentId:p.id}))]);
    const state={session,lines,starts:0,operationId:`gid://shopify/BulkOperation/${++sequence}`,polls:0};states.set(shop,state);return state;
  }
  const shopify={config:{sessionStorage:{loadSession:async id=>sessions.get(id),findSessionsByShop:async shop=>[...sessions.values()].filter(s=>s.shop===shop),deleteSessions:async ids=>{for(const id of ids)sessions.delete(id);return true;}}}};
  const clientFactory=({shopId})=>({authorize:async()=>{
    const s=states.get(shopId);s.authorizations=(s.authorizations??0)+1;
    if(s.denyAuthorization)throw new Error('Credential revoked');
  },request:async(query,{variables}={})=>{
    const s=states.get(shopId);
    if(query.includes('MirrorProductSnapshot')) {
      const records=s.lines.map(line=>JSON.parse(line));
      const p=records.find(p=>p.id===variables.id&&!p.__parentId);
      return {data:{product:p?{...p,variants:{nodes:records.filter(v=>v.__parentId===p.id).map(({__parentId,...v})=>v),pageInfo:{hasNextPage:false,endCursor:null}}}:null}};
    }
    if(query.includes('StartBulkOperation')) {s.starts++;if(s.loseStart)throw new Error('Response lost after dispatch');
      return {data:{bulkOperationRunQuery:{bulkOperation:{id:s.operationId,status:'CREATED'},userErrors:[]}}};}
    if(query.includes('CancelMirrorBulk')){
      s.cancels=(s.cancels??0)+1;
      if(s.onCancel)await s.onCancel();
      if(s.failCancel)throw new Error('Remote cancel failed');
      if(Object.hasOwn(s,'cancelResponse'))return s.cancelResponse;
      return {data:{bulkOperationCancel:{bulkOperation:{id:s.operationId,status:'CANCELLED'},userErrors:[]}}};
    }
    if(s.failStatus)throw new Error('Status verification unavailable');
    if(s.onStatus)await s.onStatus();
    assert.equal(variables.id,s.operationId);s.polls++;
    return {data:{bulkOperation:{id:s.operationId,status:s.remoteStatus??(s.pending?'RUNNING':'COMPLETED'),objectCount:String(s.lines.length),url:`https://storage.googleapis.com/${shopId}`}}};
  }});
  const fetchImpl=async(url,{headers}={})=>{
    const bytes=Buffer.from(states.get(new URL(url).pathname.slice(1)).lines.map(line=>line+'\n').join(''));
    const start=Number(/^bytes=(\d+)-/.exec(headers.Range)[1]),end=Math.min(bytes.length-1,start+1048575);
    return {ok:true,status:206,headers:new Headers({etag:'"fixture-export"','content-range':`bytes ${start}-${end}/${bytes.length}`}),body:Readable.from([bytes.subarray(start,end+1)],{objectMode:false})};
  };
  const options={database:createVerifiedRuntimePool(enginePool,{profile:"catalogWorker"}),shopify,clientFactory,fetchImpl,logger:{info(){},error(){}}};
  const runtime=await createCatalogPhaseRuntime(options);
  await t.test('physical schema revalidation batches all domain metadata into three network reads',async()=>{
    let metadataQueries=0;
    const measured={async connect(){
      const client=await pool.connect();
      return {query(sql,values){
        if(/pg_attribute|FROM pg_constraint|FROM pg_index|JOIN pg_constraint|JOIN pg_index/.test(sql))metadataQueries++;
        return client.query(sql,values);
      },release:error=>client.release(error)};
    }};
    await verifySyncRunDbMapping({database:measured,mapping:CATALOG_EXECUTION_MAPPING});
    assert.equal(metadataQueries,3);
  });
  const service=createCatalogImportService({...options,phaseRuntime:runtime});
  const state=async id=>(await pool.query('SELECT * FROM mirror.catalog_import_executions WHERE id=$1',[id])).rows[0];
  const makeDue=id=>pool.query('UPDATE mirror.catalog_import_executions SET next_eligible_at=clock_timestamp() WHERE id=$1',[id]);
  async function drain(id,max=12) {
    for(let i=0;i<max;i++){await makeDue(id);await runtime.processOne();const row=await state(id);if(row.completed_at||row.review_required||row.cancel_requested)return row;}
    return state(id);
  }
  // The global scanner may first service another test's due cancellation.
  // Wait for this job's actual result rather than assuming UUID service order.
  async function processJob(id){
    for(let turn=0;turn<64;turn++){
      await makeDue(id);const result=await runtime.processOne();
      if(result?.id===id)return result;
    }
    assert.fail('Target job was not serviced within the bounded fixture budget');
  }
  async function ledgerFixture(name) {
    const s=fixture(name),job=await service.enqueue(s.session);
    const mapping=await verifySyncRunDbMapping({database:pool,mapping:CATALOG_EXECUTION_MAPPING});
    const repo=createSyncRunRepository({db:createSyncRunDbAdapter({database:pool,mapping,...createCatalogEvidenceValidators()})});
    const claim=await repo.claimRun({runId:job.id,workerId:'ledger-test',leaseSeconds:120});
    const ledger=createSyncExternalOperations({database:pool,inputHash:CATALOG_INPUT_HASH,syncRunService:createSyncRunService({database:pool})});
    return {s,job,repo,claim,ledger};
  }
  await testInstallSync(t,{pool,fixture,service,runtime,state,makeDue,shopify,sessions,options});
  await t.test('missing, mismatched and CANCELING cleanup results remain pending until exact terminal observation',async()=>{
    for(const mode of ['missing','mismatch','canceling']){
      const s=fixture('cleanup-contract-'+mode);s.pending=true;const job=await service.enqueue(s.session);
      await runtime.processOne();
      s.cancelResponse={data:{bulkOperationCancel:mode==='missing'?null:{userErrors:[],bulkOperation:{id:mode==='mismatch'?'gid://shopify/BulkOperation/999999':s.operationId,status:'CANCELING'}}}};
      await service.cancel(s.session,job.id);
      const pending=await runtime.processOne();assert.equal(pending.kind,'CANCEL_PENDING');
      let row=await state(job.id);assert.equal(row.cancel_completed_at,null);assert.equal(row.outcome_uncertain,mode!=='canceling');
      s.remoteStatus='CANCELING';await makeDue(job.id);assert.equal((await runtime.processOne()).kind,'CANCEL_PENDING');
      row=await state(job.id);assert.equal(row.cancel_completed_at,null);
      s.remoteStatus='CANCELLED';await makeDue(job.id);assert.equal((await runtime.processOne()).kind,'CANCELLED');
      row=await state(job.id);assert.ok(row.cancel_completed_at);assert.equal(row.outcome_uncertain,false);
    }
  });
  await t.test('expired old generations archive and release terminal execution references while current publication survives',async()=>{
    const s=fixture('catalog-retention'),first=await service.enqueue(s.session);assert.ok((await drain(first.id)).completed_at);
    const second=await service.enqueue(s.session);assert.ok((await drain(second.id)).completed_at);
    const c=await pool.connect();try{
      await c.query('BEGIN');await c.query('LOCK TABLE mirror.generations IN ACCESS EXCLUSIVE MODE');
      // Isolated fixture clock simulation only; guards are restored before reclamation and FKs remain enabled.
      await c.query('ALTER TABLE mirror.generations DISABLE TRIGGER guard_sync_retention');
      await c.query("UPDATE mirror.generations SET retain_until=clock_timestamp()-interval '1 day' WHERE shop_id=$1 AND id=$2",[s.session.shop,first.generationId]);
      await c.query('ALTER TABLE mirror.generations ENABLE TRIGGER guard_sync_retention');
      await c.query("UPDATE mirror.catalog_import_executions SET completed_at=clock_timestamp()-interval '2 days' WHERE id=$1",[first.id]);
      await c.query("UPDATE mirror.catalog_import_jobs SET updated_at=clock_timestamp()-interval '2 days' WHERE id=$1",[first.id]);
      await c.query('COMMIT');
    }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    const repository=createPublicationRepository({database:pool});assert.equal(await repository.reclaimGeneration({shopId:s.session.shop,generationId:first.generationId}),true);
    assert.equal((await pool.query('SELECT 1 FROM mirror.generations WHERE shop_id=$1 AND id=$2',[s.session.shop,first.generationId])).rowCount,0);
    assert.equal((await pool.query('SELECT 1 FROM mirror.catalog_import_executions WHERE id=$1',[first.id])).rowCount,0);
    assert.equal((await pool.query('SELECT generation_id FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0].generation_id,second.generationId);
    assert.equal((await pool.query('SELECT 1 FROM mirror.catalog_retention_audit WHERE shop_id=$1 AND generation_id=$2',[s.session.shop,first.generationId])).rowCount,1);
  });
  await testWebhookRefresh(t,{pool,fixture,service,runtime,drain,options});
  await testSyncDispatchRepository(t,{pool,fixture,service,runtime,state,makeDue});
  await t.test('ledger commits preparation separately and allows exactly one dispatch',async()=>{
    const {claim,ledger}=await ledgerFixture('ledger-dispatch');
    const intent=await ledger.prepare({claim});
    assert.equal(intent.state,'PREPARED');
    assert.equal((await ledger.prepare({claim})).id,intent.id);
    const results=await Promise.allSettled([1,2].map(()=>ledger.beginDispatch({claim,intentId:intent.id})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.find(r=>r.status==='rejected').reason.outcomeUncertain,true);
    await assert.rejects(()=>ledger.prepare({claim}),{outcomeUncertain:true});
  });
  await t.test('late response evidence survives lease loss but cannot bind or acknowledge',async()=>{
    const {s,job,claim,ledger}=await ledgerFixture('ledger-late');
    const intent=await ledger.prepare({claim});await ledger.beginDispatch({claim,intentId:intent.id});
    await pool.query("UPDATE mirror.catalog_import_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
    await ledger.recordResponse({claim,intentId:intent.id,operationId:s.operationId});
    await ledger.recordResponse({claim,intentId:intent.id,operationId:s.operationId});
    await assert.rejects(()=>ledger.recordResponse({claim,intentId:intent.id,operationId:'gid://shopify/BulkOperation/888888'}),{outcomeUncertain:true});
    await assert.rejects(()=>ledger.confirm({claim,intentId:intent.id,operationId:s.operationId}));
    const stored=(await pool.query('SELECT * FROM mirror.sync_external_operations WHERE id=$1',[intent.id])).rows[0];
    assert.equal(stored.operation_id,s.operationId);assert.equal(stored.state,'DISPATCHING');
    assert.equal((await pool.query('SELECT bulk_operation_id FROM mirror.ingestion_runs WHERE execution_id=$1',[job.id])).rows[0].bulk_operation_id,null);
  });
  await t.test('rejected intent retries fence out old responses and bind confirmation atomically',async()=>{
    const {s,job,repo,claim,ledger}=await ledgerFixture('ledger-retry');
    const intent=await ledger.prepare({claim});await ledger.beginDispatch({claim,intentId:intent.id});
    await ledger.reject({claim,intentId:intent.id});
    await repo.recordFailure({claim,failure:{code:'START_REJECTED',retryable:true,outcomeUncertain:false,retryAfterMs:1000}});
    await makeDue(job.id);
    const next=await repo.claimRun({runId:job.id,workerId:'ledger-retry',leaseSeconds:120});
    assert.equal((await ledger.prepare({claim:next})).id,intent.id);
    await ledger.beginDispatch({claim:next,intentId:intent.id});
    await assert.rejects(()=>ledger.recordResponse({claim,intentId:intent.id,operationId:s.operationId}),{outcomeUncertain:true});
    await ledger.recordResponse({claim:next,intentId:intent.id,operationId:s.operationId});
    const failing=createSyncExternalOperations({database:pool,inputHash:CATALOG_INPUT_HASH,
      syncRunService:{async bindBulkOperationIdInTransaction(){throw new Error('injected binding failure');}}});
    await assert.rejects(()=>failing.confirm({claim:next,intentId:intent.id,operationId:s.operationId}),/injected/);
    assert.equal((await pool.query('SELECT state FROM mirror.sync_external_operations WHERE id=$1',[intent.id])).rows[0].state,'DISPATCHING');
    await ledger.confirm({claim:next,intentId:intent.id,operationId:s.operationId});
    assert.equal((await ledger.prepare({claim:next})).alreadyBound,true);
    await repo.recordStep({claim:next,result:{kind:'ADVANCE'}});
    const waiting=await repo.claimRun({runId:job.id,workerId:'ledger-waiting',leaseSeconds:120});
    await ledger.recordCompleted({claim:waiting,operationId:s.operationId,objectCount:'0'});
    await ledger.recordCompleted({claim:waiting,operationId:s.operationId,objectCount:'0'});
    await assert.rejects(()=>ledger.recordCompleted({claim:waiting,operationId:s.operationId,objectCount:'1'}),{outcomeUncertain:true});
    assert.equal((await pool.query('SELECT expected_lines FROM mirror.ingestion_runs WHERE execution_id=$1',[job.id])).rows[0].expected_lines,'0');
  });
  await t.test('ledger rejects changed input identity and cross-shop evidence',async()=>{
    const {s,claim,ledger}=await ledgerFixture('ledger-scope');
    const intent=await ledger.prepare({claim});
    const changed=createSyncExternalOperations({database:pool,inputHash:'b'.repeat(64),syncRunService:createSyncRunService({database:pool})});
    await assert.rejects(()=>changed.prepare({claim}),{outcomeUncertain:true});
    await ledger.beginDispatch({claim,intentId:intent.id});
    await assert.rejects(()=>ledger.recordResponse({claim:{...claim,shopId:'other.myshopify.com'},intentId:intent.id,operationId:s.operationId}),{outcomeUncertain:true});
    await assert.rejects(()=>changed.recordResponse({claim,intentId:intent.id,operationId:s.operationId}),{outcomeUncertain:true});
  });
  await t.test('production phase runtime allocates atomically, verifies durable gates and publishes through real services',async()=>{
    const s=fixture('phase-success');const job=await service.enqueue(s.session);
    assert.equal((await pool.query('SELECT execution_mode,lease_until FROM mirror.catalog_import_jobs WHERE id=$1',[job.id])).rows[0].execution_mode,'PHASE');
    const finished=await drain(job.id);assert.ok(finished.completed_at);assert.equal(finished.attempt,0);assert.equal(s.starts,1);
    const pub=(await pool.query('SELECT generation_id FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0];
    assert.equal(pub.generation_id,job.generationId);
  });
  await t.test('twenty healthy remote polls keep the same operation eligible without exhausting retries',async()=>{
    const s=fixture('phase-polls');s.pending=true;const job=await service.enqueue(s.session);await runtime.processOne();
    for(let i=0;i<20;i++){await makeDue(job.id);await runtime.processOne();assert.equal((await state(job.id)).attempt,0);}
    assert.equal((await state(job.id)).phase,'WAITING');s.pending=false;
    assert.ok((await drain(job.id)).completed_at);assert.equal(s.starts,1);
  });
  await t.test('chunk budgets defer until durable EOF and a fresh runtime resumes the same input',async()=>{
    const s=fixture('phase-chunks',Array.from({length:575},(_,i)=>product(1000+i)));
    const job=await service.enqueue(s.session);await runtime.processOne();await runtime.processOne();
    const partial=await runtime.processOne();assert.equal(partial.kind,'DEFER');assert.equal((await state(job.id)).phase,'INGESTING');
    const receipt=(await pool.query("SELECT processed_lines,eof_verified FROM mirror.ingestion_runs WHERE shop_id=$1 AND dataset='products'",[s.session.shop])).rows[0];
    assert.ok(BigInt(receipt.processed_lines)>0n);assert.equal(receipt.eof_verified,false);
    const fresh=await createCatalogPhaseRuntime(options);await makeDue(job.id);await fresh.processOne();
    assert.ok((await drain(job.id)).completed_at);assert.equal(s.starts,1);
  });
  await t.test('uncertain unbound remote starts require review and cannot silently start a second export',async()=>{
    const s=fixture('phase-unknown');s.loseStart=true;const job=await service.enqueue(s.session);
    const result=await runtime.processOne();assert.equal(result.kind,'RECOVERY_REQUIRED');
    await makeDue(job.id);await runtime.processOne();assert.equal((await state(job.id)).review_required,true);
    await runtime.processOne();assert.equal(s.starts,1);
    assert.equal((await pool.query('SELECT count(*) FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0].count,'0');
  });
  await t.test('recovery verifies a persisted operation ID and resumes without another remote start',async()=>{
    const s=fixture('phase-recover');const job=await service.enqueue(s.session);await runtime.processOne();
    await pool.query(`UPDATE mirror.catalog_import_executions SET outcome_uncertain=true,next_eligible_at=clock_timestamp() WHERE id=$1`,[job.id]);
    const result=await runtime.processOne();assert.equal(result.kind,'RESUMED');
    assert.ok((await drain(job.id)).completed_at);assert.equal(s.starts,1);
  });
  await t.test('production gates reject fabricated phase completion and a stale child loses authority',async()=>{
    const s=fixture('phase-fence');const job=await service.enqueue(s.session);
    const mapping=await verifySyncRunDbMapping({database:pool,mapping:CATALOG_EXECUTION_MAPPING});
    const db=createSyncRunDbAdapter({database:pool,mapping,...createCatalogEvidenceValidators()});
    const repo=createSyncRunRepository({db});
    const claim=await repo.claimRun({runId:job.id,workerId:'fixture',leaseSeconds:120});
    await assert.rejects(()=>repo.recordStep({claim,result:{kind:'ADVANCE'}}),{code:'EVIDENCE_MISSING'});
    const child=(await pool.query("SELECT * FROM mirror.ingestion_runs WHERE shop_id=$1 AND dataset='products'",[s.session.shop])).rows[0];
    await pool.query('UPDATE mirror.catalog_import_jobs SET cancel_requested=true WHERE id=$1',[job.id]);
    await assert.rejects(()=>createSyncRunService({database:pool}).bindBulkOperationId({shopId:s.session.shop,runId:child.id,fence:child.fence,bulkOperationId:s.operationId}));
    await runtime.processOne();assert.equal((await state(job.id)).cancel_requested,true);
  });
  await t.test('lost start binding is recovered only from the immutable response operation identity',async()=>{
    const s=fixture('phase-bind-recovery');let fail=true;
    const interruptedDatabase={query:pool.query.bind(pool),async connect(){const client=await pool.connect();return {
      query(text,values){
        if(fail&&text.includes('UPDATE mirror.ingestion_runs SET bulk_operation_id=$3')){
          fail=false;throw Object.assign(new Error('Binding failed after exact response was persisted'),{code:'INJECTED'});
        }
        return client.query(text,values);
      },release:client.release.bind(client),
    };}};
    const interrupted=await createCatalogPhaseRuntime({...options,database:interruptedDatabase});
    const interruptedService=createCatalogImportService({...options,database:interruptedDatabase,phaseRuntime:interrupted});
    const job=await interruptedService.enqueue(s.session);
    // Even the final ordinary claim must retain an independent recovery path.
    await pool.query('UPDATE mirror.catalog_import_executions SET attempt=11,fence=11 WHERE id=$1',[job.id]);
    assert.equal((await interrupted.processOne()).kind,'RECOVERY_REQUIRED');
    assert.equal((await state(job.id)).attempt,12);assert.equal((await state(job.id)).review_required,false);
    assert.equal((await pool.query("SELECT bulk_operation_id FROM mirror.ingestion_runs WHERE shop_id=$1 AND dataset='products'",[s.session.shop])).rows[0].bulk_operation_id,null);
    await makeDue(job.id);const before=s.polls;await runtime.processOne();assert.equal(s.polls,before+1);
    assert.equal((await state(job.id)).outcome_uncertain,false);
    assert.ok((await drain(job.id)).completed_at);assert.equal(s.starts,1);
    await assert.rejects(()=>pool.query("UPDATE mirror.sync_external_operations SET input_hash='forged' WHERE run_id=$1",[job.id]),{code:'23514'});
    await assert.rejects(()=>pool.query("UPDATE mirror.sync_external_operations SET operation_id='gid://shopify/BulkOperation/999999' WHERE run_id=$1",[job.id]),{code:'23514'});
  });
  await t.test('expired last claims recover before replay and repeated crashes eventually require review',async()=>{
    const s=fixture('phase-crashes');const job=await service.enqueue(s.session);
    for(let i=0;i<8;i++) {
      await pool.query(`UPDATE mirror.catalog_import_executions SET lease_token='crashed',worker_id='crashed',fence=fence+1,
        lease_until=clock_timestamp()-interval '1 second',attempt=12 WHERE id=$1`,[job.id]);
      const result=await runtime.processOne();assert.equal(result.kind,'RESUMED');
    }
    await pool.query(`UPDATE mirror.catalog_import_executions SET lease_token='crashed',worker_id='crashed',fence=fence+1,
      lease_until=clock_timestamp()-interval '1 second',attempt=12 WHERE id=$1`,[job.id]);
    await runtime.processOne();assert.equal((await state(job.id)).review_required,true);assert.equal(s.starts,0);
    await service.cancel(s.session,job.id);await runtime.processOne();
  });
  await t.test('cancellation cleanup is rediscovered after a crash and a cancelled generation cannot publish',async()=>{
    const s=fixture('phase-cancel-recovery');const job=await service.enqueue(s.session);await runtime.processOne();
    await service.cancel(s.session,job.id);
    await pool.query(`UPDATE mirror.catalog_import_executions SET cancel_requested=true,lease_token='crashed',worker_id='cancel',
      lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,[job.id]);
    await runtime.processOne();const row=await state(job.id);assert.ok(row.cancel_completed_at);
    assert.equal((await pool.query('SELECT status FROM mirror.generations WHERE shop_id=$1 AND id=$2',[s.session.shop,job.generationId])).rows[0].status,'FAILED');
    assert.equal((await pool.query('SELECT count(*) FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0].count,'0');
  });
  await t.test('cancellation ownership is fenced through remote cleanup and uncertain remote cancels reconcile before completion',async()=>{
    const s=fixture('phase-cancel-fence');const job=await service.enqueue(s.session);await runtime.processOne();
    await service.cancel(s.session,job.id);
    // CAT-003: failed/timed-out remote cancel persists REMOTE_CANCEL_OUTCOME_UNKNOWN without completing cancellation.
    s.failCancel=true;
    const pendingCancel=await runtime.processOne();
    assert.equal(pendingCancel.kind,'CANCEL_PENDING');
    const uncertainRow=await state(job.id);
    assert.equal(uncertainRow.cancel_completed_at,null);
    assert.equal(uncertainRow.outcome_uncertain,true);
    assert.equal(uncertainRow.last_error,'REMOTE_CANCEL_OUTCOME_UNKNOWN');
    assert.equal((await pool.query('SELECT status FROM mirror.generations WHERE shop_id=$1 AND id=$2',[s.session.shop,job.generationId])).rows[0].status,'FAILED');
    // CAT-002: if another worker supersedes fence/lease_token during cleanup, stale worker returns STALE_CLAIM.
    s.failCancel=false;
    s.remoteStatus='CANCELLED';
    s.onCancel=async()=>{
      await pool.query("UPDATE mirror.catalog_import_executions SET fence=fence+1,lease_token='superseded' WHERE id=$1",[job.id]);
    };
    await pool.query("UPDATE mirror.catalog_import_executions SET outcome_uncertain=false,last_error=NULL,next_eligible_at=clock_timestamp() WHERE id=$1",[job.id]);
    const staleResult=await runtime.processOne();
    assert.equal(staleResult.kind,'STALE_CLAIM');
    assert.equal((await state(job.id)).cancel_completed_at,null);
    // Next pass reconciles remote CANCELLED status via BULK_STATUS_QUERY and completes cancellation.
    s.onCancel=null;
    await pool.query("UPDATE mirror.catalog_import_executions SET outcome_uncertain=true,last_error='REMOTE_CANCEL_OUTCOME_UNKNOWN',lease_token=NULL,lease_until=NULL,next_eligible_at=clock_timestamp() WHERE id=$1",[job.id]);
    const cancelsBefore=s.cancels;
    const completedCancel=await runtime.processOne();
    assert.equal(completedCancel.kind,'CANCELLED');
    assert.equal(s.cancels,cancelsBefore);
    const finalRow=await state(job.id);
    assert.ok(finalRow.cancel_completed_at);
    assert.equal(finalRow.outcome_uncertain,false);
    assert.equal(finalRow.last_error,null);
  });
  await t.test('phaseRuntime.enqueue acquires a shop-scoped row lock and rejects concurrent double-enqueue',async()=>{
    const s=fixture('phase-double-enqueue');
    await pool.query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,'v1') ON CONFLICT(id) DO NOTHING",[s.session.shop]);
    const outcomes=await Promise.allSettled([
      runtime.enqueue({shopId:s.session.shop,installationVersion:'v1'}),
      runtime.enqueue({shopId:s.session.shop,installationVersion:'v1'}),
    ]);
    const winners=outcomes.filter(o=>o.status==='fulfilled');
    assert.equal(winners.length,1);
    assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);
    assert.equal((await pool.query('SELECT count(*) FROM mirror.generations WHERE shop_id=$1',[s.session.shop])).rows[0].count,'1');
    assert.equal((await pool.query('SELECT count(*) FROM mirror.catalog_import_jobs WHERE shop_id=$1',[s.session.shop])).rows[0].count,'1');
    assert.ok((await drain(winners[0].value.id)).completed_at);
  });
  await t.test('an installation change cancels and fences persisted work before any new Shopify call',async()=>{
    const s=fixture('phase-installation');const job=await service.enqueue(s.session);
    await pool.query("UPDATE mirror.shops SET installation_version='replacement' WHERE id=$1",[s.session.shop]);
    await runtime.processOne();assert.equal((await state(job.id)).cancel_requested,true);assert.equal(s.starts,0);
  });
  await t.test('concurrent production runtimes never issue duplicate starts for the same durable job',async()=>{
    const s=fixture('phase-concurrent');const job=await service.enqueue(s.session);
    const second=await createCatalogPhaseRuntime(options);
    await Promise.all([runtime.processOne(),second.processOne()]);
    assert.equal(s.starts,1);assert.ok((await drain(job.id)).completed_at);
  });
  await t.test('publication committed before a cancellation is acknowledged as completed',async()=>{
    const s=fixture('phase-late-cancel');const job=await service.enqueue(s.session);const done=await drain(job.id);
    assert.ok(done.completed_at);
    // Reproduce the gap between publishing and recording COMPLETE.
    await pool.query(`UPDATE mirror.catalog_import_executions SET completed_at=NULL WHERE id=$1`,[job.id]);
    s.denyAuthorization=true;const authorizations=s.authorizations;
    assert.equal((await runtime.processOne()).kind,'COMPLETE');assert.equal(s.authorizations,authorizations);
    await pool.query(`UPDATE mirror.catalog_import_executions SET completed_at=NULL WHERE id=$1`,[job.id]);
    await service.cancel(s.session,job.id);const result=await runtime.processOne();assert.equal(result.kind,'COMPLETE');
    assert.ok((await state(job.id)).completed_at);assert.equal((await service.status(s.session,job.id)).status,'SUCCEEDED');
    assert.equal((await pool.query('SELECT generation_id FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0].generation_id,job.generationId);
  });
  await t.test('the final failed recovery reports review and preserves uncertainty durably',async()=>{
    const s=fixture('phase-recovery-exhausted');const job=await service.enqueue(s.session);await runtime.processOne();
    await pool.query(`UPDATE mirror.catalog_import_executions SET outcome_uncertain=true,recovery_attempts=7,
      next_eligible_at=clock_timestamp() WHERE id=$1`,[job.id]);
    s.failStatus=true;
    assert.equal((await runtime.processOne()).kind,'REVIEW_REQUIRED');
    const row=await state(job.id);assert.equal(row.recovery_attempts,8);assert.equal(row.outcome_uncertain,true);
    assert.equal(row.review_required,true);assert.equal(row.lease_token,null);
    assert.equal((await service.status(s.session,job.id)).status,'FAILED');assert.equal(s.starts,1);
  });
  await t.test('shutdown aborts recovery verification and late responses cannot resume execution',async()=>{
    const s=fixture('phase-recovery-shutdown');const job=await service.enqueue(s.session);await runtime.processOne();
    await pool.query(`UPDATE mirror.catalog_import_executions SET outcome_uncertain=true,next_eligible_at=clock_timestamp() WHERE id=$1`,[job.id]);
    const started=Promise.withResolvers(),pending=Promise.withResolvers();s.onStatus=()=>{started.resolve();return pending.promise;};
    const recovering=processJob(job.id);await started.promise;const stopped=runtime.stop();
    assert.equal((await recovering).kind,'RECOVERY_DEFERRED');
    assert.equal((await state(job.id)).last_error,'VERIFICATION_ABORTED');
    s.onStatus=null;pending.resolve();await stopped;
    assert.equal((await state(job.id)).outcome_uncertain,true);
    runtime.start();assert.equal((await processJob(job.id)).kind,'RESUMED');
    assert.ok((await drain(job.id)).completed_at);assert.equal(s.starts,1);
  });
  await t.test('a second recovery runtime cannot verify or consume another attempt while the first owns the lease',async()=>{
    const s=fixture('phase-recovery-concurrent');const job=await service.enqueue(s.session);await runtime.processOne();
    await pool.query(`UPDATE mirror.catalog_import_executions SET outcome_uncertain=true,next_eligible_at=clock_timestamp() WHERE id=$1`,[job.id]);
    const started=Promise.withResolvers(),pending=Promise.withResolvers();let verifications=0;
    s.onStatus=()=>{verifications++;started.resolve();return pending.promise;};
    const recovering=processJob(job.id);await started.promise;
    const second=await createCatalogPhaseRuntime(options);assert.equal(await second.processOne(),null);
    assert.equal((await state(job.id)).recovery_attempts,1);assert.equal(verifications,1);
    s.onStatus=null;pending.resolve();assert.equal((await recovering).kind,'RESUMED');
    assert.ok((await drain(job.id)).completed_at);assert.equal(s.starts,1);
  });
  await testSyncRecoveryRepository(t,{pool,fixture,service,runtime,state,makeDue,drain,processJob});
  }finally{await enginePool.end();await pool.query('DROP OWNED BY phase_engine_runtime');await pool.query('DROP ROLE phase_engine_runtime');}
}
