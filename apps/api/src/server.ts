import { createServer } from "node:http";
import pino from "pino";
import { PROJECT_NAME } from "@ticket-rpc/shared";
import { pool, runMigrations } from "@ticket-rpc/shared/database";
import { app } from "./app.js";
import { config } from "./config.js";

const logger = pino({ level: config.LOG_LEVEL });
const server = createServer(app);

try {
  await runMigrations();
  server.listen(config.API_PORT, "0.0.0.0", () => {
    logger.info({ project: PROJECT_NAME, port: config.API_PORT }, "API started");
  });
} catch (error) {
  logger.fatal({ err: error }, "API startup failed");
  await pool.end();
  process.exitCode = 1;
}

const shutdown = (signal: string) => {
  logger.info({ signal }, "API shutting down");
  server.close((error) => {
    if (error) {
      logger.error(error, "API shutdown failed");
      process.exitCode = 1;
    }
    void pool.end();
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));