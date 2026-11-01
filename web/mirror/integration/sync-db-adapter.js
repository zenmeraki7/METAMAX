import assert from "node:assert/strict";
import { createSyncRunDbAdapter, verifySyncRunDbMapping, runSyncDbTransaction, SyncOutcomeUnknownError } from "../sync-run-db-adapter.server.js";
import { createSyncRunRepository } from "../sync-run-repository.server.js";
import { createSyncRunService } from "../sync-run-service.server.js";
import { transaction } from "../transactions.server.js";

const phases = ["STARTING","WAITING","INGESTING","RECONCILING","PUBLISHING"];
const mappingSpec = {
  runs: { table:"sync_adapter_test.runs", columns:{id:"id",shopId:"shop_id",generationId:"generation_id",phase:"phase",attempt:"attempt",fence:"fence",
    leaseToken:"lease_token",leaseExpiresAt:"lease_expires_at",nextEligibleAt:"next_eligible_at",completedAt:"completed_at",reviewRequired:"review_required",
    outcomeUncertain:"outcome_uncertain",workerId:"worker_id",cancelRequested:"cancel_requested",lastError:"last_error",recoveryAttempts:"recovery_attempts"} },
  shops:{table:"mirror.shops",columns:{shopId:"id"}}, attemptLimit:12,
};

export async function testSyncDbAdapter(t, pool) {
  const shops=["adapter-a.myshopify.com","adapter-b.myshopify.com"];
  await pool.query(`CREATE SCHEMA sync_adapter_test;
    CREATE TABLE sync_adapter_test.runs (
      id text PRIMARY KEY,shop_id text NOT NULL REFERENCES mirror.shops(id),generation_id text NOT NULL,
      phase text NOT NULL DEFAULT 'STARTING' CHECK (phase IN ('STARTING','WAITING','INGESTING','RECONCILING','PUBLISHING')),
      attempt integer NOT NULL DEFAULT 0 CHECK (attempt>=0 AND attempt<=12),fence bigint NOT NULL DEFAULT 0 CHECK (fence>=0),
      recovery_attempts integer NOT NULL DEFAULT 0 CHECK (recovery_attempts>=0 AND recovery_attempts<=8),
      lease_token text,lease_expires_at timestamptz,next_eligible_at timestamptz,completed_at timestamptz,
      review_required boolean NOT NULL DEFAULT false,outcome_uncertain boolean NOT NULL DEFAULT false,worker_id text,
      cancel_requested boolean NOT NULL DEFAULT false,last_error text,
      FOREIGN KEY(shop_id,generation_id) REFERENCES mirror.generations(shop_id,id));
    CREATE INDEX adapter_shop_lease ON sync_adapter_test.runs(shop_id,lease_expires_at);
    CREATE INDEX adapter_due ON sync_adapter_test.runs(next_eligible_at,id);
    CREATE TABLE sync_adapter_test.evidence(run_id text NOT NULL REFERENCES sync_adapter_test.runs(id),shop_id text NOT NULL,generation_id text NOT NULL,
      phase text NOT NULL,fence bigint NOT NULL,confirmed boolean NOT NULL DEFAULT true,PRIMARY KEY(run_id,phase,fence));
    CREATE TABLE sync_adapter_test.conflicts(id integer PRIMARY KEY,value integer NOT NULL);
    INSERT INTO sync_adapter_test.conflicts VALUES (1,0)`);
  for(const shopId of shops) {
    await pool.query("INSERT INTO mirror.shops(id,installation_version) VALUES ($1,'adapter-install')",[shopId]);
    await pool.query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
      VALUES ($1,'adapter-generation','adapter-coverage','metamax_mirror_v1','metamax_sources_v1','mapping_v1')`,[shopId]);
  }
  let mapping=await verifySyncRunDbMapping({database:pool,mapping:mappingSpec});
  const verifyShop=async({tx,shopId})=>(await tx.$queryRawUnsafe("SELECT 1 FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL",shopId)).length===1;
  const evidence=async(tx,run)=>(await tx.$queryRawUnsafe(`SELECT 1 FROM sync_adapter_test.evidence WHERE run_id=$1 AND shop_id=$2 AND generation_id=$3 AND phase=$4 AND fence=$5::bigint AND confirmed`,
    run.id,run.shopId,run.generationId,run.phase,run.fence)).length===1;
  const verifyStepEvidence=async({tx,run})=>{
    if(!await evidence(tx,run))return false;
    if(run.phase!=="INGESTING")return true;
    const rows=await tx.$queryRawUnsafe(`SELECT 1 FROM mirror.ingestion_runs r WHERE r.shop_id=$1 AND r.generation_id=$2 AND r.dataset='products'
      AND r.status='SUCCEEDED' AND r.eof_verified AND r.writes_finished_at IS NOT NULL AND r.invalid_lines=0
      AND r.bulk_operation_id IS NOT NULL AND r.processed_lines=r.expected_lines
      AND r.processed_lines=(SELECT COALESCE(sum(c.line_count),0) FROM mirror.ingestion_chunks c WHERE c.shop_id=r.shop_id AND c.run_id=r.id)
      AND r.processed_lines=(SELECT count(*) FROM mirror.products p WHERE p.shop_id=r.shop_id AND p.generation_id=r.generation_id)
        +(SELECT count(*) FROM mirror.variants v WHERE v.shop_id=r.shop_id AND v.generation_id=r.generation_id)
      AND (SELECT COALESCE(max(c.ordinal),-1) FROM mirror.ingestion_chunks c WHERE c.shop_id=r.shop_id AND c.run_id=r.id)
        =(SELECT count(*)-1 FROM mirror.ingestion_chunks c WHERE c.shop_id=r.shop_id AND c.run_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM mirror.generations g CROSS JOIN unnest(g.required_datasets) d(name)
        WHERE g.shop_id=r.shop_id AND g.id=r.generation_id AND NOT EXISTS(SELECT 1 FROM mirror.ingestion_runs required
          WHERE required.shop_id=g.shop_id AND required.generation_id=g.id AND required.dataset=d.name AND required.status='SUCCEEDED'
            AND required.eof_verified AND required.writes_finished_at IS NOT NULL AND required.invalid_lines=0 AND required.expected_lines=required.processed_lines))`,run.shopId,run.generationId);
    return rows.length===1;
  };
  const verifyPublished=async({tx,run})=>await evidence(tx,run) && (await tx.$queryRawUnsafe(`SELECT 1 FROM mirror.publications p
    JOIN mirror.generations g ON g.shop_id=p.shop_id AND g.id=p.generation_id AND g.coverage_revision=p.coverage_revision AND g.mapping_version=p.mapping_version
    WHERE p.shop_id=$1 AND p.generation_id=$2 AND g.status='PUBLISHED' AND g.coverage_revision='adapter-coverage'
      AND NOT EXISTS(SELECT 1 FROM unnest(g.required_datasets) d(name) WHERE NOT EXISTS(SELECT 1 FROM mirror.coverage c
        WHERE c.shop_id=g.shop_id AND c.generation_id=g.id AND c.name=d.name AND c.status='COMPLETE'))`,run.shopId,run.generationId)).length===1;
  let db,repo;
  function configure(){db=createSyncRunDbAdapter({database:pool,mapping,verifyShop,verifyStepEvidence,verifyPublished});repo=createSyncRunRepository({db});}
  configure();
  let ordinal=0;
  const seed=async(phase="STARTING",shopId=shops[0])=>{
    const id=`adapter-run-${++ordinal}`;
    await pool.query("INSERT INTO sync_adapter_test.runs(id,shop_id,generation_id,phase) VALUES ($1,$2,'adapter-generation',$3)",[id,shopId,phase]);return id;
  };
  const claim=runId=>repo.claimRun({runId,workerId:"adapter-worker",leaseSeconds:120});
  const expire=runId=>pool.query("UPDATE sync_adapter_test.runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[runId]);
  const grant=async c=>pool.query("INSERT INTO sync_adapter_test.evidence(run_id,shop_id,generation_id,phase,fence) VALUES ($1,$2,$3,$4,$5)",[c.runId,c.shopId,c.generationId,c.phase,c.fence]);
  const releaseAll=()=>pool.query("UPDATE sync_adapter_test.runs SET lease_token=NULL,lease_expires_at=NULL");

  await t.test("physical verification refuses fabricated mappings and incompatible deployed ingestion rows",async()=>{
    assert.throws(()=>createSyncRunDbAdapter({database:pool,mapping:{...mapping},verifyShop,verifyStepEvidence,verifyPublished}),/Genuine physically/);
    for(const table of ["mirror.ingestion_runs","mirror.catalog_import_jobs"]) {
      await assert.rejects(()=>verifySyncRunDbMapping({database:pool,mapping:{...mappingSpec,runs:{...mappingSpec.runs,table}}}),{code:"SYNC_SCHEMA_MISMATCH"});
    }
    await assert.rejects(()=>verifySyncRunDbMapping({database:pool,mapping:{...mappingSpec,runs:{...mappingSpec.runs,table:"x; DROP TABLE mirror.shops"}}}),{code:"SYNC_SCHEMA_MISMATCH"});
    assert.throws(()=>createSyncRunDbAdapter({database:{connect(){}},mapping,verifyShop,verifyStepEvidence,verifyPublished}),/another database/);
  });

  await t.test("physical verification rejects absent global uniqueness, unsafe counters, nullability and missing indexes",async()=>{
    const invalid = [
      {name:"nullable",alter:"ALTER TABLE sync_adapter_test.nullable ALTER COLUMN generation_id DROP NOT NULL"},
      {name:"bad_fence",alter:"ALTER TABLE sync_adapter_test.bad_fence ALTER COLUMN fence TYPE integer"},
      {name:"no_unique",bare:true,alter:"CREATE UNIQUE INDEX composite_only ON sync_adapter_test.no_unique(shop_id,id);CREATE INDEX bad_shop_lease ON sync_adapter_test.no_unique(shop_id,lease_expires_at);CREATE INDEX bad_due ON sync_adapter_test.no_unique(next_eligible_at)"},
    ];
    for(const value of invalid) {
      // Fixed test identifiers, never request-supplied names.
      await pool.query(`CREATE TABLE sync_adapter_test.${value.name} (LIKE sync_adapter_test.runs ${value.bare?"INCLUDING DEFAULTS INCLUDING CONSTRAINTS":"INCLUDING ALL"})`);
      await pool.query(value.alter);
      await assert.rejects(()=>verifySyncRunDbMapping({database:pool,mapping:{...mappingSpec,runs:{...mappingSpec.runs,table:`sync_adapter_test.${value.name}`}}}),{code:"SYNC_SCHEMA_MISMATCH"});
    }
    await pool.query("DROP INDEX sync_adapter_test.adapter_due");
    try{await assert.rejects(()=>verifySyncRunDbMapping({database:pool,mapping:mappingSpec}),/Dispatcher eligibility index/);}
    finally{await pool.query("CREATE INDEX adapter_due ON sync_adapter_test.runs(next_eligible_at,id)");}
    mapping=await verifySyncRunDbMapping({database:pool,mapping:mappingSpec});configure();
  });

  await t.test("real PostgreSQL claims, renewal, durable evidence and stale writes preserve exact owner and attempt",async()=>{
    const runId=await seed();const c=await claim(runId);assert.equal(c.attempt,1);assert.equal(c.fence,"1");
    assert.equal(await claim(runId),null);
    assert.equal((await repo.renewLease({claim:c,leaseSeconds:120})).kind,"RENEWED");
    await assert.rejects(()=>repo.recordStep({claim:c,result:{kind:"ADVANCE"}}),{code:"EVIDENCE_MISSING"});
    await grant(c);assert.equal((await repo.recordStep({claim:c,result:{kind:"ADVANCE"}})).kind,"RECORDED");
    const after=await db.getRunState({runId,shopId:c.shopId});assert.equal(after.phase,"WAITING");assert.equal(after.attempt,0);assert.equal(after.leaseToken,null);
    assert.equal((await repo.recordFailure({claim:c,failure:{code:"FAILED",retryable:true,outcomeUncertain:false,retryAfterMs:1000}})).kind,"STALE_CLAIM");
    assert.equal(await db.getRunState({runId,shopId:shops[1]}),null);
  });

  await t.test("duplicate delivery and another run in the same shop cannot create two live owners",async()=>{
    const first=await seed(),second=await seed();
    const claims=await Promise.all([claim(first),claim(first),claim(second)]);assert.equal(claims.filter(Boolean).length,1);
    await releaseAll();
    const a=await seed(),b=await seed("STARTING",shops[1]);
    assert.equal((await Promise.all([claim(a),claim(b)])).filter(Boolean).length,2);await releaseAll();
  });

  await t.test("expiry, newer fences and attempt mismatches cannot mutate a run even through direct adapter calls",async()=>{
    const runId=await seed();const old=await claim(runId);await expire(runId);
    assert.equal(await claim(runId),null);assert.equal((await repo.getRecoveryEligibility({runId})).eligible,true);
    // This fixture has performed no external work. Simulate its verified
    // safe-to-retry receipt before testing a newer ordinary claim.
    await pool.query("UPDATE sync_adapter_test.runs SET lease_token=NULL,lease_expires_at=NULL WHERE id=$1",[runId]);
    const latest=await claim(runId);
    assert.equal(latest.fence,"2");assert.equal((await repo.renewLease({claim:old,leaseSeconds:120})).kind,"STALE_CLAIM");
    for(const changed of [{...latest,attempt:1},{...latest,fence:old.fence},{...latest,phase:"WAITING"}]) {
      const result=await db.transaction(async tx=>{await tx.lockShop(latest.shopId);await tx.lockRun(runId);return tx.renewRun(runId,{claim:changed,leaseSeconds:120});});
      assert.equal(result,null);
    }
    await expire(runId);
    const expired=await db.transaction(async tx=>{await tx.lockShop(latest.shopId);await tx.lockRun(runId);return tx.commitStep(runId,{claim:latest,kind:"DEFER",delayMs:1000,expectedGenerationId:latest.generationId});});
    assert.equal(expired,null);await releaseAll();
  });

  await t.test("attempt ceiling, future eligibility, cancellation and uncertainty are enforced in SQL",async()=>{
    const runId=await seed();await pool.query("UPDATE sync_adapter_test.runs SET attempt=12 WHERE id=$1",[runId]);assert.equal(await claim(runId),null);
    const cId=await seed();await pool.query("UPDATE sync_adapter_test.runs SET cancel_requested=true WHERE id=$1",[cId]);assert.equal(await claim(cId),null);
    const future=await seed();const c=await claim(future);
    await repo.recordFailure({claim:c,failure:{code:"REMOTE_UNKNOWN",retryable:true,outcomeUncertain:true,retryAfterMs:1000}});
    await pool.query("UPDATE sync_adapter_test.runs SET next_eligible_at=now()-interval '1 second' WHERE id=$1",[future]);
    assert.equal(await claim(future),null);
    const row=await db.getRunState({runId:future,shopId:shops[0]});assert.equal(row.attempt,1);assert.equal(row.lastError,"REMOTE_UNKNOWN");assert.equal(row.outcomeUncertain,true);
    const deferred=await seed();const d=await claim(deferred);await repo.recordStep({claim:d,result:{kind:"DEFER",delayMs:1000}});assert.equal(await claim(deferred),null);
    await releaseAll();
  });

  await t.test("repository and SQL attempt budgets must agree and lower configured limits are enforced",async()=>{
    const limited=createSyncRunDbAdapter({database:pool,mapping,verifyShop,verifyStepEvidence,verifyPublished,maxAttempts:2});
    assert.throws(()=>createSyncRunRepository({db:limited}),/attempt budgets must match/);
    const repository=createSyncRunRepository({db:limited,maxAttempts:2});
    const runId=await seed();
    await pool.query("UPDATE sync_adapter_test.runs SET attempt=1,fence=1 WHERE id=$1",[runId]);
    const c=await repository.claimRun({runId,workerId:"worker",leaseSeconds:120});assert.equal(c.attempt,2);
    await repository.recordFailure({claim:c,failure:{code:"RETRYABLE",retryable:true,outcomeUncertain:false,retryAfterMs:1000}});
    assert.equal((await limited.getRunState({runId,shopId:c.shopId})).reviewRequired,true);
    assert.equal(await repository.claimRun({runId,workerId:"worker",leaseSeconds:120}),null);
  });

  await t.test("uncertainty on the final claim preserves recovery eligibility without scheduling ordinary retry",async()=>{
    await releaseAll();
    const limited=createSyncRunDbAdapter({database:pool,mapping,verifyShop,verifyStepEvidence,verifyPublished,maxAttempts:1});
    const repository=createSyncRunRepository({db:limited,maxAttempts:1});
    const runId=await seed();const c=await repository.claimRun({runId,workerId:"worker",leaseSeconds:120});
    const receipt=await repository.recordFailure({claim:c,failure:{code:"COMMIT_UNKNOWN",retryable:true,outcomeUncertain:true,retryAfterMs:1000}});
    assert.deepEqual(receipt,{kind:"RECORDED",retryable:false,reviewRequired:false,outcomeUncertain:true});
    const row=await limited.getRunState({runId,shopId:c.shopId});assert.equal(row.attempt,1);assert.equal(row.leaseToken,null);
    assert.equal((await repository.getRecoveryEligibility({runId})).reason,"NOT_DUE");
    await pool.query("UPDATE sync_adapter_test.runs SET next_eligible_at=clock_timestamp() WHERE id=$1",[runId]);
    assert.equal((await repository.getRecoveryEligibility({runId})).eligible,true);
    assert.equal(await repository.claimRun({runId,workerId:"worker",leaseSeconds:120}),null);
    assert.equal((await repository.getRecoveryEligibility({runId,shopId:shops[1]})).kind,"NOT_FOUND");
  });

  await t.test("ingestion evidence requires durable EOF and checkpoint receipts before reconciliation",async()=>{
    const runId=await seed("INGESTING");const c=await claim(runId);await grant(c);
    await assert.rejects(()=>repo.recordStep({claim:c,result:{kind:"ADVANCE"}}),{code:"EVIDENCE_MISSING"});
    const inserted=(await pool.query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,bulk_operation_id,expected_lines,processed_lines,eof_verified)
      VALUES ($1,'adapter-generation','products','RUNNING','gid://shopify/BulkOperation/999',0,0,false) RETURNING id`,[shops[0]])).rows[0];
    await assert.rejects(()=>repo.recordStep({claim:c,result:{kind:"ADVANCE"}}),{code:"EVIDENCE_MISSING"});
    await pool.query("UPDATE mirror.ingestion_runs SET status='SUCCEEDED',eof_verified=true,writes_finished_at=now() WHERE shop_id=$1 AND id=$2",[shops[0],inserted.id]);
    await assert.rejects(()=>repo.recordStep({claim:c,result:{kind:"ADVANCE"}}),{code:"EVIDENCE_MISSING"});
    await pool.query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at)
      VALUES ($1,'adapter-generation','variants','SUCCEEDED',0,0,true,now())`,[shops[0]]);
    assert.equal((await repo.recordStep({claim:c,result:{kind:"ADVANCE"}})).kind,"RECORDED");
  });

  await t.test("completion requires the existing generation service's exact committed publication",async()=>{
    const runId=await seed("PUBLISHING");const c=await claim(runId);await grant(c);
    await assert.rejects(()=>repo.recordStep({claim:c,result:{kind:"COMPLETE"}}),{code:"PUBLICATION_MISSING"});
    const sync=createSyncRunService({database:pool});
    await transaction(pool,async client=>{
      await sync.transitionGenerationToReconciling({client,shopId:shops[0],generationId:"adapter-generation"});
      await sync.completeCoverageAndVerify({client,shopId:shops[0],generationId:"adapter-generation"});
      await sync.publishGeneration({client,shopId:shops[0],generationId:"adapter-generation",expectedGenerationId:null});
    });
    assert.equal((await repo.recordStep({claim:c,result:{kind:"COMPLETE"}})).kind,"RECORDED");assert.equal(await claim(runId),null);
  });

  await t.test("shop publication locks block same-shop writers while allowing other shops",async()=>{
    const blocker=await pool.connect();try{
      await blocker.query("BEGIN");await blocker.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1::text,581834147::bigint))",[shops[0]]);
      const limited=createSyncRunDbAdapter({database:pool,mapping,verifyShop,verifyStepEvidence,verifyPublished,lockTimeoutMs:100});
      await limited.transaction(async tx=>{await tx.lockShop(shops[1]);});
      await assert.rejects(()=>limited.transaction(async tx=>{await tx.lockShop(shops[0]);}),{code:"55P03"});
    }finally{await blocker.query("ROLLBACK");blocker.release();}
    await assert.rejects(()=>db.transaction(tx=>tx.lockRun("anything")),{code:"LOCK_ORDER"});
  });

  await t.test("Serializable conflicts retry only aborted DB work and preserve PostgreSQL timeouts",async()=>{
    const read=Promise.withResolvers(),resume=Promise.withResolvers();let attempts=0;
    const processing=runSyncDbTransaction({database:pool,work:async tx=>{
      attempts++;const before=(await tx.$queryRawUnsafe("SELECT value FROM sync_adapter_test.conflicts WHERE id=1"))[0].value;
      if(attempts===1){read.resolve();await resume.promise;}
      const settings=(await tx.$queryRawUnsafe("SELECT current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock"))[0];
      assert.equal(settings.isolation,"serializable");assert.equal(settings.statement,"5s");assert.equal(settings.lock,"1s");
      await tx.$executeRawUnsafe("UPDATE sync_adapter_test.conflicts SET value=$1 WHERE id=1",before+1);
    }});
    await read.promise;await pool.query("UPDATE sync_adapter_test.conflicts SET value=value+1 WHERE id=1");resume.resolve();await processing;assert.equal(attempts,2);
    assert.equal((await pool.query("SELECT value FROM sync_adapter_test.conflicts WHERE id=1")).rows[0].value,2);
  });

  await t.test("a lost COMMIT acknowledgment is uncertain, is never retried, and may already be durable",async()=>{
    const original=pool.connect.bind(pool);let hide=true,calls=0;
    pool.connect=async()=>{
      const client=await original();return {release:error=>client.release(error),query:async(...args)=>{
        const result=await client.query(...args);
        if(args[0]==="COMMIT"&&hide){hide=false;throw Object.assign(new Error("lost commit acknowledgment"),{code:"ECONNRESET"});}return result;
      }};
    };
    try{await assert.rejects(()=>runSyncDbTransaction({database:pool,work:async tx=>{calls++;await tx.$executeRawUnsafe("UPDATE sync_adapter_test.conflicts SET value=value+1 WHERE id=1");}}),error=>error instanceof SyncOutcomeUnknownError&&error.outcomeUncertain);}
    finally{pool.connect=original;}
    assert.equal(calls,1);assert.equal((await pool.query("SELECT value FROM sync_adapter_test.conflicts WHERE id=1")).rows[0].value,3);
  });

  await t.test("late SQL from an adapter that ignores a deadline cannot use a released transaction",async()=>{
    const release=Promise.withResolvers();let late;
    const before=(await pool.query("SELECT value FROM sync_adapter_test.conflicts WHERE id=1")).rows[0].value;
    await assert.rejects(()=>runSyncDbTransaction({database:pool,transactionTimeoutMs:100,work:async tx=>{
      await release.promise;
      try{await tx.$executeRawUnsafe("UPDATE sync_adapter_test.conflicts SET value=value+1 WHERE id=1");}
      catch(error){late=error;throw error;}
    }}),{code:"TRANSACTION_DEADLINE"});
    release.resolve();await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(late.code,"TRANSACTION_CLOSED");
    assert.equal((await pool.query("SELECT value FROM sync_adapter_test.conflicts WHERE id=1")).rows[0].value,before);
  });

  await t.test("schema drift revokes verified mappings instead of executing stale bindings",async()=>{
    await pool.query("ALTER TABLE sync_adapter_test.runs RENAME COLUMN worker_id TO worker_changed");
    try{
      await assert.rejects(()=>db.getRunShop("anything"),{code:"SYNC_SCHEMA_MISMATCH"});
      await assert.rejects(()=>db.getRunState({runId:"anything",shopId:shops[0]}),{code:"SYNC_SCHEMA_MISMATCH"});
      let invoked=false;
      await assert.rejects(()=>db.transaction(async()=>{invoked=true;}),{code:"SYNC_SCHEMA_MISMATCH"});
      assert.equal(invoked,false);
    }
    finally{await pool.query("ALTER TABLE sync_adapter_test.runs RENAME COLUMN worker_changed TO worker_id");}
    mapping=await verifySyncRunDbMapping({database:pool,mapping:mappingSpec});configure();
  });

  await t.test("direct SQL-adapter commits require evidence verified in that exact transaction",async()=>{
    await releaseAll();const runId=await seed(),c=await claim(runId);await grant(c);
    const patch={claim:c,kind:"ADVANCE",nextPhase:"WAITING",expectedGenerationId:c.generationId};
    const locked=work=>db.transaction(async tx=>{await tx.lockShop(c.shopId);const run=await tx.lockRun(runId);return work(tx,run);});
    await assert.rejects(()=>locked(tx=>tx.commitStep(runId,patch)),{code:"EVIDENCE_MISSING"});
    assert.equal((await db.getRunState({runId,shopId:c.shopId})).phase,"STARTING");
    // A verification in another transaction is deliberately not a grant.
    assert.equal(await locked((tx,run)=>tx.verifyStepEvidence(run,{kind:"ADVANCE"})),true);
    await assert.rejects(()=>locked(tx=>tx.commitStep(runId,patch)),{code:"EVIDENCE_MISSING"});
    const changed=await locked(async(tx,run)=>{
      const candidate={...run};
      Object.defineProperty(candidate,"untrustedExtra",{enumerable:true,get(){assert.fail("Caller run getter invoked");}});
      assert.equal(await tx.verifyStepEvidence(candidate,{kind:"ADVANCE"}),true);
      return tx.commitStep(runId,patch);
    });
    assert.equal(changed.phase,"WAITING");assert.equal(changed.attempt,0);assert.equal(changed.fence,c.fence);
    const publishing=await seed("PUBLISHING"),p=await claim(publishing);
    await assert.rejects(()=>db.transaction(async tx=>{
      await tx.lockShop(p.shopId);await tx.lockRun(publishing);
      return tx.commitStep(publishing,{claim:p,kind:"COMPLETE",expectedGenerationId:p.generationId});
    }),{code:"PUBLICATION_MISSING"});
    await releaseAll();
  });

  await t.test("renewing or relocking a claim invalidates earlier phase evidence",async()=>{
    const runId=await seed(),c=await claim(runId);await grant(c);
    for(const action of ["renew","relock"]) {
      await assert.rejects(()=>db.transaction(async tx=>{
        await tx.lockShop(c.shopId);const run=await tx.lockRun(runId);
        assert.equal(await tx.verifyStepEvidence(run,{kind:"ADVANCE"}),true);
        if(action==="renew")assert.ok(await tx.renewRun(runId,{claim:c,leaseSeconds:120}));
        else await tx.lockRun(runId);
        return tx.commitStep(runId,{claim:c,kind:"ADVANCE",nextPhase:"WAITING",expectedGenerationId:c.generationId});
      }),{code:"EVIDENCE_MISSING"});
    }
    await releaseAll();
  });

  await t.test("an asynchronous validator cannot authorize a row relocked while verification was pending",async()=>{
    const runId=await seed(),c=await claim(runId);await grant(c);
    const started=Promise.withResolvers(),resume=Promise.withResolvers();
    const guarded=createSyncRunDbAdapter({database:pool,mapping,verifyShop,verifyPublished,
      verifyStepEvidence:async input=>{started.resolve();await resume.promise;return verifyStepEvidence(input);}});
    await assert.rejects(()=>guarded.transaction(async tx=>{
      await tx.lockShop(c.shopId);const run=await tx.lockRun(runId);
      const verification=tx.verifyStepEvidence(run,{kind:"ADVANCE"});
      await started.promise;await tx.lockRun(runId);resume.resolve();
      assert.equal(await verification,false);
      return tx.commitStep(runId,{claim:c,kind:"ADVANCE",nextPhase:"WAITING",expectedGenerationId:c.generationId});
    }),{code:"EVIDENCE_MISSING"});
    await releaseAll();
  });

  await t.test("transaction-local SQL and adapter capabilities cannot execute after callback completion",async()=>{
    let escapedSql;
    const guarded=createSyncRunDbAdapter({database:pool,mapping,verifyStepEvidence,verifyPublished,
      verifyShop:async input=>{escapedSql=input.tx;return verifyShop(input);}});
    const escaped=await guarded.transaction(async tx=>{await tx.lockShop(shops[0]);return tx;});
    const before=(await pool.query("SELECT value FROM sync_adapter_test.conflicts WHERE id=1")).rows[0].value;
    await assert.rejects(async()=>escapedSql.$executeRawUnsafe("UPDATE sync_adapter_test.conflicts SET value=value+1 WHERE id=1"),{code:"TRANSACTION_CLOSED"});
    await assert.rejects(()=>escaped.now(),{code:"TRANSACTION_CLOSED"});
    assert.equal((await pool.query("SELECT value FROM sync_adapter_test.conflicts WHERE id=1")).rows[0].value,before);
    assert.throws(()=>createSyncRunDbAdapter({database:pool,mapping,verifyShop,verifyStepEvidence,verifyPublished,verifyRun:false}),/verifyRun must be a function/);
    assert.throws(()=>db.transaction(null),/Database callback required/);
    assert.throws(()=>db.transaction(()=>{}, {isolationLevel:"ReadCommitted"}),{code:"INVALID_ISOLATION"});
  });
}
