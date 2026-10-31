# History security, value protection and 30-day retention

Implemented for the History Contract V3 repository. New history values are
encrypted; reads default to redaction; database roles are checked on every
connection acquisition; retention and uninstall work use bounded, durable
maintenance. No live migration, credential change, secret creation or Shopify
dispatch activation is performed by this implementation.

Active prerequisites are V1, its V2 upgrade, the multi-resource integrity
migration and `20261030130000_edit_history_mutation_requests`. The pending
security/retention migration follows them; no applied V1/V2 file was changed.

## Database boundary

`20261030150000_history_security_retention` requires a migration administrator
able to administer roles. It creates four NOLOGIN groups:

| Role | Purpose |
| --- | --- |
| `metamax_history_runtime` | Read/insert history and update only lifecycle columns. Cannot delete, truncate, alter triggers, change legal holds/retention settings, or run maintenance. |
| `metamax_history_maintenance` | Read bounded maintenance metadata and execute fixed encryption/purge functions. No direct INSERT/UPDATE/DELETE rights. |
| `metamax_history_privacy` | Execute the shop-redaction enqueue function; no direct history table access. |
| `metamax_history_owner` | Private NOLOGIN function owner. Never grant this role to an application login. |

Assign separate non-owner LOGINs to the first three groups using administrator
credentials and a secret manager. Migration ownership is intentionally rejected
for runtime use. Do not reuse the deployment DATABASE_URL as the history pool.
The administrator retains private function-owner membership for maintenance of
the schema; application credentials must not inherit or SET ROLE into it.

`database-security.server.js` checks current_user, session_user and all transitively
reachable roles, including permissions reachable via SET ROLE. Checks include
superuser/CREATEDB/CREATEROLE/replication/BYPASSRLS, dangerous built-in roles,
database CREATE/TEMP, schema CREATE, ownership, effective PUBLIC/table/column
privileges, required minimum grants and callable function owner/search_path/exact
argument signatures. Unknown history tables, extra grants or missing required
permissions fail closed. Grants are not cached between repository calls.

The verifier also rejects access to unrelated application relations and callable
SECURITY DEFINER functions outside history. Trusted backend receipt/plan stores
must be registered explicitly through the repository's `authorityRelations`
option (`schema`, `table`, optional inert `lockColumn`); this is a static backend
registry, never request input. Only SELECT and the designated lock column may
be granted. The deployment CLI accepts the same registry through
HISTORY_AUTHORITY_RELATIONS_JSON. Maintenance/privacy roles cannot use this
exception. Role graphs and external-access enumeration have strict bounds.

Engine SELECT FOR UPDATE/SHARE requires UPDATE privilege on at least one column.
The migration adds an inert `_history_lock` column to the ten locked Mirror
tables, and grants UPDATE only on that column. The history role can retain the
existing verified locks without permission to modify engine leases/fences,
approvals, installation identity, source snapshots or catalog values. These
internal columns are not registered fields or browser-selectable SQL mappings.

The migration revokes PUBLIC access to history tables/functions, PUBLIC CREATE
on the public schema, and PUBLIC TEMP on this database. Other services needing
temporary tables must receive explicit reviewed grants. This is a deployment
change requiring administrator review, not something applied on startup.

Read-only deployment checks, from `web/`:

```text
npm run history:verify-security -- runtime
npm run history:verify-security -- maintenance
npm run history:verify-security -- privacy
```

They use HISTORY_DATABASE_URL, HISTORY_MAINTENANCE_DATABASE_URL and
HISTORY_PRIVACY_DATABASE_URL respectively. Output contains profile, verification
result and generic finding codes, never URLs/passwords or raw database errors.
Missing dedicated credentials fail verification rather than falling back to the
general application database. Production credentials have not been supplied or
verified in this task; the runtime check currently reports HISTORY_DATABASE_URL
as configuration-required.

## Encryption and reads

`history-value-protection.server.js` treats **every VALUE snapshot as sensitive**
by default, including null/false/list values and BEFORE/OBSERVED_AFTER snapshots.
AES-256-GCM uses a fresh random nonce, a 256-bit key and authenticated associated
data binding tenant/installation, operation/change/snapshot IDs, kind, resource,
field, fingerprints and key reference. HKDF separates installations even when
the configured master key is shared. Ciphertext goes into encrypted_value;
value_json is NULL. Keys are never stored in database rows or logs. Missing keys,
wrong scopes, tampering and unsupported payloads fail closed without plaintext
fallback. ABSENT has no value payload.

Construct an issued valueProtection using a trusted server key resolver, or use
`historyValueKeyring` with HISTORY_ENCRYPTION_ACTIVE_KEY_ID and a secret-manager
HISTORY_ENCRYPTION_KEYS_JSON mapping opaque key IDs to canonical base64 32-byte
keys. Keep old IDs available while their ciphertext remains retained. Resolver
callbacks receive short-lived, read-only transaction clients and AbortSignal;
timeouts and errors are sanitized. Configure bounded key lookup/cache behavior
server-side; keys and key-provider selection never come from HTTP bodies.

The existing read_snapshot permission grants metadata access. Revealing values
additionally requires `authorizeHistoryValueRead`, returning literal true for
the current authenticated tenant, resource, field and `reveal_snapshot_value`
action. This is checked again after decryption. Without it, getSnapshot returns
`{ ...request, redacted: true, snapshot: null }`, without reading the key. List
APIs contain no before/after values. A reveal response contains `redacted:false`
and the verified V3 snapshot. No UI or browser flag can grant reveal authority.

The storage CHECK is NOT VALID so it can protect new writes immediately while
preserving existing plaintext rows for controlled conversion. Maintenance locks
one operation and at most 25 legacy rows per batch, validates V3 content/linkage,
encrypts without changing IDs/fingerprints, and conditionally replaces only the
storage representation through a restricted function. Invalid legacy content is
marked encryption_review_required and skipped rather than repaired by trusting
its claimed digest. Ordinary roles cannot perform this conversion.

This protects the edit_history snapshot store. Existing Mirror snapshots,
execution-plan/receipt stores, exported files, secret-manager policies and
backups require their own access/encryption/retention controls. The repository
does not claim to erase those independent stores or all app data.

## Retention and privacy

Default history retention is **30 days**. New operations receive retained_until;
existing NULL deadlines use created_at + 30 days. Ordinary expiry purges terminal
operations only and does not purge a live executor. Legal holds always prevent
purging and produce review-required privacy status. The runtime role cannot
change deadlines, holds or maintenance state.

The maintenance function selects/locks one eligible operation with SKIP LOCKED,
marks it as purging, then deletes at most 500 dependent rows per transaction in
FK-safe order. It commits progress between batches. Reads and further admission
exclude purging operations immediately. A restart resumes from durable rows;
the function never calls Shopify or reclassifies an uncertain mutation. A final
minimal purge receipt contains an operation ID, scope digest, reason and time,
not history values; these audit receipts expire after another 30 days. Completed
privacy scopes are removed once no history remains, so plaintext shop identifiers
do not accumulate indefinitely in the cleanup queue. Metadata cleanup is also
bounded. Deletion failures persist bounded exponential backoff and
enter purge_review_required after eight attempts. Legal holds and review states
require operator action; they are never reported as successful erasure.

APP_UNINSTALLED remains behind Shopify's official raw-body/HMAC webhook
middleware. The same transaction that tombstones the installation captures an
immutable uninstall scope, cancels/fences its history execution/undo commands,
and clears recovery claims without asserting FAILED_NO_WRITE. Sessions are
removed by the established handler. Uninstall scopes become due after 30 days.

SHOP_REDACT queues deletion of old uninstalled scopes immediately (subject to
legal holds), independently of the ordinary retention clock. It does not
tombstone a current active reinstall, cancel its jobs, erase its history or
delete its sessions. Duplicate delivery is idempotent. When configured,
HISTORY_PRIVACY_DATABASE_URL composes a separately verified privacy service into
the authenticated webhook handler; the webhook is acknowledged only after the
privacy request is durably queued. The existing main-transaction path remains
available for compatibility; it is not certified as a least-privilege privacy
connection. Secured rollout requires the dedicated privacy credentials.

## Worker configuration and rollout

`index.js` starts the maintenance runtime only with
HISTORY_MAINTENANCE_ENABLED=true. It requires a separately verified maintenance
URL, dedicated privacy URL and keyring. A serial timer performs bounded purge/backfill batches, uses
capped retry delay, and waits for in-flight work before closing keys/connections
on shutdown. With only HISTORY_PRIVACY_DATABASE_URL set, the runtime wires the
privacy service without starting cleanup or requiring an encryption keyring.
Neither mode creates a Shopify mutation writer.

Apply reviewed migrations, provision restricted logins and encryption keys,
run all three deployment checks, then enable the worker. Backfill existing
plaintext and inspect encryption/retention review queues. Configure backup and
source-store retention separately. Production activation remains disabled here.

Official webhook requirements were checked using the
[Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) against
[Shopify privacy webhook guidance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance).

## Local verification

| Suite | Result |
| --- | --- |
| Backend `npm test` | 1,027 passed, no failures, one existing TODO |
| Fresh PostgreSQL history migration/repository | 76 passed |
| V1/V2 PostgreSQL upgrade/history repository | 77 passed |
| Complete PostgreSQL migration/schema chain | 144 passed |

PostgreSQL tests use disposable databases and genuine restricted LOGIN roles.
They cover inherited/PUBLIC/external privilege escalation, ciphertext tampering,
reveal revocation, missing keys, legacy encryption quarantine, bounded purge and
retry exhaustion, legal holds, and uninstall/redaction across reinstallations.
They do not constitute live deployment verification or approval to dispatch.
