import pino from "pino";
import { PROJECT_NAME } from "@ticket-rpc/shared";

const logger = pino();
logger.info({ project: PROJECT_NAME }, "Worker runtime started");
const keepAlive = setInterval(() => {}, 60_000);

const shutdown = (signal: string) => {
  logger.info({ signal }, "Worker runtime stopping");
  clearInterval(keepAlive);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));