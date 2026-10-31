import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createSyncRecoveryRepository } from "../sync-recovery-repository.server.js";
import { createSyncRunRepository } from "../sync-run-repository.server.js";
import { createSyncRunDbAdapter, verifySyncRunDbMapping } from "../sync-run-db-adapter.server.js";
import { CATALOG_EXECUTION_MAPPING, createCatalogEvidenceValidators, createCatalogSyncRunDbAdapter } from "../catalog-execution.server.js";
import { CATALOG_INPUT_HASH } from "../catalog-sync-steps.server.js";

export async function testSyncRecoveryRepository(t,{pool,fixture,service,runtime,state,makeDue,drain}) {
  const mapping=await verifySyncRunDbMapping({database:pool,mapping:CATALOG_EXECUTION_MAPPING});
  const core=createSyncRunRepository({db:createSyncRunDbAdapter({database:pool,mapping,...createCatalogEvidenceValidators()})});
  const approved=new Set();
  const key=c=>JSON.stringify([c.runId,c.shopId,c.generationId,c.phase,c.fence,c.leaseToken,c.recoveryAttempt,c.intent.id]);
  // Test-only read-only verification receipts, explicitly scoped to the claim.
  const settings={database:pool,syncRunRepository:core,inputHash:CATALOG_INPUT_HASH,
    verifyRecoveryEvidence:({claim,verification})=>verification.evidence.ticket==="fixture-approved"&&approved.has(key(claim))};
  const repo=createSyncRecoveryRepository(settings);
  const proof=(claim,kind="CONFIRMED")=>{approved.add(key(claim));return {kind,evidence:{ticket:"fixture-approved"}};};
  const park=id=>pool.query(`UPDATE mirror.catalog_import_executions SET review_required=true,lease_token=NULL,lease_until=NULL,worker_id=NULL,next_eligible_at=NULL WHERE id=$1`,[id]);
  async function seed(name,{start=true}={}) {
    const s=fixture(name),job=await service.enqueue(s.session);
    if(start)await runtime.processOne();
    await pool.query(`UPDATE mirror.catalog_import_executions SET outcome_uncertain=true,next_eligible_at=clock_timestamp() WHERE id=$1`,[job.id]);
    return {s,job};
  }
  async function ledger(s,job,{status="DISPATCHING",operationId=null,hash=CATALOG_INPUT_HASH}={}) {
    await pool.query(`INSERT INTO mirror.sync_external_operations(id,shop_id,run_id,generation_id,kind,input_hash,state,dispatch_fence,operation_id)
      VALUES($1,$2,$3,$4,'BULK_START',$5,$6,1,$7)`,[randomUUID(),s.session.shop,job.id,job.generationId,hash,status,operationId]);
  }
  function proxyPool(intercept) {
    return {query:pool.query.bind(pool),async connect(){const client=await pool.connect();return {
      query:(text,values)=>intercept(client,text,values),release:client.release.bind(client),
    };}};
  }

  await t.test("fenced recovery claims have one owner and increment only the recovery counter",async()=>{
    const {job}=await seed("recovery-repo-owner");const before=await state(job.id);
    const results=await Promise.all([repo.claimRecovery({runId:job.id}),repo.claimRecovery({runId:job.id})]);
    const claims=results.filter(Boolean);assert.equal(claims.length,1);const c=claims[0];
    assert.ok(Object.isFrozen(c));assert.ok(Object.isFrozen(c.intent));assert.equal(c.recoveryAttempt,1);
    assert.equal(c.fence,String(BigInt(before.fence)+1n));assert.equal((await state(job.id)).attempt,before.attempt);
    assert.equal((await repo.finishRecovery({claim:c,verification:proof(c)})).kind,"RESUMED");
    assert.ok((await drain(job.id)).completed_at);
  });

  await t.test("recovery mutations reject forged tenant, generation, phase, token, fence and attempt",async()=>{
    const {job}=await seed("recovery-repo-forged"),c=await repo.claimRecovery({runId:job.id});
    for(const change of [{shopId:"absent.myshopify.com"},{generationId:"other-generation"},{phase:"INGESTING"},
      {leaseToken:"other-token"},{fence:String(BigInt(c.fence)+1n)},{recoveryAttempt:2}]) {
      const forged={...c,...change,intent:{...c.intent,recoveryFence:change.fence??c.fence}};
      assert.equal((await repo.finishRecovery({claim:forged,verification:proof(forged)})).kind,"STALE_CLAIM");
      assert.equal((await repo.recordRecoveryFailure({claim:forged,reason:"VERIFICATION_FAILED"})).kind,"STALE_CLAIM");
    }
    assert.equal((await state(job.id)).lease_token,c.leaseToken);assert.equal((await state(job.id)).outcome_uncertain,true);
    await park(job.id);
  });

  await t.test("expired recovery owners cannot finish or penalize a newer recovery claim",async()=>{
    const {job}=await seed("recovery-repo-expired"),old=await repo.claimRecovery({runId:job.id});
    await pool.query("UPDATE mirror.catalog_import_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
    assert.equal((await repo.finishRecovery({claim:old,verification:proof(old)})).kind,"STALE_CLAIM");
    const next=await repo.claimRecovery({runId:job.id});assert.equal(next.recoveryAttempt,2);
    assert.equal((await repo.recordRecoveryFailure({claim:old,reason:"VERIFICATION_FAILED"})).kind,"STALE_CLAIM");
    assert.equal((await state(job.id)).lease_token,next.leaseToken);
    assert.equal((await repo.finishRecovery({claim:next,verification:proof(next)})).kind,"RESUMED");
    assert.ok((await drain(job.id)).completed_at);
  });

  await t.test("unissued receipts and dispatched starts without a response ID cannot clear uncertainty",async()=>{
    const known=await seed("recovery-repo-proof"),c=await repo.claimRecovery({runId:known.job.id});
    const result=await repo.finishRecovery({claim:c,verification:{kind:"CONFIRMED",evidence:{ticket:"unissued"}}});
    assert.equal(result.kind,"REVIEW_REQUIRED");assert.equal((await state(known.job.id)).outcome_uncertain,true);
    const unknown=await seed("recovery-repo-unbound",{start:false});await ledger(unknown.s,unknown.job);
    const unbound=await repo.claimRecovery({runId:unknown.job.id});
    assert.equal((await repo.finishRecovery({claim:unbound,verification:proof(unbound,"SAFE_TO_RETRY")})).kind,"REVIEW_REQUIRED");
    assert.equal((await state(unknown.job.id)).outcome_uncertain,true);assert.equal(unknown.s.starts,0);
    const changed=await seed("recovery-repo-hash",{start:false});await ledger(changed.s,changed.job,{status:"PREPARED",hash:"b".repeat(64)});
    const incompatible=await repo.claimRecovery({runId:changed.job.id});
    assert.equal((await repo.finishRecovery({claim:incompatible,verification:proof(incompatible,"SAFE_TO_RETRY")})).kind,"REVIEW_REQUIRED");
    assert.equal((await state(changed.job.id)).outcome_uncertain,true);assert.equal(changed.s.starts,0);
  });

  await t.test("a changed durable intent releases stale verification without adopting the new operation",async()=>{
    const {s,job}=await seed("recovery-repo-intent",{start:false}),c=await repo.claimRecovery({runId:job.id});
    await ledger(s,job,{status:"PREPARED"});
    assert.equal((await repo.finishRecovery({claim:c,verification:proof(c,"SAFE_TO_RETRY")})).kind,"STALE_CLAIM");
    const row=await state(job.id);assert.equal(row.outcome_uncertain,true);assert.equal(row.lease_token,null);
    assert.equal(row.last_error,"RECOVERY_INTENT_CHANGED");await park(job.id);
  });

  await t.test("prepared non-dispatch recovery preserves the intent and enables exactly one later start",async()=>{
    const {s,job}=await seed("recovery-repo-prepared",{start:false});await ledger(s,job,{status:"PREPARED"});
    const c=await repo.claimRecovery({runId:job.id});
    assert.equal((await repo.finishRecovery({claim:c,verification:proof(c,"SAFE_TO_RETRY")})).kind,"RESUMED");
    assert.equal((await pool.query("SELECT state FROM mirror.sync_external_operations WHERE run_id=$1",[job.id])).rows[0].state,"REJECTED");
    assert.ok((await drain(job.id)).completed_at);assert.equal(s.starts,1);
  });

  await t.test("lease expiry after uncertainty clearing rolls the entire recovery transaction back",async()=>{
    const {job}=await seed("recovery-repo-clock");let delayed=false;
    const database=proxyPool(async(client,text,values)=>{
      if(text.includes("worker_id=NULL,attempt=0,next_eligible_at")) {
        delayed=true;
        // Expire at the exact boundary under test instead of relying on schema
        // verification completing within an arbitrary 100ms wall-clock budget.
        await client.query("UPDATE mirror.catalog_import_executions SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[job.id]);
      }
      return client.query(text,values);
    });
    const timed=createSyncRecoveryRepository({...settings,database}),c=await timed.claimRecovery({runId:job.id});
    assert.equal((await timed.finishRecovery({claim:c,verification:proof(c)})).kind,"STALE_CLAIM");assert.equal(delayed,true);
    const row=await state(job.id);assert.equal(row.outcome_uncertain,true);assert.equal(row.lease_token,c.leaseToken);
    assert.equal((await pool.query("SELECT lease_token FROM mirror.ingestion_runs WHERE execution_id=$1 AND dataset='products'",[job.id])).rows[0].lease_token,null);
    await park(job.id);
  });

  await t.test("a lost recovery COMMIT acknowledgment stays uncertain and is not replayed",async()=>{
    const {job}=await seed("recovery-repo-commit"),c=await repo.claimRecovery({runId:job.id});let commits=0,writeSeen=false;
    const database=proxyPool(async(client,text,values)=>{
      if(text.includes("UPDATE mirror.catalog_import_executions e SET outcome_uncertain=false"))writeSeen=true;
      const result=await client.query(text,values);
      if(text==="COMMIT"&&writeSeen){commits++;throw Object.assign(new Error("Commit response lost"),{code:"ECONNRESET"});}
      return result;
    });
    const ambiguous=createSyncRecoveryRepository({...settings,database});
    await assert.rejects(()=>ambiguous.finishRecovery({claim:c,verification:proof(c)}),error=>error.outcomeUncertain===true);
    assert.equal(commits,1);assert.equal((await state(job.id)).outcome_uncertain,false);
    assert.equal((await repo.recordRecoveryFailure({claim:c,reason:"VERIFICATION_FAILED"})).kind,"STALE_CLAIM");
    assert.ok((await drain(job.id)).completed_at);
  });
  await t.test("recovery transactions revalidate physical schema before final writes",async()=>{
    const {job}=await seed("recovery-repo-schema"),c=await repo.claimRecovery({runId:job.id});
    await pool.query("ALTER TABLE mirror.catalog_import_executions RENAME COLUMN worker_id TO worker_drift");
    try {
      await assert.rejects(()=>repo.finishRecovery({claim:c,verification:proof(c)}),{code:"SYNC_SCHEMA_MISMATCH"});
      await assert.rejects(()=>repo.recordRecoveryFailure({claim:c,reason:"VERIFICATION_FAILED"}),{code:"SYNC_SCHEMA_MISMATCH"});
    } finally {await pool.query("ALTER TABLE mirror.catalog_import_executions RENAME COLUMN worker_drift TO worker_id");}
    assert.equal((await state(job.id)).outcome_uncertain,true);
    assert.equal((await repo.finishRecovery({claim:c,verification:proof(c)})).kind,"RESUMED");
    assert.ok((await drain(job.id)).completed_at);
  });
  await t.test("production adapter and recovery reject drift in exact tenant, SyncRun and checkpoint mappings",async()=>{
    const {job}=await seed('recovery-domain-schema'),c=await repo.claimRecovery({runId:job.id});
    const adapter=await createCatalogSyncRunDbAdapter({database:pool});
    for (const [table,column] of [['shops','installation_version'],['ingestion_runs','execution_id'],['ingestion_chunks','checksum']]) {
      await pool.query(`ALTER TABLE mirror.${table} RENAME COLUMN ${column} TO domain_drift`);
      try {
        await assert.rejects(()=>adapter.getRunState({runId:job.id,shopId:c.shopId}),{code:'SYNC_SCHEMA_MISMATCH'});
        await assert.rejects(()=>repo.finishRecovery({claim:c,verification:proof(c)}),{code:'SYNC_SCHEMA_MISMATCH'});
      } finally {await pool.query(`ALTER TABLE mirror.${table} RENAME COLUMN domain_drift TO ${column}`);}
    }
    await pool.query('ALTER TABLE mirror.ingestion_chunks DISABLE TRIGGER guard_ingestion_checkpoint');
    try {
      await assert.rejects(()=>adapter.getRunState({runId:job.id,shopId:c.shopId}),{code:'SYNC_SCHEMA_MISMATCH'});
      await assert.rejects(()=>repo.recordRecoveryFailure({claim:c,reason:'VERIFICATION_FAILED'}),{code:'SYNC_SCHEMA_MISMATCH'});
    } finally {await pool.query('ALTER TABLE mirror.ingestion_chunks ENABLE TRIGGER guard_ingestion_checkpoint');}
    assert.equal((await state(job.id)).outcome_uncertain,true);
    assert.equal((await repo.finishRecovery({claim:c,verification:proof(c)})).kind,'RESUMED');
    assert.ok((await drain(job.id)).completed_at);
  });
  await t.test("recovery refuses gaps and uncommitted line counts in the exact product SyncRun",async()=>{
    for (const [suffix,ordinal,processed] of [['gap',1,'1'],['count',0,'0']]) {
      const s=fixture(`recovery-checkpoint-${suffix}`),job=await service.enqueue(s.session);
      await runtime.processOne();await runtime.processOne();
      assert.equal((await state(job.id)).phase,'INGESTING');
      const ordinary=await core.claimRun({runId:job.id,workerId:'checkpoint-fixture',leaseSeconds:120});
      const run=(await pool.query('SELECT * FROM mirror.ingestion_runs WHERE execution_id=$1',[job.id])).rows[0];
      assert.equal(typeof run.id,'string'); // PostgreSQL bigint identity is never a phase-run string UUID.
      await pool.query(`INSERT INTO mirror.ingestion_chunks(shop_id,run_id,ordinal,checksum,line_count)
        VALUES($1,$2,$3,$4,1)`,[s.session.shop,run.id,ordinal,'a'.repeat(64)]);
      await pool.query('UPDATE mirror.ingestion_runs SET processed_lines=$2 WHERE id=$1',[run.id,processed]);
      await core.recordFailure({claim:ordinary,failure:{code:'INTERRUPTED',retryable:false,outcomeUncertain:true}});
      await makeDue(job.id);
      const c=await repo.claimRecovery({runId:job.id});
      assert.equal((await repo.finishRecovery({claim:c,verification:proof(c,'SAFE_TO_RETRY')})).kind,'REVIEW_REQUIRED');
      const row=await state(job.id);
      assert.equal(row.outcome_uncertain,true);assert.equal(row.last_error,'RECOVERY_CHECKPOINTS_INVALID');
    }
  });
  await t.test("cancellation and reinstallation immediately fence live recovery claims",async()=>{
    for(const action of ["cancel","reinstall"]) {
      const {s,job}=await seed(`recovery-repo-${action}`),c=await repo.claimRecovery({runId:job.id});
      if(action==="cancel")await service.cancel(s.session,job.id);
      else await pool.query("UPDATE mirror.shops SET installation_version='replacement' WHERE id=$1",[s.session.shop]);
      assert.equal((await repo.finishRecovery({claim:c,verification:proof(c)})).kind,"STALE_CLAIM");
      assert.equal((await repo.recordRecoveryFailure({claim:c,reason:"VERIFICATION_FAILED"})).kind,"STALE_CLAIM");
      assert.equal((await state(job.id)).outcome_uncertain,true);
      await runtime.processOne();assert.equal((await state(job.id)).cancel_requested,true);
    }
  });
}
