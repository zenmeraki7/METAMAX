// Interface contract (repository root): docs/backend-interface-contracts.md#scheduled-occurrences
import {isDeepStrictEqual} from 'node:util';
import {lockPublication} from '../mirror/publication-lock.server.js';
import {assertRuntimeDatabaseProfile} from '../security/runtime-database.server.js';
import {currentMutationAdapterVersion} from './execution-contract.server.js';
/** Durable schedule occurrences. Discovery never materializes products. */
import { randomUUID } from "node:crypto";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { bulkInstructions } from "./operation-instructions.server.js";
import { parseFilterAst } from "../filters/ast.js";

const INTERVALS={HOURLY:3600000,DAILY:86400000,WEEKLY:604800000};
const fail=(code,message)=>{throw new FieldError(code,message);};
const MAX_TARGETS=10000;

export function createSchedulesService({database,workerDatabase,selectionService,approvalService,jobDispatchService,getScheduleAuthContext,resolveShop,logger=console}={}) {
  if(typeof database?.connect!=="function"||typeof resolveShop!=="function")throw new TypeError("Transactional database and trusted schedule shop resolver required");
  async function authenticated(context,expected) {
    if(!context)fail(C.PERMISSION_DENIED,"Authenticated schedule context required");
    const shop=await resolveShop(context);
    if(typeof shop!=="string"||shop.trim()!==shop||shop.length>255||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)||expected!==undefined&&shop!==expected)fail(C.PERMISSION_DENIED,"Schedule shop differs from authenticated shop");
    return shop;
  }
  const requireWorker=()=>{assertRuntimeDatabaseProfile(workerDatabase,'operationWorker');return workerDatabase;};
  async function transaction(callback,{shopId,installationVersion,connection=database}={}) {
    const client=await connection.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");await client.query("SET LOCAL lock_timeout = '2000ms'");await client.query("SET LOCAL statement_timeout = '30000ms'");
      if(shopId){
        await lockPublication(client,shopId);
        const current=(await client.query('SELECT installation_version FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR SHARE',[shopId])).rows[0];
        if(!current||installationVersion!==undefined&&current.installation_version!==installationVersion)fail(C.PERMISSION_DENIED,'Scheduled installation changed');
      }
      const result=await callback(client);await client.query("COMMIT");return result;
    }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
  }
  const owned=async(client,claim)=>{
    const result=await client.query(`SELECT o.id FROM mirror.schedule_occurrences o JOIN mirror.shops s
      ON s.id=o.shop_id AND s.installation_version=o.installation_version AND s.uninstalled_at IS NULL
      WHERE o.shop_id=$1 AND o.id=$2 AND o.status='RUNNING' AND o.phase=$3 AND o.fence=$4 AND o.lease_token=$5
       AND o.lease_until>clock_timestamp() AND o.installation_version=$6 FOR UPDATE OF o`,
      [claim.shop_id,claim.id,claim.phase,claim.fence,claim.lease_token,claim.installation_version]);
    if(!result.rows[0])fail(C.CONTRACT_MISMATCH,"Schedule occurrence lease superseded");
  };
  async function advance(client,claim,{snapshotId=claim.snapshot_id,contractId=claim.contract_id,commandId=claim.command_id,phase,status=undefined,result=null,delaySeconds=0}) {
    await owned(client,claim);
    const updated=await client.query(`UPDATE mirror.schedule_occurrences SET phase=$6,snapshot_id=$7,contract_id=$8,command_id=$9,
      status=COALESCE($10, CASE WHEN $6='DONE' THEN 'DISPATCHED' ELSE 'QUEUED' END),attempts=0,lease_token=NULL,lease_until=NULL,last_error=NULL,
      execution_result=COALESCE($11::jsonb,execution_result),next_attempt_at=clock_timestamp()+$12::integer*interval '1 second',updated_at=clock_timestamp() WHERE shop_id=$1 AND id=$2 AND phase=$3 AND fence=$4
      AND lease_token=$5 AND status='RUNNING' AND lease_until>clock_timestamp() AND installation_version=$13`,[claim.shop_id,claim.id,claim.phase,claim.fence,claim.lease_token,phase,snapshotId,contractId,commandId,status,result===null?null:JSON.stringify(result),delaySeconds,claim.installation_version]);
    if(updated.rowCount!==1)fail(C.CONTRACT_MISMATCH,"Schedule occurrence completion superseded");
  }
  return Object.freeze({
    async createSchedule({authContext,recurrence="DAILY",timezone="UTC",operation="bulk_edit",template={},freezeTargetsOnCreation=false,firstRunAt=null,enabled=true,...unsupported}={}) {
      if(Object.hasOwn(unsupported,"shopId")||Object.hasOwn(unsupported,"client"))fail(C.PERMISSION_DENIED,"Schedule uses authenticated shop and protected transaction");
      const shopId=await authenticated(authContext);
      if(!Object.hasOwn(INTERVALS,recurrence)||timezone!=="UTC"||operation!=="bulk_edit")fail(C.INVALID_VALUE,"Supported UTC bulk-edit recurrence required");
      if(!template||typeof template!=="object"||Array.isArray(template)||Object.keys(template).some(key=>!["selectionMode","filter","productIds","excludedProductIds","contractPayload"].includes(key)))fail(C.INVALID_VALUE,"Invalid schedule template");
      const frozen=structuredClone(template);
      frozen.mutationAdapterVersion=currentMutationAdapterVersion(frozen.contractPayload?.resourceType??'product');
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
        await lockPublication(client,shopId);
        await authenticated(authContext,shopId);
        const installation=(await client.query('SELECT installation_version FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR SHARE',[shopId])).rows[0];
        if(!installation)fail(C.PERMISSION_DENIED,'Current scheduled installation required');
        if(snapshot&&snapshot.installationId!==installation.installation_version)fail(C.CONTRACT_MISMATCH,'Frozen selection installation differs');
        return (await client.query(`INSERT INTO mirror.job_schedules(shop_id,enabled,timezone,recurrence,operation,template,next_run_at,fence)
          VALUES($1,$2,$3,$4,$5,$6,$7,0) RETURNING id,shop_id,enabled,recurrence,next_run_at`,[shopId,enabled,timezone,recurrence,operation,JSON.stringify(frozen),due])).rows[0];
      };
      if(freezeTargetsOnCreation) {
        if(typeof selectionService?.withSelectionTransaction!=="function")fail(C.EXECUTION_UNAVAILABLE,"Protected selection transaction required");
        return selectionService.withSelectionTransaction({authContext,mode:frozen.selectionMode||"ALL_MATCHING",filter:frozen.filter,
          productIds:frozen.productIds,excludedProductIds:frozen.excludedProductIds,operation,maxItems:MAX_TARGETS},({client,snapshot})=>insert(client,snapshot));
      }
      return transaction(client=>insert(client),{shopId});
    },
    async triggerDueSchedules({now=new Date()}={}) {
      if(!(now instanceof Date)||!Number.isFinite(now.getTime()))fail(C.INVALID_VALUE,"Valid schedule discovery time required");
      return transaction(async client=>{
        const due=(await client.query(`SELECT j.id,j.shop_id,j.recurrence,j.operation,j.template,j.next_run_at,j.installation_version FROM mirror.job_schedules j
          JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
          WHERE j.enabled=true AND j.next_run_at<=$1 ORDER BY j.next_run_at,j.id LIMIT 10 FOR UPDATE OF j SKIP LOCKED`,[now])).rows;
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
      },{connection:requireWorker()});
    },
    async processNextOccurrence({leaseSeconds=300}={}) {
      if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>600)fail(C.INVALID_VALUE,"Bounded occurrence lease required");
      if(typeof getScheduleAuthContext!=="function"||typeof selectionService?.withSelectionTransaction!=="function"||typeof approvalService?.approveContract!=="function"||typeof jobDispatchService?.dispatchBulkEdit!=="function")fail(C.EXECUTION_UNAVAILABLE,"Authenticated occurrence execution services required");
      const worker=requireWorker();
      await worker.query(`UPDATE mirror.schedule_occurrences o SET status='REVIEW_REQUIRED',lease_token=NULL,lease_until=NULL,last_error='INSTALLATION_CHANGED'
        WHERE status NOT IN('SUCCEEDED','PARTIAL','FAILED','CANCELLED','REVIEW_REQUIRED') AND NOT EXISTS(
         SELECT 1 FROM mirror.shops s WHERE s.id=o.shop_id AND s.installation_version=o.installation_version AND s.uninstalled_at IS NULL)`);
      await worker.query(`UPDATE mirror.schedule_occurrences SET status=CASE WHEN phase='DONE' THEN 'REVIEW_REQUIRED' ELSE 'FAILED' END,lease_token=NULL,lease_until=NULL,last_error='Occurrence retry budget exhausted'
        WHERE attempts>=8 AND (status='RETRY' OR status='RUNNING' AND lease_until<=clock_timestamp())`);
      const claim=(await worker.query(`WITH due AS(SELECT o.id FROM mirror.schedule_occurrences o
        JOIN mirror.shops s ON s.id=o.shop_id AND s.installation_version=o.installation_version AND s.uninstalled_at IS NULL
        WHERE o.attempts<8 AND (o.status IN('QUEUED','RETRY','DISPATCHED','EXECUTING') AND o.next_attempt_at<=clock_timestamp() OR o.status='RUNNING' AND o.lease_until<=clock_timestamp())
        ORDER BY o.next_attempt_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED)
        UPDATE mirror.schedule_occurrences o SET status='RUNNING',attempts=attempts+1,fence=fence+1,lease_token=$1,
          lease_until=clock_timestamp()+$2::integer*interval '1 second',updated_at=clock_timestamp() FROM due WHERE o.id=due.id RETURNING o.*`,[randomUUID(),leaseSeconds])).rows[0];
      if(!claim)return {kind:"EMPTY"};
      try {
        const authContext=claim.phase==='DONE'?null:await getScheduleAuthContext({shopId:claim.shop_id,scheduleId:claim.schedule_id,occurrenceId:claim.id,installationId:claim.installation_version});
        if(claim.phase!=='DONE')await authenticated(authContext,claim.shop_id);
        const template=typeof claim.template==="string"?JSON.parse(claim.template):claim.template;
        if(claim.phase!=='DONE'&&!isDeepStrictEqual(template.mutationAdapterVersion,currentMutationAdapterVersion(template.contractPayload?.resourceType??'product')))
          fail(C.CONTRACT_MISMATCH,'Scheduled mutation adapter changed; revalidation required');
        if(claim.phase==="SELECT") {
          const save=async(client,snapshot)=>{
            if(snapshot.shopId!==claim.shop_id||snapshot.installationId!==claim.installation_version)fail(C.PERMISSION_DENIED,"Occurrence selection belongs to another shop");
            await authenticated(authContext,claim.shop_id);
            await advance(client,claim,{snapshotId:snapshot.snapshotId,phase:"APPROVE"});
          };
          if(template.frozenSnapshotId) {
            await transaction(async client=>{
              await owned(client,claim);
              const snapshot=await selectionService.getSelectionSnapshot({authContext,snapshotId:template.frozenSnapshotId});
              if(!snapshot||snapshot.status!=="APPROVED"||snapshot.operation!==claim.operation||snapshot.selectedCount>MAX_TARGETS||new Date(snapshot.expiresAt)<=new Date())fail(C.EXECUTION_UNAVAILABLE,"Frozen schedule selection expired or incompatible; approve a fresh selection");
              await save(client,snapshot);
            },{shopId:claim.shop_id,installationVersion:claim.installation_version});
          } else await selectionService.withSelectionTransaction({authContext,mode:template.selectionMode||"ALL_MATCHING",filter:template.filter,
            productIds:template.productIds,excludedProductIds:template.excludedProductIds,operation:claim.operation,operationId:`schedule-occurrence:${claim.id}`,maxItems:MAX_TARGETS},({client,snapshot})=>save(client,snapshot));
        } else await transaction(async client=>{
          await owned(client,claim);
          if(claim.phase==="APPROVE") {
            const approved=await approvalService.approveContract({client,authContext,shopId:claim.shop_id,snapshotId:claim.snapshot_id,operation:claim.operation,
              contractPayload:template.contractPayload});
            await authenticated(authContext,claim.shop_id);
            await advance(client,claim,{contractId:approved.contractId,phase:"DISPATCH"});
          } else if(claim.phase==="DISPATCH") {
            const command=await jobDispatchService.dispatchBulkEdit({client,authContext,contractId:claim.contract_id,actorId:`schedule:${claim.schedule_id}`});
            await authenticated(authContext,claim.shop_id);
            await advance(client,claim,{commandId:command.commandId,phase:"DONE",status:"DISPATCHED"});
          } else if(claim.phase==='DONE') {
            const command=(await client.query(`SELECT status,result,installation_version FROM mirror.job_commands
              WHERE shop_id=$1 AND id=$2 AND installation_version=$3 AND contract_id=$4
              AND EXISTS(SELECT 1 FROM mirror.execution_contracts a WHERE a.shop_id=$1 AND a.id=$4 AND a.snapshot_id=$5)`,
              [claim.shop_id,claim.command_id,claim.installation_version,claim.contract_id,claim.snapshot_id])).rows[0];
            if(!command)fail(C.CONTRACT_MISMATCH,'Owned execution command missing for scheduled occurrence');
            const result=typeof command.result==='string'?JSON.parse(command.result):command.result;
            if(result?.outcome==='REVIEW_REQUIRED')await advance(client,claim,{phase:'DONE',status:'REVIEW_REQUIRED',result});
            else if(['PENDING','RUNNING','RETRY'].includes(command.status))await advance(client,claim,{phase:'DONE',
              status:command.status==='PENDING'?'DISPATCHED':'EXECUTING',result,delaySeconds:5});
            else if(['SUCCEEDED','PARTIAL','FAILED','CANCELLED'].includes(command.status)){
              const finalization=(await client.query('SELECT state FROM mirror.operation_finalizations WHERE shop_id=$1 AND command_id=$2',[claim.shop_id,claim.command_id])).rows[0];
              let status;
              if(finalization?.state==='REVIEW_REQUIRED')status='REVIEW_REQUIRED';
              else if(finalization?.state!=='SUCCEEDED')status='EXECUTING';
              else if(result?.outcome==='PARTIAL'||result?.counts?.succeeded>0&&result?.counts?.failed>0)status='PARTIAL';
              else status=command.status;
              await advance(client,claim,{phase:'DONE',status,result,delaySeconds:status==='EXECUTING'?5:0});
            }else fail(C.CONTRACT_MISMATCH,'Unsupported scheduled command status');
          } else fail(C.CONTRACT_MISMATCH,"Invalid occurrence phase");
        },{shopId:claim.shop_id,installationVersion:claim.installation_version,connection:claim.phase==='DONE'?worker:database});
        return {kind:"ADVANCED",occurrenceId:claim.id,phase:claim.phase};
      }catch(error){
        const persisted=await worker.query(`UPDATE mirror.schedule_occurrences SET status=CASE WHEN $7::boolean THEN 'REVIEW_REQUIRED' WHEN attempts>=8 THEN CASE WHEN phase='DONE' THEN 'REVIEW_REQUIRED' ELSE 'FAILED' END ELSE 'RETRY' END,
          next_attempt_at=clock_timestamp()+LEAST(3600,5*power(2,attempts))::integer*interval '1 second',lease_token=NULL,lease_until=NULL,
          last_error=$6,updated_at=clock_timestamp() WHERE shop_id=$1 AND id=$2 AND phase=$3 AND fence=$4 AND lease_token=$5 AND status='RUNNING' AND lease_until>clock_timestamp()`,
        [claim.shop_id,claim.id,claim.phase,claim.fence,claim.lease_token,error instanceof FieldError?error.code:"OCCURRENCE_EXECUTION_FAILED",[C.CONTRACT_MISMATCH,C.PERMISSION_DENIED].includes(error.code)]);
        try{logger.error?.({code:error.code,occurrenceId:claim.id},"Schedule occurrence requires recovery");}catch{}
        return {kind:persisted.rowCount===1?([C.CONTRACT_MISMATCH,C.PERMISSION_DENIED].includes(error.code)?"REVIEW_REQUIRED":"RETRY"):"SUPERSEDED",occurrenceId:claim.id};
      }
    },
    async cancelOccurrence({authContext,occurrenceId}={}) {
      const shopId=await authenticated(authContext);
      return transaction(async client=>{
        const occurrence=(await client.query(`SELECT o.id,o.command_id,o.installation_version FROM mirror.schedule_occurrences o
          JOIN mirror.shops s ON s.id=o.shop_id AND s.installation_version=o.installation_version AND s.uninstalled_at IS NULL
          WHERE o.shop_id=$1 AND o.id=$2 AND o.status IN('QUEUED','RUNNING','RETRY','FAILED','DISPATCHED','EXECUTING') FOR UPDATE OF o`,[shopId,occurrenceId])).rows[0];
        if(!occurrence)return false;
        if(occurrence.command_id)await client.query(`UPDATE mirror.job_commands SET cancel_requested_at=COALESCE(cancel_requested_at,clock_timestamp()),updated_at=clock_timestamp()
          WHERE shop_id=$1 AND id=$2 AND installation_version=$3 AND status IN('PENDING','RUNNING','RETRY')`,[shopId,occurrence.command_id,occurrence.installation_version]);
        const updated=await client.query(`UPDATE mirror.schedule_occurrences SET status=$3,fence=fence+1,lease_token=NULL,lease_until=NULL,
          next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE shop_id=$1 AND id=$2`,[shopId,occurrenceId,occurrence.command_id?'EXECUTING':'CANCELLED']);
        await authenticated(authContext,shopId);return updated.rowCount===1;
      },{shopId});
    },
    async listSchedules({authContext}={}) {
      const shopId=await authenticated(authContext);
      return transaction(async client=>(await client.query(`SELECT j.id,j.enabled,j.timezone,j.recurrence,j.operation,j.next_run_at,j.last_run_at
        FROM mirror.job_schedules j JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
        WHERE j.shop_id=$1 ORDER BY j.id`,[shopId])).rows,{shopId});
    },
  });
}
