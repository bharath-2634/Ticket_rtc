import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClassificationError,
  OpenAiCompatibleLlmClient,
  classificationCategories,
  parseClassification,
} from "../../apps/worker/src/llm-client.js";

const servers: Server[] = [];

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start test LLM server");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("classification output validation", () => {
  it.each(classificationCategories)("accepts category %s", (category) => {
    expect(parseClassification(JSON.stringify({ category }))).toBe(category);
  });

  it.each([
    ["unknown", '{"category":"Urgent"}'],
    ["missing category", "{}"],
    ["wrong type", '{"category":42}'],
    ["extra field", '{"category":"Billing","reason":"guess"}'],
    ["malformed JSON", '{"category":'],
    ["prose", 'The correct answer is {"category":"Billing"}'],
    ["empty", ""],
  ])("rejects %s output", (_label, output) => {
    expect(() => parseClassification(output)).toThrow(ClassificationError);
  });

  it("rejects null content", () => {
    expect(() => parseClassification(null)).toThrow(/empty content/);
  });
});

describe("OpenAI-compatible LLM HTTP client", () => {
  it("sends the supplied chat-completions request shape and parses the category", async () => {
    let received: { headers: Record<string, string>; body: string } | undefined;
    const baseUrl = await serve((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        received = { headers: request.headers as Record<string, string>, body };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          choices: [{ message: { content: '{"category":"Refund"}' } }],
        }));
      });
    });
    const client = new OpenAiCompatibleLlmClient({
      baseUrl,
      model: "qwen3-4b",
      apiKey: "test-key",
      timeoutMs: 1000,
    });

    await expect(client.classify("Please return my money.")).resolves.toBe("Refund");
    expect(received?.headers["ngrok-skip-browser-warning"]).toBe("true");
    expect(received?.headers.authorization).toBe("Bearer test-key");
    expect(JSON.parse(received?.body ?? "{}")).toMatchObject({
      model: "qwen3-4b",
      messages: [
        { role: "system" },
        { role: "user", content: "Please return my money." },
      ],
    });
  });

  it("rejects malformed chat-completion envelopes", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [] }));
    });
    const client = new OpenAiCompatibleLlmClient({ baseUrl, model: "test", timeoutMs: 1000 });
    await expect(client.classify("text")).rejects.toMatchObject({ code: "llm_malformed_response" });
  });

  it("reports HTTP server errors", async () => {
    const baseUrl = await serve((_request, response) => {
      response.writeHead(500);
      response.end("failure");
    });
    const client = new OpenAiCompatibleLlmClient({ baseUrl, model: "test", timeoutMs: 1000 });
    await expect(client.classify("text")).rejects.toMatchObject({ code: "llm_http_error" });
  });

  it("reports connection failures", async () => {
    const client = new OpenAiCompatibleLlmClient({
      baseUrl: "http://127.0.0.1:1",
      model: "test",
      timeoutMs: 500,
    });
    await expect(client.classify("text")).rejects.toMatchObject({ code: "llm_connection_error" });
  });

  it("aborts requests that exceed the configured timeout", async () => {
    const baseUrl = await serve((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) response.end();
      }, 200);
    });
    const client = new OpenAiCompatibleLlmClient({ baseUrl, model: "test", timeoutMs: 20 });
    await expect(client.classify("text")).rejects.toMatchObject({ code: "llm_timeout" });
  });
});
