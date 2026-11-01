import {product} from './sync-hardening.js';
import assert from 'node:assert/strict';
import {handleWebhookEvent} from '../../privacy.js';
import {createCatalogPhaseRuntime} from '../../services/catalog-phase-runtime.server.js';

export async function testWebhookRefresh(t,{pool,fixture,service,runtime,drain,options}) {
  const deliver=(s,topic,payload,eventId)=>handleWebhookEvent({database:pool,shop:s.session.shop,topic,body:JSON.stringify(payload),webhookId:eventId});
  const due=s=>pool.query('UPDATE mirror.catalog_refresh_requests SET next_attempt_at=clock_timestamp() WHERE shop_id=$1',[s.session.shop]);
  const latest=s=>pool.query('SELECT * FROM mirror.catalog_import_jobs WHERE shop_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[s.session.shop]).then(r=>r.rows[0]);

  await t.test('dispatcher and queue worker finish reopened publication after DEFER, redelivery and lost-delivery recovery',async()=>{
    const handlers=new Map(),queued=new Map();
    class Worker {constructor(name,handler){handlers.set(name,handler);}on(){}async close(){}}
    const queue={async add(name,data,{jobId}){const job={id:jobId,name,data,getState:async()=> 'waiting'};queued.set(jobId,job);return job;},async getJob(id){return queued.get(id)??null;}};
    const queuedRuntime=await createCatalogPhaseRuntime({...options,Worker,connection:{},syncQueue:queue,recoveryQueue:queue});
    const s=fixture('queued-reopened',Array.from({length:11},(_,index)=>product(index+100))),job=await service.enqueue(s.session);
    const ready=async()=>{await pool.query('UPDATE mirror.catalog_import_executions SET next_eligible_at=clock_timestamp() WHERE id=$1',[job.id]);await pool.query('UPDATE mirror.sync_dispatch_schedule SET next_eligible_at=clock_timestamp() WHERE shop_id=$1',[s.session.shop]);};
    const next=async()=>{await ready();assert.equal((await queuedRuntime.dispatchOnce()).dispatched,1);const delivery=[...queued.values()].find(item=>item.data.runId===job.id);assert.ok(delivery);return delivery;};
    const execute=async delivery=>{queued.delete(delivery.id);return handlers.get('metamax-catalog-sync')(delivery);};
    try{
      for(let i=0;i<10;i++){const row=(await pool.query('SELECT phase FROM mirror.catalog_import_executions WHERE id=$1',[job.id])).rows[0];if(row.phase==='PUBLISHING')break;await execute(await next());}
      assert.equal((await pool.query('SELECT phase FROM mirror.catalog_import_executions WHERE id=$1',[job.id])).rows[0].phase,'PUBLISHING');
      for(let id=100;id<111;id++)await deliver(s,'PRODUCTS_UPDATE',{id},'queued-dirty-'+id);
      const deferred=await next();await execute(deferred);
      assert.equal((await pool.query('SELECT status FROM mirror.generations WHERE shop_id=$1 AND id=$2',[s.session.shop,job.generationId])).rows[0].status,'RECONCILING');
      assert.equal((await pool.query('SELECT count(*) FROM mirror.catalog_changes WHERE shop_id=$1 AND dirty',[s.session.shop])).rows[0].count,'1');
      await handlers.get('metamax-catalog-sync')(deferred); // Before its durable due time: redundant delivery.
      const lost=await next();queued.delete(lost.id);
      const dispatch=(await pool.query('SELECT id FROM mirror.sync_dispatches WHERE job_id=$1',[lost.id])).rows[0];
      await pool.query("UPDATE mirror.sync_dispatches SET state='UNKNOWN',reserved_until=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=$1",[dispatch.id]);
      const recovered=await queuedRuntime.recoverDelivery(dispatch.id);assert.equal(recovered.decision,'RETRY_VERIFIED');
      await execute(await next());
      assert.equal((await pool.query('SELECT generation_id FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0].generation_id,job.generationId);
      assert.equal((await pool.query('SELECT count(*) FROM mirror.catalog_changes WHERE shop_id=$1 AND dirty',[s.session.shop])).rows[0].count,'0');
    }finally{await queuedRuntime.stop();}
  });

  for(const boundary of ['before-phase-evidence','before-publication'])await t.test(`late webhook ${boundary} is reconciled and publishes without review`,async()=>{
    const s=fixture(`late-${boundary}`),job=await service.enqueue(s.session);
    let delivered=false;
    const webhook=async()=>{
      delivered=true;
      s.lines=s.lines.map(line=>{const p=JSON.parse(line);return JSON.stringify(p.__parentId?p:{...p,title:'Late webhook title'});});
      await deliver(s,'PRODUCTS_UPDATE',{id:31},`late-${boundary}`);
    };
    const database={query:(...args)=>pool.query(...args),async connect(){
      const c=await pool.connect();let verified=false;
      return {release:error=>c.release(error),async query(sql,values){
        const result=await c.query(sql,values);
        if(sql.includes("SET status='VERIFIED',verified_at=now()"))verified=true;
        if(sql==='COMMIT'&&verified&&!delivered&&boundary==='before-phase-evidence')await webhook();
        return result;
      }};
    }};
    const lateRuntime=await createCatalogPhaseRuntime({...options,database});
    let row;
    for(let i=0;i<20;i++){
      await pool.query('UPDATE mirror.catalog_import_executions SET next_eligible_at=clock_timestamp() WHERE id=$1',[job.id]);
      await lateRuntime.processOne();
      row=(await pool.query('SELECT * FROM mirror.catalog_import_executions WHERE id=$1',[job.id])).rows[0];
      if(boundary==='before-publication'&&row.phase==='PUBLISHING'&&!delivered)await webhook();
      if(row.completed_at||row.review_required)break;
    }
    assert.equal(delivered,true);assert.ok(row.completed_at,JSON.stringify(row));assert.equal(row.review_required,false);
    const published=(await pool.query('SELECT generation_id FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0];
    assert.equal(published.generation_id,job.generationId);
    assert.equal((await pool.query('SELECT title FROM mirror.products WHERE shop_id=$1 AND generation_id=$2',[s.session.shop,published.generation_id])).rows[0].title,'Late webhook title');
    assert.equal((await pool.query('SELECT dirty FROM mirror.catalog_changes WHERE shop_id=$1',[s.session.shop])).rows[0].dirty,false);
    await pool.query('UPDATE mirror.catalog_refresh_requests SET scheduled_revision=requested_revision WHERE shop_id=$1',[s.session.shop]);
  });

  await t.test('real webhook fan-out is atomic, concurrent duplicate deliveries journal every product once',async()=>{
    const s=fixture('audit-fanout');
    await pool.query('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2)',[s.session.shop,'fanout-install']);
    const eventId='atomic-fanout',payload={product_ids:[101,102,103,102]};
    await Promise.all([1,2,3].map(()=>deliver(s,'COLLECTIONS_UPDATE',payload,eventId)));
    assert.equal((await pool.query('SELECT count(*) FROM mirror.mutation_journal WHERE shop_id=$1',[s.session.shop])).rows[0].count,'3');
    assert.deepEqual((await pool.query('SELECT revision::text FROM mirror.catalog_changes WHERE shop_id=$1',[s.session.shop])).rows.map(r=>r.revision),['1','1','1']);
    assert.equal((await pool.query('SELECT requested_revision::text FROM mirror.catalog_refresh_requests WHERE shop_id=$1',[s.session.shop])).rows[0].requested_revision,'1');
    // Fail the second journal write on a real transaction and verify that the
    // first write, receipt, and refresh request are all absent after rollback.
    const failing={connect:async()=>{
      const c=await pool.connect();return {release:()=>c.release(),query(sql,values){
        if(sql.includes('INSERT INTO mirror.mutation_journal')&&values[1]==='gid://shopify/Product/202')throw Error('Injected fanout failure');
        return c.query(sql,values);
      }};
    }};
    await assert.rejects(()=>handleWebhookEvent({database:failing,shop:s.session.shop,topic:'COLLECTIONS_UPDATE',body:JSON.stringify({product_ids:[201,202]}),webhookId:'rollback-fanout'}),/Injected/);
    assert.equal((await pool.query("SELECT count(*) FROM mirror.webhook_receipts WHERE shop_id=$1 AND event_id='rollback-fanout'",[s.session.shop])).rows[0].count,'0');
    assert.equal((await pool.query("SELECT count(*) FROM mirror.catalog_changes WHERE shop_id=$1 AND product_id='gid://shopify/Product/201'",[s.session.shop])).rows[0].count,'0');
    await deliver(s,'COLLECTIONS_UPDATE',{product_ids:[201,202]},'rollback-fanout');
    assert.equal((await pool.query('SELECT count(*) FROM mirror.mutation_journal WHERE shop_id=$1',[s.session.shop])).rows[0].count,'5');
    // Leave no scheduler work unrelated to the following tests.
    await pool.query('UPDATE mirror.catalog_refresh_requests SET scheduled_revision=requested_revision WHERE shop_id=$1',[s.session.shop]);
  });

  await t.test('post-publication product webhook publishes a replacement generation and preserves the old snapshot',async()=>{
    const s=fixture('audit-live-refresh');
    const initial=await service.onInstall(s.session);await drain(initial.id);
    const oldGeneration=initial.generationId;
    s.lines=s.lines.map(line=>{const p=JSON.parse(line);return JSON.stringify(p.__parentId?p:{...p,title:'Webhook title'});});
    await deliver(s,'PRODUCTS_UPDATE',{id:31},'post-publish-product');
    await due(s);await service.ensurePendingCatalogRefreshes();await service.ensurePendingCatalogRefreshes();
    const next=await latest(s);assert.notEqual(next.id,initial.id);
    assert.equal((await pool.query('SELECT generation_id FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0].generation_id,oldGeneration);
    await drain(next.id);
    assert.equal((await latest(s)).status,'SUCCEEDED');
    const published=(await pool.query('SELECT generation_id FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0].generation_id;
    assert.notEqual(published,oldGeneration);
    assert.equal((await pool.query('SELECT title FROM mirror.products WHERE shop_id=$1 AND generation_id=$2',[s.session.shop,published])).rows[0].title,'Webhook title');
    assert.equal((await pool.query('SELECT title FROM mirror.products WHERE shop_id=$1 AND generation_id=$2',[s.session.shop,oldGeneration])).rows[0].title,'Product');
    assert.equal((await pool.query('SELECT dirty FROM mirror.catalog_changes WHERE shop_id=$1',[s.session.shop])).rows[0].dirty,false);
  });

  await t.test('unmapped inventory event refreshes durable inventory through the complete catalog importer',async()=>{
    const s=fixture('audit-inventory-refresh');
    const initial=await service.onInstall(s.session);await drain(initial.id);
    s.lines=s.lines.map(line=>{const v=JSON.parse(line);return JSON.stringify(v.__parentId?{...v,inventoryQuantity:17}:v);});
    await deliver(s,'INVENTORY_LEVELS_UPDATE',{inventory_item_id:999,available:17},'unmapped-inventory');
    await due(s);await service.ensurePendingCatalogRefreshes();await service.ensurePendingCatalogRefreshes();
    const next=await latest(s);assert.notEqual(next.id,initial.id);await drain(next.id);
    const quantity=(await pool.query(`SELECT v.inventory_quantity::text FROM mirror.variants v JOIN mirror.publications p
      ON p.shop_id=v.shop_id AND p.generation_id=v.generation_id WHERE v.shop_id=$1`,[s.session.shop])).rows[0].inventory_quantity;
    assert.equal(quantity,'17');
  });

  await t.test('a webhook arriving during an import is retained until another generation is durably allocated',async()=>{
    const s=fixture('audit-mid-import');
    const initial=await service.onInstall(s.session);await drain(initial.id);
    await deliver(s,'INVENTORY_ITEMS_UPDATE',{id:999},'before-import');
    await due(s);await service.ensurePendingCatalogRefreshes();await service.ensurePendingCatalogRefreshes();
    const next=await latest(s);assert.notEqual(next.id,initial.id);
    await deliver(s,'INVENTORY_ITEMS_UPDATE',{id:999},'during-import');
    await due(s);await service.ensurePendingCatalogRefreshes();await service.ensurePendingCatalogRefreshes();
    assert.equal((await latest(s)).id,next.id);
    const pending=(await pool.query('SELECT requested_revision::text,scheduled_revision::text FROM mirror.catalog_refresh_requests WHERE shop_id=$1',[s.session.shop])).rows[0];
    assert.deepEqual(pending,{requested_revision:'2',scheduled_revision:'1'});
    await drain(next.id);
    await service.ensurePendingCatalogRefreshes();await service.ensurePendingCatalogRefreshes();
    const followup=await latest(s);assert.notEqual(followup.id,next.id);await drain(followup.id);
    const acknowledged=(await pool.query('SELECT requested_revision=scheduled_revision AS allocated FROM mirror.catalog_refresh_requests WHERE shop_id=$1',[s.session.shop])).rows[0];
    assert.equal(acknowledged.allocated,true);
  });

  await t.test('refresh intent is installation scoped and a new delivery resets old installation counters',async()=>{
    const s=fixture('audit-refresh-reinstall');
    await pool.query('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2)',[s.session.shop,'refresh-old-install']);
    await deliver(s,'INVENTORY_ITEMS_UPDATE',{id:999},'old-install-delivery');
    await pool.query('UPDATE mirror.shops SET installation_version=$2 WHERE id=$1',[s.session.shop,'refresh-new-install']);
    await due(s);await service.ensurePendingCatalogRefreshes();await service.ensurePendingCatalogRefreshes();
    assert.equal((await pool.query('SELECT count(*) FROM mirror.catalog_import_jobs WHERE shop_id=$1',[s.session.shop])).rows[0].count,'0');
    await deliver(s,'INVENTORY_ITEMS_UPDATE',{id:999},'new-install-delivery');
    const row=(await pool.query('SELECT installation_version,requested_revision::text,scheduled_revision::text,attempts FROM mirror.catalog_refresh_requests WHERE shop_id=$1',[s.session.shop])).rows[0];
    assert.deepEqual(row,{installation_version:'refresh-new-install',requested_revision:'1',scheduled_revision:'0',attempts:0});
    await due(s);await service.ensurePendingCatalogRefreshes();await service.ensurePendingCatalogRefreshes();
    const job=await latest(s);assert.equal(job.installation_version,'refresh-new-install');await drain(job.id);
  });
}
