# Installed write capabilities and bulk execution heartbeat — 2026-10-31

## P0-05

`web/fields/write-capabilities.js` is the pure, immutable installed-writer contract (`product-set-v1`). It owns both directions of the product field mapping and the supported operation list. The installed journaled writer supports SET for title, handle, descriptionHtml, vendor, productType, status, tags and templateSuffix.

Field service write resolution rejects fields outside this contract, even when structural field policy and authorization would otherwise allow them. Structural normalization policies remain separate; normalization alone does not grant execution support. Import validation rejects unsupported fields before creating previews. Approvals validate ordinary bulk/scheduled updates and undo fields, and include the write capability version in the cryptographically frozen contract. Import preview hashes include the same version. Execution rejects missing or incompatible versions. Existing unversioned approvals need reapproval; they are not silently upgraded during execution.

The mutation instructions and journaled history writer consume the shared mapping. Generic future metafield and money-history unit tests explicitly isolate their fixture writer capability using module mocks; the installed writer's actual boundary has separate tests against every canonical field. No runtime override bypass was added.

## P0-06

The operation worker renews its lease during processing using a separate transaction. Renewal requires the exact shop, command, installation, fence and token, an active installation, RUNNING status, no cancellation and an unexpired lease. Renewal cannot revive an expired lease. Renewals do not overlap, have bounded wait times, and stop on all exits.

Lease loss or an uncertain renewal aborts the transport signal, blocks subsequent sends and local completion, and returns STALE_CLAIM. Final acknowledgment drains an in-flight renewal before its fenced transaction. Local monotonic deadlines protect against delayed heartbeat timers. In-flight sends are never retried by this heartbeat; the existing durable history/outcome recovery path remains responsible for uncertain remote outcomes. A transport may ignore cancellation, so database fencing and durable send admission remain essential.

Validation: `npm test` passed 1,103 tests. Regressions cover all canonical fields, incompatible capability versions, long items with renewals, nonoverlapping renewals, revoked/error/hung renewal, final-acknowledgment races and an aborted in-flight transport. PostgreSQL integration tests were not run; the local PostgreSQL/Docker runtime remains unavailable.
