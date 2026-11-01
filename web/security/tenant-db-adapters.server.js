import {readDatabaseSecurityState} from './runtime-database.server.js';
import {HISTORY_EXECUTION_CAPABILITIES} from '../fields/write-capabilities.js';
import {TenantDatabaseError} from './tenant-db.server.js';
const deny=code=>{throw new TenantDatabaseError(code);};

/** Supplied transaction only; gateway already holds the installation barrier. */
export async function getInstallationInTransaction(tx,shopId,mode){
  if(!['READ','WRITE'].includes(mode))deny('INVALID_TENANT_DB_MODE');
  const row=(await tx.query('SELECT installation_version FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL',[shopId])).rows[0];
  if(!row)deny('INSTALLATION_NOT_ACTIVE');
  return {active:true,shopId,installationId:row.installation_version,installationVersion:row.installation_version};
}

/** Current schema: RUNNING, lease_until, fence. Read-only worker authorization
 * is deliberately unsupported for this write-only namespace. */
export async function verifyJobCommandInTransaction(tx,claim){
  if(claim.namespace!=='mirror.job_commands'||!HISTORY_EXECUTION_CAPABILITIES.jobKinds.includes(claim.jobKind))deny('WORKER_KIND_UNAUTHORIZED');
  const row=(await tx.query(`SELECT c.id::text FROM mirror.job_commands c JOIN mirror.shops s
    ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
    WHERE c.id=$1::bigint AND c.shop_id=$2 AND c.installation_version=$3 AND c.kind=$4
      AND c.fence=$5::bigint AND c.lease_token=$6 AND c.lease_until>clock_timestamp()
      AND c.status='RUNNING' AND c.cancel_requested_at IS NULL FOR UPDATE OF c`,
    [claim.jobId,claim.shopId,claim.installationVersion,claim.jobKind,claim.fenceEpoch,claim.claimToken])).rows[0];
  if(!row||claim.installationId!==claim.installationVersion)deny('WORKER_CLAIM_REVOKED');
  return {...claim,verified:true};
}

/** Repository transition, re-fenced at the write itself. No illustrative states.
 * Trusted worker infrastructure only; not exported through repository handles.
 * This does not authorize any remote Shopify request. */
export async function renewJobCommandInTransaction(tx,claim,leaseSeconds=120){
  if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<5||leaseSeconds>300)deny('INVALID_WORKER_LEASE');
  await verifyJobCommandInTransaction(tx,claim);
  const result=await tx.query(`UPDATE mirror.job_commands SET lease_until=GREATEST(lease_until,clock_timestamp()+$7::integer*interval '1 second'),updated_at=clock_timestamp()
    WHERE id=$1::bigint AND shop_id=$2 AND installation_version=$3 AND kind=$4 AND fence=$5::bigint
      AND lease_token=$6 AND lease_until>clock_timestamp() AND status='RUNNING' AND cancel_requested_at IS NULL RETURNING id`,
    [claim.jobId,claim.shopId,claim.installationVersion,claim.jobKind,claim.fenceEpoch,claim.claimToken,leaseSeconds]);
  if(result.rowCount!==1)deny('WORKER_CLAIM_REVOKED');
  return true;
}

/** Fail-closed runtime audit for explicitly reviewed relations. RLS is defense
 * in depth: this role can still SET custom GUCs if arbitrary SQL is obtained. */
export function createTenantDatabaseVerifier({tables}={}){
  if(!Array.isArray(tables)||!tables.length||tables.length>100||tables.some(t=>typeof t!=='string'||!/^mirror\.[a-z_][a-z0-9_]*$/.test(t)))
    throw TypeError('Explicit reviewed mirror relation registry required');
  const names=Object.freeze([...new Set(tables)]);
  return async tx=>{
    const state=await readDatabaseSecurityState(tx,names);
    const roles=state.roles??[];
    if(!roles.length||roles.length>32||roles.some(r=>r.rolsuper||r.rolbypassrls||r.rolcreaterole||r.rolcreatedb||r.rolreplication||r.db_create||r.schema_create))deny('UNSAFE_TENANT_DATABASE_ROLE');
    const relations=(state.tables??[]).map(r=>({...r,name:r.nspname+'.'+r.relname}));
    if(relations.length!==names.length||relations.some(r=>r.relkind!=='r'||!r.relrowsecurity||roles.some(role=>String(role.oid)===String(r.relowner))))deny('TENANT_RLS_NOT_ENFORCED');
    for(const relation of relations){
      if(relation.can_truncate||relation.can_trigger)deny('UNSAFE_TENANT_TABLE_PRIVILEGES');
      const policies=(state.policies??[]).filter(p=>String(p.polrelid)===String(relation.oid));
      const column=relation.name==='mirror.shops'?'id':'shop_id';
      const expected=`(${column} = current_setting('app.shop_id'::text, true))`;
      if(policies.length!==1||policies[0].polcmd!=='*'||!policies[0].polpermissive||policies[0].using_expr!==expected||policies[0].check_expr!==expected)
        deny('TENANT_RLS_POLICY_NOT_REVIEWED');
    }
    return true;
  };
}
