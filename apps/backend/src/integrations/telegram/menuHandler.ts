/**
 * B2 (telegram-bot-tz §3) — Onboarding menu + reply-keyboard router.
 *
 * When a LINKED user sends `/start` (or right after redeeming a link token),
 * the bot greets them with their bo'lim + rol and shows a ROLE-BASED reply
 * keyboard. Tapping a text button sends a normal `message:text` update, which
 * the bot routes here BEFORE the cash-shift handler (so the cash flow is
 * untouched — a menu button is matched first, any other text falls through).
 *
 * The menu strings are Uzbek (UI language). Identifiers stay English.
 *
 * RBAC scoping: each handler uses the user's own location, so a store manager
 * only ever sees its own incoming requests / stock (invariant 6).
 */
import type { Role } from '../../auth/roles.js';
import type { AuthPrincipal } from '../../auth/jwt.js';
import { query } from '../../db/index.js';
import { loadVoicePrincipal } from './voiceHandler.js';
import { reportScopeFor, reportTypeKeyboard } from './reportsHandler.js';
import { enterAiChatMode, exitAiChatMode, AI_CHAT_PROMPT } from './aiChatHandler.js';
import { unlinkTelegramAccount } from '../../services/userTelegramLink.js';

// ---------------------------------------------------------------------------
// Menu button labels (single source of truth — used by the keyboard + router)
// ---------------------------------------------------------------------------

export const MENU = {
  voice: '🎤 Ovozli so\'rov',
  sendRequest: '➕ So\'rov yuborish',
  incoming: '📥 Kelgan so\'rovlar',
  products: '📦 Mahsulotlar',
  up: '⬆️ Yuqoriga so\'rov',
  status: '📊 Holat',
  reports: '📊 Hisobotlar',
  aiChat: '🤖 AI suhbat',
  logout: '🚪 Chiqish',
} as const;

type ReplyKeyboard = {
  readonly keyboard: string[][];
  readonly resize_keyboard: true;
  readonly is_persistent: true;
};

/**
 * The role → reply-keyboard map (tz §3). `store_manager` gets the full action
 * set; the upstream managers get an incoming-first layout; `pm` is read-only
 * (no action buttons — operational view only).
 */
export function buildMenuKeyboard(role: Role): ReplyKeyboard {
  let rows: string[][];
  switch (role) {
    case 'store_manager':
      rows = [
        [MENU.voice, MENU.sendRequest],
        [MENU.incoming, MENU.products],
        [MENU.reports, MENU.aiChat],
        [MENU.logout],
      ];
      break;
    case 'central_warehouse_manager':
    case 'production_manager':
    case 'supply_manager':
    case 'raw_warehouse_manager':
      rows = [
        [MENU.incoming, MENU.voice],
        [MENU.up],
        [MENU.reports, MENU.aiChat],
        [MENU.logout],
      ];
      break;
    case 'pm':
      // Read-only operational view + reports.
      rows = [[MENU.status], [MENU.reports, MENU.aiChat], [MENU.logout]];
      break;
    default:
      rows = [[MENU.status], [MENU.aiChat], [MENU.logout]];
  }
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

const ROLE_LABEL: Readonly<Record<Role, string>> = {
  pm: 'PM',
  raw_warehouse_manager: 'xom-ashyo ombori',
  production_manager: 'ishlab chiqarish',
  supply_manager: "ta'minot",
  central_warehouse_manager: 'markaziy sklad',
  store_manager: "do'kon",
  ai_assistant: 'AI',
};

export type UserMenuContext = {
  readonly userName: string;
  readonly role: Role;
  readonly locationName: string | null;
};

/** Load the greeting context for a linked user (name + role + primary location). */
export async function loadUserMenuContext(
  userId: number,
): Promise<UserMenuContext | null> {
  const { rows } = await query<{
    name: string;
    role: Role;
    location_name: string | null;
  }>(
    `SELECT u.name, u.role, l.name AS location_name
       FROM users u
       LEFT JOIN locations l ON l.id = u.location_id
      WHERE u.id = $1 AND u.is_active = TRUE`,
    [userId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return { userName: r.name, role: r.role, locationName: r.location_name };
}

export function buildGreeting(menuCtx: UserMenuContext): string {
  const loc = menuCtx.locationName ?? ROLE_LABEL[menuCtx.role];
  const roleLabel = ROLE_LABEL[menuCtx.role];
  return (
    `Salom, ${menuCtx.userName}! ` +
    `Siz ${loc} (${roleLabel}) bo'limidasiz.\n\n` +
    'Quyidagi menyudan foydalaning:'
  );
}

// ---------------------------------------------------------------------------
// Menu router — turns a tapped reply-keyboard button into a reply
// ---------------------------------------------------------------------------

export type MenuCtxLike = {
  readonly from?: { id?: number };
  readonly message?: { readonly text?: string };
  reply(text: string, opts?: Record<string, unknown>): Promise<unknown>;
};

export type MenuHandleResult = {
  readonly handled: boolean;
  readonly action?: string;
};

const MENU_TEXTS = new Set<string>(Object.values(MENU));

/** Is this text one of our menu buttons? (cheap pre-check before any DB hit). */
export function isMenuButton(text: string): boolean {
  return MENU_TEXTS.has(text.trim());
}

/**
 * Route a tapped menu button. Returns `{ handled:false }` for any text that is
 * NOT a menu button, so the caller can fall through to the cash-shift handler.
 */
export async function handleMenuMessage(
  ctx: MenuCtxLike,
): Promise<MenuHandleResult> {
  const tgId = ctx.from?.id;
  const text = ctx.message?.text?.trim();
  if (tgId === undefined || text === undefined || text === '') {
    return { handled: false };
  }
  if (!isMenuButton(text)) {
    return { handled: false };
  }

  const principal = await loadVoicePrincipal(tgId);
  if (principal === null) {
    await safeReply(
      ctx,
      "Sizning Telegram hisobingiz tizimda ro'yxatdan o'tmagan. PM bilan bog'laning.",
    );
    return { handled: true, action: 'unauthorized' };
  }

  switch (text) {
    case MENU.voice:
      await safeReply(
        ctx,
        '🎤 Ovozli so\'rov yuborish uchun mikrofon tugmasini bosib, ' +
          'masalan "menga yigirmata napoleon kerak" deb gapiring.',
      );
      return { handled: true, action: 'voice_hint' };

    case MENU.sendRequest:
    case MENU.up:
      await safeReply(
        ctx,
        "➕ So'rov yuborish: ovozli xabar yuboring (🎤) — bot mahsulot va sonini " +
          "aniqlab, ustki bo'limга jo'natadi.",
      );
      return { handled: true, action: 'send_request_hint' };

    case MENU.incoming:
      await replyIncoming(ctx, principal);
      return { handled: true, action: 'incoming' };

    case MENU.products:
      await replyProducts(ctx, principal);
      return { handled: true, action: 'products' };

    case MENU.status:
      await replyStatus(ctx, principal);
      return { handled: true, action: 'status' };

    case MENU.reports:
      await replyReportsMenu(ctx, principal);
      return { handled: true, action: 'reports' };

    case MENU.aiChat:
      enterAiChatMode(tgId);
      await safeReply(ctx, AI_CHAT_PROMPT);
      return { handled: true, action: 'ai_chat' };

    case MENU.logout: {
      const { unlinked, userName } = await unlinkTelegramAccount(tgId);
      exitAiChatMode(tgId);
      await safeReply(
        ctx,
        unlinked
          ? `✅ Tizimdan chiqdingiz${userName ? ` (${userName})` : ''}.\n` +
              'Boshqa akkaunt ulash uchun ilovadan yangi havola oling va /start <token> yuboring.'
          : 'Siz hech qaysi akkauntga ulanmagansiz.',
        { reply_markup: { remove_keyboard: true } },
      );
      return { handled: true, action: 'logout' };
    }

    default:
      return { handled: false };
  }
}

// ---------------------------------------------------------------------------
// Button bodies
// ---------------------------------------------------------------------------

type InlineButton = { text: string; callback_data: string };

/**
 * "📥 Kelgan so'rovlar" — open requests whose TARGET is the user's location
 * (or whose requester's parent is the user's location, for not-yet-pinned
 * requests). Each row gets ✅ Qabul / ❌ Rad inline buttons (xreq verbs).
 */
async function replyIncoming(
  ctx: MenuCtxLike,
  principal: AuthPrincipal,
): Promise<void> {
  const locId = principal.activeLocationId ?? principal.locationId;
  const isPm = principal.role === 'pm';
  if (locId === null && !isPm) {
    await safeReply(ctx, "Sizga bo'lim biriktirilmagan.");
    return;
  }

  const { rows } = await query<{
    id: number;
    product_name: string;
    qty_needed: string;
    unit: string;
    requester_name: string;
    status: string;
  }>(
    `SELECT r.id, p.name AS product_name, r.qty_needed, p.unit AS unit,
            rl.name AS requester_name, r.status
       FROM replenishment_requests r
       JOIN products p ON p.id = r.product_id
       JOIN locations rl ON rl.id = r.requester_location_id
      WHERE r.status NOT IN ('CLOSED', 'CANCELLED')
        AND (
          $2::boolean = TRUE
          OR r.target_location_id = $1
          OR (r.target_location_id IS NULL AND rl.parent_id = $1)
        )
      ORDER BY r.created_at ASC
      LIMIT 20`,
    [locId, isPm],
  );

  if (rows.length === 0) {
    await safeReply(ctx, '📥 Kelgan so\'rovlar yo\'q.');
    return;
  }

  for (const r of rows) {
    const line =
      `📥 So'rov #${r.id} — ${r.requester_name}\n` +
      `${r.product_name} × ${Number(r.qty_needed)} ${r.unit}\n` +
      `Holat: ${r.status}`;
    const buttons: InlineButton[] = [
      { text: '✅ Qabul', callback_data: `xreq:accept:${r.id}` },
      { text: '❌ Rad', callback_data: `xreq:reject:${r.id}` },
    ];
    await safeReply(ctx, line, {
      reply_markup: { inline_keyboard: [buttons] },
    });
  }
}

/** "📦 Mahsulotlar" — stock summary for the user's location. */
async function replyProducts(
  ctx: MenuCtxLike,
  principal: AuthPrincipal,
): Promise<void> {
  const locId = principal.activeLocationId ?? principal.locationId;
  if (locId === null) {
    await safeReply(ctx, "Sizga bo'lim biriktirilmagan.");
    return;
  }
  const { rows } = await query<{
    name: string;
    qty: string;
    unit: string;
    min_level: string;
  }>(
    `SELECT p.name, s.qty, p.unit, s.min_level
       FROM stock s
       JOIN products p ON p.id = s.product_id
      WHERE s.location_id = $1 AND p.is_active = TRUE
      ORDER BY (s.qty <= s.min_level) DESC, p.name ASC
      LIMIT 30`,
    [locId],
  );
  if (rows.length === 0) {
    await safeReply(ctx, '📦 Bu bo\'limda mahsulot qoldig\'i yo\'q.');
    return;
  }
  const lines = rows.map((r) => {
    const low = Number(r.qty) <= Number(r.min_level) ? ' ⚠️' : '';
    return `• ${r.name}: ${Number(r.qty)} ${r.unit}${low}`;
  });
  await safeReply(ctx, `📦 Mahsulotlar (qoldiq):\n${lines.join('\n')}`);
}

/** "📊 Holat" — PM read-only chain overview (open requests count by status). */
async function replyStatus(
  ctx: MenuCtxLike,
  _principal: AuthPrincipal,
): Promise<void> {
  const { rows } = await query<{ status: string; n: string }>(
    `SELECT status, count(*) AS n
       FROM replenishment_requests
      WHERE status NOT IN ('CLOSED', 'CANCELLED')
      GROUP BY status
      ORDER BY status`,
  );
  if (rows.length === 0) {
    await safeReply(ctx, '📊 Hozir ochiq so\'rovlar yo\'q.');
    return;
  }
  const lines = rows.map((r) => `• ${r.status}: ${Number(r.n)}`);
  await safeReply(ctx, `📊 Ochiq so'rovlar holati:\n${lines.join('\n')}`);
}

/**
 * "📊 Hisobotlar" — open the inline keyboard of the 4 report types. RBAC: a
 * store_manager must have a store; the dept managers + pm get the whole chain.
 * The actual report rendering / file generation happens in the callback flow
 * (reportsHandler.ts), reached when a button is tapped.
 */
async function replyReportsMenu(
  ctx: MenuCtxLike,
  principal: AuthPrincipal,
): Promise<void> {
  const scope = reportScopeFor({
    userId: principal.userId,
    role: principal.role,
    locationId: principal.activeLocationId ?? principal.locationId,
  });
  if (scope === null) {
    await safeReply(ctx, "Sizda hisobot ko'rish huquqi yo'q yoki bo'lim biriktirilmagan.");
    return;
  }
  await safeReply(ctx, '📊 Hisobotlar — turini tanlang:', {
    reply_markup: { inline_keyboard: reportTypeKeyboard() },
  });
}

async function safeReply(
  ctx: MenuCtxLike,
  text: string,
  opts?: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.reply(text, opts);
  } catch (err) {
    console.error('[telegram-menu] reply failed:', (err as Error).message);
  }
}
