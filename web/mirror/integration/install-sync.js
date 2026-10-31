import assert from 'node:assert/strict';
import {createApp} from '../../app.js';
import {handleWebhookEvent} from '../../privacy.js';
import {createCatalogPhaseRuntime} from '../../services/catalog-phase-runtime.server.js';
import {createCatalogImportService} from '../../services/catalog-import.server.js';

export async function testInstallSync(t,{pool,fixture,service,runtime,state,makeDue,shopify,sessions,options}) {
  const pass=()=> (_req,_res,next)=>next();
  const appShopify={...shopify,config:{...shopify.config,auth:{path:'/auth',callbackPath:'/auth/callback'},webhooks:{path:'/webhooks'}},
    auth:{begin:pass,callback:()=> (req,res,next)=>{
      const session=sessions.get(req.headers['x-test-session']);
      if(!session)return res.sendStatus(401);
      res.locals.shopify={session};next();
    }},redirectToShopifyOrAppRoot:()=> (_req,res)=>res.redirect('/'),cspHeaders:pass,processWebhooks:pass,
    validateAuthenticatedSession:pass,ensureInstalledOnShop:pass};
  const server=createApp({shopify:appShopify,staticPath:'.',catalogImportService:service}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const callback=session=>fetch(`http://127.0.0.1:${server.address().port}/auth/callback?shop=forged.myshopify.com`,{
    headers:session?{'x-test-session':session.id}:{},redirect:'manual'});
  async function finish(worker,id) {
    for(let i=0;i<12;i++) {
      await makeDue(id);await worker.processOne();
      const row=await state(id);if(row.completed_at)return row;
    }
    assert.fail('Initial sync did not complete');
  }
  try {
    await t.test('install callback commits one phase job before redirect; a fresh worker publishes it',async()=>{
      assert.equal((await callback()).status,401);
      const s=fixture('install-automatic');
      const responses=await Promise.all([1,2,3].map(()=>callback(s.session)));
      assert.ok(responses.every(r=>r.status===302));
      const jobs=(await pool.query('SELECT * FROM mirror.catalog_import_jobs WHERE shop_id=$1',[s.session.shop])).rows;
      assert.equal(jobs.length,1);assert.equal(jobs[0].execution_mode,'PHASE');
      assert.equal(s.starts,0);assert.equal((await state(jobs[0].id)).phase,'STARTING');
      const initialProgress=await service.current(s.session);
      assert.equal(initialProgress.id,jobs[0].id);assert.equal(initialProgress.progress.percent,5);
      const other=fixture('install-progress-other');const otherJob=await service.onInstall(other.session);
      assert.equal((await service.current(other.session)).id,otherJob.id);
      await service.cancel(other.session,otherJob.id);await runtime.processOne();
      assert.equal((await pool.query("SELECT count(*) FROM mirror.shops WHERE id='forged.myshopify.com'")).rows[0].count,'0');
      const fresh=await createCatalogPhaseRuntime(options);
      await finish(fresh,jobs[0].id);
      assert.equal((await service.status(s.session,jobs[0].id)).status,'SUCCEEDED');
      assert.equal((await service.current(s.session)).progress.percent,100);
      assert.equal((await pool.query('SELECT generation_id FROM mirror.publications WHERE shop_id=$1',[s.session.shop])).rows[0].generation_id,jobs[0].generation_id);
      assert.equal((await pool.query('SELECT count(*) FROM mirror.products WHERE shop_id=$1 AND generation_id=$2',[s.session.shop,jobs[0].generation_id])).rows[0].count,'1');
      assert.equal((await callback(s.session)).status,302);
      assert.equal((await service.ensureInitialSync(s.session)).id,jobs[0].id);
      assert.equal((await pool.query('SELECT count(*) FROM mirror.catalog_import_jobs WHERE shop_id=$1',[s.session.shop])).rows[0].count,'1');
      await fresh.stop();
    });
    await t.test('initial sync requires a persisted offline product-read credential',async()=>{
      const s=fixture('install-no-scope');s.session.scope='';
      assert.equal((await callback(s.session)).status,500);
      assert.equal((await pool.query('SELECT count(*) FROM mirror.shops WHERE id=$1',[s.session.shop])).rows[0].count,'0');
      const online=fixture('install-online');online.session.isOnline=true;
      assert.equal((await callback(online.session)).status,500);
      assert.equal((await pool.query('SELECT count(*) FROM mirror.catalog_import_jobs WHERE shop_id=$1',[online.session.shop])).rows[0].count,'0');
    });
    await t.test('reauthorization preserves an exhausted initial job while explicit manual sync can retry',async()=>{
      const s=fixture('install-exhausted');
      const legacy=createCatalogImportService({...options,phaseRuntime:undefined});
      const job=await legacy.onInstall(s.session);
      await pool.query("UPDATE mirror.catalog_import_jobs SET status='FAILED',attempts=8 WHERE id=$1",[job.id]);
      const duplicate=await legacy.onInstall(s.session);
      assert.equal(duplicate.id,job.id);assert.equal(duplicate.status,'FAILED');assert.equal(duplicate.attempts,8);
      assert.equal((await legacy.ensureInitialSync(s.session)).id,job.id);
      const manual=await legacy.enqueue(s.session);assert.notEqual(manual.id,job.id);
      await legacy.cancel(s.session,manual.id);
      await legacy.stop();
    });
    await t.test('uninstall fences old work; reinstall and restart discover one fresh initial delivery',async()=>{
      const s=fixture('install-again'),old=await service.onInstall(s.session);
      const original=(await pool.query('SELECT installation_version FROM mirror.shops WHERE id=$1',[s.session.shop])).rows[0].installation_version;
      await pool.query(`INSERT INTO mirror.subscriptions(shop_id,installation_version,updated_at) VALUES ($1,$2,now())`,[s.session.shop,original]);
      const event={topic:'APP_UNINSTALLED',shop:s.session.shop,body:'{}',webhookId:'install-uninstall',database:pool,sessionStorage:shopify.config.sessionStorage};
      await handleWebhookEvent(event);
      assert.equal(sessions.has(s.session.id),false);
      assert.equal((await state(old.id)).cancel_requested,false); // The worker discovers the job/installation cancellation.
      assert.equal((await pool.query('SELECT cancel_requested FROM mirror.catalog_import_jobs WHERE id=$1',[old.id])).rows[0].cancel_requested,true);
      sessions.set(s.session.id,s.session);
      await assert.rejects(service.ensureInitialSync(s.session),/Active installation required/);
      assert.equal(await service.onInstall(s.session),null); // Old staging generation still needs draining.
      const replacement=(await pool.query('SELECT installation_version FROM mirror.shops WHERE id=$1',[s.session.shop])).rows[0].installation_version;
      assert.notEqual(replacement,original);
      assert.equal((await pool.query('SELECT count(*) FROM mirror.subscriptions WHERE shop_id=$1',[s.session.shop])).rows[0].count,'0');
      await runtime.processOne();
      assert.ok((await state(old.id)).cancel_completed_at);
      const fresh=await createCatalogPhaseRuntime(options);
      const restarted=createCatalogImportService({...options,phaseRuntime:fresh});
      let next;
      for(let i=0;i<30&&!next;i++) {
        await restarted.ensurePendingInitialSyncs();
        next=(await pool.query('SELECT * FROM mirror.catalog_import_jobs WHERE shop_id=$1 AND installation_version=$2',[s.session.shop,replacement])).rows[0];
      }
      assert.ok(next);assert.notEqual(next.id,old.id);
      assert.equal((await handleWebhookEvent(event)).duplicate,true);
      assert.ok(sessions.has(s.session.id));
      assert.equal((await pool.query('SELECT uninstalled_at FROM mirror.shops WHERE id=$1',[s.session.shop])).rows[0].uninstalled_at,null);
      await finish(fresh,next.id);
      assert.equal((await restarted.onInstall(s.session)).id,next.id);
      await restarted.stop();
    });
  } finally {await new Promise(resolve=>server.close(resolve));}
}
