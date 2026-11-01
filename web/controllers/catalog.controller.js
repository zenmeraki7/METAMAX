import { FieldError, FIELD_ERROR_CODES as C } from "../fields/types.js";
import { describeFilterFailure } from "../filters/errors.js";
import { normalizePageSize } from "../filters/execute.js";

const condition = (field, operator, value) => ({
  kind: "condition",
  field,
  operator,
  ...(value === undefined ? {} : { value }),
});
const group = (operator, children) => ({ kind: "group", operator, children });
function invalid() {
  throw new FieldError(C.INVALID_VALUE, "Invalid catalog request");
}

/** Translate the existing toolbar contract into the shared, validated filter AST. */
export function catalogRequest(query = {}) {
  if (
    Object.keys(query).some(
      (key) =>
        !["search", "status", "limit", "cursor", "filters", "match"].includes(
          key,
        ),
    ) ||
    Object.values(query).some((value) => typeof value !== "string") ||
    Buffer.byteLength(JSON.stringify(query)) > 16384
  )
    invalid();
  const search = query.search ?? "",
    status = query.status ?? "ALL",
    match = query.match ?? "all";
  if (
    search.length > 200 ||
    !["ALL", "ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"].includes(status) ||
    !["all", "any"].includes(match)
  )
    invalid();
  if (query.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(query.limit))
    invalid();
  const pageSize = normalizePageSize(
    query.limit === undefined ? 25 : Number(query.limit),
  );
  if (
    query.cursor !== undefined &&
    (!query.cursor || query.cursor.length > 4096)
  )
    invalid();
  let filters;
  try {
    filters = query.filters === undefined ? [] : JSON.parse(query.filters);
  } catch {
    invalid();
  }
  if (!Array.isArray(filters) || filters.length > 10) invalid();
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
    )
      invalid();
    // Field identity, operator compatibility and operands are authorized by the
    // canonical registry and compiler, never by this HTTP translation layer.
    return condition(item.field, item.operator, item.value);
  });
  const children = [];
  if (search.trim())
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
  if (status !== "ALL")
    children.push(condition("product.status", "eq", status));
  if (advanced.length)
    children.push(group(match === "all" ? "AND" : "OR", advanced));
  if (!children.length) children.push(condition("product.id", "is_not_null"));
  return {
    filter: { version: 1, root: group("AND", children) },
    pageSize,
    ...(query.cursor ? { cursor: query.cursor } : {}),
  };
}

export function createCatalogController({
  authentication,
  compiler,
  executor,
  resolveDatasets,
  logger = console,
}) {
  function handle(mode) {
    return async (req, res, next) => {
      res.setHeader("Cache-Control", "private, no-store");
      try {
        const authContext = await authentication.authenticate(req);
        if (!authContext)
          return res.status(401).json({ error: "UNAUTHENTICATED" });
        const { filter, pageSize, cursor } = catalogRequest(
          mode === "status" ? {} : req.query,
        );
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
          pageSize: mode === "search" ? pageSize : 1,
          ...(cursor && mode === "search" ? { cursor } : {}),
          catalog: mode === "status" ? "status" : mode === "count" ? "count" : true,
        });
        const result = await executor.execute({ query, authContext });
        if (mode === "count")
          return res.json({ count: result.filteredCount, precision: "EXACT" });
        const metadata = {
          snapshotId: result.generationId,
          publishedRevision: result.coverageRevision,
          syncStatus: "READY",
        };
        if (mode === "status") return res.json(metadata);
        return res.json({
          ...metadata,
          products: result.products,
          summary: result.summary,
          filteredCount: result.filteredCount,
          pageInfo: {
            hasNextPage: result.hasMore,
            endCursor: result.nextCursor,
          },
        });
      } catch (error) {
        const failure = describeFilterFailure(error);
        logger.error?.(
          { code: failure.code, cause: error },
          "Catalog request failed",
        );
        if (res.headersSent) return next(error);
        return res
          .status(failure.status)
          .json({
            error: failure.code,
            message: failure.message,
            retryable: failure.retryable,
          });
      }
    };
  }
  return Object.freeze({
    search: handle("search"),
    status: handle("status"),
    count: handle("count"),
  });
}
