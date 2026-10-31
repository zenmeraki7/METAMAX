# Product catalog refresh protocol

The frontend requests a bounded product page from `/api/mirror/products` on
initial load, query/page changes and explicit Refresh. Subsequent automatic
requests use `/api/mirror/status`, without product rows or active filter values.

A compatible status response has:

```json
{
  "snapshotId": "published-snapshot-id",
  "publishedRevision": "opaque-revision-token",
  "syncStatus": "READY"
}
```

Product-page responses must include the same `snapshotId` and `publishedRevision`
from the consistent read that produced the rows. `publishedRevision` is a bounded,
nonempty string or a nonnegative safe integer. Before first publication,
`snapshotId` and `publishedRevision` may both be null.

The revision must change whenever merchant-visible published data changes,
including webhook/inventory updates within the same snapshot. A snapshot ID or
last full-import timestamp alone is insufficient. The backend must maintain this
checkpoint atomically with its durable published writes; the frontend does not
invent a revision or infer one from row counts.

Status is checked every 30 seconds when READY, otherwise every 5 seconds. A
changed snapshot/revision triggers a product-page read; a new snapshot on a later
page restarts pagination first. Sync-status-only changes preserve row references.
Identical catalog responses preserve the entire state object; changed metadata
with identical rows preserves the products array.

Requests remain serial, with bounded retry/backoff for temporary errors and no
automatic retry of authentication/other nonretryable client failures. Hiding the
page clears timers and aborts the current request. Returning to it starts one
check after any canceled request settles. Query changes and unmount also abort
requests and prevent stale responses from updating state.

If status is unavailable (404/405/501), malformed, or the catalog response lacks
the shared revision token, automatic refresh stops. There is no fallback loop of
full product requests. Existing rows remain available and the UI points merchants
to explicit Refresh.

The current minimal Express template implements neither mirror endpoint. This
change prepares the frontend contract without restoring the removed catalog
backend. Mocked interaction tests verify request patterns and state retention;
live network/rendering cost has not been measured.

## Failure handling

Service errors explicitly distinguish `network`, `http`, and `contract` failures.
Only errors marked `retryable: true` can schedule automatic retries. HTTP-success
responses with invalid JSON or invalid catalog/status schemas carry
`CATALOG_RESPONSE_INVALID`, their original HTTP status and `retryable: false`.
Unexpected/unclassified errors do not enter a retry loop either.

Contract failures leave previously valid rows intact for the current query,
show a recoverable error, and stop timers/visibility-triggered retries. The
merchant can use Try again or Refresh to start a fresh attempt. Query changes
still clear the previous query's rows so stale results are not presented under
new filters. Network failures and HTTP 429/5xx responses retain bounded retries;
invalid JSON in an HTTP error body does not hide that HTTP retry classification.
