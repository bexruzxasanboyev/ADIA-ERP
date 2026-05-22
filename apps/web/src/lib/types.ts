/**
 * Shared domain types for the ADIA ERP web client.
 * Mirrors the API contract in docs/specs/phase-1-mvp.md §4 and §6.
 */

/** RBAC roles — phase-1-mvp.md §6 matrix columns. */
export type Role =
  | 'pm'
  | 'raw_warehouse_manager'
  | 'production_manager'
  | 'supply_manager'
  | 'central_warehouse_manager'
  | 'store_manager';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  location_id: string | null;
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
