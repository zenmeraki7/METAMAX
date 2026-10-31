import assert from 'node:assert/strict';
import { createHistoryExecutionAuthority } from '../execution-authority.server.js';
import { createHistoryExecutionAdapter } from '../../services/history-execution-adapter.server.js';

const LOCK = 'AUTHORITATIVE_EXECUTION_JOB_UNTIL_TRANSACTION_END';

// Explicit fixture composition for the proposed durable V3 stores. It reuses the
// real engine integration adapter for schema, approval, target and lease checks.
// It is not a production provider or a fallback for missing admission storage.
function authorityFor(f, overrides = {}) {
  const engine = createHistoryExecutionAdapter();
  const loadStored = context => f.adapters.loadExecutionPlan({ ...context, ...context.tenant,
    operationId: f.input.operationId, mutationId: context.plan?.mutationId ?? context.mutationId });
  const adapters = {
    resolveTenant: f.adapters.resolveTenant,
    async verifyInstallation(context) {
      await engine.assertTenant(context);
      return { ...context.tenant, verified: true, current: true };
    },
    async loadApprovedExecutionPlan(context) {
      const stored = await loadStored(context);
      if (!stored) return null;
      const plan = Object.fromEntries(['shopId', 'installationId', 'executionJobId', 'editOperationId', 'executionContractId',
        'mutationId', 'mutationPlanFingerprint', 'executionFingerprint', 'filterFingerprint', 'approvedContractFingerprint',
        'attemptId', 'attemptNumber', 'fenceEpoch', 'executionClaimId', 'startedAt'].map(key => [key, stored[key]]));
      return { ...plan, executionItemId: stored.fields[0].identity.executionItemId,
        fields: stored.fields.map(field => ({ ...field, mutationPlanFingerprint: stored.mutationPlanFingerprint })) };
    },
    async verifyExecutionOwnership(context) {
      const stored = await loadStored(context);
      const locked = await engine.lockAuthority({ ...context, plan: stored });
      for (const field of stored.fields) {
        const entry = { intent: { identity: field.identity }, resourceFamilyGid: field.resourceFamilyGid, mirrorBeforeSnapshotId: null };
        await engine.verifyTarget({ ...context, selection: locked.selection, coverage: locked.coverage, entry });
        await engine.verifyFieldOwnership({ ...context, plan: stored, entry, expected: field });
      }
      await locked.assertClaim();
      return { ...context.tenant, verified: true, executionJobId: context.plan.executionJobId,
        executionItemId: context.plan.executionItemId, mutationId: context.plan.mutationId, ...context.claim, lockScope: LOCK };
    },
    async verifyFieldAuthorization(context) {
      return { ...context.tenant, verified: await f.adapters.authorizePlan(context),
        executionJobId: context.plan.executionJobId, mutationId: context.plan.mutationId,
        approvedPlanFingerprint: context.plan.mutationPlanFingerprint };
    },
    async verifyObservationProvenance(context) {
      const snapshot = context.beforeSnapshot;
      const verified = await f.adapters.verifyObservation({ ...context, snapshot, mirrorSnapshot: null });
      return { ...context.tenant, verified, observationId: snapshot.observation.observationId,
        snapshotFingerprint: snapshot.fingerprint, evidenceBindingFingerprint: snapshot.evidenceBindingFingerprint,
        receiptFingerprint: snapshot.observation.receiptFingerprint };
    },
  };
  const authority = createHistoryExecutionAuthority({ ...adapters, ...overrides });
  return { authority, adapters, engine, input: client => ({ client, authContext: f.input.authContext,
    executionJobId: f.command, mutationId: f.input.mutationId, claim: f.input.claim, entries: f.input.entries }) };
}

export async function testExecutionAuthority(t, fixture, pool) {
  await t.test('execution authority keeps the real engine row lock until the caller transaction ends', async () => {
    const f = await fixture(), tx = await pool.connect(), other = await pool.adminConnect(), a = authorityFor(f);
    try {
      await tx.query('BEGIN'); await a.engine.beginScope({ client: tx, write: true });
      const receipt = await a.authority.authorizeAdmission(a.input(tx));
      assert.equal(receipt.executionJobId, f.command); assert.equal(receipt.fields.length, 2);
      await other.query('BEGIN'); await other.query("SET LOCAL lock_timeout='100ms'");
      await assert.rejects(() => other.query('UPDATE mirror.job_commands SET fence=fence+1 WHERE shop_id=$1 AND id=$2',
        [f.shopId, f.command]), { code: '55P03' });
      await other.query('ROLLBACK');
      await tx.query('COMMIT');
      await other.query('UPDATE mirror.job_commands SET fence=fence+1 WHERE shop_id=$1 AND id=$2', [f.shopId, f.command]);
      await tx.query('BEGIN'); await a.engine.beginScope({ client: tx, write: true });
      await assert.rejects(() => a.authority.authorizeAdmission(a.input(tx)), { code: 'HISTORY_OWNERSHIP_LOST' });
    } finally {
      await tx.query('ROLLBACK').catch(() => {}); await other.query('ROLLBACK').catch(() => {});
      tx.release(); other.release();
    }
  });

  await t.test('execution authority authenticates persisted receipt contents and real approval hashes', async () => {
    for (const tamper of ['receipt', 'approval']) {
      const f = await fixture(), tx = await pool.connect(), a = authorityFor(f);
      try {
        if (tamper === 'receipt') await f.q('DELETE FROM history_test_authority.observations WHERE shop_id=$1', [f.shopId]);
        const badHash = 'f'.repeat(64);
        // Approved contracts are immutable. Model corrupt source reads at the
        // connection boundary, leaving the real database guards enabled.
        if (tamper === 'approval') await f.persistPlan({ ...f.plan, approvedContractFingerprint: `sha256:${badHash}` });
        const client = tamper === 'approval' ? { async query(sql, values) {
          const result = await tx.query(sql, values);
          if (sql.includes('SELECT * FROM mirror.execution_contracts') || sql.includes('SELECT c.*, s.selection_hash'))
            return { ...result, rows: result.rows.map(row => ({ ...row, contract_hash: badHash })) };
          return result;
        } } : tx;
        await tx.query('BEGIN'); await a.engine.beginScope({ client: tx, write: true });
        await assert.rejects(() => a.authority.authorizeAdmission(a.input(client)),
          { code: tamper === 'receipt' ? 'HISTORY_EVIDENCE_CONFLICT' : 'HISTORY_BINDING_CONFLICT' });
      } finally { await tx.query('ROLLBACK').catch(() => {}); tx.release(); }
    }
  });

  await t.test('execution authority rejects an engine lease that expires during durable receipt verification', async () => {
    const f = await fixture(), tx = await pool.connect(); let checked = false;
    const original = authorityFor(f);
    const a = authorityFor(f, { async verifyObservationProvenance(context) {
      const proof = await original.adapters.verifyObservationProvenance(context);
      if (!checked) { checked = true; await context.client.query('SELECT pg_sleep(1.1)'); }
      return proof;
    } });
    await f.q("UPDATE mirror.job_commands SET lease_until=clock_timestamp()+interval '1 second' WHERE shop_id=$1 AND id=$2", [f.shopId, f.command]);
    try {
      await tx.query('BEGIN'); await a.engine.beginScope({ client: tx, write: true });
      await assert.rejects(() => a.authority.authorizeAdmission(a.input(tx)), { code: 'HISTORY_OWNERSHIP_LOST' });
      assert.equal(checked, true);
      assert.equal((await tx.query('SELECT count(*) FROM edit_history.operations WHERE shop_id=$1', [f.shopId])).rows[0].count, '0');
    } finally { await tx.query('ROLLBACK').catch(() => {}); tx.release(); }
  });
}
