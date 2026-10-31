/** Server-owned transaction scope, never supplied by a filter request. */
import { AsyncLocalStorage } from "node:async_hooks";

const transactions = new AsyncLocalStorage();

export function withCoverageTransaction(client, callback) {
  if (typeof client?.query !== "function" || typeof callback !== "function") {
    throw new TypeError("Transaction client and coverage callback required");
  }
  return transactions.run(client, callback);
}

export function currentCoverageTransaction() {
  return transactions.getStore();
}
