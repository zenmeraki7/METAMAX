import {loadMigrationEnvironment} from './security/migration-environment.server.js';
// Prisma CLI only. The application continues to use its existing pg pool.
// Migrations require a direct connection supplied explicitly by the operator.
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

const envFile = new URL("./.env", import.meta.url);
const local = loadMigrationEnvironment();

export default {
  schema: "prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DIRECT_DATABASE_URL || local.DIRECT_DATABASE_URL || "postgresql://unused:unused@127.0.0.1:1/unused",
  },
};
