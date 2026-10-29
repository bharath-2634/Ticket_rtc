import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const defaultMigrationDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

function integerSetting(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://ticket_rpc:ticket_rpc_dev@localhost:5432/ticket_rpc",
  max: integerSetting("DB_POOL_MAX", 10, 1),
  idleTimeoutMillis: integerSetting("DB_IDLE_TIMEOUT_MS", 30_000, 0),
  connectionTimeoutMillis: integerSetting("DB_CONNECTION_TIMEOUT_MS", 5_000, 1),
});

export async function runMigrations(directory = defaultMigrationDirectory) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [812_431_009]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(directory))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [file],
      );
      if (applied.rowCount) continue;
      const sql = await readFile(resolve(directory, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
