/** Read-only catalog verification of the installed SQL source contract. */
import { database, closeDatabase } from "../db/postgres.js";
import { getInstalledFilterSchemaOptions, verifyInstalledFilterSchema } from "../services/filter-schema.server.js";

let fields = 0;
try {
  fields = getInstalledFilterSchemaOptions().fieldMappings.length;
  if (!database) throw new Error("DATABASE_URL required");
  const verified = await verifyInstalledFilterSchema({ database });
  console.log(JSON.stringify({ verified: true, fields: verified.fieldMappings.length,
    mirrorSchemaVersion: verified.mirrorSchemaVersion, sourceContractVersion: verified.sourceContractVersion,
    schemaFingerprint: verified.fingerprint }));
} catch (error) {
  console.error(JSON.stringify({ verified: false, code: error.code ?? "SCHEMA_VERIFICATION_FAILED",
    message: "Installed filter mappings have not passed physical catalog verification",
    causeCode: error.cause?.code ?? null, fields }));
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
