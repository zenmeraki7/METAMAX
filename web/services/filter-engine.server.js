/** Construct once in server bootstrap; all dependencies are server-owned. */
import { createFilterService } from "../filters/index.js";
import {
  FieldError,
  FIELD_ERROR_CODES as C,
  isPlainObject,
  deepFreeze,
} from "../fields/types.js";
import {
  createFilterCompiler,
  createFilterExecutor,
} from "../filters/index.js";
import { verifyMirrorSqlSchema } from "./mirror-schema.server.js";
import { createMirrorCoverageService } from "../mirror/coverage.js";
import { createMirrorPublicationService } from "../mirror/publication-service.server.js";
import { createFilterAuthentication } from "../middleware/filter-auth.server.js";
import { createFiltersController } from "../controllers/filters.controller.js";
import { createCursorService } from "../filters/pagination.js";
import { getFilterBindingRegistry } from "../filters/bindings.js";
import { getInstalledFilterSchemaOptions } from "./filter-schema.server.js";
import { createFieldService } from "../fields/resolve.js";
import { createFieldAuthorizationService } from "./field-authorization.server.js";
import { createPublicationRepository } from "../mirror/publication-repository.server.js";
import { createCatalogController } from "../controllers/catalog.controller.js";
import { createCatalogQueryService } from "./catalog-query.server.js";
import { createMetafieldRepository } from "./metafield-repository.server.js";
import { createMetafieldAdapter } from "../fields/metafield-adapter.js";
import { currentCoverageTransaction } from "../mirror/coverage-transaction.server.js";

/** Production source-contract bootstrap; callers supply services, never SQL mappings. */
export function createInstalledFilterHttpRuntime(options = {}) {
  const config = data(options, [
    "database",
    "sessionStorage",
    "fieldServiceFactory",
    "coverageRepository",
    "publishedContextRepository",
    "cursorSecret",
    "logger",
    "metafieldRepository",
    "metafieldAdapter",
  ]);
  const repository = createPublicationRepository({ database: config.database });
  const metafieldRepo =
    config.metafieldRepository ??
    (config.database && typeof config.database.query === "function"
      ? createMetafieldRepository({ database: config.database })
      : null);
  const metafieldAdapter =
    config.metafieldAdapter ??
    (metafieldRepo
      ? createMetafieldAdapter({ repository: metafieldRepo })
      : {
          resolveOne() {
            throw new FieldError(
              C.UNSUPPORTED_OPERATION,
              "Dynamic catalog fields are not installed",
            );
          },
          resolveBatch() {
            throw new FieldError(
              C.UNSUPPORTED_OPERATION,
              "Dynamic catalog fields are not installed",
            );
          },
        });

  return createFilterHttpRuntime({
    ...config,
    coverageRepository: config.coverageRepository ?? repository,
    publishedContextRepository: config.publishedContextRepository ?? repository,
    fieldServiceFactory:
      config.fieldServiceFactory ??
      (({ resolveShop, resolveSession, verifyCoverage }) => {
        const authorization = createFieldAuthorizationService({
          database: config.database,
          resolveShop,
          allowedOperations: ["filter", "export"],
          getShopScopes: async (shopId, authContext) => {
            const session = await resolveSession(authContext);
            return session?.shop === shopId ? (session.scope ?? "") : "";
          },
        });
        return createFieldService({
          resolveShop,
          verifyCoverage,
          authorizeAccess: authorization.authorizeAccess,
          adapter: metafieldAdapter,
        });
      }),
    ...getInstalledFilterSchemaOptions(),
    barrierTable: { schema: "mirror", table: "publications" },
  });
}

/** Optional HTTP runtime. No guessed physical mappings or readiness defaults.
 * fieldServiceFactory must construct the genuine authorized Field Service with
 * these authentication/coverage functions and the application's authorization.
 * publishedContextRepository must load the current context from stored state.
 */
export async function createFilterHttpRuntime({
  database,
  sessionStorage,
  fieldServiceFactory,
  coverageRepository,
  publishedContextRepository,
  barrierTable,
  schema,
  fieldMappings,
  mirrorSchemaVersion,
  sourceContractVersion,
  cursorSecret,
  logger = console,
} = {}) {
  if (
    typeof fieldServiceFactory !== "function" ||
    typeof publishedContextRepository?.getPublishedContext !== "function"
  ) {
    throw new TypeError(
      "Trusted field service factory and published context repository required",
    );
  }
  // A schema/migration or dataset enum is not an installed source contract.
  // Refuse bootstrap before invoking adapters or opening a database connection.
  getFilterBindingRegistry();
  const authentication = createFilterAuthentication({ sessionStorage });
  const coverage = createMirrorCoverageService({
    repository: coverageRepository,
  });
  const publicationService = createMirrorPublicationService({
    repository: coverageRepository,
    barrierTable,
  });
  const physicalSchema = await verifyMirrorSqlSchema({
    database,
    schema,
    fieldMappings,
    mirrorSchemaVersion,
    sourceContractVersion,
  });
  const fieldService = await fieldServiceFactory({
    resolveShop: authentication.resolveShop,
    resolveSession: authentication.resolveSession,
    verifyCoverage: coverage.getVerifiedCoverage,
  });
  const secretKey =
    typeof cursorSecret === "string"
      ? Buffer.from(cursorSecret, "utf8")
      : cursorSecret;
  const cursors = createCursorService({ secret: secretKey });
  const compiler = createFilterCompiler({
    fieldService,
    physicalSchema,
    cursorService: cursors,
  });
  const executor = createFilterExecutor({
    database,
    publicationService,
    resolveShop: authentication.resolveShop,
    compiler,
  });
  async function resolveDatasets({
    authContext,
    cursor,
    client,
    generationId,
    coverageRevision,
  }) {
    const shopId = await authentication.resolveShop(authContext);
    const routing =
      cursor === undefined ? {} : cursors.readContext(cursor, shopId);
    if (
      (generationId !== undefined &&
        routing.generationId !== undefined &&
        routing.generationId !== generationId) ||
      (coverageRevision !== undefined &&
        routing.coverageRevision !== undefined &&
        routing.coverageRevision !== coverageRevision)
    ) {
      throw new FieldError(
        C.CONTRACT_MISMATCH,
        "Cursor context differs from pinned selection snapshot",
      );
    }
    const txClient = client ?? currentCoverageTransaction();
    const published = await publishedContextRepository.getPublishedContext({
      shopId,
      ...(generationId !== undefined ? { generationId } : {}),
      ...(coverageRevision !== undefined ? { coverageRevision } : {}),
      ...routing,
      ...(txClient ? { client: txClient } : {}),
    });
    if (!isPlainObject(published))
      throw new FieldError(
        C.MISSING_DEPENDENCY,
        "Published filter context unavailable",
      );
    if (
      (generationId !== undefined && published.generationId !== generationId) ||
      (coverageRevision !== undefined &&
        published.coverageRevision !== coverageRevision)
    ) {
      throw new FieldError(
        C.CONTRACT_MISMATCH,
        "Published filter context differs from pinned selection snapshot",
      );
    }
    const executionContext = deepFreeze(structuredClone(published));
    // Coverage is supplied exclusively by the final compiler-issued query plan.
    return Object.freeze({ executionContext });
  }
  const controller = createFiltersController({
    authenticate: authentication.authenticate,
    compiler,
    executor,
    resolveDatasets,
    logger,
  });
  const catalog = createCatalogController({
    authentication,
    compiler,
    executor,
    resolveDatasets,
    logger,
  });
  const catalogQuery = createCatalogQueryService({
    compiler,
    executor,
    resolveDatasets,
    resolveShop: authentication.resolveShop,
    logger,
  });
  return Object.freeze({
    capture: authentication.capture,
    authentication,
    search: controller.search,
    catalog: catalog.search,
    catalogStatus: catalog.status,
    catalogCount: catalog.count,
    catalogQuery,
    compiler,
    fieldService,
    executor,
    physicalSchema,
  });
}

function data(raw, allowed) {
  if (!isPlainObject(raw))
    throw new TypeError("Server filter context required");
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (
      typeof key !== "string" ||
      !allowed.includes(key) ||
      !descriptor ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError("Unsupported filter bootstrap or context property");
    }
    result[key] = descriptor.value;
  }
  return result;
}

export function createFilterEngine(options = {}) {
  const { fieldService, authenticatedSessionService } = data(options, [
    "fieldService",
    "authenticatedSessionService",
  ]);
  if (
    !authenticatedSessionService ||
    typeof authenticatedSessionService.requireAuthenticatedShop !== "function"
  ) {
    throw new TypeError("Authenticated session service required");
  }
  const authenticate =
    authenticatedSessionService.requireAuthenticatedShop.bind(
      authenticatedSessionService,
    );
  // The genuine field service owns authorization/coverage. Binding definitions
  // come only from the installed server source registry, never this factory.
  const service = createFilterService({ fieldService });
  async function requireShop(authContext) {
    const session = await authenticate(authContext);
    const descriptor =
      isPlainObject(session) &&
      Object.getOwnPropertyDescriptor(session, "shopId");
    const shopId =
      descriptor && Object.hasOwn(descriptor, "value")
        ? descriptor.value
        : null;
    if (
      typeof shopId !== "string" ||
      !shopId ||
      shopId.length > 255 ||
      shopId.trim() !== shopId ||
      /[\u0000-\u001f\u007f]/.test(shopId)
    ) {
      throw new FieldError(
        C.PERMISSION_DENIED,
        "Verified session shop required",
      );
    }
    return shopId;
  }
  function assertShop(shopId, resolvedShop) {
    if (resolvedShop !== shopId)
      throw new FieldError(
        C.PERMISSION_DENIED,
        "Filter belongs to another authenticated shop",
      );
  }
  return Object.freeze({
    async validateFilter(input, trustedContext) {
      const context = data(trustedContext, [
        "authContext",
        "operation",
        "executionContext",
      ]);
      const shopId = await requireShop(context.authContext);
      const validated = await service.validateFilter(input, context);
      assertShop(shopId, validated.shopId);
      return validated;
    },
    async compileFilter(validated, trustedContext) {
      const context = data(trustedContext, ["authContext"]);
      const shopId = await requireShop(context.authContext);
      const plan = await service.compileFilter(validated, context);
      assertShop(shopId, plan.binding.shopId);
      return plan;
    },
  });
}
