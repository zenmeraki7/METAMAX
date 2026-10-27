const BASE = "/api/shopify-data";

async function readResponse(response) {
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error ||
      payload?.message ||
      `Request failed (${response.status})`
    );
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid response from sync API");
  }

  return payload;
}

export async function fetchShopifyData({ signal } = {}) {
  const response = await fetch(`${BASE}/sources`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
    signal,
  });

  const payload = await readResponse(response);

  if (
    !Array.isArray(payload.sources) ||
    typeof payload.shopTimeZone !== "string"
  ) {
    throw new Error("Invalid Shopify data response");
  }

  return payload;
}

export async function requestShopifyRefresh(sourceId = null) {
  const response = await fetch(`${BASE}/refresh`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sourceId,
    }),
  });

  const payload = await readResponse(response);

  if (
    typeof payload.jobId !== "string" ||
    !payload.jobId
  ) {
    throw new Error(
      "Refresh API did not return a confirmed job ID"
    );
  }

  return payload;
}
