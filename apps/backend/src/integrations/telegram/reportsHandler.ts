/**
 * 📊 Hisobotlar — Telegram reports menu + callback handler.
 *
 * The reports flow needs two things the generic `verb:entity:id` dispatch
 * (dispatch.ts / callbackHandler.ts) cannot express:
 *   1. STRING callback segments — a report `type` (sales|payment|trend|
 *      belowmin) and a `period` (bugun|hafta|oy), not numeric ids;
 *   2. DOCUMENT replies — `replyWithDocument`, not `answerCallbackQuery` text.
 *
 * So reports get their own self-contained handler, wired in bot.ts BEFORE the
 * generic callback handler. It reuses the SAME guarantees as that framework:
 *   - idempotency via `telegram_callback_actions(update_id)` UNIQUE;
 *   - spoofing check via `lookupTelegramUser`;
 *   - RBAC scoping — a store_manager only ever pulls THEIR store's reports;
 *   - an `audit_log` row per action.
 *
 * Callback grammar (compact, ≤64 bytes):
 *   - `rep:menu`                       — open the 4-type inline keyboard;
 *   - `rep:<type>`                     — type chosen; show period sub-keyboard
 *                                        (or render immediately for belowmin);
 *   - `rep:<type>:<period>`            — render the formatted summary + 3 DL btns;
 *   - `repdl:<fmt>:<type>:<period>`    — generate + send the file (fmt=xlsx|pdf|docx).
 *
 * UI text is Uzbek; identifiers stay English.
 */
import { query } from '../../db/index.js';
import { writeAudit, poolRunner } from '../../lib/audit.js';
import { lookupTelegramUser, type CallbackPrincipal } from './dispatch.js';
import {
  buildReport,
  isReportPeriod,
  isReportType,
  MENU_REPORT_TYPES,
  PERIOD_LABEL,
  REPORT_PERIODS,
  REPORT_TYPE_LABEL,
  type Report,
  type ReportPeriod,
  type ReportScope,
  type ReportType,
} from '../../services/reports.js';
import {
  EXPORT_FORMATS,
  exportReport,
  isExportFormat,
  type ExportFormat,
} from '../../services/reportExport.js';

/** PostgreSQL SQLSTATE for unique_violation. */
const SQLSTATE_UNIQUE_VIOLATION = '23505';

/** Report types that take a period sub-choice (belowmin is a snapshot). */
const PERIODIC_TYPES: ReadonlySet<ReportType> = new Set<ReportType>([
  'sales',
  'payment',
  'trend',
]);

type InlineButton = { text: string; callback_data: string };

/**
 * The adapter the bot wires for a reports callback. Mirrors `CallbackContext`
 * but adds `editMessageText` (swap the menu in place) and `replyWithDocument`
 * (send the generated file).
 */
export type ReportsCallbackContext = {
  readonly updateId: number;
  readonly callbackQueryId: string;
  readonly fromTelegramId: number;
  readonly data: string;
  answerCallbackQuery(text: string, opts?: { showAlert?: boolean }): Promise<unknown>;
  /** Send a fresh message with optional inline keyboard. */
  sendMessage(
    text: string,
    opts?: { inlineKeyboard?: InlineButton[][] },
  ): Promise<unknown>;
  /** Send a generated document (Grammy replyWithDocument). */
  replyWithDocument(buffer: Buffer, filename: string): Promise<unknown>;
};

/** Does this raw callback_data belong to the reports flow? */
export function isReportsCallback(data: string): boolean {
  return data.startsWith('rep:') || data.startsWith('repdl:');
}

// ---------------------------------------------------------------------------
// RBAC — who may pull reports, and in what scope
// ---------------------------------------------------------------------------

/**
 * Reports are available to `pm` (whole chain) and every dept/store manager.
 * A `store_manager` is scoped to THEIR store; everyone else (pm + dept
 * managers, who already see read-only chain summaries) gets `all`.
 *
 * Returns `null` when the role may not pull reports at all.
 */
export function reportScopeFor(principal: CallbackPrincipal): ReportScope | null {
  if (principal.role === 'store_manager') {
    if (principal.locationId === null) return null;
    return { kind: 'store', storeId: principal.locationId };
  }
  if (
    principal.role === 'pm' ||
    principal.role === 'central_warehouse_manager' ||
    principal.role === 'production_manager' ||
    principal.role === 'supply_manager' ||
    principal.role === 'raw_warehouse_manager'
  ) {
    return { kind: 'all' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/**
 * The top-level keyboard. Only the two MENU report types are offered:
 * "Sotuvlar" (now a combined report carrying the payment-type + trend sections)
 * and "Min'dan past mahsulotlar". The `payment` / `trend` callbacks still
 * resolve if pressed (legacy/back-compat) but are no longer surfaced here.
 */
export function reportTypeKeyboard(): InlineButton[][] {
  return MENU_REPORT_TYPES.map((t) => [
    { text: REPORT_TYPE_LABEL[t], callback_data: `rep:${t}` },
  ]);
}

/** The period sub-keyboard for a periodic type. */
export function periodKeyboard(type: ReportType): InlineButton[][] {
  return [
    REPORT_PERIODS.map((p) => ({
      text: PERIOD_LABEL[p],
      callback_data: `rep:${type}:${p}`,
    })),
  ];
}

/** The 3 download buttons under a rendered summary. */
export function downloadKeyboard(
  type: ReportType,
  period: ReportPeriod,
): InlineButton[][] {
  const fmtLabel: Readonly<Record<ExportFormat, string>> = {
    xlsx: '📊 Excel',
    docx: '📄 Word',
    pdf: '📕 PDF',
  };
  return [
    EXPORT_FORMATS.map((f) => ({
      text: fmtLabel[f],
      callback_data: `repdl:${f}:${type}:${period}`,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Summary text rendering
// ---------------------------------------------------------------------------

/** Render a `Report` as a compact Telegram text summary. */
export function renderReportSummary(report: Report): string {
  const lines: string[] = [`📊 *${report.title}*`, report.subtitle, ''];
  for (const section of report.sections) {
    lines.push(`*${section.heading}*`);
    if (section.rows.length === 0) {
      lines.push("  (ma'lumot yo'q)");
    } else {
      // Show up to 15 rows in the chat; the file carries the full set.
      const shown = section.rows.slice(0, 15);
      for (const row of shown) {
        lines.push(`• ${row.join(' — ')}`);
      }
      if (section.rows.length > shown.length) {
        lines.push(`  …va yana ${section.rows.length - shown.length} ta (faylda to'liq)`);
      }
    }
    if (section.total !== undefined) {
      lines.push(`*${section.total.filter((c) => c !== '').join(' — ')}*`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

type Outcome = {
  readonly answer: string;
  readonly showAlert: boolean;
  readonly status: 'processed' | 'rejected_unauthorized' | 'rejected_rbac' | 'failed';
};

export async function handleReportsCallback(
  ctx: ReportsCallbackContext,
): Promise<void> {
  // -------- 1. Idempotency: claim the audit row first -------------------
  let actionRowId: number | null = null;
  try {
    const { rows } = await query<{ id: number }>(
      `INSERT INTO telegram_callback_actions
         (update_id, callback_query_id, from_telegram_id, callback_data, status)
       VALUES ($1, $2, $3, $4, 'processed')
       RETURNING id`,
      [ctx.updateId, ctx.callbackQueryId, String(ctx.fromTelegramId), ctx.data],
    );
    actionRowId = rows[0]?.id ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) {
      await safeAnswer(ctx, 'Allaqachon qayta ishlangan', false);
      return;
    }
    console.error('[telegram-reports] audit insert failed:', (err as Error).message);
    await safeAnswer(ctx, 'Server xatosi', true);
    return;
  }

  // -------- 2. Spoofing — resolve the presser ---------------------------
  let principal: CallbackPrincipal | null;
  try {
    principal = await lookupTelegramUser(ctx.fromTelegramId);
  } catch (err) {
    await finalizeAudit(actionRowId, 'failed', `user lookup: ${(err as Error).message}`);
    await safeAnswer(ctx, 'Server xatosi', true);
    return;
  }
  if (principal === null) {
    await finalizeAudit(actionRowId, 'rejected_unauthorized', null);
    await safeAnswer(ctx, 'Foydalanuvchi topilmadi', true);
    return;
  }
  await query(`UPDATE telegram_callback_actions SET user_id = $2 WHERE id = $1`, [
    actionRowId,
    principal.userId,
  ]);

  // -------- 3. RBAC scope ------------------------------------------------
  const scope = reportScopeFor(principal);
  if (scope === null) {
    await finalizeAudit(actionRowId, 'rejected_rbac', null);
    await safeAnswer(ctx, 'Sizda hisobot ko\'rish huquqi yo\'q', true);
    return;
  }

  // -------- 4. Route -----------------------------------------------------
  let outcome: Outcome;
  try {
    outcome = await routeReports(ctx, principal, scope);
  } catch (err) {
    outcome = {
      answer: 'Hisobot xatolik bilan tugadi',
      showAlert: true,
      status: 'failed',
    };
    console.error('[telegram-reports] route failed:', (err as Error).message);
    await finalizeAudit(actionRowId, 'failed', (err as Error).message.slice(0, 500));
    await writeReportAudit(principal.userId, ctx.data, 'failed');
    await safeAnswer(ctx, outcome.answer, outcome.showAlert);
    return;
  }

  await finalizeAudit(actionRowId, outcome.status, null);
  await writeReportAudit(principal.userId, ctx.data, outcome.status);
  await safeAnswer(ctx, outcome.answer, outcome.showAlert);
}

/** The pure routing core — parse the callback and act. */
async function routeReports(
  ctx: ReportsCallbackContext,
  _principal: CallbackPrincipal,
  scope: ReportScope,
): Promise<Outcome> {
  const parts = ctx.data.split(':');

  // ---- repdl:<fmt>:<type>:<period> — generate + send a file ----
  if (parts[0] === 'repdl') {
    const fmt = parts[1] ?? '';
    const type = parts[2] ?? '';
    const period = parts[3] ?? '';
    if (
      !isExportFormat(fmt) ||
      !isReportType(type) ||
      !validPeriodFor(type, period)
    ) {
      return { answer: "Noto'g'ri tugma", showAlert: true, status: 'failed' };
    }
    const report = await buildReport(type, resolvePeriod(type, period), scope);
    const file = await exportReport(report, fmt);
    await ctx.replyWithDocument(file.buffer, file.filename);
    return { answer: '📎 Fayl yuborildi', showAlert: false, status: 'processed' };
  }

  // ---- rep:* ----
  if (parts[0] === 'rep') {
    // rep:menu — open the 4-type keyboard.
    if (parts[1] === 'menu' || parts[1] === undefined || parts[1] === '') {
      await ctx.sendMessage('📊 *Hisobotlar* — turini tanlang:', {
        inlineKeyboard: reportTypeKeyboard(),
      });
      return { answer: 'Hisobotlar', showAlert: false, status: 'processed' };
    }

    const type = parts[1];
    if (!isReportType(type)) {
      return { answer: "Noto'g'ri tugma", showAlert: true, status: 'failed' };
    }

    // rep:<type> — periodic types show the period sub-keyboard; belowmin
    // renders immediately (snapshot, no period).
    if (parts[2] === undefined) {
      if (PERIODIC_TYPES.has(type)) {
        await ctx.sendMessage(
          `📊 *${REPORT_TYPE_LABEL[type]}* — davrni tanlang:`,
          { inlineKeyboard: periodKeyboard(type) },
        );
        return { answer: REPORT_TYPE_LABEL[type], showAlert: false, status: 'processed' };
      }
      // belowmin — render now.
      return renderAndSend(ctx, type, 'bugun', scope);
    }

    // rep:<type>:<period> — render the summary + download buttons.
    const period = parts[2];
    if (!validPeriodFor(type, period)) {
      return { answer: "Noto'g'ri davr", showAlert: true, status: 'failed' };
    }
    return renderAndSend(ctx, type, resolvePeriod(type, period), scope);
  }

  return { answer: "Noma'lum amal", showAlert: true, status: 'failed' };
}

/** Build the report, send the summary + download keyboard. */
async function renderAndSend(
  ctx: ReportsCallbackContext,
  type: ReportType,
  period: ReportPeriod,
  scope: ReportScope,
): Promise<Outcome> {
  const report = await buildReport(type, period, scope);
  const summary = renderReportSummary(report);
  await ctx.sendMessage(summary, {
    inlineKeyboard: downloadKeyboard(type, period),
  });
  return { answer: REPORT_TYPE_LABEL[type], showAlert: false, status: 'processed' };
}

/**
 * A period is valid for a periodic type only if it is a real period; for
 * belowmin any value is accepted (it is ignored — snapshot). This keeps the
 * grammar uniform (`repdl:<fmt>:belowmin:bugun`).
 */
function validPeriodFor(type: ReportType, period: string): boolean {
  if (!PERIODIC_TYPES.has(type)) return true;
  return isReportPeriod(period);
}
function resolvePeriod(type: ReportType, period: string): ReportPeriod {
  if (PERIODIC_TYPES.has(type) && isReportPeriod(period)) return period;
  return 'bugun';
}

// ---------------------------------------------------------------------------
// Audit + answer helpers
// ---------------------------------------------------------------------------

async function finalizeAudit(
  actionRowId: number | null,
  status: Outcome['status'] | 'duplicate',
  errorDetail: string | null,
): Promise<void> {
  if (actionRowId === null) return;
  await query(
    `UPDATE telegram_callback_actions
        SET status = $2::telegram_callback_status, error_detail = $3
      WHERE id = $1`,
    [actionRowId, status, errorDetail],
  );
}

async function writeReportAudit(
  userId: number,
  data: string,
  status: Outcome['status'],
): Promise<void> {
  try {
    await writeAudit(poolRunner, {
      actorUserId: userId,
      action: `telegram_report.${status}`,
      entity: 'telegram_callback_actions',
      entityId: null,
      payload: { callback_data: data },
    });
  } catch (err) {
    console.error('[telegram-reports] audit write failed:', (err as Error).message);
  }
}

async function safeAnswer(
  ctx: ReportsCallbackContext,
  text: string,
  showAlert: boolean,
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(text, { showAlert });
  } catch (err) {
    console.error('[telegram-reports] answerCallbackQuery failed:', (err as Error).message);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === SQLSTATE_UNIQUE_VIOLATION
  );
}
