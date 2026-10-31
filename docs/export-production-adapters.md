# Production export adapters

Export Contract V2 keeps its versions/error codes and the established retry
transitions. The enabled runtime uses `export_engine.jobs`, `parts`, `artifacts`,
`outbox`, `delivery_receipts` and `target_approvals`; the legacy admission API
remains available for existing consumers.

| Component | Implementation |
| --- | --- |
| Trusted preparation | `web/export/export-service.server.js` |
| Approved membership and projections | `web/export/export-source.server.js` |
| Transaction-bound Mirror lease verification | `web/mirror/publication-service.server.js` and `publication-repository.server.js` |
| Exact-version S3 evidence and serialization | `web/export/export-storage.server.js` |
| BullMQ evidence, dispatch, reconciliation and coordinator | `web/export/export-dispatch.server.js` |
| Fenced checkpoint replay, heartbeat, cancellation and recovery | `web/export/export-worker.server.js` |
| Production dependency composition and shutdown | `web/export/export-runtime.server.js`, `web/index.js` |
| Authenticated status, cancellation and private download | `web/export/export-control.routes.js`, `web/app.js` |

## Configuration

Apply migrations through `20261030000300_export_installation_history` using the
normal reviewed database deployment process. This code change does not deploy
migrations or modify a configured live database. Set:

```dotenv
EXPORTS_ENABLED=true
EXPORT_S3_BUCKET=your-private-versioned-bucket
EXPORT_S3_REGION=your-provider-region
# Omit endpoint for AWS S3; use HTTPS for a compatible provider.
EXPORT_S3_ENDPOINT=https://your-s3-endpoint
EXPORT_S3_FORCE_PATH_STYLE=true
EXPORT_S3_PREFIX=metamax-exports
REDIS_URL=redis://your-private-redis:6379
```

The AWS SDK uses its standard server credential chain (workload role or
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`). No
credentials are shipped to the browser. The S3 provider must support enabled
bucket versioning, exact-version GetObject, conditional `If-None-Match: *`
PutObject, and the bucket Public Access Block API with all four flags enabled.
No mutable-key, missing-version or privacy-check fallback is installed.

The worker identity needs GetBucketVersioning, GetBucketPublicAccessBlock,
PutObject and GetObjectVersion for the configured private bucket/prefix. It
does not delete object versions. Configure bucket lifecycle retention so
committed artifacts survive their recorded expiry and old unregistered attempt
objects can later be reclaimed. Server-side encryption can be enforced by the
bucket/provider policy. These bucket/account settings are not created by bootstrap.

Enabled startup checks migrated columns and immutable guards, verified physical
Field/Filter Engine bindings, S3 privacy/versioning, Redis readiness, and every
mandatory adapter. Failure stops startup instead of exposing partial export
execution. Unset/false `EXPORTS_ENABLED` leaves the other app features running
and returns authenticated HTTP 503 for export endpoints.

Production uses five new-admission attempts/minute per installation and the
repository's bounded shop/global execution limits. Idempotency replays consult
PostgreSQL first and do not consume another admission token. BullMQ producer
connections fail promptly while worker reconnects continue; see
[BullMQ connection guidance](https://docs.bullmq.io/guide/connections).

## Execution and authorization

Preparation materializes an approved server-side all-matching selection in a
consistent published generation. Requested projection and predicate fields are
validated by the genuine Field/Filter Engines before a private manifest brand
is issued. Projection and predicate registry fingerprints cover different field
sets, so each is pinned and revalidated independently. Shared generation,
installation, coverage, mapping, physical/source versions and overlapping
definition revisions must remain compatible.

The generation must have a completed catalog import for the current
installation. Reinstallation cannot relabel an older generation as newly
authorized. Installation IDs in export history remain immutable fences while
tenant foreign keys reference the shop identity; historical export rows do not
prevent the current installation version from rotating. The coordinator promptly
fails pending jobs from obsolete installations and releases their leases.

The dataset approval records the actual verified dataset union and frozen
selection hash. It is never reconstructed from a browser readiness flag. Every
page rechecks current session scopes, installation, physical mapping, field
definitions, predicate contract, live dataset coverage and the exact approved
membership. Projection SQL identifiers come exclusively from the canonical
server registry and verified physical schema. The checkpoint is the last
durably committed product ID plus EOF state; it is never an unverified worker
cursor. New job creation and acquisition of its exact Mirror read lease share
one PostgreSQL transaction.

The initial projection writer supports these installed canonical product fields:
`product.id`, `product.title`, `product.handle`, `product.status`, `product.vendor`,
`product.productType`, `product.createdAt`, `product.updatedAt`,
`product.publishedAt`, and `product.tags`. Other projections fail closed. Filter
support remains the existing trusted compiler's installed capabilities. The
selection engine's one-million-item and one-hour approval limits still apply;
expired approvals fail execution instead of silently retargeting another snapshot.

Intermediate S3 objects contain ordered JSONL cell arrays for every output
format. CSV, JSONL and XLSX finalization assembles those exact immutable parts.
Verification independently reads final bytes, counts rows, compares ordered
values/header/encoding policy against source parts, checks digest and size, and
binds the part-set hash. CSV protects spreadsheet formula prefixes; XLSX writes
text cells, never formula objects. Intermediate bytes and final package bytes
remain separate accounting contracts.

Generation verification and renewal also revalidate current execution
authorization inside the checkpoint/finalization transaction, after external
storage verification. A revoked scope cannot use an earlier page-read grant to
acknowledge a later checkpoint or artifact.

Each upload has an isolated job/fence/attempt key. A stale upload cannot overwrite
the immutable versions in committed checkpoints or register output after losing
its database fence. Recovery uses this namespace proof plus independent part
verification; it never interprets storage/Redis absence as proof of non-delivery.

## Queues, recovery and controls

Queue payloads contain only `{eventId}`. PostgreSQL resolves job, tenant,
installation and generation. A consumer durably records delivery observation,
then conditionally claims that exact QUEUED job with a fresh token/fence. Clean
or superseded deliveries return without reading products or writing storage.

The coordinator recovers expired execution/reconciliation ownership, protects
pending generations, releases verified due retries and terminal leases, promotes
waiting jobs, and dispatches/reconciles outbox events. Redis absence alone cannot
authorize retry. Redelivery requires positive proof of a still-queued, uncancelled
job with no active owner or registered artifact and verified exact generation.
Retained failed/completed scheduling tokens can be removed and replaced only
after that database eligibility check. Execution retries create fresh durable
events; queue retention is never the idempotency mechanism.

Cancellation aborts in-flight worker operations before the live fenced owner
acknowledges it. Expired owners are revoked by recovery. Shutdown stops the
coordinator, pauses queue intake, aborts/waits for active attempts, and closes
workers, queue and S3 clients. Uncertain commits are resolved from PostgreSQL;
registered artifacts are never deleted by a stale attempt.

Endpoints behind the existing Shopify verification middleware:

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/exports` | Trusted preparation and durable admission |
| GET | `/api/exports/:id` | Tenant-scoped progress without leases or storage keys |
| POST | `/api/exports/:id/cancel` | Request cancellation with an empty JSON body |
| GET | `/api/exports/:id/download` | Stream the private registered S3 version |

Downloads require a current authenticated installation and current field/scope
authorization, and enforce artifact expiry using PostgreSQL time. They do not
extend generation retention or treat old preparation as a reusable permission.

## Verification and remaining deployment checks

Run `npm --prefix web test`. Run isolated PostgreSQL tests with
`node web/scripts/test-filter-postgres.js --exports` using Docker or an explicit
`FILTER_POSTGRES_BIN` directory. The runner never reads the app's DATABASE_URL.
The integration suite exercises actual Field/Filter/Mirror services, frozen
selections, storage verification, delivery receipts and workers against real
PostgreSQL. Test-only S3 and queue transports hold actual serialized bytes;
verification receipts are produced by the production adapter code.

The suite covers CSV/JSONL/XLSX output, content substitution, current-scope
download denial, duplicate scheduling, checkpoint replay after failure, stale
ownership, cancellation, retries and concurrency. Live provider S3 permissions,
conditional-write behavior, bucket policies, lifecycle settings and a live
BullMQ/Redis connection still require deployment smoke tests. No live S3 bucket,
Redis queue, enabled runtime or database migration was deployed by this change.
