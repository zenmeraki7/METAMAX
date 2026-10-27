// Reuse the established Prisma instance, pool, lifecycle and transactions.
// The underlying client reads DATABASE_URL and pool settings from the environment.
export {
  prisma,
  databaseSettings,
  connectDatabase,
  checkDatabaseHealth,
  databaseStatus,
  disconnectDatabase,
  default,
} from "../db/client.js";
