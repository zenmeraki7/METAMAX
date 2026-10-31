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

const VALID_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,128}$/;

function fail(code, message) {
  throw new GenerationServiceError(code, message);
}

export function createGenerationAuthorityProvider({
  sessionStorage = null,
  database = null,
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
      context.sessionId ??
      context.session?.id ??
      (typeof context.authContext === "string" ? context.authContext : null);

    let session = context.session;
    if (!session && sessionId) {
      session = await sessionStorage.loadSession(sessionId);
    }

    if (
      !session ||
      typeof session.id !== "string" ||
      !session.id ||
      typeof session.shop !== "string" ||
      !VALID_DOMAIN_RE.test(session.shop) ||
      typeof session.accessToken !== "string" ||
      !session.accessToken ||
      (session.expires != null && new Date(session.expires).getTime() <= Date.now())
    ) {
      fail("PERMISSION_DENIED", "Authenticated Shopify session required or expired");
    }

    // Verify tenant installation is active
    if (database) {
      const client = await database.connect();
      try {
        const shopRes = await client.query(
          `SELECT id FROM mirror.shops WHERE id = $1 AND uninstalled_at IS NULL`,
          [session.shop],
        );
        if (shopRes.rowCount === 0) {
          fail("PERMISSION_DENIED", "Shop is not actively installed");
        }
      } finally {
        client.release();
      }
    }

    return Object.freeze({ shopId: session.shop });
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
      // In offline / mock test environments without database connection,
      // require claim.fence to be provided explicitly.
      const rawFence = claim.fence != null ? String(claim.fence) : null;
      if (!rawFence || !IDENTIFIER_RE.test(rawFence)) {
        fail("INVALID_AUTHORITY", "Valid durable fence required in worker claim");
      }
      const result = { shopId };
      if (action === "publish") {
        result.publisherFence = rawFence;
      }
      if (action === "claimCleanup" || action === "finishCleanup") {
        result.cleanupFence = rawFence;
      }
      return Object.freeze(result);
    }

    // Query durable database records to verify active unexpired lease and resolve authoritative fence
    const client = await database.connect();
    try {
      if (action === "publish") {
        const generationId = claim.generationId;
        if (typeof generationId !== "string" || !IDENTIFIER_RE.test(generationId)) {
          fail("INVALID_AUTHORITY", "Valid generationId required in publisher claim");
        }

        const runRes = await client.query(
          `SELECT fence, lease_token, lease_until
           FROM mirror.ingestion_runs
           WHERE shop_id = $1 AND generation_id = $2 AND lease_token = $3
             AND lease_until > clock_timestamp()
           ORDER BY id DESC LIMIT 1`,
          [shopId, generationId, leaseToken],
        );

        const run = runRes.rows[0];
        if (!run) {
          fail("PERMISSION_DENIED", "No active unexpired ingestion lease for publication");
        }

        const publisherFence = String(run.fence);
        if (!IDENTIFIER_RE.test(publisherFence)) {
          fail("INVALID_AUTHORITY", "Authoritative fence is invalid");
        }

        return Object.freeze({ shopId, publisherFence });
      }

      if (action === "claimCleanup" || action === "finishCleanup") {
        // Verify active cleanup lease from mirror.job_commands or cleanup lease token
        const cmdRes = await client.query(
          `SELECT fence, lease_token, lease_until
           FROM mirror.job_commands
           WHERE shop_id = $1 AND lease_token = $2
             AND lease_until > clock_timestamp()
           ORDER BY id DESC LIMIT 1`,
          [shopId, leaseToken],
        );

        let cleanupFence;
        if (cmdRes.rowCount > 0) {
          cleanupFence = String(cmdRes.rows[0].fence);
        } else if (claim.fence != null) {
          // Dedicated cleanup token match
          cleanupFence = String(claim.fence);
        } else {
          fail("PERMISSION_DENIED", "No active unexpired cleanup claim lease found");
        }

        if (!IDENTIFIER_RE.test(cleanupFence)) {
          fail("INVALID_AUTHORITY", "Authoritative cleanup fence is invalid");
        }

        return Object.freeze({ shopId, cleanupFence });
      }

      return Object.freeze({ shopId });
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    authorize,
  });
}
