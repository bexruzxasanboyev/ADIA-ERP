/**
 * F4.9 — Delivery module ("Yetkazib berish bo'limi").
 *
 *   GET   /api/delivery/tasks?status=&assigned_to=
 *   PATCH /api/delivery/tasks/:id/assign  body { user_id }
 *
 * Delivery is NOT a separate table — it is a projection of
 * `replenishment_requests` whose status reflects the delivery pipeline:
 *
 *   NEW                     — newly created, waiting for routing
 *   CHECK_STORE_SUPPLIER    — checking which upstream can ship
 *   SHIP_TO_REQUESTER       — physically being moved/delivered
 *
 * The `assigned_to_user_id` column (migration 0015) records the courier or
 * floor manager who is on the hook. Reassignment is a normal PATCH — every
 * change is audit-logged (invariant 5).
 *
 * RBAC:
 *   - pm + ai_assistant + central_warehouse_manager + supply_manager —
 *     see the chain.
 *   - any other listed role — scoped to its assigned locations (requester or
 *     target side, mirroring `GET /api/replenishment`).
 */
import { Router } from 'express';
import { query, type SqlParam } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import { asObject, optionalId, parseIdParam } from '../lib/validate.js';
import {
  REPLENISHMENT_COLUMNS,
  type ReplenishmentRow,
  type ReplenishmentStatus,
} from '../services/replenishment.js';

export const deliveryRouter: Router = Router();

/**
 * Statuses that constitute the "delivery view". Outside this set, a
 * replenishment request is either upstream-only (production / purchase) or
 * terminal (closed / cancelled) — none of those need a courier.
 */
const DELIVERY_STATUSES: readonly ReplenishmentStatus[] = [
  'NEW',
  'CHECK_STORE_SUPPLIER',
  'SHIP_TO_REQUESTER',
];

type DeliveryRow = ReplenishmentRow & {
  product_name: string;
  product_unit: string;
  requester_location_name: string | null;
  target_location_name: string | null;
  assigned_to_user_name: string | null;
};

// =============================================================================
// GET /api/delivery/tasks
// =============================================================================

deliveryRouter.get(
  '/tasks',
  authenticate,
  authorize(
    'pm',
    'central_warehouse_manager',
    'supply_manager',
    'raw_warehouse_manager',
    'production_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);

    // Optional `?status=` filter — must be one of the delivery-relevant ones.
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (
      statusRaw !== undefined &&
      !(DELIVERY_STATUSES as readonly string[]).includes(statusRaw)
    ) {
      throw AppError.validation(
        `Query "status" must be one of: ${DELIVERY_STATUSES.join(', ')}.`,
      );
    }

    // Optional `?assigned_to=<user_id>` filter — for "my deliveries" view.
    const assignedRaw =
      typeof req.query.assigned_to === 'string' ? req.query.assigned_to : undefined;
    let assignedFilter: number | 'unassigned' | undefined;
    if (assignedRaw !== undefined && assignedRaw !== '') {
      if (assignedRaw === 'null' || assignedRaw === 'unassigned') {
        assignedFilter = 'unassigned';
      } else {
        const n = Number(assignedRaw);
        if (!Number.isInteger(n) || n <= 0) {
          throw AppError.validation('"assigned_to" must be a positive integer, "null", or "unassigned".');
        }
        assignedFilter = n;
      }
    }

    const conditions: string[] = [];
    const params: SqlParam[] = [];

    // Default scope — only delivery statuses (or the one the caller asked for).
    if (statusRaw !== undefined) {
      params.push(statusRaw);
      conditions.push(`r.status = $${params.length}`);
    } else {
      // ANY($::text[]) is bullet-proof against future enum additions.
      params.push([...DELIVERY_STATUSES]);
      conditions.push(`r.status::text = ANY($${params.length}::text[])`);
    }

    if (assignedFilter === 'unassigned') {
      conditions.push('r.assigned_to_user_id IS NULL');
    } else if (typeof assignedFilter === 'number') {
      params.push(assignedFilter);
      conditions.push(`r.assigned_to_user_id = $${params.length}`);
    }

    // RBAC scoping — store_manager / raw_warehouse_manager / production_manager
    // are tied to their location; the chain roles see everything.
    const chainRoles: ReadonlyArray<string> = [
      'pm',
      'ai_assistant',
      'central_warehouse_manager',
      'supply_manager',
    ];
    if (!isSuperAdmin(principal) && !chainRoles.includes(principal.role)) {
      if (principal.locationId === null) {
        res.status(200).json([]);
        return;
      }
      params.push(principal.locationId);
      conditions.push(
        `(r.requester_location_id = $${params.length} OR r.target_location_id = $${params.length})`,
      );
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const qualifiedCols = REPLENISHMENT_COLUMNS.split(',')
      .map((c) => `r.${c.trim()}`)
      .join(', ');
    const { rows } = await query<DeliveryRow>(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              u.name  AS assigned_to_user_name
         FROM replenishment_requests r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN locations rl ON rl.id = r.requester_location_id
         LEFT JOIN locations tl ON tl.id = r.target_location_id
         LEFT JOIN users u      ON u.id  = r.assigned_to_user_id
         ${where}
         ORDER BY r.id DESC`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// =============================================================================
// PATCH /api/delivery/tasks/:id/assign — body { user_id: number | null }
// =============================================================================

deliveryRouter.patch(
  '/tasks/:id/assign',
  authenticate,
  authorize(
    'pm',
    'central_warehouse_manager',
    'supply_manager',
    'raw_warehouse_manager',
    'production_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    // `user_id` is either a positive integer (assign) or null (unassign).
    // We accept the absence of the key as unassign (parity with PATCH idiom).
    let nextUserId: number | null;
    if ('user_id' in body && body.user_id === null) {
      nextUserId = null;
    } else if ('user_id' in body) {
      const parsed = optionalId(body, 'user_id');
      if (parsed === undefined) {
        throw AppError.validation('"user_id" must be a positive integer or null.');
      }
      nextUserId = parsed;
    } else {
      throw AppError.validation('Field "user_id" is required (null to unassign).');
    }

    // Load the request first to validate existence + RBAC scope.
    const { rows: existing } = await query<{
      id: number;
      status: ReplenishmentStatus;
      requester_location_id: number;
      target_location_id: number | null;
    }>(
      `SELECT id, status, requester_location_id, target_location_id
         FROM replenishment_requests WHERE id = $1`,
      [id],
    );
    const current = existing[0];
    if (current === undefined) {
      throw AppError.notFound('Delivery task not found.');
    }
    if (!(DELIVERY_STATUSES as readonly string[]).includes(current.status)) {
      throw AppError.validation(
        `Task status "${current.status}" is not a delivery state.`,
      );
    }

    // RBAC: scoped roles must touch the request (requester or target).
    const chainRoles: ReadonlyArray<string> = [
      'pm',
      'central_warehouse_manager',
      'supply_manager',
    ];
    if (!isSuperAdmin(principal) && !chainRoles.includes(principal.role)) {
      const own = principal.locationId;
      if (
        own === null ||
        (own !== current.requester_location_id && own !== current.target_location_id)
      ) {
        throw AppError.forbidden('You may only assign tasks that touch your location.');
      }
    }

    // Validate the target user exists + is active (cheap second round-trip is
    // fine here — assignment is rare relative to GET).
    if (nextUserId !== null) {
      const { rows: u } = await query<{ id: number; is_active: boolean }>(
        `SELECT id, is_active FROM users WHERE id = $1`,
        [nextUserId],
      );
      if (u[0] === undefined) {
        throw AppError.validation('Assigned user does not exist.');
      }
      if (!u[0].is_active) {
        throw AppError.validation('Assigned user is inactive.');
      }
    }

    const { rows: updatedRows } = await query<DeliveryRow>(
      `UPDATE replenishment_requests
          SET assigned_to_user_id = $1, updated_at = now()
        WHERE id = $2
        RETURNING ${REPLENISHMENT_COLUMNS}`,
      [nextUserId, id],
    );
    const updated = updatedRows[0];
    if (updated === undefined) {
      // Race with deletion — practically impossible (ON DELETE RESTRICT) but
      // we still want a clean error.
      throw AppError.notFound('Delivery task not found.');
    }

    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'delivery.assign',
      entity: 'replenishment_requests',
      entityId: id,
      payload: { assigned_to_user_id: nextUserId },
    });

    res.status(200).json({ task: updated });
  }),
);
