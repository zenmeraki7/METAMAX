// Interface contract (repository root): docs/backend-interface-contracts.md#reviewed-import-handoff
import {requireInstalledWriteCapability,WRITE_CAPABILITY_VERSION} from '../fields/write-capabilities.js';
/** Import preparation and explicit merchant approval are separate operations. */
import {createHash,randomUUID} from "node:crypto";
import {FieldError,FIELD_ERROR_CODES as C,deepFreeze,isPlainObject} from "../fields/types.js";
import {requireCanonicalField} from "../fields/canonical.js";
import {normalizeWriteOperand,validateFinalWriteValue,WRITE_OPERATIONS} from "../fields/constraints.js";
import {assertAuthorizedFieldService} from "../fields/resolve.js";
import {canonicalApproval} from "./approval.server.js";
const fail=(code,message)=>{throw new FieldError(code,message);};

function normalize(records) {
  if(!Array.isArray(records)||!records.length||records.length>1000)fail(C.INVALID_VALUE,"Import requires 1–1000 records");
  try{if(Buffer.byteLength(JSON.stringify(records))>1048576)fail(C.INVALID_VALUE,"Import exceeds byte budget");}catch(error){if(error instanceof FieldError)throw error;fail(C.INVALID_VALUE,"JSON import records required");}
  const validRows=[],invalidRows=[],fieldIds=new Set(),targets=new Set();
  for(let index=0;index<records.length;index++) {
    const row=records[index],errors=[],fields={};
    if(!isPlainObject(row)){invalidRows.push({line:index+1,errors:["Record must be an object"]});continue;}
    const supplied=["id","shopify_id"].filter(key=>Object.hasOwn(row,key));
    const raw=supplied.length===1?row[supplied[0]]:null;
    const target=typeof raw==="number"&&Number.isSafeInteger(raw)?String(raw):raw;
    if(typeof target!=="string"||target.length>100||!(/^[1-9][0-9]*$/.test(target)&&BigInt(target)<=9223372036854775807n||/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(target)))errors.push("One valid product identity required");
    if(targets.has(target))errors.push("Duplicate import target");
    targets.add(target);
    if(Object.keys(row).length>52)errors.push("Too many import fields");
    for(const [key,value] of Object.entries(row)) {
      if(["id","shopify_id"].includes(key))continue;
      try {
        const canonical=requireCanonicalField(key.includes(".")?key:`product.${key}`);
        if(Object.hasOwn(fields,canonical.id))fail(C.INVALID_VALUE,"Duplicate field alias");
        requireInstalledWriteCapability(canonical.id);
        const normalized=normalizeWriteOperand(canonical.id,WRITE_OPERATIONS.SET,value);
        const final=validateFinalWriteValue(canonical.id,WRITE_OPERATIONS.SET,normalized);
        if(canonical.entity!=="product")fail(C.UNSUPPORTED_OPERATION,"Product import does not target variants or inventory");
        fields[canonical.id]=final;fieldIds.add(canonical.id);
      }catch(error){errors.push({field:key,code:error.code??C.INVALID_VALUE});}
    }
    if(!Object.keys(fields).length)errors.push("At least one writable field required");
    if(errors.length)invalidRows.push({line:index+1,errors});else validRows.push({line:index+1,targetId:target,fields});
  }
  return deepFreeze({totalRows:records.length,validCount:validRows.length,invalidCount:invalidRows.length,validRows,invalidRows,fieldIds:[...fieldIds].sort()});
}

export function createImportPreviewService({database,selectionService,approvalService,fieldService,resolveShop,resolveMerchantActor,resolveDatasets}={}) {
  if(typeof database?.connect!=="function"||typeof selectionService?.withSelectionTransaction!=="function"||typeof approvalService?.approveContract!=="function"||typeof approvalService?.getApprovedContract!=="function"||
    typeof resolveShop!=="function"||typeof resolveMerchantActor!=="function"||typeof resolveDatasets!=="function")throw new TypeError("Import previews require durable selection, approval, merchant identity and field authorization");
  assertAuthorizedFieldService(fieldService);
  async function identity(authContext,unsupported={}) {
    if(!authContext||Object.keys(unsupported).length)fail(C.PERMISSION_DENIED,"Verified merchant import context required; preparation cannot approve");
    const shopId=await resolveShop(authContext),actor=await resolveMerchantActor(authContext);
    if(!actor||actor.shopId!==shopId||typeof actor.id!=="string"||!actor.id||typeof shopId!=="string"||shopId.trim()!==shopId||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopId))fail(C.PERMISSION_DENIED,"Verified merchant actor required");
    return {shopId,actor};
  }
  async function authorize(validation,authContext,executionContext) {
    if(!validation.fieldIds.length)return null;
    return fieldService.requireFields({authContext,fieldIds:validation.fieldIds,access:"write",operation:"import",executionContext:{...executionContext,phase:"preview"}});
  }
  return Object.freeze({
    async validateImportRecords({authContext,records,...unsupported}={}) {
      const {shopId}=await identity(authContext,unsupported),validation=normalize(records);
      const context=await resolveDatasets({authContext});
      await authorize(validation,authContext,context.executionContext);
      if(await resolveShop(authContext)!==shopId)fail(C.PERMISSION_DENIED,"Import shop changed");
      return validation;
    },
    async createImportPreview({authContext,records,...unsupported}={}) {
      const {shopId,actor}=await identity(authContext,unsupported),validation=normalize(records);
      if(validation.invalidCount)fail(C.INVALID_VALUE,"Import contains invalid fields, values or targets");
      return selectionService.withSelectionTransaction({authContext,mode:"EXPLICIT",productIds:validation.validRows.map(row=>row.targetId),operation:"import"},async({client,snapshot})=>{
        if(snapshot.shopId!==shopId||snapshot.selectedCount!==validation.validRows.length)fail(C.CONTRACT_MISMATCH,"Every import row must resolve to a distinct authorized product");
        const resolution=await authorize(validation,authContext,{operationId:snapshot.operationId,generationId:snapshot.generationId,coverageRevision:snapshot.coverageRevision});
        const targets=(await client.query(`SELECT p.id::text,p.shopify_id FROM mirror.selection_items si JOIN mirror.products p
          ON p.shop_id=si.shop_id AND p.generation_id=si.generation_id AND p.id=si.product_id
          WHERE si.shop_id=$1 AND si.snapshot_id=$2 ORDER BY p.id`,[shopId,snapshot.snapshotId])).rows;
        const seen=new Set();
        const rows=validation.validRows.map(row=>{
          const matches=targets.filter(target=>target.id===row.targetId||target.shopify_id===row.targetId);
          if(matches.length!==1||seen.has(matches[0].shopify_id))fail(C.CONTRACT_MISMATCH,'Exact distinct import resource mapping required');
          seen.add(matches[0].shopify_id);return {...row,resourceGid:matches[0].shopify_id};
        });
        if(targets.length!==rows.length)fail(C.CONTRACT_MISMATCH,'Complete import selection mapping required');
        const payload={writeCapabilityVersion:WRITE_CAPABILITY_VERSION,importMappingVersion:1,resourceType:'product',kind:"import",rowCount:validation.validCount,rows,fieldIds:validation.fieldIds,
          registryVersion:resolution.registryVersion,definitionRevisions:resolution.definitionRevisions};
        const canonical=canonicalApproval({shopId,snapshotId:snapshot.snapshotId,operation:"import-preview",contract:payload,selectionHash:snapshot.selectionHash,approvedBy:actor.id});
        const previewHash=createHash("sha256").update(canonical).digest("hex"),previewId=randomUUID();
        await fieldService.revalidateResolution(resolution,{authContext});
        const current=await identity(authContext);
        if(current.shopId!==shopId||current.actor.id!==actor.id)fail(C.PERMISSION_DENIED,"Import preparation actor changed");
        await client.query(`INSERT INTO mirror.import_previews(id,shop_id,snapshot_id,payload,canonical_preview,preview_hash,created_by,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[previewId,shopId,snapshot.snapshotId,JSON.stringify(payload),canonical,previewHash,actor.id,snapshot.expiresAt]);
        return Object.freeze({previewId,snapshotId:snapshot.snapshotId,status:"DRAFT",previewHash,rowCount:validation.validCount,expiresAt:snapshot.expiresAt});
      });
    },
    async getImportPreview({authContext,previewId,...unsupported}={}) {
      const {shopId}=await identity(authContext,unsupported);
      if(typeof previewId!=="string"||!previewId||previewId.length>128)fail(C.INVALID_VALUE,"Bounded preview ID required");
      const client=await database.connect();
      try{
        await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='10000ms'");
        await client.query("SELECT set_config('app.shop_id',$1,true)",[shopId]);
        const preview=(await client.query("SELECT id,snapshot_id,status,payload,preview_hash,expires_at,contract_id FROM mirror.import_previews WHERE shop_id=$1 AND id=$2",[shopId,previewId])).rows[0]??null;
        if(await resolveShop(authContext)!==shopId)fail(C.PERMISSION_DENIED,'Import preview shop changed');
        await client.query('COMMIT');return preview;
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
    },
    async approveImportPreview({authContext,previewId,expectedPreviewHash,...unsupported}={}) {
      const {shopId,actor}=await identity(authContext,unsupported);
      if(typeof previewId!=="string"||!previewId||previewId.length>128||typeof expectedPreviewHash!=="string"||expectedPreviewHash.length!==64||!(/^[a-f0-9]{64}$/).test(expectedPreviewHash))fail(C.INVALID_VALUE,"Reviewed preview ID and exact hash required");
      const client=await database.connect();
      try {
        await client.query("BEGIN");await client.query("SET LOCAL lock_timeout='2000ms'");await client.query("SET LOCAL statement_timeout='10000ms'");
        await client.query("SELECT set_config('app.shop_id',$1,true)",[shopId]);
        const preview=(await client.query("SELECT p.*,s.generation_id,s.coverage_revision,s.operation_id FROM mirror.import_previews p JOIN mirror.selection_snapshots s ON s.shop_id=p.shop_id AND s.id=p.snapshot_id WHERE p.shop_id=$1 AND p.id=$2 FOR UPDATE OF p",[shopId,previewId])).rows[0];
        if(!preview||preview.preview_hash!==expectedPreviewHash||new Date(preview.expires_at)<=new Date())fail(C.CONTRACT_MISMATCH,"Preview missing, expired or changed");
        const payload=typeof preview.payload==="string"?JSON.parse(preview.payload):preview.payload;
        const resolution=await fieldService.requireFields({authContext,fieldIds:payload.fieldIds,access:"write",operation:"import",executionContext:{phase:"preview",
          operationId:preview.operation_id,generationId:preview.generation_id,coverageRevision:preview.coverage_revision,expectedRegistryVersion:payload.registryVersion}});
        await fieldService.revalidateResolution(resolution,{authContext});
        let approved;
        if(preview.status==="APPROVED")approved=await approvalService.getApprovedContract({client,shopId,contractId:preview.contract_id});
        else approved=await approvalService.approveContract({client,shopId,authContext,snapshotId:preview.snapshot_id,operation:"import",
          contractPayload:{previewId,previewHash:expectedPreviewHash}});
        const current=await identity(authContext);
        if(current.shopId!==shopId||current.actor.id!==actor.id)fail(C.PERMISSION_DENIED,"Import approval actor changed");
        await client.query("COMMIT");
        return Object.freeze({previewId,status:"APPROVED",contractId:approved.contractId??approved.id,contractHash:approved.contractHash??approved.contract_hash});
      }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
    },
  });
}
