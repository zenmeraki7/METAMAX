import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { testJournalRepository } from './journal-repository.js';

const fingerprint = `sha256:${'a'.repeat(64)}`;
const differentFingerprint = `sha256:${'b'.repeat(64)}`;
const shop = 'history-test.myshopify.com';
const installation = 'installation-1';
const migration = new URL('../../prisma-fresh/20261030110000_edit_history_v2/migration.sql', import.meta.url);

test('Edit History V2 against isolated PostgreSQL', async t => {
  const target = process.env.FILTER_TEST_DATABASE_URL;
  assert.ok(target && process.env.FILTER_TEST_DATABASE_ISOLATED === '1', 'Use npm run test:history:postgres');
  const url = new URL(target);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/metamax_filter_test');
  const pool = new pg.Pool({ connectionString: target });
  const q = (sql, values) => pool.query(sql, values);
  // All SQL identifiers below are test-owned constants, never request input.
  async function insert(client, table, row) {
    const keys = Object.keys(row);
    await client.query(`INSERT INTO edit_history.${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
    return row.id;
  }
  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  let job = 0;
  async function operation(overrides = {}) {
    const row = { id: randomUUID(), shop_id: shop, installation_id: installation,
      execution_job_id: String(++job), operation_kind: 'BULK_EDIT', execution_fingerprint: fingerprint, ...overrides };
    await insert(pool, 'operations', row);
    return row.id;
  }
  function change(operationId, overrides = {}) {
    return { id: randomUUID(), shop_id: shop, installation_id: installation, operation_id: operationId,
      execution_item_id: '9223372036854775807', mutation_id: randomUUID(), attempt_id: randomUUID(), attempt_number: 1,
      execution_fence_epoch: '9007199254740993', execution_claim_id: 'claim-1',
      resource_gid: 'gid://shopify/Product/1', resource_family_gid: 'gid://shopify/Product/1',
      field_id: 'product.title', field_definition_revision: 'registry-1',
      mutation_plan_fingerprint: fingerprint, intended_value_fingerprint: fingerprint,
      before_snapshot_fingerprint: fingerprint, ...overrides };
  }
  function snapshot(c, overrides = {}) {
    return { id: randomUUID(), shop_id: c.shop_id, installation_id: c.installation_id,
      operation_id: c.operation_id, change_id: c.id, snapshot_kind: 'BEFORE', value_kind: 'VALUE',
      value_json: 'null', snapshot_fingerprint: c.before_snapshot_fingerprint,
      evidence_binding_fingerprint: fingerprint, observation_id: randomUUID(), observation_source: 'SHOPIFY_GRAPHQL',
      observed_at: new Date(), observation_receipt_id: randomUUID(), observation_receipt_fingerprint: fingerprint,
      resource_gid: c.resource_gid, field_id: c.field_id, field_definition_revision: c.field_definition_revision,
      filter_fingerprint: fingerprint, execution_fingerprint: fingerprint, field_resolution_fingerprint: fingerprint,
      binding_mode: 'SHOPIFY_DIRECT', ...overrides };
  }
  async function pair(overrides = {}, snapshotOverrides = {}) {
    const c = change(await operation(), overrides);
    const s = snapshot(c, snapshotOverrides);
    await transaction(async client => { await insert(client, 'changes', c); await insert(client, 'snapshots', s); });
    return { c, s };
  }
  async function undo(operationId, overrides = {}) {
    const row = { id: randomUUID(), shop_id: shop, installation_id: installation, original_operation_id: operationId,
      idempotency_key: randomUUID(), request_fingerprint: fingerprint, handoff_key: randomUUID(), ...overrides };
    await insert(pool, 'undo_requests', row);
    return row;
  }
  try {
    const sql = await readFile(migration, 'utf8');
    const migrations = new URL('../../prisma/migrations/', import.meta.url);
    const dirs = (await readdir(migrations, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort();
    // Apply the real predecessor schema; V2 is an alternative to V1, not its successor.
    for (const directory of dirs.filter(name => name < '20261030110000_edit_history_v1')) {
      const predecessor = await readFile(new URL(`${directory}/migration.sql`, migrations), 'utf8');
      await transaction(client => client.query(predecessor));
    }
    await t.test('failed transactional DDL leaves no partial schema', async () => {
      await assert.rejects(() => transaction(client => client.query(`${sql}\nSELECT history_forced_failure;`)), { code: '42703' });
      assert.equal((await q("SELECT to_regnamespace('edit_history') AS schema")).rows[0].schema, null);
    });
    const v1 = await readFile(new URL('20261030110000_edit_history_v1/migration.sql', migrations), 'utf8');
    const upgrade = await readFile(new URL('20261030120000_edit_history_v2_upgrade/migration.sql', migrations), 'utf8');
    await t.test('populated V1 upgrade fails without modifying legacy rows or schema', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query(v1);
        await client.query(`INSERT INTO edit_history.operations(id,shop_id,installation_id,execution_job_id,operation_kind,execution_fingerprint)
          VALUES($1,'legacy-history.myshopify.com','legacy-install',1,'BULK_EDIT',$2)`, [randomUUID(),fingerprint]);
        await client.query('SAVEPOINT legacy');
        await assert.rejects(() => client.query(upgrade), { code: '55000' });
        await client.query('ROLLBACK TO SAVEPOINT legacy');
        assert.equal((await client.query('SELECT count(*) FROM edit_history.operations')).rows[0].count, '1');
        assert.ok((await client.query("SELECT to_regclass('edit_history.hist_snapshots_one_before_idx') AS old_index")).rows[0].old_index);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
    if (process.env.HISTORY_TEST_UPGRADE === '1') {
      await q(v1); await q(upgrade);
      await t.test('upgraded V1 has the same physical schema as fresh V2', async () => {
        await q(sql.replaceAll('edit_history.', 'history_expected.').replace('CREATE SCHEMA IF NOT EXISTS edit_history;', 'CREATE SCHEMA IF NOT EXISTS history_expected;'));
        async function signature(schema) {
          const result = await q(`SELECT 'column' AS kind,c.relname AS table_name,a.attname AS name,
              format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),'') AS definition
            FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
            LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
            UNION ALL SELECT 'constraint',c.relname,k.conname,pg_get_constraintdef(k.oid)
            FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1
            UNION ALL SELECT 'index',tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=$1
            UNION ALL SELECT 'trigger',c.relname,t.tgname,pg_get_triggerdef(t.oid)
            FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal
            UNION ALL SELECT 'function','',p.proname,pg_get_functiondef(p.oid)
            FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1
            ORDER BY kind,table_name,name`, [schema]);
          return result.rows.map(row => ({ ...row,definition: row.definition.replaceAll(`${schema}.`, 'HISTORY.').replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim() }));
        }
        assert.deepEqual(await signature('edit_history'), await signature('history_expected'));
      });
    } else await transaction(client => client.query(sql));
    await t.test('fresh migration installs all five tables and the deferred barrier', async () => {
      const tables = (await q("SELECT tablename FROM pg_tables WHERE schemaname='edit_history' ORDER BY tablename")).rows.map(r => r.tablename);
      assert.deepEqual(tables, ['changes', 'operations', 'recovery_tasks', 'snapshots', 'undo_requests']);
      const trigger = (await q("SELECT tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='eh_change_requires_before'")).rows[0];
      assert.deepEqual(trigger, { tgdeferrable: true, tginitdeferred: true });
    });
    await t.test('Mirror job command tenant and execution-fence columns match the verified backend binding', async () => {
      const columns = (await q(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required
        FROM pg_attribute a WHERE a.attrelid='mirror.job_commands'::regclass AND a.attnum>0 AND NOT a.attisdropped`)).rows;
      const expected = [
        ['id','bigint',true],['shop_id','text',true],['contract_id','text',true],['status','mirror."WorkStatus"',true],
        ['fence','bigint',true],['lease_token','text',false],['lease_until','timestamp(3) with time zone',false],
        ['cancel_requested_at','timestamp(3) with time zone',false],['attempts','integer',true],['max_attempts','integer',true],
      ];
      for (const [name,type,required] of expected) assert.deepEqual(columns.find(c => c.name === name), { name,type,required });
      for (const absent of ['installation_id','installation_version','execution_claim_id','attempt_id']) assert.equal(columns.some(c => c.name === absent),false);
      const key = (await q(`SELECT i.indisunique,pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i
        JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='mirror.job_commands'::regclass AND c.relname='job_commands_shop_id_id_key'`)).rows[0];
      assert.equal(key.indisunique,true); assert.match(key.definition,/\(shop_id, id\)/);
    });
    await t.test('V1 and V2 cannot be stacked and failed application preserves V2', async () => {
      const v1 = await readFile(new URL('20261030110000_edit_history_v1/migration.sql', migrations), 'utf8');
      await assert.rejects(() => transaction(client => client.query(v1)), { code: '42P07' });
      assert.equal((await q("SELECT count(*) FROM pg_tables WHERE schemaname='edit_history'")).rows[0].count, '5');
    });
    await t.test('BEFORE barrier rejects missing or mismatched evidence at COMMIT and rolls back', async () => {
      const op = await operation();
      const missing = change(op);
      await assert.rejects(() => transaction(client => insert(client, 'changes', missing)), { code: '23514' });
      assert.equal((await q('SELECT count(*) FROM edit_history.changes WHERE id=$1', [missing.id])).rows[0].count, '0');
      for (const overrides of [{ snapshot_fingerprint: differentFingerprint }, { resource_gid: 'wrong-resource' },
        { field_id: 'product.vendor' }, { field_definition_revision: 'wrong-revision' }]) {
        await assert.rejects(() => pair({}, overrides), { code: '23514' });
      }
      const { c } = await pair();
      const stored = (await q('SELECT execution_item_id,execution_fence_epoch FROM edit_history.changes WHERE id=$1', [c.id])).rows[0];
      assert.equal(stored.execution_item_id, '9223372036854775807');
      assert.equal(stored.execution_fence_epoch, '9007199254740993');
    });
    await t.test('composite FKs isolate shops, installations and operation ancestry', async () => {
      const { c } = await pair();
      for (const overrides of [{ shop_id: 'other.myshopify.com' }, { installation_id: 'installation-2' }]) {
        await assert.rejects(() => transaction(client => insert(client, 'changes', change(c.operation_id, overrides))), { code: '23503' });
        await assert.rejects(() => insert(pool, 'snapshots', snapshot(c, overrides)), { code: '23503' });
        await assert.rejects(() => undo(c.operation_id, overrides), { code: '23503' });
      }
      await assert.rejects(async () => insert(pool, 'snapshots', snapshot(c, { snapshot_kind: 'OBSERVED_AFTER', operation_id: await operation() })), { code: '23503' });
    });
    await t.test('snapshots distinguish JSON null, SQL NULL and ABSENT and remain immutable', async () => {
      const { c, s } = await pair();
      assert.equal((await q("SELECT value_json IS NOT NULL AND value_json='null'::jsonb AS valid FROM edit_history.snapshots WHERE id=$1", [s.id])).rows[0].valid, true);
      await assert.rejects(() => pair({}, { value_json: null }), { code: '23514' });
      await pair({}, { value_kind: 'ABSENT', value_json: null });
      await assert.rejects(() => pair({}, { value_kind: 'ABSENT' }), { code: '23514' });
      await pair({}, { value_encoding: 'ENCRYPTED_JSON', value_json: null, encrypted_value: Buffer.from('ciphertext'), encryption_key_reference: 'key-1' });
      await assert.rejects(() => pair({}, { value_encoding: 'ENCRYPTED_JSON', value_json: null, encrypted_value: Buffer.from('ciphertext') }), { code: '23514' });
      await assert.rejects(() => insert(pool, 'snapshots', snapshot(c)), { code: '23505' });
      await insert(pool, 'snapshots', snapshot(c, { snapshot_kind: 'OBSERVED_AFTER' }));
      await assert.rejects(() => q('UPDATE edit_history.snapshots SET source_revision=$1 WHERE id=$2', ['changed', s.id]), { code: '55000' });
      await assert.rejects(() => q('DELETE FROM edit_history.snapshots WHERE id=$1', [s.id]), { code: '55000' });
      await assert.rejects(() => pair({}, { binding_mode: 'MIRROR_PINNED', observation_source: 'MIRROR_PINNED' }), { code: '23514' });
      await pair({}, { binding_mode: 'MIRROR_PINNED', observation_source: 'MIRROR_PINNED', generation_id: 'g1', coverage_revision: 'c1', mapping_version: 'm1' });
    });
    await t.test('NULL evidence cannot satisfy outcome checks on INSERT', async () => {
      for (const state of ['VERIFIED', 'FAILED_NO_WRITE', 'CONFLICT', 'OUTCOME_UNKNOWN', 'ACKNOWLEDGED']) {
        await assert.rejects(() => pair({ mutation_state: state,
          verification_state: state === 'VERIFIED' ? 'MATCHED' : state === 'CONFLICT' ? 'MISMATCHED' : 'NOT_CHECKED',
          ...(state === 'VERIFIED' ? { verified_at: new Date(Date.now() + 1000) } : {}) }), { code: '23514' });
      }
    });
    await t.test('transitions reject missing evidence, invalid jumps and terminal rewrites', async () => {
      const { c } = await pair();
      await assert.rejects(() => q("UPDATE edit_history.changes SET mutation_state='VERIFIED' WHERE id=$1", [c.id]), { code: '23514' });
      await q("UPDATE edit_history.changes SET mutation_state='DISPATCHING' WHERE id=$1", [c.id]);
      await assert.rejects(() => q("UPDATE edit_history.changes SET mutation_state='OUTCOME_UNKNOWN' WHERE id=$1", [c.id]), { code: '23514' });
      await q("UPDATE edit_history.changes SET mutation_state='OUTCOME_UNKNOWN',last_evidence_kind='AMBIGUOUS',last_evidence_fingerprint=$2 WHERE id=$1", [c.id, fingerprint]);
      await assert.rejects(() => q('UPDATE edit_history.changes SET last_evidence_kind=NULL,last_evidence_fingerprint=NULL WHERE id=$1', [c.id]), { code: '23514' });
      await q("UPDATE edit_history.changes SET mutation_state='ACKNOWLEDGED',last_evidence_kind='SHOPIFY_ACKNOWLEDGEMENT',acknowledged_at=clock_timestamp() WHERE id=$1", [c.id]);
      await q("UPDATE edit_history.changes SET mutation_state='VERIFIED',verification_state='MATCHED',last_evidence_kind='VERIFIED_OBSERVATION',verified_at=clock_timestamp() WHERE id=$1", [c.id]);
      await assert.rejects(() => q("UPDATE edit_history.changes SET mutation_state='OUTCOME_UNKNOWN' WHERE id=$1", [c.id]), { code: '55000' });
      await assert.rejects(() => q('UPDATE edit_history.changes SET last_evidence_fingerprint=$2 WHERE id=$1', [c.id, differentFingerprint]), { code: '55000' });
      await assert.rejects(() => q("UPDATE edit_history.changes SET field_id='product.vendor' WHERE id=$1", [c.id]), { code: '55000' });
    });
    await t.test('all five transition evidence comparisons reject NULL in the trigger', async () => {
      const cases = [
        ['DISPATCHING', 'OUTCOME_UNKNOWN'],
        ['DISPATCHING', 'ACKNOWLEDGED'],
        ['ACKNOWLEDGED', 'VERIFIED'],
        ['PREPARED', 'FAILED_NO_WRITE'],
        ['ACKNOWLEDGED', 'CONFLICT'],
      ];
      for (const [source, destination] of cases) {
        const { c } = await pair({ mutation_state: source,
          ...(source === 'ACKNOWLEDGED' ? {
            last_evidence_kind: 'SHOPIFY_ACKNOWLEDGEMENT', last_evidence_fingerprint: fingerprint,
          } : {}),
        });
        await assert.rejects(() => q(`UPDATE edit_history.changes SET mutation_state=$2,
          last_evidence_kind=NULL,last_evidence_fingerprint=NULL WHERE id=$1`, [c.id, destination]),
        { code: '23514', message: 'Mutation transition lacks matching evidence type' });
        assert.equal((await q('SELECT mutation_state FROM edit_history.changes WHERE id=$1', [c.id])).rows[0].mutation_state, source);
      }
    });
    await t.test('operation identity, terminal status, counts and retention guards', async () => {
      const op = await operation();
      await assert.rejects(() => q('UPDATE edit_history.operations SET execution_job_id=99999 WHERE id=$1', [op]), { code: '55000' });
      await assert.rejects(() => q('UPDATE edit_history.operations SET changes_verified=1 WHERE id=$1', [op]), { code: '23514' });
      await q("UPDATE edit_history.operations SET operation_state='COMPLETED',completed_at=clock_timestamp() WHERE id=$1", [op]);
      await assert.rejects(() => q("UPDATE edit_history.operations SET operation_state='ACTIVE',completed_at=NULL WHERE id=$1", [op]), { code: '55000' });
      await assert.rejects(() => q('DELETE FROM edit_history.operations WHERE id=$1', [op]), { code: '55000' });
      await assert.rejects(() => operation({ execution_fingerprint: 'invalid' }), { code: '23514' });
    });
    await t.test('concurrent same-attempt insertion has one durable winner', async () => {
      const op = await operation();
      const first = change(op);
      const second = { ...first, id: randomUUID() };
      const write = c => transaction(async client => { await insert(client, 'changes', c); await insert(client, 'snapshots', snapshot(c)); });
      const results = await Promise.allSettled([write(first), write(second)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.find(r => r.status === 'rejected').reason.code, '23505');
      assert.equal((await q('SELECT count(*) FROM edit_history.changes WHERE operation_id=$1', [op])).rows[0].count, '1');
      await write({ ...first, id: randomUUID(), attempt_id: randomUUID(), attempt_number: 2 });
    });
    await t.test('undo keys, approval freeze, handoff identity and terminal claims', async () => {
      const op = await operation();
      const u = await undo(op);
      await assert.rejects(() => undo(op, { idempotency_key: u.idempotency_key }), { code: '23505' });
      await assert.rejects(() => undo(op, { handoff_key: u.handoff_key }), { code: '23505' });
      await assert.rejects(() => q("UPDATE edit_history.undo_requests SET claimed_by='worker' WHERE id=$1", [u.id]), { code: '23514' });
      await q("UPDATE edit_history.undo_requests SET preflight_fingerprint=$2,inverse_plan_fingerprint=$2,approval_reference='approval-1',approved_at=clock_timestamp(),undo_state='APPROVED' WHERE id=$1", [u.id, fingerprint]);
      await assert.rejects(() => q('UPDATE edit_history.undo_requests SET preflight_fingerprint=$2 WHERE id=$1', [u.id, differentFingerprint]), { code: '55000' });
      await q("UPDATE edit_history.undo_requests SET execution_job_id=12345,execution_contract_id='contract-1',undo_state='EXECUTING' WHERE id=$1", [u.id]);
      await assert.rejects(() => q('UPDATE edit_history.undo_requests SET execution_job_id=12346 WHERE id=$1', [u.id]), { code: '55000' });
      await assert.rejects(() => undo(op, { execution_job_id: '12345' }), { code: '23505' });
      await q("UPDATE edit_history.undo_requests SET undo_state='COMPLETED',completed_at=clock_timestamp() WHERE id=$1", [u.id]);
      await assert.rejects(() => q("UPDATE edit_history.undo_requests SET undo_state='REQUESTED',completed_at=NULL WHERE id=$1", [u.id]), { code: '55000' });
      await assert.rejects(() => q('DELETE FROM edit_history.undo_requests WHERE id=$1', [u.id]), { code: '55000' });
    });
    await t.test('recovery target ancestry, dedupe, claims, retry limits and deletion guards', async () => {
      const { c } = await pair();
      const u = await undo(c.operation_id);
      const row = { id: randomUUID(), shop_id: shop, installation_id: installation, operation_id: c.operation_id,
        change_id: c.id, task_kind: 'MUTATION_OUTCOME', dedupe_key: randomUUID() };
      await insert(pool, 'recovery_tasks', row);
      await assert.rejects(() => insert(pool, 'recovery_tasks', { ...row, id: randomUUID() }), { code: '23505' });
      await assert.rejects(async () => insert(pool, 'recovery_tasks', { ...row, id: randomUUID(), dedupe_key: randomUUID(), operation_id: await operation() }), { code: '23503' });
      await assert.rejects(() => insert(pool, 'recovery_tasks', { ...row, id: randomUUID(), dedupe_key: randomUUID(), change_id: null }), { code: '23514' });
      await insert(pool, 'recovery_tasks', { ...row, id: randomUUID(), dedupe_key: randomUUID(), change_id: null, undo_request_id: u.id, task_kind: 'UNDO_HANDOFF' });
      await assert.rejects(() => q("UPDATE edit_history.recovery_tasks SET task_state='RECONCILING' WHERE id=$1", [row.id]), { code: '23514' });
      await q("UPDATE edit_history.recovery_tasks SET task_state='RECONCILING',claimed_by='worker',claim_token=$2,fence_epoch=1,claim_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1", [row.id, randomUUID()]);
      await assert.rejects(() => q("UPDATE edit_history.recovery_tasks SET task_state='COMPLETED',completed_at=clock_timestamp() WHERE id=$1", [row.id]), { code: '23514' });
      await q("UPDATE edit_history.recovery_tasks SET task_state='RETRY_WAIT',attempt_count=1,claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL WHERE id=$1", [row.id]);
      await assert.rejects(() => q('UPDATE edit_history.recovery_tasks SET max_attempts=0 WHERE id=$1', [row.id]), { code: '23514' });
      await q("UPDATE edit_history.recovery_tasks SET task_state='COMPLETED',completed_at=clock_timestamp() WHERE id=$1", [row.id]);
      await assert.rejects(() => q('DELETE FROM edit_history.recovery_tasks WHERE id=$1', [row.id]), { code: '55000' });
      await assert.rejects(() => q('DELETE FROM edit_history.changes WHERE id=$1', [c.id]), { code: '55000' });
    });
    const mutationRequestsSql = await readFile(new URL('20261030130000_edit_history_mutation_requests/migration.sql', migrations), 'utf8');
    await t.test('mutation-requests migration requires multi-resource integrity prerequisites', async () => {
      const client = await pool.connect();
      try {
        await assert.rejects(() => client.query(mutationRequestsSql), { code: 'P0001' });
        await client.query('ROLLBACK');
      } finally { client.release(); }
      assert.equal((await q("SELECT to_regclass('edit_history.mutation_requests') AS request")).rows[0].request, null);
    });
    // Reset only this runner's disposable, localhost-only history fixture.
    // The production migration itself never drops history or manufactures it.
    await q('DROP SCHEMA edit_history CASCADE');
    if(process.env.HISTORY_TEST_UPGRADE==='1'){await q(v1);await q(upgrade);}else await q(sql);
    const multiResourceSql=await readFile(new URL('20261030125000_edit_history_multi_resource_integrity/migration.sql',migrations),'utf8');
    const multiBody=multiResourceSql.replace(/^BEGIN;\r?$/m,'').replace(/^COMMIT;\r?$/m,'');
    await t.test('multi-resource migration rejects disabled guards, ambiguous keys, partial names and unexpected definitions atomically',async()=>{
      for(const setup of [
        'ALTER TABLE edit_history.changes DISABLE TRIGGER eh_change_guard',
        'ALTER TABLE edit_history.changes ADD CONSTRAINT hist_changes_attempt_field_unique UNIQUE(shop_id,installation_id,operation_id,mutation_id,attempt_id,field_id)',
        'ALTER TABLE edit_history.changes RENAME CONSTRAINT eh_change_attempt_field_unique TO hist_changes_attempt_field_unique',
        'ALTER TABLE edit_history.changes DROP CONSTRAINT eh_change_attempt_field_unique; ALTER TABLE edit_history.changes ADD CONSTRAINT eh_change_attempt_field_unique UNIQUE(shop_id,id)',
      ]){
        const client=await pool.connect();
        try{
          await client.query('BEGIN');await client.query(setup);await client.query('SAVEPOINT migration_attempt');
          await assert.rejects(()=>client.query(multiBody),{code:'P0001'});await client.query('ROLLBACK TO SAVEPOINT migration_attempt');
          assert.equal((await client.query(`SELECT count(*) FROM pg_constraint WHERE conrelid='edit_history.changes'::regclass
            AND conname IN ('eh_change_attempt_resource_field_unique','eh_change_attempt_number_resource_field_unique')`)).rows[0].count,'0');
        }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
      }
    });
    await t.test('multi-resource migration supports the complete alternate constraint naming scheme',async()=>{
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        await client.query(`ALTER TABLE edit_history.changes RENAME CONSTRAINT eh_change_attempt_field_unique TO hist_changes_attempt_field_unique;
          ALTER TABLE edit_history.changes RENAME CONSTRAINT eh_change_attempt_number_unique TO hist_changes_attempt_number_unique;
          ALTER TRIGGER eh_change_guard ON edit_history.changes RENAME TO hist_changes_protect_identity`);
        await client.query(multiBody);
        assert.equal((await client.query(`SELECT count(*) FROM pg_constraint WHERE conrelid='edit_history.changes'::regclass
          AND conname IN ('eh_change_attempt_resource_field_unique','eh_change_attempt_number_resource_field_unique')`)).rows[0].count,'2');
      }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
    });
    await q(multiResourceSql);
    await t.test('attempt consistency fences stale Repeatable Read snapshots across resource writers',async()=>{
      const first=change(await operation()),second=change(first.operation_id,{mutation_id:first.mutation_id,attempt_id:first.attempt_id,
        resource_gid:'gid://shopify/Product/2',resource_family_gid:'gid://shopify/Product/2',execution_fence_epoch:'2'});
      const a=await pool.connect(),b=await pool.connect();
      try{
        await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await b.query('SELECT id FROM edit_history.operations WHERE id=$1',[first.operation_id]);
        await a.query('BEGIN');await insert(a,'changes',first);await insert(a,'snapshots',snapshot(first));await a.query('COMMIT');
        await assert.rejects(()=>insert(b,'changes',second),{code:'40001'});await b.query('ROLLBACK');
        await assert.rejects(()=>transaction(client=>insert(client,'changes',second)),{code:'23514'});
        second.execution_fence_epoch=first.execution_fence_epoch;
        await transaction(async client=>{await insert(client,'changes',second);await insert(client,'snapshots',snapshot(second));});
        assert.equal((await q('SELECT count(*) FROM edit_history.changes WHERE operation_id=$1',[first.operation_id])).rows[0].count,'2');
      }finally{await a.query('ROLLBACK').catch(()=>{});await b.query('ROLLBACK').catch(()=>{});a.release();b.release();}
    });
    // Only the private localhost fixture is reset; the envelope migration must
    // continue refusing populated history without trusted admission backfill.
    await q('DROP SCHEMA edit_history CASCADE');
    if(process.env.HISTORY_TEST_UPGRADE==='1'){await q(v1);await q(upgrade);}else await q(sql);
    await q(multiResourceSql);
    await q(mutationRequestsSql);

    function buildEnvelope(first, changesList, overrides = {}) {
      const compareC = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
      const set = changesList.map(c => ({
        resourceGid: c.resource_gid,
        fieldId: c.field_id,
      })).sort((a, b) => {
        const r = compareC(a.resourceGid, b.resourceGid);
        return r !== 0 ? r : compareC(a.fieldId, b.fieldId);
      });
      return {
        id: randomUUID(),
        shop_id: first.shop_id,
        installation_id: first.installation_id,
        operation_id: first.operation_id,
        mutation_id: first.mutation_id,
        attempt_id: first.attempt_id,
        attempt_number: first.attempt_number,
        execution_item_id: first.execution_item_id,
        execution_fence_epoch: first.execution_fence_epoch,
        execution_claim_id: first.execution_claim_id,
        mutation_plan_fingerprint: first.mutation_plan_fingerprint,
        request_fingerprint: fingerprint,
        resource_field_set: JSON.stringify(set),
        field_count: set.length,
        request_state: 'PREPARED',
        dispatch_handoff_key: `${first.operation_id}:${first.mutation_id}:${first.attempt_id}`,
        ...overrides,
      };
    }

    await t.test('mutation request envelope enforces sorted unique resource_field_set and matching count', async () => {
      const opId = await operation();
      const first = change(opId, { resource_gid: 'gid://shopify/Product/1', field_id: 'product.title' });
      const second = change(opId, { mutation_id: first.mutation_id, attempt_id: first.attempt_id, resource_gid: 'gid://shopify/Product/2', field_id: 'product.title' });

      // Unsorted array fails trigger
      const unsortedSet = [
        { resourceGid: 'gid://shopify/Product/2', fieldId: 'product.title' },
        { resourceGid: 'gid://shopify/Product/1', fieldId: 'product.title' },
      ];
      await assert.rejects(() => insert(pool, 'mutation_requests', buildEnvelope(first, [first, second], {
        resource_field_set: JSON.stringify(unsortedSet),
        dispatch_handoff_key: 'unsorted-test',
      })), { code: '23514' });

      // Duplicate array elements fail trigger
      const dupSet = [
        { resourceGid: 'gid://shopify/Product/1', fieldId: 'product.title' },
        { resourceGid: 'gid://shopify/Product/1', fieldId: 'product.title' },
      ];
      await assert.rejects(() => insert(pool, 'mutation_requests', buildEnvelope(first, [first, second], {
        resource_field_set: JSON.stringify(dupSet),
        dispatch_handoff_key: 'dup-test',
      })), { code: '23514' });

      // Count mismatch fails check constraint
      await assert.rejects(() => insert(pool, 'mutation_requests', buildEnvelope(first, [first, second], {
        field_count: 3,
        dispatch_handoff_key: 'count-mismatch',
      })), { code: '23514' });
    });

    await t.test('resource-aware uniqueness accepts the same field on two resources and verifies at commit', async () => {
      const first = change(await operation()), second = change(first.operation_id, {
        mutation_id: first.mutation_id, attempt_id: first.attempt_id,
        resource_gid: 'gid://shopify/Product/2', resource_family_gid: 'gid://shopify/Product/2',
      });
      const envelope = buildEnvelope(first, [first, second]);
      await transaction(async client => {
        await insert(client, 'mutation_requests', envelope);
        for (const c of [first, second]) {
          await insert(client, 'changes', c);
          await insert(client, 'snapshots', snapshot(c));
        }
      });
      assert.equal((await q('SELECT count(*) FROM edit_history.changes WHERE operation_id=$1', [first.operation_id])).rows[0].count, '2');
      assert.equal((await q('SELECT request_state FROM edit_history.mutation_requests WHERE id=$1', [envelope.id])).rows[0].request_state, 'PREPARED');
      await assert.rejects(() => transaction(client => insert(client, 'changes', { ...first, id: randomUUID() })), { code: '23505' });
    });

    await t.test('deferred triggers reject duplicate, missing, item-mismatched or fence-mismatched changes at commit', async () => {
      for (const mode of ['missing', 'extra', 'item', 'fence']) {
        const first = change(await operation()), second = change(first.operation_id, {
          mutation_id: first.mutation_id, attempt_id: first.attempt_id,
          resource_gid: 'gid://shopify/Product/2', resource_family_gid: 'gid://shopify/Product/2',
        });
        if (mode === 'item') second.execution_item_id = '999';
        if (mode === 'fence') second.execution_fence_epoch = '999';
        const envelope = buildEnvelope(first, [first, second]);
        await assert.rejects(() => transaction(async client => {
          await insert(client, 'mutation_requests', envelope);
          const toInsert = mode === 'missing' ? [first] : [first, second];
          for (const c of toInsert) {
            await insert(client, 'changes', c);
            await insert(client, 'snapshots', snapshot(c));
          }
          if (mode === 'extra') {
            const extra = change(first.operation_id, {
              mutation_id: first.mutation_id, attempt_id: first.attempt_id,
              resource_gid: 'gid://shopify/Product/3', resource_family_gid: 'gid://shopify/Product/3',
            });
            await insert(client, 'changes', extra);
            await insert(client, 'snapshots', snapshot(extra));
          }
        }), { code: '23514' });
        assert.equal((await q('SELECT count(*) FROM edit_history.changes WHERE operation_id=$1', [first.operation_id])).rows[0].count, '0');
      }
    });

    await t.test('mutation request envelope is immutable and rejects illegal transitions or deletion', async () => {
      const first = change(await operation());
      const envelope = buildEnvelope(first, [first]);
      await transaction(async client => {
        await insert(client, 'mutation_requests', envelope);
        await insert(client, 'changes', first);
        await insert(client, 'snapshots', snapshot(first));
      });
      // Immutable identity
      await assert.rejects(() => q('UPDATE edit_history.mutation_requests SET execution_fence_epoch=999 WHERE id=$1', [envelope.id]), { code: '55000' });
      // Illegal state transition directly to ACKNOWLEDGED
      await assert.rejects(() => q("UPDATE edit_history.mutation_requests SET request_state='ACKNOWLEDGED' WHERE id=$1", [envelope.id]), { code: '23514' });
      // Legal state transition to DISPATCH_AUTHORIZED
      await q("UPDATE edit_history.mutation_requests SET request_state='DISPATCH_AUTHORIZED', dispatch_authorized_at=clock_timestamp() WHERE id=$1", [envelope.id]);
      assert.equal((await q('SELECT request_state FROM edit_history.mutation_requests WHERE id=$1', [envelope.id])).rows[0].request_state, 'DISPATCH_AUTHORIZED');
      // Rejects deletion
      await assert.rejects(() => q('DELETE FROM edit_history.mutation_requests WHERE id=$1', [envelope.id]), { code: '55000' });
    });

    await q(await readFile(new URL('20261030150000_history_security_retention/migration.sql',migrations),'utf8'));
    await q(await readFile(new URL('20261030160000_history_undo_execution/migration.sql',migrations),'utf8'));
    for(const directory of dirs.filter(name=>name>'20261030160000_history_undo_execution')) await q(await readFile(new URL(directory+'/migration.sql',migrations),'utf8'));
    await testJournalRepository(t, pool);
  } finally { await pool.end(); }
});
