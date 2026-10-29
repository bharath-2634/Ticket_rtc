import express, { type ErrorRequestHandler } from "express";
import pino from "pino";
import { pool } from "@ticket-rpc/shared/database";
import { config } from "./config.js";
import { incomingMessageSchema } from "./schema.js";

const logger = pino({ level: config.LOG_LEVEL });
pool.on("error", (error) => {
  logger.error({ err: error }, "Idle PostgreSQL connection failed");
});
const ticketStatuses = ["pending", "processing", "completed", "failed", "rejected"] as const;
type TicketStatus = (typeof ticketStatuses)[number];

export const app = express();
app.disable("x-powered-by");
app.use((request, response, next) => {
  response.setHeader("Access-Control-Allow-Origin", config.DASHBOARD_ORIGIN);
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

async function recordEvent(
  messageId: string | null,
  eventType: string,
  reason: string | null,
) {
  await pool.query(
    "INSERT INTO ingestion_events (message_id, event_type, reason) VALUES ($1, $2, $3)",
    [messageId, eventType, reason],
  );
}

app.get("/health/live", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.get("/health/ready", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.status(200).json({ status: "ready" });
  } catch {
    response.status(503).json({ status: "not_ready" });
  }
});

app.post(
  "/api/v1/tickets",
  async (request, response, next) => {
    if (!request.is("application/json")) {
      try {
        await recordEvent(null, "ingestion_error", "unsupported_content_type");
      } catch (error) {
        logger.error({ err: error }, "Could not persist unsupported content-type event");
      }
      response.status(415).json({ error: "unsupported_media_type", message: "Use application/json." });
      return;
    }
    next();
  },
  express.json({ limit: config.MAX_REQUEST_BODY_SIZE, strict: false }),
  async (request, response, next) => {
    let messageId: string | null = null;
    try {
      const body = request.body as unknown;
      if (body && typeof body === "object" && "message_id" in body &&
          typeof body.message_id === "string") {
        messageId = body.message_id;
      }
      const parsed = incomingMessageSchema.safeParse(body);
      if (!parsed.success) {
        await recordEvent(messageId, "request_rejected", "schema_validation_failed");
        response.status(400).json({
          error: "invalid_request",
          message: "Body must contain string message_id and text fields only.",
        });
        return;
      }

      const { message_id: messageIdValue, text } = parsed.data;
      const textCharacterCount = [...text].length;
      const rejectionReason =
        text.length === 0
          ? "text must not be empty"
          : text.trim().length === 0
            ? "text must not contain only whitespace"
            : textCharacterCount > config.MAX_TICKET_TEXT_LENGTH
              ? `Text exceeds maximum allowed length of ${config.MAX_TICKET_TEXT_LENGTH} characters`
              : null;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<{
          id: string;
          message_id: string;
          status: TicketStatus;
          attempts: number;
        }>(
          `INSERT INTO tickets (message_id, original_text, status, rejection_reason)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (message_id) DO NOTHING
           RETURNING id, message_id, status, attempts`,
          [
            messageIdValue,
            text,
            rejectionReason ? "rejected" : "pending",
            rejectionReason,
          ],
        );

        if (inserted.rowCount) {
          const ticket = inserted.rows[0]!;
          if (!rejectionReason) {
            await client.query(
              "INSERT INTO ticket_classifications (ticket_id, status) VALUES ($1, 'pending')",
              [ticket.id],
            );
          }
          await client.query(
            "INSERT INTO ingestion_events (message_id, event_type, reason) VALUES ($1, $2, $3)",
            [messageIdValue, rejectionReason ? "rejected" : "accepted", rejectionReason],
          );
          await client.query("COMMIT");
          response.status(rejectionReason ? 422 : 202).json({
            ticket_id: ticket.id,
            message_id: ticket.message_id,
            status: ticket.status,
            ...(rejectionReason ? { rejection_reason: rejectionReason } : {}),
          });
          return;
        }

        const existing = await client.query<{
          id: string;
          message_id: string;
          original_text: string;
          status: TicketStatus;
          attempts: number;
        }>(
          "SELECT id, message_id, original_text, status, attempts FROM tickets WHERE message_id = $1",
          [messageIdValue],
        );
        const ticket = existing.rows[0];
        if (!ticket) throw new Error("Ticket conflict row was not available");

        if (ticket.original_text !== text) {
          await client.query(
            "INSERT INTO ingestion_events (message_id, event_type, reason) VALUES ($1, 'payload_conflict', $2)",
            [messageIdValue, "message_id was previously used with different text"],
          );
          await client.query("COMMIT");
          response.status(409).json({
            error: "payload_conflict",
            message: "This message_id is already associated with a different payload.",
          });
          return;
        }

        await client.query(
          "INSERT INTO ingestion_events (message_id, event_type, reason) VALUES ($1, 'duplicate', $2)",
          [messageIdValue, "identical message submission"],
        );
        await client.query("COMMIT");
        response.status(200).json({
          ticket_id: ticket.id,
          message_id: ticket.message_id,
          status: ticket.status,
          duplicate: true,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      next(error);
    }
  },
);

app.get("/api/v1/tickets", async (request, response, next) => {
  try {
    const page = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? "25"), 10) || 25));
    const status = request.query.status;
    if (status !== undefined && !ticketStatuses.includes(String(status) as TicketStatus)) {
      response.status(400).json({ error: "invalid_status" });
      return;
    }
    const values: unknown[] = [];
    const filter = status
      ? `WHERE t.status = $${values.push(String(status))}`
      : "";
    values.push(limit, (page - 1) * limit);
    const result = await pool.query(
      `SELECT t.id, t.message_id, t.original_text, t.status, t.rejection_reason, t.attempts,
              t.created_at, t.updated_at, t.processing_started_at, t.completed_at, t.last_error,
              c.status AS classification_status, c.category AS classification_category,
              c.attempts AS classification_attempts, c.llm_calls AS classification_llm_calls,
              c.started_at AS classification_started_at, c.completed_at AS classification_completed_at,
              c.last_error AS classification_error
       FROM tickets t
       LEFT JOIN ticket_classifications c ON c.ticket_id = t.id
       ${filter}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    response.json({ tickets: result.rows, page, limit });
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1/tickets/:messageId", async (request, response, next) => {
  try {
    const ticket = await pool.query(
      `SELECT t.id, t.message_id, t.original_text, t.status, t.rejection_reason, t.attempts,
              t.created_at, t.updated_at, t.processing_started_at, t.completed_at, t.last_error,
              c.status AS classification_status, c.category AS classification_category,
              c.attempts AS classification_attempts, c.llm_calls AS classification_llm_calls,
              c.started_at AS classification_started_at, c.completed_at AS classification_completed_at,
              c.last_error AS classification_error
       FROM tickets t LEFT JOIN ticket_classifications c ON c.ticket_id = t.id
       WHERE t.message_id = $1`,
      [request.params.messageId],
    );
    if (!ticket.rowCount) {
      response.status(404).json({ error: "ticket_not_found" });
      return;
    }
    const events = await pool.query(
      `SELECT id, event_type, reason, created_at FROM ingestion_events
       WHERE message_id = $1 ORDER BY created_at DESC, id DESC`,
      [request.params.messageId],
    );
    response.json({ ticket: ticket.rows[0], events: events.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/api/v1/tickets/:messageId/retry", async (request, response, next) => {
  const client = await pool.connect().catch(next);
  if (!client) return;
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT t.id, t.status, c.status AS classification_status
       FROM tickets t LEFT JOIN ticket_classifications c ON c.ticket_id = t.id
       WHERE t.message_id = $1 FOR UPDATE OF t`,
      [request.params.messageId],
    );
    if (!current.rowCount) {
      await client.query("ROLLBACK");
      response.status(404).json({ error: "ticket_not_found" });
      return;
    }
    if (current.rows[0].status !== "failed" || current.rows[0].classification_status !== "failed") {
      await client.query("ROLLBACK");
      response.status(409).json({ error: "ticket_not_retryable", status: current.rows[0].status });
      return;
    }
    await client.query(
      `UPDATE ticket_classifications SET status = 'pending', attempts = 0,
         next_attempt_at = now(), updated_at = now(), last_error = NULL
       WHERE ticket_id = $1 AND status = 'failed'`,
      [current.rows[0].id],
    );
    const result = await client.query(
      `UPDATE tickets SET status = 'pending', updated_at = now(), last_error = NULL
       WHERE id = $1 AND status = 'failed'
       RETURNING id, message_id, status, attempts`,
      [current.rows[0].id],
    );
    await client.query(
      "INSERT INTO ingestion_events (message_id, event_type, reason) VALUES ($1, 'retry_requested', $2)",
      [request.params.messageId, "operator requested retry"],
    );
    await client.query("COMMIT");
    response.status(202).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

app.get("/api/v1/ops/summary", async (_request, response, next) => {
  try {
    const result = await pool.query(`
      SELECT
        count(*) FILTER (WHERE status <> 'rejected')::int AS valid_tickets_received,
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(*) FILTER (WHERE status = 'rejected')::int AS rejected_tickets
      FROM tickets
    `);
    const events = await pool.query(`
      SELECT
        count(*) FILTER (WHERE event_type IN ('rejected', 'request_rejected'))::int AS rejected_requests,
        count(*) FILTER (WHERE event_type = 'duplicate')::int AS duplicate_submissions,
        count(*) FILTER (WHERE event_type = 'payload_conflict')::int AS payload_conflicts,
        count(*) FILTER (WHERE event_type = 'ingestion_error')::int AS ingestion_errors
      FROM ingestion_events
    `);
    const classification = await pool.query(`
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS classification_pending,
        count(*) FILTER (WHERE status = 'in_progress')::int AS classification_in_progress,
        count(*) FILTER (WHERE status = 'completed')::int AS classification_completed,
        count(*) FILTER (WHERE status = 'failed')::int AS classification_failed
      FROM ticket_classifications
    `);
    const classificationCalls = await pool.query(`
      SELECT
        count(*)::int AS classification_calls,
        count(*) FILTER (WHERE status = 'succeeded')::int AS classification_successes,
        count(*) FILTER (WHERE status = 'failed')::int AS classification_call_failures,
        count(*) FILTER (WHERE call_number > 1)::int AS classification_retries
      FROM classification_attempts
    `);
    response.json({
      ...result.rows[0],
      ...events.rows[0],
      ...classification.rows[0],
      ...classificationCalls.rows[0],
      llm_configured: Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/v1/ops/events", async (request, response, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(request.query.limit ?? "25"), 10) || 25));
    const result = await pool.query(
      `SELECT id, message_id, event_type, reason, created_at
       FROM ingestion_events ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    );
    response.json({ events: result.rows });
  } catch (error) {
    next(error);
  }
});

const errorHandler: ErrorRequestHandler = async (error, request, response, _next) => {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 500;
  const knownBodyError = status === 400 || status === 413;
  const reason = status === 413
    ? "request_body_too_large"
    : knownBodyError
      ? "malformed_json"
      : "internal_request_error";
  const body = request.body as unknown;
  const messageId = body && typeof body === "object" && "message_id" in body &&
      typeof body.message_id === "string"
    ? body.message_id
    : null;
  try {
    await recordEvent(messageId, "ingestion_error", reason);
  } catch (eventError) {
    logger.error({ err: eventError }, "Could not persist request parsing failure");
  }
  if (knownBodyError) {
    response.status(status).json({
      error: status === 413 ? "payload_too_large" : "invalid_json",
      message: status === 413 ? "Request body exceeds the configured limit." : "Request body must be valid JSON.",
    });
    return;
  }
  logger.error({ err: error, path: request.path }, "Unhandled API request error");
  response.status(503).json({ error: "service_unavailable", message: "The service could not complete the request." });
};

app.use(errorHandler);
