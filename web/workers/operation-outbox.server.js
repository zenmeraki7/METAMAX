/** Publish only committed operation outbox rows; Redis is a scheduling carrier. */
import { createHash, randomUUID } from "node:crypto";

export function createOperationOutboxDispatcher({database,queue}={}) {
  if(typeof database?.query!=="function"||typeof queue?.add!=="function")throw new TypeError("Operation outbox database and queue required");
  return Object.freeze({
    async dispatchNext() {
      const token=randomUUID();
      const row=(await database.query(`WITH due AS(SELECT e.id FROM mirror.outbox_events e
        JOIN mirror.job_commands c ON c.shop_id=e.shop_id AND c.id=e.command_id
        WHERE e.dispatched_at IS NULL AND e.available_at<=clock_timestamp() AND e.attempts<8
          AND (e.lease_until IS NULL OR e.lease_until<=clock_timestamp()) AND c.kind IN('bulk_edit','undo')
        ORDER BY e.available_at,e.id LIMIT 1 FOR UPDATE OF e SKIP LOCKED)
        UPDATE mirror.outbox_events e SET lease_token=$1,lease_until=clock_timestamp()+interval '60 seconds',fence=fence+1,attempts=attempts+1
        FROM due WHERE e.id=due.id RETURNING e.*`,[token])).rows[0];
      if(!row)return {kind:"EMPTY"};
      try {
        const command=(await database.query("SELECT kind FROM mirror.job_commands WHERE shop_id=$1 AND id=$2",[row.shop_id,row.command_id])).rows[0];
        if(!["bulk_edit","undo"].includes(command?.kind))throw new Error("Committed operation unavailable");
        const jobId=`operation-${createHash("sha256").update(JSON.stringify([row.shop_id,String(row.command_id)])).digest("hex")}`;
        await queue.add(command.kind,{shopId:row.shop_id,commandId:String(row.command_id)},{jobId});
        const acknowledged=await database.query(`UPDATE mirror.outbox_events SET dispatched_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
          WHERE shop_id=$1 AND id=$2 AND fence=$3 AND lease_token=$4 AND lease_until>clock_timestamp() AND dispatched_at IS NULL`,[row.shop_id,row.id,row.fence,token]);
        return {kind:acknowledged.rowCount===1?"DISPATCHED":"SUPERSEDED",commandId:String(row.command_id)};
      }catch(error){
        await database.query(`UPDATE mirror.outbox_events SET lease_token=NULL,lease_until=NULL,
          available_at=clock_timestamp()+LEAST(3600,5*power(2,attempts))::integer*interval '1 second'
          WHERE shop_id=$1 AND id=$2 AND fence=$3 AND lease_token=$4 AND dispatched_at IS NULL`,[row.shop_id,row.id,row.fence,token]);
        return {kind:Number(row.attempts)>=8?"EXHAUSTED":"RETRY",commandId:String(row.command_id)};
      }
    },
  });
}
