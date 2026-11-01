import {DATABASE_PROFILES} from './database-profiles.server.js';
const issuedPools=new WeakMap();
export function assertRuntimeDatabaseProfile(database,profile){
 if(issuedPools.get(database)!==profile)throw Error('Issued '+profile+' database gateway required');
}
/** Infrastructure audit only; no caller-supplied SQL, schema or role names. */
export async function readDatabaseSecurityState(client,names=null){
  // One statement gives a coherent role/policy snapshot without caching any
  // permission grant across connections or operations.
  const state=(await client.query(`WITH RECURSIVE reachable(oid) AS (
    SELECT oid FROM pg_roles WHERE rolname IN(current_user,session_user)
    UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable r ON r.oid=m.member),
  roles AS(SELECT r.oid,r.rolname,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,
    has_database_privilege(r.oid,current_database(),'CREATE') AS db_create,
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
      AND has_schema_privilege(r.oid,n.oid,'CREATE')) AS schema_create
    FROM reachable x JOIN pg_roles r ON r.oid=x.oid),
  relations AS(SELECT c.oid,n.nspname,c.relname,c.relkind,c.relowner,c.relrowsecurity,
    EXISTS(SELECT 1 FROM reachable r WHERE has_any_column_privilege(r.oid,c.oid,'INSERT')) AS can_insert,
    EXISTS(SELECT 1 FROM reachable r WHERE has_any_column_privilege(r.oid,c.oid,'UPDATE')) AS can_update,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      AND EXISTS(SELECT 1 FROM reachable r WHERE has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE'))) AS update_columns,
    EXISTS(SELECT 1 FROM reachable r WHERE has_table_privilege(r.oid,c.oid,'DELETE')) AS can_delete,
    EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='shop_id' AND NOT a.attisdropped) AS tenant_owned,
    EXISTS(SELECT 1 FROM reachable r WHERE has_table_privilege(r.oid,c.oid,'TRUNCATE')) AS can_truncate,
    EXISTS(SELECT 1 FROM reachable r WHERE has_table_privilege(r.oid,c.oid,'TRIGGER')) AS can_trigger
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('mirror','edit_history') AND c.relkind='r' AND($1::text[] IS NULL OR n.nspname||'.'||c.relname=ANY($1::text[]))),
  policies AS(SELECT p.polrelid,p.polname,p.polcmd,p.polpermissive,pg_get_expr(p.polqual,p.polrelid) AS using_expr,
    pg_get_expr(p.polwithcheck,p.polrelid) AS check_expr FROM pg_policy p JOIN relations t ON t.oid=p.polrelid
    WHERE (t.tenant_owned OR t.relname='shops') AND(0=ANY(p.polroles) OR p.polroles && ARRAY(SELECT oid FROM reachable)))
  SELECT (SELECT jsonb_agg(r) FROM roles r) AS roles,(SELECT jsonb_agg(t) FROM relations t) AS tables,
    (SELECT jsonb_agg(p) FROM policies p) AS policies,
    EXISTS(SELECT 1 FROM reachable r WHERE COALESCE(has_table_privilege(r.oid,to_regclass('mirror._prisma_migrations'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),false)) AS ledger_allowed,
    EXISTS(SELECT 1 FROM reachable r WHERE has_table_privilege(r.oid,'mirror.field_mappings','INSERT,UPDATE,DELETE')) AS mapping_allowed`,[names])).rows[0]??{};
  return state;
}

export async function verifyRuntimeDatabase(client,{profile='merchant'}={}){
  const expected=DATABASE_PROFILES[profile];if(!expected)throw Error('Unknown database runtime profile');
  const state=await readDatabaseSecurityState(client);
  const roles=state.roles??[],tables=state.tables??[],policies=state.policies??[];
  if(!roles.length||roles.length>32||roles.some(r=>r.rolsuper||r.rolbypassrls||r.rolcreaterole||r.rolcreatedb||r.rolreplication||r.schema_create||r.db_create))
    throw Error('Application database role has elevated or reachable elevated privileges');
  const applicationRoles=roles.filter(r=>Object.values(DATABASE_PROFILES).some(p=>p.role===r.rolname));
  if(applicationRoles.length!==1||applicationRoles[0].rolname!==expected.role)throw Error('Database login must reach exactly its declared runtime profile');
  if(!tables.length||tables.some(t=>roles.some(r=>String(r.oid)===String(t.relowner))||t.can_truncate||t.can_trigger||
    (t.tenant_owned||t.nspname==='mirror'&&t.relname==='shops')&&!t.relrowsecurity))throw Error('Application tenant tables are not protected by reviewed runtime ownership and RLS');
  const control=new Set(expected.control),metadata=new Set(expected.metadata);
  for(const table of tables)if(table.can_insert||table.can_update||table.can_delete){
    if(table.nspname==='mirror'&&table.relname==='audit_events'&&(table.can_update||table.can_delete))throw Error('Runtime audit evidence must be append-only');
    if(profile==='merchant'&&table.nspname==='mirror'&&(['product_snapshots'].includes(table.relname)||table.relname==='job_items'&&(table.can_update||table.can_delete)))throw Error('Merchant runtime cannot execute or erase worker outcomes');
    if(profile==='merchant'&&table.nspname==='mirror'){
      if(['job_commands','outbox_events','edit_operations'].includes(table.relname)&&table.can_delete)throw Error('Merchant runtime cannot delete durable dispatch evidence');
      const allowed=table.relname==='job_commands'?['cancel_requested_at','updated_at']:table.relname==='outbox_events'?['review_required','last_error','attempts','available_at','fence','lease_token','lease_until']:table.relname==='edit_operations'?['_history_lock']:null;
      if(allowed&&table.can_update&&(!table.update_columns?.length||table.update_columns.some(column=>!allowed.includes(column))))throw Error('Merchant runtime cannot claim commands or publish worker outcomes');
    }
    const limitedColumns=profile==='merchant'&&table.relname==='generations'?['_history_lock','retain_until']:['_history_lock'];
    const metadataOnly=!table.can_insert&&!table.can_delete&&table.can_update&&table.update_columns?.length>0&&table.update_columns.every(column=>limitedColumns.includes(column));
    if(table.nspname!=='mirror'||!expected.write.includes(table.relname)&&!metadataOnly)throw Error('Database profile has excess DML privileges');
    if(profile==='operationWorker'&&table.can_delete)throw Error('Operation worker must not delete durable work');
    if(profile==='operationWorker'&&table.nspname==='mirror'&&table.relname==='job_commands'&&table.can_insert)throw Error('Operation worker must not create commands');
  }
  for(const table of tables.filter(t=>t.tenant_owned||t.relname==='shops')){
    const scoped=policies.filter(p=>String(p.polrelid)===String(table.oid));
    const expression=`(${table.nspname==='mirror'&&table.relname==='shops'?'id':'shop_id'} = current_setting('app.shop_id'::text, true))`;
    if(!scoped.some(p=>p.polname==='metamax_tenant_isolation'&&p.polcmd==='*'&&p.using_expr===expression&&p.check_expr===expression))throw Error('Missing scoped runtime tenant policy');
    for(const p of scoped){
      if(!p.polpermissive)throw Error('Unreviewed restrictive application policy');
      if(p.polname==='metamax_tenant_isolation'&&p.polcmd==='*'&&p.using_expr===expression&&p.check_expr===expression)continue;
      if(table.nspname==='mirror'&&control.has(table.relname)&&p.polname===(profile==='catalogWorker'?'metamax_catalog_control':'metamax_operation_control')&&p.polcmd==='*'&&p.using_expr==='true'&&p.check_expr==='true')continue;
      if(table.nspname==='mirror'&&metadata.has(table.relname)&&p.polname===(profile==='catalogWorker'?'metamax_catalog_metadata':'metamax_operation_discovery')&&p.polcmd==='r'&&p.using_expr==='true'&&p.check_expr===null)continue;
      if(profile==='operationWorker'&&table.nspname==='edit_history'&&['operations','changes','mutation_requests'].includes(table.relname)&&p.polname==='metamax_operation_discovery'&&p.polcmd==='r'&&p.using_expr==='true'&&p.check_expr===null)continue;
      if(profile==='operationWorker'&&table.nspname==='mirror'&&table.relname==='audit_events'&&p.polname==='metamax_operation_audit'&&p.polcmd==='a'&&p.using_expr===null&&p.check_expr==='true')continue;
      throw Error('Unreviewed effective application RLS policy');
    }
  }
  if(state.ledger_allowed)throw Error('Application runtime must not access the migration ledger');
  if(state.mapping_allowed)throw Error('Application runtime cannot mutate the trusted mapping registry');
  return Object.freeze({runtimeProfile:expected.role,roles:roles.map(r=>r.rolname),tenantTables:tables.filter(t=>t.tenant_owned||t.relname==='shops').length,owner:false,bypassRls:false});
}

/** Audited infrastructure facade. The underlying pool, shutdown and owner
 * credentials are never handed to tenant repositories. No grant is cached. */
export function createVerifiedRuntimePool(pool,{profile='merchant'}={}){
  if(typeof pool?.connect!=='function')throw TypeError('Private runtime pool required');
  async function connect(){
    const client=await pool.connect();
    try{
      await verifyRuntimeDatabase(client,{profile});let active=true;
      return Object.freeze({query(...args){if(!active)throw Error('Runtime transaction client has been released');return client.query(...args);},
        release(error){if(!active)throw Error('Runtime transaction client already released');active=false;client.release(error);}});
    }catch(error){client.release(error);throw error;}
  }
  const facade=Object.freeze({connect,async query(...args){const client=await connect();try{return await client.query(...args);}finally{client.release();}}});
  issuedPools.set(facade,profile);return facade;
}
