/**
 * METAMAX — Immutable Approval Service
 *
 * Implements Step 8.3:
 * When the merchant approves a bulk edit, binds the exact target set,
 * field definitions, mutation payload, authorizing actor, and preview contract.
 *
 * Enforces cryptographic immutability: once approved, a browser request
 * cannot replace the approved targets or values.
 */

import { createHash, randomUUID } from "node:crypto";
import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";

const DEFAULT_APPROVAL_LIFETIME_MS = 1800000; // 30 minutes

function fail(code, message) {
  throw new FieldError(code, message);
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key,canonicalJsonValue(value[key])]));
  return value;
}

export function computeContractHash({
  shopId,
  snapshotId,
  operation,
  contract,
  selectionHash,
  approvedBy,
  legacy = false,
}) {
  const payload = JSON.stringify({
    shopId,
    snapshotId,
    operation,
    contract: legacy ? contract : canonicalJsonValue(JSON.parse(JSON.stringify(contract))),
    selectionHash,
    approvedBy,
  });
  return createHash("sha256").update(legacy ? payload : canonicalApproval({shopId,snapshotId,operation,contract,selectionHash,approvedBy})).digest("hex");
}

export function canonicalApproval({shopId,snapshotId,operation,contract,selectionHash,approvedBy}) {
  return JSON.stringify(canonicalJsonValue(JSON.parse(JSON.stringify({hashVersion:"canonical-v2",shopId,snapshotId,operation,contract,selectionHash,approvedBy}))));
}

export async function getApprovedContractInTransaction({ client, shopId, contractId } = {}) {
  if (typeof client?.query !== "function") throw new TypeError("Explicit transaction query client required");
      if (!shopId || !contractId) {
        fail(C.INVALID_VALUE, "shopId and contractId required");
      }
      const q = client;
      const res = await q.query(
        `SELECT c.*, s.selection_hash
         FROM mirror.execution_contracts c
         JOIN mirror.selection_snapshots s ON s.shop_id = c.shop_id AND s.id = c.snapshot_id
         WHERE c.shop_id = $1 AND c.id = $2`,
        [shopId, contractId],
      );

      const contract = res.rows[0];
      if (!contract) return null;

      // Verify status and expiration
      if (contract.status !== "APPROVED") {
        fail(C.EXECUTION_UNAVAILABLE, "Execution contract is not approved");
      }
      if (new Date(contract.expires_at).getTime() <= Date.now()) {
        fail(C.EXECUTION_UNAVAILABLE, "Execution contract has expired");
      }

      // Verify cryptographic contractHash
      const expectedHash = computeContractHash({
        shopId: contract.shop_id,
        snapshotId: contract.snapshot_id,
        operation: contract.operation,
        contract: contract.contract,
        selectionHash: contract.selection_hash,
        approvedBy: contract.approved_by,
      });

      const context={shopId:contract.shop_id,snapshotId:contract.snapshot_id,operation:contract.operation,
        contract:contract.contract,selectionHash:contract.selection_hash,approvedBy:contract.approved_by};
      let valid=false;
      if(contract.hash_version==="canonical-v2") {
        valid=contract.canonical_contract===canonicalApproval(context)&&expectedHash===contract.contract_hash;
      } else if(contract.hash_version==="legacy-v1") {
        const legacy=computeContractHash({...context,legacy:true});
        const oldCanonical=createHash("sha256").update(JSON.stringify({...context,contract:canonicalJsonValue(context.contract)})).digest("hex");
        valid=contract.canonical_contract==null&&(contract.contract_hash===legacy||contract.contract_hash===oldCanonical);
      }
      if (!valid) {
        fail(C.CONTRACT_MISMATCH, "Execution contract tampering detected; contractHash mismatch");
      }

      return contract;
}

export function createApprovalService({
  database,
  selectionService,
  resolveMerchantActor,
  authorizeImportApproval,
  logger = console,
} = {}) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("Database client with query method required");
  }

  return Object.freeze({
    /**
     * Creates and approves an immutable preview execution contract.
     */
    async approveContract({
      client,
      authContext,
      shopId,
      snapshotId,
      operation = "bulk_edit",
      contractPayload,
      approvedBy,
      lifetimeMs = DEFAULT_APPROVAL_LIFETIME_MS,
    } = {}) {
      if (!shopId || !snapshotId) {
        fail(C.INVALID_VALUE, "shopId and snapshotId required");
      }
      let importActor;
      if(operation==="import") {
        if(!authContext||typeof resolveMerchantActor!=="function"||typeof authorizeImportApproval!=="function")fail(C.PERMISSION_DENIED,"Verified explicit merchant import approval required");
        importActor=await resolveMerchantActor(authContext);
        if(!importActor||importActor.shopId!==shopId||typeof importActor.id!=="string"||!importActor.id)fail(C.PERMISSION_DENIED,"Verified merchant actor required");
        approvedBy=importActor.id;
      }
      if (!approvedBy || typeof approvedBy !== "string") {
        fail(C.PERMISSION_DENIED, "Authorizing actor (approvedBy) required");
      }
      if (!contractPayload || typeof contractPayload !== "object") {
        fail(C.INVALID_VALUE, "Validated contract payload required");
      }

      const txClient = client || (await database.connect?.()) || database;
      const isExternalClient = Boolean(client);

      try {
        if (!isExternalClient && database.connect) {
          await txClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        }

        // 1. Verify selection snapshot is approved, valid, and unexpired
        const snapRes = await txClient.query(
          `SELECT id, status, selection_hash, expires_at, generation_id,coverage_revision,operation_id
           FROM mirror.selection_snapshots
           WHERE shop_id = $1 AND id = $2 FOR SHARE`,
          [shopId, snapshotId],
        );

        const snapshot = snapRes.rows[0];
        if (!snapshot) {
          fail(C.INVALID_VALUE, "Referenced selection snapshot not found");
        }
        if (snapshot.status !== "APPROVED") {
          fail(C.CONTRACT_MISMATCH, "Selection snapshot is not in APPROVED state");
        }
        if (new Date(snapshot.expires_at).getTime() <= Date.now()) {
          fail(C.EXECUTION_UNAVAILABLE, "Selection snapshot has expired");
        }
        let importPreview;
        if(operation==="import") {
          if(typeof contractPayload.previewId!=="string"||!(/^[a-f0-9]{64}$/).test(contractPayload.previewHash)||Object.keys(contractPayload).some(key=>!["previewId","previewHash"].includes(key)))fail(C.INVALID_VALUE,"Exact reviewed import preview required");
          importPreview=(await txClient.query("SELECT * FROM mirror.import_previews WHERE shop_id=$1 AND id=$2 FOR UPDATE",[shopId,contractPayload.previewId])).rows[0];
          if(!importPreview||importPreview.status!=="DRAFT"||importPreview.snapshot_id!==snapshotId||importPreview.preview_hash!==contractPayload.previewHash||new Date(importPreview.expires_at)<=new Date())fail(C.CONTRACT_MISMATCH,"Import preview is missing, changed, expired or already approved");
          const prepared=typeof importPreview.payload==="string"?JSON.parse(importPreview.payload):importPreview.payload;
          const canonicalPreview=canonicalApproval({shopId,snapshotId,operation:"import-preview",contract:prepared,selectionHash:snapshot.selection_hash,approvedBy:importPreview.created_by});
          if(canonicalPreview!==importPreview.canonical_preview||createHash("sha256").update(canonicalPreview).digest("hex")!==importPreview.preview_hash)fail(C.CONTRACT_MISMATCH,"Import preview hash mismatch");
          if(await authorizeImportApproval({authContext,actor:importActor,operation:"import",preview:importPreview,payload:prepared,snapshot})!==true)fail(C.PERMISSION_DENIED,"Current import approval authorization required");
          contractPayload={previewId:importPreview.id,previewHash:importPreview.preview_hash,...prepared};
        }

        // 2. Compute canonical contract hash
        const contractId = randomUUID();
        const approvalRevision = randomUUID();
        const contractHash = computeContractHash({
          shopId,
          snapshotId,
          operation,
          contract: contractPayload,
          selectionHash: snapshot.selection_hash,
          approvedBy,
        });
        const canonical = canonicalApproval({shopId,snapshotId,operation,contract:contractPayload,selectionHash:snapshot.selection_hash,approvedBy});

        const now = new Date();
        const expiresAt = new Date(Math.min(now.getTime() + lifetimeMs, new Date(snapshot.expires_at).getTime()));

        // The database requires DRAFT before the atomic approval transition.
        await txClient.query(
          `INSERT INTO mirror.execution_contracts(
             shop_id, id, snapshot_id, operation, approval_revision,
             status, contract, contract_hash, approved_by, approved_at, expires_at,hash_version,canonical_contract
           ) VALUES (
             $1, $2, $3, $4, $5,
             'DRAFT', $6, $7, $8, $9, $10,'canonical-v2',$11
           )`,
          [
            shopId,
            contractId,
            snapshotId,
            operation,
            approvalRevision,
            JSON.stringify(contractPayload),
            contractHash,
            approvedBy,
            now,
            expiresAt,
            canonical,
          ],
        );
        const frozen = await txClient.query(
          `UPDATE mirror.execution_contracts SET status='APPROVED'
           WHERE shop_id=$1 AND id=$2 AND status='DRAFT'`, [shopId,contractId],
        );
        if (frozen.rowCount !== 1) fail(C.CONTRACT_MISMATCH, "Execution contract could not be approved");
        if(importPreview) {
          const actor=await resolveMerchantActor(authContext);
          if(actor?.shopId!==shopId||actor.id!==importActor.id||await authorizeImportApproval({authContext,actor,operation:"import",preview:importPreview,payload:contractPayload,snapshot})!==true)fail(C.PERMISSION_DENIED,"Import approval authorization changed");
          const approved=await txClient.query("UPDATE mirror.import_previews SET status='APPROVED',contract_id=$3,approved_by=$4,approved_at=clock_timestamp() WHERE shop_id=$1 AND id=$2 AND status='DRAFT'",[shopId,importPreview.id,contractId,approvedBy]);
          if(approved.rowCount!==1)fail(C.CONTRACT_MISMATCH,"Import preview approval superseded");
        }

        if (!isExternalClient && database.connect) {
          await txClient.query("COMMIT");
        }

        return Object.freeze({
          contractId,
          shopId,
          snapshotId,
          operation,
          approvalRevision,
          status: "APPROVED",
          contractHash,
          approvedBy,
          approvedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          contract: contractPayload,
        });
      } catch (error) {
        if (!isExternalClient && database.connect) {
          try {
            await txClient.query("ROLLBACK");
          } catch {}
        }
        if (error instanceof FieldError) throw error;
        logger.error?.({ error }, "Failed to approve execution contract");
        throw error;
      } finally {
        if (!isExternalClient && txClient.release) {
          txClient.release();
        }
      }
    },

    /**
     * Verifies that an approved execution contract is genuine, unexpired,
     * and strictly matches its cryptographic contractHash.
     */
    async getApprovedContract({ client, shopId, contractId } = {}) {
      return getApprovedContractInTransaction({ client: client || database, shopId, contractId });
    },

    /**
     * Revokes an existing approved contract.
     */
    async revokeApproval({ client, shopId, contractId } = {}) {
      if (!shopId || !contractId) {
        fail(C.INVALID_VALUE, "shopId and contractId required");
      }
      const q = client || database;
      const res = await q.query(
        `UPDATE mirror.execution_contracts
         SET status = 'REVOKED'
         WHERE shop_id = $1 AND id = $2 AND status = 'APPROVED'
         RETURNING id`,
        [shopId, contractId],
      );
      return res.rowCount === 1;
    },
  });
}
