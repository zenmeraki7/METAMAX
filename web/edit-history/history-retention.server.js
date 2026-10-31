/** Dedicated maintenance credential. Never a merchant or mutation-worker API. */
import { protectedHistoryDatabase } from './database-security.server.js';
import { assertHistoryValueProtection } from './history-value-protection.server.js';
import { validateStoredHistorySnapshot } from './history-repository.server.js';
export function createHistoryRetentionService({database,valueProtection}){
 if(typeof database?.connect!=='function')throw TypeError('Dedicated history maintenance database required');
 assertHistoryValueProtection(valueProtection);const pool=protectedHistoryDatabase(database,'maintenance');
 async function transaction(work){
  const client=await pool.connect();const deadline=Date.now()+15000;
  const check=()=>{if(Date.now()>=deadline)throw Error('History maintenance deadline exceeded');};
  try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2000ms'");await client.query("SET LOCAL statement_timeout='15000ms'");
   await client.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
   const result=await work(client,check);check();await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 return Object.freeze({
  async purgeBatch({limit=250}={}){
   if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw TypeError('Retention batch must be 1–500 rows');
   return transaction(async client=>(await client.query('SELECT edit_history.purge_history_batch($1) AS result',[limit])).rows[0].result);
  },
  async encryptLegacyBatch({limit=10}={}){
   if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw TypeError('Encryption batch must be 1–25 snapshots');
   let operationId;
   try{return await transaction(async(client,check)=>{
    const rows=(await client.query(`SELECT s.*,o.execution_job_id,o.execution_fingerprint AS operation_execution_fingerprint,
     o.filter_fingerprint AS operation_filter_fingerprint,c.execution_item_id,c.mutation_id,c.before_snapshot_fingerprint,
     c.resource_gid AS change_resource_gid,c.field_id AS change_field_id,c.field_definition_revision AS change_definition_revision
     FROM edit_history.legacy_snapshot_batch($1) s JOIN edit_history.changes c ON c.shop_id=s.shop_id AND c.installation_id=s.installation_id AND c.operation_id=s.operation_id AND c.id=s.change_id
     JOIN edit_history.operations o ON o.shop_id=s.shop_id AND o.installation_id=s.installation_id AND o.id=s.operation_id
     ORDER BY s.id`,[limit])).rows;
    let encrypted=0;
    for(const row of rows){check();operationId=row.operation_id;const snapshot=validateStoredHistorySnapshot(row),tenant={shopId:row.shop_id,installationId:row.installation_id};
     const sealed=await valueProtection.seal(row,snapshot.value,{client,tenant});check();
     const changed=(await client.query('SELECT edit_history.encrypt_legacy_snapshot($1,$2,$3,$4,$5,$6) AS changed',
      [row.shop_id,row.installation_id,row.id,row.snapshot_fingerprint,sealed.encrypted_value,sealed.encryption_key_reference])).rows[0].changed;
     if(changed)encrypted++;
    }
    return Object.freeze({encrypted});
   });}catch(error){
    if(operationId&&['HISTORY_BINDING_CONFLICT','HISTORY_EVIDENCE_CONFLICT','HISTORY_UNSUPPORTED_VERSION'].includes(error.code)){
     await transaction(client=>client.query('SELECT edit_history.mark_encryption_review($1)',[operationId]));
     return Object.freeze({encrypted:0,reviewRequired:true});
    }throw error;
   }
  },
 });
}
