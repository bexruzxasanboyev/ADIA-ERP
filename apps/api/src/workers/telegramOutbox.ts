/**
 * M9 — Telegram outbox worker (spec §2.9.1).
 *
 * Every 30 seconds, scan `notifications` for rows that have not yet been
 * delivered (`telegram_sent = FALSE`) and have not exhausted their retry
 * budget (`telegram_send_attempts < MAX_ATTEMPTS`). For each row:
 *
 *   1. Look up the recipient's `users.telegram_id`. If missing, mark the row
 *      as a permanent failure (`error_detail = 'no telegram_id'`) and leave
 *      `telegram_sent = FALSE` — we are not going to retry without an id.
 *   2. Call Grammy `bot.api.sendMessage(telegram_id, text)`. On success, set
 *      `telegram_sent = TRUE`, `telegram_sent_at = now()`.
 *   3. On failure, increment `telegram_send_attempts`, store the truncated
 *      `error_detail`, and let the next cycle try again (until MAX_ATTEMPTS).
 *
 * Overlap guard mirrors `replenishmentScan` — a slow Telegram round-trip
 * must not let the next 30-second tick fire a parallel cycle and send the
 * same message twice. The guard is module-scope (single Node process /
 * single PM2 instance per CLAUDE.md §5 deployment).
 *
 * The worker NEVER throws: a Grammy failure stays inside `attemptSend`, a
 * SQL failure for a single row is logged and the loop continues, and a
 * fatal cycle error is logged then swallowed (same pattern as the other
 * workers).
 */
import cron from 'node-cron';
import { query } from '../db/index.js';
import { getTelegramBot, type SendableBot } from '../integrations/telegram/bot.js';

/** Cron expression — every 30 seconds. */
export const TELEGRAM_OUTBOX_SCHEDULE = '*/30 * * * * *';

/** Maximum send retries before a row is skipped permanently. */
export const MAX_SEND_ATTEMPTS = 5;

/** Max rows handled per cycle — keeps a single tick bounded. */
export const BATCH_LIMIT = 50;

/** Truncate `error_detail` to keep audit/log payloads compact. */
const ERROR_DETAIL_MAX_LEN = 500;

let task: cron.ScheduledTask | undefined;

/** Re-entrancy guard — exported for tests. */
export const cronGuard: { running: boolean } = { running: false };

/**
 * Start the outbox cron. Idempotent — a second call returns the existing task
 * instead of double-scheduling. Returns the scheduled task for tests.
 */
export function startTelegramOutboxWorker(): cron.ScheduledTask {
  if (task !== undefined) return task;
  task = cron.schedule(TELEGRAM_OUTBOX_SCHEDULE, () => {
    void runOneCycle();
  });
  return task;
}

/** Stop the outbox cron (used by tests and the graceful-shutdown handler). */
export function stopTelegramOutboxWorker(): void {
  if (task !== undefined) {
    task.stop();
    task = undefined;
  }
}

/**
 * Run one outbox cycle. Exported so the integration test (or a future admin
 * endpoint) can drive a cycle synchronously without waiting for the cron.
 *
 * @param botOverride lets tests inject a mocked Grammy surface; production
 *                    code never passes anything.
 */
export async function runOneCycle(botOverride?: SendableBot): Promise<void> {
  if (cronGuard.running) {
    console.log('[telegram-outbox] previous cycle still running, skipping');
    return;
  }
  cronGuard.running = true;
  try {
    const bot = botOverride ?? safelyGetBot();
    if (bot === undefined) {
      // No token configured -> the outbox stays a no-op. The worker is only
      // started when the token is non-empty, but we still defend here so a
      // misconfigured restart never crashes.
      return;
    }

    const { rows } = await query<{
      id: number;
      recipient_user_id: number | null;
      body: string;
      title: string;
      telegram_send_attempts: number;
    }>(
      `SELECT n.id, n.recipient_user_id, n.body, n.title, n.telegram_send_attempts
         FROM notifications n
        WHERE n.telegram_sent = FALSE
          AND n.telegram_send_attempts < $1
        ORDER BY n.id
        LIMIT $2`,
      [MAX_SEND_ATTEMPTS, BATCH_LIMIT],
    );

    let delivered = 0;
    let failed = 0;
    let missing = 0;
    for (const row of rows) {
      try {
        const outcome = await deliverOne(bot, row);
        if (outcome === 'sent') delivered += 1;
        else if (outcome === 'no-recipient') missing += 1;
        else failed += 1;
      } catch (err) {
        // A single row's bookkeeping SQL failed — log and keep the loop alive.
        console.error(
          `[telegram-outbox] notification ${row.id} bookkeeping failed:`,
          (err as Error).message,
        );
      }
    }

    if (rows.length > 0) {
      console.log(
        `[telegram-outbox] processed=${rows.length} delivered=${delivered} ` +
          `failed=${failed} no_telegram_id=${missing}`,
      );
    }
  } catch (err) {
    console.error('[telegram-outbox] cycle failed:', (err as Error).message);
  } finally {
    cronGuard.running = false;
  }
}

/**
 * Wrapper around `getTelegramBot()` that returns `undefined` instead of
 * throwing when the token is empty. The worker treats that as a soft skip.
 */
function safelyGetBot(): SendableBot | undefined {
  try {
    return getTelegramBot();
  } catch {
    return undefined;
  }
}

type OutboxRow = {
  id: number;
  recipient_user_id: number | null;
  body: string;
  title: string;
  telegram_send_attempts: number;
};

type Outcome = 'sent' | 'failed' | 'no-recipient';

/**
 * Deliver one notification row. Returns the outcome; the caller uses it for
 * the summary log. SQL errors propagate so the per-row catch can log them.
 */
async function deliverOne(bot: SendableBot, row: OutboxRow): Promise<Outcome> {
  if (row.recipient_user_id === null) {
    await query(
      `UPDATE notifications
          SET error_detail = $2
        WHERE id = $1`,
      [row.id, 'no recipient_user_id'],
    );
    return 'no-recipient';
  }

  const { rows: userRows } = await query<{ telegram_id: string | null }>(
    `SELECT telegram_id FROM users WHERE id = $1`,
    [row.recipient_user_id],
  );
  const tgIdRaw = userRows[0]?.telegram_id;
  if (tgIdRaw === null || tgIdRaw === undefined) {
    await query(
      `UPDATE notifications
          SET error_detail = $2
        WHERE id = $1`,
      [row.id, 'no telegram_id'],
    );
    return 'no-recipient';
  }

  // `users.telegram_id` is BIGINT and pg returns it as a string. Telegram
  // chat ids are 64-bit integers; pass the string-form through to Grammy
  // (it accepts string | number) to avoid precision loss for large ids.
  const chatId = typeof tgIdRaw === 'string' ? tgIdRaw : String(tgIdRaw);
  const text = formatMessage(row);

  try {
    await bot.api.sendMessage(chatId, text);
    await query(
      `UPDATE notifications
          SET telegram_sent = TRUE,
              telegram_sent_at = now(),
              error_detail = NULL
        WHERE id = $1`,
      [row.id],
    );
    return 'sent';
  } catch (err) {
    const detail = ((err as Error).message ?? 'unknown').slice(0, ERROR_DETAIL_MAX_LEN);
    await query(
      `UPDATE notifications
          SET telegram_send_attempts = telegram_send_attempts + 1,
              error_detail = $2
        WHERE id = $1`,
      [row.id, detail],
    );
    return 'failed';
  }
}

/**
 * Assemble the plain-text message body. Title goes on line one, body on
 * the rest. We deliberately avoid Markdown/HTML — Grammy will not retry a
 * `parse_mode` failure for us and the spec §9.5 demands plain text.
 */
function formatMessage(row: OutboxRow): string {
  const title = row.title.trim();
  const body = row.body.trim();
  if (title === '') return body;
  if (body === '') return title;
  return `${title}\n${body}`;
}
