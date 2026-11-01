/** Engine item counts and durable journal uncertainty are separate observations. */
export async function readOperationOutcome(tx,claim){
 const row=(await tx.query(`WITH item_outcomes AS(
  SELECT i.status,i.attempts,i.next_attempt_at,EXISTS(SELECT 1 FROM edit_history.operations o
   JOIN edit_history.mutation_requests r ON r.shop_id=o.shop_id AND r.installation_id=o.installation_id AND r.operation_id=o.id
   WHERE o.shop_id=i.shop_id AND o.execution_job_id=i.command_id AND o.installation_id=$3
    AND r.execution_item_id=i.id AND r.request_state IN('DISPATCH_AUTHORIZED','ACKNOWLEDGED','OUTCOME_UNKNOWN')) AS uncertain
  FROM mirror.job_items i WHERE i.shop_id=$1 AND i.command_id=$2)
  SELECT count(*)::int AS total,count(*) FILTER(WHERE NOT uncertain AND status='SUCCEEDED')::int AS succeeded,
   count(*) FILTER(WHERE NOT uncertain AND(status='FAILED' OR status IN('PENDING','RETRY','RUNNING') AND attempts>=8))::int AS failed,
   count(*) FILTER(WHERE NOT uncertain AND status IN('PENDING','RETRY','RUNNING') AND attempts<8)::int AS pending,
   count(*) FILTER(WHERE uncertain)::int AS uncertain,count(*) FILTER(WHERE NOT uncertain AND status='CANCELLED')::int AS cancelled,
   min(next_attempt_at) FILTER(WHERE NOT uncertain AND status='RETRY' AND attempts<8) AS due FROM item_outcomes`,[claim.shop_id,claim.id,claim.installation_version])).rows[0];
 const counts=Object.fromEntries(['total','succeeded','failed','pending','uncertain','cancelled'].map(key=>[key,Number(row?.[key])]));
 if(Object.values(counts).some(value=>!Number.isSafeInteger(value)||value<0)||counts.total!==counts.succeeded+counts.failed+counts.pending+counts.uncertain+counts.cancelled)throw Error('Complete durable operation counts required');
 const terminal=counts.pending===0&&counts.uncertain===0;
 const outcome=counts.uncertain?'OUTCOME_UNKNOWN':!terminal?'IN_PROGRESS':counts.total>0&&counts.succeeded===counts.total?'SUCCEEDED':counts.succeeded>0?'PARTIAL':'FAILED';
 return {version:1,countUnit:'resources',outcome,terminal,counts,due:row.due};
}
