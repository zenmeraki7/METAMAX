export async function fetchProductCatalog({
  search = "",
  status = "ALL",
  cursor = "",
  signal,
} = {}) {
  const query = new URLSearchParams({
    search,
    status: status.toUpperCase(),
    limit: "25",
  });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/mirror/products?${query}`, {
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(new Error("Could not load products. Try again."), {
      code: payload?.error,
      status: response.status,
    });
  if (
    !payload ||
    !Array.isArray(payload.products) ||
    typeof payload.syncStatus !== "string" ||
    !payload.summary ||
    typeof payload.filteredCount !== "number" ||
    typeof payload.pageInfo?.hasNextPage !== "boolean" ||
    (payload.pageInfo.hasNextPage &&
      typeof payload.pageInfo.endCursor !== "string")
  )
    throw Error("The catalog response was incomplete. Try again.");
  return payload;
}
