/**
 * Principal access + location-scope guard helpers.
 *
 * `authenticate` attaches `req.auth`; these helpers read it with a definite
 * (non-undefined) type and enforce the location-scoped half of RBAC
 * (invariant 6 — "a store sees only its own data").
 *
 * F4.1 / ADR-0012 — multi-location (M:N) extension:
 *   - `principal.locationIds` carries every location the user is assigned
 *     to (primary + secondary). PM (chain-wide) gets an empty array — the
 *     `isSuperAdmin` branch handles them.
 *   - `principal.activeLocationId` is the request-scoped context: the
 *     `X-Active-Location` header takes precedence over the primary
 *     `locationId`. The header is validated against `locationIds` —
 *     anything outside the user's assigned set is a 403.
 *   - `assertLocationAccess` now accepts ANY assigned location.
 *   - `getEffectiveLocationIds` is the helper RBAC-scoped SQL uses to
 *     decide which ids to filter by — see callers in `routes/stock.ts`,
 *     `routes/replenishment.ts`, etc.
 */
import type { Request } from 'express';
import type { AuthPrincipal } from '../auth/jwt.js';
import { SUPER_ADMIN_ROLE } from '../auth/roles.js';
import { AppError } from '../errors/index.js';

/** Read the verified principal; throws if `authenticate` did not run. */
export function getPrincipal(req: Request): AuthPrincipal {
  const principal = req.auth;
  if (principal === undefined) {
    throw AppError.unauthenticated('Authentication must run before this handler.');
  }
  return principal;
}

/** True when the principal is the chain-wide super-admin (`pm`). */
export function isSuperAdmin(principal: AuthPrincipal): boolean {
  return principal.role === SUPER_ADMIN_ROLE;
}

/**
 * Enforce that a location-scoped principal may only touch a location it is
 * assigned to. `pm` (and any chain-wide super-admin) passes for any
 * location. A scoped principal must have `targetLocationId` in its
 * `locationIds` set (M:N — ADR-0012).
 */
export function assertLocationAccess(
  principal: AuthPrincipal,
  targetLocationId: number,
): void {
  if (isSuperAdmin(principal)) {
    return;
  }
  if (!principal.locationIds.includes(targetLocationId)) {
    throw AppError.forbidden('You may only access data for your own location.');
  }
}

/**
 * The set of location ids RBAC-scoped queries should filter by, in order
 * of preference:
 *
 *   1. PM (super-admin) — `null` (caller treats this as "no filter").
 *   2. `activeLocationId` set — narrow scope to that one location (better
 *      UX: "I picked Filial-2 in the header, show me only Filial-2").
 *   3. Otherwise — every assigned `locationIds`.
 *
 * `null` is reserved for chain-wide principals so callers can branch on it
 * unambiguously.
 */
export function getEffectiveLocationIds(
  principal: AuthPrincipal,
): number[] | null {
  if (isSuperAdmin(principal)) {
    return null;
  }
  if (principal.activeLocationId !== null) {
    return [principal.activeLocationId];
  }
  return principal.locationIds;
}
