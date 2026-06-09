/**
 * Store KPI — Do'kon KPI (TZ Module 8, store-level).
 *
 * The owner sets a MONTHLY SALES PLAN per store; this router serves the
 * plan-vs-actual achievement %, month-over-month growth, and the store
 * leaderboard:
 *
 *   GET /api/store-kpi?month=YYYY-MM           — the leaderboard for a month.
 *   PUT /api/store-kpi/plan                    — upsert one store's plan (pm).
 *   GET /api/store-kpi/:locationId/trend       — a store's monthly actual series.
 *
 * ACTUAL revenue reconciles EXACTLY with the dashboard's per-store sales sum
 * (`routes/dashboardDetail.ts` -> `fetchStoresBreakdown`): `SUM(qty * price)`
 * over `sales` rows whose `store_id` is the store and whose `sold_at` falls in
 * the month's half-open window `[start, nextStart)`. `sales.price` is a TRUE
 * per-unit price (post 2026-06-08 ingest fix), so `qty * price` is the line
 * total — the same formula every revenue query in the codebase uses.
 *
 * RBAC (mirrors the Stores detail page):
 *   - `pm` / `ai_assistant`  — chain-wide (every active store).
 *   - `store_manager`        — own store(s) only (M:N `locationIds`); a scoped
 *                              manager with no assigned store gets an empty
 *                              leaderboard.
 *   - PUT /plan              — `pm` ONLY (a sales plan is a planning input, the
 *                              same PM-scoped concern as `products.kpi_target`).
 *   - every other role       — 403 (the `authorize` gate).
 *
 * All SQL is parameterized. The month label is validated against `YYYY-MM`
 * before it ever touches a query.
 */
import { Router } from 'express';
import { query, withTransaction, type SqlParam } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin, assertLocationAccess } from '../lib/principal.js';
import { writeAudit } from '../lib/audit.js';
import type { AuthPrincipal } from '../auth/jwt.js';

export const storeKpiRouter: Router = Router();

// ---------------------------------------------------------------------------
// Month + scope helpers
// ---------------------------------------------------------------------------

/**
 * A resolved month: the `YYYY-MM` label, the first day of the month (`start`),
 * the first day of the next month (`nextStart`, exclusive upper bound) and the
 * first day of the PREVIOUS month (`prevStart`) for the month-over-month
 * comparison. Date filters use `>= start AND < nextStart` (half-open, no
 * month-end off-by-one).
 */
type MonthWindow = {
  readonly label: string; // 'YYYY-MM'
  readonly prevLabel: string; // previous month 'YYYY-MM'
  readonly prevStart: string; // first day of the previous month
  readonly start: string; // 'YYYY-MM-01'
  readonly nextStart: string; // first day of the following month
};

/** Build a `YYYY-MM-01` first-of-month string from a (year, 1-12 month). */
function firstOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

/**
 * Parse a `?month=YYYY-MM` value into a window. Defaults to the CURRENT month
 * when absent/empty. Rejects anything that is not a real `YYYY-MM`.
 */
function resolveMonth(raw: unknown): MonthWindow {
  let year: number;
  let month: number; // 1-12
  if (raw === undefined || raw === '') {
    const now = new Date();
    year = now.getUTCFullYear();
    month = now.getUTCMonth() + 1;
  } else {
    if (typeof raw !== 'string') {
      throw AppError.validation('Query "month" must be a string "YYYY-MM".');
    }
    const m = /^(\d{4})-(\d{2})$/.exec(raw.trim());
    if (m === null) {
      throw AppError.validation('Query "month" must be in the form "YYYY-MM".');
    }
    year = Number(m[1]);
    month = Number(m[2]);
    if (month < 1 || month > 12) {
      throw AppError.validation('Query "month" must have a month between 01 and 12.');
    }
  }
  const label = `${year}-${String(month).padStart(2, '0')}`;
  const start = firstOfMonth(year, month);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextStart = firstOfMonth(nextYear, nextMonth);
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevLabel = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
  const prevStart = firstOfMonth(prevYear, prevMonth);
  return { label, prevLabel, prevStart, start, nextStart };
}

/** Round a money value to 2 dp (matches kpi.ts / the money columns). */
function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Round a percentage to 2 dp. */
function roundPct(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Store scope — chain-wide (PM / ai_assistant) OR scoped to the principal's
 * assigned store ids. `empty` is the scoped-with-no-stores branch (mirrors the
 * Stores detail page) and yields an empty leaderboard.
 */
type StoreScope =
  | { kind: 'chain' }
  | { kind: 'locations'; locationIds: number[] }
  | { kind: 'empty' };

function resolveStoreScope(principal: AuthPrincipal): StoreScope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain' };
  }
  if (principal.locationIds.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'locations', locationIds: principal.locationIds };
}

/**
 * Build the `(SELECT id FROM locations WHERE type='store' AND is_active ...)`
 * id-set fragment, narrowed to the scope, growing `params` in place. A scoped
 * principal's `locationIds` are ANDed on top so the set can only NARROW to the
 * RBAC scope — never widen past it. ids are always parameterized.
 */
function storeIdSet(
  scope: Exclude<StoreScope, { kind: 'empty' }>,
  params: SqlParam[],
): string {
  const clauses = [`type = 'store'`, `is_active = TRUE`];
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    clauses.push(`id = ANY($${params.length}::bigint[])`);
  }
  return `(SELECT id FROM locations WHERE ${clauses.join(' AND ')})`;
}

// ---------------------------------------------------------------------------
// GET /api/store-kpi?month=YYYY-MM — the leaderboard.
// ---------------------------------------------------------------------------

type StoreKpiItem = {
  location_id: number;
  location_name: string;
  target_sum: number | null;
  actual_sum: number;
  achievement_pct: number | null;
  prev_month_actual: number;
  growth_pct_mom: number | null;
  rank: number;
};

type StoreKpiResponse = {
  month: string;
  items: StoreKpiItem[];
  summary: {
    total_target: number;
    total_actual: number;
    achievement_pct: number | null;
  };
};

/** Raw per-store aggregate row from the leaderboard query. */
type StoreKpiRow = {
  location_id: string;
  location_name: string;
  target_sum: string | null;
  actual_sum: string | null;
  prev_month_actual: string | null;
};

storeKpiRouter.get(
  '/',
  authenticate,
  authorize('pm', 'ai_assistant', 'store_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const win = resolveMonth(req.query['month']);
    const scope = resolveStoreScope(principal);

    if (scope.kind === 'empty') {
      const empty: StoreKpiResponse = {
        month: win.label,
        items: [],
        summary: { total_target: 0, total_actual: 0, achievement_pct: null },
      };
      res.status(200).json(empty);
      return;
    }

    // One row per visible store: its plan for the month (LEFT JOIN — NULL when
    // unset), its actual revenue this month, and its actual revenue last month.
    // The two sales aggregates are LATERAL sub-queries on `ix_sales_store_date`
    // (store_id, sold_at), so each store's window scan is index-backed.
    const params: SqlParam[] = [];
    const stores = storeIdSet(scope, params);
    params.push(win.label); // $month
    const monthIdx = params.length;
    params.push(win.start); // $start
    const startIdx = params.length;
    params.push(win.nextStart); // $nextStart
    const nextStartIdx = params.length;
    params.push(win.prevStart); // $prevStart
    const prevStartIdx = params.length;

    const { rows } = await query<StoreKpiRow>(
      `SELECT l.id   AS location_id,
              l.name AS location_name,
              plan.target_sum                  AS target_sum,
              coalesce(cur.actual_sum, 0)      AS actual_sum,
              coalesce(prev.actual_sum, 0)     AS prev_month_actual
         FROM locations l
         LEFT JOIN store_sales_plan plan
                ON plan.location_id = l.id
               AND plan.month = $${monthIdx}
         LEFT JOIN LATERAL (
                SELECT sum(s.qty * s.price) AS actual_sum
                  FROM sales s
                 WHERE s.store_id = l.id
                   AND s.sold_at >= $${startIdx}
                   AND s.sold_at <  $${nextStartIdx}
              ) cur ON TRUE
         LEFT JOIN LATERAL (
                SELECT sum(s.qty * s.price) AS actual_sum
                  FROM sales s
                 WHERE s.store_id = l.id
                   AND s.sold_at >= $${prevStartIdx}
                   AND s.sold_at <  $${startIdx}
              ) prev ON TRUE
        WHERE l.id IN ${stores}
        ORDER BY coalesce(cur.actual_sum, 0) DESC, l.id`,
      params,
    );

    let totalTarget = 0;
    let totalActual = 0;
    const items: StoreKpiItem[] = rows.map((r, idx) => {
      const targetSum = r.target_sum === null ? null : Number(r.target_sum);
      const actualSum = roundMoney(Number(r.actual_sum ?? 0));
      const prevActual = roundMoney(Number(r.prev_month_actual ?? 0));

      // achievement_pct — null when no target set; otherwise actual / target.
      // A zero target is a real (if odd) goal: any positive actual is "over
      // 100%", a zero actual is 0% — guard the divide-by-zero explicitly.
      let achievementPct: number | null = null;
      if (targetSum !== null) {
        achievementPct =
          targetSum === 0 ? (actualSum > 0 ? 100 : 0) : roundPct((actualSum / targetSum) * 100);
      }

      // growth_pct_mom — null when there is no previous-month baseline (prev=0),
      // since percentage growth from zero is undefined.
      const growthPctMom =
        prevActual === 0 ? null : roundPct(((actualSum - prevActual) / prevActual) * 100);

      if (targetSum !== null) totalTarget += targetSum;
      totalActual += actualSum;

      return {
        location_id: Number(r.location_id),
        location_name: r.location_name,
        target_sum: targetSum,
        actual_sum: actualSum,
        achievement_pct: achievementPct,
        prev_month_actual: prevActual,
        growth_pct_mom: growthPctMom,
        rank: idx + 1, // rows are ordered by actual_sum DESC, so index+1 is the rank.
      };
    });

    const summary = {
      total_target: roundMoney(totalTarget),
      total_actual: roundMoney(totalActual),
      achievement_pct:
        totalTarget === 0 ? null : roundPct((totalActual / totalTarget) * 100),
    };

    const response: StoreKpiResponse = { month: win.label, items, summary };
    res.status(200).json(response);
  }),
);

// ---------------------------------------------------------------------------
// PUT /api/store-kpi/plan — upsert one store's monthly plan (pm only).
// ---------------------------------------------------------------------------

type PlanRow = {
  id: string;
  location_id: string;
  month: string;
  target_sum: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Validate the PUT /plan body into a typed, sanitised input. */
function parsePlanBody(body: unknown): {
  locationId: number;
  month: string;
  targetSum: number;
} {
  if (typeof body !== 'object' || body === null) {
    throw AppError.validation('Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  const locationId = Number(b['location_id']);
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw AppError.validation('"location_id" must be a positive integer.');
  }

  const monthRaw = b['month'];
  if (typeof monthRaw !== 'string') {
    throw AppError.validation('"month" must be a string "YYYY-MM".');
  }
  const m = /^(\d{4})-(\d{2})$/.exec(monthRaw.trim());
  if (m === null) {
    throw AppError.validation('"month" must be in the form "YYYY-MM".');
  }
  const monthNum = Number(m[2]);
  if (monthNum < 1 || monthNum > 12) {
    throw AppError.validation('"month" must have a month between 01 and 12.');
  }
  const month = monthRaw.trim();

  const targetSum = Number(b['target_sum']);
  if (!Number.isFinite(targetSum) || targetSum < 0) {
    throw AppError.validation('"target_sum" must be a number >= 0.');
  }

  return { locationId, month, targetSum };
}

storeKpiRouter.put(
  '/plan',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const { locationId, month, targetSum } = parsePlanBody(req.body);

    // The target location must exist and be a store — reject a plan for a
    // warehouse / sex / non-existent location (the FK alone would not enforce
    // type='store').
    const loc = await query<{ type: string }>(
      `SELECT type::text AS type FROM locations WHERE id = $1`,
      [locationId],
    );
    const locType = loc.rows[0]?.type;
    if (locType === undefined) {
      throw AppError.notFound('Location not found.');
    }
    if (locType !== 'store') {
      throw AppError.validation('A sales plan can only be set for a store location.');
    }

    const row = await withTransaction(async (tx) => {
      const upserted = await tx.query<PlanRow>(
        `INSERT INTO store_sales_plan (location_id, month, target_sum, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (location_id, month)
         DO UPDATE SET target_sum = EXCLUDED.target_sum, updated_at = now()
         RETURNING id, location_id, month, target_sum, created_by,
                   created_at, updated_at`,
        [locationId, month, targetSum, principal.userId],
      );
      const r = upserted.rows[0];
      if (r === undefined) {
        throw AppError.validation('Failed to upsert the store sales plan.');
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'store_sales_plan.upsert',
        entity: 'store_sales_plan',
        entityId: Number(r.id),
        payload: { location_id: locationId, month, target_sum: targetSum },
        activeLocationId: principal.activeLocationId,
      });
      return r;
    });

    res.status(200).json({
      id: Number(row.id),
      location_id: Number(row.location_id),
      month: row.month.trim(), // CHAR(7) — trim any storage padding.
      target_sum: Number(row.target_sum),
      created_by: row.created_by === null ? null : Number(row.created_by),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/store-kpi/:locationId/trend?months=6 — monthly actual series.
// ---------------------------------------------------------------------------

const TREND_DEFAULT_MONTHS = 6;
const TREND_MAX_MONTHS = 24;

/** Parse `?months=` into 1..TREND_MAX_MONTHS; default TREND_DEFAULT_MONTHS. */
function parseMonthsParam(raw: unknown): number {
  if (raw === undefined || raw === '') return TREND_DEFAULT_MONTHS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw AppError.validation('Query "months" must be a positive integer.');
  }
  return Math.min(n, TREND_MAX_MONTHS);
}

/** Build the trailing `count` month labels ending with the current month. */
function trailingMonthLabels(count: number): Array<{ label: string; start: string; nextStart: string }> {
  const now = new Date();
  const out: Array<{ label: string; start: string; nextStart: string }> = [];
  // Walk oldest -> newest so the series is chronologically ordered.
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const label = `${year}-${String(month).padStart(2, '0')}`;
    const start = firstOfMonth(year, month);
    const next = new Date(Date.UTC(year, month, 1));
    const nextStart = firstOfMonth(next.getUTCFullYear(), next.getUTCMonth() + 1);
    out.push({ label, start, nextStart });
  }
  return out;
}

storeKpiRouter.get(
  '/:locationId/trend',
  authenticate,
  authorize('pm', 'ai_assistant', 'store_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const locationId = Number(req.params['locationId']);
    if (!Number.isInteger(locationId) || locationId <= 0) {
      throw AppError.validation('locationId must be a positive integer.');
    }
    const months = parseMonthsParam(req.query['months']);

    // RBAC — a scoped principal may only read its own store(s). PM /
    // ai_assistant pass for any store. (ai_assistant is chain-wide read, so it
    // is exempt from the location check like the super-admin.)
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      assertLocationAccess(principal, locationId);
    }

    // The store must exist and be a store.
    const loc = await query<{ name: string; type: string }>(
      `SELECT name, type::text AS type FROM locations WHERE id = $1`,
      [locationId],
    );
    const locRow = loc.rows[0];
    if (locRow === undefined) {
      throw AppError.notFound('Location not found.');
    }
    if (locRow.type !== 'store') {
      throw AppError.validation('Trend is only available for a store location.');
    }

    const windows = trailingMonthLabels(months);
    const oldestStart = windows[0]?.start ?? firstOfMonth(new Date().getUTCFullYear(), 1);

    // One scan over the whole range, bucketed by calendar month in SQL. The
    // bucket key is the `YYYY-MM` label so we can join it to the zero-filled
    // series below — months with no sales simply have no row.
    const { rows } = await query<{ month: string; actual_sum: string | null }>(
      `SELECT to_char(date_trunc('month', s.sold_at), 'YYYY-MM') AS month,
              sum(s.qty * s.price)                                AS actual_sum
         FROM sales s
        WHERE s.store_id = $1
          AND s.sold_at >= $2
        GROUP BY 1`,
      [locationId, oldestStart],
    );
    const byMonth = new Map<string, number>();
    for (const r of rows) {
      byMonth.set(r.month, roundMoney(Number(r.actual_sum ?? 0)));
    }

    const series = windows.map((w) => ({
      month: w.label,
      actual_sum: byMonth.get(w.label) ?? 0,
    }));

    res.status(200).json({
      location_id: locationId,
      location_name: locRow.name,
      months,
      series, // oldest -> newest
    });
  }),
);
