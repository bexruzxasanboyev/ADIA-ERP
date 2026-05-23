/**
 * Shared domain types for the ADIA ERP web client.
 * Mirrors the API contract in docs/specs/phase-1-mvp.md §4 and §6
 * and the DB schema in docs/architecture/db-schema-phase-1.sql.
 */

/**
 * RBAC roles — phase-1-mvp.md §6 matrix columns.
 *
 * `ai_assistant` mirrors the backend `user_role` enum (auth/roles.ts) so
 * the client type stays drift-free. It is NOT user-facing in Faza-1 — the
 * sidebar, role-routes, and forms never offer it as an option — but a
 * `User` returned by the API may legitimately carry it.
 */
export type Role =
  | 'pm'
  | 'raw_warehouse_manager'
  | 'production_manager'
  | 'supply_manager'
  | 'central_warehouse_manager'
  | 'store_manager'
  | 'ai_assistant';

/** Location classification — db-schema location_type enum. */
export type LocationType =
  | 'raw_warehouse'
  | 'production'
  | 'supply'
  | 'central_warehouse'
  | 'store';

/** Product classification — db-schema product_type enum. */
export type ProductType = 'raw' | 'semi' | 'finished';

/** Unit of measure — db-schema unit_type enum. */
export type Unit = 'kg' | 'l' | 'pcs';

/** stock_movement reason — db-schema movement_reason enum. */
export type MovementReason =
  | 'sale'
  | 'production_input'
  | 'production_output'
  | 'transfer'
  | 'purchase'
  | 'adjust';

/**
 * Identifier type for all primary/foreign keys. The backend serialises
 * `BIGSERIAL`/`BIGINT` columns as JSON numbers, so the client mirrors
 * that — every `id`, `location_id`, `product_id`, `parent_id`, etc. is a
 * `number`. Equality checks and `<Select>` values must account for the
 * string↔number boundary at the DOM edge (a `<select>` value is always a
 * string — see `MovementDialog`).
 */
export interface User {
  id: number;
  name: string;
  email: string;
  role: Role;
  location_id: number | null;
}

export interface Location {
  id: number;
  name: string;
  type: LocationType;
  parent_id: number | null;
  manager_user_id: number | null;
  poster_storage_id: number | null;
  lead_time_days: number | null;
  review_days: number | null;
  safety_factor: number | null;
}

export interface Product {
  id: number;
  name: string;
  type: ProductType;
  unit: Unit;
  sku: string | null;
  poster_ingredient_id: number | null;
  poster_product_id: number | null;
  is_active: boolean;
}

/** A single BOM line — phase-1-mvp.md §4.3. */
export interface RecipeLine {
  component_product_id: number;
  qty_per_unit: number;
}

/** Stock row for a (location, product) pair — phase-1-mvp.md §4.4. */
export interface StockRow {
  location_id: number;
  product_id: number;
  qty: number;
  min_level: number;
  max_level: number;
  /** db-schema: minmax_mode CHECK (minmax_mode IN ('manual','dynamic')). */
  minmax_mode: 'manual' | 'dynamic';
  updated_at: string;
  /** Embedded by the backend for display — `GET /api/stock` always sends these. */
  product_name: string;
  product_unit: Unit;
}

/** Stock ledger entry — phase-1-mvp.md §4.4. */
export interface StockMovement {
  id: number;
  product_id: number;
  from_location_id: number | null;
  to_location_id: number | null;
  qty: number;
  reason: MovementReason;
  note: string | null;
  created_at: string;
  created_by: number | null;
  /** Embedded by the backend for display — always present on list responses. */
  product_name: string;
  product_unit: Unit;
  from_location_name: string | null;
  to_location_name: string | null;
}

/** Standard API error envelope — phase-1-mvp.md §4.10. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface LoginResponse {
  token: string;
  user: User;
}

/**
 * Paginated envelope returned by `GET /api/stock/movements`.
 * The only list endpoint that wraps its rows — every other list endpoint
 * returns a bare array.
 */
export interface MovementsResponse {
  items: StockMovement[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Sprint 2 — replenishment, production orders, purchase orders.
// Mirrors `apps/api/src/services/{replenishment,productionOrder,purchaseOrder}.ts`.
// ---------------------------------------------------------------------------

/** Replenishment state machine — phase-1-mvp.md §3 (10 holat). */
export type ReplenishmentStatus =
  | 'NEW'
  | 'CHECK_STORE_SUPPLIER'
  | 'SHIP_TO_REQUESTER'
  | 'CHECK_PRODUCTION_INPUT'
  | 'CREATE_PURCHASE_ORDER'
  | 'CREATE_PRODUCTION_ORDER'
  | 'PRODUCING'
  | 'DONE_TO_WAREHOUSE'
  | 'CLOSED'
  | 'CANCELLED';

/** Terminal replenishment statuses — no further transitions allowed. */
export const TERMINAL_REPLENISHMENT_STATUSES: readonly ReplenishmentStatus[] = [
  'CLOSED',
  'CANCELLED',
];

/**
 * A single replenishment_requests row.
 * `qty_needed` is a JS `number`: the backend pool (`apps/api/src/db/pool.ts`)
 * registers a NUMERIC (OID 1700) type parser that calls `parseFloat`, so every
 * NUMERIC column arrives on the wire and at this client as a plain number.
 * Faza-1 columns are NUMERIC(14,4) / NUMERIC(14,2) — well within JS exact
 * integer/float range.
 */
export interface ReplenishmentRequest {
  id: number;
  product_id: number;
  requester_location_id: number;
  target_location_id: number | null;
  qty_needed: number;
  status: ReplenishmentStatus;
  production_order_id: number | null;
  purchase_order_id: number | null;
  shipment_movement_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /**
   * Embedded by the backend for display — `GET /api/replenishment` and
   * `GET /api/replenishment/:id` always send these (JOIN products /
   * locations). `target_location_name` is nullable because the column
   * itself is optional.
   */
  product_name: string;
  product_unit: Unit;
  requester_location_name: string;
  target_location_name: string | null;
}

/** A single replenishment_transitions audit row. */
export interface ReplenishmentTransition {
  id: number;
  from_status: ReplenishmentStatus | null;
  to_status: ReplenishmentStatus;
  reason: string | null;
  actor_user_id: number | null;
  created_at: string;
  /**
   * Embedded by the backend — JOIN users so the UI can render "kim"
   * without an extra `/api/users` fetch. `null` for system / cron rows.
   */
  actor_name: string | null;
}

/** `GET /api/replenishment/:id` envelope — request + transitions tarixi. */
export interface ReplenishmentDetail {
  request: ReplenishmentRequest;
  transitions: ReplenishmentTransition[];
}

/** `POST /api/replenishment/:id/advance` envelope. */
export interface ReplenishmentAdvanceResponse {
  advanced: boolean;
  status: ReplenishmentStatus;
  reason: string;
  request: ReplenishmentRequest;
}

/** Production order status — production_orders.status enum. */
export type ProductionOrderStatus = 'new' | 'in_progress' | 'done' | 'cancelled';

/**
 * A single production_orders row.
 * `qty` is a JS `number` — see the NUMERIC parser note on
 * `ReplenishmentRequest.qty_needed`.
 * `deadline` is an ISO date (YYYY-MM-DD) or null.
 */
export interface ProductionOrder {
  id: number;
  product_id: number;
  qty: number;
  location_id: number;
  target_location_id: number | null;
  deadline: string | null;
  status: ProductionOrderStatus;
  replenishment_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  /**
   * Embedded by the backend for display — `GET /api/production-orders`
   * always sends these. `target_location_name` is nullable because the
   * column itself is optional.
   */
  product_name: string;
  location_name: string;
  target_location_name: string | null;
}

/** Purchase order status — purchase_orders.status enum. */
export type PurchaseOrderStatus =
  | 'draft'
  | 'approved'
  | 'received'
  | 'cancelled'
  | 'rejected';

/** Two-step approval step identifier — purchaseOrder.ts ApprovalStep. */
export type PurchaseApprovalStep = 'manager' | 'keeper';

// ---------------------------------------------------------------------------
// Sprint 3 — M8 Dashboard overview.
// Mirrors `apps/api/src/routes/dashboard.ts` OverviewResponse.
// ---------------------------------------------------------------------------

/** Below-min row embedded in `DashboardOverview.below_min`. */
export interface DashboardBelowMinItem {
  location_id: number;
  location_name: string;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  qty: number;
  min_level: number;
  max_level: number;
  /** The open replenishment request id, if any (invariant 2: at most one). */
  open_request_id: number | null;
  /** Backend serialises the status enum as string; null when no open request. */
  open_request_status: ReplenishmentStatus | null;
}

/** Production plan row embedded in `DashboardOverview.production_plan`. */
export interface DashboardProductionPlanItem {
  id: number;
  product_id: number;
  product_name: string;
  qty: number;
  status: ProductionOrderStatus;
  location_id: number;
  location_name: string;
  target_location_id: number | null;
  target_location_name: string | null;
  /** Date-only `YYYY-MM-DD` or null. */
  deadline: string | null;
}

/** Recent movement row embedded in `DashboardOverview.recent_movements`. */
export interface DashboardRecentMovementItem {
  id: number;
  created_at: string;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  from_location_id: number | null;
  from_location_name: string | null;
  to_location_id: number | null;
  to_location_name: string | null;
  qty: number;
  reason: MovementReason;
}

/**
 * `GET /api/dashboard/overview` envelope. Wired to the backend
 * `OverviewResponse` shape (phase-1-mvp.md §4.8, §2.8).
 */
export interface DashboardOverview {
  below_min: DashboardBelowMinItem[];
  open_requests: {
    /** Counts keyed by open replenishment status (terminal ones excluded). */
    by_status: Partial<Record<ReplenishmentStatus, number>>;
    total: number;
    /** ISO timestamp of the oldest open request, or null. */
    oldest_created_at: string | null;
  };
  production_plan: DashboardProductionPlanItem[];
  recent_movements: DashboardRecentMovementItem[];
  kpis: {
    total_open_requests: number;
    below_min_count: number;
    active_production_orders: number;
    pending_approvals: number;
  };
}

/**
 * A single purchase_orders row.
 * `qty` is a JS `number` — see the NUMERIC parser note on
 * `ReplenishmentRequest.qty_needed`. Approval timestamps are ISO strings.
 */
export interface PurchaseOrder {
  id: number;
  product_id: number;
  qty: number;
  supplier_id: number | null;
  target_location_id: number;
  status: PurchaseOrderStatus;
  replenishment_id: number | null;
  manager_approved_by: number | null;
  manager_approved_at: string | null;
  keeper_approved_by: number | null;
  keeper_approved_at: string | null;
  received_movement_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  /**
   * Embedded by the backend for display — `GET /api/purchase-orders`
   * always sends these. Approver / supplier names are nullable because
   * the referenced FK columns are themselves optional.
   */
  product_name: string;
  target_location_name: string;
  manager_approved_name: string | null;
  keeper_approved_name: string | null;
  supplier_name: string | null;
}
