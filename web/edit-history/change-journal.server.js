// Compatibility entry point; the history repository owns all persistence.
export { createHistoryRepository as createChangeJournalRepository } from './history-repository.server.js';
