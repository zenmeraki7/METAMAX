import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createHistoryRepository } from '../history-repository.server.js';
import { createHistoryValueProtection } from '../history-value-protection.server.js';
import { inspectHistoryDatabasePrivileges } from '../database-security.server.js';
import { createHistoryRetentionService } from '../history-retention.server.js';
import { handleWebhookEvent } from '../../privacy.js';
import { createHistoryPrivacyService } from '../history-privacy.server.js';

export async function testHistorySecurity(t,fixture,pool,admin){
 const password=randomUUID();
 await admin.query(`CREATE ROLE history_fixture_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD '${password}'`);
 await admin.query('GRANT metamax_history_maintenance TO history_fixture_maintenance');
 const url=new URL(process.env.FILTER_TEST_DATABASE_URL);url.username='history_fixture_maintenance';url.password=password;
 const maintenancePool=new pg.Pool({connectionString:url.toString()});
 await admin.query(`CREATE ROLE history_fixture_privacy LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD '${password}'`);
 await admin.query('GRANT metamax_history_privacy TO history_fixture_privacy');url.username='history_fixture_privacy';
 const privacyPool=new pg.Pool({connectionString:url.toString()}),historyPrivacyService=createHistoryPrivacyService({database:privacyPool});
 const protection=createHistoryValueProtection({resolveKey:async()=>({key:Buffer.alloc(32,17),keyReference:'fixture-history-v1'})});
 const maintenance=createHistoryRetentionService({database:maintenancePool,valueProtection:protection});
 const snapshotInput=(f,receipt)=>({authContext:f.input.authContext,operationId:f.input.operationId,
  changeId:receipt.fields[0].changeId,snapshotId:receipt.fields[0].snapshotId});
 async function seedAged(f,{hold=false}={}){
  await admin.query(`INSERT INTO edit_history.operations(id,shop_id,installation_id,execution_job_id,edit_operation_id,execution_contract_id,
   operation_kind,execution_fingerprint,filter_fingerprint,approved_contract_fingerprint,field_mapping_version,created_at,retained_until,legal_hold)
   VALUES($1,$2,$3,$4,$5,$6,'BULK_EDIT',$7,$8,$9,$10,clock_timestamp()-interval '31 days',clock_timestamp()-interval '1 day',$11)`,
   [f.input.operationId,f.shopId,f.installationId,f.command,f.plan.editOperationId,f.contractId,f.plan.executionFingerprint,
    f.plan.filterFingerprint,f.plan.approvedContractFingerprint,f.input.entries[0].intent.binding.mappingVersion,hold]);
  await f.repository.prepareRequest(f.input);
  await admin.query("UPDATE edit_history.operations SET operation_state='FAILED',completed_at=clock_timestamp() WHERE id=$1",[f.input.operationId]);
  await admin.query("UPDATE mirror.job_commands SET status='FAILED',lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.command]);
 }
 async function purgeUntilGone(id){
  for(let i=0;i<35;i++){
   const result=await maintenance.purgeBatch({limit:2});assert.ok(result.deletedRows<=2);
   if((await admin.query('SELECT count(*) FROM edit_history.operations WHERE id=$1',[id])).rows[0].count==='0')return;
  }assert.fail('Bounded maintenance did not finish operation');
 }
 try{
 await t.test('maintenance cannot turn NULL or oversized SQL limits into unbounded deletion or plaintext reads',async()=>{
  const client=await maintenancePool.connect();try{
   for(const sql of ['SELECT edit_history.purge_history_batch(NULL)','SELECT edit_history.purge_history_batch(501)',
    'SELECT * FROM edit_history.legacy_snapshot_batch(NULL)','SELECT * FROM edit_history.legacy_snapshot_batch(26)'])
    await assert.rejects(()=>client.query(sql),{code:'22023'});
  }finally{client.release();}
 });
 await t.test('least-privilege verification rejects migration owners and detects later PUBLIC and inherited privilege escalation',async()=>{
  assert.equal((await inspectHistoryDatabasePrivileges(admin)).verified,false);
  const f=await fixture();await f.repository.prepareRequest(f.input);
  const client=await pool.connect();try{assert.equal((await inspectHistoryDatabasePrivileges(client,{authorityRelations:f.adapters.authorityRelations})).verified,true);}finally{client.release();}
  await admin.query('CREATE TABLE public.history_security_probe(id integer)');
  for(const [grant,revoke] of [
   ['GRANT DELETE ON edit_history.operations TO metamax_history_runtime','REVOKE DELETE ON edit_history.operations FROM metamax_history_runtime'],
   ['GRANT UPDATE(value_json) ON edit_history.snapshots TO PUBLIC','REVOKE UPDATE(value_json) ON edit_history.snapshots FROM PUBLIC'],
   ['GRANT SELECT ON edit_history.snapshots TO PUBLIC','REVOKE SELECT ON edit_history.snapshots FROM PUBLIC'],
   ['GRANT metamax_history_owner TO history_fixture_runtime','REVOKE metamax_history_owner FROM history_fixture_runtime'],
   ['GRANT SELECT ON public.history_security_probe TO metamax_history_runtime','REVOKE SELECT ON public.history_security_probe FROM metamax_history_runtime'],
   ["CREATE FUNCTION public.history_privilege_probe() RETURNS integer LANGUAGE SQL SECURITY DEFINER AS 'SELECT 1'",'DROP FUNCTION public.history_privilege_probe()'],
  ]){
   await admin.query(grant);try{await assert.rejects(()=>f.repository.getOperation({authContext:f.input.authContext,operationId:f.input.operationId}),{code:'HISTORY_UNAUTHORIZED'});}
   finally{await admin.query(revoke);}
  }
  await admin.query('DROP TABLE public.history_security_probe');
  assert.equal((await f.repository.getOperation({authContext:f.input.authContext,operationId:f.input.operationId})).operationId,f.input.operationId);
 });
 await t.test('runtime credentials cannot delete, bypass immutable history, invoke maintenance or change engine ownership',async()=>{
  const client=await pool.connect();try{
   for(const sql of ['DELETE FROM edit_history.operations','TRUNCATE edit_history.snapshots',
    'UPDATE edit_history.snapshots SET value_json=\'null\'', 'ALTER TABLE edit_history.snapshots DISABLE TRIGGER ALL',
    'UPDATE mirror.job_commands SET fence=fence+1','UPDATE edit_history.operations SET legal_hold=false',
    'SELECT edit_history.purge_history_batch(1)','SET ROLE metamax_history_owner'])await assert.rejects(()=>client.query(sql),{code:'42501'});
  }finally{client.release();}
 });
 await t.test('history values are ciphertext at rest and merchant reads default to redaction without loading keys',async()=>{
  const f=await fixture(),receipt=await f.repository.prepareRequest(f.input);
  const rows=(await admin.query('SELECT * FROM edit_history.snapshots WHERE shop_id=$1',[f.shopId])).rows;
  for(const row of rows){assert.equal(row.value_encoding,'ENCRYPTED_JSON');assert.equal(row.value_json,null);assert.ok(Buffer.isBuffer(row.encrypted_value));}
  const {authorizeHistoryValueRead,...adapters}=f.adapters;let keys=0;
  const redactedRepo=createHistoryRepository({database:pool,...adapters,valueProtection:createHistoryValueProtection({resolveKey:async()=>{keys++;throw Error('unavailable');}})});
  const result=await redactedRepo.getSnapshot(snapshotInput(f,receipt));assert.equal(result.redacted,true);assert.equal(result.snapshot,null);assert.equal(keys,0);
  assert.ok(!JSON.stringify(result).includes('Before'));
  assert.equal((await f.repository.getSnapshot(snapshotInput(f,receipt))).snapshot.value,'Before');
  let grants=0;const revoked=createHistoryRepository({database:pool,...f.adapters,authorizeHistoryValueRead:async()=>++grants===1});
  await assert.rejects(()=>revoked.getSnapshot(snapshotInput(f,receipt)),{code:'HISTORY_UNAUTHORIZED'});
 });
 await t.test('ciphertext corruption and cross-tenant key use fail closed; missing keys cannot persist plaintext',async()=>{
  const f=await fixture(),receipt=await f.repository.prepareRequest(f.input);
  const row=(await admin.query('SELECT * FROM edit_history.snapshots WHERE id=$1',[receipt.fields[0].snapshotId])).rows[0];
  await assert.rejects(()=>protection.open(row,{tenant:{shopId:'foreign.myshopify.com',installationId:f.installationId}}),{code:'HISTORY_UNAUTHORIZED'});
  const corrupted={...row,encrypted_value:Buffer.from(row.encrypted_value)};corrupted.encrypted_value[15]^=1;
  await assert.rejects(()=>protection.open(corrupted,{tenant:{shopId:f.shopId,installationId:f.installationId}}),{code:'HISTORY_EVIDENCE_CONFLICT'});
  const missing=await fixture({valueProtection:createHistoryValueProtection()});
  await assert.rejects(()=>missing.repository.prepareRequest(missing.input),{code:'HISTORY_UNAUTHORIZED'});
  assert.equal((await admin.query('SELECT count(*) FROM edit_history.snapshots WHERE shop_id=$1',[missing.shopId])).rows[0].count,'0');
 });
 await t.test('30-day retention is resumable in bounded batches and hides records as soon as purging starts',async()=>{
  const f=await fixture();await seedAged(f);
  const first=await maintenance.purgeBatch({limit:2});assert.equal(first.deletedRows,2);
  assert.equal(await f.repository.getOperation({authContext:f.input.authContext,operationId:f.input.operationId}),null);
  await purgeUntilGone(f.input.operationId);
  for(const table of ['changes','snapshots','mutation_requests'])assert.equal((await admin.query(`SELECT count(*) FROM edit_history.${table} WHERE shop_id=$1`,[f.shopId])).rows[0].count,'0');
  assert.equal((await admin.query('SELECT count(*) FROM edit_history.purge_receipts WHERE operation_id=$1',[f.input.operationId])).rows[0].count,'1');
  const fresh=await fixture();await fresh.repository.prepareRequest(fresh.input);await maintenance.purgeBatch();
  assert.equal((await admin.query('SELECT count(*) FROM edit_history.operations WHERE id=$1',[fresh.input.operationId])).rows[0].count,'1');
 });
 await t.test('maintenance encrypts legacy snapshots without changing identity or fingerprints and quarantines invalid legacy records',async()=>{
  const f=await fixture(),receipt=await f.repository.prepareRequest(f.input),target=receipt.fields[0].snapshotId;
  const before=(await admin.query('SELECT * FROM edit_history.snapshots WHERE id=$1',[target])).rows[0];
  // Simulate an existing pre-migration plaintext row. Access-exclusive DDL and
  // restored guards remain in one isolated-fixture transaction; no runtime
  // account is granted an unencrypted write or trigger-bypass capability.
  const tx=await admin.connect();try{
   await tx.query('BEGIN');await tx.query('ALTER TABLE edit_history.snapshots DISABLE TRIGGER eh_snapshot_no_update');
   await tx.query('ALTER TABLE edit_history.snapshots DROP CONSTRAINT eh_snapshot_encrypt_new_values');
   await tx.query("UPDATE edit_history.snapshots SET value_encoding='JSONB',value_json=$2::jsonb,encrypted_value=NULL,encryption_key_reference=NULL WHERE id=$1",[target,JSON.stringify('Before')]);
   await tx.query("ALTER TABLE edit_history.snapshots ADD CONSTRAINT eh_snapshot_encrypt_new_values CHECK(value_kind='ABSENT' OR value_encoding='ENCRYPTED_JSON') NOT VALID");
   await tx.query('ALTER TABLE edit_history.snapshots ENABLE TRIGGER eh_snapshot_no_update');await tx.query('COMMIT');
  }finally{await tx.query('ROLLBACK').catch(()=>{});tx.release();}
  for(let i=0;i<30;i++){
   await maintenance.encryptLegacyBatch({limit:1});
   if((await admin.query('SELECT value_encoding FROM edit_history.snapshots WHERE id=$1',[target])).rows[0].value_encoding==='ENCRYPTED_JSON')break;
  }
  const after=(await admin.query('SELECT * FROM edit_history.snapshots WHERE id=$1',[target])).rows[0];
  assert.equal(after.value_encoding,'ENCRYPTED_JSON');assert.equal(after.value_json,null);assert.equal(after.snapshot_fingerprint,before.snapshot_fingerprint);
  assert.equal(after.evidence_binding_fingerprint,before.evidence_binding_fingerprint);
  assert.equal((await f.repository.getSnapshot(snapshotInput(f,receipt))).snapshot.value,'Before');
 });
 await t.test('permanent cleanup failures use durable bounded retries and require review instead of reporting completion',async()=>{
  const f=await fixture();await seedAged(f);
  await admin.query(`CREATE FUNCTION history_test_authority.inject_purge_failure() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF OLD.shop_id='${f.shopId}' THEN RAISE EXCEPTION 'Fixture cleanup failure'; END IF; RETURN OLD; END $$;
   CREATE TRIGGER fixture_purge_failure BEFORE DELETE ON edit_history.snapshots FOR EACH ROW EXECUTE FUNCTION history_test_authority.inject_purge_failure()`);
  try{
   for(let i=0;i<8;i++){
    const result=await maintenance.purgeBatch();assert.equal(result.retryScheduled,true);assert.equal(result.deletedRows,0);
    await admin.query("UPDATE edit_history.operations SET purge_next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.input.operationId]);
   }
   const state=(await admin.query('SELECT purge_attempts,purge_review_required,purge_requested_at FROM edit_history.operations WHERE id=$1',[f.input.operationId])).rows[0];
   assert.equal(state.purge_attempts,8);assert.equal(state.purge_review_required,true);assert.ok(state.purge_requested_at);
   assert.equal((await maintenance.purgeBatch()).deletedRows,0);
   assert.equal((await admin.query('SELECT count(*) FROM edit_history.snapshots WHERE shop_id=$1',[f.shopId])).rows[0].count,'2');
  }finally{await admin.query('DROP TRIGGER fixture_purge_failure ON edit_history.snapshots');await admin.query('DROP FUNCTION history_test_authority.inject_purge_failure()');}
  await admin.query('UPDATE edit_history.operations SET purge_review_required=false,purge_attempts=0 WHERE id=$1',[f.input.operationId]);
  await purgeUntilGone(f.input.operationId);
 });
 await t.test('authenticated uninstall fences recovery and delayed shop redaction preserves a new installation and its sessions',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);await f.repository.beginDispatch(f.input);
  const storage={sessions:['old'],async findSessionsByShop(){return this.sessions.map(id=>({id}));},async deleteSessions(ids){this.sessions=this.sessions.filter(id=>!ids.includes(id));}};
  const event={shop:f.shopId,database:admin,sessionStorage:storage,body:'{}',historyPrivacyService};
  const uninstallEvent=randomUUID();await handleWebhookEvent({...event,topic:'APP_UNINSTALLED',webhookId:uninstallEvent});
  const job=(await admin.query('SELECT fence,lease_until,cancel_requested_at FROM mirror.job_commands WHERE id=$1',[f.command])).rows[0];
  assert.ok(BigInt(job.fence)>BigInt(f.plan.fenceEpoch));assert.ok(job.cancel_requested_at);assert.equal(storage.sessions.length,0);
  assert.equal((await admin.query('SELECT DISTINCT mutation_state FROM edit_history.changes WHERE shop_id=$1',[f.shopId])).rows[0].mutation_state,'DISPATCHING');
  const newer=randomUUID();await admin.query('UPDATE mirror.shops SET installation_version=$2,uninstalled_at=NULL WHERE id=$1',[f.shopId,newer]);storage.sessions=['new'];
  assert.equal((await handleWebhookEvent({...event,topic:'APP_UNINSTALLED',webhookId:uninstallEvent})).duplicate,true);
  const nextOperation=randomUUID();
  await admin.query(`INSERT INTO edit_history.operations(id,shop_id,installation_id,execution_job_id,operation_kind,execution_fingerprint)
   VALUES($1,$2,$3,9223372036854775000,'BULK_EDIT',$4)`,[nextOperation,f.shopId,newer,f.plan.executionFingerprint]);
  await handleWebhookEvent({...event,topic:'SHOP_REDACT',webhookId:'redact-old-install'});
  await handleWebhookEvent({...event,topic:'SHOP_REDACT',webhookId:'redact-old-install'});
  assert.deepEqual(storage.sessions,['new']);
  await purgeUntilGone(f.input.operationId);
  const current=(await admin.query('SELECT installation_version,uninstalled_at FROM mirror.shops WHERE id=$1',[f.shopId])).rows[0];
  assert.equal(current.installation_version,newer);assert.equal(current.uninstalled_at,null);
  assert.equal((await admin.query('SELECT count(*) FROM edit_history.operations WHERE id=$1',[nextOperation])).rows[0].count,'1');
 });
 await t.test('legal holds survive retention and privacy requests and enter an explicit review-required state',async()=>{
  const f=await fixture();await seedAged(f,{hold:true});
  await handleWebhookEvent({shop:f.shopId,database:admin,body:'{}',topic:'APP_UNINSTALLED',webhookId:randomUUID()});
  await handleWebhookEvent({shop:f.shopId,database:admin,body:'{}',topic:'SHOP_REDACT',webhookId:randomUUID(),historyPrivacyService});
  await maintenance.purgeBatch();
  assert.equal((await admin.query('SELECT count(*) FROM edit_history.snapshots WHERE shop_id=$1',[f.shopId])).rows[0].count,'2');
  assert.equal((await admin.query('SELECT review_required FROM edit_history.privacy_scopes WHERE shop_id=$1',[f.shopId])).rows[0].review_required,true);
 });
 }finally{await maintenancePool.end();await privacyPool.end();}
}
