# Sync progress notification

The app mounts one header popup above the routed pages. It discovers the current
installation's import through authenticated `GET /api/mirror/sync`, polls every
three seconds while active and every fifteen seconds while idle, and persists
across navigation. It can be collapsed; observed completion can be dismissed.
Historical successful runs do not display a completion notification on app load.

The endpoint joins the current shop installation, import job, phase execution,
tenant-bound ingestion run and generation. It returns no browser-selected tenant,
remote operation URL or credential. Responses use `private, no-store`.

Overall percentages are explicitly **estimated** phase weights: queued 0%,
starting 5%, waiting for Shopify 15%, ingesting 20–80%, reconciliation 85% and
publication 95%. Ingestion uses `processed_lines / expected_lines`, stored with
validated committed writes, with bigint-safe arithmetic. Unknown or zero totals
do not imply ingestion completeness. The popup separately shows saved export
record counts; these include product and variant records, not just products.

100% requires both a succeeded import and a published generation. Retry,
uncertainty, cancellation and review-required states are reported explicitly.
Polling failures preserve the last progress with a retry notice, never fabricate
completion, and back off up to sixty seconds. Requests have a deadline, do not
overlap, stop while hidden and are aborted on unmount.

Verification covers React rendering and polling behavior, HTTP authentication
and no-cache responses, bigint calculations, tenant isolation and a real
PostgreSQL import progressing from its initial phase to published completion.
Evidence: `.audit/sync-notification-{ui,backend,postgres}-tests.txt`.
