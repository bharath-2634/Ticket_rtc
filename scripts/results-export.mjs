import { open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function buildResults(pool) {
  const result = await pool.query(`
    SELECT t.message_id, t.status, c.category,
           x.order_id, x.product, x.urgency, x.requested_action
    FROM tickets t
    LEFT JOIN ticket_classifications c ON c.ticket_id = t.id
    LEFT JOIN ticket_extractions x ON x.ticket_id = t.id
    ORDER BY t.message_id
  `);
  return result.rows.map((row) => ({
    message_id: row.message_id,
    status: row.status,
    category: row.category ?? null,
    order_id: row.order_id ?? null,
    product: row.product ?? null,
    urgency: row.urgency ?? null,
    requested_action: row.requested_action ?? null,
  }));
}

export async function writeResultsAtomically(entries, outputPath) {
  const target = resolve(outputPath);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx");
    await file.writeFile(`${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, target);
  } catch (error) {
    if (file) await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function exportResults(pool, outputPath) {
  const entries = await buildResults(pool);
  await writeResultsAtomically(entries, outputPath);
  return entries.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://ticket_rpc:ticket_rpc_dev@localhost:5432/ticket_rpc",
  });
  const outputPath = process.argv[2] ?? resolve("results.json");
  await client.connect();
  try {
    const count = await exportResults(client, outputPath);
    console.log(`Exported ${count} ticket results to ${outputPath}`);
  } finally {
    await client.end();
  }
}
