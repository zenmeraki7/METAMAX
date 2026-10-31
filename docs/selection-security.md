# Frozen all-matching selections

All modes, including EXPLICIT, require `authContext` and a mandatory trusted
`resolveShop` dependency. `createSelection` rejects a supplied `shopId`; the
resolver provides the tenant for every query and is checked again before reads
and before commit. Explicit product IDs are identifiers, never tenant authority.
Import previews forward their authentication context. Background schedules need
a trusted `getScheduleAuthContext` provider and cannot derive a grant from a
saved template's shop ID.

`createSelectionService` requires the catalog service's backend-only
`withSelectionSnapshot` capability for either all-matching mode. Missing services,
missing authentication, a missing filter, and caller-supplied transaction clients
are rejected. `withSelectionTransaction(options, callback)` instead supplies a
client from the verified selection transaction to a backend callback. The
scheduler saves its occurrence checkpoint through this callback; it cannot
substitute an unprotected client or open another independent snapshot.
To intentionally select the whole catalog, supply an explicit
validated match-all filter such as `product.id is_not_null`.

The catalog service authenticates the requested shop and captures the filter.
The executor opens one read/write repeatable-read transaction and acquires the
publication read barrier before any mirror read. Context lookup, live coverage
validation, every signed cursor page, ID mapping, exclusions and membership
writes all use this transaction. Coordinated publication, coverage and mirror
writers cannot change the target snapshot while it is being captured. Ordinary
filter execution still uses its own read-only transaction and accepts only
compiler-issued queries and authentication context.

Selection follows every cursor in pages of 100 and writes membership to its
DRAFT snapshot as it goes. Only one bounded product page is mapped in Node;
database uniqueness detects duplicates across pages. Every page must match the
authenticated shop, pinned generation and coverage revision, registry version,
definition revisions, normalized filter and compiler-issued fingerprint. Missing
IDs, changed identities, duplicate IDs, broken cursors and query failures abort
the operation. Selections over one million matching products fail explicitly;
they are never approved as truncated selections.

Both numeric internal IDs and Shopify product GIDs are accepted for exclusions.
Invalid exclusions are rejected, and supplied exclusions are honored for both
all-matching modes. Exclusions and ID mapping use the same tenant and generation.

The service inserts a DRAFT snapshot, writes its exact membership, then transitions
it to APPROVED with its selection hash and freeze time. Database triggers verify
membership counts and enforce immutability. The executor rechecks the session and
field authorization before committing. A page, membership, freeze or final
authorization failure rolls back the entire snapshot. Creation returns only
frozen snapshot metadata and count. `getSelectionItems` requires authentication
and returns at most 1,000 IDs per keyset page; the default is 100. No unbounded
membership-read API remains. Selection hashes stream database membership in
numeric BigInt order using canonical decimal IDs joined by commas. Equal IDs
compare as zero; existing stored snapshot hashes are not rewritten. Explicit
input and exclusion lists are capped at 10,000 IDs; all-matching membership can
reach one million, with a lower backend-supplied budget for scheduled work.
This approval fixes selection membership; downstream execution still
requires its own authorized execution contract.

Regression coverage lives in `web/services/selection.test.js` and
`web/mirror/integration/selection.js`. Run `npm test` and the isolated
`npm --prefix web run test:schema` / `test:postgres` suites.
