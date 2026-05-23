/**
 * M1 — Users (spec section 4.2). PM-only.
 *
 *   GET  /api/users   — list users (no password hashes)
 *   POST /api/users   — create a user; password is bcrypt-hashed
 *
 * RBAC: only `pm` may list or create users. Every create is audit-logged.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { ROLES } from '../auth/roles.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { getPrincipal } from '../lib/principal.js';
import { asObject, optionalId, requireEnum, requireString } from '../lib/validate.js';

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

// GET /api/users  — pm only.
usersRouter.get(
  '/',
  authenticate,
  authorize('pm'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query<PublicUserRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY id`,
    );
    // List endpoints return a bare array (spec section 4) — no envelope.
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
    const locationId = optionalId(body, 'location_id');
    const telegramId = optionalId(body, 'telegram_id');

    // Mirror the DB constraint at the boundary for a clear 422 instead of a 500.
    if (!CHAIN_WIDE_ROLES.has(role) && locationId === undefined) {
      throw AppError.validation(`Role "${role}" requires a "location_id".`);
    }

    // Reject a duplicate email with a clean 422 rather than a raw DB error.
    const existing = await query<{ id: number }>(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    if (existing.rows.length > 0) {
      throw AppError.validation('A user with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await query<PublicUserRow>(
      `INSERT INTO users (name, email, password_hash, role, location_id, telegram_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PUBLIC_COLUMNS}`,
      [name, email, passwordHash, role, locationId ?? null, telegramId ?? null],
    );
    const created = rows[0];
    if (created === undefined) {
      throw AppError.internal('User insert returned no row.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'user.create',
      entity: 'users',
      entityId: created.id,
      payload: { email, role },
    });
    res.status(201).json({ user: created });
  }),
);
