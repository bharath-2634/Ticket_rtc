import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool, runMigrations } from "@ticket-rpc/shared/database";
import { app } from "../../apps/api/src/app.js";
import { OpenAiCompatibleLlmClient } from "../../apps/worker/src/llm-client.js";
import { classifyClaimedTicket, pollAndClaim } from "../../apps/worker/src/worker.js";
import pino from "pino";

const prefix = `it-${randomUUID()}-`;
const id = (name: string) => `${prefix}${name}`;
const fixture = JSON.parse(
  await readFile(new URL("../fixtures/ingestion-messages.json", import.meta.url), "utf8"),
) as Array<{ message_id: string; text: string }>;
let databaseReady = false;
const logger = pino({ enabled: false });
const llmServers: Server[] = [];

async function startLlm(status: number, content: string, count: { calls: number }) {
  const server = createServer((_request, response) => {
    count.calls += 1;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { content } }],
    }));
  });
  llmServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start test LLM");
  return new OpenAiCompatibleLlmClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: "test-model",
    timeoutMs: 1000,
  });
}

describe("ticket ingestion with PostgreSQL", () => {
  beforeAll(async () => {
    await runMigrations();
    databaseReady = true;
  });

  afterAll(async () => {
    await Promise.all(
      llmServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    if (!databaseReady) return;
    await pool.query("DELETE FROM ingestion_events WHERE message_id LIKE $1", [`${prefix}%`]);
    await pool.query("DELETE FROM tickets WHERE message_id LIKE $1", [`${prefix}%`]);
  });

  it("persists accepted input exactly and returns stable identical-duplicate responses", async () => {
    const text = "  Original text, unicode 😀  ";
    const accepted = await request(app).post("/api/v1/tickets").send({ message_id: id("same"), text });
    expect(accepted.status).toBe(202);
    expect(accepted.body.status).toBe("pending");
    const duplicate = await request(app).post("/api/v1/tickets").send({ message_id: id("same"), text });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.duplicate).toBe(true);
    const stored = await pool.query("SELECT original_text, status, attempts FROM tickets WHERE message_id = $1", [
      id("same"),
    ]);
    expect(stored.rows[0]).toEqual({ original_text: text, status: "pending", attempts: 0 });
    expect((await pool.query("SELECT count(*)::int AS count FROM tickets WHERE message_id = $1", [id("same")])).rows[0].count).toBe(1);
  });

  it("preserves the original payload and records conflicts", async () => {
    await request(app).post("/api/v1/tickets").send({ message_id: id("conflict"), text: "first" });
    const result = await request(app).post("/api/v1/tickets").send({
      message_id: id("conflict"),
      text: "different",
    });
    expect(result.status).toBe(409);
    expect((await pool.query("SELECT original_text FROM tickets WHERE message_id = $1", [id("conflict")])).rows[0].original_text).toBe("first");
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM ingestion_events WHERE message_id = $1 AND event_type = 'payload_conflict'",
      [id("conflict")],
    )).rows[0].count).toBe(1);
  });

  it("records empty and whitespace-only messages as rejected tickets", async () => {
    for (const [name, text] of [
      ["empty", ""],
      ["spaces", " \t "],
      ["too-long", "x".repeat(100_001)],
    ] as const) {
      const result = await request(app).post("/api/v1/tickets").send({ message_id: id(name), text });
      expect(result.status).toBe(422);
      expect(result.body.rejection_reason).toMatch(
        name === "too-long" ? /maximum length/ : /empty|whitespace/,
      );
      const stored = await pool.query("SELECT status, rejection_reason FROM tickets WHERE message_id = $1", [id(name)]);
      expect(stored.rows[0].status).toBe("rejected");
      expect(stored.rows[0].rejection_reason).toBeTruthy();
      expect((await pool.query(
        `SELECT count(*)::int AS count FROM ticket_classifications c
         JOIN tickets t ON t.id = c.ticket_id WHERE t.message_id = $1`,
        [id(name)],
      )).rows[0].count).toBe(0);
    }
  });

  it("handles invalid bodies and persists request events without creating tickets", async () => {
    const invalid = await request(app).post("/api/v1/tickets").send({
      message_id: id("invalid"),
      text: "text",
      extra: true,
    });
    expect(invalid.status).toBe(400);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM ingestion_events WHERE message_id = $1 AND event_type = 'request_rejected'",
      [id("invalid")],
    )).rows[0].count).toBe(1);
    const missingId = await request(app).post("/api/v1/tickets").send({ text: "missing id" });
    expect(missingId.status).toBe(400);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM ingestion_events
       WHERE message_id IS NULL AND event_type = 'request_rejected'`,
    )).rows[0].count).toBeGreaterThan(0);
    const malformed = await request(app)
      .post("/api/v1/tickets")
      .set("content-type", "application/json")
      .send('{"broken"');
    expect(malformed.status).toBe(400);
    const unsupported = await request(app).post("/api/v1/tickets").type("text").send("plain");
    expect(unsupported.status).toBe(415);
    const oversized = await request(app)
      .post("/api/v1/tickets")
      .set("content-type", "application/json")
      .send(JSON.stringify({ message_id: id("large"), text: "x".repeat(1_100_000) }));
    expect(oversized.status).toBe(413);
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM ingestion_events
       WHERE event_type = 'ingestion_error'
         AND reason IN ('malformed_json', 'unsupported_content_type', 'request_body_too_large')`,
    )).rows[0].count).toBeGreaterThanOrEqual(3);
  });

  it("creates one ticket for concurrent identical submissions", async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        request(app).post("/api/v1/tickets").send({ message_id: id("race"), text: "same payload" }),
      ),
    );
    expect(responses.filter((response) => response.status === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(11);
    expect((await pool.query("SELECT count(*)::int AS count FROM tickets WHERE message_id = $1", [id("race")])).rows[0].count).toBe(1);
  });

  it("preserves one original payload during concurrent conflicting submissions", async () => {
    const payloads = Array.from({ length: 10 }, (_, index) => `conflict payload ${index}`);
    const responses = await Promise.all(
      payloads.map((text) =>
        request(app).post("/api/v1/tickets").send({ message_id: id("conflict-race"), text }),
      ),
    );
    expect(responses.filter((response) => response.status === 202)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(9);
    const stored = await pool.query("SELECT original_text FROM tickets WHERE message_id = $1", [
      id("conflict-race"),
    ]);
    expect(payloads).toContain(stored.rows[0].original_text);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM ingestion_events WHERE message_id = $1 AND event_type = 'payload_conflict'",
      [id("conflict-race")],
    )).rows[0].count).toBe(9);
  });

  it("records failed ticket retry transitions atomically", async () => {
    await request(app).post("/api/v1/tickets").send({ message_id: id("retry"), text: "retry me" });
    await pool.query("UPDATE tickets SET status = 'failed' WHERE message_id = $1", [id("retry")]);
    await pool.query(
      `UPDATE ticket_classifications SET status = 'failed', last_error = 'test failure'
       WHERE ticket_id = (SELECT id FROM tickets WHERE message_id = $1)`,
      [id("retry")],
    );
    const retries = await Promise.all([
      request(app).post(`/api/v1/tickets/${id("retry")}/retry`),
      request(app).post(`/api/v1/tickets/${id("retry")}/retry`),
    ]);
    expect(retries.map((response) => response.status).sort()).toEqual([202, 409]);
    expect((await request(app).post(`/api/v1/tickets/${id("missing")}/retry`)).status).toBe(404);
    expect((await request(app).post(`/api/v1/tickets/${id("retry")}/retry`)).status).toBe(409);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM ingestion_events WHERE message_id = $1 AND event_type = 'retry_requested'",
      [id("retry")],
    )).rows[0].count).toBe(1);
  });

  it("recovers expired leases and concurrently claims each pending ticket once", async () => {
    const expiredId = id("expired");
    await request(app).post("/api/v1/tickets").send({ message_id: expiredId, text: "recover" });
    await pool.query(
      `UPDATE tickets SET status = 'processing', attempts = 1, lease_expires_at = now() - interval '1 second'
       WHERE message_id = $1`,
      [expiredId],
    );
    const recovered = await pollAndClaim(pool, {
      concurrency: 100,
      leaseMs: 60_000,
      messageIdPrefix: prefix,
    });

    expect(recovered.recovered.some((ticket) => ticket.message_id === expiredId)).toBe(true);
    expect(recovered.claimed.some((ticket) => ticket.message_id === expiredId)).toBe(true);
    expect((await pool.query("SELECT status, attempts FROM tickets WHERE message_id = $1", [expiredId])).rows[0]).toEqual({
      status: "processing",
      attempts: 2,
    });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM ingestion_events WHERE message_id = $1 AND event_type = 'worker_recovered'",
      [expiredId],
    )).rows[0].count).toBe(1);
  });

  it("persists one valid category checkpoint and does not repeat completed classification", async () => {
    const messageId = id("classify-once");
    await request(app).post("/api/v1/tickets").send({
      message_id: messageId,
      text: "I was charged twice; please return the extra payment.",
    });
    const [claimed, competing] = await Promise.all([
      pollAndClaim(pool, { concurrency: 1, leaseMs: 60_000, messageIdPrefix: messageId }),
      pollAndClaim(pool, { concurrency: 1, leaseMs: 60_000, messageIdPrefix: messageId }),
    ]);
    const ticket = claimed.claimed.find((candidate) => candidate.message_id === messageId);
    const competingTicket = competing.claimed.find((candidate) => candidate.message_id === messageId);
    expect(ticket).toBeDefined();
    expect(competingTicket).toBeUndefined();
    const calls = { calls: 0 };
    const llm = await startLlm(200, '{"category":"Refund"}', calls);
    await classifyClaimedTicket(
      pool,
      llm,
      ticket!,
      { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 5, leaseMs: 60_000 },
      logger,
    );
    await classifyClaimedTicket(
      pool,
      llm,
      ticket!,
      { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 5, leaseMs: 60_000 },
      logger,
    );
    expect(calls.calls).toBe(1);
    const persisted = await pool.query(
      `SELECT t.status, c.status AS classification_status, c.category,
              c.attempts, c.llm_calls
       FROM tickets t JOIN ticket_classifications c ON c.ticket_id = t.id
       WHERE t.message_id = $1`,
      [messageId],
    );
    expect(persisted.rows[0]).toEqual({
      status: "processing",
      classification_status: "completed",
      category: "Refund",
      attempts: 1,
      llm_calls: 1,
    });
    const apiResult = await request(app).get(`/api/v1/tickets/${messageId}`);
    expect(apiResult.body.ticket.classification_category).toBe("Refund");
    expect(apiResult.body.ticket.classification_status).toBe("completed");
  });

  it("classifies only eligible messages from the supplied fixture through HTTP and PostgreSQL", async () => {
    const fixturePrefix = `${prefix}fixture-`;
    const fixtureMessages = fixture.map((message) => ({
      ...message,
      message_id: `${fixturePrefix}${message.message_id}`,
    }));
    const responses = await Promise.all(
      fixtureMessages.map((message) =>
        request(app).post("/api/v1/tickets").send(message),
      ),
    );
    expect(responses.filter((response) => response.status === 202)).toHaveLength(23);
    expect(responses.filter((response) => response.status === 422)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);

    const claimed = await pollAndClaim(pool, {
      concurrency: 32,
      leaseMs: 60_000,
      messageIdPrefix: fixturePrefix,
    });
    expect(claimed.claimed).toHaveLength(23);
    const calls = { calls: 0 };
    const llm = await startLlm(200, '{"category":"Other"}', calls);
    await Promise.all(
      claimed.claimed.map((ticket) =>
        classifyClaimedTicket(
          pool,
          llm,
          ticket,
          { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 5, leaseMs: 60_000 },
          logger,
        ),
      ),
    );
    expect(calls.calls).toBe(23);

    const persisted = await pool.query(
      `SELECT t.message_id, t.status, c.status AS classification_status,
              c.category, c.llm_calls
       FROM tickets t LEFT JOIN ticket_classifications c ON c.ticket_id = t.id
       WHERE t.message_id LIKE $1`,
      [`${fixturePrefix}%`],
    );
    expect(persisted.rowCount).toBe(24);
    expect(persisted.rows.filter((ticket) => ticket.classification_status === "completed")).toHaveLength(23);
    expect(persisted.rows.every((ticket) =>
      ticket.status === "rejected" || ["Billing", "Technical issue", "Account access", "Refund", "Other"].includes(ticket.category),
    )).toBe(true);
    const rejected = persisted.rows.find((ticket) => ticket.message_id.endsWith("T-1012"));
    expect(rejected).toMatchObject({ status: "rejected", classification_status: null, category: null });
    const duplicateTicketCount = await pool.query(
      `SELECT count(*)::int AS count FROM (
         SELECT message_id FROM tickets WHERE message_id LIKE $1 GROUP BY message_id
       ) ticket_ids`,
      [`${fixturePrefix}%`],
    );
    expect(duplicateTicketCount.rows[0].count).toBe(24);
    const duplicateClassification = await pool.query(
      `SELECT count(a.id)::int AS count FROM tickets t
       JOIN classification_attempts a ON a.ticket_id = t.id
       WHERE t.message_id = $1`,
      [`${fixturePrefix}T-1007`],
    );
    expect(duplicateClassification.rows[0].count).toBe(1);
  }, 20_000);

  it("fails after three invalid LLM responses and operator retry re-enables classification", async () => {
    const messageId = id("classify-retry");
    await request(app).post("/api/v1/tickets").send({ message_id: messageId, text: "A test message" });
    const calls = { calls: 0 };
    const llm = await startLlm(200, '{"category":"not-a-category"}', calls);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = await pollAndClaim(pool, {
        concurrency: 1,
        leaseMs: 60_000,
        messageIdPrefix: messageId,
      });
      expect(claimed.claimed).toHaveLength(1);
      await classifyClaimedTicket(
        pool,
        llm,
        claimed.claimed[0]!,
        { maxAttempts: 3, retryBaseMs: 1, retryMaxMs: 5, leaseMs: 60_000 },
        logger,
      );
      await pool.query(
        `UPDATE ticket_classifications SET next_attempt_at = now()
         WHERE ticket_id = (SELECT id FROM tickets WHERE message_id = $1)`,
        [messageId],
      );
    }
    expect(calls.calls).toBe(3);
    const failed = await request(app).get(`/api/v1/tickets/${messageId}`);
    expect(failed.body.ticket.status).toBe("failed");
    expect(failed.body.ticket.classification_status).toBe("failed");
    expect(failed.body.ticket.classification_error).toContain("llm_invalid_output");
    expect((await request(app).get("/api/v1/ops/summary")).body.classification_call_failures).toBeGreaterThan(0);

    const retry = await request(app).post(`/api/v1/tickets/${messageId}/retry`);
    expect(retry.status).toBe(202);
    const checkpoint = await pool.query(
      `SELECT c.status, c.attempts, c.llm_calls, t.status AS ticket_status
       FROM ticket_classifications c JOIN tickets t ON t.id = c.ticket_id
       WHERE t.message_id = $1`,
      [messageId],
    );
    expect(checkpoint.rows[0]).toEqual({
      status: "pending",
      attempts: 0,
      llm_calls: 3,
      ticket_status: "pending",
    });
  });

  it("does not claim rejected tickets and worker instances claim disjoint tickets", async () => {
    const rejectedId = id("never-claim");
    await request(app).post("/api/v1/tickets").send({ message_id: rejectedId, text: "" });
    const pendingIds = Array.from({ length: 8 }, (_, index) => id(`worker-${index}`));
    for (const messageId of pendingIds) {
      await request(app).post("/api/v1/tickets").send({ message_id: messageId, text: "worker test" });
    }
    const results = await Promise.all([
      pollAndClaim(pool, { concurrency: 4, leaseMs: 60_000, messageIdPrefix: prefix }),
      pollAndClaim(pool, { concurrency: 4, leaseMs: 60_000, messageIdPrefix: prefix }),
    ]);
    const claims = results.flatMap((result) => result.claimed.map((ticket) => ticket.message_id));
    expect(new Set(claims).size).toBe(claims.length);
    expect(claims).not.toContain(rejectedId);
    expect((await pool.query("SELECT status FROM tickets WHERE message_id = $1", [rejectedId])).rows[0].status).toBe("rejected");
  });

  it("serves persisted list, detail, counters, and independent liveness", async () => {
    expect((await request(app).get("/health/live")).status).toBe(200);
    expect((await request(app).get("/health/ready")).status).toBe(200);
    expect((await request(app).get(`/api/v1/tickets/${id("same")}`)).body.ticket.message_id).toBe(id("same"));
    expect((await request(app).get("/api/v1/tickets?limit=1")).body.tickets).toHaveLength(1);
    expect((await request(app).get("/api/v1/ops/summary")).body.duplicate_submissions).toBeGreaterThan(0);
    expect((await request(app).get("/api/v1/ops/events")).body.events.length).toBeGreaterThan(0);
  });
});
