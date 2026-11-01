// Server-owned mappings transcribed from tenant.prisma, synchronization.prisma
// and catalog-import.prisma. SyncRun is ingestion state, not the phase lease.
export const CATALOG_EXECUTION_MAPPING = Object.freeze({
  runs: Object.freeze({ table:"mirror.catalog_import_executions", columns:Object.freeze({id:"id",shopId:"shop_id",generationId:"generation_id",phase:"phase",
    attempt:"attempt",fence:"fence",leaseToken:"lease_token",leaseExpiresAt:"lease_until",nextEligibleAt:"next_eligible_at",
    completedAt:"completed_at",reviewRequired:"review_required",outcomeUncertain:"outcome_uncertain",workerId:"worker_id",
    cancelRequested:"cancel_requested",lastError:"last_error",recoveryAttempts:"recovery_attempts"}) }),
  shops:Object.freeze({table:"mirror.shops",columns:Object.freeze({shopId:"id"})}),attemptLimit:12,
});

// Each entry is [physical column, PostgreSQL type, nullable]. These are schema
// contracts, never browser-provided identifiers or authorization grants.
const columns = {
  shops: [['id','text'],['installation_version','text'],['uninstalled_at','timestamptz',true]],
  catalog_import_jobs: [['id','text'],['shop_id','text'],['generation_id','text',true],['run_id','int8',true],
    ['installation_version','text'],['execution_mode','text'],['cancel_requested','bool'],['status','text']],
  ingestion_runs: [['id','int8'],['shop_id','text'],['generation_id','text'],['dataset','text'],['status','WorkStatus'],
    ['bulk_operation_id','text',true],['expected_lines','int8',true],['processed_lines','int8'],['invalid_lines','int8'],
    ['eof_verified','bool'],['writes_finished_at','timestamptz',true],['lease_token','text',true],['lease_until','timestamptz',true],
    ['fence','int8'],['execution_id','text',true],['execution_fence','int8',true]],
  ingestion_chunks: [['id','int8'],['shop_id','text'],['run_id','int8'],['ordinal','int4'],['checksum','text'],
    ['line_count','int8'],['committed_at','timestamptz']],
  sync_external_operations: [['id','text'],['shop_id','text'],['run_id','text'],['generation_id','text'],['kind','text'],
    ['input_hash','text'],['state','text'],['dispatch_fence','int8'],['operation_id','text',true],['remote_status','text',true],
    ['object_count','int8',true],['last_error','text',true],['created_at','timestamptz'],['updated_at','timestamptz']],
  sync_dispatch_schedule: [['shop_id','text'],['last_served','int8'],['last_dispatched_at','timestamptz',true],['next_eligible_at','timestamptz']],
  sync_dispatches: [['id','text'],['shop_id','text'],['run_id','text'],['generation_id','text'],
    ['sync_run_id','int8'],['attempt','int4'],['next_attempt_at','timestamptz'],['enqueued_at','timestamptz',true],
    ['recovery_token','text',true],['recovery_until','timestamptz',true],['recovery_reason','text',true],
    ['consumed_at','timestamptz',true],['reviewed_at','timestamptz',true],
    ['consumed_fence','int8',true],['consumed_lease_token','text',true],['recovery_fence','int8'],
    ['delivery_revision','int8'],['kind','text'],['delivery_key','text'],['state','text'],['dispatch_token','text'],
    ['reservation_fence','int8'],['reserved_until','timestamptz',true],['job_id','text',true],['last_error_code','text',true]],
  sync_dispatch_recovery_evidence: [['id','text'],['dispatch_id','text'],['shop_id','text'],['run_id','text'],
    ['generation_id','text'],['delivery_revision','int8'],['kind','text'],['delivery_key','text'],
    ['recovery_token','text'],['recovery_fence','int8'],['decision','text'],['queue_state','text'],
    ['job_id','text'],['observed_at','timestamptz'],['expires_at','timestamptz'],['consumed_at','timestamptz',true]],
};
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export const SYNC_DOMAIN_TABLES = Object.freeze(Object.keys(columns).map(name => `mirror.${name}`));

/** Extend phase schema verification to the actual models its SQL consumes.
 * Called inside the same protected transaction as the adapter/recovery work.
 */
export async function inspectSyncDomainSchema(tx, { mapping, execution, catalog, reject }) {
  if (!equal(mapping.runs, CATALOG_EXECUTION_MAPPING.runs) || !equal(mapping.shops, CATALOG_EXECUTION_MAPPING.shops)) {
    reject('Catalog execution requires the exact domain model mapping');
  }
  await tx.$executeRawUnsafe(`LOCK TABLE mirror.shops,mirror.catalog_import_jobs,mirror.ingestion_runs,
    mirror.ingestion_chunks,mirror.sync_external_operations,mirror.sync_dispatch_schedule,mirror.sync_dispatches,
    mirror.sync_dispatch_recovery_evidence IN ACCESS SHARE MODE`);
  const found = {catalog_import_executions:execution};
  const revision=execution.columns.find(c=>c.name==='delivery_revision');
  if(!revision||revision.type!=='int8'||!revision.required)reject('Incompatible durable delivery revision');
  for (const [table, contract] of Object.entries(columns)) {
    const metadata = await catalog(tx, `mirror.${table}`);
    found[table] = metadata;
    for (const [name, type, nullable=false] of contract) {
      const column = metadata.columns.find(c => c.name === name);
      if (!column || column.type !== type || column.required === nullable) reject(`Incompatible domain column: ${table}.${name}`);
    }
  }
  const unique = (table, fields) => found[table].indexes.some(i => i.unique && i.valid && i.ready && i.predicate == null && equal(i.columns,fields));
  if(!found.sync_dispatches.indexes.some(i=>i.valid&&i.ready&&equal(i.columns,['reserved_until','id']))) {
    reject('Missing dispatch expiry scanner index');
  }
  if(!found.sync_dispatches.indexes.some(i=>i.valid&&i.ready&&i.predicate!=null&&equal(i.columns,['next_attempt_at','reserved_until']))) {
    reject('Missing dispatch retry index');
  }
  if(!found.sync_dispatch_schedule.indexes.some(i=>i.valid&&i.ready&&equal(i.columns,['next_eligible_at','last_dispatched_at','shop_id']))||
     !found.sync_dispatches.indexes.some(i=>i.valid&&i.ready&&i.predicate!=null&&equal(i.columns,['updated_at','id']))||
     !found.sync_dispatches.indexes.some(i=>i.valid&&i.ready&&i.predicate!=null&&equal(i.columns,['next_attempt_at','shop_id']))||
     !found.sync_dispatch_recovery_evidence.indexes.some(i=>i.valid&&i.ready&&equal(i.columns,['dispatch_id','recovery_fence','expires_at']))) {
    reject('Missing dispatch lifecycle scheduling indexes');
  }
  const foreign = (table, fields, target, targets) => found[table].constraints.some(c => c.type === 'f' && c.validated &&
    equal(c.columns,fields) && c.target_schema === 'mirror' && c.target_table === target && equal(c.target_columns,targets));
  for (const [table, fields] of [
    ['catalog_import_jobs',['id']], ['ingestion_runs',['id']], ['ingestion_chunks',['id']], ['sync_external_operations',['id']],
    ['shops',['id','installation_version']], ['catalog_import_jobs',['shop_id','id','generation_id']],
    ['ingestion_runs',['shop_id','id']], ['ingestion_runs',['shop_id','generation_id','dataset']],
    ['ingestion_chunks',['shop_id','run_id','ordinal']], ['sync_external_operations',['run_id','kind']],
    ['sync_dispatch_schedule',['shop_id']], ['sync_dispatches',['id']], ['sync_dispatches',['delivery_key']],
    ['sync_dispatches',['shop_id','delivery_key']],
    ['sync_dispatches',['shop_id','run_id','delivery_revision','kind']],
    ['sync_dispatch_recovery_evidence',['id']],
    ['sync_dispatch_recovery_evidence',['dispatch_id','recovery_fence']],
  ]) if (!unique(table,fields)) reject(`Missing domain uniqueness: ${table}`);
  for (const [table, fields, target, targets] of [
    ['catalog_import_jobs',['shop_id'],'shops',['id']],
    ['catalog_import_executions',['shop_id','id','generation_id'],'catalog_import_jobs',['shop_id','id','generation_id']],
    ['ingestion_runs',['shop_id','generation_id'],'generations',['shop_id','id']],
    ['ingestion_runs',['shop_id','execution_id','generation_id'],'catalog_import_executions',['shop_id','id','generation_id']],
    ['ingestion_chunks',['shop_id','run_id'],'ingestion_runs',['shop_id','id']],
    ['sync_external_operations',['shop_id','run_id','generation_id'],'catalog_import_executions',['shop_id','id','generation_id']],
    ['sync_dispatch_schedule',['shop_id'],'shops',['id']],
    ['sync_dispatches',['shop_id','run_id','generation_id'],'catalog_import_executions',['shop_id','id','generation_id']],
    ['sync_dispatches',['shop_id'],'shops',['id']],
    ['sync_dispatches',['shop_id','sync_run_id'],'ingestion_runs',['shop_id','id']],
    ['sync_dispatch_recovery_evidence',['dispatch_id'],'sync_dispatches',['id']],
    ['sync_dispatch_recovery_evidence',['shop_id','run_id','generation_id'],'catalog_import_executions',['shop_id','id','generation_id']],
    ['sync_dispatch_recovery_evidence',['shop_id'],'shops',['id']],
  ]) if (!foreign(table,fields,target,targets)) reject(`Missing tenant-bound domain relation: ${table}`);
  const status = found.ingestion_runs.columns.find(c => c.name === 'status');
  if (!equal(status.enum_values,['PENDING','RUNNING','RETRY','SUCCEEDED','PARTIAL','FAILED','CANCELLED'])) reject('Incompatible SyncRun WorkStatus');
  const triggers = await tx.$queryRawUnsafe(`SELECT c.relname AS relation,t.tgname AS name,t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='mirror' AND NOT t.tgisinternal AND c.relname IN
      ('shops','ingestion_runs','ingestion_chunks','catalog_import_executions','sync_external_operations','sync_dispatches','sync_dispatch_recovery_evidence')`);
  for (const [relation,name] of [
    ['ingestion_runs','guard_completed_ingestion'],['ingestion_chunks','guard_ingestion_checkpoint'],
    ['catalog_import_executions','propagate_catalog_execution'],['sync_external_operations','guard_sync_external_intent'],
    ['catalog_import_executions','advance_sync_delivery_revision'],['sync_dispatches','guard_sync_dispatch_identity'],
    ['shops','maintain_sync_dispatch_schedule'],
    ['sync_dispatches','guard_sync_dispatch_recovery_fence'],
    ['sync_dispatch_recovery_evidence','guard_sync_dispatch_recovery_evidence'],
  ]) if (!triggers.some(t => t.relation === relation && t.name === name && ['O','A'].includes(t.enabled))) reject(`Missing active domain guard: ${name}`);
  return found;
}
