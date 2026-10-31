/**
 * METAMAX — Edit History Express Routes
 *
 * Exposes /api/history and /api/history/:id over authenticated HTTP sessions,
 * backed by PostgreSQL edit_history and mirror.job_commands tables.
 */

import express from "express";

function formatDuration(start, end) {
  if (!start || !end) return null;
  const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  return `${minutes}m ${remainingSecs}s`;
}

function mapStatus(rawStatus) {
  switch ((rawStatus || "").toUpperCase()) {
    case "SUCCEEDED":
    case "COMPLETED":
      return "Completed";
    case "RUNNING":
      return "In Progress";
    case "CANCELLED":
      return "Cancelled";
    case "FAILED":
      return "Failed";
    default:
      return "Pending";
  }
}

function mapType(rawKind) {
  switch ((rawKind || "").toLowerCase()) {
    case "undo":
      return "Undo";
    case "export":
      return "Export";
    case "import":
      return "Import";
    default:
      return "Edit";
  }
}

export function createHistoryRouter({ database, authentication, logger = console } = {}) {
  const router = express.Router();

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });

  const unavailable = (_req, res) =>
    res.status(503).json({
      error: "HISTORY_UNAVAILABLE",
      message: "History service is currently unavailable",
      retryable: true,
    });

  if (!database) {
    router.use(unavailable);
    return router;
  }

  // GET /: Paginated operation list for the authenticated shop
  router.get("/", async (req, res, next) => {
    try {
      const authContext = await authentication.authenticate(req);
      if (!authContext) {
        return res.status(401).json({ error: "UNAUTHENTICATED" });
      }

      const shopId = authContext.shopId || authContext.shop;
      if (!shopId) {
        return res.status(401).json({ error: "UNAUTHORIZED_TENANT" });
      }

      const limit = Math.min(Math.max(1, Number(req.query.limit) || 25), 100);
      const cursor = req.query.cursor ? String(req.query.cursor) : null;

      const params = [shopId, limit + 1];
      let cursorClause = "";
      if (cursor && /^\d{4}-\d{2}-\d{2}T/.test(cursor)) {
        params.push(cursor);
        cursorClause = `AND o.created_at < $3::timestamptz`;
      }

      const query = `
        SELECT 
          o.id,
          o.shop_id,
          o.operation_kind,
          o.operation_state,
          o.changes_recorded,
          o.changes_verified,
          o.changes_failed,
          o.created_at,
          o.completed_at,
          o.actor_reference,
          c.kind AS command_kind,
          c.status AS command_status,
          c.checkpoint
        FROM edit_history.operations o
        LEFT JOIN mirror.job_commands c ON c.shop_id = o.shop_id AND c.id = o.execution_job_id
        WHERE o.shop_id = $1
          AND o.purge_requested_at IS NULL
          ${cursorClause}
        ORDER BY o.created_at DESC
        LIMIT $2
      `;

      const result = await database.query(query, params);
      const hasMore = result.rows.length > limit;
      const visible = hasMore ? result.rows.slice(0, limit) : result.rows;

      const operations = visible.map(row => {
        const title = row.checkpoint?.title || 
          (row.operation_kind === "undo" ? "Undo Operation" : "Bulk Product Edit");
        return {
          id: String(row.id),
          title,
          type: mapType(row.command_kind || row.operation_kind),
          status: mapStatus(row.command_status || row.operation_state),
          processedCount: Number(row.changes_verified || 0),
          totalCount: Number(row.changes_recorded || 0),
          startedAt: row.created_at?.toISOString?.() || String(row.created_at),
          duration: formatDuration(row.created_at, row.completed_at),
          user: row.actor_reference || "Merchant Admin",
        };
      });

      const nextCursor = hasMore && visible.length > 0
        ? visible[visible.length - 1].created_at?.toISOString?.() || null
        : null;

      return res.json({
        operations,
        pageInfo: {
          hasNextPage: hasMore,
          endCursor: nextCursor,
        },
      });
    } catch (error) {
      logger.error?.({ error: error.message || error }, "Failed to fetch history operations");
      if (res.headersSent) return next(error);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: "Failed to load operation history" });
    }
  });

  // GET /:id: Operation details
  router.get("/:id", async (req, res, next) => {
    try {
      const authContext = await authentication.authenticate(req);
      if (!authContext) return res.status(401).json({ error: "UNAUTHENTICATED" });

      const shopId = authContext.shopId || authContext.shop;
      const operationId = req.params.id;

      const query = `
        SELECT o.*, c.status AS command_status, c.checkpoint
        FROM edit_history.operations o
        LEFT JOIN mirror.job_commands c ON c.shop_id = o.shop_id AND c.id = o.execution_job_id
        WHERE o.shop_id = $1 AND o.id = $2 AND o.purge_requested_at IS NULL
        LIMIT 1
      `;
      const result = await database.query(query, [shopId, operationId]);
      if (!result.rows.length) {
        return res.status(404).json({ error: "OPERATION_NOT_FOUND" });
      }

      const row = result.rows[0];
      return res.json({
        operation: {
          id: String(row.id),
          type: mapType(row.operation_kind),
          status: mapStatus(row.command_status || row.operation_state),
          changesRecorded: Number(row.changes_recorded || 0),
          changesVerified: Number(row.changes_verified || 0),
          changesFailed: Number(row.changes_failed || 0),
          createdAt: row.created_at,
          completedAt: row.completed_at,
        },
      });
    } catch (error) {
      if (res.headersSent) return next(error);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  // GET /:id/changes: Changes list
  router.get("/:id/changes", async (req, res, next) => {
    try {
      const authContext = await authentication.authenticate(req);
      if (!authContext) return res.status(401).json({ error: "UNAUTHENTICATED" });

      const shopId = authContext.shopId || authContext.shop;
      const operationId = req.params.id;
      const limit = Math.min(Math.max(1, Number(req.query.limit) || 50), 200);

      const query = `
        SELECT id, resource_gid, field_id, mutation_state, verification_state, prepared_at
        FROM edit_history.changes
        WHERE shop_id = $1 AND operation_id = $2
        ORDER BY prepared_at DESC, id DESC
        LIMIT $3
      `;
      const result = await database.query(query, [shopId, operationId, limit]);
      return res.json({
        changes: result.rows.map(r => ({
          id: String(r.id),
          resourceGid: r.resource_gid,
          fieldId: r.field_id,
          mutationState: r.mutation_state,
          verificationState: r.verification_state,
          preparedAt: r.prepared_at,
        })),
      });
    } catch (error) {
      if (res.headersSent) return next(error);
      return res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
    }
  });

  return router;
}
