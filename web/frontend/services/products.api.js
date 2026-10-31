function responseContractError(message, status) {
  return Object.assign(new Error(message), {
    code: "CATALOG_RESPONSE_INVALID",
    kind: "contract",
    status,
    retryable: false,
  });
}

async function requestJson(url, signal, message) {
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (cause) {
    if (signal?.aborted || cause?.name === "AbortError") throw cause;
    throw Object.assign(new Error(message, { cause }), {
      code: "CATALOG_NETWORK_ERROR",
      kind: "network",
      retryable: true,
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch (cause) {
    if (signal?.aborted) throw cause;
    if (response.ok)
      throw responseContractError(
        "The catalog server returned invalid JSON. Try again.",
        response.status,
      );
  }
  if (!response.ok)
    throw Object.assign(new Error(message), {
      code: typeof payload?.error === "string" ? payload.error : payload?.error?.code,
      kind: "http",
      status: response.status,
      retryable: response.status >= 500 || response.status === 429,
    });
  return { payload, status: response.status };
}
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export async function fetchProductCatalog({
  search = "",
  status = "ALL",
  conditions = [],
  match = "all",
  cursor = "",
  signal,
} = {}) {
  const query = new URLSearchParams({
    search,
    status: status.toUpperCase(),
    limit: "25",
  });
  if (cursor) query.set("cursor", cursor);
  if (conditions.length) {
    const normalizedConditions = conditions.map((item) => ({
      ...item,
      operator: item.operator === "ne" ? "neq" : item.operator,
    }));
    query.set("filters", JSON.stringify(normalizedConditions));
    query.set("match", match);
  }
  const { payload, status: responseStatus } = await requestJson(
    `/api/mirror/products?${query}`,
    signal,
    "Could not load products. Try again.",
  );
  if (
    !record(payload) ||
    !Array.isArray(payload.products) ||
    payload.products.length > 25 ||
    payload.products.some(
      (product) =>
        !record(product) ||
        typeof product.id !== "string" ||
        !product.id ||
        !(product.title === null || typeof product.title === "string"),
    ) ||
    !(
      payload.snapshotId === null ||
      (typeof payload.snapshotId === "string" && payload.snapshotId.length > 0)
    ) ||
    typeof payload.syncStatus !== "string" ||
    !payload.syncStatus ||
    !record(payload.summary) ||
    !["productCount", "variantCount", "activeCount"].every((key) =>
      count(payload.summary[key]),
    ) ||
    !count(payload.filteredCount) ||
    typeof payload.pageInfo?.hasNextPage !== "boolean" ||
    (payload.pageInfo.hasNextPage &&
      (typeof payload.pageInfo.endCursor !== "string" ||
        !payload.pageInfo.endCursor))
  )
    throw responseContractError(
      "The catalog response was incomplete. Try again.",
      responseStatus,
    );
  return payload;
}

export function publishedRevision(payload) {
  const revision = payload?.publishedRevision;
  if (
    typeof revision === "string" &&
    revision.length > 0 &&
    revision.length <= 256
  )
    return revision;
  if (Number.isSafeInteger(revision) && revision >= 0) return String(revision);
  if (payload?.snapshotId === null && revision === null) return null;
  return undefined;
}

export async function fetchProductCatalogStatus({ signal } = {}) {
  let result;
  try {
    result = await requestJson(
      "/api/mirror/status",
      signal,
      "Could not check catalog updates. Try again.",
    );
  } catch (error) {
    if (error.kind === "http" && [404, 405, 501].includes(error.status))
      error.statusUnavailable = true;
    throw error;
  }
  const { payload, status } = result;
  if (
    !record(payload) ||
    typeof payload.syncStatus !== "string" ||
    !(
      payload.snapshotId === null ||
      (typeof payload.snapshotId === "string" && payload.snapshotId.length > 0)
    ) ||
    publishedRevision(payload) === undefined
  )
    throw responseContractError(
      "Catalog status does not provide a valid published revision. Try again.",
      status,
    );
  return payload;
}

// Keep row references stable when metadata changes and avoid replacing an
// identical response. Only compare the bounded (25-row) page, never a catalog.
export function retainCatalogData(previous, result) {
  if (!previous) return result;
  if (JSON.stringify(previous) === JSON.stringify(result)) return previous;
  return JSON.stringify(previous.products) === JSON.stringify(result.products)
    ? { ...result, products: previous.products }
    : result;
}
