/**
 * METAMAX — Tenant Authority V4
 *
 * File: web/security/tenant.server.js
 *
 * RESPONSIBILITIES:
 * - Establish trusted Shopify tenant capabilities
 * - Bind authority to active installation lifecycles
 * - Bind workers to exact durable PostgreSQL claims
 * - Enforce canonical operation and transaction modes
 * - Authorize protected transaction callbacks
 *
 * DOES NOT:
 * - Verify Shopify JWTs directly
 * - Own Prisma or PostgreSQL connections
 * - Configure PostgreSQL RLS
 * - Execute Shopify GraphQL mutations
 * - Replace worker execution/dispatch fencing
 *
 * TRUST BOUNDARY:
 * Construct only during trusted server bootstrap.
 * Adapters must use authoritative server-side data.
 */

const SHOP_RE =
  /^[a-z0-9]+(?:-[a-z0-9]+)*\.myshopify\.com$/;

const OPAQUE_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const POSITIVE_ID_RE = /^[1-9][0-9]*$/;

const MAX_BIGINT = 9223372036854775807n;

export class TenantSecurityError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.name = "TenantSecurityError";
    this.code = code;
    this.status = status;
  }
}

function deny(code, status = 403) {
  throw new TenantSecurityError(code, status);
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(
      `TENANT_ADAPTER_REQUIRED:${name}`
    );
  }
  return value;
}

function requireRecord(value, code) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    deny(code);
  }

  const prototype = Object.getPrototypeOf(value);

  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    deny(code);
  }

  return value;
}

function shopId(value) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !SHOP_RE.test(value)
  ) {
    deny("INVALID_SHOP_ID");
  }

  return value;
}

function opaqueId(value, code) {
  if (
    typeof value !== "string" ||
    !OPAQUE_ID_RE.test(value)
  ) {
    deny(code);
  }

  return value;
}

function optionalId(value, code) {
  if (value == null) return null;
  return opaqueId(value, code);
}

function boundedBigint(value, code) {
  let text;

  if (typeof value === "bigint") {
    text = value.toString();
  } else if (
    typeof value === "number" &&
    Number.isSafeInteger(value)
  ) {
    text = String(value);
  } else if (typeof value === "string") {
    text = value;
  } else {
    deny(code);
  }

  if (
    text.length > 19 ||
    !DECIMAL_RE.test(text)
  ) {
    deny(code);
  }

  if (BigInt(text) > MAX_BIGINT) {
    deny(code);
  }

  return text;
}

function canonicalJobId(value) {
  if (
    typeof value !== "string" ||
    value.length > 128
  ) {
    deny("INVALID_JOB_ID");
  }

  if (POSITIVE_ID_RE.test(value)) {
    if (
      value.length > 19 ||
      BigInt(value) > MAX_BIGINT
    ) {
      deny("INVALID_JOB_ID");
    }

    return value;
  }

  if (UUID_RE.test(value)) {
    return value.toLowerCase();
  }

  deny("INVALID_JOB_ID");
}

function claimToken(value) {
  if (
    typeof value !== "string" ||
    !UUID_RE.test(value)
  ) {
    deny("INVALID_CLAIM_TOKEN");
  }

  return value.toLowerCase();
}

/**
 * Authoritative installation record.
 *
 * Installation versions are canonical UUID lifecycle tokens in this repository
 * and must never be reused after reinstall.
 */
function installationRecord(value, expectedShop) {
  const record = requireRecord(
    value,
    "INSTALLATION_RECORD_INVALID"
  );

  if (
    record.active !== true ||
    record.shopId !== expectedShop
  ) {
    deny("INSTALLATION_NOT_ACTIVE");
  }

  return Object.freeze({
    shopId: shopId(record.shopId),

    installationId: opaqueId(
      record.installationId,
      "INVALID_INSTALLATION_ID"
    ),

    installationVersion: installationVersion(
      record.installationVersion,
      "INVALID_INSTALLATION_VERSION"
    )
  });
}

function installationVersion(value, code) {
  if (typeof value !== "string" || !UUID_RE.test(value)) deny(code);
  return value.toLowerCase();
}

function sameInstallation(a, b) {
  return (
    a.shopId === b.shopId &&
    a.installationId === b.installationId &&
    a.installationVersion ===
      b.installationVersion
  );
}

/**
 * Canonical authenticated admin identity.
 *
 * identityKind:
 *
 * SHOP:
 *   Trusted shop-level authentication.
 *   actorId must be absent.
 *
 * USER:
 *   Trusted user-level authentication.
 *   actorId must be present.
 *
 * These classifications are not permissions.
 *
 * The authorization adapter must independently
 * resolve the required permissions using trusted
 * server-side state.
 *
 * Never copy Shopify session objects, API clients,
 * roles, or mutable permission objects into context.
 */
function adminIdentity(value) {
  const record = requireRecord(
    value,
    "ADMIN_AUTHENTICATION_INVALID"
  );

  if (
    record.identityKind !== "SHOP" &&
    record.identityKind !== "USER"
  ) {
    deny("ADMIN_IDENTITY_KIND_REQUIRED");
  }

  const actorId = optionalId(
    record.actorId,
    "INVALID_ADMIN_ACTOR"
  );

  const sessionId = optionalId(
    record.sessionId,
    "INVALID_ADMIN_SESSION"
  );

  if (
    (
      record.identityKind === "USER" &&
      actorId === null
    ) ||
    (
      record.identityKind === "SHOP" &&
      actorId !== null
    )
  ) {
    deny("ADMIN_IDENTITY_KIND_MISMATCH");
  }

  return Object.freeze({
    shopId: shopId(record.shopId),
    identityKind: record.identityKind,
    actorId,
    sessionId
  });
}

/**
 * Immutable durable worker claim.
 *
 * The repository adapter must verify:
 * - Exact namespace and job
 * - Exact claim token
 * - Current lease
 * - Current fencing epoch
 * - Installation identity and version
 * - Eligible durable job state
 */
function verifiedWorker(value) {
  const record = requireRecord(
    value,
    "WORKER_VERIFICATION_INVALID"
  );

  if (record.verified !== true) {
    deny("WORKER_VERIFICATION_FAILED");
  }

  return Object.freeze({
    namespace: opaqueId(
      record.namespace,
      "INVALID_JOB_NAMESPACE"
    ),

    jobKind: opaqueId(
      record.jobKind,
      "INVALID_JOB_KIND"
    ),

    jobId: canonicalJobId(
      record.jobId
    ),

    claimToken: claimToken(
      record.claimToken
    ),

    fenceEpoch: boundedBigint(
      record.fenceEpoch,
      "INVALID_FENCE_EPOCH"
    ),

    shopId: shopId(
      record.shopId
    ),

    installationId: opaqueId(
      record.installationId,
      "INVALID_INSTALLATION_ID"
    ),

    installationVersion: installationVersion(
      record.installationVersion,
      "INVALID_INSTALLATION_VERSION"
    )
  });
}

function sameWorker(a, b) {
  return (
    a.namespace === b.namespace &&
    a.jobKind === b.jobKind &&
    a.jobId === b.jobId &&
    a.claimToken === b.claimToken &&
    a.fenceEpoch === b.fenceEpoch &&
    a.shopId === b.shopId &&
    a.installationId === b.installationId &&
    a.installationVersion ===
      b.installationVersion
  );
}

/**
 * CANONICAL POLICY REGISTRY
 *
 * Required configuration:
 *
 * operations: [
 *   {
 *     operation: "catalog",
 *     mode: "READ"
 *   },
 *   {
 *     operation: "bulk_edit",
 *     mode: "WRITE"
 *   }
 * ]
 *
 * workerPolicies: [
 *   {
 *     namespace: "mirror.job_commands",
 *     jobKind: "bulk_edit",
 *     operation: "bulk_edit"
 *   }
 * ]
 *
 * Use existing project-defined canonical names.
 *
 * Legacy string-only operations are rejected.
 *
 * The mode is an authorization requirement,
 * not merely a caller-provided preference.
 */
function createPolicyRegistry({
  operations,
  workerPolicies
}) {
  if (
    !Array.isArray(operations) ||
    operations.length === 0 ||
    !Array.isArray(workerPolicies)
  ) {
    throw new TypeError(
      "TENANT_POLICY_CONFIGURATION_INVALID"
    );
  }

  // Operation -> required transaction mode.
  const allowed = new Map();

  // Namespace -> Map(jobKind -> operation).
  // Nested maps avoid delimiter collisions.
  const workers = new Map();

  for (const entry of operations) {
    const record = requireRecord(
      entry,
      "INVALID_OPERATION_POLICY"
    );

    const operation = opaqueId(
      record.operation,
      "INVALID_OPERATION"
    );

    if (
      record.mode !== "READ" &&
      record.mode !== "WRITE"
    ) {
      deny("INVALID_OPERATION_MODE");
    }

    if (allowed.has(operation)) {
      throw new TypeError(
        "DUPLICATE_TENANT_OPERATION"
      );
    }

    allowed.set(operation, record.mode);
  }

  for (const entry of workerPolicies) {
    const policy = requireRecord(
      entry,
      "INVALID_WORKER_POLICY"
    );

    const namespace = opaqueId(
      policy.namespace,
      "INVALID_JOB_NAMESPACE"
    );

    const kind = opaqueId(
      policy.jobKind,
      "INVALID_JOB_KIND"
    );

    const operation = opaqueId(
      policy.operation,
      "INVALID_OPERATION"
    );

    if (!allowed.has(operation)) {
      throw new TypeError(
        "UNKNOWN_WORKER_OPERATION"
      );
    }

    let byKind = workers.get(namespace);

    if (!byKind) {
      byKind = new Map();
      workers.set(namespace, byKind);
    }

    if (byKind.has(kind)) {
      throw new TypeError(
        "DUPLICATE_WORKER_POLICY"
      );
    }

    byKind.set(kind, operation);
  }

  return Object.freeze({
    hasOperation(value) {
      return allowed.has(value);
    },

    operationMode(value) {
      return allowed.get(value);
    },

    workerOperation(namespace, kind) {
      return workers.get(namespace)?.get(kind);
    }
  });
}

/**
 * REQUIRED TRUSTED ADAPTERS
 *
 * authenticateAdmin(request)
 *   Returns:
 *   {
 *     shopId,
 *     identityKind: "SHOP" | "USER",
 *     actorId?,
 *     sessionId?
 *   }
 *
 * getActiveInstallation(shopId)
 *   Returns active installation with version.
 *
 * verifyWorkerClaim({
 *   namespace,
 *   jobId,
 *   claimToken,
 *   fenceEpoch
 * })
 *
 * getInstallationInTransaction(tx, shopId, mode)
 *
 * verifyWorkerInTransaction(tx, exactClaim)
 *
 * authorizeAdminInTransaction(
 *   tx,
 *   scalarIdentity,
 *   operation,
 *   tenant
 * )
 *
 * All transaction adapters must use the supplied
 * active transaction and fail on infrastructure errors.
 */
export function createTenantAuthority({
  authenticateAdmin,
  getActiveInstallation,
  verifyWorkerClaim,
  getInstallationInTransaction,
  verifyWorkerInTransaction,
  authorizeAdminInTransaction,
  operations,
  workerPolicies
}) {
  requireFunction(
    authenticateAdmin,
    "authenticateAdmin"
  );

  requireFunction(
    getActiveInstallation,
    "getActiveInstallation"
  );

  requireFunction(
    verifyWorkerClaim,
    "verifyWorkerClaim"
  );

  requireFunction(
    getInstallationInTransaction,
    "getInstallationInTransaction"
  );

  requireFunction(
    verifyWorkerInTransaction,
    "verifyWorkerInTransaction"
  );

  requireFunction(
    authorizeAdminInTransaction,
    "authorizeAdminInTransaction"
  );

  const policies = createPolicyRegistry({
    operations,
    workerPolicies
  });

  /**
   * Private instance-local capability registry.
   *
   * Callers cannot manufacture an authorized
   * context by matching public properties.
   */
  const capabilities = new WeakMap();

  function issue(data) {
    const context = Object.freeze(
      Object.create(null)
    );

    capabilities.set(
      context,
      Object.freeze(data)
    );

    return context;
  }

  function requireContext(context) {
    if (
      context === null ||
      typeof context !== "object"
    ) {
      deny("TENANT_CONTEXT_REQUIRED", 401);
    }

    const value = capabilities.get(context);

    if (!value) {
      deny("UNTRUSTED_TENANT_CONTEXT");
    }

    return value;
  }

  function requireOperation(operation) {
    if (
      typeof operation !== "string" ||
      !policies.hasOperation(operation)
    ) {
      deny("UNSUPPORTED_OPERATION");
    }

    return operation;
  }

  async function readActiveInstallation(shop) {
    return installationRecord(
      await getActiveInstallation(shop),
      shop
    );
  }

  /**
   * Establish trusted Shopify admin authority.
   *
   * authenticateAdmin must verify the Shopify
   * session or ID token before returning identity.
   */
  async function fromAdminRequest(request) {
    const authenticated = await authenticateAdmin(request);
    const identity = adminIdentity(authenticated);

    const installation =
      await readActiveInstallation(
        identity.shopId
      );

    // Identity adapters that pin request lifecycle coordinates must agree with
    // the independently loaded installation; never rebind a request on reinstall.
    if ((authenticated.installationId !== undefined || authenticated.installationVersion !== undefined) &&
        (authenticated.installationId !== installation.installationId || authenticated.installationVersion !== installation.installationVersion))
      deny('INSTALLATION_REVOKED');

    return issue({
      principal: "ADMIN",
      identity,
      installation
    });
  }

  /**
   * Establish worker authority using durable
   * claim verification.
   *
   * Candidate claim input is NOT authority.
   * A BullMQ job payload alone is insufficient.
   */
  async function fromWorkerClaim(input) {
    const candidate = requireRecord(
      input,
      "WORKER_CLAIM_REQUIRED"
    );

    const lookup = Object.freeze({
      namespace: opaqueId(
        candidate.namespace,
        "INVALID_JOB_NAMESPACE"
      ),

      jobId: canonicalJobId(
        candidate.jobId
      ),

      claimToken: claimToken(
        candidate.claimToken
      ),

      fenceEpoch: boundedBigint(
        candidate.fenceEpoch,
        "INVALID_FENCE_EPOCH"
      )
    });

    const worker = verifiedWorker(
      await verifyWorkerClaim(lookup)
    );

    if (
      worker.namespace !== lookup.namespace ||
      worker.jobId !== lookup.jobId ||
      worker.claimToken !== lookup.claimToken ||
      worker.fenceEpoch !== lookup.fenceEpoch
    ) {
      deny("WORKER_CLAIM_MISMATCH");
    }

    const operation =
      policies.workerOperation(
        worker.namespace,
        worker.jobKind
      );

    if (!operation) {
      deny("WORKER_KIND_UNAUTHORIZED");
    }

    const installation =
      await readActiveInstallation(
        worker.shopId
      );

    if (
      !sameInstallation(
        installation,
        worker
      )
    ) {
      deny("STALE_WORKER_INSTALLATION");
    }

    return issue({
      principal: "WORKER",
      worker,
      installation,
      operation
    });
  }

  /**
   * Informational metadata only.
   *
   * Never expose worker claim tokens,
   * fencing details or private identity data.
   */
  function describe(context) {
    const authority = requireContext(context);

    return Object.freeze({
      principal: authority.principal,
      shopId: authority.installation.shopId,
      installationId:
        authority.installation.installationId,
      installationVersion:
        authority.installation.installationVersion
    });
  }

  function assertShop(context, expectedShop) {
    const authority = requireContext(context);

    if (
      authority.installation.shopId !==
      shopId(expectedShop)
    ) {
      deny("CROSS_TENANT_ACCESS");
    }

    return true;
  }

  /**
   * Compare the complete installation lifecycle.
   *
   * BOTH ID and version are mandatory.
   *
   * This is a local identity assertion.
   * It does not replace transaction-time checks.
   */
  function assertInstallation(
    context,
    expectedInstallationId,
    expectedInstallationVersion
  ) {
    const authority = requireContext(context);

    const id = opaqueId(
      expectedInstallationId,
      "INVALID_INSTALLATION_ID"
    );

    const version = installationVersion(
      expectedInstallationVersion,
      "INVALID_INSTALLATION_VERSION"
    );

    if (
      authority.installation.installationId !== id ||
      authority.installation.installationVersion !==
        version
    ) {
      deny("INSTALLATION_MISMATCH");
    }

    return true;
  }

  /**
   * Transaction-scoped authorization.
   *
   * Only the trusted DB gateway should invoke
   * this method.
   *
   * The gateway owns:
   * - Active PostgreSQL transaction
   * - Transaction isolation and lifecycle
   * - Tenant RLS session context
   * - Restricted DB connection
   * - Commit and rollback behavior
   *
   * No reusable authorization receipt is issued.
   */
  async function runAuthorized({
    context,
    tx,
    operation,
    mode,
    execute
  }) {
    const authority = requireContext(context);

    const requested =
      requireOperation(operation);

    if (
      !tx ||
      typeof tx !== "object"
    ) {
      deny("TRANSACTION_REQUIRED");
    }

    if (
      mode !== "READ" &&
      mode !== "WRITE"
    ) {
      deny("INVALID_TRANSACTION_MODE");
    }

    /**
     * Require exact mode compatibility.
     *
     * A WRITE operation cannot claim READ.
     * READ operations must use READ.
     */
    if (
      policies.operationMode(requested) !== mode
    ) {
      deny("OPERATION_TRANSACTION_MODE_MISMATCH");
    }

    requireFunction(
      execute,
      "execute"
    );

    /**
     * 1. Revalidate installation inside
     * the active transaction.
     */
    const currentInstallation =
      installationRecord(
        await getInstallationInTransaction(
          tx,
          authority.installation.shopId,
          mode
        ),
        authority.installation.shopId
      );

    if (
      !sameInstallation(
        currentInstallation,
        authority.installation
      )
    ) {
      deny("INSTALLATION_REVOKED");
    }

    /**
     * 2. Verify principal-specific authority.
     */
    if (authority.principal === "WORKER") {
      if (
        authority.operation !== requested
      ) {
        deny("WORKER_OPERATION_DENIED");
      }

      const current = verifiedWorker(
        await verifyWorkerInTransaction(
          tx,
          authority.worker
        )
      );

      if (
        !sameWorker(
          current,
          authority.worker
        )
      ) {
        deny("WORKER_CLAIM_REVOKED");
      }
    } else if (
      authority.principal === "ADMIN"
    ) {
      const decision =
        await authorizeAdminInTransaction(
          tx,
          authority.identity,
          requested,
          Object.freeze({
            shopId:
              authority.installation.shopId,
            installationId:
              authority.installation.installationId,
            installationVersion:
              authority.installation.installationVersion
          })
        );



      if (
        !decision ||
        decision.authorized !== true
      ) {
        deny("ADMIN_OPERATION_DENIED");
      }
    } else {
      deny("UNKNOWN_PRINCIPAL");
    }

    /**
     * 3. Execute protected work.
     *
     * No transferable receipt is returned.
     *
     * For workers, repositories must ALSO
     * enforce fencing at each critical state
     * transition. External Shopify mutations
     * require the execution dispatch protocol.
     */
    return await execute(tx);
  }

  // Admission only, never a reusable authorization receipt. The gateway calls
  // this before acquiring a connection; runAuthorized still rechecks live state.
  function assertOperation(context, operation, mode) {
    const value = requireContext(context);
    requireOperation(operation);
    if (policies.operationMode(operation) !== mode) deny('OPERATION_TRANSACTION_MODE_MISMATCH');
    if (value.principal === 'WORKER' && value.operation !== operation) deny('WORKER_OPERATION_DENIED');
  }

  /**
   * Express middleware.
   *
   * Never accept tenant identity from
   * request body, query parameters or headers
   * unless verified by authenticateAdmin.
   */
  function adminMiddleware() {
    return async function tenantMiddleware(
      req,
      res,
      next
    ) {
      try {
        if (
          Object.prototype.hasOwnProperty.call(
            req,
            "tenant"
          )
        ) {
          deny(
            "TENANT_MIDDLEWARE_CONFLICT",
            500
          );
        }

        const context =
          await fromAdminRequest(req);

        Object.defineProperty(
          req,
          "tenant",
          {
            value: context,
            writable: false,
            configurable: false,
            enumerable: false
          }
        );

        next();
      } catch (error) {
        next(error);
      }
    };
  }

  return Object.freeze({
    fromAdminRequest,
    fromWorkerClaim,
    describe,
    assertShop,
    assertInstallation,
    runAuthorized,
    assertOperation,
    adminMiddleware
  });
}
