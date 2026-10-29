import type { Pool } from "pg";
import type { Logger } from "pino";
import {
  ClassificationError,
  OpenAiCompatibleLlmClient,
  type ClassificationCategory,
} from "./llm-client.js";
import {
  ExtractionError,
  type ExtractionResult,
} from "./extraction.js";

export type ClaimedTicket = {
  id: string;
  message_id: string;
  original_text: string;
  lease_token: string;
  classification_status: "pending" | "in_progress" | "completed" | "failed";
  classification_category: ClassificationCategory | null;
  extraction_status: "pending" | "in_progress" | "completed" | "failed";
};

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
             lease_expires_at = NULL, lease_token = NULL, last_error = 'Processing lease expired'
         WHERE status = 'processing' AND lease_expires_at <= now()
           AND ($1::text IS NULL OR message_id LIKE $1)
           AND EXISTS (SELECT 1 FROM ticket_classifications c WHERE c.ticket_id = tickets.id)
           AND EXISTS (SELECT 1 FROM ticket_extractions x WHERE x.ticket_id = tickets.id)
         RETURNING id, message_id
       ),
       reset_classification AS (
         UPDATE ticket_classifications c
         SET status = 'pending', updated_at = now(), next_attempt_at = LEAST(c.next_attempt_at, now())
         FROM expired e
         WHERE c.ticket_id = e.id AND c.status = 'in_progress'
       ),
       reset_extraction AS (
         UPDATE ticket_extractions x
         SET status = 'pending', updated_at = now(), next_attempt_at = LEAST(x.next_attempt_at, now())
         FROM expired e
         WHERE x.ticket_id = e.id AND x.status = 'in_progress'
       ),
       events AS (
         INSERT INTO ingestion_events (message_id, event_type, reason)
         SELECT message_id, 'worker_recovered', 'expired processing lease'
         FROM expired
         RETURNING message_id
       )
       SELECT message_id FROM expired`,
      [options.messageIdPrefix ? `${options.messageIdPrefix}%` : null],
    );
    const claimed = await client.query<ClaimedTicket>(
       `WITH eligible AS (
          SELECT t.id, c.status AS classification_status,
                 c.category AS classification_category, x.status AS extraction_status
          FROM tickets t
          JOIN ticket_classifications c ON c.ticket_id = t.id
          JOIN ticket_extractions x ON x.ticket_id = t.id
          WHERE (
            (t.status = 'pending' AND c.status = 'pending' AND c.next_attempt_at <= now())
            OR (
              t.status IN ('pending', 'processing') AND t.lease_token IS NULL
              AND c.status = 'completed' AND x.status = 'pending'
              AND x.next_attempt_at <= now()
            )
            OR (
              t.status IN ('pending', 'processing') AND t.lease_token IS NULL
              AND c.status = 'completed' AND x.status = 'completed'
            )
          )
            AND ($3::text IS NULL OR t.message_id LIKE $3)
          ORDER BY t.created_at, t.id
          LIMIT $1
          FOR UPDATE OF t SKIP LOCKED
        )
        UPDATE tickets AS ticket
        SET status = 'processing', attempts = ticket.attempts + 1,
            updated_at = now(), processing_started_at = now(),
            lease_expires_at = now() + ($2 * interval '1 millisecond'),
            lease_token = gen_random_uuid()
        FROM eligible
        WHERE ticket.id = eligible.id
        RETURNING ticket.id, ticket.message_id, ticket.original_text, ticket.lease_token,
                  eligible.classification_status, eligible.classification_category,
                  eligible.extraction_status`,
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

export type ClassificationOptions = {
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  leaseMs: number;
};

async function retryPersistence<T>(
  operation: () => Promise<T>,
  logger: Logger,
  ticket: ClaimedTicket,
): Promise<T> {
  let delay = 250;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      logger.error(
        { err: error, messageId: ticket.message_id, retryInMs: delay },
        "Could not persist processing result; will retry without another LLM request",
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
}

async function beginClassificationAttempt(pool: Pool, ticket: ClaimedTicket) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ call_number: number }>(
      `UPDATE ticket_classifications c
       SET status = 'in_progress', attempts = c.attempts + 1, llm_calls = c.llm_calls + 1,
           started_at = now(), updated_at = now(), last_error = NULL
       FROM tickets t
       WHERE c.ticket_id = t.id AND t.id = $1 AND t.lease_token = $2
         AND t.status = 'processing' AND c.status = 'pending'
       RETURNING c.llm_calls AS call_number`,
      [ticket.id, ticket.lease_token],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const callNumber = result.rows[0].call_number;
    await client.query(
      `INSERT INTO classification_attempts (ticket_id, call_number, status)
       VALUES ($1, $2, 'started')`,
      [ticket.id, callNumber],
    );
    await client.query(
      `INSERT INTO ingestion_events (message_id, event_type, reason)
       VALUES ($1, 'classification_started', $2)`,
      [ticket.message_id, `LLM call ${callNumber} started`],
    );
    await client.query("COMMIT");
    return { callNumber };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistClassificationSuccess(
  pool: Pool,
  ticket: ClaimedTicket,
  callNumber: number,
  category: string,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saved = await client.query(
      `UPDATE ticket_classifications c
       SET status = 'completed', category = $2, completed_at = now(), updated_at = now(),
           next_attempt_at = now(), last_error = NULL
       WHERE c.ticket_id = $1 AND c.status = 'in_progress'
       RETURNING c.ticket_id`,
      [ticket.id, category],
    );
    if (saved.rowCount) {
      await client.query(
        `UPDATE classification_attempts
         SET status = 'succeeded', category = $3, finished_at = now()
         WHERE ticket_id = $1 AND call_number = $2 AND status = 'started'`,
        [ticket.id, callNumber, category],
      );
      await client.query(
        `UPDATE tickets SET lease_expires_at = NULL, lease_token = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2`,
        [ticket.id, ticket.lease_token],
      );
      await client.query(
        `INSERT INTO ingestion_events (message_id, event_type, reason)
         VALUES ($1, 'classification_succeeded', $2)`,
        [ticket.message_id, `Classified as ${category}`],
      );
    } else {
      const current = await client.query(
        "SELECT status, category FROM ticket_classifications WHERE ticket_id = $1",
        [ticket.id],
      );
      if (current.rows[0]?.status !== "completed") {
        throw new Error("Classification lease was lost before checkpoint persistence");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistClassificationFailure(
  pool: Pool,
  ticket: ClaimedTicket,
  callNumber: number,
  attempts: number,
  maxAttempts: number,
  retryDelayMs: number,
  reason: string,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      `SELECT c.status, t.lease_token
       FROM ticket_classifications c JOIN tickets t ON t.id = c.ticket_id
       WHERE c.ticket_id = $1 FOR UPDATE OF c, t`,
      [ticket.id],
    );
    if (
      owner.rows[0]?.status !== "in_progress" ||
      owner.rows[0]?.lease_token !== ticket.lease_token
    ) {
      await client.query("COMMIT");
      return;
    }
    const state = attempts >= maxAttempts ? "failed" : "pending";
    await client.query(
      `UPDATE classification_attempts
       SET status = 'failed', failure_reason = $3, finished_at = now()
       WHERE ticket_id = $1 AND call_number = $2 AND status = 'started'`,
      [ticket.id, callNumber, reason],
    );
    await client.query(
      `UPDATE ticket_classifications
       SET status = $2, updated_at = now(), last_error = $3,
           next_attempt_at = CASE WHEN $2 = 'pending'
             THEN now() + ($4 * interval '1 millisecond') ELSE next_attempt_at END
       WHERE ticket_id = $1 AND status = 'in_progress'`,
      [ticket.id, state, reason, retryDelayMs],
    );
    await client.query(
      `UPDATE tickets SET status = $2, updated_at = now(), lease_expires_at = NULL,
           lease_token = NULL, last_error = $3
       WHERE id = $1 AND lease_token = $4`,
      [ticket.id, state, reason, ticket.lease_token],
    );
    await client.query(
      `INSERT INTO ingestion_events (message_id, event_type, reason)
       VALUES ($1, $2, $3)`,
      [
        ticket.message_id,
        attempts >= maxAttempts ? "classification_failed" : "classification_retry_scheduled",
        reason,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function classifyClaimedTicket(
  pool: Pool,
  llm: OpenAiCompatibleLlmClient,
  ticket: ClaimedTicket,
  options: ClassificationOptions,
  logger: Logger,
) {
  const attempt = await beginClassificationAttempt(pool, ticket);
  if (!attempt) return;

  const heartbeat = setInterval(() => {
    void pool.query(
      `UPDATE tickets SET lease_expires_at = now() + ($2 * interval '1 millisecond')
       WHERE id = $1 AND lease_token = $3 AND status = 'processing'`,
      [ticket.id, options.leaseMs, ticket.lease_token],
    ).catch((error: unknown) => {
      logger.error({ err: error, messageId: ticket.message_id }, "Could not renew classification lease");
    });
  }, Math.max(1000, Math.floor(options.leaseMs / 3)));
  heartbeat.unref();

  try {
    const category = await llm.classify(ticket.original_text);
    await retryPersistence(
      () => persistClassificationSuccess(pool, ticket, attempt.callNumber, category),
      logger,
      ticket,
    );
    logger.info(
      { messageId: ticket.message_id, category },
      "Ticket classification checkpoint persisted",
    );
  } catch (error) {
    const reason = error instanceof ClassificationError
      ? `${error.code}: ${error.message}`
      : "classification_processing_error";
    const attempts = await retryPersistence(
      async () => {
        const result = await pool.query<{ attempts: number }>(
          "SELECT attempts FROM ticket_classifications WHERE ticket_id = $1",
          [ticket.id],
        );
        const attempts = result.rows[0]?.attempts ?? options.maxAttempts;
        const retryDelayMs = Math.min(
          options.retryBaseMs * 2 ** Math.max(0, attempts - 1),
          options.retryMaxMs,
        );
        await persistClassificationFailure(
          pool,
          ticket,
          attempt.callNumber,
          attempts,
          options.maxAttempts,
          retryDelayMs,
          reason,
        );
        return attempts;
      },
      logger,
      ticket,
    );
    logger.warn(
      { messageId: ticket.message_id, attempts, maxAttempts: options.maxAttempts, reason },
      attempts >= options.maxAttempts
        ? "Classification failed permanently for this retry cycle"
        : "Classification failed; retry scheduled",
    );
  } finally {
    clearInterval(heartbeat);
  }
}

async function beginExtractionAttempt(pool: Pool, ticket: ClaimedTicket) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ call_number: number }>(
      `UPDATE ticket_extractions x
       SET status = 'in_progress', attempts = x.attempts + 1,
           llm_calls = x.llm_calls + 1, started_at = now(),
           updated_at = now(), last_error = NULL
       FROM tickets t JOIN ticket_classifications c ON c.ticket_id = t.id
       WHERE x.ticket_id = t.id AND t.id = $1 AND t.lease_token = $2
         AND t.status = 'processing' AND c.status = 'completed'
         AND x.status = 'pending'
       RETURNING x.llm_calls AS call_number`,
      [ticket.id, ticket.lease_token],
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const callNumber = result.rows[0].call_number;
    await client.query(
      `INSERT INTO extraction_attempts (ticket_id, call_number, status)
       VALUES ($1, $2, 'started')`,
      [ticket.id, callNumber],
    );
    await client.query(
      `INSERT INTO ingestion_events (message_id, event_type, reason)
       VALUES ($1, 'extraction_started', $2)`,
      [ticket.message_id, `LLM extraction call ${callNumber} started`],
    );
    await client.query("COMMIT");
    return { callNumber };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistExtractionSuccess(
  pool: Pool,
  ticket: ClaimedTicket,
  callNumber: number,
  extraction: ExtractionResult,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saved = await client.query(
      `UPDATE ticket_extractions x
       SET status = 'completed', order_id = $3, product = $4, urgency = $5,
           requested_action = $6, completed_at = now(), updated_at = now(),
           next_attempt_at = now(), last_error = NULL
       FROM tickets t
       WHERE x.ticket_id = t.id AND t.id = $1 AND t.lease_token = $2
         AND t.status = 'processing' AND x.status = 'in_progress'
       RETURNING x.ticket_id`,
      [
        ticket.id,
        ticket.lease_token,
        extraction.order_id,
        extraction.product,
        extraction.urgency,
        extraction.requested_action,
      ],
    );
    if (saved.rowCount) {
      const attempt = await client.query(
        `UPDATE extraction_attempts
         SET status = 'succeeded', finished_at = now()
         WHERE ticket_id = $1 AND call_number = $2 AND status = 'started'`,
        [ticket.id, callNumber],
      );
      if (!attempt.rowCount) throw new Error("Extraction attempt record was not available");
    } else {
      const current = await client.query(
        "SELECT status FROM ticket_extractions WHERE ticket_id = $1",
        [ticket.id],
      );
      if (current.rows[0]?.status !== "completed") {
        throw new Error("Extraction lease was lost before checkpoint persistence");
      }
    }
    const completed = await client.query(
      `UPDATE tickets
       SET status = 'completed', completed_at = now(), updated_at = now(),
           lease_expires_at = NULL, lease_token = NULL, last_error = NULL
       WHERE id = $1 AND lease_token = $2 AND status = 'processing'
       RETURNING message_id`,
      [ticket.id, ticket.lease_token],
    );
    if (completed.rowCount) {
      await client.query(
        `INSERT INTO ingestion_events (message_id, event_type, reason)
         VALUES ($1, 'extraction_succeeded', $2), ($1, 'ticket_completed', $3)`,
        [ticket.message_id, "Extraction checkpoint persisted", "Classification and extraction completed"],
      );
    } else {
      const current = await client.query(
        "SELECT status FROM tickets WHERE id = $1",
        [ticket.id],
      );
      if (current.rows[0]?.status !== "completed") {
        throw new Error("Ticket lease was lost before final completion");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function persistExtractionFailure(
  pool: Pool,
  ticket: ClaimedTicket,
  callNumber: number,
  attempts: number,
  maxAttempts: number,
  retryDelayMs: number,
  reason: string,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query(
      `SELECT x.status, t.lease_token
       FROM ticket_extractions x JOIN tickets t ON t.id = x.ticket_id
       WHERE x.ticket_id = $1 FOR UPDATE OF x, t`,
      [ticket.id],
    );
    if (
      owner.rows[0]?.status !== "in_progress" ||
      owner.rows[0]?.lease_token !== ticket.lease_token
    ) {
      await client.query("COMMIT");
      return;
    }
    const state = attempts >= maxAttempts ? "failed" : "pending";
    await client.query(
      `UPDATE extraction_attempts
       SET status = 'failed', failure_reason = $3, finished_at = now()
       WHERE ticket_id = $1 AND call_number = $2 AND status = 'started'`,
      [ticket.id, callNumber, reason],
    );
    await client.query(
      `UPDATE ticket_extractions
       SET status = $2, updated_at = now(), last_error = $3,
           next_attempt_at = CASE WHEN $2 = 'pending'
             THEN now() + ($4 * interval '1 millisecond') ELSE next_attempt_at END
       WHERE ticket_id = $1 AND status = 'in_progress'`,
      [ticket.id, state, reason, retryDelayMs],
    );
    await client.query(
      `UPDATE tickets SET status = $2, updated_at = now(), lease_expires_at = NULL,
           lease_token = NULL, last_error = $3, completed_at = NULL
       WHERE id = $1 AND lease_token = $4`,
      [ticket.id, state, reason, ticket.lease_token],
    );
    await client.query(
      `INSERT INTO ingestion_events (message_id, event_type, reason)
       VALUES ($1, $2, $3)`,
      [
        ticket.message_id,
        attempts >= maxAttempts ? "extraction_failed" : "extraction_retry_scheduled",
        reason,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeCompletedExtraction(pool: Pool, ticket: ClaimedTicket) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE tickets t
       SET status = 'completed', completed_at = COALESCE(t.completed_at, now()),
           updated_at = now(), lease_expires_at = NULL, lease_token = NULL
       FROM ticket_classifications c JOIN ticket_extractions x ON x.ticket_id = c.ticket_id
       WHERE t.id = $1 AND t.lease_token = $2 AND c.ticket_id = t.id
         AND c.status = 'completed' AND x.status = 'completed'
       RETURNING t.message_id`,
      [ticket.id, ticket.lease_token],
    );
    if (result.rowCount) {
      await client.query(
        `INSERT INTO ingestion_events (message_id, event_type, reason)
         VALUES ($1, 'ticket_completed', $2)`,
        [ticket.message_id, "Reused committed extraction checkpoint"],
      );
    } else {
      const current = await client.query("SELECT status FROM tickets WHERE id = $1", [ticket.id]);
      if (current.rows[0]?.status !== "completed") {
        throw new Error("Could not finalize the committed extraction checkpoint");
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function extractClaimedTicket(
  pool: Pool,
  llm: OpenAiCompatibleLlmClient,
  ticket: ClaimedTicket,
  options: ClassificationOptions,
  logger: Logger,
) {
  if (ticket.extraction_status === "completed") {
    await retryPersistence(
      () => finalizeCompletedExtraction(pool, ticket),
      logger,
      ticket,
    );
    return;
  }

  const attempt = await beginExtractionAttempt(pool, ticket);
  if (!attempt) return;
  const heartbeat = setInterval(() => {
    void pool.query(
      `UPDATE tickets SET lease_expires_at = now() + ($2 * interval '1 millisecond')
       WHERE id = $1 AND lease_token = $3 AND status = 'processing'`,
      [ticket.id, options.leaseMs, ticket.lease_token],
    ).catch((error: unknown) => {
      logger.error({ err: error, messageId: ticket.message_id }, "Could not renew extraction lease");
    });
  }, Math.max(1000, Math.floor(options.leaseMs / 3)));
  heartbeat.unref();
  const startedAt = performance.now();

  try {
    if (!ticket.classification_category) {
      throw new Error("Persisted classification category is missing");
    }
    const result = await llm.extract(
      ticket.original_text,
      ticket.classification_category,
    );
    const durationMs = Math.round(performance.now() - startedAt);
    await retryPersistence(
      () => persistExtractionSuccess(pool, ticket, attempt.callNumber, result),
      logger,
      ticket,
    );
    logger.info(
      {
        messageId: ticket.message_id,
        model: llm.modelName,
        durationMs,
        outcome: "succeeded",
        callNumber: attempt.callNumber,
      },
      "Ticket extraction checkpoint persisted",
    );
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    const reason = error instanceof ClassificationError || error instanceof ExtractionError
      ? `${error.code}: ${error.message}`
      : "extraction_processing_error";
    const attempts = await retryPersistence(
      async () => {
        const checkpoint = await pool.query<{ attempts: number }>(
          "SELECT attempts FROM ticket_extractions WHERE ticket_id = $1",
          [ticket.id],
        );
        const currentAttempts = checkpoint.rows[0]?.attempts ?? options.maxAttempts;
        const retryDelayMs = Math.min(
          options.retryBaseMs * 2 ** Math.max(0, currentAttempts - 1),
          options.retryMaxMs,
        );
        await persistExtractionFailure(
          pool,
          ticket,
          attempt.callNumber,
          currentAttempts,
          options.maxAttempts,
          retryDelayMs,
          reason,
        );
        return currentAttempts;
      },
      logger,
      ticket,
    );
    logger.warn(
      {
        messageId: ticket.message_id,
        model: llm.modelName,
        durationMs,
        outcome: "failed",
        callNumber: attempt.callNumber,
        attempts,
        maxAttempts: options.maxAttempts,
        reason,
      },
      attempts >= options.maxAttempts
        ? "Ticket extraction failed permanently for this retry cycle"
        : "Ticket extraction failed; retry scheduled",
    );
  } finally {
    clearInterval(heartbeat);
  }
}
