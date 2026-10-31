import {createHash} from 'node:crypto';

// A capability exists only during the fresh claim callback. A caller cannot
// acknowledge consumption later using an independently opened SQL transaction.
const freshClaims=new WeakMap();
export const logicalDispatchKey=({shopId,runId,deliveryRevision,kind})=>createHash('sha256')
  .update(JSON.stringify([shopId,runId,String(deliveryRevision),kind])).digest('hex');
const query=async(tx,sql,...values)=>typeof tx.$queryRawUnsafe==='function'
  ?tx.$queryRawUnsafe(sql,...values):(await tx.query(sql,values)).rows;

export async function acknowledgeDispatchConsumptionInTransaction({tx,deliveryKey,claim,verifyConsumption}) {
  const context=tx&&freshClaims.get(tx);
  if(!context||context.claim!==claim)throw new TypeError('Consumption requires the fresh execution claim transaction');
  const {kind}=context;
  const rows=await query(tx,`SELECT e.delivery_revision,j.run_id AS sync_run_id FROM mirror.catalog_import_executions e
    JOIN mirror.catalog_import_jobs j ON j.id=e.id AND j.shop_id=e.shop_id AND j.generation_id=e.generation_id
    JOIN mirror.shops s ON s.id=e.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
    WHERE e.id=$1 AND e.shop_id=$2 AND e.generation_id=$3 AND e.phase=$4 AND e.fence=$5::bigint AND e.lease_token=$6
      AND e.lease_until>clock_timestamp() AND NOT e.cancel_requested AND NOT j.cancel_requested AND NOT e.review_required
      AND e.completed_at IS NULL AND e.outcome_uncertain=$7 AND (e.worker_id='recovery')=$7`,
  claim.runId,claim.shopId,claim.generationId,claim.phase,String(claim.fence),claim.leaseToken,kind==='RECOVERY');
  if(rows.length!==1)throw new Error('Fresh claim lost before dispatch consumption');
  const key=logicalDispatchKey({shopId:claim.shopId,runId:claim.runId,deliveryRevision:rows[0].delivery_revision,kind});
  if(deliveryKey!==undefined&&deliveryKey!==key)throw new TypeError('Consumption logical delivery mismatch');
  const deliveries=await query(tx,`SELECT * FROM mirror.sync_dispatches WHERE shop_id=$1 AND run_id=$2
    AND generation_id=$3 AND delivery_key=$4 AND delivery_revision=$5 AND kind=$6 AND sync_run_id=$7 FOR UPDATE`,
  claim.shopId,claim.runId,claim.generationId,key,rows[0].delivery_revision,kind,rows[0].sync_run_id);
  if(!deliveries.length)return Object.freeze({kind:'NOT_FOUND'}); // Direct DB pollers also claim without a queue notification.
  const delivery=Object.freeze(deliveries[0]);
  if(verifyConsumption&&await verifyConsumption({tx,delivery,claim})!==true)throw new Error('Consumption evidence not verified');
  if(['REVIEW_REQUIRED','CANCELLED'].includes(delivery.state))throw new Error('Delivery cannot be consumed');
  const updated=await query(tx,`UPDATE mirror.sync_dispatches SET state='CONSUMED',consumed_at=clock_timestamp(),
    consumed_fence=$5::bigint,consumed_lease_token=$6,recovery_token=NULL,recovery_until=NULL,updated_at=clock_timestamp()
    WHERE id=$1 AND shop_id=$2 AND run_id=$3 AND delivery_key=$4 AND state NOT IN ('REVIEW_REQUIRED','CANCELLED')
      AND EXISTS(SELECT 1 FROM mirror.catalog_import_executions e WHERE e.id=$3 AND e.shop_id=$2
        AND e.fence=$5::bigint AND e.lease_token=$6 AND e.lease_until>clock_timestamp()) RETURNING id`,
  delivery.id,claim.shopId,claim.runId,key,String(claim.fence),claim.leaseToken);
  if(updated.length!==1)throw new Error('Consumption acknowledgment lost its claim');
  return Object.freeze({kind:'RECORDED'});
}

// Internal claim integration, not an HTTP/API authority issuer. The only call
// sites follow a successful fenced execution UPDATE in that same transaction.
export async function consumeFreshDispatchClaim({tx,claim,kind,acknowledge}) {
  freshClaims.set(tx,{claim,kind});
  try{return await (acknowledge||acknowledgeDispatchConsumptionInTransaction)({tx,claim});}
  finally{freshClaims.delete(tx);}
}
