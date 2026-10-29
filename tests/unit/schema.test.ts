import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { incomingMessageSchema } from "../../apps/api/src/schema.js";

describe("incoming message contract", () => {
  it("accepts strings including empty text and Unicode", () => {
    expect(incomingMessageSchema.safeParse({ message_id: "id-1", text: "hello" }).success).toBe(true);
    expect(incomingMessageSchema.safeParse({ message_id: "id-2", text: "" }).success).toBe(true);
    expect(incomingMessageSchema.safeParse({ message_id: "id-3", text: "வணக்கம் 😀" }).success).toBe(true);
  });

  it.each([
    [{ text: "hello" }],
    [{ message_id: "id-1" }],
    [{ message_id: 1, text: "hello" }],
    [{ message_id: "id-1", text: 1 }],
    [{ message_id: "id-1", text: "hello", unexpected: true }],
    [null],
    [42],
    ["text"],
  ])("rejects schema-invalid input %j", (input) => {
    expect(incomingMessageSchema.safeParse(input).success).toBe(false);
  });

  it("keeps the dedicated JSON Schema contract unchanged", async () => {
    const schema = JSON.parse(
      await readFile(new URL("../../apps/api/src/incoming-message.schema.json", import.meta.url), "utf8"),
    );
    expect(schema.required).toEqual(["message_id", "text"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.message_id.type).toBe("string");
    expect(schema.properties.text.type).toBe("string");
    expect(schema.properties.text.description).toContain("May be empty");
  });
});
