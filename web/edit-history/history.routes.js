import {historyOperationPresentation,historyStatusPresentation} from '../shared/history-operation-contract.js';
/**
 * METAMAX — Edit History Express Routes
 *
 * Exposes /api/history and /api/history/:id over authenticated HTTP sessions,
 * through installation-scoped, independently authorized repository reads.
 */

import express from "express";
import { createHistoryReadService } from "./history-read.server.js";
import { HistoryContractError, HISTORY_ERROR_CODES as C } from "./history-contract.js";

function formatDuration(start, end) {
  if (!start || !end) return null;
  const ms = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSecs = seconds % 60;
  return `${minutes}m ${remainingSecs}s`;
}

function mapStatus(rawStatus, logger) {
  const status=historyStatusPresentation(rawStatus);
  if(status==='Unknown'){
    try { logger?.error?.({code:'HISTORY_STATUS_UNRECOGNIZED'},'Unknown history operation state'); } catch {}
  }
  return status;
}

function mapType(rawKind) {return historyOperationPresentation(rawKind).type;}

function boundedQuery(query, defaultLimit) {
  if (Object.keys(query).some(key => !["limit", "cursor"].includes(key)) ||
      Object.values(query).some(value => typeof value !== "string")) {
    throw new HistoryContractError(C.INVALID_INPUT, "Invalid history query");
  }
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
  if (query.limit !== undefined && !/^[1-9][0-9]{0,2}$/.test(query.limit) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new HistoryContractError(C.INVALID_INPUT, "Invalid history page size");
  }
  return {limit, ...(query.cursor === undefined ? {} : {cursor:query.cursor})};
}
function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new HistoryContractError(C.LIMIT_EXCEEDED, "History count exceeds response contract");
  return number;
}
function summary(operation, logger) {
  return {id:operation.operationId,
    title:historyOperationPresentation(operation.operationKind).title,
    type:mapType(operation.operationKind),status:mapStatus(operation.state,logger),
    processedCount:count(operation.counts.verified),totalCount:count(operation.counts.recorded),
    countUnit:'fields',
    failedCount:count(operation.counts.failed),uncertainCount:count(operation.counts.uncertain),
    startedAt:operation.createdAt,duration:formatDuration(operation.createdAt,operation.completedAt),user:"Merchant Admin"};
}

/** GET list/detail/change pages accept bounded cursor queries and opaque current
 * request authority. The read service independently enforces installation and
 * read permission. Outputs contain counts/metadata, never snapshot values.
 * No durable writes: Partial is distinct from Failed; unsupported states are
 * Unknown and emit a contract-mismatch diagnostic. Counts remain field counts.
 */
export function createHistoryRouter({database,authentication,logger=console,
  cursorSecret=process.env.HISTORY_CURSOR_SECRET || process.env.FILTER_CURSOR_SECRET || process.env.SHOPIFY_API_SECRET,
  historyReadService}={}) {
  const router = express.Router();
  const service = historyReadService ?? (database && cursorSecret
    ? createHistoryReadService({database,authentication,cursorSecret}) : null);
  router.use((_req,res,next) => {res.setHeader("Cache-Control","private, no-store");next();});
  function handle(action) {
    return async (req,res,next) => {
      try {
        const authContext = await authentication.authenticate(req);
        if (!authContext) return res.status(401).json({error:"UNAUTHENTICATED"});
        if (!service) return res.status(503).json({error:"HISTORY_UNAVAILABLE",retryable:true});
        const options = boundedQuery(req.query,action === "listChanges" ? 50 : 25);
        if (action === "getOperation" && Object.keys(req.query).length) {
          throw new HistoryContractError(C.INVALID_INPUT,"Operation detail does not accept query parameters");
        }
        const result = await service[action]({authContext,...options,
          ...(action === "listOperations" ? {} : {operationId:req.params.id})});
        if (action === "getOperation") {
          if (!result) return res.status(404).json({error:"OPERATION_NOT_FOUND"});
          return res.json({operation:{id:result.operationId,title:historyOperationPresentation(result.operationKind).title,type:mapType(result.operationKind),status:mapStatus(result.state,logger),countUnit:'fields',
            changesRecorded:count(result.counts.recorded),changesVerified:count(result.counts.verified),changesFailed:count(result.counts.failed),
            changesUncertain:count(result.counts.uncertain),
            createdAt:result.createdAt,completedAt:result.completedAt}});
        }
        const pageInfo={hasNextPage:result.nextCursor !== null,endCursor:result.nextCursor};
        return action === "listOperations"
          ? res.json({operations:result.items.map(item=>summary(item,logger)),pageInfo})
          : res.json({changes:result.items.map(item=>({id:item.changeId,resourceGid:item.resourceGid,fieldId:item.fieldId,
              mutationState:item.state,verificationState:item.verificationState,preparedAt:item.preparedAt})),pageInfo});
      } catch(error) {
        if (res.headersSent) return next(error);
        if (error instanceof HistoryContractError) return res.status(error.status).json({error:error.code});
        if (error?.code === "FIELD_PERMISSION_DENIED") return res.status(403).json({error:"HISTORY_UNAUTHORIZED"});
        logger.error?.({code:error.code},"History read failed");
        return res.status(503).json({error:"HISTORY_UNAVAILABLE",retryable:true});
      }
    };
  }
  router.get("/",handle("listOperations"));
  router.get("/:id",handle("getOperation"));
  router.get("/:id/changes",handle("listChanges"));
  return router;
}
