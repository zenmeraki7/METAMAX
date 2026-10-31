# Automatic mirror sync on installation

After Shopify's official Express OAuth callback verifies the request and stores
the session, the app calls `catalogImportService.onInstall()` before redirecting
the merchant. This commits installation authority and schedules an initial import
in PostgreSQL, or preserves pending intent while an old generation drains.
Export requests, ingestion, reconciliation and publication run in
the existing background phase worker, independently of the merchant's browser.

The production entry point already starts that worker when a configured database
passes storage verification. It checks for work every two seconds. No new
migration, queue service, browser credential or merchant button click is required.
Deploy/restart the backend with these source changes to enable the new hook.

## Durability and installation boundaries

- The shop comes from the SDK's verified session, reloaded from session storage.
  Query-string or request-body shop values cannot select the tenant.
- A persisted offline credential with product-read access is required for a new
  request. Workers continue to reload credentials before external operations.
- Scheduling uses the existing publication barrier and shop lock. Concurrent
  callbacks allocate one job/generation. The callback waits for the scheduling
  commit, not for the export; scheduling failure does not return the success
  redirect.
- Any existing import job for the current installation satisfies initial
  scheduling, including a succeeded, cancelled or exhausted job. Reauthorization
  does not reset retry limits. Explicit manual sync remains available.
- Installed shops without a current request form durable pending installation
  intent. The worker scans ten eligible shops per tick using rotating keyset
  selection; unavailable credentials cannot permanently hide later shops.
  A restarted worker can recreate scheduling without retaining an HTTP closure.
- The authenticated `/api/mirror/status` route also ensures initial scheduling.
  This repairs the session-storage/scheduling gap if the process exits between
  OAuth session persistence and the scheduling commit. Completed requests use a
  read-only scheduling lookup during polling, rather than the global write lock.
- Verified uninstall/redaction events mark the installation inactive and request
  cancellation. Receipt persistence and tenant fencing share a transaction;
  duplicate events do not delete credentials from a later installation.
- Only a new verified OAuth callback can reactivate an inactive shop. It rotates
  installation authority and removes the old local subscription observation
  cache; this does not change Shopify billing. A fresh initial request waits for
  the prior generation to be cleaned up. Unresolved cleanup remains blocked for
  recovery rather than publishing stale work.

Initial sync still follows the existing ingestion completeness, revision-safe
reconciliation, coverage verification and publication contracts. This feature
does not add datasets beyond the existing product/variant mirror contract.

## Verification

`web/mirror/integration/install-sync.js` runs against disposable PostgreSQL with
fixture Shopify responses. It covers concurrent callbacks, persisted phase jobs,
tenant isolation, a fresh worker publishing actual mirror rows, missing offline
credentials/scopes, terminal-job deduplication, uninstall/reinstall cleanup,
startup discovery, subscription-cache invalidation and duplicate uninstall
delivery after reinstall. HTTP tests additionally cover rejected OAuth, failed
scheduling, unavailable dependencies and authenticated status repair.

Evidence: `.audit/install-sync-backend-tests.txt` and
`.audit/install-sync-postgres-tests.txt`. A live merchant install/export was not
performed; the broader dispatch release assessment remains applicable.
