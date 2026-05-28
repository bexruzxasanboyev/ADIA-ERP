/**
 * M4 — Replenishment endpoints (spec section 4.5).
 *
 *   GET  /api/replenishment?status=        — list (RBAC + status filter)
 *   GET  /api/replenishment/:id            — one request + its transitions tarixi
 *   POST /api/replenishment                — manual create (qo'lda request)
 *   POST /api/replenishment/:id/advance    — step the state machine once
 *   POST /api/replenishment/:id/cancel     — -> CANCELLED
 *
 * The business logic lives in `services/replenishment.ts` — these handlers
 * are thin and only do validation, RBAC and shape adaptation.
 */
import { Router } from 'express';
import { query } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getPrincipal, isSuperAdmin } from '../lib/principal.js';
import {
  asObject,
  optionalString,
  parseIdParam,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import {
  advance,
  cancelRequest,
  createRequest,
  REPLENISHMENT_COLUMNS,
  type ReplenishmentRow,
  type ReplenishmentStatus,
} from '../services/replenishment.js';

export const replenishmentRouter: Router = Router();

const ALL_STATUSES: readonly ReplenishmentStatus[] = [
  'NEW',
  'CHECK_STORE_SUPPLIER',
  'SHIP_TO_REQUESTER',
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
  'DONE_TO_WAREHOUSE',
  'CLOSED',
  'CANCELLED',
];

// GET /api/replenishment?status=
replenishmentRouter.get(
  '/',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !(ALL_STATUSES as readonly string[]).includes(statusRaw)) {
      throw AppError.validation(`Query "status" must be one of: ${ALL_STATUSES.join(', ')}.`);
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (statusRaw !== undefined) {
      params.push(statusRaw);
      conditions.push(`r.status = $${params.length}`);
    }
    // RBAC: location-scoped roles see only requests that touch their location.
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      if (principal.locationId === null) {
        res.status(200).json([]);
        return;
      }
      params.push(principal.locationId);
      conditions.push(
        `(r.requester_location_id = $${params.length} OR r.target_location_id = $${params.length})`,
      );
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // Embed product + requester/target location names so the UI can render
    // the row without a second round trip (spec §4 list embedding rule).
    const qualifiedCols = REPLENISHMENT_COLUMNS.split(',')
      .map((c) => `r.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      ReplenishmentRow & {
        product_name: string;
        product_unit: string;
        requester_location_name: string | null;
        target_location_name: string | null;
        production_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              pl.name AS production_location_name
       FROM replenishment_requests r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN locations rl ON rl.id = r.requester_location_id
       LEFT JOIN locations tl ON tl.id = r.target_location_id
       LEFT JOIN production_orders po ON po.id = r.production_order_id
       LEFT JOIN locations pl ON pl.id = po.location_id
       ${where}
       ORDER BY r.id DESC`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// GET /api/replenishment/:id  — embeds the transitions history.
replenishmentRouter.get(
  '/:id',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
    'ai_assistant',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // Embed product + requester/target location names (parity with the list
    // endpoint — frontend detail page renders the same fields).
    const qualifiedCols = REPLENISHMENT_COLUMNS.split(',')
      .map((c) => `r.${c.trim()}`)
      .join(', ');
    const { rows } = await query<
      ReplenishmentRow & {
        product_name: string;
        product_unit: string;
        requester_location_name: string | null;
        target_location_name: string | null;
        production_location_name: string | null;
      }
    >(
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              pl.name AS production_location_name
       FROM replenishment_requests r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN locations rl ON rl.id = r.requester_location_id
       LEFT JOIN locations tl ON tl.id = r.target_location_id
       LEFT JOIN production_orders po ON po.id = r.production_order_id
       LEFT JOIN locations pl ON pl.id = po.location_id
       WHERE r.id = $1`,
      [id],
    );
    const request = rows[0];
    if (request === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }

    // RBAC: only pm/ai_assistant see arbitrary requests; others must be tied
    // to it via requester_location_id, target_location_id, or the location
    // of any linked production_order/purchase_order — the spec §6 "W(bog'liq)"
    // semantics (a production_manager working on the linked PO must be able
    // to read the request).
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      const own = principal.locationId;
      if (own === null || !(await requestTouchesLocation(request, own))) {
        throw AppError.forbidden('You may only view requests that touch your location.');
      }
    }

    // Embed actor_name (JOIN users) so the UI can render "who" without an
    // extra fetch — system/cron rows show actor_name = null.
    const { rows: transitions } = await query<{
      id: number;
      from_status: string | null;
      to_status: string;
      reason: string | null;
      actor_user_id: number | null;
      actor_name: string | null;
      actor_username: string | null;
      created_at: Date;
    }>(
      `SELECT t.id, t.from_status, t.to_status, t.reason, t.actor_user_id,
              u.name AS actor_name, u.username AS actor_username, t.created_at
       FROM replenishment_transitions t
       LEFT JOIN users u ON u.id = t.actor_user_id
       WHERE t.replenishment_id = $1 ORDER BY t.id`,
      [id],
    );
    res.status(200).json({ request, transitions });
  }),
);

// POST /api/replenishment
replenishmentRouter.post(
  '/',
  authenticate,
  authorize('pm', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const requesterLocationId = requireId(body, 'requester_location_id');
    const qtyNeeded = requirePositiveNumber(body, 'qty_needed');
    const note = optionalString(body, 'note') ?? null;

    const row = await createRequest({
      productId,
      requesterLocationId,
      qtyNeeded,
      actorUserId: principal.userId,
      note,
    });
    res.status(201).json({ request: row });
  }),
);

// POST /api/replenishment/:id/advance
replenishmentRouter.post(
  '/:id/advance',
  authenticate,
  authorize(
    'pm',
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // RBAC: a scoped manager must be linked to the request — directly via
    // requester/target, or indirectly via a linked production_order /
    // purchase_order (spec §6 "W(bog'liq)").
    if (!isSuperAdmin(principal)) {
      const { rows } = await query<{
        requester_location_id: number;
        target_location_id: number | null;
        production_order_id: number | null;
        purchase_order_id: number | null;
      }>(
        `SELECT requester_location_id, target_location_id,
                production_order_id, purchase_order_id
         FROM replenishment_requests WHERE id = $1`,
        [id],
      );
      const r = rows[0];
      if (r === undefined) {
        throw AppError.notFound('Replenishment request not found.');
      }
      const own = principal.locationId;
      if (own === null || !(await requestTouchesLocation(r, own))) {
        throw AppError.forbidden('You may only advance requests that touch your location.');
      }
    }

    const result = await advance(id, principal.userId);
    res.status(200).json({
      advanced: result.advanced,
      status: result.request.status,
      reason: result.reason,
      request: result.request,
    });
  }),
);

// POST /api/replenishment/:id/cancel
replenishmentRouter.post(
  '/:id/cancel',
  authenticate,
  authorize('pm'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : 'manual cancel';

    const updated = await cancelRequest(id, principal.userId, reason);
    res.status(200).json({ request: updated });
  }),
);

/**
 * Spec §6 "W(bog'liq)" — a scoped role touches a request when its location
 * matches the requester, the target, OR the location_id of a linked
 * production_order / target_location_id of a linked purchase_order. The two
 * extra checks fire only when the request has been linked (lazy join).
 */
async function requestTouchesLocation(
  request: {
    requester_location_id: number;
    target_location_id: number | null;
    production_order_id?: number | null;
    purchase_order_id?: number | null;
  },
  ownLocationId: number,
): Promise<boolean> {
  if (
    ownLocationId === request.requester_location_id ||
    ownLocationId === request.target_location_id
  ) {
    return true;
  }
  if (request.production_order_id != null) {
    const { rows } = await query<{ location_id: number }>(
      'SELECT location_id FROM production_orders WHERE id = $1',
      [request.production_order_id],
    );
    if (rows[0]?.location_id === ownLocationId) {
      return true;
    }
  }
  if (request.purchase_order_id != null) {
    const { rows } = await query<{ target_location_id: number }>(
      'SELECT target_location_id FROM purchase_orders WHERE id = $1',
      [request.purchase_order_id],
    );
    if (rows[0]?.target_location_id === ownLocationId) {
      return true;
    }
  }
  return false;
}
