import test from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../history-contract.js';

const H = `sha256:${'a'.repeat(64)}`, OTHER = `sha256:${'b'.repeat(64)}`;
const time = '2026-10-30T00:00:00.000Z';
const identity = () => ({ shopId: 'contract.myshopify.com',installationId: 'install-1',executionJobId: '9007199254740993',
  executionItemId: '9223372036854775807',mutationId: 'mutation-1',resourceGid: 'gid://shopify/Product/1',fieldId: 'product.title' });
const binding = () => ({ mode: 'MIRROR_PINNED',filterFingerprint: H,executionFingerprint: H,fieldResolutionFingerprint: H,
  fieldDefinitionRevision: 'definition-1',generationId: 'generation-1',coverageRevision: 'coverage-1',mappingVersion: 'mapping-1' });
const observation = () => ({ observationId: 'observation-1',source: 'MIRROR_PINNED',observedAt: time,
  resourceGid: identity().resourceGid,fieldId: identity().fieldId,receiptId: 'receipt-1',receiptFingerprint: H });
function snapshot(options = {}) {
  return contract.normalizeHistorySnapshot({ identity: identity(),binding: binding(),kind: 'BEFORE',valueKind: 'VALUE',value: 'Before',observation: observation(),...options });
}
function intent(before, options = {}) {
  return contract.normalizeMutationIntent({ identity: before.identity,binding: before.binding,beforeSnapshotFingerprint: before.fingerprint,
    intendedValueKind: 'VALUE',intendedValue: 'After',mutationPlanFingerprint: H,...options });
}
const attempt = options => ({ identity: identity(),attemptId: 'attempt-1',attemptNumber: 1,fenceEpoch: '9007199254740993',executionClaimId: 'claim-1',startedAt: time,...options });
const rejects = (fn, code = 'HISTORY_INVALID_INPUT') => assert.throws(fn, { name: 'HistoryContractError',code });

test('V3 fingerprint protocol has a stable golden vector and separated domains', () => {
  assert.equal(contract.HISTORY_CONTRACT_VERSION, 3); assert.equal(contract.HISTORY_SNAPSHOT_VERSION, 3);
  assert.equal(contract.HISTORY_FINGERPRINT_SCHEME, 'metamax-history-sha256-v3');
  const expected = 'sha256:dfa30b2fd1a8280f1d9275ad7b6c20e8deb3e5c0d2cccaa672b19a2d96906b68';
  assert.equal(contract.historyFingerprint({ b: 2,a: 1 }, 'vector'), expected);
  assert.equal(contract.historyFingerprint({ a: 1,b: 2 }, 'vector'), expected);
  assert.notEqual(contract.historyFingerprint({ a: 1,b: 2 }, 'other-domain'), expected);
  assert.notEqual(contract.historyFingerprint([1,2]), contract.historyFingerprint([2,1]));
});
test('native readers and writes reject legacy and future versions explicitly', () => {
  assert.equal(contract.assertHistoryVersion(3), true); assert.equal(contract.requireHistoryReader(3), 3);
  for (const value of [1,2,4]) {
    rejects(() => contract.assertHistoryVersion(value), 'HISTORY_UNSUPPORTED_VERSION');
    rejects(() => contract.requireHistoryReader(value), 'HISTORY_UNSUPPORTED_VERSION');
  }
  assert.ok(Object.isFrozen(contract.HISTORY_VERSION_POLICY.nativeReadVersions));
});
test('execution identifiers retain exact bigint digits and reject opaque or lossy forms', () => {
  const normalized = contract.normalizeHistoryIdentity(identity());
  assert.equal(normalized.executionJobId, '9007199254740993');
  assert.equal(normalized.executionItemId, '9223372036854775807');
  for (const key of ['executionJobId','executionItemId']) for (const value of ['job-1','item-1','gid://shopify/Product/1','0','-1','01','1e3','1.0',' 1','9223372036854775808',1,1n,Number.MAX_SAFE_INTEGER+1,null]) {
    rejects(() => contract.normalizeHistoryIdentity({ ...identity(),[key]: value }));
  }
});
test('record validation rejects accessors, hidden keys, symbols and inherited records without reading getters', () => {
  let reads = 0;
  const accessor = { ...identity() }; Object.defineProperty(accessor,'shopId',{ enumerable: true,get() { reads++; return 'forged'; } });
  const hidden = { ...identity() }; Object.defineProperty(hidden,'sql',{ value: 'SELECT anything',enumerable: false });
  for (const value of [accessor,hidden,{ ...identity(),[Symbol('extra')]: true },Object.create(identity()),{ ...identity(),column: 'title' }]) rejects(() => contract.normalizeHistoryIdentity(value));
  assert.equal(reads, 0);
});
test('IDs enforce UTF-8 byte limits and control-character restrictions', () => {
  assert.equal(contract.requireHistoryId('é'.repeat(256)), 'é'.repeat(256));
  for (const value of ['', ' spaced', 'trailing ', 'bad\u0000id', 'bad\nid', 'é'.repeat(257)]) rejects(() => contract.requireHistoryId(value));
});
test('canonical JSON is detached, deeply frozen, deterministic and normalizes negative zero', () => {
  const source = { z: [{ b: true,a: -0 }] }, result = contract.canonicalHistoryJson(source);
  source.z[0].b = false;
  assert.equal(result.z[0].b, true); assert.equal(Object.is(result.z[0].a,-0), false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.z) && Object.isFrozen(result.z[0]));
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(contract.historyFingerprint({ b: true,a: -0 }), contract.historyFingerprint({ a: 0,b: true }));
});
test('canonical JSON rejects non-JSON numbers, cycles, aliases, prototypes and sparse arrays', () => {
  const shared = {}, cyclic = {}; cyclic.self = cyclic;
  const sparse = new Array(2); sparse[1] = 1;
  const decorated = [1]; decorated.extra = 2;
  for (const value of [NaN,Infinity,Number.MAX_SAFE_INTEGER+1,undefined,1n,() => {},new Date(),cyclic,{ a: shared,b: shared },sparse,decorated,
    JSON.parse('{"__proto__":1}'),{ constructor: 'unsafe' },{ prototype: 'unsafe' }]) rejects(() => contract.canonicalHistoryJson(value));
});
test('canonical JSON enforces node, depth and UTF-8 byte budgets without invoking accessors', () => {
  rejects(() => contract.canonicalHistoryJson({ a: { b: 1 } }, { maxDepth: 1 }), 'HISTORY_LIMIT_EXCEEDED');
  rejects(() => contract.canonicalHistoryJson([1,2], { maxNodes: 2 }), 'HISTORY_LIMIT_EXCEEDED');
  rejects(() => contract.canonicalHistoryJson('é', { maxBytes: 3 }), 'HISTORY_LIMIT_EXCEEDED');
  let reads = 0; const value = {}; Object.defineProperty(value,'a',{ enumerable: true,get() { reads++; return 1; } });
  rejects(() => contract.canonicalHistoryJson(value)); assert.equal(reads, 0);
});
test('mirror, direct and execution bindings require complete exclusive coordinates', () => {
  assert.equal(contract.normalizeHistoryBinding(binding()).generationId, 'generation-1');
  for (const key of ['generationId','coverageRevision','mappingVersion']) rejects(() => contract.normalizeHistoryBinding({ ...binding(),[key]: null }));
  const { generationId,coverageRevision,mappingVersion,...base } = binding();
  assert.equal(contract.normalizeHistoryBinding({ ...base,mode: 'SHOPIFY_DIRECT' }).generationId, null);
  assert.equal(contract.normalizeHistoryBinding({ ...base,mode: 'EXECUTION_SNAPSHOT',executionSnapshotId: 'snapshot-1' }).executionSnapshotId, 'snapshot-1');
  rejects(() => contract.normalizeHistoryBinding({ ...binding(),mode: 'SHOPIFY_DIRECT' }), 'HISTORY_BINDING_CONFLICT');
  rejects(() => contract.normalizeHistoryBinding({ ...base,mode: 'EXECUTION_SNAPSHOT' }));
  rejects(() => contract.normalizeHistoryBinding({ ...binding(),executionSnapshotId: 'mixed' }));
  for (const key of ['filterFingerprint','executionFingerprint','fieldResolutionFingerprint']) rejects(() => contract.normalizeHistoryBinding({ ...binding(),[key]: 'browser-hash' }));
});
test('VALUE null, ABSENT and false have different fingerprints and strict value presence', () => {
  const valueNull = snapshot({ value: null }), valueFalse = snapshot({ value: false });
  const absent = contract.normalizeHistorySnapshot({ identity: identity(),binding: binding(),kind: 'BEFORE',valueKind: 'ABSENT',observation: observation() });
  assert.notEqual(valueNull.fingerprint, absent.fingerprint); assert.notEqual(valueNull.fingerprint, valueFalse.fingerprint);
  assert.equal(Object.hasOwn(absent,'value'), false);
  rejects(() => snapshot({ valueKind: 'ABSENT' }));
  const { value,...missing } = { identity: identity(),binding: binding(),kind: 'BEFORE',valueKind: 'VALUE',observation: observation(),value: null };
  rejects(() => contract.normalizeHistorySnapshot(missing));
});
test('observation receipt changes update evidence binding but preserve the captured-value fingerprint', () => {
  const a = snapshot(), b = snapshot({ observation: { ...observation(),receiptId: 'receipt-2' } });
  assert.equal(a.fingerprint, b.fingerprint); assert.notEqual(a.evidenceBindingFingerprint, b.evidenceBindingFingerprint);
  rejects(() => snapshot({ observation: { ...observation(),fieldId: 'product.vendor' } }), 'HISTORY_EVIDENCE_CONFLICT');
  rejects(() => snapshot({ observation: { ...observation(),source: 'SHOPIFY_GRAPHQL' } }), 'HISTORY_EVIDENCE_CONFLICT');
  for (const observedAt of ['2026-02-30T00:00:00.000Z','2026-10-30T00:00:00Z','2026-10-30T01:00:00.000+01:00']) rejects(() => snapshot({ observation: { ...observation(),observedAt } }));
});
test('snapshot/intent consistency rejects changed values, stale digests and tampered observation links', () => {
  const before = snapshot(), mutation = intent(before);
  assert.equal(contract.assertSnapshotIntentConsistency({ beforeSnapshot: before,intent: mutation }), true);
  for (const replacement of [{ value: 'Tampered' },{ fingerprint: OTHER },{ evidenceBindingFingerprint: OTHER },
    { observation: { ...before.observation,receiptId: 'forged-receipt' } }]) {
    rejects(() => contract.assertSnapshotIntentConsistency({ beforeSnapshot: { ...before,...replacement },intent: mutation }), 'HISTORY_EVIDENCE_CONFLICT');
  }
  rejects(() => contract.assertSnapshotIntentConsistency({ beforeSnapshot: before,intent: { ...mutation,intendedValue: 'Tampered' } }), 'HISTORY_EVIDENCE_CONFLICT');
  const different = intent(before, { identity: { ...identity(),installationId: 'install-2' } });
  rejects(() => contract.assertSnapshotIntentConsistency({ beforeSnapshot: before,intent: different }), 'HISTORY_BINDING_CONFLICT');
  let reads = 0; const pair = { intent: mutation }; Object.defineProperty(pair,'beforeSnapshot',{ enumerable: true,get() { reads++; return before; } });
  rejects(() => contract.assertSnapshotIntentConsistency(pair)); assert.equal(reads, 0);
});
test('attempts keep bigint fences exact, exclude lease secrets and enforce time/number bounds', () => {
  const normalized = contract.normalizeMutationAttempt(attempt({ fenceEpoch: 9223372036854775807n }));
  assert.equal(normalized.fenceEpoch, '9223372036854775807'); assert.equal(Object.hasOwn(normalized,'leaseToken'), false);
  for (const fenceEpoch of ['0','01','-1','9223372036854775808',9007199254740992]) rejects(() => contract.normalizeMutationAttempt(attempt({ fenceEpoch })));
  for (const attemptNumber of [0,1.5,1000001]) rejects(() => contract.normalizeMutationAttempt(attempt({ attemptNumber })));
  rejects(() => contract.normalizeMutationAttempt(attempt({ leaseToken: 'private' })));
  assert.notEqual(contract.normalizeMutationAttempt(attempt()).fingerprint, contract.normalizeMutationAttempt(attempt({ attemptId: 'attempt-2' })).fingerprint);
});
test('mutation transition matrix matches all legal paths and requires the exact evidence class', () => {
  const allowed = { PREPARED: ['DISPATCHING','FAILED_NO_WRITE'],DISPATCHING: ['OUTCOME_UNKNOWN','ACKNOWLEDGED','FAILED_NO_WRITE'],
    OUTCOME_UNKNOWN: ['ACKNOWLEDGED','VERIFIED','FAILED_NO_WRITE','CONFLICT'],ACKNOWLEDGED: ['OUTCOME_UNKNOWN','VERIFIED','CONFLICT'],
    VERIFIED: [],FAILED_NO_WRITE: [],CONFLICT: [] };
  const required = { OUTCOME_UNKNOWN: 'AMBIGUOUS',ACKNOWLEDGED: 'SHOPIFY_ACKNOWLEDGEMENT',VERIFIED: 'VERIFIED_OBSERVATION',
    FAILED_NO_WRITE: 'AUTHORITATIVE_NO_WRITE',CONFLICT: 'CONFLICT_OBSERVATION' };
  for (const from of Object.keys(allowed)) for (const to of Object.keys(allowed)) {
    const legal = allowed[from].includes(to); assert.equal(contract.canTransitionMutation(from,to), legal, `${from} -> ${to}`);
    if (!legal) rejects(() => contract.assertMutationTransition(from,to), 'HISTORY_INVALID_TRANSITION');
    else {
      assert.equal(contract.assertMutationTransition(from,to,{ evidenceKind: required[to] ?? null }), true);
      if (required[to]) {
        for (const evidenceKind of [null,'NONE',...Object.values(required).filter(v => v !== required[to])]) rejects(() => contract.assertMutationTransition(from,to,{ evidenceKind }), 'HISTORY_EVIDENCE_REQUIRED');
      }
    }
  }
});
test('transition API rejects accessor evidence, unsupported keys and object coercion', () => {
  let reads = 0; const options = {}; Object.defineProperty(options,'evidenceKind',{ enumerable: true,get() { reads++; return 'AMBIGUOUS'; } });
  rejects(() => contract.assertMutationTransition('DISPATCHING','OUTCOME_UNKNOWN',options));
  rejects(() => contract.assertMutationTransition('PREPARED','DISPATCHING',{ authorized: true }));
  rejects(() => contract.assertMutationTransition('PREPARED','DISPATCHING',{ evidenceKind: 'TIMEOUT' }));
  const from = { [Symbol.toPrimitive]() { reads++; return 'PREPARED'; } };
  assert.equal(contract.canTransitionMutation(from,'DISPATCHING'), false);
  rejects(() => contract.assertMutationTransition(from,'DISPATCHING'), 'HISTORY_INVALID_TRANSITION'); assert.equal(reads, 0);
});
test('correction events preserve the original linkage and bind new evidence independently', () => {
  const raw = { identity: identity(),previousEventFingerprint: H,newEvidenceFingerprint: OTHER,reasonCode: 'LATE_OBSERVATION',recordedAt: time };
  const event = contract.normalizeHistoryCorrection(raw);
  assert.equal(event.previousEventFingerprint,H); assert.equal(event.newEvidenceFingerprint,OTHER); assert.equal(event.contractVersion,3);
  assert.notEqual(event.fingerprint, contract.normalizeHistoryCorrection({ ...raw,reasonCode: 'MANUAL_REVIEW' }).fingerprint);
  rejects(() => contract.normalizeHistoryCorrection({ ...raw,mutationState: 'VERIFIED' }));
});
test('undo preflight requires verified-after/current evidence, an inverse plan and a supported conflict policy', () => {
  const raw = { identity: identity(),originalMutationFingerprint: H,beforeSnapshotFingerprint: H,verifiedAfterSnapshotFingerprint: H,
    currentObservationFingerprint: OTHER,fieldDefinitionRevision: 'definition-1',inversePlanFingerprint: H,conflictPolicy: 'ABORT_ON_CONFLICT',checkedAt: time };
  const normalized = contract.normalizeUndoPreflight(raw);
  assert.equal(normalized.conflictPolicy, 'ABORT_ON_CONFLICT'); assert.ok(Object.isFrozen(normalized));
  assert.notEqual(normalized.fingerprint, contract.normalizeUndoPreflight({ ...raw,conflictPolicy: 'SKIP_CONFLICTED' }).fingerprint);
  rejects(() => contract.normalizeUndoPreflight({ ...raw,conflictPolicy: 'FORCE_OVERWRITE' }));
  for (const key of ['verifiedAfterSnapshotFingerprint','currentObservationFingerprint','inversePlanFingerprint']) rejects(() => contract.normalizeUndoPreflight({ ...raw,[key]: null }));
});
test('history page sizes are bounded and never coerced from request strings', () => {
  assert.equal(contract.normalizeHistoryPageSize(),25); assert.equal(contract.normalizeHistoryPageSize(100),100);
  for (const value of [0,101,1.5,'25',null]) rejects(() => contract.normalizeHistoryPageSize(value));
});
test('contract errors expose stable public metadata without arbitrary error codes', () => {
  const error = new contract.HistoryContractError(contract.HISTORY_ERROR_CODES.OWNERSHIP_LOST,'Lease expired');
  assert.equal(error.status,409); assert.deepEqual(error.toJSON(), { error: { code: 'HISTORY_OWNERSHIP_LOST',message: 'Lease expired',retryable: false } });
  assert.throws(() => new contract.HistoryContractError('UNRECOGNIZED','unsafe'), TypeError);
});
