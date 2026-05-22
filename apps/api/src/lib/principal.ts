/**
 * Principal access + location-scope guard helpers.
 *
 * `authenticate` attaches `req.auth`; these helpers read it with a definite
 * (non-undefined) type and enforce the location-scoped half of RBAC
 * (invariant 6 — "a store sees only its own data").
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
 * Enforce that a location-scoped principal may only touch its own location.
 * `pm` (and any chain-wide role with `locationId === null`) passes for any
 * location. A scoped principal must match `targetLocationId` exactly.
 */
export function assertLocationAccess(
  principal: AuthPrincipal,
  targetLocationId: number,
): void {
  if (isSuperAdmin(principal)) {
    return;
  }
  if (principal.locationId === null || principal.locationId !== targetLocationId) {
    throw AppError.forbidden('You may only access data for your own location.');
  }
}
