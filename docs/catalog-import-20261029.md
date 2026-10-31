# Durable catalog imports — 2026-10-29

The three gaps in `sync-verification-20261029.md` are addressed in source.

## Deployment and API

Apply `20261029000000_catalog_import_jobs` using the existing Prisma migration
workflow before restarting the backend. No live database was migrated by this
change. Startup verifies the new queue table and starts the import worker when
`DATABASE_URL` is configured. A missing migration fails startup clearly.

All endpoints run after Shopify's authenticated-session middleware and the
router's authentication check, before body parsing. The router owns its JSON
parser and mounts ahead of the app's general parser. The optional body schema
is `{ "type": "object", "properties": {}, "additionalProperties": false }`:
an absent body or `{}` is accepted; arrays, scalars, null, and all properties
are rejected. Import options are currently unsupported. Adding options requires
an explicit schema and service contract change; shops, URLs, filters, operation
IDs and counts cannot be overridden by a browser.

Nonempty bodies require `Content-Type: application/json` (UTF-8). Compressed
bodies are unsupported. The limit is 4096 bytes, including whitespace; excess
size returns 413 `IMPORT_REQUEST_TOO_LARGE`. Malformed JSON or schema violations
return 400 `INVALID_IMPORT_REQUEST`; unsupported media types, encodings or
charsets return 415 `IMPORT_UNSUPPORTED_MEDIA_TYPE`. Authentication failures
are returned before any parsing errors.

| Endpoint | Result |
| --- | --- |
| `POST /api/mirror/sync` | Returns 202 with a durable job. Repeated requests reuse the active job for that shop. |
| `GET /api/mirror/sync` | Returns 200 with `{data: job}` or `{data: null}` when there is no current import. Missing current state is not a 404. |
| `GET /api/mirror/sync/:id` | Returns the authenticated shop's job status, generation, attempts, retry time and last error. |
| `POST /api/mirror/sync/:id/cancel` | Persists cancellation and interrupts the local worker. Failed jobs can also be cancelled to clean up their staging generation. |

Status and cancellation return 200 with `{data: job}` on success, or 404
`IMPORT_NOT_FOUND` if the ID is absent from the authenticated shop. Enqueue
must return a job; an absent enqueue result is a 500 `IMPORT_INTERNAL_ERROR`.

Import IDs must be canonical lowercase UUID v4 strings, including standard
8-4-4-4-12 grouping, version 4 and RFC variant bits, matching both import
creation paths' `crypto.randomUUID()` output stored as TEXT. Invalid IDs return
400 before a job query. A valid ID grants no access: status and cancellation
still bind both the stored authenticated shop and import ID in SQL.

An active offline Shopify session with product-read access (`read_products` or
`write_products`) is required. Workers reload that credential and verify the
installation version for every API request and immediately before publication.
There is no browser-supplied Shopify client, credential, shop or result URL.

## Import and recovery contract

The PostgreSQL queue owns due scheduling, eight bounded attempts, exponential
backoff, a 60-second renewable lease, fencing and cancellation. Workers poll every
two seconds; each backend runs one import at a time, and database claims allow
multiple backends without processing the same job concurrently. Expired final
attempts are failed instead of remaining RUNNING forever.

The worker starts or resumes the existing fenced run, binds the export, polls its
owned operation and downloads the completed result directly into the streaming
importer. Downloads accept HTTPS Shopify/Shopifycloud, Google Storage or S3
result hosts, refuse redirects and forward no Shopify credential. Failed,
cancelled and expired exports never become empty catalog imports.

`expectedLines` is now an optional consistency assertion. The importer always
requires the persisted operation ID, its COMPLETED status and its exact remote
object count, including empty-store imports. Supplied counts cannot replace
that check. A fixed-size byte buffer enforces the line limit during decoding,
including unterminated lines; UTF-8 and CRLF may span transport chunks.

Committed chunk receipts remain authoritative during replay. Download failures
retain staging; another worker replays the same export and skips verified chunks.
Shutdown aborts transport and releases the lease without cancelling the durable
generation. Explicit cancellation first fences local state, then requests remote
cancellation; uncertain remote cancellation is retried durably.

After ingestion, the worker drains due dirty products through the existing
revision-safe reconciler. Its Shopify reader follows every variant cursor,
rejects partial responses, duplicate/non-advancing cursors and changing product
snapshots, and treats an authoritative null product as deletion. Pending retries
or dead-letter dirty rows block verification and publication. Operators can
inspect the job error and cancel failed staging before starting another import.

Coverage verification, expected-publication comparison, publication and marking
the job SUCCEEDED share one protected transaction. The expected pointer is
captured when the request is queued; a different publication cannot be silently
overwritten. A lost lease, uninstall, superseded installation, revoked scope,
pending mutation or cancellation prevents successful completion.

## Validation

Regression coverage is in `mirror/import-boundaries.test.js` and
`mirror/integration/catalog-import.js`. It covers early stream rejection,
completion-count bypasses, paginated rereads, authenticated HTTP routing,
shop isolation, exact real-database catalog writes, interruption and
restart, local and remote cancellation, competing claims, expired leases,
shutdown recovery, final authorization and automatic worker pickup.

The new product reader query is validated with the Shopify AI Toolkit against
Admin API 2026-10. The Prisma schema validates with the repository's Prisma 7.10.1
version. Real-database tests run on disposable local PostgreSQL, with fixture
Shopify responses and download streams. No live merchant export was requested.

Final checks: 674 backend tests passed (one existing TODO), 38 PostgreSQL
schema/integration tests passed, and 20 PostgreSQL filter regressions passed.
Prisma and the new Shopify query both validate. Evidence is recorded in
`.audit/sync-fix-{backend,schema,postgres,prisma,api-validation}.txt`.
