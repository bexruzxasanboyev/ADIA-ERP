/**
 * EPIC 0.3 / P3 — Poster money-unit normalisation.
 *
 * THE UNIT TRAP (verified live against account `adia`, 2026-05-29):
 *
 *   dash.getAnalytics       revenue for 2026-05-29 = "19553300.0000"  (so'm)
 *   dash.getPaymentsReport  payed_sum_sum same day = 1955330000        (tiyin)
 *
 *   1955330000 / 19553300 = 100  (exactly)
 *
 * So Poster is INCONSISTENT across endpoints:
 *   - `dash.getAnalytics` / `dash.getTransactions` are already in so'm
 *     (the doc §8 "to'g'ri so'm" note describes THESE endpoints);
 *   - `dash.getPaymentsReport.total.payed_*_sum` is in TIYIN — it must be
 *     divided by 100 before it reconciles with the headline revenue.
 *
 * That mismatch is exactly why the revenue breakdown showed 0%/0 against an
 * 11M headline: the breakdown was synthesised from the LOCAL `sales` table
 * (demo mode) while the headline came from a different (corrupted) source,
 * and any attempt to read getPaymentsReport without the ÷100 over-stated the
 * total 100×. This module is the single place that converts and aggregates.
 */
import {
  classifyPosterPayment,
  emptyPaymentBuckets,
  buildMethodResolver,
  type PaymentMethodKey,
  type PaymentMethodLike,
} from './paymentMethods.js';
import type {
  PosterAnalytics,
  PosterPaymentReport,
  PosterTransactionSummary,
} from './client.js';

/** 1 so'm = 100 tiyin. getPaymentsReport sums are in tiyin (see file header). */
export const TIYIN_PER_SOM = 100;

/**
 * Convert a Poster `payed_*_sum` (tiyin, string or number) to so'm. Empty or
 * non-numeric input yields 0 (never NaN — a NaN bucket would silently break
 * the breakdown total).
 */
export function tiyinToSom(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return n / TIYIN_PER_SOM;
}

/** Legacy per-method row shape (older tests / hypothetical Poster variant). */
type LegacyPaymentRow = {
  payment_id?: string | number;
  payment_title?: string;
  payment_sum?: string | number;
};

export type PaymentBreakdown = {
  byMethod: Record<PaymentMethodKey, number>;
  /** Grand total in so'm — always equals the sum of `byMethod`. */
  total: number;
};

/**
 * Aggregate a `dash.getPaymentsReport` response into so'm buckets that always
 * reconcile (sum of buckets === total).
 *
 * Accepts BOTH shapes Poster has been seen to emit:
 *   1. the real `{days?, total}` aggregate (production) — read `total.payed_*`;
 *   2. a legacy `[{payment_id, payment_title, payment_sum}]` row array — classify
 *      each row by id/title.
 *
 * In the aggregate shape, getPaymentsReport does NOT split Payme/Click — it only
 * exposes cash / card / ewallet / cert / bonus. We route cash->cash, card->card,
 * and everything else (ewallet, third-party, bonus, cert) into `other` so the
 * total still reconciles. A finer Payme/Click split needs a per-transaction or
 * per-method endpoint and is handled elsewhere when required.
 */
export function paymentReportToBuckets(
  report: PosterPaymentReport | LegacyPaymentRow[] | null | undefined,
): PaymentBreakdown {
  const byMethod = emptyPaymentBuckets();

  if (report === null || report === undefined) {
    return { byMethod, total: 0 };
  }

  // ---- Legacy per-method row array ----
  if (Array.isArray(report)) {
    for (const row of report) {
      const key = classifyPosterPayment(
        row.payment_id === undefined ? undefined : Number(row.payment_id),
        row.payment_title,
      );
      byMethod[key] += tiyinToSom(row.payment_sum);
    }
    const total = sumBuckets(byMethod);
    return { byMethod, total };
  }

  // ---- Real `{days, total}` aggregate ----
  const t = report.total ?? {};
  byMethod.cash = tiyinToSom(t.payed_cash_sum);
  byMethod.card = tiyinToSom(t.payed_card_sum);
  // Payme/Click are not separated by this endpoint -> bundle the rest in
  // `other` so the breakdown reconciles. (Cert in/out net to ~0; bonus and
  // ewallet/third-party land here.)
  byMethod.other =
    tiyinToSom(t.payed_ewallet_sum) +
    tiyinToSom(t.payed_third_party_sum) +
    tiyinToSom(t.payed_bonus_sum) +
    tiyinToSom(t.payed_cert_in_sum);

  // Prefer Poster's own grand total when present; else sum the components we
  // mapped. Either way, normalise `other` so buckets always equal `total`.
  const reportedTotal = tiyinToSom(t.payed_sum_sum);
  const mapped = sumBuckets(byMethod);
  let total: number;
  if (reportedTotal > 0) {
    total = reportedTotal;
    // Reconcile rounding / any sum not captured above into `other`.
    const drift = round2(reportedTotal - mapped);
    if (Math.abs(drift) > 0.005) {
      byMethod.other = round2(byMethod.other + drift);
    }
  } else {
    total = mapped;
  }

  // Round every bucket to 2 dp for clean money output.
  byMethod.cash = round2(byMethod.cash);
  byMethod.card = round2(byMethod.card);
  byMethod.payme = round2(byMethod.payme);
  byMethod.click = round2(byMethod.click);
  byMethod.other = round2(byMethod.other);
  return { byMethod, total: round2(total) };
}

function sumBuckets(b: Record<PaymentMethodKey, number>): number {
  return b.cash + b.card + b.payme + b.click + b.other;
}

/**
 * Revenue-breakdown — group CLOSED `dash.getTransactions` rows into so'm buckets
 * that separate Payme/Click (which `dash.getPaymentsReport` cannot — it folds
 * them into `payed_card_sum`; verified live against `adia` 2026-06-06).
 *
 * APPROACH (documented per the task brief): we iterate per-transaction because
 * only the transaction carries `payment_method_id`. For each CLOSED txn
 * (`pay_type != 0`) we decide ONE method via `buildMethodResolver`:
 *   - id 0 (no custom method) -> split the txn by its own `payed_cash` -> cash
 *     and `payed_card` -> card, folding `payed_third_party` + `payed_ewallet` +
 *     `payed_bonus` -> the unnamed `other` bucket;
 *   - a `core` resolution (built-in 1=cash / 2=card, or a Payme/Click custom
 *     method matched by title) -> the WHOLE txn amount to that core bucket;
 *   - a `named` resolution (EVERY OTHER custom method, id >= 3) -> the whole txn
 *     amount to its OWN bucket keyed `pm_<id>`, labelled with the verbatim
 *     Poster title. This is the money-fix: a card-titled custom method like
 *     "Карта|Абдулқодир ака" no longer disappears into `card`.
 *
 * The transaction amount used for a resolved method is `payed_sum` when present,
 * else `payed_cash + payed_card + payed_third_party + payed_ewallet`. All Poster
 * money here is TIYIN -> converted to so'm via `tiyinToSom`.
 *
 * OUTPUT: `byMethod` keeps the legacy 5 core keys (cash/card/payme/click/other)
 * for backward compatibility — `card` now EXCLUDES named custom methods. The
 * `methods` list is the ordered display contract: the 4 core methods always
 * appear (even at 0), then each named custom method present with amount > 0
 * sorted by amount desc, then an unnamed `other` row only when its residual > 0.
 * `sum(methods[].amount) === total` (reconciliation).
 *
 * Reconciliation: the returned `total` is the sum of all buckets. The caller may
 * cross-check it against `dash.getPaymentsReport` / `dash.getAnalytics`; see
 * `reconcileWarning`, which is set (non-null) when the per-method buckets drift
 * from a supplied expected total beyond a 1-so'm tolerance.
 */

/** One row of the ordered `methods` display list. */
export type MethodRow = {
  /** Stable bucket key — a core key or `pm_<id>` for a named custom method. */
  key: string;
  /** UI label — a fixed core label or the verbatim Poster title. */
  label: string;
  /** Amount in so'm. */
  amount: number;
};

export type TransactionBreakdown = PaymentBreakdown & {
  /** Number of closed transactions folded into the buckets. */
  closedCount: number;
  /** Ordered display list: core 4 (always) + named customs + residual other. */
  methods: MethodRow[];
  /** Non-null when buckets drift from `expectedTotal` (still returns buckets). */
  reconcileWarning: string | null;
};

/** Fixed labels for the four core methods (always shown). */
const CORE_LABELS: Readonly<Record<'cash' | 'card' | 'payme' | 'click', string>> = {
  cash: 'Naqd',
  card: 'Karta',
  payme: 'Payme',
  click: 'Click',
};

export function transactionsToBuckets(
  transactions: ReadonlyArray<PosterTransactionSummary>,
  methods: ReadonlyArray<PaymentMethodLike>,
  expectedTotal?: number,
): TransactionBreakdown {
  const byMethod = emptyPaymentBuckets();
  const resolve = buildMethodResolver(methods);
  // Named custom-method buckets, keyed `pm_<id>` -> {label, amount}.
  const named = new Map<string, { label: string; amount: number }>();
  let closedCount = 0;

  for (const txn of transactions) {
    const payType = toInt(txn.pay_type);
    if (payType === 0) continue; // open / unpaid — not yet revenue
    closedCount += 1;

    const methodId = toInt(txn.payment_method_id);
    const resolved = resolve(methodId);

    if (resolved === null) {
      // No custom method (id 0) — split by the txn's own cash/card fields.
      byMethod.cash += tiyinToSom(txn.payed_cash);
      byMethod.card += tiyinToSom(txn.payed_card);
      byMethod.other +=
        tiyinToSom(txn.payed_third_party) +
        tiyinToSom(txn.payed_ewallet) +
        tiyinToSom(txn.payed_bonus);
      continue;
    }

    const amount = transactionAmountSom(txn);
    if (resolved.kind === 'core') {
      byMethod[resolved.key] += amount;
    } else {
      const prev = named.get(resolved.key);
      named.set(resolved.key, {
        label: resolved.label,
        amount: (prev?.amount ?? 0) + amount,
      });
    }
  }

  byMethod.cash = round2(byMethod.cash);
  byMethod.card = round2(byMethod.card);
  byMethod.payme = round2(byMethod.payme);
  byMethod.click = round2(byMethod.click);
  byMethod.other = round2(byMethod.other);
  for (const [k, v] of named) named.set(k, { ...v, amount: round2(v.amount) });

  // Total = core 5 buckets + every named custom bucket.
  let namedSum = 0;
  for (const v of named.values()) namedSum += v.amount;
  const total = round2(sumBuckets(byMethod) + namedSum);

  // Ordered display list: core 4 always, then named customs (amount desc),
  // then the unnamed `other` residual only when > 0.
  const methodRows: MethodRow[] = [
    { key: 'cash', label: CORE_LABELS.cash, amount: byMethod.cash },
    { key: 'card', label: CORE_LABELS.card, amount: byMethod.card },
    { key: 'payme', label: CORE_LABELS.payme, amount: byMethod.payme },
    { key: 'click', label: CORE_LABELS.click, amount: byMethod.click },
  ];
  const namedRows: MethodRow[] = [...named.entries()]
    .map(([key, v]) => ({ key, label: v.label, amount: v.amount }))
    .filter((r) => r.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
  methodRows.push(...namedRows);
  if (byMethod.other > 0) {
    methodRows.push({ key: 'other', label: 'Boshqa', amount: byMethod.other });
  }

  let reconcileWarning: string | null = null;
  if (expectedTotal !== undefined && Number.isFinite(expectedTotal)) {
    const drift = round2(total - expectedTotal);
    if (Math.abs(drift) > 1) {
      reconcileWarning = `revenue-breakdown reconcile drift: buckets=${total} expected=${round2(expectedTotal)} drift=${drift}`;
    }
  }

  return { byMethod, total, closedCount, methods: methodRows, reconcileWarning };
}

/** Total so'm for one transaction: `payed_sum` if present, else the parts. */
function transactionAmountSom(txn: PosterTransactionSummary): number {
  if (txn.payed_sum !== undefined && txn.payed_sum !== null && `${txn.payed_sum}` !== '') {
    return tiyinToSom(txn.payed_sum);
  }
  return (
    tiyinToSom(txn.payed_cash) +
    tiyinToSom(txn.payed_card) +
    tiyinToSom(txn.payed_third_party) +
    tiyinToSom(txn.payed_ewallet)
  );
}

/** Parse a Poster string/number to an int, or `undefined` when not finite. */
function toInt(v: string | number | undefined | null): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

export type DailyRevenue = { date: string; revenue: number };

/**
 * EPIC 0.2 — turn a `dash.getAnalytics?interpolate=day` response into a dated
 * daily revenue series in so'm. The `data` array is aligned day-by-day from
 * `dateFrom` (inclusive). Analytics values are ALREADY in so'm (see
 * `PosterAnalytics`) — no ÷100 here.
 *
 * @param analytics the raw getAnalytics response.
 * @param dateFrom  the `YYYY-MM-DD` of the FIRST `data` entry.
 * @returns one `{date, revenue}` per `data` entry, dates incrementing by a day.
 */
export function analyticsToDailySom(
  analytics: PosterAnalytics | null | undefined,
  dateFrom: string,
): DailyRevenue[] {
  const data = analytics?.data;
  if (!Array.isArray(data) || data.length === 0) return [];
  const start = parseIsoDate(dateFrom);
  if (start === null) return [];
  return data.map((v, i) => {
    const d = new Date(start.getTime() + i * 86_400_000);
    const n = typeof v === 'number' ? v : Number(v);
    return { date: toIsoDate(d), revenue: Number.isFinite(n) ? round2(n) : 0 };
  });
}

function parseIsoDate(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
