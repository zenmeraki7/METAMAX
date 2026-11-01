// Interface contract (repository root): docs/backend-interface-contracts.md#selection
import {lockPublication} from "../mirror/publication-lock.server.js";
import {selectionSnapshotRecord} from './selection-snapshot.server.js';
/** Frozen tenant selections: bounded pages, database-owned membership. */
import { createHash, randomUUID } from "node:crypto";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { parseFilterAst } from "../filters/ast.js";

const LIFETIME = 3600000, MAX_ITEMS = 1000000, MAX_EXPLICIT = 10000, PAGE_SIZE = 1000;
const fail = (code,message) => {throw new FieldError(code,message);};
const numericOrder = (a,b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const identityFilter = Object.freeze({version:1,root:Object.freeze({kind:"condition",field:"product.id",operator:"is_not_null"})});
function identity(id) {
  if (!["string","number","bigint"].includes(typeof id) || (typeof id === "number" && !Number.isSafeInteger(id))) fail(C.INVALID_VALUE,"Invalid product ID");
  const value=String(id);
  if (value.length<=100 && (/^[1-9][0-9]*$/.test(value) && BigInt(value)<=9223372036854775807n || /^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(value))) return value;
  fail(C.INVALID_VALUE,"Invalid product ID");
}
function boundedIds(ids,limit) {
  if(!Array.isArray(ids)||ids.length>limit) fail(C.INVALID_VALUE,"Bounded product IDs required");
  return ids.map(identity);
}

export function createSelectionService({database,catalogQueryService,resolveShop,logger=console}={}) {
  if(typeof database?.query!=="function") throw new TypeError("Database client with query method required");
  if(typeof resolveShop!=="function") throw new TypeError("Trusted selection shop resolver required");
  if(typeof catalogQueryService?.withSelectionSnapshot!=="function") throw new TypeError("Protected catalog query service required for every selection mode");
  async function shop(context) {
    const value=await resolveShop(context);
    if(typeof value!=="string"||value.length>255||value.trim()!==value||!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value)) fail(C.PERMISSION_DENIED,"Authenticated selection shop required");
    return value;
  }
  async function create({authContext,mode="EXPLICIT",productIds=[],excludedProductIds=[],filter=null,
    operation="bulk_edit",operationId=null,lifetimeMs=LIFETIME,maxItems=MAX_ITEMS,signal,...unsupported}={},callback) {
    if(!authContext||Object.keys(unsupported).length) fail(C.PERMISSION_DENIED,"Authenticated selection context required; shopId is server-resolved and overrides or SQL clients are not accepted");
    if(!["bulk_edit","export","import","scheduled_edit","recurring_edit","undo"].includes(operation)||operationId!==null&&(typeof operationId!=="string"||!operationId||operationId.length>128))fail(C.INVALID_VALUE,"Supported selection operation and bounded identity required");
    if(!["EXPLICIT","ALL_MATCHING","ALL_MATCHING_WITH_EXCLUSIONS"].includes(mode)) fail(C.INVALID_VALUE,"Unsupported selection mode");
    if(!Number.isSafeInteger(lifetimeMs)||lifetimeMs<1||lifetimeMs>LIFETIME||!Number.isSafeInteger(maxItems)||maxItems<1||maxItems>MAX_ITEMS) fail(C.INVALID_VALUE,"Selection lifetime or materialization budget exceeded");
    // Shared installed command budget; exports retain the larger read budget.
    const commandLimit=operation==='import'?1000:operation==='export'?MAX_ITEMS:100000;
    maxItems=Math.min(maxItems,commandLimit);
    const exclusions=boundedIds(excludedProductIds,MAX_EXPLICIT);
    const ids=mode==="EXPLICIT"?[...new Set(boundedIds(productIds,Math.min(maxItems,MAX_EXPLICIT)))]:[];
    if(mode==="EXPLICIT"&&!ids.length) fail(C.INVALID_VALUE,"Explicit selection requires bounded non-empty productIds");
    const ast=mode==="EXPLICIT"?null:parseFilterAst(filter);
    const shopId=await shop(authContext);
    if(signal!==undefined && !(signal instanceof AbortSignal))fail(C.INVALID_VALUE,"Trusted cancellation signal required");
    signal?.throwIfAborted();
    const revalidate=async()=>{if(await shop(authContext)!==shopId) fail(C.PERMISSION_DENIED,"Authenticated selection shop changed");};
    async function materialize(tx,queryPage,external,pins={}) {
      try {
        await revalidate();
        if(!external) {
          await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
          await tx.query("SET LOCAL lock_timeout = '1000ms'");
          await tx.query("SET LOCAL statement_timeout = '5000ms'");
          await lockPublication(tx,shopId);
        }
        const published=(await tx.query(`SELECT p.generation_id,g.coverage_revision,g.mapping_version,sh.installation_version FROM mirror.publications p
          JOIN mirror.generations g ON g.shop_id=p.shop_id AND g.id=p.generation_id
          JOIN mirror.shops sh ON sh.id=p.shop_id AND sh.uninstalled_at IS NULL WHERE p.shop_id=$1`,[shopId])).rows[0];
        if(!published) fail(C.EXECUTION_UNAVAILABLE,"No published catalog generation available for shop");
        const {generation_id:generationId,coverage_revision:coverageRevision,mapping_version:mappingVersion}=published;
        if(pins.generationId!==undefined&&pins.generationId!==generationId||pins.coverageRevision!==undefined&&pins.coverageRevision!==coverageRevision) fail(C.CONTRACT_MISMATCH,"Selection publication differs from pinned snapshot");
        const snapshotId=randomUUID(),opId=operationId||randomUUID(),now=new Date(),expiresAt=new Date(now.getTime()+lifetimeMs);
        let registry,definitions=[],authorizedFilter=ast||{mode},fingerprint=createHash("sha256").update(JSON.stringify(authorizedFilter)).digest("hex"),pageIdentity;
        let firstPage;
        {
          // Execute a bounded canonical identity query through the real engine:
          // this verifies current field permissions, physical bindings and live
          // publication coverage inside the same transaction as membership.
          const proof=await queryPage(undefined,{client:tx,generationId,coverageRevision});
          if(!proof||proof.shopId!==shopId||proof.generationId!==generationId||proof.coverageRevision!==coverageRevision||typeof proof.registryVersion!=="string"||!proof.registryVersion||!Array.isArray(proof.definitionRevisions))fail(C.CONTRACT_MISMATCH,"Explicit selection lacks verified catalog authorization");
          registry=proof.registryVersion;definitions=proof.definitionRevisions;
          firstPage=proof;
        }
        await tx.query(`INSERT INTO mirror.selection_snapshots(shop_id,id,generation_id,coverage_revision,mapping_version,operation,operation_id,
          status,filter_ast,filter_fingerprint,registry_version,definition_revisions,selected_count,selection_hash,frozen_at,expires_at,created_at,target_mode,installation_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8,$9,$10,$11,0,$12,NULL,$13,$14,$15,$16)`,
        [shopId,snapshotId,generationId,coverageRevision,mappingVersion,operation,opId,JSON.stringify(authorizedFilter),fingerprint,registry,"[]","0".repeat(64),expiresAt,now,mode,published.installation_version]);
        let matched=0;
        const add=async(requested)=>{
          if(!requested.length) return;
          const rows=(await tx.query(`SELECT id,shopify_id FROM mirror.products WHERE shop_id=$1 AND generation_id=$2
            AND (id=ANY($3::bigint[]) OR shopify_id=ANY($4::text[]))`,[shopId,generationId,requested.filter(id=>!id.startsWith("gid://")),requested.filter(id=>id.startsWith("gid://"))])).rows;
          const wanted=new Set(requested),mapped=new Set();
          for(const row of rows) {
            const match=wanted.has(String(row.id))?String(row.id):row.shopify_id;
            if(!wanted.has(match)||mapped.has(match)) fail(C.CONTRACT_MISMATCH,"Selection product mapping changed");
            mapped.add(match);
          }
          if(mapped.size!==wanted.size) fail(C.CONTRACT_MISMATCH,"Selection product mapping is incomplete");
          const mappedIds=[...new Set(rows.map(row=>String(row.id)))].sort(numericOrder);
          matched+=mappedIds.length;
          if(matched>maxItems) fail(C.INVALID_VALUE,"Selection exceeds materialization budget");
          if(mappedIds.length) await tx.query(`INSERT INTO mirror.selection_items(shop_id,snapshot_id,generation_id,product_id)
            SELECT $1,$2,$3,value FROM unnest($4::bigint[]) AS value ${mode==="EXPLICIT"?"ON CONFLICT DO NOTHING":""}`,[shopId,snapshotId,generationId,mappedIds]);
        };
        if(mode==="EXPLICIT") {
          for(let i=0;i<ids.length;i+=PAGE_SIZE) await add(ids.slice(i,i+PAGE_SIZE));
        } else {
          let cursor,pages=0;
          const cursors=new Set();
          do {
            if(++pages>Math.ceil(maxItems/100)+1) fail(C.INVALID_VALUE,"Selection paging budget exceeded");
            const page=pages===1?firstPage:await queryPage(cursor,{client:tx,generationId,coverageRevision});
            if(!page||!Array.isArray(page.productIds)||page.productIds.length>100||typeof page.hasMore!=="boolean"||page.shopId!==shopId||
              page.generationId!==generationId||page.coverageRevision!==coverageRevision||typeof page.registryVersion!=="string"||!page.registryVersion||
              typeof page.filterFingerprint!=="string"||!page.filterFingerprint||!Array.isArray(page.definitionRevisions)||!page.filterAst) fail(C.CONTRACT_MISMATCH,"Selection page differs from its authorized publication");
            const current=JSON.stringify([page.registryVersion,page.definitionRevisions,page.filterFingerprint,page.filterAst]);
            if(pageIdentity!==undefined&&current!==pageIdentity) fail(C.CONTRACT_MISMATCH,"Selection authorization or filter changed between pages");
            pageIdentity=current;registry=page.registryVersion;definitions=page.definitionRevisions;fingerprint=page.filterFingerprint;authorizedFilter=page.filterAst;
            const cursorHash=typeof page.nextCursor==="string"?createHash("sha256").update(page.nextCursor).digest("hex"):null;
            if(page.hasMore&&(!page.productIds.length||typeof page.nextCursor!=="string"||!page.nextCursor||page.nextCursor.length>4096||cursors.has(cursorHash))||!page.hasMore&&page.nextCursor!=null) fail(C.CONTRACT_MISMATCH,"Selection pagination did not advance");
            const requested=page.productIds.map(identity);
            if(new Set(requested).size!==requested.length) fail(C.CONTRACT_MISMATCH,"Duplicate product across selection pages");
            await add(requested);
            cursor=page.hasMore?page.nextCursor:undefined;
            if(cursor)cursors.add(cursorHash);
          }while(cursor!==undefined);
        }
        if(exclusions.length) await tx.query(`DELETE FROM mirror.selection_items si USING mirror.products p
          WHERE si.shop_id=$1 AND si.snapshot_id=$2 AND p.shop_id=si.shop_id AND p.generation_id=si.generation_id AND p.id=si.product_id
          AND (si.product_id=ANY($3::bigint[]) OR p.shopify_id=ANY($4::text[]))`,[shopId,snapshotId,exclusions.filter(id=>!id.startsWith("gid://")),exclusions.filter(id=>id.startsWith("gid://"))]);
        // Hash canonical decimal IDs in numeric BigInt order, streamed from DB.
        const hash=createHash("sha256");let after="0",count=0;
        for(;;) {
          const rows=(await tx.query(`SELECT product_id FROM mirror.selection_items WHERE shop_id=$1 AND snapshot_id=$2
            AND product_id>$3::bigint ORDER BY product_id ASC LIMIT 1000`,[shopId,snapshotId,after])).rows;
          for(const row of rows){const id=String(row.product_id);hash.update(`${count++?",":""}${id}`);after=id;}
          if(rows.length<PAGE_SIZE)break;
        }
        const selectionHash=hash.digest("hex");
        const frozen=await tx.query(`UPDATE mirror.selection_snapshots SET status = 'APPROVED',frozen_at=$3,selected_count=$4,selection_hash=$5,
          filter_ast=$6,filter_fingerprint=$7,registry_version=$8,definition_revisions=$9 WHERE shop_id=$1 AND id=$2 AND status='DRAFT'`,
        [shopId,snapshotId,now,count,selectionHash,JSON.stringify(authorizedFilter),fingerprint,registry,JSON.stringify(definitions)]);
        if(frozen.rowCount!==1)fail(C.CONTRACT_MISMATCH,"Selection could not be frozen");
        await revalidate();
        const snapshot=selectionSnapshotRecord({id:snapshotId,shop_id:shopId,installation_version:published.installation_version,generation_id:generationId,
          coverage_revision:coverageRevision,mapping_version:mappingVersion,operation,operation_id:opId,target_mode:mode,
          status:'APPROVED',selected_count:count,selection_hash:selectionHash,frozen_at:now,expires_at:expiresAt,registry_version:registry,definition_revisions:definitions});
        const result=callback?await callback({client:tx,snapshot}):snapshot;
        await revalidate();
        if(!external)await tx.query("COMMIT");
        return result;
      }catch(error){if(!external)try{await tx.query("ROLLBACK");}catch{} logger.error?.({error},"Selection failed");throw error;}
      finally{if(!external)tx.release();}
    }
    return catalogQueryService.withSelectionSnapshot({authContext,shopId,filter:ast??identityFilter,signal},scope=>materialize(scope.client,scope.queryPage,true,{generationId:scope.generationId,coverageRevision:scope.coverageRevision}));
  }
  async function read({authContext,snapshotId,...unsupported}={},callback) {
    if(!authContext||Object.keys(unsupported).length)fail(C.PERMISSION_DENIED,"Authenticated selection read required; overrides are not accepted");
    if(typeof snapshotId!=="string"||!snapshotId||snapshotId.length>128)fail(C.INVALID_VALUE,"Bounded snapshot ID required");
    const shopId=await shop(authContext);
    return catalogQueryService.withSelectionSnapshot({authContext,shopId,filter:identityFilter},async scope=>{
      await scope.queryPage(undefined,{client:scope.client,generationId:scope.generationId,coverageRevision:scope.coverageRevision});
      const snapshot=(await scope.client.query(`SELECT s.* FROM mirror.selection_snapshots s JOIN mirror.shops sh ON sh.id=s.shop_id AND sh.installation_version=s.installation_version AND sh.uninstalled_at IS NULL WHERE s.shop_id=$1 AND s.id=$2`,[shopId,snapshotId])).rows[0];
      if(!snapshot)return callback(null,scope.client,shopId);
      if(snapshot.generation_id!==scope.generationId||snapshot.coverage_revision!==scope.coverageRevision||snapshot.status!=="APPROVED"||new Date(snapshot.expires_at)<=new Date())fail(C.EXECUTION_UNAVAILABLE,"Selection snapshot expired or publication changed");
      const result=await callback(snapshot,scope.client,shopId);
      if(await shop(authContext)!==shopId)fail(C.PERMISSION_DENIED,"Selection read identity changed");
      return result;
    });
  }
  return Object.freeze({
    createSelection:options=>create(options),
    withSelectionTransaction(options,callback){if(typeof callback!=="function")throw new TypeError("Selection transaction callback required");return create(options,callback);},
    getSelectionSnapshot:options=>read(options,snapshot=>selectionSnapshotRecord(snapshot)),
    async getSelectionItems({authContext,snapshotId,after="0",limit=100, ...unsupported}={}) {
      if(typeof snapshotId!=="string"||!snapshotId||!Number.isSafeInteger(limit)||limit<1||limit>1000||typeof after!=="string"||!/^\d{1,19}$/.test(after)||BigInt(after)>9223372036854775807n) fail(C.INVALID_VALUE,"Bounded membership page required");
      return read({authContext,snapshotId,...unsupported},async(snapshot,client,shopId)=>{
      const rows=snapshot?(await client.query(`SELECT product_id FROM mirror.selection_items WHERE shop_id=$1 AND snapshot_id=$2 AND product_id>$3::bigint ORDER BY product_id LIMIT $4`,[shopId,snapshotId,after,limit+1])).rows:[];
      const ids=rows.slice(0,limit).map(row=>String(row.product_id));
      return Object.freeze({productIds:Object.freeze(ids),hasMore:rows.length>limit,nextAfter:rows.length>limit?ids.at(-1):null});
      });
    },
  });
}
