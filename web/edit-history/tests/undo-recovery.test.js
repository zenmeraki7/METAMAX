import test from 'node:test';
import assert from 'node:assert/strict';
import {createUndoService} from '../undo-service.server.js';
import {createUndoRepository} from '../undo-repository.server.js';
import {createHistoryExecution} from '../history-execution.server.js';
test('undo service rejects caller-fabricated repository authority',()=>{
 assert.throws(()=>createUndoService({repository:{request(){},loadSource(){}}}),/Issued undo repository/);
});
test('undo storage and execution reject caller-fabricated journal authority',()=>{
 assert.throws(()=>createUndoRepository({historyRepository:{getSnapshot(){}}}),/Issued history repository/);
 assert.throws(()=>createHistoryExecution({historyRepository:{consumeDispatch(){}}}),/Issued history repository/);
});
