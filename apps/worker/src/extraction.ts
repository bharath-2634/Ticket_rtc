import { z } from "zod";

export const productCatalogue = [
  { name: "Aura Smart Watch", aliases: ["Aura Watch", "Aura Smartwatch"] },
  { name: "CloudSync Pro", aliases: ["CloudSync Pro subscription"] },
  { name: "Pulse Earbuds", aliases: [] },
  { name: "Zen Air Purifier", aliases: [] },
  { name: "Nimbus Router X2", aliases: ["Nimbus Router"] },
  { name: "Vista 4K Monitor", aliases: ["Vista Monitor"] },
  { name: "Orbit Smart Speaker", aliases: ["Orbit Speaker"] },
  { name: "Glide Laptop Stand", aliases: [] },
] as const;

export type Urgency = "Low" | "Medium" | "High";

export type ExtractionResult = {
  order_id: string | null;
  product: string | null;
  urgency: Urgency;
  requested_action: string | null;
};

export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly code:
      | "llm_invalid_output"
      | "llm_malformed_response"
      | "invalid_order_id"
      | "unknown_product",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

const extractionResultSchema = z.object({
  order_id: z.string().nullable(),
  product: z.string().nullable(),
  urgency: z.enum(["Low", "Medium", "High"]),
  requested_action: z.string().trim().min(1).nullable(),
}).strict();

function normalizedName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function normalizeProductName(value: string | null): string | null {
  if (value === null) return null;
  const candidate = normalizedName(value);
  const product = productCatalogue.find(({ name, aliases }) =>
    [name, ...aliases].some((alias) => normalizedName(alias) === candidate),
  );
  if (!product) {
    throw new ExtractionError(`The LLM returned an unknown product name: ${value}`, "unknown_product");
  }
  return product.name;
}

function getOrderIdsFromText(text: string): Set<string> {
  const ids = new Set<string>();
  const excludedContext = (index: number) => {
    const preceding = text.slice(Math.max(0, index - 32), index);
    const lastOrder = preceding.toLocaleLowerCase("en-US").lastIndexOf("order");
    const lastOther = Math.max(
      preceding.toLocaleLowerCase("en-US").lastIndexOf("invoice"),
      preceding.toLocaleLowerCase("en-US").lastIndexOf("tracking"),
      preceding.toLocaleLowerCase("en-US").lastIndexOf("shipment"),
    );
    return lastOther > lastOrder;
  };

  for (const match of text.matchAll(/\bORD-(\d{5})\b/gi)) {
    if (match.index !== undefined && !excludedContext(match.index)) {
      ids.add(`ORD-${match[1]}`);
    }
  }
  for (const match of text.matchAll(
    /\border(?:\s+(?:id|number|no\.?))?(?:\s+(?:is|was))?\s*(?:#|:|-)?\s*(\d{5})\b/gi,
  )) {
    if (match.index !== undefined && !excludedContext(match.index)) {
      ids.add(`ORD-${match[1]}`);
    }
  }
  return ids;
}

export function normalizeOrderId(value: string | null, originalText: string): string | null {
  if (value === null) return null;
  const candidate = value.trim().toUpperCase();
  const normalized = /^\d{5}$/.test(candidate)
    ? `ORD-${candidate}`
    : /^ORD-\d{5}$/.test(candidate)
      ? candidate
      : null;
  if (!normalized || !getOrderIdsFromText(originalText).has(normalized)) {
    throw new ExtractionError(
      "The LLM returned an invalid or unsupported order ID.",
      "invalid_order_id",
    );
  }
  return normalized;
}

export function parseExtraction(
  content: string | null | undefined,
  originalText: string,
): ExtractionResult {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ExtractionError("The LLM returned empty extraction content.", "llm_invalid_output");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch (error) {
    throw new ExtractionError("The LLM extraction response was not valid JSON.", "llm_invalid_output", {
      cause: error,
    });
  }
  const parsed = extractionResultSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ExtractionError(
      "The LLM extraction response did not match the four-field contract.",
      "llm_invalid_output",
    );
  }
  return {
    order_id: normalizeOrderId(parsed.data.order_id, originalText),
    product: normalizeProductName(parsed.data.product),
    urgency: parsed.data.urgency,
    requested_action: parsed.data.requested_action,
  };
}

export const extractionInstructions = `Extract exactly these four fields from the original customer message and return only one JSON object with exactly these keys:
{"order_id": null, "product": null, "urgency": "Low", "requested_action": null}

Rules:
- order_id: use a real order ID with format ORD- followed by exactly five digits, or null. A bare five-digit value may be normalized to ORD-##### only when explicitly identified as an order number. Do not select invoice, tracking, shipment, or unrelated numbers. If an order ID is explicitly corrected, use the corrected one. With multiple IDs, use the one for the primary issue.
- product: use an official catalogue name or null. Catalogue: ${productCatalogue.map(({ name }) => name).join("; ")}. Normalize clear aliases to the official name. Do not invent products. If several are mentioned, choose the one relevant to the primary requested resolution; for a wrong-delivery complaint, extract the product ordered, not the incorrect item.
- urgency: exactly High, Medium, or Low. High means the customer cannot use a product or access an account, money was incorrectly taken, or there is a security concern. Medium means an affecting but manageable issue, pending refund, or billing problem not meeting High. Low means a general question, information request, suggestion, feedback, or non-urgent request. Judge the situation, not tone, capitalization, urgency words, punctuation, or emojis.
- requested_action: concise requested resolution, or null when no clear action is requested. For questions, state the requested answer or resolution. Do not turn a complaint into an action the customer did not request.
- Use JSON null for missing or unidentifiable values; never use empty strings, "unknown", "N/A", guesses, or fabricated values.
- Preserve the meaning of the message, including Unicode and multilingual text. Do not classify again; the persisted category is context only.
- Do not add, omit, or rename fields.`;
