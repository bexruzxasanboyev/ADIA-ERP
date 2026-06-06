/**
 * Reports service — structured report data for the Telegram "📊 Hisobotlar"
 * menu (and reusable from anywhere). Each function returns a plain `Report`
 * value object: a title, a date subtitle, and one-or-more tabular `sections`
 * with totals. The Telegram layer renders this as a formatted summary; the
 * `reportExport` service turns the SAME value into .xlsx / .docx / .pdf.
 *
 * RBAC (invariant 4/5): a `store_manager` is scoped to THEIR store only; a
 * `pm` sees every store. The scope is passed in as a `ReportScope` so the
 * caller (Telegram dispatch) maps the principal once and these functions stay
 * pure data-shapers over SQL.
 *
 * Data sources (reuse, do not duplicate):
 *   - Sales / trend / store breakdown — the `sales` table (Poster-synced),
 *     revenue = Σ(qty·price), receipts = distinct poster_transaction_id.
 *   - Payment-type split — Poster `dash.getPaymentsReport` via the existing
 *     `paymentReportToBuckets` aggregator (the only source of method data).
 *   - Below-min — `scanBelowMin()` + the `stock` table, joined to names.
 *
 * Product + store NAMES are always used in output, never raw ids.
 */
import { query } from '../db/index.js';
import { parseDateRange, toPosterDate } from '../lib/dateRange.js';
import type { PaymentMethodKey } from '../integrations/poster/paymentMethods.js';
import { paymentReportToBuckets } from '../integrations/poster/posterMoney.js';

// ---------------------------------------------------------------------------
// Period + scope
// ---------------------------------------------------------------------------

/** The three Telegram period choices. */
export const REPORT_PERIODS = ['bugun', 'hafta', 'oy'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

/** The four report types (callback verbs). */
export const REPORT_TYPES = ['sales', 'payment', 'trend', 'belowmin'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** Uzbek label for each period (UI text). */
export const PERIOD_LABEL: Readonly<Record<ReportPeriod, string>> = {
  bugun: 'Bugungi',
  hafta: 'Haftalik',
  oy: 'Oylik',
};

/** Uzbek label for each report type (UI text). */
export const REPORT_TYPE_LABEL: Readonly<Record<ReportType, string>> = {
  sales: 'Sotuvlar',
  payment: "To'lov turi bo'yicha",
  trend: 'Trend mahsulotlar',
  belowmin: "Min'dan past mahsulotlar",
};

export function isReportPeriod(v: string): v is ReportPeriod {
  return (REPORT_PERIODS as readonly string[]).includes(v);
}
export function isReportType(v: string): v is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(v);
}

/**
 * Who is asking. A `store_manager` is pinned to a single store; `pm` (and the
 * dept managers, who only ever see read-only summaries) get the whole chain.
 */
export type ReportScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'store'; readonly storeId: number };

/** Map a Telegram period to the shared dateRange preset window. */
function periodRange(period: ReportPeriod): { from: Date; to: Date } {
  const preset = period === 'bugun' ? 'today' : period === 'hafta' ? 'week' : 'month';
  const r = parseDateRange({ range: preset });
  return { from: r.from, to: r.to };
}

// ---------------------------------------------------------------------------
// The value object the renderer + every exporter consume
// ---------------------------------------------------------------------------

/** A single table inside a report (header row + data rows + optional total). */
export type ReportSection = {
  readonly heading: string;
  /** Column headers (Uzbek labels). */
  readonly columns: readonly string[];
  /** Data rows — cells already formatted as display strings. */
  readonly rows: readonly (readonly string[])[];
  /** Optional total row appended after the data (e.g. ["Jami", "…"]). */
  readonly total?: readonly string[];
};

/** A fully-shaped report — pure data, no formatting library involved. */
export type Report = {
  readonly type: ReportType;
  /** Title, e.g. "Sotuvlar hisoboti". */
  readonly title: string;
  /** Date / scope subtitle, e.g. "Davr: 2026-06-01 — 2026-06-06". */
  readonly subtitle: string;
  /** Period (null for below-min, which is a point-in-time snapshot). */
  readonly period: ReportPeriod | null;
  readonly sections: readonly ReportSection[];
  /** Slug used in the download filename, e.g. "sales_hafta". */
  readonly slug: string;
};

// ---------------------------------------------------------------------------
// Formatting helpers (Uzbek number/money/date)
// ---------------------------------------------------------------------------

/** Money in so'm with thousands separators, e.g. 1234567 -> "1 234 567 so'm". */
function som(n: number): string {
  return `${formatInt(Math.round(n))} so'm`;
}
/** Integer with non-breaking-ish space groups (plain space — clean in all 3 exports). */
function formatInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
/** A quantity — up to 3 dp, trailing zeros trimmed. */
function qtyStr(n: number): string {
  return Number(n.toFixed(3)).toString();
}
/** Date as YYYY-MM-DD (UTC) — matches the half-open window arithmetic. */
function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** A date subtitle for a period window: "Davr: from — to(inclusive)". */
function periodSubtitle(from: Date, to: Date): string {
  // `to` is exclusive (now); show the inclusive last day for humans.
  const lastDay = new Date(to.getTime() - 1);
  const fromS = dateStr(from);
  const toS = dateStr(lastDay);
  return fromS === toS ? `Sana: ${fromS}` : `Davr: ${fromS} — ${toS}`;
}

// ---------------------------------------------------------------------------
// 1. Sales report — revenue, receipts, per-store breakdown
// ---------------------------------------------------------------------------

export async function getSalesReport(
  period: ReportPeriod,
  scope: ReportScope,
): Promise<Report> {
  const { from, to } = periodRange(period);
  const storeFilter = scope.kind === 'store' ? scope.storeId : null;

  // Per-store revenue + receipt count from the canonical `sales` table.
  const { rows } = await query<{
    store_name: string;
    revenue: string;
    receipts: string;
  }>(
    `SELECT l.name AS store_name,
            COALESCE(SUM(s.qty * s.price), 0) AS revenue,
            COUNT(DISTINCT s.poster_transaction_id) AS receipts
       FROM sales s
       JOIN locations l ON l.id = s.store_id
      WHERE s.sold_at >= $1 AND s.sold_at < $2
        AND ($3::bigint IS NULL OR s.store_id = $3)
      GROUP BY l.name
      ORDER BY revenue DESC`,
    [from, to, storeFilter],
  );

  let totalRevenue = 0;
  let totalReceipts = 0;
  const dataRows = rows.map((r) => {
    const rev = Number(r.revenue);
    const rec = Number(r.receipts);
    totalRevenue += rev;
    totalReceipts += rec;
    return [r.store_name, som(rev), formatInt(rec)] as const;
  });

  const sections: ReportSection[] = [
    {
      heading: 'Umumiy ko’rsatkichlar',
      columns: ["Ko'rsatkich", 'Qiymat'],
      rows: [
        ['Umumiy tushum', som(totalRevenue)],
        ['Cheklar soni', formatInt(totalReceipts)],
        [
          "O'rtacha chek",
          som(totalReceipts > 0 ? totalRevenue / totalReceipts : 0),
        ],
      ],
    },
    {
      heading: "Do'konlar kesimida",
      columns: ["Do'kon", 'Tushum', 'Cheklar'],
      rows: dataRows,
      total: ['Jami', som(totalRevenue), formatInt(totalReceipts)],
    },
  ];

  return {
    type: 'sales',
    title: `Sotuvlar hisoboti — ${PERIOD_LABEL[period]}`,
    subtitle: periodSubtitle(from, to),
    period,
    sections,
    slug: `sales_${period}`,
  };
}

// ---------------------------------------------------------------------------
// 2. Payment-type report — sales split by payment method (Poster source)
// ---------------------------------------------------------------------------

const PAYMENT_LABEL: Readonly<Record<PaymentMethodKey, string>> = {
  cash: 'Naqd',
  card: 'Karta',
  payme: 'Payme',
  click: 'Click',
  other: 'Boshqa',
};

export async function getPaymentTypeReport(
  period: ReportPeriod,
  scope: ReportScope,
): Promise<Report> {
  const { from, to } = periodRange(period);

  // Resolve the Poster spot for a store-scoped request (so the payment report
  // is filtered to that one store). `pm`/all scope queries every spot.
  let spotId: number | undefined;
  if (scope.kind === 'store') {
    const { rows } = await query<{ poster_spot_id: number | null }>(
      `SELECT poster_spot_id FROM locations WHERE id = $1`,
      [scope.storeId],
    );
    const sid = rows[0]?.poster_spot_id;
    spotId = sid === null || sid === undefined ? undefined : Number(sid);
  }

  // Poster is the only source of payment-method splits. Pull the aggregate
  // report for the window and bucket it. Lazy-import the client so unit tests
  // can inject a stub via setPosterClientForTests without a live token.
  const { createPosterClientFromConfig } = await import(
    '../integrations/poster/client.js'
  );
  const client = createPosterClientFromConfig();
  const dateFrom = toPosterDate(from);
  const dateTo = toPosterDate(new Date(to.getTime() - 1));
  const report = await client.getPaymentsReport(
    spotId === undefined ? { dateFrom, dateTo } : { dateFrom, dateTo, spotId },
  );
  const buckets = paymentReportToBuckets(report);

  const order: PaymentMethodKey[] = ['cash', 'card', 'payme', 'click', 'other'];
  const dataRows = order
    .filter((k) => buckets.byMethod[k] > 0 || buckets.total === 0)
    .map((k) => {
      const amount = buckets.byMethod[k];
      const pct = buckets.total > 0 ? (amount / buckets.total) * 100 : 0;
      return [PAYMENT_LABEL[k], som(amount), `${pct.toFixed(1)}%`] as const;
    });

  const sections: ReportSection[] = [
    {
      heading: "To'lov turlari",
      columns: ["To'lov turi", 'Summa', 'Ulush'],
      rows: dataRows,
      total: ['Jami', som(buckets.total), '100.0%'],
    },
  ];

  return {
    type: 'payment',
    title: `To'lov turi bo'yicha — ${PERIOD_LABEL[period]}`,
    subtitle: periodSubtitle(from, to),
    period,
    sections,
    slug: `payment_${period}`,
  };
}

// ---------------------------------------------------------------------------
// 3. Trend products — top sellers for the period (qty + revenue)
// ---------------------------------------------------------------------------

const TREND_LIMIT = 20;

export async function getTrendProducts(
  period: ReportPeriod,
  scope: ReportScope,
): Promise<Report> {
  const { from, to } = periodRange(period);
  const storeFilter = scope.kind === 'store' ? scope.storeId : null;

  const { rows } = await query<{
    product_name: string;
    unit: string;
    qty: string;
    revenue: string;
  }>(
    `SELECT p.name AS product_name, p.unit::text AS unit,
            COALESCE(SUM(s.qty), 0) AS qty,
            COALESCE(SUM(s.qty * s.price), 0) AS revenue
       FROM sales s
       JOIN products p ON p.id = s.product_id
      WHERE s.sold_at >= $1 AND s.sold_at < $2
        AND ($3::bigint IS NULL OR s.store_id = $3)
      GROUP BY p.name, p.unit
      ORDER BY revenue DESC, qty DESC
      LIMIT ${TREND_LIMIT}`,
    [from, to, storeFilter],
  );

  let totalRevenue = 0;
  let totalQty = 0;
  const dataRows = rows.map((r, i) => {
    const q = Number(r.qty);
    const rev = Number(r.revenue);
    totalQty += q;
    totalRevenue += rev;
    return [
      String(i + 1),
      r.product_name,
      `${qtyStr(q)} ${r.unit}`,
      som(rev),
    ] as const;
  });

  const sections: ReportSection[] = [
    {
      heading: `Eng ko'p sotilgan mahsulotlar (TOP ${TREND_LIMIT})`,
      columns: ['#', 'Mahsulot', 'Miqdor', 'Tushum'],
      rows: dataRows,
      total: ['', 'Jami', qtyStr(totalQty), som(totalRevenue)],
    },
  ];

  return {
    type: 'trend',
    title: `Trend mahsulotlar — ${PERIOD_LABEL[period]}`,
    subtitle: periodSubtitle(from, to),
    period,
    sections,
    slug: `trend_${period}`,
  };
}

// ---------------------------------------------------------------------------
// 4. Below-min — products currently below their min (point-in-time snapshot)
// ---------------------------------------------------------------------------

export async function getBelowMinReport(scope: ReportScope): Promise<Report> {
  const storeFilter = scope.kind === 'store' ? scope.storeId : null;

  // A store IS allowed to view its own below-min (the scan worker excludes
  // stores from AUTO-replenishment, but a manager may still inspect their
  // shortfalls). So this query is the raw stock<=min view, scoped by RBAC —
  // it intentionally does NOT reuse scanBelowMin()'s store-exclusion filter.
  const { rows } = await query<{
    product_name: string;
    unit: string;
    location_name: string;
    qty: string;
    min_level: string;
  }>(
    `SELECT p.name AS product_name, p.unit::text AS unit,
            l.name AS location_name, s.qty, s.min_level
       FROM stock s
       JOIN products p ON p.id = s.product_id
       JOIN locations l ON l.id = s.location_id
      WHERE s.qty <= s.min_level AND s.min_level > 0
        AND p.is_active = TRUE
        AND ($1::bigint IS NULL OR s.location_id = $1)
      ORDER BY l.name ASC, p.name ASC`,
    [storeFilter],
  );

  const dataRows = rows.map((r) => {
    const q = Number(r.qty);
    const min = Number(r.min_level);
    return [
      r.location_name,
      r.product_name,
      `${qtyStr(q)} ${r.unit}`,
      `${qtyStr(min)} ${r.unit}`,
      `-${qtyStr(Math.max(0, min - q))} ${r.unit}`,
    ] as const;
  });

  const now = new Date();
  const sections: ReportSection[] = [
    {
      heading: "Min'dan past mahsulotlar",
      columns: ["Bo'lim", 'Mahsulot', 'Qoldiq', 'Min', 'Yetishmovchilik'],
      rows: dataRows,
    },
  ];

  return {
    type: 'belowmin',
    title: "Min'dan past mahsulotlar",
    subtitle: `Sana: ${dateStr(now)} (${dataRows.length} ta pozitsiya)`,
    period: null,
    sections,
    slug: 'belowmin',
  };
}

// ---------------------------------------------------------------------------
// Dispatch helper — build any report by (type, period, scope)
// ---------------------------------------------------------------------------

export async function buildReport(
  type: ReportType,
  period: ReportPeriod,
  scope: ReportScope,
): Promise<Report> {
  switch (type) {
    case 'sales':
      return getSalesReport(period, scope);
    case 'payment':
      return getPaymentTypeReport(period, scope);
    case 'trend':
      return getTrendProducts(period, scope);
    case 'belowmin':
      return getBelowMinReport(scope);
  }
}
