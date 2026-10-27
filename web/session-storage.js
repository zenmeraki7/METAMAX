import "./env.js";
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { installationSessionStorage } from "./domains/lifecycle/offline-session.js";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is required. Configure it in web/.env or the server environment."
  );
}

// This adapter version does not forward URL TLS options to node-postgres.
// Enable verified TLS through the driver's supported environment setting.
process.env.PGSSLMODE ??= "verify-full";

let baseStorage = new PostgreSQLSessionStorage(process.env.DATABASE_URL);

function getWrapper() {
  if (!baseStorage) {
    baseStorage = new PostgreSQLSessionStorage(process.env.DATABASE_URL);
  }
  return installationSessionStorage(baseStorage);
}

export const sessionStorage = {
  storeSession: (session) => getWrapper().storeSession(session),
  loadSession: (...args) => getWrapper().loadSession(...args),
  deleteSession: (...args) => getWrapper().deleteSession(...args),
  deleteSessions: (...args) => getWrapper().deleteSessions(...args),
  findSessionsByShop: (...args) => getWrapper().findSessionsByShop(...args),
  disconnect: async () => {
    // Keep connection pool alive across test suites in single-process test runs
  },
};
