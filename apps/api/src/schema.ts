import { z } from "zod";

export const incomingMessageSchema = z
  .object({ message_id: z.string(), text: z.string() })
  .strict();
