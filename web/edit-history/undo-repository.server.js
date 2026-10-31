/** Durable undo approval/handoff state. Never performs remote writes. */
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assertHistoryRepository} from './history-repository.server.js';
import {protectedHistoryDatabase} from './database-security.server.js';
import {createHistoryHookInvoker} from './transaction-hooks.server.js';
import {historyFingerprint,requireHistoryId,HistoryContractError,HISTORY_ERROR_CODES as C} from './history-contract.js';
import {getApprovedContractInTransaction} from '../services/approval.server.js';
import {undoInstructions,productUpdates} from '../services/operation-instructions.server.js';
const issued=new WeakSet(),fail=message=>{throw new HistoryContractError(C.UNAUTHORIZED,message);};
const names=Object.freeze({'product.title':'title','product.handle':'handle','product.descriptionHtml':'descriptionHtml','product.vendor':'vendor',
 'product.productType':'productType','product.status':'status','product.tags':'tags','product.templateSuffix':'templateSuffix'});
export function assertUndoRepository(repository){if(!issued.has(repository))throw TypeError('Issued undo repository required');}
export function createUndoRepository({database,historyRepository,resolveTenant,authorizeUndo,resolveWorkerAuth,authorityRelations=[]}={}){
 assertHistoryRepository(historyRepository);if([resolveTenant,authorizeUndo].some(fn=>typeof fn!=='function'))throw TypeError('Trusted undo authentication and permissions required');
 const db=protectedHistoryDatabase(database,'runtime',{authorityRelations});
 async function scope(authContext,action,work){if(!authContext)fail('Authenticated undo context required');
  const tx=await db.connect(),invoke=createHistoryHookInvoker(tx);try{
   await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await tx.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
   const tenant=await invoke(resolveTenant,{authContext});
   const check=async()=>{const now=await invoke(resolveTenant,{authContext});if(now.shopId!==tenant.shopId||now.installationId!==tenant.installationId||
    await invoke(authorizeUndo,{authContext,tenant,operation:action})!==true)fail('Current independent undo permission required');
    if(!(await tx.query('SELECT id FROM mirror.shops WHERE id=$1 AND installation_version=$2 AND uninstalled_at IS NULL FOR SHARE',[tenant.shopId,tenant.installationId])).rows.length)fail('Current undo installation required');};
   await check();const result=await work(tx,tenant);await check();await tx.query('COMMIT');return result;
  }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}
 }
 async function owned(tx,t,id){requireHistoryId(id);const row=(await tx.query(`SELECT u.* FROM edit_history.undo_requests u JOIN edit_history.operations o
  ON o.shop_id=u.shop_id AND o.installation_id=u.installation_id AND o.id=u.original_operation_id
  WHERE u.shop_id=$1 AND u.installation_id=$2 AND u.id=$3 AND o.purge_requested_at IS NULL FOR UPDATE OF u`,[t.shopId,t.installationId,id])).rows[0];
  if(!row)fail('Owned retained undo request required');return row;}
 async function loadSource({authContext,originalOperationId,resourceGid}){
  const source=await scope(authContext,'read_undo_source',async(tx,t)=>{
   const op=(await tx.query('SELECT execution_job_id FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3 AND purge_requested_at IS NULL',[t.shopId,t.installationId,originalOperationId])).rows[0];
   if(!op)fail('Owned original operation required');
   const rows=(await tx.query(`SELECT DISTINCT ON(c.resource_gid,c.field_id) c.*,b.id AS before_id,a.id AS after_id
    FROM edit_history.changes c LEFT JOIN edit_history.snapshots b ON b.shop_id=c.shop_id AND b.installation_id=c.installation_id AND b.change_id=c.id AND b.snapshot_kind='BEFORE'
    LEFT JOIN LATERAL(SELECT id FROM edit_history.snapshots s WHERE s.shop_id=c.shop_id AND s.installation_id=c.installation_id AND s.change_id=c.id
     AND s.snapshot_kind='OBSERVED_AFTER' ORDER BY observed_at DESC,id DESC LIMIT 1)a ON true
    WHERE c.shop_id=$1 AND c.installation_id=$2 AND c.operation_id=$3 AND($4::text IS NULL OR c.resource_gid=$4)
    ORDER BY c.resource_gid,c.field_id,c.prepared_at DESC,c.attempt_number DESC,c.id DESC LIMIT 65`,[t.shopId,t.installationId,originalOperationId,resourceGid??null])).rows;
   if(!rows.length||rows.length>64||rows.some(r=>!['VERIFIED','FAILED_NO_WRITE','CONFLICT'].includes(r.mutation_state)))fail('Bounded resolved original changes required');
   const verified=rows.filter(r=>r.mutation_state==='VERIFIED');
   if(!verified.length||verified.some(r=>r.verification_state!=='MATCHED'||!r.before_id||!r.after_id))fail('Verified original observations required');
   return{tenant:t,sourceCommandId:String(op.execution_job_id),rows:verified};
  });
  const fields=[];for(const r of source.rows){const ref={authContext,operationId:originalOperationId,changeId:r.id};
   const before=await historyRepository.getSnapshot({...ref,snapshotId:r.before_id}),after=await historyRepository.getSnapshot({...ref,snapshotId:r.after_id});
   if(before?.redacted!==false||after?.redacted!==false)fail('Separate sensitive-value permission required for undo');
   fields.push({resourceGid:r.resource_gid,fieldId:r.field_id,changeId:r.id,before:before.snapshot,after:after.snapshot});
  }
  await scope(authContext,'read_undo_source',async()=>{});return{tenant:source.tenant,sourceCommandId:source.sourceCommandId,fields};
 }
 const repository=Object.freeze({loadSource,
  request:({authContext,originalOperationId,idempotencyKey,conflictPolicy='ABORT_ON_CONFLICT'})=>scope(authContext,'request_undo',async(tx,t)=>{
   requireHistoryId(idempotencyKey,'idempotencyKey',128);if(!['ABORT_ON_CONFLICT','SKIP_CONFLICTED'].includes(conflictPolicy))fail('Known undo conflict policy required');
   if(!(await tx.query('SELECT id FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3 AND purge_requested_at IS NULL',[t.shopId,t.installationId,originalOperationId])).rows.length)fail('Owned original history required');
   const fp=historyFingerprint({originalOperationId,conflictPolicy},'undo-request-v3'),handoff=historyFingerprint({...t,idempotencyKey},'undo-handoff-v3');
   await tx.query(`INSERT INTO edit_history.undo_requests(id,shop_id,installation_id,original_operation_id,idempotency_key,request_fingerprint,conflict_policy,handoff_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(shop_id,installation_id,idempotency_key) DO NOTHING`,[randomUUID(),t.shopId,t.installationId,originalOperationId,idempotencyKey,fp,conflictPolicy,handoff]);
   const row=(await tx.query('SELECT * FROM edit_history.undo_requests WHERE shop_id=$1 AND installation_id=$2 AND idempotency_key=$3 FOR UPDATE',[t.shopId,t.installationId,idempotencyKey])).rows[0];
   if(row.request_fingerprint!==fp)fail('Undo key cannot select a different original operation or policy');return row;
  }),
  get:({authContext,undoRequestId})=>scope(authContext,'read_undo',(tx,t)=>owned(tx,t,undoRequestId)),
  recordPreflight:({authContext,undoRequestId,fingerprint,inverseFingerprint,conflict})=>scope(authContext,'preflight_undo',async(tx,t)=>{
   const row=await owned(tx,t,undoRequestId);if(!['REQUESTED','READY_FOR_REVIEW'].includes(row.undo_state))return row;
   return(await tx.query(`UPDATE edit_history.undo_requests SET undo_state=$4,preflight_fingerprint=$5,inverse_plan_fingerprint=$6,
    completed_at=CASE WHEN $4='CONFLICT' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
    WHERE shop_id=$1 AND installation_id=$2 AND id=$3 RETURNING *`,[t.shopId,t.installationId,row.id,conflict?'CONFLICT':'READY_FOR_REVIEW',fingerprint,inverseFingerprint])).rows[0];
  }),
  approve:({authContext,undoRequestId,contractId})=>scope(authContext,'approve_undo',async(tx,t)=>{
   const row=await owned(tx,t,undoRequestId);if(row.approval_reference){if(row.execution_contract_id!==contractId)fail('Immutable undo approval required');return row;}
   if(row.undo_state!=='READY_FOR_REVIEW')fail('Undo preflight required');
   await tx.query('SELECT id FROM mirror.execution_contracts WHERE shop_id=$1 AND id=$2 FOR SHARE',[t.shopId,contractId]);
   const contract=await getApprovedContractInTransaction({client:tx,shopId:t.shopId,contractId}),instructions=undoInstructions(contract,t.shopId);
   const payload=typeof contract.contract==='string'?JSON.parse(contract.contract):contract.contract;
   if(!isDeepStrictEqual(payload.historyUndo,{requestId:row.id,preflightFingerprint:row.preflight_fingerprint,
    inversePlanFingerprint:row.inverse_plan_fingerprint,handoffKey:row.handoff_key}))fail('Inverse approval must bind this exact reviewed undo plan');
   const original=(await tx.query('SELECT execution_job_id FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3',[t.shopId,t.installationId,row.original_operation_id])).rows[0];
   if(instructions.sourceCommandId!==String(original.execution_job_id))fail('Approval targets a different original command');
   return(await tx.query(`UPDATE edit_history.undo_requests SET undo_state='APPROVED',approval_reference=$4,execution_contract_id=$4,
    approved_at=clock_timestamp(),updated_at=clock_timestamp() WHERE shop_id=$1 AND installation_id=$2 AND id=$3 RETURNING *`,[t.shopId,t.installationId,row.id,contractId])).rows[0];
  }),
  markSubmitting:({authContext,undoRequestId})=>scope(authContext,'submit_undo',async(tx,t)=>{
   const row=await owned(tx,t,undoRequestId);if(!['APPROVED','SUBMITTING','OUTCOME_UNKNOWN','EXECUTING'].includes(row.undo_state))fail('Approved inverse execution required');
   if(row.execution_job_id)return row;
   return(await tx.query("UPDATE edit_history.undo_requests SET undo_state='SUBMITTING',updated_at=clock_timestamp() WHERE shop_id=$1 AND installation_id=$2 AND id=$3 RETURNING *",[t.shopId,t.installationId,row.id])).rows[0];
  }),
  bindExecution:({authContext,undoRequestId,executionJobId})=>scope(authContext,'submit_undo',async(tx,t)=>{
   const row=await owned(tx,t,undoRequestId);if(!['SUBMITTING','OUTCOME_UNKNOWN','EXECUTING'].includes(row.undo_state))fail('Approved durable handoff required');
   if(!(await tx.query(`SELECT id FROM mirror.job_commands WHERE shop_id=$1 AND installation_version=$2 AND id=$3 AND kind='undo' AND contract_id=$4 FOR SHARE`,[t.shopId,t.installationId,executionJobId,row.execution_contract_id])).rows.length)fail('Owned approved inverse command required');
   return(await tx.query("UPDATE edit_history.undo_requests SET undo_state='EXECUTING',execution_job_id=$4,updated_at=clock_timestamp() WHERE shop_id=$1 AND installation_id=$2 AND id=$3 RETURNING *",[t.shopId,t.installationId,row.id,executionJobId])).rows[0];
  }),
  markUnknown:({authContext,undoRequestId})=>scope(authContext,'submit_undo',async(tx,t)=>{
   const row=await owned(tx,t,undoRequestId);if(row.undo_state==='SUBMITTING')await tx.query("UPDATE edit_history.undo_requests SET undo_state='OUTCOME_UNKNOWN',updated_at=clock_timestamp() WHERE shop_id=$1 AND installation_id=$2 AND id=$3",[t.shopId,t.installationId,row.id]);
  }),
  reconcileExecution:({authContext,executionJobId})=>scope(authContext,'reconcile_undo',async(tx,t)=>{
   const row=(await tx.query('SELECT * FROM edit_history.undo_requests WHERE shop_id=$1 AND installation_id=$2 AND execution_job_id=$3 FOR UPDATE',[t.shopId,t.installationId,executionJobId])).rows[0];
   if(!row)fail('Owned inverse execution required');
   if(['COMPLETED','PARTIAL','FAILED','CANCELLED'].includes(row.undo_state))return{state:row.undo_state};
   const command=(await tx.query('SELECT status FROM mirror.job_commands WHERE shop_id=$1 AND installation_version=$2 AND id=$3 FOR SHARE',[t.shopId,t.installationId,executionJobId])).rows[0];
   const journal=(await tx.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE r.request_state='VERIFIED')::int AS verified,
    count(*) FILTER(WHERE r.request_state IN('DISPATCH_AUTHORIZED','ACKNOWLEDGED','OUTCOME_UNKNOWN'))::int AS uncertain
    FROM edit_history.mutation_requests r JOIN edit_history.operations o ON o.shop_id=r.shop_id AND o.installation_id=r.installation_id AND o.id=r.operation_id
    WHERE o.shop_id=$1 AND o.installation_id=$2 AND o.execution_job_id=$3`,[t.shopId,t.installationId,executionJobId])).rows[0];
   let state=journal.uncertain?'OUTCOME_UNKNOWN':row.undo_state;
   if(!journal.uncertain&&['SUCCEEDED','FAILED','CANCELLED'].includes(command?.status))state=command.status==='SUCCEEDED'&&journal.total>0&&journal.verified===journal.total?'COMPLETED':command.status==='CANCELLED'?'CANCELLED':journal.verified?'PARTIAL':'FAILED';
   await tx.query(`UPDATE edit_history.undo_requests SET undo_state=$4,completed_at=CASE WHEN $4 IN('COMPLETED','PARTIAL','FAILED','CANCELLED') THEN clock_timestamp() ELSE NULL END,
    updated_at=clock_timestamp() WHERE shop_id=$1 AND installation_id=$2 AND id=$3`,[t.shopId,t.installationId,row.id,state]);return{state};
  }),
  async reconcileExecutionForWorker({claim}){
   if(typeof resolveWorkerAuth!=='function')fail('Trusted worker authentication required');
   return repository.reconcileExecution({authContext:await resolveWorkerAuth({claim}),executionJobId:String(claim.id)});
  },
  async loadExecutionSource({authContext,executionJobId,resourceGid}){
   const row=await scope(authContext,'execute_undo',async(tx,t)=>{
    const row=(await tx.query(`SELECT u.* FROM edit_history.undo_requests u JOIN mirror.job_commands c
     ON c.shop_id=u.shop_id AND c.installation_version=u.installation_id AND c.id=u.execution_job_id AND c.contract_id=u.execution_contract_id
     WHERE u.shop_id=$1 AND u.installation_id=$2 AND u.execution_job_id=$3 AND u.undo_state='EXECUTING' AND c.kind='undo'`,[t.shopId,t.installationId,executionJobId])).rows[0];
    if(!row)fail('Approved durable undo lineage required');
    const contract=await getApprovedContractInTransaction({client:tx,shopId:t.shopId,contractId:row.execution_contract_id});
    return{...row,approvedFields:undoInstructions(contract,t.shopId).fields};});
   const source=await loadSource({authContext,originalOperationId:row.original_operation_id,resourceGid});
   const projection=which=>productUpdates(Object.fromEntries(source.fields.filter(f=>row.approvedFields.includes(names[f.fieldId])).map(f=>{
    if(!names[f.fieldId]||f[which].valueKind!=='VALUE')fail('Unsupported inverse product field');return[names[f.fieldId],f[which].value];})));
   return{sourceCommandId:source.sourceCommandId,inverseValues:projection('before'),expectedValues:projection('after')};
  },
  async loadExecutionSourceForWorker({claim,item}){
   if(typeof resolveWorkerAuth!=='function')fail('Trusted worker authentication required');
   return repository.loadExecutionSource({authContext:await resolveWorkerAuth({claim}),executionJobId:String(claim.id),resourceGid:item.resource_id});
  }
 });issued.add(repository);return repository;
}
