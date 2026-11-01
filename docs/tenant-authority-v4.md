# Tenant Authority V4 integration contract

Current operation-mode and deployment details are in [tenant-security-rollout-2026-10-31.md](tenant-security-rollout-2026-10-31.md). Catalog/filter preparation is WRITE because it extends retention; sync_sources.read is READ. The earlier read-only classification below is historical.

`web/security/tenant.server.js` implements the supplied opaque authority API. `assertInstallation(context, id, installationVersion)` requires both lifecycle values. A repository-wide search found no existing authority module or callers of the old two-argument API to migrate.

## Canonical installation representation

This repository stores `mirror.shops.installation_version` as a UUID text token, regenerated at reinstall, rather than a monotonic integer. The authority validates and compares that UUID without converting it to a number or inventing a counter. History adapters currently map this token to `installation_id`; an installation adapter using that existing convention must provide the token as both installationId and installationVersion. No installation schema migration was made.

## Operations and database modes

`web/security/tenant-policy.server.js` supplies frozen operation policies using existing operation names. Modes concern transaction effects, not whether Shopify field access is read-only.

| Operations | Mode | Reason |
|---|---|---|
| filter, catalog, audit | READ | Query/inspection paths |
| export | WRITE | Admission, retention leases, manifests, jobs and outbox records |
| preview | WRITE | Import preparation persists selection and preview records |
| import, bulk_edit, scheduled_edit, recurring_edit, undo, mutation | WRITE | Durable approval, execution, scheduling or mutation state |

Do not use the field-authorization service's read-only set as a database transaction mode registry. Separate future read-only export/preview metadata operations need their own explicit policies; do not reuse a WRITE operation with mode READ.

Worker policies default to an empty deny-all list. Trusted composition must configure the exact namespace, durable job kind and operation and provide claim-verification adapters. No arbitrary worker wildcard is installed.

## Verified Shopify authentication

Pass `createTenantAdminAuthenticator({sessionStorage})` from `web/middleware/shopify-auth.js` as authenticateAdmin. It works only after `createShopifyAuthMiddleware` has recorded request verification in its private WeakMap. It reloads the session and compares shop, session ID, identity kind and actor to the verified snapshot. Missing classification, absent online user identity, revocation and identity changes fail closed.

Offline `isOnline === false` yields SHOP with no actor. Online `isOnline === true` requires a valid associated_user.id and yields USER. Body/query/header identityKind and actorId values are ignored. No session tokens, credentials or mutable permission records enter the authority context. Classification does not grant permissions: authorizeAdminInTransaction remains mandatory.

Provider contract reference: [Shopify session storage](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md).

## Remaining composition boundary

The authority has not replaced existing HTTP/service/worker authorization. This repository has several protected database adapters, rather than the single DB gateway assumed by the supplied design. getActiveInstallation, verifyWorkerClaim, getInstallationInTransaction, verifyWorkerInTransaction and authorizeAdminInTransaction must be supplied by trusted bootstrap before adopting the new authority on a live route. They must use authoritative storage and the supplied active transaction, retain permission checks, RLS/session context as applicable, and existing dispatch fencing. Merely importing this module does not secure an existing query.

## Validation

JavaScript syntax checked. Eleven focused tests pass in `web/services/tenant-authority.test.js`; the full backend suite reports 1,060 passed and one pre-existing TODO. Tests cover capability provenance, lifecycle mismatch/reinstall, operation modes, legacy/duplicate policies, delimiter collisions, exact worker claims and revocation, required identity kind, verified SHOP/USER classification and browser spoofing.

Shopify AI Toolkit documentation search failed with fetch failed; the provider's session-storage documentation was consulted as fallback. No live Shopify authentication, Prisma integration, or PostgreSQL gateway integration was performed for this new authority module. Existing backend tests exercise the middleware with verified-provider fixtures, not real JWTs.
