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
  /**
   * Primary location id (mirrored from `user_locations.is_primary=TRUE`).
   * `null` for chain-wide roles (`pm`, `ai_assistant`).
   */
  location_id: number | null;
  /**
   * Optional — used only when constructing `POST /api/users` payloads
   * for the M:N flow (F4.1). The list endpoint does NOT echo this field.
   */
  location_ids?: number[];
  /** Optional Telegram numeric id, when provisioned by the PM. */
  telegram_id?: number | null;
}

/**
 * F4.1 / ADR-0012 — one row of `GET /api/users/:id/locations`. Uses the
 * junction-table key `location_id` and exposes `assigned_at`. Distinct
 * from `MeLocation`, the lighter shape embedded in `/api/auth/me`.
 */
export interface UserLocation {
  location_id: number;
  name: string;
  type: LocationType;
  is_primary: boolean;
  assigned_at: string;
}

/**
 * F4.1 / ADR-0012 — one row inside `MeResponse.locations`. Uses `id`
 * (matching the `locations` table) and omits `assigned_at`; `/api/auth/me`
 * is hot and the LocationSwitcher does not need the timestamp.
 */
export interface MeLocation {
  id: number;
  name: string;
  type: LocationType;
  is_primary: boolean;
}

/** `GET /api/auth/me` envelope (F4.1). */
export interface MeResponse {
  user: User;
  locations: MeLocation[];
  /** `null` for PMs who have not selected one yet (chain-wide view). */
  active_location_id: number | null;
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

/**
 * `POST /api/auth/login` response — Sprint 3 added the refresh-token flow.
 * `token` is a backward-compat alias for `access_token` (kept by the
 * backend); the client prefers the explicit `access_token` field.
 */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  /** Backward-compat alias for `access_token`. */
  token?: string;
  user: User;
}

/** `POST /api/auth/refresh` response — rotated token pair. */
export interface RefreshResponse {
  access_token: string;
  refresh_token: string;
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
// Mirrors `apps/backend/src/services/{replenishment,productionOrder,purchaseOrder}.ts`.
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
 * `qty_needed` is a JS `number`: the backend pool (`apps/backend/src/db/pool.ts`)
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
// Mirrors `apps/backend/src/routes/dashboard.ts` OverviewResponse.
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

// ---------------------------------------------------------------------------
// Faza-2 — F2.1 dynamic min/max + F2.3 import warnings admin.
// Mirrors `apps/backend/src/routes/admin.ts` (phase-2.md §4.3, §7.3).
// ---------------------------------------------------------------------------

/** `import_warnings.severity` enum (phase-2.md §7.3). */
export type ImportWarningSeverity = 'info' | 'warning' | 'error';

/**
 * A single `import_warnings` row — Poster sync / BOM mismatch /
 * dynamic-recalc anomalies surface here for the PM (phase-2.md §2.3.3).
 */
export interface ImportWarning {
  id: number;
  source: string;
  entity: string | null;
  severity: ImportWarningSeverity;
  message: string;
  payload: Record<string, unknown> | null;
  resolved: boolean;
  resolved_at: string | null;
  created_at: string;
}

/** `GET /api/admin/import-warnings` envelope (phase-2.md §4.3). */
export interface ImportWarningsResponse {
  items: ImportWarning[];
  total: number;
  limit: number;
  offset: number;
}

/** `POST /api/admin/recalc-minmax` response (phase-2.md §4.3). */
export interface RecalcMinMaxResponse {
  updated_count: number;
  skipped_count: number;
  errors: Array<{ location_id: number; product_id: number; message: string }>;
}

// ---------------------------------------------------------------------------
// Faza-2 — F2.2 AI Assistant (Vertex AI Gemini, read-only).
// Mirrors `apps/backend/src/routes/assistant.ts` (phase-2.md §2.2, §4.1).
// ADR-0006 — `session_id` is a `number` for the frontend contract; the
// backend may carry it as UUID internally and surface a numeric handle, or
// emit it as bigint. We type as `number` per the team-lead spec; tests
// stub with simple integers.
// ---------------------------------------------------------------------------

/** A single tool-call summary attached to an assistant response. */
export interface AssistantToolCall {
  /** Tool function name, e.g. `get_stock`, `get_below_min`. */
  tool_name: string;
  /** Arguments the model called the tool with (server-injected RBAC scope is not shown). */
  args: Record<string, unknown>;
  /** Short human-readable summary of the tool result (e.g. "12 qator topildi"). */
  result_summary: string;
}

/**
 * Faza-3 F3.2 — AI write-action two-phase commit.
 * Mirrors `assistant_actions.status` enum on the backend.
 */
export type AssistantActionStatus =
  | 'pending'
  | 'executed'
  | 'rejected'
  | 'expired'
  | 'superseded';

/**
 * Pending write-action surfaced by the backend when the model invoked a
 * write tool. The UI renders a `PendingActionCard` and the user must
 * either `/confirm` or `/reject` before the side-effect lands.
 * Carried both inline (in `AssistantQueryResponse.pending_action`) and
 * attached to the assistant turn in `AssistantMessage.pending_action`.
 */
export interface AssistantPendingAction {
  action_id: number;
  tool_name: string;
  /** Human-readable one-line Uzbek summary of the action. */
  summary: string;
  args: Record<string, unknown>;
  /** ISO timestamp — action turns to `expired` after this moment. */
  expires_at: string;
}

/**
 * Resolved action — i.e. one that the user has confirmed or rejected,
 * or which the server has marked expired/superseded. Surfaces in the
 * message timeline (rebuilt from session history) and as the response of
 * `/confirm` and `/reject`.
 */
export interface AssistantActionResult {
  action_id: number;
  tool_name: string;
  summary: string;
  status: AssistantActionStatus;
  /** Tool-specific success payload; null on rejected/expired. */
  result?: unknown;
}

/**
 * `POST /api/assistant/query` response envelope.
 * `session_id` is returned even on the first turn (the backend created a new session).
 * `pending_action` is present when the model invoked a write tool — UI must surface it.
 */
export interface AssistantQueryResponse {
  session_id: number;
  /** Final assistant text — markdown allowed. */
  response: string;
  tool_calls: AssistantToolCall[];
  pending_action?: AssistantPendingAction;
}

/**
 * `POST /api/assistant/actions/:id/confirm` response envelope.
 * Returns the resolved action (status `executed`) plus tool-specific result.
 */
export interface AssistantConfirmActionResponse {
  action: AssistantActionResult;
}

/** `POST /api/assistant/actions/:id/reject` response envelope. */
export interface AssistantRejectActionResponse {
  action: AssistantActionResult;
}

/** A single chat message row, both for the live UI and for session history. */
export type AssistantMessageRole = 'user' | 'assistant' | 'tool';

export interface AssistantMessage {
  role: AssistantMessageRole;
  /** Text content; empty for pure tool-call rows. */
  content: string;
  /** Tool-calls emitted for an `assistant` turn (or describing the `tool` row). */
  tool_calls?: AssistantToolCall[];
  /**
   * Live pending write-action attached to this assistant turn (Faza-3 F3.2).
   * Mutually exclusive with `action_result` — once the user confirms/rejects
   * or the action expires, the UI replaces this with the resolved row.
   */
  pending_action?: AssistantPendingAction;
  /**
   * Resolved write-action surfaced after confirm/reject/expire, or hydrated
   * from session history. The card switches to a read-only outcome strip.
   */
  action_result?: AssistantActionResult;
  created_at: string;
}

/** `GET /api/assistant/sessions` row. */
export interface AssistantSessionSummary {
  id: number;
  /** Auto-summarised from the first user message; nullable for brand-new sessions. */
  title: string | null;
  updated_at: string;
}

/** `GET /api/assistant/sessions` envelope. */
export interface AssistantSessionsResponse {
  items: AssistantSessionSummary[];
  total: number;
  limit: number;
  offset: number;
}

/** `GET /api/assistant/sessions/:id` envelope. */
export interface AssistantSessionDetail {
  session: AssistantSessionSummary;
  messages: AssistantMessage[];
}

/**
 * A single purchase_orders row.
 * `qty` is a JS `number` — see the NUMERIC parser note on
 * `ReplenishmentRequest.qty_needed`. Approval timestamps are ISO strings.
 */
// ---------------------------------------------------------------------------
// Faza-3 — F3.4 Forecasting (Prophet sidecar; ADR-0010, phase-3.md §2.4).
// Mirrors `apps/backend/src/routes/forecasts.ts` ForecastsResponse.
// ---------------------------------------------------------------------------

/** A single day from the 14-day forecast horizon. */
export interface ForecastDailyPrediction {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Predicted demand (`yhat`). */
  yhat: number;
  /** Lower confidence bound (`yhat_lower`). */
  yhat_lower: number;
  /** Upper confidence bound (`yhat_upper`). */
  yhat_upper: number;
}

/**
 * A single `forecasts` row enriched with location/product names.
 * `expected_stockout_date` is `YYYY-MM-DD` or `null` when the
 * 14-day window does not exhaust current stock.
 * `stale` is set when the row's `generated_at` is older than 24h
 * (sidecar / cron has lagged).
 */
export interface ForecastItem {
  location_id: number;
  location_name: string;
  product_id: number;
  product_name: string;
  product_unit: Unit;
  daily_predictions: ForecastDailyPrediction[];
  expected_stockout_date: string | null;
  generated_at: string;
  stale: boolean;
}

/** `GET /api/forecasts` envelope. */
export interface ForecastsResponse {
  items: ForecastItem[];
}

// ---------------------------------------------------------------------------
// Faza-4 — F4.4 Dashboard ecosystem extension (phase-4.md §2.4).
// Mirrors `apps/backend/src/routes/dashboard.ts` GET /api/dashboard/ecosystem.
// ---------------------------------------------------------------------------

/** Poster POS sync run status — mirrors backend `poster_sync_runs.status`. */
export type PosterSyncStatus = 'ok' | 'partial' | 'failed';

/** Severity of a notification surfaced on the dashboard alerts feed. */
export type AlertSeverity = 'info' | 'warning' | 'danger';

/**
 * Notification type emitted by the backend `notifications` table. Mirrors
 * `apps/backend/src/services/notify.ts` `NotificationType`.
 */
export type DashboardAlertType =
  | 'stock_below_min'
  | 'replenishment_created'
  | 'production_order_created'
  | 'production_order_done'
  | 'shipment_created'
  | 'purchase_request_created'
  | 'purchase_request_approved'
  | 'poster_sync_failed'
  | 'negative_stock_detected';

/** Poster sync card — first block of the F4.4 envelope. */
export interface DashboardPosterStatus {
  /** ISO timestamp of the most recent `poster_sync_runs` finish, or null. */
  last_sync_at: string | null;
  /** null when no sync has run yet. */
  last_sync_status: PosterSyncStatus | null;
  /** Count of `import_warnings` rows with severity='error' in the last 24h. */
  sync_errors_24h: number;
  /** Number of sales rows ingested today (`poster_sales_log` rows). */
  sales_today_count: number;
  /** Total revenue of those sales, local-currency major units. */
  sales_today_sum: number;
}

/** One node in the ecosystem chain. */
export interface DashboardChainNode {
  location_id: number;
  location_name: string;
  location_type: LocationType;
  /** Number of (product, location) rows currently below `min_level`. */
  below_min_count: number;
  /** Number of non-terminal `replenishment_requests` targeting this location. */
  open_requests_count: number;
  /** Distinct products held at this location. */
  total_products: number;
}

/** One row in the alerts feed (mirrors `notifications` row). */
export interface DashboardAlert {
  id: number;
  type: DashboardAlertType;
  severity: AlertSeverity;
  message: string;
  /** Optional — only when the notification is location-scoped. */
  location_id: number | null;
  location_name?: string | null;
  created_at: string;
}

/** One point in the 30-day sales chart. */
export interface DashboardSalesPoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Aggregate sold quantity for the day (sum of `stock_movements.qty` where reason='sale'). */
  qty: number;
}

/**
 * `GET /api/dashboard/ecosystem` envelope. Mirrors phase-4.md §2.4 contract.
 */
export interface DashboardEcosystem {
  poster_status: DashboardPosterStatus;
  chain_flow: DashboardChainNode[];
  alerts_feed: DashboardAlert[];
  sales_chart: {
    days: DashboardSalesPoint[];
  };
}

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
