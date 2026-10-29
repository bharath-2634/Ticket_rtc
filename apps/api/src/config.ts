import { z } from "zod";

const configSchema = z.object({
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .default("postgresql://ticket_rpc:ticket_rpc_dev@localhost:5432/ticket_rpc"),
});

export const config = configSchema.parse(process.env);