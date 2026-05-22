/**
 * M1 — Locations CRUD (spec section 4.2).
 *
 *   GET    /api/locations        — list (RBAC-filtered)
 *   GET    /api/locations/:id    — one location (own scope or pm)
 *   POST   /api/locations        — create (pm only)
 *   PATCH  /api/locations/:id    — edit (pm only)
 *
 * RBAC: pm sees the whole chain; a location-scoped manager sees only its own
 * location row. Every write is audit-logged (invariant 6).
 *
 * List responses are bare arrays (spec section 4); single-resource responses
 * keep the `{ location }` envelope.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  optionalString,
  parseIdParam,
  requireEnum,
  requireString,
} from '../lib/validate.js';

export const locationsRouter: Router = Router();

const LOCATION_TYPES = [
  'raw_warehouse',
  'production',
  'supply',
  'central_warehouse',
  'store',
] as const;

type LocationRow = {
  id: number;
  name: string;
  type: string;
  parent_id: number | null;
  poster_spot_id: number | null;
  poster_storage_id: number | null;
  lead_time_days: string;
  review_days: string;
  safety_factor: string;
  manager_user_id: number | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

const SELECT_COLUMNS = `id, name, type, parent_id, poster_spot_id, poster_storage_id,
  lead_time_days, review_days, safety_factor, manager_user_id, is_active,
  created_at, updated_at`;

// GET /api/locations  — pm: all; scoped manager: only own location.
locationsRouter.get(
  '/',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    // List endpoints return a bare array (spec section 4) — no envelope.
    if (isSuperAdmin(principal)) {
      const { rows } = await query<LocationRow>(
        `SELECT ${SELECT_COLUMNS} FROM locations ORDER BY id`,
      );
      res.status(200).json(rows);
      return;
    }
    // A scoped manager sees only its own location.
    if (principal.locationId === null) {
      res.status(200).json([]);
      return;
    }
    const { rows } = await query<LocationRow>(
      `SELECT ${SELECT_COLUMNS} FROM locations WHERE id = $1`,
      [principal.locationId],
    );
    res.status(200).json(rows);
  }),
);

// GET /api/locations/:id
locationsRouter.get(
  '/:id',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    if (!isSuperAdmin(principal) && principal.locationId !== id) {
      throw AppError.forbidden('You may only view your own location.');
    }
    const { rows } = await query<LocationRow>(
      `SELECT ${SELECT_COLUMNS} FROM locations WHERE id = $1`,
      [id],
    );
    const location = rows[0];
    if (location === undefined) {
      throw AppError.notFound('Location not found.');
    }
    res.status(200).json({ location });
  }),
);

// POST /api/locations  — pm only.
locationsRouter.post(
  '/',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const name = requireString(body, 'name');
    const type = requireEnum(body, 'type', LOCATION_TYPES);
    const parentId = optionalId(body, 'parent_id');
    const posterSpotId = optionalId(body, 'poster_spot_id');
    const posterStorageId = optionalId(body, 'poster_storage_id');

    const { rows } = await query<LocationRow>(
      `INSERT INTO locations (name, type, parent_id, poster_spot_id, poster_storage_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [name, type, parentId ?? null, posterSpotId ?? null, posterStorageId ?? null],
    );
    const created = rows[0];
    if (created === undefined) {
      throw AppError.internal('Location insert returned no row.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'location.create',
      entity: 'locations',
      entityId: created.id,
      payload: { name, type },
    });
    res.status(201).json({ location: created });
  }),
);

// PATCH /api/locations/:id  — pm only.
locationsRouter.patch(
  '/:id',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    // Build a partial update from the keys actually present.
    const sets: string[] = [];
    const params: (string | number | boolean | null)[] = [];
    let i = 1;
    const add = (column: string, value: string | number | boolean | null): void => {
      sets.push(`${column} = $${i}`);
      params.push(value);
      i += 1;
    };

    const name = optionalString(body, 'name');
    if (name !== undefined) {
      add('name', name);
    }
    if ('manager_user_id' in body) {
      add('manager_user_id', optionalId(body, 'manager_user_id') ?? null);
    }
    if ('parent_id' in body) {
      add('parent_id', optionalId(body, 'parent_id') ?? null);
    }
    if ('is_active' in body) {
      const active = body.is_active;
      if (typeof active !== 'boolean') {
        throw AppError.validation('Field "is_active" must be a boolean.');
      }
      add('is_active', active);
    }
    // Phase-2 dynamic min/max tuning inputs (spec section 4.2, TZ 8.3).
    for (const column of ['lead_time_days', 'review_days', 'safety_factor'] as const) {
      if (column in body) {
        const raw = body[column];
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
          throw AppError.validation(`Field "${column}" must be a non-negative number.`);
        }
        add(column, raw);
      }
    }
    if (sets.length === 0) {
      throw AppError.validation('No editable fields provided.');
    }

    params.push(id);
    const { rows } = await query<LocationRow>(
      `UPDATE locations SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING ${SELECT_COLUMNS}`,
      params,
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.notFound('Location not found.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'location.update',
      entity: 'locations',
      entityId: id,
      payload: { fields: sets },
    });
    res.status(200).json({ location: updated });
  }),
);
