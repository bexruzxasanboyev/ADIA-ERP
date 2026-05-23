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
import {
  startPosterStockSyncWorker,
  stopPosterStockSyncWorker,
} from './workers/posterStockSync.js';
import {
  startPosterSalesWorker,
  stopPosterSalesWorker,
} from './workers/posterSalesSync.js';
import {
  startTelegramOutboxWorker,
  stopTelegramOutboxWorker,
} from './workers/telegramOutbox.js';
import {
  startSalesAggregateWorker,
  stopSalesAggregateWorker,
} from './workers/salesAggregateCron.js';
import {
  startMinmaxRecalcWorker,
  stopMinmaxRecalcWorker,
} from './workers/minmaxRecalcCron.js';

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

  // Phase-2 F2.1 — nightly sales aggregate + dynamic min/max recalc.
  // The recalc reads the aggregate written one hour earlier (03:00 → 04:00).
  startSalesAggregateWorker();
  console.log('[server] sales aggregate worker started (0 3 * * *)');
  startMinmaxRecalcWorker();
  console.log('[server] minmax recalc worker started (0 4 * * *)');

  // Poster integration workers only run when a token is configured — saves
  // log spam and avoids hammering Poster on a fresh install.
  if (cfg.poster.token !== '') {
    startPosterStockSyncWorker();
    console.log('[server] poster stock sync worker started (*/15 * * * *)');
    startPosterSalesWorker();
    console.log('[server] poster sales sync workers started (webhook 1m, fallback 30m)');
  } else {
    console.log('[server] poster workers skipped — POSTER_TOKEN is empty');
  }

  // Telegram outbox worker — only started when BOT_TOKEN is configured. The
  // outbox stays dormant in dev/test (the notifications still queue up; they
  // simply do not leave the database). Outbound-only — no `bot.start()` here.
  if (cfg.bot.token !== '') {
    startTelegramOutboxWorker();
    console.log('[server] telegram outbox worker started (*/30 seconds)');
  } else {
    console.log('[server] telegram outbox worker skipped — BOT_TOKEN is empty');
  }

  const shutdown = (signal: string): void => {
    console.log(`[server] ${signal} received — shutting down.`);
    stopReplenishmentScanWorker();
    stopPosterStockSyncWorker();
    stopPosterSalesWorker();
    stopTelegramOutboxWorker();
    stopSalesAggregateWorker();
    stopMinmaxRecalcWorker();
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
