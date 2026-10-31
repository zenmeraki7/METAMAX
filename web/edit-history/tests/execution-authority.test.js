import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryExecutionAuthority } from '../execution-authority.server.js';
import { normalizeHistorySnapshot, normalizeMutationIntent, normalizeMutationAttempt } from '../history-contract.js';

const H = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const TIME = '2026-10-30T00:00:00.000Z';
const LOCK = 'AUTHORITATIVE_EXECUTION_JOB_UNTIL_TRANSACTION_END';
const clone = value => JSON.parse(JSON.stringify(value));
function entry(fieldId = 'product.title', options = {}) {
  const identity = { shopId: 'authority.myshopify.com', installationId: 'install-1', executionJobId: '9007199254740993',
    executionItemId: '9223372036854775807', mutationId: 'mutation-1', resourceGid: 'gid://shopify/Product/1', fieldId, ...options.identity };
  const binding = { mode: 'MIRROR_PINNED', executionFingerprint: H, filterFingerprint: H, fieldResolutionFingerprint: H,
    fieldDefinitionRevision: 'definition-1', generationId: 'generation-1', coverageRevision: 'coverage-1', mappingVersion: 'mapping-1', ...options.binding };
  const beforeSnapshot = normalizeHistorySnapshot({ identity, binding, kind: 'BEFORE', valueKind: 'VALUE', value: 'Before',
    observation: { observationId: `observation-${identity.resourceGid}-${fieldId}`, source: 'MIRROR_PINNED', observedAt: TIME,
      resourceGid: identity.resourceGid, fieldId, receiptId: `receipt-${identity.resourceGid}-${fieldId}`, receiptFingerprint: H } });
  const intendedValueKind = options.absent ? 'ABSENT' : 'VALUE';
  const intent = normalizeMutationIntent({ identity, binding, beforeSnapshotFingerprint: beforeSnapshot.fingerprint,
    intendedValueKind, ...(options.absent ? {} : { intendedValue: Object.hasOwn(options, 'value') ? options.value : 'After' }), mutationPlanFingerprint: H });
  const attempt = normalizeMutationAttempt({ identity, attemptId: 'attempt-1', attemptNumber: 1,
    fenceEpoch: '9007199254740993', executionClaimId: 'claim-1', startedAt: TIME, ...options.attempt });
  return { beforeSnapshot, intent, attempt, resourceFamilyGid: options.family ?? identity.resourceGid };
}
function fixture(entries = [entry(), entry('product.vendor')]) {
  const authContext = Object.freeze({ session: 'trusted-session' });
  const tenant = { shopId: entries[0].intent.identity.shopId, installationId: entries[0].intent.identity.installationId };
  const plan = { ...tenant, executionJobId: '9007199254740993', executionItemId: '9223372036854775807', editOperationId: '2',
    executionContractId: 'contract-1', mutationId: 'mutation-1', mutationPlanFingerprint: H, executionFingerprint: H, filterFingerprint: H,
    approvedContractFingerprint: H, attemptId: 'attempt-1', attemptNumber: 1, fenceEpoch: '9007199254740993', executionClaimId: 'claim-1', startedAt: TIME,
    fields: entries.map(e => ({ identity: clone(e.intent.identity), binding: clone(e.intent.binding), resourceFamilyGid: e.resourceFamilyGid,
      mutationPlanFingerprint: H, intendedValueKind: e.intent.intendedValueKind,
      ...(Object.hasOwn(e.intent, 'intendedValue') ? { intendedValue: clone(e.intent.intendedValue) } : {}) })) };
  const receipts = new Map(entries.map(e => [e.beforeSnapshot.observation.receiptId, clone(e.beforeSnapshot)]));
  const calls = { tenant: 0, installation: 0, ownership: 0, authorization: 0, observation: 0, queries: 0 };
  const client = { async query() { calls.queries++; return { rows: [] }; } };
  const input = { client, authContext, executionJobId: plan.executionJobId, mutationId: plan.mutationId,
    claim: { fenceEpoch: plan.fenceEpoch, executionClaimId: plan.executionClaimId, leaseToken: 'private-lease' }, entries };
  const adapters = {
    async resolveTenant(context) { calls.tenant++; assert.equal(context.authContext, authContext); return { ...tenant }; },
    async verifyInstallation({ tenant }) { calls.installation++; return { ...tenant, verified: true, current: true }; },
    async loadApprovedExecutionPlan() { return clone(plan); },
    async verifyExecutionOwnership({ tenant, plan, claim }) { calls.ownership++; return { ...tenant, verified: true,
      executionJobId: plan.executionJobId, executionItemId: plan.executionItemId, mutationId: plan.mutationId,
      ...claim, lockScope: LOCK }; },
    async verifyFieldAuthorization({ tenant, plan }) { calls.authorization++; return { ...tenant, verified: true,
      executionJobId: plan.executionJobId, mutationId: plan.mutationId, approvedPlanFingerprint: plan.mutationPlanFingerprint }; },
    async verifyObservationProvenance({ tenant, beforeSnapshot }) {
      calls.observation++;
      const stored = receipts.get(beforeSnapshot.observation.receiptId);
      if (!stored) return { ...tenant, verified: false };
      assert.deepEqual(clone(beforeSnapshot), stored);
      return { ...tenant, verified: true, observationId: stored.observation.observationId,
        snapshotFingerprint: stored.fingerprint, evidenceBindingFingerprint: stored.evidenceBindingFingerprint,
        receiptFingerprint: stored.observation.receiptFingerprint };
    },
  };
  return { input, plan, tenant, adapters, calls, receipts, authority: overrides => createHistoryExecutionAuthority({ ...adapters, ...overrides }) };
}

test('authority requires all six trusted adapters and rejects decorated dependency records', () => {
  const f = fixture();
  for (const key of Object.keys(f.adapters)) {
    const adapters = { ...f.adapters }; delete adapters[key];
    assert.throws(() => createHistoryExecutionAuthority(adapters), TypeError);
  }
  assert.throws(() => f.authority({ browserPlan: {} }), { code: 'HISTORY_INVALID_INPUT' });
});

test('admission returns frozen scoped metadata without issuing a lease or executing SQL', async () => {
  const f = fixture(); const result = await f.authority().authorizeAdmission(f.input);
  assert.equal(result.contractVersion, 3); assert.equal(result.executionJobId, '9007199254740993');
  assert.equal(result.executionItemId, '9223372036854775807'); assert.equal(result.fields.length, 2);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.fields) && Object.isFrozen(result.fields[0].binding));
  assert.ok(!JSON.stringify(result).includes('private-lease')); assert.equal(f.calls.queries, 0);
  assert.deepEqual(f.calls, { tenant: 2, installation: 2, ownership: 2, authorization: 2, observation: 2, queries: 0 });
});

test('browser scope/SQL overrides and getters fail before trusted adapters run', async () => {
  const f = fixture(); let reads = 0;
  const getter = { ...f.input }; Object.defineProperty(getter, 'entries', { enumerable: true, get() { reads++; return []; } });
  for (const input of [getter, { ...f.input, shopId: f.tenant.shopId }, { ...f.input, sql: 'SELECT 1' },
    { ...f.input, plan: f.plan }, { ...f.input, [Symbol('extra')]: true }, undefined]) {
    await assert.rejects(() => f.authority().authorizeAdmission(input), { code: 'HISTORY_INVALID_INPUT' });
  }
  assert.equal(reads, 0); assert.equal(f.calls.tenant, 0);
});

test('all bigint coordinates use exact positive signed-64-bit decimal strings', async () => {
  for (const value of [1, 1n, '0', '01', '-1', '1e3', '9223372036854775808', '9'.repeat(1000)]) {
    const f = fixture();
    await assert.rejects(() => f.authority().authorizeAdmission({ ...f.input, executionJobId: value }), { code: 'HISTORY_INVALID_INPUT' });
    await assert.rejects(() => f.authority().authorizeAdmission({ ...f.input, claim: { ...f.input.claim, fenceEpoch: value } }), { code: 'HISTORY_INVALID_INPUT' });
    assert.equal(f.calls.tenant, 0);
  }
  const f = fixture(); f.plan.executionItemId = 1;
  await assert.rejects(() => f.authority().authorizeAdmission(f.input), { code: 'HISTORY_INVALID_INPUT' });
});

test('sparse, decorated, accessor and excessive field arrays are rejected without invoking getters', async () => {
  const f = fixture(), sparse = new Array(1), decorated = [entry()]; decorated.extra = true;
  let reads = 0; const getter = [entry()]; Object.defineProperty(getter, '0', { enumerable: true, get() { reads++; return entry(); } });
  for (const entries of [sparse, decorated, getter, [], Array.from({ length: 65 }, () => entry())]) {
    await assert.rejects(() => f.authority().authorizeAdmission({ ...f.input, entries }));
  }
  assert.equal(reads, 0); assert.equal(f.calls.tenant, 0);
});

test('duplicate, missing, extra and rehashed forged intended fields cannot match an approved plan', async () => {
  const f = fixture();
  for (const entries of [[f.input.entries[0]], [f.input.entries[0], f.input.entries[0]],
    [...f.input.entries, entry('product.handle')], [entry('product.title', { value: 'Forged' }), f.input.entries[1]]]) {
    await assert.rejects(() => f.authority().authorizeAdmission({ ...f.input, entries }), { code: 'HISTORY_BINDING_CONFLICT' });
  }
});

test('resource/field pairs allow the same field on separately approved resources', async () => {
  const f = fixture([entry(), entry('product.title', { identity: { resourceGid: 'gid://shopify/Product/2' } })]);
  const result = await f.authority().authorizeAdmission(f.input);
  assert.equal(result.fields[0].fieldId, result.fields[1].fieldId);
  assert.notEqual(result.fields[0].resourceGid, result.fields[1].resourceGid);
});

test('mixed plan scope, engine coordinates and duplicate approved fields fail closed', async () => {
  const changes = [p => { p.installationId = 'other'; }, p => { p.executionJobId = '3'; }, p => { p.mutationId = 'other'; },
    p => { p.fields[1].identity.executionItemId = '3'; }, p => { p.fields[1].binding.filterFingerprint = OTHER; },
    p => { p.fields[1].binding.executionFingerprint = OTHER; }, p => { p.fields[1].mutationPlanFingerprint = OTHER; },
    p => { p.fields[1] = clone(p.fields[0]); }, p => { p.fields[1].binding.fieldResolutionFingerprint = OTHER; },
    p => { p.fields[1].resourceFamilyGid = 'gid://shopify/Product/2'; }];
  for (const change of changes) {
    const f = fixture(); change(f.plan);
    await assert.rejects(() => f.authority().authorizeAdmission(f.input), { code: 'HISTORY_BINDING_CONFLICT' });
  }
});

test('all fields share the admitted attempt and the submitted private claim', async () => {
  for (const key of ['attemptId', 'attemptNumber', 'fenceEpoch', 'executionClaimId', 'startedAt']) {
    const f = fixture(), options = { attempt: { [key]: ({ attemptId: 'other', attemptNumber: 2, fenceEpoch: '2', executionClaimId: 'other', startedAt: '2026-10-30T00:01:00.000Z' })[key] } };
    await assert.rejects(() => f.authority().authorizeAdmission({ ...f.input, entries: [f.input.entries[0], entry('product.vendor', options)] }), { code: 'HISTORY_BINDING_CONFLICT' });
  }
  const f = fixture();
  await assert.rejects(() => f.authority().authorizeAdmission({ ...f.input, claim: { ...f.input.claim, fenceEpoch: '2' } }), { code: 'HISTORY_OWNERSHIP_LOST' });
});

test('plan timestamps and record budgets are checked before ownership and field authorization', async () => {
  const f = fixture(); f.plan.startedAt = 'yesterday';
  await assert.rejects(() => f.authority().authorizeAdmission(f.input), { code: 'HISTORY_INVALID_INPUT' });
  assert.equal(f.calls.ownership, 0); assert.equal(f.calls.authorization, 0);
  const large = fixture(); large.plan.fields[0].intendedValue = 'x'.repeat(32769);
  await assert.rejects(() => large.authority().authorizeAdmission(large.input), { code: 'HISTORY_LIMIT_EXCEEDED' });
});

test('null and absent intended values remain distinct', async () => {
  for (const options of [{ value: null }, { absent: true }]) {
    const f = fixture([entry('product.title', options)]);
    assert.equal((await f.authority().authorizeAdmission(f.input)).fields.length, 1);
  }
  const f = fixture([entry('product.title', { value: null })]);
  await assert.rejects(() => f.authority().authorizeAdmission({ ...f.input, entries: [entry('product.title', { absent: true })] }), { code: 'HISTORY_BINDING_CONFLICT' });
});

test('proof producers must bind installation, locked ownership, permission and receipt to this request', async () => {
  for (const [name, change, code] of [
    ['verifyInstallation', p => { p.current = false; }, 'HISTORY_UNAUTHORIZED'],
    ['verifyExecutionOwnership', p => { p.lockScope = 'ORDINARY_SELECT'; }, 'HISTORY_OWNERSHIP_LOST'],
    ['verifyExecutionOwnership', p => { p.leaseToken = 'foreign-lease'; }, 'HISTORY_OWNERSHIP_LOST'],
    ['verifyExecutionOwnership', p => { p.executionItemId = '3'; }, 'HISTORY_OWNERSHIP_LOST'],
    ['verifyFieldAuthorization', p => { p.approvedPlanFingerprint = OTHER; }, 'HISTORY_UNAUTHORIZED'],
    ['verifyObservationProvenance', p => { p.receiptFingerprint = OTHER; }, 'HISTORY_EVIDENCE_CONFLICT'],
  ]) {
    const f = fixture(); const authority = f.authority({ [name]: async context => { const proof = await f.adapters[name](context); change(proof); return proof; } });
    await assert.rejects(() => authority.authorizeAdmission(f.input), { code });
  }
  const f = fixture(); f.receipts.clear();
  await assert.rejects(() => f.authority().authorizeAdmission(f.input), { code: 'HISTORY_EVIDENCE_CONFLICT' });
});

test('revocation and ownership expiry during asynchronous provenance verification reject admission', async () => {
  for (const kind of ['installation', 'authorization', 'ownership', 'tenant']) {
    const f = fixture(); let changed = false;
    const authority = f.authority({
      verifyObservationProvenance: async context => { const proof = await f.adapters.verifyObservationProvenance(context); changed = true; return proof; },
      verifyInstallation: async context => ({ ...await f.adapters.verifyInstallation(context), current: !(changed && kind === 'installation') }),
      verifyFieldAuthorization: async context => ({ ...await f.adapters.verifyFieldAuthorization(context), verified: !(changed && kind === 'authorization') }),
      verifyExecutionOwnership: async context => ({ ...await f.adapters.verifyExecutionOwnership(context), verified: !(changed && kind === 'ownership') }),
      resolveTenant: async context => ({ ...await f.adapters.resolveTenant(context), ...(changed && kind === 'tenant' ? { installationId: 'other' } : {}) }),
    });
    await assert.rejects(() => authority.authorizeAdmission(f.input), { code: ({ installation: 'HISTORY_UNAUTHORIZED', authorization: 'HISTORY_UNAUTHORIZED', ownership: 'HISTORY_OWNERSHIP_LOST', tenant: 'HISTORY_BINDING_CONFLICT' })[kind] });
  }
});

test('callback clients use the supplied connection and expire without committing or releasing it', async () => {
  const f = fixture(); let saved;
  const authority = f.authority({ verifyExecutionOwnership: async context => {
    saved = context.client; assert.equal(context.client.release, undefined); assert.ok(context.signal instanceof AbortSignal);
    await context.client.query('SELECT 1');
    await assert.rejects(() => context.client.query('SELECT 1; COMMIT'), { code: 'HISTORY_UNAUTHORIZED' });
    return f.adapters.verifyExecutionOwnership(context);
  } });
  await authority.authorizeAdmission(f.input); assert.equal(f.calls.queries, 2);
  await assert.rejects(() => saved.query('SELECT 1'), { code: 'HISTORY_OWNERSHIP_LOST' });
  await f.input.client.query('SELECT 1'); assert.equal(f.calls.queries, 3);
});
