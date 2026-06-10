/**
 * KPI — production costing & profit (owner feature, 2026-06-06).
 *
 * The boss manages selling prices from a single screen that, for every
 * finished product, shows its FULL cost (ingredients + utilities + labor) and
 * the profit vs actual sales for a month. This router serves:
 *
 *   GET /api/kpi/products?month=YYYY-MM — THE costing report (see below)
 *
 * COSTING MODEL (per finished product, for a chosen month):
 *   material_cost    = the BOM roll-up (services/bom readRecipeTree.total_cost),
 *                      per ONE finished unit. NULL when any leg's cost is unknown
 *                      — we never fake a 0 (a missing raw cost must stay visible).
 *   komunal_per_unit = products.komunal_per_unit — a PER-PRODUCT manual per-unit
 *                      utility cost the boss enters directly (owner decision
 *                      2026-06-06; replaces the old shared overhead pool). NULL
 *                      = not set (treated as 0 in full_cost).
 *   salary_per_unit  = Σ users.monthly_salary (active) / total units made — labor
 *                      stays a SHARED pool spread over every finished unit made.
 *   full_cost        = material_cost + komunal_per_unit + salary_per_unit
 *                      (null-safe: if material_cost is null, full_cost is null)
 *   profit           = revenue − (full_cost × units_sold)  (null if full_cost null)
 *
 * Salary is the only SHARED cost spread evenly over every finished unit produced
 * that month, so a product not produced in the month still carries the same
 * per-unit salary share (the boss compares apples to apples). Komunal is now a
 * direct per-product value. Units produced come from done production orders of
 * FINISHED goods.
 *
 * RBAC: pm only (payroll + pricing strategy is a PM-scoped concern).
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { poolRunner } from '../lib/audit.js';
import { readRecipeTree } from '../services/bom.js';

export const kpiRouter: Router = Router();

/**
 * A resolved month window: the first day of the month (`start`), the first day
 * of the NEXT month (`nextStart`, exclusive upper bound) and the `YYYY-MM`
 * label echoed back to the client. Date filters use `>= start AND < nextStart`
 * so the upper bound is half-open (no off-by-one on month-end timestamps).
 */
type MonthWindow = {
  readonly label: string; // 'YYYY-MM'
  readonly start: string; // 'YYYY-MM-01'
  readonly nextStart: string; // first day of the following month
};

/**
 * The effective reporting window for GET /api/kpi/products. Either a whole
 * month (`?month=YYYY-MM`, the default) or an arbitrary inclusive day range
 * (`?from=YYYY-MM-DD&to=YYYY-MM-DD`, which OVERRIDES month when given).
 *
 * `salaryFactor` is the share of the MONTHLY salary pool the window carries:
 * the pool is pro-rated by calendar days — for every month the window touches
 * it contributes (days of the window inside that month / days in that month).
 * A whole-month window therefore has factor exactly 1 (back-compat), a
 * 2026-06-01..2026-06-15 window carries 15/30, and a cross-month
 * 2026-05-25..2026-06-03 window carries 7/31 + 3/30.
 */
type ReportWindow = {
  readonly label: string; // 'YYYY-MM' — the month echo (unchanged shape)
  readonly start: string; // inclusive 'YYYY-MM-DD' lower bound
  readonly endExclusive: string; // exclusive 'YYYY-MM-DD' upper bound
  readonly from: string; // inclusive ISO start date (echoed)
  readonly to: string; // inclusive ISO end date (echoed)
  readonly salaryFactor: number;
};

const DAY_MS = 86_400_000;

/** Format a UTC date as 'YYYY-MM-DD'. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Parse a strict 'YYYY-MM-DD' string into a UTC date. Returns null for a
 * malformed string or an impossible calendar day (e.g. 2026-02-30 — the
 * Date round-trip check catches silent overflow).
 */
function parseIsoDate(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
    return null;
  }
  return d;
}

/**
 * Share of the monthly salary pool carried by the inclusive day window
 * [from, toInclusive]: Σ over touched months of (window days in the month /
 * days in that month). Exported for unit tests.
 */
export function salaryProRateFactor(from: Date, toInclusive: Date): number {
  let factor = 0;
  let monthStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (monthStart.getTime() <= toInclusive.getTime()) {
    const nextMonth = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1),
    );
    const daysInMonth = Math.round((nextMonth.getTime() - monthStart.getTime()) / DAY_MS);
    const overlapStart = Math.max(from.getTime(), monthStart.getTime());
    const monthEndInclusive = nextMonth.getTime() - DAY_MS;
    const overlapEnd = Math.min(toInclusive.getTime(), monthEndInclusive);
    const overlapDays = Math.round((overlapEnd - overlapStart) / DAY_MS) + 1;
    if (overlapDays > 0) factor += overlapDays / daysInMonth;
    monthStart = nextMonth;
  }
  return factor;
}

/**
 * Resolve the effective reporting window from the query. `from`/`to`
 * (inclusive, 'YYYY-MM-DD') override `month` when given — both must then be
 * present and ordered. Without them the window is the whole resolved month
 * and behaves exactly as before (salaryFactor 1). Exported for unit tests.
 */
export function resolveWindow(queryParams: {
  month?: unknown;
  from?: unknown;
  to?: unknown;
}): ReportWindow {
  const month = resolveMonth(queryParams.month);
  const fromRaw = queryParams.from;
  const toRaw = queryParams.to;
  if (fromRaw === undefined && toRaw === undefined) {
    // Month mode — identical to the historic behavior. `to` echoes the last
    // day of the month (inclusive), salary pool is carried in full.
    const nextStart = parseIsoDate(month.nextStart);
    const toInclusive = new Date((nextStart as Date).getTime() - DAY_MS);
    return {
      label: month.label,
      start: month.start,
      endExclusive: month.nextStart,
      from: month.start,
      to: isoDate(toInclusive),
      salaryFactor: 1,
    };
  }
  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') {
    throw AppError.validation('Queries "from" and "to" must BOTH be given as "YYYY-MM-DD".');
  }
  const from = parseIsoDate(fromRaw);
  const to = parseIsoDate(toRaw);
  if (from === null || to === null) {
    throw AppError.validation('Queries "from"/"to" must be real dates in the form "YYYY-MM-DD".');
  }
  if (from.getTime() > to.getTime()) {
    throw AppError.validation('Query "from" must not be after "to".');
  }
  const endExclusive = new Date(to.getTime() + DAY_MS);
  return {
    label: month.label,
    start: isoDate(from),
    endExclusive: isoDate(endExclusive),
    from: isoDate(from),
    to: isoDate(to),
    salaryFactor: salaryProRateFactor(from, to),
  };
}

/**
 * Parse a `?month=YYYY-MM` query value into a half-open window. Defaults to the
 * CURRENT month when absent/empty. Rejects anything that is not a real month.
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
  const start = `${label}-01`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextStart = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
  return { label, start, nextStart };
}

// ---------------------------------------------------------------------------
// GET /api/kpi/products?month=YYYY-MM — THE costing report (pm only).
// ---------------------------------------------------------------------------
type FinishedProductRow = {
  id: number;
  name: string;
  kpi_target: string | null;
  komunal_per_unit: string | null;
};

/** A per-product produced/sold/revenue aggregate row from one of the scans. */
type AggRow = {
  product_id: number;
  qty: string;
};
type RevenueRow = {
  product_id: number;
  units_sold: string;
  revenue: string;
};

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

kpiRouter.get(
  '/products',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const win = resolveWindow({
      month: req.query['month'],
      from: req.query['from'],
      to: req.query['to'],
    });

    // --- totals -------------------------------------------------------------
    // Salary total — only ACTIVE employees of a PRODUCTION department (sex) count
    // toward the costing labour pool (owner rule 2026-06-06: oylik applies only to
    // ishlab chiqarish bo'limlari, not store/warehouse/cashier staff). A user is a
    // production employee if ANY assigned location (primary `location_id` or an
    // M:N `user_locations` row) is of type 'production'. EXISTS counts each salary
    // once. SUM skips NULL salaries.
    const salaryAgg = await query<{ total: string | null }>(
      `SELECT SUM(u.monthly_salary) AS total
         FROM users u
        WHERE u.is_active = TRUE
          AND EXISTS (
            SELECT 1 FROM locations l
             WHERE l.type = 'production'
               AND (l.id = u.location_id
                    OR l.id IN (SELECT ul.location_id FROM user_locations ul
                                 WHERE ul.user_id = u.id))
          )`,
    );
    // Salary pool for the WINDOW — the monthly pool pro-rated by calendar days
    // (factor 1 for a whole-month window; see `salaryProRateFactor`).
    const totalSalary = roundMoney(
      Number(salaryAgg.rows[0]?.total ?? 0) * win.salaryFactor,
    );

    // Units produced in the window — done orders of FINISHED products only.
    // (done_at within the half-open window.)
    const producedAgg = await query<AggRow>(
      `SELECT po.product_id, SUM(po.qty) AS qty
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
        WHERE po.status = 'done'
          AND po.done_at >= $1 AND po.done_at < $2
          AND p.type = 'finished'
        GROUP BY po.product_id`,
      [win.start, win.endExclusive],
    );
    const producedByProduct = new Map<number, number>();
    let totalUnitsProduced = 0;
    for (const r of producedAgg.rows) {
      const q = Number(r.qty);
      producedByProduct.set(Number(r.product_id), q);
      totalUnitsProduced += q;
    }

    const salaryPerUnit =
      totalUnitsProduced > 0 ? roundMoney(totalSalary / totalUnitsProduced) : null;

    // Sales in the window — units_sold + revenue per product.
    const salesAgg = await query<RevenueRow>(
      `SELECT product_id,
              SUM(qty)            AS units_sold,
              SUM(price * qty)    AS revenue
         FROM sales
        WHERE sold_at >= $1 AND sold_at < $2
        GROUP BY product_id`,
      [win.start, win.endExclusive],
    );
    const soldByProduct = new Map<number, { units: number; revenue: number }>();
    for (const r of salesAgg.rows) {
      soldByProduct.set(Number(r.product_id), {
        units: Number(r.units_sold),
        revenue: Number(r.revenue),
      });
    }

    // Every active finished product (the rows the boss prices).
    const { rows: products } = await query<FinishedProductRow>(
      `SELECT id, name, kpi_target, komunal_per_unit
         FROM products
        WHERE type = 'finished' AND is_active = TRUE
        ORDER BY id`,
    );

    // --- per-product rows ---------------------------------------------------
    const rows = [];
    for (const p of products) {
      const productId = Number(p.id);

      // Material cost = BOM roll-up per ONE finished unit (may be null).
      const tree = await readRecipeTree(poolRunner, productId);
      const materialCost = tree.total_cost; // already per-piece + rounded; null-safe.

      // Komunal is a PER-PRODUCT manual per-unit value (may be null = not set).
      const komunalPerUnit =
        p.komunal_per_unit === null ? null : Number(p.komunal_per_unit);

      // full_cost is null whenever material_cost is null (never fake a 0). The
      // komunal/salary legs are 0 when unset / no units produced this month.
      const fullCost =
        materialCost === null
          ? null
          : roundMoney(materialCost + (komunalPerUnit ?? 0) + (salaryPerUnit ?? 0));

      const sold = soldByProduct.get(productId);
      const unitsSold = sold?.units ?? 0;
      const revenue = sold?.revenue ?? 0;

      const profit =
        fullCost === null ? null : roundMoney(revenue - fullCost * unitsSold);

      rows.push({
        product_id: productId,
        name: p.name,
        material_cost: materialCost,
        komunal_per_unit: komunalPerUnit,
        salary_per_unit: salaryPerUnit,
        full_cost: fullCost,
        units_produced: producedByProduct.get(productId) ?? 0,
        units_sold: unitsSold,
        revenue: roundMoney(revenue),
        profit,
        kpi_target: p.kpi_target === null ? null : Number(p.kpi_target),
      });
    }

    // Order by revenue desc, then name (stable tiebreak).
    rows.sort((a, b) => {
      if (b.revenue !== a.revenue) return b.revenue - a.revenue;
      return a.name.localeCompare(b.name);
    });

    res.status(200).json({
      month: win.label,
      // Echo of the effective inclusive window (equals the whole month when
      // no ?from/?to was given).
      from: win.from,
      to: win.to,
      totals: {
        salary: roundMoney(totalSalary),
        units_produced: totalUnitsProduced,
        salary_per_unit: salaryPerUnit,
      },
      products: rows,
    });
  }),
);
