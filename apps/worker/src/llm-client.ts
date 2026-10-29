import { z } from "zod";
import {
  extractionInstructions,
  parseExtraction,
  type ExtractionResult,
} from "./extraction.js";

export const classificationCategories = [
  "Billing",
  "Technical issue",
  "Account access",
  "Refund",
  "Other",
] as const;

export type ClassificationCategory = (typeof classificationCategories)[number];

const classificationResultSchema = z
  .object({ category: z.enum(classificationCategories) })
  .strict();

const chatCompletionSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string().nullable() }),
    }),
  ).min(1),
});

export type LlmClientConfig = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
};

export class ClassificationError extends Error {
  constructor(
    message: string,
    readonly code:
      | "llm_timeout"
      | "llm_connection_error"
      | "llm_http_error"
      | "llm_malformed_response"
      | "llm_invalid_output",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClassificationError";
  }
}

const classificationInstructions = `Classify the customer message into exactly one category:
- Billing: charges, invoices, payments, subscriptions, plans, prices, or fees, unless the customer is asking to get money back.
- Technical issue: a product or application is not working as expected.
- Account access: login, password, OTP, two-factor authentication, security concerns, or account-detail changes.
- Refund: asks for money back, a reversed charge, store credit, or a price difference.
- Other: delivery questions, product enquiries, feedback, suggestions, spam, or anything else.
For multiple issues, select the category matching the primary requested resolution.
Do not infer urgency from emotional wording.
Return only a valid JSON object with exactly one field, category, whose value is one of: Billing, Technical issue, Account access, Refund, Other. Do not include markdown or explanation.`;

export function parseClassification(content: string | null | undefined): ClassificationCategory {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ClassificationError("The LLM returned empty content.", "llm_invalid_output");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch (error) {
    throw new ClassificationError("The LLM response was not valid JSON.", "llm_invalid_output", {
      cause: error,
    });
  }
  const parsed = classificationResultSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ClassificationError(
      "The LLM response did not match the classification contract.",
      "llm_invalid_output",
    );
  }
  return parsed.data.category;
}

export class OpenAiCompatibleLlmClient {
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(
    private readonly config: LlmClientConfig,
    fetchImplementation: typeof fetch = fetch,
  ) {
    const base = config.baseUrl.replace(/\/+$/, "");
    this.endpoint = base.endsWith("/v1")
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;
    this.fetchImplementation = fetchImplementation;
  }

  get modelName() {
    return this.config.model;
  }

  private async extractionCompletion(text: string, category: ClassificationCategory) {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "true",
      };
      if (this.config.apiKey) {
        headers.authorization = `\u0042earer ${this.config.apiKey}`;
      }
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: extractionInstructions },
            {
              role: "user",
              content: JSON.stringify({
                persisted_category: category,
                original_customer_message: text,
              }),
            },
          ],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new ClassificationError("The LLM request timed out.", "llm_timeout", { cause: error });
      }
      throw new ClassificationError("The LLM endpoint could not be reached.", "llm_connection_error", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new ClassificationError(
        `The LLM endpoint returned HTTP ${response.status}.`,
        "llm_http_error",
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ClassificationError("The LLM response body was not valid JSON.", "llm_malformed_response", {
        cause: error,
      });
    }
    const parsedBody = chatCompletionSchema.safeParse(body);
    if (!parsedBody.success) {
      throw new ClassificationError(
        "The LLM response did not contain a chat completion.",
        "llm_malformed_response",
      );
    }
    return parseExtraction(parsedBody.data.choices[0].message.content, text);
  }

  async extract(text: string, category: ClassificationCategory): Promise<ExtractionResult> {
    return this.extractionCompletion(text, category);
  }

  async classify(text: string): Promise<ClassificationCategory> {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "ngrok-skip-browser-warning": "true",
      };
      if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
      response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: "system", content: classificationInstructions },
            { role: "user", content: text },
          ],
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new ClassificationError("The LLM request timed out.", "llm_timeout", { cause: error });
      }
      throw new ClassificationError("The LLM endpoint could not be reached.", "llm_connection_error", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new ClassificationError(
        `The LLM endpoint returned HTTP ${response.status}.`,
        "llm_http_error",
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ClassificationError("The LLM response body was not valid JSON.", "llm_malformed_response", {
        cause: error,
      });
    }
    const parsedBody = chatCompletionSchema.safeParse(body);
    if (!parsedBody.success) {
      throw new ClassificationError(
        "The LLM response did not contain a chat completion.",
        "llm_malformed_response",
      );
    }
    return parseClassification(parsedBody.data.choices[0].message.content);
  }
}
