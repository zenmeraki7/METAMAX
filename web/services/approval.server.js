// Interface contract (repository root): docs/backend-interface-contracts.md#approval-and-approval-reads
import {APPROVAL_SCHEMA_VERSION,readApprovalCoordinates,verifyApprovalCoordinates} from './approval-coordinates.server.js';
import {bindExecutionCoordinates,executionAuthorityRecord} from './execution-contract.server.js';
import {resourceUpdates,undoInstructions,importInstructions} from './operation-instructions.server.js';
import {WRITE_CAPABILITY_VERSION,assertWriteCapabilityVersion,HISTORY_EXECUTION_CAPABILITIES,requireResourceWriteContract,assertInstalledUndoCapability} from '../fields/write-capabilities.js';
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
import { deepFreeze, FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";

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

export const getApprovedContractInTransaction=({client,shopId,contractId}={})=>readExecutionContract({client,shopId,contractId});
// Evidence-only reading of an immutable historical approval. This cannot issue
// a live execution grant and does not refresh expiry or adapter compatibility.
export const getEvidenceContractInTransaction=({client,shopId,contractId}={})=>readExecutionContract({client,shopId,contractId,historical:true});
async function readExecutionContract({ client, shopId, contractId,historical=false } = {}) {
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
      if (contract.shop_id !== shopId || contract.id !== contractId) {
        fail(C.CONTRACT_MISMATCH, "Execution contract identity mismatch");
      }

      // Verify status and expiration
      if (historical?!['APPROVED','REVOKED','EXPIRED'].includes(contract.status):contract.status !== "APPROVED") {
        fail(C.EXECUTION_UNAVAILABLE, "Execution contract is not approved");
      }
      if (!Number.isFinite(new Date(contract.expires_at).getTime()) || !historical&&new Date(contract.expires_at).getTime() <= Date.now()) {
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

      const coordinates=historical?contract.contract?.executionCoordinates:await verifyApprovalCoordinates({client:q,shopId,contract});
      if(!coordinates||coordinates.shopId!==shopId||coordinates.snapshotId!==contract.snapshot_id||coordinates.operation!==contract.operation||coordinates.selectionHash!==contract.selection_hash)
        fail(C.CONTRACT_MISMATCH,'Persisted execution authority differs from approval');
      return Object.freeze({...contract,contract:deepFreeze(canonicalJsonValue(contract.contract)),evidenceOnly:historical,executionAuthority:executionAuthorityRecord(contract,coordinates)});
}

/** Trusted bootstrap adapters: resolveMerchantActor must authenticate the opaque
 * context and return {id, shopId}. authorizeApproval (or authorizeImportApproval
 * for imports) must check current operation/field permissions and return true.
 * It receives the active transaction client, actor, payload and selection.
 * Read-only contract retrieval does not require these approval adapters. */
export function createApprovalService({
  database,
  selectionService,
  resolveMerchantActor,
  authorizeImportApproval,
  authorizeApproval,
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
      const authorize = operation === 'import' ? authorizeImportApproval : authorizeApproval;
      if (!authContext || typeof resolveMerchantActor !== 'function' || typeof authorize !== 'function')
        fail(C.PERMISSION_DENIED, 'Verified merchant identity and current approval authorization required');
      const actor = await resolveMerchantActor(authContext);
      if (!actor || actor.shopId !== shopId || typeof actor.id !== 'string' || !actor.id.trim() ||
          (approvedBy !== undefined && approvedBy !== actor.id))
        fail(C.PERMISSION_DENIED, 'Verified merchant actor required; approving actor cannot be overridden');
      approvedBy = actor.id;
      if (!contractPayload || typeof contractPayload !== "object") {
        fail(C.INVALID_VALUE, "Validated contract payload required");
      }

      if (!client && typeof database.connect !== 'function')
        fail(C.EXECUTION_UNAVAILABLE, 'Transactional approval storage required');
      const txClient = client || await database.connect();
      const isExternalClient = Boolean(client);

      try {
        if (!isExternalClient) {
          await txClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          // The authenticated actor and current approval authorization above
          // establish the shop; pool connections start without tenant settings.
          await txClient.query("SELECT set_config('app.shop_id',$1,true)",[shopId]);
        }

        // 1. Verify selection snapshot is approved, valid, and unexpired
        const {snapshot,coordinates:baseCoordinates}=await readApprovalCoordinates({client:txClient,shopId,snapshotId});
        if(snapshot.operation!==operation)fail(C.CONTRACT_MISMATCH,'Selection operation differs from approval');
        if (!snapshot) {
          fail(C.INVALID_VALUE, "Referenced selection snapshot not found");
        }
        if (snapshot.status !== "APPROVED") {
          fail(C.CONTRACT_MISMATCH, "Selection snapshot is not in APPROVED state");
        }
        if (!Number.isFinite(new Date(snapshot.expires_at).getTime()) || new Date(snapshot.expires_at).getTime() <= Date.now()) {
          fail(C.EXECUTION_UNAVAILABLE, "Selection snapshot has expired");
        }
        let importPreview;
        if(operation==="import") {
          if(typeof contractPayload.previewId!=="string"||!(/^[a-f0-9]{64}$/).test(contractPayload.previewHash)||Object.keys(contractPayload).some(key=>!["previewId","previewHash"].includes(key)))fail(C.INVALID_VALUE,"Exact reviewed import preview required");
          importPreview=(await txClient.query("SELECT * FROM mirror.import_previews WHERE shop_id=$1 AND id=$2 FOR UPDATE",[shopId,contractPayload.previewId])).rows[0];
          if(!importPreview||importPreview.status!=="DRAFT"||importPreview.snapshot_id!==snapshotId||importPreview.preview_hash!==contractPayload.previewHash||new Date(importPreview.expires_at)<=new Date())fail(C.CONTRACT_MISMATCH,"Import preview is missing, changed, expired or already approved");
          const prepared=typeof importPreview.payload==="string"?JSON.parse(importPreview.payload):importPreview.payload;
          assertWriteCapabilityVersion(prepared.writeCapabilityVersion);
          const canonicalPreview=canonicalApproval({shopId,snapshotId,operation:"import-preview",contract:prepared,selectionHash:snapshot.selection_hash,approvedBy:importPreview.created_by});
          if(canonicalPreview!==importPreview.canonical_preview||createHash("sha256").update(canonicalPreview).digest("hex")!==importPreview.preview_hash)fail(C.CONTRACT_MISMATCH,"Import preview hash mismatch");
          if(await authorizeImportApproval({client:txClient,authContext,actor,operation:"import",preview:importPreview,payload:prepared,snapshot})!==true)fail(C.PERMISSION_DENIED,"Current import approval authorization required");
          contractPayload={previewId:importPreview.id,previewHash:importPreview.preview_hash,...prepared};
        }

        if(Object.hasOwn(contractPayload,'executionCoordinates')||Object.hasOwn(contractPayload,'executionAuthority'))fail(C.INVALID_VALUE,'Execution coordinates are server-owned');
        const resourceType=contractPayload.resourceType??'product';
        const executionCapability=Object.hasOwn(HISTORY_EXECUTION_CAPABILITIES.operations,operation)?HISTORY_EXECUTION_CAPABILITIES.operations[operation]:null;
        if(executionCapability&&!executionCapability.resourceTypes.includes(resourceType))fail(C.UNSUPPORTED_OPERATION,'Operation has no installed writer for this resource type');
        const writer=requireResourceWriteContract(resourceType);
        if(contractPayload.resourceFamily!==undefined&&contractPayload.resourceFamily!==writer.resourceFamily)fail(C.UNSUPPORTED_OPERATION,'Resource family has no installed writer');
        if(contractPayload.writeCapabilityVersion !== undefined)assertWriteCapabilityVersion(contractPayload.writeCapabilityVersion,{resourceType});
        if(contractPayload.approvalSchemaVersion!==undefined&&contractPayload.approvalSchemaVersion!==APPROVAL_SCHEMA_VERSION)fail(C.CONTRACT_MISMATCH,'Approval schema version is incompatible');
        const approvalRevision = randomUUID();
        const coordinates=bindExecutionCoordinates({coordinates:baseCoordinates,payload:contractPayload,approvalRevision});
        const executionCapabilities=deepFreeze({
          executor:HISTORY_EXECUTION_CAPABILITIES.executor,
          resourceType:writer.kind,
          resourceFamily:writer.resourceFamily,
          targetIdentity:writer.targetIdentity,
          supportedFields:Object.values(writer.bindings),
          operations:['set'],
          valueKinds:['VALUE'],
          maxResourcesPerRequest:1,
          maxExecutionItemsPerRequest:1,
          adapterVersion:writer.adapterVersion,
        });
        contractPayload={...contractPayload,resourceType:writer.kind,resourceFamily:writer.resourceFamily,executionCapabilities,approvalSchemaVersion:APPROVAL_SCHEMA_VERSION,writeCapabilityVersion:WRITE_CAPABILITY_VERSION,executionCoordinates:coordinates};
        if(['bulk_edit','scheduled_edit','recurring_edit'].includes(operation))contractPayload={...contractPayload,updates:resourceUpdates(resourceType,contractPayload.updates)};
        if(operation==='undo')undoInstructions({shop_id:shopId,status:'APPROVED',operation,contract:contractPayload},shopId);
        if(operation==='import')importInstructions({shop_id:shopId,status:'APPROVED',operation,contract:contractPayload},shopId);
        if(resourceType==='variant'){
          const expectedPolicy=operation==='undo'?'VERIFIED_VARIANTS_OF_SOURCE_COMMAND':'ALL_VARIANTS_OF_SELECTED_PRODUCTS';
          if(contractPayload.variantTargetingPolicy!==expectedPolicy)fail(C.INVALID_VALUE,'Explicit variant targeting policy required');
          const targets=(await txClient.query(`SELECT count(*)::text AS target_count FROM (SELECT v.id FROM mirror.selection_items si
           JOIN mirror.products p ON p.shop_id=si.shop_id AND p.generation_id=si.generation_id AND p.id=si.product_id
           JOIN mirror.variants v ON v.shop_id=p.shop_id AND v.generation_id=p.generation_id AND v.product_id=p.id
           ${operation==='undo'?"JOIN mirror.job_items original ON original.shop_id=v.shop_id AND original.command_id=$3 AND original.resource_id=v.shopify_id AND original.status='SUCCEEDED' JOIN mirror.product_snapshots ps ON ps.shop_id=original.shop_id AND ps.edit_item_id=original.id AND ps.confirmed_at IS NOT NULL AND ps.after_hash IS NOT NULL AND ps.before_values ?& $4::text[]":''}
           WHERE si.shop_id=$1 AND si.snapshot_id=$2 LIMIT 100001) bounded_targets`,operation==='undo'?[shopId,snapshotId,contractPayload.sourceCommandId,contractPayload.fields]:[shopId,snapshotId])).rows[0];
          const count=Number(targets?.target_count);
          if(!Number.isSafeInteger(count)||count<1||count>100000||contractPayload.variantTargetCount!==undefined&&String(contractPayload.variantTargetCount)!==String(count))fail(C.CONTRACT_MISMATCH,'Verified bounded variant target set required');
          contractPayload={...contractPayload,variantTargetCount:count};
        }
        contractPayload=deepFreeze(contractPayload);
        const checkApproval = async () => {
          const current = await resolveMerchantActor(authContext);
          if (current?.shopId !== shopId || current.id !== approvedBy ||
              await authorize({client:txClient,authContext,actor:current,shopId,operation,preview:importPreview,payload:contractPayload,snapshot}) !== true)
            fail(C.PERMISSION_DENIED, 'Current approval authorization required');
        };
        await checkApproval();
        if(operation==='undo')assertInstalledUndoCapability(resourceType);

        // 2. Compute canonical contract hash
        const contractId = randomUUID();
        const contractHash = computeContractHash({
          shopId,
          snapshotId,
          operation,
          contract: contractPayload,
          selectionHash: snapshot.selection_hash,
          approvedBy,
        });
        const canonical = canonicalApproval({shopId,snapshotId,operation,contract:contractPayload,selectionHash:snapshot.selection_hash,approvedBy});
        const executionAuthority=executionAuthorityRecord({shop_id:shopId,snapshot_id:snapshotId,operation,approval_revision:approvalRevision,contract_hash:contractHash},coordinates);

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
        await checkApproval();
        const frozen = await txClient.query(
          `UPDATE mirror.execution_contracts SET status='APPROVED'
           WHERE shop_id=$1 AND id=$2 AND status='DRAFT'`, [shopId,contractId],
        );
        if (frozen.rowCount !== 1) fail(C.CONTRACT_MISMATCH, "Execution contract could not be approved");
        if(importPreview) {
          const actor=await resolveMerchantActor(authContext);
          if(actor?.shopId!==shopId||actor.id!==approvedBy||await authorizeImportApproval({authContext,actor,operation:"import",preview:importPreview,payload:contractPayload,snapshot})!==true)fail(C.PERMISSION_DENIED,"Import approval authorization changed");
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
          executionAuthority,
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
