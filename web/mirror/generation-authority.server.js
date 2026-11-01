/**
 * METAMAX — Generation Lifecycle Authority Provider
 *
 * Implements authorityProvider.authorize({ action, context })
 *
 * Validates actual Shopify authentication for merchant actions
 * and durable PostgreSQL worker-claim records with fences for worker actions.
 *
 * Never trusts context merely because it exists.
 */

import { GenerationServiceError } from "./generation-service.server.js";
import {isValidShopifySession} from '../middleware/session-validation.js';
import {createDatabaseInstallationResolver,assertInstallationTenant} from '../security/installation-lifecycle.server.js';

const VALID_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,128}$/;

function fail(code, message) {
  throw new GenerationServiceError(code, message);
}

export function createGenerationAuthorityProvider({
  sessionStorage = null,
  database = null,
  resolveInstallation=database?createDatabaseInstallationResolver({database}):null,
} = {}) {
  if (database && typeof database.connect !== "function") {
    throw new TypeError("Database pool must have connect() method");
  }

  async function authorize({ action, context } = {}) {
    if (!context || typeof context !== "object") {
      fail("INVALID_AUTHORITY", "Authoritative context required");
    }

    // 1. Interactive Merchant Session Actions: "verify", "retain", "release"
    if (action === "verify" || action === "retain" || action === "release") {
      if (context.sessionId || context.authContext || context.session) {
        return authorizeSession(context);
      }
      if (context.workerClaim || context.claim) {
        return authorizeWorkerClaim(action, context.workerClaim || context.claim);
      }
      fail("PERMISSION_DENIED", "Authenticated session or durable worker claim required");
    }

    // 2. Durable Worker Actions: "publish", "claimCleanup", "finishCleanup"
    if (action === "publish" || action === "claimCleanup" || action === "finishCleanup") {
      const claim = context.workerClaim || context.claim;
      if (!claim || typeof claim !== "object") {
        fail("PERMISSION_DENIED", `Durable worker claim required for action: ${action}`);
      }
      return authorizeWorkerClaim(action, claim);
    }

    fail("INVALID_AUTHORITY", `Unsupported generation action: ${action}`);
  }

  async function authorizeSession(context) {
    if (!sessionStorage || typeof sessionStorage.loadSession !== "function") {
      fail("INVALID_AUTHORITY", "Session storage required for session authentication");
    }

    const sessionId =
      (typeof context.sessionId === "string" && context.sessionId) ||
      (typeof context.session?.id === "string" && context.session.id) ||
      (typeof context.authContext === "string" && context.authContext) ||
      null;

    if (!sessionId) {
      fail("PERMISSION_DENIED", "Valid server-issued session ID required");
    }

    // Load server-issued session authority; never trust a caller-supplied session object
    const session = await sessionStorage.loadSession(sessionId);

    if (
      !isValidShopifySession(session) || session.id !== sessionId
    ) {
      fail("PERMISSION_DENIED", "Authenticated Shopify session required or expired");
    }

    // If caller also provided a session object, it must match the server-issued session authority
    if (context.session) {
      if (
        typeof context.session !== "object" ||
        context.session.shop !== session.shop ||
        context.session.id !== session.id ||
        (context.session.accessToken && context.session.accessToken !== session.accessToken)
      ) {
        fail("PERMISSION_DENIED", "Supplied session does not match server-issued session authority");
      }
    }

    if(typeof resolveInstallation!=='function')fail('PERMISSION_DENIED','Exact active installation required');
    let tenant;try{tenant=assertInstallationTenant(await resolveInstallation(session.shop));}catch{fail('PERMISSION_DENIED','Exact active installation required');}
    if(tenant.shopId!==session.shop||context.installationVersion!==undefined&&context.installationVersion!==tenant.installationVersion)
      fail('PERMISSION_DENIED','Generation installation differs from authenticated lifecycle');
    return tenant;
  }

  async function authorizeWorkerClaim(action, claim) {
    const shopId = claim.shopId;
    if (
      typeof shopId !== "string" ||
      !VALID_DOMAIN_RE.test(shopId)
    ) {
      fail("INVALID_AUTHORITY", "Valid shop domain required in worker claim");
    }

    const workerId = claim.workerId;
    const leaseToken = claim.leaseToken;
    if (
      typeof workerId !== "string" ||
      !IDENTIFIER_RE.test(workerId) ||
      typeof leaseToken !== "string" ||
      !IDENTIFIER_RE.test(leaseToken)
    ) {
      fail("INVALID_AUTHORITY", "Valid workerId and leaseToken required in claim");
    }

    if (!database) {
      fail("PERMISSION_DENIED", "Durable worker claim storage required; use an isolated authority adapter for offline tests");
    }
    if(typeof resolveInstallation!=='function')fail('PERMISSION_DENIED','Exact worker installation required');
    let tenant;try{tenant=assertInstallationTenant(await resolveInstallation(shopId));}catch(error){if(error.code!=='INSTALLATION_NOT_ACTIVE')throw error;fail('PERMISSION_DENIED','Exact worker installation required');}
    if(claim.installationVersion!==tenant.installationVersion)fail('PERMISSION_DENIED','Worker installation lifecycle changed');

    // Query durable database records to verify active unexpired lease and resolve authoritative fence
    const client = await database.connect();
    try {
      if (["publish", "verify", "retain", "release"].includes(action)) {
        const generationId = claim.generationId;
        if (typeof generationId !== "string" || !IDENTIFIER_RE.test(generationId)) {
          fail("INVALID_AUTHORITY", "Valid generationId required in ingestion worker claim");
        }

        const runRes = await client.query(
          `SELECT r.fence,r.lease_token,r.lease_until FROM mirror.ingestion_runs r
           JOIN mirror.catalog_import_jobs j ON j.shop_id=r.shop_id AND j.run_id=r.id AND j.generation_id=r.generation_id AND j.installation_version=$4
           JOIN mirror.shops s ON s.id=j.shop_id AND s.installation_version=j.installation_version AND s.uninstalled_at IS NULL
           WHERE r.shop_id=$1 AND r.generation_id=$2 AND r.lease_token=$3 AND r.lease_until>clock_timestamp()
           ORDER BY r.id DESC LIMIT 1`,
          [shopId, generationId, leaseToken,tenant.installationVersion],
        );

        const run = runRes.rows[0];
        if (!run) {
          fail("PERMISSION_DENIED", "No active unexpired ingestion worker lease");
        }

        const publisherFence = String(run.fence);
        if (!IDENTIFIER_RE.test(publisherFence)) {
          fail("INVALID_AUTHORITY", "Authoritative fence is invalid");
        }

        return Object.freeze({tenant,...tenant,...(action==='publish'?{publisherFence}:{})});
      }

      if (action === "claimCleanup" || action === "finishCleanup") {
        // A caller-supplied fence never substitutes for a durable cleanup lease.
        const cmdRes = await client.query(
          `SELECT c.fence,c.lease_token,c.lease_until FROM mirror.job_commands c
           JOIN mirror.shops s ON s.id=c.shop_id AND s.installation_version=c.installation_version AND s.uninstalled_at IS NULL
           WHERE c.shop_id=$1 AND c.lease_token=$2 AND c.installation_version=$3 AND c.kind='generation_cleanup'
             AND c.status='RUNNING' AND c.cancel_requested_at IS NULL AND c.lease_until>clock_timestamp()
           ORDER BY c.id DESC LIMIT 1`,
          [shopId, leaseToken,tenant.installationVersion],
        );

        let cleanupFence;
        if (cmdRes.rowCount > 0) {
          cleanupFence = String(cmdRes.rows[0].fence);
        } else {
          fail("PERMISSION_DENIED", "No active unexpired cleanup claim lease found");
        }

        if (!IDENTIFIER_RE.test(cleanupFence)) {
          fail("INVALID_AUTHORITY", "Authoritative cleanup fence is invalid");
        }

        return Object.freeze({tenant,...tenant,cleanupFence});
      }

      fail("PERMISSION_DENIED", "Unsupported worker authority action");
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    authorize,
  });
}
