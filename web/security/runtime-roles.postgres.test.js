import {createSchedulesService} from '../services/schedules.server.js';
import {WRITE_CAPABILITY_VERSION} from '../fields/write-capabilities.js';
import {createJsonlIngestionService} from '../mirror/jsonl-ingestion.server.js';
import {createSyncRunService} from '../mirror/sync-run-service.server.js';
import {createReconciliationService} from '../mirror/reconciliation-service.server.js';
import {createBulkSyncService,PRODUCTS_BULK_QUERY} from '../mirror/bulk-sync.server.js';
import {createHash} from 'node:crypto';
import {product} from '../mirror/integration/sync-hardening.js';
import {createVerifiedRuntimePool,verifyRuntimeDatabase} from './runtime-database.server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {createRestrictedRuntimeProfiles} from './test-support/restricted-runtime.js';
import {testTenantDatabase} from './tenant-db.integration.js';
import {inspectHistoryDatabasePrivileges} from '../edit-history/database-security.server.js';

/** All writes target the runner's disposable localhost database; never app env. */
test('actual merchant, worker and history roles enforce RLS and rollback',async t=>{
 const target=process.env.FILTER_TEST_DATABASE_URL;
 assert.equal(process.env.FILTER_TEST_DATABASE_ISOLATED,'1','Use npm run test:roles:postgres');
 const url=new URL(target);assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/metamax_filter_test');
 const admin=new pg.Pool({connectionString:target});let profiles,history;
 const login='history_rls_'+randomUUID().replaceAll('-',''),password=randomUUID();
 const shop='role-a.myshopify.com',other='role-b.myshopify.com',installation=randomUUID();
 try{
  const root=new URL('../prisma/migrations/',import.meta.url);
  for(const name of (await readdir(root)).filter(n=>/^\d+_/.test(n)).sort())await admin.query(await readFile(new URL(name+'/migration.sql',root),'utf8'));
  await t.test('incremental export policy repair restores RLS without broadening existing grants',async()=>{
   const repair=await readFile(new URL('../prisma/migrations/20261101001100_complete_export_tenant_policies/migration.sql',import.meta.url),'utf8');
   await admin.query('DROP POLICY metamax_tenant_isolation ON export_engine.jobs; ALTER TABLE export_engine.jobs DISABLE ROW LEVEL SECURITY; DROP POLICY metamax_tenant_isolation ON export_engine.target_approvals; ALTER TABLE export_engine.target_approvals DISABLE ROW LEVEL SECURITY');
   await admin.query(repair);await admin.query(repair);
   const rows=(await admin.query("SELECT c.relname,c.relrowsecurity,count(p.oid)::int AS policies FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_policy p ON p.polrelid=c.oid AND p.polname='metamax_tenant_isolation' WHERE n.nspname='export_engine' AND c.relname IN('jobs','target_approvals') GROUP BY c.oid ORDER BY c.relname")).rows;
   assert.equal(rows.length,2);for(const row of rows){assert.equal(row.relrowsecurity,true);assert.equal(row.policies,1);}
  });
  await t.test('incompatible export policy aborts repair without partial RLS changes',async()=>{
   const repair=await readFile(new URL('../prisma/migrations/20261101001100_complete_export_tenant_policies/migration.sql',import.meta.url),'utf8');
   const tx=await admin.connect();try{
    await tx.query('ALTER TABLE export_engine.jobs DISABLE ROW LEVEL SECURITY; DROP POLICY metamax_tenant_isolation ON export_engine.target_approvals; CREATE POLICY metamax_tenant_isolation ON export_engine.target_approvals USING(true) WITH CHECK(true)');
    await assert.rejects(()=>tx.query(repair),{code:'55000'});await tx.query('ROLLBACK');
    assert.equal((await tx.query("SELECT relrowsecurity FROM pg_class WHERE oid='export_engine.jobs'::regclass")).rows[0].relrowsecurity,false);
   }finally{
    await tx.query('ROLLBACK');await tx.query('DROP POLICY metamax_tenant_isolation ON export_engine.target_approvals');await tx.query(repair);tx.release();
   }
  });
  profiles=await createRestrictedRuntimeProfiles(admin,target);
  await t.test('run lookup and due scanner work under tenant-only RLS without leaking pooled scope',async()=>{
   const shopId='sync-read-a.myshopify.com',otherShop='sync-read-b.myshopify.com';
   await admin.query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,'read-install'),($2,'read-install')",[shopId,otherShop]);
   const writer=createSyncRunService({database:profiles.catalogWorker});
   const run=await writer.startIngestionRun({shopId,workerId:'read-worker'});
   const otherRun=await writer.startIngestionRun({shopId:otherShop,workerId:'read-worker'});
   await admin.query(`INSERT INTO mirror.catalog_changes(shop_id,product_id,revision,applied_revision,dirty,next_attempt_at,lease_until,dead_letter_at,updated_at)
    VALUES($1,'gid://shopify/Product/1',3,1,true,NULL,NULL,NULL,now()),
     ($1,'gid://shopify/Product/2',3,1,true,now()-interval '1 hour',NULL,NULL,now()),
     ($1,'gid://shopify/Product/3',3,1,true,now()+interval '1 hour',NULL,NULL,now()),
     ($1,'gid://shopify/Product/4',3,1,true,NULL,now()+interval '1 hour',NULL,now()),
     ($1,'gid://shopify/Product/5',3,1,true,NULL,NULL,now(),now()),
     ($1,'gid://shopify/Product/6',3,3,false,NULL,NULL,NULL,now()),
     ($2,'gid://shopify/Product/7',3,1,true,NULL,NULL,NULL,now())`,[shopId,otherShop]);
   const login='sync_read_'+randomUUID().replaceAll('-',''),password=randomUUID();
   await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
   await admin.query(`GRANT USAGE ON SCHEMA mirror TO ${login}; GRANT SELECT ON mirror.publications,mirror.ingestion_runs,mirror.catalog_changes TO ${login}`);
   const readUrl=new URL(target);readUrl.username=login;readUrl.password=password;
   const database=new pg.Pool({connectionString:readUrl.href,max:1});
   try {
    assert.equal((await database.query('SELECT id FROM mirror.ingestion_runs')).rowCount,0);
    assert.equal((await database.query('SELECT product_id FROM mirror.catalog_changes')).rowCount,0);
    const sync=createSyncRunService({database}),rec=createReconciliationService({database});
    assert.equal(String((await sync.getSyncRun({shopId,runId:run.runId})).runId),String(run.runId));
    assert.equal(await sync.getSyncRun({shopId,runId:otherRun.runId}),null);
    assert.equal(String((await sync.getSyncRun({shopId:otherShop,runId:otherRun.runId})).runId),String(otherRun.runId));
    const due=await rec.scanDueDirtyProducts({shopId});
    assert.deepEqual(due.map(row=>row.productId),['gid://shopify/Product/1','gid://shopify/Product/2']);
    assert.equal(due[0].revision,3n);assert.equal(due[0].appliedRevision,1n);assert.equal(due[0].fence,0n);
    assert.equal((await rec.scanDueDirtyProducts({shopId,limit:1})).length,1);
    assert.deepEqual((await rec.scanDueDirtyProducts({shopId:otherShop})).map(row=>row.productId),['gid://shopify/Product/7']);
    assert.equal((await database.query('SELECT id FROM mirror.ingestion_runs')).rowCount,0);
    assert.equal((await database.query('SELECT product_id FROM mirror.catalog_changes')).rowCount,0);
    // Discovery must not claim, acknowledge or alter retry eligibility.
    const unchanged=(await admin.query("SELECT revision,applied_revision,dirty,fence,lease_token FROM mirror.catalog_changes WHERE shop_id=$1 AND product_id='gid://shopify/Product/1'",[shopId])).rows[0];
    assert.equal(unchanged.revision,'3');assert.equal(unchanged.applied_revision,'1');assert.equal(unchanged.dirty,true);assert.equal(unchanged.fence,'0');assert.equal(unchanged.lease_token,null);
   } finally {
    await database.end();await admin.query(`DROP OWNED BY ${login}`);await admin.query(`DROP ROLE ${login}`);
   }
  });
  await t.test('checkpoint replay reads persisted chunks under the restricted catalog role tenant scope',async()=>{
   const shopId='checkpoint-role.myshopify.com',id='gid://shopify/BulkOperation/901';
   await admin.query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,'checkpoint-install')",[shopId]);
   const sync=createSyncRunService({database:profiles.catalogWorker});
   const run=await sync.startIngestionRun({shopId,workerId:'checkpoint-worker'});
   const record=product(901,[]),{variants,...flat}=record;
   const checksum=createHash('sha256').update(JSON.stringify([record])).digest('hex');
   await admin.query('INSERT INTO mirror.ingestion_chunks(shop_id,run_id,ordinal,checksum,line_count) VALUES($1,$2,0,$3,1)',[shopId,run.runId,checksum]);
   // The deployed catalog role intentionally has a global control-plane policy.
   // A narrower actual LOGIN proves compatibility with tenant-only checkpoint RLS.
   assert.equal((await profiles.catalogWorker.query('SELECT ordinal FROM mirror.ingestion_chunks WHERE run_id=$1',[run.runId])).rowCount,1);
   const login='checkpoint_'+randomUUID().replaceAll('-',''),password=randomUUID();
   await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
   await admin.query(`GRANT USAGE ON SCHEMA mirror TO ${login}; GRANT SELECT ON mirror.ingestion_chunks,mirror.publications TO ${login}`);
   const checkpointUrl=new URL(target);checkpointUrl.username=login;checkpointUrl.password=password;
   const checkpointDatabase=new pg.Pool({connectionString:checkpointUrl.href,max:1});
   try {
   assert.equal((await checkpointDatabase.query('SELECT ordinal FROM mirror.ingestion_chunks WHERE run_id=$1',[run.runId])).rowCount,0);
   let completed=false;
   const service=createJsonlIngestionService({database:checkpointDatabase,
    ingestionWriter:{writeStagingBatch(){assert.fail('Durable checkpoint must be replayed, not rewritten');}},
    bulkSyncService:{getStatus:async()=>({id,status:'COMPLETED',objectCount:'1'})},
    syncRunService:{getSyncRun:async()=>({...run,bulkOperationId:id}),
     async completeIngestionRun(){completed=true;},async transitionGenerationToReconciling(){}}});
   const result=await service.ingestJsonlLines({shopId,generationId:run.generationId,runId:run.runId,fence:run.fence,lines:[JSON.stringify(flat)]});
   assert.equal(result.succeeded,true);assert.equal(completed,true);
   assert.equal((await checkpointDatabase.query('SELECT ordinal FROM mirror.ingestion_chunks WHERE run_id=$1',[run.runId])).rowCount,0);
   } finally {
    await checkpointDatabase.end();await admin.query(`DROP OWNED BY ${login}`);await admin.query(`DROP ROLE ${login}`);
   }
  });
  await t.test('legacy bulk intent fences concurrent starts and recovers exact evidence after lease replacement',async()=>{
   const shopId='bulk-intent-role.myshopify.com',id='gid://shopify/BulkOperation/902';
   await admin.query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,'bulk-intent-install')",[shopId]);
   const sync=createSyncRunService({database:profiles.catalogWorker});
   let run=await sync.startIngestionRun({shopId,workerId:'bulk-intent-worker'}),sends=0;
   const service=createBulkSyncService({syncRunService:sync,shopifyClient:{async request(query){
    if(query.includes('StartBulkOperation')){sends++;throw Error('Remote response lost');}
    return {data:{bulkOperation:{id,status:'RUNNING'}}};
   }}});
   const attempts=await Promise.allSettled([service.startBulkQuery({shopId,syncRun:run}),service.startBulkQuery({shopId,syncRun:run})]);
   assert.equal(sends,1);for(const result of attempts){assert.equal(result.status,'rejected');assert.equal(result.reason.outcomeUncertain,true);}
   const dispatchFence=run.fence,inputHash=createHash('sha256').update(PRODUCTS_BULK_QUERY).digest('hex');
   await sync.failIngestionRun({shopId,runId:run.runId,fence:run.fence,error:Error('retry')});
   run=await sync.startIngestionRun({shopId,workerId:'bulk-intent-worker-next'});
   await assert.rejects(()=>service.startBulkQuery({shopId,syncRun:run}),{code:'OUTCOME_UNKNOWN'});assert.equal(sends,1);
   // A late exact response can save evidence, but cannot acknowledge the newer run.
   await sync.recordBulkStartResponse({shopId,runId:run.runId,dispatchFence,inputHash,bulkOperationId:id});
   assert.equal((await sync.getSyncRun({shopId,runId:run.runId})).bulkOperationId,null);
   assert.equal((await service.startBulkQuery({shopId,syncRun:run})).id,id);assert.equal(sends,1);
   assert.equal((await sync.getSyncRun({shopId,runId:run.runId})).bulkOperationId,id);
   await assert.rejects(()=>sync.recordBulkStartResponse({shopId,runId:run.runId,dispatchFence,inputHash,bulkOperationId:'gid://shopify/BulkOperation/999'}),{code:'OUTCOME_UNKNOWN'});
  });
  await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await admin.query(`GRANT metamax_history_runtime TO ${login}`);
  const historyUrl=new URL(target);historyUrl.username=login;historyUrl.password=password;
  history=new pg.Pool({connectionString:historyUrl.href,max:1});
  await admin.query('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$3),($2,$3)',[shop,other,installation]);
  await admin.query(`INSERT INTO mirror.saved_filters(shop_id,id,name,ast_version,ast,fingerprint,updated_at)
   VALUES($1,'seed','A',1,'{}','fixture',now()),($2,'seed','B',1,'{}','fixture',now())`,[shop,other]);
  for(const tenant of [shop,other])await admin.query(`INSERT INTO edit_history.operations(id,shop_id,installation_id,execution_job_id,operation_kind,execution_fingerprint)
   VALUES($1,$2,$3,1,'BULK_EDIT',$4)`,[randomUUID(),tenant,installation,'sha256:'+'a'.repeat(64)]);
  await t.test('all application profiles are genuine non-owner NOBYPASSRLS logins',async()=>{
   for(const db of [profiles.merchant,profiles.catalogWorker,profiles.operationWorker,history]){
    const state=(await db.query('SELECT current_user AS name,rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(state.rolsuper,false);assert.equal(state.rolbypassrls,false);assert.equal(state.rolcanlogin,true);assert.notEqual(state.name,'postgres');
   }
   assert.deepEqual(await inspectHistoryDatabasePrivileges(history),{profile:'runtime',verified:true,findings:[]});
  });
  await t.test('merchant scope is initialized inside the transaction and never leaks after commit',async()=>{
   assert.equal((await profiles.merchant.query('SELECT id FROM mirror.saved_filters')).rowCount,0);
   const tx=await profiles.merchant.connect();try{
    await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true)",[shop]);
    assert.deepEqual((await tx.query('SELECT shop_id FROM mirror.saved_filters')).rows,[{shop_id:shop}]);
    await tx.query('COMMIT');assert.equal((await tx.query('SELECT id FROM mirror.saved_filters')).rowCount,0);
    await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true)",[other]);
    assert.deepEqual((await tx.query('SELECT shop_id FROM mirror.saved_filters')).rows,[{shop_id:other}]);await tx.query('ROLLBACK');
   }finally{await tx.query('ROLLBACK');tx.release();}
  });
  await t.test('denied cross-shop insert rolls back an earlier permitted merchant write',async()=>{
   const tx=await profiles.merchant.connect();try{
    await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true)",[shop]);
    const insert=`INSERT INTO mirror.saved_filters(shop_id,id,name,ast_version,ast,fingerprint,updated_at) VALUES($1,$2,'rollback',1,'{}','fixture',now())`;
    await tx.query(insert,[shop,'must-rollback']);await assert.rejects(()=>tx.query(insert,[other,'denied']),{code:'42501'});
    await assert.rejects(()=>tx.query('SELECT 1'),{code:'25P02'});await tx.query('ROLLBACK');
   }finally{tx.release();}
   assert.equal((await admin.query("SELECT 1 FROM mirror.saved_filters WHERE id IN('must-rollback','denied')")).rowCount,0);
   assert.equal((await profiles.merchant.query('SELECT id FROM mirror.saved_filters')).rowCount,0);
  });
  await t.test('catalog reinstall cleanup has only scoped subscription deletion and rolls back',async()=>{
   await admin.query('INSERT INTO mirror.subscriptions(shop_id,installation_version,updated_at) VALUES($1,$3,now()),($2,$3,now())',[shop,other,installation]);
   const tx=await profiles.catalogWorker.connect();try{
    await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true)",[shop]);
    assert.equal((await tx.query('DELETE FROM mirror.subscriptions WHERE shop_id=$1',[other])).rowCount,0);
    assert.equal((await tx.query('DELETE FROM mirror.subscriptions WHERE shop_id=$1',[shop])).rowCount,1);
    await tx.query('ROLLBACK');
    await assert.rejects(()=>tx.query('SELECT plan_handle FROM mirror.subscriptions LIMIT 0'),{code:'42501'});
    await assert.rejects(()=>tx.query("UPDATE mirror.subscriptions SET status='ACTIVE' WHERE false"),{code:'42501'});
   }finally{await tx.query('ROLLBACK');tx.release();}
   assert.equal((await admin.query('SELECT 1 FROM mirror.subscriptions WHERE shop_id=ANY($1)',[[shop,other]])).rowCount,2);
  });
  await t.test('catalog and operation workers cannot cross their write domains',async()=>{
   await assert.rejects(()=>profiles.catalogWorker.query("UPDATE mirror.job_commands SET status='FAILED' WHERE false"),{code:'42501'});
   await assert.rejects(()=>profiles.operationWorker.query("UPDATE mirror.products SET title='denied' WHERE false"),{code:'42501'});
   await assert.rejects(()=>profiles.operationWorker.query('SELECT value_json FROM edit_history.snapshots LIMIT 0'),{code:'42501'});
   await assert.rejects(()=>profiles.merchant.query("UPDATE mirror.job_commands SET lease_token='forged' WHERE false"),{code:'42501'});
  });
  await t.test('operation worker scheduling privileges preserve immutable approvals and durable records',async()=>{
   const db=profiles.operationWorker;
   for(const sql of [
    "UPDATE mirror.execution_contracts SET status='APPROVED' WHERE false",
    "UPDATE mirror.execution_contracts SET contract='{}'::jsonb WHERE false",
    'DELETE FROM mirror.execution_contracts WHERE false',
    'DELETE FROM mirror.job_commands WHERE false',
    'INSERT INTO mirror.job_commands DEFAULT VALUES',
    'DELETE FROM mirror.schedule_occurrences WHERE false',
    "UPDATE mirror.job_schedules SET template='{}'::jsonb WHERE false",
    'DELETE FROM mirror.job_schedules WHERE false',
   ])await assert.rejects(()=>db.query(sql),{code:'42501'});
   assert.equal((await db.query('UPDATE mirror.execution_contracts SET _history_lock=_history_lock WHERE false')).rowCount,0);
   assert.equal((await db.query('UPDATE mirror.job_schedules SET next_run_at=next_run_at,fence=fence WHERE false')).rowCount,0);
   const grants=(await db.query(`SELECT
     has_table_privilege(current_user,'mirror.job_commands','INSERT') AS command_insert,
     has_table_privilege(current_user,'mirror.job_commands','UPDATE') AS command_update,
     has_table_privilege(current_user,'mirror.execution_contracts','INSERT') AS approval_insert,
     has_table_privilege(current_user,'mirror.job_schedules','INSERT') AS schedule_insert`)).rows[0];
   assert.deepEqual(grants,{command_insert:false,command_update:true,approval_insert:false,schedule_insert:false});
   await admin.query('GRANT INSERT ON mirror.job_commands TO metamax_operation_worker');
   try{
    await assert.rejects(()=>verifyRuntimeDatabase(db,{profile:'operationWorker'}),/Operation worker must not create commands/);
   }finally{await admin.query('REVOKE INSERT ON mirror.job_commands FROM metamax_operation_worker');}
   assert.equal((await verifyRuntimeDatabase(db,{profile:'operationWorker'})).runtimeProfile,'metamax_operation_worker');
  });
  await t.test('history reads require transaction tenant scope and immutable fields stay denied',async()=>{
   assert.equal((await history.query('SELECT id FROM edit_history.operations')).rowCount,0);
   const tx=await history.connect();try{
    await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true),set_config('app.installation_id',$2,true)",[shop,installation]);
    assert.deepEqual((await tx.query('SELECT shop_id FROM edit_history.operations')).rows,[{shop_id:shop}]);
    assert.equal((await tx.query('SELECT id FROM edit_history.operations WHERE shop_id=$1',[other])).rowCount,0);
    await tx.query('SAVEPOINT allowed');
    await assert.rejects(()=>tx.query('UPDATE edit_history.operations SET execution_fingerprint=execution_fingerprint WHERE false'),{code:'42501'});
    await tx.query('ROLLBACK TO SAVEPOINT allowed');await tx.query('COMMIT');
    assert.equal((await tx.query('SELECT id FROM edit_history.operations')).rowCount,0);
    await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true),set_config('app.installation_id',$2,true)",[other,installation]);
    assert.deepEqual((await tx.query('SELECT shop_id FROM edit_history.operations')).rows,[{shop_id:other}]);await tx.query('ROLLBACK');
   }finally{await tx.query('ROLLBACK');tx.release();}
  });
  const secondScheduleInstallation=randomUUID();
  await admin.query('DELETE FROM mirror.subscriptions WHERE shop_id=$1',[other]);
  await admin.query('UPDATE mirror.shops SET installation_version=$2 WHERE id=$1',[other,secondScheduleInstallation]);
  const contexts=new WeakMap(),contextA=Object.freeze({}),contextB=Object.freeze({});
  contexts.set(contextA,shop);contexts.set(contextB,other);
  const resolveScheduleShop=async context=>{const value=contexts.get(context);assert.ok(value,'Opaque test authentication required');return value;};
  const schedules=createSchedulesService({database:profiles.merchant,workerDatabase:profiles.operationWorker,resolveShop:resolveScheduleShop});
  const scheduledFor=new Date(),template={selectionMode:'EXPLICIT',productIds:['1'],contractPayload:{writeCapabilityVersion:WRITE_CAPABILITY_VERSION,updates:{title:'Scheduled'}}};
  let scheduleA,scheduleB;
  await t.test('schedule merchant operations are scoped and a merchant cannot invoke global discovery',async()=>{
   scheduleA=await schedules.createSchedule({authContext:contextA,firstRunAt:scheduledFor,template});
   scheduleB=await schedules.createSchedule({authContext:contextB,firstRunAt:scheduledFor,template});
   assert.deepEqual((await schedules.listSchedules({authContext:contextA})).map(row=>row.id),[scheduleA.id]);
   assert.deepEqual((await schedules.listSchedules({authContext:contextB})).map(row=>row.id),[scheduleB.id]);
   assert.equal((await profiles.merchant.query('SELECT id FROM mirror.job_schedules')).rowCount,0);
   await assert.rejects(()=>schedules.createSchedule({authContext:contextA,shopId:other,template}),{code:'FIELD_PERMISSION_DENIED'});
   const merchantScanner=createSchedulesService({database:profiles.merchant,workerDatabase:profiles.merchant,resolveShop:resolveScheduleShop});
   await assert.rejects(()=>merchantScanner.triggerDueSchedules({now:scheduledFor}),/Issued operationWorker database gateway required/);
  });
  await t.test('mixed-tenant schedule discovery rolls back occurrences and due-time updates together',async()=>{
   let inserts=0;
   const failingWorker=createVerifiedRuntimePool({async connect(){const client=await profiles.operationWorker.connect();return{
    async query(sql,values){if(sql.includes('INSERT INTO mirror.schedule_occurrences')&&++inserts===2)throw Error('Injected second occurrence failure');return client.query(sql,values);},
    release:error=>client.release(error),
   };}},{profile:'operationWorker'});
   const scanner=createSchedulesService({database:profiles.merchant,workerDatabase:failingWorker,resolveShop:resolveScheduleShop});
   await assert.rejects(()=>scanner.triggerDueSchedules({now:scheduledFor}),/Injected second occurrence failure/);
   assert.equal((await admin.query('SELECT id FROM mirror.schedule_occurrences WHERE schedule_id=ANY($1::bigint[])',[[scheduleA.id,scheduleB.id]])).rowCount,0);
   const rows=(await admin.query('SELECT next_run_at,fence FROM mirror.job_schedules WHERE id=ANY($1::bigint[])',[[scheduleA.id,scheduleB.id]])).rows;
   for(const row of rows){assert.equal(new Date(row.next_run_at).getTime(),scheduledFor.getTime());assert.equal(String(row.fence),'0');}
  });
  await t.test('concurrent global workers discover both tenants once and initialize each occurrence installation',async()=>{
   const batches=await Promise.all([schedules.triggerDueSchedules({now:scheduledFor}),schedules.triggerDueSchedules({now:scheduledFor})]);
   assert.equal(batches.flat().length,2);assert.equal(new Set(batches.flat().map(row=>row.id)).size,2);
   const rows=(await profiles.operationWorker.query('SELECT shop_id,installation_version FROM mirror.schedule_occurrences ORDER BY shop_id')).rows;
   assert.deepEqual(rows,[{shop_id:shop,installation_version:installation},{shop_id:other,installation_version:secondScheduleInstallation}]);
   assert.equal((await profiles.merchant.query('SELECT id FROM mirror.schedule_occurrences')).rowCount,0);
   const scope=(await profiles.operationWorker.query("SELECT current_setting('app.shop_id',true) AS shop")).rows[0].shop;
   assert.ok(scope!==shop&&scope!==other);
   const foreign=batches.flat().find(row=>row.shop_id===other);
   assert.equal(await schedules.cancelOccurrence({authContext:contextA,occurrenceId:foreign.id}),false);
   await admin.query('UPDATE mirror.job_schedules SET enabled=false WHERE id=ANY($1::bigint[])',[[scheduleA.id,scheduleB.id]]);
  });
  await t.test('global claim commits before merchant authorization and failure persistence fences superseded workers',async()=>{
   let called=0,lastClaim,supersede=false;
   const runner=createSchedulesService({database:profiles.merchant,workerDatabase:profiles.operationWorker,resolveShop:resolveScheduleShop,
    selectionService:{withSelectionTransaction(){assert.fail('Selection before authorization');}},
    approvalService:{approveContract(){assert.fail('Approval before authorization');}},jobDispatchService:{dispatchBulkEdit(){assert.fail('Dispatch before authorization');}},
    getScheduleAuthContext:async input=>{
     called++;lastClaim=input;
     const row=(await admin.query('SELECT status,lease_token FROM mirror.schedule_occurrences WHERE shop_id=$1 AND id=$2',[input.shopId,input.occurrenceId])).rows[0];
     assert.equal(row.status,'RUNNING');assert.ok(row.lease_token);
     if(supersede)await admin.query("UPDATE mirror.schedule_occurrences SET fence=fence+1,lease_token='new-owner' WHERE shop_id=$1 AND id=$2",[input.shopId,input.occurrenceId]);
     throw Error('Current credentials unavailable');
    },logger:{error(){}},
   });
   assert.equal((await runner.processNextOccurrence()).kind,'RETRY');
   const retry=(await admin.query('SELECT status,last_error FROM mirror.schedule_occurrences WHERE id=$1',[lastClaim.occurrenceId])).rows[0];
   assert.equal(retry.status,'RETRY');assert.equal(retry.last_error,'OCCURRENCE_EXECUTION_FAILED');
   supersede=true;assert.equal((await runner.processNextOccurrence()).kind,'SUPERSEDED');assert.equal(called,2);
   const row=(await admin.query('SELECT status,lease_token,last_error FROM mirror.schedule_occurrences WHERE id=$1',[lastClaim.occurrenceId])).rows[0];
   assert.equal(row.status,'RUNNING');assert.equal(row.lease_token,'new-owner');assert.equal(row.last_error,null);
   assert.equal((await admin.query('SELECT id FROM mirror.job_commands WHERE shop_id=ANY($1)',[[shop,other]])).rowCount,0);
  });
  await testTenantDatabase(t,admin,target);
 }finally{
  await history?.end();await profiles?.close();
  await admin.query(`DROP OWNED BY ${login}`).catch(()=>{});await admin.query(`DROP ROLE IF EXISTS ${login}`).catch(()=>{});await admin.end();
 }
});
