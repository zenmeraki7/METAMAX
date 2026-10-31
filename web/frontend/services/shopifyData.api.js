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
  // Try /api/shopify-data/sources first
  try {
    const response = await fetch(`${BASE}/sources`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      signal,
    });

    if (response.ok) {
      const payload = await readResponse(response);
      if (Array.isArray(payload.sources) && typeof payload.shopTimeZone === "string") {
        return payload;
      }
    }
  } catch {
    // Fall back to checking mirror status
  }

  // Fallback: Query mirror status and compose active source status
  const statusRes = await fetch("/api/mirror/status", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  const mirror = await readResponse(statusRes);
  const isReady = mirror.syncStatus === "READY";

  return {
    shopTimeZone: "UTC",
    sources: [
      {
        id: "products",
        name: "Products & Variants",
        icon: "bag",
        syncType: "automatic",
        status: isReady ? "healthy" : "syncing",
        lastFullSyncAt: new Date().toISOString(),
      },
      {
        id: "collections",
        name: "Collections",
        icon: "layers",
        syncType: "automatic",
        status: isReady ? "healthy" : "syncing",
        lastFullSyncAt: new Date().toISOString(),
      },
      {
        id: "inventory",
        name: "Inventory Levels",
        icon: "box",
        syncType: "automatic",
        status: isReady ? "healthy" : "syncing",
        lastFullSyncAt: new Date().toISOString(),
      },
      {
        id: "metafields",
        name: "Metafield Definitions",
        icon: "receipt",
        syncType: "automatic",
        status: isReady ? "healthy" : "syncing",
        lastFullSyncAt: new Date().toISOString(),
      },
    ],
  };
}

export async function requestShopifyRefresh(sourceId = null) {
  // Trigger mirror sync via /api/mirror/sync
  const response = await fetch("/api/mirror/sync", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({}),
  });

  const payload = await readResponse(response);
  const jobId = payload?.data?.id || payload?.jobId;

  if (typeof jobId !== "string" || !jobId) {
    throw new Error("Refresh API did not return a confirmed job ID");
  }

  return { jobId };
}
