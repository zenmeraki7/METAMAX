import {getFieldCapability,FIELD_CAPABILITY_VERSIONS} from '../fields/capabilities.js';
import {getFieldConstraints} from '../fields/constraints.js';
/**
 * METAMAX — Product Catalog Query Service
 *
 * Reuses the existing predicate compiler and executor to support product IDs,
 * authorized product projections, counts, and signed keyset pagination.
 * Does not write a separate SQL compiler for the catalog.
 */

import {
  FieldError,
  FIELD_ERROR_CODES as C,
  deepFreeze,
  isPlainObject,
} from "../fields/types.js";
import { normalizePageSize } from "../filters/execute.js";
import { parseFilterAst } from "../filters/ast.js";
import {getFilterBindingRegistry} from '../filters/bindings.js';
import {requireCanonicalField} from '../fields/canonical.js';
import {
  withCoverageTransaction,
  currentCoverageTransaction,
} from "../mirror/coverage-transaction.server.js";

const condition = (field, operator, value) => ({
  kind: "condition",
  field,
  operator: operator === "ne" ? "neq" : operator,
  ...(value === undefined ? {} : { value }),
});

const group = (operator, children) => ({ kind: "group", operator, children });

function invalid(message = "Invalid catalog query request") {
  throw new FieldError(C.INVALID_VALUE, message);
}

/**
 * Normalizes query parameters into a validated filter AST.
 * Handles search text, status, limit, cursor, and advanced filter conditions.
 */
export function parseCatalogQueryParams(query = {}) {
  if (
    Object.keys(query).some(
      (key) =>
        ![
          "search",
          "status",
          "limit",
          "cursor",
          "filters",
          "match",
        ].includes(key),
    ) ||
    Object.values(query).some((value) => typeof value !== "string") ||
    Buffer.byteLength(JSON.stringify(query)) > 16384
  ) {
    invalid();
  }

  const search = query.search ?? "";
  const status = query.status ?? "ALL";
  const match = query.match ?? "all";

  if (
    search.length > 200 ||
    !["ALL", "ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"].includes(status) ||
    !["all", "any"].includes(match)
  ) {
    invalid();
  }

  if (query.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(query.limit)) {
    invalid("Invalid limit parameter");
  }

  const pageSize = normalizePageSize(
    query.limit === undefined ? 25 : Number(query.limit),
  );

  if (
    query.cursor !== undefined &&
    (!query.cursor || query.cursor.length > 4096)
  ) {
    invalid("Invalid cursor token");
  }

  let filters = [];
  if (query.filters !== undefined) {
    try {
      filters = JSON.parse(query.filters);
    } catch {
      invalid("Invalid JSON in filters parameter");
    }
  }

  if (!Array.isArray(filters) || filters.length > 10) {
    invalid("Filters must be an array of at most 10 conditions");
  }

  const advanced = filters.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) => !["field", "operator", "value"].includes(key),
      ) ||
      typeof item.field !== "string" ||
      typeof item.operator !== "string"
    ) {
      invalid("Invalid condition structure");
    }
    // Normalizes 'ne' -> 'neq'
    return condition(item.field, item.operator, item.value);
  });

  const children = [];
  if (search.trim()) {
    children.push(
      group(
        "OR",
        [
          "product.title",
          "product.vendor",
          "product.productType",
          "product.handle",
        ].map((field) => condition(field, "contains", search.trim())),
      ),
    );
  }

  if (status !== "ALL") {
    children.push(condition("product.status", "eq", status));
  }

  if (advanced.length) {
    children.push(group(match === "all" ? "AND" : "OR", advanced));
  }

  if (!children.length) {
    children.push(condition("product.id", "is_not_null"));
  }

  return {
    filter: { version: 1, root: group("AND", children) },
    pageSize,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  };
}

export function createCatalogQueryService({
  compiler,
  executor,
  resolveDatasets,
  resolveShop,
  logger = console,
} = {}) {
  if (!compiler || typeof compiler.compileFilter !== "function") {
    throw new TypeError("Valid filter compiler required");
  }
  if (!executor || typeof executor.execute !== "function") {
    throw new TypeError("Valid filter executor required");
  }
  if (typeof resolveDatasets !== "function") {
    throw new TypeError("Dataset resolution handler required");
  }

  const service = Object.freeze({
    // Backend-only unit of work: pages and membership writes share one protected
    // shop-protected transaction. No client or shop is accepted from a browser.
    async withSelectionSnapshot({ authContext, shopId, filter, signal }, callback) {
      if (typeof executor.withSnapshot !== "function" || typeof resolveShop !== "function") {
        throw new FieldError(C.EXECUTION_UNAVAILABLE, "Protected catalog selection unavailable");
      }
      if (!authContext || await resolveShop(authContext) !== shopId) {
        throw new FieldError(C.PERMISSION_DENIED, "Selection requires the authenticated shop");
      }
      const capturedFilter = parseFilterAst(filter);
      return executor.withSnapshot({ authContext, signal }, async ({ client, shopId: authenticatedShop }) => {
        if (authenticatedShop !== shopId || !client || typeof client.query !== "function") {
          throw new FieldError(C.PERMISSION_DENIED, "Selection shop changed");
        }
        const initialContext = await withCoverageTransaction(client, () =>
          resolveDatasets({ authContext, client }),
        );
        const rawExecutionContext = initialContext?.executionContext;
        if (
          !isPlainObject(rawExecutionContext) ||
          typeof rawExecutionContext.generationId !== "string" ||
          !rawExecutionContext.generationId ||
          typeof rawExecutionContext.coverageRevision !== "string" ||
          !rawExecutionContext.coverageRevision
        ) {
          throw new FieldError(
            C.EXECUTION_UNAVAILABLE,
            "Pinned published generation and coverage revision required for selection snapshot",
          );
        }
        const pinnedExecutionContext = deepFreeze(structuredClone(rawExecutionContext));
        const pinnedGenerationId = pinnedExecutionContext.generationId;
        const pinnedCoverageRevision = pinnedExecutionContext.coverageRevision;

        return callback({
          client,
          generationId: pinnedGenerationId,
          coverageRevision: pinnedCoverageRevision,
          queryPage: async (cursor, pinned = {}) => {
            if (pinned && typeof pinned === "object") {
              if (pinned.client !== undefined && pinned.client !== client) {
                throw new FieldError(
                  C.CONTRACT_MISMATCH,
                  "Selection page must execute on the protected snapshot transaction client",
                );
              }
              if (
                pinned.generationId !== undefined &&
                pinned.generationId !== pinnedGenerationId
              ) {
                throw new FieldError(
                  C.CONTRACT_MISMATCH,
                  "Selection page generation differs from pinned snapshot",
                );
              }
              if (
                pinned.coverageRevision !== undefined &&
                pinned.coverageRevision !== pinnedCoverageRevision
              ) {
                throw new FieldError(
                  C.CONTRACT_MISMATCH,
                  "Selection page coverage revision differs from pinned snapshot",
                );
              }
            }
            return service.queryProductIds({
              authContext,
              filter: capturedFilter,
              pageSize: 100,
              ...(cursor === undefined ? {} : { cursor }),
              snapshot: {
                client,
                generationId: pinnedGenerationId,
                coverageRevision: pinnedCoverageRevision,
                executionContext: pinnedExecutionContext,
              },
            });
          },
        });
      });
    },
    async queryProducts({ authContext, params = {} } = {}) {
      const { filter, pageSize, cursor } = parseCatalogQueryParams(params);
      const context = await resolveDatasets({
        authContext,
        ...(cursor ? { cursor } : {}),
      });

      const validated = await compiler.validateFilter(filter, {
        authContext,
        operation: "filter",
        executionContext: context.executionContext,
      });

      const query = await compiler.compileFilter(validated, {
        authContext,
        pageSize,
        ...(cursor ? { cursor } : {}),
        catalog: true,
      });

      const result = await executor.execute({ query, authContext });

      return {
        products: result.products,
        summary: result.summary,
        filteredCount: result.filteredCount,
        pageInfo: {
          hasNextPage: result.hasMore,
          endCursor: result.nextCursor,
        },
        snapshotId: result.generationId,
        publishedRevision: result.coverageRevision,
        syncStatus: "READY",
      };
    },

    async queryCapabilities({authContext}={}) {
      const registry=getFilterBindingRegistry();
      const fieldIds=registry.listFieldIds();
      const context=await resolveDatasets({authContext});
      // Every advertised field passes the genuine semantic, physical mapping,
      // coverage and live authorization stages. This metadata grants no access.
      const validated=await compiler.validateFilter({version:1,root:group('AND',fieldIds.map(id=>condition(id,'is_not_null')))},
        {authContext,operation:'filter',executionContext:context.executionContext});
      const query=await compiler.compileFilter(validated,{authContext,catalog:'status',pageSize:1});
      const result=await executor.execute({query,authContext});
      return {...FIELD_CAPABILITY_VERSIONS,snapshotId:result.generationId,publishedRevision:result.coverageRevision,
        fields:fieldIds.map(id=>getFieldCapability(id,{bindingOperators:registry.requireBinding(id).operators}))};
    },
    async queryStatus({ authContext } = {}) {
      const context = await resolveDatasets({ authContext });
      const validated = await compiler.validateFilter(
        { version: 1, root: condition("product.id", "is_not_null") },
        {
          authContext,
          operation: "filter",
          executionContext: context.executionContext,
        },
      );

      const query = await compiler.compileFilter(validated, {
        authContext,
        pageSize: 1,
        catalog: "status",
      });

      const result = await executor.execute({ query, authContext });

      return {
        snapshotId: result.generationId,
        publishedRevision: result.coverageRevision,
        syncStatus: "READY",
      };
    },

    async queryCount({ authContext, params = {} } = {}) {
      const { filter } = parseCatalogQueryParams(params);
      const context = await resolveDatasets({ authContext });

      const validated = await compiler.validateFilter(filter, {
        authContext,
        operation: "filter",
        executionContext: context.executionContext,
      });

      const query = await compiler.compileFilter(validated, {
        authContext,
        pageSize: 1,
        catalog: "count",
      });

      const result = await executor.execute({ query, authContext });

      return {
        count: result.filteredCount,
        precision: "EXACT",
      };
    },

    async queryProductIds({
      authContext,
      filter,
      pageSize = 250,
      cursor,
      snapshot,
    } = {}) {
      const runInSnapshot = snapshot?.client
        ? (fn) => {
            const activeTx = currentCoverageTransaction();
            if (activeTx && activeTx !== snapshot.client) {
              throw new FieldError(
                C.CONTRACT_MISMATCH,
                "Selection page transaction client mismatch",
              );
            }
            return activeTx ? fn() : withCoverageTransaction(snapshot.client, fn);
          }
        : (fn) => fn();

      return runInSnapshot(async () => {
        const context = await resolveDatasets({
          authContext,
          ...(cursor ? { cursor } : {}),
          ...(snapshot
            ? {
                client: snapshot.client,
                generationId: snapshot.generationId,
                coverageRevision: snapshot.coverageRevision,
              }
            : {}),
        });

        const executionContext = snapshot
          ? snapshot.executionContext
          : context.executionContext;

        if (snapshot) {
          if (
            context?.executionContext?.generationId !== snapshot.generationId ||
            context?.executionContext?.coverageRevision !== snapshot.coverageRevision
          ) {
            throw new FieldError(
              C.CONTRACT_MISMATCH,
              "Selection page dataset context differs from pinned snapshot",
            );
          }
        }

        const validated = await compiler.validateFilter(filter, {
          authContext,
          operation: "filter",
          executionContext,
        });

        const query = await compiler.compileFilter(validated, {
          authContext,
          pageSize,
          ...(cursor ? { cursor } : {}),
        });

        if (snapshot) {
          if (
            (query.binding?.generationId !== undefined &&
              query.binding.generationId !== snapshot.generationId) ||
            (query.binding?.coverageRevision !== undefined &&
              query.binding.coverageRevision !== snapshot.coverageRevision)
          ) {
            throw new FieldError(
              C.CONTRACT_MISMATCH,
              "Compiled selection query binding differs from pinned snapshot",
            );
          }
        }

        const result = await executor.execute({ query, authContext });

        if (snapshot) {
          if (
            result.generationId !== snapshot.generationId ||
            result.coverageRevision !== snapshot.coverageRevision
          ) {
            throw new FieldError(
              C.CONTRACT_MISMATCH,
              "Executed selection page differs from pinned snapshot",
            );
          }
        }

        return {
          productIds: result.productIds,
          hasMore: result.hasMore,
          nextCursor: result.nextCursor,
          generationId: result.generationId,
          coverageRevision: result.coverageRevision,
          totalCount: result.filteredCount,
          shopId: query.binding.shopId,
          registryVersion: query.binding.registryVersion,
          definitionRevisions: validated.definitionRevisions,
          filterAst: validated.ast,
          filterFingerprint: validated.fingerprint,
        };
      });
    },
  });
  return service;
}
