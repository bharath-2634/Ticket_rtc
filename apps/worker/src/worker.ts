import type { Pool } from "pg";

export async function pollAndClaim(
  pool: Pool,
  options: { concurrency: number; leaseMs: number; messageIdPrefix?: string },
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recovered = await client.query<{ message_id: string }>(
      `WITH expired AS (
         UPDATE tickets
         SET status = 'pending', updated_at = now(), processing_started_at = NULL,
             lease_expires_at = NULL, last_error = 'Processing lease expired'
         WHERE status = 'processing' AND lease_expires_at <= now()
           AND ($1::text IS NULL OR message_id LIKE $1)
         RETURNING message_id
       )
       INSERT INTO ingestion_events (message_id, event_type, reason)
       SELECT message_id, 'worker_recovered', 'expired processing lease'
       FROM expired
       RETURNING message_id`,
      [options.messageIdPrefix ? `${options.messageIdPrefix}%` : null],
    );
    const claimed = await client.query<{ id: string; message_id: string }>(
      `WITH eligible AS (
         SELECT id FROM tickets
         WHERE status = 'pending'
           AND ($3::text IS NULL OR message_id LIKE $3)
         ORDER BY created_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE tickets AS ticket
       SET status = 'processing', attempts = ticket.attempts + 1,
           updated_at = now(), processing_started_at = now(),
           lease_expires_at = now() + ($2 * interval '1 millisecond')
       FROM eligible
       WHERE ticket.id = eligible.id
       RETURNING ticket.id, ticket.message_id`,
      [options.concurrency, options.leaseMs, options.messageIdPrefix ? `${options.messageIdPrefix}%` : null],
    );
    if (claimed.rowCount) {
      await client.query(
        `INSERT INTO ingestion_events (message_id, event_type, reason)
         SELECT unnest($1::text[]), 'worker_claimed', 'ingestion-phase lifecycle claim'`,
        [claimed.rows.map((ticket) => ticket.message_id)],
      );
    }
    await client.query("COMMIT");
    return { claimed: claimed.rows, recovered: recovered.rows };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
