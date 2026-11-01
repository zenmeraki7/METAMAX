import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHistoryRepository } from '../history-repository.server.js';
import { createHistoryExecutionAdapter } from '../../services/history-execution-adapter.server.js';
import { getApprovedContractInTransaction } from '../../services/approval.server.js';
import { normalizeHistorySnapshot,historyFingerprint } from '../history-contract.js';
import {createHistoryExecution} from '../history-execution.server.js';
import {createOperationRecoveryScanner} from '../../workers/operation-recovery-scanner.server.js';
const base=f=>({authContext:f.input.authContext,operationId:f.input.operationId,mutationId:f.input.mutationId,attemptId:f.plan.attemptId});
export async function evidence(f,kind,override={}){
 const evidenceId=randomUUID();
 const record={...Object.fromEntries(['operationId','mutationId','attemptId','executionJobId','executionItemId','executionFenceEpoch','executionClaimId'].map(key=>[key,
  ({operationId:f.input.operationId,mutationId:f.input.mutationId,attemptId:f.plan.attemptId,executionJobId:f.command,executionItemId:f.item,executionFenceEpoch:f.plan.fenceEpoch,executionClaimId:f.plan.executionClaimId})[key]])),kind,evidenceId,
  fields:f.input.entries.map(entry=>{
   if(!['VERIFIED_OBSERVATION','CONFLICT_OBSERVATION'].includes(kind))return {fieldId:entry.intent.identity.fieldId};
   const original=entry.beforeSnapshot.observation,observation=Object.fromEntries(['source','resourceGid','fieldId','sourceRevision','receiptFingerprint'].map(key=>[key,original[key]]));
   Object.assign(observation,{observationId:randomUUID(),receiptId:randomUUID(),observedAt:new Date().toISOString()});
   return {fieldId:entry.intent.identity.fieldId,afterSnapshot:normalizeHistorySnapshot({identity:entry.intent.identity,binding:entry.intent.binding,kind:'OBSERVED_AFTER',valueKind:'VALUE',
    value:kind==='VERIFIED_OBSERVATION'?entry.intent.intendedValue:'Concurrent merchant edit',observation})};
  }),...override};
 record.fingerprint=historyFingerprint(record,'fixture-authenticated-mutation-evidence-v3');
 await f.q('INSERT INTO history_test_authority.evidence VALUES($1,$2,$3,$4,true)',[f.shopId,f.installationId,evidenceId,JSON.stringify(record)]);return evidenceId;
}
export async function testRepositoryQa(t,fixture,pool){
 await t.test('approval expiry after admission prevents consumption but does not erase no-write evidence',async()=>{
  const f=await fixture({approvalLifetimeMs:2000});await f.repository.prepareRequest(f.input);const dispatch=await f.repository.beginDispatch(f.input);
  await new Promise(resolve=>setTimeout(resolve,2100));
  await assert.rejects(()=>f.repository.consumeDispatch({...base(f),claim:f.input.claim,dispatchToken:dispatch.dispatchToken,dispatchHandoffKey:dispatch.dispatchHandoffKey}),{code:'HISTORY_OWNERSHIP_LOST'});
  await f.repository.recordVerifiedNoWrite({...base(f),claim:f.input.claim,dispatchToken:dispatch.dispatchToken,dispatchHandoffKey:dispatch.dispatchHandoffKey,evidenceId:await evidence(f,'AUTHORITATIVE_NO_WRITE')});
  assert.equal((await f.repository.getRequest(base(f))).requestState,'FAILED_NO_WRITE');
 });
 await t.test('command finalization reads the complete job independently of a last-item request',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);
  await f.repository.recordVerifiedNoWrite({...base(f),claim:f.input.claim,evidenceId:await evidence(f,'AUTHORITATIVE_NO_WRITE')});
  await f.q("UPDATE mirror.job_items SET status='FAILED' WHERE shop_id=$1 AND command_id=$2",[f.shopId,f.command]);
  await f.q("UPDATE mirror.job_commands SET status='FAILED',lease_token=NULL,lease_until=NULL WHERE shop_id=$1 AND id=$2",[f.shopId,f.command]);
  const result=await f.repository.finalizeExecutionJob({authContext:f.input.authContext,executionJobId:f.command,expectedTenant:{shopId:f.shopId,installationId:f.installationId}});
  assert.equal(result.completed,true);assert.equal(result.state,'FAILED');
  assert.equal((await f.q('SELECT operation_state FROM edit_history.operations WHERE shop_id=$1 AND execution_job_id=$2',[f.shopId,f.command])).rows[0].operation_state,'FAILED');
 });
 await t.test('complete persisted multi-field evidence is verified on the worker transaction',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);const dispatch=await f.repository.beginDispatch(f.input);
  await f.repository.consumeDispatch({...base(f),claim:f.input.claim,dispatchToken:dispatch.dispatchToken,dispatchHandoffKey:dispatch.dispatchHandoffKey});
  await f.repository.recordMutationOutcome({...base(f),claim:f.input.claim,evidenceId:await evidence(f,'SHOPIFY_ACKNOWLEDGEMENT')});
  await f.repository.recordVerification({...base(f),claim:f.input.claim,evidenceId:await evidence(f,'VERIFIED_OBSERVATION')});
  const tx=await pool.operationWorker.connect();
  try{
   await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true)",[f.shopId]);
   const args={tx,authContext:f.input.authContext,operationId:f.input.operationId,mutationId:f.input.mutationId,
    claim:{shop_id:f.shopId,installation_version:f.installationId,id:f.command,fence:f.input.claim.fenceEpoch,lease_token:f.input.claim.leaseToken},
    item:{id:f.item,resource_id:f.input.entries[0].intent.identity.resourceGid},approved:f.plan.itemIntendedValues};
   assert.equal(await f.repository.verifyItemCompletion(args),true);
   await assert.rejects(()=>f.repository.verifyItemCompletion({...args,approved:{title:args.approved.title}}),{code:'HISTORY_VERIFICATION_INCOMPLETE'});
   await tx.query('ROLLBACK');
  }finally{tx.release();}
 });
 await t.test('dispatch guard runs inside admission and revocation rolls back authorization',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);
  let calls=0;
  await assert.rejects(()=>f.repository.beginDispatch(f.input,{dispatchGuard:async tx=>{
   calls++;const row=(await tx.query('SELECT txid_current()::text AS transaction_id')).rows[0];assert.ok(row.transaction_id);
   throw Object.assign(Error('Current write permission revoked'),{code:'HISTORY_UNAUTHORIZED'});
  }}),{code:'HISTORY_UNAUTHORIZED'});
  assert.equal(calls,1);assert.equal((await f.repository.getRequest(base(f))).requestState,'PREPARED');
 });
 await t.test('authority adapter verifies exact columns and FK joins; schema drift is rejected',async()=>{
  const tx=await pool.adminConnect(),adapter=createHistoryExecutionAdapter();
  try{
   await tx.query('BEGIN');await adapter.verifySchema(tx);
   await tx.query('ALTER TABLE mirror.job_commands RENAME COLUMN lease_until TO wrong_lease_until');
   await assert.rejects(()=>adapter.verifySchema(tx),{code:'HISTORY_BINDING_CONFLICT'});await tx.query('ROLLBACK');
   await tx.query('BEGIN');await tx.query('ALTER TABLE mirror.job_commands DROP CONSTRAINT job_commands_shop_id_contract_id_fkey');
   await assert.rejects(()=>adapter.verifySchema(tx),{code:'HISTORY_BINDING_CONFLICT'});await tx.query('ROLLBACK');
  }finally{await tx.query('ROLLBACK').catch(()=>{});tx.release();}
 });
 await t.test('approval reads use the explicit connection and transaction exclusively',async()=>{
  const f=await fixture(),tx=await pool.connect();let selects=0;
  try{await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true)",[f.shopId]);const before=(await tx.query('SELECT txid_current()::text AS id')).rows[0].id;
   const approval=await getApprovedContractInTransaction({client:{query(sql,values){selects++;return tx.query(sql,values);}},shopId:f.shopId,contractId:f.contractId});
   assert.equal(approval.id,f.contractId);assert.equal(selects,2);assert.equal((await tx.query('SELECT txid_current()::text AS id')).rows[0].id,before);
   await assert.rejects(()=>getApprovedContractInTransaction({shopId:f.shopId,contractId:f.contractId}),TypeError);
  }finally{await tx.query('ROLLBACK');tx.release();}
 });
 await t.test('installation replacement invalidates even an intact hashed approval',async()=>{
  const f=await fixture();
  const approved=await getApprovedContractInTransaction({client:{query:f.q},shopId:f.shopId,contractId:f.contractId});
  assert.equal(approved.contract.executionCoordinates.installationVersion,f.installationId);
  await f.q('UPDATE mirror.shops SET installation_version=$2 WHERE id=$1',[f.shopId,randomUUID()]);
  await assert.rejects(()=>getApprovedContractInTransaction({client:{query:f.q},shopId:f.shopId,contractId:f.contractId}),{code:'FIELD_CONTRACT_MISMATCH'});
 });
 await t.test('journal admission grants cannot authorize dispatch or consume a dispatch capability',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);f.state.dispatchAllowed=false;
  await assert.rejects(()=>f.repository.beginDispatch(f.input),{code:'HISTORY_UNAUTHORIZED'});
  f.state.dispatchAllowed=true;const dispatch=await f.repository.beginDispatch(f.input);
  f.state.dispatchAllowed=false;
  await assert.rejects(()=>f.repository.consumeDispatch({...base(f),claim:f.input.claim,dispatchToken:dispatch.dispatchToken}),{code:'HISTORY_UNAUTHORIZED'});
  f.state.dispatchAllowed=true;
  const results=await Promise.allSettled([f.repository.consumeDispatch({...base(f),claim:f.input.claim,dispatchToken:dispatch.dispatchToken}),f.repository.consumeDispatch({...base(f),claim:f.input.claim,dispatchToken:dispatch.dispatchToken})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
 });
 await t.test('all mutation fields acknowledge and verify atomically with immutable after observations',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);const dispatch=await f.repository.beginDispatch(f.input);
  await f.repository.consumeDispatch({...base(f),claim:f.input.claim,dispatchToken:dispatch.dispatchToken});
  const ack=await evidence(f,'SHOPIFY_ACKNOWLEDGEMENT');
  assert.equal((await f.repository.recordMutationOutcome({...base(f),claim:f.input.claim,evidenceId:ack})).state,'ACKNOWLEDGED');
  const verified=await evidence(f,'VERIFIED_OBSERVATION'),input={...base(f),claim:f.input.claim,evidenceId:verified};
  const result=await f.repository.recordVerification(input);assert.equal(result.state,'VERIFIED');assert.equal(result.observationIds.length,2);
  const replay=await f.repository.recordVerification(input);assert.deepEqual(replay.observationIds,result.observationIds);
  assert.equal((await f.q("SELECT count(*) FROM edit_history.snapshots WHERE shop_id=$1 AND snapshot_kind='OBSERVED_AFTER'",[f.shopId])).rows[0].count,'2');
  assert.equal((await f.q('SELECT changes_verified FROM edit_history.operations WHERE shop_id=$1',[f.shopId])).rows[0].changes_verified,'2');
 });
 await t.test('incomplete and unauthenticated outcome receipts cannot modify any field',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);await f.repository.beginDispatch(f.input);
  const id=await evidence(f,'SHOPIFY_ACKNOWLEDGEMENT');await f.q('UPDATE history_test_authority.evidence SET authenticated=false WHERE evidence_id=$1',[id]);
  await assert.rejects(()=>f.repository.recordMutationOutcome({...base(f),claim:f.input.claim,evidenceId:id}),{code:'HISTORY_EVIDENCE_REQUIRED'});
  const partial=await evidence(f,'SHOPIFY_ACKNOWLEDGEMENT',{fields:[{fieldId:f.input.entries[0].intent.identity.fieldId}]});
  await assert.rejects(()=>f.repository.recordMutationOutcome({...base(f),claim:f.input.claim,evidenceId:partial}),{code:'HISTORY_EVIDENCE_CONFLICT'});
  assert.deepEqual((await f.q('SELECT DISTINCT mutation_state FROM edit_history.changes WHERE shop_id=$1',[f.shopId])).rows.map(row=>row.mutation_state),['DISPATCHING']);
 });
 await t.test('crash after dispatch commit is discovered and reconciled without automatic resubmission',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);await f.repository.beginDispatch(f.input); // crash before consume / HTTP
  await f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()-interval '1 second' WHERE shop_id=$1 AND id=$2",[f.shopId,f.command]);
  assert.equal((await f.repository.discoverOutcomeRecovery({authContext:f.input.authContext})).scheduledRequests,1);
  const claim=await f.repository.claimOutcomeRecovery({...base(f),workerId:'recovery-1'});assert.ok(claim);
  assert.equal((await f.repository.getRequest(base(f))).state,'OUTCOME_UNKNOWN');
  const verified=await evidence(f,'VERIFIED_OBSERVATION');
  await assert.rejects(()=>f.repository.recordVerification({...base(f),claim:f.input.claim,evidenceId:verified}),{code:'HISTORY_OWNERSHIP_LOST'});
  assert.equal((await f.repository.recordVerification({...base(f),recoveryClaim:claim,evidenceId:verified})).state,'VERIFIED');
  assert.equal((await f.q("SELECT count(*) FROM edit_history.recovery_tasks WHERE shop_id=$1 AND task_state='COMPLETED'",[f.shopId])).rows[0].count,'2');
  await assert.rejects(()=>f.repository.beginDispatch(f.input));
 });
 await t.test('independent scanner finds a consumed dispatch even when the worker wrote no recovery task',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);const dispatch=await f.repository.beginDispatch(f.input);
  await f.repository.consumeDispatch({...base(f),claim:f.input.claim,dispatchToken:dispatch.dispatchToken,dispatchHandoffKey:dispatch.dispatchHandoffKey});
  assert.equal((await f.q('SELECT count(*) FROM edit_history.recovery_tasks WHERE shop_id=$1',[f.shopId])).rows[0].count,'0');
  await f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()-interval '1 second' WHERE shop_id=$1 AND id=$2",[f.shopId,f.command]);
  await assert.rejects(()=>f.repository.discoverOutcomeRecovery({authContext:f.input.authContext,expectedTenant:{shopId:'other.myshopify.com',installationId:f.installationId}}),{code:'HISTORY_UNAUTHORIZED'});
  const historyExecution=createHistoryExecution({historyRepository:f.repository,resolveRecoveryAuth:async()=>f.input.authContext,
   loadExecutionRequest:async()=>assert.fail('No old worker needed'),persistEvidence:async()=>assert.fail('No original-worker persistence needed')});
  const scanner=createOperationRecoveryScanner({database:{connect:()=>pool.adminConnect()},historyExecution,logger:{error(){}}});
  assert.equal((await scanner.runOne({workerId:'independent-scanner',shopId:f.shopId,commandId:f.command})).kind,'RECOVERY_SCHEDULED');
  assert.equal((await f.q('SELECT count(*) FROM edit_history.recovery_tasks WHERE shop_id=$1',[f.shopId])).rows[0].count,String(f.input.entries.length));
  assert.equal((await f.q("SELECT checkpoint->'recoveryScan'->>'state' AS state FROM mirror.job_commands WHERE shop_id=$1 AND id=$2",[f.shopId,f.command])).rows[0].state,'SCHEDULED');
 });
 await t.test('recovery takeover fences stale owners; bounded retry preserves uncertainty and ends in review',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);await f.repository.beginDispatch(f.input);
  await f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()-interval '1 second' WHERE shop_id=$1 AND id=$2",[f.shopId,f.command]);
  const first=await f.repository.claimOutcomeRecovery({...base(f),workerId:'worker-1'});
  assert.equal(await f.repository.claimOutcomeRecovery({...base(f),workerId:'worker-2'}),null);
  await f.q("UPDATE edit_history.recovery_tasks SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE shop_id=$1",[f.shopId]);
  const second=await f.repository.claimOutcomeRecovery({...base(f),workerId:'worker-2'});assert.ok(BigInt(second.fenceEpoch)>BigInt(first.fenceEpoch));
  await assert.rejects(()=>f.repository.retryOutcomeRecovery({...base(f),recoveryClaim:first,errorCode:'OLD_WORKER'}),{code:'HISTORY_OWNERSHIP_LOST'});
  await f.repository.renewOutcomeRecovery({...base(f),recoveryClaim:second});
  const retry=await f.repository.retryOutcomeRecovery({...base(f),recoveryClaim:second,errorCode:'REMOTE_UNAVAILABLE'});assert.equal(retry.state,'RETRY_WAIT');assert.ok(retry.delaySeconds>=30);
  assert.equal(await f.repository.claimOutcomeRecovery({...base(f),workerId:'not-due'}),null);
  await f.q("UPDATE edit_history.recovery_tasks SET available_at=clock_timestamp()-interval '1 second',attempt_count=max_attempts WHERE shop_id=$1",[f.shopId]);
  assert.equal(await f.repository.claimOutcomeRecovery({...base(f),workerId:'budget-exhausted'}),null);
  assert.equal((await f.q("SELECT count(*) FROM edit_history.recovery_tasks WHERE shop_id=$1 AND task_state='REVIEW_REQUIRED'",[f.shopId])).rows[0].count,'2');
  assert.equal((await f.repository.getRequest(base(f))).state,'OUTCOME_UNKNOWN');
 });
 await t.test('authoritative no-write and conflict classifications are persisted for the entire request',async()=>{
  for(const kind of ['AUTHORITATIVE_NO_WRITE','CONFLICT_OBSERVATION']){
   const f=await fixture();await f.repository.prepareRequest(f.input);
   if(kind==='CONFLICT_OBSERVATION'){await f.repository.beginDispatch(f.input);const ack=await evidence(f,'SHOPIFY_ACKNOWLEDGEMENT');await f.repository.recordMutationOutcome({...base(f),claim:f.input.claim,evidenceId:ack});}
   const id=await evidence(f,kind),input={...base(f),claim:f.input.claim,evidenceId:id};
   const result=kind==='CONFLICT_OBSERVATION'?await f.repository.recordVerification(input):await f.repository.recordVerifiedNoWrite(input);
   assert.equal(result.state,kind==='CONFLICT_OBSERVATION'?'CONFLICT':'FAILED_NO_WRITE');
   assert.equal((await f.q('SELECT changes_failed FROM edit_history.operations WHERE shop_id=$1',[f.shopId])).rows[0].changes_failed,'2');
  }
 });
 await t.test('database request envelopes prevent bypassing the repository with an incomplete field set',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);
  const tx=await pool.connect();try{await tx.query('BEGIN');await tx.query("SELECT set_config('app.shop_id',$1,true)",[f.shopId]);
   await tx.query(`INSERT INTO edit_history.mutation_requests(id,shop_id,installation_id,operation_id,mutation_id,attempt_id,attempt_number,
    execution_item_id,execution_fence_epoch,execution_claim_id,mutation_plan_fingerprint,request_fingerprint,resource_field_set,field_count,request_state,dispatch_handoff_key)
    SELECT $2,shop_id,installation_id,operation_id,'independent-request','independent-attempt',1,execution_item_id,execution_fence_epoch,execution_claim_id,
    mutation_plan_fingerprint,request_fingerprint,resource_field_set,field_count,'PREPARED','independent-handoff' FROM edit_history.mutation_requests WHERE shop_id=$1`,[f.shopId,randomUUID()]);
   await assert.rejects(()=>tx.query('COMMIT'),{code:'23514'});
  }finally{await tx.query('ROLLBACK').catch(()=>{});tx.release();}
  assert.equal((await f.q('SELECT count(*) FROM edit_history.mutation_requests WHERE shop_id=$1',[f.shopId])).rows[0].count,'1');
 });
 await t.test('authenticated history pagination preserves keysets and rejects cursor reuse across capabilities and tenants',async()=>{
  const f=await fixture(),other=await fixture();await f.repository.prepareRequest(f.input);await other.repository.prepareRequest(other.input);
  const input={authContext:f.input.authContext,operationId:f.input.operationId,limit:1};
  const first=await f.repository.listChanges(input);assert.equal(first.items.length,1);assert.ok(first.nextCursor);
  const second=await f.repository.listChanges({...input,cursor:first.nextCursor});assert.equal(second.items.length,1);assert.notEqual(first.items[0].changeId,second.items[0].changeId);assert.equal(second.nextCursor,null);
  await assert.rejects(()=>other.repository.listChanges({authContext:other.input.authContext,operationId:other.input.operationId,limit:1,cursor:first.nextCursor}),{code:'HISTORY_UNAUTHORIZED'});
  await assert.rejects(()=>f.repository.listOperations({authContext:f.input.authContext,cursor:first.nextCursor}),{code:'HISTORY_UNAUTHORIZED'});
  await assert.rejects(()=>f.repository.listChanges({...input,cursor:'x'+first.nextCursor.slice(1)}),{code:'HISTORY_INVALID_INPUT'});
  const ops=await f.repository.listOperations({authContext:f.input.authContext});assert.equal(ops.items[0].operationId,f.input.operationId);
  assert.ok(!JSON.stringify(first).includes('executionClaimId')&&!JSON.stringify(first).includes('leaseToken'));
 });
 await t.test('replay authenticates the persisted BEFORE receipt instead of relying on the caller snapshot',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);
  await f.q('DELETE FROM history_test_authority.observations WHERE shop_id=$1 AND receipt_id=$2',[f.shopId,f.input.entries[0].beforeSnapshot.observation.receiptId]);
  await assert.rejects(()=>f.repository.prepareRequest(f.input),{code:'HISTORY_EVIDENCE_REQUIRED',message:'Persisted observation receipt is not authentic'});
  assert.equal((await f.q('SELECT count(*) FROM edit_history.changes WHERE shop_id=$1',[f.shopId])).rows[0].count,'2');
 });
 await t.test('independent SQL cannot add an undeclared field even with a matching BEFORE snapshot',async()=>{
  const f=await fixture(),receipt=await f.repository.prepareRequest(f.input),tx=await pool.adminConnect(),changeId=randomUUID(),snapshotId=randomUUID();
  try{
   await tx.query('BEGIN');
   await tx.query(`INSERT INTO edit_history.changes SELECT (jsonb_populate_record(NULL::edit_history.changes,
    to_jsonb(c)||jsonb_build_object('id',$2::text,'field_id','product.handle'))).* FROM edit_history.changes c WHERE c.id=$1`,[receipt.fields[0].changeId,changeId]);
   await tx.query(`INSERT INTO edit_history.snapshots SELECT (jsonb_populate_record(NULL::edit_history.snapshots,
    to_jsonb(s)||jsonb_build_object('id',$2::text,'change_id',$3::text,'field_id','product.handle'))).* FROM edit_history.snapshots s WHERE s.id=$1`,[receipt.fields[0].snapshotId,snapshotId,changeId]);
   await assert.rejects(()=>tx.query('COMMIT'),{code:'23514',message:'Mutation request does not match complete journal field set'});
  }finally{await tx.query('ROLLBACK').catch(()=>{});tx.release();}
  assert.equal((await f.q('SELECT count(*) FROM edit_history.changes WHERE shop_id=$1',[f.shopId])).rows[0].count,'2');
 });
 await t.test('a lost outcome COMMIT is not replayed and the completed request remains inspectable',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);await f.repository.beginDispatch(f.input);
  const id=await evidence(f,'SHOPIFY_ACKNOWLEDGEMENT');let commits=0;
  const database={async connect(){const client=await pool.connect();return{release:()=>client.release(),async query(sql,values){const result=await client.query(sql,values);if(sql==='COMMIT'){commits++;throw Object.assign(Error('lost outcome COMMIT'),{code:'ECONNRESET'});}return result;}};}};
  await assert.rejects(()=>createHistoryRepository({database,...f.adapters}).recordMutationOutcome({...base(f),claim:f.input.claim,evidenceId:id}),{code:'ECONNRESET'});
  assert.equal(commits,1);assert.equal((await f.repository.getRequest(base(f))).state,'ACKNOWLEDGED');
  assert.equal((await f.repository.recordMutationOutcome({...base(f),claim:f.input.claim,evidenceId:id})).state,'ACKNOWLEDGED');
 });
 await t.test('recovery lease expiry during evidence verification rolls back snapshots and acknowledgement',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);await f.repository.beginDispatch(f.input);
  await f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()-interval '1 second' WHERE shop_id=$1 AND id=$2",[f.shopId,f.command]);
  const claim=await f.repository.claimOutcomeRecovery({...base(f),workerId:'slow-recovery'}),id=await evidence(f,'VERIFIED_OBSERVATION');
  await f.q("UPDATE edit_history.recovery_tasks SET claim_expires_at=clock_timestamp()+interval '1 second' WHERE shop_id=$1",[f.shopId]);
  let verified=false;
  const repository=createHistoryRepository({database:pool,...f.adapters,verifyMutationEvidence:async context=>{const valid=await f.adapters.verifyMutationEvidence(context);verified=true;await context.client.query('SELECT pg_sleep(1.1)');return valid;}});
  await assert.rejects(()=>repository.recordVerification({...base(f),recoveryClaim:claim,evidenceId:id}),{code:'HISTORY_OWNERSHIP_LOST'});
  assert.equal(verified,true);assert.equal((await f.repository.getRequest(base(f))).state,'OUTCOME_UNKNOWN');
  assert.equal((await f.q("SELECT count(*) FROM edit_history.snapshots WHERE shop_id=$1 AND snapshot_kind='OBSERVED_AFTER'",[f.shopId])).rows[0].count,'0');
 });
 await t.test('recovery permissions are action-specific and revocation rolls back the transaction',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);await f.repository.beginDispatch(f.input);
  await f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()-interval '1 second' WHERE shop_id=$1 AND id=$2",[f.shopId,f.command]);
  const claim=await f.repository.claimOutcomeRecovery({...base(f),workerId:'permission-owner'});let cancellations=0;
  const repository=createHistoryRepository({database:pool,...f.adapters,authorizeRecovery:async context=>{
   if(context.operation==='renew_outcome_recovery')return false;
   if(context.operation==='cancel_outcome_recovery')return ++cancellations===1;
   return true;
  }});
  await assert.rejects(()=>repository.renewOutcomeRecovery({...base(f),recoveryClaim:claim}),{code:'HISTORY_UNAUTHORIZED'});
  await assert.rejects(()=>repository.cancelOutcomeRecovery(base(f)),{code:'HISTORY_UNAUTHORIZED'});
  assert.equal(cancellations,2);
  assert.equal((await f.q("SELECT count(*) FROM edit_history.recovery_tasks WHERE shop_id=$1 AND task_state='RECONCILING'",[f.shopId])).rows[0].count,'2');
  assert.equal((await f.repository.renewOutcomeRecovery({...base(f),recoveryClaim:claim})).renewed,true);
 });
 await t.test('cancelled recovery cannot be reclaimed or completed by its previous owner',async()=>{
  const f=await fixture();await f.repository.prepareRequest(f.input);await f.repository.beginDispatch(f.input);
  await f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()-interval '1 second' WHERE shop_id=$1 AND id=$2",[f.shopId,f.command]);
  const claim=await f.repository.claimOutcomeRecovery({...base(f),workerId:'cancelled-owner'});await f.repository.cancelOutcomeRecovery(base(f));
  assert.equal(await f.repository.claimOutcomeRecovery({...base(f),workerId:'replacement'}),null);
  const id=await evidence(f,'VERIFIED_OBSERVATION');await assert.rejects(()=>f.repository.recordVerification({...base(f),recoveryClaim:claim,evidenceId:id}),{code:'HISTORY_OWNERSHIP_LOST'});
  assert.equal((await f.repository.getRequest(base(f))).state,'OUTCOME_UNKNOWN');
 });
}
