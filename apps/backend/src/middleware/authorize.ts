/**
 * `authorize` middleware factory — role-gates an endpoint.
 *
 * `authorize('pm', 'production_manager')` returns a middleware that lets the
 * request through only if `req.auth.role` is one of the listed roles. The
 * `pm` super-admin role always passes (spec section 6).
 *
 * Must run AFTER `authenticate`. Location-scoped checks ("a store sees only
 * its own data") are enforced inside each handler, since they need the
 * resource's location id.
 */
import type { NextFunction, Request, Response } from 'express';
import { SUPER_ADMIN_ROLE, type Role } from '../auth/roles.js';
import { AppError } from '../errors/index.js';
import { poolRunner, writeAudit } from '../lib/audit.js';
import './types.js';

/** Build a middleware that allows only the given roles (plus `pm`). */
export function authorize(...allowed: readonly Role[]): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = req.auth;
    if (principal === undefined) {
      // authorize was used without authenticate — a wiring bug, not a client error.
      next(AppError.unauthenticated('Authentication must run before authorization.'));
      return;
    }
    if (principal.role === SUPER_ADMIN_ROLE || allowed.includes(principal.role)) {
      next();
      return;
    }
    next(AppError.forbidden('Your role may not perform this action.'));
  };
}

/**
 * `authorizeWrite` — hardened role gate for **business write** endpoints.
 *
 * Owner-approved 2026-05-28: PM (super-admin) is **read-and-recommend** only
 * across the chain. Business write actions (stock movement, replenishment
 * lifecycle, production orders, purchase approvals, delivery assignment,
 * etc.) must be performed by the operator responsible for the target
 * location. PM is therefore **always** 403 here — no super-admin bypass.
 *
 * Configuration / admin endpoints (users, locations, products, /api/admin/*,
 * /api/stock/minmax, /api/stock/minmax-mode) are explicitly exempt and stay
 * on the legacy `authorize('pm', ...)` factory above.
 *
 * Pair this with `requireLocationOperator` inside the handler to also
 * enforce the (location, principal) ownership check.
 */
export function authorizeWrite(...allowed: readonly Role[]): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const principal = req.auth;
    if (principal === undefined) {
      next(AppError.unauthenticated('Authentication must run before authorization.'));
      return;
    }
    if (principal.role === SUPER_ADMIN_ROLE) {
      // Best-effort audit — never let an audit failure turn the 403 into 500.
      void writeAudit(poolRunner, {
        actorUserId: principal.userId,
        action: 'auth.forbidden.pm_write_blocked',
        entity: 'principal',
        entityId: principal.userId,
        payload: {
          reason: 'pm_write_blocked',
          method: req.method,
          path: req.originalUrl,
        },
        activeLocationId: principal.activeLocationId,
      }).catch(() => undefined);
      next(
        AppError.forbidden(
          'PM has read-only access; write actions require an operator role for the responsible location.',
        ),
      );
      return;
    }
    if (allowed.includes(principal.role)) {
      next();
      return;
    }
    next(AppError.forbidden('Your role may not perform this action.'));
  };
}
