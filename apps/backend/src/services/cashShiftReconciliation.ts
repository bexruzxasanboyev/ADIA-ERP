/**
 * TZ Module 15 — kassir bot SOLISHTIRUV (reconciliation).
 *
 * The kassir bot already parses a cashier's end-of-day text and creates a
 * `cash_shift` money nakladnoy (services/cashShiftSubmission.ts). This module
 * is the MISSING piece: after that nakladnoy commits, it reads the Poster cash
 * shift (`finance.getCashShifts`) for the same store + day — and optionally the
 * store's safe (cash-box) balance (`finance.getAccounts`) — and compares
 * Poster's cash/card/expense against what the cashier submitted.
 *
 * Field mapping (submitted ↔ Poster), all in so'm:
 *   submitted_cash    = remainder − card  ↔  poster_cash    = amount_sell_cash
 *   submitted_card    = card               ↔  poster_card    = amount_sell_card
 *   submitted_expense = expense            ↔  poster_expense = amount_debit
 *   *_diff = submitted_* − poster_*   (positive = cashier reported MORE than Poster).
 *   poster_safe_balance = the store's cash-box account balance (informational only).
 *
 * status:
 *   'no_poster_data' — Poster had no shift for that store+day (cannot compare);
 *   'matched'        — every diff within tolerance (default ±1000 so'm);
 *   'discrepancy'    — at least one diff exceeds tolerance → PM + manager alerted.
 *
 * NON-FATAL GUARANTEE (invariant): `reconcileCashShift` NEVER throws — a Poster
 * outage, a DB hiccup, or a missing spot mapping is caught, logged, and returns
 * `null`. The nakladnoy already exists; reconciliation is a best-effort overlay
 * and must never break (or roll back) the cashier's submission.
 */
import { withTransaction, type TxClient } from '../db/index.js';
import type { PosterCashShift, PosterClient } from '../integrations/poster/client.js';
import { tiyinToSom } from '../integrations/poster/posterMoney.js';
import {
  createNotification,
  getPmRecipients,
  getLocationManager,
} from './notify.js';

/** Default tolerance (so'm) below which a diff is treated as a rounding match. */
export const DEFAULT_RECON_TOLERANCE_SOM = 1000;

export type ReconciliationStatus = 'matched' | 'discrepancy' | 'no_poster_data';

/** The cashier-submitted side, all in so'm. cash = naqd qoldiq (remainder − card). */
export type SubmittedFigures = {
  readonly cash: number;
  readonly card: number;
  readonly expense: number;
};

/** The Poster side, all in so'm. `null` when Poster returned no shift. */
export type PosterFigures = {
  readonly cashShiftId: string | null;
  readonly cash: number;
  readonly card: number;
  readonly expense: number;
} | null;

/** The pure reconciliation result — every money value in so'm. */
export type ReconciliationResult = {
  readonly status: ReconciliationStatus;
  readonly posterCashShiftId: string | null;
  readonly submittedCash: number;
  readonly submittedCard: number;
  readonly submittedExpense: number;
  readonly posterCash: number | null;
  readonly posterCard: number | null;
  readonly posterExpense: number | null;
  readonly posterSafeBalance: number | null;
  readonly cashDiff: number | null;
  readonly cardDiff: number | null;
  readonly expenseDiff: number | null;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure reconciliation — compares the cashier's submitted figures against the
 * Poster shift (when present). No DB, no network — exported for unit testing.
 *
 * - `poster === null` → status `no_poster_data`, all poster_* + diffs null.
 * - else compute each diff = submitted − poster; status `matched` when EVERY
 *   diff's magnitude is ≤ `tolerance`, otherwise `discrepancy`.
 *
 * `safeBalance` (so'm or null) is informational only — it does NOT affect the
 * status (it is not a like-for-like of any submitted figure).
 */
export function computeReconciliation(
  submitted: SubmittedFigures,
  poster: PosterFigures,
  safeBalance: number | null,
  tolerance: number = DEFAULT_RECON_TOLERANCE_SOM,
): ReconciliationResult {
  const submittedCash = round2(submitted.cash);
  const submittedCard = round2(submitted.card);
  const submittedExpense = round2(submitted.expense);
  const safe = safeBalance === null ? null : round2(safeBalance);

  if (poster === null) {
    return {
      status: 'no_poster_data',
      posterCashShiftId: null,
      submittedCash,
      submittedCard,
      submittedExpense,
      posterCash: null,
      posterCard: null,
      posterExpense: null,
      posterSafeBalance: safe,
      cashDiff: null,
      cardDiff: null,
      expenseDiff: null,
    };
  }

  const posterCash = round2(poster.cash);
  const posterCard = round2(poster.card);
  const posterExpense = round2(poster.expense);
  const cashDiff = round2(submittedCash - posterCash);
  const cardDiff = round2(submittedCard - posterCard);
  const expenseDiff = round2(submittedExpense - posterExpense);

  const within = (d: number): boolean => Math.abs(d) <= tolerance;
  const status: ReconciliationStatus =
    within(cashDiff) && within(cardDiff) && within(expenseDiff)
      ? 'matched'
      : 'discrepancy';

  return {
    status,
    posterCashShiftId: poster.cashShiftId,
    submittedCash,
    submittedCard,
    submittedExpense,
    posterCash,
    posterCard,
    posterExpense,
    posterSafeBalance: safe,
    cashDiff,
    cardDiff,
    expenseDiff,
  };
}

/**
 * Pick the most representative Poster shift for a store+day. Poster can emit
 * several shifts per spot per day (multiple cashier sessions); we aggregate
 * cash/card/expense across all of them so the comparison is against the WHOLE
 * day's Poster activity — which is what a single end-of-day cashier text
 * reports. Returns `null` when the list is empty.
 */
export function aggregatePosterShifts(shifts: readonly PosterCashShift[]): PosterFigures {
  if (shifts.length === 0) return null;
  let cash = 0;
  let card = 0;
  let expense = 0;
  for (const s of shifts) {
    cash += tiyinToSom(s.amount_sell_cash);
    card += tiyinToSom(s.amount_sell_card);
    expense += tiyinToSom(s.amount_debit);
  }
  // Use the first shift's id as the reference (newest-first not guaranteed; the
  // id is only a forensic pointer back to Poster, not a sum key).
  const ref = shifts[0]?.cash_shift_id;
  return {
    cashShiftId: ref === undefined ? null : String(ref),
    cash: round2(cash),
    card: round2(card),
    expense: round2(expense),
  };
}

/** Date → Poster `YYYYMMDD` (UTC), matching dateRange.toPosterDate. */
function toPosterDay(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Read the store's safe (cash-box) balance from `finance.getAccounts`, in so'm.
 * A store's till maps to a cash-box account via `account.spots[].account_cash`
 * (verified live 2026-06-09). We pick that account's balance. Returns `null`
 * when no spot id is known, no account matches, or Poster yields nothing.
 *
 * Best-effort: any failure here returns `null` (the caller never lets a safe
 * lookup break reconciliation).
 */
async function fetchSafeBalance(
  poster: PosterClient,
  spotId: number | null,
): Promise<number | null> {
  if (spotId === null) return null;
  try {
    const accounts = await poster.getAccounts();
    for (const acc of accounts) {
      for (const s of acc.spots ?? []) {
        if (s.account_cash === undefined) continue;
        if (Number(s.spot_id) === spotId && Number(s.account_cash) === Number(acc.account_id)) {
          return tiyinToSom(acc.balance);
        }
      }
    }
    return null;
  } catch (err) {
    console.warn('[cash-shift-recon] safe balance lookup failed:', (err as Error).message);
    return null;
  }
}

export type ReconcileCashShiftInput = {
  readonly nakladnoyId: number;
  readonly locationId: number;
  /** Naqd qoldiq (remainder − card), in so'm. */
  readonly submittedCash: number;
  /** Karta qoldiq, in so'm. */
  readonly submittedCard: number;
  /** Rasxod, in so'm. */
  readonly submittedExpense: number;
  /** Business day to reconcile (defaults to now). */
  readonly shiftDate?: Date;
  /** Tolerance override (so'm). */
  readonly tolerance?: number;
};

export type ReconcileCashShiftOutcome = {
  readonly reconciliationId: number;
  readonly result: ReconciliationResult;
  readonly shiftDate: string; // YYYY-MM-DD
};

/**
 * Orchestrate the reconciliation for a just-created cash_shift nakladnoy.
 *
 * NON-FATAL: this function NEVER throws. On any failure (Poster outage, DB
 * error, missing mapping) it logs and returns `null` — the submission stands.
 *
 * Steps:
 *   1. Resolve the store's `poster_spot_id`.
 *   2. Fetch Poster cash shifts for spot+day (graceful-degrade to none).
 *   3. Fetch the safe balance from `finance.getAccounts` (informational).
 *   4. Compute the reconciliation (pure).
 *   5. Insert the `cash_shift_reconciliation` row, stamp `nakladnoy.source_ref`
 *      with the Poster cash_shift_id (when known) + audit — one transaction.
 *   6. On `discrepancy`, notify PM + the location manager (same transaction).
 */
export async function reconcileCashShift(
  poster: PosterClient,
  input: ReconcileCashShiftInput,
): Promise<ReconcileCashShiftOutcome | null> {
  const shiftDate = input.shiftDate ?? new Date();
  const dayKey = shiftDate.toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    // 1. Store's Poster spot id (RBAC anchor → Poster filter).
    const spotId = await loadSpotId(input.locationId);

    // 2. Poster cash shifts for the spot + day. A method-level Poster failure
    //    (unavailable for this account) degrades to "no data" — never fatal.
    let posterFigures: PosterFigures = null;
    if (spotId !== null) {
      try {
        const day = toPosterDay(shiftDate);
        const shifts = await poster.getCashShifts({
          dateFrom: day,
          dateTo: day,
          spotId,
        });
        // Defensive: keep only shifts for THIS spot (Poster honours the filter,
        // but the param is advisory on some accounts).
        const own = shifts.filter(
          (s) => s.spot_id === undefined || Number(s.spot_id) === spotId,
        );
        posterFigures = aggregatePosterShifts(own);
      } catch (err) {
        console.warn(
          '[cash-shift-recon] Poster getCashShifts failed, treating as no data:',
          (err as Error).message,
        );
        posterFigures = null;
      }
    }

    // 3. Safe (cash-box) balance — informational, best-effort.
    const safeBalance = await fetchSafeBalance(poster, spotId);

    // 4. Pure compute.
    const result = computeReconciliation(
      {
        cash: input.submittedCash,
        card: input.submittedCard,
        expense: input.submittedExpense,
      },
      posterFigures,
      safeBalance,
      input.tolerance ?? DEFAULT_RECON_TOLERANCE_SOM,
    );

    // 5 + 6. Persist + stamp source_ref + audit + (maybe) notify — atomically.
    const reconciliationId = await withTransaction(async (tx) =>
      persistReconciliation(tx, input, result, dayKey),
    );

    return { reconciliationId, result, shiftDate: dayKey };
  } catch (err) {
    // Absolute non-fatal backstop — the submission must never break.
    console.error('[cash-shift-recon] reconciliation failed (non-fatal):', (err as Error).message);
    return null;
  }
}

/** Resolve a location's Poster spot id (NULL when none / not a store). */
async function loadSpotId(locationId: number): Promise<number | null> {
  // Imported lazily to keep the pure compute path free of the DB module.
  const { query } = await import('../db/index.js');
  const { rows } = await query<{ poster_spot_id: string | null }>(
    `SELECT poster_spot_id FROM locations WHERE id = $1`,
    [locationId],
  );
  const raw = rows[0]?.poster_spot_id;
  return raw === null || raw === undefined ? null : Number(raw);
}

/**
 * Insert the reconciliation row, set `nakladnoy.source_ref` to the Poster
 * cash_shift_id when known, write an audit row, and notify PM + the location
 * manager on a discrepancy. All in the caller's transaction.
 */
async function persistReconciliation(
  tx: TxClient,
  input: ReconcileCashShiftInput,
  result: ReconciliationResult,
  dayKey: string,
): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO cash_shift_reconciliation
       (nakladnoy_id, location_id, shift_date, poster_cash_shift_id,
        submitted_cash, submitted_card, submitted_expense,
        poster_cash, poster_card, poster_expense, poster_safe_balance,
        cash_diff, card_diff, expense_diff, status)
     VALUES ($1, $2, $3::date, $4,
             $5, $6, $7,
             $8, $9, $10, $11,
             $12, $13, $14, $15)
     RETURNING id`,
    [
      input.nakladnoyId,
      input.locationId,
      dayKey,
      result.posterCashShiftId,
      result.submittedCash,
      result.submittedCard,
      result.submittedExpense,
      result.posterCash,
      result.posterCard,
      result.posterExpense,
      result.posterSafeBalance,
      result.cashDiff,
      result.cardDiff,
      result.expenseDiff,
      result.status,
    ],
  );
  const idRaw = rows[0]?.id;
  if (idRaw === undefined) {
    throw new Error('cash_shift_reconciliation insert returned no row.');
  }
  const reconciliationId = Number(idRaw);

  // Stamp the originating Poster shift onto the nakladnoy when we resolved one
  // (source_ref was 'loc:<id>' from creation; enrich it with the shift id).
  if (result.posterCashShiftId !== null) {
    await tx.query(
      `UPDATE nakladnoy SET source_ref = $2 WHERE id = $1`,
      [input.nakladnoyId, `cash_shift:${result.posterCashShiftId}`],
    );
  }

  // Lazy import to avoid pulling the audit module into the pure compute path.
  const { writeAudit } = await import('../lib/audit.js');
  await writeAudit(tx, {
    actorUserId: null,
    action: 'cash_shift.reconciled',
    entity: 'cash_shift_reconciliation',
    entityId: reconciliationId,
    payload: {
      nakladnoy_id: input.nakladnoyId,
      location_id: input.locationId,
      shift_date: dayKey,
      status: result.status,
      poster_cash_shift_id: result.posterCashShiftId,
      cash_diff: result.cashDiff,
      card_diff: result.cardDiff,
      expense_diff: result.expenseDiff,
    },
  });

  if (result.status === 'discrepancy') {
    await notifyDiscrepancy(tx, input, result, dayKey);
  }

  return reconciliationId;
}

/** Notify PM + the location manager that Poster disagrees with the cashier. */
async function notifyDiscrepancy(
  tx: TxClient,
  input: ReconcileCashShiftInput,
  result: ReconciliationResult,
  dayKey: string,
): Promise<void> {
  const body =
    `Kassir solishtiruvi — Poster bilan tafovut (${dayKey}).\n` +
    `Naqd farq: ${fmt(result.cashDiff)} so'm\n` +
    `Karta farq: ${fmt(result.cardDiff)} so'm\n` +
    `Rasxod farq: ${fmt(result.expenseDiff)} so'm`;
  const recipients = new Set<number>();
  for (const pm of await getPmRecipients(tx)) recipients.add(pm);
  const manager = await getLocationManager(tx, input.locationId);
  if (manager !== null) recipients.add(manager);
  for (const userId of recipients) {
    await createNotification(tx, {
      recipientUserId: userId,
      type: 'cash_shift_submitted',
      title: 'Kassa solishtiruvi: tafovut',
      body,
      payload: {
        nakladnoy_id: input.nakladnoyId,
        location_id: input.locationId,
        status: result.status,
        cash_diff: result.cashDiff,
        card_diff: result.cardDiff,
        expense_diff: result.expenseDiff,
      },
    });
  }
}

function fmt(n: number | null): string {
  if (n === null) return '—';
  return new Intl.NumberFormat('ru-RU').format(Math.round(n));
}
