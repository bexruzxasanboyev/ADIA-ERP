/**
 * RBAC roles — mirrors the `user_role` enum in the database
 * (db-schema-phase-1.sql) and the spec section 6 matrix.
 */
export const ROLES = [
  'pm',
  'raw_warehouse_manager',
  'production_manager',
  'supply_manager',
  'central_warehouse_manager',
  'store_manager',
  'ai_assistant',
] as const;

export type Role = (typeof ROLES)[number];

/** Type guard — narrows an unknown string to a valid `Role`. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * `pm` is the chain-wide super-admin: it implicitly satisfies any role gate.
 * Other roles are location-scoped (enforced per-endpoint in later sprints).
 */
export const SUPER_ADMIN_ROLE: Role = 'pm';
