# Worker and history lifecycle fixes

## P0-07: lost ownership

The worker and history executor recognize stale execution/recovery claims and revoked installations. They return immediately, including when ownership is lost inside an exception probe or local completion recovery. They do not attempt another outcome write, recovery probe, or Shopify send using the stale claim.

## P0-08: durable finalization

Terminal command completion inserts `mirror.operation_finalizations` in the same transaction. History and Undo acknowledgment are independent durable phases. Failed, incomplete, or timed-out phases retain a sanitized error code and retry deadline; successful phases are not repeated. Eight attempts lead to `REVIEW_REQUIRED`. A separate task token, fence, lease, current installation and command fence protect acknowledgment. The operation supervisor runs reconciliation each tick and backfills bounded batches of historical terminal commands. These retries perform local finalization only and never replay a Shopify mutation.

Apply `20261031190000_operation_finalization` before deploying these workers. Monitor `RETRY` and `REVIEW_REQUIRED` tasks and their error codes. Exhausted or missing-lineage tasks require investigation; this implementation does not automatically erase or reset them.

## P1-09: resource-specific writers

The shared contract is now `resource-set-v2`. It supports the existing eight product SET fields plus five variant SET fields: price, compare-at price, barcode, taxable and inventory policy. Legacy `product-set-v1` approvals remain product-only. Inventory quantities, collections, metafields and other uninstalled resource operations remain rejected.

Variant approvals require an explicit policy, freeze a bounded count, and target all variants of the approved selected products in the pinned generation. Undo targets verified variants of the source command. Dispatch materializes the exact variant membership and rejects count changes. History admission requires the matching canonical field/resource, parent membership and complete variant coverage. The variant writer uses one `productVariantsBulkUpdate` invocation with `allowPartialUpdates:false`; reads and responses must match the exact variant and parent. The same history, dispatch consumption, verification and inverse execution paths cover both resources.

Authenticated transports must supply `readVariant`/`applyVariantMutation`, or a `request(query,{variables,signal})` function for the installed variant writer. There is no new automatic runtime or credential setup. Apply `20261031200000_variant_history` to permit exact ProductVariant identities in immutable Undo requests. Broader resource families require their own writer and admission contract before they can be enabled.

## P1-10: verified no-write

`recordVerifiedNoWrite` requires authenticated, attempt-bound evidence for every member and current execution ownership. A prepared request may finish without dispatch admission. An authorized request additionally requires its exact private handoff token/key, unconsumed token and dispatching members. A consumed handoff must use outcome recovery. The request, member states, counters and recovery tasks transition atomically to `FAILED_NO_WRITE`. A post-authorization observation conflict uses this transition without consuming the token or calling the writer.

## Validation

All 1,141 backend tests and four focused frontend contract tests pass. Backend regression and targeted tests cover stale exception handling, finalization failure/retry/fencing, typed writers, approval/materialization counts, and preflight conflicts. Shopify AI Toolkit validates the generated variant operations against API 2026-10. Prisma validation passes. PostgreSQL integration cases include handoff identity and consumed-token rejection, but could not run locally: the schema harness cannot start Docker (`spawnSync docker EPERM`). The two migrations have not been applied to a database.
