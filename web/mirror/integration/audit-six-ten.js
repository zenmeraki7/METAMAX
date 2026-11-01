import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {lockPublication} from '../publication-lock.server.js';
import {createFilterExecutor} from '../../filters/execute.js';
import {createReconciliationRepository} from '../reconciliation-repository.server.js';
import {createReconciliationService} from '../reconciliation-service.server.js';
import {FILTER_SQL_SCHEMA} from '../../fields/sources.js';

export async function testAuditSixTen({t,pool}) {
  await t.test('publication locking rejects an autocommit client',async()=>{
    const client=await pool.connect();
    try{await assert.rejects(()=>lockPublication(client,'audit-a.myshopify.com'),{code:'25P01'});}
    finally{client.release();}
  });
  await t.test('publication locks isolate shops and readers see commits made while they wait',async()=>{
    await pool.query('CREATE TABLE mirror.audit_lock_probe(id int PRIMARY KEY,version int)');
    await pool.query('INSERT INTO mirror.audit_lock_probe VALUES(1,1)');
    const writer=await pool.connect(),reader=await pool.connect(),other=await pool.connect();
    try {
      await writer.query('BEGIN');await lockPublication(writer,'audit-a.myshopify.com',{write:true});
      await writer.query('UPDATE mirror.audit_lock_probe SET version=2');
      await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='100ms'");
      await lockPublication(other,'audit-b.myshopify.com');await other.query('COMMIT');
      await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
      const waiting=lockPublication(reader,'audit-a.myshopify.com');
      await delay(25);await writer.query('COMMIT');await waiting;
      assert.equal((await reader.query('SELECT version FROM mirror.audit_lock_probe')).rows[0].version,2);
      await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='50ms'");
      await assert.rejects(()=>lockPublication(writer,'audit-a.myshopify.com',{write:true}),{code:'55P03'});
      await writer.query('ROLLBACK');await reader.query('COMMIT');
      await writer.query('BEGIN');await lockPublication(writer,'audit-a.myshopify.com',{write:true});await writer.query('COMMIT');
    } finally {
      for(const client of [writer,reader,other]){await client.query('ROLLBACK');client.release();}
      await pool.query('DROP TABLE mirror.audit_lock_probe');
    }
  });
  await t.test('selection deadline and cancellation roll back writes and revoke late client access',async()=>{
    await pool.query('CREATE TABLE mirror.audit_selection_probe(id int)');
    const shopId='audit-a.myshopify.com';
    const executor=createFilterExecutor({database:pool,resolveShop:async()=>shopId,
      compiler:{createCursor:()=>null,isCompiledQuery:()=>false,getExecutionPlan:()=>null,authorizeExecution:async()=>{}},
      publicationService:{requirePublished:async()=>{},lockForRead:(client,shop)=>lockPublication(client,shop)}});
    try {
      for(const cancel of [false,true]) {
        const controller=new AbortController();let client,late;
        let started;const ready=new Promise(resolve=>{started=resolve;});
        const work=executor.withSnapshot({authContext:{},timeoutMs:cancel?5000:40,signal:controller.signal},async scope=>{
          client=scope.client;await client.query('INSERT INTO mirror.audit_selection_probe VALUES(1)');started();
          await delay(100);
          try{await client.query('INSERT INTO mirror.audit_selection_probe VALUES(2)');late=false;}catch{late=true;}
        });
        await Promise.race([ready,work.then(()=>{throw new Error("Selection unexpectedly completed");})]);if(cancel)controller.abort();
        await assert.rejects(()=>work);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM mirror.audit_selection_probe')).rows[0].n,0);
        await delay(110);assert.equal(late,true);
        await assert.rejects(()=>client.query('SELECT 1'));
      }
      let resolutions=0;
      const delayedAuthorization=createFilterExecutor({database:pool,
        resolveShop:async()=>{if(++resolutions>1)await delay(70);return shopId;},
        compiler:{createCursor:()=>null,getExecutionPlan:()=>null,authorizeExecution:async()=>{}},
        publicationService:{requirePublished:async()=>{},lockForRead:(client,shop)=>lockPublication(client,shop)}});
      await assert.rejects(()=>delayedAuthorization.withSnapshot({authContext:{},timeoutMs:50},async({client})=>{
        await client.query('INSERT INTO mirror.audit_selection_probe VALUES(3)');
      }),/deadline exceeded/);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM mirror.audit_selection_probe')).rows[0].n,0);
    } finally {await pool.query('DROP TABLE mirror.audit_selection_probe');}
  });
  await t.test('secondary worker expiry before acknowledgment never writes mirrors; mirror failure rolls acknowledgment back',async()=>{
    const shopId='audit-secondary.myshopify.com',generationId='audit-secondary-generation',productId='gid://shopify/Product/991';
    await pool.query('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2)',[shopId,'audit-installation']);
    await pool.query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
      VALUES($1,$2,'audit-secondary-r1',$3,$4,'mapping_v1')`,[shopId,generationId,FILTER_SQL_SCHEMA.mirrorSchemaVersion,FILTER_SQL_SCHEMA.sourceContractVersion]);
    await pool.query(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,created_at,updated_at)
      VALUES($1,$2,$3,'Retained','retained','ACTIVE',now(),now())`,[shopId,generationId,productId]);
    await createReconciliationService({database:pool}).recordMutationEvent({shopId,productId,source:'WEBHOOK',sourceKey:'audit-expiry',deleted:true});
    const repository=createReconciliationRepository({database:pool});
    let claim=await repository.claimNext({workerId:'audit-worker',shopId,generationId});assert.ok(claim);
    await pool.query("UPDATE mirror.catalog_changes SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE shop_id=$1",[shopId]);
    let writes=0;
    const wrapped=mode=>({async connect(){const client=await pool.connect();return {release:()=>client.release(),async query(sql,values){
      if(mode==='expiry' && /UPDATE mirror.catalog_changes/.test(sql) && /applied_revision/.test(sql))await delay(200);
      if(/DELETE FROM mirror\.|INSERT INTO mirror\.generation_product_revisions/.test(sql)){writes++;if(mode==='failure')throw new Error('injected mirror failure');}
      return client.query(sql,values);
    }};}});
    const result=await createReconciliationRepository({database:wrapped('expiry')}).commitReconciliation({claim,observedRevision:claim.revision,replacement:{kind:'DELETE'}});
    assert.equal(result.kind,'SUPERSEDED');assert.equal(writes,0);
    claim=await repository.claimNext({workerId:'audit-worker',shopId,generationId});assert.ok(claim);
    await assert.rejects(()=>createReconciliationRepository({database:wrapped('failure')}).commitReconciliation({claim,observedRevision:claim.revision,replacement:{kind:'DELETE'}}),/injected mirror failure/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mirror.products WHERE shop_id=$1',[shopId])).rows[0].n,1);
    const change=(await pool.query('SELECT dirty,applied_revision FROM mirror.catalog_changes WHERE shop_id=$1',[shopId])).rows[0];
    assert.equal(change.dirty,true);assert.equal(String(change.applied_revision),'0');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mirror.generation_product_revisions WHERE shop_id=$1',[shopId])).rows[0].n,0);
  });
}
