/** Verify effective and SET ROLE-reachable privileges, never only role flags. */
import { HistoryContractError,HISTORY_ERROR_CODES as C } from './history-contract.js';
const tables=['operations','changes','snapshots','undo_requests','recovery_tasks','mutation_requests','privacy_scopes','purge_receipts'];
const updates={undo_requests:'undo_state preflight_fingerprint inverse_plan_fingerprint approval_reference approved_at execution_job_id execution_contract_id updated_at completed_at failure_code retry_count next_attempt_at'.split(' '),
 operations:['operation_state','changes_recorded','changes_verified','changes_failed','changes_uncertain','completed_at','updated_at'],
 changes:['mutation_state','verification_state','last_evidence_kind','last_evidence_fingerprint','dispatch_started_at','acknowledged_at','verified_at','updated_at'],
 mutation_requests:['request_state','dispatch_authorized_at','dispatch_evidence_fingerprint','outcome_evidence_kind','outcome_evidence_fingerprint',
 'acknowledged_at','verified_at','updated_at','dispatch_token_hash','dispatch_consumed_at'],
 recovery_tasks:['task_state','claimed_by','claim_token','claim_expires_at','fence_epoch','attempt_count','available_at','completed_at','updated_at','last_error_code','evidence_fingerprint','last_checked_at']};
const insertOperations=['id','shop_id','installation_id','execution_job_id','edit_operation_id','execution_contract_id','operation_kind',
 'execution_fingerprint','filter_fingerprint','approved_contract_fingerprint','field_mapping_version'];
const inserts={undo_requests:'id shop_id installation_id original_operation_id idempotency_key request_fingerprint conflict_policy handoff_key resource_gid'.split(' '),operations:insertOperations,
 changes:'id shop_id installation_id operation_id execution_item_id mutation_id attempt_id attempt_number execution_fence_epoch execution_claim_id resource_gid resource_family_gid field_id field_definition_revision mutation_plan_fingerprint intended_value_fingerprint before_snapshot_fingerprint prepared_at'.split(' '),
 snapshots:'id shop_id installation_id operation_id change_id snapshot_kind value_kind value_json snapshot_fingerprint evidence_binding_fingerprint observation_id observation_source observed_at source_revision observation_receipt_id observation_receipt_fingerprint resource_gid field_id field_definition_revision filter_fingerprint execution_fingerprint field_resolution_fingerprint binding_mode generation_id coverage_revision mapping_version execution_snapshot_id mirror_before_snapshot_id value_encoding encrypted_value encryption_key_reference'.split(' '),
 recovery_tasks:'id shop_id installation_id operation_id change_id task_kind dedupe_key'.split(' '),
 mutation_requests:'id shop_id installation_id operation_id mutation_id attempt_id attempt_number execution_item_id execution_fence_epoch execution_claim_id mutation_plan_fingerprint request_fingerprint resource_field_set field_count request_state dispatch_handoff_key'.split(' ')};
const reads={runtime:['operations','changes','snapshots','recovery_tasks','mutation_requests','undo_requests'],
 maintenance:['operations','changes','snapshots','privacy_scopes','purge_receipts'],privacy:[]};
const functions={runtime:[],maintenance:['purge_history_batch','encrypt_legacy_snapshot','legacy_snapshot_batch','mark_encryption_review'],privacy:['request_shop_redaction']};
const engineReads=['shops','job_commands','edit_operations','job_items','execution_contracts','selection_snapshots','generations',
 'coverage','products','product_snapshots','variants','selection_items','publications'];
export async function inspectHistoryDatabasePrivileges(client,{profile='runtime',authorityRelations=[]}={}){
 if(!Object.hasOwn(reads,profile))throw TypeError('Known history database profile required');
 if(!Array.isArray(authorityRelations)||authorityRelations.length>16)throw TypeError('Bounded server authority relation registry required');
 const authority=new Map();for(const rule of authorityRelations){
  if(!rule||Object.keys(rule).some(key=>!['schema','table','lockColumn'].includes(key))||
   ![rule.schema,rule.table,...(rule.lockColumn?[rule.lockColumn]:[])].every(name=>typeof name==='string'&&/^[a-z_][a-z0-9_]{0,62}$/.test(name))||
   ['edit_history','mirror','information_schema'].includes(rule.schema)||rule.schema.startsWith('pg_'))throw TypeError('Trusted authority relation required');
  authority.set(`${rule.schema}.${rule.table}`,rule.lockColumn??null);
 }
 const roles=(await client.query(`WITH RECURSIVE reachable(oid) AS (
  SELECT oid FROM pg_roles WHERE rolname IN(current_user,session_user)
  UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable r ON r.oid=m.member)
  SELECT r.oid,r.rolname,r.rolname=current_user AS is_current,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   has_database_privilege(r.oid,current_database(),'CREATE') AS db_create,
   has_database_privilege(r.oid,current_database(),'TEMP') AS db_temp,
   EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND has_schema_privilege(r.oid,n.oid,'CREATE')) AS schema_create
  FROM reachable x JOIN pg_roles r ON r.oid=x.oid`)).rows;
 const findings=[];
 if(roles.length>32)throw Error('History role graph exceeds verification budget');
 const exposure=(await client.query(`SELECT EXISTS(
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x WHERE n.nspname='edit_history' AND x.grantee=0
  UNION ALL SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE n.nspname='edit_history' AND x.grantee=0
  UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x WHERE n.nspname='edit_history' AND x.grantee=0
 ) AS exposed`)).rows[0];
 if(exposure?.exposed)findings.push('PUBLIC_HISTORY_ACCESS');
 for(const r of roles)if(r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolreplication||r.rolbypassrls||r.db_create||r.db_temp||r.schema_create||
  /^pg_(read_all_data|write_all_data|read_server_files|write_server_files|execute_server_program|monitor|signal_backend|checkpoint|database_owner)$/.test(r.rolname)||r.rolname==='metamax_history_owner')findings.push('PRIVILEGED_ROLE_REACHABLE');
 const names=roles.map(r=>r.rolname);
 const permissions=(await client.query(`SELECT r.rolname,c.relname,pg_has_role(r.oid,c.relowner,'MEMBER') AS owned,
  has_table_privilege(r.oid,c.oid,'DELETE') OR has_table_privilege(r.oid,c.oid,'TRUNCATE') OR
   has_table_privilege(r.oid,c.oid,'TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'REFERENCES') AS destructive,
  has_any_column_privilege(r.oid,c.oid,'SELECT') AS readable,has_table_privilege(r.oid,c.oid,'SELECT') AS full_read,
  ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE')) AS update_columns,
  ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.oid,c.oid,a.attnum,'INSERT')) AS insert_columns
  FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE r.rolname=ANY($1::text[]) AND n.nspname='edit_history' AND c.relkind IN('r','p','v','m','f')`,[names])).rows;
 if(new Set(permissions.map(p=>p.relname)).size!==tables.length||tables.some(t=>!permissions.some(p=>p.relname===t)))findings.push('INCOMPATIBLE_SECURITY_SCHEMA');
 for(const p of permissions){
  if(p.owned||p.destructive)findings.push('HISTORY_OWNER_OR_DESTRUCTIVE_ACCESS');
  if(p.readable&&!reads[profile].includes(p.relname))findings.push('EXCESS_HISTORY_READ');
  if(p.update_columns.some(column=>profile!=='runtime'||!(updates[p.relname]??[]).includes(column)))findings.push('EXCESS_HISTORY_UPDATE');
  if(p.insert_columns.some(column=>profile!=='runtime'||!(inserts[p.relname]??[]).includes(column)))findings.push('EXCESS_HISTORY_INSERT');
 }
 const current=roles.find(r=>r.is_current)?.rolname;
 for(const table of reads[profile])if(!permissions.some(p=>p.rolname===current&&p.relname===table&&p.full_read))findings.push('MISSING_REQUIRED_READ');
 if(profile==='runtime'){
  for(const [table,columns] of Object.entries(updates))if(!columns.every(column=>permissions.some(p=>p.rolname===current&&p.relname===table&&p.update_columns.includes(column))))findings.push('MISSING_REQUIRED_UPDATE');
  for(const [table,columns] of Object.entries(inserts))if(!columns.every(column=>permissions.some(p=>p.rolname===current&&p.relname===table&&p.insert_columns.includes(column))))findings.push('MISSING_REQUIRED_INSERT');
 }
 if(profile!=='privacy'){
  const engine=(await client.query(`SELECT r.rolname,c.relname,pg_has_role(r.oid,c.relowner,'MEMBER') AS owned,
   has_any_column_privilege(r.oid,c.oid,'SELECT') AS readable,
   has_any_column_privilege(r.oid,c.oid,'INSERT') OR has_table_privilege(r.oid,c.oid,'DELETE') OR
    has_table_privilege(r.oid,c.oid,'TRUNCATE') OR has_table_privilege(r.oid,c.oid,'TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'REFERENCES') AS writable,
   ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE')) AS updates
   FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE r.rolname=ANY($1::text[]) AND n.nspname='mirror' AND c.relkind IN('r','p','v','m','f')`,[names])).rows;
  for(const p of engine)if(p.owned||p.writable||p.readable&&(profile!=='runtime'||!engineReads.includes(p.relname))||
   p.updates.some(column=>profile!=='runtime'||!engineReads.includes(p.relname)||column!=='_history_lock'))findings.push('EXCESS_ENGINE_ACCESS');
 }
 const outside=(await client.query(`SELECT n.nspname,c.relname,
  has_any_column_privilege(r.oid,c.oid,'SELECT') AS readable,
  pg_has_role(r.oid,c.relowner,'MEMBER') OR has_any_column_privilege(r.oid,c.oid,'INSERT') OR
   has_table_privilege(r.oid,c.oid,'DELETE') OR has_table_privilege(r.oid,c.oid,'TRUNCATE') OR
   has_table_privilege(r.oid,c.oid,'TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'REFERENCES') AS writable,
  ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE')) AS updates
  FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE r.rolname=ANY($1::text[]) AND n.nspname !~ '^pg_' AND n.nspname NOT IN('edit_history','information_schema')
   AND (n.nspname<>'mirror' OR $2='privacy') AND c.relkind IN('r','p','v','m','f') AND
   (has_any_column_privilege(r.oid,c.oid,'SELECT') OR has_any_column_privilege(r.oid,c.oid,'INSERT') OR
    has_any_column_privilege(r.oid,c.oid,'UPDATE') OR has_table_privilege(r.oid,c.oid,'DELETE') OR
    has_table_privilege(r.oid,c.oid,'TRUNCATE') OR has_table_privilege(r.oid,c.oid,'TRIGGER') OR has_any_column_privilege(r.oid,c.oid,'REFERENCES')) LIMIT 257`,[names,profile])).rows;
 if(outside.length>256)findings.push('EXCESS_EXTERNAL_ACCESS');
 for(const p of outside){const relation=`${p.nspname}.${p.relname}`;
  if(profile!=='runtime'||!authority.has(relation)||p.writable||p.updates.some(column=>column!==authority.get(relation)))findings.push('EXCESS_EXTERNAL_ACCESS');
 }
 if((await client.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname NOT IN('edit_history','information_schema') AND
   EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=ANY($1::text[]) AND has_schema_privilege(r.oid,n.oid,'USAGE') AND has_function_privilege(r.oid,p.oid,'EXECUTE'))) AS unsafe`,[names])).rows[0]?.unsafe)findings.push('EXTERNAL_SECURITY_DEFINER_ACCESS');
 const callable=(await client.query(`SELECT p.proname,oidvectortypes(p.proargtypes) AS arguments,p.prosecdef,o.rolname AS owner,p.proconfig
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles o ON o.oid=p.proowner
  WHERE n.nspname='edit_history' AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=ANY($1::text[]) AND has_function_privilege(r.oid,p.oid,'EXECUTE'))`,[names])).rows;
 const signatures={purge_history_batch:'integer',encrypt_legacy_snapshot:'text, text, uuid, text, bytea, text',legacy_snapshot_batch:'integer',mark_encryption_review:'uuid',request_shop_redaction:'text'};
 for(const f of callable)if(!functions[profile].includes(f.proname)||f.arguments!==signatures[f.proname]||!f.prosecdef||f.owner!=='metamax_history_owner'||
  !(f.proconfig??[]).some(value=>value.replace(/\s/g,'')==='search_path=pg_catalog,edit_history,pg_temp'))findings.push('UNSAFE_FUNCTION_ACCESS');
 for(const name of functions[profile])if(!callable.some(f=>f.proname===name))findings.push('MISSING_REQUIRED_FUNCTION');
 return Object.freeze({profile,verified:findings.length===0,findings:Object.freeze([...new Set(findings)].sort())});
}
export async function verifyHistoryDatabasePrivileges(client,options){
 try{const report=await inspectHistoryDatabasePrivileges(client,options);if(report.verified)return report;}catch{}
 throw new HistoryContractError(C.UNAUTHORIZED,'History database permissions require deployment review');
}
export function protectedHistoryDatabase(database,profile='runtime',{authorityRelations=[]}={}){
 const registry=Object.freeze(authorityRelations.map(rule=>Object.freeze({...rule})));
 return Object.freeze({async connect(){const client=await database.connect();try{await client.query("SET statement_timeout='15000ms'");await client.query("SET lock_timeout='2000ms'");await verifyHistoryDatabasePrivileges(client,{profile,authorityRelations:registry});return client;}
  catch(error){client.release();throw error;}}});
}
