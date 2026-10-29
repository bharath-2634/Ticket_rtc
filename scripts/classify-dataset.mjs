import { readFile } from "node:fs/promises";
import pg from "pg";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const timeoutMs = Number(process.env.CLASSIFICATION_DATASET_TIMEOUT_MS ?? 600_000);
const messages = JSON.parse(
  await readFile(new URL("../tests/fixtures/ingestion-messages.json", import.meta.url), "utf8"),
);
const client = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://ticket_rpc:ticket_rpc_dev@localhost:5432/ticket_rpc",
});

await client.connect();
try {
  for (const message of messages) {
    const response = await fetch(`${baseUrl}/api/v1/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (![200, 202, 422].includes(response.status)) {
      throw new Error(`Ingestion request ${message.message_id} returned HTTP ${response.status}`);
    }
  }

  const ids = [...new Set(messages.map((message) => message.message_id))];
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    const result = await client.query(
      `SELECT t.message_id, t.status, c.status AS classification_status,
              c.category, c.last_error, c.llm_calls
       FROM tickets t LEFT JOIN ticket_classifications c ON c.ticket_id = t.id
       WHERE t.message_id = ANY($1::text[])`,
      [ids],
    );
    rows = result.rows;
    const finished = rows.length === ids.length && rows.every((ticket) =>
      ticket.status === "rejected" || ["completed", "failed"].includes(ticket.classification_status),
    );
    if (finished) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const rejected = rows.find((ticket) => ticket.message_id === "T-1012");
  const invalidRejected = rejected?.status !== "rejected" || rejected.classification_status !== null;
  const completed = rows.filter((ticket) => ticket.classification_status === "completed");
  const invalidCategories = completed.filter(
    (ticket) => !["Billing", "Technical issue", "Account access", "Refund", "Other"].includes(ticket.category),
  );
  const duplicateTicketRows = await client.query(
    `SELECT message_id FROM tickets WHERE message_id = ANY($1::text[])
     GROUP BY message_id HAVING count(*) > 1`,
    [ids],
  );
  const classificationCalls = await client.query(
    `SELECT t.message_id, count(a.id)::int AS calls
     FROM tickets t LEFT JOIN classification_attempts a ON a.ticket_id = t.id
     WHERE t.message_id = ANY($1::text[])
     GROUP BY t.message_id`,
    [ids],
  );
  const t1007ClassificationCalls = classificationCalls.rows.find(
    (ticket) => ticket.message_id === "T-1007",
  )?.calls ?? 0;
  console.log(JSON.stringify({
    submissions: messages.length,
    uniqueMessageIds: ids.length,
    persistedTickets: rows.length,
    classificationCompleted: completed.length,
    classificationFailed: rows.filter((ticket) => ticket.classification_status === "failed").length,
    calls: classificationCalls.rows.reduce((total, ticket) => total + ticket.calls, 0),
    rejectedTicketNotClassified: !invalidRejected,
    categoriesValid: invalidCategories.length === 0,
    duplicateTicketRows: duplicateTicketRows.rowCount,
    t1007HasClassificationCall: t1007ClassificationCalls > 0,
    pendingAtTimeout: rows.filter((ticket) => !["completed", "failed"].includes(ticket.classification_status) && ticket.status !== "rejected").map((ticket) => ticket.message_id),
  }, null, 2));
  if (
    rows.length !== ids.length ||
    invalidRejected ||
    invalidCategories.length > 0 ||
    duplicateTicketRows.rowCount > 0 ||
    t1007ClassificationCalls === 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
