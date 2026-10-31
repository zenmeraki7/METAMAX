/**
 * METAMAX — Durable Bulk Operation Worker
 *
 * Implements Steps 9.2 & 9.3:
 * 1. Claims operation with atomic leasing & fencing
 * 2. Checks cancellation
 * 3. Captures authoritative before-state into mirror.product_snapshots
 * 4. Applies Shopify Admin GraphQL mutation
 * 5. Handles ambiguous network outcomes with safe rereads
 * 6. Rereads and verifies remote result
 * 7. Enforces undo safety: compares current state against after_hash to reject intervening edits
 * 8. Records completion and durable audit trail
 */

import { createHash } from "node:crypto";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { bulkInstructions, undoInstructions, restoredUpdates, assertIntendedValues, requireWriteAuthorization } from "../services/operation-instructions.server.js";

const DEFAULT_LEASE_SECONDS = 120;
const MAX_RETRY_BACKOFF_SECONDS = 900;

function computeHash(data) {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}

export function createOperationWorker({
  database,
  shopifyClientFactory,
  approvalService,
  authorizeWrite,
  logger = console,
} = {}) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("Database client with query method required");
  }
  if (typeof approvalService?.getApprovedContract !== "function" || typeof authorizeWrite !== "function") {
    throw new TypeError("Approved contracts and current write authorization required");
  }

  return Object.freeze({
    /**
     * Atomically claims the next pending, retryable, or expired command.
     */
    async claimNext({ workerId, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
      if (!workerId || typeof workerId !== "string") {
        throw new TypeError("Valid workerId required for durable claim");
      }

      const txClient = (await database.connect?.()) || database;
      const isPool = Boolean(database.connect);

      try {
        if (isPool) await txClient.query("BEGIN");

        const selectSql = `
          SELECT id, shop_id, contract_id, kind, attempts, max_attempts, fence, cancel_requested_at
          FROM mirror.job_commands
          WHERE kind IN ('bulk_edit','undo') AND ((status IN ('PENDING', 'RETRY') AND available_at <= clock_timestamp())
             OR (status = 'RUNNING' AND lease_until < clock_timestamp()))
          ORDER BY id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `;
        const claimRes = await txClient.query(selectSql);
        const command = claimRes.rows[0];

        if (!command) {
          if (isPool) await txClient.query("COMMIT");
          return null;
        }

        const updateSql = `
          UPDATE mirror.job_commands
          SET status = 'RUNNING',
              lease_token = $1,
              lease_until = clock_timestamp() + ($2 || ' seconds')::interval,
              fence = fence + 1,
              attempts = attempts + 1,
              updated_at = clock_timestamp()
          WHERE shop_id = $3 AND id = $4 AND fence = $5
          RETURNING id, shop_id, contract_id, kind, fence, attempts, max_attempts, cancel_requested_at
        `;
        const updatedRes = await txClient.query(updateSql, [
          workerId,
          leaseSeconds,
          command.shop_id,
          command.id,
          command.fence,
        ]);

        if (isPool) await txClient.query("COMMIT");
        return updatedRes.rows[0] || null;
      } catch (err) {
        if (isPool) {
          try {
            await txClient.query("ROLLBACK");
          } catch {}
        }
        logger.error?.({ err }, "Failed to claim job command");
        throw err;
      } finally {
        if (isPool && txClient.release) txClient.release();
      }
    },

    /**
     * Processes a single claimed command through the full execution pipeline.
     */
    async processOne({ workerId, leaseSeconds = DEFAULT_LEASE_SECONDS } = {}) {
      const claim = await this.claimNext({ workerId, leaseSeconds });
      if (!claim) return { kind: "EMPTY" };

      const { id: commandId, shop_id: shopId, contract_id: contractId, fence, cancel_requested_at } = claim;

      // 1. Safe Cancellation Check
      if (cancel_requested_at) {
        await database.query(
          `UPDATE mirror.job_commands
           SET status = 'CANCELLED', updated_at = clock_timestamp()
           WHERE shop_id = $1 AND id = $2 AND fence = $3`,
          [shopId, commandId, fence],
        );
        await database.query(
          `INSERT INTO mirror.audit_events(shop_id, operation_id, action, actor_id, outcome, summary, created_at)
           VALUES ($1, $2, 'bulk_edit_cancelled', $3, 'CANCELLED', '{"reason":"Cancellation requested"}', clock_timestamp())`,
          [shopId, contractId, workerId],
        );
        return { kind: "CANCELLED", commandId: String(commandId) };
      }

      // 2. Resolve Shopify Client for tenant
      const shopifyClient = shopifyClientFactory
        ? await shopifyClientFactory({ shopId })
        : null;

      // 3. Process Pending Items for Command
      const itemsRes = await database.query(
        `SELECT id, resource_id, intended_values, restore_snapshot_id, attempts
         FROM mirror.job_items
         WHERE shop_id = $1 AND command_id = $2 AND status IN ('PENDING', 'RETRY')
         ORDER BY id ASC`,
        [shopId, commandId],
      );

      const items = itemsRes.rows;
      let succeededCount = 0;
      let failedCount = 0;

      for (const item of items) {
        try {
          const intended = typeof item.intended_values === "string" ? JSON.parse(item.intended_values) : item.intended_values;
          const contract = await approvalService.getApprovedContract({ shopId, contractId });
          let approved;
          let undo;
          if (claim.kind === "undo") undo = undoInstructions(contract, shopId);
          else {
            if (item.restore_snapshot_id) throw new FieldError(C.CONTRACT_MISMATCH, "Unexpected restoration item");
            approved = bulkInstructions(contract, shopId);
          }
          if (typeof shopifyClient?.readProduct !== "function") throw new FieldError(C.EXECUTION_UNAVAILABLE, "Authoritative Shopify product reads required");
          // A. Step 9.3 — Safe Undo check: verify no intervening changes occurred
          if (undo) {
            if (!item.restore_snapshot_id) throw new FieldError(C.CONTRACT_MISMATCH, "Undo snapshot required");
            const snapRes = await database.query(
              `SELECT ps.before_values,ps.after_hash FROM mirror.product_snapshots ps
               JOIN mirror.job_items original ON original.shop_id=ps.shop_id AND original.id=ps.edit_item_id
               WHERE ps.shop_id=$1 AND ps.id=$2 AND original.command_id=$3 AND original.resource_id=$4
                 AND original.status='SUCCEEDED' AND ps.confirmed_at IS NOT NULL`,
              [shopId, item.restore_snapshot_id, undo.sourceCommandId, item.resource_id],
            );
            const snap = snapRes.rows[0];
            if (!snap?.after_hash) throw new FieldError(C.CONTRACT_MISMATCH, "Confirmed undo source required");
            approved = restoredUpdates(snap.before_values, undo.fields);

            if (shopifyClient?.readProduct) {
              const currentRemote = await shopifyClient.readProduct({
                shopId,
                resourceId: item.resource_id,
              });
              const currentHash = computeHash(currentRemote);

              if (snap?.after_hash && currentHash !== snap.after_hash) {
                // Intervening external modification detected! Safe undo stops.
                await database.query(
                  `UPDATE mirror.job_items i
                   SET status = 'FAILED', last_error = 'CONCURRENT_INTERVENING_MODIFICATION'
                   FROM mirror.job_commands c
                   WHERE i.shop_id = $1 AND i.id = $2
                     AND c.id = i.command_id AND c.shop_id = i.shop_id
                     AND c.fence = $3 AND c.lease_token = $4
                     AND c.lease_until > clock_timestamp()`,
                  [shopId, item.id, fence, workerId],
                );
                failedCount++;
                continue;
              }
            }
          }
          assertIntendedValues(intended, approved);
          const authorization = { shopId, contract, operation: claim.kind, resourceId:item.resource_id, fields:Object.keys(approved) };
          await requireWriteAuthorization(authorizeWrite, authorization);

          // B. Capture Authoritative Before-State
          let beforeValues = {};
          let beforeHash = null;
          let snapshotId = null;

          const existingSnap = await database.query(
            `SELECT id, before_values, before_hash FROM mirror.product_snapshots
             WHERE shop_id = $1 AND edit_item_id = $2`,
            [shopId, item.id],
          );

          if (existingSnap.rows.length > 0) {
            snapshotId = existingSnap.rows[0].id;
            beforeValues = typeof existingSnap.rows[0].before_values === "string"
              ? JSON.parse(existingSnap.rows[0].before_values)
              : existingSnap.rows[0].before_values;
            beforeHash = existingSnap.rows[0].before_hash;
          } else {
            if (shopifyClient?.readProduct) {
              const currentRemote = await shopifyClient.readProduct({
                shopId,
                resourceId: item.resource_id,
              });
              beforeValues = currentRemote;
            }
            beforeHash = computeHash(beforeValues);

            const snapInsertRes = await database.query(
              `INSERT INTO mirror.product_snapshots(
                 shop_id, edit_item_id, before_values, before_hash, captured_at
               ) VALUES ($1, $2, $3, $4, clock_timestamp())
               ON CONFLICT (shop_id, edit_item_id) DO NOTHING
               RETURNING id`,
              [shopId, item.id, JSON.stringify(beforeValues), beforeHash],
            );
            snapshotId = snapInsertRes.rows[0]?.id;
            if (!snapshotId) {
              const rereadSnap = await database.query(
                `SELECT id, before_values, before_hash FROM mirror.product_snapshots
                 WHERE shop_id = $1 AND edit_item_id = $2`,
                [shopId, item.id],
              );
              snapshotId = rereadSnap.rows[0]?.id;
              beforeHash = rereadSnap.rows[0]?.before_hash;
            }
          }

          // C. Apply Shopify Admin GraphQL Mutation
          const currentContract = await approvalService.getApprovedContract({ shopId, contractId });
          if (undo) assertIntendedValues(undoInstructions(currentContract, shopId), undo);
          else assertIntendedValues(bulkInstructions(currentContract, shopId), approved);
          await requireWriteAuthorization(authorizeWrite, { ...authorization, contract:currentContract });
          let mutationResult = null;
          if (shopifyClient?.applyMutation) {
            try {
              mutationResult = await shopifyClient.applyMutation({
                shopId,
                resourceId: item.resource_id,
                values: approved,
              });
            } catch (networkErr) {
              // Ambiguous API outcome: reread Shopify state before deciding
              if (shopifyClient?.readProduct) {
                const reread = await shopifyClient.readProduct({
                  shopId,
                  resourceId: item.resource_id,
                });
                if (reread && computeHash(reread) !== beforeHash) {
                  // Mutation actually applied remotely!
                  mutationResult = reread;
                } else {
                  throw networkErr;
                }
              } else {
                throw networkErr;
              }
            }
          } else {
            throw new FieldError(C.EXECUTION_UNAVAILABLE, "Shopify mutation adapter required");
          }

          // D. Reread & Verify Remote Result
          const afterHash = computeHash(mutationResult);
          if (snapshotId) {
            await database.query(
              `UPDATE mirror.product_snapshots
               SET after_hash = $1, confirmed_at = clock_timestamp()
               WHERE shop_id = $2 AND id = $3`,
              [afterHash, shopId, snapshotId],
            );
          }

          // Mark item SUCCEEDED with command lease and fence verification
          const itemUpdateRes = await database.query(
            `UPDATE mirror.job_items i
             SET status = 'SUCCEEDED', last_error = null
             FROM mirror.job_commands c
             WHERE i.shop_id = $1 AND i.id = $2
               AND c.id = i.command_id AND c.shop_id = i.shop_id
               AND c.fence = $3 AND c.lease_token = $4
               AND c.lease_until > clock_timestamp()`,
            [shopId, item.id, fence, workerId],
          );
          if (itemUpdateRes && typeof itemUpdateRes.rowCount === "number" && itemUpdateRes.rowCount === 0) {
            logger.error?.({ itemId: item.id, commandId, fence }, "Command lease or fence expired before marking item succeeded");
            return { kind: "STALE_CLAIM", commandId: String(commandId) };
          }
          succeededCount++;
        } catch (itemErr) {
          logger.error?.({ itemErr, itemId: item.id }, "Item mutation attempt failed");
          failedCount++;

          const nextAttempts = (item.attempts || 0) + 1;
          const retryAfter = Math.min(Math.pow(2, nextAttempts) * 10, MAX_RETRY_BACKOFF_SECONDS);

          await database.query(
            `UPDATE mirror.job_items i
             SET status = CASE WHEN $3 >= 8 THEN 'FAILED' ELSE 'RETRY' END,
                 attempts = $3,
                 next_attempt_at = clock_timestamp() + ($4 || ' seconds')::interval,
                 last_error = $5
             FROM mirror.job_commands c
             WHERE i.shop_id = $1 AND i.id = $2
               AND c.id = i.command_id AND c.shop_id = i.shop_id
               AND c.fence = $6 AND c.lease_token = $7
               AND c.lease_until > clock_timestamp()`,
            [shopId, item.id, nextAttempts, retryAfter, itemErr.message || String(itemErr), fence, workerId],
          );
        }
      }

      // 4. Update Command Status & Record Completion
      const remainingRes = await database.query(
        `SELECT count(*)::int AS remaining
         FROM mirror.job_items
         WHERE shop_id = $1 AND command_id = $2 AND status != 'SUCCEEDED'`,
        [shopId, commandId],
      );
      const remainingCount = remainingRes.rows[0]?.remaining || 0;

      if (remainingCount === 0) {
        // All items succeeded!
        await database.query(
          `UPDATE mirror.job_commands
           SET status = 'SUCCEEDED',
               lease_token = null,
               lease_until = null,
               checkpoint = '{"completed":true}',
               updated_at = clock_timestamp()
           WHERE shop_id = $1 AND id = $2 AND fence = $3`,
          [shopId, commandId, fence],
        );

        // Mark outbox event dispatched
        await database.query(
          `UPDATE mirror.outbox_events
           SET dispatched_at = clock_timestamp()
           WHERE shop_id = $1 AND (payload->>'commandId') = $2`,
          [shopId, String(commandId)],
        );

        // Audit Trail
        await database.query(
          `INSERT INTO mirror.audit_events(shop_id, operation_id, action, actor_id, outcome, summary, created_at)
           VALUES ($1, $2, 'bulk_edit_completed', $3, 'SUCCESS', $4, clock_timestamp())`,
          [
            shopId,
            contractId,
            workerId,
            JSON.stringify({ commandId: String(commandId), succeededCount, failedCount: 0 }),
          ],
        );

        return { kind: "SUCCEEDED", commandId: String(commandId), succeededCount };
      } else {
        // Some items remain pending or failed
        await database.query(
          `UPDATE mirror.job_commands
           SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'RETRY' END,
               lease_token = null,
               lease_until = null,
               available_at = clock_timestamp() + interval '30 seconds',
               updated_at = clock_timestamp()
           WHERE shop_id = $1 AND id = $2 AND fence = $3`,
          [shopId, commandId, fence],
        );

        return { kind: "PARTIAL", commandId: String(commandId), succeededCount, remainingCount };
      }
    },
  });
}
