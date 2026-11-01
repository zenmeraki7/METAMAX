/** Frozen selection projection; all columns come from this server registry.
 * Browser ASTs are revalidated through the real Field/Filter Engines. They are
 * never executed as raw SQL or used as identifiers by this projection reader.
 */
import {randomUUID} from "node:crypto";
import {createSelectionService} from "../services/selection.server.js";
import {assertVerifiedMirrorSqlSchema,assertPhysicalColumn} from "../services/mirror-schema.server.js";
import {withCoverageTransaction} from "../mirror/coverage-transaction.server.js";
import {transaction} from "../mirror/transactions.server.js";
import {isValidShopifySession} from "../middleware/session-validation.js";
import {assertInstallationTenant} from '../security/installation-lifecycle.server.js';
import {FIELD_SOURCES} from "../fields/sources.js";
import {EXPORT_ERROR_CODES as C,ExportContractError,canonicalizeJson} from "./export-contract.js";
const fail=(message,code=C.UNAUTHORIZED)=>{throw new ExportContractError(code,message);};
const COLUMNS=new Map([
  ["product.id",["shopify_id","text"]],["product.title",["title","text"]],["product.handle",["handle","text"]],
  ["product.status",["status","text"]],["product.vendor",["vendor","text"]],["product.productType",["product_type","text"]],
  ["product.createdAt",["created_at","timestamptz"]],["product.updatedAt",["updated_at","timestamptz"]],
  ["product.publishedAt",["published_at","timestamptz"]],["product.tags",["tags","text[]"]],
]);
const identityFilter={version:1,root:{kind:"condition",field:"product.id",operator:"is_not_null"}};

export function createExportCoverageRepository({database,repository}={}) {
  return Object.freeze({
    async getPublishedSnapshot({targetingSnapshotId,...input}) {
      if(targetingSnapshotId===undefined)return repository.getPublishedSnapshot(input);
      async function read(client) {
        const approval=(await client.query(`SELECT a.*,s.status FROM export_engine.target_approvals a
          JOIN mirror.selection_snapshots s ON s.shop_id=a.shop_id AND s.id=a.snapshot_id
          WHERE a.shop_id=$1 AND a.snapshot_id=$2 AND a.generation_id=$3 AND s.operation='export'
            AND s.status='APPROVED' AND s.frozen_at IS NOT NULL AND s.expires_at>clock_timestamp()
            AND a.coverage_revision=s.coverage_revision AND a.mapping_version=s.mapping_version
            AND a.generation_id=s.generation_id
            AND a.selection_hash=s.selection_hash`,[input.shopId,targetingSnapshotId,input.generationId])).rows[0];
        if(!approval||input.datasets.some(name=>!approval.datasets.includes(name)))fail("Stored export dataset approval unavailable",C.MISSING_COVERAGE);
        const snapshot=await repository.getPublishedSnapshot({...input,client});
        return snapshot&&{...snapshot,targetingSnapshot:{id:approval.snapshot_id,shopId:approval.shop_id,
          generationId:approval.generation_id,coverageRevision:approval.coverage_revision,status:approval.status,datasets:approval.datasets}};
      }
      return input.client?read(input.client):transaction(database,read, input.shopId);
    },
  });
}

export function createExportSource({database,runtime,publicationService,sessionStorage}={}) {
  for(const key of ["authentication","fieldService","compiler","physicalSchema","catalogQuery"])if(!runtime?.[key])throw new TypeError(`Verified export runtime.${key} required`);
  if(typeof database?.connect!=="function"||typeof sessionStorage?.findSessionsByShop!=="function")throw new TypeError("Database and trusted session storage required");
  assertVerifiedMirrorSqlSchema(runtime.physicalSchema);
  function columns(fieldIds) {
    return fieldIds.map(id=>{
      const binding=COLUMNS.get(id);if(!binding)fail("Export projection is not installed",C.INVALID_REQUEST);
      const registered=FIELD_SOURCES[id];
      if(registered?.entity!=="product"||registered.sql?.kind!=="column"||registered.sql.alias!=="p"||
        registered.sql.column!==binding[0]||registered.sql.storageType!==binding[1]||registered.sql.shopColumn!=="shop_id"||registered.sql.generationColumn!=="generation_id")
        fail("Export projection differs from trusted field registry",C.SCHEMA_DRIFT);
      assertPhysicalColumn(runtime.physicalSchema,"product",binding[0],binding[1]);
      return binding[0];
    });
  }
  const selection=createSelectionService({database,catalogQueryService:runtime.catalogQuery,resolveShop:runtime.authentication.resolveShop});
  async function resolveShop(authContext) {
    const shopId=await runtime.authentication.resolveShop(authContext);
    const tenant=assertInstallationTenant(await runtime.authentication.resolveTenant(authContext));
    if(tenant.shopId!==shopId)fail('Export installation authority differs');
    return {id:shopId,installationId:tenant.installationId};
  }
  async function offline(job) {
    const session=(await sessionStorage.findSessionsByShop(job.shop_id)).find(s=>s.isOnline===false&&s.shop===job.shop_id&&isValidShopifySession(s));
    if(!session)fail("Current offline export session required");
    const req={};runtime.authentication.capture(req,{locals:{shopify:{session}}},()=>{});
    const context=await runtime.authentication.authenticate(req);if(!context)fail("Export worker authentication unavailable");return context;
  }
  const api=Object.freeze({
    resolveShop,
    authorizeJob:options=>api.readPage({...options,authorizationOnly:true}),
    async authorizeDownload({authContext,job}) {
      const current=await resolveShop(authContext);
      if(current.id!==job.shopId||current.installationId!==job.installationId)fail("Export download installation differs");
      const client=await database.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
        await client.query("SET LOCAL statement_timeout='10000ms'");await client.query("SET LOCAL lock_timeout='2000ms'");
        await publicationService.lockForRead(client,current.id);
        const published=(await client.query(`SELECT generation_id,coverage_revision FROM mirror.publications WHERE shop_id=$1`,[current.id])).rows[0];
        if(!published)fail("Current export download authorization unavailable",C.MISSING_COVERAGE);
        columns(job.manifest.fields.map(field=>field.id));
        await withCoverageTransaction(client,async()=>{
          const resolution=await runtime.fieldService.requireFields({authContext,fieldIds:job.manifest.fields.map(field=>field.id),access:"read",operation:"export",
            executionContext:{phase:"preview",operationId:`download-${job.id}`,generationId:published.generation_id,coverageRevision:published.coverage_revision}});
          await runtime.fieldService.revalidateResolution(resolution,{authContext});
        });
        await client.query("COMMIT");return true;
      }catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
    },
    async resolveExecutionContext({authContext,request}) {
      columns(request.fieldIds);
      const installation=await resolveShop(authContext);
      const filter=request.filter??identityFilter,operationId=randomUUID();
      return selection.withSelectionTransaction({authContext,filter,mode:"ALL_MATCHING",operation:"export",operationId},async({client,snapshot})=>{
        const imported=(await client.query(`SELECT 1 FROM mirror.catalog_import_jobs WHERE shop_id=$1 AND generation_id=$2
          AND installation_version=$3 AND status='SUCCEEDED' LIMIT 1`,[snapshot.shopId,snapshot.generationId,installation.installationId])).rows[0];
        if(!imported)fail("Export generation was not imported for this installation",C.SNAPSHOT_EXPIRED);
        const context={phase:"preview",operationId,generationId:snapshot.generationId,coverageRevision:snapshot.coverageRevision};
        const preview=await withCoverageTransaction(client,()=>runtime.fieldService.requireFields({authContext,fieldIds:request.fieldIds,
          access:"read",operation:"export",executionContext:context}));
        const validated=await withCoverageTransaction(client,()=>runtime.compiler.validateFilter(filter,{authContext,operation:"export",executionContext:context}));
        const query=await withCoverageTransaction(client,()=>runtime.compiler.compileFilter(validated,{authContext,pageSize:1}));
        const datasets=[...new Set([...preview.datasets,...runtime.compiler.getExecutionPlan(query).datasets])].sort();
        await client.query(`INSERT INTO export_engine.target_approvals(shop_id,snapshot_id,generation_id,coverage_revision,mapping_version,selection_hash,datasets)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,[snapshot.shopId,snapshot.snapshotId,snapshot.generationId,snapshot.coverageRevision,snapshot.mappingVersion,snapshot.selectionHash,datasets]);
        return {phase:"execute",operationId,generationId:snapshot.generationId,coverageRevision:snapshot.coverageRevision,mappingVersion:snapshot.mappingVersion,
          approvedTargetingSnapshot:{snapshotId:snapshot.snapshotId,shopId:snapshot.shopId,generationId:snapshot.generationId,coverageRevision:snapshot.coverageRevision},
          selectionHash:snapshot.selectionHash,selectedCount:snapshot.selectedCount,datasets};
      });
    },
    async readPage({job,checkpoint={},signal,authorizationOnly=false,client:suppliedClient}) {
      signal?.throwIfAborted();const authContext=await offline(job),manifest=job.manifest;
      const approved=manifest.approvedTargetingSnapshot;
      if(!approved||approved.shopId!==job.shop_id||approved.generationId!==job.generation_id)fail("Immutable export target required");
      const after=checkpoint.afterProductId??"0";
      if(typeof after!=="string"||! /^(0|[1-9][0-9]{0,18})$/.test(after)||BigInt(after)>9223372036854775807n)fail("Invalid committed export cursor",C.CHECKPOINT_CONFLICT);
      const projection=columns(manifest.fields.map(f=>f.id));
      const executionContext={phase:"execute",operationId:manifest.operationId,generationId:job.generation_id,coverageRevision:job.coverage_revision,
        approvedTargetingSnapshot:approved,expectedRegistryVersion:manifest.registryVersion,expectedDefinitionRevisions:manifest.definitionRevisions};
      const client=suppliedClient??await database.connect();
      try {
        if(!suppliedClient)await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
        await client.query("SET LOCAL statement_timeout='10000ms'");await client.query("SET LOCAL lock_timeout='2000ms'");
        await publicationService.lockForRead(client,job.shop_id);
        const installed=await resolveShop(authContext);if(installed.id!==job.shop_id||installed.installationId!==job.installation_id)fail("Export installation changed");
        const target=(await client.query(`SELECT s.selection_hash,s.selected_count FROM mirror.selection_snapshots s
          JOIN export_engine.target_approvals a ON a.shop_id=s.shop_id AND a.snapshot_id=s.id
          WHERE s.shop_id=$1 AND s.id=$2 AND s.generation_id=$3 AND s.coverage_revision=$4 AND s.mapping_version=$5
            AND s.status='APPROVED' AND s.operation='export' AND s.operation_id=$6 AND s.expires_at>clock_timestamp()
            AND a.generation_id=s.generation_id AND a.coverage_revision=s.coverage_revision AND a.mapping_version=s.mapping_version
            AND a.selection_hash=s.selection_hash`,
          [job.shop_id,approved.snapshotId,job.generation_id,job.coverage_revision,job.mapping_version,manifest.operationId])).rows[0];
        if(!target||target.selection_hash!==manifest.selectionHash||String(target.selected_count)!==String(manifest.selectedCount))fail("Export selection changed or expired",C.SNAPSHOT_EXPIRED);
        await withCoverageTransaction(client,async()=>{
          const fields=await runtime.fieldService.requireFields({authContext,fieldIds:manifest.fields.map(f=>f.id),access:"read",operation:"export",executionContext});
          if(fields.mirrorSchemaVersion!==manifest.mirrorSchemaVersion||fields.sourceContractVersion!==manifest.sourceContractVersion)fail("Export physical schema changed",C.SCHEMA_DRIFT);
          const filterContext={...executionContext,expectedRegistryVersion:manifest.filterRegistryVersion,expectedDefinitionRevisions:manifest.filterDefinitionRevisions};
          const filter=await runtime.compiler.validateFilter(manifest.filterAst,{authContext,operation:"export",executionContext:filterContext});
          if(filter.fingerprint!==manifest.filterFingerprint)fail("Export filter contract changed",C.SCHEMA_DRIFT);
          const query=await runtime.compiler.compileFilter(filter,{authContext,pageSize:1});
          await runtime.compiler.authorizeExecution(query,authContext);
          await runtime.fieldService.revalidateResolution(fields,{authContext});
        });
        if(authorizationOnly){signal?.throwIfAborted();if(!suppliedClient)await client.query("COMMIT");return true;}
        const rows=(await client.query(`SELECT p.id,${projection.map(column=>`p."${column}"`).join(",")} FROM mirror.products p
          JOIN mirror.selection_items s ON s.shop_id=p.shop_id AND s.generation_id=p.generation_id AND s.product_id=p.id
          WHERE p.shop_id=$1 AND p.generation_id=$2 AND s.snapshot_id=$3 AND p.id>$4::bigint
          ORDER BY p.id LIMIT $5`,[job.shop_id,job.generation_id,approved.snapshotId,after,manifest.batchSize+1])).rows;
        const page=rows.slice(0,manifest.batchSize),hasMore=rows.length>manifest.batchSize;
        signal?.throwIfAborted();if(!suppliedClient)await client.query("COMMIT");
        return {rows:page.map(row=>projection.map(column=>row[column])),checkpoint:{afterProductId:page.length?String(page.at(-1).id):after,done:!hasMore}};
      }catch(error){if(!suppliedClient)try{await client.query("ROLLBACK");}catch{}throw error;}finally{if(!suppliedClient)client.release();}
    },
  });
  return api;
}
