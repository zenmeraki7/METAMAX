import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { createPublicationRepository } from "../publication-repository.server.js";
import { createMirrorPublicationService } from "../publication-service.server.js";
import { createMirrorCoverageService } from "../coverage.js";
import { currentCoverageTransaction } from "../coverage-transaction.server.js";
import { createFieldService } from "../../fields/resolve.js";
import { createFilterAuthentication } from "../../middleware/filter-auth.server.js";
import { createFieldAuthorizationService } from "../../services/field-authorization.server.js";
import { createInstalledFilterCompiler, getInstalledFilterSchemaOptions } from "../../services/filter-schema.server.js";
import { createCursorService } from "../../filters/pagination.js";
import { createFilterExecutor } from "../../filters/execute.js";
import { createCatalogQueryService } from "../../services/catalog-query.server.js";
import { createSelectionService } from "../../services/selection.server.js";
import { createApprovalService } from "../../services/approval.server.js";
import { createJobDispatchService } from "../../services/job-dispatch.server.js";
import { createSchedulesService } from "../../services/schedules.server.js";
import { createOperationOutboxDispatcher } from "../../workers/operation-outbox.server.js";
import {testIoBoundaries} from "./io-boundaries.js";

export async function testSelection(t, pool, { onlyDispatch = false } = {}) {
  const shopId = "selection-live.myshopify.com", generationId = "selection-live";
  const installed = getInstalledFilterSchemaOptions();
  const repository = createPublicationRepository({ database: pool });
  const publication = createMirrorPublicationService({ repository, barrierTable: { schema: "mirror", table: "publications" } });
  const writer = await pool.connect();
  try {
    await writer.query("BEGIN");
    await publication.lockForWrite(writer);
    await writer.query("INSERT INTO mirror.shops(id,installation_version) VALUES ($1,'selection-install')", [shopId]);
    await writer.query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
      VALUES ($1,$2,'selection-r1',$3,$4,'mapping_v1')`, [shopId,generationId,installed.mirrorSchemaVersion,installed.sourceContractVersion]);
    await writer.query(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,vendor,created_at,updated_at)
      SELECT $1,$2,'gid://shopify/Product/' || n,'Selection ' || n,'selection-' || n,'ACTIVE',
        CASE WHEN n <= 205 THEN 'Selected' ELSE 'Other' END,now(),now() FROM generate_series(1,208) n`, [shopId,generationId]);
    for (const [dataset,count] of [["products",208],["variants",0]]) {
      await writer.query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at)
        VALUES ($1,$2,$3,'SUCCEEDED',$4,$4,true,now())`, [shopId,generationId,dataset,count]);
      await writer.query(`INSERT INTO mirror.coverage(shop_id,generation_id,name,status,durable_rows,verified_at,verification_hash)
        VALUES ($1,$2,$3,'COMPLETE',$4,now(),'selection-verified')`, [shopId,generationId,dataset,count]);
    }
    for (const state of ["RECONCILING","VERIFIED","PUBLISHED"]) {
      await writer.query(`UPDATE mirror.generations SET status=$3::mirror."GenerationStatus",
        verified_at=CASE WHEN $3='VERIFIED' THEN now() ELSE verified_at END,
        published_at=CASE WHEN $3='PUBLISHED' THEN now() ELSE published_at END WHERE shop_id=$1 AND id=$2`, [shopId,generationId,state]);
    }
    await writer.query(`INSERT INTO mirror.publications(shop_id,generation_id,coverage_revision,mapping_version)
      VALUES ($1,$2,'selection-r1','mapping_v1')`, [shopId,generationId]);
    await writer.query("COMMIT");
  } finally { await writer.query("ROLLBACK"); writer.release(); }

  const session = { id: "selection-live-session", shop: shopId, scope: "read_products", accessToken: "fixture-token" };
  let active = true;
  const authentication = createFilterAuthentication({ sessionStorage: { loadSession: async () => active ? session : null } });
  const req = {};
  authentication.capture(req, { locals: { shopify: { session } } }, () => {});
  const authContext = await authentication.authenticate(req);
  const coverage = createMirrorCoverageService({ repository });
  const authorization = createFieldAuthorizationService({ database: pool, resolveShop: authentication.resolveShop,
    allowedOperations: ["filter"], getShopScopes: async (_shop, auth) => (await authentication.resolveSession(auth)).scope });
  const fieldService = createFieldService({ resolveShop: authentication.resolveShop, verifyCoverage: coverage.getVerifiedCoverage,
    authorizeAccess: authorization.authorizeAccess,
    adapter: { resolveOne() { assert.fail("Unexpected dynamic field"); }, resolveBatch() { assert.fail("Unexpected dynamic field"); } } });
  const { compiler } = await createInstalledFilterCompiler({ database: pool, fieldService, cursorService: createCursorService({ secret: randomBytes(32) }) });
  const executor = createFilterExecutor({ database: pool, publicationService: publication, resolveShop: authentication.resolveShop, compiler });
  const catalog = createCatalogQueryService({ compiler, executor, resolveShop: authentication.resolveShop,
    resolveDatasets: async () => {
      // Cursor verification remains the compiler's responsibility; the shared
      // transaction fixes this context for every page.
      return { executionContext: await repository.getPublishedContext({ shopId, client: currentCoverageTransaction() }) };
    } });
  const filter = { version: 1, root: { kind: "condition", field: "product.vendor", operator: "eq", value: "Selected" } };
  const allRows = (await pool.query("SELECT id,shopify_id FROM mirror.products WHERE shop_id=$1 ORDER BY id", [shopId])).rows;
  const internal = gid => allRows.find(row => row.shopify_id === `gid://shopify/Product/${gid}`).id;
  const select = (service, overrides = {}) => service.createSelection({ authContext, mode: "ALL_MATCHING", filter, ...overrides });
  const countSnapshots = async () => Number((await pool.query("SELECT count(*) FROM mirror.selection_snapshots WHERE shop_id=$1", [shopId])).rows[0].count);
  const wrap = hook => createSelectionService({ database: pool, resolveShop: authentication.resolveShop, logger: { error() {} }, catalogQueryService: {
    withSelectionSnapshot: (context, callback) => catalog.withSelectionSnapshot(context, async ({ client, generationId: pinnedGenerationId, coverageRevision: pinnedCoverageRevision, queryPage }) => {
      let page = 0;
      return callback({ client, generationId: pinnedGenerationId, coverageRevision: pinnedCoverageRevision, queryPage: async (cursor, pinned) => {
        const result = await queryPage(cursor, pinned);
        await hook({ page: ++page, client, result });
        return result;
      } });
    }),
  } });

  await t.test("explicit authentication and concurrent bulk dispatch preserve one approved operation in PostgreSQL", async () => {
    const selections = createSelectionService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop});
    await assert.rejects(() => selections.createSelection({productIds:[allRows[0].id]}));
    await assert.rejects(() => selections.createSelection({authContext,shopId:"other.myshopify.com",productIds:[allRows[0].id]}));
    const snapshot = await selections.createSelection({authContext,productIds:allRows.map(row=>row.id)});
    const approval = createApprovalService({database:pool});
    const approved = await approval.approveContract({shopId,snapshotId:snapshot.snapshotId,
      contractPayload:{updates:{title:"Approved title"}},approvedBy:"selection-fixture"});
    const dispatch = createJobDispatchService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop,
      approvalService:approval,authorizeWrite:async () => true});
    const results = await Promise.all(Array.from({length:4},()=>dispatch.dispatchBulkEdit({authContext,contractId:approved.contractId})));
    assert.equal(new Set(results.map(result=>result.commandId)).size,1);
    const commandId=results[0].commandId;
    assert.equal((await pool.query("SELECT count(*) FROM mirror.job_commands WHERE shop_id=$1 AND contract_id=$2",[shopId,approved.contractId])).rows[0].count,"1");
    const items=await pool.query("SELECT intended_values FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2",[shopId,commandId]);
    assert.equal(items.rows.length,allRows.length);
    for(const item of items.rows) assert.deepEqual(item.intended_values,{title:"Approved title"});
    assert.equal((await pool.query("SELECT count(*) FROM mirror.outbox_events WHERE shop_id=$1 AND command_id=$2",[shopId,commandId])).rows[0].count,"1");
    await assert.rejects(()=>pool.query(`INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,updated_at)
      VALUES($1,$2,'changed-client-key','bulk_edit',now())`,[shopId,approved.contractId]),{code:"23505"});

    // Capture confirmed before-state, then approve a separate undo occurrence.
    await pool.query(`INSERT INTO mirror.product_snapshots(shop_id,edit_item_id,before_values,before_hash)
      SELECT shop_id,id,'{"title":"Before","targetTitle":"Display only"}'::jsonb,$3 FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2`,[shopId,commandId,"a".repeat(64)]);
    await pool.query("UPDATE mirror.job_items SET status='SUCCEEDED' WHERE shop_id=$1 AND command_id=$2",[shopId,commandId]);
    await pool.query(`UPDATE mirror.product_snapshots SET after_hash=$3,confirmed_at=now()
      WHERE shop_id=$1 AND edit_item_id IN(SELECT id FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2)`,[shopId,commandId,"b".repeat(64)]);
    const undoSnapshot=await selections.createSelection({authContext,productIds:allRows.map(row=>row.id),operation:"undo"});
    const undoApproval=await approval.approveContract({shopId,snapshotId:undoSnapshot.snapshotId,operation:"undo",
      contractPayload:{sourceCommandId:commandId,fields:["title"]},approvedBy:"selection-fixture"});
    const undos=await Promise.all(Array.from({length:4},()=>dispatch.dispatchUndo({authContext,contractId:undoApproval.contractId,sourceCommandId:commandId})));
    assert.equal(new Set(undos.map(result=>result.restoreCommandId)).size,1);
    const restores=await pool.query("SELECT intended_values,restore_snapshot_id FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2",[shopId,undos[0].restoreCommandId]);
    assert.equal(restores.rows.length,allRows.length);
    for(const item of restores.rows){assert.deepEqual(item.intended_values,{title:"Before"});assert.ok(item.restore_snapshot_id);}
  });
  if (onlyDispatch) return;
  await testIoBoundaries(t,{pool,shopId,generationId,authentication,authContext,session,repository,publication,coverage,allRows});

  await t.test("scheduled all-matching occurrences checkpoint one protected phase at a time and publish after commit", async () => {
    const selections=createSelectionService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop});
    const approval=createApprovalService({database:pool});
    let queueCalls=0;
    const dispatch=createJobDispatchService({database:pool,approvalService:approval,resolveShop:authentication.resolveShop,
      authorizeWrite:async()=>true,queue:{async add(){queueCalls++;}}});
    const schedules=createSchedulesService({database:pool,selectionService:selections,approvalService:approval,jobDispatchService:dispatch,
      resolveShop:authentication.resolveShop,getScheduleAuthContext:async()=>authContext,logger:{error(){}}});
    const now=new Date();
    const schedule=await schedules.createSchedule({authContext,firstRunAt:now,template:{filter,contractPayload:{updates:{title:"Scheduled"},nested:{z:2,a:{y:1,b:0}}}}});
    const occurrences=await schedules.triggerDueSchedules({now});
    assert.equal(occurrences.length,1);
    const occurrenceId=occurrences[0].id;
    assert.equal((await schedules.triggerDueSchedules({now})).length,0);
    assert.equal((await pool.query("SELECT count(*) FROM mirror.job_commands c JOIN mirror.schedule_occurrences o ON o.shop_id=c.shop_id AND o.contract_id=c.contract_id WHERE o.id=$1",[occurrenceId])).rows[0].count,"0");
    for(const phase of ["SELECT","APPROVE","DISPATCH"]){
      const step=await schedules.processNextOccurrence();assert.equal(step.kind,"ADVANCED");assert.equal(step.phase,phase);
    }
    const occurrence=(await pool.query("SELECT * FROM mirror.schedule_occurrences WHERE id=$1",[occurrenceId])).rows[0];
    assert.equal(occurrence.status,"SUCCEEDED");assert.equal(occurrence.phase,"DONE");assert.equal(queueCalls,0);
    const contract=await approval.getApprovedContract({shopId,contractId:occurrence.contract_id});
    assert.equal(contract.hash_version,"canonical-v2");
    assert.equal(typeof contract.canonical_contract,"string");
    assert.equal((await pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema='mirror' AND table_name='execution_contracts' AND column_name='contract'")).rows[0].data_type,"jsonb");
    const command=(await pool.query("SELECT count(*) FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2",[shopId,occurrence.command_id])).rows[0];
    assert.equal(command.count,"205");
    await pool.query("UPDATE mirror.outbox_events SET dispatched_at=now() WHERE shop_id=$1 AND command_id<>$2",[shopId,occurrence.command_id]);
    const outbox=createOperationOutboxDispatcher({database:pool,queue:{async add(_name,data){assert.equal(data.commandId,occurrence.command_id);queueCalls++;}}});
    assert.equal((await outbox.dispatchNext()).kind,"DISPATCHED");assert.equal(queueCalls,1);
    assert.equal((await outbox.dispatchNext()).kind,"EMPTY");
    await pool.query("UPDATE mirror.job_schedules SET enabled=false WHERE shop_id=$1 AND id=$2",[shopId,schedule.id]);
  });

  await t.test("occurrence retries, expired leases and lost COMMIT responses resume the same checkpoints",async()=>{
    const selections=createSelectionService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop});
    const approval=createApprovalService({database:pool});
    const dispatch=createJobDispatchService({database:pool,approvalService:approval,resolveShop:authentication.resolveShop,authorizeWrite:async()=>true});
    let deny=true,loseCommit=false;
    const db={query:(...args)=>pool.query(...args),async connect(){const client=await pool.connect();return {release:()=>client.release(),async query(sql,...args){
      const result=await client.query(sql,...args);if(sql==="COMMIT"&&loseCommit){loseCommit=false;throw new Error("COMMIT response lost");}return result;
    }};}};
    const schedules=createSchedulesService({database:db,resolveShop:authentication.resolveShop,selectionService:selections,approvalService:approval,jobDispatchService:dispatch,
      getScheduleAuthContext:async()=>{if(deny)throw new Error("credentials temporarily unavailable");return authContext;},logger:{error(){}}});
    const now=new Date(),schedule=await schedules.createSchedule({authContext,firstRunAt:now,template:{filter,contractPayload:{updates:{title:"Retry"}}}});
    const occurrence=(await schedules.triggerDueSchedules({now}))[0];
    assert.equal((await schedules.processNextOccurrence()).kind,"RETRY");
    const retry=(await pool.query("SELECT * FROM mirror.schedule_occurrences WHERE id=$1",[occurrence.id])).rows[0];
    assert.equal(retry.status,"RETRY");assert.ok(new Date(retry.next_attempt_at)>new Date());
    assert.equal((await schedules.processNextOccurrence()).kind,"EMPTY");
    deny=false;
    await pool.query("UPDATE mirror.schedule_occurrences SET status='RUNNING',lease_token='dead-worker',lease_until=now()-interval '1 second' WHERE id=$1",[occurrence.id]);
    assert.equal((await schedules.processNextOccurrence()).phase,"SELECT");
    const selected=(await pool.query("SELECT * FROM mirror.schedule_occurrences WHERE id=$1",[occurrence.id])).rows[0];
    assert.ok(BigInt(selected.fence)>BigInt(retry.fence));assert.ok(selected.snapshot_id);
    loseCommit=true;
    assert.equal((await schedules.processNextOccurrence()).kind,"SUPERSEDED");
    const approved=(await pool.query("SELECT * FROM mirror.schedule_occurrences WHERE id=$1",[occurrence.id])).rows[0];
    assert.equal(approved.phase,"DISPATCH");assert.ok(approved.contract_id);assert.equal(approved.snapshot_id,selected.snapshot_id);
    loseCommit=true;
    assert.equal((await schedules.processNextOccurrence()).kind,"SUPERSEDED");
    const done=(await pool.query("SELECT * FROM mirror.schedule_occurrences WHERE id=$1",[occurrence.id])).rows[0];
    assert.equal(done.status,"SUCCEEDED");assert.equal(done.contract_id,approved.contract_id);
    assert.equal((await pool.query("SELECT count(*) FROM mirror.job_commands WHERE shop_id=$1 AND contract_id=$2",[shopId,done.contract_id])).rows[0].count,"1");
    await pool.query("UPDATE mirror.job_schedules SET enabled=false WHERE id=$1",[schedule.id]);
  });

  await t.test("cancelling during selection fences its checkpoint and rolls back the entire protected snapshot",async()=>{
    const selections=createSelectionService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop});
    const approval=createApprovalService({database:pool});
    const dispatch=createJobDispatchService({database:pool,approvalService:approval,resolveShop:authentication.resolveShop,authorizeWrite:async()=>true});
    let occurrenceId;
    const schedules=createSchedulesService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop,approvalService:approval,jobDispatchService:dispatch,
      getScheduleAuthContext:async()=>authContext,logger:{error(){}},selectionService:{...selections,
        withSelectionTransaction:(options,callback)=>selections.withSelectionTransaction(options,async scope=>{
          // Discovery holds no schedule-row locks while selection runs.
          const competing=await pool.connect();
          try{await competing.query("BEGIN");await competing.query("SET LOCAL lock_timeout='100ms'");
            await competing.query("UPDATE mirror.job_schedules SET enabled=enabled WHERE shop_id=$1",[shopId]);
          }finally{await competing.query("ROLLBACK");competing.release();}
          assert.equal((await schedules.processNextOccurrence()).kind,"EMPTY");
          assert.equal(await schedules.cancelOccurrence({authContext,occurrenceId}),true);
          return callback(scope);
        })}});
    const now=new Date(),schedule=await schedules.createSchedule({authContext,firstRunAt:now,template:{filter,contractPayload:{updates:{title:"Cancelled"}}}});
    occurrenceId=(await schedules.triggerDueSchedules({now}))[0].id;
    const before=await countSnapshots();
    assert.equal((await schedules.processNextOccurrence()).kind,"SUPERSEDED");
    assert.equal(await countSnapshots(),before);
    const cancelled=(await pool.query("SELECT * FROM mirror.schedule_occurrences WHERE id=$1",[occurrenceId])).rows[0];
    assert.equal(cancelled.status,"CANCELLED");assert.equal(cancelled.snapshot_id,null);
    await pool.query("UPDATE mirror.job_schedules SET enabled=false WHERE id=$1",[schedule.id]);
  });

  await t.test("outbox publication sees only committed commands, and uncertain queue responses retry the same identity",async()=>{
    await pool.query("UPDATE mirror.outbox_events SET dispatched_at=now() WHERE shop_id=$1 AND dispatched_at IS NULL",[shopId]);
    const selections=createSelectionService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop});
    const snapshot=await selections.createSelection({authContext,productIds:[allRows[0].id]});
    const approval=createApprovalService({database:pool});
    const approved=await approval.approveContract({shopId,snapshotId:snapshot.snapshotId,contractPayload:{updates:{title:"Outbox"}},approvedBy:"merchant"});
    const dispatch=createJobDispatchService({database:pool,approvalService:approval,resolveShop:authentication.resolveShop,authorizeWrite:async()=>true,
      queue:{async add(){assert.fail("Dispatch cannot publish directly");}}});
    const jobs=[];let uncertain=true;
    const outbox=createOperationOutboxDispatcher({database:pool,queue:{async add(_kind,data,options){jobs.push({data,options});if(uncertain)throw new Error("queue response lost");}}});
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      await dispatch.dispatchBulkEdit({client,authContext,contractId:approved.contractId});
      assert.equal((await outbox.dispatchNext()).kind,"EMPTY");assert.equal(jobs.length,0);
      await client.query("ROLLBACK");
      assert.equal((await outbox.dispatchNext()).kind,"EMPTY");
      await client.query("BEGIN");
      await dispatch.dispatchBulkEdit({client,authContext,contractId:approved.contractId});
      await client.query("COMMIT");
    }finally{await client.query("ROLLBACK");client.release();}
    assert.equal((await outbox.dispatchNext()).kind,"RETRY");
    uncertain=false;
    await pool.query("UPDATE mirror.outbox_events SET available_at=now() WHERE shop_id=$1 AND dispatched_at IS NULL",[shopId]);
    assert.equal((await outbox.dispatchNext()).kind,"DISPATCHED");assert.equal(jobs.length,2);
    assert.equal(jobs[0].options.jobId,jobs[1].options.jobId);
    assert.equal((await pool.query("SELECT status FROM mirror.job_commands WHERE shop_id=$1 AND id=$2",[shopId,jobs[0].data.commandId])).rows[0].status,"PENDING");
  });

  await t.test("exhausted occurrence leases fail durably and foreign shops cannot cancel them",async()=>{
    const schedules=createSchedulesService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop,getScheduleAuthContext:async()=>authContext,
      selectionService:{withSelectionTransaction(){assert.fail("Exhausted occurrence executed");}},
      approvalService:{approveContract(){assert.fail();}},jobDispatchService:{dispatchBulkEdit(){assert.fail();}}});
    const now=new Date();
    const schedule=await schedules.createSchedule({authContext,firstRunAt:now,template:{filter,contractPayload:{updates:{title:"Exhausted"}}}});
    const occurrence=(await schedules.triggerDueSchedules({now}))[0];
    await pool.query("UPDATE mirror.schedule_occurrences SET status='RUNNING',attempts=8,lease_token='crashed',lease_until=now()-interval '1 second' WHERE id=$1",[occurrence.id]);
    assert.equal((await schedules.processNextOccurrence()).kind,"EMPTY");
    assert.equal((await pool.query("SELECT status FROM mirror.schedule_occurrences WHERE id=$1",[occurrence.id])).rows[0].status,"FAILED");
    const foreign=createSchedulesService({database:pool,resolveShop:async()=>"other.myshopify.com"});
    assert.equal(await foreign.cancelOccurrence({authContext:{},occurrenceId:occurrence.id}),false);
    assert.equal(await schedules.cancelOccurrence({authContext,occurrenceId:occurrence.id}),true);
    await pool.query("UPDATE mirror.job_schedules SET enabled=false WHERE id=$1",[schedule.id]);
  });

  await t.test("freezing all-matching schedule targets uses the protected creation transaction",async()=>{
    const selections=createSelectionService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop});
    const schedules=createSchedulesService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop,selectionService:selections});
    const schedule=await schedules.createSchedule({authContext,freezeTargetsOnCreation:true,enabled:false,
      template:{filter,contractPayload:{updates:{title:"Frozen"}}}});
    const stored=(await pool.query("SELECT template FROM mirror.job_schedules WHERE shop_id=$1 AND id=$2",[shopId,schedule.id])).rows[0];
    const snapshot=await selections.getSelectionSnapshot({authContext,snapshotId:stored.template.frozenSnapshotId});
    assert.equal(snapshot.status,"APPROVED");assert.equal(snapshot.selected_count,"205");
    const before=await countSnapshots();
    const denied=createSchedulesService({database:pool,catalogQueryService:catalog,resolveShop:authentication.resolveShop,selectionService:{
      withSelectionTransaction:(options,callback)=>selections.withSelectionTransaction(options,scope=>callback({...scope,client:{async query(){throw new Error("schedule write failed");}}}))}});
    await assert.rejects(()=>denied.createSchedule({authContext,freezeTargetsOnCreation:true,template:{filter,contractPayload:{updates:{title:"Failed"}}}}),/schedule write failed/);
    assert.equal(await countSnapshots(),before);
  });

  await t.test("real selection drains three pages, excludes IDs, and freezes exact membership with database triggers", async () => {
    let pages = 0;
    const service = wrap(async () => { pages++; });
    const result = await select(service, { mode: "ALL_MATCHING_WITH_EXCLUSIONS", excludedProductIds: [internal(2), "gid://shopify/Product/150", "gid://shopify/Product/205"] });
    assert.equal(pages, 3);
    const expected = allRows.slice(0,205).map(row => row.id).filter(id => ![internal(2),internal(150),internal(205)].includes(id)).sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    assert.equal(Object.hasOwn(result,"productIds"),false);
    assert.equal(result.selectedCount, 202);
    assert.equal(result.selectionHash, createHash("sha256").update(expected.join(",")).digest("hex"));
    const stored = await service.getSelectionSnapshot({ authContext, snapshotId: result.snapshotId });
    assert.equal(stored.status, "APPROVED");
    assert.equal(stored.generation_id, generationId);
    assert.equal(stored.coverage_revision, "selection-r1");
    assert.equal(stored.mapping_version, "mapping_v1");
    assert.equal(stored.selection_hash, result.selectionHash);
    const membership=await service.getSelectionItems({ authContext, snapshotId: result.snapshotId,limit:1000 });
    assert.deepEqual(membership.productIds,expected);
    await assert.rejects(() => pool.query(`INSERT INTO mirror.selection_items(shop_id,snapshot_id,generation_id,product_id)
      VALUES ($1,$2,$3,$4)`, [shopId,result.snapshotId,generationId,internal(208)]), { code: "23514" });
    await assert.rejects(() => pool.query("UPDATE mirror.selection_snapshots SET selection_hash='tampered' WHERE shop_id=$1 AND id=$2", [shopId,result.snapshotId]), { code: "23514" });
  });

  await t.test("selection blocks publication and mirror writers through the final membership freeze", async () => {
    const service = wrap(async ({ page }) => {
      if (page !== 1) return;
      const competing = await pool.connect();
      try {
        await competing.query("BEGIN");
        await competing.query("SET LOCAL lock_timeout = '100ms'");
        await assert.rejects(() => publication.lockForWrite(competing), { code: "55P03" });
      } finally { await competing.query("ROLLBACK"); competing.release(); }
    });
    assert.equal((await select(service)).selectedCount, 205);
  });

  await t.test("multi-page selection pins repeatable-read snapshot against concurrent product updates and publication changes", async () => {
    const expectedIds = allRows.slice(0, 205).map(row => row.id).sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0);
    const stagingGenId = "selection-staging";
    await pool.query(
      `INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
       VALUES ($1,$2,'selection-r2',$3,$4,'mapping_v1')`,
      [shopId, stagingGenId, installed.mirrorSchemaVersion, installed.sourceContractVersion],
    );
    const seenBackendPids = new Set();
    const seenSnapshots = new Set();
    let selecting = true; const service = wrap(async ({ page, client, result }) => { if (!selecting) return;
      assert.equal(result.generationId, generationId);
      assert.equal(result.coverageRevision, "selection-r1");
      const txInfo = (
        await client.query(
          "SELECT pg_backend_pid() AS pid, pg_current_snapshot()::text AS snap, current_setting('transaction_isolation') AS iso, (SELECT count(*)::int FROM mirror.products WHERE shop_id=$1 AND generation_id=$2) AS staging_count",
          [shopId, stagingGenId],
        )
      ).rows[0];
      assert.equal(txInfo.iso, "repeatable read");
      seenBackendPids.add(txInfo.pid);
      seenSnapshots.add(txInfo.snap);
      // Every page sees 0 rows in stagingGenId even after page 1 commits a concurrent product insert on pool.
      assert.equal(txInfo.staging_count, 0);
      if (page === 1) {
        await pool.query(
          `INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,vendor,created_at,updated_at)
           VALUES ($1,$2,'gid://shopify/Product/999999','Concurrent Staging Product','concurrent-staging','ACTIVE','Selected',now(),now())`,
          [shopId, stagingGenId],
        );
        const externalCount = (
          await pool.query(
            "SELECT count(*)::int AS c FROM mirror.products WHERE shop_id=$1 AND generation_id=$2",
            [shopId, stagingGenId],
          )
        ).rows[0].c;
        assert.equal(externalCount, 1);
      }
    });
    try {
      const snapshot = await select(service); selecting = false;
      assert.equal(seenBackendPids.size, 1);
      assert.equal(seenSnapshots.size, 1);
      assert.equal(snapshot.selectedCount, 205);
      assert.deepEqual((await service.getSelectionItems({authContext,snapshotId:snapshot.snapshotId,limit:1000})).productIds, expectedIds);
    } finally {
      await pool.query("UPDATE mirror.generations SET status='FAILED',retain_until=now()-interval '1 second' WHERE shop_id=$1 AND id=$2", [shopId, stagingGenId]);
      await pool.query("DELETE FROM mirror.products WHERE shop_id=$1 AND generation_id=$2", [shopId, stagingGenId]);
      await pool.query("DELETE FROM mirror.generations WHERE shop_id=$1 AND id=$2", [shopId, stagingGenId]);
    }
  });

  await t.test("revocation on a later page leaves no partial snapshot", async () => {
    const before = await countSnapshots();
    const service = wrap(async ({ page }) => { if (page === 1) active = false; });
    try { await assert.rejects(() => select(service), /session expired or revoked/); }
    finally { active = true; }
    assert.equal(await countSnapshots(), before);
  });

  await t.test("membership failure rolls back draft and all inserted membership", async () => {
    const before = await countSnapshots();
    const service = createSelectionService({ database: pool, resolveShop: authentication.resolveShop, logger: { error() {} }, catalogQueryService: {
      withSelectionSnapshot: (context, callback) => catalog.withSelectionSnapshot(context, ({ client, queryPage }) => callback({
        queryPage: (cursor,pinned) => queryPage(cursor,{...pinned,client}), client: { query: (sql, params) => sql.includes("INSERT INTO mirror.selection_items")
          ? client.query("SELECT 1/0") : client.query(sql, params) },
      })),
    } });
    await assert.rejects(() => select(service), { code: "22012" });
    assert.equal(await countSnapshots(), before);
  });

  await t.test("scope revocation after materialization rolls back the approved snapshot before commit", async () => {
    const before = await countSnapshots();
    const service = createSelectionService({ database: pool, resolveShop: authentication.resolveShop, catalogQueryService: {
      withSelectionSnapshot: (context, callback) => catalog.withSelectionSnapshot(context, async scope => {
        const result = await callback(scope);
        session.scope = "";
        return result;
      }),
    } });
    try { await assert.rejects(() => select(service)); }
    finally { session.scope = "read_products"; }
    assert.equal(await countSnapshots(), before);
  });

  await t.test("cross-shop and forged session contexts cannot create selections", async () => {
    const before = await countSnapshots();
    const service = createSelectionService({ database: pool, resolveShop: authentication.resolveShop, catalogQueryService: catalog });
    await assert.rejects(() => select(service, { shopId: "other.myshopify.com" }), /shopId is server-resolved/);
    await assert.rejects(() => select(service, { authContext: { shop: shopId } }), /Authenticated filter session/);
    assert.equal(await countSnapshots(), before);
  });
}
