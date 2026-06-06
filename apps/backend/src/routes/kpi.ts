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
    const win = resolveMonth(req.query['month']);

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
    const totalSalary = Number(salaryAgg.rows[0]?.total ?? 0);

    // Units produced this month — done orders of FINISHED products only.
    // (done_at within the half-open month window.)
    const producedAgg = await query<AggRow>(
      `SELECT po.product_id, SUM(po.qty) AS qty
         FROM production_orders po
         JOIN products p ON p.id = po.product_id
        WHERE po.status = 'done'
          AND po.done_at >= $1 AND po.done_at < $2
          AND p.type = 'finished'
        GROUP BY po.product_id`,
      [win.start, win.nextStart],
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

    // Sales this month — units_sold + revenue per product.
    const salesAgg = await query<RevenueRow>(
      `SELECT product_id,
              SUM(qty)            AS units_sold,
              SUM(price * qty)    AS revenue
         FROM sales
        WHERE sold_at >= $1 AND sold_at < $2
        GROUP BY product_id`,
      [win.start, win.nextStart],
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
      totals: {
        salary: roundMoney(totalSalary),
        units_produced: totalUnitsProduced,
        salary_per_unit: salaryPerUnit,
      },
      products: rows,
    });
  }),
);
