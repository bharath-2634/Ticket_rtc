import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { pool, runMigrations } from "@ticket-rpc/shared/database";
import { app } from "../../apps/api/src/app.js";
import { exportResults, writeResultsAtomically } from "../../scripts/results-export.mjs";

const prefix = `export-${randomUUID()}-`;
const messageId = (name: string) => `${prefix}${name}`;
let databaseReady = false;
let outputDirectory = "";

describe("durable results export", () => {
  beforeAll(async () => {
    await runMigrations();
    databaseReady = true;
    outputDirectory = await mkdtemp(join(tmpdir(), "ticket-results-"));

    await request(app).post("/api/v1/tickets").send({
      message_id: messageId("complete"),
      text: "My Aura Watch order ORD-48213 needs a corrected invoice.",
    });
    await pool.query(
      `UPDATE ticket_classifications SET status = 'completed', category = 'Billing',
         completed_at = now() WHERE ticket_id = (SELECT id FROM tickets WHERE message_id = $1)`,
      [messageId("complete")],
    );
    await pool.query(
      `UPDATE ticket_extractions SET status = 'completed', order_id = 'ORD-48213',
         product = 'Aura Smart Watch', urgency = 'High',
         requested_action = 'Correct the invoice', completed_at = now()
       WHERE ticket_id = (SELECT id FROM tickets WHERE message_id = $1)`,
      [messageId("complete")],
    );
    await pool.query(
      `UPDATE tickets SET status = 'completed', completed_at = now()
       WHERE message_id = $1`,
      [messageId("complete")],
    );

    await request(app).post("/api/v1/tickets").send({
      message_id: messageId("rejected"),
      text: "",
    });
    await request(app).post("/api/v1/tickets").send({
      message_id: messageId("failed"),
      text: "A ticket whose extraction failed.",
    });
    await pool.query(
      `UPDATE ticket_classifications SET status = 'completed', category = 'Other',
         completed_at = now() WHERE ticket_id = (SELECT id FROM tickets WHERE message_id = $1)`,
      [messageId("failed")],
    );
    await pool.query(
      `UPDATE ticket_extractions SET status = 'failed', last_error = 'test extraction failure'
       WHERE ticket_id = (SELECT id FROM tickets WHERE message_id = $1)`,
      [messageId("failed")],
    );
    await pool.query(
      `UPDATE tickets SET status = 'failed', last_error = 'test extraction failure'
       WHERE message_id = $1`,
      [messageId("failed")],
    );
    await request(app).post("/api/v1/tickets").send({
      message_id: messageId("unfinished"),
      text: "A ticket that has not been processed yet.",
    });
  });

  afterAll(async () => {
    if (databaseReady) {
      await pool.query("DELETE FROM ingestion_events WHERE message_id LIKE $1", [`${prefix}%`]);
      await pool.query("DELETE FROM tickets WHERE message_id LIKE $1", [`${prefix}%`]);
    }
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  });

  it("exports unique persisted tickets with exactly seven fields and truthful states", async () => {
    const outputPath = join(outputDirectory, "results.json");
    const count = await exportResults(pool, outputPath);
    const serialized = await readFile(outputPath, "utf8");
    const entries = JSON.parse(serialized) as Array<Record<string, unknown>>;
    const fixtureEntries = entries.filter((entry) =>
      typeof entry.message_id === "string" && entry.message_id.startsWith(prefix),
    );
    const expectedKeys = [
      "message_id", "status", "category", "order_id", "product", "urgency", "requested_action",
    ];

    expect(count).toBe(entries.length);
    expect(fixtureEntries).toHaveLength(4);
    expect(fixtureEntries.every((entry) =>
      JSON.stringify(Object.keys(entry).sort()) === JSON.stringify([...expectedKeys].sort()),
    )).toBe(true);
    expect(new Set(fixtureEntries.map((entry) => entry.message_id)).size).toBe(4);
    expect(fixtureEntries.find((entry) => entry.message_id === messageId("complete"))).toEqual({
      message_id: messageId("complete"),
      status: "completed",
      category: "Billing",
      order_id: "ORD-48213",
      product: "Aura Smart Watch",
      urgency: "High",
      requested_action: "Correct the invoice",
    });
    expect(fixtureEntries.find((entry) => entry.message_id === messageId("rejected"))).toMatchObject({
      status: "rejected",
      category: null,
      order_id: null,
      product: null,
      urgency: null,
      requested_action: null,
    });
    expect(fixtureEntries.find((entry) => entry.message_id === messageId("failed"))).toMatchObject({
      status: "failed",
      category: "Other",
      order_id: null,
      product: null,
      urgency: null,
      requested_action: null,
    });
    expect(fixtureEntries.find((entry) => entry.message_id === messageId("unfinished"))).toMatchObject({
      status: "pending",
      category: null,
      order_id: null,
      product: null,
      urgency: null,
      requested_action: null,
    });

    const originalTicket = await pool.query(
      "SELECT status, attempts FROM tickets WHERE message_id = $1",
      [messageId("complete")],
    );
    expect(await exportResults(pool, outputPath)).toBeGreaterThanOrEqual(count);
    expect((await pool.query(
      "SELECT status, attempts FROM tickets WHERE message_id = $1",
      [messageId("complete")],
    )).rows).toEqual(originalTicket.rows);
  });

  it("preserves the prior valid file and removes temporary files after an interrupted write", async () => {
    const outputPath = join(outputDirectory, "atomic-results.json");
    const previous = [{ message_id: "previous", status: "completed" }];
    await writeResultsAtomically(previous, outputPath);

    await expect(
      writeResultsAtomically([{ value: 1n }], outputPath),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(previous);
    expect((await readdir(outputDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await readdir(outputDirectory)).toContain("atomic-results.json");
  });
});
