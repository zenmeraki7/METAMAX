/** Durable schedule occurrences. Discovery never materializes products. */
import { randomUUID } from "node:crypto";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { bulkInstructions } from "./operation-instructions.server.js";
import { parseFilterAst } from "../filters/ast.js";

const INTERVALS={HOURLY:3600000,DAILY:86400000,WEEKLY:604800000};
const fail=(code,message)=>{throw new FieldError(code,message);};
const MAX_TARGETS=10000;

export function createSchedulesService({database,selectionService,approvalService,jobDispatchService,getScheduleAuthContext,resolveShop,logger=console}={}) {
  if(typeof database?.connect!=="function"||typeof resolveShop!=="function")throw new TypeError("Transactional database and trusted schedule shop resolver required");
  async function authenticated(context,expected) {
    if(!context)fail(C.PERMISSION_DENIED,"Authenticated schedule context required");
    const shop=await resolveShop(context);
    if(typeof shop!=="string"||shop.trim()!==shop||shop.length>255||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)||expected!==undefined&&shop!==expected)fail(C.PERMISSION_DENIED,"Schedule shop differs from authenticated shop");
    return shop;
  }
  async function transaction(callback) {
    const client=await database.connect();
    try {
      await client.query("BEGIN");await client.query("SET LOCAL lock_timeout = '2000ms'");await client.query("SET LOCAL statement_timeout = '30000ms'");
      const result=await callback(client);await client.query("COMMIT");return result;
    }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
  }
  const owned=async(client,claim)=>{
    const result=await client.query(`SELECT id FROM mirror.schedule_occurrences WHERE shop_id=$1 AND id=$2 AND status='RUNNING'
      AND phase=$3 AND fence=$4 AND lease_token=$5 AND lease_until>clock_timestamp() FOR UPDATE`,[claim.shop_id,claim.id,claim.phase,claim.fence,claim.lease_token]);
    if(!result.rows[0])fail(C.CONTRACT_MISMATCH,"Schedule occurrence lease superseded");
  };
  async function advance(client,claim,{snapshotId=claim.snapshot_id,contractId=claim.contract_id,commandId=claim.command_id,phase}) {
    await owned(client,claim);
    const result=await client.query(`UPDATE mirror.schedule_occurrences SET phase=$6,snapshot_id=$7,contract_id=$8,command_id=$9,
      status=CASE WHEN $6='DONE' THEN 'SUCCEEDED' ELSE 'QUEUED' END,attempts=0,lease_token=NULL,lease_until=NULL,last_error=NULL,
      next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE shop_id=$1 AND id=$2 AND phase=$3 AND fence=$4
      AND lease_token=$5 AND status='RUNNING' AND lease_until>clock_timestamp()`,[claim.shop_id,claim.id,claim.phase,claim.fence,claim.lease_token,phase,snapshotId,contractId,commandId]);
    if(result.rowCount!==1)fail(C.CONTRACT_MISMATCH,"Schedule occurrence completion superseded");
  }
  return Object.freeze({
    async createSchedule({authContext,recurrence="DAILY",timezone="UTC",operation="bulk_edit",template={},freezeTargetsOnCreation=false,firstRunAt=null,enabled=true,...unsupported}={}) {
      if(Object.hasOwn(unsupported,"shopId")||Object.hasOwn(unsupported,"client"))fail(C.PERMISSION_DENIED,"Schedule uses authenticated shop and protected transaction");
      const shopId=await authenticated(authContext);
      if(!Object.hasOwn(INTERVALS,recurrence)||timezone!=="UTC"||operation!=="bulk_edit")fail(C.INVALID_VALUE,"Supported UTC bulk-edit recurrence required");
      if(!template||typeof template!=="object"||Array.isArray(template)||Object.keys(template).some(key=>!["selectionMode","filter","productIds","excludedProductIds","contractPayload"].includes(key)))fail(C.INVALID_VALUE,"Invalid schedule template");
      const frozen=structuredClone(template);
      if(Buffer.byteLength(JSON.stringify(frozen))>131072)fail(C.INVALID_VALUE,"Schedule template exceeds budget");
      const mode=frozen.selectionMode||"ALL_MATCHING";
      if(!["EXPLICIT","ALL_MATCHING","ALL_MATCHING_WITH_EXCLUSIONS"].includes(mode))fail(C.INVALID_VALUE,"Invalid scheduled selection mode");
      if(mode!=="EXPLICIT")frozen.filter=parseFilterAst(frozen.filter);
      else if(!Array.isArray(frozen.productIds)||!frozen.productIds.length||frozen.productIds.length>MAX_TARGETS)fail(C.INVALID_VALUE,"Bounded explicit schedule targets required");
      bulkInstructions({shop_id:shopId,status:"APPROVED",operation,contract:frozen.contractPayload},shopId);
      const due=firstRunAt==null?new Date(Date.now()+INTERVALS[recurrence]):new Date(firstRunAt);
      if(!Number.isFinite(due.getTime())||typeof enabled!=="boolean")fail(C.INVALID_VALUE,"Invalid schedule date or enabled state");
      const insert=async(client,snapshot)=>{
        if(snapshot){if(snapshot.shopId!==shopId)fail(C.PERMISSION_DENIED,"Schedule selection belongs to another shop");frozen.frozenSnapshotId=snapshot.snapshotId;}
        await authenticated(authContext,shopId);
        return (await client.query(`INSERT INTO mirror.job_schedules(shop_id,enabled,timezone,recurrence,operation,template,next_run_at,fence)
          VALUES($1,$2,$3,$4,$5,$6,$7,0) RETURNING id,shop_id,enabled,recurrence,next_run_at`,[shopId,enabled,timezone,recurrence,operation,JSON.stringify(frozen),due])).rows[0];
      };
      if(freezeTargetsOnCreation) {
        if(typeof selectionService?.withSelectionTransaction!=="function")fail(C.EXECUTION_UNAVAILABLE,"Protected selection transaction required");
        return selectionService.withSelectionTransaction({authContext,mode:frozen.selectionMode||"ALL_MATCHING",filter:frozen.filter,
          productIds:frozen.productIds,excludedProductIds:frozen.excludedProductIds,operation,maxItems:MAX_TARGETS},({client,snapshot})=>insert(client,snapshot));
      }
      return transaction(client=>insert(client));
    },
    async triggerDueSchedules({now=new Date()}={}) {
      if(!(now instanceof Date)||!Number.isFinite(now.getTime()))fail(C.INVALID_VALUE,"Valid schedule discovery time required");
      return transaction(async client=>{
        const due=(await client.query(`SELECT id,shop_id,recurrence,operation,template,next_run_at FROM mirror.job_schedules
          WHERE enabled=true AND next_run_at<=$1 ORDER BY next_run_at,id LIMIT 10 FOR UPDATE SKIP LOCKED`,[now])).rows;
        const occurrences=[];
        for(const schedule of due) {
          if(!Object.hasOwn(INTERVALS,schedule.recurrence))fail(C.CONTRACT_MISMATCH,"Unsupported persisted recurrence");
          const next=new Date(new Date(schedule.next_run_at).getTime()+INTERVALS[schedule.recurrence]);
          const occurrence=(await client.query(`INSERT INTO mirror.schedule_occurrences(id,shop_id,schedule_id,scheduled_for,template,operation)
            VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(shop_id,schedule_id,scheduled_for) DO NOTHING RETURNING id,shop_id,schedule_id,scheduled_for`,
          [randomUUID(),schedule.shop_id,schedule.id,schedule.next_run_at,JSON.stringify(schedule.template),schedule.operation])).rows[0];
          await client.query(`UPDATE mirror.job_schedules SET next_run_at=$3,last_run_at=$4,fence=fence+1 WHERE shop_id=$1 AND id=$2`,[schedule.shop_id,schedule.id,next,now]);
          if(occurrence)occurrences.push(occurrence);
        }
        return occurrences;
      });
    },
    async processNextOccurrence({leaseSeconds=300}={}) {
      if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>600)fail(C.INVALID_VALUE,"Bounded occurrence lease required");
      if(typeof getScheduleAuthContext!=="function"||typeof selectionService?.withSelectionTransaction!=="function"||typeof approvalService?.approveContract!=="function"||typeof jobDispatchService?.dispatchBulkEdit!=="function")fail(C.EXECUTION_UNAVAILABLE,"Authenticated occurrence execution services required");
      await database.query(`UPDATE mirror.schedule_occurrences SET status='FAILED',lease_token=NULL,lease_until=NULL,last_error='Occurrence retry budget exhausted'
        WHERE attempts>=8 AND (status='RETRY' OR status='RUNNING' AND lease_until<=clock_timestamp())`);
      const claim=(await database.query(`WITH due AS(SELECT id FROM mirror.schedule_occurrences WHERE attempts<8
        AND (status IN('QUEUED','RETRY') AND next_attempt_at<=clock_timestamp() OR status='RUNNING' AND lease_until<=clock_timestamp())
        ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE mirror.schedule_occurrences o SET status='RUNNING',attempts=attempts+1,fence=fence+1,lease_token=$1,
          lease_until=clock_timestamp()+$2::integer*interval '1 second',updated_at=clock_timestamp() FROM due WHERE o.id=due.id RETURNING o.*`,[randomUUID(),leaseSeconds])).rows[0];
      if(!claim)return {kind:"EMPTY"};
      try {
        const authContext=await getScheduleAuthContext({shopId:claim.shop_id,scheduleId:claim.schedule_id,occurrenceId:claim.id});
        await authenticated(authContext,claim.shop_id);
        const template=typeof claim.template==="string"?JSON.parse(claim.template):claim.template;
        if(claim.phase==="SELECT") {
          const save=async(client,snapshot)=>{
            if(snapshot.shopId!==claim.shop_id)fail(C.PERMISSION_DENIED,"Occurrence selection belongs to another shop");
            await authenticated(authContext,claim.shop_id);
            await advance(client,claim,{snapshotId:snapshot.snapshotId,phase:"APPROVE"});
          };
          if(template.frozenSnapshotId) {
            await transaction(async client=>{
              await owned(client,claim);
              const snapshot=await selectionService.getSelectionSnapshot({authContext,snapshotId:template.frozenSnapshotId});
              if(!snapshot||snapshot.status!=="APPROVED"||snapshot.operation!==claim.operation||Number(snapshot.selected_count)>MAX_TARGETS||new Date(snapshot.expires_at)<=new Date())fail(C.EXECUTION_UNAVAILABLE,"Frozen schedule selection expired or incompatible; approve a fresh selection");
              await save(client,{shopId:claim.shop_id,snapshotId:snapshot.id});
            });
          } else await selectionService.withSelectionTransaction({authContext,mode:template.selectionMode||"ALL_MATCHING",filter:template.filter,
            productIds:template.productIds,excludedProductIds:template.excludedProductIds,operation:claim.operation,maxItems:MAX_TARGETS},({client,snapshot})=>save(client,snapshot));
        } else await transaction(async client=>{
          await owned(client,claim);
          if(claim.phase==="APPROVE") {
            const approved=await approvalService.approveContract({client,shopId:claim.shop_id,snapshotId:claim.snapshot_id,operation:claim.operation,
              contractPayload:template.contractPayload,approvedBy:`schedule:${claim.schedule_id}:occurrence:${claim.id}`});
            await authenticated(authContext,claim.shop_id);
            await advance(client,claim,{contractId:approved.contractId,phase:"DISPATCH"});
          } else if(claim.phase==="DISPATCH") {
            const command=await jobDispatchService.dispatchBulkEdit({client,authContext,contractId:claim.contract_id,actorId:`schedule:${claim.schedule_id}`});
            await authenticated(authContext,claim.shop_id);
            await advance(client,claim,{commandId:command.commandId,phase:"DONE"});
          } else fail(C.CONTRACT_MISMATCH,"Invalid occurrence phase");
        });
        return {kind:"ADVANCED",occurrenceId:claim.id,phase:claim.phase};
      }catch(error){
        const persisted=await database.query(`UPDATE mirror.schedule_occurrences SET status=CASE WHEN attempts>=8 THEN 'FAILED' ELSE 'RETRY' END,
          next_attempt_at=clock_timestamp()+LEAST(3600,5*power(2,attempts))::integer*interval '1 second',lease_token=NULL,lease_until=NULL,
          last_error=$6,updated_at=clock_timestamp() WHERE shop_id=$1 AND id=$2 AND phase=$3 AND fence=$4 AND lease_token=$5 AND status='RUNNING'`,
        [claim.shop_id,claim.id,claim.phase,claim.fence,claim.lease_token,error instanceof FieldError?error.code:"OCCURRENCE_EXECUTION_FAILED"]);
        logger.error?.({code:error.code,occurrenceId:claim.id},"Schedule occurrence remains retryable");
        return {kind:persisted.rowCount===1?"RETRY":"SUPERSEDED",occurrenceId:claim.id};
      }
    },
    async cancelOccurrence({authContext,occurrenceId}={}) {
      const shopId=await authenticated(authContext);
      return (await database.query(`UPDATE mirror.schedule_occurrences SET status='CANCELLED',fence=fence+1,lease_token=NULL,lease_until=NULL,
        updated_at=clock_timestamp() WHERE shop_id=$1 AND id=$2 AND status IN('QUEUED','RUNNING','RETRY','FAILED')`,[shopId,occurrenceId])).rowCount===1;
    },
    async listSchedules({authContext}={}) {
      const shopId=await authenticated(authContext);
      return (await database.query(`SELECT id,enabled,timezone,recurrence,operation,next_run_at,last_run_at FROM mirror.job_schedules WHERE shop_id=$1 ORDER BY id`,[shopId])).rows;
    },
  });
}
