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
  const response=await fetch(`${BASE}/sources`,{method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'},signal});
  const payload=await readResponse(response);
  const statuses=['healthy','queued','running','failed','cancelled','unavailable'];
  if(!Array.isArray(payload.sources)||payload.sources.length>32||typeof payload.shopTimeZone!=='string'||payload.sources.some(source=>
    !source||typeof source.id!=='string'||typeof source.name!=='string'||!statuses.includes(source.status)||
    !(source.lastFullSyncAt===null||typeof source.lastFullSyncAt==='string'&&Number.isFinite(Date.parse(source.lastFullSyncAt)))))throw new Error('Invalid source status response');
  return payload;
}

export async function requestShopifyRefresh(sourceId = null) {
  if(sourceId!==null && sourceId!=="products")throw new Error("This data source is not available for refresh.");
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
