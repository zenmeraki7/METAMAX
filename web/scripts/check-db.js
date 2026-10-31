import assert from "node:assert/strict";
import { connectDatabase, closeDatabase } from "../db/postgres.js";

try {
  const database = await connectDatabase();
  const { rows } = await database.query(
    "SELECT current_database() AS database, 1 AS connected",
  );
  assert.equal(rows[0].connected, 1);
  console.log(`Postgres connection verified: ${rows[0].database}`);
} finally {
  await closeDatabase();
}
