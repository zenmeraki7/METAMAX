# Approval coordinates and canonical session policy

## P1-11

New approvals persist `contract.executionCoordinates` inside the existing immutable, hash-bound JSON contract. The versioned envelope records the authenticated shop's current installation version, snapshot ID and operation, logical operation and filter fingerprint, generation and coverage revision, mapping and resolved registry versions, field definition revisions, selection hash, mirror/source schema versions, installed field registry fingerprint, and installed writer/mapping capability fingerprints.

Coordinates come from tenant-scoped, locked database rows and installed server registries. Browser-supplied coordinates are rejected. Approval creation rejects an operation mismatch. The shared approved-contract getter verifies the contract hash and canonical bytes, then recomputes and compares every coordinate against current installation, snapshot, generation and installed capabilities. Dispatch, worker execution, history admission, import/export and Undo consumers already use this getter. Current permission and live coverage checks remain mandatory and separate from coordinate compatibility.

Existing approvals without this envelope, including legacy product writer approvals, fail closed and require reapproval. They are not upgraded or backfilled. Scheduled templates receive fresh coordinates when their occurrences are approved. No database migration is needed: existing database guards already make the approved JSON payload and canonical hash immutable.

## P1-12

`middleware/session-validation.js` owns the `server-session-v2` structural session policy. It requires a valid shop domain, nonblank session ID and access token. If supplied, online classification must be boolean. Online sessions require an expiry; every supplied expiry must be a finite, future `Date`. Nonexpiring offline sessions remain supported. Callers cannot disable credential checks through options.

HTTP middleware, filter authentication, installation guards, imports, exports, generation authority and catalog source adapters use this validator. The duplicate generation/catalog date coercion paths are removed. Sessions still must originate from official middleware/server storage. Session validity does not establish installation authority, staff permissions or a user identity; those checks remain at their respective boundaries. Catalog source permission checks now use the existing shared product-read policy, including online staff scopes.

The official [Shopify session-storage guide](https://github.com/Shopify/shopify-api-js/blob/main/packages/shopify-api/docs/guides/session-storage.md) describes the SDK's online session expiry metadata. Local policy tests exercise SDK `Session` instances as well as malformed stored objects.

## Verification

All 1,147 backend tests pass, including validly hashed but stale capability/coordinate cases, installation replacement, forged coordinate input, expired snapshots, malformed dates, online expiry and staff scope checks. PostgreSQL integration fixtures now create bound approvals; a database-backed reinstall regression was added. Those database integration cases remain unverified locally because `npm run test:schema` cannot start Docker (`spawnSync docker EPERM`). No database changes were deployed.
