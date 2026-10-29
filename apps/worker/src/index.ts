import pino from "pino";
import { PROJECT_NAME } from "@ticket-rpc/shared";
import { pool, runMigrations } from "@ticket-rpc/shared/database";
import { OpenAiCompatibleLlmClient } from "./llm-client.js";
import { classifyClaimedTicket, pollAndClaim } from "./worker.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
pool.on("error", (error) => {
  logger.error({ err: error }, "Idle PostgreSQL connection failed");
});

function integerSetting(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const pollingIntervalMs = integerSetting("WORKER_POLL_INTERVAL_MS", 1000);
const concurrency = integerSetting("WORKER_CONCURRENCY", 2);
const leaseMs = integerSetting("WORKER_PROCESSING_LEASE_MS", 60_000);
const retryBaseMs = integerSetting("DB_RETRY_BASE_MS", 500);
const retryMaxMs = integerSetting("DB_RETRY_MAX_MS", 30_000);
const classificationMaxAttempts = integerSetting("CLASSIFICATION_MAX_ATTEMPTS", 3);
const classificationRetryBaseMs = integerSetting("CLASSIFICATION_RETRY_BASE_MS", 1_000);
const classificationRetryMaxMs = integerSetting("CLASSIFICATION_RETRY_MAX_MS", 10_000);
const llm = new OpenAiCompatibleLlmClient({
  baseUrl: process.env.LLM_BASE_URL ?? "https://6efd-219-65-111-226.ngrok-free.app",
  model: process.env.LLM_MODEL ?? "qwen3-4b",
  apiKey: process.env.LLM_API_KEY,
  timeoutMs: integerSetting("LLM_TIMEOUT_MS", 300_000),
});
let stopping = false;
const activeJobs = new Map<string, Promise<void>>();

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  let failures = 0;
  while (!stopping) {
    try {
      await runMigrations();
      break;
    } catch (error) {
      failures += 1;
      const delay = Math.min(retryBaseMs * 2 ** Math.min(failures - 1, 10), retryMaxMs);
      logger.error({ err: error, retryInMs: delay }, "Worker database startup failed");
      await wait(delay);
    }
  }
  logger.info({ project: PROJECT_NAME }, "Worker runtime started");
  while (!stopping) {
    try {
      const availableSlots = Math.max(0, concurrency - activeJobs.size);
      if (availableSlots === 0) {
        await wait(pollingIntervalMs);
        continue;
      }
      const result = await pollAndClaim(pool, { concurrency: availableSlots, leaseMs });
      if (result.recovered.length || result.claimed.length) {
        logger.info(
          { recovered: result.recovered.length, claimed: result.claimed.length },
          "Worker poll completed",
        );
      }
      for (const ticket of result.claimed) {
        const job = classifyClaimedTicket(
          pool,
          llm,
          ticket,
          {
            maxAttempts: classificationMaxAttempts,
            retryBaseMs: classificationRetryBaseMs,
            retryMaxMs: classificationRetryMaxMs,
            leaseMs,
          },
          logger,
        )
          .catch((error: unknown) => {
            logger.error({ err: error, messageId: ticket.message_id }, "Classification worker failed");
          })
          .finally(() => activeJobs.delete(ticket.id));
        activeJobs.set(ticket.id, job);
      }
      failures = 0;
      await wait(pollingIntervalMs);
    } catch (error) {
      failures += 1;
      const delay = Math.min(retryBaseMs * 2 ** Math.min(failures - 1, 10), retryMaxMs);
      logger.error({ err: error, retryInMs: delay }, "Worker database operation failed");
      await wait(delay);
    }
  }
  await Promise.all(activeJobs.values());
}

const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Worker runtime stopping");
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  logger.error({ err: error }, "Unhandled worker rejection");
});

void run()
  .catch((error: unknown) => {
    logger.fatal({ err: error }, "Worker startup failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
