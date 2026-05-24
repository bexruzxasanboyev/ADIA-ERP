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
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { parseDateRange, type DateRange } from '../lib/dateRange.js';
import type { AuthPrincipal } from '../auth/jwt.js';
import type { Role } from '../auth/roles.js';

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

    // F4.9 — `?range` narrows time-bound aggregates (recent_movements here;
    // below_min/open_requests/production_plan/KPIs are "current state" and
    // intentionally ignore range).
    const range = parseDateRange(req.query);

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
      fetchRecentMovements(scope, range),
      fetchKpiExtras(scope, principal),
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
  range: DateRange,
): Promise<RecentMovementRaw[]> {
  const params: SqlParam[] = [];
  const conditions: string[] = [];
  if (scope.kind === 'location') {
    params.push(scope.locationId);
    conditions.push(
      `(m.from_location_id = $${params.length} OR m.to_location_id = $${params.length})`,
    );
  }
  // F4.9 — clip to the requested range. Half-open: [from, to).
  params.push(range.from);
  conditions.push(`m.created_at >= $${params.length}`);
  params.push(range.to);
  conditions.push(`m.created_at < $${params.length}`);
  const where = `WHERE ${conditions.join(' AND ')}`;
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
 *
 * `pending_approvals` is role-aware (C6 — Sprint 3 audit) — see
 * `pendingApprovalsClause` below. The two queries fan out in parallel.
 */
async function fetchKpiExtras(
  scope: Exclude<Scope, { kind: 'empty' }>,
  principal: AuthPrincipal,
): Promise<{ activeProduction: string; pendingApprovals: string }> {
  // Active production orders — same scope rule as production_plan.
  const prodParams: SqlParam[] = [];
  let prodWhere = `WHERE status IN ('${ACTIVE_PO_STATUSES.join("','")}')`;
  if (scope.kind === 'location') {
    prodParams.push(scope.locationId);
    prodWhere += ` AND (location_id = $${prodParams.length} OR target_location_id = $${prodParams.length})`;
  }

  const { sql: poSql, params: poParams } = pendingApprovalsClause(principal);

  const [prodRes, poRes] = await Promise.all([
    query<SimpleCountRaw>(
      `SELECT count(*) AS cnt FROM production_orders ${prodWhere}`,
      prodParams,
    ),
    query<SimpleCountRaw>(`SELECT count(*) AS cnt FROM purchase_orders ${poSql}`, poParams),
  ]);
  return {
    activeProduction: prodRes.rows[0]?.cnt ?? '0',
    pendingApprovals: poRes.rows[0]?.cnt ?? '0',
  };
}

/**
 * Build the `pending_approvals` WHERE clause and its bind params, role-aware.
 *
 * Spec D5 + section 4.5: a purchase_order is `draft` until both the supply
 * manager (step 1) and the raw-warehouse keeper (step 2) approve it. The
 * dashboard widget says "approvals waiting for YOU".
 *
 *   pm / ai_assistant / central_warehouse_manager:
 *     full chain — every draft missing at least one approval.
 *   raw_warehouse_manager:
 *     drafts targeting their warehouse (the only PO field that ties to a
 *     location), missing at least one approval. They are the keeper-step
 *     approver.
 *   supply_manager:
 *     supply_manager's `users.location_id` is the supply hub, not the raw
 *     warehouse. They cannot be filtered by `target_location_id`. They are
 *     the chain's draft-approvers (step 1) — show every draft still missing
 *     manager approval. Chain-wide visibility is by design.
 *   store_manager / production_manager:
 *     no role in the approval chain — show 0.
 */
function pendingApprovalsClause(
  principal: AuthPrincipal,
): { sql: string; params: SqlParam[] } {
  const role = principal.role;
  const draftOpen =
    `status = 'draft' AND (manager_approved_by IS NULL OR keeper_approved_by IS NULL)`;

  if (role === 'pm' || role === 'ai_assistant' || role === 'central_warehouse_manager') {
    return { sql: `WHERE ${draftOpen}`, params: [] };
  }
  if (role === 'raw_warehouse_manager') {
    if (principal.locationId === null) {
      return { sql: `WHERE 1 = 0`, params: [] };
    }
    return {
      sql: `WHERE ${draftOpen} AND target_location_id = $1`,
      params: [principal.locationId],
    };
  }
  if (role === 'supply_manager') {
    // C6 — show every draft still awaiting manager approval. A supply_manager
    // is the chain-wide draft-approver and their `location_id` is the supply
    // hub, not the raw warehouse a PO targets.
    return {
      sql: `WHERE ${draftOpen} AND manager_approved_by IS NULL`,
      params: [],
    };
  }
  // store_manager, production_manager — no role in PO approval chain.
  return { sql: `WHERE 1 = 0`, params: [] };
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

// =============================================================================
// F4.4 — GET /api/dashboard/ecosystem
// =============================================================================
//
// One payload, four blocks:
//   - poster_status: last sync run + 24h failure count + today's sales pulse
//   - chain_flow:    every location with below-min / open-request counts,
//                    ordered by type so the UI can render the supply chain
//                    left-to-right (raw -> production -> supply -> central
//                    -> store).
//   - alerts_feed:   the latest 20 notifications with a derived severity.
//   - sales_chart:   the last 30 days of daily sales (per scoped location set).
//
// RBAC mirrors M8 dashboard/overview — every authenticated business role can
// hit the endpoint; non-chain roles are scoped to their assigned locations
// (M:N — F4.1 / ADR-0012) for `chain_flow`, `sales_chart`, and the
// `sales_today_*` fields of `poster_status`. `poster_status` headline metrics
// (last sync, sync_errors_24h) are intentionally chain-wide — Poster sync is
// a backend-wide event, not a per-location one.
//
// AC4.4.6 — endpoint P95 < 1000ms. Four queries fan out in parallel via
// Promise.all; each one is bounded (sales_chart 30 rows, alerts_feed 20).
// -----------------------------------------------------------------------------

const ALERTS_FEED_LIMIT = 20;

type EcosystemScope =
  | { kind: 'chain' } // pm / ai_assistant — every location.
  | { kind: 'locations'; locationIds: number[] } // scoped principal.
  | { kind: 'empty' }; // scoped principal with no assigned locations.

type PosterStatusBlock = {
  last_sync_at: string | null;
  last_sync_status: 'ok' | 'partial' | 'failed' | null;
  sync_errors_24h: number;
  sales_today_count: number;
  sales_today_sum: number;
};

type ChainFlowItem = {
  location_id: number;
  location_name: string;
  location_type: string;
  below_min_count: number;
  open_requests_count: number;
  total_products: number;
};

type AlertSeverity = 'info' | 'warning' | 'danger';

type AlertsFeedItem = {
  id: number;
  type: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  location_id: number | null;
  created_at: string;
};

type SalesChartItem = {
  date: string; // YYYY-MM-DD
  qty: number;
};

type EcosystemResponse = {
  poster_status: PosterStatusBlock;
  chain_flow: ChainFlowItem[];
  alerts_feed: AlertsFeedItem[];
  sales_chart: { days: SalesChartItem[] };
};

dashboardRouter.get(
  '/ecosystem',
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
    const scope = resolveEcosystemScope(principal);

    // F4.9 — `?range` shrinks the sales aggregates and chart window. The
    // chain_flow + alerts_feed are state snapshots and intentionally
    // ignore range.
    const range = parseDateRange(req.query);

    if (scope.kind === 'empty') {
      res.status(200).json(emptyEcosystem());
      return;
    }

    const [posterStatus, chainFlow, alertsFeed, salesChart] = await Promise.all([
      fetchPosterStatus(scope, range),
      fetchChainFlow(scope),
      fetchAlertsFeed(principal),
      fetchSalesChart(scope, range),
    ]);

    const response: EcosystemResponse = {
      poster_status: posterStatus,
      chain_flow: chainFlow,
      alerts_feed: alertsFeed,
      sales_chart: { days: salesChart },
    };
    res.status(200).json(response);
  }),
);

function resolveEcosystemScope(principal: AuthPrincipal): EcosystemScope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain' };
  }
  // M:N — every assigned location. Empty array -> empty payload.
  if (principal.locationIds.length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'locations', locationIds: principal.locationIds };
}

/**
 * Alerts-feed visibility — broader than `resolveEcosystemScope` because the
 * central warehouse manager is the operational hub of the chain and needs
 * the chain-wide alert stream even though their stock/sales views are
 * location-scoped. Mirrors `pendingApprovalsClause` (D5).
 */
function isAlertsChainWide(principal: AuthPrincipal): boolean {
  return (
    isSuperAdmin(principal) ||
    principal.role === 'ai_assistant' ||
    principal.role === 'central_warehouse_manager'
  );
}

/**
 * Poster status block.
 *   - last_sync_*  : the most recent `poster_sync_log` row (any entity).
 *   - sync_errors_24h: count of `failed` rows in the last 24h.
 *   - sales_today_* : today's `sales` rows; for a scoped principal, filtered
 *     to their assigned stores. Stock movements/sync are chain-wide.
 */
async function fetchPosterStatus(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<PosterStatusBlock> {
  const salesParams: SqlParam[] = [range.from, range.to];
  let salesWhere = 'WHERE sold_at >= $1 AND sold_at < $2';
  if (scope.kind === 'locations') {
    salesParams.push(scope.locationIds);
    salesWhere += ` AND store_id = ANY($${salesParams.length}::bigint[])`;
  }

  const [lastSync, errors24h, salesToday] = await Promise.all([
    query<{ finished_at: Date | null; started_at: Date; status: 'ok' | 'partial' | 'failed' }>(
      // Order by `started_at` (NOT by id) — id reflects insert order, which
      // is fine for the common case, but back-fills or replayed rows could
      // arrive out of chronological order. The "last sync" the dashboard
      // should show is the most recent one in real time.
      `SELECT finished_at, started_at, status::text AS status
         FROM poster_sync_log
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
    ),
    query<{ cnt: string }>(
      `SELECT count(*) AS cnt
         FROM poster_sync_log
         WHERE status = 'failed'
           AND started_at > now() - interval '24 hours'`,
    ),
    query<{ cnt: string; total: string | null }>(
      `SELECT count(*) AS cnt, coalesce(sum(qty),0) AS total
         FROM sales
         ${salesWhere}`,
      salesParams,
    ),
  ]);

  const lastRow = lastSync.rows[0];
  const lastWhen = lastRow?.finished_at ?? lastRow?.started_at ?? null;

  return {
    last_sync_at: lastWhen === null ? null : lastWhen.toISOString(),
    last_sync_status: lastRow?.status ?? null,
    sync_errors_24h: Number(errors24h.rows[0]?.cnt ?? 0),
    sales_today_count: Number(salesToday.rows[0]?.cnt ?? 0),
    sales_today_sum: Number(salesToday.rows[0]?.total ?? 0),
  };
}

/**
 * One row per location. `below_min_count` and `open_requests_count` are
 * computed in SQL with LEFT JOIN sub-aggregates — keeps the result one
 * query, scales linearly with location count (small — single digits in MVP).
 *
 * Ordering: type rank (raw -> production -> supply -> central -> store),
 * then by id for a stable left-to-right render.
 */
async function fetchChainFlow(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainFlowItem[]> {
  const params: SqlParam[] = [];
  let where = 'WHERE l.is_active = TRUE';
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND l.id = ANY($${params.length}::bigint[])`;
  }

  const { rows } = await query<{
    location_id: string;
    location_name: string;
    location_type: string;
    below_min_count: string;
    open_requests_count: string;
    total_products: string;
  }>(
    `SELECT l.id              AS location_id,
            l.name            AS location_name,
            l.type::text      AS location_type,
            coalesce(bm.below_min_count, 0)   AS below_min_count,
            coalesce(orq.open_requests_count, 0) AS open_requests_count,
            coalesce(tp.total_products, 0)    AS total_products
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT count(*) AS below_min_count
           FROM stock s
          WHERE s.location_id = l.id AND s.qty <= s.min_level
       ) bm ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_requests_count
           FROM replenishment_requests rr
          WHERE rr.requester_location_id = l.id
            AND rr.status NOT IN ('CLOSED','CANCELLED')
       ) orq ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS total_products
           FROM stock s2 WHERE s2.location_id = l.id
       ) tp ON TRUE
       ${where}
       ORDER BY CASE l.type
                  WHEN 'raw_warehouse'      THEN 1
                  WHEN 'production'         THEN 2
                  WHEN 'supply'             THEN 3
                  WHEN 'central_warehouse'  THEN 4
                  WHEN 'store'              THEN 5
                  ELSE 6
                END,
                l.id`,
    params,
  );

  return rows.map((r) => ({
    location_id: Number(r.location_id),
    location_name: r.location_name,
    location_type: r.location_type,
    below_min_count: Number(r.below_min_count),
    open_requests_count: Number(r.open_requests_count),
    total_products: Number(r.total_products),
  }));
}

/**
 * The latest 20 notifications, scoped to the principal.
 *
 * F4.11 Bug-MIN-03 — previously this fetched chain-wide for every role, so a
 * store_manager saw alerts about locations they have no business seeing.
 * Scoping rules now mirror the rest of the dashboard:
 *
 *   - pm / ai_assistant / central_warehouse_manager
 *       chain-wide visibility (see `pendingApprovalsClause` for the same
 *       three-role split).
 *   - any other scoped role
 *       only alerts addressed to them personally
 *       (`notifications.recipient_user_id = principal.userId`)
 *       OR alerts tagged with a location id in `payload.location_id` that
 *       falls inside their assigned `locationIds` set.
 *
 * Severity is derived from `notifications.type` per the spec §2.4 routing
 * table.
 */
async function fetchAlertsFeed(
  principal: AuthPrincipal,
): Promise<AlertsFeedItem[]> {
  const params: SqlParam[] = [];
  let where = '';
  if (!isAlertsChainWide(principal)) {
    // No assigned locations -> only personal alerts are reachable.
    params.push(principal.userId);
    const personalIdx = params.length;
    if (principal.locationIds.length === 0) {
      where = `WHERE recipient_user_id = $${personalIdx}`;
    } else {
      params.push(principal.locationIds);
      const locsIdx = params.length;
      // `payload->>'location_id'` is text in JSONB; cast both sides through
      // bigint so numeric comparison works against the `bigint[]` ids.
      where =
        `WHERE recipient_user_id = $${personalIdx} ` +
        `   OR (payload ? 'location_id' ` +
        `       AND (payload->>'location_id') ~ '^[0-9]+$' ` +
        `       AND (payload->>'location_id')::bigint = ANY($${locsIdx}::bigint[]))`;
    }
  }
  params.push(ALERTS_FEED_LIMIT);
  const limitIdx = params.length;

  const { rows } = await query<{
    id: string;
    type: string;
    title: string;
    body: string;
    payload: { location_id?: number | string } | null;
    created_at: Date;
  }>(
    `SELECT id, type, title, body, payload, created_at
       FROM notifications
       ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIdx}`,
    params,
  );

  return rows.map((r) => {
    const payloadLoc = r.payload?.location_id;
    const locationId =
      payloadLoc === undefined || payloadLoc === null ? null : Number(payloadLoc);
    return {
      id: Number(r.id),
      type: r.type,
      severity: severityFor(r.type),
      title: r.title,
      message: r.body,
      location_id: Number.isFinite(locationId as number) ? (locationId as number) : null,
      created_at: r.created_at.toISOString(),
    };
  });
}

/** Spec §2.4 severity routing. Unknown types default to `info`. */
function severityFor(type: string): AlertSeverity {
  switch (type) {
    case 'negative_stock_detected':
    case 'poster_sync_failed':
      return 'danger';
    case 'stock_below_min':
      return 'warning';
    default:
      return 'info';
  }
}

/**
 * Last 30 days of sales, aggregated from `sales_stats_daily`. For a scoped
 * principal, only their assigned locations contribute. The chart is fed by
 * the nightly `salesAggregateCron`, so per-day rows always exist for days
 * that had sales.
 */
async function fetchSalesChart(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<SalesChartItem[]> {
  // F4.9 — chart window equals the requested range. The aggregate table is
  // keyed by `stat_date` (DATE, not TIMESTAMPTZ), so we compare against the
  // calendar bounds, inclusive on both ends.
  const fromDate = toIsoDate(range.from);
  // Subtract 1 ms so a half-open `[from, to)` window maps back to the last
  // inclusive calendar day in `to`. Without it `2026-05-25T00:00:00Z` would
  // pull in 2026-05-25 even when the caller asked through 2026-05-24.
  const toInclusive = new Date(range.to.getTime() - 1);
  const toDate = toIsoDate(toInclusive);
  const params: SqlParam[] = [fromDate, toDate];
  let where = `WHERE stat_date >= $1::date AND stat_date <= $2::date`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND location_id = ANY($${params.length}::bigint[])`;
  }
  const { rows } = await query<{ stat_date: Date; qty: string }>(
    `SELECT stat_date, sum(qty_sold) AS qty
       FROM sales_stats_daily
       ${where}
       GROUP BY stat_date
       ORDER BY stat_date`,
    params,
  );
  return rows.map((r) => ({
    date: toIsoDate(r.stat_date),
    qty: Number(r.qty),
  }));
}

function emptyEcosystem(): EcosystemResponse {
  return {
    poster_status: {
      last_sync_at: null,
      last_sync_status: null,
      sync_errors_24h: 0,
      sales_today_count: 0,
      sales_today_sum: 0,
    },
    chain_flow: [],
    alerts_feed: [],
    sales_chart: { days: [] },
  };
}

// =============================================================================
// F4.6 — GET /api/dashboard/chain-layer/:type
// =============================================================================
//
// One aggregate the UI uses to render a single "chain layer" page (raw,
// production, supply, central_warehouse, or store). Every layer page wants
// the same skeleton — locations on this layer with per-location KPIs,
// rolled-up totals, and the most recent movements — plus a few layer-specific
// totals (active production orders for `production`, pending shipments for
// `supply`/`central_warehouse`, today's sales count for `store`).
//
// RBAC:
//   - pm + ai_assistant — every location of the requested type.
//   - the matching layer's manager role — only locations from the type set
//     that intersect their assigned `locationIds`.
//   - any other role — 403 (the supply_manager has no business on the raw
//     warehouse layer page, etc.).
//
// Performance: every sub-query is bounded (recent_movements LIMIT 20) and
// fans out via Promise.all. Same < 1s budget as /overview.
// -----------------------------------------------------------------------------

const CHAIN_LAYER_RECENT_MOVEMENTS = 20;

const CHAIN_LAYER_TYPES = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;
type ChainLayerType = (typeof CHAIN_LAYER_TYPES)[number];

/** The single role that manages each layer. PM + ai_assistant pass any layer. */
const LAYER_MANAGER_ROLE: Record<ChainLayerType, Role> = {
  raw_warehouse: 'raw_warehouse_manager',
  production: 'production_manager',
  supply: 'supply_manager',
  central_warehouse: 'central_warehouse_manager',
  store: 'store_manager',
};

type ChainLayerLocation = {
  id: number;
  name: string;
  type: ChainLayerType;
  total_products: number;
  below_min_count: number;
  open_requests_count: number;
};

type ChainLayerTotals = {
  total_locations: number;
  total_products: number;
  below_min_count: number;
  open_requests_count: number;
  active_production_orders?: number;
  pending_shipments?: number;
  sales_today_count?: number;
};

type ChainLayerResponse = {
  layer_type: ChainLayerType;
  locations: ChainLayerLocation[];
  totals: ChainLayerTotals;
  recent_movements: RecentMovementItem[];
};

type LayerScope =
  | { kind: 'chain'; type: ChainLayerType }
  | { kind: 'locations'; type: ChainLayerType; locationIds: number[] }
  | { kind: 'empty'; type: ChainLayerType };

dashboardRouter.get(
  '/chain-layer/:type',
  authenticate,
  // Authorize is broad here — the handler narrows per-layer (`LAYER_MANAGER_ROLE`).
  // A non-matching scoped role hits a clean 403 instead of a generic gate.
  authorize(
    'pm',
    'ai_assistant',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const rawType = req.params.type ?? '';
    if (!(CHAIN_LAYER_TYPES as readonly string[]).includes(rawType)) {
      throw AppError.validation(
        `"type" must be one of: ${CHAIN_LAYER_TYPES.join(', ')}.`,
      );
    }
    const layerType = rawType as ChainLayerType;

    // RBAC: only pm / ai_assistant / the matching layer manager pass.
    if (
      !isSuperAdmin(principal) &&
      principal.role !== 'ai_assistant' &&
      principal.role !== LAYER_MANAGER_ROLE[layerType]
    ) {
      throw AppError.forbidden('You may not view this chain layer.');
    }

    // F4.9 — recent_movements + (store layer) sales_today_count clip to range.
    const range = parseDateRange(req.query);

    const scope = resolveLayerScope(principal, layerType);
    if (scope.kind === 'empty') {
      res.status(200).json(emptyChainLayer(layerType));
      return;
    }

    const [locations, layerExtras, recent] = await Promise.all([
      fetchChainLayerLocations(scope),
      fetchChainLayerExtras(scope, range),
      fetchChainLayerRecentMovements(scope, range),
    ]);

    const totals: ChainLayerTotals = {
      total_locations: locations.length,
      total_products: locations.reduce((sum, l) => sum + l.total_products, 0),
      below_min_count: locations.reduce((sum, l) => sum + l.below_min_count, 0),
      open_requests_count: locations.reduce((sum, l) => sum + l.open_requests_count, 0),
    };
    if (layerType === 'production') {
      totals.active_production_orders = layerExtras.activeProductionOrders;
    }
    if (layerType === 'supply' || layerType === 'central_warehouse') {
      totals.pending_shipments = layerExtras.pendingShipments;
    }
    if (layerType === 'store') {
      totals.sales_today_count = layerExtras.salesTodayCount;
    }

    const response: ChainLayerResponse = {
      layer_type: layerType,
      locations,
      totals,
      recent_movements: recent,
    };
    res.status(200).json(response);
  }),
);

function resolveLayerScope(
  principal: AuthPrincipal,
  layerType: ChainLayerType,
): LayerScope {
  if (isSuperAdmin(principal) || principal.role === 'ai_assistant') {
    return { kind: 'chain', type: layerType };
  }
  if (principal.locationIds.length === 0) {
    return { kind: 'empty', type: layerType };
  }
  return {
    kind: 'locations',
    type: layerType,
    locationIds: principal.locationIds,
  };
}

/** One row per active location of the requested type, with KPIs. */
async function fetchChainLayerLocations(
  scope: Exclude<LayerScope, { kind: 'empty' }>,
): Promise<ChainLayerLocation[]> {
  const params: SqlParam[] = [scope.type];
  let where = 'WHERE l.type = $1 AND l.is_active = TRUE';
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND l.id = ANY($${params.length}::bigint[])`;
  }

  const { rows } = await query<{
    id: string;
    name: string;
    type: string;
    total_products: string;
    below_min_count: string;
    open_requests_count: string;
  }>(
    `SELECT l.id, l.name, l.type::text AS type,
            coalesce(tp.total_products, 0)       AS total_products,
            coalesce(bm.below_min_count, 0)      AS below_min_count,
            coalesce(orq.open_requests_count, 0) AS open_requests_count
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT count(*) AS total_products
           FROM stock s WHERE s.location_id = l.id
       ) tp ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS below_min_count
           FROM stock s WHERE s.location_id = l.id AND s.qty <= s.min_level
       ) bm ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS open_requests_count
           FROM replenishment_requests rr
          WHERE rr.requester_location_id = l.id
            AND rr.status NOT IN ('CLOSED','CANCELLED')
       ) orq ON TRUE
       ${where}
       ORDER BY l.id`,
    params,
  );

  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    type: r.type as ChainLayerType,
    total_products: Number(r.total_products),
    below_min_count: Number(r.below_min_count),
    open_requests_count: Number(r.open_requests_count),
  }));
}

/**
 * Layer-specific extras: active production orders (production layer), pending
 * shipments (supply + central_warehouse layers), today's sales count (store
 * layer). Always returns all three fields — the handler only emits the ones
 * relevant to the requested layer.
 */
async function fetchChainLayerExtras(
  scope: Exclude<LayerScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<{
  activeProductionOrders: number;
  pendingShipments: number;
  salesTodayCount: number;
}> {
  const layerType = scope.type;
  const locFilter = scope.kind === 'locations' ? scope.locationIds : null;

  // Active production orders — only when the layer is production. A PO lives
  // on `production` locations, so the location filter is the scope's id set.
  const activeProdPromise =
    layerType === 'production'
      ? (async () => {
          const params: SqlParam[] = [];
          let where = `WHERE po.status IN ('${ACTIVE_PO_STATUSES.join("','")}')`;
          if (locFilter !== null) {
            params.push(locFilter);
            where += ` AND po.location_id = ANY($${params.length}::bigint[])`;
          } else {
            // chain — implicit `po.location_id IN (every production location)`,
            // but every PO already targets a production location so no extra
            // filter is needed.
          }
          const r = await query<SimpleCountRaw>(
            `SELECT count(*) AS cnt FROM production_orders po ${where}`,
            params,
          );
          return Number(r.rows[0]?.cnt ?? 0);
        })()
      : Promise.resolve(0);

  // Pending shipments — open replenishment_requests where the target is one
  // of the layer's locations. "Pending" = not yet terminal (per the
  // `replenishment_status` enum, the terminal states are CLOSED and
  // CANCELLED).
  const pendingShipmentsPromise =
    layerType === 'supply' || layerType === 'central_warehouse'
      ? (async () => {
          const params: SqlParam[] = [layerType];
          let where =
            `WHERE rr.status NOT IN ('CLOSED','CANCELLED') AND tl.type = $1`;
          if (locFilter !== null) {
            params.push(locFilter);
            where += ` AND rr.target_location_id = ANY($${params.length}::bigint[])`;
          }
          const r = await query<SimpleCountRaw>(
            `SELECT count(*) AS cnt
               FROM replenishment_requests rr
               JOIN locations tl ON tl.id = rr.target_location_id
               ${where}`,
            params,
          );
          return Number(r.rows[0]?.cnt ?? 0);
        })()
      : Promise.resolve(0);

  // Sales count in the requested range — only on the store layer.
  // (Field is named `salesTodayCount` for backward compat with the response
  // schema; semantically it is "sales in range".)
  const salesTodayPromise =
    layerType === 'store'
      ? (async () => {
          const params: SqlParam[] = [range.from, range.to];
          let where = `WHERE sold_at >= $1 AND sold_at < $2`;
          if (locFilter !== null) {
            params.push(locFilter);
            where += ` AND store_id = ANY($${params.length}::bigint[])`;
          }
          const r = await query<SimpleCountRaw>(
            `SELECT count(*) AS cnt FROM sales ${where}`,
            params,
          );
          return Number(r.rows[0]?.cnt ?? 0);
        })()
      : Promise.resolve(0);

  const [activeProductionOrders, pendingShipments, salesTodayCount] =
    await Promise.all([activeProdPromise, pendingShipmentsPromise, salesTodayPromise]);
  return { activeProductionOrders, pendingShipments, salesTodayCount };
}

/**
 * Recent movements touching the layer. A movement "touches" the layer when
 * either its source or destination is a location of the requested type
 * (and, for a scoped principal, also in their assigned set).
 */
async function fetchChainLayerRecentMovements(
  scope: Exclude<LayerScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<RecentMovementItem[]> {
  const params: SqlParam[] = [scope.type];
  let where =
    `WHERE (fl.type = $1 OR tl.type = $1)`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where +=
      ` AND (m.from_location_id = ANY($${params.length}::bigint[]) ` +
      `OR m.to_location_id = ANY($${params.length}::bigint[]))`;
  }
  // F4.9 — clip to range.
  params.push(range.from);
  where += ` AND m.created_at >= $${params.length}`;
  params.push(range.to);
  where += ` AND m.created_at < $${params.length}`;
  params.push(CHAIN_LAYER_RECENT_MOVEMENTS);
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
  return rows.map(mapMovement);
}

function emptyChainLayer(layerType: ChainLayerType): ChainLayerResponse {
  const totals: ChainLayerTotals = {
    total_locations: 0,
    total_products: 0,
    below_min_count: 0,
    open_requests_count: 0,
  };
  if (layerType === 'production') totals.active_production_orders = 0;
  if (layerType === 'supply' || layerType === 'central_warehouse') {
    totals.pending_shipments = 0;
  }
  if (layerType === 'store') totals.sales_today_count = 0;
  return {
    layer_type: layerType,
    locations: [],
    totals,
    recent_movements: [],
  };
}
