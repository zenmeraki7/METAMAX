import {lockPublication} from '../../mirror/publication-lock.server.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryRepository } from '../history-repository.server.js';
import { createChangeJournalRepository } from '../change-journal.server.js';
import { normalizeHistorySnapshot,normalizeMutationIntent,normalizeMutationAttempt } from '../history-contract.js';
import { createHistoryHookInvoker } from '../transaction-hooks.server.js';

function fixture() {
  let connections = 0;
  const database = { async connect() { connections++; throw Error('Unexpected database acquisition'); } };
  const adapters = { database,resolveTenant: async () => null,loadExecutionPlan: async () => null,
    authorizePlan: async () => false,verifyObservation: async () => false };
  const H = `sha256:${'a'.repeat(64)}`,time = '2026-10-30T00:00:00.000Z';
  const identity = { shopId: 'repo.myshopify.com',installationId: 'install-1',executionJobId: '1',executionItemId: '2',
    mutationId: 'mutation-1',resourceGid: 'gid://shopify/Product/1',fieldId: 'product.title' };
  const binding = { mode: 'SHOPIFY_DIRECT',filterFingerprint: H,executionFingerprint: H,fieldResolutionFingerprint: H,fieldDefinitionRevision: 'registry-1' };
  const beforeSnapshot = normalizeHistorySnapshot({ identity,binding,kind: 'BEFORE',valueKind: 'VALUE',value: 'Before',
    observation: { observationId: 'obs-1',source: 'SHOPIFY_GRAPHQL',observedAt: time,resourceGid: identity.resourceGid,fieldId: identity.fieldId,receiptId: 'receipt-1',receiptFingerprint: H } });
  const intent = normalizeMutationIntent({ identity,binding,beforeSnapshotFingerprint: beforeSnapshot.fingerprint,intendedValueKind: 'VALUE',intendedValue: 'After',mutationPlanFingerprint: H });
  const attempt = normalizeMutationAttempt({ identity,attemptId: 'attempt-1',attemptNumber: 1,fenceEpoch: '1',executionClaimId: 'claim-1',startedAt: time });
  const entry = { beforeSnapshot,intent,attempt,resourceFamilyGid: identity.resourceGid };
  const input = { authContext: {},operationId: '12345678-1234-4234-8234-123456789abc',mutationId: identity.mutationId,
    claim: { fenceEpoch: '1',executionClaimId: 'claim-1',leaseToken: 'private-lease' },entries: [entry] };
  return { adapters,input,entry,repository: createHistoryRepository(adapters),connections: () => connections };
}
test('history repository owns the implementation and preserves the old journal factory API', () => {
  assert.equal(createChangeJournalRepository,createHistoryRepository);
  const { repository } = fixture(); assert.ok(Object.isFrozen(repository));
  for(const name of ['beginDispatch','getOperation','getRequest','getSnapshot','prepareRequest','recordVerifiedNoWrite','recordMutationOutcome','recordVerification','scheduleOutcomeRecovery','consumeDispatch',
    'claimOutcomeRecovery','retryOutcomeRecovery','renewOutcomeRecovery','cancelOutcomeRecovery','discoverOutcomeRecovery','listOperations','listChanges'])assert.equal(typeof repository[name],'function');
  assert.equal(Object.hasOwn(repository,'query'),false);
});
test('repository construction requires trusted write adapters and validates an optional read adapter', () => {
  const { adapters } = fixture();
  for (const name of ['database','resolveTenant','loadExecutionPlan','authorizePlan','verifyObservation']) assert.throws(() => createHistoryRepository({ ...adapters,[name]: undefined }),TypeError);
  assert.throws(() => createHistoryRepository({ ...adapters,authorizeHistoryRead: true }),TypeError);
});
test('caller transaction, SQL, plan and tenant overrides fail before acquiring a database connection', async () => {
  const f = fixture();
  for (const extra of [{ client: {} },{ sql: 'SELECT anything' },{ plan: {} },{ shopId: 'forged.myshopify.com' },{ installationId: 'forged' }]) {
    await assert.rejects(() => f.repository.prepareRequest({ ...f.input,...extra }),{ code: 'HISTORY_INVALID_INPUT' });
  }
  assert.equal(f.connections(),0);
});
test('sparse, decorated and accessor entry arrays fail without invoking caller code', async () => {
  const f = fixture(); let reads = 0;
  const accessor = []; Object.defineProperty(accessor,'0',{ enumerable: true,get() { reads++; return f.entry; } });
  const decorated = [f.entry]; decorated.extra = true;
  const sparse = new Array(1);
  for (const entries of [accessor,decorated,sparse]) await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries }),{ code: 'HISTORY_INVALID_INPUT' });
  assert.equal(reads,0); assert.equal(f.connections(),0);
});
test('Mirror snapshot references require exact positive bigint strings', async () => {
  const f = fixture();
  for (const mirrorBeforeSnapshotId of [0,1,1n,'0','01','snapshot-1','9223372036854775808']) {
    await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries: [{ ...f.entry,mirrorBeforeSnapshotId }] }),{ code: 'HISTORY_INVALID_INPUT' });
  }
  assert.equal(f.connections(),0);
});
test('observation accessors are rejected before entry normalization can read them', async () => {
  const f = fixture(); let reads = 0;
  const observation = { ...f.entry.beforeSnapshot.observation };
  Object.defineProperty(observation,'receiptId',{ enumerable: true,get() { reads++; return 'forged'; } });
  await assert.rejects(() => f.repository.prepareRequest({ ...f.input,entries: [{ ...f.entry,beforeSnapshot: { ...f.entry.beforeSnapshot,observation } }] }),{ code: 'HISTORY_INVALID_INPUT' });
  assert.equal(reads,0); assert.equal(f.connections(),0);
});
test('read methods do not borrow write authorization or accept browser scope overrides', async () => {
  const f = fixture(), base = { authContext: {},operationId: f.input.operationId };
  await assert.rejects(() => f.repository.getOperation(base),{ code: 'HISTORY_UNAUTHORIZED' });
  await assert.rejects(() => f.repository.getOperation({ ...base,shopId: 'forged' }),{ code: 'HISTORY_INVALID_INPUT' });
  assert.equal(f.connections(),0);
});
test('authority callback clients expire at completion and cannot commit repository transactions',async()=>{
 let queries=0,retained;
 const invoke=createHistoryHookInvoker({async query(){queries++;return {rows:[]};}},{budgetMs:1000,hookMs:50});
 assert.equal(await invoke(async({client})=>{retained=client;await client.query('SELECT 1');return true;},{}),true);
 await assert.rejects(()=>retained.query('SELECT 1'),{code:'HISTORY_OWNERSHIP_LOST'});
 await assert.rejects(()=>invoke(({client})=>client.query('COMMIT'),{}),{code:'HISTORY_UNAUTHORIZED'});assert.equal(queries,1);
 await assert.rejects(()=>invoke(({client})=>client.query('SELECT 1; COMMIT'),{}),{code:'HISTORY_UNAUTHORIZED'});assert.equal(queries,1);
});
test('a timed-out callback cannot keep using a released transaction client',async()=>{
 let retained,queries=0;
 const invoke=createHistoryHookInvoker({async query(){queries++;return {rows:[]};}},{budgetMs:100,hookMs:20});
 await assert.rejects(()=>invoke(({client})=>{retained=client;return new Promise(()=>{});},{}),{code:'HISTORY_OWNERSHIP_LOST'});
 await assert.rejects(()=>retained.query('SELECT 1'),{code:'HISTORY_OWNERSHIP_LOST'});assert.equal(queries,0);
});


test('history publication capability locks only its captured tenant and expires with the callback',async()=>{
 const statements=[];let retained;
 const invoke=createHistoryHookInvoker({async query(sql,values){statements.push({sql,values});return{rows:[]};}});
 const tenant={shopId:'a.myshopify.com'};
 await invoke(async({client,tenant:mutable})=>{
  retained=client;await lockPublication(client,'a.myshopify.com');
  mutable.shopId='b.myshopify.com';
  await assert.rejects(()=>lockPublication(client,'b.myshopify.com'),{code:'HISTORY_UNAUTHORIZED'});
  await assert.rejects(()=>lockPublication(client,'a.myshopify.com',{write:true}),{code:'HISTORY_UNAUTHORIZED'});
  await assert.rejects(()=>client.query('LOCK TABLE mirror.products IN ACCESS SHARE MODE'),{code:'HISTORY_UNAUTHORIZED'});
 },{tenant});
 assert.equal(statements.length,3);assert.match(statements[0].sql,/LOCK TABLE "mirror"."publications" IN ACCESS SHARE MODE/);
 await assert.rejects(()=>lockPublication(retained,'a.myshopify.com'),{code:'HISTORY_OWNERSHIP_LOST'});assert.equal(statements.length,3);
});
