/**
 * Grammy bot — outbound only (M9, spec §2.9).
 *
 * Faza-1 uses Telegram as a one-way notification channel: the
 * `telegramOutbox` worker reads `notifications` rows where
 * `telegram_sent = FALSE` and pushes each one through `bot.api.sendMessage`.
 *
 * We never call `bot.start()` — polling (or webhook intake) is Faza-3 work
 * (inline-button confirmations). Holding off on `start()` also keeps the bot
 * usable in tests where the token is empty.
 *
 * The factory is lazy: the first call constructs a Grammy `Bot`, every later
 * call returns the cached instance. `resetBotCache()` exists for tests that
 * mock `Bot` and need a fresh build.
 */
import { Bot, type BotConfig } from 'grammy';
import { loadConfig } from '../../config/index.js';

/** Minimal surface the outbox worker needs from a Grammy bot. */
export type SendableBot = {
  api: {
    sendMessage(
      chatId: number | string,
      text: string,
      other?: Record<string, unknown>,
    ): Promise<unknown>;
  };
};

let cached: SendableBot | undefined;

/**
 * Return a Grammy bot built from `cfg.bot.token`. Throws if the token is
 * empty — callers MUST gate on `cfg.bot.token !== ''` (the outbox worker
 * does this and is simply not started when the token is missing).
 *
 * `options` is forwarded to Grammy verbatim so tests can pass a stub
 * BotConfig (e.g. `client.canUseWebhookReply` indirection).
 */
export function getTelegramBot(options?: BotConfig<never>): SendableBot {
  if (cached !== undefined) return cached;
  const cfg = loadConfig();
  if (cfg.bot.token === '') {
    throw new Error(
      'getTelegramBot(): BOT_TOKEN is empty. Gate the call on cfg.bot.token first.',
    );
  }
  cached = new Bot(cfg.bot.token, options) as unknown as SendableBot;
  return cached;
}

/**
 * TEST-ONLY — wipe the cached bot so a new `getTelegramBot()` call returns
 * a fresh instance (used by mocked-Grammy unit tests). Production code never
 * calls this.
 */
export function resetBotCache(): void {
  cached = undefined;
}

/**
 * TEST-ONLY — inject a custom bot instance. Lets the outbox-worker unit test
 * pass a `vi.fn()`-backed `sendMessage` without spinning up a real Grammy
 * client (which would refuse to construct without a valid token).
 */
export function setTelegramBotForTesting(bot: SendableBot | undefined): void {
  cached = bot;
}
