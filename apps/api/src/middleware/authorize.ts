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
