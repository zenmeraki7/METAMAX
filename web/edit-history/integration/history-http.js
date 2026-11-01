import {createDatabaseInstallationResolver} from '../../security/installation-lifecycle.server.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {createHistoryRouter} from '../history.routes.js';
import {createHistoryReadService} from '../history-read.server.js';
import {createFilterAuthentication} from '../../middleware/filter-auth.server.js';

export async function testHistoryHttp(t,pool) {
  const shop='audit-history.myshopify.com',other='audit-history-other.myshopify.com',installation='history-current';
  await pool.query('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2),($3,$2)',[shop,installation,other]);
  const sessions=new Map([shop,other].map(shop=>[shop,{id:`offline_${shop}`,shop,isOnline:false,scope:'read_products',accessToken:'test'}]));
  const authentication=createFilterAuthentication({resolveInstallation:createDatabaseInstallationResolver({database:pool}),sessionStorage:{loadSession:async id=>[...sessions.values()].find(s=>s.id===id)}});
  const secret='history-test-cursor-key-with-32-bytes-minimum';
  async function operation(shopId,install=installation,purged=false) {
    const id=randomUUID();
    await pool.query(`INSERT INTO edit_history.operations(id,shop_id,installation_id,execution_job_id,operation_kind,execution_fingerprint,created_at,updated_at,purge_requested_at)
      VALUES($1,$2,$3,1,'BULK_EDIT',$4,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z',$5)`,
    [id,shopId,install,`sha256:${'a'.repeat(64)}`,purged?new Date():null]);
    return id;
  }
  // Execution job IDs are unique per installation; use different IDs in later rows.
  const visible=await operation(shop);
  const old=await operation(shop,'history-old');
  const foreign=await operation(other);
  const purged=randomUUID();
  await pool.query(`INSERT INTO edit_history.operations(id,shop_id,installation_id,execution_job_id,operation_kind,execution_fingerprint,purge_requested_at)
    VALUES($1,$2,$3,2,'BULK_EDIT',$4,clock_timestamp())`,[purged,shop,installation,`sha256:${'a'.repeat(64)}`]);
  const tied=randomUUID();
  await pool.query(`INSERT INTO edit_history.operations(id,shop_id,installation_id,execution_job_id,operation_kind,execution_fingerprint,created_at,updated_at)
    VALUES($1,$2,$3,3,'BULK_EDIT',$4,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`,[tied,shop,installation,`sha256:${'a'.repeat(64)}`]);

  const app=express();
  app.use((req,res,next)=>{res.locals.shopify={session:sessions.get(req.headers['x-test-shop']??shop)};next();});
  app.use(authentication.capture);
  app.use('/history',createHistoryRouter({database:pool,authentication,cursorSecret:secret,logger:{error(){}}}));
  const denied=createHistoryReadService({database:pool,authentication,cursorSecret:secret,authorizeHistoryRead:async()=>false});
  app.use('/denied',createHistoryRouter({authentication,historyReadService:denied,logger:{error(){}}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const request=(path,shopId=shop)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{'x-test-shop':shopId}});
  try {
    await t.test('history HTTP resolves real opaque authentication and excludes other shops, prior installations and purged operations',async()=>{
      const response=await request('/history');assert.equal(response.status,200);
      const result=await response.json();assert.deepEqual(result.operations.map(o=>o.id).sort(),[visible,tied].sort());
      assert.match(response.headers.get('cache-control'),/no-store/);
      assert.equal((await request(`/history/${visible}`)).status,200);
      for(const id of [old,foreign,purged]){
        assert.equal((await request(`/history/${id}`)).status,404);
        const changes=await request(`/history/${id}/changes`);assert.equal(changes.status,200);
        assert.deepEqual((await changes.json()).changes,[]);
      }
    });
    await t.test('history permission denial is enforced independently on every read route',async()=>{
      for(const path of ['/denied',`/denied/${visible}`,`/denied/${visible}/changes`])assert.equal((await request(path)).status,403);
      const stored=sessions.get(shop);sessions.set(shop,{...stored,scope:'read_orders'});
      try{assert.equal((await request('/history')).status,403);}finally{sessions.set(shop,stored);}
      sessions.set(shop,{...stored,isOnline:true,expires:new Date(Date.now()+60000),onlineAccessInfo:{associated_user_scope:'read_orders',associated_user:{id:7}}});
      try{assert.equal((await request('/history')).status,403);}finally{sessions.set(shop,stored);}
    });
    await t.test('history cursors preserve timestamp ties and reject cross-shop reuse and browser tenant overrides',async()=>{
      const first=await (await request('/history?limit=1')).json();
      assert.equal(first.pageInfo.hasNextPage,true);
      const second=await (await request(`/history?limit=1&cursor=${encodeURIComponent(first.pageInfo.endCursor)}`)).json();
      assert.equal(second.pageInfo.hasNextPage,false);
      assert.deepEqual([first.operations[0].id,second.operations[0].id].sort(),[visible,tied].sort());
      assert.equal((await request(`/history?cursor=${encodeURIComponent(first.pageInfo.endCursor)}`,other)).status,403);
      for(const query of ['shop=forged.myshopify.com','limit=1.5','limit=Infinity','limit=101','cursor=bad'])assert.equal((await request(`/history?${query}`)).status,400);
    });
    await t.test('uninstalled history tenant and revoked sessions fail closed',async()=>{
      await pool.query('UPDATE mirror.shops SET uninstalled_at=clock_timestamp() WHERE id=$1',[other]);
      assert.equal((await request('/history',other)).status,403);
      const stored=sessions.get(shop);sessions.delete(shop);
      try{assert.equal((await request('/history')).status,401);}finally{sessions.set(shop,stored);}
    });
  }finally{await new Promise(resolve=>server.close(resolve));}
}
