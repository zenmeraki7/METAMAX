# CT-106–120: authority and lifecycle contracts

The execution authority is a normalized, immutable projection of a verified persisted approval. It is metadata, not a bearer permission grant. No browser-supplied authority object is accepted by approval, and each execution boundary reloads authoritative records and checks current permission appropriate to that phase.

| Normalized coordinate | Authoritative source |
| --- | --- |
| `contractVersion` | Server contract version 1 |
| `shopId` | Authenticated shop and persisted contract shop |
| `installationId` | Immutable `selection_snapshots.installation_version`, compared with the current shop for live execution |
| `operationKind` | Persisted contract operation; the history adapter maps engine operation names to history enums |
| `selectionSnapshotId` | Contract `snapshot_id`, backed by immutable selection membership |
| `generationId`, `coverageRevision`, `mappingVersion` | Persisted selection and independently loaded generation coordinates |
| `fieldRegistryVersion` | Installed canonical Field Engine registry version; the selection's resolved registry and definition revisions are also hashed |
| `fieldResolutionFingerprint` | Stable digest of approved field identities, installed and selection registries, definition revisions, mappings, normalization, constraints and operators |
| `mutationAdapterVersion` | Declared adapter ID, contract version, resource type, adapter revision, writer version and stable capability fingerprint |
| `approvalRevision` | Persisted `approval_revision`, also bound inside the canonical hashed coordinates |
| `approvedContractHash` | Verified persisted canonical contract hash, projected after hashing |
| `targetMode` | Persisted selection mode |
| `selectionHash` | Persisted approved membership hash |

The final contract hash cannot be embedded in the payload that it hashes. The stored hashed coordinates and immutable row headers together persist the complete authority; approval and retrieval return the normalized projection including the final hash. This avoids a self-referential hash. Approved write operands are stored canonically, and returned payloads and authority metadata are frozen.

Selection now returns the same `SelectionSnapshot` shape from creation, transaction callbacks and persisted reads. It contains `snapshotId`, `shopId`, `installationId`, `generationId`, coverage/mapping coordinates, operation, target mode, numeric `selectedCount`, selection hash, registry metadata and ISO timestamps. Database column aliases do not cross this service boundary. Frozen schedules consume this contract directly.

Merchant dispatch and workers compare the normalized authority with their independently resolved shop, installation and operation. History compares the complete server-loaded plan authority with a freshly verified approval, including its field resolution fingerprint. Recovery and local completion compare immutable historical approval coordinates and persisted evidence; they do not renew an expired mutation grant. Local completion does not construct a Shopify transport or require new write permission. AFTER observations must retain every BEFORE binding coordinate, including mode, generation, coverage, mapping and execution-snapshot identity.

Mutation adapters have declared identifiers and versions. Capability and registry changes invalidate live approvals. Incompatible adapter or approval coordinates suspend the command with a durable `review_required` checkpoint and actual item counts, rather than retrying a mutation under new semantics. Scheduled templates capture the adapter descriptor when created and require revalidation before creating a new execution under an incompatible deployment. Incompatible changes to writer behavior require an adapter-version bump; the capability fingerprint also detects declared mapping/shape changes.

Schedule creation captures the current installation. Each occurrence retains that lifecycle identity, and worker discovery, claim, phase ownership, command lookup and acknowledgments compare it with current database records. An old occurrence is moved to review without obtaining authentication for a replacement installation. Discovery uses an explicit operation-worker gateway; merchant selection, approval and dispatch use the merchant gateway. Only the worker role receives global schedule discovery permissions. Composition must supply `database` as the merchant gateway and a separate `workerDatabase` issued for the operation-worker profile; there is no privileged pool fallback.

Dispatch checkpoints an occurrence as `DISPATCHED`, not successful. Pending or running commands remain `DISPATCHED`/`EXECUTING`; terminal command outcomes wait for the independently durable finalization ledger. Partial outcomes take precedence over the engine's internal FAILED status and retain the result counts on the occurrence. Finalization read failures remain retryable, and exhausted terminal-status reconciliation requires review. Reading an already dispatched command's outcome uses its fenced worker authority and does not acquire a new merchant write grant. Canceling an already dispatched occurrence requests command cancellation and waits for the durable outcome.

History mutation-attempt finalization and command finalization are separate APIs. The command finalizer independently authenticates, loads the exact installation-bound terminal command and immutable approval, checks all successful items for complete verified request membership and AFTER evidence, rejects unresolved changes, and finalizes every associated history operation. It does not choose the last item as the command's history scope. It can finalize a command with no mutation history when no write occurred, and prior verified-no-write attempts do not turn an entirely successful command into a partial result.

The phase rules are explicit:

| Case | Rule and contract coverage |
| --- | --- |
| CT-111: expiry after dispatch | No new one-use handoff consumption or mutation may be authorized after expiry. Already consumed or verified outcomes can be persisted and completed through evidence-only authority. Live execution cannot use an evidence-only approval read. |
| CT-112: replacement publication | Admission and consumption require the exact current publication barrier and coordinates. Replacement stops further sends. Verified results from an earlier admitted request may still complete locally against the original retained selection and evidence. |
| CT-113: reinstall before occurrence | Stored installation identity cannot change. Legacy/obsolete occurrences require review and cannot obtain replacement-installation authority. |
| CT-114: adapter upgrade | Validly hashed stale adapter coordinates fail live verification. Commands and pre-dispatch schedule phases suspend for revalidation. Historical evidence remains readable without granting another send. |
| CT-115: mixed item outcomes | Successful, failed, pending and uncertain evidence remains distinct; partial commands and scheduled occurrences preserve those counts. |
| CT-116: lost acknowledgement commit response | The worker records/schedules uncertainty and does not send again. Recovery reconciles durable evidence before local completion. |
| CT-117: mixed import families | The installed row importer supports Product SET fields only. Product/variant/metafield mixtures are rejected before any selection or approval; unsupported fields cannot become a partial authoritative import. |
| CT-118: repeated variant field | Undo observation/inverse keys include resource GID and field ID. Separate variants sharing `variant.price` retain different values and conflicts; installed dispatch uses separate resource items. |
| CT-119: recurring replay | The unique shop/schedule/due-time occurrence identity and fenced phase updates share the selection/approval/dispatch transactions. Replaying an occurrence does not create another logical command. |
| CT-120: scheduled partial completion | Dispatch alone is nonterminal. A terminal partial command becomes a PARTIAL occurrence after successful history/Undo finalization. |

`20261101000300_execution_authority_lifecycle` adds immutable installation and target-mode provenance, occurrence result storage and narrowly scoped worker scheduling permissions. Historical provenance is not inferred from the current shop: legacy schedules are disabled, active legacy occurrences require review, and legacy selections/approvals require fresh selection and approval. The migration is not applied by these code changes.

Unit contract tests cover authority tampering, phase-specific expiry, adapter drift, snapshot shape equality, reinstall fencing, scheduled dispatch replay, partial completion, finalization errors, full item membership, command-wide history scope, mixed imports, variant Undo identities and lost acknowledgement responses. Additional PostgreSQL integration scenarios cover actual lease/transaction races, expiry between admission and consumption, publication withdrawal after verification and evidence-only completion. Their execution requires the disposable PostgreSQL harness; passing unit tests does not certify these database scenarios.

Validation: all 1,254 backend tests and Prisma validation pass. The PostgreSQL/schema harness could not start because Docker Desktop's Linux engine is unavailable. The new migration, SQL privilege changes and PostgreSQL concurrency scenarios remain unapplied/unverified.
