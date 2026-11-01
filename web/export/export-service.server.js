/**
 * METAMAX Export Engine — Request Preparation & Atomic Idempotent Creation Service.
 *
 * Bridges the pure Export Contract (v2) with METAMAX's trusted
 * Field Engine (`requireFields`) and Filter Engine (`validateFilter`),
 * and computes both the structural `requestFingerprint` and the
 * execution `manifestFingerprint`.
 */

import { createHash } from "node:crypto";
import {
  normalizeExportRequest,
  normalizeIdempotencyKey,
  exportRequestFingerprint,
  canonicalizeJson,
  EXPORT_CONTRACT_VERSION,
  EXPORT_MANIFEST_VERSION,
  EXPORT_ERROR_CODES,
  EXPORT_LIMITS,
  EXPORT_STATES,
  ExportContractError,
} from "./export-contract.js";
import {
  FieldError,
  FIELD_ERROR_CODES,
  isSupportedFieldId,
} from "../fields/types.js";
import { FILTER_VALIDATION_VERSION } from "../filters/contracts.js";
import {
  FILTER_AST_VERSION,
  FILTER_AST_LIMITS,
  FILTER_AST_ERROR_CODES,
  FilterAstError,
  parseFilterAst,
  inspectFilterAst,
} from "../filters/ast.js";
import { FILTER_EXECUTION_LIMITS } from "../filters/validate.js";

/**
 * Private provenance for execution manifests constructed only after
 * both Field Engine and Filter Engine validation succeed.
 * Never export a brand issuer.
 */
const ISSUED_PREPARED_EXPORTS = new WeakSet();
const ISSUED_EXPORT_MANIFESTS = new WeakSet();

const IDENTITY_FILTER_AST = Object.freeze({
  version: FILTER_AST_VERSION,
  root: Object.freeze({
    kind: "condition",
    field: "product.id",
    operator: "is_not_null",
  }),
});

/**
 * Effective filter budgets are the stricter of the Export Contract's
 * structural limits and the Filter Engine's own AST & execution limits.
 */
export const EFFECTIVE_EXPORT_FILTER_LIMITS = Object.freeze({
  MAX_NODES: Math.min(
    EXPORT_LIMITS.MAX_FILTER_NODES,
    FILTER_AST_LIMITS.MAX_NODES,
  ),
  MAX_DEPTH: Math.min(
    EXPORT_LIMITS.MAX_FILTER_DEPTH,
    FILTER_AST_LIMITS.MAX_DEPTH,
    FILTER_EXECUTION_LIMITS.MAX_DEPTH,
  ),
  MAX_BYTES: Math.min(
    EXPORT_LIMITS.MAX_FILTER_BYTES,
    FILTER_AST_LIMITS.MAX_BYTES,
  ),
  MAX_CONDITIONS: FILTER_EXECUTION_LIMITS.MAX_CONDITIONS,
  MAX_OR_BRANCHES: FILTER_EXECUTION_LIMITS.MAX_OR_BRANCHES,
  MAX_FIELD_BYTES: Math.min(
    EXPORT_LIMITS.MAX_FIELD_ID_BYTES,
    FILTER_AST_LIMITS.MAX_FIELD_BYTES,
  ),
});

function mapEngineError(error) {
  if (error instanceof ExportContractError) {
    return error;
  }

  if (error instanceof FilterAstError) {
    const code =
      error.code === FILTER_AST_ERROR_CODES.LIMIT_EXCEEDED
        ? EXPORT_ERROR_CODES.TOO_LARGE
        : EXPORT_ERROR_CODES.INVALID_REQUEST;
    return new ExportContractError(
      code,
      error.message || "Invalid export filter AST",
    );
  }

  if (error instanceof FieldError) {
    switch (error.code) {
      case FIELD_ERROR_CODES.PERMISSION_DENIED:
        return new ExportContractError(
          EXPORT_ERROR_CODES.UNAUTHORIZED,
          error.message || "Export field or filter access denied",
        );
      case FIELD_ERROR_CODES.MISSING_DEPENDENCY:
        return new ExportContractError(
          EXPORT_ERROR_CODES.MISSING_COVERAGE,
          error.message || "Required published mirror coverage unavailable",
        );
      case FIELD_ERROR_CODES.CONTRACT_MISMATCH:
        return new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          error.message || "Export contract or schema version mismatch",
        );
      case FIELD_ERROR_CODES.EXECUTION_UNAVAILABLE:
        return new ExportContractError(
          EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
          error.message || "Pinned export snapshot is no longer available",
        );
      default:
        return new ExportContractError(
          EXPORT_ERROR_CODES.INVALID_REQUEST,
          error.message || "Invalid export field or filter specification",
        );
    }
  }

  return error;
}

/**
 * Enforces the Filter Engine's authoritative AST grammar and execution budgets
 * (which are stricter than generic JSON structural limits in export-contract.js).
 */
function parseAndEnforceFilterEngineBudgets(rawFilter) {
  if (rawFilter === null || rawFilter === undefined) {
    return null;
  }

  // Support canonical { version, root } ASTs as well as single-condition shorthand
  // objects while always enforcing parseFilterAst's strict node/operand limits.
  const candidate =
    typeof rawFilter === "object" &&
    !Object.hasOwn(rawFilter, "version") &&
    !Object.hasOwn(rawFilter, "root") &&
    Object.hasOwn(rawFilter, "field") &&
    Object.hasOwn(rawFilter, "operator")
      ? {
          version: FILTER_AST_VERSION,
          root: {
            kind: "condition",
            ...rawFilter,
          },
        }
      : rawFilter;

  const ast = parseFilterAst(candidate);
  const info = inspectFilterAst(ast);

  if (
    info.nodes > EFFECTIVE_EXPORT_FILTER_LIMITS.MAX_NODES ||
    info.maxDepth > EFFECTIVE_EXPORT_FILTER_LIMITS.MAX_DEPTH ||
    info.byteSize > EFFECTIVE_EXPORT_FILTER_LIMITS.MAX_BYTES ||
    info.conditions > EFFECTIVE_EXPORT_FILTER_LIMITS.MAX_CONDITIONS
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.INVALID_REQUEST,
      "Filter exceeds authoritative Filter Engine AST complexity or depth budget",
    );
  }

  let orBranches = 0;
  const stack = [ast.root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.kind !== "group") continue;
    if (node.operator === "OR") {
      orBranches += node.children.length;
      if (orBranches > EFFECTIVE_EXPORT_FILTER_LIMITS.MAX_OR_BRANCHES) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.INVALID_REQUEST,
          "Filter OR fan-out exceeds authoritative Filter Engine budget",
        );
      }
    }
    stack.push(...node.children);
  }

  return ast;
}

function enforceAuthoritativeFieldIdBudgets(fieldIds) {
  for (const fieldId of fieldIds) {
    if (
      Buffer.byteLength(fieldId, "utf8") >
        EFFECTIVE_EXPORT_FILTER_LIMITS.MAX_FIELD_BYTES ||
      !isSupportedFieldId(fieldId)
    ) {
      throw new ExportContractError(
        EXPORT_ERROR_CODES.INVALID_REQUEST,
        `Invalid or oversized export field identifier: ${fieldId}`,
      );
    }
  }
}

function summarizeAuthorizedFields(authorizedFields, requestedFieldIds) {
  if (!authorizedFields || typeof authorizedFields !== "object") {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.UNAUTHORIZED,
      "Trusted field authorization resolution required",
    );
  }

  const rawFields = Array.isArray(authorizedFields.fields)
    ? authorizedFields.fields
    : Array.isArray(authorizedFields)
      ? authorizedFields
      : null;

  if (!rawFields || rawFields.length !== requestedFieldIds.length) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.UNAUTHORIZED,
      "Authorized field resolution does not match requested fields",
    );
  }

  return Object.freeze(
    rawFields.map((field, index) => {
      const id = field?.id ?? field?.field?.id;
      if (id !== requestedFieldIds[index]) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Authorized field ordering or identity mismatch",
        );
      }

      return Object.freeze({
        id,
        origin: field?.origin ?? field?.field?.origin ?? "canonical",
        type: field?.type ?? field?.field?.type ?? null,
        entity: field?.entity ?? field?.field?.entity ?? null,
        definitionRevision:
          field?.source?.definitionRevision ??
          field?.definitionRevision ??
          null,
      });
    }),
  );
}

function hashCanonicalJson(value) {
  const canonical = canonicalizeJson(value, {
    maxDepth: 32,
    maxNodes: 10_000,
    maxBytes: EXPORT_LIMITS.MAX_REQUEST_BYTES,
  });
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")}`;
}

export function resolveRequiredDatasets({
  authorizedFields,
  validatedFilter,
  fieldDescriptors,
} = {}) {
  const datasets = new Set(["products"]);

  if (Array.isArray(fieldDescriptors)) {
    for (const f of fieldDescriptors) {
      if (
        f.entity === "variant" ||
        (typeof f.id === "string" && f.id.startsWith("variant."))
      ) {
        datasets.add("variants");
      }
    }
  }

  const rawFields = authorizedFields?.fields ?? authorizedFields;
  if (Array.isArray(rawFields)) {
    for (const f of rawFields) {
      const entity = f?.entity ?? f?.field?.entity;
      const id = f?.id ?? f?.field?.id;
      const table = f?.source?.table ?? f?.field?.source?.table;
      if (
        entity === "variant" ||
        (typeof id === "string" && id.startsWith("variant.")) ||
        table === "variants"
      ) {
        datasets.add("variants");
      }
    }
  }

  for (const source of [
    authorizedFields?.datasets,
    authorizedFields?.requiredDatasets,
    validatedFilter?.datasets,
    validatedFilter?.requiredDatasets,
  ]) {
    if (Array.isArray(source)) {
      for (const d of source) {
        if (typeof d === "string" && d.trim().length > 0) {
          datasets.add(d.trim());
        }
      }
    }
  }

  return Object.freeze([...datasets].sort());
}

/**
 * Private builder for the trusted execution manifest.
 * Must ONLY be called after both the Field Engine and Filter Engine have
 * validated and authorized the request.
 */
function buildTrustedExecutionManifest({
  request,
  requestFingerprint,
  shopId,
  installationId,
  authorizedFields,
  validatedFilter,
  executionContext,
}) {
  if (!authorizedFields || typeof authorizedFields !== "object") {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.UNAUTHORIZED,
      "Field Engine authorization is required before constructing an execution manifest",
    );
  }

  if (
    !validatedFilter ||
    typeof validatedFilter !== "object" ||
    typeof validatedFilter.fingerprint !== "string" ||
    validatedFilter.fingerprint.trim() === ""
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.UNAUTHORIZED,
      "Filter Engine validation is required before constructing an execution manifest",
    );
  }

  const fieldDescriptors = summarizeAuthorizedFields(
    authorizedFields,
    request.fieldIds,
  );

  const generationId =
    authorizedFields?.generationId ??
    validatedFilter?.generationId ??
    executionContext?.generationId ??
    null;

  const coverageRevision =
    authorizedFields?.coverageRevision ??
    validatedFilter?.coverageRevision ??
    executionContext?.coverageRevision ??
    null;

  if (!generationId || !coverageRevision) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.MISSING_COVERAGE,
      "Export manifest requires a pinned generationId and coverageRevision",
    );
  }

  if (
    validatedFilter?.generationId &&
    authorizedFields?.generationId &&
    validatedFilter.generationId !== authorizedFields.generationId
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Field and filter validations resolved against different generations",
    );
  }

  if (
    validatedFilter?.coverageRevision &&
    authorizedFields?.coverageRevision &&
    validatedFilter.coverageRevision !== authorizedFields.coverageRevision
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Field and filter validations resolved against different coverage revisions",
    );
  }

  if (
    executionContext?.generationId &&
    executionContext.generationId !== generationId
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Validated export generation drifted from pinned execution context",
    );
  }

  if (
    executionContext?.coverageRevision &&
    executionContext.coverageRevision !== coverageRevision
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Validated export coverage revision drifted from pinned execution context",
    );
  }

  if (
    authorizedFields?.mappingVersion &&
    validatedFilter?.mappingVersion &&
    authorizedFields.mappingVersion !== validatedFilter.mappingVersion
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Field and filter validations resolved against different mapping versions",
    );
  }

  if (
    executionContext?.mappingVersion &&
    authorizedFields?.mappingVersion &&
    executionContext.mappingVersion !== authorizedFields.mappingVersion
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Validated export mapping version drifted from pinned execution context",
    );
  }

  // registryVersion fingerprints a resolved FIELD SET. Different projection
  // and predicate scopes legitimately produce different fingerprints. Each is
  // pinned independently in the manifest and revalidated before execution.
  const filterIds=new Set();
  const pending=validatedFilter.ast?.root?[validatedFilter.ast.root]:[];
  while(pending.length){const node=pending.pop();if(node.kind==="group")pending.push(...node.children);else if(node.kind==="condition")filterIds.add(node.field);}
  const sameRegistryScope=!validatedFilter.ast || (filterIds.size===request.fieldIds.length&&request.fieldIds.every(id=>filterIds.has(id)));
  if (
    sameRegistryScope &&
    authorizedFields?.registryVersion &&
    validatedFilter?.registryVersion &&
    authorizedFields.registryVersion !== validatedFilter.registryVersion
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Field and filter validations resolved against different registry versions",
    );
  }

  if (
    authorizedFields?.mirrorSchemaVersion &&
    validatedFilter?.mirrorSchemaVersion &&
    authorizedFields.mirrorSchemaVersion !== validatedFilter.mirrorSchemaVersion
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Field and filter validations resolved against different mirror schema versions",
    );
  }

  if (
    authorizedFields?.sourceContractVersion &&
    validatedFilter?.sourceContractVersion &&
    authorizedFields.sourceContractVersion !==
      validatedFilter.sourceContractVersion
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.SCHEMA_DRIFT,
      "Field and filter validations resolved against different source contract versions",
    );
  }

  const definitionRevisions = Array.isArray(
    authorizedFields?.definitionRevisions,
  )
    ? authorizedFields.definitionRevisions
    : [];

  const filterDefinitionRevisions = Array.isArray(
    validatedFilter?.definitionRevisions,
  )
    ? validatedFilter.definitionRevisions
    : [];

  const fieldDefMap = new Map(
    definitionRevisions.map((d) => [
      d.fieldId,
      d.definitionToken ?? d.definitionRevision,
    ]),
  );
  for (const d of filterDefinitionRevisions) {
    const id = d.fieldId;
    const token = d.definitionToken ?? d.definitionRevision;
    if (fieldDefMap.has(id) && fieldDefMap.get(id) !== token) {
      throw new ExportContractError(
        EXPORT_ERROR_CODES.SCHEMA_DRIFT,
        `Field definition revision drifted between field and filter validation for ${id}`,
      );
    }
  }

  const fieldProjectionFingerprint = hashCanonicalJson({
    fields: fieldDescriptors,
    definitionRevisions,
  });

  const mappingVersion =
    authorizedFields?.mappingVersion ??
    executionContext?.mappingVersion ??
    authorizedFields?.registryVersion ??
    validatedFilter?.registryVersion ??
    "mapping_v1";

  const compilerVersion =
    typeof validatedFilter?.compilerVersion === "string" &&
    validatedFilter.compilerVersion.length > 0
      ? validatedFilter.compilerVersion
      : validatedFilter?.versions
        ? JSON.stringify(canonicalizeJson(validatedFilter.versions))
        : String(FILTER_VALIDATION_VERSION);

  const manifest = canonicalizeJson(
    {
      manifestVersion: EXPORT_MANIFEST_VERSION,
      contractVersion: EXPORT_CONTRACT_VERSION,
      shopId,
      installationId,
      format: request.format,
      fileName: request.fileName,
      includeHeader: request.includeHeader,
      batchSize: request.batchSize,
      generationId,
      coverageRevision,
      mappingVersion,
      compilerVersion,
      registryVersion:
        authorizedFields?.registryVersion ??
        validatedFilter?.registryVersion ??
        null,
      mirrorSchemaVersion:
        authorizedFields?.mirrorSchemaVersion ??
        validatedFilter?.mirrorSchemaVersion ??
        null,
      sourceContractVersion:
        authorizedFields?.sourceContractVersion ??
        validatedFilter?.sourceContractVersion ??
        null,
      requestFingerprint,
      request,
      fieldProjectionFingerprint,
      fields: fieldDescriptors,
      definitionRevisions,
      filterFingerprint: validatedFilter.fingerprint,
      filterAst: validatedFilter.ast ?? request.filter ?? IDENTITY_FILTER_AST,
      operationId: executionContext?.operationId ?? null,
      approvedTargetingSnapshot: executionContext?.approvedTargetingSnapshot ?? null,
      selectionHash: executionContext?.selectionHash ?? null,
      selectedCount: executionContext?.selectedCount ?? null,
      datasets: executionContext?.datasets ?? authorizedFields.datasets ?? ["products","variants"],
      filterRegistryVersion: validatedFilter.registryVersion ?? null,
      filterDefinitionRevisions: validatedFilter.definitionRevisions ?? [],
    },
    {
      maxDepth: 32,
      maxNodes: 10_000,
      maxBytes: EXPORT_LIMITS.MAX_REQUEST_BYTES,
    },
  );

  const manifestFingerprint = `sha256:${createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")}`;

  ISSUED_EXPORT_MANIFESTS.add(manifest);

  return {
    manifest,
    manifestFingerprint,
    generationId,
    coverageRevision,
    mappingVersion,
    compilerVersion,
  };
}

/**
 * Verifies that an execution manifest or prepared export request was produced
 * by `prepareExportRequest` after Field Engine and Filter Engine validation.
 */
export function assertTrustedExportPrepared(prepared) {
  if (
    !prepared ||
    typeof prepared !== "object" ||
    !ISSUED_PREPARED_EXPORTS.has(prepared) ||
    !prepared.manifest ||
    !ISSUED_EXPORT_MANIFESTS.has(prepared.manifest)
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.UNAUTHORIZED,
      "Trusted export execution manifest requires prior Field and Filter Engine validation",
    );
  }
  return prepared;
}

/**
 * Computes the execution-manifest fingerprint ONLY for a request that has
 * already been validated by the Field Engine and Filter Engine.
 * Fingerprinting alone is never treated as authorization.
 */
export function exportManifestFingerprint({
  request,
  shopId,
  installationId,
  authorizedFields,
  validatedFilter,
  executionContext,
} = {}) {
  const normalizedRequest = normalizeExportRequest(request);
  const requestFingerprint = exportRequestFingerprint(normalizedRequest);
  return buildTrustedExecutionManifest({
    request: normalizedRequest,
    requestFingerprint,
    shopId,
    installationId,
    authorizedFields,
    validatedFilter,
    executionContext,
  }).manifestFingerprint;
}

/**
 * Validates, authorizes, normalizes, and fingerprints an export request
 * against METAMAX's Field and Filter Engines before constructing a
 * trusted execution manifest.
 */
export async function prepareExportRequest({
  input,
  idempotencyKey,
  authenticatedShop,
  authContext,
  executionContext,
  publicationService,
  fieldService,
  filterService,
} = {}) {
  if (
    !authenticatedShop ||
    typeof authenticatedShop.id !== "string" ||
    authenticatedShop.id.trim() === "" ||
    typeof authenticatedShop.installationId !== "string" ||
    authenticatedShop.installationId.trim() === ""
  ) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.UNAUTHORIZED,
      "Verified shop identity required",
    );
  }

  const hasFieldEngine =
    typeof fieldService?.requireFields === "function" ||
    typeof fieldService?.validateExportFields === "function";

  const hasFilterEngine =
    typeof filterService?.validateFilter === "function" ||
    typeof filterService?.validateExportFilter === "function";

  if (!hasFieldEngine || !hasFilterEngine) {
    throw new ExportContractError(
      EXPORT_ERROR_CODES.EXECUTION_FAILED,
      "Export validation adapters unavailable",
    );
  }

  const request = normalizeExportRequest(input);
  const key = normalizeIdempotencyKey(idempotencyKey);

  let resolvedExecutionContext = executionContext;
  if (publicationService) {
    if (typeof publicationService.getPublishedSnapshot === "function") {
      const pub = await publicationService.getPublishedSnapshot({
        shopId: authenticatedShop.id,
        generationId: executionContext?.generationId ?? null,
        datasets: ["products", "variants"],
        client: authContext?.databaseClient,
      });
      if (!pub) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SNAPSHOT_EXPIRED,
          "No published mirror generation available for shop",
        );
      }
      if (
        executionContext?.generationId &&
        pub.generationId !== executionContext.generationId
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Published generation drifted from execution context",
        );
      }
      if (
        executionContext?.coverageRevision &&
        pub.coverageRevision !== executionContext.coverageRevision
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Published coverage revision drifted from execution context",
        );
      }
      resolvedExecutionContext = Object.freeze({
        ...executionContext,
        generationId: pub.generationId,
        coverageRevision: pub.coverageRevision,
        mappingVersion:
          pub.mappingVersion ?? executionContext?.mappingVersion ?? "mapping_v1",
        mirrorSchemaVersion:
          pub.mirrorSchemaVersion ?? executionContext?.mirrorSchemaVersion ?? null,
        sourceContractVersion:
          pub.sourceContractVersion ??
          executionContext?.sourceContractVersion ??
          null,
      });
    } else if (
      typeof publicationService.requirePublished === "function" &&
      authContext?.databaseClient
    ) {
      await publicationService.requirePublished({
        client: authContext.databaseClient,
        shopId: authenticatedShop.id,
        generationId: executionContext?.generationId,
        coverageRevision: executionContext?.coverageRevision,
        datasets: ["products", "variants"],
      });
    }
  }

  let parsedFilterAst = null;
  let authorizedFields;
  let validatedFilter = null;

  try {
    // 1. Enforce authoritative Field & Filter Engine AST budgets when stricter
    //    than the Export Contract's generic JSON structural limits.
    enforceAuthoritativeFieldIdBudgets(request.fieldIds);
    parsedFilterAst = parseAndEnforceFilterEngineBudgets(request.filter);

    const effectiveAuthContext =
      authContext ??
      Object.freeze({
        shopId: authenticatedShop.id,
        installationId: authenticatedShop.installationId,
      });

    // 2. Authorize and resolve requested projection fields via the Field Engine.
    if (typeof fieldService.requireFields === "function") {
      authorizedFields = await fieldService.requireFields({
        authContext: effectiveAuthContext,
        fieldIds: request.fieldIds,
        access: "read",
        operation: "export",
        executionContext: resolvedExecutionContext,
      });
      if (typeof fieldService.assertResolution === "function") {
        fieldService.assertResolution(authorizedFields);
      }
    } else {
      authorizedFields = await fieldService.validateExportFields({
        shop: authenticatedShop,
        authContext: effectiveAuthContext,
        fieldIds: request.fieldIds,
        operation: "export",
        executionContext: resolvedExecutionContext,
      });
    }

    if (
      !authorizedFields ||
      typeof authorizedFields !== "object" ||
      (authorizedFields.shopId &&
        authorizedFields.shopId !== authenticatedShop.id) ||
      (authorizedFields.operation &&
        authorizedFields.operation !== "export") ||
      (authorizedFields.access && authorizedFields.access !== "read")
    ) {
      throw new ExportContractError(
        EXPORT_ERROR_CODES.UNAUTHORIZED,
        "Field resolution shop or operation mismatch",
      );
    }

    // 3. Semantically validate the filter via the Filter Engine BEFORE
    //    constructing the trusted execution manifest. Unfiltered exports
    //    still validate through the Filter Engine using the canonical identity filter.
    if (typeof filterService.validateFilter === "function") {
      const astToValidate = parsedFilterAst ?? IDENTITY_FILTER_AST;
      validatedFilter = await filterService.validateFilter(astToValidate, {
        authContext: effectiveAuthContext,
        operation: "export",
        executionContext: resolvedExecutionContext,
      });
    } else {
      validatedFilter = await filterService.validateExportFilter({
        shop: authenticatedShop,
        authContext: effectiveAuthContext,
        filter: parsedFilterAst,
        operation: "export",
        executionContext: resolvedExecutionContext,
      });
    }

    if (
      !validatedFilter ||
      typeof validatedFilter !== "object" ||
      (validatedFilter.shopId &&
        validatedFilter.shopId !== authenticatedShop.id) ||
      (validatedFilter.operation &&
        validatedFilter.operation !== "export")
    ) {
      throw new ExportContractError(
        EXPORT_ERROR_CODES.UNAUTHORIZED,
        "Filter validation shop or operation mismatch",
      );
    }
  } catch (error) {
    throw mapEngineError(error);
  }

  // 4. Compute structural request fingerprint (idempotency identity only) and
  //    construct the trusted execution manifest ONLY after validation succeeds.
  const requestFingerprint = exportRequestFingerprint(request);
  const {
    manifest,
    manifestFingerprint,
    generationId,
    coverageRevision,
    mappingVersion,
    compilerVersion,
  } = buildTrustedExecutionManifest({
    request,
    requestFingerprint,
    shopId: authenticatedShop.id,
    installationId: authenticatedShop.installationId,
    authorizedFields,
    validatedFilter,
    executionContext,
  });

  const prepared = Object.freeze({
    contractVersion: EXPORT_CONTRACT_VERSION,
    manifestVersion: EXPORT_MANIFEST_VERSION,
    shopId: authenticatedShop.id,
    installationId: authenticatedShop.installationId,
    idempotencyKey: key,
    requestFingerprint,
    manifestFingerprint,
    manifest,
    generationId,
    coverageRevision,
    mappingVersion,
    compilerVersion,
    request,
    authorizedFields,
    validatedFilter,
  });

  ISSUED_PREPARED_EXPORTS.add(prepared);

  return prepared;
}

/**
 * Creates the server-side Export Service supporting rate-limited,
 * idempotent export job creation bound to the authenticated shop.
 * Input: opaque authContext, normalized export input and idempotency key.
 * Output: {created,job}; authority/lifecycle: current tenant and installation,
 * approved fields/filter and protected publication enforced before admission.
 * Durable effect: repository atomically creates or returns a tenant/key job.
 * Persistent lookup bypasses admission limits for replays. Legacy replay hints
 * expire after 60 seconds and retain at most 1,000 committed entries per service;
 * eviction never replaces repository conflict checking or authorizes execution.
 */
export function createExportService({
  resolveShop,
  resolveExecutionContext,
  publicationService,
  fieldService,
  filterService,
  repository,
  rateLimiter,
} = {}) {
  if (
    typeof resolveShop !== "function" ||
    (typeof repository?.createOrGet !== "function" && typeof repository?.createPreparedJob !== "function")
  ) {
    throw new TypeError(
      "Export service requires resolveShop and an atomic repository.createOrGet implementation",
    );
  }

  // Persistent lookup is authoritative and retains no process-local results.
  // Legacy atomic repositories get only a bounded, short-lived replay hint;
  // createOrGet remains responsible for durable conflict detection after eviction.
  const persistentLookup = typeof repository.findByIdempotencyKey === "function";
  const committedIdempotencyIndex = persistentLookup ? null : new Map();
  const replayCapacity = 1000, replayTtlMs = 60000;

  return Object.freeze({
    async create({ authContext, input, idempotencyKey } = {}) {
      if (!authContext) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.UNAUTHORIZED,
          "Authentication required",
        );
      }

      const authenticatedShop = await resolveShop(authContext);
      if (
        !authenticatedShop ||
        typeof authenticatedShop.id !== "string" ||
        !authenticatedShop.id ||
        typeof authenticatedShop.installationId !== "string" ||
        !authenticatedShop.installationId
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.UNAUTHORIZED,
          "Verified shop identity required",
        );
      }

      // Normalize request and idempotency key first so idempotency replays
      // never consume rate-limit tokens or reserve additional execution slots.
      const normalizedRequest = normalizeExportRequest(input);
      const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
      const requestFingerprint = exportRequestFingerprint(normalizedRequest);
      const idempotencyScopeKey = JSON.stringify([authenticatedShop.id, authenticatedShop.installationId, normalizedKey]);

      if (persistentLookup) {
        const existingJob = await repository.findByIdempotencyKey({
          shopId: authenticatedShop.id,
          installationId: authenticatedShop.installationId,
          idempotencyKey: normalizedKey,
        });
        if (existingJob) {
          if (
            (existingJob.requestFingerprint ?? existingJob.request_fingerprint) &&
            (existingJob.requestFingerprint ?? existingJob.request_fingerprint) !== requestFingerprint
          ) {
            throw new ExportContractError(
              EXPORT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              "Idempotency key already used with different export request parameters",
            );
          }
          return Object.freeze({
            created: false,
            job: repository.createPreparedJob ? publicExecutionJob(existingJob) : existingJob,
          });
        }
      } else {
        for (const [key, value] of committedIdempotencyIndex) {
          if (value.expiresAt <= Date.now()) committedIdempotencyIndex.delete(key);
        }
        const cached = committedIdempotencyIndex.get(idempotencyScopeKey);
        if (cached) {
          if (cached.requestFingerprint !== requestFingerprint) {
            throw new ExportContractError(
              EXPORT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
              "Idempotency key already used with different export request parameters",
            );
          }
          return Object.freeze({
            created: false,
            job: cached.job,
          });
        }
      }

      // Rate limit strictly by server-authenticated shop identity, never headers,
      // and only for new admission attempts (not idempotent replays).
      if (rateLimiter) {
        const allowed = await rateLimiter.consume({
          shopId: authenticatedShop.id,
          installationId: authenticatedShop.installationId,
          operation: "export",
        });
        if (!allowed) {
          throw new ExportContractError(
            EXPORT_ERROR_CODES.RATE_LIMITED,
            "Export creation rate limit exceeded for shop",
            { retryable: true },
          );
        }
      }

      const executionContext =
        typeof resolveExecutionContext === "function"
          ? await resolveExecutionContext({
              authContext,
              shop: authenticatedShop,
              request: normalizedRequest,
            })
          : undefined;

      const prepared = await prepareExportRequest({
        input,
        idempotencyKey,
        authenticatedShop,
        authContext,
        executionContext,
        publicationService,
        fieldService,
        filterService,
      });

      const outcome = typeof repository.createPreparedJob === "function"
        ? await repository.createPreparedJob({prepared:assertTrustedExportPrepared(prepared)})
        : await repository.createOrGet({
        shopId: prepared.shopId,
        installationId: prepared.installationId,
        idempotencyKey: prepared.idempotencyKey,
        requestFingerprint: prepared.requestFingerprint,
        manifestFingerprint: prepared.manifestFingerprint,
        state: EXPORT_STATES.QUEUED,
        prepared,
      });

      if (
        !outcome ||
        typeof outcome.created !== "boolean" ||
        !outcome.job
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.EXECUTION_FAILED,
          "Invalid export repository outcome",
        );
      }

      if (
        outcome.job.requestFingerprint &&
        outcome.job.requestFingerprint !== prepared.requestFingerprint
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.IDEMPOTENCY_CONFLICT,
          "Idempotency key already used with different export request parameters",
        );
      }

      if (committedIdempotencyIndex) {
        committedIdempotencyIndex.delete(idempotencyScopeKey);
        while (committedIdempotencyIndex.size >= replayCapacity) {
          committedIdempotencyIndex.delete(committedIdempotencyIndex.keys().next().value);
        }
        committedIdempotencyIndex.set(idempotencyScopeKey, {
          requestFingerprint: prepared.requestFingerprint,
          job: repository.createPreparedJob ? publicExecutionJob(outcome.job) : outcome.job,
          expiresAt: Date.now() + replayTtlMs,
        });
      }

      return Object.freeze({
        created: outcome.created,
        job: repository.createPreparedJob ? publicExecutionJob(outcome.job) : outcome.job,
      });
    },

    /**
     * Verifies that a retry or resume execution stays pinned to the job's original
     * immutable manifest, verifies that the pinned generation is still published and
     * retained (via active generation read lease), and revalidates that no schema,
     * field definition revision, or filter compilation drift occurred.
     */
    async verifyRetryExecution({
      authContext,
      job,
      jobId,
      claim,
      renewLease = true,
      readLeaseSeconds,
    } = {}) {
      if (!authContext) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.UNAUTHORIZED,
          "Authentication required",
        );
      }

      const authenticatedShop = await resolveShop(authContext);
      if (!authenticatedShop?.id || !authenticatedShop?.installationId) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.UNAUTHORIZED,
          "Verified shop identity required",
        );
      }

      const targetJob =
        (typeof repository.getJob === "function"
          ? await repository.getJob({
              identity: {
                shopId: authenticatedShop.id,
                installationId: authenticatedShop.installationId,
              },
              jobId: jobId ?? job?.id,
              shopId: authenticatedShop.id,
              installationId: authenticatedShop.installationId,
            })
          : null);

      if (!targetJob) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.INVALID_REQUEST,
          "Export job not found",
        );
      }

      const jobShopId = targetJob.shopId ?? targetJob.shop_id;
      const jobInstallationId =
        targetJob.installationId ?? targetJob.installation_id;
      if (
        jobShopId !== authenticatedShop.id ||
        jobInstallationId !== authenticatedShop.installationId
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.UNAUTHORIZED,
          "Export job tenant mismatch",
        );
      }

      const manifest = targetJob.manifest;
      if (!manifest || typeof manifest !== "object") {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Export job manifest missing or invalid",
        );
      }

      const manifestFp =
        targetJob.manifestFingerprint ?? targetJob.manifest_fingerprint;
      if (manifestFp && hashCanonicalJson(manifest) !== manifestFp) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Export job manifest fingerprint drifted",
        );
      }

      const reqFp =
        targetJob.requestFingerprint ?? targetJob.request_fingerprint;
      if (
        reqFp &&
        manifest.requestFingerprint &&
        reqFp !== manifest.requestFingerprint
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Export job request fingerprint drifted from manifest",
        );
      }

      const jobGenId = targetJob.generationId ?? targetJob.generation_id;
      if (
        jobGenId &&
        manifest.generationId &&
        String(jobGenId) !== String(manifest.generationId)
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Export job generationId drifted from manifest",
        );
      }

      const jobCovRev =
        targetJob.coverageRevision ?? targetJob.coverage_revision;
      if (
        jobCovRev &&
        manifest.coverageRevision &&
        String(jobCovRev) !== String(manifest.coverageRevision)
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Export job coverageRevision drifted from manifest",
        );
      }

      const jobMapVer =
        targetJob.mappingVersion ?? targetJob.mapping_version;
      if (
        jobMapVer &&
        manifest.mappingVersion &&
        String(jobMapVer) !== String(manifest.mappingVersion)
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Export job mappingVersion drifted from manifest",
        );
      }

      // Pin execution strictly to the job's original immutable generation
      const pinnedExecutionContext = Object.freeze({
        phase: manifest.approvedTargetingSnapshot ? "execute" : "preview",
        operationId: manifest.operationId,
        ...(manifest.approvedTargetingSnapshot ? {approvedTargetingSnapshot:manifest.approvedTargetingSnapshot} : {}),
        selectionHash:manifest.selectionHash,
        selectedCount:manifest.selectedCount,
        shopId: authenticatedShop.id,
        installationId: authenticatedShop.installationId,
        generationId: manifest.generationId,
        coverageRevision: manifest.coverageRevision,
        mappingVersion: manifest.mappingVersion,
        registryVersion: manifest.registryVersion,
        mirrorSchemaVersion: manifest.mirrorSchemaVersion,
        sourceContractVersion: manifest.sourceContractVersion,
        definitionRevisions: manifest.definitionRevisions,
        datasets: manifest.datasets ?? ["products", "variants"],
      });

      // Verify generation retention lease
      if (typeof repository.verifyRetention === "function") {
        await repository.verifyRetention({
          shopId: authenticatedShop.id,
          installationId: authenticatedShop.installationId,
          jobId: targetJob.id,
          renewLease,
          readLeaseSeconds,
        });
      } else if (
        typeof repository.renewGenerationProtection === "function"
      ) {
        if(!claim)throw new ExportContractError(EXPORT_ERROR_CODES.LEASE_LOST,"Retry verification requires its current database claim");
        await repository.renewGenerationProtection({
          identity: {
            shopId: authenticatedShop.id,
            installationId: authenticatedShop.installationId,
          },
          jobId: targetJob.id,
          claim,
        });
      }

      // Revalidate Field and Filter Engines against the pinned execution context
      const revalidated = await prepareExportRequest({
        input: manifest.request ?? {
          format: manifest.format,
          fileName: manifest.fileName,
          includeHeader: manifest.includeHeader,
          batchSize: manifest.batchSize,
          fieldIds: Array.isArray(manifest.fields)
            ? manifest.fields.map((f) => f.id)
            : [],
          filter: manifest.filterAst ?? null,
        },
        idempotencyKey:
          targetJob.idempotencyKey ??
          targetJob.idempotency_key ??
          "export:retry",
        authenticatedShop,
        authContext,
        executionContext: pinnedExecutionContext,
        publicationService,
        fieldService,
        filterService,
      });

      if (
        revalidated.manifest.generationId !== manifest.generationId ||
        revalidated.manifest.coverageRevision !== manifest.coverageRevision ||
        revalidated.manifest.mappingVersion !== manifest.mappingVersion ||
        revalidated.manifest.fieldProjectionFingerprint !==
          manifest.fieldProjectionFingerprint ||
        revalidated.manifest.filterFingerprint !== manifest.filterFingerprint
      ) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.SCHEMA_DRIFT,
          "Export execution contract drifted across retries",
        );
      }

      return Object.freeze({
        verified: true,
        job: targetJob,
        manifest,
        pinnedExecutionContext,
        prepared: revalidated,
      });
    },

    prepareRetry(args) {
      return this.verifyRetryExecution(args);
    },

    verifyExecutionSnapshot(args) {
      return this.verifyRetryExecution(args);
    },

    async renewGenerationRetention({
      authContext,
      job,
      jobId,
      claim,
      readLeaseSeconds,
    } = {}) {
      return this.verifyRetryExecution({
        authContext,
        job,
        jobId,
        claim,
        renewLease: true,
        readLeaseSeconds,
      });
    },

    async releaseGenerationRetention({
      authContext,
      job,
      jobId,
      reason = "TERMINAL_CLEANUP",
    } = {}) {
      const authenticatedShop = await resolveShop(authContext);
      if (!authenticatedShop?.id) {
        throw new ExportContractError(
          EXPORT_ERROR_CODES.UNAUTHORIZED,
          "Authentication required",
        );
      }
      const targetId = jobId ?? job?.id;
      if (typeof repository.releaseReadLease === "function") {
        return repository.releaseReadLease({
          shopId: authenticatedShop.id,
          installationId: authenticatedShop.installationId,
          jobId: targetId,
        });
      }
      if (typeof repository.releaseGenerationProtection === "function") {
        return repository.releaseGenerationProtection({
          identity: {
            shopId: authenticatedShop.id,
            installationId: authenticatedShop.installationId,
          },
          jobId: targetId,
          reason,
        });
      }
      return false;
    },
  });
}

function publicExecutionJob(job) {
  return Object.freeze({id:job.id,state:job.state,format:job.manifest?.format,
    rowsCommitted:String(job.rows_committed ?? 0),bytesCommitted:String(job.bytes_committed ?? 0),
    createdAt:job.created_at,updatedAt:job.updated_at});
}

