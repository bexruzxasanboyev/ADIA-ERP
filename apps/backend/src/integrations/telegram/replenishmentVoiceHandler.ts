/**
 * VOICE → replenishment-request — Telegram `message:voice` handler.
 *
 * A store manager (do'konchi) sends a VOICE message — e.g. "menga 10 ta
 * napoleon kerak" — and the bot:
 *
 *   1. resolves the sender's ADIA user + their location (reusing
 *      `loadVoicePrincipal`, the SAME telegram_id → users mapping the bot's
 *      notifications already rely on);
 *   2. downloads the OGG/Opus bytes (Telegram `getFile` + fetch);
 *   3. hands them to `runVoiceAssistant` (transcribe + assistant query with
 *      write tools on). The web service owns the Vertex/tool plumbing and the
 *      pending-action staging — this handler adds NO new AI layer;
 *   4. if the assistant stages a `create_replenishment_request` pending action,
 *      replies with the human summary + an inline keyboard:
 *      **✅ Tasdiqlash** (`apprv:act:<id>`) / **❌ Bekor qilish** (`rej:act:<id>`).
 *
 * The confirm/reject buttons reuse the EXISTING callback path in
 * `dispatch.ts` (`apprv:act` → `confirmAction`, `rej:act` → `rejectAction`),
 * which is already wired in `bot.ts`. So on confirm the request is created
 * through `assistantActions.confirmAction` → the `create_replenishment_request`
 * write tool's executor (one atomic transaction, audit, RBAC re-check) — the
 * same path the web confirm dialog uses.
 *
 * Why a separate handler (not the regex-intent `voiceHandler.ts`): this flow
 * is the AI-assistant path — the model maps Uzbek speech to the Russian
 * product catalog and pins `requester_location_id` to the caller's own
 * location, then we gate the create behind an explicit Tasdiqlash/Bekor
 * confirm. `voiceHandler.ts` (Yandex/Gemini regex intents + transfer/adjust
 * staging) stays as a tested, reuse-capable unit.
 *
 * Robustness:
 *   - an unlinked sender (no `users.telegram_id`) gets a clear "akkauntingiz
 *     ulanmagan" reply explaining `/start <token>` linking — NEVER a crash.
 *   - `runVoiceAssistant` already degrades unintelligible / failed audio to a
 *     friendly "tushunmadim" reply (no pending action); we just relay its
 *     `response` text.
 *   - the handler swallows every error at the Grammy boundary (a throwing
 *     handler would leave the user with no feedback).
 */
import { Buffer } from 'node:buffer';
import type { Bot, Context } from 'grammy';

import { AppError } from '../../errors/index.js';
import { loadConfig } from '../../config/index.js';
import { writeAudit, poolRunner } from '../../lib/audit.js';
import type { AuthPrincipal } from '../../auth/jwt.js';
import {
  runVoiceAssistant,
  type RunVoiceAssistantResult,
} from '../../services/voiceAssistant.js';
import { loadVoicePrincipal } from './voiceHandler.js';

// ---------------------------------------------------------------------------
// Adapter — the minimal surface our tests and the real Grammy Context share.
// ---------------------------------------------------------------------------

export type ReplenishVoiceCtxLike = {
  readonly from?: { id?: number };
  readonly message?: {
    readonly message_id: number;
    readonly voice?: {
      readonly file_id: string;
      readonly duration?: number;
      readonly file_size?: number;
    };
  };
  reply(text: string, opts?: Record<string, unknown>): Promise<unknown>;
};

/**
 * Injectable dependencies. Production wires the real Telegram download +
 * `loadVoicePrincipal` + `runVoiceAssistant`; tests pass fakes so the suite
 * never touches Telegram, GCP, or the principal lookup.
 */
export type ReplenishVoiceDeps = {
  /** Download a Telegram voice file → Buffer (production: getFile + fetch). */
  readonly downloadVoice: (fileId: string) => Promise<Buffer>;
  /** Resolve a Telegram numeric id → AuthPrincipal (or null when unlinked). */
  readonly loadPrincipal: (telegramId: number | string) => Promise<AuthPrincipal | null>;
  /** Transcribe + stage — the web voice service, reused verbatim. */
  readonly runVoice: (input: {
    audio: Buffer;
    principal: AuthPrincipal;
    mimeType?: string;
  }) => Promise<RunVoiceAssistantResult>;
};

// ---------------------------------------------------------------------------
// Messages (UI text — Uzbek)
// ---------------------------------------------------------------------------

/** Shown when the sender's Telegram is not linked to any ADIA user. */
export const UNLINKED_REPLY =
  "Akkauntingiz ADIA tizimiga ulanmagan. Ulash uchun ilovadagi " +
  '"Telegramni ulash" tugmasini bosing va chiqqan havola orqali bot\'ga ' +
  '`/start <token>` yuboring.';

/** Generic fallback when the bot cannot understand the voice. */
const NO_REQUEST_REPLY =
  "Ovozli xabardan to'ldirish so'rovi aniqlanmadi. Masalan: " +
  '"menga 10 ta napoleon kerak" deb ayting.';

const TELEGRAM_FILE_URL = 'https://api.telegram.org/file/bot';

// ---------------------------------------------------------------------------
// Default deps (production)
// ---------------------------------------------------------------------------

/**
 * Telegram voice file_id → Buffer. Grammy `getFile` returns `file_path`; we
 * fetch the raw bytes over HTTPS with the bot token. Mirrors the existing
 * `makeDefaultDownloadVoice` in `voiceHandler.ts`.
 */
export function makeDownloadVoice(bot: Pick<Bot, 'api'>) {
  return async function downloadVoice(fileId: string): Promise<Buffer> {
    const cfg = loadConfig();
    if (cfg.bot.token === '') {
      throw AppError.internal('BOT_TOKEN not configured — cannot download voice.');
    }
    const file = await bot.api.getFile(fileId);
    if (typeof file.file_path !== 'string' || file.file_path === '') {
      throw AppError.internal('Telegram getFile returned no file_path.');
    }
    const url = `${TELEGRAM_FILE_URL}${cfg.bot.token}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw AppError.internal(
        `Telegram file download failed: HTTP ${res.status} ${res.statusText}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  };
}

export function makeDefaultDeps(bot: Pick<Bot, 'api'>): ReplenishVoiceDeps {
  return {
    downloadVoice: makeDownloadVoice(bot),
    loadPrincipal: loadVoicePrincipal,
    // Telegram voice is always OGG/Opus — pin the mime so the model gets the
    // right container hint.
    runVoice: (input) =>
      runVoiceAssistant({
        audio: input.audio,
        principal: input.principal,
        mimeType: input.mimeType ?? 'audio/ogg',
      }),
  };
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

type InlineButton = { text: string; callback_data: string };
type InlineKeyboard = InlineButton[][];

/**
 * The confirm keyboard for ONE staged action. `apprv:act:<id>` and
 * `rej:act:<id>` are already handled by `dispatch.ts` — we reuse them so the
 * confirm path is identical to the existing voice/transfer flow.
 */
export function buildConfirmKeyboard(actionId: number): InlineKeyboard {
  return [
    [
      { text: '✅ Tasdiqlash', callback_data: `apprv:act:${actionId}` },
      { text: '❌ Bekor qilish', callback_data: `rej:act:${actionId}` },
    ],
  ];
}

// ---------------------------------------------------------------------------
// Result type (for tests + observability)
// ---------------------------------------------------------------------------

export type HandleReplenishVoiceResult = {
  readonly status:
    | 'unlinked' // sender not mapped to an ADIA user
    | 'staged' // a create_replenishment_request pending action was staged
    | 'no_action' // transcribed but no request (echoed assistant reply)
    | 'download_failed' // could not fetch the audio
    | 'bad_update'; // malformed update (no from/voice)
  readonly actionId: number | null;
};

// ---------------------------------------------------------------------------
// Core handler (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Process one voice message. Pure of Grammy — `ctx` is the small adapter, and
 * every external effect is an injected dep, so the unit test drives it with
 * plain fakes.
 */
export async function handleReplenishmentVoice(
  ctx: ReplenishVoiceCtxLike,
  deps: ReplenishVoiceDeps,
): Promise<HandleReplenishVoiceResult> {
  const tgId = ctx.from?.id;
  const voice = ctx.message?.voice;
  if (tgId === undefined || voice === undefined) {
    // Grammy should not route a non-voice update here; defend anyway.
    return { status: 'bad_update', actionId: null };
  }

  // 1. Resolve sender → ADIA principal (reuse the bot's telegram_id mapping).
  const principal = await deps.loadPrincipal(tgId);
  if (principal === null) {
    await safeReply(ctx, UNLINKED_REPLY);
    await writeAudit(poolRunner, {
      actorUserId: null,
      action: 'voice_replenishment.rejected_unlinked',
      entity: 'users',
      entityId: null,
      payload: { telegram_id: String(tgId) },
    });
    return { status: 'unlinked', actionId: null };
  }

  // 2. Download the audio bytes.
  let audio: Buffer;
  try {
    audio = await deps.downloadVoice(voice.file_id);
  } catch (err) {
    console.error(
      '[telegram-voice-replenish] download failed:',
      (err as Error).message,
    );
    await safeReply(ctx, "Ovozli faylni yuklab bo'lmadi. Qaytadan urinib ko'ring.");
    return { status: 'download_failed', actionId: null };
  }

  // 3. Transcribe + stage via the web voice service. It owns transcription,
  //    the assistant query (write tools on), session persistence, and the
  //    pending-action staging. Unintelligible / failed audio degrades inside
  //    the service to a friendly `response` with no `pending_action`.
  const result = await deps.runVoice({ audio, principal, mimeType: 'audio/ogg' });

  // 4a. A staged create_replenishment_request → confirm keyboard.
  const pending = result.pending_action;
  if (
    pending !== undefined &&
    pending.tool_name === 'create_replenishment_request'
  ) {
    const transcriptLine =
      result.transcript.trim() === ''
        ? ''
        : `📝 Eshitdim: "${result.transcript.trim()}"\n\n`;
    const text = `${transcriptLine}${pending.summary}\n\nTasdiqlaysizmi?`;
    await safeReply(ctx, text, {
      reply_markup: { inline_keyboard: buildConfirmKeyboard(pending.action_id) },
    });
    return { status: 'staged', actionId: pending.action_id };
  }

  // 4b. The assistant staged some OTHER write action (e.g. transfer) — this
  //     handler is scoped to replenishment requests, so we do NOT surface a
  //     confirm button for it (the web UI / menu owns those). Relay the text.
  if (pending !== undefined) {
    await safeReply(
      ctx,
      `${assistantText(result)}\n\nℹ️ Bu amal ovozli so'rov orqali tasdiqlanmaydi.`,
    );
    return { status: 'no_action', actionId: null };
  }

  // 4c. No pending action — echo the assistant reply (covers "tushunmadim",
  //     a plain answer, or "couldn't map a product").
  await safeReply(ctx, assistantText(result));
  return { status: 'no_action', actionId: null };
}

/** The assistant's text, or a sensible default. */
function assistantText(result: RunVoiceAssistantResult): string {
  const t = result.response.trim();
  return t === '' ? NO_REQUEST_REPLY : t;
}

// ---------------------------------------------------------------------------
// Grammy wiring
// ---------------------------------------------------------------------------

/**
 * Wire `message:voice` onto the bot. `bot.ts` calls this from
 * `ensureCallbackHandlerWired` (replacing the regex-intent `wireVoiceHandler`).
 * The outer try/catch guarantees a thrown handler never crashes Grammy.
 */
export function wireReplenishmentVoiceHandler(bot: Pick<Bot, 'on' | 'api'>): void {
  const deps = makeDefaultDeps(bot);
  bot.on('message:voice', async (ctx: Context) => {
    try {
      await handleReplenishmentVoice(
        ctx as unknown as ReplenishVoiceCtxLike,
        deps,
      );
    } catch (err) {
      console.error(
        '[telegram-voice-replenish] uncaught:',
        (err as Error).message,
        (err as Error).stack,
      );
      try {
        await ctx.reply("Texnik xatolik yuz berdi. Keyinroq urinib ko'ring.");
      } catch {
        /* swallow — nothing more we can do */
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReply(
  ctx: ReplenishVoiceCtxLike,
  text: string,
  opts?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('[telegram-voice-replenish] reply failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __forTesting = {
  UNLINKED_REPLY,
  NO_REQUEST_REPLY,
  buildConfirmKeyboard,
};
