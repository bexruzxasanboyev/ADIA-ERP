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
import { parseDateRange, toPosterDate, type DateRange } from '../lib/dateRange.js';
import type { AuthPrincipal } from '../auth/jwt.js';
import type { Role } from '../auth/roles.js';

export const dashboardRouter: Router = Router();

/** How many of the most-recent stock movements the overview returns. */
const RECENT_MOVEMENTS_LIMIT = 20;

/**
 * Business timezone for the single-company (Tashkent) Poster account.
 *
 * The hourly sales chart (ecosystem `sales_chart`) is fed by Poster
 * `dash.getAnalytics.data_hourly`, whose hour index is the account's LOCAL
 * Tashkent hour. Anything that buckets local `sales.sold_at` (a TIMESTAMPTZ,
 * stored at +05) into an hour MUST convert to this zone first — extracting the
 * hour in UTC lands an 08:11+05 sale in hour 3 instead of 8, mis-aligning the
 * breakdown tooltip with the chart x-axis. Used by the sales-breakdown route.
 */
const BUSINESS_TZ = 'Asia/Tashkent';

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
 *
 * The `min_level > 0 AND max_level > 0` guard mirrors the replenishment scan
 * rule (`services/replenishment.ts`: `qty <= min_level AND max_level > 0`): a
 * product with no configured threshold (e.g. a Poster-synced row at
 * min/max = 0) has no reorder point and must NOT count as below-min/critical.
 * This is the SINGLE source the M8 `below_min` array AND the `below_min_count`
 * KPI both derive from, so the dashboard's critical count is internally
 * consistent.
 */
async function fetchBelowMin(scope: Exclude<Scope, { kind: 'empty' }>): Promise<BelowMinRaw[]> {
  const params: SqlParam[] = [];
  let where = 'WHERE s.qty <= s.min_level AND s.min_level > 0 AND s.max_level > 0';
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
  /**
   * Production-only KPI: count of `production_orders` at this location in
   * `new` or `in_progress` status. `null` for non-production locations so
   * the frontend can branch on type without an extra lookup.
   */
  active_production_orders: number | null;
  /**
   * Production-only KPI: count of `production_orders` at this location
   * completed (`status='done'`, `done_at` falls on the current date).
   * `null` for non-production locations.
   */
  done_today_count: number | null;
};

// ---------------------------------------------------------------------------
// F4.4 / Dashboard MEGA Redesign Sprint B — `chain_summary`
// ---------------------------------------------------------------------------
//
// One row PER LOCATION TYPE (not per location). The `ChainFlowRow` UI renders
// exactly 5 cards — one per supply-chain stage — and needs aggregate counts
// across every location of that type plus a type-specific "pulse" metric for
// today. `chain_flow` (row per location) stays untouched for the existing
// `EcosystemHealthBar` consumer and the M8 overview screen.
//
// Status thresholds (plan §10, owner-approved):
//   below_min == 0     -> ok
//   below_min in 1..3  -> warn
//   below_min >= 4     -> danger
//
// The pulse shape is a discriminated union keyed by `type` so the frontend
// can render per-stage micro-content (today inflow/outflow for raw, active
// orders for production, etc.). Each pulse field is a number for the UI to
// format with units — never a pre-formatted string (i18n + dark theme tone).
// ---------------------------------------------------------------------------

const CHAIN_TYPES = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;
type ChainType = (typeof CHAIN_TYPES)[number];

type ChainStatus = 'ok' | 'warn' | 'danger';

/**
 * Per-stage pulse — today's activity highlight.
 *
 * Sprint C+ — every variant carries the original Sprint-B fields PLUS the
 * "expanded" KPIs the new `ChainCard` wants to render (4 → 6 stats per stage,
 * 10 for the store). New fields are additive — existing consumers stay
 * unchanged. Field naming is snake_case to match the rest of the API.
 */
type ChainPulse =
  | {
      kind: 'raw';
      // Sprint B
      received_today: number;
      issued_today: number;
      // Sprint C
      /** Open `purchase_orders` whose target is a raw warehouse. */
      pending_purchase_orders: number;
      /**
       * Total qty held at raw warehouses, grouped by `products.unit`. The
       * eskiz wants "ombor sig'imi" broken down per unit so kg / l / pcs
       * are never collapsed into a meaningless scalar.
       */
      total_qty_by_unit: Array<{ unit: string; qty: number }>;
    }
  | {
      kind: 'production';
      // Sprint B
      active_orders: number;
      done_today: number;
      // Sprint C
      /** Production orders whose `deadline < CURRENT_DATE` and still open. */
      overdue_orders: number;
      /** Active `production` locations (sex_count). */
      sex_count: number;
      /** Today's `production_input` (raw consumed by sexes). */
      input_today: number;
      /** Today's `production_output` (qty produced by sexes). */
      output_today: number;
    }
  | {
      kind: 'supply';
      // Sprint B
      shipped_today: number;
      received_today: number;
      // Sprint C
      /** Open replenishment requests routed through a supply location. */
      open_requests: number;
      /** Distinct destinations a supply location served today. */
      top_destination_count: number;
    }
  | {
      kind: 'central';
      // Sprint B
      last_sync_at: string | null;
      last_sync_status: 'ok' | 'partial' | 'failed' | null;
      // Sprint C
      /** Failed poster_sync_log rows in the last 24h. */
      sync_errors_24h: number;
    }
  | {
      kind: 'store';
      // Sprint B
      sales_today_sum: number;
      receipts_today: number;
      // Sprint C
      /** sales_today_sum / receipts_today (0 if no receipts). */
      avg_receipt_today: number;
      /** Open replenishment requests originating from a store. */
      open_replenishments: number;
      /** Transfer movements arriving at a store in the last 24h with a */
      /** replenishment link (i.e. recent transit deliveries).          */
      transit_count: number;
      /** Best-selling product name today (across the principal's stores). */
      top_product_name: string | null;
      /** Total qty (units) sold today across the principal's stores. */
      qty_today: number;
    };

type ChainSummaryNode = {
  type: ChainType;
  location_count: number;
  total_products: number;
  below_min_count: number;
  status: ChainStatus;
  pulse: ChainPulse;
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

/**
 * One point on the sales chart.
 *
 * F4.9-hourly — the series carries a `granularity` discriminator (on the
 * wrapper) so the chart never collapses to a single point on `range=today`.
 * When `granularity === 'hour'` every point also carries `hour` (0..23) and
 * `date` is today's ISO date for every point. When `granularity === 'day'`
 * the `hour` field is absent and `date` is the bucket day (unchanged).
 */
type SalesChartItem = {
  date: string; // YYYY-MM-DD
  hour?: number; // 0-23, PRESENT IFF the wrapper granularity === 'hour'
  qty: number;
  amount: number; // so'm
};

/** Chart granularity discriminator — `hour` only on the `range=today` path. */
type SalesChartGranularity = 'hour' | 'day';

/**
 * D-0026 (2026-05-28) — explicit M:N supply-chain edge, sourced from the
 * `location_flows` junction table. Until 0026 the canvas inferred edges
 * from `locations.parent_id` (a 1:N tree) which could not express the
 * Tort sexi → {Tort skladi, Yarim Fabrika skladi} fan-out or the BOM
 * re-entry loop from Yarim Fabrika skladi back into the sexes.
 *
 * `flow_type` is one of:
 *   production_output — sex → its sklad (or shared Yarim Fabrika sklad).
 *   bom_input         — Yarim Fabrika sklad → sex (semi-finished re-use).
 *   forward           — sex_storage → markaziy sklad (and onward).
 *   reverse           — markaziy → upstream (returns / claw-backs).
 */
type ChainEdge = {
  from: number;
  to: number;
  type: 'production_output' | 'bom_input' | 'forward' | 'reverse';
};

type EcosystemResponse = {
  poster_status: PosterStatusBlock;
  chain_flow: ChainFlowItem[];
  /**
   * Sprint B — one entry per supply-chain stage visible to the principal.
   * PM / ai_assistant see all 5 stages; a scoped manager sees only the
   * stages that intersect their assigned locations (typically one).
   */
  chain_summary: ChainSummaryNode[];
  /**
   * D-0026 — explicit M:N edges between supply-chain locations. Backed
   * by the `location_flows` table (migration 0026). Scoped principals
   * see only edges whose `from` OR `to` is in their assigned set.
   */
  chain_edges: ChainEdge[];
  alerts_feed: AlertsFeedItem[];
  /**
   * F4.9-hourly — `granularity` tells the chart whether `days` holds daily
   * buckets (`'day'`, unchanged) or hourly buckets (`'hour'`, only on
   * `range=today`). The field stays named `days` for back-compat.
   */
  sales_chart: { granularity: SalesChartGranularity; days: SalesChartItem[] };
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

    // D-0028 — Poster is the single source of truth for revenue. Make the ONE
    // Poster call up-front and share its result between `poster_status`
    // (range total + cheque count) and `sales_chart` (per-day so'm amount), so
    // a single `?range` request never hits Poster twice.
    const posterRevenue = await fetchPosterRevenue(scope, range);

    const [
      posterStatus,
      chainFlow,
      chainSummary,
      chainEdges,
      alertsFeed,
      salesChart,
    ] = await Promise.all([
      fetchPosterStatus(posterRevenue),
      fetchChainFlow(scope),
      fetchChainSummary(scope),
      fetchChainEdges(scope),
      fetchAlertsFeed(principal),
      fetchSalesChart(scope, range, posterRevenue),
    ]);

    const response: EcosystemResponse = {
      poster_status: posterStatus,
      chain_flow: chainFlow,
      chain_summary: chainSummary,
      chain_edges: chainEdges,
      alerts_feed: alertsFeed,
      sales_chart: { granularity: salesChart.granularity, days: salesChart.days },
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
 * D-0028 (2026-06-01) — POSTER IS THE SINGLE SOURCE OF TRUTH FOR REVENUE.
 *
 * The local `sales` table money column is unreliable (mixed units: real
 * Poster-synced rows arrive in TIYIN, older synthetic seed rows are in so'm),
 * so `sum(qty*price)` over it is not a trustworthy revenue figure. The owner
 * decided dashboard tushum must come from Poster `dash.getPaymentsReport` —
 * the same source the `/revenue-breakdown` card already reads correctly.
 *
 * This helper makes the ONE Poster call the ecosystem endpoint needs and
 * returns, for the requested `?range` (+ RBAC scope):
 *   - `total`   : the range revenue total in so'm (sum of `total.payed_sum_sum`,
 *                 ÷100 via `tiyinToSom`) — reconciles with RevenueBreakdown.
 *   - `count`   : the range cheque count (`total.transactions_count`).
 *   - `perDay`  : a per-DAY revenue series `[{date 'YYYY-MM-DD', amount so'm}]`,
 *                 read from the report's `days[]` block (each day carries its
 *                 own explicit `date` + `payed_sum_sum`, ÷100). We use `days[]`
 *                 rather than `getAnalytics(interpolate=day)` because the days
 *                 are EXPLICITLY DATED (no positional index-from-dateFrom
 *                 alignment guesswork, no gaps-as-zero ambiguity) and come from
 *                 the SAME report as the total/split — one call, one unit
 *                 convention, fully consistent with RevenueBreakdown.
 *
 * Date bounds mirror the revenue-breakdown route: `dateFrom = toPosterDate(
 * range.from)`, `dateTo = toPosterDate(range.to - 1ms)` (the inclusive last
 * day of the half-open `[from, to)` window).
 *
 * RBAC: a `chain`-scoped principal (PM / ai_assistant / central / supply)
 * queries Poster chain-wide (no `spotId`). A `locations`-scoped principal is
 * restricted to the Poster `poster_spot_id`(s) of their assigned STORE
 * locations; with >1 spot we call once per spot and SUM totals/counts and
 * merge the per-day series. Stores with no `poster_spot_id` contribute
 * nothing.
 *
 * RESILIENCE: any Poster failure resolves to ZEROES (never throws) so a Poster
 * outage cannot 500 the whole `/api/dashboard/ecosystem` payload — the rest of
 * the dashboard (chain_flow, alerts, local qty) still renders.
 */
type PosterRevenue = {
  total: number;
  count: number;
  perDay: Map<string, number>;
  /**
   * F4.9-hourly — per-hour revenue (so'm), index 0..23, populated ONLY when
   * `range.preset === 'today'` (otherwise `null`). Sourced from Poster
   * `dash.getAnalytics.data_hourly`, which is ALREADY in so'm (NOT tiyin —
   * see `PosterAnalytics` unit note), so NO ÷100 is applied here (the daily
   * path divides only because `getPaymentsReport` is in tiyin).
   */
  perHour: number[] | null;
  /**
   * F4.9-hourly — per-hour TRANSACTION COUNTS (cheque/sales count), index
   * 0..23, populated ONLY when `range.preset === 'today'` (otherwise `null`).
   * Sourced from a SECOND Poster `dash.getAnalytics` call with
   * `select=transactions`, whose `data_hourly` returns per-hour counts. This
   * is the hourly `qty` ("Sotuv soni") source — Poster has no other hourly
   * unit/count series. A counts value is an integer (no ÷100). Falls back to
   * an all-zero array if the transactions call fails (revenue still renders).
   */
  perHourQty: number[] | null;
};

async function fetchPosterRevenue(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<PosterRevenue> {
  const empty: PosterRevenue = {
    total: 0,
    count: 0,
    perDay: new Map(),
    // Hourly only matters for the today path; keep it null for wider ranges
    // and for every failure/short-circuit fallback.
    perHour: range.preset === 'today' ? new Array<number>(24).fill(0) : null,
    perHourQty: range.preset === 'today' ? new Array<number>(24).fill(0) : null,
  };
  try {
    // Lazy imports — the ecosystem endpoint otherwise never touches Poster, so
    // we mirror the revenue-breakdown route and only pull the client in when a
    // call is actually made (keeps cold-start + test-stub seams identical).
    const { tiyinToSom } = await import('../integrations/poster/posterMoney.js');
    const { createPosterClientFromConfig } = await import(
      '../integrations/poster/client.js'
    );

    // Resolve the spot scope. PM/global/central/supply -> chain-wide (no spot).
    // A locations-scoped principal -> the poster_spot_id of their assigned
    // STORE locations. No mapped spot -> zero contribution.
    let spotIds: number[] | null = null; // null = chain-wide (no spotId param)
    if (scope.kind === 'locations') {
      const { rows } = await query<{ poster_spot_id: string }>(
        `SELECT DISTINCT poster_spot_id
           FROM locations
          WHERE id = ANY($1::bigint[])
            AND type = 'store'
            AND is_active = TRUE
            AND poster_spot_id IS NOT NULL`,
        [scope.locationIds],
      );
      spotIds = rows.map((r) => Number(r.poster_spot_id));
      // Scoped principal whose stores map to NO Poster spot -> nothing to ask.
      if (spotIds.length === 0) return empty;
    }

    const client = createPosterClientFromConfig();
    const dateFrom = toPosterDate(range.from);
    const dateTo = toPosterDate(new Date(range.to.getTime() - 1));

    // One call chain-wide, OR one call per assigned spot (summed/merged).
    const calls =
      spotIds === null
        ? [client.getPaymentsReport({ dateFrom, dateTo })]
        : spotIds.map((spotId) =>
            client.getPaymentsReport({ dateFrom, dateTo, spotId }),
          );

    // F4.9-hourly — on the today path we ALSO pull `dash.getAnalytics`
    // (data_hourly) so the chart renders one point per hour instead of a
    // single daily point. We make TWO analytics fetches per scope:
    //   - `select=revenue`      -> data_hourly = per-hour revenue (so'm).
    //   - `select=transactions` -> data_hourly = per-hour TRANSACTION COUNTS
    //                              (the "Sotuv soni" qty source).
    // Both are already final-unit (revenue so'm, counts integer) — no ÷100.
    // One call chain-wide, or one per assigned spot (summed element-wise).
    // Each fetch is wrapped in its own try/catch so a hourly-analytics failure
    // (either series) never drops the daily revenue figures, and a transactions
    // failure leaves qty at 0 without breaking the revenue series.
    const wantHourly = range.preset === 'today';
    type Analytics = Awaited<ReturnType<typeof client.getAnalytics>>;
    const revenueAnalyticsCalls: Array<Promise<Analytics>> = !wantHourly
      ? []
      : spotIds === null
        ? [client.getAnalytics({ dateFrom, dateTo, interpolate: 'day', select: 'revenue' })]
        : spotIds.map((spotId) =>
            client.getAnalytics({ dateFrom, dateTo, interpolate: 'day', select: 'revenue', spotId }),
          );
    const txAnalyticsCalls: Array<Promise<Analytics>> = !wantHourly
      ? []
      : spotIds === null
        ? [client.getAnalytics({ dateFrom, dateTo, interpolate: 'day', select: 'transactions' })]
        : spotIds.map((spotId) =>
            client.getAnalytics({ dateFrom, dateTo, interpolate: 'day', select: 'transactions', spotId }),
          );

    // Fire payments + both analytics series in parallel to stay within the
    // AC4.4.6 P95 < 1000ms budget — the second analytics call adds no
    // serial latency.
    const [reports, revenueAnalytics, txAnalytics] = await Promise.all([
      Promise.all(calls),
      Promise.all(revenueAnalyticsCalls).catch((err) => {
        console.error('[dashboard/ecosystem] Poster hourly revenue analytics failed:', err);
        return [] as Analytics[];
      }),
      Promise.all(txAnalyticsCalls).catch((err) => {
        console.error('[dashboard/ecosystem] Poster hourly transactions analytics failed:', err);
        return [] as Analytics[];
      }),
    ]);

    const out: PosterRevenue = {
      total: 0,
      count: 0,
      perDay: new Map(),
      perHour: wantHourly ? new Array<number>(24).fill(0) : null,
      perHourQty: wantHourly ? new Array<number>(24).fill(0) : null,
    };
    for (const report of reports) {
      // The legacy per-method row-array shape carries no day/total split, so
      // only the real `{days, total}` aggregate contributes here.
      if (report === null || report === undefined || Array.isArray(report)) {
        continue;
      }
      out.total += tiyinToSom(report.total?.payed_sum_sum);
      out.count += toCount(report.total?.transactions_count);
      for (const day of report.days ?? []) {
        if (typeof day.date !== 'string') continue;
        const som = tiyinToSom(day.payed_sum_sum);
        out.perDay.set(day.date, (out.perDay.get(day.date) ?? 0) + som);
      }
    }
    // Sum the per-spot revenue `data_hourly` series element-wise. Values are
    // so'm already (NOT tiyin) — see PosterAnalytics — so no ÷100.
    if (out.perHour !== null) {
      const perHour = out.perHour;
      for (const a of revenueAnalytics) {
        const hourly = a?.data_hourly;
        if (!Array.isArray(hourly)) continue;
        for (let h = 0; h < 24 && h < hourly.length; h++) {
          const v = Number(hourly[h]);
          if (Number.isFinite(v)) perHour[h] = (perHour[h] ?? 0) + v;
        }
      }
    }
    // Sum the per-spot transactions `data_hourly` series element-wise. Values
    // are per-hour transaction COUNTS (the hourly qty / "Sotuv soni" source) —
    // integers, no ÷100. Aggregated exactly like the revenue path above.
    if (out.perHourQty !== null) {
      const perHourQty = out.perHourQty;
      for (const a of txAnalytics) {
        const hourly = a?.data_hourly;
        if (!Array.isArray(hourly)) continue;
        for (let h = 0; h < 24 && h < hourly.length; h++) {
          const v = Number(hourly[h]);
          if (Number.isFinite(v)) perHourQty[h] = (perHourQty[h] ?? 0) + v;
        }
      }
    }
    // Round the aggregate total (per-day buckets are summed raw then rounded
    // at the merge site in fetchSalesChart).
    out.total = Math.round(out.total * 100) / 100;
    return out;
  } catch (err) {
    // RESILIENCE — Poster down / token missing / network error must NOT 500
    // the dashboard. Log and fall back to zeroes.
    console.error('[dashboard/ecosystem] Poster revenue fetch failed:', err);
    return empty;
  }
}

/** Coerce a Poster `transactions_count` (string|number|undefined) to an int. */
function toCount(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Poster status block.
 *   - last_sync_*  : the most recent `poster_sync_log` row (any entity).
 *   - sync_errors_24h: count of `failed` rows in the last 24h.
 *   - sales_today_* : D-0028 — sourced from Poster `dash.getPaymentsReport`
 *     (the single source of truth for revenue), windowed to `?range` and
 *     scoped to the principal's assigned store spots. `sales_today_sum` is the
 *     range revenue total (so'm); `sales_today_count` is the cheque count.
 *     `last_sync_*` / `sync_errors_24h` stay DB-sourced (sync health is a
 *     backend-wide event, not a Poster revenue figure).
 */
async function fetchPosterStatus(
  revenue: PosterRevenue,
): Promise<PosterStatusBlock> {
  const [lastSync, errors24h] = await Promise.all([
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
  ]);

  const lastRow = lastSync.rows[0];
  const lastWhen = lastRow?.finished_at ?? lastRow?.started_at ?? null;

  return {
    last_sync_at: lastWhen === null ? null : lastWhen.toISOString(),
    last_sync_status: lastRow?.status ?? null,
    sync_errors_24h: Number(errors24h.rows[0]?.cnt ?? 0),
    sales_today_count: revenue.count,
    sales_today_sum: revenue.total,
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
    active_production_orders: string | null;
    done_today_count: string | null;
  }>(
    // The production sub-aggregates run via correlated LATERAL joins gated by
    // `l.type = 'production'` so they are short-circuited for every other
    // chain stage — keeps the existing query plan (raw/supply/central/store)
    // unchanged while adding sex-only KPIs.
    `SELECT l.id              AS location_id,
            l.name            AS location_name,
            l.type::text      AS location_type,
            coalesce(bm.below_min_count, 0)   AS below_min_count,
            coalesce(orq.open_requests_count, 0) AS open_requests_count,
            coalesce(tp.total_products, 0)    AS total_products,
            CASE WHEN l.type = 'production'
                 THEN coalesce(po_active.cnt, 0)
                 ELSE NULL END                AS active_production_orders,
            CASE WHEN l.type = 'production'
                 THEN coalesce(po_done.cnt, 0)
                 ELSE NULL END                AS done_today_count
       FROM locations l
       LEFT JOIN LATERAL (
         SELECT count(*) AS below_min_count
           FROM stock s
          WHERE s.location_id = l.id
            AND s.qty <= s.min_level
            AND s.min_level > 0
            AND s.max_level > 0
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
       LEFT JOIN LATERAL (
         SELECT count(*) AS cnt
           FROM production_orders po
          WHERE l.type = 'production'
            AND po.location_id = l.id
            AND po.status IN ('new','in_progress')
       ) po_active ON TRUE
       LEFT JOIN LATERAL (
         SELECT count(*) AS cnt
           FROM production_orders po2
          WHERE l.type = 'production'
            AND po2.location_id = l.id
            AND po2.status = 'done'
            AND po2.done_at >= date_trunc('day', now())
            AND po2.done_at <  date_trunc('day', now()) + interval '1 day'
       ) po_done ON TRUE
       ${where}
       ORDER BY CASE l.type
                  WHEN 'raw_warehouse'      THEN 1
                  WHEN 'production'         THEN 2
                  WHEN 'sex_storage'        THEN 3
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
    active_production_orders:
      r.active_production_orders === null
        ? null
        : Number(r.active_production_orders),
    done_today_count:
      r.done_today_count === null ? null : Number(r.done_today_count),
  }));
}

/**
 * Sprint B — one summary row per supply-chain stage (raw / production /
 * supply / central / store).
 *
 * Strategy:
 *   1. A single SQL query (`base`) aggregates locations, products and below-
 *      min counts grouped by `locations.type`. Backed by `ix_stock_product`
 *      and the partial `ix_stock_below_min` index — for the seeded DB (38
 *      locations / 2,448 stock rows) this is sub-millisecond.
 *   2. Five small per-type "pulse" queries run in parallel. Each one is
 *      narrowly bounded (single-day `created_at::date = CURRENT_DATE`
 *      filter; for `central` we hit `poster_sync_log` ordered by
 *      `started_at` LIMIT 1).
 *   3. A scoped principal (locations-kind) sees only the chain types that
 *      intersect their assigned `locationIds` — same UX as `chain_flow`.
 *
 * Notes:
 *   - For the `store` pulse we read `sales` directly (not `sales_stats_daily`)
 *     because today's row isn't aggregated yet — the cron runs nightly at
 *     03:00. The query is bounded by `sold_at >= CURRENT_DATE` and uses
 *     `ix_sales_store_date`.
 *   - For raw/production/supply pulses we use the existing
 *     `ix_movements_created` + `ix_movements_reason` indexes; same-day
 *     filter keeps the working set tiny.
 */
async function fetchChainSummary(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainSummaryNode[]> {
  // -------- base aggregate (counts + below-min) per chain type --------
  const baseParams: SqlParam[] = [];
  let locFilter = 'l.is_active = TRUE';
  if (scope.kind === 'locations') {
    baseParams.push(scope.locationIds);
    locFilter += ` AND l.id = ANY($${baseParams.length}::bigint[])`;
  }

  // D7 (2026-05-28) — fold the new `sex_storage` type into the historical
  // `supply` bucket so the 5-card chain_summary layout stays stable. After
  // migration 0022 every live "supply" row is actually `sex_storage`; the
  // frontend still reads the `supply` key for the sex skladi stage.
  const baseSql = `
    SELECT CASE WHEN l.type::text = 'sex_storage'
                THEN 'supply'
                ELSE l.type::text
           END                                                                    AS type,
           count(DISTINCT l.id)                                                    AS location_count,
           count(DISTINCT s.product_id) FILTER (WHERE s.product_id IS NOT NULL)    AS total_products,
           coalesce(sum(CASE
                          WHEN s.qty <= s.min_level AND s.min_level > 0 AND s.max_level > 0 THEN 1
                          ELSE 0
                        END), 0)                                                   AS below_min_count
      FROM locations l
      LEFT JOIN stock s ON s.location_id = l.id
     WHERE ${locFilter}
     GROUP BY 1
  `;

  type BaseRow = {
    type: string;
    location_count: string;
    total_products: string;
    below_min_count: string;
  };
  const baseRes = await query<BaseRow>(baseSql, baseParams);

  const baseByType = new Map<ChainType, BaseRow>();
  for (const r of baseRes.rows) {
    if ((CHAIN_TYPES as readonly string[]).includes(r.type)) {
      baseByType.set(r.type as ChainType, r);
    }
  }

  // No locations matched -> nothing to summarise. PM still gets 5 nodes
  // (even empty stages stay in the response so the UI can render them).
  if (baseByType.size === 0 && scope.kind === 'locations') {
    return [];
  }

  // -------- pulses (5 small parallel queries) --------
  const [raw, production, supply, central, store] = await Promise.all([
    fetchRawPulse(scope),
    fetchProductionPulse(scope),
    fetchSupplyPulse(scope),
    fetchCentralPulse(scope),
    fetchStorePulse(scope),
  ]);

  const pulsesByType: Record<ChainType, ChainPulse> = {
    raw_warehouse: raw,
    production,
    supply,
    central_warehouse: central,
    store,
  };

  // For PM/ai_assistant always emit all 5 types (so the UI keeps a stable
  // 5-card row even when one stage has no locations yet — e.g. a fresh
  // tenant with no production sex seeded). For scoped principals, only
  // emit the types they actually have access to (matches chain_flow UX).
  const types: ChainType[] =
    scope.kind === 'chain'
      ? [...CHAIN_TYPES]
      : ([...CHAIN_TYPES] as ChainType[]).filter((t) => baseByType.has(t));

  return types.map<ChainSummaryNode>((type) => {
    const row = baseByType.get(type);
    const belowMin = row ? Number(row.below_min_count) : 0;
    return {
      type,
      location_count: row ? Number(row.location_count) : 0,
      total_products: row ? Number(row.total_products) : 0,
      below_min_count: belowMin,
      status: deriveChainStatus(belowMin),
      pulse: pulsesByType[type],
    };
  });
}

function deriveChainStatus(belowMin: number): ChainStatus {
  if (belowMin === 0) return 'ok';
  if (belowMin <= 3) return 'warn';
  return 'danger';
}

/**
 * Builds a stock_movements `WHERE` fragment that scopes the pulse query to
 * locations of the given type(s), optionally intersected with the principal's
 * `locationIds`. Returned as a SQL snippet `(SELECT id FROM locations ...)`
 * — keeps the param list flat and easy to reason about.
 *
 * D7 (2026-05-28) — accepts a single type OR an array of types. The supply
 * stage now spans both the legacy `supply` (deprecated, kept as enum) and
 * the new `sex_storage` rows; callers pass `SUPPLY_PULSE_TYPES` so the
 * "supply" card in the 5-stage chain_summary keeps reporting the sex skladi
 * traffic after migration 0022 flips the live rows.
 */
function locationIdsForTypeSql(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  type: ChainType | readonly string[],
  params: SqlParam[],
): string {
  const types = Array.isArray(type) ? [...type] : [type as string];
  params.push(types);
  const typesIdx = params.length;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    const locIdx = params.length;
    return `(SELECT id FROM locations
              WHERE type::text = ANY($${typesIdx}::text[])
                AND is_active = TRUE
                AND id = ANY($${locIdx}::bigint[]))`;
  }
  return `(SELECT id FROM locations
            WHERE type::text = ANY($${typesIdx}::text[])
              AND is_active = TRUE)`;
}

/** D7 — the supply stage spans both legacy `supply` and new `sex_storage`. */
const SUPPLY_PULSE_TYPES = ['supply', 'sex_storage'] as const;

async function fetchRawPulse(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  // 1. Today's flow (received/issued) — same query as before.
  const flowParams: SqlParam[] = [];
  const locSql = locationIdsForTypeSql(scope, 'raw_warehouse', flowParams);
  const flowQ = query<{ received_today: string; issued_today: string }>(
    `SELECT
       coalesce(sum(qty) FILTER (
         WHERE reason = 'purchase' AND to_location_id IN ${locSql}
       ), 0) AS received_today,
       coalesce(sum(qty) FILTER (
         WHERE reason = 'production_input' AND from_location_id IN ${locSql}
       ), 0) AS issued_today
     FROM stock_movements
     WHERE created_at >= date_trunc('day', now())
       AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    flowParams,
  );

  // 2. Open purchase orders targeting a raw warehouse.
  const poParams: SqlParam[] = [];
  const poLocSql = locationIdsForTypeSql(scope, 'raw_warehouse', poParams);
  const poQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM purchase_orders
      WHERE status IN ('draft','approved')
        AND target_location_id IN ${poLocSql}`,
    poParams,
  );

  // 3. Total qty held at raw warehouses, grouped by `products.unit` so the UI
  //    can render "ombor sig'imi" per unit instead of collapsing kg / l / pcs
  //    into a meaningless scalar.
  const qtyParams: SqlParam[] = [];
  const qtyLocSql = locationIdsForTypeSql(scope, 'raw_warehouse', qtyParams);
  const qtyQ = query<{ unit: string; qty: string }>(
    `SELECT p.unit::text AS unit, coalesce(sum(s.qty), 0) AS qty
       FROM stock s
       JOIN products p ON p.id = s.product_id
      WHERE s.location_id IN ${qtyLocSql}
      GROUP BY p.unit
      ORDER BY p.unit`,
    qtyParams,
  );

  const [flow, po, qty] = await Promise.all([flowQ, poQ, qtyQ]);
  const f = flow.rows[0];
  return {
    kind: 'raw',
    received_today: Number(f?.received_today ?? 0),
    issued_today: Number(f?.issued_today ?? 0),
    pending_purchase_orders: Number(po.rows[0]?.cnt ?? 0),
    total_qty_by_unit: qty.rows.map((r) => ({
      unit: r.unit,
      qty: Number(r.qty),
    })),
  };
}

async function fetchProductionPulse(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  const params: SqlParam[] = [];
  const locSql = locationIdsForTypeSql(scope, 'production', params);
  const activeQ = query<{ active: string }>(
    `SELECT count(*) AS active
       FROM production_orders
      WHERE status IN ('new','in_progress')
        AND location_id IN ${locSql}`,
    params,
  );
  const doneParams: SqlParam[] = [];
  const doneLocSql = locationIdsForTypeSql(scope, 'production', doneParams);
  const doneQ = query<{ done: string }>(
    `SELECT count(*) AS done
       FROM production_orders
      WHERE status = 'done'
        AND done_at >= date_trunc('day', now())
        AND done_at <  date_trunc('day', now()) + interval '1 day'
        AND location_id IN ${doneLocSql}`,
    doneParams,
  );

  // Overdue: open production orders whose deadline has passed.
  const overdueParams: SqlParam[] = [];
  const overdueLocSql = locationIdsForTypeSql(scope, 'production', overdueParams);
  const overdueQ = query<{ overdue: string }>(
    `SELECT count(*) AS overdue
       FROM production_orders
      WHERE status IN ('new','in_progress')
        AND deadline IS NOT NULL
        AND deadline < CURRENT_DATE
        AND location_id IN ${overdueLocSql}`,
    overdueParams,
  );

  // sex_count: active production locations visible to the principal. We
  // bypass `locationIdsForTypeSql` (which returns an `IN (...)` subquery)
  // and reuse the same scope rules inline so we can SELECT count.
  const sexParams: SqlParam[] = [];
  let sexWhere = `type = 'production' AND is_active = TRUE`;
  if (scope.kind === 'locations') {
    sexParams.push(scope.locationIds);
    sexWhere += ` AND id = ANY($${sexParams.length}::bigint[])`;
  }
  const sexQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt FROM locations WHERE ${sexWhere}`,
    sexParams,
  );

  // input_today: qty consumed by sexes today (production_input leaving a
  // location that is itself a production sex — sex consumes from its own
  // raw bin per the BOM).
  const inputParams: SqlParam[] = [];
  const inputLocSql = locationIdsForTypeSql(scope, 'production', inputParams);
  const inputQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'production_input'
        AND from_location_id IN ${inputLocSql}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    inputParams,
  );

  // output_today: qty produced by sexes today.
  const outputParams: SqlParam[] = [];
  const outputLocSql = locationIdsForTypeSql(scope, 'production', outputParams);
  const outputQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'production_output'
        AND from_location_id IN ${outputLocSql}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    outputParams,
  );

  const [a, d, ov, sx, inp, out] = await Promise.all([
    activeQ,
    doneQ,
    overdueQ,
    sexQ,
    inputQ,
    outputQ,
  ]);
  return {
    kind: 'production',
    active_orders: Number(a.rows[0]?.active ?? 0),
    done_today: Number(d.rows[0]?.done ?? 0),
    overdue_orders: Number(ov.rows[0]?.overdue ?? 0),
    sex_count: Number(sx.rows[0]?.cnt ?? 0),
    input_today: Number(inp.rows[0]?.total ?? 0),
    output_today: Number(out.rows[0]?.total ?? 0),
  };
}

async function fetchSupplyPulse(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  const shipParams: SqlParam[] = [];
  const shipLocSql = locationIdsForTypeSql(scope, SUPPLY_PULSE_TYPES, shipParams);
  const shipQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'transfer'
        AND from_location_id IN ${shipLocSql}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    shipParams,
  );
  const recvParams: SqlParam[] = [];
  const recvLocSql = locationIdsForTypeSql(scope, SUPPLY_PULSE_TYPES, recvParams);
  const recvQ = query<{ total: string }>(
    `SELECT coalesce(sum(qty), 0) AS total
       FROM stock_movements
      WHERE reason = 'production_output'
        AND to_location_id IN ${recvLocSql}
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    recvParams,
  );

  // Open replenishment requests routed THROUGH a supply location. `supply`
  // is an intermediate hop, so it can appear as either the requester (the
  // supply chief asks for inputs) or the target (a store asks supply to
  // ship). We count rows where EITHER endpoint is a supply location in
  // scope and the request is not terminal.
  const openParams: SqlParam[] = [];
  const openLocSql = locationIdsForTypeSql(scope, SUPPLY_PULSE_TYPES, openParams);
  const openQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM replenishment_requests
      WHERE status NOT IN ('CLOSED','CANCELLED')
        AND (requester_location_id IN ${openLocSql}
             OR target_location_id IN ${openLocSql})`,
    openParams,
  );

  // Distinct destinations a supply location served today (today's transfer
  // fan-out count — useful for "today supply shipped to N stores").
  const destParams: SqlParam[] = [];
  const destLocSql = locationIdsForTypeSql(scope, SUPPLY_PULSE_TYPES, destParams);
  const destQ = query<{ cnt: string }>(
    `SELECT count(DISTINCT to_location_id) AS cnt
       FROM stock_movements
      WHERE reason = 'transfer'
        AND from_location_id IN ${destLocSql}
        AND to_location_id IS NOT NULL
        AND created_at >= date_trunc('day', now())
        AND created_at <  date_trunc('day', now()) + interval '1 day'`,
    destParams,
  );

  const [s, r, op, ds] = await Promise.all([shipQ, recvQ, openQ, destQ]);
  return {
    kind: 'supply',
    shipped_today: Number(s.rows[0]?.total ?? 0),
    received_today: Number(r.rows[0]?.total ?? 0),
    open_requests: Number(op.rows[0]?.cnt ?? 0),
    top_destination_count: Number(ds.rows[0]?.cnt ?? 0),
  };
}

async function fetchCentralPulse(
  _scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  // Poster sync is chain-wide (no per-location scoping makes sense — the
  // pulse mirrors poster_status.last_sync_at). We keep this query trivially
  // cheap by hitting the `ix_poster_sync_entity` index with LIMIT 1.
  const latestQ = query<{
    started_at: Date;
    finished_at: Date | null;
    status: 'ok' | 'partial' | 'failed';
  }>(
    `SELECT started_at, finished_at, status::text AS status
       FROM poster_sync_log
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
  );

  // Failed sync runs in the last 24h — quick chain-wide health gauge that
  // a store_manager wouldn't see, but a PM cares about.
  const errorsQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM poster_sync_log
      WHERE status = 'failed'
        AND started_at > now() - interval '24 hours'`,
  );

  const [latest, errors] = await Promise.all([latestQ, errorsQ]);
  const row = latest.rows[0];
  const when = row?.finished_at ?? row?.started_at ?? null;
  return {
    kind: 'central',
    last_sync_at: when === null ? null : when.toISOString(),
    last_sync_status: row?.status ?? null,
    sync_errors_24h: Number(errors.rows[0]?.cnt ?? 0),
  };
}

async function fetchStorePulse(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainPulse> {
  // Today's sales — read from `sales` (not `sales_stats_daily`) because the
  // daily aggregate cron only runs at 03:00, so today's row doesn't exist
  // mid-day. The window is tight (1 day) and `ix_sales_store_date` keeps
  // the scan bounded; even at 70k+ rows this stays sub-100ms.
  const params: SqlParam[] = [];
  let where = `sold_at >= date_trunc('day', now())
               AND sold_at <  date_trunc('day', now()) + interval '1 day'`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND store_id = ANY($${params.length}::bigint[])`;
  }
  const salesQ = query<{
    total_sum: string | null;
    receipts: string;
    qty_today: string | null;
  }>(
    `SELECT coalesce(sum(qty * price), 0)         AS total_sum,
            count(DISTINCT poster_transaction_id) AS receipts,
            coalesce(sum(qty), 0)                 AS qty_today
       FROM sales
      WHERE ${where}`,
    params,
  );

  // Open replenishments originating from a store the principal can see.
  const replParams: SqlParam[] = [];
  const replLocSql = locationIdsForTypeSql(scope, 'store', replParams);
  const replQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM replenishment_requests
      WHERE status NOT IN ('CLOSED','CANCELLED')
        AND requester_location_id IN ${replLocSql}`,
    replParams,
  );

  // Transit deliveries: transfer movements arriving at a store in scope
  // within the last 24h that are linked to a replenishment request. The
  // `replenishment_id` link distinguishes a real "transit" from a manual
  // ad-hoc transfer.
  const transitParams: SqlParam[] = [];
  const transitLocSql = locationIdsForTypeSql(scope, 'store', transitParams);
  const transitQ = query<{ cnt: string }>(
    `SELECT count(*) AS cnt
       FROM stock_movements
      WHERE reason = 'transfer'
        AND replenishment_id IS NOT NULL
        AND to_location_id IN ${transitLocSql}
        AND created_at > now() - interval '24 hours'`,
    transitParams,
  );

  // Best-selling product today across stores in scope.
  const topParams: SqlParam[] = [];
  let topWhere = `s.sold_at >= date_trunc('day', now())
                  AND s.sold_at <  date_trunc('day', now()) + interval '1 day'`;
  if (scope.kind === 'locations') {
    topParams.push(scope.locationIds);
    topWhere += ` AND s.store_id = ANY($${topParams.length}::bigint[])`;
  }
  const topQ = query<{ name: string }>(
    `SELECT p.name
       FROM sales s
       JOIN products p ON p.id = s.product_id
      WHERE ${topWhere}
      GROUP BY p.id, p.name
      ORDER BY sum(s.qty) DESC, p.id ASC
      LIMIT 1`,
    topParams,
  );

  const [sales, repl, transit, top] = await Promise.all([
    salesQ,
    replQ,
    transitQ,
    topQ,
  ]);
  const r = sales.rows[0];
  const salesSum = Number(r?.total_sum ?? 0);
  const receipts = Number(r?.receipts ?? 0);
  return {
    kind: 'store',
    sales_today_sum: salesSum,
    receipts_today: receipts,
    avg_receipt_today: receipts > 0 ? salesSum / receipts : 0,
    open_replenishments: Number(repl.rows[0]?.cnt ?? 0),
    transit_count: Number(transit.rows[0]?.cnt ?? 0),
    top_product_name: top.rows[0]?.name ?? null,
    qty_today: Number(r?.qty_today ?? 0),
  };
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
    case 'wrong_keyed_check':
    case 'poster_sync_failed':
      return 'danger';
    case 'stock_below_min':
      return 'warning';
    default:
      return 'info';
  }
}

/**
 * Daily sales over the requested range.
 *
 * Two series per day, from TWO sources (D-0028):
 *   - `amount` — so'm REVENUE, from Poster `dash.getPaymentsReport.days[]`
 *     (the single source of truth for money; ÷100 already applied upstream in
 *     `fetchPosterRevenue`). The "Sotuv summasi" chart is Poster-authoritative
 *     and therefore reconciles with the HeroStrip headline + RevenueBreakdown.
 *   - `qty`    — UNITS sold, from the raw local `sales` table (`sum(qty)`).
 *     Units are not money and are not part of the revenue mismatch, so they
 *     stay local. Reading the raw table (not `sales_stats_daily`) keeps
 *     TODAY's partial-but-real units in the "Sotuv soni" chart.
 *
 * The two series are MERGED by calendar day: the day set is the UNION of the
 * Poster days and the local-sales days, so a day present in EITHER source
 * appears (missing side = 0). For a scoped principal, only their assigned
 * stores contribute the local `qty`, and `fetchPosterRevenue` already scoped
 * the Poster `amount` to their store spots.
 *
 * `sales` rows are POS/store sales keyed by `store_id`, which equals the
 * location id (mirrors how `fetchStorePulse` reads `sales` directly).
 */
async function fetchSalesChart(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
  poster: PosterRevenue,
): Promise<{ granularity: SalesChartGranularity; days: SalesChartItem[] }> {
  // F4.9-hourly — `range=today` would otherwise collapse to a single daily
  // point. Emit one point per hour instead (00:00..current hour).
  if (range.preset === 'today') {
    return fetchSalesChartHourly(scope, range, poster);
  }

  // F4.9 — chart window equals the requested range. `sales.sold_at` is a
  // TIMESTAMPTZ, so we apply the same half-open `[from, to)` window the rest
  // of the dashboard uses, then bucket by calendar day via `sold_at::date`.
  const params: SqlParam[] = [range.from, range.to];
  let where = `WHERE sold_at >= $1 AND sold_at < $2`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND store_id = ANY($${params.length}::bigint[])`;
  }
  // Bucket by calendar day and return the day as TEXT (`YYYY-MM-DD`) straight
  // from SQL. Returning a pg `date` would round-trip through a JS Date at the
  // Node process's local midnight, which `toIsoDate` then re-projects to UTC —
  // shifting the day backward whenever the process TZ is ahead of UTC (e.g.
  // Asia/Tashkent, +05). `to_char` sidesteps that timezone trap entirely.
  const { rows } = await query<{ day: string; qty: string }>(
    `SELECT to_char(sold_at::date, 'YYYY-MM-DD') AS day,
            sum(qty)                             AS qty
       FROM sales
       ${where}
       GROUP BY sold_at::date
       ORDER BY sold_at::date`,
    params,
  );

  // Local units, keyed by day.
  const qtyByDate = new Map<string, number>();
  for (const r of rows) qtyByDate.set(r.day, Number(r.qty));

  // Union of days seen by EITHER source — a day with revenue but no local
  // unit row (or vice versa) still appears, with the missing side = 0.
  const dateSet = new Set<string>([...qtyByDate.keys(), ...poster.perDay.keys()]);
  const dates = [...dateSet].sort();

  const days = dates.map<SalesChartItem>((date) => ({
    date,
    qty: qtyByDate.get(date) ?? 0,
    amount: Math.round((poster.perDay.get(date) ?? 0) * 100) / 100,
  }));
  return { granularity: 'day', days };
}

/**
 * F4.9-hourly — the `range=today` series, one point per hour from 00:00 up to
 * the CURRENT hour of the business day (never a future hour). Each point:
 *   - `hour`   : 0..N.
 *   - `date`   : today's ISO date (same for every point).
 *   - `amount` : Poster `dash.getAnalytics?select=revenue` `data_hourly[hour]`
 *                (so'm — already divided by Poster, NO ÷100; see
 *                PosterAnalytics unit note). Falls back to 0 when Poster is
 *                unavailable.
 *   - `qty`    : Poster `dash.getAnalytics?select=transactions`
 *                `data_hourly[hour]` — per-hour transaction COUNTS (the
 *                "Sotuv soni" series). Falls back to 0 when the transactions
 *                call is unavailable (revenue series still renders).
 *
 * RBAC: `poster.perHour` was already scoped to the principal's store spots
 * inside `fetchPosterRevenue` (chain-wide for PM/ai_assistant, per-spot summed
 * for a scoped manager) — the same scoping as the daily `amount` path.
 */
function fetchSalesChartHourly(
  _scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
  poster: PosterRevenue,
): { granularity: SalesChartGranularity; days: SalesChartItem[] } {
  // `range.from` is the start of the business day (UTC); `range.to` is "now".
  // The current hour is how far the day has progressed — emit 0..currentHour
  // inclusive so we never render a future (empty) hour past now.
  const date = toPosterIsoDate(range.from);
  const currentHour = range.to.getUTCHours();
  const perHour = poster.perHour ?? new Array<number>(24).fill(0);
  // qty now comes from `select=transactions` per-hour counts (poster.perHourQty);
  // all-zero when the transactions analytics call was unavailable.
  const perHourQty = poster.perHourQty ?? new Array<number>(24).fill(0);

  const days: SalesChartItem[] = [];
  for (let hour = 0; hour <= currentHour && hour < 24; hour++) {
    const amount = perHour[hour] ?? 0;
    const qty = perHourQty[hour] ?? 0;
    days.push({
      date,
      hour,
      qty,
      amount: Math.round(amount * 100) / 100,
    });
  }
  return { granularity: 'hour', days };
}

/** Format a UTC instant as `YYYY-MM-DD` (today's ISO date for hourly points). */
function toPosterIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
    chain_summary: [],
    chain_edges: [],
    alerts_feed: [],
    // An empty payload has no data to bucket — `day` keeps the contract
    // simplest for the empty-state UI (no hour points to render).
    sales_chart: { granularity: 'day', days: [] },
  };
}

/**
 * D-0026 — read explicit M:N edges from `location_flows`.
 *
 * Scoping rules:
 *   - chain     — every active edge (the PM canvas sees the full graph).
 *   - locations — edges where either endpoint is in the principal's
 *                 assigned set. A store_manager rarely has flow edges
 *                 (stores are leaf nodes today) but the rule is uniform.
 *
 * Only edges between two ACTIVE locations are returned — `is_active=false`
 * rows would render dangling endpoints on the canvas.
 */
async function fetchChainEdges(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
): Promise<ChainEdge[]> {
  const params: SqlParam[] = [];
  let where = `WHERE lf_from.is_active = TRUE AND lf_to.is_active = TRUE`;
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    where += ` AND (lf.from_location_id = ANY($${params.length}::bigint[])
                OR lf.to_location_id   = ANY($${params.length}::bigint[]))`;
  }

  const { rows } = await query<{
    from_location_id: string;
    to_location_id: string;
    flow_type: ChainEdge['type'];
  }>(
    `SELECT lf.from_location_id, lf.to_location_id, lf.flow_type
       FROM location_flows lf
       JOIN locations lf_from ON lf_from.id = lf.from_location_id
       JOIN locations lf_to   ON lf_to.id   = lf.to_location_id
       ${where}
       ORDER BY lf.from_location_id, lf.to_location_id, lf.flow_type`,
    params,
  );

  return rows.map((r) => ({
    from: Number(r.from_location_id),
    to: Number(r.to_location_id),
    type: r.flow_type,
  }));
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

// D7 (2026-05-28) — `sex_storage` is accepted as a SYNONYM for the supply
// layer. The data-fetching SQL maps either path-segment to the same set
// `['supply','sex_storage']` so the existing `ChainDetailSheet` keeps working
// and a new client may use the canonical name.
const CHAIN_LAYER_TYPES = [
  'raw_warehouse',
  'production',
  'sex_storage',
  'supply',
  'central_warehouse',
  'store',
] as const;
type ChainLayerType = (typeof CHAIN_LAYER_TYPES)[number];

/** The single role that manages each layer. PM + ai_assistant pass any layer. */
const LAYER_MANAGER_ROLE: Record<ChainLayerType, Role> = {
  raw_warehouse: 'raw_warehouse_manager',
  production: 'production_manager',
  sex_storage: 'supply_manager',
  supply: 'supply_manager',
  central_warehouse: 'central_warehouse_manager',
  store: 'store_manager',
};

/**
 * SQL type filter for the requested layer. Supply / sex_storage both fan
 * out to BOTH location_type values so the dashboard surface keeps reporting
 * the sex skladi traffic after migration 0022 flipped the live rows.
 */
function chainLayerTypeFilter(layerType: ChainLayerType): readonly string[] {
  if (layerType === 'supply' || layerType === 'sex_storage') {
    return SUPPLY_PULSE_TYPES;
  }
  return [layerType];
}

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
    if (
      layerType === 'supply' ||
      layerType === 'sex_storage' ||
      layerType === 'central_warehouse'
    ) {
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
  // D7 — `supply` and `sex_storage` both resolve to the same set.
  const typeFilter = [...chainLayerTypeFilter(scope.type)];
  const params: SqlParam[] = [typeFilter];
  let where = 'WHERE l.type::text = ANY($1::text[]) AND l.is_active = TRUE';
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
           FROM stock s
          WHERE s.location_id = l.id
            AND s.qty <= s.min_level
            AND s.min_level > 0
            AND s.max_level > 0
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
  // CANCELLED). D7 — supply/sex_storage are aliased.
  const isSupplyOrSexStorage =
    layerType === 'supply' || layerType === 'sex_storage';
  const pendingShipmentsPromise =
    isSupplyOrSexStorage || layerType === 'central_warehouse'
      ? (async () => {
          const typeFilter = [...chainLayerTypeFilter(layerType)];
          const params: SqlParam[] = [typeFilter];
          let where =
            `WHERE rr.status NOT IN ('CLOSED','CANCELLED') AND tl.type::text = ANY($1::text[])`;
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
  // D7 — `supply` / `sex_storage` both expand to the same type-set.
  const typeFilter = [...chainLayerTypeFilter(scope.type)];
  const params: SqlParam[] = [typeFilter];
  let where =
    `WHERE (fl.type::text = ANY($1::text[]) OR tl.type::text = ANY($1::text[]))`;
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
  if (
    layerType === 'supply' ||
    layerType === 'sex_storage' ||
    layerType === 'central_warehouse'
  ) {
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

// =============================================================================
// Sub-task #5 — GET /api/dashboard/aging-alerts
// =============================================================================
//
// Surfaces stock sitting in a `sex_storage` (or legacy `supply`) location for
// longer than its `products.shelf_life_days` threshold.
//
// Aging is computed from the most recent inbound `stock_movement` (reasons:
// `production_output` or `transfer`) that landed product P into location L.
// We then compare `now() - last_inbound_at` against `shelf_life_days` and
// classify:
//   - days_in_storage >= shelf_life_days        -> 'critical' (already off)
//   - days_in_storage >= shelf_life_days * 0.7  -> 'warning'  (safe-zone)
//
// Products with NULL `shelf_life_days` (raw materials) are ignored — they
// have no expiry.
//
// RBAC mirrors `/api/dashboard/overview`:
//   - pm / ai_assistant -> chain-wide.
//   - scoped principal  -> only their assigned sex_storage / supply locations.
// =============================================================================

const AGING_WARNING_RATIO = 0.7;

type AgingAlertRaw = {
  location_id: string;
  location_name: string;
  location_type: string;
  product_id: string;
  product_name: string;
  product_unit: string;
  qty: string;
  shelf_life_days: number;
  last_inbound_at: Date;
  days_in_storage: string;
};

type AgingAlertItem = {
  location_id: number;
  location_name: string;
  location_type: string;
  product_id: number;
  product_name: string;
  product_unit: string;
  qty: number;
  shelf_life_days: number;
  last_inbound_at: string;
  days_in_storage: number;
  urgency: 'warning' | 'critical';
};

type AgingAlertsResponse = {
  items: AgingAlertItem[];
};

dashboardRouter.get(
  '/aging-alerts',
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

    if (scope.kind === 'empty') {
      res.status(200).json({ items: [] } satisfies AgingAlertsResponse);
      return;
    }

    const params: SqlParam[] = [];
    // Sex skladi = `sex_storage` (post-D7) + legacy `supply` rows. Aging is
    // most relevant for half-finished goods sitting in a sex buffer, but we
    // include legacy `supply` rows so any unmigrated tenant still gets the
    // signal.
    let locFilter = `l.type IN ('sex_storage','supply') AND l.is_active = TRUE`;
    if (scope.kind === 'locations') {
      params.push(scope.locationIds);
      locFilter += ` AND l.id = ANY($${params.length}::bigint[])`;
    }

    // The aging signal is the most recent inbound movement into (L, P). We
    // consider `production_output` and `transfer` — both deposit qty into a
    // sex_storage. `purchase` is for raw warehouses, not sex buffers, and is
    // intentionally excluded.
    const { rows } = await query<AgingAlertRaw>(
      `SELECT s.location_id, l.name AS location_name, l.type::text AS location_type,
              s.product_id, p.name AS product_name, p.unit::text AS product_unit,
              s.qty,
              p.shelf_life_days,
              last_inbound.created_at AS last_inbound_at,
              EXTRACT(EPOCH FROM (now() - last_inbound.created_at)) / 86400.0
                AS days_in_storage
         FROM stock s
         JOIN products  p ON p.id = s.product_id
         JOIN locations l ON l.id = s.location_id
         JOIN LATERAL (
           SELECT m.created_at
             FROM stock_movements m
            WHERE m.product_id = s.product_id
              AND m.to_location_id = s.location_id
              AND m.reason IN ('production_output','transfer')
            ORDER BY m.created_at DESC
            LIMIT 1
         ) last_inbound ON TRUE
        WHERE s.qty > 0
          AND p.shelf_life_days IS NOT NULL
          AND ${locFilter}
          AND EXTRACT(EPOCH FROM (now() - last_inbound.created_at)) / 86400.0
              >= p.shelf_life_days * $${params.length + 1}::numeric
        ORDER BY (EXTRACT(EPOCH FROM (now() - last_inbound.created_at)) / 86400.0)
                 / NULLIF(p.shelf_life_days, 0) DESC,
                 s.location_id, s.product_id`,
      [...params, AGING_WARNING_RATIO],
    );

    const items: AgingAlertItem[] = rows.map((r) => {
      const days = Number(r.days_in_storage);
      const shelf = r.shelf_life_days;
      const urgency: 'warning' | 'critical' =
        days >= shelf ? 'critical' : 'warning';
      return {
        location_id: Number(r.location_id),
        location_name: r.location_name,
        location_type: r.location_type,
        product_id: Number(r.product_id),
        product_name: r.product_name,
        product_unit: r.product_unit,
        qty: Number(r.qty),
        shelf_life_days: shelf,
        last_inbound_at: r.last_inbound_at.toISOString(),
        days_in_storage: Math.round(days * 100) / 100,
        urgency,
      };
    });

    res.status(200).json({ items } satisfies AgingAlertsResponse);
  }),
);

// =============================================================================
// Sub-task #7 — GET /api/dashboard/revenue-breakdown
// =============================================================================
//
// Revenue split by payment method (naqd / karta / Payme / Click / other) for
// the SELECTED date range. Backed by Poster `dash.getPaymentsReport` — already
// aggregated by the POS, so we don't pull every check line ourselves.
//
// Query params (same range contract as /overview, /ecosystem, /sales-chart):
//   ?range=today|week|month|6m|custom   default = today.
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD       required when range=custom.
//   ?spotId=<int>      optional Poster spot_id; restricts the lookup to one
//                       store. PM may pass any spot; a scoped principal may
//                       only pass a spot that maps to one of their assigned
//                       store locations.
//
// Response shape:
//   { from, to, spot_id, total, byMethod: { cash, card, payme, click, other } }
//
// RBAC: pm / ai_assistant / store_manager / central_warehouse_manager /
//       supply_manager — the same set that can read /api/sales.
// =============================================================================

type RevenueMethodRow = {
  /** Stable key — a core key (cash/card/payme/click/other) or `pm_<id>`. */
  key: string;
  /** Display label — core label or the verbatim Poster method title. */
  label: string;
  amount: number;
};

type RevenueBreakdownResponse = {
  /** Inclusive window bounds, ISO `YYYY-MM-DD`, echoing the resolved range. */
  from: string;
  to: string;
  spot_id: number | null;
  total: number;
  /** Number of closed receipts (transactions) in the range. */
  count: number;
  // camelCase to match the frontend contract (DashboardRevenueBreakdown).
  // The 4 core keys + `other` are kept for backward-compatibility; `card`
  // now EXCLUDES named custom methods (each lands in `methods` by its name).
  byMethod: {
    cash: number;
    card: number;
    payme: number;
    click: number;
    other: number;
  };
  /**
   * Ordered display list: the 4 core methods always appear, then each named
   * custom method present (amount > 0, amount desc), then the unnamed `other`
   * residual only when > 0. `sum(methods[].amount) === total`.
   */
  methods: RevenueMethodRow[];
};

dashboardRouter.get(
  '/revenue-breakdown',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    // EPIC 0.4 — follow the dashboard date-range filter instead of a single
    // hard-coded day, so the breakdown changes when the period changes.
    const range = parseDateRange(req.query);
    const spotIdParam = parseOptionalSpotId(req.query.spotId ?? req.query.spot_id);

    // RBAC scoping (invariant 5): the per-transaction Poster window is chain-wide
    // unless filtered by spot, so a location-scoped principal MUST be confined to
    // their own store's spot(s) — server-side, never trusting the frontend.
    //   - super-admin / pm / ai_assistant: chain-wide (effectiveSpotIds = null).
    //   - central_warehouse_manager / supply_manager: chain-wide (their scope is
    //     the whole supply chain, not a single POS spot) — UNCHANGED.
    //   - store_manager (and any other location-scoped role): auto-scoped to the
    //     Poster spot(s) of their assigned stores. An explicit `spotId` must be
    //     one of those spots (else 403); when absent we query EVERY assigned spot.
    const effectiveSpotIds = await resolveRevenueSpotScope(
      principal,
      spotIdParam,
    );

    // EPIC 0.3 + money-fix (2026-06-06) — REAL Poster path.
    //
    // `dash.getPaymentsReport` only exposes aggregate type buckets (cash / card
    // / ewallet / third_party / …) and — for the `adia` account — folds Payme
    // AND Click into `payed_card_sum` (verified live: third_party=0, ewallet=0).
    // So that endpoint CANNOT separate Payme/Click and the breakdown showed 0.
    //
    // The real per-method signal lives on the TRANSACTION (`payment_method_id`).
    // We therefore iterate `dash.getTransactions` for the window and group by
    // method via the account's dynamic id->title map (`settings.getPaymentMethods`,
    // cached). `transactionsToBuckets` splits payme/click/named-methods out of
    // card; built-in cash/card txns are split by their own payed_cash/payed_card.
    // Buckets always reconcile to `total`; we additionally cross-check against
    // `dash.getAnalytics` revenue and log (never throw) on drift.
    //
    // Money is TIYIN throughout -> so'm via tiyinToSom inside the grouping fn.
    const { transactionsToBuckets } = await import(
      '../integrations/poster/posterMoney.js'
    );
    const { createPosterClientFromConfig } = await import(
      '../integrations/poster/client.js'
    );

    const client = createPosterClientFromConfig();
    // Half-open [from, to) -> Poster's inclusive YYYYMMDD bounds. `to` is the
    // exclusive next-instant, so the inclusive last day is `to - 1ms`.
    const lastDay = new Date(range.to.getTime() - 1);
    const dateFrom = toPosterDate(range.from);
    const dateTo = toPosterDate(lastDay);

    // A location-scoped principal whose stores carry NO Poster spot must get an
    // empty result — never the chain-wide window (which is what an unfiltered
    // `getTransactions` would return).
    if (effectiveSpotIds !== null && effectiveSpotIds.length === 0) {
      const empty = transactionsToBuckets([], await client.getPaymentMethods());
      res.status(200).json({
        from: range.from.toISOString().slice(0, 10),
        to: lastDay.toISOString().slice(0, 10),
        spot_id: spotIdParam,
        total: empty.total,
        count: empty.closedCount,
        byMethod: {
          cash: empty.byMethod.cash,
          card: empty.byMethod.card,
          payme: empty.byMethod.payme,
          click: empty.byMethod.click,
          other: empty.byMethod.other,
        },
        methods: empty.methods.map((m) => ({
          key: m.key,
          label: m.label,
          amount: m.amount,
        })),
      } satisfies RevenueBreakdownResponse);
      return;
    }

    // `getTransactions` / `getAnalytics` accept a SINGLE spot, so a multi-store
    // principal is served by fetching per spot and concatenating the rows; the
    // breakdown is a pure function of the transaction list, so one pass over the
    // union yields the same totals as the chain-wide call did per spot. A null
    // scope (PM/ai/central/supply) makes a single unfiltered call as before.
    const spotsToQuery: (number | undefined)[] =
      effectiveSpotIds === null ? [undefined] : effectiveSpotIds;

    const methods = await client.getPaymentMethods();
    const perSpot = await Promise.all(
      spotsToQuery.map(async (spotId) => {
        const [transactions, analytics] = await Promise.all([
          client.getTransactions({
            dateFrom,
            dateTo,
            paginate: true,
            ...(spotId !== undefined ? { spotId } : {}),
          }),
          client
            .getAnalytics({
              dateFrom,
              dateTo,
              interpolate: 'day',
              select: 'revenue',
              ...(spotId !== undefined ? { spotId } : {}),
            })
            .catch(() => ({}) as Awaited<ReturnType<typeof client.getAnalytics>>),
        ]);
        return { transactions, revenue: Number(analytics.counters?.revenue) };
      }),
    );
    const transactions = perSpot.flatMap((p) => p.transactions);
    // Reconciliation cross-check: sum each spot's analytics revenue. Skip the
    // cross-check entirely if any spot's analytics was unavailable (NaN).
    const revenues = perSpot.map((p) => p.revenue);
    const expectedTotal = revenues.every((r) => Number.isFinite(r))
      ? revenues.reduce((s, r) => s + r, 0)
      : Number.NaN;

    const breakdown = transactionsToBuckets(
      transactions,
      methods,
      Number.isFinite(expectedTotal) ? expectedTotal : undefined,
    );
    const { byMethod, total } = breakdown;
    if (breakdown.reconcileWarning !== null) {
      console.warn(`[revenue-breakdown] ${breakdown.reconcileWarning}`);
    }

    const response: RevenueBreakdownResponse = {
      from: range.from.toISOString().slice(0, 10),
      to: lastDay.toISOString().slice(0, 10),
      spot_id: spotIdParam,
      total,
      count: breakdown.closedCount,
      byMethod: {
        cash: byMethod.cash,
        card: byMethod.card,
        payme: byMethod.payme,
        click: byMethod.click,
        other: byMethod.other,
      },
      methods: breakdown.methods.map((m) => ({
        key: m.key,
        label: m.label,
        amount: m.amount,
      })),
    };
    res.status(200).json(response);
  }),
);

// =============================================================================
// GET /api/dashboard/sales-breakdown
// =============================================================================
//
// Per-time-bucket itemised breakdown that powers the Yandex-style tooltip on
// the hourly/daily sales charts (the `sales_chart` series from /ecosystem).
// Bucket granularity matches that chart EXACTLY so the frontend can join the
// breakdown onto each chart point:
//   - range=today -> hourly buckets keyed by `hour`, bucketed in LOCAL
//     Asia/Tashkent time (BUSINESS_TZ) so the hour index aligns with the
//     ecosystem hourly chart's `days[].hour` (Poster `data_hourly` is local).
//   - otherwise   -> daily buckets keyed by `date` (YYYY-MM-DD, also local
//     Tashkent), mirroring `days[].date`.
//
// Two dimensions via `?by=`:
//   - product (default): local `sales` JOIN `products`, grouped by
//     (bucket, product). Line amount = sum(s.qty * s.price). After the
//     2026-06-08 ingest fix `sales.price` is a TRUE per-unit price
//     (lineTotalSom / num), so `qty * price` = the Poster line total and this
//     endpoint agrees with /stores' top_products to the cheque. `qty` stays
//     sum(s.qty) = units sold.
//     NOTE: this local product revenue is sourced from the `sales` table and
//     may differ slightly from the Poster-sourced `sales_chart` line amount
//     (different source — Poster analytics vs. local lines). We do NOT try to
//     force-reconcile the two; the tooltip is an itemised drill-down, not the
//     authoritative money headline (that stays /revenue-breakdown).
//   - payment: Poster `dash.getTransactions`, bucketed by LOCAL Tashkent
//     hour/date of `date_close` (the Poster account is Tashkent) and by payment
//     method (cash/card/payme/click + named customs), reusing the same method
//     resolver as /revenue-breakdown.
//
// Query params (same range/spotId/RBAC contract as /revenue-breakdown):
//   ?range=today|week|month|6m|custom   default today.
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD       required when range=custom.
//   ?spotId=<int>                        optional Poster spot_id.
//   ?by=product|payment                  default product.
//   ?limit=<int>                         top items per bucket; default 6, 1..12.
//
// Each bucket returns `items` = top `limit` by amount (desc), plus a single
// rolled-up "Boshqa" item carrying the remainder when more items exist, plus
// `total_qty` / `total_amount` for the whole bucket (pre-rollup totals).
//
// Performance: hourly is <= 24 buckets. For by=payment over long ranges we
// reuse the SAME paginated getTransactions /revenue-breakdown uses — a 6-month
// window can be heavy (many pages); callers should prefer shorter ranges for
// the payment dimension.
//
// RBAC: pm / ai_assistant / store_manager / central_warehouse_manager /
//       supply_manager — same set as /revenue-breakdown and /api/sales.
// =============================================================================

const SALES_BREAKDOWN_DEFAULT_LIMIT = 6;
const SALES_BREAKDOWN_MIN_LIMIT = 1;
const SALES_BREAKDOWN_MAX_LIMIT = 12;
/** Safety cap on daily buckets returned (a 6-month window is ~183 days). */
const SALES_BREAKDOWN_MAX_BUCKETS = 200;

type SalesBreakdownDimension = 'product' | 'payment';

type SalesBreakdownItem = { name: string; qty: number; amount: number };

type SalesBreakdownBucket = {
  /** Present iff granularity === 'hour'. */
  hour?: number;
  /** Present iff granularity === 'day' (YYYY-MM-DD). */
  date?: string;
  total_qty: number;
  total_amount: number;
  items: SalesBreakdownItem[];
};

type SalesBreakdownResponse = {
  from: string;
  to: string;
  spot_id: number | null;
  granularity: SalesChartGranularity;
  by: SalesBreakdownDimension;
  buckets: SalesBreakdownBucket[];
};

/** Raw (bucket, product) aggregate row for the local `by=product` query. */
type ProductBucketRaw = {
  /** Hour 0..23 (hourly) — NULL on the daily path. */
  hour: string | null;
  /** YYYY-MM-DD (daily) — NULL on the hourly path. */
  day: string | null;
  product_id: string;
  product_name: string;
  qty: string;
  amount: string;
};

dashboardRouter.get(
  '/sales-breakdown',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const range = parseDateRange(req.query);
    const spotIdParam = parseOptionalSpotId(req.query.spotId ?? req.query.spot_id);
    const by = parseSalesBreakdownDimension(req.query.by);
    const limit = parseSalesBreakdownLimit(req.query.limit);
    const granularity: SalesChartGranularity =
      range.preset === 'today' ? 'hour' : 'day';

    // RBAC scoping for spotId — identical to /revenue-breakdown. The `by=product`
    // path is store-scoped locally (buildProductBreakdown intersects storeIds),
    // so it only needs the explicit-spot 403 guard. The `by=payment` path is
    // Poster-backed and chain-wide unless filtered, so a location-scoped
    // principal MUST be auto-scoped to their own store spot(s) — invariant 5.
    let paymentSpotScope: number[] | null = null;
    if (by === 'payment') {
      paymentSpotScope = await resolveRevenueSpotScope(principal, spotIdParam);
    } else if (
      !isSuperAdmin(principal) &&
      principal.role !== 'ai_assistant' &&
      principal.role !== 'central_warehouse_manager' &&
      principal.role !== 'supply_manager' &&
      spotIdParam !== null
    ) {
      const ok = await isSpotAssignedToPrincipal(principal.locationIds, spotIdParam);
      if (!ok) {
        throw AppError.forbidden(
          'You may only query sales for spots in your assigned stores.',
        );
      }
    }

    const lastDay = new Date(range.to.getTime() - 1);
    const fromIso = range.from.toISOString().slice(0, 10);
    const toIso = lastDay.toISOString().slice(0, 10);

    const buckets =
      by === 'product'
        ? await buildProductBreakdown(principal, range, granularity, limit, spotIdParam)
        : await buildPaymentBreakdown(range, granularity, limit, paymentSpotScope);

    const response: SalesBreakdownResponse = {
      from: fromIso,
      to: toIso,
      spot_id: spotIdParam,
      granularity,
      by,
      buckets,
    };
    res.status(200).json(response);
  }),
);

/**
 * by=product — local `sales` JOIN `products`, grouped by (bucket, product).
 * Store scoping mirrors `fetchSalesChart`: a location-bound principal only
 * sees `store_id = ANY(locationIds)`. A `spotId` further narrows to the single
 * store mapped to that Poster spot (intersected with scope).
 */
async function buildProductBreakdown(
  principal: AuthPrincipal,
  range: DateRange,
  granularity: SalesChartGranularity,
  limit: number,
  spotId: number | null,
): Promise<SalesBreakdownBucket[]> {
  // Resolve the store-id set this principal may read. PM / ai_assistant see
  // every store (null = no store filter); a scoped manager is limited to their
  // assigned locations.
  let storeIds: number[] | null = null; // null = no store filter (chain-wide)
  if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
    if (principal.locationIds.length === 0) return [];
    storeIds = [...principal.locationIds];
  }

  // A spotId narrows to the single store mapped to that Poster spot. We
  // intersect it with the principal's scope so it never widens access.
  if (spotId !== null) {
    const mapped = await storeLocationIdForSpot(spotId);
    if (mapped === null) return [];
    if (storeIds !== null && !storeIds.includes(mapped)) return [];
    storeIds = [mapped];
  }

  // Window + bucketing are done in BUSINESS_TZ (Asia/Tashkent) so the hour
  // index aligns with the ecosystem hourly chart, which is fed by Poster
  // `data_hourly` (local Tashkent hours). See BUSINESS_TZ.
  const params: SqlParam[] = [];
  const conditions: string[] = [];
  if (granularity === 'hour') {
    // Today path — restrict to the Tashkent CALENDAR day so all 24 hour
    // buckets (00..23) belong to the same business day the chart shows. The
    // half-open UTC `[range.from, range.to)` window would otherwise clip the
    // Tashkent 00:00..05:00 hours (UTC-midnight today = Tashkent 05:00).
    params.push(BUSINESS_TZ);
    conditions.push(
      `(s.sold_at AT TIME ZONE $${params.length})::date = (now() AT TIME ZONE $${params.length})::date`,
    );
  } else {
    // Daily path — keep the requested half-open `[from, to)` window.
    params.push(range.from);
    conditions.push(`s.sold_at >= $${params.length}`);
    params.push(range.to);
    conditions.push(`s.sold_at < $${params.length}`);
  }
  if (storeIds !== null) {
    params.push(storeIds);
    conditions.push(`s.store_id = ANY($${params.length}::bigint[])`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;

  // Bucket key in BUSINESS_TZ: local hour (hourly) or local calendar date as
  // text (daily). Converting the TIMESTAMPTZ `AT TIME ZONE 'Asia/Tashkent'`
  // gives the local wall-clock, then `extract(hour ...)` / `::date` derive the
  // bucket — matching Poster's local-hour `data_hourly` index exactly.
  params.push(BUSINESS_TZ);
  const tzIdx = params.length;
  const bucketSelect =
    granularity === 'hour'
      ? `extract(hour FROM s.sold_at AT TIME ZONE $${tzIdx})::int AS hour, NULL::text AS day`
      : `NULL::int AS hour, to_char((s.sold_at AT TIME ZONE $${tzIdx})::date, 'YYYY-MM-DD') AS day`;
  const bucketGroup =
    granularity === 'hour'
      ? `extract(hour FROM s.sold_at AT TIME ZONE $${tzIdx})`
      : `(s.sold_at AT TIME ZONE $${tzIdx})::date`;

  // Bucket/item revenue = sum(s.qty * s.price). After the 2026-06-08 ingest
  // fix `sales.price` is a TRUE per-unit price (lineTotalSom / num), so
  // `qty * price` equals the Poster line total (`payed_sum`) and reconciles to
  // the revenue-breakdown. This is the SAME formula every other revenue query
  // uses (dashboard/stores, reports, AI tools) — the two endpoints now agree.
  // `qty` stays sum(s.qty) = units sold.
  const { rows } = await query<ProductBucketRaw>(
    `SELECT ${bucketSelect},
            s.product_id,
            p.name              AS product_name,
            sum(s.qty)          AS qty,
            sum(s.qty * s.price) AS amount
       FROM sales s
       JOIN products p ON p.id = s.product_id
       ${where}
       GROUP BY ${bucketGroup}, s.product_id, p.name`,
    params,
  );

  // Group the flat (bucket, product) rows into per-bucket item lists.
  type Acc = {
    key: number | string;
    hour?: number;
    date?: string;
    items: SalesBreakdownItem[];
  };
  const byBucket = new Map<string, Acc>();
  for (const r of rows) {
    const isHour = granularity === 'hour';
    const key = isHour ? Number(r.hour) : (r.day ?? '');
    const mapKey = String(key);
    let acc = byBucket.get(mapKey);
    if (acc === undefined) {
      acc = isHour
        ? { key, hour: Number(r.hour), items: [] }
        : { key, date: r.day ?? '', items: [] };
      byBucket.set(mapKey, acc);
    }
    acc.items.push({
      name: r.product_name,
      qty: roundQty(Number(r.qty)),
      amount: Math.round(Number(r.amount) * 100) / 100,
    });
  }

  const ordered = [...byBucket.values()].sort((a, b) =>
    granularity === 'hour'
      ? (a.hour ?? 0) - (b.hour ?? 0)
      : String(a.date).localeCompare(String(b.date)),
  );
  const capped =
    granularity === 'day' ? ordered.slice(0, SALES_BREAKDOWN_MAX_BUCKETS) : ordered;

  return capped.map((acc) =>
    finalizeBucket(
      granularity === 'hour' ? { hour: acc.hour ?? 0 } : { date: acc.date ?? '' },
      acc.items,
      limit,
    ),
  );
}

/**
 * by=payment — Poster `dash.getTransactions` bucketed by hour/date of
 * `date_close` and by payment method. Reuses the same method resolver as
 * /revenue-breakdown so Payme/Click and named custom methods are split out of
 * `card`. Item `qty` is the receipt COUNT for that method; `amount` is so'm.
 */
async function buildPaymentBreakdown(
  range: DateRange,
  granularity: SalesChartGranularity,
  limit: number,
  // null = chain-wide (no spot filter); number[] = the exact spot(s) to query.
  // An empty array means a location-scoped principal with no Poster-mapped store
  // and yields an empty breakdown (never the chain-wide window).
  spotScope: number[] | null,
): Promise<SalesBreakdownBucket[]> {
  const { tiyinToSom } = await import('../integrations/poster/posterMoney.js');
  const { buildMethodResolver } = await import(
    '../integrations/poster/paymentMethods.js'
  );
  const { createPosterClientFromConfig } = await import(
    '../integrations/poster/client.js'
  );

  if (spotScope !== null && spotScope.length === 0) return [];

  const client = createPosterClientFromConfig();
  const lastDay = new Date(range.to.getTime() - 1);
  const dateFrom = toPosterDate(range.from);
  const dateTo = toPosterDate(lastDay);

  // `getTransactions` takes a single spot, so multi-store scopes fetch per spot
  // and concatenate; the bucketing below is a pure function of the row list.
  const spotsToQuery: (number | undefined)[] =
    spotScope === null ? [undefined] : spotScope;

  const methods = await client.getPaymentMethods();
  const transactionPages = await Promise.all(
    spotsToQuery.map((spotId) =>
      client.getTransactions({
        dateFrom,
        dateTo,
        paginate: true, // 6-month windows can span many pages — see endpoint note.
        ...(spotId !== undefined ? { spotId } : {}),
      }),
    ),
  );
  const transactions = transactionPages.flat();
  const resolve = buildMethodResolver(methods);

  // Fixed core labels (match /revenue-breakdown). Named customs carry their
  // verbatim Poster title; the cash/card split of a no-custom-method txn folds
  // into these core labels.
  const coreLabel: Record<'cash' | 'card' | 'payme' | 'click' | 'other', string> = {
    cash: 'Naqd',
    card: 'Karta',
    payme: 'Payme',
    click: 'Click',
    other: 'Boshqa',
  };

  // bucketKey -> (methodKey -> {label, qty(receipts), amount}).
  type MethodAcc = { label: string; qty: number; amount: number };
  const byBucket = new Map<
    string,
    { hour?: number; date?: string; methods: Map<string, MethodAcc> }
  >();

  const bump = (
    bucketMap: Map<string, MethodAcc>,
    key: string,
    label: string,
    amount: number,
  ): void => {
    const prev = bucketMap.get(key);
    // One receipt counts ONCE per method it touches. A mixed-tender receipt
    // (cash+card) increments both methods' qty — acceptable for a tooltip.
    bucketMap.set(key, {
      label,
      qty: (prev?.qty ?? 0) + 1,
      amount: (prev?.amount ?? 0) + amount,
    });
  };

  for (const txn of transactions) {
    const payType = Number(txn.pay_type);
    if (Number.isFinite(payType) && payType === 0) continue; // open -> not revenue

    // Bucket in BUSINESS_TZ (Asia/Tashkent) so payment hours line up with the
    // chart x-axis and the by=product hours. `date_close` is local Tashkent
    // (the Poster account is Tashkent) — see posterCloseLocalParts.
    const parts = posterCloseLocalParts(txn.date_close);
    if (parts === null) continue;
    const bucketKey =
      granularity === 'hour' ? String(parts.hour) : parts.date;

    let bucket = byBucket.get(bucketKey);
    if (bucket === undefined) {
      bucket =
        granularity === 'hour'
          ? { hour: parts.hour, methods: new Map() }
          : { date: parts.date, methods: new Map() };
      byBucket.set(bucketKey, bucket);
    }

    const methodId = Number(txn.payment_method_id);
    const resolved = resolve(Number.isFinite(methodId) ? methodId : undefined);
    if (resolved === null) {
      // No custom method — split by the txn's own cash/card fields.
      const cash = tiyinToSom(txn.payed_cash);
      const card = tiyinToSom(txn.payed_card);
      const other =
        tiyinToSom(txn.payed_third_party) +
        tiyinToSom(txn.payed_ewallet) +
        tiyinToSom(txn.payed_bonus);
      if (cash > 0) bump(bucket.methods, 'cash', coreLabel.cash, cash);
      if (card > 0) bump(bucket.methods, 'card', coreLabel.card, card);
      if (other > 0) bump(bucket.methods, 'other', coreLabel.other, other);
      // A fully-zero no-method txn still counts as a receipt under `cash`.
      if (cash <= 0 && card <= 0 && other <= 0) {
        bump(bucket.methods, 'cash', coreLabel.cash, 0);
      }
      continue;
    }

    const amount = transactionAmountSom(txn, tiyinToSom);
    if (resolved.kind === 'core') {
      bump(bucket.methods, resolved.key, coreLabel[resolved.key], amount);
    } else {
      bump(bucket.methods, resolved.key, resolved.label, amount);
    }
  }

  const ordered = [...byBucket.values()].sort((a, b) =>
    granularity === 'hour'
      ? (a.hour ?? 0) - (b.hour ?? 0)
      : String(a.date).localeCompare(String(b.date)),
  );
  const capped =
    granularity === 'day' ? ordered.slice(0, SALES_BREAKDOWN_MAX_BUCKETS) : ordered;

  return capped.map((b) => {
    const items: SalesBreakdownItem[] = [...b.methods.values()].map((m) => ({
      name: m.label,
      qty: m.qty,
      amount: Math.round(m.amount * 100) / 100,
    }));
    return finalizeBucket(
      granularity === 'hour' ? { hour: b.hour ?? 0 } : { date: b.date ?? '' },
      items,
      limit,
    );
  });
}

/**
 * Total so'm for one transaction: `payed_sum` if present, else the parts.
 * Mirrors `transactionAmountSom` in posterMoney (kept local to avoid exporting
 * an internal helper).
 */
function transactionAmountSom(
  txn: { payed_sum?: string | number; payed_cash?: string | number; payed_card?: string | number; payed_third_party?: string | number; payed_ewallet?: string | number },
  tiyinToSom: (v: string | number | undefined | null) => number,
): number {
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

/** Reusable Tashkent-local hour/date extractor for a true instant. */
const TASHKENT_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/**
 * Parse Poster `date_close` to its LOCAL Tashkent `{ hour (0..23), date
 * (YYYY-MM-DD) }`, or null when unparseable. `date_close` arrives either as a
 * unix(ms|s) string OR a zoneless `"YYYY-MM-DD HH:mm:ss"`.
 *
 *   - The zoneless string is already in the Poster account's LOCAL Tashkent
 *     wall-clock, so we read its hour/date verbatim (no zone math).
 *   - A unix timestamp is a true UTC instant, so we project it into
 *     Asia/Tashkent before reading the hour/date.
 *
 * Both yield the LOCAL Tashkent bucket the chart's `data_hourly` index uses.
 */
function posterCloseLocalParts(
  raw: string | undefined,
): { hour: number; date: string } | null {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    const instant = new Date(n > 1e12 ? n : n * 1000);
    if (Number.isNaN(instant.getTime())) return null;
    return instantToTashkentParts(instant);
  }
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):\d{2}:\d{2}$/.exec(raw);
  if (m === null) return null;
  return { date: m[1] as string, hour: Number(m[2]) };
}

/** Project a true UTC instant into Asia/Tashkent `{ hour, date }`. */
function instantToTashkentParts(instant: Date): { hour: number; date: string } {
  const parts = TASHKENT_PARTS.formatToParts(instant);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  };
}

/**
 * Take a bucket's full item list, compute the pre-rollup totals, then return
 * the top `limit` items by amount + a single "Boshqa" remainder when more
 * items exist. Items are sorted amount desc (tie-break by name).
 */
function finalizeBucket(
  key: { hour: number } | { date: string },
  items: SalesBreakdownItem[],
  limit: number,
): SalesBreakdownBucket {
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const totalAmount = items.reduce((s, i) => s + i.amount, 0);

  const sorted = [...items].sort(
    (a, b) => b.amount - a.amount || a.name.localeCompare(b.name),
  );
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  if (rest.length > 0) {
    top.push({
      name: 'Boshqa',
      qty: roundQty(rest.reduce((s, i) => s + i.qty, 0)),
      amount: Math.round(rest.reduce((s, i) => s + i.amount, 0) * 100) / 100,
    });
  }

  const base = {
    total_qty: roundQty(totalQty),
    total_amount: Math.round(totalAmount * 100) / 100,
    items: top,
  };
  return 'hour' in key ? { hour: key.hour, ...base } : { date: key.date, ...base };
}

/** Parse `?by=` to a dimension, defaulting to `product`. */
function parseSalesBreakdownDimension(raw: unknown): SalesBreakdownDimension {
  if (raw === undefined || raw === null || raw === '') return 'product';
  if (raw === 'product' || raw === 'payment') return raw;
  throw AppError.validation('"by" must be one of: product, payment.');
}

/** Parse `?limit=` to an int in [1, 12], defaulting to 6 when absent. */
function parseSalesBreakdownLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return SALES_BREAKDOWN_DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw AppError.validation('"limit" must be an integer.');
  }
  return Math.min(SALES_BREAKDOWN_MAX_LIMIT, Math.max(SALES_BREAKDOWN_MIN_LIMIT, n));
}

/**
 * Resolve a Poster `spot_id` to its mapped store `locations.id`, or null when
 * no active store maps to it. Unlike `isSpotAssignedToPrincipal` this does NOT
 * scope to a principal — the caller intersects with scope itself.
 */
async function storeLocationIdForSpot(spotId: number): Promise<number | null> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations
      WHERE poster_spot_id = $1 AND type = 'store' AND is_active = TRUE
      LIMIT 1`,
    [spotId],
  );
  const idRaw = rows[0]?.id;
  return idRaw === undefined ? null : Number(idRaw);
}

// =============================================================================
// GET /api/dashboard/top-products
// =============================================================================
//
// Top-selling products for the SELECTED date range, sourced from Poster
// `dash.getProductsSales`. Poster returns one row per product+modification, so
// the route aggregates by `product_id` (summing qty + revenue across the
// product's modifications), then sorts by revenue desc and takes the top N.
//
// Query params (same range contract as /revenue-breakdown):
//   ?range=today|week|month|6m|custom    default = today.
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD        required when range=custom.
//   ?spotId=<int>     optional Poster spot_id; restricts the lookup to one
//                      store. PM/central/supply/ai may pass any spot; a scoped
//                      store_manager may only pass a spot mapped to one of
//                      their assigned store locations.
//   ?limit=<int>      how many products to return. Default 5, clamped 1..200.
//
// Response shape:
//   { from, to, spot_id,
//     products: [ { product_id, name, qty, unit, revenue, share } ] }
//   `share` = product revenue / total revenue across ALL products (0..1).
//
// RBAC mirrors /revenue-breakdown: pm / ai_assistant / store_manager /
//       central_warehouse_manager / supply_manager.
// =============================================================================

const TOP_PRODUCTS_DEFAULT_LIMIT = 5;
const TOP_PRODUCTS_MIN_LIMIT = 1;
// Raised 20 -> 200 so the "full ranking" detail sheet can request the entire
// product ranking. Poster `getProductsSales` returns ~200+ products; 200 caps
// the full list without truncating it for any realistic catalogue.
const TOP_PRODUCTS_MAX_LIMIT = 200;

type TopProductItem = {
  product_id: number;
  name: string;
  qty: number;
  unit: string;
  revenue: number;
  share: number;
};

type TopProductsResponse = {
  from: string;
  to: string;
  spot_id: number | null;
  products: TopProductItem[];
};

/** Display unit for a weight-sold (`weight_flag=1`) product. */
const SALES_UNIT_WEIGHT = 'kg';
/** Display unit for a piece-sold (`weight_flag=0`) product (dona). */
const SALES_UNIT_PIECE = 'dona';

/**
 * Normalise a Poster product-sales row's unit to a stable display unit.
 *
 * `weight_flag` is authoritative (live probe 2026-06-06: "1" -> sold by weight
 * in kg, "0" -> sold by piece). When `weight_flag` is missing we fall back to
 * the textual `unit` ("kg" -> kg, "p"/"pcs"/"dona" -> dona) and finally to
 * pieces, since a Poster catalogue product is piece-sold by default.
 */
function normalizeSalesUnit(
  weightFlag: string | number | undefined,
  unit: string | undefined,
): string {
  if (weightFlag !== undefined) {
    return Number(weightFlag) === 1 ? SALES_UNIT_WEIGHT : SALES_UNIT_PIECE;
  }
  const u = (unit ?? '').trim().toLowerCase();
  if (u === 'kg' || u === 'g' || u === 'l' || u === 'ml') return SALES_UNIT_WEIGHT;
  return SALES_UNIT_PIECE;
}

/** Round a quantity to 3 dp (kg-precision) without trailing FP noise. */
function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Round a share (0..1) to 4 dp. */
function roundShare(n: number): number {
  return Math.round(n * 10000) / 10000;
}

dashboardRouter.get(
  '/top-products',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const range = parseDateRange(req.query);
    const spotIdParam = parseOptionalSpotId(req.query.spotId ?? req.query.spot_id);
    const limit = parseTopProductsLimit(req.query.limit);

    // RBAC scoping for spotId — identical to /revenue-breakdown: a scoped
    // store_manager may only target a spot mapped to one of their assigned
    // store locations.
    if (
      !isSuperAdmin(principal) &&
      principal.role !== 'ai_assistant' &&
      principal.role !== 'central_warehouse_manager' &&
      principal.role !== 'supply_manager' &&
      spotIdParam !== null
    ) {
      const ok = await isSpotAssignedToPrincipal(principal.locationIds, spotIdParam);
      if (!ok) {
        throw AppError.forbidden(
          'You may only query product sales for spots in your assigned stores.',
        );
      }
    }

    const { tiyinToSom } = await import('../integrations/poster/posterMoney.js');
    const { createPosterClientFromConfig } = await import(
      '../integrations/poster/client.js'
    );

    const client = createPosterClientFromConfig();
    // Half-open [from, to) -> Poster's inclusive YYYYMMDD bounds.
    const lastDay = new Date(range.to.getTime() - 1);
    const dateFrom = toPosterDate(range.from);
    const dateTo = toPosterDate(lastDay);

    const rows = await client.getProductsSales({
      dateFrom,
      dateTo,
      ...(spotIdParam !== null ? { spotId: spotIdParam } : {}),
    });

    // Aggregate by product_id: one product appears once even if it sold under
    // several modifications. Revenue is summed in so'm; qty is summed in the
    // product's NATIVE unit.
    //
    // Unit logic (live probe 2026-06-06): Poster sells a product either BY
    // WEIGHT (`weight_flag=1`, `unit="kg"`, `count` is a decimal weight) or BY
    // PIECE (`weight_flag=0`, `unit="p"`, `count` is an integer count). In both
    // cases `count` is the canonical quantity field (it equals
    // `count_converted` for the `adia` catalogue). We normalise the displayed
    // unit from `weight_flag` so a weight product reads "kg" and a piece
    // product reads "dona" regardless of how Poster spells `unit`. All of a
    // product's modifications share the same sale mode, so summing `count`
    // across them stays unit-consistent.
    type Agg = { product_id: number; name: string; unit: string; qty: number; revenue: number };
    const byProduct = new Map<number, Agg>();
    let totalRevenue = 0;
    for (const row of rows) {
      const productId = Number(row.product_id);
      if (!Number.isFinite(productId)) continue;
      const qty = Number(row.count);
      const revenue = tiyinToSom(row.payed_sum);
      totalRevenue += revenue;
      const unit = normalizeSalesUnit(row.weight_flag, row.unit);
      const existing = byProduct.get(productId);
      if (existing === undefined) {
        byProduct.set(productId, {
          product_id: productId,
          name: row.product_name,
          unit,
          qty: Number.isFinite(qty) ? qty : 0,
          revenue,
        });
      } else {
        existing.qty += Number.isFinite(qty) ? qty : 0;
        existing.revenue += revenue;
      }
    }

    const products: TopProductItem[] = [...byProduct.values()]
      .sort((a, b) => b.revenue - a.revenue || a.product_id - b.product_id)
      .slice(0, limit)
      .map((p) => ({
        product_id: p.product_id,
        name: p.name,
        qty: roundQty(p.qty),
        unit: p.unit,
        revenue: Math.round(p.revenue * 100) / 100,
        // Share against the FULL revenue (all products), not just the top N.
        share: totalRevenue > 0 ? roundShare(p.revenue / totalRevenue) : 0,
      }));

    const response: TopProductsResponse = {
      from: range.from.toISOString().slice(0, 10),
      to: lastDay.toISOString().slice(0, 10),
      spot_id: spotIdParam,
      products,
    };
    res.status(200).json(response);
  }),
);

/** Parse `?limit=` to an int in [1, 200], defaulting to 5 when absent. */
function parseTopProductsLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') {
    return TOP_PRODUCTS_DEFAULT_LIMIT;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw AppError.validation('"limit" must be an integer.');
  }
  return Math.min(TOP_PRODUCTS_MAX_LIMIT, Math.max(TOP_PRODUCTS_MIN_LIMIT, n));
}

/** Parse `?spotId=` to a positive integer, or `null` when missing. */
function parseOptionalSpotId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw AppError.validation('"spotId" must be a positive integer.');
  }
  return n;
}

/**
 * Resolve the Poster `spot_id`s that a location-scoped principal may read,
 * derived from `locations.poster_spot_id` over their assigned store locations.
 *
 * Used to enforce server-side RBAC on Poster-backed endpoints (revenue /
 * payment breakdowns) that the POS exposes only chain-wide: a `store_manager`
 * with no explicit `spotId` is auto-scoped to their own store's spot(s) so the
 * answer can never span the chain (invariant 5 — every role sees only its own
 * link). The returned set is the principal's `store` locations that carry a
 * `poster_spot_id`; stores with `poster_spot_id IS NULL` have no Poster spot
 * and contribute nothing.
 *
 * Returns an empty array when the principal owns no spot-mapped store — the
 * caller must then yield a zero/empty result (NOT a chain-wide one).
 */
async function spotIdsForPrincipal(
  locationIds: readonly number[],
): Promise<number[]> {
  if (locationIds.length === 0) return [];
  const { rows } = await query<{ poster_spot_id: string }>(
    `SELECT DISTINCT poster_spot_id
       FROM locations
      WHERE id = ANY($1::int[])
        AND type = 'store'
        AND is_active = TRUE
        AND poster_spot_id IS NOT NULL`,
    [[...locationIds]],
  );
  return rows.map((r) => Number(r.poster_spot_id));
}

/**
 * Resolve the Poster spot scope for the per-transaction breakdown endpoints
 * (`/revenue-breakdown`, `/sales-breakdown?by=payment`).
 *
 * Returns:
 *   - `null` -> chain-wide (no spot filter): super-admin, pm, ai_assistant, and
 *     the chain-wide supply roles (central_warehouse_manager, supply_manager).
 *   - `number[]` -> the exact spot(s) the location-scoped principal may read.
 *     `[]` means "scoped but owns no Poster-mapped store" -> the caller must
 *     return an EMPTY result, never widen to chain-wide.
 *
 * When a location-scoped principal passes an explicit `spotId`, it must belong
 * to one of their assigned stores (403 otherwise); the scope is then that single
 * spot. With no `spotId`, the scope is EVERY spot their stores map to.
 */
async function resolveRevenueSpotScope(
  principal: AuthPrincipal,
  spotIdParam: number | null,
): Promise<number[] | null> {
  // Chain-wide roles: no spot filter. They may optionally narrow by `spotId`.
  if (
    isSuperAdmin(principal) ||
    principal.role === 'ai_assistant' ||
    principal.role === 'central_warehouse_manager' ||
    principal.role === 'supply_manager'
  ) {
    return spotIdParam === null ? null : [spotIdParam];
  }

  // Location-scoped principal (store_manager et al.).
  if (spotIdParam !== null) {
    const ok = await isSpotAssignedToPrincipal(principal.locationIds, spotIdParam);
    if (!ok) {
      throw AppError.forbidden(
        'You may only query revenue for spots in your assigned stores.',
      );
    }
    return [spotIdParam];
  }
  // No explicit spot -> auto-scope to the principal's own store spot(s).
  return spotIdsForPrincipal(principal.locationIds);
}

/**
 * Confirm that the Poster `spot_id` resolves to a `locations.id` inside the
 * principal's assigned set. Returns false when no `store` location maps
 * to the spot or the mapped location is not in scope.
 */
async function isSpotAssignedToPrincipal(
  locationIds: readonly number[],
  spotId: number,
): Promise<boolean> {
  if (locationIds.length === 0) return false;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations
      WHERE poster_spot_id = $1 AND type = 'store' AND is_active = TRUE
      LIMIT 1`,
    [spotId],
  );
  const idRaw = rows[0]?.id;
  if (idRaw === undefined) return false;
  return locationIds.includes(Number(idRaw));
}

// =============================================================================
// GET /api/dashboard/production-series
// =============================================================================
//
// A filter-aware time-series of PRODUCTION ORDERS bucketed over the resolved
// `[range.from, range.to)` window, MIRRORING the `sales_chart` series shape the
// `/ecosystem` route returns (`{ granularity, days }`). The frontend renders it
// as a line chart next to the sales series.
//
// Query param `?by=created|deadline` selects which timestamp drives bucketing;
// it DEFAULTS to `deadline` when absent OR invalid (a bad value never 422s —
// it silently falls back to `deadline`).
//
//   - `by=created` buckets on `production_orders.created_at` (TIMESTAMPTZ,
//     creation instant). Granularity follows the same today->hourly /
//     else->daily rule as `fetchSalesChart`: `range=today` emits one point per
//     hour (0..currentHour, `granularity:'hour'`, `date` = today's ISO on every
//     point); every other range emits one DAILY point per calendar day in the
//     window (`granularity:'day'`, zero-filled for days with no production).
//
//   - `by=deadline` buckets on `production_orders.deadline` (a DATE column with
//     NO time component). Because a DATE cannot sit on an hourly axis, this mode
//     is ALWAYS daily (`granularity:'day'`) — even for `range=today`, which
//     collapses to a single day bucket. Rows are bucketed by their deadline date
//     over `deadline >= $from::date AND deadline < $to::date`; rows with
//     `deadline IS NULL` are EXCLUDED (they have no point on the time axis). The
//     same daily zero-fill spine and RBAC scoping as the daily `created` path
//     are reused.
//
// Each point: `{ date, hour?, count, qty }` where `count` = number of
// production orders bucketed and `qty` = SUM of their `qty`. `hour` is present
// IFF granularity === 'hour' (i.e. only the `created`+today hourly path), same
// contract as `SalesChartItem`.
//
// The window is half-open `[from, to)` via parameterized bounds.
//
// RBAC: pm / ai_assistant / store_manager / central_warehouse_manager /
//       supply_manager — the same set as /revenue-breakdown. Scoping reuses the
//       production rule from `fetchProductionPlan` / `fetchKpiExtras`: a PO is
//       in scope when produced AT or shipped TO one of the principal's
//       locations (`location_id` OR `target_location_id`); pm / ai_assistant
//       see the whole chain.
// =============================================================================

/** One point of the production time-series — mirrors `SalesChartItem`. */
type ProductionSeriesItem = {
  date: string; // YYYY-MM-DD
  hour?: number; // 0-23, PRESENT IFF the wrapper granularity === 'hour'
  count: number; // number of production orders in the bucket
  qty: number; // SUM of their qty
};

type ProductionSeriesResponse = {
  granularity: SalesChartGranularity;
  days: ProductionSeriesItem[];
};

dashboardRouter.get(
  '/production-series',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const scope = resolveEcosystemScope(principal);
    const range = parseDateRange(req.query);

    // A scoped principal with no assigned locations has nothing to chart.
    if (scope.kind === 'empty') {
      // Empty payload keeps the `day` contract simplest for the empty-state UI.
      res
        .status(200)
        .json({ granularity: 'day', days: [] } satisfies ProductionSeriesResponse);
      return;
    }

    // `?by=` picks the bucketing timestamp; anything other than 'created'
    // (including absent / garbage) falls back to 'deadline' — never a 422.
    const by = req.query.by === 'created' ? 'created' : 'deadline';

    let response: ProductionSeriesResponse;
    if (by === 'deadline') {
      // Deadline is a DATE — always daily, even for range=today.
      response = await fetchProductionSeriesByDeadline(scope, range);
    } else {
      response =
        range.preset === 'today'
          ? await fetchProductionSeriesHourly(scope, range)
          : await fetchProductionSeriesDaily(scope, range);
    }
    res.status(200).json(response);
  }),
);

/**
 * The production-scope WHERE fragment, shared by the daily and hourly builders.
 * Mirrors `fetchProductionPlan`: a PO touches the scope when produced AT or
 * shipped TO one of the principal's locations. `chain` scope adds no filter.
 *
 * Appends its bind values to `params` and returns the SQL fragment; the caller
 * keeps numbering the range bounds that follow.
 */
function productionScopeClause(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  params: SqlParam[],
): string {
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    const idx = params.length;
    return `(po.location_id = ANY($${idx}::bigint[]) OR po.target_location_id = ANY($${idx}::bigint[]))`;
  }
  return 'TRUE'; // chain — every production order is visible.
}

/**
 * DAILY production series: one zero-filled point per calendar day in the
 * window. `generate_series` over the half-open `[from, to)` range emits every
 * day (UTC) even when no PO was created that day, so the line has no gaps —
 * the same gap-free intent as the daily sales series. Days are returned as
 * TEXT (`to_char`) straight from SQL to avoid the local-midnight timezone trap
 * the sales builder documents.
 */
async function fetchProductionSeriesDaily(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<ProductionSeriesResponse> {
  const params: SqlParam[] = [];
  const scopeSql = productionScopeClause(scope, params);
  params.push(range.from);
  const fromIdx = params.length;
  params.push(range.to);
  const toIdx = params.length;

  // `generate_series` yields each day's 00:00 UTC; the last bucket is `to - 1
  // day` so a half-open window never spills a trailing empty day. PO buckets
  // LEFT JOIN onto the day spine, zero-filling absent days.
  const { rows } = await query<{ day: string; count: string; qty: string }>(
    `WITH spine AS (
       SELECT generate_series(
                date_trunc('day', $${fromIdx}::timestamptz),
                date_trunc('day', $${toIdx}::timestamptz) - interval '1 day',
                interval '1 day'
              ) AS d
     ),
     buckets AS (
       SELECT date_trunc('day', po.created_at) AS d,
              count(*)    AS cnt,
              sum(po.qty) AS qty
         FROM production_orders po
        WHERE ${scopeSql}
          AND po.created_at >= $${fromIdx}
          AND po.created_at <  $${toIdx}
        GROUP BY date_trunc('day', po.created_at)
     )
     SELECT to_char(spine.d, 'YYYY-MM-DD') AS day,
            COALESCE(b.cnt, 0)             AS count,
            COALESCE(b.qty, 0)             AS qty
       FROM spine
       LEFT JOIN buckets b ON b.d = spine.d
      ORDER BY spine.d`,
    params,
  );

  const days = rows.map<ProductionSeriesItem>((r) => ({
    date: r.day,
    count: Number(r.count),
    qty: Number(r.qty),
  }));
  return { granularity: 'day', days };
}

/**
 * DEADLINE production series — the `by=deadline` path. ALWAYS daily because
 * `production_orders.deadline` is a DATE (no time component); even `range=today`
 * collapses to a single day bucket here. POs are bucketed by their deadline
 * DATE over the half-open window `deadline >= $from::date AND deadline <
 * $to::date`, and rows with a NULL deadline are EXCLUDED — they have no place on
 * a time axis. The zero-fill day spine, scope clause and TEXT day output match
 * `fetchProductionSeriesDaily` so the contract is identical.
 */
async function fetchProductionSeriesByDeadline(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<ProductionSeriesResponse> {
  const params: SqlParam[] = [];
  const scopeSql = productionScopeClause(scope, params);
  params.push(range.from);
  const fromIdx = params.length;
  params.push(range.to);
  const toIdx = params.length;

  // The spine is a series of plain DATEs (the bounds cast to ::date); the last
  // bucket is `to::date - 1 day` so the half-open window never spills a trailing
  // empty day. Deadline buckets LEFT JOIN onto the spine, zero-filling days with
  // no PO due. NULL deadlines drop out of `buckets` naturally (they fail the
  // range predicate and can't equal any spine day).
  const { rows } = await query<{ day: string; count: string; qty: string }>(
    `WITH spine AS (
       SELECT generate_series(
                $${fromIdx}::date,
                $${toIdx}::date - interval '1 day',
                interval '1 day'
              )::date AS d
     ),
     buckets AS (
       SELECT po.deadline AS d,
              count(*)    AS cnt,
              sum(po.qty) AS qty
         FROM production_orders po
        WHERE ${scopeSql}
          AND po.deadline IS NOT NULL
          AND po.deadline >= $${fromIdx}::date
          AND po.deadline <  $${toIdx}::date
        GROUP BY po.deadline
     )
     SELECT to_char(spine.d, 'YYYY-MM-DD') AS day,
            COALESCE(b.cnt, 0)             AS count,
            COALESCE(b.qty, 0)             AS qty
       FROM spine
       LEFT JOIN buckets b ON b.d = spine.d
      ORDER BY spine.d`,
    params,
  );

  const days = rows.map<ProductionSeriesItem>((r) => ({
    date: r.day,
    count: Number(r.count),
    qty: Number(r.qty),
  }));
  return { granularity: 'day', days };
}

/**
 * HOURLY production series — the `range=today` path. One point per hour from
 * 00:00 up to the CURRENT hour of the business day (never a future hour),
 * mirroring `fetchSalesChartHourly`. `date` is today's ISO on every point and
 * `hour` is 0..currentHour. Hours with no production are zero-filled.
 */
async function fetchProductionSeriesHourly(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<ProductionSeriesResponse> {
  const params: SqlParam[] = [];
  const scopeSql = productionScopeClause(scope, params);
  params.push(range.from);
  const fromIdx = params.length;
  params.push(range.to);
  const toIdx = params.length;

  // Bucket by hour-of-day (UTC) within today's window. Sparse — we zero-fill
  // the 0..currentHour spine in JS below, exactly as the hourly sales series
  // builds its fixed-length array.
  const { rows } = await query<{ hour: string; count: string; qty: string }>(
    `SELECT extract(hour FROM po.created_at)::int AS hour,
            count(*)    AS count,
            sum(po.qty) AS qty
       FROM production_orders po
      WHERE ${scopeSql}
        AND po.created_at >= $${fromIdx}
        AND po.created_at <  $${toIdx}
      GROUP BY extract(hour FROM po.created_at)::int
      ORDER BY 1`,
    params,
  );

  const countByHour = new Map<number, number>();
  const qtyByHour = new Map<number, number>();
  for (const r of rows) {
    const h = Number(r.hour);
    countByHour.set(h, Number(r.count));
    qtyByHour.set(h, Number(r.qty));
  }

  // `range.from` is the start of the business day (UTC); `range.to` is "now".
  // Emit 0..currentHour inclusive so we never render a future (empty) hour.
  const date = toPosterIsoDate(range.from);
  const currentHour = range.to.getUTCHours();

  const days: ProductionSeriesItem[] = [];
  for (let hour = 0; hour <= currentHour && hour < 24; hour++) {
    days.push({
      date,
      hour,
      count: countByHour.get(hour) ?? 0,
      qty: qtyByHour.get(hour) ?? 0,
    });
  }
  return { granularity: 'hour', days };
}

// =============================================================================
// GET /api/dashboard/requests-series
// =============================================================================
//
// A filter-aware time-series of REPLENISHMENT-REQUEST lifecycle events bucketed
// over the resolved `[range.from, range.to)` window. It MIRRORS the shape of
// `/production-series` (`{ granularity, days }`) so the frontend can render it
// as a two-line chart (accepted vs shipped) next to the other dashboard series.
//
// Each bucket carries THREE counts. Two are derived from the state-machine
// audit trail in `replenishment_transitions` and bucketed by the TRANSITION
// instant (`replenishment_transitions.created_at`):
//   - `accepted` = transitions that LEFT the NEW state (`from_status = 'NEW'`):
//     the moment a request was accepted / began processing ("qabul qilingan").
//   - `shipped`  = transitions that ENTERED `SHIP_TO_REQUESTER`
//     (`to_status = 'SHIP_TO_REQUESTER'`): the moment goods were dispatched to
//     the requester ("jo'natilgan").
//
// The third count comes from a DIFFERENT table/timestamp:
//   - `open` = replenishment requests that were RAISED but NOT YET ACCEPTED —
//     rows in `replenishment_requests` whose CURRENT `status = 'NEW'`, bucketed
//     by the REQUEST's OWN `replenishment_requests.created_at` (these requests
//     never left NEW, so there is no transition instant to bucket by — we use
//     the request's birth time). Because it is sourced from a different table
//     and timestamp than accepted/shipped, it is computed as its own per-bucket
//     aggregate and merged onto the SAME date/hour spine so all three counts
//     share identical buckets; a bucket with no open requests emits `open: 0`,
//     never a gap.
//
// We use the TRANSITION-history path (NOT the fallback) because the
// `replenishment_transitions` table exists in this schema (migration 0001,
// §4.2) and is the precise, append-only record of each state change with its
// own timestamp — far more accurate than proxying off the request row's
// created_at/updated_at. The fallback documented in the task is only needed
// when that history table is absent, which is not the case here.
//
// Granularity follows the same today->hourly / else->daily rule as
// `/production-series` `by=created`:
//   - `range=today` emits one point per hour (0..currentHour, `granularity:
//     'hour'`, `date` = today's ISO on every point);
//   - every other range emits one DAILY point per calendar day in the window
//     (`granularity:'day'`, zero-filled day spine so the lines have no gaps).
//
// Each point: `{ date, hour?, accepted, shipped, open }`. `hour` is present IFF
// granularity === 'hour'. The window is half-open `[from, to)`.
//
// Query params:
//   - `range` (+ `from`/`to` for custom) via `parseDateRange` — same contract
//     as every other dashboard series.
//   - OPTIONAL `locationId` (number) — narrow to ONE department/location.
//     Absent OR non-numeric/invalid is parsed LENIENTLY to "all departments the
//     principal may see" (never a 422), mirroring `/production-series` `?by=`.
//
// RBAC: pm / ai_assistant / store_manager / central_warehouse_manager /
//       supply_manager — the same set as /production-series & /revenue-breakdown.
//       Scoping is by the REQUEST's `requester_location_id` (the requester/owner
//       location), the same column every other replenishment dashboard read
//       scopes by; pm / ai_assistant see the whole chain. A transition is in
//       scope when its parent request's `requester_location_id` is one the
//       principal may see, further narrowed to `locationId` when provided.
// =============================================================================

/** One point of the replenishment-request time-series. */
type RequestsSeriesItem = {
  date: string; // YYYY-MM-DD
  hour?: number; // 0-23, PRESENT IFF the wrapper granularity === 'hour'
  accepted: number; // transitions that left NEW (from_status = 'NEW') in the bucket
  shipped: number; // transitions into SHIP_TO_REQUESTER in the bucket
  open: number; // requests still at status NEW, by rr.created_at in the bucket
};

type RequestsSeriesResponse = {
  granularity: SalesChartGranularity;
  days: RequestsSeriesItem[];
};

dashboardRouter.get(
  '/requests-series',
  authenticate,
  authorize(
    'pm',
    'ai_assistant',
    'store_manager',
    'central_warehouse_manager',
    'supply_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const scope = resolveEcosystemScope(principal);
    const range = parseDateRange(req.query);

    // A scoped principal with no assigned locations has nothing to chart.
    if (scope.kind === 'empty') {
      res
        .status(200)
        .json({ granularity: 'day', days: [] } satisfies RequestsSeriesResponse);
      return;
    }

    // OPTIONAL `locationId` — lenient parse: a finite positive integer narrows
    // to that one location; anything else (absent / non-numeric / garbage) is
    // treated as ABSENT and never 422s.
    const rawLocationId = Number(req.query.locationId);
    const locationId =
      Number.isInteger(rawLocationId) && rawLocationId > 0 ? rawLocationId : null;

    const response =
      range.preset === 'today'
        ? await fetchRequestsSeriesHourly(scope, range, locationId)
        : await fetchRequestsSeriesDaily(scope, range, locationId);
    res.status(200).json(response);
  }),
);

/**
 * The replenishment-request scope WHERE fragment, shared by the daily and
 * hourly builders. A transition is in scope when its parent request's
 * `requester_location_id` is one the principal may see (the same column every
 * other replenishment dashboard read scopes by); `chain` scope adds no filter.
 * When `locationId` is provided it further narrows to that single location
 * (still intersected with the principal's allowed set for `locations` scope, so
 * a scoped principal can never widen their view by passing a foreign id).
 *
 * The fragment is written against the request alias `rr`. It appends its bind
 * values to `params` and returns the SQL; the caller keeps numbering the range
 * bounds that follow.
 */
function requestsScopeClause(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  locationId: number | null,
  params: SqlParam[],
): string {
  const clauses: string[] = [];
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    clauses.push(`rr.requester_location_id = ANY($${params.length}::bigint[])`);
  }
  if (locationId !== null) {
    params.push(locationId);
    clauses.push(`rr.requester_location_id = $${params.length}`);
  }
  return clauses.length > 0 ? clauses.join(' AND ') : 'TRUE';
}

/**
 * DAILY requests series: one zero-filled point per calendar day in the window.
 * `generate_series` over the half-open `[from, to)` range emits every day (UTC)
 * even when no transition occurred that day, so the two lines have no gaps.
 * `accepted`/`shipped` come from a SINGLE pass over `replenishment_transitions`
 * joined to its parent request (for RBAC scoping), bucketed by the transition
 * `created_at` and aggregated with `FILTER` so they share one scan. `open` is a
 * SEPARATE per-bucket aggregate over `replenishment_requests` itself (current
 * `status = 'NEW'`, bucketed by the request's own `created_at`), LEFT JOINed
 * onto the SAME spine so all three counts share identical day buckets. Days are
 * returned as TEXT (`to_char`) straight from SQL to avoid the local-midnight
 * timezone trap the sales builder documents.
 */
async function fetchRequestsSeriesDaily(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
  locationId: number | null,
): Promise<RequestsSeriesResponse> {
  const params: SqlParam[] = [];
  // Transition-sourced scope (accepted/shipped) — written against `rr` joined
  // to the transitions table inside `buckets`.
  const scopeSql = requestsScopeClause(scope, locationId, params);
  params.push(range.from);
  const fromIdx = params.length;
  params.push(range.to);
  const toIdx = params.length;
  // Request-sourced scope (open) — same `rr` predicate, but its own bind values
  // so the placeholder indices stay sequential after the range bounds above.
  const openScopeSql = requestsScopeClause(scope, locationId, params);

  const { rows } = await query<{
    day: string;
    accepted: string;
    shipped: string;
    open: string;
  }>(
    `WITH spine AS (
       SELECT generate_series(
                date_trunc('day', $${fromIdx}::timestamptz),
                date_trunc('day', $${toIdx}::timestamptz) - interval '1 day',
                interval '1 day'
              ) AS d
     ),
     buckets AS (
       SELECT date_trunc('day', t.created_at) AS d,
              count(*) FILTER (WHERE t.from_status = 'NEW')               AS accepted,
              count(*) FILTER (WHERE t.to_status = 'SHIP_TO_REQUESTER')   AS shipped
         FROM replenishment_transitions t
         JOIN replenishment_requests rr ON rr.id = t.replenishment_id
        WHERE ${scopeSql}
          AND t.created_at >= $${fromIdx}
          AND t.created_at <  $${toIdx}
        GROUP BY date_trunc('day', t.created_at)
     ),
     open_buckets AS (
       SELECT date_trunc('day', rr.created_at) AS d,
              count(*) AS open
         FROM replenishment_requests rr
        WHERE ${openScopeSql}
          AND rr.status = 'NEW'
          AND rr.created_at >= $${fromIdx}
          AND rr.created_at <  $${toIdx}
        GROUP BY date_trunc('day', rr.created_at)
     )
     SELECT to_char(spine.d, 'YYYY-MM-DD') AS day,
            COALESCE(b.accepted, 0)        AS accepted,
            COALESCE(b.shipped, 0)         AS shipped,
            COALESCE(o.open, 0)            AS open
       FROM spine
       LEFT JOIN buckets b      ON b.d = spine.d
       LEFT JOIN open_buckets o ON o.d = spine.d
      ORDER BY spine.d`,
    params,
  );

  const days = rows.map<RequestsSeriesItem>((r) => ({
    date: r.day,
    accepted: Number(r.accepted),
    shipped: Number(r.shipped),
    open: Number(r.open),
  }));
  return { granularity: 'day', days };
}

/**
 * HOURLY requests series — the `range=today` path. One point per hour from 00:00
 * up to the CURRENT hour of the business day (never a future hour), mirroring
 * `fetchProductionSeriesHourly`. `date` is today's ISO on every point and `hour`
 * is 0..currentHour. Hours with no transition are zero-filled in JS.
 */
async function fetchRequestsSeriesHourly(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
  locationId: number | null,
): Promise<RequestsSeriesResponse> {
  const params: SqlParam[] = [];
  // Transition-sourced scope (accepted/shipped) for the `buckets` aggregate.
  const scopeSql = requestsScopeClause(scope, locationId, params);
  params.push(range.from);
  const fromIdx = params.length;
  params.push(range.to);
  const toIdx = params.length;
  // Request-sourced scope (open) — its own bind values appended after the range
  // bounds so the placeholder indices stay sequential.
  const openScopeSql = requestsScopeClause(scope, locationId, params);

  // Bucket by hour-of-day (UTC) within today's window. Sparse — we zero-fill
  // the 0..currentHour spine in JS below, exactly as the hourly production
  // series builds its fixed-length array. `accepted`/`shipped` come from the
  // transition history; `open` is a separate aggregate over the request rows
  // themselves (current status NEW, by `rr.created_at`) merged onto the same
  // hourly spine via a FULL OUTER JOIN on the hour key so an hour present in
  // only one source still emits the missing counts as 0.
  const { rows } = await query<{
    hour: string;
    accepted: string;
    shipped: string;
    open: string;
  }>(
    `WITH tbuckets AS (
       SELECT extract(hour FROM t.created_at)::int                        AS hour,
              count(*) FILTER (WHERE t.from_status = 'NEW')               AS accepted,
              count(*) FILTER (WHERE t.to_status = 'SHIP_TO_REQUESTER')   AS shipped
         FROM replenishment_transitions t
         JOIN replenishment_requests rr ON rr.id = t.replenishment_id
        WHERE ${scopeSql}
          AND t.created_at >= $${fromIdx}
          AND t.created_at <  $${toIdx}
        GROUP BY extract(hour FROM t.created_at)::int
     ),
     obuckets AS (
       SELECT extract(hour FROM rr.created_at)::int AS hour,
              count(*)                              AS open
         FROM replenishment_requests rr
        WHERE ${openScopeSql}
          AND rr.status = 'NEW'
          AND rr.created_at >= $${fromIdx}
          AND rr.created_at <  $${toIdx}
        GROUP BY extract(hour FROM rr.created_at)::int
     )
     SELECT COALESCE(t.hour, o.hour)   AS hour,
            COALESCE(t.accepted, 0)    AS accepted,
            COALESCE(t.shipped, 0)     AS shipped,
            COALESCE(o.open, 0)        AS open
       FROM tbuckets t
       FULL OUTER JOIN obuckets o ON o.hour = t.hour
      ORDER BY 1`,
    params,
  );

  const acceptedByHour = new Map<number, number>();
  const shippedByHour = new Map<number, number>();
  const openByHour = new Map<number, number>();
  for (const r of rows) {
    const h = Number(r.hour);
    acceptedByHour.set(h, Number(r.accepted));
    shippedByHour.set(h, Number(r.shipped));
    openByHour.set(h, Number(r.open));
  }

  // `range.from` is the start of the business day (UTC); `range.to` is "now".
  // Emit 0..currentHour inclusive so we never render a future (empty) hour.
  const date = toPosterIsoDate(range.from);
  const currentHour = range.to.getUTCHours();

  const days: RequestsSeriesItem[] = [];
  for (let hour = 0; hour <= currentHour && hour < 24; hour++) {
    days.push({
      date,
      hour,
      accepted: acceptedByHour.get(hour) ?? 0,
      shipped: shippedByHour.get(hour) ?? 0,
      open: openByHour.get(hour) ?? 0,
    });
  }
  return { granularity: 'hour', days };
}

// =============================================================================
// GET /api/dashboard/brak-summary — PM "Sifat & integritet" (quality) row.
// =============================================================================
//
// Aggregates brak (defective) quantities captured on goods-receipt across the
// chain, for the requested `?range`. Brak is recorded in TWO authoritative
// places (the `stock_movements` table has NO brak_qty column — confirmed
// against migrations 0001/0045/0056, so it contributes nothing here):
//
//   - replenishment_requests.brak_qty (+ brak_reason) — captured when a
//     requester (store / central) RECEIVES a shipment (migration 0045). The
//     corresponding GOOD qty is `qty_accepted` (the sellable qty kept). The
//     receipt timestamp is `closed_at` (set to now() on receive).
//     Receiving location = `requester_location_id`.
//
//   - purchase_orders.brak_qty (+ brak_reason) — captured when a
//     raw_warehouse_manager RECEIVES an approved purchase order (migration
//     0056). The brak qty is written off the warehouse via an `adjust`
//     movement, so the GOOD qty received is the ordered `qty`. The receipt
//     timestamp is `updated_at` (the `trg_purchase_updated` trigger stamps it
//     when status flips to 'received'). Receiving location = `target_location_id`.
//
// DENOMINATOR (assumption): `total_received_qty` is the GOOD qty received in
// the range — replenishment `qty_accepted` + purchase ordered `qty` — and the
// ratio is `brak / (good + brak)`. A NULL `qty_accepted` (older closed rows
// with no partial-accept bookkeeping) coalesces to 0 so it never inflates the
// denominator.
//
// RBAC mirrors /api/dashboard/aging-alerts (resolveEcosystemScope, M:N
// locationIds): pm / ai_assistant -> chain-wide; a scoped principal is limited
// to brak recorded at their assigned locations. An empty-scope principal gets
// zeros (never a 500).
// =============================================================================

const BRAK_TOP_LIMIT = 5;

type BrakAggregateRaw = {
  source: 'purchase' | 'replenishment';
  total_brak_qty: string | null;
  total_received_qty: string | null;
};

type BrakTopRaw = {
  product_id: string;
  product_name: string;
  unit: string;
  brak_qty: string;
  reason: string | null;
};

type BrakSummaryTopItem = {
  product_id: number;
  product_name: string;
  unit: string;
  brak_qty: number;
  reason: string | null;
};

type BrakSummaryResponse = {
  from: string;
  to: string;
  total_received_qty: number;
  total_brak_qty: number;
  brak_ratio: number;
  by_source: { purchase: number; replenishment: number };
  top: BrakSummaryTopItem[];
};

dashboardRouter.get(
  '/brak-summary',
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
    const range = parseDateRange(req.query);

    const fromIso = toIsoDate(range.from);
    // `range.to` is exclusive (half-open [from, to)); the "to" the UI shows is
    // the inclusive last day, so subtract 1ms before formatting.
    const toIso = toIsoDate(new Date(range.to.getTime() - 1));

    if (scope.kind === 'empty') {
      res.status(200).json({
        from: fromIso,
        to: toIso,
        total_received_qty: 0,
        total_brak_qty: 0,
        brak_ratio: 0,
        by_source: { purchase: 0, replenishment: 0 },
        top: [],
      } satisfies BrakSummaryResponse);
      return;
    }

    const [aggregates, top] = await Promise.all([
      fetchBrakAggregates(scope, range),
      fetchBrakTop(scope, range),
    ]);

    let purchaseBrak = 0;
    let replenishmentBrak = 0;
    let goodQty = 0;
    for (const row of aggregates) {
      const brak = Number(row.total_brak_qty ?? 0);
      goodQty += Number(row.total_received_qty ?? 0);
      if (row.source === 'purchase') purchaseBrak += brak;
      else replenishmentBrak += brak;
    }
    const totalBrak = purchaseBrak + replenishmentBrak;
    const denom = goodQty + totalBrak;
    const ratio = denom === 0 ? 0 : totalBrak / denom;

    res.status(200).json({
      from: fromIso,
      to: toIso,
      total_received_qty: round4(goodQty),
      total_brak_qty: round4(totalBrak),
      brak_ratio: Math.round(ratio * 10000) / 10000,
      by_source: {
        purchase: round4(purchaseBrak),
        replenishment: round4(replenishmentBrak),
      },
      top: top.map((r) => ({
        product_id: Number(r.product_id),
        product_name: r.product_name,
        unit: r.unit,
        brak_qty: round4(Number(r.brak_qty)),
        reason: r.reason,
      })),
    } satisfies BrakSummaryResponse);
  }),
);

/** Round a NUMERIC(14,4) total to 4 dp (kills float drift from summation). */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * Brak + good-received qty per source, scoped + range-clipped. Two UNION-ed
 * sub-aggregates so the route gets one round trip:
 *   - purchase:      received POs with brak; good qty = ordered `qty`,
 *                    timestamp = `updated_at`, location = `target_location_id`.
 *   - replenishment: closed requests with brak; good qty = `qty_accepted`,
 *                    timestamp = `closed_at`, location = `requester_location_id`.
 * Half-open `[from, to)` window on the respective receipt timestamp.
 */
async function fetchBrakAggregates(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<BrakAggregateRaw[]> {
  const params: SqlParam[] = [range.from, range.to];
  const fromIdx = 1;
  const toIdx = 2;

  let poLoc = '';
  let rrLoc = '';
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    const locIdx = params.length;
    poLoc = ` AND po.target_location_id = ANY($${locIdx}::bigint[])`;
    rrLoc = ` AND rr.requester_location_id = ANY($${locIdx}::bigint[])`;
  }

  const { rows } = await query<BrakAggregateRaw>(
    `SELECT 'purchase' AS source,
            coalesce(sum(po.brak_qty), 0)              AS total_brak_qty,
            coalesce(sum(po.qty), 0)                   AS total_received_qty
       FROM purchase_orders po
      WHERE po.status = 'received'
        AND po.brak_qty IS NOT NULL AND po.brak_qty > 0
        AND po.updated_at >= $${fromIdx} AND po.updated_at < $${toIdx}
        ${poLoc}
     UNION ALL
     SELECT 'replenishment' AS source,
            coalesce(sum(rr.brak_qty), 0)              AS total_brak_qty,
            coalesce(sum(rr.qty_accepted), 0)          AS total_received_qty
       FROM replenishment_requests rr
      WHERE rr.brak_qty IS NOT NULL AND rr.brak_qty > 0
        AND rr.closed_at IS NOT NULL
        AND rr.closed_at >= $${fromIdx} AND rr.closed_at < $${toIdx}
        ${rrLoc}`,
    params,
  );
  return rows;
}

/**
 * Top-N products by brak qty (descending), aggregated across BOTH sources for
 * the range + scope. The `reason` is the most-recent brak_reason for that
 * product (picked via DISTINCT ON over the unioned receipt rows). Good qty is
 * irrelevant here — this list is purely "what broke the most".
 */
async function fetchBrakTop(
  scope: Exclude<EcosystemScope, { kind: 'empty' }>,
  range: DateRange,
): Promise<BrakTopRaw[]> {
  const params: SqlParam[] = [range.from, range.to];
  const fromIdx = 1;
  const toIdx = 2;

  let poLoc = '';
  let rrLoc = '';
  if (scope.kind === 'locations') {
    params.push(scope.locationIds);
    const locIdx = params.length;
    poLoc = ` AND po.target_location_id = ANY($${locIdx}::bigint[])`;
    rrLoc = ` AND rr.requester_location_id = ANY($${locIdx}::bigint[])`;
  }
  params.push(BRAK_TOP_LIMIT);
  const limitIdx = params.length;

  const { rows } = await query<BrakTopRaw>(
    `WITH brak_rows AS (
       SELECT po.product_id, po.brak_qty AS brak_qty, po.brak_reason AS reason,
              po.updated_at AS at
         FROM purchase_orders po
        WHERE po.status = 'received'
          AND po.brak_qty IS NOT NULL AND po.brak_qty > 0
          AND po.updated_at >= $${fromIdx} AND po.updated_at < $${toIdx}
          ${poLoc}
       UNION ALL
       SELECT rr.product_id, rr.brak_qty AS brak_qty, rr.brak_reason AS reason,
              rr.closed_at AS at
         FROM replenishment_requests rr
        WHERE rr.brak_qty IS NOT NULL AND rr.brak_qty > 0
          AND rr.closed_at IS NOT NULL
          AND rr.closed_at >= $${fromIdx} AND rr.closed_at < $${toIdx}
          ${rrLoc}
     ),
     by_product AS (
       SELECT product_id, sum(brak_qty) AS brak_qty
         FROM brak_rows
        GROUP BY product_id
     ),
     latest_reason AS (
       SELECT DISTINCT ON (product_id) product_id, reason
         FROM brak_rows
        ORDER BY product_id, at DESC
     )
     SELECT bp.product_id, p.name AS product_name, p.unit::text AS unit,
            bp.brak_qty, lr.reason
       FROM by_product bp
       JOIN products p     ON p.id = bp.product_id
       LEFT JOIN latest_reason lr ON lr.product_id = bp.product_id
      ORDER BY bp.brak_qty DESC, bp.product_id
      LIMIT $${limitIdx}`,
    params,
  );
  return rows;
}
