import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicationRepository} from './publication-repository.server.js';
function fixture({blocked=false,referenced=false,retained=false}={}){
 const calls=[];const client={async query(sql,params){calls.push({sql,params});
  if(sql.includes('SELECT id, status, retain_until'))return {rows:[{id:'old',status:'RETIRED',retain_until:new Date(Date.now()+(retained?60000:-60000))}],rowCount:1};
  if(sql.includes('SELECT j.id,j.status'))return {rows:[{id:'execution',status:'SUCCEEDED',phase:'PUBLISHING',fence:2n,delivery_revision:5n,installation_version:'installation',completed_at:new Date(Date.now()-90000000)}],rowCount:1};
  if(sql.includes('FROM mirror.publications WHERE')&&sql.includes('UNION ALL'))return {rows:referenced?[{}]:[],rowCount:referenced?1:0};
  if(sql.includes('SELECT 1 FROM mirror.catalog_import_jobs'))return {rows:blocked?[{}]:[],rowCount:blocked?1:0};
  if(sql.includes('SELECT operation_id,state'))return {rows:[{operation_id:'gid://shopify/BulkOperation/1',state:'CONFIRMED',remote_status:'COMPLETED'}]};
  return {rows:[],rowCount:0};
 },release(){}};
 return {calls,run:()=>createPublicationRepository({database:{async connect(){return client;}}}).reclaimGeneration({shopId:'retention.myshopify.com',generationId:'old'})};
}
test('generation reclamation archives terminal history before removing RESTRICT references in dependency order',async()=>{
 const f=fixture();assert.equal(await f.run(),true);
 const sql=f.calls.map(c=>c.sql);const index=table=>sql.findIndex(s=>s.startsWith('DELETE FROM mirror.'+table+' '));
 assert.ok(sql.findIndex(s=>s.includes('INSERT INTO mirror.catalog_retention_audit'))<index('sync_dispatches'));
 assert.ok(index('sync_dispatch_recovery_evidence')<index('sync_dispatches'));
 assert.ok(index('sync_dispatches')<index('ingestion_runs'));assert.ok(index('ingestion_runs')<index('catalog_import_executions'));
 assert.ok(index('catalog_import_executions')<index('catalog_import_jobs'));assert.ok(index('catalog_import_jobs')<index('generations'));
 assert.equal(sql.at(-1),'COMMIT');
 const guard=sql.find(s=>s.includes('SELECT 1 FROM mirror.catalog_import_jobs'));
 for(const required of ['outcome_uncertain','review_required','cancel_completed_at','24 hours','sync_dispatches','mutation_journal','lease_token',"j.cancel_requested AND j.status NOT IN ('CANCELLED','SUCCEEDED')"])assert.ok(guard.includes(required),required);
});
test('uncertain history, live references and unexpired retention preserve all generation and execution rows',async()=>{
 const blocked=fixture({blocked:true});assert.equal(await blocked.run(),false);assert.equal(blocked.calls.some(c=>c.sql.startsWith('DELETE')),false);
 for(const options of [{referenced:true},{retained:true}]){const f=fixture(options);await assert.rejects(()=>f.run());assert.equal(f.calls.some(c=>c.sql.startsWith('DELETE')),false);assert.equal(f.calls.at(-1).sql,'ROLLBACK');}
});
