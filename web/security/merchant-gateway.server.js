// Interface contract (repository root): docs/backend-interface-contracts.md#merchant-dispatch
import {requireResourceWriteContract,assertInstalledUndoCapability} from '../fields/write-capabilities.js';
import {assertInstallationTenant} from './installation-lifecycle.server.js';
import {assertRuntimeDatabaseProfile,verifyRuntimeDatabase} from './runtime-database.server.js';
import {lockPublication} from '../mirror/publication-lock.server.js';
import {assertExecutionAuthorityContext} from '../services/execution-contract.server.js';
/** Durable dispatch: authenticated identity, immutable approval, set-based items.
 * Optional client is a trusted server-owned, dedicated PostgreSQL transaction,
 * never a pool. It must use READ COMMITTED READ WRITE with statement_timeout
 * <=30s and lock_timeout <=2s, both nonzero. The gateway verifies profile and
 * settings, owns a savepoint, establishes tenant GUCs/publication protection and
 * holds the exact installation FOR SHARE. Caller owns outer commit/rollback and
 * must await dispatch; success is provisional until that commit. Errors roll
 * back this dispatch to its savepoint. No remote send occurs in this interface.
 */
import { createHash } from "node:crypto";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { bulkInstructions, bulkResourceType, undoInstructions, importInstructions, assertIntendedValues, requireWriteAuthorization } from "../services/operation-instructions.server.js";

const fail = (code, message) => { throw new FieldError(code, message); };
const issuedDispatchers=new WeakSet();
const externalInFlight=new WeakSet();
export function assertJobDispatchService(service){if(!issuedDispatchers.has(service))throw TypeError('Issued Bulk Edit dispatch service required');}

export function createJobDispatchService({ database, approvalService, resolveShop, resolveTenant, authorizeWrite } = {}) {
  assertRuntimeDatabaseProfile(database,'merchant');
  if (typeof database?.connect !== "function" || typeof approvalService?.getApprovedContract !== "function" ||
      typeof resolveShop !== "function" || typeof resolveTenant!=='function' || typeof authorizeWrite !== "function") {
    throw new TypeError("Transactional database, approval service and trusted shop/write authorization required");
  }
  async function dispatch(kind, { client, authContext, contractId, sourceCommandId, actorId = "system", ...unsupported } = {}) {
    if (!authContext || Object.hasOwn(unsupported, "shopId")) fail(C.PERMISSION_DENIED, "Authenticated dispatch context required; shopId is server-resolved");
    if (typeof contractId !== "string" || !contractId) fail(C.INVALID_VALUE, "Immutable approved contractId required");
    if (kind === "undo" && !sourceCommandId) fail(C.INVALID_VALUE, "Approved undo source required");
    const shopId = await resolveShop(authContext);
    const tenant=assertInstallationTenant(await resolveTenant(authContext));
    if(tenant.shopId!==shopId)fail(C.PERMISSION_DENIED,'Merchant tenant authority mismatch');
    if (typeof shopId !== "string" || shopId.trim() !== shopId || shopId.length > 255 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopId)) fail(C.PERMISSION_DENIED, "Authenticated dispatch shop required");
    // Caller keys cannot split one approved operation into multiple commands.
    const key = `operation:v1:${createHash("sha256").update(JSON.stringify([shopId, kind, contractId])).digest("hex")}`;
    const tx = client ?? await database.connect();
    const owned = !client;
    if(!owned){
      if(typeof tx?.query!=='function'||typeof tx.release!=='function'||typeof tx.connect==='function')
        fail(C.CONTRACT_MISMATCH,'Dedicated transaction client required; pools are forbidden');
      if(externalInFlight.has(tx))fail(C.CONTRACT_MISMATCH,'Concurrent use of a dispatch transaction is forbidden');
      externalInFlight.add(tx);
    }
    let savepoint = false;
    const findExisting = async () => (await tx.query(
      `SELECT c.id,c.status,c.result,c.contract_id,c.kind,c.installation_version,e.id AS operation_id,
        (SELECT count(*)::text FROM mirror.job_items i WHERE i.shop_id=c.shop_id AND i.command_id=c.id) AS item_count
       FROM mirror.job_commands c LEFT JOIN mirror.edit_operations e ON e.shop_id=c.shop_id AND e.command_id=c.id
       WHERE c.shop_id=$1 AND c.kind=$2 AND c.contract_id=$3`, [shopId,kind,contractId])).rows[0];
    const receipt = (command, existing) => Object.freeze({
      commandId: String(command.id), editOperationId: String(command.operation_id),
      ...(kind === "undo" ? { restoreCommandId: String(command.id), restoreOperationId: String(command.operation_id) } : {}),
      contractId, status: command.status, idempotencyKey: key, itemCount: Number(command.item_count), existing,
      ...(command.result?{result:typeof command.result==='string'?JSON.parse(command.result):command.result}:{}),
    });
    try {
      if(!owned){
        // SAVEPOINT itself rejects autocommit. Runtime-profile checks alone do
        // not prove transaction ownership or a fresh READ COMMITTED snapshot.
        await tx.query('SAVEPOINT metamax_dispatch');savepoint=true;
        await verifyRuntimeDatabase(tx,{profile:'merchant'});
        const settings=(await tx.query(`SELECT current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS read_only,
          (SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout') AS statement_timeout_ms,
          (SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout') AS lock_timeout_ms`)).rows[0];
        if(settings?.isolation!=='read committed'||settings.read_only!=='off'||
          !(Number(settings.statement_timeout_ms)>0&&Number(settings.statement_timeout_ms)<=30000)||
          !(Number(settings.lock_timeout_ms)>0&&Number(settings.lock_timeout_ms)<=2000))
          fail(C.CONTRACT_MISMATCH,'Bounded READ COMMITTED READ WRITE dispatch transaction required');
      }
      // READ COMMITTED lets a losing INSERT see the committed winner next.
      // Contracts and approved selection membership are immutable.
      if (owned) {
        await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await tx.query("SET LOCAL lock_timeout = '2000ms'");
        await tx.query("SET LOCAL statement_timeout = '30000ms'");
      }
      await tx.query("SELECT set_config('app.shop_id',$1,true),set_config('app.installation_id',$2,true),set_config('app.installation_version',$2,true)",[shopId,tenant.installationVersion]);
      await lockPublication(tx,shopId,{write:false});
      const installation = (await tx.query(
        'SELECT installation_version FROM mirror.shops WHERE id=$1 AND uninstalled_at IS NULL FOR SHARE', [shopId])).rows[0];
      if (!installation?.installation_version) fail(C.PERMISSION_DENIED, 'Active installation required');
      if(installation.installation_version!==tenant.installationVersion)fail(C.PERMISSION_DENIED,'Merchant installation changed');
      const loadAuthorizedContract = async () => {
        const current=assertInstallationTenant(await resolveTenant(authContext));
        if(current.shopId!==shopId||current.installationVersion!==tenant.installationVersion)fail(C.PERMISSION_DENIED,'Dispatch lifecycle changed');
        if (await resolveShop(authContext) !== shopId) fail(C.PERMISSION_DENIED, 'Dispatch shop changed');
        const contract = await approvalService.getApprovedContract({client:tx,shopId,contractId});
        assertExecutionAuthorityContext(contract,{shopId,installationId:installation.installation_version,operationKind:kind});
        const instructions = kind === 'bulk_edit' ? bulkInstructions(contract,shopId) : kind==='import'?importInstructions(contract,shopId):undoInstructions(contract,shopId);
        if (kind === 'undo' && instructions.sourceCommandId !== String(sourceCommandId)) fail(C.CONTRACT_MISMATCH, 'Undo source differs from approval');
        const resourceType=bulkResourceType(contract,shopId);
        const authorization = {client:tx,authContext,shopId,resourceType,fieldIds:(kind==='bulk_edit'?Object.keys(instructions):instructions.fields).map(name=>requireResourceWriteContract(resourceType).bindings[name]),installationId:installation.installation_version,
          installationVersion:installation.installation_version,contract,operation:kind,
          fields:kind === 'bulk_edit' ? Object.keys(instructions) : instructions.fields};
        await requireWriteAuthorization(authorizeWrite,authorization);
        if(kind==='undo')assertInstalledUndoCapability(resourceType);
        if (await resolveShop(authContext) !== shopId) fail(C.PERMISSION_DENIED, 'Dispatch shop changed');
        return {contract,instructions,authorization,resourceType};
      };
      const existingReceipt = async command => {
        if (command.installation_version !== installation.installation_version) fail(C.PERMISSION_DENIED, 'Dispatch belongs to a different installation');
        await loadAuthorizedContract();
        if (owned) await tx.query('COMMIT');
        else {await tx.query('RELEASE SAVEPOINT metamax_dispatch');savepoint=false;}
        return receipt(command,true);
      };
      const previous = await findExisting();
      if (previous) return await existingReceipt(previous);
      const {contract,instructions,authorization,resourceType} = await loadAuthorizedContract();
      const inserted = (await tx.query(
        `INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,status,attempts,max_attempts,available_at,fence,created_at,updated_at)
         VALUES($1,$2,$3,$4,'PENDING',0,8,clock_timestamp(),0,clock_timestamp(),clock_timestamp())
         ON CONFLICT DO NOTHING RETURNING id,status`, [shopId,contractId,key,kind])).rows[0];
      if (!inserted) {
        const winner = await findExisting();
        if (!winner) fail(C.EXECUTION_UNAVAILABLE, "Concurrent dispatch committed outside this snapshot; retry transaction");
        return await existingReceipt(winner);
      }
      const commandId = inserted.id;
      const op = (await tx.query(`INSERT INTO mirror.edit_operations(shop_id,command_id,preview_id,created_at)
        VALUES($1,$2,$3,clock_timestamp()) RETURNING id`, [shopId,commandId,contractId])).rows[0];
      if (kind === "undo") {
        const source = (await tx.query(`SELECT id FROM mirror.edit_operations WHERE shop_id=$1 AND command_id=$2`, [shopId,sourceCommandId])).rows[0];
        if (!source) fail(C.CONTRACT_MISMATCH, "Undo source operation unavailable");
        await tx.query(`INSERT INTO mirror.undo_operations(shop_id,source_operation_id,restore_operation_id,mode,created_at)
          VALUES($1,$2,$3,'COMPARE_AFTER_HASH',clock_timestamp())`, [shopId,source.id,op.id]);
      }
      // Exact membership and generation from the approved snapshot. No target
      // array crosses Node and no per-product INSERT round trips are needed.
      const count = (await tx.query(`SELECT s.selected_count,count(p.id)::text AS target_count
        FROM mirror.selection_snapshots s LEFT JOIN mirror.selection_items si ON si.shop_id=s.shop_id AND si.snapshot_id=s.id
        LEFT JOIN mirror.products p ON p.shop_id=si.shop_id AND p.generation_id=si.generation_id AND p.id=si.product_id
        WHERE s.shop_id=$1 AND s.id=$2 AND s.status='APPROVED'
        GROUP BY s.selected_count`, [shopId,contract.snapshot_id])).rows[0];
      let expected = Number(count?.selected_count); const targets = Number(count?.target_count);
      if (!Number.isSafeInteger(expected) || expected < 1 || expected>100000 || expected !== targets) fail(C.CONTRACT_MISMATCH, "Approved selection membership is incomplete or exceeds installed command budget");
      if(resourceType==='variant'){
        const payload=typeof contract.contract==='string'?JSON.parse(contract.contract):contract.contract;
        const expectedPolicy=kind==='undo'?'VERIFIED_VARIANTS_OF_SOURCE_COMMAND':'ALL_VARIANTS_OF_SELECTED_PRODUCTS';
        if(payload.variantTargetingPolicy!==expectedPolicy)fail(C.CONTRACT_MISMATCH,'Approved variant targeting policy required');
        expected=payload.variantTargetCount;
        if(!Number.isSafeInteger(expected)||expected<1||expected>100000)fail(C.CONTRACT_MISMATCH,'Approved bounded variant target count required');
      }
      let items;
      if(kind==='import'){
        if(instructions.rows.length!==expected)fail(C.CONTRACT_MISMATCH,'Import mappings differ from approved selection');
        items=await tx.query(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,status,intended_values,attempts)
         SELECT si.shop_id,$2,p.shopify_id,'PENDING',mapped.updates,0 FROM mirror.selection_items si
         JOIN mirror.products p ON p.shop_id=si.shop_id AND p.generation_id=si.generation_id AND p.id=si.product_id
         JOIN jsonb_to_recordset($4::jsonb) AS mapped("resourceId" text,updates jsonb) ON mapped."resourceId"=p.shopify_id
         WHERE si.shop_id=$1 AND si.snapshot_id=$3 ORDER BY si.product_id`,[shopId,commandId,contract.snapshot_id,JSON.stringify(instructions.rows)]);
      }else if(resourceType==='variant'){
        items=await tx.query(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,status,intended_values,restore_snapshot_id,attempts)
         SELECT si.shop_id,$2,v.shopify_id,'PENDING',${kind==='undo'?"(SELECT jsonb_object_agg(k,val) FROM jsonb_each(ps.before_values) entry(k,val) WHERE k=ANY($5::text[]))":'$4::jsonb'},${kind==='undo'?'ps.id':'NULL'},0
         FROM mirror.selection_items si JOIN mirror.products p ON p.shop_id=si.shop_id AND p.generation_id=si.generation_id AND p.id=si.product_id
         JOIN mirror.variants v ON v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id
         ${kind==='undo'?"JOIN mirror.job_items original ON original.shop_id=v.shop_id AND original.command_id=$4 AND original.resource_id=v.shopify_id AND original.status='SUCCEEDED' JOIN mirror.product_snapshots ps ON ps.shop_id=original.shop_id AND ps.edit_item_id=original.id AND ps.confirmed_at IS NOT NULL AND ps.after_hash IS NOT NULL AND ps.before_values ?& $5::text[]":''}
         WHERE si.shop_id=$1 AND si.snapshot_id=$3 ORDER BY si.product_id,v.id LIMIT 100001`,
         kind==='undo'?[shopId,commandId,contract.snapshot_id,sourceCommandId,instructions.fields]:[shopId,commandId,contract.snapshot_id,JSON.stringify(instructions)]);
      }else if (kind === "bulk_edit") {
        items = await tx.query(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,status,intended_values,attempts)
          SELECT si.shop_id,$2,p.shopify_id,'PENDING',$4::jsonb,0 FROM mirror.selection_items si
          JOIN mirror.products p ON p.shop_id=si.shop_id AND p.generation_id=si.generation_id AND p.id=si.product_id
          WHERE si.shop_id=$1 AND si.snapshot_id=$3 ORDER BY si.product_id`, [shopId,commandId,contract.snapshot_id,JSON.stringify(instructions)]);
      } else {
        items = await tx.query(`INSERT INTO mirror.job_items(shop_id,command_id,resource_id,status,intended_values,restore_snapshot_id,attempts)
          SELECT si.shop_id,$2,p.shopify_id,'PENDING',
            (SELECT jsonb_object_agg(k,v) FROM jsonb_each(ps.before_values) entry(k,v) WHERE k=ANY($5::text[])),ps.id,0
          FROM mirror.selection_items si JOIN mirror.products p ON p.shop_id=si.shop_id AND p.generation_id=si.generation_id AND p.id=si.product_id
          JOIN mirror.job_items original ON original.shop_id=si.shop_id AND original.command_id=$4 AND original.resource_id=p.shopify_id
          JOIN mirror.product_snapshots ps ON ps.shop_id=original.shop_id AND ps.edit_item_id=original.id
          WHERE si.shop_id=$1 AND si.snapshot_id=$3 AND original.status='SUCCEEDED' AND ps.confirmed_at IS NOT NULL
            AND ps.after_hash IS NOT NULL AND ps.before_values ?& $5::text[] ORDER BY si.product_id`,
        [shopId,commandId,contract.snapshot_id,sourceCommandId,instructions.fields]);
      }
      if (items.rowCount !== expected) fail(C.CONTRACT_MISMATCH, "Materialized targets differ from approved selection");
      const payload = JSON.stringify({ shopId, commandId: String(commandId), contractId, itemCount: expected });
      await tx.query(`INSERT INTO mirror.outbox_events(shop_id,command_id,dedupe_key,available_at,attempts,fence)
        VALUES($1,$2,$3,clock_timestamp(),0,0)`, [shopId,commandId,key]);
      await tx.query(`INSERT INTO mirror.audit_events(shop_id,operation_id,action,actor_id,outcome,summary,created_at)
        VALUES($1,$2,$3,$4,'PENDING',$5,clock_timestamp())`, [shopId,contractId,`${kind}_dispatched`,actorId,payload]);
      if (await resolveShop(authContext) !== shopId) fail(C.PERMISSION_DENIED, "Dispatch shop changed");
      const currentContract = await approvalService.getApprovedContract({ client: tx, shopId, contractId });
      assertIntendedValues(kind === "bulk_edit" ? bulkInstructions(currentContract, shopId) : kind==='import'?importInstructions(currentContract,shopId):undoInstructions(currentContract, shopId), instructions);
      await requireWriteAuthorization(authorizeWrite, { ...authorization, contract: currentContract });
      if (owned) await tx.query("COMMIT");
      else {await tx.query('RELEASE SAVEPOINT metamax_dispatch');savepoint=false;}
      // The separate operation outbox dispatcher publishes committed rows.
      return receipt({ ...inserted, operation_id:op.id, item_count:expected }, false);
    } catch (error) {
      if (owned) { try { await tx.query("ROLLBACK"); } catch {} }
      else if(savepoint){
        try{await tx.query('ROLLBACK TO SAVEPOINT metamax_dispatch');await tx.query('RELEASE SAVEPOINT metamax_dispatch');}
        catch(rollbackError){throw new FieldError(C.EXECUTION_UNAVAILABLE,'Dispatch rollback failed; caller must roll back the outer transaction',{cause:new AggregateError([error,rollbackError])});}
      }
      throw error;
    } finally { if (owned) tx.release(); else externalInFlight.delete(tx); }
  }
  async function requeueDispatch({authContext,contractId,kind,sourceCommandId,reason}={}){
    if(!['bulk_edit','undo','import'].includes(kind)||typeof reason!=='string'||!reason.trim()||reason.length>512)fail(C.INVALID_VALUE,'Supported command and bounded review reason required');
    const tx=await database.connect();
    try{
      await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');await tx.query("SET LOCAL statement_timeout='15000ms'");await tx.query("SET LOCAL lock_timeout='2000ms'");
      const receipt=await dispatch(kind,{client:tx,authContext,contractId,sourceCommandId});
      if(!receipt.existing)fail(C.CONTRACT_MISMATCH,'Review can only requeue existing work');
      const shopId=await resolveShop(authContext);
      const changed=await tx.query(`UPDATE mirror.outbox_events e SET review_required=false,last_error=NULL,attempts=0,available_at=clock_timestamp(),
       fence=fence+1,lease_token=NULL,lease_until=NULL FROM mirror.job_commands c WHERE e.shop_id=$1 AND e.command_id=$2
       AND c.shop_id=e.shop_id AND c.id=e.command_id AND c.status IN('PENDING','RETRY') AND c.cancel_requested_at IS NULL
       AND e.review_required AND e.dispatched_at IS NULL AND(e.lease_until IS NULL OR e.lease_until<=clock_timestamp()) RETURNING e.id`,[shopId,receipt.commandId]);
      if(changed.rowCount!==1)fail(C.CONTRACT_MISMATCH,'Unpublished reviewed event required');
      await tx.query(`INSERT INTO mirror.audit_events(shop_id,operation_id,action,actor_id,outcome,summary) VALUES($1,$2,'operation_dispatch_requeued','authorized_merchant','PENDING',$3::jsonb)`,
       [shopId,contractId,JSON.stringify({commandId:receipt.commandId,reason})]);
      await tx.query('COMMIT');return Object.freeze({...receipt,requeued:true});
    }catch(error){await tx.query('ROLLBACK').catch(()=>{});throw error;}finally{tx.release();}
  }
  const service=Object.freeze({ dispatchBulkEdit: options => dispatch("bulk_edit", options), dispatchUndo: options => dispatch("undo", options), dispatchImport: options=>dispatch("import",options),requeueDispatch });
  issuedDispatchers.add(service);return service;
}
