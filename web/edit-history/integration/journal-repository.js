import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { computeContractHash,canonicalApproval } from '../../services/approval.server.js';
import { createHistoryRepository } from '../history-repository.server.js';
import { normalizeHistorySnapshot, normalizeMutationIntent, normalizeMutationAttempt } from '../history-contract.js';
import { testRepositoryQa } from './repository-qa.js';
import { testExecutionAuthority } from './execution-authority.js';
import { testRepositoryAuthority } from './repository-authority.js';
import pg from 'pg';
import { createHistoryValueProtection } from '../history-value-protection.server.js';
import { testHistorySecurity } from './security.js';
import {testWorkerExecution} from './worker-execution.js';

const digest = n => `sha256:${String(n).repeat(64)}`;
const clone = value => JSON.parse(JSON.stringify(value));

// These tables model the missing execution-engine durable admission and receipt
// stores. They are fixture-only, not a fabricated production engine adapter.
export async function testJournalRepository(t, adminPool) {
  // Real restricted LOGIN: SET ROLE on a superuser session would not test
  // whether an application could regain session_user's elevated privileges.
  const password=randomUUID();
  await adminPool.query(`CREATE ROLE history_fixture_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD '${password}'`);
  await adminPool.query('GRANT metamax_history_runtime TO history_fixture_runtime');
  const url=new URL(process.env.FILTER_TEST_DATABASE_URL);url.username='history_fixture_runtime';url.password=password;
  const runtimePool=new pg.Pool({connectionString:url.toString()});
  const pool={query:(...args)=>adminPool.query(...args),connect:()=>runtimePool.connect(),adminConnect:()=>adminPool.connect(),runtimePool};
  try{
  await pool.query(`CREATE SCHEMA history_test_authority;
    CREATE TABLE history_test_authority.plans(shop_id text,installation_id text,operation_id uuid,mutation_id text,
      document jsonb NOT NULL,PRIMARY KEY(shop_id,installation_id,operation_id,mutation_id));
    CREATE TABLE history_test_authority.observations(shop_id text,installation_id text,receipt_id text,
      snapshot jsonb NOT NULL,PRIMARY KEY(shop_id,installation_id,receipt_id));
    CREATE TABLE history_test_authority.evidence(shop_id text,installation_id text,evidence_id text,document jsonb NOT NULL,authenticated boolean NOT NULL DEFAULT true,
      PRIMARY KEY(shop_id,installation_id,evidence_id));`);
  await adminPool.query(`ALTER TABLE history_test_authority.plans ADD COLUMN _history_lock integer DEFAULT 0;
    ALTER TABLE history_test_authority.observations ADD COLUMN _history_lock integer DEFAULT 0;
    GRANT USAGE ON SCHEMA history_test_authority TO metamax_history_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA history_test_authority TO metamax_history_runtime;
    GRANT UPDATE(_history_lock) ON history_test_authority.plans,history_test_authority.observations TO metamax_history_runtime;`);
  async function fixture(options = {}) {
    const operationId = randomUUID(), mutationId = randomUUID(), installationId = options.tenant?.installationId??randomUUID();
    const shopId = options.tenant?.shopId??`journal-${randomUUID()}.myshopify.com`, authContext = Object.freeze({ session: randomUUID() });
    const contractId = randomUUID(), generationId = randomUUID(), selectionId = randomUUID();
    const kind=options.kind??'bulk_edit',inverse=kind==='undo';
    const writes=inverse?{title:'Before',vendor:'Old Vendor'}:{title:'After',vendor:'Vendor'};
    const q = (text, values) => pool.query(text, values);
    if(!options.tenant)await q('INSERT INTO mirror.shops(id,installation_version) VALUES($1,$2)', [shopId,installationId]);
    await q(`INSERT INTO mirror.generations(shop_id,id,coverage_revision,mirror_schema_version,source_contract_version,mapping_version,required_datasets)
      VALUES($1,$2,'coverage-1','mirror_v1','sources_v1','physical-mapping-1',ARRAY['products'])`, [shopId,generationId]);
    const resource = 'gid://shopify/Product/1';
    const product = (await q(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,created_at,updated_at)
      VALUES($1,$2,$3,'Before','product-1','ACTIVE',now(),now()) RETURNING id`, [shopId,generationId,resource])).rows[0].id;
    if (options.extraProduct) await q(`INSERT INTO mirror.products(shop_id,generation_id,shopify_id,title,handle,status,created_at,updated_at)
      VALUES($1,$2,'gid://shopify/Product/2','Unselected','product-2','ACTIVE',now(),now())`,[shopId,generationId]);
    const productCount = options.extraProduct ? 2 : 1;
    await q(`INSERT INTO mirror.ingestion_runs(shop_id,generation_id,dataset,status,expected_lines,processed_lines,eof_verified,writes_finished_at)
      VALUES($1,$2,'products','SUCCEEDED',$3,$3,true,now())`, [shopId,generationId,productCount]);
    await q(`INSERT INTO mirror.coverage(shop_id,generation_id,name,status,durable_rows,verified_at,verification_hash)
      VALUES($1,$2,'products','COMPLETE',$3,now(),'verified')`, [shopId,generationId,productCount]);
    await q("UPDATE mirror.generations SET status='RECONCILING' WHERE shop_id=$1 AND id=$2", [shopId,generationId]);
    await q("UPDATE mirror.generations SET status='VERIFIED',verified_at=now() WHERE shop_id=$1 AND id=$2", [shopId,generationId]);
    await q("UPDATE mirror.generations SET status='PUBLISHED',published_at=now() WHERE shop_id=$1 AND id=$2", [shopId,generationId]);
    await q(`INSERT INTO mirror.selection_snapshots(shop_id,id,generation_id,coverage_revision,mapping_version,operation,operation_id,
      filter_ast,filter_fingerprint,registry_version,definition_revisions,expires_at)
      VALUES($1,$2,$3,'coverage-1','physical-mapping-1',$6,$4,'{}',$5,'registry-1','[]',now()+interval '2 hours')`,
    [shopId,selectionId,generationId,operationId,digest(2).slice(7),kind]);
    await q(`INSERT INTO mirror.selection_items(shop_id,snapshot_id,generation_id,product_id) VALUES($1,$2,$3,$4)`, [shopId,selectionId,generationId,product]);
    await q("UPDATE mirror.selection_snapshots SET status='APPROVED',selected_count=1,selection_hash='hash',frozen_at=now() WHERE shop_id=$1 AND id=$2", [shopId,selectionId]);
    const approvalContext = { shopId,snapshotId: selectionId,operation:kind,contract:inverse?{sourceCommandId:options.sourceCommandId,fields:['title','vendor'],...(options.historyUndoBinding?{historyUndo:options.historyUndoBinding}:{})}:{updates:writes},selectionHash: 'hash',approvedBy: 'merchant' };
    const approvedHash = computeContractHash(approvalContext);
    await q(`INSERT INTO mirror.execution_contracts(shop_id,id,snapshot_id,operation,approval_revision,contract,contract_hash,hash_version,canonical_contract,expires_at)
      VALUES($1,$2,$3,$8,'approval-1',$4,$5,'canonical-v2',$6,$7)`,
    [shopId,contractId,selectionId,JSON.stringify(approvalContext.contract),approvedHash,canonicalApproval(approvalContext),new Date(Date.now()+(options.approvalLifetimeMs ?? 3600000)),kind]);
    await q("UPDATE mirror.execution_contracts SET status='APPROVED',approved_by='merchant',approved_at=now() WHERE shop_id=$1 AND id=$2", [shopId,contractId]);
    const command = options.deferCommand?'9223372036854775807':(await q(`INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,status,fence,lease_token,lease_until,updated_at)
      VALUES($1,$2,$3,$4,'RUNNING',9007199254740993,'secret-lease',now()+interval '1 hour',now()) RETURNING id`, [shopId,contractId,randomUUID(),kind])).rows[0].id;
    const edit = options.deferCommand?'9223372036854775807':(await q('INSERT INTO mirror.edit_operations(shop_id,command_id,preview_id) VALUES($1,$2,$3) RETURNING id', [shopId,command,contractId])).rows[0].id;
    const item = options.deferCommand?'9223372036854775807':(await q(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,intended_values)
      VALUES($1,$2,$3,$4::jsonb) RETURNING id`, [shopId,command,resource,JSON.stringify(writes)])).rows[0].id;
    const attemptId = randomUUID(), startedAt = new Date().toISOString();
    const claim = { fenceEpoch: '9007199254740993', executionClaimId: 'engine-claim-1', leaseToken: 'secret-lease' };
    const entries = ['product.title','product.vendor'].map((fieldId, index) => {
      const identity = { shopId,installationId,executionJobId: command,executionItemId: item,mutationId,resourceGid: resource,fieldId };
      const binding = { mode: 'MIRROR_PINNED',executionFingerprint: digest(1),filterFingerprint: digest(2),fieldResolutionFingerprint: digest(3),
        fieldDefinitionRevision: 'registry-1',generationId,coverageRevision: 'coverage-1',mappingVersion: 'engine-mapping-1' };
      const beforeSnapshot = normalizeHistorySnapshot({ identity,binding,kind: 'BEFORE',valueKind: 'VALUE',value: inverse?(index?'Vendor':'After'):(index ? 'Old Vendor' : 'Before'),
        observation: { observationId: randomUUID(),source: 'MIRROR_PINNED',observedAt: startedAt,resourceGid: resource,fieldId,
          sourceRevision: null,receiptId: randomUUID(),receiptFingerprint: digest(5) } });
      const intent = normalizeMutationIntent({ identity,binding,beforeSnapshotFingerprint: beforeSnapshot.fingerprint,
        mutationPlanFingerprint: digest(6),intendedValueKind: 'VALUE',intendedValue: writes[index?'vendor':'title'] });
      const attempt = normalizeMutationAttempt({ identity,attemptId,attemptNumber: 1,fenceEpoch: claim.fenceEpoch,executionClaimId: claim.executionClaimId,startedAt });
      return { beforeSnapshot,intent,attempt,resourceFamilyGid: resource };
    });
    const plan = { shopId,installationId,operationId,mutationId,executionJobId: command,editOperationId: edit,executionContractId: contractId,
      operationKind: inverse?'UNDO':'BULK_EDIT',executionFingerprint: digest(1),filterFingerprint: digest(2),fieldResolutionFingerprint: digest(3),
      targetingSnapshotId: selectionId,logicalOperationId: operationId,approvalRevision: 'approval-1',
      itemIntendedValues:writes,
      approvedContractFingerprint: `sha256:${approvedHash}`,mutationPlanFingerprint: digest(6),attemptId,attemptNumber: 1,
      fenceEpoch: claim.fenceEpoch,executionClaimId: claim.executionClaimId,startedAt,
      fields: entries.map(e => ({ identity: e.intent.identity,binding: e.intent.binding,intendedValueKind: e.intent.intendedValueKind,
        intendedValue: e.intent.intendedValue,resourceFamilyGid: e.resourceFamilyGid })) };
    const persistPlan = async value => q(`INSERT INTO history_test_authority.plans(shop_id,installation_id,operation_id,mutation_id,document) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(shop_id,installation_id,operation_id,mutation_id) DO UPDATE SET document=EXCLUDED.document`, [shopId,installationId,operationId,mutationId,JSON.stringify(value)]);
    await persistPlan(plan);
    for (const e of entries) await q('INSERT INTO history_test_authority.observations(shop_id,installation_id,receipt_id,snapshot) VALUES($1,$2,$3,$4)',
      [shopId,installationId,e.beforeSnapshot.observation.receiptId,JSON.stringify(e.beforeSnapshot)]);
    const state = { allowed: true,dispatchAllowed: true,recoveryAllowed: true,readAllowed: true,observations: 0,loads: 0,readActions: [] };
    const adapters = {
      authorityRelations:[{schema:'history_test_authority',table:'plans',lockColumn:'_history_lock'},
        {schema:'history_test_authority',table:'observations',lockColumn:'_history_lock'},{schema:'history_test_authority',table:'evidence'}],
      valueProtection:createHistoryValueProtection({resolveKey:async()=>({key:Buffer.alloc(32,17),keyReference:'fixture-history-v1'})}),
      authorizeHistoryValueRead:async()=>true,
      resolveTenant: async ({ authContext: supplied }) => {
        if (supplied !== authContext) throw new Error('Unauthenticated context');
        return { shopId,installationId };
      },
      loadExecutionPlan: async ({ client,shopId,installationId,operationId,mutationId }) => {
        state.loads++;
        return (await client.query(`SELECT document FROM history_test_authority.plans
          WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 FOR SHARE`,
        [shopId,installationId,operationId,mutationId])).rows[0]?.document ?? null;
      },
      authorizePlan: async () => state.allowed,
      authorizeDispatch: async () => state.dispatchAllowed,
      authorizeRecovery: async () => state.recoveryAllowed,
      loadMutationEvidence: async ({client,tenant,evidenceId}) => (await client.query('SELECT document FROM history_test_authority.evidence WHERE shop_id=$1 AND installation_id=$2 AND evidence_id=$3',
        [tenant.shopId,tenant.installationId,evidenceId])).rows[0]?.document ?? null,
      verifyMutationEvidence: async ({client,tenant,evidence}) => {
        const row=(await client.query('SELECT document,authenticated FROM history_test_authority.evidence WHERE shop_id=$1 AND installation_id=$2 AND evidence_id=$3',
          [tenant.shopId,tenant.installationId,evidence.evidenceId])).rows[0];
        return Boolean(row?.authenticated&&isDeepStrictEqual(row.document,clone(evidence)));
      },
      historyCursorSecret:'fixture-private-history-cursor-key-000000000000000000000000000000',
      authorizeHistoryRead: async ({ operation,tenant,request }) => {
        assert.equal(tenant.shopId,shopId); assert.equal(tenant.installationId,installationId);
        if(request.operationId)assert.equal(request.operationId,operationId); state.readActions.push(operation); return state.readAllowed;
      },
      verifyObservation: async ({ client, snapshot,mirrorSnapshot }) => {
        state.observations++;
        if (mirrorSnapshot) {
          const key = { 'product.title': 'title','product.vendor': 'vendor' }[snapshot.identity.fieldId];
          if (snapshot.value !== mirrorSnapshot.before_values[key]) return false;
        }
        const row = (await client.query(`SELECT snapshot FROM history_test_authority.observations
          WHERE shop_id=$1 AND installation_id=$2 AND receipt_id=$3 FOR SHARE`, [shopId,installationId,snapshot.observation.receiptId])).rows[0];
        return Boolean(row && JSON.stringify(row.snapshot) && assert.deepEqual(row.snapshot, clone(snapshot)) === undefined);
      },
    };
    const repository = createHistoryRepository({ database: pool,...adapters,...options });
    const input = { authContext,operationId,mutationId,claim,entries };
    return { repository,input,plan,persistPlan,state,adapters,shopId,installationId,command,item,contractId,q };
  }
  await t.test('repository requires trusted adapters and rejects caller authority overrides', async () => {
    assert.throws(() => createHistoryRepository({ database: pool }), TypeError);
    const f = await fixture();
    for (const extra of [{ shopId: f.shopId },{ plan: f.plan },{ filterFingerprint: digest(9) }]) {
      await assert.rejects(() => f.repository.prepareRequest({ ...f.input,...extra }), { code: 'HISTORY_INVALID_INPUT' });
    }
  });
  await t.test('repository durably prepares the full request, replays idempotently, and dispatches once', async () => {
    const f = await fixture();
    const prepared = await f.repository.prepareRequest(f.input);
    assert.equal(prepared.state, 'PREPARED'); assert.equal(prepared.fields.length, 2); assert.equal(prepared.existing, false);
    const replay = await f.repository.prepareRequest(f.input);
    assert.equal(replay.existing, true); assert.deepEqual(replay.fields, prepared.fields);
    assert.equal((await f.q('SELECT changes_recorded FROM edit_history.operations WHERE shop_id=$1 AND id=$2', [f.shopId,f.input.operationId])).rows[0].changes_recorded, '2');
    const dispatch = await f.repository.beginDispatch(f.input);
    assert.equal(dispatch.state, 'DISPATCHING');
    await assert.rejects(() => f.repository.beginDispatch(f.input), { code: 'HISTORY_INVALID_TRANSITION' });
  });
  await t.test('repository rejects self-consistent forged engine coordinates and mutated persisted operation', async () => {
    for (const key of ['executionFingerprint','filterFingerprint','fieldResolutionFingerprint']) {
      const f = await fixture();
      const entries = f.input.entries.map(e => {
        const binding = { ...e.beforeSnapshot.binding,[key]: digest(9) };
        const beforeSnapshot = normalizeHistorySnapshot({ identity: e.intent.identity,binding,kind: 'BEFORE',valueKind: 'VALUE',value: e.beforeSnapshot.value,
          observation: Object.fromEntries(['observationId','source','observedAt','resourceGid','fieldId','sourceRevision','receiptId','receiptFingerprint'].map(k => [k,e.beforeSnapshot.observation[k]])) });
        const intent = normalizeMutationIntent({ identity: e.intent.identity,binding,beforeSnapshotFingerprint: beforeSnapshot.fingerprint,
          mutationPlanFingerprint: e.intent.mutationPlanFingerprint,intendedValueKind: 'VALUE',intendedValue: e.intent.intendedValue });
        return { ...e,beforeSnapshot,intent };
      });
      await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries }), { code: 'HISTORY_BINDING_CONFLICT' });
      assert.equal((await f.q('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1', [f.shopId])).rows[0].count, '0');
    }
    const f = await fixture();
    await f.q(`INSERT INTO edit_history.operations(id,shop_id,installation_id,execution_job_id,edit_operation_id,execution_contract_id,
      operation_kind,execution_fingerprint) VALUES($1,$2,$3,$4,$5,$6,'BULK_EDIT',$7)`,
    [f.input.operationId,f.shopId,f.installationId,f.command,f.plan.editOperationId,f.contractId,digest(9)]);
    await assert.rejects(() => f.repository.prepareRequest(f.input), { code: 'HISTORY_BINDING_CONFLICT' });
  });
  await t.test('repository rejects mixed attempts, missing fields and unauthenticated receipts atomically', async () => {
    const f = await fixture();
    const entries = clone(f.input.entries);
    const a = entries[1].attempt;
    entries[1].attempt = normalizeMutationAttempt({ identity: a.identity,attemptId: randomUUID(),attemptNumber: a.attemptNumber,
      fenceEpoch: a.fenceEpoch,executionClaimId: a.executionClaimId,startedAt: a.startedAt });
    await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries }), { code: 'HISTORY_BINDING_CONFLICT' });
    await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries: f.input.entries.slice(0,1) }), { code: 'HISTORY_BINDING_CONFLICT' });
    await f.q('DELETE FROM history_test_authority.observations WHERE shop_id=$1 AND receipt_id=$2', [f.shopId,f.input.entries[1].beforeSnapshot.observation.receiptId]);
    await assert.rejects(() => f.repository.prepareRequest(f.input), { code: 'HISTORY_EVIDENCE_REQUIRED' });
    assert.equal((await f.q('SELECT count(*) FROM edit_history.changes WHERE shop_id=$1', [f.shopId])).rows[0].count, '0');
  });
  await t.test('repository fences expired leases, stale tokens, revoked access and obsolete installations', async () => {
    for (const change of ['fence','token','expiry','cancel','auth','installation','contract']) {
      const f = await fixture();
      if (change === 'fence') await f.q('UPDATE mirror.job_commands SET fence=fence+1 WHERE shop_id=$1 AND id=$2', [f.shopId,f.command]);
      if (change === 'token') f.input.claim.leaseToken = 'forged';
      if (change === 'expiry') await f.q("UPDATE mirror.job_commands SET lease_until=now()-interval '1 second' WHERE shop_id=$1 AND id=$2", [f.shopId,f.command]);
      if (change === 'cancel') await f.q('UPDATE mirror.job_commands SET cancel_requested_at=now() WHERE shop_id=$1 AND id=$2', [f.shopId,f.command]);
      if (change === 'auth') f.state.allowed = false;
      if (change === 'installation') await f.q('UPDATE mirror.shops SET installation_version=$2 WHERE id=$1', [f.shopId,randomUUID()]);
      if (change === 'contract') await f.q("UPDATE mirror.execution_contracts SET status='REVOKED' WHERE shop_id=$1 AND id=$2", [f.shopId,f.contractId]);
      await assert.rejects(() => f.repository.prepareRequest(f.input));
      assert.equal((await f.q('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1', [f.shopId])).rows[0].count, '0');
    }
  });
  await t.test('concurrent full requests have one insertion and one dispatch; partial corruption fails closed', async () => {
    const f = await fixture();
    const results = await Promise.all([f.repository.prepareRequest(f.input),f.repository.prepareRequest(f.input)]);
    assert.deepEqual(results.map(r => r.existing).sort(), [false,true]);
    const outcomes = await Promise.allSettled([f.repository.beginDispatch(f.input),f.repository.beginDispatch(f.input)]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    const invalid = await fixture();
    await invalid.repository.prepareRequest(invalid.input);
    // Model a request admitted by a prior implementation with a different
    // field set: durable authority expands but old rows cannot be overwritten.
    const plan = clone(invalid.plan); plan.fields = plan.fields.slice(0,1); await invalid.persistPlan(plan);
    await assert.rejects(() => invalid.repository.prepareRequest({ ...invalid.input,entries: invalid.input.entries.slice(0,1) }), { code: 'HISTORY_BINDING_CONFLICT' });
  });
  await t.test('failed snapshot insert rolls back operation, changes and counters', async () => {
    const f = await fixture();
    const database = { async connect() {
      const client = await pool.connect();
      return { release: () => client.release(), query: (sql,values) => {
        if (sql.startsWith('INSERT INTO edit_history.snapshots')) return Promise.reject(Object.assign(new Error('forced write failure'), { code: 'XX000' }));
        return client.query(sql,values);
      } };
    } };
    const repo = createHistoryRepository({ database,...f.adapters });
    await assert.rejects(() => repo.prepareRequest(f.input), { code: 'XX000' });
    assert.equal((await f.q('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1', [f.shopId])).rows[0].count, '0');
    assert.equal((await f.q('SELECT count(*) FROM edit_history.changes WHERE shop_id=$1', [f.shopId])).rows[0].count, '0');
  });
  await t.test('every shared-attempt coordinate and authoritative intended value is enforced', async () => {
    const f = await fixture();
    for (const [key,value] of [['attemptId',randomUUID()],['attemptNumber',2],['fenceEpoch','9007199254740994'],['executionClaimId','another-claim'],['startedAt',new Date(Date.now()+1000).toISOString()]]) {
      const entries = clone(f.input.entries), old = entries[1].attempt;
      entries[1].attempt = normalizeMutationAttempt({ identity: old.identity,attemptId: old.attemptId,attemptNumber: old.attemptNumber,
        fenceEpoch: old.fenceEpoch,executionClaimId: old.executionClaimId,startedAt: old.startedAt,[key]: value });
      await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries }), { code: 'HISTORY_BINDING_CONFLICT' });
    }
    for (const replacement of [{ intendedValue: 'Unapproved' },{ mutationPlanFingerprint: digest(9) }]) {
      const entries = clone(f.input.entries), old = entries[1].intent;
      entries[1].intent = normalizeMutationIntent({ identity: old.identity,binding: old.binding,
        beforeSnapshotFingerprint: old.beforeSnapshotFingerprint,mutationPlanFingerprint: old.mutationPlanFingerprint,
        intendedValueKind: old.intendedValueKind,intendedValue: old.intendedValue,...replacement });
      await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries }), { code: 'HISTORY_BINDING_CONFLICT' });
    }
  });
  await t.test('retry admission cannot bypass an uncertain prior attempt', async () => {
    const f = await fixture(); await f.repository.prepareRequest(f.input); await f.repository.beginDispatch(f.input);
    await f.q(`UPDATE edit_history.changes SET mutation_state='OUTCOME_UNKNOWN',last_evidence_kind='AMBIGUOUS',last_evidence_fingerprint=$2
      WHERE shop_id=$1`, [f.shopId,digest(8)]);
    const plan = clone(f.plan); plan.attemptId = randomUUID(); plan.attemptNumber = 2;
    await f.persistPlan(plan);
    const entries = f.input.entries.map(e => ({ ...e,attempt: normalizeMutationAttempt({ identity: e.attempt.identity,
      attemptId: plan.attemptId,attemptNumber: 2,fenceEpoch: e.attempt.fenceEpoch,executionClaimId: e.attempt.executionClaimId,startedAt: e.attempt.startedAt }) }));
    await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries }), { code: 'HISTORY_INVALID_TRANSITION' });
    // Only an authoritative no-write classification opens a retry path.
    await f.q(`UPDATE edit_history.changes SET mutation_state='FAILED_NO_WRITE',last_evidence_kind='AUTHORITATIVE_NO_WRITE',last_evidence_fingerprint=$2 WHERE shop_id=$1`, [f.shopId,digest(8)]);
    const retry = await f.repository.prepareRequest({ ...f.input,entries });
    assert.equal(retry.state, 'PREPARED'); assert.equal(retry.attemptId, plan.attemptId);
  });
  await t.test('lease expiry and authorization revocation during verification roll back admission', async () => {
    for (const condition of ['lease','authorization','approval']) {
      const f = await fixture(condition === 'approval' ? { approvalLifetimeMs: 200 } : {});
      if (condition === 'lease') await f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()+interval '200 milliseconds' WHERE shop_id=$1 AND id=$2", [f.shopId,f.command]);
      let first = true;
      const repo = createHistoryRepository({ database: pool,...f.adapters,verifyObservation: async context => {
        const verified = await f.adapters.verifyObservation(context);
        if (first) { first = false; if (condition !== 'authorization') await context.client.query('SELECT pg_sleep(0.25)'); else f.state.allowed = false; }
        return verified;
      } });
      await assert.rejects(() => repo.prepareRequest(f.input), { code: condition !== 'authorization' ? 'HISTORY_OWNERSHIP_LOST' : 'HISTORY_UNAUTHORIZED' });
      assert.equal((await f.q('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1', [f.shopId])).rows[0].count, '0');
    }
  });
  await t.test('known database conflicts retry aborted work but lost COMMIT is never replayed', async () => {
    for (const conflict of ['40001','P2002','P2034']) {
      const f = await fixture(); let injected = false;
      const database = { async connect() {
        const client = await pool.connect();
        return { release: () => client.release(),query: (sql,values) => {
          if (!injected && sql.startsWith('INSERT INTO edit_history.changes')) {
            injected = true; return Promise.reject(Object.assign(new Error('known transaction failure'), { code: conflict }));
          }
          return client.query(sql,values);
        } };
      } };
      const result = await createHistoryRepository({ database,...f.adapters }).prepareRequest(f.input);
      assert.equal(result.fields.length, 2); assert.equal(f.state.loads, 2);
    }
    const f = await fixture(); await f.repository.prepareRequest(f.input); let commits = 0;
    const database = { async connect() {
      const client = await pool.connect();
      return { release: () => client.release(),query: async (sql,values) => {
        const result = await client.query(sql,values);
        if (sql === 'COMMIT') { commits++; throw Object.assign(new Error('lost COMMIT acknowledgment'), { code: 'ECONNRESET' }); }
        return result;
      } };
    } };
    await assert.rejects(() => createHistoryRepository({ database,...f.adapters }).beginDispatch(f.input), { code: 'ECONNRESET' });
    assert.equal(commits, 1);
    assert.equal((await f.q('SELECT DISTINCT mutation_state FROM edit_history.changes WHERE shop_id=$1', [f.shopId])).rows[0].mutation_state, 'DISPATCHING');
    await assert.rejects(() => f.repository.beginDispatch(f.input), { code: 'HISTORY_INVALID_TRANSITION' });
  });
  await t.test('repository verifies the actual Bulk Edit Engine approval rather than a self-consistent stored hash', async () => {
    const f = await fixture();
    // This digest claims a different authorizing actor while all plan/database
    // fingerprint references agree. The genuine approval verifier must reject it.
    const wrong = computeContractHash({ shopId: f.shopId,snapshotId: f.plan.targetingSnapshotId,operation: 'bulk_edit',
      contract: { updates: { title: 'After',vendor: 'Vendor' } },selectionHash: 'hash',approvedBy: 'someone-else' });
    const plan = clone(f.plan); plan.approvedContractFingerprint = `sha256:${wrong}`;
    // The real immutable approval trigger prevents this update after approval.
    // Instead inject the bad read at the SQL boundary, modeling corrupt/legacy
    // source storage without weakening database triggers globally.
    const database = { async connect() {
      const client = await pool.connect();
      return { release: () => client.release(),query: async (sql,values) => {
        const result = await client.query(sql,values);
        if (sql.includes('SELECT * FROM mirror.execution_contracts') || sql.includes('SELECT c.*, s.selection_hash')) {
          return { ...result,rows: result.rows.map(row => ({ ...row,contract_hash: wrong })) };
        }
        return result;
      } };
    } };
    await f.persistPlan(plan);
    await assert.rejects(() => createHistoryRepository({ database,...f.adapters }).prepareRequest(f.input), { code: 'HISTORY_BINDING_CONFLICT' });
    assert.equal((await f.q('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1',[f.shopId])).rows[0].count,'0');
  });
  await t.test('owned Mirror BEFORE snapshots are verified and stored as explicit durable lineage', async () => {
    const f = await fixture();
    const values = { title: 'Before',vendor: 'Old Vendor' }, beforeHash = createHash('sha256').update(JSON.stringify(values)).digest('hex');
    const snapshotId = (await f.q(`INSERT INTO mirror.product_snapshots(id,shop_id,edit_item_id,before_values,before_hash)
      VALUES(9007199254740993,$1,$2,$3,$4) RETURNING id`,[f.shopId,f.item,JSON.stringify(values),beforeHash])).rows[0].id;
    const plan = clone(f.plan); for (const field of plan.fields) field.mirrorBeforeSnapshotId = snapshotId;
    await f.persistPlan(plan);
    const input = { ...f.input,entries: f.input.entries.map(entry => ({ ...entry,mirrorBeforeSnapshotId: snapshotId })) };
    const receipt = await f.repository.prepareRequest(input);
    for (const field of receipt.fields) {
      assert.equal((await f.q('SELECT mirror_before_snapshot_id FROM edit_history.snapshots WHERE shop_id=$1 AND id=$2',[f.shopId,field.snapshotId])).rows[0].mirror_before_snapshot_id,snapshotId);
      const stored = await f.repository.getSnapshot({ authContext: f.input.authContext,operationId: f.input.operationId,changeId: field.changeId,snapshotId: field.snapshotId });
      assert.equal(stored.mirrorBeforeSnapshotId,snapshotId);
    }
    assert.equal((await f.repository.prepareRequest(input)).existing,true);
    await assert.rejects(() => f.repository.prepareRequest(f.input), { code: 'HISTORY_BINDING_CONFLICT' });
  });
  await t.test('foreign-tenant and same-tenant foreign-item Mirror snapshots cannot be adopted', async () => {
    const f = await fixture(), foreign = await fixture();
    const cases = [
      (await foreign.q(`INSERT INTO mirror.product_snapshots(shop_id,edit_item_id,before_values,before_hash)
        VALUES($1,$2,'{"title":"Before","vendor":"Old Vendor"}',repeat('a',64)) RETURNING id`,[foreign.shopId,foreign.item])).rows[0].id,
    ];
    const otherItem = (await f.q(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,intended_values)
      VALUES($1,$2,'gid://shopify/Product/2','{"title":"After","vendor":"Vendor"}') RETURNING id`,[f.shopId,f.command])).rows[0].id;
    cases.push((await f.q(`INSERT INTO mirror.product_snapshots(shop_id,edit_item_id,before_values,before_hash)
      VALUES($1,$2,'{"title":"Before","vendor":"Old Vendor"}',repeat('a',64)) RETURNING id`,[f.shopId,otherItem])).rows[0].id);
    for (const snapshotId of cases) {
      const plan = clone(f.plan); for (const field of plan.fields) field.mirrorBeforeSnapshotId = snapshotId;
      await f.persistPlan(plan);
      await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries: f.input.entries.map(entry => ({ ...entry,mirrorBeforeSnapshotId: snapshotId })) }), { code: 'HISTORY_BINDING_CONFLICT' });
    }
  });
  await t.test('tenant-scoped reads reconstruct durable requests and snapshots without exposing lease authority', async () => {
    const f = await fixture(), receipt = await f.repository.prepareRequest(f.input),field = receipt.fields[0];
    const operation = await f.repository.getOperation({ authContext: f.input.authContext,operationId: f.input.operationId });
    assert.equal(operation.executionJobId,f.command); assert.equal(operation.counts.recorded,'2'); assert.equal(operation.contractVersion,3);
    const request = await f.repository.getRequest({ authContext: f.input.authContext,operationId: f.input.operationId,mutationId: f.input.mutationId,attemptId: f.plan.attemptId });
    assert.equal(request.fields.length,2); assert.equal(request.state,'PREPARED');
    const snapshot = await f.repository.getSnapshot({ authContext: f.input.authContext,operationId: f.input.operationId,changeId: field.changeId,snapshotId: field.snapshotId });
    assert.equal(snapshot.snapshot.fingerprint,f.input.entries.find(entry => entry.intent.identity.fieldId === field.fieldId).beforeSnapshot.fingerprint);
    assert.ok(Object.isFrozen(operation) && Object.isFrozen(request.fields) && Object.isFrozen(snapshot.snapshot));
    const serialized = JSON.stringify({ operation,request,snapshot });
    for (const secret of ['secret-lease','lease_token','leaseToken','executionClaimId']) assert.ok(!serialized.includes(secret));
    assert.deepEqual(new Set(f.state.readActions),new Set(['read_operation','read_request','read_snapshot']));
  });
  await t.test('reads enforce tenant, installation, exact snapshot ancestry and separate current read authorization', async () => {
    const f = await fixture(),other = await fixture();
    const receipt = await f.repository.prepareRequest(f.input),foreign = await other.repository.prepareRequest(other.input);
    const base = { authContext: f.input.authContext,operationId: f.input.operationId };
    assert.equal(await f.repository.getOperation({ ...base,operationId: other.input.operationId }),null);
    assert.equal(await f.repository.getSnapshot({ ...base,changeId: receipt.fields[0].changeId,snapshotId: foreign.fields[0].snapshotId }),null);
    assert.equal(await f.repository.getSnapshot({ ...base,changeId: receipt.fields[0].changeId,snapshotId: receipt.fields[1].snapshotId }),null);
    f.state.readAllowed = false;
    await assert.rejects(() => f.repository.getOperation(base), { code: 'HISTORY_UNAUTHORIZED' });
    f.state.readAllowed = true;
    await f.q('UPDATE mirror.shops SET installation_version=$2 WHERE id=$1',[f.shopId,randomUUID()]);
    await assert.rejects(() => f.repository.getOperation(base), { code: 'HISTORY_UNAUTHORIZED' });
  });
  await t.test('read access fails closed when no trusted reader exists or authorization changes mid-read', async () => {
    const f = await fixture(); await f.repository.prepareRequest(f.input);
    const base = { authContext: f.input.authContext,operationId: f.input.operationId };
    const { authorizeHistoryRead,...withoutReader } = f.adapters;
    await assert.rejects(() => createHistoryRepository({ database: pool,...withoutReader }).getOperation(base), { code: 'HISTORY_UNAUTHORIZED' });
    let calls = 0;
    const repository = createHistoryRepository({ database: pool,...f.adapters,authorizeHistoryRead: async () => ++calls === 1 });
    await assert.rejects(() => repository.getOperation(base), { code: 'HISTORY_UNAUTHORIZED' });
    assert.equal(calls,2);
    await assert.rejects(() => f.repository.getOperation({ ...base,shopId: f.shopId }), { code: 'HISTORY_INVALID_INPUT' });
  });
  await t.test('snapshot reads reject stored content tampering and unsupported versions instead of trusting a stored digest', async () => {
    const f = await fixture(),receipt = await f.repository.prepareRequest(f.input),field = receipt.fields[0];
    for (const replacement of [{ value_json: 'Tampered' },{ observation_receipt_id: 'forged-receipt' },{ snapshot_version: 2 }]) {
      const database = { async connect() {
        const client = await pool.connect();
        return { release: () => client.release(),query: async (sql,values) => {
          const result = await client.query(sql,values);
          return sql.includes('SELECT s.*,o.execution_job_id') ? { ...result,rows: result.rows.map(row => ({ ...row,...replacement })) } : result;
        } };
      } };
      await assert.rejects(() => createHistoryRepository({ database,...f.adapters }).getSnapshot({
        authContext: f.input.authContext,operationId: f.input.operationId,changeId: field.changeId,snapshotId: field.snapshotId,
      }),{ code: replacement.snapshot_version ? 'HISTORY_UNSUPPORTED_VERSION' : 'HISTORY_BINDING_CONFLICT' });
    }
  });
  await t.test('an owned execution item outside the approved selection cannot enter history even when the plan claims authorization', async () => {
    const f = await fixture({ extraProduct: true });
    const resourceGid = 'gid://shopify/Product/2';
    const item = (await f.q(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,intended_values)
      VALUES($1,$2,$3,'{"title":"After","vendor":"Vendor"}') RETURNING id`,[f.shopId,f.command,resourceGid])).rows[0].id;
    const entries = f.input.entries.map(e => {
      const identity = { ...e.intent.identity,executionItemId: item,resourceGid };
      const observation = Object.fromEntries(['observationId','source','observedAt','fieldId','sourceRevision','receiptId','receiptFingerprint'].map(key => [key,e.beforeSnapshot.observation[key]]));
      observation.resourceGid = resourceGid;
      const beforeSnapshot = normalizeHistorySnapshot({ identity,binding: e.intent.binding,kind: 'BEFORE',valueKind: 'VALUE',value: e.beforeSnapshot.value,observation });
      const intent = normalizeMutationIntent({ identity,binding: e.intent.binding,beforeSnapshotFingerprint: beforeSnapshot.fingerprint,
        mutationPlanFingerprint: e.intent.mutationPlanFingerprint,intendedValueKind: 'VALUE',intendedValue: e.intent.intendedValue });
      const attempt = normalizeMutationAttempt({ identity,attemptId: e.attempt.attemptId,attemptNumber: e.attempt.attemptNumber,
        fenceEpoch: e.attempt.fenceEpoch,executionClaimId: e.attempt.executionClaimId,startedAt: e.attempt.startedAt });
      return { beforeSnapshot,intent,attempt,resourceFamilyGid: resourceGid };
    });
    const plan = clone(f.plan);
    plan.fields = entries.map(e => ({ identity: e.intent.identity,binding: e.intent.binding,intendedValueKind: 'VALUE',intendedValue: e.intent.intendedValue,resourceFamilyGid: resourceGid }));
    await f.persistPlan(plan);
    // Make the receipt fixture agree too, so selection membership is the
    // independently enforced boundary, not a failure caused by stale evidence.
    for (const e of entries) await f.q('UPDATE history_test_authority.observations SET snapshot=$4 WHERE shop_id=$1 AND installation_id=$2 AND receipt_id=$3',
      [f.shopId,f.installationId,e.beforeSnapshot.observation.receiptId,JSON.stringify(e.beforeSnapshot)]);
    await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries }),{
      code: 'HISTORY_BINDING_CONFLICT',message: 'Mutation resource is not part of the exact approved targeting snapshot',
    });
    assert.equal((await f.q('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1',[f.shopId])).rows[0].count,'0');
  });
  await testRepositoryQa(t,fixture,pool);
  await testExecutionAuthority(t,fixture,pool);
  await testRepositoryAuthority(t,fixture,pool);
  await testWorkerExecution(t,fixture,pool);
  await testHistorySecurity(t,fixture,pool,adminPool);
  }finally{await runtimePool.end();}
}
