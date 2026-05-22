/**
 * Shared domain types for the ADIA ERP web client.
 * Mirrors the API contract in docs/specs/phase-1-mvp.md §4 and §6
 * and the DB schema in docs/architecture/db-schema-phase-1.sql.
 */

/** RBAC roles — phase-1-mvp.md §6 matrix columns. */
export type Role =
  | 'pm'
  | 'raw_warehouse_manager'
  | 'production_manager'
  | 'supply_manager'
  | 'central_warehouse_manager'
  | 'store_manager';

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
