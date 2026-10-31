/** Server-only composition. Creating this runtime never starts a Shopify writer. */
import {createHistoryRepository} from '../edit-history/history-repository.server.js';
import {createHistoryExecution} from '../edit-history/history-execution.server.js';
import {createUndoRepository} from '../edit-history/undo-repository.server.js';
import {createUndoService} from '../edit-history/undo-service.server.js';
import {createOperationWorker} from '../workers/operation.worker.js';
import {createJobDispatchService} from './job-dispatch.server.js';
export function createBulkExecutionRuntime({engineDatabase,historyDatabase,historyAdapters,executionProviders,undoProviders,
 shopifyClientFactory,approvalService,authorizeWrite,resolveShop,logger}={}){
 if(!historyAdapters||!executionProviders||!undoProviders)throw TypeError('Server-owned history, evidence and undo providers required');
 if([historyAdapters.authorizeHistoryRead,historyAdapters.authorizeHistoryValueRead].some(fn=>typeof fn!=='function'))throw TypeError('Independent history and sensitive-value read permissions required for undo');
 const historyRepository=createHistoryRepository({...historyAdapters,database:historyDatabase});
 const undoRepository=createUndoRepository({database:historyDatabase,historyRepository,resolveTenant:historyAdapters.resolveTenant,
  authorityRelations:historyAdapters.authorityRelations,authorizeUndo:undoProviders.authorizeUndo,resolveWorkerAuth:undoProviders.resolveWorkerAuth});
 const historyExecution=createHistoryExecution({...executionProviders,historyRepository,undoRepository});
 const dispatchService=createJobDispatchService({database:engineDatabase,approvalService,authorizeWrite,resolveShop});
 const undoService=createUndoService({repository:undoRepository,dispatchService,observeCurrent:undoProviders.observeCurrent,
  verifyCurrentObservation:undoProviders.verifyCurrentObservation,approveInverseExecution:undoProviders.approveInverseExecution});
 const worker=createOperationWorker({database:engineDatabase,historyExecution,undoRepository,shopifyClientFactory,approvalService,authorizeWrite,logger});
 return Object.freeze({worker,historyRepository,undoRepository,undoService,dispatchService});
}
