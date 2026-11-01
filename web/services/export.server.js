/** Legacy mirror.export_jobs artifact pipeline; not production HTTP admission.
 * Input: trusted database/publication/field/approval adapters and bounded budgets.
 * Output: legacy job creation, artifact generation and authorized download APIs.
 * Authority: revalidated shop, installation, contract and protected generation.
 * Lifecycle/effects: repository transactions own legacy jobs, leases, artifacts
 * and audit writes; fenced attempts isolate uploads and ambiguous commits.
 * Production uses export/export-service.server.js createExportService with
 * export_engine.v2 and export/export-runtime.server.js instead. No alias is
 * exported: importing this factory must explicitly opt into the legacy contract.
 */
import {createHash,randomUUID} from "node:crypto";
import {FieldError,FIELD_ERROR_CODES as C} from "../fields/types.js";
import {assertAuthorizedFieldService} from "../fields/resolve.js";
import {assertVerifiedMirrorSqlSchema,assertPhysicalColumn} from "./mirror-schema.server.js";
const fail=(code,message)=>{throw new FieldError(code,message);};
const COLUMNS=["id","shopify_id","title","handle","status","vendor","product_type","created_at","updated_at","published_at","tags"];
export const EXPORT_FIELD_IDS=Object.freeze(["product.id","product.title","product.handle","product.status","product.vendor","product.productType","product.createdAt","product.updatedAt","product.publishedAt","product.tags"]);
const FIELDS=EXPORT_FIELD_IDS;
export function encodeCsvCell(value) {
  let text=value==null?"":value instanceof Date?value.toISOString():typeof value==="object"?JSON.stringify(value):String(value);
  if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text))text=`'${text}`;
  return `"${text.replace(/"/g,'""')}"`;
}
export function createLegacyArtifactExportService({database,resolveShop,publicationService,publicationRepository,approvalService,fieldService,physicalSchema,authorizeExport,maxBytes=268435456,maxRows=100000}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1073741824||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>1000000)throw new TypeError("Export requires bounded server-owned row and byte budgets");
  if(typeof database?.connect!=="function"||typeof resolveShop!=="function"||typeof publicationService?.requirePublished!=="function"||typeof publicationService?.lockForRead!=="function"||typeof publicationRepository?.getPublishedContext!=="function"||
    typeof publicationRepository?.acquireReadLease!=="function"||typeof publicationRepository?.renewReadLease!=="function"||typeof approvalService?.getApprovedContract!=="function"||typeof authorizeExport!=="function")throw new TypeError("Export requires authenticated publication, approval, retention and authorization services");
  assertAuthorizedFieldService(fieldService);assertVerifiedMirrorSqlSchema(physicalSchema);
  const physical=()=>{
    assertVerifiedMirrorSqlSchema(physicalSchema);
    const table=physicalSchema.schema.products;
    if(table.schema!=="mirror"||table.table!=="products"||table.id!=="id"||table.shop!=="shop_id"||table.generation!=="generation_id")fail(C.CONTRACT_MISMATCH,"Installed export physical schema required");
    for(const column of COLUMNS)assertPhysicalColumn(physicalSchema,"product",column,column==="id"?"bigint":column==="tags"?"text[]":["created_at","updated_at","published_at"].includes(column)?"timestamptz":"text");
  };
  physical();
  async function shop(context,unsupported={}) {
    if(!context||Object.keys(unsupported).length)fail(C.PERMISSION_DENIED,"Authenticated export context required; shop and generation are server-pinned");
    const value=await resolveShop(context);
    if(typeof value!=="string"||value.trim()!==value||value.length>255||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value))fail(C.PERMISSION_DENIED,"Authenticated export shop required");
    return value;
  }
  async function transaction(callback) {
    const client=await database.connect();try{await client.query("BEGIN");await client.query("SET LOCAL lock_timeout='2000ms'");await client.query("SET LOCAL statement_timeout='10000ms'");
      const result=await callback(client);await client.query("COMMIT");return result;
    }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
  }
  async function authorize(client,authContext,job) {
    physical();
    if(await shop(authContext)!==job.shop_id)fail(C.PERMISSION_DENIED,"Export shop changed");
    await publicationService.requirePublished({client,shopId:job.shop_id,generationId:job.generation_id,coverageRevision:job.coverage_revision,datasets:["products"]});
    const installation=(await client.query(`SELECT s.installation_version FROM mirror.shops s WHERE s.id=$1 AND s.uninstalled_at IS NULL
      AND EXISTS(SELECT 1 FROM mirror.catalog_import_jobs i WHERE i.shop_id=s.id AND i.generation_id=$2 AND i.installation_version=s.installation_version AND i.status='SUCCEEDED')`,[job.shop_id,job.generation_id])).rows[0];
    if(!installation||job.installation_version!==undefined&&job.installation_version!==installation.installation_version)fail(C.PERMISSION_DENIED,"Export generation belongs to an obsolete or unverified installation");
    const command=(await client.query(`SELECT c.contract_id FROM mirror.job_commands c WHERE c.shop_id=$1 AND c.id=$2 AND c.kind='export'`,[job.shop_id,job.command_id])).rows[0];
    const contract=command?await approvalService.getApprovedContract({client,shopId:job.shop_id,contractId:command.contract_id}):null;
    if(!contract||contract.operation!=="export"||contract.shop_id!==job.shop_id)fail(C.PERMISSION_DENIED,"Approved export command required");
    const instructions=typeof contract.contract==="string"?JSON.parse(contract.contract):contract.contract;
    if(instructions.format!==job.format||!Array.isArray(instructions.fields)||instructions.fields.length!==FIELDS.length||FIELDS.some(field=>!instructions.fields.includes(field)))fail(C.CONTRACT_MISMATCH,"Export format and columns differ from approval");
    const target=(await client.query("SELECT generation_id,coverage_revision FROM mirror.selection_snapshots WHERE shop_id=$1 AND id=$2 AND status='APPROVED'",[job.shop_id,contract.snapshot_id])).rows[0];
    if(!target||contract.snapshot_id!==job.snapshot_id||target.generation_id!==job.generation_id||target.coverage_revision!==job.coverage_revision)fail(C.CONTRACT_MISMATCH,"Export pins differ from approved target");
    const resolution=await fieldService.requireFields({authContext,fieldIds:FIELDS,access:"read",operation:"export",executionContext:{phase:"preview",operationId:`export-${job.command_id}`,generationId:job.generation_id,coverageRevision:job.coverage_revision}});
    if(await authorizeExport({authContext,shopId:job.shop_id,operation:"export",format:job.format,contract,resolution})!==true)fail(C.PERMISSION_DENIED,"Current export authorization required");
    await fieldService.revalidateResolution(resolution,{authContext});
    return installation.installation_version;
  }
  async function checkLease(client,authContext,claim) {
    await authorize(client,authContext,claim);
    const current=(await client.query(`SELECT id FROM mirror.export_jobs WHERE shop_id=$1 AND id=$2 AND status='WRITING' AND fence=$3
      AND lease_token=$4 AND lease_until>clock_timestamp() FOR UPDATE`,[claim.shop_id,claim.id,claim.fence,claim.lease_token])).rows[0];
    if(!current)fail(C.CONTRACT_MISMATCH,"Export write lease lost");
    const lease=(await client.query(`SELECT id FROM mirror.generation_read_leases WHERE shop_id=$1 AND id=$2 AND generation_id=$3
      AND coverage_revision=$4 AND mapping_version=$5 AND owner=$6 AND operation='export' AND expires_at>clock_timestamp()`,
    [claim.shop_id,claim.read_lease_id,claim.generation_id,claim.coverage_revision,claim.mapping_version,claim.id])).rows[0];
    if(!lease)fail(C.EXECUTION_UNAVAILABLE,"Export retention lease expired");
    await publicationRepository.renewReadLease({client,shopId:claim.shop_id,leaseId:claim.read_lease_id,leaseSeconds:3600});
    await client.query("UPDATE mirror.export_jobs SET lease_until=clock_timestamp()+interval '120 seconds' WHERE shop_id=$1 AND id=$2 AND fence=$3 AND lease_token=$4",[claim.shop_id,claim.id,claim.fence,claim.lease_token]);
  }
  const artifact=row=>Object.freeze({exportJobId:row.id,objectKey:row.artifact_key,sha256:row.sha256,byteLength:Number(row.byte_length),rowCount:Number(row.row_count),format:row.format});
  return Object.freeze({
    async createExportJob({authContext,commandId,format="jsonl",...unsupported}={}) {
      const shopId=await shop(authContext,unsupported);
      if(!["csv","jsonl"].includes(format)||typeof commandId!=="string"||!(/^[1-9][0-9]{0,18}$/).test(commandId)||BigInt(commandId)>9223372036854775807n)fail(C.INVALID_VALUE,"Supported export format and command ID required");
      return transaction(async client=>{
        await publicationService.lockForRead(client,shopId);
        const prior=(await client.query("SELECT * FROM mirror.export_jobs WHERE shop_id=$1 AND command_id=$2 AND format=$3",[shopId,commandId,format])).rows[0];
        if(prior){await authorize(client,authContext,prior);return Object.freeze({exportJobId:prior.id,status:prior.status});}
        const target=(await client.query(`SELECT s.id AS snapshot_id,s.generation_id,s.coverage_revision FROM mirror.job_commands c JOIN mirror.execution_contracts a ON a.shop_id=c.shop_id AND a.id=c.contract_id
          JOIN mirror.selection_snapshots s ON s.shop_id=a.shop_id AND s.id=a.snapshot_id WHERE c.shop_id=$1 AND c.id=$2 AND c.kind='export'`,[shopId,commandId])).rows[0];
        if(!target)fail(C.PERMISSION_DENIED,"Approved export target required");
        const context=await publicationRepository.getPublishedContext({client,shopId,generationId:target.generation_id});
        if(!context||context.generationId!==target.generation_id||context.coverageRevision!==target.coverage_revision)fail(C.MISSING_DEPENDENCY,"Published export generation required");
        const id=randomUUID(),pin={id,shop_id:shopId,command_id:commandId,generation_id:context.generationId,coverage_revision:context.coverageRevision,snapshot_id:target.snapshot_id,format};
        const installation=await authorize(client,authContext,pin);
        const lease=await publicationRepository.acquireReadLease({client,shopId,generationId:pin.generation_id,operation:"export",owner:id,leaseSeconds:3600});
        await client.query(`INSERT INTO mirror.export_jobs(id,shop_id,command_id,installation_version,generation_id,coverage_revision,mapping_version,read_lease_id,format,snapshot_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,shopId,commandId,installation,pin.generation_id,pin.coverage_revision,lease.mappingVersion,lease.leaseId,format,pin.snapshot_id]);
        return Object.freeze({exportJobId:id,status:"QUEUED"});
      });
    },
    async generateExportArtifact({authContext,exportJobId,writer,retentionMs=86400000,...unsupported}={}) {
      const shopId=await shop(authContext,unsupported);
      if(!writer||["begin","write","commit","abort"].some(name=>typeof writer[name]!=="function"))fail(C.MISSING_DEPENDENCY,"Durable temporary artifact writer required");
      if(typeof exportJobId!=="string"||!exportJobId||exportJobId.length>128||!Number.isSafeInteger(retentionMs)||retentionMs<60000||retentionMs>86400000)fail(C.INVALID_VALUE,"Export job and bounded artifact retention required");
      await database.query(`UPDATE mirror.export_jobs SET status='FAILED',lease_token=NULL,lease_until=NULL,last_error='Export retry budget exhausted'
        WHERE shop_id=$1 AND id=$2 AND status='WRITING' AND attempts>=8 AND lease_until<=clock_timestamp()`,[shopId,exportJobId]);
      const previous=(await database.query("SELECT * FROM mirror.export_jobs WHERE shop_id=$1 AND id=$2",[shopId,exportJobId])).rows[0];
      if(!previous)fail(C.PERMISSION_DENIED,"Export job not found");
      if(previous.status==="READY"){await transaction(client=>authorize(client,authContext,previous));return artifact(previous);}
      const token=randomUUID();
      const claim=(await database.query(`UPDATE mirror.export_jobs SET status='WRITING',attempts=attempts+1,fence=fence+1,lease_token=$3,lease_until=clock_timestamp()+interval '120 seconds'
        WHERE shop_id=$1 AND id=$2 AND attempts<8 AND ((status IN('QUEUED','RETRY') AND next_attempt_at<=clock_timestamp()) OR status='WRITING' AND lease_until<=clock_timestamp()) RETURNING *`,[shopId,exportJobId,token])).rows[0];
      if(!claim)fail(C.EXECUTION_UNAVAILABLE,"Export busy, exhausted or not due");
      // Every fenced attempt owns its own final object as well as its upload.
      // A stale abort must never remove a newer attempt's registered artifact.
      const objectKey=`exports/${shopId}/${claim.command_id}/${claim.id}/${claim.fence}.${claim.format}`,temporaryKey=`temporary/${claim.id}/${claim.fence}`;
      try {
        await transaction(client=>checkLease(client,authContext,claim));
        await writer.begin({temporaryKey,objectKey});
        const hasher=createHash("sha256");let byteLength=0,rowCount=0,after="0";
        const write=async text=>{const chunk=Buffer.from(text,"utf8");if(chunk.length>maxBytes-byteLength)fail(C.INVALID_VALUE,"Export byte budget exceeded");hasher.update(chunk);byteLength+=chunk.length;await writer.write(chunk);};
        if(claim.format==="csv")await write(COLUMNS.map(encodeCsvCell).join(",")+"\r\n");
        for(;;) {
          const rows=await transaction(async client=>{
            await checkLease(client,authContext,claim);
            return (await client.query(`SELECT p.id,p.shopify_id,p.title,p.handle,p.status,p.vendor,p.product_type,p.created_at,p.updated_at,p.published_at,p.tags
              FROM mirror.products p JOIN mirror.selection_items si ON si.shop_id=p.shop_id AND si.generation_id=p.generation_id AND si.product_id=p.id
              WHERE p.shop_id=$1 AND p.generation_id=$2 AND p.id>$3::bigint AND si.snapshot_id=$4 ORDER BY p.id LIMIT 500`,[shopId,claim.generation_id,after,claim.snapshot_id])).rows;
          });
          for(const row of rows){if(rowCount>=maxRows)fail(C.INVALID_VALUE,"Export row budget exceeded");after=String(row.id);await write(claim.format==="csv"?COLUMNS.map(column=>encodeCsvCell(row[column])).join(",")+"\r\n":JSON.stringify(row)+"\n");rowCount++;}
          if(rows.length<500)break;
        }
        const sha256=hasher.digest("hex");
        const receipt=await writer.commit({objectKey,byteLength,sha256});
        if(!receipt||receipt.durable!==true||receipt.objectKey!==objectKey||receipt.byteLength!==byteLength||receipt.sha256!==sha256)fail(C.EXECUTION_UNAVAILABLE,"Durable artifact completion could not be verified");
        await transaction(async client=>{
          await checkLease(client,authContext,claim);
          await client.query(`INSERT INTO mirror.job_artifacts(shop_id,command_id,object_key,kind,sha256,byte_length,row_count,expires_at)
            VALUES($1,$2,$3,'export',$4,$5,$6,$7)`,[shopId,claim.command_id,objectKey,sha256,byteLength,rowCount,new Date(Date.now()+retentionMs)]);
          const result=await client.query(`UPDATE mirror.export_jobs SET status='READY',artifact_key=$5,sha256=$6,byte_length=$7,row_count=$8,lease_token=NULL,lease_until=NULL
            WHERE shop_id=$1 AND id=$2 AND fence=$3 AND lease_token=$4 AND status='WRITING'`,[shopId,claim.id,claim.fence,token,objectKey,sha256,byteLength,rowCount]);
          if(result.rowCount!==1)fail(C.CONTRACT_MISMATCH,"Export completion superseded");
        });
        return artifact({...claim,artifact_key:objectKey,sha256,byte_length:byteLength,row_count:rowCount});
      }catch(error){
        // A lost final COMMIT response must not delete an already registered file.
        const completed=(await database.query("SELECT * FROM mirror.export_jobs WHERE shop_id=$1 AND id=$2 AND status='READY'",[shopId,claim.id])).rows[0];
        if(completed){if(completed.artifact_key!==objectKey)try{await writer.abort({temporaryKey,objectKey});}catch{}await transaction(client=>authorize(client,authContext,completed));return artifact(completed);}
        try{await writer.abort({temporaryKey,objectKey});}catch{}
        await database.query(`UPDATE mirror.export_jobs SET status=CASE WHEN attempts>=8 THEN 'FAILED' ELSE 'RETRY' END,lease_token=NULL,lease_until=NULL,
          next_attempt_at=clock_timestamp()+LEAST(3600,5*power(2,attempts))::integer*interval '1 second',last_error=$5
          WHERE shop_id=$1 AND id=$2 AND fence=$3 AND lease_token=$4 AND status='WRITING'`,[shopId,claim.id,claim.fence,token,error.code??"EXPORT_FAILED"]);
        throw error;
      }
    },
    async cancelExportJob({authContext,exportJobId,...unsupported}={}) {
      const shopId=await shop(authContext,unsupported);
      if(typeof exportJobId!=="string"||!exportJobId||exportJobId.length>128)fail(C.INVALID_VALUE,"Bounded export job ID required");
      return (await database.query(`UPDATE mirror.export_jobs SET status='CANCELLED',fence=fence+1,lease_token=NULL,lease_until=NULL
        WHERE shop_id=$1 AND id=$2 AND status IN('QUEUED','WRITING','RETRY','FAILED')`,[shopId,exportJobId])).rowCount===1;
    },
  });
}
