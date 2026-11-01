import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createRestrictedRuntimeProfiles} from '../security/test-support/restricted-runtime.js';
import {createCatalogImportService} from './catalog-import.server.js';

const target=process.env.FILTER_TEST_DATABASE_URL;
test('live product progress uses committed rows with restricted tenant and generation scope', {skip:!target}, async()=>{
 const url=new URL(target);
 assert.ok(process.env.FILTER_TEST_DATABASE_ISOLATED==='1'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.pathname==='/metamax_filter_test');
 const admin=new pg.Pool({connectionString:target,max:3});let profiles;
 try{
  const root=new URL('../prisma/migrations/',import.meta.url);
  for(const name of (await readdir(root,{withFileTypes:true})).filter(d=>d.isDirectory()&&/^\d+_/.test(d.name)).map(d=>d.name).sort())await admin.query(await readFile(new URL(name+'/migration.sql',root),'utf8'));
  profiles=await createRestrictedRuntimeProfiles(admin,target);
  assert.ok(BigInt((await profiles.catalogWorker.query("SELECT nextval('mirror.sync_dispatch_fairness_sequence')::text AS value")).rows[0].value)>0n,'restricted dispatcher can advance its fairness sequence');
  const shop='progress-a.myshopify.com',foreign='progress-b.myshopify.com',id=randomUUID(),foreignId=randomUUID();
  await admin.query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,'install-a'),($2,'install-b')",[shop,foreign]);
  for(const [tenant,generation] of [[shop,'progress'],[shop,'other'],[foreign,'progress']])
   await admin.query("INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version) VALUES($1,$2,'progress-coverage','metamax_mirror_v1','metamax_sources_v1','mapping_v1')",[tenant,generation]);
  await admin.query("INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,generation_id) VALUES($1,$2,'install-a','progress'),($3,$4,'install-b','progress')",[id,shop,foreignId,foreign]);
  const insert=(client,tenant,generation,gid,deleted=false)=>client.query("INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,created_at,updated_at,deleted_at) VALUES($1,$2,$3,'Product','product','ACTIVE',now(),now(),CASE WHEN $4 THEN now() ELSE NULL END)",[tenant,generation,`gid://shopify/Product/${gid}`,deleted]);
  await insert(admin,shop,'other',3);await insert(admin,foreign,'progress',4);await insert(admin,shop,'progress',500,true);
  let stored={id:'offline-a',shop,isOnline:false,scope:'read_products,write_products',accessToken:'fixture-token'};
  const service=createCatalogImportService({database:profiles.catalogWorker,shopify:{config:{sessionStorage:{loadSession:async()=>stored}}}});
  assert.equal((await service.current(stored)).progress.productsSaved,'0');
  const writer=await admin.connect();
  try{
   await writer.query('BEGIN');await insert(writer,shop,'progress',1);
   const uncommitted=await service.status(stored,id);
   assert.equal(uncommitted.progress.productsSaved,'0','uncommitted data must not be visible');
   assert.deepEqual(uncommitted.previewProducts,[]);
   await writer.query('COMMIT');
  }finally{writer.release();}
  assert.equal((await service.status(stored,id)).progress.productsSaved,'1');
  await insert(admin,shop,'progress',2);
  assert.equal((await service.current(stored)).progress.productsSaved,'2');
  for(let n=3;n<=50;n++)await insert(admin,shop,'progress',n);
  const partial=await service.current(stored);
  assert.equal(partial.progress.productsSaved,'50');assert.equal(partial.previewProducts.length,50);
  assert.equal(partial.editingAllowed,false);
  assert.deepEqual(partial.previewProducts.map(p=>p.id),Array.from({length:50},(_,i)=>`gid://shopify/Product/${i+1}`).sort());
  assert.deepEqual(Object.keys(partial.previewProducts[0]).sort(),['id','productType','status','title','vendor']);
  await insert(admin,shop,'progress',51);
  assert.equal((await service.current(stored)).progress.productsSaved,'51');
  assert.equal((await service.current(stored)).previewProducts.length,50,'preview payload remains bounded');
  for(let n=0;n<3;n++)assert.equal((await service.ensureInitialSync(stored)).id,id);
  assert.equal((await admin.query('SELECT count(*) FROM mirror.catalog_import_jobs WHERE shop_id=$1',[shop])).rows[0].count,'1','opening an existing installation does not enqueue imports');
  let executed=false;
  await assert.rejects(()=>service.withEditingLock(stored,()=>{executed=true;}),{code:'CATALOG_IMPORT_UNAVAILABLE'});
  assert.equal(executed,false);
  await admin.query("SELECT set_config('app.shop_id',$1,false)",[shop]);
  await assert.rejects(()=>admin.query("INSERT INTO mirror.job_commands(shop_id,installation_version,contract_id,idempotency_key,kind,updated_at) VALUES($1,'install-a','not-a-contract','blocked','bulk_edit',now())",[shop]),{code:'55000'});
  // Exercise actual status transitions and coverage guards. This small fixture
  // certifies lifecycle admission, not Shopify ingestion/worker execution.
  await admin.query("DELETE FROM mirror.products WHERE shop_id=$1 AND generation_id='progress' AND deleted_at IS NOT NULL",[shop]);
  await admin.query("UPDATE mirror.generations SET required_datasets=ARRAY['products']::text[] WHERE shop_id=$1 AND id='progress'",[shop]);
  await admin.query("INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at) VALUES($1,'progress','products','SUCCEEDED',51,51,true,now())",[shop]);
  await admin.query("UPDATE mirror.generations SET status='RECONCILING' WHERE shop_id=$1 AND id='progress'",[shop]);
  await admin.query("INSERT INTO mirror.coverage(shop_id,generation_id,name,status,durable_rows,verified_at,verification_hash) VALUES($1,'progress','products','COMPLETE',51,now(),'fixture')",[shop]);
  await admin.query("UPDATE mirror.generations SET status='VERIFIED',verified_at=now() WHERE shop_id=$1 AND id='progress'",[shop]);
  assert.equal((await service.current(stored)).editingAllowed,false,'verification alone does not unlock editing');
  await admin.query("UPDATE mirror.generations SET status='PUBLISHED',published_at=now()-interval '73 hours' WHERE shop_id=$1 AND id='progress'",[shop]);
  await admin.query("INSERT INTO mirror.publications(shop_id,generation_id,coverage_revision,mapping_version) VALUES($1,'progress','progress-coverage','mapping_v1')",[shop]);
  assert.equal((await service.current(stored)).editingAllowed,false,'publication before worker acknowledgment remains locked');
  await admin.query("UPDATE mirror.catalog_import_jobs SET status='SUCCEEDED' WHERE id=$1",[id]);
  assert.equal((await service.current(stored)).editingAllowed,true);
  await service.withEditingLock(stored,()=>{executed=true;});assert.equal(executed,true);
  await assert.rejects(()=>profiles.catalogWorker.query('SELECT mirror.catalog_edit_barrier($1)',[shop]),{code:'42501'},'the private barrier cannot be called as an authorization bypass');
  await service.ensurePeriodicFullSyncs();
  assert.equal((await admin.query('SELECT 1 FROM mirror.catalog_refresh_requests WHERE shop_id=$1',[shop])).rowCount,0,'a recent attempt does not resync on a timer tick');
  await admin.query("UPDATE mirror.catalog_import_jobs SET created_at=now()-interval '74 hours' WHERE id=$1",[id]);
  await service.ensurePeriodicFullSyncs();
  assert.equal((await admin.query('SELECT 1 FROM mirror.catalog_refresh_requests WHERE shop_id=$1',[shop])).rowCount,0,'existing staging work blocks duplicate full syncs');
  await admin.query("UPDATE mirror.generations SET status='FAILED' WHERE shop_id=$1 AND id='other'",[shop]);
  await Promise.all([service.ensurePeriodicFullSyncs(),service.ensurePeriodicFullSyncs()]);
  const refresh=(await admin.query('SELECT requested_revision,scheduled_revision FROM mirror.catalog_refresh_requests WHERE shop_id=$1',[shop])).rows[0];
  assert.deepEqual(refresh,{requested_revision:'1',scheduled_revision:'0'},'concurrent 72-hour schedulers coalesce to one durable request');
  await service.ensurePeriodicFullSyncs();
  assert.equal((await admin.query('SELECT requested_revision FROM mirror.catalog_refresh_requests WHERE shop_id=$1',[shop])).rows[0].requested_revision,'1');
  // A queued refresh immediately locks editing, even before it owns a generation.
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;}),finished=new Promise(resolve=>{release=resolve;});
  const editing=service.withEditingLock(stored,async()=>{enter();await finished;});
  await entered;
  let syncAdmitted=false;
  const newSync=admin.query("INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version) VALUES($1,$2,'install-a')",[randomUUID(),shop]).then(()=>{syncAdmitted=true;});
  try {
    let waiting=false;
    for(let i=0;i<100&&!waiting;i++){
      waiting=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE 'INSERT INTO mirror.catalog_import_jobs%') AS waiting")).rows[0].waiting;
      if(!waiting)await delay(10);
    }
    assert.equal(waiting,true,'sync admission waits for the already-authorized edit barrier');
    assert.equal(syncAdmitted,false);
  } finally {release();await editing;await newSync;}
  assert.equal((await service.current(stored)).editingAllowed,false);
  await assert.rejects(()=>service.withEditingLock(stored,()=>{}),{code:'CATALOG_IMPORT_UNAVAILABLE'});
  assert.equal((await service.status(stored,foreignId)) ?? null,null);
  stored={...stored,scope:'read_orders'};
  await assert.rejects(()=>service.current(stored),{code:'IMPORT_PERMISSION_DENIED'});
 }finally{await profiles?.close();await admin.end();}
});
