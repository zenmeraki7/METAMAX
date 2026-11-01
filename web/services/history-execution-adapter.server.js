import { requireResourceWriteContract, resourceTypeForGid, assertResourceExecutionRequest } from '../fields/write-capabilities.js';
import { lockPublication } from '../mirror/publication-lock.server.js';
/** Trusted Bulk Edit Engine integration; all Mirror SQL for history lives here.
 * Each repository transaction re-verifies physical columns, keys and joins.
 * No schema/authorization grant is cached between transactions.
 */
import { isDeepStrictEqual } from 'node:util';
import { getApprovedContractInTransaction, getEvidenceContractInTransaction } from './approval.server.js';
import { bulkInstructions, undoInstructions, importItemInstructions, assertIntendedValues } from './operation-instructions.server.js';
import { HistoryContractError, HISTORY_ERROR_CODES as C } from '../edit-history/history-contract.js';
const issued = new WeakSet();
const fail = (code, message) => { throw new HistoryContractError(code, message); };
const comparable = v => Array.isArray(v) ? v.map(comparable) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, comparable(x)])) : v;
const match = (a, b, message) => { if (!isDeepStrictEqual(comparable(a), comparable(b))) fail(C.BINDING_CONFLICT, message); };
const columns = {
  shops: 'id:text installation_version:text uninstalled_at:timestamptz?',
  publications: 'shop_id:text generation_id:text coverage_revision:text mapping_version:text _history_lock:int4',
  job_commands: 'id:int8 shop_id:text installation_version:text? contract_id:text status:WorkStatus fence:int8 lease_token:text? lease_until:timestamptz? cancel_requested_at:timestamptz?',
  edit_operations: 'id:int8 shop_id:text command_id:int8 preview_id:text',
  job_items: 'id:int8 shop_id:text command_id:int8 resource_id:text intended_values:jsonb status:WorkStatus',
  execution_contracts: 'shop_id:text id:text snapshot_id:text operation:text approval_revision:text status:ApprovalStatus expires_at:timestamptz contract_hash:text contract:jsonb hash_version:text canonical_contract:text? approved_by:text? approved_at:timestamptz?',
  selection_snapshots: 'installation_version:text? target_mode:text? shop_id:text id:text generation_id:text coverage_revision:text mapping_version:text operation:text operation_id:text status:ApprovalStatus expires_at:timestamptz filter_fingerprint:text selection_hash:text?',
  generations: 'shop_id:text id:text coverage_revision:text mapping_version:text status:GenerationStatus required_datasets:_text?',
  coverage: 'shop_id:text generation_id:text name:text status:CoverageStatus verified_at:timestamptz? verification_hash:text?',
  selection_items: 'shop_id:text snapshot_id:text generation_id:text product_id:int8',
  products: 'shop_id:text generation_id:text id:int8 shopify_id:text',
  variants: 'shop_id:text generation_id:text product_id:int8 shopify_id:text',
  product_snapshots: 'shop_id:text id:int8 edit_item_id:int8 before_values:jsonb before_hash:text? captured_at:timestamptz'
};
const links = [
  ['job_commands', 'shop_id,contract_id', 'execution_contracts', 'shop_id,id'],
  ['edit_operations', 'shop_id,command_id', 'job_commands', 'shop_id,id'],
  ['edit_operations', 'shop_id,preview_id', 'execution_contracts', 'shop_id,id'],
  ['job_items', 'shop_id,command_id', 'job_commands', 'shop_id,id'],
  ['job_items', 'shop_id,command_id', 'edit_operations', 'shop_id,command_id'],
  ['execution_contracts', 'shop_id,snapshot_id', 'selection_snapshots', 'shop_id,id'],
  ['selection_snapshots', 'shop_id,generation_id,coverage_revision,mapping_version', 'generations', 'shop_id,id,coverage_revision,mapping_version'],
  ['selection_items', 'shop_id,snapshot_id,generation_id', 'selection_snapshots', 'shop_id,id,generation_id'],
  ['selection_items', 'shop_id,generation_id,product_id', 'products', 'shop_id,generation_id,id'],
  ['variants', 'shop_id,generation_id,product_id', 'products', 'shop_id,generation_id,id'],
  ['product_snapshots', 'shop_id,edit_item_id', 'job_items', 'shop_id,id']
  , ['publications', 'shop_id,generation_id,coverage_revision,mapping_version', 'generations', 'shop_id,id,coverage_revision,mapping_version']
  , ['coverage', 'shop_id,generation_id', 'generations', 'shop_id,id']
  , ['products', 'shop_id,generation_id', 'generations', 'shop_id,id']
];
export function assertHistoryExecutionAdapter(adapter) { if (!issued.has(adapter)) throw new TypeError('Installed verified Execution Engine adapter required'); }
export function createHistoryExecutionAdapter() {
  async function verifySchema(client) {
    if (typeof client?.query !== 'function') throw new TypeError('Explicit transaction query client required');
    const names = Object.keys(columns);
    const metadata = (await client.query(`SELECT c.relname,a.attname,t.typname,n2.nspname AS type_schema,a.atttypmod,a.attnotnull
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace n2 ON n2.oid=t.typnamespace
    WHERE n.nspname='mirror' AND c.relname=ANY($1::text[]) AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`, [names])).rows;
    for (const [table, spec] of Object.entries(columns)) for (const definition of spec.split(' ')) {
      const [name, encoded] = definition.split(':'), nullable = encoded.endsWith('?'), type = encoded.replace(/\?$/, '');
      const row = metadata.find(r => r.relname === table && r.attname === name);
      if (!row || row.typname !== type || row.type_schema !== (/Status$/.test(type) ? 'mirror' : 'pg_catalog') ||
        row.attnotnull === nullable || (type === 'timestamptz' && row.atttypmod !== 3)) fail(C.BINDING_CONFLICT, `Unverified execution schema: mirror.${table}.${name}`);
    }
    const fks = (await client.query(`SELECT src.relname,ref.relname AS target,rn.nspname AS target_schema,k.convalidated,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=u.num ORDER BY u.ord) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=u.num ORDER BY u.ord) AS target_columns
    FROM pg_constraint k JOIN pg_class src ON src.oid=k.conrelid JOIN pg_namespace sn ON sn.oid=src.relnamespace
    JOIN pg_class ref ON ref.oid=k.confrelid JOIN pg_namespace rn ON rn.oid=ref.relnamespace WHERE k.contype='f' AND sn.nspname='mirror' AND src.relname=ANY($1::text[])`, [names])).rows;
    for (const [source, cols, target, refs] of links) if (!fks.some(r => r.relname === source && r.columns.join(',') === cols && r.target === target && r.target_schema === 'mirror' && r.target_columns.join(',') === refs && r.convalidated)) fail(C.BINDING_CONFLICT, `Unverified execution relationship: ${source} -> ${target}`);
    const indexes = (await client.query(`SELECT c.relname,ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY u(num,ord)
    JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=u.num WHERE u.ord<=i.indnkeyatts ORDER BY u.ord) AS columns
    FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='mirror' AND c.relname=ANY($1::text[]) AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL`, [names])).rows;
    for (const [table, key] of [['shops', 'id'], ['job_commands', 'shop_id,id'], ['edit_operations', 'shop_id,id'], ['edit_operations', 'shop_id,command_id'], ['job_items', 'shop_id,id'],
    ['execution_contracts', 'shop_id,id'], ['selection_snapshots', 'shop_id,id'], ['products', 'shop_id,generation_id,shopify_id'], ['variants', 'shop_id,generation_id,shopify_id'], ['product_snapshots', 'shop_id,id'], ['product_snapshots', 'shop_id,edit_item_id']])
      if (!indexes.some(row => row.relname === table && row.columns.join(',') === key)) fail(C.BINDING_CONFLICT, `Unverified execution candidate key: ${table}(${key})`);
  }
  async function assertTenant({ client: tx, tenant }) {
    await lockPublication(tx, tenant.shopId);
    await tx.query("SELECT set_config('app.shop_id',$1,true)", [tenant.shopId]);
    const shop = (await tx.query(`SELECT installation_version FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR SHARE`, [tenant.shopId])).rows[0];
    if (!shop || shop.installation_version !== tenant.installationId) fail(C.UNAUTHORIZED, 'Installation is no longer current');
  }
  const adapter = Object.freeze({
    verifySchema,
    async beginScope({ client }) { await verifySchema(client); },
    assertRequestCapabilities({ entries }) { return assertResourceExecutionRequest(entries); },
    assertTenant,
    async assertEvidenceAuthority({ client, tenant, op }) {
      const approved = await getEvidenceContractInTransaction({ client, shopId: tenant.shopId, contractId: op.execution_contract_id });
      if (!approved) fail(C.BINDING_CONFLICT, 'Persisted execution approval required for evidence');
      match([approved.executionAuthority.shopId, approved.executionAuthority.installationId, approved.executionAuthority.approvedContractHash],
        [tenant.shopId, tenant.installationId, op.approved_contract_fingerprint], 'Evidence operation differs from immutable approval authority');
      return approved.executionAuthority;
    },
    // Contract: docs/backend-interface-contracts.md#historical-item-evidence
    // Evidence completion keeps current worker ownership, but does not renew a
    // historical approval or require the publication still to be current.
    async lockEvidenceItemAuthority({client:tx,tenant,plan,claim}) {
      await adapter.assertExecutionClaim({client:tx,tenant,jobId:plan.executionJobId,claim});
      const command=(await tx.query('SELECT * FROM mirror.job_commands WHERE shop_id=$1 AND id=$2 FOR UPDATE',[tenant.shopId,plan.executionJobId])).rows[0];
      if(!command||command.installation_version!==tenant.installationId||command.contract_id!==plan.executionContractId)
        fail(C.BINDING_CONFLICT,'Evidence command belongs to another installation or approval');
      const contract=await getEvidenceContractInTransaction({client:tx,shopId:tenant.shopId,contractId:plan.executionContractId});
      if(!contract||contract.operation!==command.kind)fail(C.BINDING_CONFLICT,'Immutable evidence approval required');
      match(plan.executionAuthority,contract.executionAuthority,'Evidence plan differs from immutable approval authority');
      match(plan.approvedContractFingerprint,contract.executionAuthority.approvedContractHash,'Evidence approval hash differs');
      match(plan.fieldResolutionFingerprint,contract.executionAuthority.fieldResolutionFingerprint,'Evidence field resolution differs');
      const coordinates=contract.contract.executionCoordinates;
      match([plan.targetingSnapshotId,plan.approvalRevision,plan.logicalOperationId,plan.filterFingerprint],
        [contract.snapshot_id,contract.approval_revision,coordinates.logicalOperationId,'sha256:'+coordinates.filterFingerprint],'Evidence targeting coordinates differ from approval');
      match(plan.operationKind,{bulk_edit:'BULK_EDIT',import:'IMPORT',undo:'UNDO'}[command.kind],'Evidence operation kind differs');
      const edit=(await tx.query('SELECT id FROM mirror.edit_operations WHERE shop_id=$1 AND id=$2 AND command_id=$3 AND preview_id=$4 FOR SHARE',
        [tenant.shopId,plan.editOperationId,plan.executionJobId,plan.executionContractId])).rows[0];
      if(!edit||!Array.isArray(plan.fields)||!plan.fields.length)fail(C.BINDING_CONFLICT,'Evidence aggregate and field membership required');
      const first=plan.fields[0].identity,writer=requireResourceWriteContract(resourceTypeForGid(first.resourceGid));
      const expected={};
      for(const field of plan.fields){
        match([field.identity.shopId,field.identity.installationId,field.identity.executionJobId,field.identity.executionItemId,field.identity.resourceGid],
          [tenant.shopId,tenant.installationId,String(command.id),first.executionItemId,first.resourceGid],'Evidence fields must own one exact execution item');
        const name=writer.names[field.identity.fieldId];
        if(!name||Object.hasOwn(expected,name)||field.intendedValueKind!=='VALUE')fail(C.BINDING_CONFLICT,'Unsupported evidence field set');
        expected[name]=field.intendedValue;
      }
      const item=(await tx.query('SELECT id,intended_values FROM mirror.job_items WHERE shop_id=$1 AND command_id=$2 AND id=$3 AND resource_id=$4 FOR SHARE',
        [tenant.shopId,plan.executionJobId,first.executionItemId,first.resourceGid])).rows[0];
      if(!item)fail(C.BINDING_CONFLICT,'Evidence item is not owned by its command');
      match(item.intended_values,expected,'Evidence intended values differ from durable item');
      match(plan.itemIntendedValues,expected,'Evidence plan values differ from its fields');
      const payload=contract.contract;
      if(command.kind==='bulk_edit')match(payload.updates,expected,'Evidence values differ from immutable bulk approval');
      else if(command.kind==='import'){
        const row=payload.rows?.find(row=>row.resourceGid===first.resourceGid);
        if(!row)fail(C.BINDING_CONFLICT,'Evidence import target missing');
        match(Object.fromEntries(Object.entries(row.fields).map(([id,value])=>[writer.names[id],value])),expected,'Evidence values differ from immutable import row');
      }else if(command.kind==='undo')match(payload.fields?.slice().sort(),Object.keys(expected).sort(),'Evidence undo field membership differs');
      else fail(C.BINDING_CONFLICT,'Unsupported evidence operation');
      return {command,contract,assertClaim:()=>adapter.assertExecutionClaim({client:tx,tenant,jobId:plan.executionJobId,claim})};
    },
    async lockAuthority({ client: tx, tenant, plan, claim }) {
      const command = (await tx.query(`SELECT * FROM mirror.job_commands WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [tenant.shopId, plan.executionJobId])).rows[0];
      if (command?.installation_version !== tenant.installationId) fail(C.OWNERSHIP_LOST, 'Command belongs to a different installation');
      const assertClaim = async () => {
        const result = await tx.query(`SELECT c.id FROM mirror.job_commands c
            JOIN mirror.execution_contracts p ON p.shop_id=c.shop_id AND p.id=c.contract_id
            JOIN mirror.selection_snapshots s ON s.shop_id=p.shop_id AND s.id=p.snapshot_id
            WHERE c.shop_id=$1 AND c.id=$2 AND c.status='RUNNING' AND c.fence=$3 AND c.lease_token=$4
            AND c.lease_until>clock_timestamp() AND c.cancel_requested_at IS NULL
            AND p.status='APPROVED' AND p.expires_at>clock_timestamp()
            AND s.status='APPROVED' AND s.expires_at>clock_timestamp()`, [tenant.shopId, plan.executionJobId, claim.fenceEpoch, claim.leaseToken]);
        if (result.rowCount !== 1) fail(C.OWNERSHIP_LOST, 'Execution ownership expired, changed or cancelled');
      };
      if (!command || command.contract_id !== plan.executionContractId) fail(C.BINDING_CONFLICT, 'Plan command/contract mismatch');
      await assertClaim();
      const edit = (await tx.query(`SELECT id FROM mirror.edit_operations WHERE shop_id=$1 AND id=$2 AND command_id=$3 AND preview_id=$4 FOR SHARE`,
        [tenant.shopId, plan.editOperationId, plan.executionJobId, plan.executionContractId])).rows[0];
      if (!edit) fail(C.BINDING_CONFLICT, 'Execution aggregate ownership mismatch');
      const contract = (await tx.query(`SELECT * FROM mirror.execution_contracts WHERE shop_id=$1 AND id=$2
          AND status='APPROVED' AND expires_at>clock_timestamp() FOR SHARE`, [tenant.shopId, plan.executionContractId])).rows[0];
      if (!contract || `sha256:${contract.contract_hash}` !== plan.approvedContractFingerprint || contract.operation !== command.kind) fail(C.BINDING_CONFLICT, 'Approved contract differs from authoritative plan');
      match([contract.snapshot_id, contract.approval_revision], [plan.targetingSnapshotId, plan.approvalRevision], 'Plan approval or targeting snapshot differs');
      const selection = (await tx.query(`SELECT * FROM mirror.selection_snapshots WHERE shop_id=$1 AND id=$2
          AND status='APPROVED' AND expires_at>clock_timestamp() FOR SHARE`, [tenant.shopId, contract.snapshot_id])).rows[0];
      if (!selection || selection.operation !== command.kind || `sha256:${selection.filter_fingerprint}` !== plan.filterFingerprint) fail(C.BINDING_CONFLICT, 'Approved targeting snapshot differs from authoritative plan');
      try {
        const approved = await getApprovedContractInTransaction({ client: tx, shopId: tenant.shopId, contractId: plan.executionContractId });
        if (!approved) fail(C.BINDING_CONFLICT, 'Approved contract is absent');
        match(plan.executionAuthority, approved.executionAuthority, 'Plan execution authority differs from independently verified approval');
        match(plan.fieldResolutionFingerprint, approved.executionAuthority.fieldResolutionFingerprint, 'Plan field resolution differs from approval');
        if (command.kind === 'bulk_edit') assertIntendedValues(comparable(plan.itemIntendedValues), bulkInstructions(approved, tenant.shopId));
        if (command.kind === 'undo') match(Object.keys(plan.itemIntendedValues).sort(), undoInstructions(approved, tenant.shopId).fields.sort(), 'Complete approved Undo field membership required');
        if (command.kind === 'import') {
          const targets = [...new Set(plan.fields.map(field => field.identity.resourceGid))];
          if (targets.length !== 1) fail(C.BINDING_CONFLICT, 'Import item requires one resource');
          assertIntendedValues(comparable(plan.itemIntendedValues), importItemInstructions(approved, tenant.shopId, targets[0]));
        }
        if (approved.executionCapabilities) {
          if (plan.fields.some(f => !approved.executionCapabilities.supportedFields.includes(f.identity.fieldId)))
            fail(C.BINDING_CONFLICT, 'Plan fields exceed approved execution adapter capabilities');
          if (plan.fields.some(f => f.intendedValueKind !== 'VALUE'))
            fail(C.BINDING_CONFLICT, 'Plan value states exceed approved execution adapter capabilities');
        }
      } catch (error) {
        if (typeof error?.code === 'string' && error.code.startsWith('FIELD_')) fail(C.BINDING_CONFLICT, 'Execution approval is invalid or no longer eligible');
        throw error;
      }
      match(selection.operation_id, plan.logicalOperationId, 'Plan logical operation differs from approved selection');
      // Under SERIALIZABLE this locking read rejects a publication row changed
      // after the transaction snapshot. The shop advisory barrier is already held.
      const publication = (await tx.query(`SELECT generation_id,coverage_revision,mapping_version FROM mirror.publications WHERE shop_id=$1 FOR SHARE`, [tenant.shopId])).rows[0];
      if (!publication) fail(C.BINDING_CONFLICT, 'Current publication required');
      match([publication.generation_id, publication.coverage_revision, publication.mapping_version],
        [selection.generation_id, selection.coverage_revision, selection.mapping_version], 'Approved publication has been replaced');
      const generation = (await tx.query(`SELECT * FROM mirror.generations WHERE shop_id=$1 AND id=$2
          AND status='PUBLISHED' AND coverage_revision=$3 AND mapping_version=$4 FOR SHARE`,
        [tenant.shopId, selection.generation_id, selection.coverage_revision, selection.mapping_version])).rows[0];
      if (!generation) fail(C.BINDING_CONFLICT, 'Pinned published generation is no longer verified');
      const coverage = (await tx.query(`SELECT name FROM mirror.coverage WHERE shop_id=$1 AND generation_id=$2
          AND status='COMPLETE' AND verified_at IS NOT NULL AND verification_hash IS NOT NULL FOR SHARE`, [tenant.shopId, selection.generation_id])).rows;
      if (!generation.required_datasets.every(name => coverage.some(row => row.name === name))) fail(C.BINDING_CONFLICT, 'Required mirror dataset coverage is incomplete');
      const kinds = { bulk_edit: 'BULK_EDIT', undo: 'UNDO', import: 'IMPORT', scheduled_edit: 'SCHEDULED_EDIT', recurring_edit: 'RECURRING_EDIT' };
      if (!Object.hasOwn(kinds, command.kind) || plan.operationKind !== kinds[command.kind]) fail(C.BINDING_CONFLICT, 'Unsupported history operation kind');

      return { command, contract, selection, generation, coverage, assertClaim };
    },
    async verifyTarget({ client: tx, tenant, selection, coverage, entry: first }) {
      const writer = requireResourceWriteContract(resourceTypeForGid(first.intent.identity.resourceGid));
      if (!Object.hasOwn(writer.names, first.intent.identity.fieldId)) fail(C.BINDING_CONFLICT, 'Field and resource require matching installed writer');
      const variantTarget = first.intent.identity.resourceGid !== first.resourceFamilyGid;
      if (variantTarget && !coverage.some(row => row.name === 'variants')) fail(C.BINDING_CONFLICT, 'Variant target requires verified pinned variant coverage');
      const member = (await tx.query(`SELECT p.id FROM mirror.selection_items selected
          JOIN mirror.products p ON p.shop_id=selected.shop_id AND p.generation_id=selected.generation_id AND p.id=selected.product_id
          WHERE selected.shop_id=$1 AND selected.snapshot_id=$2 AND selected.generation_id=$3 AND p.shopify_id=$4
            AND (p.shopify_id=$5 OR EXISTS (SELECT 1 FROM mirror.variants v
              WHERE v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id AND v.shopify_id=$5))
          FOR SHARE OF p`, [tenant.shopId, selection.id, selection.generation_id, first.resourceFamilyGid, first.intent.identity.resourceGid])).rows[0];
      if (!member) fail(C.BINDING_CONFLICT, 'Mutation resource is not part of the exact approved targeting snapshot');

    },
    async verifyFieldOwnership({ client: tx, tenant, plan, entry: e, expected }) {
      const writer = requireResourceWriteContract(resourceTypeForGid(e.intent.identity.resourceGid));
      if (!Object.hasOwn(writer.names, e.intent.identity.fieldId)) fail(C.BINDING_CONFLICT, 'Field is not supported by this resource writer');
      const item = (await tx.query(`SELECT id,intended_values FROM mirror.job_items WHERE shop_id=$1 AND id=$2 AND command_id=$3
            AND resource_id=$4 AND status IN ('PENDING','RETRY','RUNNING') FOR SHARE`,
        [tenant.shopId, e.intent.identity.executionItemId, plan.executionJobId, e.intent.identity.resourceGid])).rows[0];
      if (!item) fail(C.BINDING_CONFLICT, 'Execution item is not owned by this request');
      match(item.intended_values, plan.itemIntendedValues, 'Immutable execution item differs from authoritative plan');
      match(e.mirrorBeforeSnapshotId, expected.mirrorBeforeSnapshotId ?? null, 'Mirror snapshot lineage differs from authoritative plan');
      let mirrorSnapshot = null;
      if (e.mirrorBeforeSnapshotId !== null) {
        mirrorSnapshot = (await tx.query(`SELECT s.* FROM mirror.product_snapshots s
              JOIN mirror.job_items i ON i.shop_id=s.shop_id AND i.id=s.edit_item_id
              WHERE s.shop_id=$1 AND s.id=$2 AND s.edit_item_id=$3 AND i.command_id=$4 AND i.resource_id=$5
              AND s.before_hash IS NOT NULL FOR SHARE OF s,i`,
          [tenant.shopId, e.mirrorBeforeSnapshotId, e.intent.identity.executionItemId, plan.executionJobId, e.intent.identity.resourceGid])).rows[0] ?? null;
        if (!mirrorSnapshot) fail(C.BINDING_CONFLICT, 'Mirror BEFORE snapshot is not owned by the execution item and command');
      }

      return mirrorSnapshot;
    },
    async assertExecutionClaim({ client: tx, tenant, jobId, claim }) {
      if (typeof claim?.fenceEpoch !== 'string' || !/^[1-9][0-9]{0,18}$/.test(claim.fenceEpoch) || BigInt(claim.fenceEpoch) > 9223372036854775807n || typeof claim.leaseToken !== 'string' || !claim.leaseToken) fail(C.INVALID_INPUT, 'Exact execution fence and private lease token required');
      const row = (await tx.query(`SELECT id FROM mirror.job_commands WHERE shop_id=$1 AND id=$2 AND status='RUNNING' AND fence=$3 AND lease_token=$4 AND lease_until>clock_timestamp() AND cancel_requested_at IS NULL FOR UPDATE`, [tenant.shopId, jobId, claim.fenceEpoch, claim.leaseToken])).rows[0];
      if (!row) fail(C.OWNERSHIP_LOST, 'Execution ownership expired, changed or cancelled');
    },
    async assertDispatchClaim({ client: tx, tenant, jobId, claim }) {
      await adapter.assertExecutionClaim({ client: tx, tenant, jobId, claim });
      const row = (await tx.query(`SELECT c.id FROM mirror.job_commands c JOIN mirror.execution_contracts p ON p.shop_id=c.shop_id AND p.id=c.contract_id
    JOIN mirror.selection_snapshots s ON s.shop_id=p.shop_id AND s.id=p.snapshot_id
    JOIN mirror.publications pub ON pub.shop_id=s.shop_id AND pub.generation_id=s.generation_id AND pub.coverage_revision=s.coverage_revision AND pub.mapping_version=s.mapping_version
    WHERE c.shop_id=$1 AND c.id=$2 AND p.status='APPROVED'
    AND p.expires_at>clock_timestamp() AND s.status='APPROVED' AND s.expires_at>clock_timestamp() FOR SHARE OF pub`, [tenant.shopId, jobId])).rows[0];
      if (!row) fail(C.OWNERSHIP_LOST, 'Dispatch approval or target snapshot expired');
    },
    async assertRecoveryWindow({ client: tx, tenant, jobId, claim }) {
      if (claim) { await adapter.assertExecutionClaim({ client: tx, tenant, jobId, claim }); return; }
      const row = (await tx.query(`SELECT id,status,lease_until,lease_until>clock_timestamp() AS live FROM mirror.job_commands WHERE shop_id=$1 AND id=$2 FOR UPDATE`, [tenant.shopId, jobId])).rows[0];
      if (!row || (row.status === 'RUNNING' && row.live)) fail(C.OWNERSHIP_LOST, 'A live execution owner must explicitly coordinate recovery');
    },
    async lockCommandForEvidence({ client: tx, tenant, jobId }) {
      if (!(await tx.query('SELECT id FROM mirror.job_commands WHERE shop_id=$1 AND id=$2 FOR UPDATE', [tenant.shopId, jobId])).rows[0]) fail(C.BINDING_CONFLICT, 'Authoritative execution command is missing');
    },
    async discoverInterruptedRequests({ client: tx, tenant, limit, executionJobId }) {
      return (await tx.query(`SELECT DISTINCT o.id AS operation_id,c.mutation_id,c.attempt_id FROM edit_history.changes c
    JOIN edit_history.operations o ON o.shop_id=c.shop_id AND o.installation_id=c.installation_id AND o.id=c.operation_id
    JOIN mirror.job_commands j ON j.shop_id=o.shop_id AND j.id=o.execution_job_id
    LEFT JOIN edit_history.recovery_tasks t ON t.shop_id=c.shop_id AND t.installation_id=c.installation_id AND t.change_id=c.id AND t.task_kind='MUTATION_OUTCOME'
    WHERE c.shop_id=$1 AND c.installation_id=$2 AND c.mutation_state IN ('DISPATCHING','OUTCOME_UNKNOWN','ACKNOWLEDGED')
    AND (j.status<>'RUNNING' OR j.lease_until<=clock_timestamp())
    AND($4::text IS NULL OR j.id::text=$4)
    AND (t.id IS NULL OR (t.task_state IN ('PENDING','RETRY_WAIT') AND t.available_at<=clock_timestamp()) OR (t.task_state='RECONCILING' AND t.claim_expires_at<=clock_timestamp()))
    ORDER BY o.id,c.mutation_id,c.attempt_id LIMIT $3`, [tenant.shopId, tenant.installationId, limit, executionJobId ?? null])).rows;
    }
  });
  issued.add(adapter); return adapter;
}
