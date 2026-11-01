# P0 filter and authority verification — 2026-10-31

Changes in this pass:
- UI operator compatibility is derived from the backend pure operator registry. `is_empty` and `is_not_empty` are supported there and in the SQL compiler; live per-field capabilities still gate their availability.
- Status enum values come from authenticated capabilities and backend filter constraints. Capability responses reject unknown operators, incompatible declared types and malformed enum lists.
- Dates and datetimes use the strict backend normalizer. Dates remain dates; timestamps require explicit zones, valid calendars/clocks and bounded offsets. Range inputs require two nonempty ordered boundaries, with decimal comparison preserving precision.
- All protected `/api` handlers pass a shared stored-session and active-installation check, including legacy routes. OAuth and webhook routes remain before this guard because they authenticate independently. Missing installation storage fails closed.
- Approval retrieval explicitly checks returned shop and contract identity and rejects invalid expiry dates. Hash regression tests cover all contract identity dimensions and changed payloads. Existing dispatch and worker tests check immutable approved instructions.

Validation:
- `npm test`: 1,071 passed.
- Frontend `test:products`: 44 passed; `test:ui`: 27 passed.
- Frontend build passed with CI=1.
- Prisma CLI validation passed for both `prisma.config.mjs` and `prisma-live.config.mjs` using the cached Prisma CLI; no schema changes were necessary for these checks.

Outstanding verification:
- `test:schema` cannot run: Docker is unavailable and the cached PostgreSQL distribution at `%TEMP%/metamax-pg18-runtime/pgsql` lacks its `bin` executables. No production migrations were applied. Database-backed schema/migration checks and end-to-end preview/approval/execution checks remain unverified in this pass.
- The full working tree already contains substantial prior changes; this report describes only this pass and does not certify all previous edits.
