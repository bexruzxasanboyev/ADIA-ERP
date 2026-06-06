/**
 * EPIC 3.2 — Telegram `/start <token>` self-link command handler.
 *
 * The Grammy bot (`bot.ts`) wires `bot.command('start', ...)` to call
 * `handleStartCommand(ctx)`. `ctx` is a deliberately small adapter around
 * Grammy's command context so this module is fully unit-testable without a
 * real Bot — mirrors the `callbackHandler.ts` design.
 *
 * Flow:
 *   - No payload → friendly greeting (the user opened the bot directly).
 *   - `/start <token>` → redeem the single-use link token. On success the
 *     user's `users.telegram_id` is bound to the presser's Telegram id.
 *
 * This is the ONLY Telegram verb added for EPIC 3 — production/cash flows
 * are untouched.
 */
import { redeemLinkToken } from '../../services/userTelegramLink.js';
import { loadVoicePrincipal } from './voiceHandler.js';
import {
  buildGreeting,
  buildMenuKeyboard,
  loadUserMenuContext,
} from './menuHandler.js';

/** Minimal adapter the bot wire-up provides. */
export type StartContext = {
  /** Telegram numeric id of the sender. */
  readonly fromTelegramId: number;
  /** The deep-link payload after `/start ` (empty string when absent). */
  readonly token: string;
  /** Send a plain-text reply to the chat (best-effort). `opts` carries the
   *  reply-keyboard markup for the onboarding menu (B2). */
  reply(text: string, opts?: Record<string, unknown>): Promise<void>;
};

const GREETING =
  "Assalomu alaykum! Bu ADIA ERP boti.\n\n" +
  "Akkauntingizni ulash uchun ilovadagi \"Telegramni ulash\" tugmasini bosing " +
  "va chiqqan havola orqali qayta keling.";

export async function handleStartCommand(ctx: StartContext): Promise<void> {
  if (ctx.token === '') {
    // B2 — a LINKED user who opens the bot with no token lands straight on
    // their role menu; an unknown sender gets the link greeting.
    const shown = await showMenuForLinkedUser(ctx);
    if (!shown) {
      await safeReply(ctx, GREETING);
    }
    return;
  }

  let message: string;
  try {
    const outcome = await redeemLinkToken(ctx.token, ctx.fromTelegramId);
    switch (outcome.kind) {
      case 'linked': {
        // B2 — right after linking, drop the user onto their bo'lim menu.
        const shown = await showMenuForUserId(ctx, outcome.userId);
        if (shown) return;
        message =
          `✅ Akkauntingiz ulandi: ${outcome.userName}.\n` +
          "Endi bildirishnomalar shu yerga keladi.";
        break;
      }
      case 'expired':
        message = "⏳ Havola muddati tugagan. Iltimos, ilovadan yangi havola oling.";
        break;
      case 'already_used':
        message = "ℹ️ Bu havola allaqachon ishlatilgan. Yangi havola oling.";
        break;
      case 'telegram_taken':
        message =
          "⚠️ Bu Telegram akkaunt boshqa foydalanuvchiga bog'langan. " +
          "Avval uni uzib, keyin qayta urinib ko'ring.";
        break;
      case 'invalid':
      default:
        message = "❌ Havola noto'g'ri. Iltimos, ilovadan yangi havola oling.";
        break;
    }
  } catch (err) {
    // Never let a DB error leave the user with a stuck command — answer with
    // a generic message and log the detail server-side.
    console.error('[telegram-start] redeem failed:', (err as Error).message);
    message = "Server xatosi. Birozdan so'ng qayta urinib ko'ring.";
  }
  await safeReply(ctx, message);
}

/**
 * B2 — show the role menu for the sender IF they are a linked, active user.
 * Returns true when the menu was sent (caller skips the link greeting).
 */
async function showMenuForLinkedUser(ctx: StartContext): Promise<boolean> {
  const principal = await loadVoicePrincipal(ctx.fromTelegramId);
  if (principal === null) return false;
  return showMenuForUserId(ctx, principal.userId);
}

/** B2 — greet `userId` + send their role-based reply keyboard. */
async function showMenuForUserId(
  ctx: StartContext,
  userId: number,
): Promise<boolean> {
  try {
    const menuCtx = await loadUserMenuContext(userId);
    if (menuCtx === null) return false;
    await safeReply(ctx, buildGreeting(menuCtx), {
      reply_markup: buildMenuKeyboard(menuCtx.role),
    });
    return true;
  } catch (err) {
    console.error('[telegram-start] menu render failed:', (err as Error).message);
    return false;
  }
}

/** Swallow reply failures — a network glitch here is unrecoverable. */
async function safeReply(
  ctx: StartContext,
  text: string,
  opts?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('[telegram-start] reply failed:', (err as Error).message);
  }
}
