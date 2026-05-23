/**
 * Process entrypoint — boots the HTTP server.
 *
 * Validates config first (fail fast on missing env), then listens. Handles
 * SIGINT/SIGTERM for a graceful shutdown that drains the DB pool.
 */
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { closePool } from './db/index.js';
import {
  startReplenishmentScanWorker,
  stopReplenishmentScanWorker,
} from './workers/replenishmentScan.js';

function main(): void {
  const cfg = loadConfig(); // throws clearly on missing/invalid env
  const app = createApp();

  const server = app.listen(cfg.port, () => {
    console.log(`[server] ADIA ERP API listening on port ${cfg.port} (${cfg.nodeEnv})`);
  });

  // Start the replenishment scan worker once the HTTP server is up. The
  // worker runs every 5 minutes and is a no-op if the DB is empty.
  startReplenishmentScanWorker();
  console.log('[server] replenishment scan worker started (*/5 * * * *)');

  const shutdown = (signal: string): void => {
    console.log(`[server] ${signal} received — shutting down.`);
    stopReplenishmentScanWorker();
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  console.error('[server] failed to start:');
  console.error(err);
  process.exit(1);
}
