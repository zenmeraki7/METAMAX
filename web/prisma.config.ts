import "./env.js";
import "dotenv/config";
import { defineConfig } from "prisma/config";

const databaseUrl = (
  process.env.DIRECT_URL || process.env.DATABASE_URL
)?.trim();
const shadowDatabaseUrl =
  process.env.SHADOW_DATABASE_URL?.trim();

export default defineConfig({
  schema: "prisma/schema.prisma",

  migrations: {
    path: "prisma/migrations",
  },

  ...(databaseUrl
    ? {
      datasource: {
        url: databaseUrl,

        ...(shadowDatabaseUrl
          ? { shadowDatabaseUrl }
          : {}),
      },
    }
    : {}),
});
