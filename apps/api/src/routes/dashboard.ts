/**
 * M8 — Dashboard overview (spec section 4.8).
 *
 *   GET /api/dashboard/overview
 *
 * One read-only endpoint that returns the whole-chain (or location-scoped)
 * snapshot the operator sees: below-min stock rows, open replenishment
 * requests aggregated by status, the production plan for today (plus
 * overdue), the most recent stock movements, and a small KPI block.
 *
 * Performance contract (AC8.1 — TZ section 13): the endpoint must answer
 * in < 1 s. Each sub-query is bounded (LIMIT 20 on movements, status-keyed
 * aggregates), backed by existing indexes (`ix_stock_below_min`,
 * `ix_replenishment_status`, `ix_movements_created`), and the five queries
 * are issued in parallel via `Promise.all`.
 *
 * RBAC (spec section 6, dashboard row):
 *   - `pm` and `ai_assistant` see the entire chain.
 *   - every other role is locked to its own `location_id`. A scoped
 *     principal with `locationId === null` sees an empty snapshot (the
 *     guard mirrors `GET /api/stock`).
 *
 * Read-only — no audit-log writes (per spec).
 */
import { Router } from 'express';
import { query, type SqlParam } from '../db/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import type { AuthPrincipal } from '../auth/jwt.js';

export const dashboardRouter: Router = Router();

/** How many of the most-recent stock movements the overview returns. */
const RECENT_MOVEMENTS_LIMIT = 20;

/** Open replenishment statuses (terminal ones never appear in `by_status`). */
const OPEN_REPL_STATUSES = ['CLOSED', 'CANCELLED'] as const;

/** Active production order statuses (KPI + plan). */
const ACTIVE_PO_STATUSES = ['new', 'in_progress'] as const;

// ---------------------------------------------------------------------------
// Row types (raw shapes returned by pg — numerics arrive as strings)
// ---------------------------------------------------------------------------

type BelowMinRaw = {
  location_id: string;
  location_name: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  qty: string;
  min_level: string;
  max_level: string;
  open_request_id: string | null;
  open_request_status: string | null;
};

type StatusCountRaw = { status: string; cnt: string };

type ProductionPlanRaw = {
  id: string;
  product_id: string;
  product_name: string;
  qty: string;
  status: 'new' | 'in_progress' | 'done' | 'cancelled';
  location_id: string;
  location_name: string;
  target_location_id: string | null;
  target_location_name: string | null;
  deadline: Date | null;
};

type RecentMovementRaw = {
  id: string;
  created_at: Date;
  product_id: string;
  product_name: string;
  product_unit: string;
  from_location_id: string | null;
  from_location_name: string | null;
  to_location_id: string | null;
  to_location_name: string | null;
  qty: string;
  reason: string;
};

type SimpleCountRaw = { cnt: string };
type OldestOpenRaw = { oldest: Date | null };

// ---------------------------------------------------------------------------
// Response types (JSON-clean: numbers/strings, no Date or BigInt)
// ---------------------------------------------------------------------------

type BelowMinItem = {
  location_id: number;
  location_name: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  min_level: number;
  max_level: number;
  open_request_id: number | null;
  open_request_status: string | null;
};

type ProductionPlanItem = {
  id: number;
  product_id: number;
  product_name: string;
  qty: number;
  status: 'new' | 'in_progress' | 'done' | 'cancelled';
  location_id: number;
  location_name: string;
  target_location_id: number | null;
  target_location_name: string | null;
  deadline: string | null;
};

type RecentMovementItem = {
  id: number;
  created_at: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  from_location_id: number | null;
  from_location_name: string | null;
  to_location_id: number | null;
  to_location_name: string | null;
  qty: number;
  reason: string;
};

type OverviewResponse = {
  below_min: BelowMinItem[];
  open_requests: {
    by_status: Record<string, number>;
    total: number;
    oldest_created_at: string | null;
  };
  production_plan: ProductionPlanItem[];
  recent_movements: RecentMovementItem[];
  kpis: {
    total_open_requests: number;
    below_min_count: number;
    active_production_orders: number;
    pending_approvals: number;
  };
};

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

dashboardRouter.get(
  '/overview',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const scope = resolveScope(principal);

    // A location-scoped principal whose JWT has `locationId=null` sees
    // nothing — mirror the `GET /api/stock` behaviour for consistency.
    if (scope.kind === 'empty') {
      res.status(200).json(emptyOverview());
      return;
    }

    // All five queries are independent reads — fire them in parallel.
    const [belowMin, openByStatus, prodPlan, movements, kpiRow] = await Promise.all([
      fetchBelowMin(scope),
      fetchOpenRequestsByStatus(scope),
      fetchProductionPlan(scope),
      fetchRecentMovements(scope),
      fetchKpiExtras(scope),
    ]);

    const byStatus: Record<string, number> = {};
    let openTotal = 0;
    for (const row of openByStatus.counts) {
      const n = Number(row.cnt);
      byStatus[row.status] = n;
      openTotal += n;
    }

    const response: OverviewResponse = {
      below_min: belowMin.map(mapBelowMin),
      open_requests: {
        by_status: byStatus,
        total: openTotal,
        oldest_created_at:
          openByStatus.oldest === null ? null : openByStatus.oldest.toISOString(),
      },
      production_plan: prodPlan.map(mapProductionPlan),
      recent_movements: movements.map(mapMovement),
      kpis: {
        total_open_requests: openTotal,
        below_min_count: belowMin.length,
        active_production_orders: Number(kpiRow.activeProduction),
        pending_approvals: Number(kpiRow.pendingApprovals),
      },
    };
    res.status(200).json(response);
  }),
);

// ---------------------------------------------------------------------------
// Scope resolution — translates RBAC into a SQL filter
// ---------------------------------------------------------------------------

type Scope =
  | { kind: 'chain' } // pm / ai_assistant — whole supply chain
  | { kind: 'location'; locationId: number } // scoped manager
  | { kind: 'empty' }; // scoped principal with no location

function resolveScope(principal: AuthPrincipal): Scope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain' };
  }
  if (principal.locationId === null) {
    return { kind: 'empty' };
  }
  return { kind: 'location', locationId: principal.locationId };
}

// ---------------------------------------------------------------------------
// Sub-queries
// ---------------------------------------------------------------------------

/**
 * Below-min stock with an embedded open replenishment_request id (if any).
 * The partial index `ix_stock_below_min` makes the `qty <= min_level` scan
 * O(matches). The LATERAL join picks at most one open request per
 * (product, location) — invariant 2 guarantees there is at most one.
 */
async function fetchBelowMin(scope: Exclude<Scope, { kind: 'empty' }>): Promise<BelowMinRaw[]> {
  const params: SqlParam[] = [];
  let where = 'WHERE s.qty <= s.min_level';
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    where += ` AND s.location_id = $${params.length}`;
  }
  const { rows } = await query<BelowMinRaw>(
    `SELECT s.location_id, l.name AS location_name,
            s.product_id, p.name AS product_name, p.unit AS product_unit,
            s.qty, s.min_level, s.max_level,
            r.id     AS open_request_id,
            r.status::text AS open_request_status
     FROM stock s
     JOIN products  p ON p.id = s.product_id
     JOIN locations l ON l.id = s.location_id
     LEFT JOIN LATERAL (
       SELECT rr.id, rr.status
       FROM replenishment_requests rr
       WHERE rr.product_id = s.product_id
         AND rr.requester_location_id = s.location_id
         AND rr.status NOT IN ('CLOSED','CANCELLED')
       LIMIT 1
     ) r ON TRUE
     ${where}
     ORDER BY s.location_id, s.product_id`,
    params,
  );
  return rows;
}

/**
 * Open replenishment requests grouped by status, plus the oldest one's
 * `created_at`. Terminal statuses are excluded.
 */
async function fetchOpenRequestsByStatus(
  scope: Exclude<Scope, { kind: 'empty' }>,
): Promise<{ counts: StatusCountRaw[]; oldest: Date | null }> {
  const params: SqlParam[] = [];
  const conditions: string[] = [
    `status NOT IN ('${OPEN_REPL_STATUSES.join("','")}')`,
  ];
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    // The location appears as either requester or target — both touch it.
    conditions.push(
      `(requester_location_id = $${params.length} OR target_location_id = $${params.length})`,
    );
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const [byStatus, oldest] = await Promise.all([
    query<StatusCountRaw>(
      `SELECT status::text AS status, count(*) AS cnt
       FROM replenishment_requests
       ${where}
       GROUP BY status`,
      params,
    ),
    query<OldestOpenRaw>(
      `SELECT min(created_at) AS oldest
       FROM replenishment_requests
       ${where}`,
      params,
    ),
  ]);
  return { counts: byStatus.rows, oldest: oldest.rows[0]?.oldest ?? null };
}

/**
 * Today's production plan + any overdue order. Cancelled and done orders
 * are excluded; a row with no deadline still counts as "today" so the
 * production manager sees it.
 */
async function fetchProductionPlan(
  scope: Exclude<Scope, { kind: 'empty' }>,
): Promise<ProductionPlanRaw[]> {
  const params: SqlParam[] = [];
  const conditions: string[] = [
    `po.status IN ('${ACTIVE_PO_STATUSES.join("','")}')`,
    `(po.deadline IS NULL OR po.deadline <= CURRENT_DATE)`,
  ];
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    // A production order touches the scope when produced AT or shipped TO
    // the principal's location.
    conditions.push(
      `(po.location_id = $${params.length} OR po.target_location_id = $${params.length})`,
    );
  }
  const { rows } = await query<ProductionPlanRaw>(
    `SELECT po.id, po.product_id, p.name AS product_name, po.qty, po.status,
            po.location_id, l.name AS location_name,
            po.target_location_id, tl.name AS target_location_name,
            po.deadline
     FROM production_orders po
     JOIN products  p  ON p.id = po.product_id
     JOIN locations l  ON l.id = po.location_id
     LEFT JOIN locations tl ON tl.id = po.target_location_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY po.deadline NULLS LAST, po.id`,
    params,
  );
  return rows;
}

/**
 * The most-recent stock movements. The `ix_movements_created` index keeps
 * this cheap even on a large ledger. For a scoped principal the filter is
 * `from OR to = scope.locationId`.
 */
async function fetchRecentMovements(
  scope: Exclude<Scope, { kind: 'empty' }>,
): Promise<RecentMovementRaw[]> {
  const params: SqlParam[] = [];
  let where = '';
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    where = `WHERE (m.from_location_id = $${params.length} OR m.to_location_id = $${params.length})`;
  }
  params.push(RECENT_MOVEMENTS_LIMIT);
  const limitIdx = params.length;
  const { rows } = await query<RecentMovementRaw>(
    `SELECT m.id, m.created_at,
            m.product_id, p.name AS product_name, p.unit AS product_unit,
            m.from_location_id, fl.name AS from_location_name,
            m.to_location_id,   tl.name AS to_location_name,
            m.qty, m.reason::text AS reason
     FROM stock_movements m
     JOIN products p   ON p.id  = m.product_id
     LEFT JOIN locations fl ON fl.id = m.from_location_id
     LEFT JOIN locations tl ON tl.id = m.to_location_id
     ${where}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${limitIdx}`,
    params,
  );
  return rows;
}

/**
 * The extra KPIs not already captured by other queries: active production
 * orders and purchase orders awaiting either approval step.
 */
async function fetchKpiExtras(
  scope: Exclude<Scope, { kind: 'empty' }>,
): Promise<{ activeProduction: string; pendingApprovals: string }> {
  // Active production orders — same scope rule as production_plan.
  const prodParams: SqlParam[] = [];
  let prodWhere = `WHERE status IN ('${ACTIVE_PO_STATUSES.join("','")}')`;
  if (scope.kind === 'location') {
    prodParams.push(scope.locationId);
    prodWhere += ` AND (location_id = $${prodParams.length} OR target_location_id = $${prodParams.length})`;
  }

  // Pending approvals = draft purchase orders where at least one approval
  // step is still open. For a scoped principal the relevant signal is the
  // target raw warehouse, which is the only PO field that maps to a
  // location. A store manager will see zero — by design.
  const poParams: SqlParam[] = [];
  let poWhere = `WHERE status = 'draft'
                   AND (manager_approved_by IS NULL OR keeper_approved_by IS NULL)`;
  if (scope.kind === 'location') {
    poParams.push(scope.locationId);
    poWhere += ` AND target_location_id = $${poParams.length}`;
  }

  const [prodRes, poRes] = await Promise.all([
    query<SimpleCountRaw>(
      `SELECT count(*) AS cnt FROM production_orders ${prodWhere}`,
      prodParams,
    ),
    query<SimpleCountRaw>(`SELECT count(*) AS cnt FROM purchase_orders ${poWhere}`, poParams),
  ]);
  return {
    activeProduction: prodRes.rows[0]?.cnt ?? '0',
    pendingApprovals: poRes.rows[0]?.cnt ?? '0',
  };
}

// ---------------------------------------------------------------------------
// Row -> response mappers (coerce BIGINT/NUMERIC strings into numbers and
// Dates into ISO strings, so the JSON shape matches the spec).
// ---------------------------------------------------------------------------

function mapBelowMin(r: BelowMinRaw): BelowMinItem {
  return {
    location_id: Number(r.location_id),
    location_name: r.location_name,
    product_id: Number(r.product_id),
    product_name: r.product_name,
    product_unit: r.product_unit,
    qty: Number(r.qty),
    min_level: Number(r.min_level),
    max_level: Number(r.max_level),
    open_request_id: r.open_request_id === null ? null : Number(r.open_request_id),
    open_request_status: r.open_request_status,
  };
}

function mapProductionPlan(r: ProductionPlanRaw): ProductionPlanItem {
  return {
    id: Number(r.id),
    product_id: Number(r.product_id),
    product_name: r.product_name,
    qty: Number(r.qty),
    status: r.status,
    location_id: Number(r.location_id),
    location_name: r.location_name,
    target_location_id: r.target_location_id === null ? null : Number(r.target_location_id),
    target_location_name: r.target_location_name,
    deadline: r.deadline === null ? null : toIsoDate(r.deadline),
  };
}

function mapMovement(r: RecentMovementRaw): RecentMovementItem {
  return {
    id: Number(r.id),
    created_at: r.created_at.toISOString(),
    product_id: Number(r.product_id),
    product_name: r.product_name,
    product_unit: r.product_unit,
    from_location_id: r.from_location_id === null ? null : Number(r.from_location_id),
    from_location_name: r.from_location_name,
    to_location_id: r.to_location_id === null ? null : Number(r.to_location_id),
    to_location_name: r.to_location_name,
    qty: Number(r.qty),
    reason: r.reason,
  };
}

/** Format a DATE column (`production_orders.deadline`) as `YYYY-MM-DD`. */
function toIsoDate(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, 10);
}

function emptyOverview(): OverviewResponse {
  return {
    below_min: [],
    open_requests: { by_status: {}, total: 0, oldest_created_at: null },
    production_plan: [],
    recent_movements: [],
    kpis: {
      total_open_requests: 0,
      below_min_count: 0,
      active_production_orders: 0,
      pending_approvals: 0,
    },
  };
}
