import {createDatabaseInstallationResolver} from './installation-lifecycle.server.js';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {createTenantAuthority} from './tenant.server.js';
import {TENANT_OPERATIONS} from './tenant-policy.server.js';
import {createTenantDatabase} from './tenant-db.server.js';
import {createTenantDatabaseVerifier,getInstallationInTransaction} from './tenant-db-adapters.server.js';
import {createTenantSourcesRepository,SOURCE_TABLES} from './repositories/sync-sources.server.js';
import {createFilterAuthentication} from '../middleware/filter-auth.server.js';
import {PostgreSQLSessionStorage} from '@shopify/shopify-app-session-storage-postgresql';
import {Session} from '@shopify/shopify-api';
import {verifyRuntimeDatabase} from './runtime-database.server.js';
import {createRestrictedRuntimeProfiles} from './test-support/restricted-runtime.js';

/** Runs only in the disposable schema-test cluster, never against app storage. */
export async function testTenantDatabase(t,admin,target){
  await t.test('separate merchant and worker logins enforce role domains and reject mixed membership',async()=>{
    const profiles=await createRestrictedRuntimeProfiles(admin,target);
    const shop='split-a.myshopify.com',other='split-b.myshopify.com';
    try{
      await admin.query('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$3),($2,$3)',[shop,other,'44444444-4444-4444-8444-444444444444']);
      assert.equal((await profiles.merchant.query('SELECT id FROM mirror.shops')).rowCount,0);
      const tx=await profiles.merchant.connect();try{
        await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true)",[shop]);
        assert.deepEqual((await tx.query('SELECT id FROM mirror.shops')).rows,[{id:shop}]);
        assert.equal((await tx.query('SELECT id FROM mirror.shops WHERE id=$1',[other])).rowCount,0);
        await assert.rejects(()=>tx.query("UPDATE mirror.generations SET status='RETIRED' WHERE false"),{code:'42501'});
      }finally{await tx.query('ROLLBACK');tx.release();}
      await assert.rejects(()=>profiles.catalogWorker.query("UPDATE mirror.job_commands SET status='FAILED' WHERE false"),{code:'42501'});
      await assert.rejects(()=>profiles.operationWorker.query("UPDATE mirror.products SET title='denied' WHERE false"),{code:'42501'});
      await assert.rejects(()=>profiles.operationWorker.query('SELECT value_json FROM edit_history.snapshots LIMIT 0'),{code:'42501'});
      for(const sql of ["UPDATE mirror.job_commands SET status='SUCCEEDED' WHERE false","UPDATE mirror.job_commands SET lease_token='forged' WHERE false",
        'UPDATE mirror.outbox_events SET dispatched_at=clock_timestamp() WHERE false','DELETE FROM mirror.job_commands WHERE false'])
        await assert.rejects(()=>profiles.merchant.query(sql),{code:'42501'});
      const login=(await profiles.merchant.query('SELECT current_user AS name')).rows[0].name;
      assert.match(login,/^fixture_[a-f0-9]{32}$/);
      await admin.query(`GRANT metamax_catalog_worker TO ${login}`);
      try{await assert.rejects(()=>profiles.merchant.query('SELECT 1'),/exactly its declared runtime profile/);}
      finally{await admin.query(`REVOKE metamax_catalog_worker FROM ${login}`);}
    }finally{await profiles.close();}
  });
  await t.test('official Shopify session adapter works with a non-owner login limited to existing session tables',async()=>{
    const bootstrap=new PostgreSQLSessionStorage(target);await bootstrap.ready;await bootstrap.disconnect();
    const password=randomBytes(24).toString('hex');
    await admin.query(`CREATE ROLE tdb_sessions LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    // The official adapter issues CREATE TABLE IF NOT EXISTS even after its
    // migrations have run. Keep that compatibility privilege on its separate
    // infrastructure login; it receives no mirror/history schema privileges.
    await admin.query('GRANT USAGE,CREATE ON SCHEMA public TO tdb_sessions');
    await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.shopify_sessions TO tdb_sessions');
    await admin.query('GRANT SELECT ON public.shopify_sessions_migrations TO tdb_sessions');
    const url=new URL(target);url.username='tdb_sessions';url.password=password;
    const storage=new PostgreSQLSessionStorage(url.href);
    try{
      await storage.ready;
      const session=new Session({id:'session-privilege-test',shop:'session-privilege.myshopify.com',state:'fixture',isOnline:false,accessToken:'fixture'});
      assert.equal(await storage.storeSession(session),true);assert.equal((await storage.loadSession(session.id)).shop,session.shop);
      assert.equal(await storage.deleteSession(session.id),true);
    }finally{await storage.disconnect();await admin.query('DROP OWNED BY tdb_sessions');await admin.query('DROP ROLE tdb_sessions');}
  });
  await t.test('sync-source repository uses issued authentication, gateway statements and restricted RLS reads',async()=>{
    const password=randomBytes(24).toString('hex'),shop='tdb-sources.myshopify.com',version='44444444-4444-4444-8444-444444444444';
    await admin.query(`CREATE ROLE tdb_sources LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query('GRANT USAGE ON SCHEMA mirror TO tdb_sources');
    await admin.query('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2)',[shop,version]);
    for(const table of SOURCE_TABLES){
      const column=table==='mirror.shops'?'id':'shop_id';
      await admin.query(`GRANT SELECT ON ${table} TO tdb_sources`);

    }
    const url=new URL(target);url.username='tdb_sources';url.password=password;
    const pool=new pg.Pool({connectionString:url.href,max:3});
    const session={id:'offline_tdb_sources',shop,accessToken:'fixture',isOnline:false,scope:'read_products'};
    let stored=session;
    const authentication=createFilterAuthentication({resolveInstallation:createDatabaseInstallationResolver({database:admin}),sessionStorage:{loadSession:async()=>stored}}),request={};
    await authentication.capture(request,{locals:{shopify:{session}}},()=>{});
    const authContext=await authentication.authenticate(request);
    const repository=createTenantSourcesRepository({pool,authentication});
    try{
      const results=await Promise.all([repository.read({authContext}),repository.read({authContext})]);
      assert.ok(results.every(row=>row.installation_version===version));
      await assert.rejects(repository.read({authContext:{}}));
      session.scope='read_orders';await assert.rejects(repository.read({authContext}),{code:'ADMIN_OPERATION_DENIED'});
      stored=null;await assert.rejects(repository.read({authContext}));
    }finally{
      await pool.end();
      await admin.query('DROP OWNED BY tdb_sources');await admin.query('DROP ROLE tdb_sources');
    }
  });
  await t.test('tenant gateway uses a real restricted PostgreSQL login, RLS and read-only transactions',async()=>{
    const password=randomBytes(24).toString('hex'),version='11111111-1111-4111-8111-111111111111';
    const a='tdb-a.myshopify.com',b='tdb-b.myshopify.com';
    await admin.query(`CREATE ROLE tdb_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query('GRANT USAGE ON SCHEMA mirror TO tdb_runtime');
    await admin.query('GRANT SELECT ON mirror.shops,mirror.publications TO tdb_runtime');
    await admin.query('GRANT SELECT,UPDATE ON mirror.products TO tdb_runtime');
    for(const shop of [a,b]){
      await admin.query('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2)',[shop,version]);
      await admin.query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
        VALUES($1,$2,'tdb-revision','metamax_mirror_v1','metamax_sources_v1','mapping_v1')`,[shop,shop===a?'tdb-a':'tdb-b']);
      await admin.query(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,created_at,updated_at)
        VALUES($1,$2,'gid://shopify/Product/1',$1,'tdb','ACTIVE',now(),now())`,[shop,shop===a?'tdb-a':'tdb-b']);
    }
    await admin.query('ALTER TABLE mirror.products ENABLE ROW LEVEL SECURITY');

    const url=new URL(target);url.username='tdb_runtime';url.password=password;
    const pool=new pg.Pool({connectionString:url.href,max:1});
    const authority=createTenantAuthority({authenticateAdmin:async()=>({shopId:a,identityKind:'SHOP'}),
      getActiveInstallation:async()=>({active:true,shopId:a,installationId:version,installationVersion:version}),
      getInstallationInTransaction,verifyWorkerClaim:async()=>{throw Error('No worker');},verifyWorkerInTransaction:async()=>{throw Error('No worker');},
      authorizeAdminInTransaction:async()=>({authorized:true}),operations:TENANT_OPERATIONS,workerPolicies:[]});
    const verifyDatabase=createTenantDatabaseVerifier({tables:['mirror.products']});
    const statements=[
      {name:'products',mode:'READ',operations:['sync_sources.read'],sql:'SELECT shop_id FROM mirror.products WHERE shop_id=$1 AND $2=$3',validateValues:()=>[]},
      {name:'other-shop',mode:'READ',operations:['sync_sources.read'],sql:"SELECT shop_id FROM mirror.products WHERE shop_id=$4 AND $1<>'' AND $2=$3",validateValues:()=>[b]},
      {name:'bad-read-write',mode:'READ',operations:['sync_sources.read'],sql:'UPDATE mirror.products SET title=$4 WHERE shop_id=$1 AND $2=$3',validateValues:()=>['forbidden']},
    ];
    const gateway=createTenantDatabase({pool,authority,statements,verifyDatabase}),context=await authority.fromAdminRequest({});
    try{
      let leaked;
      const result=await gateway.withTenantRead({context,operation:'sync_sources.read',execute:async repo=>{
        leaked=repo;assert.deepEqual(Object.keys(repo),['run']);assert.equal(repo.query,undefined);
        const writer=await admin.connect();try{
          await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='100ms'");
          await assert.rejects(writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,581834147::bigint))',[a]),{code:'55P03'});
        }finally{await writer.query('ROLLBACK');writer.release();}
        assert.equal((await repo.run('other-shop')).rowCount,0);return repo.run('products');
      }});
      assert.deepEqual(result.rows,[{shop_id:a}]);
      await assert.rejects(verifyDatabase(admin),{code:'UNSAFE_TENANT_DATABASE_ROLE'});
      await assert.rejects(leaked.run('products'),{code:'TENANT_TRANSACTION_ENDED'});
      await assert.rejects(gateway.withTenantRead({context,operation:'sync_sources.read',execute:repo=>repo.run('SELECT * FROM mirror.products')}),{code:'TENANT_STATEMENT_DENIED'});
      await assert.rejects(gateway.withTenantRead({context,operation:'sync_sources.read',execute:repo=>repo.run('bad-read-write')}),{code:'25006'});
      const c=await pool.connect();try{
        assert.notEqual((await c.query("SELECT current_setting('app.shop_id',true) AS shop")).rows[0].shop,a);
        // Deliberately demonstrate the GUC limitation. This private client is
        // test infrastructure, never reachable from the gateway repository API.
        await c.query("SELECT set_config('app.shop_id',$1,false)",[b]);
        const exposed=(await c.query('SELECT shop_id FROM mirror.products')).rows;
        assert.equal(exposed.length,1);assert.equal(exposed[0].shop_id,b);
        await c.query('RESET app.shop_id');
      }finally{c.release();}
      await admin.query(`CREATE POLICY tdb_escape ON mirror.products TO tdb_runtime USING(true)`);
      await assert.rejects(gateway.withTenantRead({context,operation:'sync_sources.read',execute:repo=>repo.run('products')}),{code:'TENANT_RLS_POLICY_NOT_REVIEWED'});
      await admin.query('DROP POLICY tdb_escape ON mirror.products');
      await admin.query('GRANT TRUNCATE ON mirror.products TO tdb_runtime');
      await assert.rejects(gateway.withTenantRead({context,operation:'sync_sources.read',execute:repo=>repo.run('products')}),{code:'UNSAFE_TENANT_TABLE_PRIVILEGES'});
      await admin.query('REVOKE TRUNCATE ON mirror.products FROM tdb_runtime');
      await admin.query('CREATE ROLE tdb_bypass NOLOGIN BYPASSRLS');await admin.query('GRANT tdb_bypass TO tdb_runtime');
      await assert.rejects(gateway.withTenantRead({context,operation:'sync_sources.read',execute:repo=>repo.run('products')}),{code:'UNSAFE_TENANT_DATABASE_ROLE'});
      await admin.query('REVOKE tdb_bypass FROM tdb_runtime');await admin.query('DROP ROLE tdb_bypass');
      await admin.query('ALTER TABLE mirror.products DISABLE ROW LEVEL SECURITY');
      await assert.rejects(gateway.withTenantRead({context,operation:'sync_sources.read',execute:repo=>repo.run('products')}),{code:'TENANT_RLS_NOT_ENFORCED'});
    }finally{
      await pool.end();await admin.query('DROP POLICY IF EXISTS tdb_escape ON mirror.products');
      await admin.query('ALTER TABLE mirror.products ENABLE ROW LEVEL SECURITY');
      await admin.query('DROP OWNED BY tdb_runtime');await admin.query('DROP ROLE tdb_runtime');
    }
  });
}
