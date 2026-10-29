import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { exportResults } from "./results-export.mjs";

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const timeoutMs = Number(process.env.PIPELINE_DATASET_TIMEOUT_MS ?? 900_000);
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
              c.category, c.last_error, c.llm_calls,
              x.status AS extraction_status, x.order_id, x.product, x.urgency,
              x.requested_action, x.last_error AS extraction_error
       FROM tickets t
       LEFT JOIN ticket_classifications c ON c.ticket_id = t.id
       LEFT JOIN ticket_extractions x ON x.ticket_id = t.id
       WHERE t.message_id = ANY($1::text[])`,
      [ids],
    );
    rows = result.rows;
    const finished = rows.length === ids.length && rows.every((ticket) =>
      ["completed", "failed", "rejected"].includes(ticket.status),
    );
    if (finished) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const rejected = rows.find((ticket) => ticket.message_id === "T-1012");
  const invalidRejected = rejected?.status !== "rejected" || rejected.classification_status !== null;
  const completed = rows.filter((ticket) =>
    ticket.status === "completed" &&
    ticket.classification_status === "completed" &&
    ticket.extraction_status === "completed",
  );
  const failed = rows.filter((ticket) => ticket.status === "failed");
  const unfinished = rows.filter((ticket) =>
    !["completed", "failed", "rejected"].includes(ticket.status),
  );
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
  const extractionCalls = await client.query(
    `SELECT t.message_id, count(a.id)::int AS calls
     FROM tickets t LEFT JOIN extraction_attempts a ON a.ticket_id = t.id
     WHERE t.message_id = ANY($1::text[])
     GROUP BY t.message_id`,
    [ids],
  );
  const t1007ExtractionCalls = extractionCalls.rows.find(
    (ticket) => ticket.message_id === "T-1007",
  )?.calls ?? 0;
  const outputPath = resolve(process.env.RESULTS_PATH ?? "results.json");
  const exportedEntries = await exportResults(client, outputPath);
  const exported = JSON.parse(await readFile(outputPath, "utf8"));
  const exportedFixture = exported.filter((ticket) => ids.includes(ticket.message_id));
  const expectedFields = [
    "message_id", "status", "category", "order_id", "product", "urgency", "requested_action",
  ];
  const resultsSchemaValid = exportedFixture.length === ids.length &&
    exportedFixture.every((ticket) =>
      JSON.stringify(Object.keys(ticket).sort()) === JSON.stringify([...expectedFields].sort()),
    );
  console.log(JSON.stringify({
    submissions: messages.length,
    uniqueMessageIds: ids.length,
    persistedTickets: rows.length,
    processingCompleted: completed.length,
    processingFailed: failed.length,
    classificationCompleted: rows.filter((ticket) => ticket.classification_status === "completed").length,
    extractionCompleted: rows.filter((ticket) => ticket.extraction_status === "completed").length,
    extractionFailed: rows.filter((ticket) => ticket.extraction_status === "failed").length,
    calls: classificationCalls.rows.reduce((total, ticket) => total + ticket.calls, 0),
    extractionCalls: extractionCalls.rows.reduce((total, ticket) => total + ticket.calls, 0),
    rejectedTicketNotClassified: !invalidRejected,
    categoriesValid: invalidCategories.length === 0,
    duplicateTicketRows: duplicateTicketRows.rowCount,
    t1007HasClassificationCall: t1007ClassificationCalls > 0,
    t1007HasClassificationAttempt: t1007ClassificationCalls > 0,
    t1007HasExtractionAttempt: t1007ExtractionCalls > 0,
    rejectedTicketNotExtracted: rejected?.extraction_status == null,
    resultsExport: outputPath,
    exportedEntries,
    exportedFixtureEntries: exportedFixture.length,
    resultsSchemaValid,
    pendingAtTimeout: unfinished.map((ticket) => ticket.message_id),
  }, null, 2));
  if (
    rows.length !== ids.length ||
    invalidRejected ||
    invalidCategories.length > 0 ||
    completed.length !== 23 ||
    failed.length > 0 ||
    unfinished.length > 0 ||
    duplicateTicketRows.rowCount > 0 ||
    t1007ClassificationCalls === 0 ||
    t1007ExtractionCalls === 0 ||
    exportedEntries !== exported.length ||
    !resultsSchemaValid
  ) {
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
