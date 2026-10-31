/** Durable dispatch: authenticated identity, immutable approval, set-based items. */
import { createHash } from "node:crypto";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { bulkInstructions, undoInstructions, assertIntendedValues, requireWriteAuthorization } from "./operation-instructions.server.js";

const fail = (code, message) => { throw new FieldError(code, message); };
const issuedDispatchers=new WeakSet();
export function assertJobDispatchService(service){if(!issuedDispatchers.has(service))throw TypeError('Issued Bulk Edit dispatch service required');}

export function createJobDispatchService({ database, approvalService, resolveShop, authorizeWrite } = {}) {
  if (typeof database?.connect !== "function" || typeof approvalService?.getApprovedContract !== "function" ||
      typeof resolveShop !== "function" || typeof authorizeWrite !== "function") {
    throw new TypeError("Transactional database, approval service and trusted shop/write authorization required");
  }
  async function dispatch(kind, { client, authContext, contractId, sourceCommandId, actorId = "system", ...unsupported } = {}) {
    if (!authContext || Object.hasOwn(unsupported, "shopId")) fail(C.PERMISSION_DENIED, "Authenticated dispatch context required; shopId is server-resolved");
    if (typeof contractId !== "string" || !contractId) fail(C.INVALID_VALUE, "Immutable approved contractId required");
    if (kind === "undo" && !sourceCommandId) fail(C.INVALID_VALUE, "Approved undo source required");
    const shopId = await resolveShop(authContext);
    if (typeof shopId !== "string" || shopId.trim() !== shopId || shopId.length > 255 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopId)) fail(C.PERMISSION_DENIED, "Authenticated dispatch shop required");
    // Caller keys cannot split one approved operation into multiple commands.
    const key = `operation:v1:${createHash("sha256").update(JSON.stringify([shopId, kind, contractId])).digest("hex")}`;
    const tx = client ?? await database.connect();
    const owned = !client;
    const findExisting = async () => (await tx.query(
      `SELECT c.id,c.status,c.contract_id,c.kind,e.id AS operation_id,
        (SELECT count(*)::text FROM mirror.job_items i WHERE i.shop_id=c.shop_id AND i.command_id=c.id) AS item_count
       FROM mirror.job_commands c LEFT JOIN mirror.edit_operations e ON e.shop_id=c.shop_id AND e.command_id=c.id
       WHERE c.shop_id=$1 AND c.kind=$2 AND c.contract_id=$3`, [shopId,kind,contractId])).rows[0];
    const receipt = (command, existing) => Object.freeze({
      commandId: String(command.id), editOperationId: String(command.operation_id),
      ...(kind === "undo" ? { restoreCommandId: String(command.id), restoreOperationId: String(command.operation_id) } : {}),
      contractId, status: command.status, idempotencyKey: key, itemCount: Number(command.item_count), existing,
    });
    try {
      // READ COMMITTED lets a losing INSERT see the committed winner next.
      // Contracts and approved selection membership are immutable.
      if (owned) {
        await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await tx.query("SET LOCAL lock_timeout = '2000ms'");
        await tx.query("SET LOCAL statement_timeout = '30000ms'");
      }
      const previous = await findExisting();
      if (previous) {
        if (await resolveShop(authContext) !== shopId) fail(C.PERMISSION_DENIED, "Dispatch shop changed");
        if (owned) await tx.query("COMMIT");
        return receipt(previous, true);
      }
      const contract = await approvalService.getApprovedContract({ client: tx, shopId, contractId });
      const instructions = kind === "bulk_edit" ? bulkInstructions(contract, shopId) : undoInstructions(contract, shopId);
      if (kind === "undo" && instructions.sourceCommandId !== String(sourceCommandId)) fail(C.CONTRACT_MISMATCH, "Undo source differs from approval");
      const authorization = { authContext, shopId, contract, operation: kind,
        fields: kind === "bulk_edit" ? Object.keys(instructions) : instructions.fields };
      await requireWriteAuthorization(authorizeWrite, authorization);
      const inserted = (await tx.query(
        `INSERT INTO mirror.job_commands(shop_id,contract_id,idempotency_key,kind,status,attempts,max_attempts,available_at,fence,created_at,updated_at)
         VALUES($1,$2,$3,$4,'PENDING',0,8,clock_timestamp(),0,clock_timestamp(),clock_timestamp())
         ON CONFLICT DO NOTHING RETURNING id,status`, [shopId,contractId,key,kind])).rows[0];
      if (!inserted) {
        const winner = await findExisting();
        if (!winner) fail(C.EXECUTION_UNAVAILABLE, "Concurrent dispatch committed outside this snapshot; retry transaction");
        if (await resolveShop(authContext) !== shopId) fail(C.PERMISSION_DENIED, "Dispatch shop changed");
        if (owned) await tx.query("COMMIT");
        return receipt(winner, true);
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
      const expected = Number(count?.selected_count), targets = Number(count?.target_count);
      if (!Number.isSafeInteger(expected) || expected < 1 || expected !== targets) fail(C.CONTRACT_MISMATCH, "Approved selection membership is incomplete");
      let items;
      if (kind === "bulk_edit") {
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
      assertIntendedValues(kind === "bulk_edit" ? bulkInstructions(currentContract, shopId) : undoInstructions(currentContract, shopId), instructions);
      await requireWriteAuthorization(authorizeWrite, { ...authorization, contract: currentContract });
      if (owned) await tx.query("COMMIT");
      // The separate operation outbox dispatcher publishes committed rows.
      return receipt({ ...inserted, operation_id:op.id, item_count:expected }, false);
    } catch (error) {
      if (owned) { try { await tx.query("ROLLBACK"); } catch {} }
      throw error;
    } finally { if (owned) tx.release(); }
  }
  const service=Object.freeze({ dispatchBulkEdit: options => dispatch("bulk_edit", options), dispatchUndo: options => dispatch("undo", options) });
  issuedDispatchers.add(service);return service;
}
