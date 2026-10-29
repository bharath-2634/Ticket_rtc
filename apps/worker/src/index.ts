import pino from "pino";
import { PROJECT_NAME } from "@ticket-rpc/shared";
import { pool, runMigrations } from "@ticket-rpc/shared/database";
import { pollAndClaim } from "./worker.js";

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
let stopping = false;

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
      const result = await pollAndClaim(pool, { concurrency, leaseMs });
      if (result.recovered.length || result.claimed.length) {
        logger.info(
          { recovered: result.recovered.length, claimed: result.claimed.length },
          "Worker poll completed",
        );
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
}

const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Worker runtime stopping");
  await pool.end();
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  logger.error({ err: error }, "Unhandled worker rejection");
});

void run().catch((error: unknown) => {
  logger.fatal({ err: error }, "Worker startup failed");
  process.exitCode = 1;
  void pool.end();
});
