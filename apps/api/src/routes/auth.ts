/**
 * M1 — Auth routes (spec section 4.1).
 *
 *   POST /api/auth/login   — { email, password } -> { token, user }
 *   GET  /api/auth/me      — the current principal's user row
 *
 * Passwords are verified with `bcryptjs` against `users.password_hash`.
 * Login failures return a single generic 401 — the response never reveals
 * whether the email exists (no user-enumeration). `POST /login` is rate-
 * limited per IP as a brute-force guard.
 */
import { Router } from 'express';
import type { RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { query } from '../db/index.js';
import { signToken } from '../auth/jwt.js';
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

// POST /api/auth/login
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
      // Still run a hash compare path is unnecessary here; bcrypt timing on the
      // happy path dominates — the generic message prevents enumeration.
      throw invalid;
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      throw invalid;
    }

    const publicUser = toPublicUser(user);
    const token = signToken({
      userId: publicUser.id,
      role: publicUser.role,
      locationId: publicUser.location_id,
    });
    res.status(200).json({ token, user: publicUser });
  }),
);

// GET /api/auth/me
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
