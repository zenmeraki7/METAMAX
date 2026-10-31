# Saved filters, imports, exports and merchant authorization

These source changes address CAT-019 through CAT-028. Migration
`web/prisma/migrations/20261029000900_export_import_boundaries/migration.sql`
creates durable import previews, fenced export jobs and an active read-lease
retention guard. It has been tested in disposable PostgreSQL, not deployed to an
application database. Prisma models are in `web/prisma/io.prisma`.

## Trusted merchant identity

Field authorization requires `database.query`, `resolveShop` and
`getShopScopes`. The backend supplies these capabilities at construction.
`resolveShop` must verify an opaque authenticated context against the current
stored session. `getShopScopes(shopId, authContext)` must reload current trusted
session or installation data; it returns a scope string or array, never browser
claims. The production filter bootstrap uses `resolveSession` for this purpose.
Every decision verifies identity, active installation, operation, field policy
and current scopes. Identity is checked again after resolving scopes.

`defaultScopes`, ambient `sessionStorage` configuration and direct use of
`authContext.session.scope` are unsupported. There is no worker bypass in this
merchant interface. A worker needs a separately authorized execution capability;
passing `{system:true}` or a shop identifier cannot grant merchant authority.

## Saved filters

Save and load require a semantic compiler, trusted dataset resolver and verified
merchant context. Stored recipes are parsed and semantically revalidated on
every load against current permissions and published coverage. Browser shop IDs,
SQL clients and compiler overrides are rejected. Structural fingerprints are
recipe identities, not authorization grants.

`loadForExecution` is a separate worker entry point. Its injected
`resolveSystemExecution` must authorize the specific filter operation and return
a matching shop plus a context accepted by the genuine authentication resolver.
It cannot manufacture authority by wrapping a shop string in an object.

## Import preparation and approval

Import preparation accepts 1–1,000 records with a combined JSON limit of 1 MiB.
Each row has exactly one product identity (`id` or `shopify_id`). IDs resolve
inside the authenticated shop and the protected selection transaction; all
targets must resolve to distinct products. There is no placeholder snapshot.

Fields resolve through the genuine Field Engine. Values undergo SET operand
normalization and final-value validation, with read-only fields, invalid values
and unsupported policies rejected. The initial implementation supports product
SET fields; variant and inventory edits require additional execution adapters.
`handle` is an editable field, not an implicit target identity.

`createImportPreview` always persists a DRAFT with immutable normalized rows,
selection membership, field registry pins and a canonical preview hash.
Caller-supplied `approvedBy`, shop IDs or SQL clients are rejected. Preparation
never approves an operation.

After displaying the persisted preview, the application separately calls
`approveImportPreview({authContext, previewId, expectedPreviewHash})`.
The backend resolves the current merchant actor, checks expiry/hash, revalidates
field permissions and records approval atomically. The generic approval service
also requires the import-specific actor and authorization capabilities, verifies
the persisted preview and derives instructions from it. A caller actor string or
replacement payload cannot approve an import. Repeated approval returns the same
contract. This change does not add an import execution worker; the bulk-edit
worker does not execute import contracts.

## Export execution and budgets

`createExportJob({authContext, commandId, format})` accepts exactly `csv` or
`jsonl`. An approved export command determines the exact selection snapshot,
generation, coverage and columns. The service checks active installation evidence
from a successful catalog import, verified physical columns, published coverage,
current field permissions and injected export authorization.

Pages contain at most 500 products, scoped by shop, pinned generation and approved
membership. There is no caller-controlled `chunkSize`. Server construction sets
`maxRows` (default 100,000, maximum 1,000,000) and `maxBytes` (default 256 MiB,
maximum 1 GiB). Both must be positive safe integers. The service rejects output
beyond either limit before writing the offending row/chunk. Artifact retention
must be a safe integer between 60,000 and 86,400,000 milliseconds inclusive.
Unsupported per-request parameters fail closed.

An active one-hour generation read lease prevents retirement or deletion. It is
renewed with progress. Current approval, authorization and retention are checked
on every page and before finalization. Expired retention fails closed and needs
fresh authorized work rather than silently reviving an old grant.

The writer must implement `begin`, `write`, `commit` and `abort`. It stages a
temporary object and returns a durable completion receipt with the exact object
key, byte count and SHA-256. Only verified completion permits artifact metadata
and READY state to commit together. Upload I/O runs outside database transactions.
The host must supply real durable storage and remove abandoned temporary objects.

Each attempt has a lease, monotonic fence and distinct final object key.
Cancellation invalidates the fence. Retries persist bounded backoff, with eight
attempts maximum. A superseded attempt can delete only its own objects. Recovery
from a lost final COMMIT response preserves an already registered artifact.

CSV and JSONL share eleven columns, including publication time and tags. CSV has
a header, quotes every cell and prefixes formula-like cells with an apostrophe.
That intentional CSV transformation protects spreadsheet consumers; JSONL
preserves the underlying values for exact data interchange.

## Integration and verification

These are backend capabilities. HTTP controllers and background workers must
provide genuine authentication, current authorization, verified merchant actors
and a durable writer before exposing these workflows. No public import/export
endpoint or live storage deployment is introduced here.

`npm --prefix web test` verifies service and route contracts. The disposable
`npm --prefix web run test:operations` suite applies migrations and exercises real
PostgreSQL selection/approval/export behavior with filesystem-backed durable
writes, row/byte budgets, revocation, failed uploads, cancellation, concurrent
takeover and uncertain final commits. It does not use the application database
or send Shopify mutations.
