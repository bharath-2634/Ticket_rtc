import { readFile } from "node:fs/promises";
import pg from "pg";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const messages = JSON.parse(
  await readFile(new URL("../tests/fixtures/ingestion-messages.json", import.meta.url), "utf8"),
);
const results = { accepted: 0, rejected: 0, duplicates: 0, conflicts: 0, unexpectedErrors: 0 };
const messageIds = [...new Set(messages.map((message) => message.message_id))];
const client = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://ticket_rpc:ticket_rpc_dev@localhost:5432/ticket_rpc",
});
try {
  await client.connect();
  const before = await client.query(
    "SELECT message_id, attempts, status FROM tickets WHERE message_id = ANY($1::text[])",
    [messageIds],
  );
  for (const message of messages) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      });
      if (response.status === 202) results.accepted += 1;
      else if (response.status === 422) results.rejected += 1;
      else if (response.status === 200 && (await response.json()).duplicate) results.duplicates += 1;
      else if (response.status === 409) results.conflicts += 1;
      else results.unexpectedErrors += 1;
    } catch (error) {
      results.unexpectedErrors += 1;
      console.error(`Request failed for ${message.message_id}:`, error);
    }
  }

  const [summaryResponse, ...detailResponses] = await Promise.all([
    fetch(`${baseUrl}/api/v1/ops/summary`),
    ...messageIds.map((messageId) =>
      fetch(`${baseUrl}/api/v1/tickets/${encodeURIComponent(messageId)}`),
    ),
  ]);
  if (!summaryResponse.ok || detailResponses.some((response) => !response.ok)) {
    throw new Error("Could not verify dataset results through API");
  }
  const summary = await summaryResponse.json();
  const apiTickets = await Promise.all(detailResponses.map(async (response) => (await response.json()).ticket));
  const dbTickets = await client.query(
    `SELECT message_id, original_text, status, attempts FROM tickets
     WHERE message_id = ANY($1::text[])`,
    [messageIds],
  );
  const duplicateTicketRows = await client.query(
    `SELECT message_id FROM tickets WHERE message_id = ANY($1::text[])
     GROUP BY message_id HAVING count(*) > 1`,
    [messageIds],
  );
  const persistedTexts = new Map(dbTickets.rows.map((ticket) => [ticket.message_id, ticket.original_text]));
  const payloadsPreserved = messages
    .filter((message) => message.text.trim().length > 0)
    .every((message) => persistedTexts.get(message.message_id) === message.text);
  const apiPayloadsPreserved = messages
    .filter((message) => message.text.trim().length > 0)
    .every((message) => apiTickets.find((ticket) => ticket.message_id === message.message_id)?.original_text === message.text);
  const existingStatePreserved = before.rows.every((ticket) => {
    const current = dbTickets.rows.find((row) => row.message_id === ticket.message_id);
    return current?.attempts === ticket.attempts && current?.status === ticket.status;
  });
  console.log(JSON.stringify({
    submissions: messages.length,
    uniqueMessageIds: messageIds.length,
    ...results,
    persistedFixtureTicketCount: dbTickets.rowCount,
    statusCounts: Object.fromEntries(
      ["pending", "processing", "completed", "failed", "rejected"].map((status) => [
        status,
        dbTickets.rows.filter((ticket) => ticket.status === status).length,
      ]),
    ),
    httpVisibleFixtureTickets: apiTickets.length,
    apiPayloadsPreserved,
    payloadsPreserved,
    duplicateTicketRows: duplicateTicketRows.rowCount,
    existingStatePreserved,
    summary,
  }, null, 2));
  if (
    results.unexpectedErrors > 0 ||
    !payloadsPreserved ||
    !apiPayloadsPreserved ||
    !existingStatePreserved ||
    duplicateTicketRows.rowCount > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
