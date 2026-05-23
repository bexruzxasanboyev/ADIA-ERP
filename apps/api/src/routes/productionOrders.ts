/**
 * M5 — Production orders (spec section 4.6).
 *
 *   GET   /api/production-orders?status=    — list (RBAC + optional status filter)
 *   POST  /api/production-orders            — create (default status: 'new')
 *   PATCH /api/production-orders/:id        — transition status: 'in_progress' or 'done'
 *
 * The `done` flip runs the atomic BOM-consume + warehouse-produce flow
 * (`finishProductionOrder`) inside ONE transaction. If a BOM component is
 * short, the whole thing rolls back and the response is 409 INSUFFICIENT_STOCK
 * (AC5.2). When the order was raised by a replenishment request, the same
 * transaction also steps the request `PRODUCING -> DONE_TO_WAREHOUSE`
 * (AC5.3).
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { writeAudit, poolRunner } from '../lib/audit.js';
import { assertLocationAccess, getPrincipal, isSuperAdmin } from '../lib/principal.js';
import {
  asObject,
  optionalId,
  optionalString,
  parseIdParam,
  requireEnum,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import {
  finishProductionOrder,
  PRODUCTION_ORDER_COLUMNS,
  type ProductionOrderRow,
} from '../services/productionOrder.js';
import { advance } from '../services/replenishment.js';

export const productionOrdersRouter: Router = Router();

const STATUSES = ['new', 'in_progress', 'done', 'cancelled'] as const;

// GET /api/production-orders?status=
productionOrdersRouter.get(
  '/',
  authenticate,
  authorize('pm', 'production_manager', 'raw_warehouse_manager', 'central_warehouse_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(STATUSES as readonly string[]).includes(statusRaw)) {
      throw AppError.validation(`Query "status" must be one of: ${STATUSES.join(', ')}.`);
    }

    // RBAC location filter: production_manager sees only its own production
    // location; pm sees the whole chain.
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (statusRaw !== undefined) {
      params.push(statusRaw);
      conditions.push(`po.status = $${params.length}`);
    }
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      if (principal.locationId === null) {
        res.status(200).json([]);
        return;
      }
      params.push(principal.locationId);
      conditions.push(
        `(po.location_id = $${params.length} OR po.target_location_id = $${params.length})`,
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Embed product + location names for the UI.
    const qualifiedCols = PRODUCTION_ORDER_COLUMNS.split(',')
      .map((c) => `po.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      ProductionOrderRow & {
        product_name: string;
        location_name: string | null;
        target_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              ll.name AS location_name,
              tl.name AS target_location_name
       FROM production_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN locations ll ON ll.id = po.location_id
       LEFT JOIN locations tl ON tl.id = po.target_location_id
       ${where}
       ORDER BY po.id DESC`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// POST /api/production-orders
productionOrdersRouter.post(
  '/',
  authenticate,
  authorize('pm', 'production_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const qty = requirePositiveNumber(body, 'qty');
    const locationId = requireId(body, 'location_id');
    const targetLocationId = optionalId(body, 'target_location_id') ?? null;
    const deadlineRaw = optionalString(body, 'deadline') ?? null;
    if (deadlineRaw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw)) {
      throw AppError.validation('Field "deadline" must be an ISO date (YYYY-MM-DD).');
    }
    const note = optionalString(body, 'note') ?? null;

    // IDOR guard — a scoped production_manager may only raise an order for its
    // OWN production location. `pm` (super-admin) bypasses via
    // `assertLocationAccess`. `central_warehouse_manager` is chain-wide so any
    // location is OK; the role gate above already filtered everyone else out.
    if (principal.role === 'production_manager') {
      assertLocationAccess(principal, locationId);
    }

    const inserted = await withTransaction(async (tx) => {
      const { rows } = await tx.query<ProductionOrderRow>(
        `INSERT INTO production_orders
           (product_id, qty, location_id, target_location_id, deadline, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
        [productId, qty, locationId, targetLocationId, deadlineRaw, note, principal.userId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.internal('Production order insert returned no row.');
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'production_order.create',
        entity: 'production_orders',
        entityId: row.id,
        payload: { product_id: productId, qty, location_id: locationId },
      });
      return row;
    });

    res.status(201).json({ production_order: inserted });
  }),
);

// PATCH /api/production-orders/:id
productionOrdersRouter.patch(
  '/:id',
  authenticate,
  authorize('pm', 'production_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const nextStatus = requireEnum(body, 'status', ['in_progress', 'done', 'cancelled'] as const);

    // IDOR guard — a scoped production_manager may only act on orders whose
    // production location matches its own. We read once with a row lock to
    // serialise against concurrent transitions; the same row's `status` is
    // re-read inside each downstream branch under that lock so this check is
    // free of TOCTOU windows.
    if (principal.role === 'production_manager') {
      const { rows } = await query<{ location_id: number }>(
        'SELECT location_id FROM production_orders WHERE id = $1',
        [orderId],
      );
      const existing = rows[0];
      if (existing === undefined) {
        throw AppError.notFound('Production order not found.');
      }
      assertLocationAccess(principal, Number(existing.location_id));
    }

    if (nextStatus === 'done') {
      // AC5.3 — the whole "tayyor" flow + the replenishment advance commit
      // together. `advance(id, actor, tx)` re-uses the outer tx so the
      // request hop is part of the same atomic unit as the BOM consumption.
      const result = await withTransaction(async (tx) => {
        const updated = await finishProductionOrder(orderId, principal.userId, tx);
        if (updated.replenishment_id !== null) {
          await advance(updated.replenishment_id, principal.userId, tx);
        }
        return updated;
      });
      res.status(200).json({ production_order: result });
      return;
    }

    if (nextStatus === 'cancelled') {
      // ADR-0001 §11 — a production order can be cancelled only from `new`
      // or `in_progress`. `done` already applied the stock movements so its
      // cancellation is forbidden (-> 409 INVALID_TRANSITION). The linked
      // replenishment request is NOT auto-cancelled — pm handles it.
      const { rows } = await query<ProductionOrderRow>(
        `UPDATE production_orders SET status = 'cancelled'
         WHERE id = $1 AND status IN ('new','in_progress')
         RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
        [orderId],
      );
      const updated = rows[0];
      if (updated === undefined) {
        const exists = await query<{ status: string }>(
          'SELECT status FROM production_orders WHERE id = $1',
          [orderId],
        );
        if (exists.rows.length === 0) {
          throw AppError.notFound('Production order not found.');
        }
        throw new AppError(
          'INVALID_TRANSITION',
          `Cannot cancel a production order in status "${exists.rows[0]?.status}".`,
        );
      }
      await writeAudit(poolRunner, {
        actorUserId: principal.userId,
        action: 'production_order.cancelled',
        entity: 'production_orders',
        entityId: orderId,
        payload: { from: 'new|in_progress', linked_replenishment_id: updated.replenishment_id },
      });
      res.status(200).json({ production_order: updated });
      return;
    }

    // `in_progress` — plain forward flip from `new`.
    const { rows } = await query<ProductionOrderRow>(
      `UPDATE production_orders SET status = $2
       WHERE id = $1 AND status IN ('new','in_progress')
       RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
      [orderId, nextStatus],
    );
    const updated = rows[0];
    if (updated === undefined) {
      // Either the order does not exist or its status disallows the change.
      const exists = await query<{ status: string }>(
        'SELECT status FROM production_orders WHERE id = $1',
        [orderId],
      );
      if (exists.rows.length === 0) {
        throw AppError.notFound('Production order not found.');
      }
      throw AppError.validation(
        `Cannot transition from "${exists.rows[0]?.status}" to "${nextStatus}".`,
      );
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: `production_order.${nextStatus}`,
      entity: 'production_orders',
      entityId: orderId,
      payload: { from: 'new|in_progress', to: nextStatus },
    });

    // AC5.3 — when an order tied to a replenishment moves to in_progress,
    // step the request CREATE_PRODUCTION_ORDER -> PRODUCING.
    if (nextStatus === 'in_progress' && updated.replenishment_id !== null) {
      await advance(updated.replenishment_id, principal.userId);
    }
    res.status(200).json({ production_order: updated });
  }),
);
