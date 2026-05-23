/**
 * M1 + Sprint-3 — Auth routes (spec section 4.1, ADR-0005).
 *
 *   POST /api/auth/login    — { email, password }
 *                             -> { access_token, refresh_token, user }
 *   POST /api/auth/refresh  — { refresh_token }
 *                             -> { access_token, refresh_token, user }
 *   POST /api/auth/logout   — { refresh_token }  (or Bearer header)
 *                             -> 204
 *   GET  /api/auth/me       — current principal (access-token gated)
 *
 * Passwords are verified with `bcryptjs` against `users.password_hash`.
 * Login + refresh failures return a single generic 401 — the response
 * never reveals whether the credential exists (no enumeration).
 *
 * Rate limits:
 *   /login   — 10 / 15 min / IP (brute-force guard)
 *   /refresh — 5  /  1 min / IP (defends a refresh-replay storm)
 * Both are disabled under `nodeEnv === 'test'`.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { query } from '../db/index.js';
import { signAccessToken } from '../auth/jwt.js';
import {
  issueRefreshToken,
  revokeOne,
  validateAndRotate,
} from '../auth/refreshTokens.js';
import { isRole, type Role } from '../auth/roles.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { asObject, requireString } from '../lib/validate.js';
import { getPrincipal } from '../lib/principal.js';
import { loadConfig } from '../config/index.js';

export const authRouter: Router = Router();

/**
 * Brute-force guard on the login endpoint: at most 10 attempts per IP per
 * 15-minute window. Disabled under `test` so in-process suites that log in
 * repeatedly are not throttled. Over the limit -> 429.
 */
const loginRateLimit: RequestHandler =
  loadConfig().nodeEnv === 'test'
    ? (_req, _res, next): void => next()
    : rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res): void => {
          res.status(429).json({
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many login attempts. Please try again later.',
            },
          });
        },
      });

/**
 * Refresh-endpoint rate limit: 5 attempts per minute per IP. Tighter than
 * /login because (a) the refresh path is hit only by legitimate clients
 * automatically, (b) a brute-force attack on opaque 256-bit tokens is
 * already infeasible — this cap is a DoS guard, not an authn guard.
 */
const refreshRateLimit: RequestHandler =
  loadConfig().nodeEnv === 'test'
    ? (_req, _res, next): void => next()
    : rateLimit({
        windowMs: 60 * 1000,
        limit: 5,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res): void => {
          res.status(429).json({
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many refresh attempts. Please try again later.',
            },
          });
        },
      });

/** A user row as stored — the password hash never leaves this module. */
type UserRow = {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  location_id: number | null;
  telegram_id: number | null;
  is_active: boolean;
};

/** The public user shape returned to clients (no password hash). */
type PublicUser = {
  id: number;
  name: string;
  email: string;
  role: Role;
  location_id: number | null;
  telegram_id: number | null;
};

function toPublicUser(row: UserRow): PublicUser {
  if (!isRole(row.role)) {
    // A row with an unknown role is a data-integrity problem, not a client error.
    throw AppError.internal('Stored user role is not recognised.');
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    location_id: row.location_id,
    telegram_id: row.telegram_id,
  };
}

/** Truncate a UA string defensively before persisting (DB column is TEXT,
 *  but a multi-MB header is not useful audit data). */
function readUserAgent(req: { header: (n: string) => string | undefined }): string | null {
  const raw = req.header('user-agent');
  if (raw === undefined) return null;
  return raw.length > 512 ? raw.slice(0, 512) : raw;
}

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
authRouter.post(
  '/login',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    const body = asObject(req.body);
    const email = requireString(body, 'email').toLowerCase();
    const password = requireString(body, 'password');

    const { rows } = await query<UserRow>(
      `SELECT id, name, email, password_hash, role, location_id, telegram_id, is_active
       FROM users WHERE email = $1`,
      [email],
    );
    const user = rows[0];

    // Generic failure for missing user, wrong password or deactivated account.
    const invalid = AppError.unauthenticated('Invalid email or password.');
    if (user === undefined || !user.is_active) {
      throw invalid;
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      throw invalid;
    }

    const publicUser = toPublicUser(user);
    const accessToken = signAccessToken({
      userId: publicUser.id,
      role: publicUser.role,
      locationId: publicUser.location_id,
    });
    const issued = await issueRefreshToken(publicUser.id, {
      userAgent: readUserAgent(req),
    });
    // NOTE: `token` field retained for one release as a backward-compat
    // alias of `access_token` — the frontend migrates over Sprint-3 and
    // it will be removed in Sprint-4.
    res.status(200).json({
      access_token: accessToken,
      refresh_token: issued.rawToken,
      token: accessToken,
      user: publicUser,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/refresh
// ---------------------------------------------------------------------------
authRouter.post(
  '/refresh',
  refreshRateLimit,
  asyncHandler(async (req, res) => {
    const body = asObject(req.body);
    const rawRefresh = requireString(body, 'refresh_token');

    const rotated = await validateAndRotate(rawRefresh, {
      userAgent: readUserAgent(req),
    });
    if (rotated === null) {
      // One generic failure mode — no leak of "expired vs reused vs
      // unknown". The client must redirect to /login.
      throw AppError.unauthenticated('Invalid or expired refresh token.');
    }

    // Re-read the user so the response carries fresh `name`, `email`,
    // `telegram_id`, etc., not just the columns the rotate path needs.
    const { rows } = await query<UserRow>(
      `SELECT id, name, email, password_hash, role, location_id, telegram_id, is_active
       FROM users WHERE id = $1 AND is_active = TRUE`,
      [rotated.user.userId],
    );
    const user = rows[0];
    if (user === undefined) {
      // Race: the user was deactivated between rotate and re-read. The
      // new refresh token is already issued but useless — revoke it.
      await revokeOne(rotated.raw);
      throw AppError.unauthenticated('Invalid or expired refresh token.');
    }

    const publicUser = toPublicUser(user);
    const accessToken = signAccessToken({
      userId: publicUser.id,
      role: publicUser.role,
      locationId: publicUser.location_id,
    });
    res.status(200).json({
      access_token: accessToken,
      refresh_token: rotated.raw,
      token: accessToken, // backward-compat alias (see /login)
      user: publicUser,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // Accept either `{ refresh_token }` in the body or a body-less call.
    // Idempotent — unknown / already-revoked / missing token still 204.
    let rawRefresh: string | undefined;
    if (typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)) {
      const candidate = (req.body as Record<string, unknown>)['refresh_token'];
      if (typeof candidate === 'string' && candidate.length > 0) {
        rawRefresh = candidate;
      }
    }
    if (rawRefresh !== undefined) {
      // Best-effort revoke — failures here are not visible to the
      // client (logout is "fire and forget" from the UI's point of view).
      await revokeOne(rawRefresh);
    }
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const { rows } = await query<UserRow>(
      `SELECT id, name, email, password_hash, role, location_id, telegram_id, is_active
       FROM users WHERE id = $1 AND is_active = TRUE`,
      [principal.userId],
    );
    const user = rows[0];
    if (user === undefined) {
      throw AppError.unauthenticated('User no longer exists or is inactive.');
    }
    res.status(200).json({ user: toPublicUser(user) });
  }),
);
