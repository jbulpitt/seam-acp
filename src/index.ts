import { loadConfig } from "./config.js";
import { logger } from "./lib/logger.js";
import { startHealthServer } from "./lib/health.js";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(
    {
      agent: config.DEFAULT_AGENT,
      model: config.DEFAULT_MODEL,
      reposRoot: config.REPOS_ROOT,
      dataDir: config.DATA_DIR,
    },
    "seam-acp ready"
  );

  const health = startHealthServer(config.HEALTH_PORT, logger);

  // Phase 1 scaffold: no chat adapter or agent runtime wired up yet.
  // Phases 2-6 will plug them in here.

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    health.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "fatal startup error");
  process.exit(1);
});
