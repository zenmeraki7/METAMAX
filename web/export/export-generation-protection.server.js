/** Transaction-scoped bridge to the actual Mirror Engine read-lease service.
 * It never changes a job's lease identity or substitutes the current generation.
 * Callers must hold the publication write barrier before taking job/lease locks.
 */
import { ExportContractError, EXPORT_ERROR_CODES as C } from "./export-contract.js";
import {FIELD_ERROR_CODES as F} from "../fields/types.js";

const fail = () => { throw new ExportContractError(C.SNAPSHOT_EXPIRED, "Exact export generation protection unavailable"); };

/** Current query authorization is checked inside the same protected transaction
 * as lease verification, checkpoint acknowledgement and artifact registration.
 */
export function withExportExecutionAuthorization({generationProtection,source}={}) {
  if(typeof source?.authorizeJob!=="function"||["verify","renew","release"].some(key=>typeof generationProtection?.[key]!=="function"))
    throw new TypeError("Mirror generation protection and current export authorization required");
  async function authorize(input) {
    if(!input.job)return;
    try{await source.authorizeJob({job:input.job,client:input.client});}
    catch(error){
      const mapped={[F.PERMISSION_DENIED]:C.UNAUTHORIZED,[F.CONTRACT_MISMATCH]:C.SCHEMA_DRIFT,[F.MISSING_DEPENDENCY]:C.MISSING_COVERAGE,[F.EXECUTION_UNAVAILABLE]:C.SNAPSHOT_EXPIRED}[error.code];
      if(mapped)throw new ExportContractError(mapped,"Current export execution authorization failed");
      throw error;
    }
  }
  return Object.freeze({
    async verify(input){const receipt=await generationProtection.verify(input);await authorize(input);return receipt;},
    async renew(input){const receipt=await generationProtection.renew(input);await authorize(input);return receipt;},
    release:input=>generationProtection.release(input),
  });
}

export function createExportGenerationProtection({ publicationService, leaseSeconds = 3600 } = {}) {
  for (const key of ["acquireReadLease", "renewReadLease", "releaseReadLease", "verifyReadLease"]) {
    if (typeof publicationService?.[key] !== "function") throw new TypeError(`Mirror publicationService.${key} required`);
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 604800) throw new TypeError("Bounded generation lease duration required");

  async function pinned({client, identity, job, manifest, allowExpired = false}) {
    if (job?.manifest && typeof job.manifest === "object") {
      if (
        (job.manifest.generationId !== undefined && String(job.manifest.generationId) !== String(job.generation_id)) ||
        (job.manifest.coverageRevision !== undefined && String(job.manifest.coverageRevision) !== String(job.coverage_revision)) ||
        (job.manifest.mappingVersion !== undefined && String(job.manifest.mappingVersion) !== String(job.mapping_version))
      ) {
        throw new ExportContractError(C.SCHEMA_DRIFT, "Export job pin drifted from immutable manifest");
      }
    }
    const pin = job ? { generationId: job.generation_id, coverageRevision: job.coverage_revision, mappingVersion: job.mapping_version } : manifest;
    const gen = (await client.query(`SELECT g.*,
        (EXISTS(SELECT 1 FROM mirror.publications p WHERE p.shop_id=g.shop_id AND p.generation_id=g.id
          AND p.coverage_revision=g.coverage_revision AND p.mapping_version=g.mapping_version)) AS is_published_current,
        (g.retain_until > clock_timestamp()) AS is_within_retention,
        (EXISTS(SELECT 1 FROM mirror.generation_read_leases l WHERE l.shop_id=g.shop_id AND l.id=$4
          AND l.generation_id=g.id AND l.coverage_revision=g.coverage_revision AND l.mapping_version=g.mapping_version
          AND l.expires_at > clock_timestamp())) AS has_active_lease
      FROM mirror.generations g
      JOIN mirror.shops s ON s.id=g.shop_id
      WHERE s.id=$1 AND s.installation_version=$2 AND s.uninstalled_at IS NULL
        AND g.id=$3 FOR UPDATE OF g`,
      [identity.shopId, identity.installationId, pin.generationId, job?.generation_lease_id ?? null])).rows[0];
    if (!gen || gen.status !== "PUBLISHED") fail();
    if (String(gen.coverage_revision) !== String(pin.coverageRevision) || String(gen.mapping_version) !== String(pin.mappingVersion)) {
      throw new ExportContractError(C.SCHEMA_DRIFT, "Pinned export generation coverage revision or mapping version drifted");
    }
    const targetManifest = job?.manifest ?? manifest;
    if(targetManifest?.approvedTargetingSnapshot) {
      const imported=(await client.query(`SELECT 1 FROM mirror.catalog_import_jobs WHERE shop_id=$1 AND generation_id=$2
        AND installation_version=$3 AND status='SUCCEEDED' LIMIT 1`,[identity.shopId,pin.generationId,identity.installationId])).rows[0];
      if(!imported)fail();
      const target=targetManifest.approvedTargetingSnapshot;
      const approved=(await client.query(`SELECT s.selection_hash,s.selected_count FROM mirror.selection_snapshots s
        JOIN export_engine.target_approvals a ON a.shop_id=s.shop_id AND a.snapshot_id=s.id
        WHERE s.shop_id=$1 AND s.id=$2 AND s.generation_id=$3 AND s.coverage_revision=$4 AND s.mapping_version=$5
          AND s.operation='export' AND s.operation_id=$6 AND s.status='APPROVED' AND s.expires_at>clock_timestamp()
          AND a.selection_hash=s.selection_hash AND a.datasets @> $7::text[]
          AND a.generation_id=s.generation_id AND a.coverage_revision=s.coverage_revision AND a.mapping_version=s.mapping_version`,
        [identity.shopId,target.snapshotId,pin.generationId,pin.coverageRevision,pin.mappingVersion,targetManifest.operationId,targetManifest.datasets])).rows[0];
      if(!approved||approved.selection_hash!==targetManifest.selectionHash||String(approved.selected_count)!==String(targetManifest.selectedCount))fail();
    }
    if (
      (targetManifest?.mirrorSchemaVersion && gen.mirror_schema_version && String(gen.mirror_schema_version) !== String(targetManifest.mirrorSchemaVersion)) ||
      (targetManifest?.sourceContractVersion && gen.source_contract_version && String(gen.source_contract_version) !== String(targetManifest.sourceContractVersion))
    ) {
      throw new ExportContractError(C.SCHEMA_DRIFT, "Pinned export generation mirror schema or source contract drifted");
    }
    if (!gen.is_published_current && !gen.is_within_retention && !gen.has_active_lease) fail();
    const requiredDatasets = Array.isArray(targetManifest?.datasets) && targetManifest.datasets.length > 0
      ? targetManifest.datasets
      : ["products", "variants"];
    const coverageCount = Number((await client.query(
      `SELECT count(DISTINCT name)::int AS c FROM mirror.coverage
       WHERE shop_id=$1 AND generation_id=$2 AND name=ANY($3::text[]) AND status='COMPLETE'`,
      [identity.shopId, pin.generationId, requiredDatasets],
    )).rows[0]?.c ?? 0);
    if (coverageCount < new Set(requiredDatasets).size) {
      throw new ExportContractError(C.MISSING_COVERAGE, "Required mirror dataset coverage is incomplete for pinned generation");
    }
    if (!job) return null;
    let lease;
    try {
      lease=await publicationService.verifyReadLease({client,shopId:identity.shopId,leaseId:job.generation_lease_id,
        generationId:pin.generationId,coverageRevision:pin.coverageRevision,mappingVersion:pin.mappingVersion,
        operation:"export",owner:job.id,allowExpired});
    } catch(error) {
      if(error.code===F.CONTRACT_MISMATCH)throw new ExportContractError(C.SCHEMA_DRIFT,"Generation lease pin drifted");
      throw error;
    }
    if (!lease || (!allowExpired && lease.active !== true) || job.generation_protection_released_at) fail();
    if (
      String(lease.generation_id) !== String(pin.generationId) ||
      String(lease.coverage_revision) !== String(pin.coverageRevision) ||
      String(lease.mapping_version) !== String(pin.mappingVersion)
    ) {
      throw new ExportContractError(C.SCHEMA_DRIFT, "Generation read lease pin drifted from job");
    }
    return lease;
  }
  const receipt = lease => ({ verified:true, leaseId:lease.id, shopId:lease.shop_id, generationId:lease.generation_id,
    coverageRevision:lease.coverage_revision, mappingVersion:lease.mapping_version, expiresAt:lease.expires_at });

  return Object.freeze({
    async verify(input) {
      if (input.purpose !== "ADMISSION") return receipt(await pinned(input));
      await pinned(input);
      const lease = await publicationService.acquireReadLease({client:input.client, shopId:input.identity.shopId,
        generationId:input.manifest.generationId, operation:"export", owner:input.jobId, leaseSeconds});
      // Re-read the actual lease with every immutable pin, including mapping version.
      return receipt(await pinned({...input, job:{id:input.jobId, generation_id:input.manifest.generationId,
        coverage_revision:input.manifest.coverageRevision, mapping_version:input.manifest.mappingVersion, generation_lease_id:lease.leaseId}}));
    },
    async renew(input) {
      // Expired protection can only be recovered for the SAME still-available pin.
      await pinned({...input, allowExpired:input.purpose === "RECOVERY"});
      await publicationService.renewReadLease({client:input.client, shopId:input.identity.shopId,
        leaseId:input.job.generation_lease_id, leaseSeconds});
      const verified = receipt(await pinned(input));
      await input.client.query(`UPDATE export_engine.jobs SET generation_lease_expires_at=$2,
        generation_lease_renewed_at=clock_timestamp() WHERE id=$1`, [input.job.id, verified.expiresAt]);
      return verified;
    },
    async release({client, identity, job}) {
      // Missing leases are already released. A mismatched lease must never be deleted.
      const lease = (await client.query(`SELECT * FROM mirror.generation_read_leases WHERE shop_id=$1 AND id=$2 FOR UPDATE`,
        [identity.shopId,job.generation_lease_id])).rows[0];
      if (lease && (lease.owner !== job.id || lease.operation !== "export" || lease.generation_id !== job.generation_id ||
        lease.coverage_revision !== job.coverage_revision || lease.mapping_version !== job.mapping_version)) fail();
      if (lease) await publicationService.releaseReadLease({client,shopId:identity.shopId,leaseId:job.generation_lease_id});
      return true;
    },
  });
}
