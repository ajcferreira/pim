import { createApp } from "./app.js";
import { pool } from "./db.js";
import { assertAuthConfig } from "./lib/auth.js";
import { logger } from "./lib/logger.js";
import { startWorkers, stopBoss } from "./lib/queue.js";
import { sweepPublishWindows, pruneRetention } from "./lib/maintenance.js";

assertAuthConfig();

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => logger.info({ port }, "PIM/DAM API listening"));

// Background workers + advisory-locked scheduled jobs (safe with multiple instances)
startWorkers().catch((e) => { logger.error({ err: e }, "worker start failed"); process.exit(1); });
const timers = [
  setInterval(() => sweepPublishWindows().catch((e) => logger.error({ err: e }, "sweep failed")), 60 * 60 * 1000),
  setInterval(() => pruneRetention().catch((e) => logger.error({ err: e }, "prune failed")), 6 * 60 * 60 * 1000),
];

/* Graceful shutdown: stop accepting, drain in-flight, close queue + pool */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  timers.forEach(clearInterval);
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { logger.warn("drain timeout — forcing close"); resolve(); }, 10_000);
    server.close(() => { clearTimeout(t); resolve(); });
  });
  await stopBoss().catch(() => {});
  await pool.end().catch(() => {});
  logger.info("shutdown complete");
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
