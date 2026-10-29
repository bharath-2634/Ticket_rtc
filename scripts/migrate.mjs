import { pool, runMigrations } from "@ticket-rpc/shared/database";

try {
  await runMigrations();
  console.log("Database migrations applied.");
} finally {
  await pool.end();
}
