/**
 * M6 — Purchase orders (spec section 4.7).
 *
 *   GET  /api/purchase-orders?status=        — list (RBAC + status filter)
 *   POST /api/purchase-orders                — create (draft)
 *   POST /api/purchase-orders/:id/approve    — { step: 'manager' | 'keeper' }
 *   POST /api/purchase-orders/:id/receive    — approved -> received (raw stock +)
 *   POST /api/purchase-orders/:id/reject     — draft -> rejected
 *
 * Approval rules (D5, OS-5):
 *   - 'manager' step: `pm` or `supply_manager` only;
 *   - 'keeper'  step: `pm` or `raw_warehouse_manager` only;
 *   - 'receive': `pm` or `raw_warehouse_manager`.
 * Both `*_approved_by` columns must be set before the row becomes `approved`
 * (AC6.1, AC6.2 — also enforced by the DB CHECK).
 *
 * On `received`, the linked replenishment request (if any) is advanced in
 * the SAME transaction (AC6.3, the request moves CREATE_PURCHASE_ORDER ->
 * CREATE_PRODUCTION_ORDER once raw is on hand).
 */
import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
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
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import {
  approvePurchaseOrder,
  receivePurchaseOrder,
  PURCHASE_ORDER_COLUMNS,
  type ApprovalStep,
  type PurchaseOrderRow,
} from '../services/purchaseOrder.js';
import { advance } from '../services/replenishment.js';

export const purchaseOrdersRouter: Router = Router();

const STATUSES = ['draft', 'approved', 'received', 'cancelled', 'rejected'] as const;

// GET /api/purchase-orders?status=
purchaseOrdersRouter.get(
  '/',
  authenticate,
  authorize('pm', 'supply_manager', 'raw_warehouse_manager', 'central_warehouse_manager', 'ai_assistant'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(STATUSES as readonly string[]).includes(statusRaw)) {
      throw AppError.validation(`Query "status" must be one of: ${STATUSES.join(', ')}.`);
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (statusRaw !== undefined) {
      params.push(statusRaw);
      conditions.push(`po.status = $${params.length}`);
    }
    // I5 — RBAC location scoping (spec §6):
    //   - `pm`, `ai_assistant`, `central_warehouse_manager` — see all;
    //   - `raw_warehouse_manager` — only POs targeting their raw warehouse;
    //   - `supply_manager` — only POs they created (no target match is
    //     reliable; the supply manager raises the request and stays linked
    //     via `created_by`).
    if (
      !isSuperAdmin(principal) &&
      principal.role !== 'ai_assistant' &&
      principal.role !== 'central_warehouse_manager'
    ) {
      if (principal.role === 'raw_warehouse_manager') {
        if (principal.locationId === null) {
          res.status(200).json([]);
          return;
        }
        params.push(principal.locationId);
        conditions.push(`po.target_location_id = $${params.length}`);
      } else if (principal.role === 'supply_manager') {
        params.push(principal.userId);
        conditions.push(`po.created_by = $${params.length}`);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Embed product / target_location / approver / supplier names for the UI.
    const qualifiedCols = PURCHASE_ORDER_COLUMNS.split(',')
      .map((c) => `po.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      PurchaseOrderRow & {
        product_name: string;
        target_location_name: string | null;
        manager_approved_name: string | null;
        keeper_approved_name: string | null;
        supplier_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              tl.name AS target_location_name,
              mu.name AS manager_approved_name,
              ku.name AS keeper_approved_name,
              s.name AS supplier_name
       FROM purchase_orders po
       JOIN products p ON p.id = po.product_id
       LEFT JOIN locations tl ON tl.id = po.target_location_id
       LEFT JOIN users mu ON mu.id = po.manager_approved_by
       LEFT JOIN users ku ON ku.id = po.keeper_approved_by
       LEFT JOIN suppliers s ON s.id = po.supplier_id
       ${where}
       ORDER BY po.id DESC`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// POST /api/purchase-orders
purchaseOrdersRouter.post(
  '/',
  authenticate,
  authorize('pm', 'supply_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const qty = requirePositiveNumber(body, 'qty');
    const supplierId = optionalId(body, 'supplier_id') ?? null;
    const targetLocationId = requireId(body, 'target_location_id');
    const note = optionalString(body, 'note') ?? null;

    const { rows } = await query<PurchaseOrderRow>(
      `INSERT INTO purchase_orders
         (product_id, qty, supplier_id, target_location_id, status, note, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6)
       RETURNING ${PURCHASE_ORDER_COLUMNS}`,
      [productId, qty, supplierId, targetLocationId, note, principal.userId],
    );
    const created = rows[0];
    if (created === undefined) {
      throw AppError.internal('Purchase order insert returned no row.');
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'purchase_order.create',
      entity: 'purchase_orders',
      entityId: created.id,
      payload: { product_id: productId, qty, target_location_id: targetLocationId },
    });
    res.status(201).json({ purchase_order: created });
  }),
);

// POST /api/purchase-orders/:id/approve
purchaseOrdersRouter.post(
  '/:id/approve',
  authenticate,
  authorize('pm', 'supply_manager', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const step = requireEnum<ApprovalStep>(body, 'step', ['manager', 'keeper'] as const);

    // Role gating per step (D5).
    if (!isSuperAdmin(principal)) {
      if (step === 'manager' && principal.role !== 'supply_manager') {
        throw AppError.forbidden('Only supply_manager (or pm) may take the manager approval step.');
      }
      if (step === 'keeper' && principal.role !== 'raw_warehouse_manager') {
        throw AppError.forbidden(
          'Only raw_warehouse_manager (or pm) may take the keeper approval step.',
        );
      }
    }

    const updated = await approvePurchaseOrder(orderId, step, principal.userId);
    res.status(200).json({ purchase_order: updated });
  }),
);

// POST /api/purchase-orders/:id/receive
purchaseOrdersRouter.post(
  '/:id/receive',
  authenticate,
  authorize('pm', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');

    // AC6.3 — the receive flow and the linked replenishment advance commit
    // together inside ONE transaction. `receivePurchaseOrder(tx)` and
    // `advance(id, actor, tx)` share the same client so both succeed or both
    // roll back.
    const received = await withTransaction(async (tx) => {
      const row = await receivePurchaseOrder(orderId, principal.userId, tx);
      if (row.replenishment_id !== null) {
        await advance(row.replenishment_id, principal.userId, tx);
      }
      return row;
    });
    res.status(200).json({ purchase_order: received });
  }),
);

// POST /api/purchase-orders/:id/reject
purchaseOrdersRouter.post(
  '/:id/reject',
  authenticate,
  authorize('pm', 'supply_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const orderId = parseIdParam(req.params.id, 'id');

    const { rows } = await query<PurchaseOrderRow>(
      `UPDATE purchase_orders SET status = 'rejected'
       WHERE id = $1 AND status = 'draft'
       RETURNING ${PURCHASE_ORDER_COLUMNS}`,
      [orderId],
    );
    const updated = rows[0];
    if (updated === undefined) {
      const exists = await query<{ status: string }>(
        'SELECT status FROM purchase_orders WHERE id = $1',
        [orderId],
      );
      if (exists.rows.length === 0) {
        throw AppError.notFound('Purchase order not found.');
      }
      throw AppError.validation(
        `Only a draft purchase order can be rejected (current: "${exists.rows[0]?.status}").`,
      );
    }
    await writeAudit(poolRunner, {
      actorUserId: principal.userId,
      action: 'purchase_order.rejected',
      entity: 'purchase_orders',
      entityId: orderId,
      payload: null,
    });
    res.status(200).json({ purchase_order: updated });
  }),
);
