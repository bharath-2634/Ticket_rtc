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
});

export const config = configSchema.parse(process.env);
