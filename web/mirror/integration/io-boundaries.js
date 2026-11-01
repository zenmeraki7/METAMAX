import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {mkdtemp,open,rename,readFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname,basename} from "node:path";
import {createFieldService} from "../../fields/resolve.js";
import {createInstalledFilterCompiler,verifyInstalledFilterSchema} from "../../services/filter-schema.server.js";
import {createCursorService} from "../../filters/pagination.js";
import {createSavedFiltersService} from "../../services/saved-filters.server.js";
import {createImportPreviewService} from "../../services/import-preview.server.js";
import {createApprovalService} from "../../services/approval.server.js";
import {createLegacyArtifactExportService,EXPORT_FIELD_IDS} from "../../services/export.server.js";
import {createFilterExecutor} from "../../filters/execute.js";
import {createCatalogQueryService} from "../../services/catalog-query.server.js";
import {createSelectionService} from "../../services/selection.server.js";
import {currentCoverageTransaction} from "../coverage-transaction.server.js";
import {createRestrictedRuntimeProfiles} from '../../security/test-support/restricted-runtime.js';
import {createDatabaseInstallationResolver} from '../../security/installation-lifecycle.server.js';
import {createJobDispatchService} from '../../services/job-dispatch.server.js';

export async function testIoBoundaries(t,{pool,shopId,generationId,authentication,authContext,session,repository,publication,coverage,allRows}) {
  const originalScope=session.scope;session.scope="read_products,write_products";session.merchantId="merchant-fixture";
  const root=await mkdtemp(join(tmpdir(),"metamax-io-test-"));
  const fieldService=createFieldService({resolveShop:authentication.resolveShop,verifyCoverage:coverage.getVerifiedCoverage,
    adapter:{resolveOne(){assert.fail("Dynamic field unexpectedly requested");},resolveBatch(){assert.fail("Dynamic fields unexpectedly requested");}},
    authorizeAccess:async({shopId:requested,authContext:context,access,operation,field})=>{
      const current=await authentication.resolveSession(context),scopes=new Set(current.scope.split(","));
      return current.shop===requested&&["filter","import","export"].includes(operation)&&
        (access==="write"?operation==="import"&&field.entity==="product"&&field.editable&&scopes.has("write_products"):scopes.has("read_products")||scopes.has("write_products"));
    }});
  const resolveDatasets=async({authContext:context})=>({executionContext:await repository.getPublishedContext({shopId:await authentication.resolveShop(context),client:currentCoverageTransaction()})});
  const {compiler}=await createInstalledFilterCompiler({database:pool,fieldService,cursorService:createCursorService({secret:Buffer.alloc(32,7)})});
  const executor=createFilterExecutor({database:pool,publicationService:publication,resolveShop:authentication.resolveShop,compiler});
  const catalogQueryService=createCatalogQueryService({compiler,executor,resolveShop:authentication.resolveShop,resolveDatasets});
  const selections=createSelectionService({database:pool,catalogQueryService,resolveShop:authentication.resolveShop,logger:{error(){}}});
  const resolveMerchantActor=async context=>{const current=await authentication.resolveSession(context);if(!current.merchantId)throw Error("Verified merchant actor missing");return {id:current.merchantId,shopId:current.shop};};
  const approval=createApprovalService({database:pool,resolveMerchantActor,logger:{error(){}},authorizeImportApproval:async({authContext:context,payload,snapshot})=>{
    await fieldService.requireFields({authContext:context,fieldIds:payload.fieldIds,access:"write",operation:"import",executionContext:{phase:"preview",operationId:snapshot.operation_id,
      generationId:snapshot.generation_id,coverageRevision:snapshot.coverage_revision,expectedRegistryVersion:payload.registryVersion}});
    return true;
  }});
  const imports=createImportPreviewService({database:pool,selectionService:selections,approvalService:approval,fieldService,
    resolveShop:authentication.resolveShop,resolveMerchantActor,resolveDatasets});
  try {
    await t.test("saved filter recipes require genuine semantics, current auth and explicitly authorized system contexts",async()=>{
      const service=createSavedFiltersService({database:pool,compiler,resolveShop:authentication.resolveShop,resolveDatasets});
      const ast={version:1,root:{kind:"condition",field:"product.vendor",operator:"eq",value:"Selected"}};
      await assert.rejects(()=>service.saveFilter({authContext,name:"Unknown field",ast:{...ast,root:{...ast.root,field:"product.not_a_field"}}}));
      let root=ast.root;for(let i=0;i<14;i++)root={kind:"group",operator:"AND",children:[root]};
      await assert.rejects(()=>service.saveFilter({authContext,name:"Too deep",ast:{version:1,root}}));
      const saved=await service.saveFilter({authContext,name:"Validated recipe",ast});
      assert.ok((await service.loadAndValidateFilter({authContext,filterId:saved.id})).validated);
      await assert.rejects(()=>service.loadAndValidateFilter({filterId:saved.id}));
      await assert.rejects(()=>service.saveFilter({authContext:{shop:shopId},name:"Forged",ast}));
      session.scope="";await assert.rejects(()=>service.loadAndValidateFilter({authContext,filterId:saved.id}));session.scope="read_products,write_products";
    });
    await t.test("import previews normalize writable values, reject bad identities and never approve during preparation",async()=>{
      const target=allRows[0].shopify_id;
      for(const edit of [{"variant.price":"-1"},{"variant.price":"NaN"},{"product.createdAt":"not-a-date"},{status:"UNSUPPORTED"},{title:"x".repeat(300)},{"product.id":"changed"}]){
        const report=await imports.validateImportRecords({authContext,records:[{id:target,...edit}]});assert.equal(report.invalidCount,1);
      }
      await assert.rejects(()=>imports.createImportPreview({authContext,records:[{title:"No identity"}]}));
      await assert.rejects(()=>imports.createImportPreview({authContext,records:[{id:target,title:"Prepared"}],approvedBy:"browser-actor"}));
      const preview=await imports.createImportPreview({authContext,records:[{id:target,title:"Prepared",tags:["one","two"]}]});
      assert.equal(preview.status,"DRAFT");
      const stored=await imports.getImportPreview({authContext,previewId:preview.previewId});
      assert.equal(stored.contract_id,null);assert.deepEqual(stored.payload.rows[0].fields,{"product.title":"Prepared","product.tags":["one","two"]});
      await assert.rejects(()=>imports.approveImportPreview({authContext,previewId:preview.previewId,expectedPreviewHash:"0".repeat(64)}));
      session.scope="read_products";await assert.rejects(()=>imports.approveImportPreview({authContext,previewId:preview.previewId,expectedPreviewHash:preview.previewHash}));session.scope="read_products,write_products";
      const approved=await imports.approveImportPreview({authContext,previewId:preview.previewId,expectedPreviewHash:preview.previewHash});
      assert.equal(approved.status,"APPROVED");
      assert.equal((await imports.approveImportPreview({authContext,previewId:preview.previewId,expectedPreviewHash:preview.previewHash})).contractId,approved.contractId);
      assert.equal((await pool.query("SELECT approved_by FROM mirror.execution_contracts WHERE shop_id=$1 AND id=$2",[shopId,approved.contractId])).rows[0].approved_by,"merchant-fixture");
      const bypass=createApprovalService({database:pool});
      await assert.rejects(()=>bypass.approveContract({shopId,snapshotId:preview.snapshotId,operation:"import",approvedBy:"forged",contractPayload:{rows:[]}}));
    });
    await t.test('approved import previews hand off exact row mappings to durable execution items',async()=>{
      const preview=await imports.createImportPreview({authContext,records:[{id:String(allRows[0].id),title:'First row'},{id:allRows[1].shopify_id,vendor:'Second row'}]});
      const approved=await imports.approveImportPreview({authContext,previewId:preview.previewId,expectedPreviewHash:preview.previewHash});
      const profiles=await createRestrictedRuntimeProfiles(pool,process.env.FILTER_TEST_DATABASE_URL);
      try{
        const dispatch=createJobDispatchService({database:profiles.merchant,approvalService:approval,resolveShop:authentication.resolveShop,
          resolveTenant:async context=>createDatabaseInstallationResolver({database:profiles.merchant})(await authentication.resolveShop(context)),
          authorizeWrite:async({authContext:context})=>(await authentication.resolveSession(context)).scope.split(',').includes('write_products')});
        const receipt=await dispatch.dispatchImport({authContext,contractId:approved.contractId});
        assert.equal(receipt.itemCount,2);
        const items=(await pool.query('SELECT resource_id,intended_values FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 ORDER BY resource_id',[shopId,receipt.commandId])).rows;
        const expected=[{resource_id:allRows[0].shopify_id,intended_values:{title:'First row'}},{resource_id:allRows[1].shopify_id,intended_values:{vendor:'Second row'}}].sort((a,b)=>a.resource_id.localeCompare(b.resource_id));
        assert.deepEqual(items,expected);
        assert.equal((await dispatch.dispatchImport({authContext,contractId:approved.contractId})).commandId,receipt.commandId);
      }finally{await profiles.close();}
    });
    await t.test("export pins a verified installation and approved membership, and registers only durable files",async()=>{
      const evidenceId=randomUUID();
      await pool.query("INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,status,generation_id) VALUES($1,$2,'selection-install','SUCCEEDED',$3)",[evidenceId,shopId,generationId]);
      const physicalSchema=await verifyInstalledFilterSchema({database:pool});
      const exports=createLegacyArtifactExportService({database:pool,resolveShop:authentication.resolveShop,publicationService:publication,publicationRepository:repository,
        approvalService:approval,fieldService,physicalSchema,authorizeExport:async({authContext:context})=>(await authentication.resolveSession(context)).scope.includes("read_products")});
      const prepare=async format=>{
        const snapshot=await selections.createSelection({authContext,productIds:allRows.slice(0,2).map(row=>row.id),operation:"export"});
        const contract=await approval.approveContract({shopId,snapshotId:snapshot.snapshotId,operation:"export",contractPayload:{format,fields:EXPORT_FIELD_IDS},approvedBy:"merchant-fixture"});
        const command=(await pool.query("INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,updated_at) VALUES($1,$2,$3,'export',now()) RETURNING id",[shopId,contract.contractId,randomUUID()])).rows[0].id;
        return {command,...await exports.createExportJob({authContext,commandId:command,format})};
      };
      let attempt=0;
      const writer=()=>{
        const prefix=join(root,String(++attempt)),temporary=`${prefix}.partial`,final=`${prefix}.complete`;let handle;
        return {final,async begin(){handle=await open(temporary,"wx");},async write(buffer){await handle.write(buffer);},async commit({objectKey}){
          await handle.sync();await handle.close();handle=null;await rename(temporary,final);
          const bytes=await readFile(final);return {durable:true,objectKey,byteLength:(await stat(final)).size,sha256:createHash("sha256").update(bytes).digest("hex")};
        },async abort(){if(handle){await handle.close();handle=null;}await rm(temporary,{force:true});await rm(final,{force:true});}};
      };
      const json=await prepare("jsonl");
      for(const format of ["xml","CSV",null,{}])await assert.rejects(()=>exports.createExportJob({authContext,commandId:json.command,format}));
      for(const retentionMs of [-1,0,59999,86400001,Infinity,NaN,"60000"])await assert.rejects(()=>exports.generateExportArtifact({authContext,exportJobId:json.exportJobId,writer:writer(),retentionMs}));
      await assert.rejects(()=>exports.generateExportArtifact({authContext,exportJobId:json.exportJobId,writer:writer(),chunkSize:1000000000}));
      await assert.rejects(()=>exports.generateExportArtifact({authContext,exportJobId:json.exportJobId}));
      await assert.rejects(()=>exports.createExportJob({authContext,commandId:json.command,generationId:"unverified"}));
      const file=writer(),write=file.write;let checkedLocks=false;
      file.write=async buffer=>{if(!checkedLocks){checkedLocks=true;const peer=await pool.connect();try{await peer.query("BEGIN");await peer.query("SET LOCAL lock_timeout='100ms'");await publication.lockForWrite(peer,shopId);}finally{await peer.query("ROLLBACK");peer.release();}}return write(buffer);};
      const artifact=await exports.generateExportArtifact({authContext,exportJobId:json.exportJobId,writer:file});
      assert.equal(artifact.rowCount,2);
      const lines=(await readFile(file.final,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
      assert.deepEqual(lines.map(row=>row.id),allRows.slice(0,2).map(row=>row.id));
      assert.ok(Object.hasOwn(lines[0],"published_at")&&Object.hasOwn(lines[0],"tags"));
      const csv=await prepare("csv"),csvFile=writer();
      await exports.generateExportArtifact({authContext,exportJobId:csv.exportJobId,writer:csvFile});
      const header=(await readFile(csvFile.final,"utf8")).split("\r\n")[0];assert.ok(header.includes('"published_at","tags"'));
      for(const limits of [{maxRows:1},{maxBytes:1}]){
        const limited=createLegacyArtifactExportService({database:pool,resolveShop:authentication.resolveShop,publicationService:publication,publicationRepository:repository,
          approvalService:approval,fieldService,physicalSchema,authorizeExport:async()=>true,...limits});
        const job=await prepare("jsonl"),file=writer();
        await assert.rejects(()=>limited.generateExportArtifact({authContext,exportJobId:job.exportJobId,writer:file}),/budget exceeded/);
        assert.equal((await pool.query("SELECT count(*) FROM mirror.job_artifacts WHERE shop_id=$1 AND command_id=$2",[shopId,job.command])).rows[0].count,"0");
        await assert.rejects(()=>stat(file.final),{code:"ENOENT"});
      }
      const failed=await prepare("jsonl"),failedWriter=writer();failedWriter.commit=async()=>{throw Error("upload completion failed");};
      await assert.rejects(()=>exports.generateExportArtifact({authContext,exportJobId:failed.exportJobId,writer:failedWriter}),/completion failed/);
      assert.equal((await pool.query("SELECT count(*) FROM mirror.job_artifacts WHERE shop_id=$1 AND command_id=$2",[shopId,failed.command])).rows[0].count,"0");
      const retry=(await pool.query("SELECT status,next_attempt_at FROM mirror.export_jobs WHERE shop_id=$1 AND id=$2",[shopId,failed.exportJobId])).rows[0];
      assert.equal(retry.status,"RETRY");assert.ok(new Date(retry.next_attempt_at)>new Date());
      await pool.query("UPDATE mirror.export_jobs SET next_attempt_at=now() WHERE shop_id=$1 AND id=$2",[shopId,failed.exportJobId]);
      const badReceipt=writer(),commit=badReceipt.commit;badReceipt.commit=async input=>({...await commit(input),durable:false});
      await assert.rejects(()=>exports.generateExportArtifact({authContext,exportJobId:failed.exportJobId,writer:badReceipt}),/completion could not be verified/);
      assert.equal((await pool.query("SELECT count(*) FROM mirror.job_artifacts WHERE shop_id=$1 AND command_id=$2",[shopId,failed.command])).rows[0].count,"0");
      await pool.query("DELETE FROM mirror.catalog_import_jobs WHERE shop_id=$1 AND id=$2",[shopId,evidenceId]);
      await assert.rejects(()=>prepare("jsonl"),/obsolete or unverified installation/);
      await pool.query("INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,status,generation_id) VALUES($1,$2,'selection-install','SUCCEEDED',$3)",[evidenceId,shopId,generationId]);
      const cancelled=await prepare("jsonl"),cancelWriter=writer(),originalWrite=cancelWriter.write;let cancelOnce=false;
      cancelWriter.write=async buffer=>{if(!cancelOnce){cancelOnce=true;assert.equal(await exports.cancelExportJob({authContext,exportJobId:cancelled.exportJobId}),true);}return originalWrite(buffer);};
      await assert.rejects(()=>exports.generateExportArtifact({authContext,exportJobId:cancelled.exportJobId,writer:cancelWriter}),/lease lost/);
      assert.equal((await pool.query("SELECT status FROM mirror.export_jobs WHERE shop_id=$1 AND id=$2",[shopId,cancelled.exportJobId])).rows[0].status,"CANCELLED");
      assert.equal((await pool.query("SELECT count(*) FROM mirror.job_artifacts WHERE shop_id=$1 AND command_id=$2",[shopId,cancelled.command])).rows[0].count,"0");
      const exhausted=await prepare("jsonl");
      await pool.query("UPDATE mirror.export_jobs SET status='WRITING',attempts=8,lease_token='crashed',lease_until=now()-interval '1 second' WHERE shop_id=$1 AND id=$2",[shopId,exhausted.exportJobId]);
      await assert.rejects(()=>exports.generateExportArtifact({authContext,exportJobId:exhausted.exportJobId,writer:writer()}),/exhausted/);
      assert.equal((await pool.query("SELECT status FROM mirror.export_jobs WHERE shop_id=$1 AND id=$2",[shopId,exhausted.exportJobId])).rows[0].status,"FAILED");
      const raced=await prepare("jsonl"),oldWriter=writer(),newWriter=writer(),keys=[];
      for(const candidate of [oldWriter,newWriter]){const begin=candidate.begin;candidate.begin=async input=>{keys.push(input.objectKey);return begin(input);};}
      const oldWrite=oldWriter.write;let tookOver=false,winner;
      oldWriter.write=async buffer=>{
        if(!tookOver){tookOver=true;await pool.query("UPDATE mirror.export_jobs SET lease_until=now()-interval '1 second' WHERE shop_id=$1 AND id=$2",[shopId,raced.exportJobId]);
          winner=await exports.generateExportArtifact({authContext,exportJobId:raced.exportJobId,writer:newWriter});}
        return oldWrite(buffer);
      };
      const replay=await exports.generateExportArtifact({authContext,exportJobId:raced.exportJobId,writer:oldWriter});
      assert.notEqual(keys[0],keys[1]);assert.equal(replay.objectKey,winner.objectKey);
      assert.ok((await stat(newWriter.final)).size>0);await assert.rejects(()=>stat(oldWriter.final),{code:"ENOENT"});
      assert.equal((await pool.query("SELECT count(*) FROM mirror.job_artifacts WHERE shop_id=$1 AND command_id=$2",[shopId,raced.command])).rows[0].count,"1");
      const uncertain=await prepare("jsonl"),uncertainWriter=writer();let aborted=false;
      const abort=uncertainWriter.abort;uncertainWriter.abort=async input=>{aborted=true;return abort(input);};
      const commitDb={query:(...args)=>pool.query(...args),async connect(){const client=await pool.connect();let final=false;
        return {release:()=>client.release(),async query(sql,...args){const result=await client.query(sql,...args);if(sql.includes("INSERT INTO mirror.job_artifacts"))final=true;
          if(sql==="COMMIT"&&final)throw Error("final COMMIT response lost");return result;}};}};
      const uncertainExports=createLegacyArtifactExportService({database:commitDb,resolveShop:authentication.resolveShop,publicationService:publication,publicationRepository:repository,
        approvalService:approval,fieldService,physicalSchema,authorizeExport:async()=>true});
      const committed=await uncertainExports.generateExportArtifact({authContext,exportJobId:uncertain.exportJobId,writer:uncertainWriter});
      assert.equal(committed.rowCount,2);assert.equal(aborted,false);assert.ok((await stat(uncertainWriter.final)).size>0);
      const revoked=await prepare("jsonl");session.scope="";
      await assert.rejects(()=>exports.generateExportArtifact({authContext,exportJobId:revoked.exportJobId,writer:writer()}));session.scope="read_products,write_products";
      await assert.rejects(()=>pool.query("UPDATE mirror.generations SET status='RETIRED' WHERE shop_id=$1 AND id=$2",[shopId,generationId]));
      await assert.rejects(()=>pool.query("UPDATE mirror.products SET title='Mutated' WHERE shop_id=$1 AND generation_id=$2",[shopId,generationId]));
    });
  } finally {
    session.scope=originalScope;delete session.merchantId;
    if(dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith("metamax-io-test-"))throw Error("Unsafe test cleanup path");
    await rm(root,{recursive:true,force:true});
  }
}
