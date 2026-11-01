// Interface contract (repository root): docs/backend-interface-contracts.md#operation-outbox
/** Publish only committed operation outbox rows; Redis is a scheduling carrier. */
import { createHash, randomUUID } from "node:crypto";
import {HISTORY_EXECUTION_CAPABILITIES} from '../fields/write-capabilities.js';
import {assertRuntimeDatabaseProfile} from '../security/runtime-database.server.js';

export function createOperationOutboxDispatcher({database,queue,logger=console}={}) {
  assertRuntimeDatabaseProfile(database,'operationWorker');
  if(typeof database?.query!=="function"||typeof queue?.add!=="function")throw new TypeError("Operation outbox database and queue required");
  return Object.freeze({
    async dispatchNext() {
      const exhausted=await database.query(`WITH exhausted AS(
       SELECT e.shop_id,e.id FROM mirror.outbox_events e JOIN mirror.job_commands c ON c.shop_id=e.shop_id AND c.id=e.command_id
       JOIN mirror.shops s ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
       WHERE e.dispatched_at IS NULL AND e.attempts>=8 AND NOT e.review_required
        AND c.cancel_requested_at IS NULL AND c.status IN('PENDING','RETRY') AND c.kind IN('bulk_edit','undo','import')
        AND(e.lease_until IS NULL OR e.lease_until<=clock_timestamp()) ORDER BY e.id LIMIT 25 FOR UPDATE OF e SKIP LOCKED)
       UPDATE mirror.outbox_events e SET review_required=true,last_error='DISPATCH_RETRY_EXHAUSTED',lease_token=NULL,lease_until=NULL
       FROM exhausted x WHERE e.shop_id=x.shop_id AND e.id=x.id RETURNING e.shop_id,e.command_id`);
      for(const event of exhausted.rows){try{logger.error?.({code:'DISPATCH_RETRY_EXHAUSTED',shopId:event.shop_id,commandId:String(event.command_id)},'Operation delivery requires review');}catch{}}
      const token=randomUUID();
      const row=(await database.query(`WITH due AS(SELECT e.shop_id,e.id FROM mirror.outbox_events e
        JOIN mirror.job_commands c ON c.shop_id=e.shop_id AND c.id=e.command_id
        JOIN mirror.shops s ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
        WHERE c.cancel_requested_at IS NULL AND c.status IN('PENDING','RETRY') AND e.dispatched_at IS NULL AND NOT e.review_required AND e.available_at<=clock_timestamp() AND e.attempts<8
          AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp()) AND c.kind IN('bulk_edit','undo','import')
        ORDER BY e.available_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED)
        UPDATE mirror.outbox_events e SET lease_token=$1,lease_until=clock_timestamp()+interval '60 seconds',fence=fence+1,attempts=attempts+1
        FROM due WHERE e.shop_id=due.shop_id AND e.id=due.id RETURNING e.*`,[token])).rows[0];
      if(!row)return {kind:"EMPTY"};
      try {
        const command=(await database.query(`SELECT kind FROM mirror.job_commands c JOIN mirror.shops s
          ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
          WHERE c.shop_id=$1 AND c.id=$2 AND c.cancel_requested_at IS NULL AND c.status IN('PENDING','RETRY')`,[row.shop_id,row.command_id])).rows[0];
        if(!command){
          const released=await database.query(`UPDATE mirror.outbox_events SET lease_token=NULL,lease_until=NULL,last_error='COMMAND_NOT_DISPATCHABLE'
            WHERE shop_id=$1 AND id=$2 AND fence=$3 AND lease_token=$4 AND lease_until>clock_timestamp() AND dispatched_at IS NULL`,
            [row.shop_id,row.id,row.fence,token]);
          return {kind:released.rowCount===1?'SKIPPED':'SUPERSEDED',commandId:String(row.command_id)};
        }
        if(!HISTORY_EXECUTION_CAPABILITIES.jobKinds.includes(command?.kind))throw new Error("Committed operation unavailable");
        const jobId=`operation-${createHash("sha256").update(JSON.stringify([row.shop_id,String(row.command_id)])).digest("hex")}`;
        await queue.add(command.kind,{shopId:row.shop_id,commandId:String(row.command_id)},{jobId});
        const acknowledged=await database.query(`UPDATE mirror.outbox_events SET dispatched_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
          WHERE shop_id=$1 AND id=$2 AND fence=$3 AND lease_token=$4 AND lease_until>clock_timestamp() AND dispatched_at IS NULL`,[row.shop_id,row.id,row.fence,token]);
        return {kind:acknowledged.rowCount===1?"DISPATCHED":"SUPERSEDED",commandId:String(row.command_id)};
      }catch(error){
        const failed=await database.query(`UPDATE mirror.outbox_events SET lease_token=NULL,lease_until=NULL,
          review_required=attempts>=8,last_error='QUEUE_DELIVERY_UNCONFIRMED',
          available_at=clock_timestamp()+LEAST(3600,5*power(2,attempts))::integer*interval '1 second'
          WHERE shop_id=$1 AND id=$2 AND fence=$3 AND lease_token=$4 AND lease_until>clock_timestamp() AND dispatched_at IS NULL RETURNING review_required`,[row.shop_id,row.id,row.fence,token]);
        if(failed.rowCount!==1)return{kind:'SUPERSEDED',commandId:String(row.command_id)};
        if(failed.rows[0].review_required){try{logger.error?.({code:'DISPATCH_RETRY_EXHAUSTED',shopId:row.shop_id,commandId:String(row.command_id)},'Operation delivery requires review');}catch{}}
        return {kind:failed.rows[0].review_required?"REVIEW_REQUIRED":"RETRY",commandId:String(row.command_id)};
      }
    },
  });
}
