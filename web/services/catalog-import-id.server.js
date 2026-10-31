import { CatalogImportError, IMPORT_ERROR_CODES as C } from "./catalog-import-errors.server.js";

// Both legacy and phase imports use node:crypto.randomUUID(), stored in a
// case-sensitive TEXT primary key: canonical lowercase RFC UUID version 4.
export function isCatalogImportId(value) {
  return typeof value === "string" && value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export function requireCatalogImportId(value) {
  if (!isCatalogImportId(value)) throw new CatalogImportError(C.INVALID_REQUEST);
  return value;
}
