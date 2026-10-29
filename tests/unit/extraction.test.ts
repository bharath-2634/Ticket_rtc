import { describe, expect, it } from "vitest";
import {
  ExtractionError,
  normalizeOrderId,
  normalizeProductName,
  parseExtraction,
  productCatalogue,
} from "../../apps/worker/src/extraction.js";
import { OpenAiCompatibleLlmClient } from "../../apps/worker/src/llm-client.js";

const originalText = "Please correct the invoice for my Aura Watch, order ORD-48213.";

function response(fields: Record<string, unknown>) {
  return JSON.stringify(fields);
}

describe("extraction output validation", () => {
  it("accepts and normalizes a valid four-field extraction", () => {
    expect(parseExtraction(response({
      order_id: "ORD-48213",
      product: "Aura Watch",
      urgency: "High",
      requested_action: "  Correct the invoice  ",
    }), originalText)).toEqual({
      order_id: "ORD-48213",
      product: "Aura Smart Watch",
      urgency: "High",
      requested_action: "Correct the invoice",
    });
  });

  it.each(["order_id", "product", "urgency", "requested_action"])(
    "rejects a response missing %s",
    (missingField) => {
      const fields: Record<string, unknown> = {
        order_id: null,
        product: null,
        urgency: "Low",
        requested_action: null,
      };
      delete fields[missingField];
      expect(() => parseExtraction(response(fields), originalText)).toThrow(ExtractionError);
    },
  );

  it.each([
    [{ order_id: null, product: null, urgency: "Urgent", requested_action: null }],
    [{ order_id: "ORD-1234", product: null, urgency: "Low", requested_action: null }],
    [{ order_id: null, product: "Imaginary Phone", urgency: "Low", requested_action: null }],
    [{ order_id: 48213, product: null, urgency: "Low", requested_action: null }],
    [{ order_id: null, product: null, urgency: "Low", requested_action: 4 }],
    [{ order_id: null, product: null, urgency: "Low", requested_action: null, extra: true }],
  ])("rejects invalid extraction values %j", (fields) => {
    expect(() => parseExtraction(response(fields), originalText)).toThrow(ExtractionError);
  });

  it.each([null, "", "   ", "not json"])("rejects empty or malformed response %j", (content) => {
    expect(() => parseExtraction(content, originalText)).toThrow(ExtractionError);
  });

  it("accepts legitimate missing values as JSON null", () => {
    expect(parseExtraction(response({
      order_id: null,
      product: null,
      urgency: "Low",
      requested_action: null,
    }), "வணக்கம், नमस्ते 😀 thanks for the help")).toEqual({
      order_id: null,
      product: null,
      urgency: "Low",
      requested_action: null,
    });
  });

  it("normalizes explicit order IDs and bare IDs only with order context", () => {
    expect(normalizeOrderId("ord-48213", "Order number 48213")).toBe("ORD-48213");
    expect(normalizeOrderId("48213", "My order number is 48213")).toBe("ORD-48213");
    expect(normalizeOrderId("ORD-48213", "Order ORD-48213")).toBe("ORD-48213");
    expect(() => normalizeOrderId("48213", "Invoice 48213; tracking 77215")).toThrow(ExtractionError);
    expect(() => normalizeOrderId("ORD-77215", "Invoice ORD-77215")).toThrow(ExtractionError);
    expect(() =>
      normalizeOrderId("ORD-22222", "I first said order ORD-11111; correction: order ORD-22222"),
    ).not.toThrow();
    expect(() =>
      normalizeOrderId("ORD-22222", "Orders ORD-11111 and ORD-22222"),
    ).not.toThrow();
  });

  it("normalizes catalogue names and clearly identified aliases only", () => {
    for (const product of productCatalogue) {
      expect(normalizeProductName(product.name)).toBe(product.name);
      for (const alias of product.aliases) {
        expect(normalizeProductName(alias)).toBe(product.name);
      }
    }
    expect(normalizeProductName("  aura   watch ")).toBe("Aura Smart Watch");
    expect(normalizeProductName(null)).toBeNull();
    expect(() => normalizeProductName("Mystery appliance")).toThrow(ExtractionError);
  });

  it("sends the original Unicode text and persisted category through the configured chat API", async () => {
    let requestUrl = "";
    let requestBody: { model: string; messages: Array<{ role: string; content: string }> } | undefined;
    const fetchMock: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as typeof requestBody;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: response({
              order_id: null,
              product: null,
              urgency: "Low",
              requested_action: null,
            }),
          },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = new OpenAiCompatibleLlmClient({
      baseUrl: "https://llm.example/v1",
      model: "configured-model",
      timeoutMs: 1000,
    }, fetchMock);
    const text = "வணக்கம் नमस्ते 😀";
    await client.extract(text, "Other");

    expect(requestUrl).toBe("https://llm.example/v1/chat/completions");
    expect(requestBody?.model).toBe("configured-model");
    expect(requestBody?.messages[0].content).toContain("Nimbus Router X2");
    expect(requestBody?.messages[1].content).toContain(text);
    expect(requestBody?.messages[1].content).toContain('"persisted_category":"Other"');
  });
});
