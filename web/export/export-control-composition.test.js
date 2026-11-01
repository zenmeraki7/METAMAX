import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createExportRepository} from './export-repository.server.js';
import {createExportControlAdapter} from './export-control-adapter.server.js';

test('active production repository and control adapter share identity, DTO and cancellation semantics',async()=>{
 const id=randomUUID(),identity={shopId:'export.myshopify.com',installationId:'installation'},calls=[];
 const raw={id,shop_id:identity.shopId,installation_id:identity.installationId,state:'RUNNING',manifest:{format:'JSONL',fields:[{id:'product.title'}]},
  rows_committed:'12',bytes_committed:'240',attempts:2,lease_token:'private'};
 const pool={async connect(){throw Error('Control reads do not need synthetic transactions');},async query(sql,p){calls.push({sql,p});
  if(sql.includes('UPDATE export_engine.jobs'))return{rows:[{...raw,state:'CANCELLING'}]};
  return{rows:[raw]};
 }};
 const repository=createExportRepository({pool,generationProtection:{verify(){},renew(){},release(){}},verifyStoredPart(){},verifyFinalArtifact(){},verifyDeliveryEvidence(){},reconcileDelivery(){},verifyRecoveryEvidence(){}}),control=createExportControlAdapter(repository);
 const job=await control.getJob({identity,jobId:id});
 assert.equal(job.shopId,identity.shopId);assert.equal(job.installationId,identity.installationId);assert.equal(job.rowsCommitted,'12');
 assert.equal(job.bytesCommitted,'240');assert.equal('lease_token' in job,false);assert.equal('shop_id' in job,false);
 assert.equal((await control.requestCancellation({identity,jobId:id})).state,'CANCELLING');
 for(const call of calls)assert.deepEqual(call.p,[id,identity.shopId,identity.installationId]);
 assert.match(calls[1].sql,/cancel_requested = TRUE/);assert.match(calls[1].sql,/state = 'CANCELLING'/);
});

test('manifest compatibility repository cannot be composed with active export control',()=>{
 assert.throws(()=>createExportControlAdapter({storageContract:'mirror.export_manifest_jobs.compatibility',getJob(){}}),/Active export_engine/);
});
