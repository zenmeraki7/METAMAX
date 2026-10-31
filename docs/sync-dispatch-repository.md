# PostgreSQL dispatch repository

The current contract is documented in [Durable dispatch repository V3](sync-dispatch-v3.md).

V3 preserves the verified domain mappings and durable scheduling authority. It
adds evidence-backed delivery recovery, atomic worker consumption, bounded
exhaustion handling and scheduled operational monitoring. Apply migrations
through `20261029000500_dispatch_consumption_receipts` before deploying this code.

The installed-schema preflight remains documented in `sync-dispatch-lifecycle.md`.
The current release verdict and outstanding production blockers are recorded in
`dispatch-release-readiness.md`.
