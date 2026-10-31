/**
 * Phase 2 history persistence and Bulk Edit Engine integration.
 * Transactional admission, dispatch, and authenticated reads require trusted
 * execution-plan, authorization and observation adapters (see the repository
 * integration document). No caller-supplied plan or authority fallback exists.
 *
 * Mandatory admission checks, in the same transaction as journal writes:
 * - Resolve the authenticated shop and installation server-side and load the
 *   operation, authoritative execution plan and current execution ownership.
 * - Compare every BEFORE snapshot's execution fingerprint with the persisted
 *   operation AND the authoritative plan. Compare its filter fingerprint and
 *   field-resolution fingerprint with that plan's trusted engine coordinates.
 * - Verify field membership, resource/revision, intended values, snapshot
 *   content/receipt provenance and the exact pinned execution coordinates.
 * - Validate one shared mutation-attempt identity across all fields belonging
 *   to an execution request: mutation ID, attempt ID/number, fence, claim,
 *   mutation-plan fingerprint and authoritative job/item associations. Check
 *   the complete approved field set, including existing rows on retry; distinct
 *   per-field records must not split or mix an execution request's identity.
 * - Serialize admission using authoritative execution ownership so concurrent
 *   inserts cannot each validate an incomplete, inconsistent set of fields.
 * - Commit intent and BEFORE evidence before external mutation dispatch.
 *
 * The deferred SQL barrier proves local snapshot linkage, not plan provenance.
 * Never use request-supplied hashes or self-consistent normalized records as
 * substitutes for the authoritative server-loaded execution plan.
 */
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { createHistoryHookInvoker } from './transaction-hooks.server.js';
import { createHistoryLifecycle } from './history-lifecycle.server.js';
import { createHistoryPages } from './history-pages.server.js';
import { createRepositoryAdmissionAuthority } from './repository-authority.server.js';
import { historyMemberKey,changeMemberKey,requestMembers } from './request-members.server.js';
import { createHistoryValueProtection,assertHistoryValueProtection } from './history-value-protection.server.js';
import { protectedHistoryDatabase } from './database-security.server.js';
import { isDeepStrictEqual } from 'node:util';
import { createHistoryExecutionAdapter,assertHistoryExecutionAdapter } from '../services/history-execution-adapter.server.js';
import {
  HISTORY_ERROR_CODES as C, HistoryContractError, canonicalHistoryJson, historyFingerprint,
  normalizeHistoryIdentity, normalizeHistoryBinding, normalizeHistorySnapshot,
  normalizeMutationIntent, normalizeMutationAttempt, assertSnapshotIntentConsistency,
  requireHistoryId, requireHistoryReader, HISTORY_FINGERPRINT_SCHEME,HISTORY_LIMITS,
} from './history-contract.js';

const fail = (code, message) => { throw new HistoryContractError(code, message); };
const issuedRepositories=new WeakSet();
export function assertHistoryRepository(repository){if(!issuedRepositories.has(repository))throw TypeError('Issued history repository required');}
// Contract canonicalization uses null-prototype records; database JSON and
// individual normalizers can use ordinary records. Compare their data content.
const comparable = value => Array.isArray(value) ? value.map(comparable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, comparable(item)])) : value;
const match = (a, b, message) => { if (!isDeepStrictEqual(comparable(a), comparable(b))) fail(C.BINDING_CONFLICT, message); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
function bigintId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    fail(C.INVALID_INPUT, 'A canonical positive signed-64-bit decimal ID is required');
  }
  return value;
}
function record(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(C.INVALID_INPUT, 'Plain journal input required');
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!keys.includes(key) || !d.enumerable || !Object.hasOwn(d, 'value')) fail(C.INVALID_INPUT, 'Unsupported journal input');
  }
  return value;
}
function normalizeEntry(entry) {
  record(entry, ['beforeSnapshot', 'intent', 'attempt', 'resourceFamilyGid', 'mirrorBeforeSnapshotId']);
  const raw = entry.beforeSnapshot;
  if (!raw) fail(C.INVALID_INPUT, 'BEFORE snapshot required');
  record(raw, ['snapshotVersion','identity','binding','kind','valueKind','value','fingerprint','observation','evidenceBindingFingerprint']);
  record(raw.observation, ['observationVersion','observationId','source','observedAt','resourceGid','fieldId','sourceRevision','receiptId','receiptFingerprint','evidenceFingerprint']);
  const before = normalizeHistorySnapshot({ identity: raw.identity, binding: raw.binding, kind: raw.kind,
    valueKind: raw.valueKind, ...(Object.hasOwn(raw, 'value') ? { value: raw.value } : {}),
    observation: raw.observation && Object.fromEntries(['observationId', 'source', 'observedAt', 'resourceGid', 'fieldId',
      'sourceRevision', 'receiptId', 'receiptFingerprint'].map(key => [key, raw.observation[key]])),
  });
  match(raw, before, 'Snapshot content or evidence binding was changed');
  const i = entry.intent;
  if (!i) fail(C.INVALID_INPUT, 'Mutation intent required');
  record(i, ['contractVersion','identity','binding','beforeSnapshotFingerprint','mutationPlanFingerprint','intendedValueKind','intendedValue','fingerprint']);
  const intent = normalizeMutationIntent({ identity: i.identity, binding: i.binding,
    beforeSnapshotFingerprint: i.beforeSnapshotFingerprint, mutationPlanFingerprint: i.mutationPlanFingerprint,
    intendedValueKind: i.intendedValueKind, ...(Object.hasOwn(i, 'intendedValue') ? { intendedValue: i.intendedValue } : {}),
  });
  match(i, intent, 'Mutation intent content was changed');
  const a = entry.attempt;
  if (!a) fail(C.INVALID_INPUT, 'Mutation attempt required');
  record(a, ['attemptVersion','identity','attemptId','attemptNumber','fenceEpoch','executionClaimId','startedAt','fingerprint']);
  const attempt = normalizeMutationAttempt(Object.fromEntries(['identity', 'attemptId', 'attemptNumber', 'fenceEpoch', 'executionClaimId', 'startedAt'].map(key => [key, a[key]])));
  match(a, attempt, 'Mutation attempt content was changed');
  match(attempt.identity, intent.identity, 'Attempt and field identity differ');
  assertSnapshotIntentConsistency({ beforeSnapshot: before, intent });
  if (typeof entry.resourceFamilyGid !== 'string' || !entry.resourceFamilyGid.trim() || entry.resourceFamilyGid.length > 512) fail(C.INVALID_INPUT, 'Resource family required');
  const mirrorBeforeSnapshotId = entry.mirrorBeforeSnapshotId == null ? null : bigintId(entry.mirrorBeforeSnapshotId);
  return { before, intent, attempt, resourceFamilyGid: entry.resourceFamilyGid, mirrorBeforeSnapshotId };
}

// Identifiers are fixed below; only values cross the parameter boundary.
async function insertChange(tx, op, entry, valueProtection, context) {
  const { before: s, intent: i, attempt: a } = entry;
  const changeId = randomUUID(), snapshotId = randomUUID();
  const sealed=await valueProtection.seal({id:snapshotId,shop_id:op.shop_id,installation_id:op.installation_id,operation_id:op.id,
    change_id:changeId,snapshot_kind:'BEFORE',value_kind:s.valueKind,resource_gid:s.identity.resourceGid,field_id:s.identity.fieldId,
    snapshot_fingerprint:s.fingerprint,evidence_binding_fingerprint:s.evidenceBindingFingerprint},s.value,context);
  const intendedHash = historyFingerprint({ valueKind: i.intendedValueKind,
    ...(Object.hasOwn(i, 'intendedValue') ? { value: i.intendedValue } : {}) }, 'intended-value-v3');
  await tx.query(`INSERT INTO edit_history.changes
    (id,shop_id,installation_id,operation_id,execution_item_id,mutation_id,attempt_id,attempt_number,
     execution_fence_epoch,execution_claim_id,resource_gid,resource_family_gid,field_id,field_definition_revision,
     mutation_plan_fingerprint,intended_value_fingerprint,before_snapshot_fingerprint,prepared_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [changeId,op.shop_id,op.installation_id,op.id,i.identity.executionItemId,i.identity.mutationId,a.attemptId,a.attemptNumber,
    a.fenceEpoch,a.executionClaimId,i.identity.resourceGid,entry.resourceFamilyGid,i.identity.fieldId,i.binding.fieldDefinitionRevision,
    i.mutationPlanFingerprint,intendedHash,s.fingerprint,a.startedAt]);
  await tx.query(`INSERT INTO edit_history.snapshots
    (id,shop_id,installation_id,operation_id,change_id,snapshot_kind,value_kind,value_json,
     snapshot_fingerprint,evidence_binding_fingerprint,observation_id,observation_source,observed_at,source_revision,
     observation_receipt_id,observation_receipt_fingerprint,resource_gid,field_id,field_definition_revision,
     filter_fingerprint,execution_fingerprint,field_resolution_fingerprint,binding_mode,generation_id,
     coverage_revision,mapping_version,execution_snapshot_id,mirror_before_snapshot_id,value_encoding,encrypted_value,encryption_key_reference)
    VALUES($1,$2,$3,$4,$5,'BEFORE',$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
  [snapshotId,op.shop_id,op.installation_id,op.id,changeId,s.valueKind,
    sealed.value_json===null?null:JSON.stringify(sealed.value_json),s.fingerprint,s.evidenceBindingFingerprint,
    s.observation.observationId,s.observation.source,s.observation.observedAt,s.observation.sourceRevision,
    s.observation.receiptId,s.observation.receiptFingerprint,s.identity.resourceGid,s.identity.fieldId,s.binding.fieldDefinitionRevision,
    s.binding.filterFingerprint,s.binding.executionFingerprint,s.binding.fieldResolutionFingerprint,s.binding.mode,
    s.binding.generationId,s.binding.coverageRevision,s.binding.mappingVersion,s.binding.executionSnapshotId,entry.mirrorBeforeSnapshotId,
    sealed.value_encoding,sealed.encrypted_value,sealed.encryption_key_reference]);
  return { changeId, snapshotId, fieldId: i.identity.fieldId,resourceGid:i.identity.resourceGid };
}

function operationRecord(row) {
  requireHistoryReader(row.contract_version);
  if (row.fingerprint_scheme !== HISTORY_FINGERPRINT_SCHEME) fail(C.UNSUPPORTED_VERSION, 'Unsupported history fingerprint scheme');
  return canonicalHistoryJson({ operationId: row.id,executionJobId: row.execution_job_id,editOperationId: row.edit_operation_id,
    executionContractId: row.execution_contract_id,contractVersion: row.contract_version,operationKind: row.operation_kind,
    state: row.operation_state,executionFingerprint: row.execution_fingerprint,filterFingerprint: row.filter_fingerprint,
    counts: { recorded: row.changes_recorded,verified: row.changes_verified,failed: row.changes_failed,uncertain: row.changes_uncertain },
    createdAt: row.created_at.toISOString(),updatedAt: row.updated_at.toISOString(),completedAt: row.completed_at?.toISOString() ?? null });
}

function storedSnapshot(row) {
  if (row.value_encoding !== 'JSONB' || row.encrypted_value !== null || row.encryption_key_reference !== null) {
    fail(C.UNSUPPORTED_VERSION, 'Encrypted history requires an explicitly configured versioned reader');
  }
  const snapshot = normalizeHistorySnapshot({
    identity: { shopId: row.shop_id,installationId: row.installation_id,executionJobId: row.execution_job_id,
      executionItemId: row.execution_item_id,mutationId: row.mutation_id,resourceGid: row.resource_gid,fieldId: row.field_id },
    binding: { mode: row.binding_mode,filterFingerprint: row.filter_fingerprint,executionFingerprint: row.execution_fingerprint,
      fieldResolutionFingerprint: row.field_resolution_fingerprint,fieldDefinitionRevision: row.field_definition_revision,
      generationId: row.generation_id,coverageRevision: row.coverage_revision,mappingVersion: row.mapping_version,executionSnapshotId: row.execution_snapshot_id },
    kind: row.snapshot_kind,valueKind: row.value_kind,...(row.value_kind === 'VALUE' ? { value: row.value_json } : {}),
    observation: { observationId: row.observation_id,source: row.observation_source,observedAt: row.observed_at.toISOString(),
      resourceGid: row.resource_gid,fieldId: row.field_id,sourceRevision: row.source_revision,
      receiptId: row.observation_receipt_id,receiptFingerprint: row.observation_receipt_fingerprint },
  });
  if (row.snapshot_version !== snapshot.snapshotVersion || row.fingerprint_scheme !== HISTORY_FINGERPRINT_SCHEME) fail(C.UNSUPPORTED_VERSION, 'Unsupported snapshot version or scheme');
  match([row.snapshot_fingerprint,row.evidence_binding_fingerprint,row.execution_fingerprint,row.filter_fingerprint],
    [snapshot.fingerprint,snapshot.evidenceBindingFingerprint,row.operation_execution_fingerprint,row.operation_filter_fingerprint], 'Persisted snapshot content or operation binding is invalid');
  match([row.resource_gid,row.field_id,row.field_definition_revision],
    [row.change_resource_gid,row.change_field_id,row.change_definition_revision], 'Persisted snapshot is not owned by this change');
  if (row.snapshot_kind === 'BEFORE') match(row.snapshot_fingerprint,row.before_snapshot_fingerprint,'Snapshot does not match recorded BEFORE intent');
  if (row.value_kind === 'ABSENT' && row.value_json !== null) fail(C.EVIDENCE_CONFLICT, 'ABSENT snapshot has a stored value');
  return snapshot;
}

export function createHistoryRepository({ database, resolveTenant, loadExecutionPlan, authorizePlan, verifyObservation, authorizeHistoryRead, executionAdapter = createHistoryExecutionAdapter(), authorizeDispatch, loadMutationEvidence, verifyMutationEvidence, authorizeRecovery, historyCursorSecret, valueProtection=createHistoryValueProtection(),authorizeHistoryValueRead,authorityRelations=[] } = {}) {
  if (typeof database?.connect !== 'function' || [resolveTenant, loadExecutionPlan, authorizePlan, verifyObservation].some(fn => typeof fn !== 'function')) {
    throw new TypeError('Transactional database and trusted tenant, durable plan, live authorization and observation adapters required');
  }
  if (authorizeHistoryRead !== undefined && typeof authorizeHistoryRead !== 'function') throw new TypeError('Trusted history read authorization must be a function');
  assertHistoryExecutionAdapter(executionAdapter);
  assertHistoryValueProtection(valueProtection);
  if(authorizeHistoryValueRead!==undefined&&typeof authorizeHistoryValueRead!=='function')throw TypeError('Trusted value reveal authorization required');
  database=protectedHistoryDatabase(database,'runtime',{authorityRelations});
  async function execute(raw, dispatch) {
    record(raw, ['authContext', 'operationId', 'mutationId', 'claim', 'entries']);
    if (!raw.authContext || !uuid(raw.operationId) || typeof raw.mutationId !== 'string' || !raw.mutationId || raw.mutationId.length > 512) fail(C.INVALID_INPUT, 'Authenticated operation and mutation references required');
    const claim = canonicalHistoryJson(record(raw.claim, ['fenceEpoch', 'executionClaimId', 'leaseToken']));
    bigintId(claim.fenceEpoch);
    if (typeof claim.leaseToken !== 'string' || !claim.leaseToken || typeof claim.executionClaimId !== 'string' || !claim.executionClaimId) fail(C.INVALID_INPUT, 'Execution claim required');
    if (!Array.isArray(raw.entries) || !raw.entries.length || raw.entries.length > 64) fail(C.LIMIT_EXCEEDED, 'One to 64 fields required per mutation request');
    if (Reflect.ownKeys(raw.entries).length !== raw.entries.length+1) fail(C.INVALID_INPUT, 'Decorated or sparse entries are prohibited');
    const entries = [];
    for (let index=0; index<raw.entries.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw.entries,String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor,'value')) fail(C.INVALID_INPUT, 'Journal entry accessors are prohibited');
      entries.push(normalizeEntry(descriptor.value));
    }
    const fieldIds = entries.map(e => e.intent.identity.fieldId);
    const memberKeys=entries.map(e=>historyMemberKey(e.intent.identity));
    if (new Set(memberKeys).size !== memberKeys.length) fail(C.INVALID_INPUT, 'Duplicate resource fields in mutation request');
    // Load the authoritative plan using references only. Admission later
    // authenticates submitted or persisted snapshots against that locked plan.
    const authContext = raw.authContext, operationId = raw.operationId, mutationId = raw.mutationId;
    for (let retry = 0; ; retry++) {
      const tx = await database.connect();
      const invoke = createHistoryHookInvoker(tx);
      try {
        await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await tx.query("SET LOCAL lock_timeout='2000ms'");
        await tx.query("SET LOCAL statement_timeout='15000ms'");
        await tx.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
        await executionAdapter.beginScope({ client: tx,write: true });
        const tenant = canonicalHistoryJson(record(await invoke(resolveTenant,{ client: tx, authContext }), ['shopId','installationId']));
        if (typeof tenant.shopId !== 'string' || typeof tenant.installationId !== 'string' || !tenant.installationId) fail(C.UNAUTHORIZED, 'Authenticated installation required');
        await executionAdapter.assertTenant({ client: tx,tenant });
        const plan = canonicalHistoryJson(await invoke(loadExecutionPlan,{ client: tx, authContext, ...tenant, operationId, mutationId }),{maxBytes:HISTORY_LIMITS.MAX_RECORD_BYTES});
        if (!plan) fail(C.UNAUTHORIZED, 'Authoritative execution request not found');
        match([plan.shopId,plan.installationId,plan.operationId,plan.mutationId],
          [tenant.shopId,tenant.installationId,operationId,mutationId], 'Plan tenant, installation or request mismatch');
        bigintId(plan.executionJobId); bigintId(plan.editOperationId);
        if (![plan.executionFingerprint,plan.filterFingerprint,plan.fieldResolutionFingerprint,plan.approvedContractFingerprint,plan.mutationPlanFingerprint].every(hash)) fail(C.BINDING_CONFLICT, 'Authoritative engine fingerprints required');
        const { command,contract,selection,generation,coverage,assertClaim } = await executionAdapter.lockAuthority({ client: tx,tenant,plan,claim });
        if (await invoke(authorizePlan,{ client: tx, authContext, tenant, plan, contract }) !== true) fail(C.UNAUTHORIZED, 'Current Field/Filter Engine authorization required');
        if (!Array.isArray(plan.fields) || plan.fields.length !== entries.length) fail(C.BINDING_CONFLICT, 'Complete authoritative field set required');
        match(plan.fields.map(f=>historyMemberKey(f.identity)).sort(), [...memberKeys].sort(), 'Authoritative field set differs');
        const first = entries[0];
        const ownedMirror=new Map(),ownedItems=new Map(),ownedTargets=new Set();
        for (const e of entries) {
          const key=historyMemberKey(e.intent.identity);
          const expected = plan.fields.find(f => historyMemberKey(f.identity) === key);
          const targetKey=JSON.stringify([e.intent.identity.resourceGid,e.resourceFamilyGid]);
          if(!ownedTargets.has(targetKey)){await executionAdapter.verifyTarget({client:tx,tenant,selection,coverage,entry:e});ownedTargets.add(targetKey);}
          match(e.intent.identity, normalizeHistoryIdentity(expected.identity), 'Field identity differs from authoritative plan');
          match(e.intent.binding, normalizeHistoryBinding(expected.binding), 'Field/filter coordinates differ from authoritative plan');
          if (e.intent.binding.mode === 'MIRROR_PINNED') match([e.intent.binding.generationId,e.intent.binding.coverageRevision],
            [selection.generation_id,selection.coverage_revision], 'Snapshot targeting coordinates differ from approved selection');
          match([e.intent.binding.executionFingerprint,e.intent.binding.filterFingerprint,e.intent.binding.fieldResolutionFingerprint],
            [plan.executionFingerprint,plan.filterFingerprint,plan.fieldResolutionFingerprint], 'Engine fingerprints differ from authoritative plan');
          match([e.intent.identity.shopId,e.intent.identity.installationId,e.intent.identity.executionJobId,e.intent.identity.mutationId],
            [tenant.shopId,tenant.installationId,plan.executionJobId,mutationId], 'Journal scope differs from authority');
          match([e.attempt.attemptId,e.attempt.attemptNumber,e.attempt.fenceEpoch,e.attempt.executionClaimId,e.attempt.startedAt],
            [plan.attemptId,plan.attemptNumber,claim.fenceEpoch,claim.executionClaimId,plan.startedAt], 'Mutation-attempt identity differs from authority');
          match([plan.fenceEpoch,plan.executionClaimId], [claim.fenceEpoch,claim.executionClaimId], 'Plan claim differs from current owner');
          match([e.intent.identity.executionItemId,e.resourceFamilyGid],
            [first.intent.identity.executionItemId,expected.resourceFamilyGid], 'Mixed execution item or resource family request');
          match([e.intent.intendedValueKind,e.intent.intendedValue,e.intent.mutationPlanFingerprint],
            [expected.intendedValueKind,expected.intendedValue,plan.mutationPlanFingerprint], 'Intended mutation differs from authoritative plan');
          bigintId(e.intent.identity.executionItemId);
          match(e.mirrorBeforeSnapshotId,expected.mirrorBeforeSnapshotId ?? null,'Mirror snapshot lineage differs from authoritative plan');
          const sourceKey=JSON.stringify([e.intent.identity.executionItemId,e.intent.identity.resourceGid,e.resourceFamilyGid,e.mirrorBeforeSnapshotId]);
          if(!ownedItems.has(sourceKey))ownedItems.set(sourceKey,await executionAdapter.verifyFieldOwnership({ client: tx,tenant,plan,entry: e,expected }));
          const mirrorSnapshot=ownedItems.get(sourceKey);
          ownedMirror.set(key,mirrorSnapshot);
        }
        if (!dispatch) await tx.query(`INSERT INTO edit_history.operations
          (id,shop_id,installation_id,execution_job_id,edit_operation_id,execution_contract_id,operation_kind,
           execution_fingerprint,filter_fingerprint,approved_contract_fingerprint,field_mapping_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [operationId,tenant.shopId,tenant.installationId,plan.executionJobId,plan.editOperationId,plan.executionContractId,
          plan.operationKind,plan.executionFingerprint,plan.filterFingerprint,plan.approvedContractFingerprint,first.intent.binding.mappingVersion]);
        const op = (await tx.query(`SELECT * FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3 FOR UPDATE`,
          [tenant.shopId,tenant.installationId,operationId])).rows[0];
        if (!op) fail(C.BINDING_CONFLICT, 'History operation absent or has a conflicting identity');
        if(op.purge_requested_at!==null&&op.purge_requested_at!==undefined)fail(C.UNAUTHORIZED,'History is being removed');
        match([op.execution_job_id,op.edit_operation_id,op.execution_contract_id,op.operation_kind,op.execution_fingerprint,op.filter_fingerprint,op.approved_contract_fingerprint,op.field_mapping_version],
          [plan.executionJobId,plan.editOperationId,plan.executionContractId,plan.operationKind,plan.executionFingerprint,plan.filterFingerprint,plan.approvedContractFingerprint,first.intent.binding.mappingVersion], 'Persisted operation differs from authoritative plan');
        if (!['RECORDING','ACTIVE'].includes(op.operation_state)) fail(C.INVALID_TRANSITION, 'History operation cannot admit execution');
        const existing = (await tx.query(`SELECT c.*,s.id AS snapshot_id,s.mirror_before_snapshot_id AS mirror_reference,to_jsonb(s) AS persisted_snapshot,s.evidence_binding_fingerprint,
          s.execution_fingerprint,s.filter_fingerprint,s.field_resolution_fingerprint
          FROM edit_history.changes c LEFT JOIN edit_history.snapshots s ON s.shop_id=c.shop_id
            AND s.installation_id=c.installation_id AND s.change_id=c.id AND s.snapshot_kind='BEFORE'
          WHERE c.shop_id=$1 AND c.installation_id=$2 AND c.operation_id=$3 AND (c.mutation_id=$4 OR c.attempt_id=$5)
          ORDER BY c.attempt_number,c.field_id LIMIT 1025`, [tenant.shopId,tenant.installationId,operationId,mutationId,plan.attemptId])).rows;
        if (existing.length > 1024) fail(C.LIMIT_EXCEEDED, 'Mutation attempt history exceeds admission bound');
        const current = existing.filter(r => r.attempt_id === plan.attemptId);
        const prior = existing.filter(r => r.attempt_id !== plan.attemptId);
        for (const attemptId of new Set(prior.map(row => row.attempt_id))) {
          match(prior.filter(row => row.attempt_id === attemptId).map(changeMemberKey).sort(), [...memberKeys].sort(), 'Previous attempt has a different field set');
        }
        for (const previous of prior) {
          if (previous.attempt_number >= plan.attemptNumber || previous.mutation_state !== 'FAILED_NO_WRITE') fail(C.INVALID_TRANSITION, 'Prior mutation attempt requires reconciliation before retry');
          const member=entries.find(e=>historyMemberKey(e.intent.identity)===changeMemberKey(previous));
          match([previous.execution_item_id,previous.resource_gid,previous.resource_family_gid,previous.mutation_plan_fingerprint],
            [member.intent.identity.executionItemId,member.intent.identity.resourceGid,member.resourceFamilyGid,plan.mutationPlanFingerprint], 'Previous attempt belongs to a different mutation request');
        }
        const compareC = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
        const resourceFieldSet = entries.map(e => ({
          resourceGid: e.intent.identity.resourceGid,
          fieldId: e.intent.identity.fieldId,
        })).sort((a, b) => {
          const r = compareC(a.resourceGid, b.resourceGid);
          return r !== 0 ? r : compareC(a.fieldId, b.fieldId);
        });
        const multiResource = new Set(entries.map(e => e.intent.identity.resourceGid)).size > 1;
        const requestFingerprint = historyFingerprint(entries.map(e => ({
          fieldId: e.intent.identity.fieldId,
          ...(multiResource ? { resourceGid: e.intent.identity.resourceGid } : {}),
          intent: e.intent.fingerprint,
          attempt: e.attempt.fingerprint,
          before: e.before.fingerprint,
          evidence: e.before.evidenceBindingFingerprint,
          mirror: e.mirrorBeforeSnapshotId
        })).sort((a, b) => multiResource ? (historyMemberKey(a) < historyMemberKey(b) ? -1 : 1) : a.fieldId.localeCompare(b.fieldId)),
        multiResource ? 'mutation-request-resources-v3' : 'mutation-request-v3');

        const dispatchHandoffKey = (typeof plan.dispatchHandoffKey === 'string' && plan.dispatchHandoffKey.trim())
          ? plan.dispatchHandoffKey.trim()
          : `${operationId}:${mutationId}:${plan.attemptId}`;

        if (!current.length && !dispatch) {
          const requestId = randomUUID();
          await tx.query(`INSERT INTO edit_history.mutation_requests
            (id, shop_id, installation_id, operation_id, mutation_id, attempt_id, attempt_number,
             execution_item_id, execution_fence_epoch, execution_claim_id, mutation_plan_fingerprint,
             request_fingerprint, resource_field_set, field_count, request_state, dispatch_handoff_key)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,'PREPARED',$15)`,
            [requestId, tenant.shopId, tenant.installationId, operationId, mutationId, plan.attemptId, plan.attemptNumber,
             first.intent.identity.executionItemId, claim.fenceEpoch, claim.executionClaimId, plan.mutationPlanFingerprint,
             requestFingerprint, JSON.stringify(resourceFieldSet), entries.length, dispatchHandoffKey]);
        }
        const envelope = (await tx.query(
          `SELECT * FROM edit_history.mutation_requests WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5 FOR UPDATE`,
          [tenant.shopId, tenant.installationId, operationId, mutationId, plan.attemptId]
        )).rows[0];
        if (!envelope || envelope.request_fingerprint !== requestFingerprint) fail(C.BINDING_CONFLICT, 'Persisted request envelope differs from admitted authority');
        if (envelope.field_count !== entries.length) fail(C.BINDING_CONFLICT, 'Persisted request field count differs from authority');
        match(envelope.resource_field_set, resourceFieldSet, 'Persisted request resource field set differs from authority');
        let dispatchToken;
        let receipts = [];
        const admissionEntries=entries.map(e=>({beforeSnapshot:e.before,intent:e.intent,attempt:e.attempt,resourceFamilyGid:e.resourceFamilyGid}));
        if (current.length) {
          const persistedRows=(await tx.query(`SELECT s.*,o.execution_job_id,o.execution_fingerprint AS operation_execution_fingerprint,
            o.filter_fingerprint AS operation_filter_fingerprint,c.execution_item_id,c.mutation_id,c.before_snapshot_fingerprint,
            c.resource_gid AS change_resource_gid,c.field_id AS change_field_id,c.field_definition_revision AS change_definition_revision
            FROM edit_history.snapshots s JOIN edit_history.changes c ON c.shop_id=s.shop_id AND c.installation_id=s.installation_id AND c.operation_id=s.operation_id AND c.id=s.change_id
            JOIN edit_history.operations o ON o.shop_id=s.shop_id AND o.installation_id=s.installation_id AND o.id=s.operation_id
            WHERE s.shop_id=$1 AND s.installation_id=$2 AND s.operation_id=$3 AND s.change_id=ANY($4::uuid[]) AND s.snapshot_kind='BEFORE'`,[tenant.shopId,tenant.installationId,operationId,current.map(row=>row.id)])).rows;
          for(const row of persistedRows){
            const persisted=storedSnapshot(await valueProtection.open(row,{client:tx,tenant,authContext})),entry=entries.find(e=>historyMemberKey(e.intent.identity)===historyMemberKey(persisted.identity));
            if(!entry)fail(C.BINDING_CONFLICT,'Persisted snapshot field is absent from authority');
            admissionEntries.find(e=>historyMemberKey(e.intent.identity)===historyMemberKey(persisted.identity)).beforeSnapshot=persisted;
            assertSnapshotIntentConsistency({beforeSnapshot:persisted,intent:entry.intent});
          }
          if(persistedRows.length!==entries.length)fail(C.EVIDENCE_REQUIRED,'Persisted BEFORE snapshot set is incomplete');
          match(current.map(changeMemberKey).sort(), [...memberKeys].sort(), 'Persisted request has an incomplete or mixed field set');
          for (const e of entries) {
            const r = current.find(row => changeMemberKey(row) === historyMemberKey(e.intent.identity));
            match([r.mutation_id,r.attempt_number,r.execution_fence_epoch,r.execution_claim_id,r.execution_item_id,r.resource_gid,r.resource_family_gid,
              r.mutation_plan_fingerprint,r.before_snapshot_fingerprint,r.evidence_binding_fingerprint,r.execution_fingerprint,r.filter_fingerprint,r.field_resolution_fingerprint],
            [mutationId,plan.attemptNumber,claim.fenceEpoch,claim.executionClaimId,e.intent.identity.executionItemId,e.intent.identity.resourceGid,e.resourceFamilyGid,
              plan.mutationPlanFingerprint,e.before.fingerprint,e.before.evidenceBindingFingerprint,plan.executionFingerprint,plan.filterFingerprint,plan.fieldResolutionFingerprint], 'Persisted mutation request conflicts with authority');
            match(r.intended_value_fingerprint, historyFingerprint({ valueKind: e.intent.intendedValueKind,
              ...(Object.hasOwn(e.intent, 'intendedValue') ? { value: e.intent.intendedValue } : {}) }, 'intended-value-v3'), 'Persisted intended value differs');
            match(new Date(r.prepared_at).toISOString(), e.attempt.startedAt, 'Persisted attempt preparation time differs');
            const s = await valueProtection.open(r.persisted_snapshot,{client:tx,tenant,authContext}), b = e.before;
            match([s.shop_id,s.installation_id,s.operation_id,s.change_id,s.snapshot_version,s.fingerprint_scheme,s.snapshot_kind,
              s.value_kind,s.value_encoding,s.value_json,s.encrypted_value,s.encryption_key_reference,s.resource_gid,s.field_id,s.field_definition_revision,
              s.observation_id,s.observation_source,new Date(s.observed_at).toISOString(),s.source_revision,s.observation_receipt_id,s.observation_receipt_fingerprint,
              s.binding_mode,s.generation_id,s.coverage_revision,s.mapping_version,s.execution_snapshot_id,r.mirror_reference],
            [tenant.shopId,tenant.installationId,operationId,r.id,3,'metamax-history-sha256-v3','BEFORE',
              b.valueKind,'JSONB',b.valueKind === 'VALUE' ? b.value : null,null,null,b.identity.resourceGid,b.identity.fieldId,b.binding.fieldDefinitionRevision,
              b.observation.observationId,b.observation.source,b.observation.observedAt,b.observation.sourceRevision,b.observation.receiptId,b.observation.receiptFingerprint,
              b.binding.mode,b.binding.generationId,b.binding.coverageRevision,b.binding.mappingVersion,b.binding.executionSnapshotId,e.mirrorBeforeSnapshotId], 'Persisted BEFORE snapshot content or coordinates differ');
            receipts.push({ changeId: r.id, snapshotId: r.snapshot_id, fieldId: r.field_id,resourceGid:r.resource_gid });
          }
        } else {
          if (dispatch) fail(C.INVALID_TRANSITION, 'Durably prepared journal required before dispatch');
        }
        // Authority runs inside the same locked transaction as the journal. On
        // replay its receipts authenticate persisted snapshots, not caller data.
        const authority=createRepositoryAdmissionAuthority({executionAdapter,invoke,resolveTenant,authorizePlan,verifyObservation,
          tenant,plan,contract,ownedMirror,replay:current.length>0});
        await authority.authorizeAdmission({client:tx,authContext,executionJobId:plan.executionJobId,mutationId,claim,entries:admissionEntries});
        if(!current.length){
          for(const e of entries)receipts.push(await insertChange(tx,op,e,valueProtection,{client:tx,tenant,authContext}));
          await tx.query(`UPDATE edit_history.operations SET changes_recorded=changes_recorded+$4,updated_at=clock_timestamp()
            WHERE shop_id=$1 AND installation_id=$2 AND id=$3`, [tenant.shopId,tenant.installationId,operationId,entries.length]);
        }
        if (dispatch) {
          if(await invoke(authorizeDispatch,{authContext,tenant,plan,contract,operation:'dispatch'})!==true)fail(C.UNAUTHORIZED,'Independent execution dispatch authorization required');
          // Serialize family admission across distinct commands. The serializable
          // predicate below remains a durable barrier after this short lock ends:
          // an uncertain request must be reconciled before another writer starts.
          for(const family of [...new Set(entries.map(e=>e.resourceFamilyGid))].sort()){
            const lock=await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
              [JSON.stringify([tenant.shopId,tenant.installationId,family])]);
            if(!lock.rows[0]?.acquired)fail(C.OWNERSHIP_LOST,'Resource family is being admitted by another execution');
          }
          const competing=await tx.query(`SELECT id FROM edit_history.changes WHERE shop_id=$1 AND installation_id=$2
            AND resource_family_gid=ANY($3::text[]) AND mutation_state IN('DISPATCHING','OUTCOME_UNKNOWN','ACKNOWLEDGED')
            AND NOT(operation_id=$4 AND mutation_id=$5 AND attempt_id=$6) LIMIT 1`,
            [tenant.shopId,tenant.installationId,[...new Set(entries.map(e=>e.resourceFamilyGid))],operationId,mutationId,plan.attemptId]);
          if(competing.rows.length)fail(C.INVALID_TRANSITION,'Resource family has an unresolved mutation; reconcile before writing');
          dispatchToken = randomBytes(32).toString('base64url');
          const bound = await tx.query(`UPDATE edit_history.mutation_requests
            SET request_state='DISPATCH_AUTHORIZED', dispatch_authorized_at=clock_timestamp(), updated_at=clock_timestamp(),dispatch_token_hash=$6
            WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5 AND request_state='PREPARED' AND dispatch_token_hash IS NULL`,
            [tenant.shopId, tenant.installationId, operationId, mutationId, plan.attemptId,'sha256:'+createHash('sha256').update(dispatchToken).digest('hex')]);
          if (bound.rowCount !== 1) fail(C.INVALID_TRANSITION, 'Dispatch handoff already issued or request not prepared; recovery is required');
          const result = await tx.query(`UPDATE edit_history.changes SET mutation_state='DISPATCHING',dispatch_started_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5 AND mutation_state='PREPARED'`,
          [tenant.shopId,tenant.installationId,operationId,mutationId,plan.attemptId]);
          if (result.rowCount !== entries.length) fail(C.INVALID_TRANSITION, 'Request was already dispatched or no longer prepared; reconcile instead of resending');
          await tx.query(`UPDATE edit_history.operations SET operation_state='ACTIVE',updated_at=clock_timestamp()
            WHERE shop_id=$1 AND installation_id=$2 AND id=$3`, [tenant.shopId,tenant.installationId,operationId]);
        }
        // Verifiers may await IO; lease eligibility uses DB time again at commit.
        if (await invoke(authorizePlan,{ client: tx, authContext, tenant, plan, contract }) !== true) fail(C.UNAUTHORIZED, 'Execution authorization changed during admission');
        match(canonicalHistoryJson(await invoke(resolveTenant,{ client: tx, authContext })), tenant, 'Authenticated installation changed during admission');
        if(dispatch&&await invoke(authorizeDispatch,{authContext,tenant,plan,contract,operation:'dispatch'})!==true)fail(C.UNAUTHORIZED,'Dispatch authorization changed');
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        await assertClaim();
        await tx.query('COMMIT');
        return Object.freeze({ operationId, mutationId, attemptId: plan.attemptId, dispatchHandoffKey, existing: current.length > 0,...(dispatchToken?{dispatchToken}:{}),
          state: dispatch ? 'DISPATCHING' : (new Set(current.map(row => row.mutation_state)).size > 1 ? 'MIXED' : current[0]?.mutation_state ?? 'PREPARED'),
          fields: Object.freeze(receipts.map(Object.freeze)) });
      } catch (error) {
        await tx.query('ROLLBACK').catch(() => {});
        // Only explicit transaction-aborted conflicts can be replayed. Never
        // replay an uncertain COMMIT or an external operation.
        if (['40001','40P01','23505','P2002','P2034'].includes(error.code) && retry < 2) continue;
        throw error;
      } finally { tx.release(); }
    }
  }
  async function read(raw, action) {
    const extra = action === 'read_request' ? ['mutationId','attemptId'] : action === 'read_snapshot' ? ['changeId','snapshotId'] : [];
    record(raw, ['authContext','operationId',...extra]);
    if (!raw.authContext || !uuid(raw.operationId)) fail(C.INVALID_INPUT, 'Authenticated history operation reference required');
    if (typeof authorizeHistoryRead !== 'function') fail(C.UNAUTHORIZED, 'Trusted history read authorization is required');
    const reference = { operationId: raw.operationId };
    for (const key of extra) {
      if (['changeId','snapshotId'].includes(key) && !uuid(raw[key])) fail(C.INVALID_INPUT, 'History UUID reference required');
      reference[key] = requireHistoryId(raw[key],key);
    }
    const request = canonicalHistoryJson(reference),authContext = raw.authContext;
    for (let retry=0; ; retry++) {
      const tx = await database.connect();
      const invoke = createHistoryHookInvoker(tx);
      try {
        await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await tx.query("SET LOCAL lock_timeout='2000ms'");
        await tx.query("SET LOCAL statement_timeout='15000ms'");
        await tx.query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
        await executionAdapter.beginScope({ client: tx,write: false });
        const tenant = canonicalHistoryJson(record(await invoke(resolveTenant,{ client: tx,authContext }),['shopId','installationId']));
        if (typeof tenant.shopId !== 'string' || typeof tenant.installationId !== 'string' || !tenant.installationId) fail(C.UNAUTHORIZED, 'Authenticated installation required');
        await executionAdapter.assertTenant({ client: tx,tenant });
        const op = (await tx.query(`SELECT * FROM edit_history.operations WHERE shop_id=$1 AND installation_id=$2 AND id=$3`,
          [tenant.shopId,tenant.installationId,request.operationId])).rows[0];
        let result = null;
        if (op&&op.purge_requested_at==null) {
          const operation = operationRecord(op);
          const authorize = () => invoke(authorizeHistoryRead,{ client: tx,authContext,tenant,operation: action,operationRecord: operation,request });
          if (await authorize() !== true) fail(C.UNAUTHORIZED, 'History read is not authorized for this operation');
          if (action === 'read_operation') result = operation;
          else if (action === 'read_request') {
            const rows = (await tx.query(`SELECT c.id,c.field_id,c.mutation_state,c.verification_state,c.attempt_number,
              c.execution_item_id,c.resource_gid,c.resource_family_gid,c.execution_fence_epoch,c.execution_claim_id,c.mutation_plan_fingerprint,
              s.id AS snapshot_id FROM edit_history.changes c LEFT JOIN edit_history.snapshots s
              ON s.shop_id=c.shop_id AND s.installation_id=c.installation_id AND s.operation_id=c.operation_id
                AND s.change_id=c.id AND s.snapshot_kind='BEFORE'
              WHERE c.shop_id=$1 AND c.installation_id=$2 AND c.operation_id=$3 AND c.mutation_id=$4 AND c.attempt_id=$5
              ORDER BY c.field_id,c.id LIMIT 65`,[tenant.shopId,tenant.installationId,request.operationId,request.mutationId,request.attemptId])).rows;
            if (rows.length > 64) fail(C.LIMIT_EXCEEDED, 'Persisted request exceeds field bound');
            if (rows.some(row => !row.snapshot_id)) fail(C.EVIDENCE_REQUIRED, 'Persisted request lacks BEFORE evidence');
            for (const row of rows.slice(1)) match([row.attempt_number,row.execution_item_id,
              row.execution_fence_epoch,row.execution_claim_id,row.mutation_plan_fingerprint],
            [rows[0].attempt_number,rows[0].execution_item_id,
              rows[0].execution_fence_epoch,rows[0].execution_claim_id,rows[0].mutation_plan_fingerprint], 'Persisted request has mixed attempt identities');
            if(rows.length){
              const envelope=(await tx.query(`SELECT resource_field_set,field_count,dispatch_handoff_key,request_state FROM edit_history.mutation_requests
                WHERE shop_id=$1 AND installation_id=$2 AND operation_id=$3 AND mutation_id=$4 AND attempt_id=$5`,
              [tenant.shopId,tenant.installationId,request.operationId,request.mutationId,request.attemptId])).rows[0];
              if(!envelope)fail(C.BINDING_CONFLICT,'Durable request envelope missing');
              match(rows.map(changeMemberKey).sort(),requestMembers(envelope).map(historyMemberKey).sort(),'Persisted request member set is incomplete');
              result = canonicalHistoryJson({ ...request,attemptNumber: rows[0].attempt_number,
                dispatchHandoffKey: envelope.dispatch_handoff_key,requestState: envelope.request_state,
                state: new Set(rows.map(row => row.mutation_state)).size === 1 ? rows[0].mutation_state : 'MIXED',
                fields: rows.map(row => ({ changeId: row.id,snapshotId: row.snapshot_id,fieldId: row.field_id,resourceGid:row.resource_gid,state: row.mutation_state,verificationState: row.verification_state })) });
            }
          } else {
            const row = (await tx.query(`SELECT s.*,o.execution_job_id,o.execution_fingerprint AS operation_execution_fingerprint,
              o.filter_fingerprint AS operation_filter_fingerprint,c.execution_item_id,c.mutation_id,c.before_snapshot_fingerprint,
              c.resource_gid AS change_resource_gid,c.field_id AS change_field_id,c.field_definition_revision AS change_definition_revision
              FROM edit_history.snapshots s JOIN edit_history.changes c ON c.shop_id=s.shop_id AND c.installation_id=s.installation_id
                AND c.operation_id=s.operation_id AND c.id=s.change_id
              JOIN edit_history.operations o ON o.shop_id=s.shop_id AND o.installation_id=s.installation_id AND o.id=s.operation_id
              WHERE s.shop_id=$1 AND s.installation_id=$2 AND s.operation_id=$3 AND s.change_id=$4 AND s.id=$5`,
            [tenant.shopId,tenant.installationId,request.operationId,request.changeId,request.snapshotId])).rows[0];
            if (row) {
              const reveal=()=>invoke(authorizeHistoryValueRead,{authContext,tenant,operation:'reveal_snapshot_value',request,
                fieldId:row.field_id,resourceGid:row.resource_gid,snapshotKind:row.snapshot_kind});
              if(typeof authorizeHistoryValueRead!=='function'||await reveal()!==true)result=Object.freeze({...request,redacted:true,snapshot:null});
              else{
                const snapshot=storedSnapshot(await valueProtection.open(row,{client:tx,tenant,authContext}));
                if(await reveal()!==true)fail(C.UNAUTHORIZED,'History value permission changed');
                result=Object.freeze({...request,redacted:false,mirrorBeforeSnapshotId:row.mirror_before_snapshot_id,snapshot});
              }
            }
          }
          if (await authorize() !== true) fail(C.UNAUTHORIZED, 'History read authorization changed');
        }
        match(canonicalHistoryJson(await invoke(resolveTenant,{ client: tx,authContext })),tenant,'Authenticated installation changed during history read');
        await tx.query('COMMIT');
        return result;
      } catch (error) {
        await tx.query('ROLLBACK').catch(() => {});
        if (['40001','40P01'].includes(error.code) && retry<2) continue;
        throw error;
      } finally { tx.release(); }
    }
  }
  const repository=Object.freeze({
    ...createHistoryPages({database,executionAdapter,resolveTenant,authorizeHistoryRead,historyCursorSecret,operationRecord}),
    ...createHistoryLifecycle({database,executionAdapter,resolveTenant,authorizeRecovery,authorizeDispatch,loadMutationEvidence,verifyMutationEvidence,valueProtection}),
    prepareRequest: input => execute(input, false),beginDispatch: input => execute(input, true),
    getOperation: input => read(input,'read_operation'),getRequest: input => read(input,'read_request'),getSnapshot: input => read(input,'read_snapshot'),
  });
  issuedRepositories.add(repository);return repository;
}
// Local integrity validation only; maintenance must independently authenticate
// its database role and bind rows to the exact tenant before using it.
export { storedSnapshot as validateStoredHistorySnapshot };
