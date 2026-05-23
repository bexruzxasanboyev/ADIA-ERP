/**
 * JWT signing and verification.
 *
 * The token carries the minimum needed for RBAC: the user id, role and
 * (location-scoped) location id. The secret comes from validated config —
 * never hard-coded.
 */
import jwt from 'jsonwebtoken';
import { loadConfig } from '../config/index.js';
import { isRole, type Role } from './roles.js';

/** The authenticated principal carried by a verified JWT. */
export type AuthPrincipal = {
  readonly userId: number;
  readonly role: Role;
  /** null for chain-wide roles (pm, ai_assistant). */
  readonly locationId: number | null;
};

/** The raw JWT claim shape we sign and expect back. */
type JwtClaims = {
  readonly sub: string; // user id as string
  readonly role: string;
  readonly locationId: number | null;
};

/** Sign a JWT for an authenticated user. */
export function signToken(principal: AuthPrincipal): string {
  const cfg = loadConfig();
  const claims: JwtClaims = {
    sub: String(principal.userId),
    role: principal.role,
    locationId: principal.locationId,
  };
  return jwt.sign(claims, cfg.jwt.secret, {
    expiresIn: cfg.jwt.expiresInSeconds,
    issuer: 'adia-erp',
  });
}

/**
 * Verify and decode a JWT. Throws on an invalid/expired token or malformed
 * claims — callers (the `authenticate` middleware) translate that into a
 * 401 response.
 */
export function verifyToken(token: string): AuthPrincipal {
  const cfg = loadConfig();
  const decoded = jwt.verify(token, cfg.jwt.secret, { issuer: 'adia-erp' });

  if (typeof decoded !== 'object' || decoded === null) {
    throw new Error('Malformed JWT payload.');
  }
  const claims = decoded as Partial<JwtClaims>;
  const userId = Number(claims.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error('JWT "sub" claim is not a valid user id.');
  }
  if (!isRole(claims.role)) {
    throw new Error('JWT "role" claim is not a recognised role.');
  }
  const locationId =
    claims.locationId === null || claims.locationId === undefined ? null : Number(claims.locationId);
  if (locationId !== null && (!Number.isInteger(locationId) || locationId <= 0)) {
    throw new Error('JWT "locationId" claim is invalid.');
  }

  return { userId, role: claims.role, locationId };
}
