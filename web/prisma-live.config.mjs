import {loadMigrationEnvironment} from './security/migration-environment.server.js';
// Read-only introspection of the database configured for this application.
// This config has no migrations path and never replaces the application schema.
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

const envFile = new URL("./.env", import.meta.url);
const local = loadMigrationEnvironment();
const configured = process.env.DIRECT_DATABASE_URL || local.DIRECT_DATABASE_URL ||
  process.env.DATABASE_URL || local.DATABASE_URL;
if (!configured) throw new Error("An existing database connection is required for introspection");
const target = new URL(configured);
// Neon direct and pooled endpoints address the same branch/database.
if (target.hostname.endsWith(".neon.tech")) target.hostname = target.hostname.replace(/-pooler(?=\.)/, "");
target.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000");

export default {
  schema: "prisma-live/schema.prisma",
  datasource: { url: target.href },
};
