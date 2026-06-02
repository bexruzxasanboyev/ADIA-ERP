/**
 * M1 + Sprint-3 — Auth routes (spec section 4.1, ADR-0005).
 *
 *   POST /api/auth/login    — { login, password }  (username-only)
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
 *   /login   — 20 /  1 min / IP (brute-force guard, but loose enough for
 *               legitimate multi-user manual test sessions — F4.11
 *               Bug-MIN-04)
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
  revokeAllForUser,
  revokeOne,
  validateAndRotate,
} from '../auth/refreshTokens.js';
import { isRole, type Role } from '../auth/roles.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { asObject, optionalString, requireId, requireString } from '../lib/validate.js';
import { getPrincipal } from '../lib/principal.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { loadConfig } from '../config/index.js';

export const authRouter: Router = Router();

/**
 * bcrypt work factor for newly minted hashes — kept in step with the
 * user-management path (`routes/users.ts` BCRYPT_ROUNDS) and the seed so
 * every hash in `users.password_hash` uses one cost factor.
 */
const BCRYPT_ROUNDS = 10;

/** Minimum length accepted for a new password (mirrors routes/users.ts). */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Brute-force guard on the login endpoint: at most 20 attempts per IP per
 * 1-minute window. Disabled under `test` so in-process suites that log in
 * repeatedly are not throttled. Over the limit -> 429.
 *
 * F4.11 Bug-MIN-04: the previous 10 / 15-min window blocked manual setup
 * of the seven F4.11 test users from a single workstation. A 1-minute
 * window is still a meaningful brute-force guard against blind credential
 * stuffing (20 tries/min/IP is unusable against bcrypt) while letting
 * legitimate manual test sessions flow.
 */
const loginRateLimit: RequestHandler =
  loadConfig().nodeEnv === 'test'
    ? (_req, _res, next): void => next()
    : rateLimit({
        windowMs: 60 * 1000,
        limit: 20,
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
  username: string;
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
  username: string;
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
    username: row.username,
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
    // Username-only login. The body field is `login`; it is matched against
    // `users.username` (case-insensitive). Email was removed from the
    // identity model entirely.
    const loginRaw = optionalString(body, 'login');
    if (loginRaw === undefined) {
      throw AppError.validation('Field "login" must be a non-empty string.');
    }
    const password = requireString(body, 'password');

    // `users.username` is stored lowercased (CHECK `^[a-z0-9._-]{3,32}$`), so a
    // single normalisation pass makes the lookup case-insensitive.
    const normalised = loginRaw.toLowerCase();
    const { rows } = await query<UserRow>(
      `SELECT id, name, username, password_hash, role, location_id, telegram_id, is_active
         FROM users WHERE username = $1`,
      [normalised],
    );
    const user = rows[0];

    // Generic failure for missing user, wrong password or deactivated account
    // — never reveal which leg failed (no user enumeration).
    const invalid = AppError.unauthenticated('Invalid login or password.');
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
    // Record the login handle (username) used to sign in so a forensic reader
    // can answer "which handle was used?".
    await writeAudit(poolRunner, {
      actorUserId: publicUser.id,
      action: 'auth.login',
      entity: 'users',
      entityId: publicUser.id,
      payload: { login: publicUser.username },
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

    // Re-read the user so the response carries fresh `name`, `username`,
    // `telegram_id`, etc., not just the columns the rotate path needs.
    const { rows } = await query<UserRow>(
      `SELECT id, name, username, password_hash, role, location_id, telegram_id, is_active
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
      `SELECT id, name, username, password_hash, role, location_id, telegram_id, is_active
       FROM users WHERE id = $1 AND is_active = TRUE`,
      [principal.userId],
    );
    const user = rows[0];
    if (user === undefined) {
      throw AppError.unauthenticated('User no longer exists or is inactive.');
    }
    // F4.1 / ADR-0012 — enrich the response with the user's assigned
    // locations (M:N) so the frontend can render a location switcher.
    const { rows: locationRows } = await query<{
      id: string;
      name: string;
      type: string;
      is_primary: boolean;
    }>(
      `SELECT l.id, l.name, l.type::text AS type, ul.is_primary
         FROM user_locations ul
         JOIN locations l ON l.id = ul.location_id
        WHERE ul.user_id = $1
        ORDER BY ul.is_primary DESC, l.name`,
      [principal.userId],
    );
    const locations = locationRows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      type: r.type,
      is_primary: r.is_primary,
    }));
    res.status(200).json({
      user: toPublicUser(user),
      locations,
      active_location_id: principal.activeLocationId,
    });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /api/auth/active-location — F4.1 (ADR-0012)
// ---------------------------------------------------------------------------
// Sets the request-scoped active location. The server is STATELESS — the
// client must also send `X-Active-Location: <id>` on every subsequent
// request. This endpoint validates the choice (must be assigned to the
// user) and writes one audit-log row so forensic readers can answer
// "when did this user start working under that location?".
authRouter.patch(
  '/active-location',
  authenticate,
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const locationId = requireId(body, 'location_id');

    // PM (chain-wide) may pick any existing location; scoped users may pick
    // only one from their M:N set.
    if (principal.role !== 'pm' && !principal.locationIds.includes(locationId)) {
      throw new AppError(
        'FORBIDDEN',
        'Active location is not assigned to this user.',
      );
    }
    // For PM, sanity-check the id exists at all (better 422 than silent no-op).
    if (principal.role === 'pm') {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM locations WHERE id = $1`,
        [locationId],
      );
      if (rows[0] === undefined) {
        throw AppError.notFound('Location not found.');
      }
    }

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'auth.active_location.set',
      entity: 'users',
      entityId: principal.userId,
      payload: { location_id: locationId },
      // Record the NEW active location so forensic readers see what
      // context the user just switched into.
      activeLocationId: locationId,
    });
    res.status(200).json({ active_location_id: locationId });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/change-password — self-service password change (Profil page)
// ---------------------------------------------------------------------------
// Operates on the CURRENT user only (principal.userId). There is NO target
// `userId` field — a user can only change their OWN password. Admin-driven
// resets, if ever needed, belong on a separate users-management endpoint.
//
// Flow:
//   1. validate the body ({ current_password, new_password }, min length 8),
//   2. load the user's current `password_hash`,
//   3. verify `current_password` with bcrypt — wrong -> 401,
//   4. hash `new_password` (BCRYPT_ROUNDS) and UPDATE users.password_hash,
//   5. revoke every refresh token for the user so other sessions are forced
//      to re-authenticate (consistent with the revoke-on-logout model),
//   6. write one audit-log row (who / when / what — never the passwords),
//   7. 204.
authRouter.post(
  '/change-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const currentPassword = requireString(body, 'current_password');
    const newPassword = requireString(body, 'new_password');
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw AppError.validation(
        `Field "new_password" must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }

    // Load only the hash + activity flag for the CURRENT user.
    const { rows } = await query<{ password_hash: string; is_active: boolean }>(
      `SELECT password_hash, is_active FROM users WHERE id = $1`,
      [principal.userId],
    );
    const user = rows[0];
    if (user === undefined || !user.is_active) {
      // The access token outlived the account (deactivated / deleted).
      throw AppError.unauthenticated('User no longer exists or is inactive.');
    }

    const currentOk = await bcrypt.compare(currentPassword, user.password_hash);
    if (!currentOk) {
      // User-facing message in Uzbek (UI language); 401 keeps it in the
      // authn family the rest of this router uses for credential failures.
      throw AppError.unauthenticated("Joriy parol noto'g'ri.");
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [newHash, principal.userId],
    );

    // A password change should not leave other sessions logged in — revoke
    // every active refresh token for this user (force re-login elsewhere).
    // The current caller already holds an access token; it stays valid until
    // it expires, but it can no longer be refreshed.
    await revokeAllForUser(principal.userId);

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'auth.password.change',
      entity: 'users',
      entityId: principal.userId,
      // Never log password material — record only that the change happened.
      payload: { self_service: true },
    });

    res.status(204).end();
  }),
);
