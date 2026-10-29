import { OpenAiCompatibleLlmClient } from "../apps/worker/src/llm-client.js";

const client = new OpenAiCompatibleLlmClient({
  baseUrl: process.env.LLM_BASE_URL ?? "https://6efd-219-65-111-226.ngrok-free.app",
  model: process.env.LLM_MODEL ?? "qwen3-4b",
  apiKey: process.env.LLM_API_KEY,
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 300_000),
});

const category = await client.classify(
  "I was charged twice for my order. Please reverse the extra charge and return that money.",
);
console.log(`Live LLM smoke test passed. Category: ${category}`);
