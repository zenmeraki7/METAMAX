/** Must run inside the history repository's SERIALIZABLE admission transaction.
 * The short advisory lock serializes admission; unresolved durable changes keep
 * the family fenced after commit and after a crashed worker's lease expires.
 */
import {HistoryContractError,HISTORY_ERROR_CODES as C} from '../edit-history/history-contract.js';
export async function acquireResourceFamilies({tx,tenant,families,operationId,mutationId,attemptId}){
 const ordered=[...new Set(families)].sort();
 if(!ordered.length||ordered.length>64||ordered.some(id=>!/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(id)))throw new HistoryContractError(C.INVALID_INPUT,'Canonical product family required');
 for(const family of ordered){
  const lock=await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[JSON.stringify([tenant.shopId,family])]);
  if(!lock.rows[0]?.acquired)throw new HistoryContractError(C.OWNERSHIP_LOST,'Resource family is being admitted by another execution');
 }
 const competing=await tx.query(`SELECT 1 FROM edit_history.changes WHERE shop_id=$1
  AND resource_family_gid=ANY($3::text[]) AND mutation_state IN('DISPATCHING','OUTCOME_UNKNOWN','ACKNOWLEDGED')
  AND NOT(installation_id=$2 AND operation_id=$4 AND mutation_id=$5 AND attempt_id=$6) LIMIT 1`,
 [tenant.shopId,tenant.installationId,ordered,operationId,mutationId,attemptId]);
 if(competing.rows.length)throw new HistoryContractError(C.INVALID_TRANSITION,'Resource family has an unresolved mutation; reconcile before writing');
}
