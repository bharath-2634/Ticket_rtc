import { createServer } from "node:http";
import pino from "pino";
import { PROJECT_NAME } from "@ticket-rpc/shared";
import { app } from "./app.js";
import { config } from "./config.js";

const logger = pino();
const server = createServer(app);

server.listen(config.API_PORT, "0.0.0.0", () => {
  logger.info({ project: PROJECT_NAME, port: config.API_PORT }, "API started");
});

const shutdown = (signal: string) => {
  logger.info({ signal }, "API shutting down");
  server.close((error) => {
    if (error) {
      logger.error(error, "API shutdown failed");
      process.exitCode = 1;
    }
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));