import { Prisma } from "@prisma/client";
import { prisma } from "../../db/client.js";

const PRODUCT_ID = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;
const STATUSES = ["ALL", "ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"];
const invalid = () =>
  Object.assign(new Error("Invalid catalog filters or cursor"), {
    code: "INVALID_CATALOG_QUERY",
    status: 400,
  });
const zeroSummary = () => ({
  productCount: 0,
  variantCount: 0,
  activeCount: 0,
});

export function parseCatalogQuery(query = {}) {
  const { search = "", status = "ALL", limit = "25", cursor = "" } = query;
  if (
    [search, status, limit, cursor].some(
      (value) => typeof value !== "string"
    ) ||
    search.length > 200 ||
    !STATUSES.includes(status.toUpperCase()) ||
    !/^[1-9]\d?$|^100$/.test(limit) ||
    cursor.length > 2048
  )
    throw invalid();
  const filter = {
    search: search.trim(),
    status: status.toUpperCase(),
    limit: Number(limit),
    after: null,
  };
  if (cursor) {
    try {
      if (!/^[\w-]+$/.test(cursor)) throw invalid();
      const decoded = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8")
      );
      if (
        !PRODUCT_ID.test(decoded.after) ||
        typeof decoded.snapshotId !== "string" ||
        !decoded.snapshotId ||
        decoded.search !== filter.search ||
        decoded.status !== filter.status
      )
        throw invalid();
      filter.after = decoded;
    } catch {
      throw invalid();
    }
  }
  return filter;
}

const variantCount = Prisma.sql`jsonb_array_length(CASE WHEN jsonb_typeof("data"->'variants')='array' THEN "data"->'variants' ELSE '[]'::jsonb END)`;

// Every response uses one repeatable read view of the published pointer, rows,
// filters and counts. Staging and another installation's snapshots are invisible.
export async function readProductCatalog(
  shop,
  query = {},
  { db = prisma } = {}
) {
  const filter = parseCatalogQuery(query);
  return db.$transaction(
    async (tx) => {
      const store = await tx.shop.findUnique({
        where: { domain: shop },
        select: { status: true, generation: true, activeSnapshotId: true },
      });
      if (!store || store.status !== "ACTIVE") return null;
      const state = await tx.catalogSyncState.findUnique({
        where: { shop },
        select: { status: true },
      });
      const snapshotId = store.activeSnapshotId;
      const empty = {
        snapshotId: null,
        syncStatus: state?.status ?? "NOT_STARTED",
        lastSyncedAt: null,
        summary: zeroSummary(),
        filteredCount: 0,
        matchingVariantCount: 0,
        products: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      };
      if (!snapshotId) return empty;
      const snapshot = await tx.snapshotRun.findUnique({
        where: { id: snapshotId },
        select: {
          shop: true,
          generation: true,
          status: true,
          completedAt: true,
        },
      });
      if (
        snapshot?.shop !== shop ||
        snapshot.generation !== store.generation ||
        snapshot.status !== "COMPLETED"
      )
        throw Object.assign(new Error("Published catalog is unavailable"), {
          code: "CATALOG_UNAVAILABLE",
          status: 503,
        });
      if (filter.after && filter.after.snapshotId !== snapshotId)
        throw Object.assign(new Error("Catalog changed; restart pagination"), {
          code: "CATALOG_SNAPSHOT_CHANGED",
          status: 409,
        });
      const pattern = `%${filter.search.replace(/[\\%_]/g, "\\$&")}%`;
      const where = Prisma.sql`"runId"=${snapshotId}
      ${
        filter.status === "ALL"
          ? Prisma.empty
          : Prisma.sql`AND "data"->>'status'=${filter.status}`
      }
      ${
        !filter.search
          ? Prisma.empty
          : Prisma.sql`AND (
        "data"->>'title' ILIKE ${pattern} OR "data"->>'vendor' ILIKE ${pattern}
        OR "data"->>'productType' ILIKE ${pattern} OR "data"->>'handle' ILIKE ${pattern})`
      }`;
      const [summary] =
        await tx.$queryRaw`SELECT COUNT(*)::bigint AS "productCount",
      COALESCE(SUM(${variantCount}),0)::bigint AS "variantCount",
      COUNT(*) FILTER (WHERE "data"->>'status'='ACTIVE')::bigint AS "activeCount"
      FROM "SnapshotProduct" WHERE "runId"=${snapshotId}`;
      const [count] =
        await tx.$queryRaw`SELECT COUNT(*)::bigint AS total,
      COALESCE(SUM(${variantCount}),0)::bigint AS "matchingVariantCount"
      FROM "SnapshotProduct" WHERE ${where}`;
      const rows = await tx.$queryRaw`WITH page AS MATERIALIZED (
        SELECT "productId", "data" FROM "SnapshotProduct" WHERE ${where}
        ${
          filter.after
            ? Prisma.sql`AND "productId">${filter.after.after}`
            : Prisma.empty
        }
        ORDER BY "productId" ASC LIMIT ${filter.limit + 1}
      ) SELECT "productId" AS id,
      "data"->>'title' AS title, "data"->>'status' AS status,
      "data"->>'vendor' AS vendor, "data"->>'productType' AS "productType",
      "data"->'featuredImage'->>'url' AS image,
      CASE WHEN stock.items>0 THEN stock.quantity::text ELSE "data"->>'totalInventory' END AS "totalInventory",
      CASE WHEN stock.items>0 THEN to_jsonb(stock.tracked>0) ELSE "data"->'tracksInventory' END AS "tracksInventory",
      ${variantCount} AS "variantCount"
      FROM page p LEFT JOIN LATERAL (
        SELECT COUNT(DISTINCT i."id") AS items,
          COUNT(DISTINCT i."id") FILTER (WHERE i."tracked") AS tracked,
          COALESCE(SUM(q."quantity") FILTER (WHERE i."tracked"),0)::bigint AS quantity
        FROM "InventoryItem" i LEFT JOIN "InventoryLevel" l
          ON l."shop"=i."shop" AND l."snapshotId"=i."snapshotId" AND l."inventoryItemId"=i."id" AND l."isActive"
        LEFT JOIN "InventoryQuantity" q
          ON q."shop"=l."shop" AND q."snapshotId"=l."snapshotId" AND q."inventoryItemId"=l."inventoryItemId"
          AND q."locationId"=l."locationId" AND q."name"='available'
        WHERE i."shop"=${shop} AND i."snapshotId"=${snapshotId} AND EXISTS (
          SELECT 1 FROM "Variant" v WHERE v."shop"=${shop} AND v."snapshotId"=${snapshotId}
            AND v."productId"=p."productId" AND v."inventoryItemId"=i."id"
        )
      ) stock ON true ORDER BY "productId" ASC`;
      const hasNextPage = rows.length > filter.limit;
      const products = rows.slice(0, filter.limit).map((row) => ({
        ...row,
        title: row.title ?? "Untitled product",
        vendor: row.vendor ?? "",
        productType: row.productType ?? "",
        totalInventory:
          row.totalInventory !== null &&
          Number.isSafeInteger(Number(row.totalInventory))
            ? Number(row.totalInventory)
            : null,
        tracksInventory:
          typeof row.tracksInventory === "boolean" ? row.tracksInventory : null,
        variantCount: Number(row.variantCount),
      }));
      const endCursor = hasNextPage
        ? Buffer.from(
            JSON.stringify({
              snapshotId,
              after: products.at(-1).id,
              search: filter.search,
              status: filter.status,
            })
          ).toString("base64url")
        : null;
      return {
        snapshotId,
        syncStatus: state?.status ?? "READY",
        lastSyncedAt: snapshot.completedAt,
        summary: Object.fromEntries(
          Object.entries(summary).map(([key, value]) => [key, Number(value)])
        ),
        filteredCount: Number(count.total),
        matchingVariantCount: Number(count.matchingVariantCount ?? 0),
        products,
        pageInfo: { hasNextPage, endCursor },
      };
    },
    { isolationLevel: "RepeatableRead", maxWait: 2000, timeout: 10000 }
  );
}
