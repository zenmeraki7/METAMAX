import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
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
  const shop='progress-a.myshopify.com',foreign='progress-b.myshopify.com',id=randomUUID(),foreignId=randomUUID();
  await admin.query("INSERT INTO mirror.shops(id,installation_version) VALUES($1,'install-a'),($2,'install-b')",[shop,foreign]);
  for(const [tenant,generation] of [[shop,'progress'],[shop,'other'],[foreign,'progress']])
   await admin.query("INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version) VALUES($1,$2,'progress-coverage','metamax_mirror_v1','metamax_sources_v1','mapping_v1')",[tenant,generation]);
  await admin.query("INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,generation_id) VALUES($1,$2,'install-a','progress'),($3,$4,'install-b','progress')",[id,shop,foreignId,foreign]);
  const insert=(client,tenant,generation,gid,deleted=false)=>client.query("INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,created_at,updated_at,deleted_at) VALUES($1,$2,$3,'Product','product','ACTIVE',now(),now(),CASE WHEN $4 THEN now() ELSE NULL END)",[tenant,generation,`gid://shopify/Product/${gid}`,deleted]);
  await insert(admin,shop,'other',3);await insert(admin,foreign,'progress',4);await insert(admin,shop,'progress',5,true);
  let stored={id:'offline-a',shop,isOnline:false,scope:'read_products',accessToken:'fixture-token'};
  const service=createCatalogImportService({database:profiles.catalogWorker,shopify:{config:{sessionStorage:{loadSession:async()=>stored}}}});
  assert.equal((await service.current(stored)).progress.productsSaved,'0');
  const writer=await admin.connect();
  try{
   await writer.query('BEGIN');await insert(writer,shop,'progress',1);
   assert.equal((await service.status(stored,id)).progress.productsSaved,'0','uncommitted data must not be visible');
   await writer.query('COMMIT');
  }finally{writer.release();}
  assert.equal((await service.status(stored,id)).progress.productsSaved,'1');
  await insert(admin,shop,'progress',2);
  assert.equal((await service.current(stored)).progress.productsSaved,'2');
  assert.equal((await service.status(stored,foreignId)) ?? null,null);
  stored={...stored,scope:'read_orders'};
  await assert.rejects(()=>service.current(stored),{code:'IMPORT_PERMISSION_DENIED'});
 }finally{await profiles?.close();await admin.end();}
});
