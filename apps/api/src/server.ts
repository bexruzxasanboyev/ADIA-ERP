/**
 * Process entrypoint — boots the HTTP server.
 *
 * Validates config first (fail fast on missing env), then listens. Handles
 * SIGINT/SIGTERM for a graceful shutdown that drains the DB pool.
 */
import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { closePool } from './db/index.js';

function main(): void {
  const cfg = loadConfig(); // throws clearly on missing/invalid env
  const app = createApp();

  const server = app.listen(cfg.port, () => {
    console.log(`[server] ADIA ERP API listening on port ${cfg.port} (${cfg.nodeEnv})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[server] ${signal} received — shutting down.`);
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
