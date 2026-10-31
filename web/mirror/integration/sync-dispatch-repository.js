import assert from 'node:assert/strict';
import {createSyncDispatchRepository} from '../sync-dispatch-repository.server.js';
import {createCatalogSyncRunDbAdapter} from '../catalog-execution.server.js';
import {createSyncRunRepository} from '../sync-run-repository.server.js';
import {dispatchJobId,createSyncDispatcher} from '../../workers/sync-dispatcher.js';
import {CATALOG_INPUT_HASH} from '../catalog-sync-steps.server.js';
import {randomUUID} from 'node:crypto';
import {createSyncDispatchMonitor} from '../../workers/sync-dispatch-monitor.server.js';
import {verifySyncRunDbMapping} from '../sync-run-schema.server.js';
import {CATALOG_EXECUTION_MAPPING} from '../sync-domain-schema.server.js';
import {createSyncRecoveryRepository} from '../sync-recovery-repository.server.js';
import {createSyncDispatchRecoveryVerifier,createSyncDispatchRecovery} from '../sync-dispatch-recovery.server.js';
import {createSyncRedisTransport} from '../../workers/sync-redis-transport.server.js';
import {createClient} from 'redis';
import {getInstalledFilterSchemaOptions} from '../../services/filter-schema.server.js';
import {mkdir,writeFile} from 'node:fs/promises';

export async function testSyncDispatchRepository(t,{pool,fixture,service,runtime,state,makeDue}) {
  await pool.query(`CREATE TABLE mirror.dispatch_test_evidence(id text PRIMARY KEY,dispatch_id text NOT NULL,
    revision bigint NOT NULL,token text NOT NULL,fence bigint NOT NULL,decision text NOT NULL)`);
  const verifyRecoveryDecision=async({tx,delivery,decision,evidenceId})=>(await tx.$queryRawUnsafe(`SELECT 1 FROM mirror.dispatch_test_evidence
    WHERE id=$1 AND dispatch_id=$2 AND revision=$3 AND token=$4 AND fence=$5 AND decision=$6`,
    evidenceId,delivery.id,delivery.delivery_revision,delivery.recovery_token,delivery.recovery_fence,decision)).length===1;
  const repository=createSyncDispatchRepository({database:pool,verifyRecoveryDecision});
  const core=createSyncRunRepository({db:await createCatalogSyncRunDbAdapter({database:pool})});
  let jobs=[];
  async function seed(name) {
    const s=fixture(`dispatch-${name}`),job=await service.enqueue(s.session);jobs.push(job.id);return {s,job};
  }
  const reserve=()=>repository.reserveDispatchBatch({limit:1,reservationSeconds:60});
  const ack=r=>repository.markDispatched({...r,jobId:dispatchJobId(r)});
  const fail=r=>repository.markDispatchFailure({...r,code:'REDIS_OUTCOME_UNKNOWN'});
  const expire=r=>pool.query("UPDATE mirror.sync_dispatches SET reserved_until=clock_timestamp()-interval '1 second' WHERE id=$1",[r.dispatchId]);
  const stored=r=>pool.query('SELECT * FROM mirror.sync_dispatches WHERE id=$1',[r.dispatchId]).then(r=>r.rows[0]);
  async function proof(claim,decision) {
    const evidenceId=randomUUID();await pool.query('INSERT INTO mirror.dispatch_test_evidence VALUES($1,$2,$3,$4,$5,$6)',
      [evidenceId,claim.dispatchId,claim.deliveryRevision,claim.recoveryToken,claim.recoveryFence,decision]);return evidenceId;
  }
  async function verifyRetry(r) {
    const claim=await repository.claimDeliveryRecovery({dispatchId:r.dispatchId});assert.ok(claim);
    const evidenceId=await proof(claim,'RETRY_VERIFIED');
    assert.equal((await repository.finishDeliveryRecovery({claim,decision:'RETRY_VERIFIED',evidenceId})).kind,'RECORDED');
  }
  async function scenario(name,work) {
    await t.test(name,async()=>{jobs=[];try{await work();}finally{
      for(const id of jobs)await pool.query(`UPDATE mirror.catalog_import_executions SET review_required=true,
        cancel_completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL,worker_id=NULL WHERE id=$1`,[id]);
      for(const id of jobs)await pool.query("UPDATE mirror.sync_dispatches SET state='REVIEW_REQUIRED' WHERE run_id=$1",[id]);
    }});
  }

  await scenario('dispatch repository reserves atomically across hosts with one stable logical identity',async()=>{
    const {job}=await seed('concurrent');
    const second=createSyncDispatchRepository({database:pool});
    const results=await Promise.all([reserve(),second.reserveDispatchBatch({limit:1,reservationSeconds:60})]);
    const reservations=results.flat();assert.equal(reservations.length,1);
    const r=reservations[0];assert.equal(r.runId,job.id);assert.equal(r.kind,'SYNC');
    assert.match(r.deliveryKey,/^[a-f0-9]{64}$/);assert.ok(Object.isFrozen(r));
    assert.equal((await stored(r)).reservation_fence,'1');assert.deepEqual(await reserve(),[]);
    assert.equal((await stored(r)).attempt,1);assert.ok((await stored(r)).sync_run_id);
  });
  await scenario('shop-fair selection rotates durable service order across dispatcher instances',async()=>{
    const a=await seed('fair-a'),b=await seed('fair-b');
    const [first]=await reserve();assert.equal(first.runId,a.job.id);
    await expire(first);await verifyRetry(first);
    const second=createSyncDispatchRepository({database:pool});
    const [next]=await second.reserveDispatchBatch({limit:1,reservationSeconds:60});
    assert.equal(next.runId,b.job.id);
    const [again]=await reserve();assert.equal(again.runId,a.job.id);assert.equal(again.deliveryKey,first.deliveryKey);
  });
  await scenario('Redis uncertainty retains reservation and never fails or mutates the execution',async()=>{
    const {job}=await seed('uncertain'),[r]=await reserve(),before=await state(job.id),initial=await stored(r);
    assert.equal((await fail(r)).kind,'RECORDED');
    const after=await stored(r);assert.equal(after.state,'UNKNOWN');
    assert.equal(after.dispatch_token,initial.dispatch_token);assert.deepEqual(after.reserved_until,initial.reserved_until);
    assert.deepEqual(await state(job.id),before);assert.deepEqual(await reserve(),[]);
    assert.equal((await ack(r)).kind,'RECORDED');assert.equal((await ack(r)).kind,'RECORDED');
    assert.equal((await fail(r)).kind,'STALE_CLAIM');assert.equal((await stored(r)).state,'ENQUEUED');
    assert.ok((await stored(r)).enqueued_at);
  });
  await scenario('expired reservations reissue the same logical key with a new token and fence',async()=>{
    await seed('expiry');const [r]=await reserve();await fail(r);await expire(r);
    assert.equal((await ack(r)).kind,'STALE_CLAIM');
    assert.deepEqual(await reserve(),[]);await verifyRetry(r);
    const [next]=await reserve();assert.equal(next.dispatchId,r.dispatchId);assert.equal(next.deliveryKey,r.deliveryKey);
    assert.notEqual(next.dispatchToken,r.dispatchToken);assert.equal((await stored(next)).reservation_fence,'2');
    assert.equal((await stored(next)).attempt,2);
    assert.equal((await ack(r)).kind,'STALE_CLAIM');assert.equal((await fail(r)).kind,'STALE_CLAIM');
    assert.equal((await ack(next)).kind,'RECORDED');
  });
  await scenario('notification acknowledgment stays valid after a consumer claims the same logical delivery',async()=>{
    const {job}=await seed('consumer-race'),[r]=await reserve();
    await core.claimRun({runId:job.id,workerId:'consumer',leaseSeconds:120});
    assert.equal((await ack(r)).kind,'STALE_CLAIM');
    assert.equal((await stored(r)).state,'CONSUMED');
    assert.deepEqual(await reserve(),[]);
  });
  await scenario('pending ledger rows honor retry eligibility even without a reservation deadline',async()=>{
    await seed('retry-eligibility');const [r]=await reserve();await expire(r);
    await pool.query("UPDATE mirror.sync_dispatches SET state='PENDING',reserved_until=NULL,next_attempt_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[r.dispatchId]);
    assert.deepEqual(await reserve(),[]);
    await pool.query('UPDATE mirror.sync_dispatches SET next_attempt_at=clock_timestamp() WHERE id=$1',[r.dispatchId]);
    const [retry]=await reserve();assert.equal(retry.deliveryKey,r.deliveryKey);assert.notEqual(retry.dispatchToken,r.dispatchToken);
  });
  await scenario('shop scheduling authority gates reservations and advances its durable dispatch timestamp',async()=>{
    const {s}=await seed('schedule-gate');
    await pool.query("UPDATE mirror.sync_dispatch_schedule SET next_eligible_at=clock_timestamp()+interval '1 hour' WHERE shop_id=$1",[s.session.shop]);
    assert.deepEqual(await reserve(),[]);
    await pool.query('UPDATE mirror.sync_dispatch_schedule SET next_eligible_at=clock_timestamp() WHERE shop_id=$1',[s.session.shop]);
    const [r]=await reserve();assert.ok(r);
    const schedule=(await pool.query('SELECT * FROM mirror.sync_dispatch_schedule WHERE shop_id=$1',[s.session.shop])).rows[0];
    assert.ok(schedule.last_dispatched_at);assert.ok(BigInt(schedule.last_served)>0n);
  });
  await scenario('terminal lifecycle states cannot be reissued as the same logical delivery',async()=>{
    await seed('terminal-deliveries');const [r]=await reserve();await expire(r);
    for(const state of ['CONSUMED','CANCELLED','REVIEW_REQUIRED']) {
      await pool.query('UPDATE mirror.sync_dispatches SET state=$2,consumed_at=clock_timestamp() WHERE id=$1',[r.dispatchId,state]);
      assert.deepEqual(await reserve(),[]);
      assert.deepEqual(await repository.listRecoveryCandidates(),[]);
    }
  });
  await scenario('active reconciliation leases block reissue and expired reconciliation retains the logical key',async()=>{
    await seed('reconciliation-lease');const [r]=await reserve();await expire(r);
    await pool.query(`UPDATE mirror.sync_dispatches SET state='RECONCILING',recovery_token='recovery-owner',recovery_fence=recovery_fence+1,
      recovery_until=clock_timestamp()+interval '1 hour',recovery_reason='QUEUE_OUTCOME_UNKNOWN' WHERE id=$1`,[r.dispatchId]);
    assert.deepEqual(await reserve(),[]);assert.equal((await ack(r)).kind,'STALE_CLAIM');
    assert.deepEqual(await repository.listRecoveryCandidates(),[]);
    await pool.query("UPDATE mirror.sync_dispatches SET recovery_until=clock_timestamp()-interval '1 second' WHERE id=$1",[r.dispatchId]);
    await verifyRetry(r);
    const released=await stored(r);assert.equal(released.state,'RETRY_ELIGIBLE');assert.equal(released.recovery_token,null);
    const [retry]=await reserve();assert.equal(retry.deliveryKey,r.deliveryKey);assert.notEqual(retry.dispatchToken,r.dispatchToken);
  });
  await scenario('dispatch acknowledgments compare every token and logical scope and reject expired owners',async()=>{
    await seed('cas');const [r]=await reserve();
    for(const patch of [{dispatchId:'absent'},{dispatchToken:'forged'},{runId:'other'},{deliveryKey:'other'},
      {kind:'RECOVERY'}]) {
      assert.equal((await ack({...r,...patch})).kind,'STALE_CLAIM');
      assert.equal((await fail({...r,...patch})).kind,'STALE_CLAIM');
    }
    await assert.rejects(()=>repository.markDispatched({...r,jobId:'wrong'}),/logical job/);
    assert.equal((await stored(r)).state,'RESERVED');await expire(r);
    assert.equal((await fail(r)).kind,'STALE_CLAIM');
  });
  await scenario('successful phase and polling deliveries advance keys while execution retries keep them',async()=>{
    const {job}=await seed('revision');const [starting]=await reserve();
    await runtime.processOne();assert.equal((await state(job.id)).phase,'WAITING');
    assert.equal((await ack(starting)).kind,'STALE_CLAIM');
    const [waiting]=await reserve();assert.notEqual(waiting.deliveryKey,starting.deliveryKey);
    const claim=await core.claimRun({runId:job.id,workerId:'dispatch-test',leaseSeconds:120});
    await core.recordFailure({claim,failure:{code:'TEMPORARY',retryable:true,outcomeUncertain:false,retryAfterMs:1000}});
    await makeDue(job.id);await expire(waiting);await verifyRetry(waiting);
    const [retry]=await reserve();assert.equal(retry.deliveryKey,waiting.deliveryKey);
    const poll=await core.claimRun({runId:job.id,workerId:'dispatch-test',leaseSeconds:120});
    await core.recordStep({claim:poll,result:{kind:'DEFER',delayMs:1000}});await makeDue(job.id);
    const [nextPoll]=await reserve();assert.notEqual(nextPoll.deliveryKey,retry.deliveryKey);
    assert.equal((await state(job.id)).phase,'WAITING');
    await expire(starting);await expire(retry);
    assert.equal((await stored(starting)).state,'CONSUMED');assert.equal((await stored(retry)).state,'CONSUMED');
    await assert.rejects(()=>pool.query('UPDATE mirror.catalog_import_executions SET delivery_revision=9999 WHERE id=$1',[job.id]),{code:'23514'});
    await assert.rejects(()=>pool.query("UPDATE mirror.sync_dispatches SET delivery_key='forged' WHERE id=$1",[nextPoll.dispatchId]),{code:'23514'});
  });
  await scenario('unresolved external operations and expired workers are routed exclusively to recovery',async()=>{
    const {s,job}=await seed('remote-unknown');
    await pool.query(`INSERT INTO mirror.sync_external_operations(id,shop_id,run_id,generation_id,kind,input_hash,state,dispatch_fence)
      VALUES('dispatch-unknown',$1,$2,$3,'BULK_START',$4,'DISPATCHING',1)`,[s.session.shop,job.id,job.generationId,CATALOG_INPUT_HASH]);
    const [r]=await reserve();assert.equal(r.kind,'RECOVERY');assert.equal(s.starts,0);
    assert.equal((await state(job.id)).outcome_uncertain,true);
    assert.equal(await core.claimRun({runId:job.id,workerId:'ordinary',leaseSeconds:120}),null);
    assert.equal((await ack(r)).kind,'RECORDED');
    // Park this job to make the next discovery independent.
    await pool.query('UPDATE mirror.catalog_import_executions SET review_required=true WHERE id=$1',[job.id]);
    const lost=await seed('lease-lost');
    await core.claimRun({runId:lost.job.id,workerId:'crashed',leaseSeconds:120});
    await pool.query("UPDATE mirror.catalog_import_executions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[lost.job.id]);
    const before=await state(lost.job.id),[recovered]=await reserve(),after=await state(lost.job.id);
    assert.equal(recovered.kind,'RECOVERY');assert.equal(after.outcome_uncertain,true);assert.equal(after.lease_token,null);
    assert.equal(after.attempt,before.attempt);assert.equal(after.recovery_attempts,before.recovery_attempts);
  });
  await scenario('successful recovery creates a fresh ordinary logical delivery',async()=>{
    const {job}=await seed('recovery-revision'),[first]=await reserve();
    const claim=await core.claimRun({runId:job.id,workerId:'lost',leaseSeconds:120});
    await core.recordFailure({claim,failure:{code:'OUTCOME_UNKNOWN',retryable:false,outcomeUncertain:true}});await makeDue(job.id);
    const [recovery]=await reserve();assert.equal(recovery.kind,'RECOVERY');
    assert.equal((await runtime.processOne()).kind,'RESUMED');
    const [next]=await reserve();assert.equal(next.kind,'SYNC');assert.notEqual(next.deliveryKey,first.deliveryKey);
    assert.equal((await ack(recovery)).kind,'STALE_CLAIM');
  });
  await scenario('discovery enforces due time, attempt budget, installation, cancellation and generation authority',async()=>{
    const {s,job}=await seed('eligibility');
    for(const [sql,restore] of [
      ["next_eligible_at=clock_timestamp()+interval '1 hour'","next_eligible_at=NULL"],
      ['attempt=12','attempt=0'],['review_required=true','review_required=false'],
    ]) {
      await pool.query(`UPDATE mirror.catalog_import_executions SET ${sql} WHERE id=$1`,[job.id]);
      assert.deepEqual(await reserve(),[]);
      await pool.query(`UPDATE mirror.catalog_import_executions SET ${restore} WHERE id=$1`,[job.id]);
    }
    await pool.query("UPDATE mirror.shops SET installation_version='reinstalled' WHERE id=$1",[s.session.shop]);
    assert.deepEqual(await reserve(),[]);
  });
  await scenario('cancellation fences delivery acknowledgments and schema drift prevents dispatch writes',async()=>{
    const {job}=await seed('authority'),[r]=await reserve();
    await pool.query('UPDATE mirror.catalog_import_jobs SET cancel_requested=true WHERE id=$1',[job.id]);
    assert.equal((await ack(r)).kind,'STALE_CLAIM');assert.equal((await fail(r)).kind,'STALE_CLAIM');
    await pool.query('ALTER TABLE mirror.sync_dispatches RENAME COLUMN delivery_key TO dispatch_drift');
    try{await assert.rejects(()=>reserve(),{code:'SYNC_SCHEMA_MISMATCH'});}
    finally{await pool.query('ALTER TABLE mirror.sync_dispatches RENAME COLUMN dispatch_drift TO delivery_key');}
  });
  await scenario('dispatcher uses real PostgreSQL reservations without conflating Redis and execution failures',async()=>{
    const {job}=await seed('dispatcher'),before=await state(job.id);
    const dispatcher=createSyncDispatcher({repository,syncQueue:{async add(){throw new Error('Redis response lost');}},
      recoveryQueue:{async add(){assert.fail('Unexpected recovery');}},logger:{info(){},error(){}}});
    const result=await dispatcher.runOnce();assert.equal(result.uncertain,1);assert.equal(result.stopReason,'NO_DUE_WORK');
    assert.deepEqual(await state(job.id),before);
  });
  await scenario('a lost reservation COMMIT remains reserved and cannot be issued again before expiry',async()=>{
    const {job}=await seed('lost-commit');let writeSeen=false,commits=0;
    const database={async connect(){const c=await pool.connect();return {
      async query(text,values){
        if(text.includes('INSERT INTO mirror.sync_dispatches AS d'))writeSeen=true;
        const result=await c.query(text,values);
        if(text==='COMMIT'&&writeSeen){commits++;throw Object.assign(new Error('Commit response lost'),{code:'ECONNRESET'});}
        return result;
      },release:c.release.bind(c),
    };}};
    const ambiguous=createSyncDispatchRepository({database});
    await assert.rejects(()=>ambiguous.reserveDispatchBatch({limit:1,reservationSeconds:60}),{outcomeUncertain:true});
    assert.equal(commits,1);assert.deepEqual(await reserve(),[]);
    const row=(await pool.query('SELECT * FROM mirror.sync_dispatches WHERE run_id=$1',[job.id])).rows[0];
    await expire({dispatchId:row.id});await verifyRetry({dispatchId:row.id});const [retry]=await reserve();
    assert.equal(retry.deliveryKey,row.delivery_key);assert.notEqual(retry.dispatchToken,row.dispatch_token);
  });
  await scenario('fresh claims and consumption receipts commit atomically and verifier rejection rolls both back',async()=>{
    const {job}=await seed('atomic-consumption'),[r]=await reserve(),before=await state(job.id);
    const denied=createSyncDispatchRepository({database:pool,verifyConsumption:async()=>false});
    const rejected=createSyncRunRepository({db:await createCatalogSyncRunDbAdapter({database:pool,dispatchRepository:denied})});
    await assert.rejects(()=>rejected.claimRun({runId:job.id,workerId:'consumer',leaseSeconds:120}),/Consumption evidence/);
    assert.deepEqual(await state(job.id),before);assert.equal((await stored(r)).state,'RESERVED');
    const claim=await core.claimRun({runId:job.id,workerId:'consumer',leaseSeconds:120});
    const receipt=await stored(r);assert.equal(receipt.state,'CONSUMED');assert.equal(receipt.consumed_fence,claim.fence);
    assert.equal(receipt.consumed_lease_token,claim.leaseToken);assert.ok(receipt.consumed_at);
    const c=await pool.connect();
    try{await c.query('BEGIN');await assert.rejects(()=>repository.acknowledgeConsumptionInTransaction({tx:c,claim,deliveryKey:r.deliveryKey}),/fresh execution claim transaction/);await c.query('ROLLBACK');}
    finally{c.release();}
    assert.equal((await ack(r)).kind,'STALE_CLAIM');
  });
  await scenario('delivery recovery has one owner, exact scoped evidence and monotonically fenced takeover',async()=>{
    await seed('recovery-fencing');const [r]=await reserve();await expire(r);
    const contenders=await Promise.all([repository.claimDeliveryRecovery({dispatchId:r.dispatchId}),repository.claimDeliveryRecovery({dispatchId:r.dispatchId})]);
    const claims=contenders.filter(Boolean);assert.equal(claims.length,1);const old=claims[0];
    await assert.rejects(()=>repository.finishDeliveryRecovery({claim:old,decision:'RETRY_VERIFIED',evidenceId:'unissued'}),{code:'EVIDENCE_MISSING'});
    await pool.query("UPDATE mirror.sync_dispatches SET recovery_until=clock_timestamp()-interval '1 second' WHERE id=$1",[r.dispatchId]);
    const next=await repository.claimDeliveryRecovery({dispatchId:r.dispatchId});assert.notEqual(next.recoveryToken,old.recoveryToken);
    assert.equal(BigInt(next.recoveryFence),BigInt(old.recoveryFence)+1n);
    const oldEvidence=await proof(old,'RETRY_VERIFIED');
    assert.equal((await repository.finishDeliveryRecovery({claim:old,decision:'RETRY_VERIFIED',evidenceId:oldEvidence})).kind,'STALE_RECOVERY');
    for(const patch of [{shopId:'other.myshopify.com'},{runId:'other'},{generationId:'other'},{deliveryKey:'other'},{recoveryFence:'999'}]) {
      assert.equal((await repository.finishDeliveryRecovery({claim:{...next,...patch},decision:'RETRY_VERIFIED',evidenceId:oldEvidence})).kind,'STALE_RECOVERY');
    }
    assert.equal((await repository.finishDeliveryRecovery({claim:next,decision:'RETRY_VERIFIED',evidenceId:await proof(next,'RETRY_VERIFIED')})).kind,'RECORDED');
    assert.equal((await stored(r)).state,'RETRY_ELIGIBLE');
  });
  await scenario('recovery execution claims roll back when their dispatch consumption verifier rejects',async()=>{
    const {job}=await seed('atomic-recovery-consumption');await reserve();
    const ordinary=await core.claimRun({runId:job.id,workerId:'interrupted',leaseSeconds:120});
    await core.recordFailure({claim:ordinary,failure:{code:'UNKNOWN_OUTCOME',retryable:false,outcomeUncertain:true}});await makeDue(job.id);
    const [notification]=await reserve(),before=await state(job.id);
    const denied=createSyncDispatchRepository({database:pool,verifyConsumption:async()=>false});
    const recovery=createSyncRecoveryRepository({database:pool,syncRunRepository:core,inputHash:CATALOG_INPUT_HASH,
      verifyRecoveryEvidence:()=>true,dispatchRepository:denied});
    await assert.rejects(()=>recovery.claimRecovery({runId:job.id}),/Consumption evidence/);
    assert.deepEqual(await state(job.id),before);assert.equal((await stored(notification)).state,'RESERVED');
    assert.equal((await runtime.processOne()).kind,'RESUMED');
    const d=await stored(notification);assert.equal(d.state,'CONSUMED');assert.ok(d.consumed_lease_token);
    assert.equal(d.consumed_fence,(await state(job.id)).fence);
  });
  await scenario('recovery cannot approve retries of superseded phases or an unexpired reservation',async()=>{
    const {job}=await seed('superseded-proof'),[r]=await reserve();await fail(r);
    const claim=await repository.claimDeliveryRecovery({dispatchId:r.dispatchId});
    const evidenceId=await proof(claim,'RETRY_VERIFIED');
    assert.equal((await repository.finishDeliveryRecovery({claim,decision:'RETRY_VERIFIED',evidenceId})).kind,'STALE_RECOVERY');
    await expire(r);
    await runtime.processOne(); // The real worker supersedes the reconciliation lease by consuming its notification.
    assert.equal((await state(job.id)).phase,'WAITING');
    assert.equal((await repository.finishDeliveryRecovery({claim,decision:'RETRY_VERIFIED',evidenceId})).kind,'STALE_RECOVERY');
    assert.equal((await stored(r)).state,'CONSUMED');
  });
  await scenario('all delivery recovery outcomes require persisted evidence and preserve queue uncertainty',async()=>{
    for(const decision of ['CONSUMED','STILL_ENQUEUED','UNRESOLVED']) {
      await seed(`decision-${decision.toLowerCase().replaceAll('_','-')}`);const [r]=await reserve();await fail(r);
      const claim=await repository.claimDeliveryRecovery({dispatchId:r.dispatchId});
      assert.equal((await repository.finishDeliveryRecovery({claim,decision,evidenceId:await proof(claim,decision)})).kind,'RECORDED');
      const d=await stored(r);assert.equal(d.state,{CONSUMED:'CONSUMED',STILL_ENQUEUED:'ENQUEUED',UNRESOLVED:'REVIEW_REQUIRED'}[decision]);
      if(decision==='CONSUMED')assert.ok(d.consumed_at);
      if(decision==='UNRESOLVED')assert.ok(d.reviewed_at);
      assert.deepEqual(await reserve(),[]);
      await pool.query('UPDATE mirror.catalog_import_executions SET review_required=true WHERE id=$1',[r.runId]);
    }
  });
  await scenario('the scheduled exhaustion worker marks only delivery review and publishes operational counts',async()=>{
    const {job}=await seed('exhaustion-monitor'),[r]=await reserve();await expire(r);
    await pool.query("UPDATE mirror.sync_dispatches SET state='RETRY_ELIGIBLE',attempt=20 WHERE id=$1",[r.dispatchId]);
    const before=await state(job.id),events=[];
    const monitor=createSyncDispatchMonitor({repository,logger:{info:e=>events.push(e),error(){}}});
    const result=await monitor.runOnce();assert.equal(result.reviewed,1);assert.ok(BigInt(result.states.REVIEW_REQUIRED)>0n);
    assert.equal(monitor.getMetrics(),result);assert.equal(events[0].event,'sync_dispatch_monitor');
    assert.equal((await stored(r)).recovery_reason,'MAX_DISPATCH_ATTEMPTS');assert.deepEqual(await state(job.id),before);
    assert.deepEqual(await reserve(),[]);
  });
  await scenario('expired delivery recovery cannot commit after its evidence verification deadline',async()=>{
    await seed('evidence-expiry');const [r]=await reserve();await expire(r);
    const claim=await repository.claimDeliveryRecovery({dispatchId:r.dispatchId});
    const timed=createSyncDispatchRepository({database:pool,verifyRecoveryDecision:async({tx})=>{
      await tx.$queryRawUnsafe("UPDATE mirror.sync_dispatches SET recovery_until=clock_timestamp()-interval '1 second' WHERE id=$1 RETURNING id",r.dispatchId);
      return true;
    }});
    assert.equal((await timed.finishDeliveryRecovery({claim,decision:'RETRY_VERIFIED',evidenceId:'test-deadline'})).kind,'STALE_RECOVERY');
    assert.equal((await stored(r)).state,'RECONCILING');assert.deepEqual(await reserve(),[]);
  });
  await scenario('Prisma transaction protocol uses genuine mappings and exact bigint delivery recovery scopes',async()=>{
    await seed('prisma-protocol');
    const prisma={async $queryRawUnsafe(){assert.fail('SQL must remain transactional');},async $transaction(work){
      const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const result=await work({async $queryRawUnsafe(sql,...values){const r=await c.query(sql,values);
          return r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[
            key,r.fields.find(f=>f.name===key)?.dataTypeID===20&&value!==null?BigInt(value):value])));},
        async $executeRawUnsafe(sql,...values){return (await c.query(sql,values)).rowCount;}});
        await c.query('COMMIT');return result;
      }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    }};
    const mapping=await verifySyncRunDbMapping({prisma,mapping:CATALOG_EXECUTION_MAPPING});
    const orm=createSyncDispatchRepository({prisma,mapping,verifyRecoveryDecision});
    const [r]=await orm.reserveDispatchBatch({limit:1,reservationSeconds:60});await expire(r);
    const claim=await orm.claimDeliveryRecovery({dispatchId:r.dispatchId});assert.equal(typeof claim.recoveryFence,'string');
    assert.equal((await orm.finishDeliveryRecovery({claim,decision:'RETRY_VERIFIED',evidenceId:await proof(claim,'RETRY_VERIFIED')})).kind,'RECORDED');
    assert.equal((await stored(r)).state,'RETRY_ELIGIBLE');
  });
  await scenario('lost enqueue-ack COMMIT responses preserve ENQUEUED without replay or compensating failure',async()=>{
    const {job}=await seed('ack-commit-unknown'),[r]=await reserve(),before=await state(job.id);
    let writeSeen=false,commits=0;
    const database={async connect(){const c=await pool.connect();return {
      async query(text,values){
        if(text.includes("state=$7,job_id=CASE"))writeSeen=true;
        const result=await c.query(text,values);
        if(text==='COMMIT'&&writeSeen){commits++;throw Object.assign(new Error('Ack COMMIT response lost'),{code:'ECONNRESET'});}
        return result;
      },release:c.release.bind(c),
    };}};
    const uncertain=createSyncDispatchRepository({database});
    await assert.rejects(()=>uncertain.markDispatched({...r,jobId:dispatchJobId(r)}),{outcomeUncertain:true});
    assert.equal(commits,1);assert.equal((await stored(r)).state,'ENQUEUED');
    assert.deepEqual(await state(job.id),before);assert.equal((await fail(r)).kind,'STALE_CLAIM');
    await expire(r);assert.deepEqual(await reserve(),[]);
  });
  await scenario('lost delivery-recovery COMMIT responses cannot replay an evidence-backed transition',async()=>{
    await seed('recovery-commit-unknown');const [r]=await reserve();await expire(r);
    const claim=await repository.claimDeliveryRecovery({dispatchId:r.dispatchId});
    const input={claim,decision:'RETRY_VERIFIED',evidenceId:await proof(claim,'RETRY_VERIFIED')};
    let writeSeen=false,commits=0;
    const database={async connect(){const c=await pool.connect();return {
      async query(text,values){
        if(text.includes('SET state=$3,recovery_token=NULL'))writeSeen=true;
        const result=await c.query(text,values);
        if(text==='COMMIT'&&writeSeen){commits++;throw Object.assign(new Error('Recovery COMMIT response lost'),{code:'ECONNRESET'});}
        return result;
      },release:c.release.bind(c),
    };}};
    const uncertain=createSyncDispatchRepository({database,verifyRecoveryDecision});
    await assert.rejects(()=>uncertain.finishDeliveryRecovery(input),{outcomeUncertain:true});
    assert.equal(commits,1);assert.equal((await stored(r)).state,'RETRY_ELIGIBLE');
    assert.equal((await repository.finishDeliveryRecovery(input)).kind,'STALE_RECOVERY');
    const [next]=await reserve();assert.equal(next.deliveryKey,r.deliveryKey);assert.notEqual(next.dispatchToken,r.dispatchToken);
  });
  await scenario('a fresh worker claim wins a concurrent delivery-recovery completion without duplicate execution ownership',async()=>{
    const {job}=await seed('consumer-recovery-race'),[r]=await reserve();await expire(r);
    const recoveryClaim=await repository.claimDeliveryRecovery({dispatchId:r.dispatchId});
    const evidenceId=await proof(recoveryClaim,'RETRY_VERIFIED');
    const [claim,result]=await Promise.all([
      core.claimRun({runId:job.id,workerId:'race-consumer',leaseSeconds:120}),
      repository.finishDeliveryRecovery({claim:recoveryClaim,decision:'RETRY_VERIFIED',evidenceId}),
    ]);
    assert.ok(claim);assert.ok(['RECORDED','STALE_RECOVERY'].includes(result.kind));
    assert.equal((await stored(r)).state,'CONSUMED');assert.equal((await stored(r)).consumed_fence,claim.fence);
    assert.equal((await state(job.id)).lease_token,claim.leaseToken);assert.deepEqual(await reserve(),[]);
  });
  await scenario('obsolete installations cannot fill the exhaustion batch ahead of eligible deliveries',async()=>{
    const obsolete=await seed('exhausted-obsolete'),[old]=await reserve();await expire(old);
    await pool.query(`UPDATE mirror.sync_dispatches SET state='RETRY_ELIGIBLE',attempt=20,updated_at=now()-interval '1 day' WHERE id=$1`,[old.dispatchId]);
    await pool.query(`INSERT INTO mirror.sync_dispatches(id,shop_id,run_id,generation_id,sync_run_id,delivery_revision,kind,delivery_key,
      dispatch_token,reservation_fence,state,attempt,updated_at)
      SELECT 'obsolete-exhausted-'||n,d.shop_id,d.run_id,d.generation_id,d.sync_run_id,n,'SYNC','obsolete-key-'||n,
        'token-'||n,1,'RETRY_ELIGIBLE',20,now()-interval '1 day' FROM mirror.sync_dispatches d,generate_series(1,110) n WHERE d.id=$1`,[old.dispatchId]);
    await pool.query("UPDATE mirror.shops SET installation_version='replaced' WHERE id=$1",[obsolete.s.session.shop]);
    const valid=await seed('exhausted-eligible'),[r]=await reserve();await expire(r);
    await pool.query("UPDATE mirror.sync_dispatches SET state='RETRY_ELIGIBLE',attempt=20 WHERE id=$1",[r.dispatchId]);
    const candidates=await repository.listExhaustedDispatches({limit:100});
    assert.deepEqual(candidates,[{dispatchId:r.dispatchId}]);
    const monitor=createSyncDispatchMonitor({repository,logger:{info(){},error(){}}});
    assert.equal((await monitor.runOnce()).reviewed,1);assert.equal((await stored(r)).state,'REVIEW_REQUIRED');
    assert.equal((await state(valid.job.id)).review_required,false);
  });
  await scenario('fair selection has a measured query plan across 500 eligible shops',async()=>{
    const versions=getInstalledFilterSchemaOptions(),c=await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO mirror.shops(id,installation_version)
        SELECT 'dispatch-perf-'||lpad(n::text,4,'0')||'.myshopify.com','perf-install' FROM generate_series(1,500) n`);
      await c.query(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version)
        SELECT id,'perf-generation','perf-coverage',$1,$2,'mapping_v1' FROM mirror.shops WHERE id LIKE 'dispatch-perf-%'`,
      [versions.mirrorSchemaVersion,versions.sourceContractVersion]);
      await c.query(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset)
        SELECT id,'perf-generation','products' FROM mirror.shops WHERE id LIKE 'dispatch-perf-%'`);
      await c.query(`INSERT INTO mirror.catalog_import_jobs(id,shop_id,installation_version,generation_id,run_id,execution_mode)
        SELECT 'perf-run-'||id,shop_id,'perf-install',generation_id,id,'PHASE' FROM mirror.ingestion_runs WHERE shop_id LIKE 'dispatch-perf-%'`);
      await c.query(`INSERT INTO mirror.catalog_import_executions(id,shop_id,generation_id)
        SELECT id,shop_id,generation_id FROM mirror.catalog_import_jobs WHERE shop_id LIKE 'dispatch-perf-%'`);
      await c.query(`UPDATE mirror.ingestion_runs r SET execution_id=j.id,execution_fence=0
        FROM mirror.catalog_import_jobs j WHERE j.shop_id=r.shop_id AND j.run_id=r.id AND r.shop_id LIKE 'dispatch-perf-%'`);
      await c.query('COMMIT');
    } catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    jobs.push(...(await pool.query("SELECT id FROM mirror.catalog_import_executions WHERE shop_id LIKE 'dispatch-perf-%'")).rows.map(r=>r.id));
    let selection;
    const database={async connect(){const c=await pool.connect();return {
      query(text,values){if(text.includes('JOIN mirror.sync_dispatch_schedule fairness'))selection={text,values};return c.query(text,values);},
      release:c.release.bind(c),
    };}};
    const measured=createSyncDispatchRepository({database}),started=performance.now();
    const [r]=await measured.reserveDispatchBatch({limit:1,reservationSeconds:60});assert.ok(r);
    const reservationMs=performance.now()-started;
    const plan=(await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${selection.text}`,selection.values)).rows[0]['QUERY PLAN'][0];
    assert.equal(plan.Plan['Actual Rows'],1);assert.ok(Number.isFinite(plan['Execution Time']));
    const summary={shops:500,reservationMs,selectionPlanningMs:plan['Planning Time'],selectionExecutionMs:plan['Execution Time'],
      note:'Disposable local smoke profile; no production concurrency or SLO approval.',plan};
    await mkdir(new URL('../../../.audit/',import.meta.url),{recursive:true});
    await writeFile(new URL('../../../.audit/dispatch-fairness-plan.json',import.meta.url),JSON.stringify(summary,null,2));
  });
  await scenario('delivery recovery verifier reconciles uncertain and expired deliveries with scoped receipts',async()=>{
    let queueState='ENQUEUED';
    const verifier=createSyncDispatchRecoveryVerifier({database:pool,inspectQueue:async()=>({state:queueState})});
    const repo=createSyncDispatchRepository({database:pool,verifyRecoveryDecision:verifier.verifyRecoveryDecision});
    const recovery=createSyncDispatchRecovery({repository:repo,verifier,logger:{info(){},warn(){},error(){}}});
    const {job}=await seed('verifier-flow');
    const [r1]=await repo.reserveDispatchBatch({limit:1,reservationSeconds:60});assert.ok(r1);
    assert.equal((await repo.markDispatchFailure({...r1,code:'REDIS_OUTCOME_UNKNOWN'})).kind,'RECORDED');
    await expire(r1);
    const stillQueued=await recovery.recoverDelivery(r1.dispatchId);
    assert.equal(stillQueued.kind,'RECORDED');assert.equal(stillQueued.decision,'STILL_ENQUEUED');
    assert.equal((await stored(r1)).state,'ENQUEUED');
    await pool.query("UPDATE mirror.sync_dispatches SET next_attempt_at=clock_timestamp()-interval '1 second',reserved_until=clock_timestamp()-interval '1 second' WHERE id=$1",[r1.dispatchId]);
    queueState='ABSENT';
    const retried=await recovery.recoverDelivery(r1.dispatchId);
    assert.equal(retried.kind,'RECORDED');assert.equal(retried.decision,'RETRY_VERIFIED');
    assert.equal((await stored(r1)).state,'RETRY_ELIGIBLE');
    const [r2]=await repo.reserveDispatchBatch({limit:1,reservationSeconds:60});
    assert.equal(r2.dispatchId,r1.dispatchId);assert.notEqual(r2.dispatchToken,r1.dispatchToken);
    assert.equal((await repo.markDispatched({...r2,jobId:dispatchJobId(r2)})).kind,'RECORDED');
    const claim=await core.claimRun({runId:job.id,workerId:'verifier-worker',leaseSeconds:60});
    assert.equal(claim.fence,'1');assert.equal((await stored(r2)).state,'CONSUMED');
    await pool.query("UPDATE mirror.sync_dispatches SET state='UNKNOWN',next_attempt_at=clock_timestamp()-interval '1 second',reserved_until=clock_timestamp()-interval '1 second' WHERE id=$1",[r2.dispatchId]);
    queueState='CONSUMED';
    const consumed=await recovery.recoverDueDeliveries({limit:5});
    assert.equal(consumed.kind,'COMPLETED');assert.equal(consumed.recorded,1);assert.equal(consumed.consumed,1);
    assert.equal((await stored(r2)).state,'CONSUMED');
    const evidenceRows=(await pool.query('SELECT * FROM mirror.sync_dispatch_recovery_evidence WHERE dispatch_id=$1 ORDER BY recovery_fence',[r1.dispatchId])).rows;
    assert.equal(evidenceRows.length,3);
    assert.deepEqual(evidenceRows.map(e=>e.decision),['STILL_ENQUEUED','RETRY_VERIFIED','CONSUMED']);
    for(const row of evidenceRows)assert.ok(row.consumed_at);
    await assert.rejects(()=>pool.query("UPDATE mirror.sync_dispatch_recovery_evidence SET decision='UNRESOLVED' WHERE id=$1",[evidenceRows[0].id]),{code:'23514'});
    await assert.rejects(()=>pool.query('UPDATE mirror.sync_dispatch_recovery_evidence SET consumed_at=NULL WHERE id=$1',[evidenceRows[0].id]),{code:'23514'});
  });
  await scenario('Redis BullMQ transport, dispatcher, and durable recovery evidence reconcile end-to-end',async()=>{
    const redisClient=createClient({url:process.env.REDIS_URL||'redis://127.0.0.1:6380',disableOfflineQueue:true,socket:{connectTimeout:1000,reconnectStrategy:false}});
    redisClient.on('error',()=>{});
    try{await redisClient.connect();}catch{return;}
    try {
      const prefix=`metamax:pg:${randomUUID().slice(0,8)}`;
      const transport=createSyncRedisTransport({redis:redisClient,prefix,activeLeaseMs:5000,pollIntervalMs:50});
      const verifier=createSyncDispatchRecoveryVerifier({database:pool,syncQueue:transport.syncQueue,recoveryQueue:transport.recoveryQueue});
      const repo=createSyncDispatchRepository({database:pool,verifyRecoveryDecision:verifier.verifyRecoveryDecision});
      const recovery=createSyncDispatchRecovery({repository:repo,verifier,logger:{info(){},warn(){},error(){}}});
      const dispatcher=createSyncDispatcher({repository:repo,syncQueue:transport.syncQueue,recoveryQueue:transport.recoveryQueue,logger:{info(){},warn(){},error(){}}});
      const {job}=await seed('redis-e2e');
      const cycle1=await dispatcher.runOnce();
      assert.equal(cycle1.dispatched,1);
      const [dispatchedRow]=(await pool.query('SELECT * FROM mirror.sync_dispatches WHERE run_id=$1',[job.id])).rows;
      assert.equal(dispatchedRow.state,'ENQUEUED');
      await pool.query("UPDATE mirror.sync_dispatches SET state='UNKNOWN',next_attempt_at=clock_timestamp()-interval '1 second',reserved_until=clock_timestamp()-interval '1 second' WHERE id=$1",[dispatchedRow.id]);
      const rec1=await recovery.recoverDelivery(dispatchedRow.id);
      assert.equal(rec1.kind,'RECORDED');assert.equal(rec1.decision,'STILL_ENQUEUED');
      const queuedJob=await transport.syncQueue.getJob(dispatchedRow.job_id);
      assert.ok(queuedJob);
      await queuedJob.remove();
      await pool.query("UPDATE mirror.sync_dispatches SET next_attempt_at=clock_timestamp()-interval '1 second',reserved_until=clock_timestamp()-interval '1 second' WHERE id=$1",[dispatchedRow.id]);
      const rec2=await recovery.recoverDelivery(dispatchedRow.id);
      assert.equal(rec2.kind,'RECORDED');assert.equal(rec2.decision,'RETRY_VERIFIED');
      const cycle2=await dispatcher.runOnce();
      assert.equal(cycle2.dispatched,1);
      const worker=new transport.Worker('metamax-catalog-sync',async j=>{
        const claimed=await core.claimRun({runId:j.data.runId,workerId:'redis-worker',leaseSeconds:60});
        return claimed;
      },{connection:transport.connection,autorun:false});
      const processed=await worker.processNext();
      assert.equal(processed?.result?.runId,job.id);
      assert.equal((await stored({dispatchId:dispatchedRow.id})).state,'CONSUMED');
    } finally {
      if(redisClient.isOpen)await redisClient.close();
    }
  });
}
