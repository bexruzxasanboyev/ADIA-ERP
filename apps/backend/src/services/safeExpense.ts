/**
 * EPIC 8.7 — seyf rasxodi (safe expense) read service.
 *
 * Owner scenario (changes-2026-05-owner-feedback.md §8.7): "Seyf rasxodlari
 * uchun ham xuddi shunday (nakladnoy/transaksiya)" — record safe pay-outs as
 * transactions visible to the admin.
 *
 * Poster is the SOURCE — `finance.getTransactions` (read-only, P8). This
 * service wraps the client and maps each EXPENSE transaction (type 0) onto the
 * frontend `SafeExpense` contract (apps/frontend/src/lib/types.ts). Income
 * rows (type 1) are dropped — the view is rasxodlar only. Money is normalised
 * from tiyin to so'm.
 *
 * INVARIANTS: read-only — no Poster write-back, no stock mutation.
 */
import type {
  PosterClient,
  PosterFinanceTransaction,
} from '../integrations/poster/client.js';
import { tiyinToSom } from '../integrations/poster/posterMoney.js';

/** Frontend `SafeExpense` contract shape. */
export type SafeExpenseDto = {
  readonly id: number;
  readonly spent_at: string;
  readonly amount: number;
  readonly category: string;
  readonly note: string | null;
  readonly recorded_by_name: string | null;
};

/**
 * Poster expense type marker. Confirmed LIVE against the `adia` account
 * 2026-06-01 via `finance.getTransactions` (660 type-0 + 737 type-1 rows over
 * 2026-05-01..06-01):
 *   - `type = 0` -> EXPENSE (rasxod): amount is ALWAYS negative; categories are
 *     spend ("Поставки", "Расход для Чигатой", "Помощники", "Кухня", staff names).
 *   - `type = 1` -> INCOME (kirim): amount is ALWAYS positive ("Кассовые смены",
 *     "Переводы").
 * So `type 0 = expense` is the correct filter (NOT inverted). We surface only
 * type-0 rows here and normalise the negative tiyin amount to a positive so'm
 * figure via `Math.abs` in `mapSafeExpense`.
 */
const EXPENSE_TYPE = 0;

function posterDateToIso(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === '') return new Date(0).toISOString();
  const d = new Date(raw.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/**
 * Pure mapper — one Poster finance transaction -> `SafeExpense`. Exported for
 * unit testing. The amount is taken as a positive so'm figure regardless of
 * Poster's sign convention.
 */
export function mapSafeExpense(raw: PosterFinanceTransaction): SafeExpenseDto {
  return {
    id: Number(raw.transaction_id),
    spent_at: posterDateToIso(raw.date ?? null),
    amount: Math.abs(tiyinToSom(raw.amount)),
    category: raw.category_name ?? 'Boshqa',
    note: raw.comment ?? null,
    recorded_by_name: raw.user_id !== undefined ? `Poster #${raw.user_id}` : null,
  };
}

/** True when a finance transaction is an expense (rasxod). */
export function isExpense(raw: PosterFinanceTransaction): boolean {
  if (raw.type === undefined) return false;
  return Number(raw.type) === EXPENSE_TYPE;
}

export type ListSafeExpensesArgs = {
  readonly dateFrom: string; // YYYYMMDD
  readonly dateTo: string; // YYYYMMDD
  readonly accountId?: number;
};

/**
 * Fetch + map safe expenses from Poster finance transactions for the range.
 * Only expense (type 0) rows are kept; newest first.
 */
export async function listSafeExpenses(
  poster: PosterClient,
  args: ListSafeExpensesArgs,
): Promise<SafeExpenseDto[]> {
  const raw = await poster.getFinanceTransactions({
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    ...(args.accountId !== undefined ? { accountId: args.accountId } : {}),
  });
  const out = raw.filter(isExpense).map(mapSafeExpense);
  out.sort((a, b) => b.spent_at.localeCompare(a.spent_at));
  return out;
}
