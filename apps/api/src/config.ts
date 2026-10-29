import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://ticket_rpc:ticket_rpc_dev@localhost:5432/ticket_rpc"),
  MAX_REQUEST_BODY_SIZE: z.string().default("1mb"),
  MAX_TICKET_TEXT_LENGTH: z.coerce.number().int().positive().default(100_000),
  DASHBOARD_ORIGIN: z.string().default("http://localhost:5173"),
  LOG_LEVEL: z.string().default("info"),
  LLM_BASE_URL: z.string().url().default("https://6efd-219-65-111-226.ngrok-free.app"),
  LLM_MODEL: z.string().default("qwen3-4b"),
  LLM_API_KEY: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  CLASSIFICATION_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  CLASSIFICATION_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),
  CLASSIFICATION_RETRY_MAX_MS: z.coerce.number().int().positive().default(10_000),
});

export const config = configSchema.parse(process.env);
