import { randomUUID } from "node:crypto";
import { executionTransaction, lockCatalogExecution } from "./catalog-execution.server.js";
import { SyncOutcomeUnknownError } from "./sync-db-transaction.server.js";

const operationIdPattern = /^gid:\/\/shopify\/BulkOperation\/[1-9][0-9]*$/;
const unknown = () => { throw new SyncOutcomeUnknownError("External operation requires authoritative recovery"); };
function operationId(value) {
  if (typeof value !== "string" || !operationIdPattern.test(value)) throw new TypeError("Exact bulk operation identity required");
}
function one(result) {
  if (result.rows.length !== 1) unknown();
  return Object.freeze(result.rows[0]);
}

/** DB-only intent ledger. A dispatch receipt is scheduling evidence, never a
 * reusable authority grant. Remote calls must stay outside these transactions.
 * DISPATCHING without an exact response ID is ambiguous and cannot be replayed.
 */
export function createSyncExternalOperations({ database, inputHash, syncRunService }) {
  if (typeof database?.connect !== "function") throw new TypeError("PostgreSQL pool required");
  if (typeof inputHash !== "string" || !/^[a-f0-9]{64}$/.test(inputHash)) throw new TypeError("Trusted input hash required");
  if (typeof syncRunService?.bindBulkOperationIdInTransaction !== "function") throw new TypeError("Transactional binding service required");

  const owned = (claim, work) => executionTransaction(database, async client => {
    const row = await lockCatalogExecution(client, claim);
    const result = await work(client, row);
    // Locks prevent replacement, but time can still expire during a callback.
    await lockCatalogExecution(client, claim);
    return result;
  });
  const scope = claim => [claim.runId, claim.shopId, claim.generationId, inputHash];
  async function read(client, claim) {
    const result = await client.query(`SELECT * FROM mirror.sync_external_operations
      WHERE run_id=$1 AND shop_id=$2 AND generation_id=$3 AND kind='BULK_START' FOR UPDATE`, scope(claim).slice(0, 3));
    if (result.rows.length > 1) unknown();
    const intent = result.rows[0];
    if (intent && (intent.input_hash !== inputHash || BigInt(intent.dispatch_fence) > BigInt(claim.fence))) unknown();
    return intent;
  }
  function starting(claim) {
    if (claim.phase !== "STARTING") throw new TypeError("Bulk start requires STARTING phase");
  }

  return Object.freeze({
    // Commit PREPARED before dispatch, allowing safe recovery of a crash here.
    async prepare({ claim }) {
      starting(claim);
      return owned(claim, async (client, row) => {
        const intent = await read(client, claim);
        if (intent?.state === "CONFIRMED" && intent.operation_id === row.bulk_operation_id) {
          operationId(intent.operation_id);
          return Object.freeze({ ...intent, alreadyBound: true });
        }
        if (row.bulk_operation_id || (intent && (!['PREPARED', 'REJECTED'].includes(intent.state) || intent.operation_id))) unknown();
        if (intent) return Object.freeze(intent);
        return one(await client.query(`INSERT INTO mirror.sync_external_operations
          (id,shop_id,run_id,generation_id,kind,input_hash,state,dispatch_fence)
          VALUES($1,$2,$3,$4,'BULK_START',$5,'PREPARED',$6) RETURNING *`,
        [randomUUID(), claim.shopId, claim.runId, claim.generationId, inputHash, claim.fence]));
      });
    },
    async beginDispatch({ claim, intentId }) {
      starting(claim);
      return owned(claim, async client => one(await client.query(`UPDATE mirror.sync_external_operations
        SET state='DISPATCHING',dispatch_fence=$6,last_error=NULL,updated_at=now()
        WHERE run_id=$1 AND shop_id=$2 AND generation_id=$3 AND input_hash=$4 AND id=$5
          AND kind='BULK_START' AND state IN ('PREPARED','REJECTED') AND operation_id IS NULL
          AND dispatch_fence<=$6 RETURNING *`, [...scope(claim), intentId, claim.fence])));
    },
    // Preserve late response evidence even after lease loss. This cannot bind a
    // run, confirm an intent, change dispatch identity, or authorize a new call.
    async recordResponse({ claim, intentId, operationId: id }) {
      starting(claim);
      operationId(id);
      return executionTransaction(database, async client => one(await client.query(`UPDATE mirror.sync_external_operations
        SET operation_id=$7,updated_at=now()
        WHERE run_id=$1 AND shop_id=$2 AND generation_id=$3 AND input_hash=$4 AND id=$5
          AND kind='BULK_START' AND dispatch_fence=$6 AND state IN ('DISPATCHING','CONFIRMED')
          AND (operation_id IS NULL OR operation_id=$7) RETURNING *`, [...scope(claim), intentId, claim.fence, id])));
    },
    async reject({ claim, intentId }) {
      starting(claim);
      return owned(claim, async client => one(await client.query(`UPDATE mirror.sync_external_operations
        SET state='REJECTED',last_error='START_REJECTED',updated_at=now()
        WHERE run_id=$1 AND shop_id=$2 AND generation_id=$3 AND input_hash=$4 AND id=$5
          AND kind='BULK_START' AND dispatch_fence=$6 AND state='DISPATCHING'
          AND operation_id IS NULL RETURNING *`, [...scope(claim), intentId, claim.fence])));
    },
    async confirm({ claim, intentId, operationId: id }) {
      starting(claim);
      operationId(id);
      return owned(claim, async (client, row) => {
        const confirmed = one(await client.query(`UPDATE mirror.sync_external_operations
          SET state='CONFIRMED',last_error=NULL,updated_at=now()
          WHERE run_id=$1 AND shop_id=$2 AND generation_id=$3 AND input_hash=$4 AND id=$5
            AND kind='BULK_START' AND dispatch_fence=$6 AND operation_id=$7
            AND state IN ('DISPATCHING','CONFIRMED') RETURNING *`, [...scope(claim), intentId, claim.fence, id]));
        await syncRunService.bindBulkOperationIdInTransaction({ client, shopId: claim.shopId,
          runId: row.run_id, fence: row.ingestion_fence, bulkOperationId: id });
        return confirmed;
      });
    },
    async recordCompleted({ claim, operationId: id, objectCount }) {
      operationId(id);
      if (claim.phase !== "WAITING") throw new TypeError("Completion requires WAITING phase");
      if (!['string','bigint','number'].includes(typeof objectCount) ||
          (typeof objectCount === 'number' && !Number.isSafeInteger(objectCount)) ||
          !/^(0|[1-9][0-9]*)$/.test(String(objectCount)) || BigInt(objectCount) > 9223372036854775807n) {
        throw new TypeError("Bounded object count required");
      }
      return owned(claim, async (client, row) => {
        if (row.bulk_operation_id !== id) unknown();
        const receipt = one(await client.query(`UPDATE mirror.sync_external_operations
          SET remote_status='COMPLETED',object_count=$6,updated_at=now()
          WHERE run_id=$1 AND shop_id=$2 AND generation_id=$3 AND input_hash=$4
            AND kind='BULK_START' AND state='CONFIRMED' AND operation_id=$5
            AND (remote_status IS DISTINCT FROM 'COMPLETED' OR object_count=$6) RETURNING *`, [...scope(claim), id, String(objectCount)]));
        one(await client.query(`UPDATE mirror.ingestion_runs SET expected_lines=$3
          WHERE shop_id=$1 AND id=$2 AND generation_id=$4 AND execution_id=$5
            AND bulk_operation_id=$6 RETURNING id`, [claim.shopId, row.run_id, String(objectCount), claim.generationId, claim.runId, id]));
        return receipt;
      });
    },
  });
}
