import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
let cleanup;
mock.module('../mirror/sync-run-service.server.js',{namedExports:{createSyncRunService:()=>({recordCheckpoint(){},async cancelGeneration(){}})}});
mock.module('../mirror/reconciliation-service.server.js',{namedExports:{createReconciliationService:()=>({})}});
mock.module('../mirror/bulk-operation-runner.server.js',{namedExports:{createBulkOperationRunner:()=>({async cancelBulkCatalogExport(input){assert.equal(input.reconcile,true);return cleanup;}})}});
const {createCatalogImportService}=await import('./catalog-import.server.js');
function fixture(rowCount=1){
 const statements=[],job={id:'job',shop_id:'cancel.myshopify.com',installation_version:'installed',fence:'5',run_id:'run',generation_id:'generation',status:'RUNNING'};
 const database={async connect(){assert.fail('Unexpected connection');},async query(sql,params){
  statements.push({sql,params});if(sql.includes('WITH due_cancel'))return {rows:[job]};return {rows:[],rowCount};
 }};
 return {statements,service:createCatalogImportService({database,shopify:{},clientFactory:()=>({}),logger:{error(){}}})};
}
test('legacy cancellation scanner persists pending or uncertain cleanup and retains retry eligibility',async()=>{
 for(const outcome of [{cancelled:false,state:'CANCELLING',outcomeUncertain:false},{cancelled:false,state:'CANCELLATION_REQUESTED',outcomeUncertain:true},undefined]){
  cleanup=outcome;const f=fixture(),result=await f.service.processOne();assert.equal(result.cancelPending,true);
  assert.equal(f.statements.some(({sql})=>sql.includes("SET status='CANCELLED'")),false);
  const saved=f.statements.at(-1);assert.match(saved.sql,/next_attempt_at=.*10 seconds/s);assert.match(saved.sql,/fence=\$3 AND cancel_requested AND lease_until>clock_timestamp/);
  assert.equal(saved.params[3],outcome?.outcomeUncertain===false?'REMOTE_CANCEL_PENDING':'REMOTE_CANCEL_OUTCOME_UNKNOWN');
 }
});
test('legacy cancellation reports terminal completion only after exact cleanup and one fenced acknowledgment',async()=>{
 cleanup={cancelled:true,state:'CANCELLED',outcomeUncertain:false};
 assert.equal((await fixture().service.processOne()).status,'CANCELLED');
 assert.equal((await fixture(0).service.processOne()).status,'SUPERSEDED');
});
