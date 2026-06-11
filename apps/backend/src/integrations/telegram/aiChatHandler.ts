/**
 * AI chat in Telegram (owner: "AI chat ham botda bo'lsin").
 *
 * The web AI assistant (`runAssistantQuery` — Vertex Gemini function-calling
 * over the DB) is reused verbatim: the bot sends the user's free text + their
 * real `AuthPrincipal` to the SAME service, so web + bot share one assistant
 * and one RBAC scope. No new LLM layer.
 *
 * Routing precedence (wired in `bot.ts`):
 *   1. menu reply-keyboard buttons (`handleMenuMessage`)
 *   2. cash-shift submissions (`handleCashShiftMessage`, keyword-gated)
 *   3. AI chat (this handler) — the default for any free text that is NOT a
 *      menu button, NOT a command, NOT an active cash-shift dialog.
 *
 * Mode: tapping "🤖 AI suhbat" sets an in-memory flag for that telegram user.
 * In AI-chat mode every plain message goes to the assistant. But even WITHOUT
 * the flag, unrecognised free text falls through to here (so the bot answers
 * questions out of the box). In-memory state is fine for dev (ADR — no
 * persistence requirement for the chat-mode toggle).
 *
 * Safety: read tools run for real inside `runAssistantQuery`; if the model
 * proposes a WRITE (pending) action, we render the answer text + a note and do
 * NOT auto-execute — voice already owns action intents; AI chat stays Q&A.
 *
 * Tested with a small adapter (`AiChatCtxLike`) + an injected assistant runner,
 * so no real Grammy `Context` or Vertex client is required.
 */
import type { AuthPrincipal } from '../../auth/jwt.js';
import { loadVoicePrincipal } from './voiceHandler.js';
import {
  runAssistantQuery,
  type RunAssistantQueryInput,
  type RunAssistantQueryResult,
} from '../../services/assistant.js';

// ---------------------------------------------------------------------------
// Per-user AI-chat mode (in-memory; dev-scoped)
// ---------------------------------------------------------------------------

const aiChatMode = new Set<number>();

/** Put a telegram user into AI-chat mode (tapped "🤖 AI suhbat"). */
export function enterAiChatMode(telegramId: number): void {
  aiChatMode.add(telegramId);
}

/** Drop a telegram user out of AI-chat mode. */
export function exitAiChatMode(telegramId: number): void {
  aiChatMode.delete(telegramId);
}

/** Is this telegram user currently in AI-chat mode? */
export function isInAiChatMode(telegramId: number): boolean {
  return aiChatMode.has(telegramId);
}

/** TEST-ONLY — wipe all mode flags between tests. */
export function __resetAiChatModeForTesting(): void {
  aiChatMode.clear();
}

/** The prompt shown when a user enters AI-chat mode. */
export const AI_CHAT_PROMPT =
  "🤖 AI suhbat yoqildi. Savolingizni yozing — masalan: " +
  "\"bugun Кукчada nima ko'p sotildi?\"";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Real Grammy `Context` ham, testdagi soxta obyekt ham mos keladigan surface. */
export type AiChatCtxLike = {
  readonly from?: { id?: number };
  readonly message?: { readonly text?: string };
  reply(text: string, opts?: Record<string, unknown>): Promise<unknown>;
  /** Optional typing indicator — production Grammy ctx has it; tests may omit. */
  replyWithChatAction?: (action: string) => Promise<unknown>;
};

export type AiChatHandleResult = {
  readonly handled: boolean;
  readonly reason?: string;
};

/**
 * Injectable dependencies — production uses the real assistant + principal
 * lookup; tests pass fakes so no Vertex/DB round-trip is needed.
 */
export type AiChatDeps = {
  readonly loadPrincipal: (telegramId: number) => Promise<AuthPrincipal | null>;
  readonly runAssistant: (
    input: RunAssistantQueryInput,
  ) => Promise<RunAssistantQueryResult>;
};

export const DEFAULT_AI_CHAT_DEPS: AiChatDeps = {
  loadPrincipal: loadVoicePrincipal,
  runAssistant: runAssistantQuery,
};

/**
 * Handle one free-text message as an AI-chat turn. The caller (`bot.ts`) only
 * reaches this after menu + cash-shift have declined, so any text here is a
 * question for the assistant.
 *
 * Returns `{ handled:false }` only for empty / id-less input; everything else
 * is answered (or an error reply is sent) and reported `handled:true`.
 */
export async function handleAiChatMessage(
  ctx: AiChatCtxLike,
  deps: AiChatDeps = DEFAULT_AI_CHAT_DEPS,
): Promise<AiChatHandleResult> {
  const tgId = ctx.from?.id;
  const text = ctx.message?.text?.trim();
  if (tgId === undefined || text === undefined || text === '') {
    return { handled: false, reason: 'no_text' };
  }

  const principal = await deps.loadPrincipal(tgId);
  if (principal === null) {
    await safeReply(
      ctx,
      "Sizning Telegram hisobingiz tizimda ro'yxatdan o'tmagan. PM bilan bog'laning.",
    );
    return { handled: true, reason: 'unauthorized' };
  }

  // ⏳ typing indicator — best-effort, never blocks the answer.
  if (typeof ctx.replyWithChatAction === 'function') {
    try {
      await ctx.replyWithChatAction('typing');
    } catch {
      // ignore — a missing typing action must not break the answer
    }
  }

  let result: RunAssistantQueryResult;
  try {
    result = await deps.runAssistant({ message: text, principal });
  } catch (err) {
    console.error('[telegram-aichat] assistant failed:', (err as Error).message);
    await safeReply(ctx, 'AI hozir javob berolmadi, keyinroq urinib ko\'ring.');
    return { handled: true, reason: 'assistant_error' };
  }

  // The assistant answers within `principal`'s RBAC scope (store_manager →
  // their store; pm → whole chain) — scoping lives inside `runAssistantQuery`.
  let answer = result.response.trim();
  if (answer === '') {
    answer = 'Javob topilmadi.';
  }

  // A proposed WRITE action is NOT auto-executed from AI chat — render the
  // answer + a note so the user knows to act via the menu / voice flow.
  if (result.pending_action !== undefined) {
    answer +=
      '\n\nℹ️ Bu amal (' +
      result.pending_action.summary +
      ') AI suhbatdan avtomatik bajarilmaydi. Tasdiqlash uchun menyudan foydalaning.';
  }

  await safeReply(ctx, answer);
  return { handled: true, reason: 'answered' };
}

async function safeReply(
  ctx: AiChatCtxLike,
  text: string,
  opts?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('[telegram-aichat] reply failed:', (err as Error).message);
  }
}
