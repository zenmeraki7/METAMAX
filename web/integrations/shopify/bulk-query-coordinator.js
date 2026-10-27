// Shared durable bulk-query capacity per Shopify app/shop; no TTL releases.
const terminal = new Set(["COMPLETED", "FAILED", "CANCELED", "EXPIRED"]);
const error = (code, message) => Object.assign(new Error(message), { code });
export const BULK_QUERY_LIMIT = 5;
const token = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f]/.test(value);
const validId = id => typeof id === "string" && /^gid:\/\/shopify\/BulkOperation\/[1-9]\d*$/.test(id);
export function createBulkQueryCoordinator({ db, appId }) {
  if (!db || !token(appId)) throw new TypeError("A database and stable Shopify app identity are required");
  async function transaction(fn) {
    for (let attempt = 0; ; attempt++) {
      try { return await db.$transaction(fn, { maxWait: 5000, timeout: 10000 }); }
      catch (failure) { if (attempt >= 2 || !["P2002", "P2034"].includes(failure.code)) throw failure; }
    }
  }
  async function reserve({ shop, generation, key, consumer }) {
    if (typeof shop !== "string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
        !token(generation) || !token(key) || !["sync", "export"].includes(consumer))
      throw new TypeError("A trusted shop, generation, request key and consumer are required");
    return transaction(async tx => {
      const identity = `bulk-query:${appId}:${shop}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
      const shops = await tx.$queryRaw`SELECT "generation", "status", "installationVerified" FROM "Shop" WHERE "domain"=${shop} FOR SHARE`;
      if (shops[0]?.status !== "ACTIVE" || shops[0].installationVerified !== true || shops[0].generation !== generation)
        throw error("INSTALLATION_CHANGED", "Bulk launch installation is not active and verified");
      const where = { appId_shop_requestKey: { appId, shop, requestKey: key } };
      const existing = await tx.bulkQueryClaim.findUnique({ where });
      if (existing && existing.generation !== generation) throw error("INSTALLATION_CHANGED", "Bulk request belongs to another installation");
      if (existing && existing.state !== "REJECTED") return { claim: existing, fresh: false };
      // Older installation generations still occupy capacity until Shopify
      // proves their operations terminal. Reinstallation is not that proof.
      const occupied = await tx.bulkQueryClaim.findMany({ where: { appId, shop, slot: { not: null } }, select: { slot: true } });
      const used = new Set(occupied.map(row => row.slot));
      const slot = Array.from({ length: BULK_QUERY_LIMIT }, (_, i) => i).find(i => !used.has(i));
      if (slot === undefined) throw error("BULK_CAPACITY_UNAVAILABLE", "App/shop bulk query capacity is occupied");
      const data = { appId, shop, requestKey: key, generation, consumer, slot, state: "RESERVED", operationId: null };
      const claim = existing ? await tx.bulkQueryClaim.update({ where, data }) : await tx.bulkQueryClaim.create({ data });
      return { claim, fresh: true };
    });
  }
  async function launch(input) {
    if (typeof input.find !== "function" || typeof input.start !== "function") throw new TypeError("Recovery and launch adapters are required");
    const { claim, fresh } = await reserve(input);
    const where = { appId_shop_requestKey: { appId, shop: input.shop, requestKey: input.key } };
    if (claim.operationId) return claim.operationId;
    try {
      let id = await input.find();
      if (!id) {
        if (!fresh) throw error("BULK_LAUNCH_UNCERTAIN", "An earlier launch requires Shopify outcome verification");
        id = await input.start();
      }
      if (!validId(id)) throw error("BULK_LAUNCH_UNCERTAIN", "Shopify did not establish an operation identity");
      await db.bulkQueryClaim.update({ where, data: { state: "ACTIVE", operationId: id } });
      return id;
    } catch (failure) {
      await db.bulkQueryClaim.updateMany({ where: { appId, shop: input.shop, requestKey: input.key, operationId: null },
        data: failure.definitiveBulkRejection === true ? { state: "REJECTED", slot: null } : { state: "UNKNOWN" } });
      throw failure;
    }
  }
  async function complete({ shop, id, status }) {
    if (!validId(id) || !terminal.has(status)) throw new TypeError("A verified terminal Shopify operation is required");
    return db.bulkQueryClaim.updateMany({ where: { appId, shop, operationId: id }, data: { state: "RELEASED", slot: null } });
  }
  return Object.freeze({ launch, complete });
}
