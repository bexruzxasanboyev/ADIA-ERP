/**
 * M1 + F4.1 — Users (spec section 4.2 + ADR-0012). PM-only for writes.
 *
 *   GET  /api/users                       — list users (no password hashes)
 *   POST /api/users                       — create user; password bcrypt-hashed;
 *                                            optional `location_ids[]` (M:N)
 *   GET  /api/users/:id/locations         — list assigned locations
 *   POST /api/users/:id/locations         — assign a location
 *   DELETE /api/users/:id/locations/:lid  — unassign a location
 *   PUT  /api/users/:id/locations/:lid/primary — swap primary (atomic)
 *
 * RBAC: PM does any write; users may read their own `:id/locations`.
 * Every change is audit-logged.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { ROLES } from '../auth/roles.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit } from '../lib/audit.js';
import { getPrincipal } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  parseIdParam,
  requireEnum,
  requireId,
  requireString,
} from '../lib/validate.js';

export const usersRouter: Router = Router();

/** bcrypt work factor — 10 rounds is the bcryptjs default, adequate here. */
const BCRYPT_ROUNDS = 10;

/** Minimum password length accepted at the boundary. */
const MIN_PASSWORD_LENGTH = 8;

type PublicUserRow = {
  id: number;
  name: string;
  email: string;
  role: string;
  location_id: number | null;
  telegram_id: number | null;
  is_active: boolean;
  created_at: Date;
};

const PUBLIC_COLUMNS = `id, name, email, role, location_id, telegram_id, is_active, created_at`;

// Roles that are chain-wide and may have a NULL location (DB check chk_users_location_required).
const CHAIN_WIDE_ROLES = new Set<string>(['pm', 'ai_assistant']);

/**
 * Parse optional `location_ids` (M:N) — must be a non-empty array of
 * positive integers, no duplicates. Returns undefined when absent so the
 * legacy single-`location_id` flow stays untouched.
 */
function parseLocationIds(body: Record<string, unknown>): number[] | undefined {
  const raw = body['location_ids'];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw AppError.validation('Field "location_ids" must be an array of positive integers.');
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw AppError.validation('Each "location_ids" entry must be a positive integer.');
    }
    if (seen.has(value)) {
      throw AppError.validation('Duplicate id in "location_ids".');
    }
    seen.add(value);
    out.push(value);
  }
  if (out.length === 0) {
    throw AppError.validation('Field "location_ids" must not be empty when provided.');
  }
  return out;
}

// GET /api/users  — pm only.
usersRouter.get(
  '/',
  authenticate,
  authorize('pm'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query<PublicUserRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY id`,
    );
    res.status(200).json(rows);
  }),
);

// POST /api/users  — pm only.
usersRouter.post(
  '/',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);

    const name = requireString(body, 'name');
    const email = requireString(body, 'email').toLowerCase();
    const password = requireString(body, 'password');
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw AppError.validation(
        `Field "password" must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }
    const role = requireEnum(body, 'role', ROLES);
    const singleLocationId = optionalId(body, 'location_id');
    const locationIds = parseLocationIds(body);
    const primaryLocationId = optionalId(body, 'primary_location_id');
    const telegramId = optionalId(body, 'telegram_id');

    // Resolve which locations to attach. Three accepted shapes:
    //   (a) `location_ids: [a,b,c]` (+ optional `primary_location_id`)
    //   (b) `location_id: 5`        (legacy single-location)
    //   (c) none                    (chain-wide roles only)
    let attached: number[] = [];
    let primaryId: number | null = null;
    if (locationIds !== undefined) {
      attached = locationIds;
      primaryId = primaryLocationId ?? locationIds[0]!;
      if (!locationIds.includes(primaryId)) {
        throw AppError.validation(
          '"primary_location_id" must be one of "location_ids".',
        );
      }
    } else if (singleLocationId !== undefined) {
      attached = [singleLocationId];
      primaryId = singleLocationId;
    }

    // Mirror the DB constraint at the boundary for a clear 422 instead of a 500.
    if (!CHAIN_WIDE_ROLES.has(role) && primaryId === null) {
      throw AppError.validation(`Role "${role}" requires at least one location.`);
    }

    // Reject a duplicate email with a clean 422 rather than a raw DB error.
    const existing = await query<{ id: number }>(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    if (existing.rows.length > 0) {
      throw AppError.validation('A user with this email already exists.');
    }

    // If location_ids were supplied, confirm all exist before insertion —
    // we get one clean 422 instead of N partial inserts + a raw FK error.
    if (attached.length > 0) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM locations WHERE id = ANY($1::bigint[])`,
        [attached],
      );
      if (rows.length !== attached.length) {
        throw AppError.validation('One or more "location_ids" do not exist.');
      }
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const created = await withTransaction(async (tx) => {
      const { rows } = await tx.query<PublicUserRow>(
        `INSERT INTO users (name, email, password_hash, role, location_id, telegram_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PUBLIC_COLUMNS}`,
        [name, email, passwordHash, role, primaryId, telegramId ?? null],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.internal('User insert returned no row.');
      }
      // Mirror the assigned locations into the M:N junction. `is_primary`
      // tracks the same row as `users.location_id`.
      for (const lid of attached) {
        await tx.query(
          `INSERT INTO user_locations (user_id, location_id, is_primary, assigned_by_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, location_id) DO NOTHING`,
          [row.id, lid, lid === primaryId, principal.userId],
        );
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'user.create',
        entity: 'users',
        entityId: row.id,
        payload: { email, role, location_ids: attached, primary_location_id: primaryId },
      });
      return row;
    });
    res.status(201).json({ user: created });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/users/:id/locations — pm or self
// ---------------------------------------------------------------------------
usersRouter.get(
  '/:id/locations',
  authenticate,
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const userId = parseIdParam(req.params['id'], 'id');
    if (principal.role !== 'pm' && principal.userId !== userId) {
      throw AppError.forbidden('You may only inspect your own locations.');
    }
    const { rows } = await query<{
      location_id: string;
      name: string;
      type: string;
      is_primary: boolean;
      assigned_at: Date;
    }>(
      `SELECT ul.location_id, l.name, l.type::text AS type,
              ul.is_primary, ul.assigned_at
         FROM user_locations ul
         JOIN locations l ON l.id = ul.location_id
        WHERE ul.user_id = $1
        ORDER BY ul.is_primary DESC, l.name`,
      [userId],
    );
    res.status(200).json(
      rows.map((r) => ({
        location_id: Number(r.location_id),
        name: r.name,
        type: r.type,
        is_primary: r.is_primary,
        assigned_at: r.assigned_at,
      })),
    );
  }),
);

// ---------------------------------------------------------------------------
// POST /api/users/:id/locations — pm only
// ---------------------------------------------------------------------------
usersRouter.post(
  '/:id/locations',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const userId = parseIdParam(req.params['id'], 'id');
    const body = asObject(req.body);
    const locationId = requireId(body, 'location_id');
    const isPrimary = body['is_primary'] === true;

    // Validate both rows exist — a missing user is 404, a missing
    // location is 422 (caller picked an invalid id).
    const { rows: userRows } = await query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [userId],
    );
    if (userRows[0] === undefined) {
      throw AppError.notFound('User not found.');
    }
    const { rows: locRows } = await query<{ id: string }>(
      `SELECT id FROM locations WHERE id = $1`,
      [locationId],
    );
    if (locRows[0] === undefined) {
      throw AppError.validation('Location does not exist.');
    }

    await withTransaction(async (tx) => {
      if (isPrimary) {
        // Atomic primary swap — clear the existing primary FIRST so the
        // partial unique index never sees two `is_primary=true` rows.
        await tx.query(
          `UPDATE user_locations SET is_primary = FALSE
             WHERE user_id = $1 AND is_primary = TRUE`,
          [userId],
        );
      }
      await tx.query(
        `INSERT INTO user_locations (user_id, location_id, is_primary, assigned_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, location_id) DO UPDATE
            SET is_primary = EXCLUDED.is_primary,
                assigned_by_user_id = EXCLUDED.assigned_by_user_id`,
        [userId, locationId, isPrimary, principal.userId],
      );
      if (isPrimary) {
        // Keep `users.location_id` mirrored to the new primary.
        await tx.query(
          `UPDATE users SET location_id = $2, updated_at = now() WHERE id = $1`,
          [userId, locationId],
        );
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'user.location.assign',
        entity: 'users',
        entityId: userId,
        payload: { location_id: locationId, is_primary: isPrimary },
      });
    });
    res.status(201).json({ user_id: userId, location_id: locationId, is_primary: isPrimary });
  }),
);

// ---------------------------------------------------------------------------
// DELETE /api/users/:id/locations/:location_id — pm only
// ---------------------------------------------------------------------------
// Primary cannot be removed directly — caller must first promote another
// location to primary (PUT /:id/locations/:lid/primary) and then DELETE
// the now-secondary row.
usersRouter.delete(
  '/:id/locations/:location_id',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const userId = parseIdParam(req.params['id'], 'id');
    const locationId = parseIdParam(req.params['location_id'], 'location_id');

    const { rows } = await query<{ is_primary: boolean }>(
      `SELECT is_primary FROM user_locations WHERE user_id = $1 AND location_id = $2`,
      [userId, locationId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.notFound('User-location assignment not found.');
    }
    if (row.is_primary) {
      throw AppError.validation(
        'Cannot remove the primary location. Promote another location first.',
      );
    }
    await withTransaction(async (tx) => {
      await tx.query(
        `DELETE FROM user_locations WHERE user_id = $1 AND location_id = $2`,
        [userId, locationId],
      );
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'user.location.unassign',
        entity: 'users',
        entityId: userId,
        payload: { location_id: locationId },
      });
    });
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// PUT /api/users/:id/locations/:location_id/primary — pm only
// ---------------------------------------------------------------------------
usersRouter.put(
  '/:id/locations/:location_id/primary',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const userId = parseIdParam(req.params['id'], 'id');
    const locationId = parseIdParam(req.params['location_id'], 'location_id');

    // The target row must already exist — primary swap is a flip, not an insert.
    const { rows } = await query<{ is_primary: boolean }>(
      `SELECT is_primary FROM user_locations WHERE user_id = $1 AND location_id = $2`,
      [userId, locationId],
    );
    if (rows[0] === undefined) {
      throw AppError.notFound('User-location assignment not found.');
    }
    if (rows[0].is_primary) {
      // Already primary — idempotent no-op.
      res.status(204).end();
      return;
    }
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE user_locations SET is_primary = FALSE
           WHERE user_id = $1 AND is_primary = TRUE`,
        [userId],
      );
      await tx.query(
        `UPDATE user_locations SET is_primary = TRUE
           WHERE user_id = $1 AND location_id = $2`,
        [userId, locationId],
      );
      await tx.query(
        `UPDATE users SET location_id = $2, updated_at = now() WHERE id = $1`,
        [userId, locationId],
      );
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'user.location.set_primary',
        entity: 'users',
        entityId: userId,
        payload: { location_id: locationId },
      });
    });
    res.status(204).end();
  }),
);
