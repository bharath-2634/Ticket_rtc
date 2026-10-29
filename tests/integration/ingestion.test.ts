import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool, runMigrations } from "@ticket-rpc/shared/database";
import { app } from "../../apps/api/src/app.js";
import { pollAndClaim } from "../../apps/worker/src/worker.js";

const prefix = `it-${randomUUID()}-`;
const id = (name: string) => `${prefix}${name}`;
let databaseReady = false;

describe("ticket ingestion with PostgreSQL", () => {
  beforeAll(async () => {
    await runMigrations();
    databaseReady = true;
  });

  afterAll(async () => {
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
