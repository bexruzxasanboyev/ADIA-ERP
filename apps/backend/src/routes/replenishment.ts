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
import { authorize, authorizeWrite } from '../middleware/authorize.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  assertLocationAccess,
  getPrincipal,
  isSuperAdmin,
  requireLocationOperator,
} from '../lib/principal.js';
import {
  asObject,
  optionalString,
  parseIdParam,
  requireId,
  requirePositiveNumber,
} from '../lib/validate.js';
import {
  acceptByCentral,
  acceptByFulfiller,
  acceptInternal,
  acceptProduction,
  acceptShipment,
  advance,
  cancelRequest,
  cancelRequestByFulfiller,
  createRequest,
  derivePipelineStage,
  fulfillStoreRequest,
  getProposalsForLocation,
  PIPELINE_STAGE_SQL,
  type PipelineStage,
  receiveFromProduction,
  receiveShipment,
  rejectInternal,
  rejectProduction,
  rejectShipment,
  REPLENISHMENT_COLUMNS,
  resolveProductionLocationId,
  returnShipment,
  sendToProduction,
  shipToStore,
  type ReplenishmentRow,
  type ReplenishmentStatus,
} from '../services/replenishment.js';
import {
  enqueueCentralDecrementWriteback,
  enqueuePosterReceiveWriteback,
} from '../services/posterWriteback.js';

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
    // cross-dept-flow §4/§6 — the location clause is widened with a PRODUCTION
    // bind: a workshop (отдел) also sees a request whose PRODUCTION is assigned
    // to it — `COALESCE(po.location_id, p.workshop_location_id)` (the production
    // location, before a production order exists it falls back to the product's
    // `workshop_location_id`) — but ONLY while the request is in a
    // production-bound state. Closed / store-side rows stay invisible to the
    // workshop. `po`/`p` are referenced here, so the joins below MUST precede
    // this WHERE (they do — JOIN products p + LEFT JOIN production_orders po).
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      if (principal.locationId === null) {
        res.status(200).json([]);
        return;
      }
      params.push(principal.locationId);
      conditions.push(
        `(r.requester_location_id = $${params.length} OR r.target_location_id = $${params.length}` +
          ` OR (COALESCE(po.location_id, p.workshop_location_id) = $${params.length}` +
          ` AND r.status IN ('CHECK_PRODUCTION_INPUT','CREATE_PURCHASE_ORDER',` +
          `'CREATE_PRODUCTION_ORDER','PRODUCING','DONE_TO_WAREHOUSE')))`,
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
        production_location_id: number | null;
        production_location_name: string | null;
        requester_location_type: string | null;
        target_location_type: string | null;
        shipped_qty: number | null;
        pipeline_stage: PipelineStage;
      }
    >(
      // F-G — requester_location_type + target_location_type are PINNED field
      // names: the Jira-style Kanban derives its "Tasdiqlandi" column (from
      // fulfiller_accepted_at, already in the columns) and the "Poster kutilmoqda"
      // chip (a raw_warehouse target still holding) from them.
      //
      // cross-dept-flow §4/§6 — production_location_id is the PINNED workshop link
      // (`COALESCE(po.location_id, p.workshop_location_id)`): once a production
      // order exists it is that order's location, otherwise the product's
      // assigned workshop. production_location_name resolves from the SAME source
      // (pl now joins the COALESCE, not just po.location_id). ::int coerces the
      // BIGINT like its waiters_count neighbour.
      //
      // F-L — shipped_qty is the PINNED actually-shipped qty: the linked shipment
      // movement's qty (`sm.qty` via shipment_movement_id), NULL until a shipment
      // exists. Cards must show what was REALLY shipped (a partial fulfil ships 4 of
      // 10) instead of qty_needed. ::float8 yields a JS number (fractional-safe);
      // the LEFT JOIN gives NULL pre-ship.
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              COALESCE(po.location_id, p.workshop_location_id)::int AS production_location_id,
              pl.name AS production_location_name,
              rl.type::text AS requester_location_type,
              tl.type::text AS target_location_type,
              sm.qty::float8 AS shipped_qty,
              ${PIPELINE_STAGE_SQL} AS pipeline_stage
       FROM replenishment_requests r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN locations rl ON rl.id = r.requester_location_id
       LEFT JOIN locations tl ON tl.id = r.target_location_id
       LEFT JOIN production_orders po ON po.id = r.production_order_id
       LEFT JOIN locations pl ON pl.id = COALESCE(po.location_id, p.workshop_location_id)
       LEFT JOIN stock_movements sm ON sm.id = r.shipment_movement_id
       ${where}
       ORDER BY r.id DESC`,
      params,
    );
    res.status(200).json(rows);
  }),
);

// GET /api/replenishment/:id  — embeds the transitions history.
//
// `:id(\\d+)` — the numeric constraint keeps this route from shadowing the
// named GET routes (`/proposals`, `/incoming`) regardless of registration
// order, so they resolve to their own handlers.
replenishmentRouter.get(
  '/:id(\\d+)',
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
        production_location_id: number | null;
        production_location_name: string | null;
        requester_location_type: string | null;
        target_location_type: string | null;
        shipped_qty: number | null;
        pipeline_stage: PipelineStage;
      }
    >(
      // F-G — requester_location_type + target_location_type carried for the
      // Kanban (PINNED field names; see the list endpoint).
      //
      // cross-dept-flow §4/§6 — production_location_id + its name resolve from
      // `COALESCE(po.location_id, p.workshop_location_id)` (see list). The field
      // also feeds the RBAC guard below (requestTouchesLocation) so the workshop
      // manager may READ a production-bound row it is assigned to.
      //
      // F-L — shipped_qty: the linked shipment movement's qty (see list endpoint).
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              COALESCE(po.location_id, p.workshop_location_id)::int AS production_location_id,
              pl.name AS production_location_name,
              rl.type::text AS requester_location_type,
              tl.type::text AS target_location_type,
              sm.qty::float8 AS shipped_qty,
              ${PIPELINE_STAGE_SQL} AS pipeline_stage
       FROM replenishment_requests r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN locations rl ON rl.id = r.requester_location_id
       LEFT JOIN locations tl ON tl.id = r.target_location_id
       LEFT JOIN production_orders po ON po.id = r.production_order_id
       LEFT JOIN locations pl ON pl.id = COALESCE(po.location_id, p.workshop_location_id)
       LEFT JOIN stock_movements sm ON sm.id = r.shipment_movement_id
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

// GET /api/replenishment/:id/tree
//
// F-D / cross-dept-flow §8 — the WHOLE request tree rooted at :id's tree root
// (`root_request_id ?? id`). The frontend builds the nested Kanban tree from a
// FLAT `nodes` list (it nests via `parent_request_id`), so this shape is PINNED:
//
//   {
//     "root":  { ...full request row..., "pipeline_stage": "kutuvda" },
//     "nodes": [ { ...full request row..., "pipeline_stage": "...", "waiters_count": N } ],
//     "waiters": [ { "child_request_id": 56, "waiter_request_id": 99 } ]
//   }
//
// `nodes` = ALL descendants of the root (flat, ordered by depth then id), each
// enriched with `pipeline_stage` (server-computed, no N+1) + `waiters_count`
// (rows in `request_waiters` where it is the child). `waiters` = every
// request_waiters row anywhere in the tree.
//
// RBAC mirrors GET /:id: pm/ai_assistant see any tree; a scoped role must touch
// the ROOT (requester/target, or a linked production/purchase order).
replenishmentRouter.get(
  '/:id(\\d+)/tree',
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

    // Resolve the tree root of :id (root_request_id ?? id).
    const { rows: rootRows } = await query<{ root_id: number }>(
      `SELECT COALESCE(root_request_id, id) AS root_id
         FROM replenishment_requests WHERE id = $1`,
      [id],
    );
    const rootRow = rootRows[0];
    if (rootRow === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    const rootId = Number(rootRow.root_id);

    const qualifiedCols = REPLENISHMENT_COLUMNS.split(',')
      .map((c) => `r.${c.trim()}`)
      .join(', ');

    // The ROOT row, enriched with its pipeline_stage + the embedded names (parity
    // with GET /:id so the frontend renders identically).
    //
    // cross-dept-flow §4/§6 — production_location_id (+ name) carried here too,
    // both for display parity and because the RBAC guard below
    // (requestTouchesLocation(root, own)) reads it to let the workshop manager
    // open a production-bound tree assigned to it.
    const { rows: rootFull } = await query<
      ReplenishmentRow & {
        product_name: string;
        product_unit: string;
        requester_location_name: string | null;
        target_location_name: string | null;
        production_location_id: number | null;
        production_location_name: string | null;
        requester_location_type: string | null;
        target_location_type: string | null;
        shipped_qty: number | null;
        pipeline_stage: PipelineStage;
      }
    >(
      // F-L — shipped_qty: the linked shipment movement's qty (see list endpoint).
      `SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              COALESCE(po.location_id, p.workshop_location_id)::int AS production_location_id,
              pl.name AS production_location_name,
              rl.type::text AS requester_location_type,
              tl.type::text AS target_location_type,
              sm.qty::float8 AS shipped_qty,
              ${PIPELINE_STAGE_SQL} AS pipeline_stage
         FROM replenishment_requests r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN locations rl ON rl.id = r.requester_location_id
         LEFT JOIN locations tl ON tl.id = r.target_location_id
         LEFT JOIN production_orders po ON po.id = r.production_order_id
         LEFT JOIN locations pl ON pl.id = COALESCE(po.location_id, p.workshop_location_id)
         LEFT JOIN stock_movements sm ON sm.id = r.shipment_movement_id
        WHERE r.id = $1`,
      [rootId],
    );
    const root = rootFull[0];
    if (root === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }

    // RBAC: a scoped role must touch the ROOT (same semantics as GET /:id).
    if (!isSuperAdmin(principal) && principal.role !== 'ai_assistant') {
      const own = principal.locationId;
      if (own === null || !(await requestTouchesLocation(root, own))) {
        throw AppError.forbidden('You may only view trees that touch your location.');
      }
    }

    // ALL descendants of the root (flat), enriched with pipeline_stage +
    // waiters_count. The recursive CTE walks DOWN via parent_request_id from the
    // root; ordered by depth then id so the frontend can nest deterministically.
    const { rows: nodes } = await query<
      ReplenishmentRow & {
        product_name: string;
        product_unit: string;
        requester_location_name: string | null;
        target_location_name: string | null;
        production_location_id: number | null;
        production_location_name: string | null;
        requester_location_type: string | null;
        target_location_type: string | null;
        shipped_qty: number | null;
        pipeline_stage: PipelineStage;
        waiters_count: number;
      }
    >(
      // cross-dept-flow §4/§6 — production_location_id (+ name) on every node for
      // display parity with the list/single endpoints.
      // F-L — shipped_qty on every node too (the linked shipment movement's qty).
      `WITH RECURSIVE descendants AS (
         SELECT id FROM replenishment_requests WHERE parent_request_id = $1
         UNION ALL
         SELECT c.id
           FROM replenishment_requests c
           JOIN descendants d ON c.parent_request_id = d.id
       )
       SELECT ${qualifiedCols},
              p.name AS product_name,
              p.unit AS product_unit,
              rl.name AS requester_location_name,
              tl.name AS target_location_name,
              COALESCE(po.location_id, p.workshop_location_id)::int AS production_location_id,
              pl.name AS production_location_name,
              rl.type::text AS requester_location_type,
              tl.type::text AS target_location_type,
              sm.qty::float8 AS shipped_qty,
              ${PIPELINE_STAGE_SQL} AS pipeline_stage,
              (SELECT count(*) FROM request_waiters w WHERE w.child_request_id = r.id)::int
                AS waiters_count
         FROM descendants dd
         JOIN replenishment_requests r ON r.id = dd.id
         JOIN products p ON p.id = r.product_id
         LEFT JOIN locations rl ON rl.id = r.requester_location_id
         LEFT JOIN locations tl ON tl.id = r.target_location_id
         LEFT JOIN production_orders po ON po.id = r.production_order_id
         LEFT JOIN locations pl ON pl.id = COALESCE(po.location_id, p.workshop_location_id)
         LEFT JOIN stock_movements sm ON sm.id = r.shipment_movement_id
        ORDER BY r.depth ASC, r.id ASC`,
      [rootId],
    );

    // Every request_waiters row anywhere in the tree (root + descendants).
    const { rows: waiters } = await query<{
      child_request_id: number;
      waiter_request_id: number;
    }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM replenishment_requests WHERE id = $1
         UNION ALL
         SELECT c.id
           FROM replenishment_requests c
           JOIN tree t ON c.parent_request_id = t.id
       )
       SELECT w.child_request_id, w.waiter_request_id
         FROM request_waiters w
        WHERE w.child_request_id IN (SELECT id FROM tree)
           OR w.waiter_request_id IN (SELECT id FROM tree)
        ORDER BY w.child_request_id ASC, w.waiter_request_id ASC`,
      [rootId],
    );

    res.status(200).json({
      root,
      nodes,
      waiters: waiters.map((w) => ({
        child_request_id: Number(w.child_request_id),
        waiter_request_id: Number(w.waiter_request_id),
      })),
    });
  }),
);

// POST /api/replenishment
//
// Owner-approved 2026-05-28: PM is read-and-recommend; the central warehouse
// manager and store managers raise manual requests (the auto-scan worker
// raises the rest with actor=null). PM hits 403 here — no super-admin bypass.
//
// 2026-06-05: a `store_manager` may now create a request, but ONLY for their
// OWN store — `requireLocationOperator(principal, requester_location_id)`
// enforces that they cannot request on behalf of another location. The central
// warehouse manager keeps the broad reach it had (any requester it owns).
replenishmentRouter.post(
  '/',
  authenticate,
  authorizeWrite('store_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const productId = requireId(body, 'product_id');
    const requesterLocationId = requireId(body, 'requester_location_id');
    const qtyNeeded = requirePositiveNumber(body, 'qty_needed');
    const note = optionalString(body, 'note') ?? null;

    // Location-scoping: a store_manager may only request FOR their own store.
    // The central warehouse manager is the fulfilment hub and keeps the broad
    // reach it had — it may raise a request on behalf of any downstream
    // location. PM is already 403'd by authorizeWrite above.
    if (principal.role === 'store_manager') {
      await requireLocationOperator(principal, requesterLocationId);
    }

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

// POST /api/replenishment/batch
//
// Batch create — one request per item, reusing createRequest. A duplicate
// open request for a `(product, location)` (invariant 2) is reported as
// `status: 'exists'` per item rather than aborting the whole batch; any other
// per-item failure is `status: 'error'` with a message. Always returns 200
// with a `results` array so the UI can render a per-row outcome.
//
// For a store_manager the requester is FORCED to their own store (the body's
// `requester_location_id` is ignored). The central warehouse manager is the
// fulfilment HUB and may create a request for ANY downstream location, so its
// `requester_location_id` is taken as-is — there is intentionally NO ownership
// check here (same policy as POST /). `createRequest` still validates that the
// location and product exist; an invalid id surfaces as a per-item 'error'.
replenishmentRouter.post(
  '/batch',
  authenticate,
  authorizeWrite('store_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);

    const itemsRaw = body.items;
    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
      throw AppError.validation('Field "items" must be a non-empty array.');
    }

    // Resolve the requester location. store_manager => FORCED to own store
    // (the body's requester_location_id is ignored). The central warehouse
    // manager is the fulfilment hub and may pass any downstream location.
    let requesterLocationId: number;
    if (principal.role === 'store_manager') {
      const own = principal.activeLocationId ?? principal.locationIds[0] ?? null;
      if (own === null) {
        throw AppError.forbidden('Your account has no assigned store to request for.');
      }
      requesterLocationId = own;
    } else {
      requesterLocationId = requireId(body, 'requester_location_id');
    }

    const note = optionalString(body, 'note') ?? null;

    // 0052 — allocate ONE batch id for the whole call so the central warehouse
    // can later accept/reject every line of this basket as one grouped order.
    const { rows: seqRows } = await query<{ batch_id: string }>(
      `SELECT nextval('replenishment_batch_seq') AS batch_id`,
    );
    const batchId = Number(seqRows[0]?.batch_id);
    if (!Number.isFinite(batchId)) {
      throw AppError.internal('Failed to allocate a batch id.');
    }

    type BatchResult = {
      product_id: number;
      status: 'created' | 'exists' | 'error';
      request_id?: number;
      message?: string;
    };
    const results: BatchResult[] = [];

    for (const itemRaw of itemsRaw) {
      let productId: number | undefined;
      try {
        const item = asObject(itemRaw);
        productId = requireId(item, 'product_id');
        const qtyNeeded = requirePositiveNumber(item, 'qty_needed');
        const row = await createRequest({
          productId,
          requesterLocationId,
          qtyNeeded,
          actorUserId: principal.userId,
          note,
          batchId,
        });
        results.push({ product_id: productId, status: 'created', request_id: row.id });
      } catch (err) {
        if (err instanceof AppError && err.code === 'OPEN_REQUEST_EXISTS') {
          results.push({
            product_id: productId ?? 0,
            status: 'exists',
            message: 'An open request already exists for this product at your location.',
          });
        } else {
          results.push({
            product_id: productId ?? 0,
            status: 'error',
            message: err instanceof AppError ? err.message : 'Failed to create request.',
          });
        }
      }
    }

    res.status(200).json({ batch_id: batchId, results });
  }),
);

// GET /api/replenishment/store-targets
//
// The list of downstream stores the central warehouse may ship to in the
// "savat -> do'konga yuborish" flow. The central_warehouse_manager is the
// fulfilment HUB — just like POST /batch lets it pass ANY downstream
// `requester_location_id`, it may target ANY store here, so we return every
// `type = 'store'` location (name-sorted). pm sees the same (read-only).
// Other roles are 403 via authorize().
replenishmentRouter.get(
  '/store-targets',
  authenticate,
  authorize('pm', 'central_warehouse_manager'),
  asyncHandler(async (_req, res) => {
    const { rows } = await query<{ id: number; name: string }>(
      `SELECT id, name
         FROM locations
        WHERE type = 'store'
        ORDER BY name ASC, id ASC`,
    );
    res.status(200).json({
      stores: rows.map((r) => ({ id: Number(r.id), name: r.name })),
    });
  }),
);

// ---------------------------------------------------------------------------
// AI auto-request — proposals (read) + approve (write)
// ---------------------------------------------------------------------------

// GET /api/replenishment/proposals?location_id=<store>
//
// Returns the AI top-up proposals for one store: every below-min product that
// does not already have an open request. A store_manager may read only their
// OWN store; pm sees any store (read-only).
replenishmentRouter.get(
  '/proposals',
  authenticate,
  authorize('pm', 'store_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const locationIdRaw = req.query.location_id;
    if (typeof locationIdRaw !== 'string' || !/^\d+$/.test(locationIdRaw)) {
      throw AppError.validation('Query "location_id" is required and must be a positive integer.');
    }
    const locationId = Number(locationIdRaw);

    // RBAC: scoped roles may only read their own location's proposals.
    if (!isSuperAdmin(principal)) {
      assertLocationAccess(principal, locationId);
    }

    const proposals = await getProposalsForLocation(locationId);
    res.status(200).json({ proposals });
  }),
);

// POST /api/replenishment/proposals/approve
//   body: { location_id, items: [{ product_id, qty }] }
//
// The boss "Hammasini tasdiqlash" — creates one request per item, reusing
// createRequest. A duplicate open request (invariant 2) is reported per-item as
// status:'exists' rather than aborting the batch. store_manager may approve only
// for their OWN store; pm is 403 (read-only write guard).
replenishmentRouter.post(
  '/proposals/approve',
  authenticate,
  authorizeWrite('store_manager', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const body = asObject(req.body);
    const locationId = requireId(body, 'location_id');

    const itemsRaw = body.items;
    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
      throw AppError.validation('Field "items" must be a non-empty array.');
    }

    // Location-scoping: the operator must own the target store.
    await requireLocationOperator(principal, locationId);

    type ApproveResult = {
      product_id: number;
      status: 'created' | 'exists' | 'error';
      request_id?: number;
      message?: string;
    };
    const results: ApproveResult[] = [];

    for (const itemRaw of itemsRaw) {
      let productId: number | undefined;
      try {
        const item = asObject(itemRaw);
        productId = requireId(item, 'product_id');
        const qty = requirePositiveNumber(item, 'qty');
        const row = await createRequest({
          productId,
          requesterLocationId: locationId,
          qtyNeeded: qty,
          actorUserId: principal.userId,
        });
        results.push({ product_id: productId, status: 'created', request_id: row.id });
      } catch (err) {
        if (err instanceof AppError && err.code === 'OPEN_REQUEST_EXISTS') {
          results.push({
            product_id: productId ?? 0,
            status: 'exists',
            message: 'An open request already exists for this product at this location.',
          });
        } else {
          results.push({
            product_id: productId ?? 0,
            status: 'error',
            message: err instanceof AppError ? err.message : 'Failed to create request.',
          });
        }
      }
    }

    res.status(200).json({ results });
  }),
);

// ---------------------------------------------------------------------------
// Central warehouse — incoming queue + accept / reject (the connection)
// ---------------------------------------------------------------------------

// GET /api/replenishment/incoming?location_id=<central>
//
// Open requests whose target is this central warehouse, with the requester
// store name. A central_warehouse_manager may read only their OWN warehouse;
// pm sees any (read-only). A NEW request has no target yet — to keep the
// connection visible from the moment a store raises it, we ALSO surface
// untargeted NEW/CHECK_STORE_SUPPLIER requests raised by a store (the central
// is the natural fulfiller). Targeted requests for OTHER warehouses are hidden.
replenishmentRouter.get(
  '/incoming',
  authenticate,
  authorize('pm', 'central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const locationIdRaw = req.query.location_id;
    if (typeof locationIdRaw !== 'string' || !/^\d+$/.test(locationIdRaw)) {
      throw AppError.validation('Query "location_id" is required and must be a positive integer.');
    }
    const centralId = Number(locationIdRaw);

    if (!isSuperAdmin(principal)) {
      assertLocationAccess(principal, centralId);
    }

    const { rows } = await query<{
      id: number;
      product_id: number;
      product_name: string;
      product_unit: string;
      requester_location_id: number;
      requester_location_name: string | null;
      qty_needed: string;
      status: string;
      batch_id: string | null;
      created_at: Date;
    }>(
      `SELECT r.id,
              r.product_id,
              p.name AS product_name,
              p.unit AS product_unit,
              r.requester_location_id,
              rl.name AS requester_location_name,
              r.qty_needed,
              r.status,
              r.batch_id,
              r.created_at
         FROM replenishment_requests r
         JOIN products p ON p.id = r.product_id
         LEFT JOIN locations rl ON rl.id = r.requester_location_id
        WHERE r.status NOT IN ('CLOSED', 'CANCELLED')
          AND (
            r.target_location_id = $1
            OR (
              r.target_location_id IS NULL
              AND r.status IN ('NEW', 'CHECK_STORE_SUPPLIER')
              AND rl.type = 'store'
            )
          )
        ORDER BY r.created_at ASC, r.id ASC`,
      [centralId],
    );

    res.status(200).json({
      items: rows.map((r) => ({
        id: Number(r.id),
        product_id: Number(r.product_id),
        product_name: r.product_name,
        unit: r.product_unit,
        requester_location_id: Number(r.requester_location_id),
        requester_location_name: r.requester_location_name,
        qty_needed: Number(r.qty_needed),
        status: r.status,
        batch_id: r.batch_id === null ? null : Number(r.batch_id),
        created_at: r.created_at,
      })),
    });
  }),
);

// POST /api/replenishment/:id/accept-central
//   body: { location_id }  (the acting central warehouse)
//
// The central warehouse ACCEPTS a store's request: pin the target to this
// warehouse and ship to the store (reusing the engine). pm is 403 (write guard).
replenishmentRouter.post(
  '/:id/accept-central',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const centralId = requireId(body, 'location_id');

    // The operator must own the acting central warehouse.
    await requireLocationOperator(principal, centralId);

    // Existence + the warehouse must actually be a central_warehouse.
    const { rows } = await query<{ id: number; type: string }>(
      `SELECT l.id, l.type
         FROM replenishment_requests r
         JOIN locations l ON l.id = $2
        WHERE r.id = $1`,
      [id, centralId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    if (row.type !== 'central_warehouse') {
      throw AppError.validation('location_id must be a central_warehouse.');
    }

    const result = await acceptByCentral({
      requestId: id,
      centralLocationId: centralId,
      actorUserId: principal.userId,
    });
    res.status(200).json({
      request: result.request,
      shipped: result.shipped,
      reason: result.reason,
    });
  }),
);

// POST /api/replenishment/:id/fulfill
//   body: { location_id, ship_qty?: number>=0, note?: string }
//
// 0058 — PARTIAL FULFILLMENT (the new partial path; supersedes accept-central
// for the modal). In ONE transaction the central warehouse manager:
//   (a) ships the AVAILABLE portion (min(qty_needed, central_on_hand), or the
//       capped `ship_qty`) to the store -> request shipped/awaiting-store-accept
//       (pipeline yuborilgan); and
//   (b) routes the shortfall (qty_needed - shipped) to production (pipeline
//       soralgan), as a NEW grouped request (or the original, when nothing was
//       on hand). pm is 403 (read-and-recommend write guard).
//
// Response: { shipped_qty, shortfall_qty, production_request_id, request }.
replenishmentRouter.post(
  '/:id/fulfill',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const centralId = requireId(body, 'location_id');

    // Optional ship_qty (>= 0); the service caps it at min(qty_needed, available).
    const shipQtyRaw = body.ship_qty;
    let shipQty: number | undefined;
    if (shipQtyRaw !== undefined && shipQtyRaw !== null) {
      if (typeof shipQtyRaw !== 'number' || !Number.isFinite(shipQtyRaw) || shipQtyRaw < 0) {
        throw AppError.validation('Field "ship_qty" must be a number >= 0.');
      }
      shipQty = shipQtyRaw;
    }
    const note = optionalString(body, 'note') ?? null;

    // The operator must own the acting central warehouse.
    await requireLocationOperator(principal, centralId);

    // Existence + the warehouse must actually be a central_warehouse (parity
    // with accept-central / to-production).
    const { rows } = await query<{ id: number; type: string }>(
      `SELECT l.id, l.type
         FROM replenishment_requests r
         JOIN locations l ON l.id = $2
        WHERE r.id = $1`,
      [id, centralId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    if (row.type !== 'central_warehouse') {
      throw AppError.validation('location_id must be a central_warehouse.');
    }

    const result = await fulfillStoreRequest({
      requestId: id,
      centralLocationId: centralId,
      ...(shipQty !== undefined ? { shipQty } : {}),
      note,
      actorUserId: principal.userId,
    });
    res.status(200).json({
      shipped_qty: result.shippedQty,
      shortfall_qty: result.shortfallQty,
      production_request_id: result.productionRequestId,
      request: { ...result.request, pipeline_stage: derivePipelineStage(result.request) },
    });
  }),
);

// POST /api/replenishment/:id/reject-central
//   body: { reason }
//
// The central warehouse REJECTS a store's request -> CANCELLED with reason.
replenishmentRouter.post(
  '/:id/reject-central',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const reason = optionalString(body, 'reason');
    if (reason === undefined || reason.trim() === '') {
      throw AppError.validation('Field "reason" is required for reject.');
    }

    // The acting principal must own a central warehouse that is (or would be)
    // the fulfiller. Accept either the request's pinned target, or — for an
    // untargeted store request — any central warehouse the operator owns.
    const { rows } = await query<{
      target_location_id: number | null;
      requester_location_id: number;
    }>(
      `SELECT target_location_id, requester_location_id
         FROM replenishment_requests WHERE id = $1`,
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    if (existing.target_location_id !== null) {
      await requireLocationOperator(principal, Number(existing.target_location_id));
    } else {
      // Untargeted — the operator just needs to own a central warehouse.
      const { rows: owned } = await query<{ id: number }>(
        `SELECT id FROM locations
          WHERE type = 'central_warehouse' AND id = ANY($1::bigint[])`,
        [principal.locationIds],
      );
      if (owned.length === 0) {
        throw AppError.forbidden('You do not manage a central warehouse for this request.');
      }
    }

    const updated = await cancelRequest(
      id,
      principal.userId,
      `rejected by central: ${reason.trim()}`,
      'rejected',
    );
    res.status(200).json({ request: updated });
  }),
);

// ---------------------------------------------------------------------------
// 0055 — Manual central -> production flow (store requests)
// ---------------------------------------------------------------------------
// When the central warehouse is SHORT, the central warehouse manager:
//   1. POST /:id/to-production            — explicitly route the request to
//                                           production (creates a production
//                                           order at the workshop; the request
//                                           STOPS at DONE_TO_WAREHOUSE and never
//                                           auto-ships).
//   2. POST /:id/receive-from-production  — after the production order is done,
//                                           confirm receipt at central with an
//                                           optional brak split.
//   3. POST /:id/ship-to-store            — forward central -> store -> CLOSED.
// All three are write actions gated to `central_warehouse_manager` (own central
// only). pm is 403 (read-and-recommend write guard).

// POST /api/replenishment/:id/to-production
//   body: { location_id }  (the acting central warehouse)
//
// status before: NEW | CHECK_STORE_SUPPLIER
// status after : CREATE_PRODUCTION_ORDER (raw OK) | CREATE_PURCHASE_ORDER (raw short)
//                — or unchanged (CHECK_PRODUCTION_INPUT) when no production
//                  topology/BOM can be resolved (advanced=false).
replenishmentRouter.post(
  '/:id/to-production',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const centralId = requireId(body, 'location_id');

    // The operator must own the acting central warehouse.
    await requireLocationOperator(principal, centralId);

    // Existence + the warehouse must actually be a central_warehouse (parity
    // with accept-central).
    const { rows } = await query<{ id: number; type: string }>(
      `SELECT l.id, l.type
         FROM replenishment_requests r
         JOIN locations l ON l.id = $2
        WHERE r.id = $1`,
      [id, centralId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    if (row.type !== 'central_warehouse') {
      throw AppError.validation('location_id must be a central_warehouse.');
    }

    const result = await sendToProduction({
      requestId: id,
      centralLocationId: centralId,
      actorUserId: principal.userId,
    });
    res.status(200).json({
      request: result.request,
      advanced: result.advanced,
      status: result.request.status,
      reason: result.reason,
    });
  }),
);

// POST /api/replenishment/:id/receive-from-production
//   body: { brak_qty?: number>=0, brak_reason?: string }
//
// status before: DONE_TO_WAREHOUSE   status after: SHIP_TO_REQUESTER
// The goods are already at central (production_output); this records the
// acknowledgement + an optional brak write-off (no double stock-in).
replenishmentRouter.post(
  '/:id/receive-from-production',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    const brakQtyRaw = body.brak_qty;
    let brakQty = 0;
    if (brakQtyRaw !== undefined && brakQtyRaw !== null) {
      if (typeof brakQtyRaw !== 'number' || !Number.isFinite(brakQtyRaw) || brakQtyRaw < 0) {
        throw AppError.validation('Field "brak_qty" must be a number >= 0.');
      }
      brakQty = brakQtyRaw;
    }
    const brakReason = optionalString(body, 'brak_reason') ?? null;

    // The acting principal must own the request's target central warehouse.
    const { rows } = await query<{ target_location_id: number | null }>(
      'SELECT target_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    if (existing.target_location_id === null) {
      throw AppError.validation('Request has no target warehouse to receive into.');
    }
    await requireLocationOperator(principal, Number(existing.target_location_id));

    const updated = await receiveFromProduction({
      requestId: id,
      brakQty,
      brakReason,
      actorUserId: principal.userId,
    });
    res.status(200).json({ request: updated });
  }),
);

// POST /api/replenishment/:id/ship-to-store
//   body: {}  (no fields)
//
// status before: SHIP_TO_REQUESTER   status after: CLOSED
// Forwards the received goods central -> store (atomic transfer), then closes.
replenishmentRouter.post(
  '/:id/ship-to-store',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // The acting principal must own the request's target central warehouse.
    const { rows } = await query<{ target_location_id: number | null }>(
      'SELECT target_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    if (existing.target_location_id === null) {
      throw AppError.validation('Request has no target warehouse to ship from.');
    }
    await requireLocationOperator(principal, Number(existing.target_location_id));

    const result = await shipToStore({ requestId: id, actorUserId: principal.userId });
    res.status(200).json({
      request: result.request,
      shipped: result.shipped,
      reason: result.reason,
    });
  }),
);

// ---------------------------------------------------------------------------
// 0052 — Central warehouse: bulk accept / reject a whole basket (batch)
// ---------------------------------------------------------------------------
// A store confirms a basket of below-min products via POST /batch; every line
// shares a `batch_id`. The central warehouse manager accepts or rejects the
// WHOLE basket as one grouped order. RBAC mirrors the single endpoints exactly
// (authorizeWrite('central_warehouse_manager')).

// POST /api/replenishment/batch/:batch_id/accept-central
//   body: { location_id }  (the acting central warehouse)
//
// Accept EVERY still-open request in the batch. Each line is accepted with the
// existing acceptByCentral engine call; a per-line failure is collected (not
// thrown) so one bad line does not abort the rest. Returns a summary.
replenishmentRouter.post(
  '/batch/:batch_id/accept-central',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const batchId = parseIdParam(req.params.batch_id, 'batch_id');
    const body = asObject(req.body);
    const centralId = requireId(body, 'location_id');

    // The operator must own the acting central warehouse.
    await requireLocationOperator(principal, centralId);

    // The warehouse must actually be a central_warehouse (parity with single).
    const { rows: locRows } = await query<{ id: number; type: string }>(
      `SELECT id, type FROM locations WHERE id = $1`,
      [centralId],
    );
    const loc = locRows[0];
    if (loc === undefined) {
      throw AppError.notFound('Location not found.');
    }
    if (loc.type !== 'central_warehouse') {
      throw AppError.validation('location_id must be a central_warehouse.');
    }

    // Every still-open line in the batch, oldest first (stable order).
    const { rows: openRows } = await query<{ id: number }>(
      `SELECT id FROM replenishment_requests
        WHERE batch_id = $1
          AND status NOT IN ('CLOSED', 'CANCELLED')
        ORDER BY id ASC`,
      [batchId],
    );
    if (openRows.length === 0) {
      throw AppError.notFound('No open requests found for this batch.');
    }

    let accepted = 0;
    let shipped = 0;
    const failed: { request_id: number; message: string }[] = [];

    for (const { id } of openRows) {
      try {
        const result = await acceptByCentral({
          requestId: Number(id),
          centralLocationId: centralId,
          actorUserId: principal.userId,
        });
        accepted += 1;
        if (result.shipped) {
          shipped += 1;
        }
      } catch (err) {
        failed.push({
          request_id: Number(id),
          message: err instanceof AppError ? err.message : 'Failed to accept request.',
        });
      }
    }

    res.status(200).json({ batch_id: batchId, accepted, shipped, failed });
  }),
);

// POST /api/replenishment/batch/:batch_id/reject-central
//   body: { reason }
//
// Reject (cancel) EVERY still-open request in the batch -> CANCELLED with
// closure_reason='rejected'. Returns the cancelled count.
replenishmentRouter.post(
  '/batch/:batch_id/reject-central',
  authenticate,
  authorizeWrite('central_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const batchId = parseIdParam(req.params.batch_id, 'batch_id');
    const body = asObject(req.body);
    const reason = optionalString(body, 'reason');
    if (reason === undefined || reason.trim() === '') {
      throw AppError.validation('Field "reason" is required for reject.');
    }

    // The acting principal must own a central warehouse — the natural fulfiller
    // for a store basket. (Mirrors the untargeted branch of the single
    // reject-central guard: a batch's NEW lines have no pinned target yet.)
    const { rows: owned } = await query<{ id: number }>(
      `SELECT id FROM locations
        WHERE type = 'central_warehouse' AND id = ANY($1::bigint[])`,
      [principal.locationIds],
    );
    if (owned.length === 0) {
      throw AppError.forbidden('You do not manage a central warehouse for this batch.');
    }

    const { rows: openRows } = await query<{ id: number }>(
      `SELECT id FROM replenishment_requests
        WHERE batch_id = $1
          AND status NOT IN ('CLOSED', 'CANCELLED')
        ORDER BY id ASC`,
      [batchId],
    );
    if (openRows.length === 0) {
      throw AppError.notFound('No open requests found for this batch.');
    }

    let cancelled = 0;
    for (const { id } of openRows) {
      await cancelRequest(
        Number(id),
        principal.userId,
        `rejected by central: ${reason.trim()}`,
        'rejected',
      );
      cancelled += 1;
    }

    res.status(200).json({ batch_id: batchId, cancelled });
  }),
);

// POST /api/replenishment/:id/advance
//
// Owner-approved 2026-05-28: only an operator may step the state machine.
// PM is 403 (no bypass) — the action happens at the operator's hop, not
// the chain. The "request touches my location" check still applies and
// is enforced for every non-PM principal below.
replenishmentRouter.post(
  '/:id/advance',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // Spec §6 W(bog'liq) — a scoped manager must be linked to the request
    // (requester/target, or indirectly via a linked production / purchase
    // order). authorizeWrite already filtered out PM and unallowed roles;
    // the remaining principals are all scoped operators.
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
    // Any of the operator's assigned locations may justify the action —
    // M:N (ADR-0012).
    const allowed = await principalTouchesRequest(r, principal.locationIds);
    if (!allowed) {
      throw AppError.forbidden('You may only advance requests that touch your location.');
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
//
// Owner-approved 2026-05-28: cancellation belongs to the requesting link
// in the chain — the manager of `requester_location_id`. PM may NOT
// cancel (read-and-recommend). The set of allowed roles is the set of
// roles that can manage a `location` that may itself raise a request:
// raw warehouse, production, supply, central warehouse, store.
replenishmentRouter.post(
  '/:id/cancel',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // Load the requester to enforce "only the originating bo'g'in
    // manager may cancel". 404 vs 403 split: an unknown id is 404; a
    // real id outside the operator's scope is 403.
    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const body = (req.body as Record<string, unknown> | null) ?? {};
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : 'manual cancel';

    const updated = await cancelRequest(id, principal.userId, reason);
    res.status(200).json({ request: updated });
  }),
);

// ---------------------------------------------------------------------------
// 0024 — Recipient-side closure: accept / reject / return
// ---------------------------------------------------------------------------
// Authorisation model:
//   * accept / reject / return — the requester location's operator confirms
//     what they received.   guard: `requireLocationOperator(principal,
//                                   request.requester_location_id)`.
//   * cancel-by-fulfiller    — the target location's operator (sklad/sex)
//     bekor qiladi.   guard: `requireLocationOperator(principal,
//                            request.target_location_id)`.
//
// 404 vs 403 split: unknown id -> 404; real id outside scope -> 403.

// POST /api/replenishment/:id/accept
//   body: { qty_accepted: number, note?: string }
replenishmentRouter.post(
  '/:id/accept',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const qtyAcceptedRaw = body.qty_accepted;
    if (
      typeof qtyAcceptedRaw !== 'number' ||
      !Number.isFinite(qtyAcceptedRaw) ||
      qtyAcceptedRaw < 0
    ) {
      throw AppError.validation('Field "qty_accepted" must be a number >= 0.');
    }
    const note = optionalString(body, 'note') ?? null;

    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const updated = await acceptShipment({
      requestId: id,
      qtyAccepted: qtyAcceptedRaw,
      note,
      actorUserId: principal.userId,
    });

    // 0058 — central Poster decrement on store-accept (best-effort, DRY-RUN by
    // default). The accepted (kept) qty is what physically left the central.
    await decrementCentralOnAccept({
      requestId: id,
      productId: updated.product_id,
      targetLocationId: updated.target_location_id,
      qty: qtyAcceptedRaw,
      actorUserId: principal.userId,
    });

    res.status(200).json({ request: updated });
  }),
);

// POST /api/replenishment/:id/receive
//   body: { received_qty: number>=0, brak_qty?: number>=0, brak_reason?: string }
//
// 0045 — the requester operator confirms physical receipt and (optionally)
// declares a `brak` (defect) split. `received_qty` stays in the store's
// sellable stock; `brak_qty` + any un-received remainder is counter-shipped
// back to the target. brak is recorded and is NOT sellable.
replenishmentRouter.post(
  '/:id/receive',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);

    const receivedQtyRaw = body.received_qty;
    if (
      typeof receivedQtyRaw !== 'number' ||
      !Number.isFinite(receivedQtyRaw) ||
      receivedQtyRaw < 0
    ) {
      throw AppError.validation('Field "received_qty" must be a number >= 0.');
    }
    const brakQtyRaw = body.brak_qty;
    let brakQty = 0;
    if (brakQtyRaw !== undefined && brakQtyRaw !== null) {
      if (typeof brakQtyRaw !== 'number' || !Number.isFinite(brakQtyRaw) || brakQtyRaw < 0) {
        throw AppError.validation('Field "brak_qty" must be a number >= 0.');
      }
      brakQty = brakQtyRaw;
    }
    const brakReason = optionalString(body, 'brak_reason') ?? null;

    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const updated = await receiveShipment({
      requestId: id,
      receivedQty: receivedQtyRaw,
      brakQty,
      brakReason,
      actorUserId: principal.userId,
    });

    // 0046 — Poster write-back (best-effort). The receive has already committed
    // above; we reflect the GOOD received qty back to Poster (live when a write
    // token is configured, otherwise queued for later). A Poster failure must
    // NEVER roll back the local receive, so this is wrapped in try/catch and
    // never throws out of the handler.
    try {
      await enqueuePosterReceiveWriteback({
        requestId: id,
        productId: updated.product_id,
        locationId: updated.requester_location_id,
        qty: receivedQtyRaw,
        actorUserId: principal.userId,
      });
    } catch (err) {
      console.error(
        '[replenishment.receive] poster write-back failed (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }

    // 0058 — central Poster decrement (best-effort, DRY-RUN by default). When the
    // store accepts a shipment that left a CENTRAL warehouse, the central's
    // Poster storage must be decremented (goods left central). Same try/catch
    // safety as above.
    await decrementCentralOnAccept({
      requestId: id,
      productId: updated.product_id,
      targetLocationId: updated.target_location_id,
      qty: receivedQtyRaw,
      actorUserId: principal.userId,
    });

    res.status(200).json({ request: updated });
  }),
);

// POST /api/replenishment/:id/reject
//   body: { reason: string }
replenishmentRouter.post(
  '/:id/reject',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const reason = optionalString(body, 'reason');
    if (reason === undefined) {
      throw AppError.validation('Field "reason" is required for reject.');
    }

    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const updated = await rejectShipment({
      requestId: id,
      reason,
      actorUserId: principal.userId,
    });
    res.status(200).json({ request: updated });
  }),
);

// POST /api/replenishment/:id/return
//   body: { qty_returned: number, reason: string }
replenishmentRouter.post(
  '/:id/return',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
    'store_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = asObject(req.body);
    const qtyReturned = requirePositiveNumber(body, 'qty_returned');
    const reason = optionalString(body, 'reason');
    if (reason === undefined) {
      throw AppError.validation('Field "reason" is required for return.');
    }

    const { rows } = await query<{ requester_location_id: number }>(
      'SELECT requester_location_id FROM replenishment_requests WHERE id = $1',
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    await requireLocationOperator(principal, Number(existing.requester_location_id));

    const updated = await returnShipment({
      requestId: id,
      qtyReturned,
      reason,
      actorUserId: principal.userId,
    });
    res.status(200).json({ request: updated });
  }),
);

// POST /api/replenishment/:id/cancel-by-fulfiller
//   body: { reason?: string }
replenishmentRouter.post(
  '/:id/cancel-by-fulfiller',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : 'cancelled by fulfiller';

    const { rows } = await query<{
      target_location_id: number | null;
      requester_location_id: number;
    }>(
      `SELECT target_location_id, requester_location_id
         FROM replenishment_requests WHERE id = $1`,
      [id],
    );
    const existing = rows[0];
    if (existing === undefined) {
      throw AppError.notFound('Replenishment request not found.');
    }
    // The fulfiller is the target side. If target is not yet resolved
    // (status=NEW), fall back to any production_order / purchase_order
    // location via principalTouchesRequest — the warehouse keeper who
    // owns the chain is the natural cancel actor.
    if (existing.target_location_id !== null) {
      await requireLocationOperator(principal, Number(existing.target_location_id));
    } else {
      // NEW state — no target yet. Permit raw_warehouse / central_warehouse /
      // supply managers whose assigned location is the eventual fulfiller
      // (resolved by the topology walk). Cheap heuristic: the chain manager
      // for the requester. We DENY if the operator does not touch the chain
      // at all.
      const allowed = await principalTouchesRequest(
        {
          requester_location_id: existing.requester_location_id,
          target_location_id: existing.target_location_id,
        },
        principal.locationIds,
      );
      if (!allowed) {
        throw AppError.forbidden(
          'You may only cancel-by-fulfiller requests that touch your location.',
        );
      }
    }

    const updated = await cancelRequestByFulfiller(id, principal.userId, reason);
    res.status(200).json({ request: updated });
  }),
);

// ---------------------------------------------------------------------------
// F-C / decision #8 — internal accept-gate for buffer (B-cycle) requests
// ---------------------------------------------------------------------------
// A sex_storage з/г buffer that fell below min raises a NEW request (origin
// scan/buffer). With the cron gate (runEngineCycle) it now SITS as a "tavsiya
// karta" until the PRODUCING отдел boss explicitly accepts or rejects it.
//
// RBAC: the producing workshop is the requester sex_storage's PARENT location
// (per migration 0022 every sex_storage hangs off its production sex). The
// acting operator must manage THAT workshop (requireLocationOperator). PM is
// 403 (read-and-recommend write guard — authorizeWrite excludes PM). 404 vs
// 403 split: unknown id -> 404; a real id outside the operator's scope -> 403.

/**
 * Load the request's requester location id + the producing workshop (its parent)
 * for the internal accept-gate RBAC. Throws 404 when the request is missing.
 */
async function loadInternalGateScope(
  id: number,
): Promise<{ requesterLocationId: number; workshopLocationId: number | null }> {
  const { rows } = await query<{
    requester_location_id: number;
    workshop_location_id: number | null;
  }>(
    `SELECT r.requester_location_id,
            rl.parent_id AS workshop_location_id
       FROM replenishment_requests r
       JOIN locations rl ON rl.id = r.requester_location_id
      WHERE r.id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound('Replenishment request not found.');
  }
  return {
    requesterLocationId: Number(row.requester_location_id),
    workshopLocationId: row.workshop_location_id === null ? null : Number(row.workshop_location_id),
  };
}

// POST /api/replenishment/:id/accept-internal
//   body: {}  (no fields)
//
// The producing отдел boss accepts a buffer refill -> NEW -> CHECK_STORE_SUPPLIER
// (the gate opens; the cron then carries the request forward). Idempotent.
replenishmentRouter.post(
  '/:id/accept-internal',
  authenticate,
  authorizeWrite('production_manager', 'central_warehouse_manager', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    const scope = await loadInternalGateScope(id);
    if (scope.workshopLocationId === null) {
      throw AppError.validation(
        'This request has no producing workshop (the requester is not a sex_storage with a parent).',
      );
    }
    // The acting operator must manage the producing workshop.
    await requireLocationOperator(principal, scope.workshopLocationId);

    const result = await acceptInternal({ requestId: id, actorUserId: principal.userId });
    res.status(200).json({
      request: result.request,
      accepted: result.accepted,
      reason: result.reason,
    });
  }),
);

// POST /api/replenishment/:id/reject-internal
//   body: { reason?: string }
//
// The producing отдел boss refuses a buffer refill -> CANCELLED
// (closure_reason='cancelled_by_fulfiller'). Idempotent.
replenishmentRouter.post(
  '/:id/reject-internal',
  authenticate,
  authorizeWrite('production_manager', 'central_warehouse_manager', 'raw_warehouse_manager'),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : null;

    const scope = await loadInternalGateScope(id);
    if (scope.workshopLocationId === null) {
      throw AppError.validation(
        'This request has no producing workshop (the requester is not a sex_storage with a parent).',
      );
    }
    await requireLocationOperator(principal, scope.workshopLocationId);

    const updated = await rejectInternal({ requestId: id, actorUserId: principal.userId, reason });
    res.status(200).json({ request: updated });
  }),
);

// ---------------------------------------------------------------------------
// F-G — web fulfiller accept / reject (parity with the Telegram xreq path)
// ---------------------------------------------------------------------------
// A cross-dept request PINNED to a non-central fulfiller (a producer sex_storage
// for cream, or the raw_warehouse for a mahsulot-ombori supply) is accepted /
// rejected by that fulfiller. The Telegram `xreq:accept|reject` buttons already
// drive this; these two routes give the WEB Kanban the same actions.
//
// RBAC mirrors `checkXreqRbac`: the acting operator must manage the request's
// effective fulfiller location — the PINNED `target_location_id` when set, else
// (a NEW request not yet pinned) the requester's topology parent (the location
// the original notification was addressed to). PM is 403 (authorizeWrite write
// guard); an operator of any OTHER location is 403; an unknown id is 404.

/**
 * Resolve the effective FULFILLER location for the web accept/reject-fulfiller
 * RBAC: the pinned `target_location_id` when present, otherwise the requester's
 * topology parent (mirrors `checkXreqRbac`). Throws 404 when the request is
 * missing; throws a 422 validation error when neither can be resolved (a root
 * requester with no parent has nobody to fulfil it).
 */
async function resolveFulfillerTarget(id: number): Promise<number> {
  const { rows } = await query<{
    target_location_id: number | null;
    requester_location_id: number;
  }>(
    `SELECT target_location_id, requester_location_id
       FROM replenishment_requests WHERE id = $1`,
    [id],
  );
  const existing = rows[0];
  if (existing === undefined) {
    throw AppError.notFound('Replenishment request not found.');
  }
  if (existing.target_location_id !== null) {
    return Number(existing.target_location_id);
  }
  const { rows: prows } = await query<{ parent_id: number | null }>(
    `SELECT parent_id FROM locations WHERE id = $1`,
    [existing.requester_location_id],
  );
  const parentId = prows[0]?.parent_id ?? null;
  if (parentId === null) {
    throw AppError.validation('Request has no fulfiller location (no pinned target and no parent).');
  }
  return Number(parentId);
}

// POST /api/replenishment/:id/accept-fulfiller
//   body: {}  (no fields)
//
// The fulfilling отдел accepts the request: pin the target to the fulfiller (when
// not already), ship from its own stock if it has any, else HOLD at
// CHECK_STORE_SUPPLIER (a raw_warehouse target holds until its Поставка lands —
// see the F-G "waiting for Poster supply" rule). Response mirrors accept-central:
// { request, shipped }.
replenishmentRouter.post(
  '/:id/accept-fulfiller',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // RBAC: the operator must manage the effective fulfiller (pinned target, else
    // the requester's parent). 404 for an unknown id; 403 for a foreign location.
    const fulfillerLocationId = await resolveFulfillerTarget(id);
    await requireLocationOperator(principal, fulfillerLocationId);

    const result = await acceptByFulfiller({
      requestId: id,
      fulfillerLocationId,
      actorUserId: principal.userId,
    });
    res.status(200).json({
      request: result.request,
      shipped: result.shipped,
      reason: result.reason,
    });
  }),
);

// POST /api/replenishment/:id/reject-fulfiller
//   body: { reason?: string }
//
// The fulfilling отдел refuses the request -> CANCELLED
// (closure_reason='cancelled_by_fulfiller'). Response: { request }.
replenishmentRouter.post(
  '/:id/reject-fulfiller',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : 'rejected by fulfiller';

    const fulfillerLocationId = await resolveFulfillerTarget(id);
    await requireLocationOperator(principal, fulfillerLocationId);

    const updated = await cancelRequestByFulfiller(id, principal.userId, reason);
    res.status(200).json({ request: updated });
  }),
);

// ---------------------------------------------------------------------------
// F-L / cross-dept-flow — production accept / reject (gate class d)
// ---------------------------------------------------------------------------
// A request the central manager routed to production is parked at
// CHECK_PRODUCTION_INPUT with its PRODUCTION assigned to an отдел
// (`COALESCE(po.location_id, p.workshop_location_id)`). The `runEngineCycle` gate
// (class d) holds it there until the отдел manager accepts; these two routes ARE
// that accept / reject. RBAC: the acting operator must manage the PRODUCTION
// location (the отдел). PM is 403 (write guard + requireLocationOperator); an
// operator of a foreign отдел is 403; an unknown id is 404; a wrong status is 409.

// POST /api/replenishment/:id/accept-production
//   body: {}  (no fields)
//
// The отдел manager accepts -> stamps fulfiller_accepted_at (NO status change; the
// stamp itself unblocks the cron, which runs advanceCheckProductionInput on its
// next pass). Idempotent: a re-call returns { accepted:false, reason:'already
// accepted' }. Response: { request, accepted }.
replenishmentRouter.post(
  '/:id/accept-production',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');

    // RBAC: resolve the request + its production location (the отдел). 404 for an
    // unknown id; 422 when the request has no resolvable production location (no
    // production order and the product has no workshop — there is no отдел to own
    // it). The operator must manage that отдел — PM/foreign are 403 inside
    // requireLocationOperator.
    const resolved = await resolveProductionLocationId(id);
    if (resolved === null) {
      throw AppError.notFound('Replenishment request not found.');
    }
    if (resolved.productionLocationId === null) {
      throw AppError.validation(
        'This request has no production location (no production order and the product has no workshop).',
      );
    }
    await requireLocationOperator(principal, resolved.productionLocationId);

    const result = await acceptProduction({ requestId: id, actorUserId: principal.userId });
    res.status(200).json({
      request: result.request,
      accepted: result.accepted,
      reason: result.reason,
    });
  }),
);

// POST /api/replenishment/:id/reject-production
//   body: { reason?: string }
//
// The отдел manager refuses -> CANCELLED (closure_reason='cancelled_by_fulfiller');
// post-commit chainWaiters fires (as on every terminal). Response: { request }.
replenishmentRouter.post(
  '/:id/reject-production',
  authenticate,
  authorizeWrite(
    'raw_warehouse_manager',
    'production_manager',
    'supply_manager',
    'central_warehouse_manager',
  ),
  asyncHandler(async (req, res) => {
    const principal = getPrincipal(req);
    const id = parseIdParam(req.params.id, 'id');
    const body = (req.body as Record<string, unknown> | null) ?? {};
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : null;

    // RBAC mirrors accept-production: the operator must manage the отдел. Same
    // 404 / 422 / 403 split.
    const resolved = await resolveProductionLocationId(id);
    if (resolved === null) {
      throw AppError.notFound('Replenishment request not found.');
    }
    if (resolved.productionLocationId === null) {
      throw AppError.validation(
        'This request has no production location (no production order and the product has no workshop).',
      );
    }
    await requireLocationOperator(principal, resolved.productionLocationId);

    const updated = await rejectProduction({ requestId: id, actorUserId: principal.userId, reason });
    res.status(200).json({ request: updated });
  }),
);

/**
 * 0058 — decrement the CENTRAL warehouse's Poster storage when a store accepts a
 * shipment that left a central. Best-effort + DRY-RUN by default: a Poster
 * failure (or a non-central target) must NEVER surface to the caller, so this
 * resolves the target type, calls `enqueueCentralDecrementWriteback` only for a
 * `central_warehouse` target, and swallows every error. The accept transaction
 * has already committed before this runs.
 */
async function decrementCentralOnAccept(opts: {
  requestId: number;
  productId: number;
  targetLocationId: number | null;
  qty: number;
  actorUserId: number | null;
}): Promise<void> {
  if (opts.targetLocationId === null || !Number.isFinite(opts.qty) || opts.qty <= 0) {
    return;
  }
  try {
    const { rows } = await query<{ type: string }>(
      'SELECT type FROM locations WHERE id = $1',
      [opts.targetLocationId],
    );
    if (rows[0]?.type !== 'central_warehouse') {
      return; // only a central warehouse's Poster storage is decremented.
    }
    await enqueueCentralDecrementWriteback({
      requestId: opts.requestId,
      productId: opts.productId,
      centralLocationId: opts.targetLocationId,
      qty: opts.qty,
      actorUserId: opts.actorUserId,
    });
  } catch (err) {
    console.error(
      '[replenishment.accept] central poster decrement failed (ignored):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * The request statuses in which a workshop may READ a row whose PRODUCTION is
 * assigned to it (cross-dept-flow §4/§6 — the same production-bound set the list
 * WHERE uses). Closed / store-side rows stay invisible to the workshop.
 */
const PRODUCTION_BOUND_STATUSES: readonly ReplenishmentStatus[] = [
  'CHECK_PRODUCTION_INPUT',
  'CREATE_PURCHASE_ORDER',
  'CREATE_PRODUCTION_ORDER',
  'PRODUCING',
  'DONE_TO_WAREHOUSE',
];

/**
 * Spec §6 "W(bog'liq)" — a scoped role touches a request when its location
 * matches the requester, the target, OR the location_id of a linked
 * production_order / target_location_id of a linked purchase_order. The two
 * extra checks fire only when the request has been linked (lazy join).
 *
 * cross-dept-flow §4/§6 — a workshop ALSO touches a request whose PRODUCTION is
 * assigned to it: `production_location_id` (COALESCE(po.location_id,
 * p.workshop_location_id), passed in on the row) matches its location AND the
 * status is production-bound. This is the READ-side mirror of the widened list
 * WHERE, so GET /:id and /:id/tree let the workshop manager open such a row.
 */
async function requestTouchesLocation(
  request: {
    requester_location_id: number;
    target_location_id: number | null;
    production_order_id?: number | null;
    purchase_order_id?: number | null;
    production_location_id?: number | null;
    status?: ReplenishmentStatus;
  },
  ownLocationId: number,
): Promise<boolean> {
  if (
    ownLocationId === request.requester_location_id ||
    ownLocationId === request.target_location_id
  ) {
    return true;
  }
  // Workshop production binding — only while the request is production-bound.
  if (
    request.production_location_id != null &&
    ownLocationId === request.production_location_id &&
    request.status !== undefined &&
    PRODUCTION_BOUND_STATUSES.includes(request.status)
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

/** M:N variant — any of `ownLocationIds` touching is enough (ADR-0012). */
async function principalTouchesRequest(
  request: {
    requester_location_id: number;
    target_location_id: number | null;
    production_order_id?: number | null;
    purchase_order_id?: number | null;
  },
  ownLocationIds: readonly number[],
): Promise<boolean> {
  for (const id of ownLocationIds) {
    if (await requestTouchesLocation(request, id)) {
      return true;
    }
  }
  return false;
}
