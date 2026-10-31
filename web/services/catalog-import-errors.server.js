/** Stable import boundary errors. Messages and dependency details stay private. */
export const IMPORT_ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "IMPORT_PERMISSION_DENIED",
  INVALID_REQUEST: "INVALID_IMPORT_REQUEST",
  BODY_TOO_LARGE: "IMPORT_REQUEST_TOO_LARGE",
  UNSUPPORTED_MEDIA_TYPE: "IMPORT_UNSUPPORTED_MEDIA_TYPE",
  NOT_FOUND: "IMPORT_NOT_FOUND",
  UNAVAILABLE: "CATALOG_IMPORT_UNAVAILABLE",
  INTERNAL: "IMPORT_INTERNAL_ERROR",
});

const statuses = new Map([
  [IMPORT_ERROR_CODES.UNAUTHENTICATED, 401],
  [IMPORT_ERROR_CODES.FORBIDDEN, 403],
  [IMPORT_ERROR_CODES.INVALID_REQUEST, 400],
  [IMPORT_ERROR_CODES.BODY_TOO_LARGE, 413],
  [IMPORT_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, 415],
  [IMPORT_ERROR_CODES.NOT_FOUND, 404],
  [IMPORT_ERROR_CODES.UNAVAILABLE, 503],
  [IMPORT_ERROR_CODES.INTERNAL, 500],
]);

export class CatalogImportError extends Error {
  constructor(code, options = {}) {
    if (!statuses.has(code)) throw new TypeError("Unknown import error code");
    super(options.message ?? code, options);
    this.name = "CatalogImportError";
    this.code = code;
  }
}

// Known transient transport/Postgres failures. Unknown failures remain 500.
const unavailableCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "53300", "53400", "57P01", "57P02", "57P03", "40001", "40P01", "55P03",
]);

export function normalizeImportError(error) {
  if (error instanceof CatalogImportError) return error;
  return new CatalogImportError(unavailableCodes.has(error?.code)
    ? IMPORT_ERROR_CODES.UNAVAILABLE : IMPORT_ERROR_CODES.INTERNAL, { cause: error });
}

export function describeImportFailure(error) {
  const failure = normalizeImportError(error);
  return { status: statuses.get(failure.code), error: failure.code };
}

export function withImportErrors(operation) {
  return async (...args) => {
    try { return await operation(...args); }
    catch (error) { throw normalizeImportError(error); }
  };
}
