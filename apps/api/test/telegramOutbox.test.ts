/**
 * M9 — Telegram outbox worker unit tests (spec §2.9.1).
 *
 * The worker reads `notifications` where `telegram_sent = FALSE`, calls
 * Grammy `bot.api.sendMessage`, and updates the row. Three branches are
 * exercised inside one integration suite (an isolated test schema):
 *
 *   1. recipient has `users.telegram_id` -> sendMessage called, telegram_sent
 *      flips to TRUE, telegram_sent_at is filled.
 *   2. recipient has no `telegram_id` -> error_detail = 'no telegram_id',
 *      telegram_sent stays FALSE, NO sendMessage call.
 *   3. sendMessage throws -> telegram_send_attempts increments, error_detail
 *      stores the truncated reason; after MAX_SEND_ATTEMPTS the row is
 *      skipped (no further sendMessage call).
 *
 * The Grammy `Bot` itself is never constructed — `setTelegramBotForTesting`
 * injects a stub that exposes only `api.sendMessage` (the `SendableBot`
 * surface the worker uses).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  cronGuard,
  MAX_SEND_ATTEMPTS,
  runOneCycle,
} from '../src/workers/telegramOutbox.js';
import { resetBotCache, type SendableBot } from '../src/integrations/telegram/bot.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
  resetBotCache();
});

beforeEach(async () => {
  // The outbox reads users + notifications — wipe both for a clean cycle.
  await ctx.db.query('DELETE FROM notifications');
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM locations');
  cronGuard.running = false;
});

/** Seed one user. `telegramId` null -> no Telegram id on record. */
async function makeUser(opts: {
  email: string;
  role: string;
  telegramId: number | null;
}): Promise<number> {
  const { rows } = await ctx.db.query<{ id: number }>(
    `INSERT INTO users (name, email, password_hash, role, telegram_id)
     VALUES ($1, $2, 'x', $3, $4) RETURNING id`,
    [opts.email, opts.email, opts.role, opts.telegramId],
  );
  return Number(rows[0]!.id);
}

async function makeNotification(opts: {
  userId: number;
  title?: string;
  body?: string;
  type?: string;
}): Promise<number> {
  const { rows } = await ctx.db.query<{ id: number }>(
    `INSERT INTO notifications (recipient_user_id, type, title, body)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      opts.userId,
      opts.type ?? 'stock_below_min',
      opts.title ?? 'Test title',
      opts.body ?? 'Test body',
    ],
  );
  return Number(rows[0]!.id);
}

/** Build a stub bot with a controllable `sendMessage` spy. */
function makeStubBot(impl?: (chatId: number | string, text: string) => Promise<unknown>): {
  bot: SendableBot;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(impl ?? (() => Promise.resolve({ ok: true })));
  const bot: SendableBot = { api: { sendMessage } };
  return { bot, sendMessage };
}

describe('telegram outbox worker', () => {
  it('delivers a notification when the recipient has telegram_id', async () => {
    const userId = await makeUser({
      email: 'a@test.local',
      role: 'pm',
      telegramId: 12345,
    });
    const notifId = await makeNotification({
      userId,
      title: 'Hello',
      body: 'World',
    });
    const { bot, sendMessage } = makeStubBot();

    await runOneCycle(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    // Telegram chat ids arrive as strings (BIGINT) — accept either form.
    const [chatId, text] = sendMessage.mock.calls[0]!;
    expect(String(chatId)).toBe('12345');
    expect(String(text)).toContain('Hello');
    expect(String(text)).toContain('World');

    const { rows } = await ctx.db.query<{
      telegram_sent: boolean;
      telegram_sent_at: Date | null;
      telegram_send_attempts: number;
      error_detail: string | null;
    }>(
      `SELECT telegram_sent, telegram_sent_at, telegram_send_attempts, error_detail
         FROM notifications WHERE id = $1`,
      [notifId],
    );
    expect(rows[0]?.telegram_sent).toBe(true);
    expect(rows[0]?.telegram_sent_at).not.toBeNull();
    expect(rows[0]?.telegram_send_attempts).toBe(0);
    expect(rows[0]?.error_detail).toBeNull();
  });

  it('marks no-telegram_id users with error_detail and does not call sendMessage', async () => {
    const userId = await makeUser({
      email: 'b@test.local',
      role: 'pm',
      telegramId: null,
    });
    const notifId = await makeNotification({ userId });
    const { bot, sendMessage } = makeStubBot();

    await runOneCycle(bot);

    expect(sendMessage).not.toHaveBeenCalled();
    const { rows } = await ctx.db.query<{
      telegram_sent: boolean;
      error_detail: string | null;
    }>(
      `SELECT telegram_sent, error_detail FROM notifications WHERE id = $1`,
      [notifId],
    );
    expect(rows[0]?.telegram_sent).toBe(false);
    expect(rows[0]?.error_detail).toBe('no telegram_id');
  });

  it('increments telegram_send_attempts and stores error_detail on Grammy failure', async () => {
    const userId = await makeUser({
      email: 'c@test.local',
      role: 'pm',
      telegramId: 9999,
    });
    const notifId = await makeNotification({ userId });
    const { bot, sendMessage } = makeStubBot(() =>
      Promise.reject(new Error('boom: Telegram refused')),
    );

    await runOneCycle(bot);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const { rows } = await ctx.db.query<{
      telegram_sent: boolean;
      telegram_send_attempts: number;
      error_detail: string | null;
    }>(
      `SELECT telegram_sent, telegram_send_attempts, error_detail
         FROM notifications WHERE id = $1`,
      [notifId],
    );
    expect(rows[0]?.telegram_sent).toBe(false);
    expect(rows[0]?.telegram_send_attempts).toBe(1);
    expect(String(rows[0]?.error_detail)).toContain('boom');
  });

  it('skips rows that have exhausted retries', async () => {
    const userId = await makeUser({
      email: 'd@test.local',
      role: 'pm',
      telegramId: 4242,
    });
    const notifId = await makeNotification({ userId });
    // Manually set attempts to the cap.
    await ctx.db.query(
      `UPDATE notifications SET telegram_send_attempts = $2 WHERE id = $1`,
      [notifId, MAX_SEND_ATTEMPTS],
    );
    const { bot, sendMessage } = makeStubBot();

    await runOneCycle(bot);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('processes a mixed batch — delivered + no-id + failed in one cycle', async () => {
    const okUser = await makeUser({ email: 'ok@t', role: 'pm', telegramId: 1 });
    const noIdUser = await makeUser({ email: 'noid@t', role: 'pm', telegramId: null });
    const failUser = await makeUser({ email: 'fail@t', role: 'pm', telegramId: 2 });
    const okN = await makeNotification({ userId: okUser, title: 'A' });
    const noIdN = await makeNotification({ userId: noIdUser, title: 'B' });
    const failN = await makeNotification({ userId: failUser, title: 'C' });

    // The stub bot succeeds for chat 1, fails for chat 2.
    const { bot, sendMessage } = makeStubBot((chatId) => {
      if (String(chatId) === '2') return Promise.reject(new Error('rate-limited'));
      return Promise.resolve({ ok: true });
    });

    await runOneCycle(bot);

    // okUser was sent, failUser was attempted -> two sendMessage calls.
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const { rows } = await ctx.db.query<{
      id: number;
      telegram_sent: boolean;
      telegram_send_attempts: number;
      error_detail: string | null;
    }>(
      `SELECT id, telegram_sent, telegram_send_attempts, error_detail
         FROM notifications WHERE id IN ($1,$2,$3) ORDER BY id`,
      [okN, noIdN, failN],
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    expect(byId.get(okN)?.telegram_sent).toBe(true);
    expect(byId.get(noIdN)?.telegram_sent).toBe(false);
    expect(byId.get(noIdN)?.error_detail).toBe('no telegram_id');
    expect(byId.get(failN)?.telegram_sent).toBe(false);
    expect(byId.get(failN)?.telegram_send_attempts).toBe(1);
  });

  it('overlap guard — a second runOneCycle skips while the first is in flight', async () => {
    const userId = await makeUser({ email: 'e@t', role: 'pm', telegramId: 7 });
    await makeNotification({ userId });

    // sendMessage returns a promise we can hold open; the second `runOneCycle`
    // must see `cronGuard.running === true` and bail before issuing any
    // sendMessage call.
    let resolveSend!: () => void;
    const { bot, sendMessage } = makeStubBot(
      () =>
        new Promise<unknown>((resolve) => {
          resolveSend = () => resolve({ ok: true });
        }),
    );

    const first = runOneCycle(bot);
    // Wait until the first cycle has reached the send (sendMessage was
    // invoked). At that point cronGuard.running is true; the second call
    // must bail out immediately.
    while (sendMessage.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(cronGuard.running).toBe(true);

    const second = runOneCycle(bot);
    await second;

    // Only the first call has issued sendMessage; the second one bailed.
    expect(sendMessage).toHaveBeenCalledTimes(1);

    resolveSend();
    await first;
    expect(cronGuard.running).toBe(false);
  });
});
