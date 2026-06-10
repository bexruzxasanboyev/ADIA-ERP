/**
 * M4 — Replenishment engine + state machine (spec section 2.4 and 3, ADR-0001).
 *
 * This file is the YADRO of the self-correcting bakery ERP. It implements the
 * 10-state machine that drives one `replenishment_request` from `NEW` (the
 * scan worker spotted `stock.qty <= min_level`) to `CLOSED` (the requester
 * was topped up to `max_level`).
 *
 * Invariants enforced here:
 *   - SM-1 every transition is appended to `replenishment_transitions`;
 *   - SM-2 only a transition in `ALLOWED_TRANSITIONS` is accepted —
 *           anything else raises `INVALID_TRANSITION` (409);
 *   - SM-3 `advance()` flips status + creates the linked document + applies
 *           the movement + writes audit in ONE `withTransaction`;
 *   - SM-4 the wait states (`CREATE_PURCHASE_ORDER`, `PRODUCING`) return a
 *           no-op `{ advanced: false }` when their guard is not yet met;
 *   - SM-5 `advance()` is a no-op on terminal (`CLOSED`/`CANCELLED`) states;
 *   - SM-6 idempotent — re-calling `advance()` on the same row twice never
 *           skips a state and never double-applies a movement (FOR UPDATE
 *           lock + status check inside the same transaction).
 *   - Invariant 2 — one open request per (product, requester_location) is
 *           enforced by the partial UNIQUE index on the table; this service
 *           additionally returns OPEN_REQUEST_EXISTS (409) on `createRequest`.
 */
import { query, withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import { applyMovement } from './stockMovement.js';
import { readFinalBom } from './bom.js';
import {
  createNotification,
  createNotificationsForRecipients,
  getLocationManager,
} from './notify.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type ReplenishmentStatus =
  | 'NEW'
  | 'CHECK_STORE_SUPPLIER'
  | 'SHIP_TO_REQUESTER'
  | 'CHECK_PRODUCTION_INPUT'
  | 'CREATE_PURCHASE_ORDER'
  | 'CREATE_PRODUCTION_ORDER'
  | 'PRODUCING'
  | 'DONE_TO_WAREHOUSE'
  | 'CLOSED'
  | 'CANCELLED';

export const TERMINAL_STATUSES: readonly ReplenishmentStatus[] = ['CLOSED', 'CANCELLED'];

/**
 * 0058 — the 5-status CENTRAL pipeline view (owner-corrected 2026-06-08). The
 * frontend buckets requests into five tabs and trusts this single derived field
 * — so the derivation is TOTAL (every request maps to exactly one stage) and
 * lives in ONE place: this union + `derivePipelineStage` (TS, used by the single
 * GET + tests) and `PIPELINE_STAGE_SQL` (the mirrored SQL CASE used by the list
 * query — no N+1).
 *
 *   kutuvda        — store request not yet handled, OR a manual production
 *                    delivery awaiting the central manager's receipt.
 *   soralgan       — shortfall being produced / sourced (in-production states).
 *   qabul_qilingan — received from production at central, ready to forward.
 *   yuborilgan     — shipped to a store, RESERVED, store has NOT accepted yet.
 *   yopilgan       — terminal: accepted / rejected / returned / cancelled.
 */
export type PipelineStage =
  | 'kutuvda'
  | 'soralgan'
  | 'qabul_qilingan'
  | 'yuborilgan'
  | 'yopilgan';

/** The subset of a request row `derivePipelineStage` needs. */
export type PipelineStageInput = {
  status: ReplenishmentStatus;
  closure_reason: ReplenishmentClosureReason | null;
  route_to_production_manual: boolean;
  received_from_production_at: Date | string | null;
};

/**
 * Derive the pipeline stage from a request row. Evaluated top-down, first match
 * wins (the ordering is load-bearing — see the spec). MUST stay in lock-step
 * with `PIPELINE_STAGE_SQL`.
 */
export function derivePipelineStage(row: PipelineStageInput): PipelineStage {
  // 1. yopilgan — terminal. CANCELLED always; CLOSED only once the store has
  //    acted (closure_reason set: accepted / rejected / returned / cancelled).
  if (row.status === 'CANCELLED') return 'yopilgan';
  if (row.status === 'CLOSED' && row.closure_reason !== null) return 'yopilgan';
  // 2. yuborilgan — shipped (CLOSED) but the store has NOT accepted yet.
  if (row.status === 'CLOSED' && row.closure_reason === null) return 'yuborilgan';
  // 3. qabul_qilingan — received from production at central, ready to forward.
  if (row.status === 'SHIP_TO_REQUESTER') return 'qabul_qilingan';
  // 4. kutuvda — store request not yet handled, OR a manual production delivery
  //    sitting at the warehouse awaiting the manager's explicit receipt.
  if (row.status === 'NEW' || row.status === 'CHECK_STORE_SUPPLIER') return 'kutuvda';
  if (row.status === 'DONE_TO_WAREHOUSE' && row.route_to_production_manual) return 'kutuvda';
  // 5. soralgan — everything else still in flight: the in-production / sourcing
  //    states, plus a non-manual DONE_TO_WAREHOUSE (internal auto-flow goods
  //    pending the auto-ship hop).
  return 'soralgan';
}

/**
 * SQL mirror of `derivePipelineStage` — a single CASE expression for the list
 * query so the stage is computed server-side without an N+1. `r` is the
 * `replenishment_requests` alias. Keep in lock-step with the TS function above.
 */
export const PIPELINE_STAGE_SQL = `CASE
  WHEN r.status = 'CANCELLED' THEN 'yopilgan'
  WHEN r.status = 'CLOSED' AND r.closure_reason IS NOT NULL THEN 'yopilgan'
  WHEN r.status = 'CLOSED' AND r.closure_reason IS NULL THEN 'yuborilgan'
  WHEN r.status = 'SHIP_TO_REQUESTER' THEN 'qabul_qilingan'
  WHEN r.status IN ('NEW', 'CHECK_STORE_SUPPLIER') THEN 'kutuvda'
  WHEN r.status = 'DONE_TO_WAREHOUSE' AND r.route_to_production_manual THEN 'kutuvda'
  ELSE 'soralgan'
END`;

/**
 * For skip-state chaining (SM-7) — the set of forward transitions that should
 * be retried inside the SAME `advance()` call after a successful step. If the
 * next state's guard happens to be satisfied (e.g. the linked production order
 * is already `done` when we move to `PRODUCING`), the engine chains forward
 * in one transaction rather than waiting for the cron's next pass.
 */
const CHAINABLE_AFTER: Readonly<Record<ReplenishmentStatus, boolean>> = {
  NEW: false,
  CHECK_STORE_SUPPLIER: false,
  SHIP_TO_REQUESTER: false,
  CHECK_PRODUCTION_INPUT: false,
  CREATE_PURCHASE_ORDER: false,
  CREATE_PRODUCTION_ORDER: true, // -> PRODUCING -> DONE_TO_WAREHOUSE
  PRODUCING: true, // -> DONE_TO_WAREHOUSE
  DONE_TO_WAREHOUSE: false,
  CLOSED: false,
  CANCELLED: false,
};

/**
 * The set of closure reasons a CLOSED / CANCELLED request may carry.
 * Migration 0024 adds the `closure_reason` column; the values mirror the
 * CHECK constraint there. NULL is allowed (legacy rows + in-flight rows).
 */
export type ReplenishmentClosureReason =
  | 'accepted_full'
  | 'accepted_partial'
  | 'rejected'
  | 'returned'
  | 'cancelled_by_requester'
  | 'cancelled_by_fulfiller';

/**
 * 0065 / cross-dept-flow §8 — HOW a request was born. Drives the Kanban
 * "recommendation card vs real request" framing and analytics; mirrors the
 * `chk_replenishment_origin` CHECK constraint exactly (any drift would be a
 * 23514 on insert).
 *
 *   scan      — the below-min cron raised it (an internal layer, NOT a store).
 *   manual    — a human raised it (web form / API) — the conservative default.
 *   voice     — a Telegram voice/menu cross-dept request (`crossDeptRequest`).
 *   dialog    — emitted by the production dialog / "Manba reja" resolver.
 *   shortfall — the leftover of a partial fulfil, routed to production.
 *   buffer    — the B-cycle: a sex_storage з/г buffer fell to/below min.
 */
export type RequestOrigin =
  | 'scan'
  | 'manual'
  | 'voice'
  | 'dialog'
  | 'shortfall'
  | 'buffer';

export const REQUEST_ORIGINS: readonly RequestOrigin[] = [
  'scan',
  'manual',
  'voice',
  'dialog',
  'shortfall',
  'buffer',
];

export type ReplenishmentRow = {
  id: number;
  product_id: number;
  requester_location_id: number;
  target_location_id: number | null;
  qty_needed: number;
  status: ReplenishmentStatus;
  production_order_id: number | null;
  purchase_order_id: number | null;
  shipment_movement_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
  closed_at: Date | null;
  assigned_to_user_id: number | null;
  /** 0024 — qty actually accepted by the recipient (NULL until accept/reject). */
  qty_accepted: number | null;
  /** 0024 — qty counter-shipped back after accept/return (NULL when none). */
  qty_returned: number | null;
  /** 0024 — recipient free-form note attached at accept time. */
  accept_note: string | null;
  /** 0024 — recipient free-form reason attached at reject/return time. */
  reject_reason: string | null;
  /** 0024 — HOW the request reached terminal. NULL while open. */
  closure_reason: ReplenishmentClosureReason | null;
  /** 0045 — defective qty refused on receipt (NULL until receive). */
  brak_qty: number | null;
  /** 0045 — free-form reason for the brak (NULL when no brak). */
  brak_reason: string | null;
  /** 0052 — basket group id; lines created in one /batch call share it. NULL = individual. */
  batch_id: number | null;
  /**
   * 0055 — TRUE once a store request was explicitly routed to production by the
   * central warehouse manager (POST /:id/to-production). Such a request STOPS at
   * DONE_TO_WAREHOUSE and never auto-ships; the manager must receive + forward
   * it by hand. FALSE for direct-ship and internal auto-replenishment paths.
   */
  route_to_production_manual: boolean;
  /**
   * 0055 — when the central warehouse manager confirmed receipt of the produced
   * goods (POST /:id/receive-from-production). Gate for the final forward to the
   * store. NULL = not yet received.
   */
  received_from_production_at: Date | null;
  /** 0065 — the immediate parent request this one was spawned for (NULL = root). */
  parent_request_id: number | null;
  /** 0065 — the top of the request tree (NULL/self for a root). */
  root_request_id: number | null;
  /** 0065 — distance from the root (0 = root); capped at 12. */
  depth: number;
  /** 0065 — how the request was born (origin domain). */
  origin: RequestOrigin;
  /**
   * 0066 — when the fulfilling отдел FIRST accepted this request (first accept
   * wins; set inside acceptByCentral / acceptByFulfiller / acceptInternal, or
   * implicitly by a partial fulfill). NULL = not yet accepted. Drives the
   * Kanban "Tasdiqlandi" column independently of the technical status.
   */
  fulfiller_accepted_at: Date | null;
  /** 0066 — the user who performed that first accept (NULL when none / cron). */
  fulfiller_accepted_by: number | null;
};

export const REPLENISHMENT_COLUMNS = `id, product_id, requester_location_id,
  target_location_id, qty_needed, status, production_order_id, purchase_order_id,
  shipment_movement_id, note, created_by, created_at, updated_at, closed_at,
  assigned_to_user_id, qty_accepted, qty_returned, accept_note, reject_reason,
  closure_reason, brak_qty, brak_reason, batch_id,
  route_to_production_manual, received_from_production_at,
  parent_request_id, root_request_id, depth, origin,
  fulfiller_accepted_at, fulfiller_accepted_by`;

/**
 * Possible outcomes of one `advance()` call. `advanced=false` means a wait
 * state's guard is not yet met (SM-4) — not an error.
 */
export type AdvanceResult = {
  readonly advanced: boolean;
  readonly request: ReplenishmentRow;
  readonly reason: string;
};

// -----------------------------------------------------------------------------
// Transition table — SM-2
// -----------------------------------------------------------------------------
// The set of every `from -> to` step the engine may take. CANCELLED is an
// orthogonal terminal: `cancel()` flips any open status to CANCELLED.
const ALLOWED_TRANSITIONS: Readonly<Record<ReplenishmentStatus, readonly ReplenishmentStatus[]>> = {
  NEW: ['CHECK_STORE_SUPPLIER', 'CANCELLED'],
  CHECK_STORE_SUPPLIER: ['SHIP_TO_REQUESTER', 'CHECK_PRODUCTION_INPUT', 'CANCELLED'],
  CHECK_PRODUCTION_INPUT: ['CREATE_PRODUCTION_ORDER', 'CREATE_PURCHASE_ORDER', 'CANCELLED'],
  // Phase-2 (F2.3): self-loop is allowed because a multi-shortage BOM creates
  // POs one at a time — after PO1 is received we re-enter CHECK_PRODUCTION_INPUT
  // and if PO2 is still needed we stay in CREATE_PURCHASE_ORDER with the new PO
  // linked. The M:N `replenishment_purchase_orders` table retains every PO.
  CREATE_PURCHASE_ORDER: ['CREATE_PURCHASE_ORDER', 'CREATE_PRODUCTION_ORDER', 'CANCELLED'],
  CREATE_PRODUCTION_ORDER: ['PRODUCING', 'CANCELLED'],
  PRODUCING: ['DONE_TO_WAREHOUSE', 'CANCELLED'],
  DONE_TO_WAREHOUSE: ['SHIP_TO_REQUESTER', 'CANCELLED'],
  SHIP_TO_REQUESTER: ['CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

/** Returns true when `to` is reachable from `from` in one step. */
export function canTransition(from: ReplenishmentStatus, to: ReplenishmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// -----------------------------------------------------------------------------
// Create / Cancel
// -----------------------------------------------------------------------------

/**
 * Create a new replenishment request. The partial UNIQUE index on
 * `(product_id, requester_location_id) WHERE status NOT IN ('CLOSED','CANCELLED')`
 * is the DB-level guard against duplicates (invariant 2); we surface a
 * friendly `OPEN_REQUEST_EXISTS` (409) when it fires.
 */
export async function createRequest(opts: {
  productId: number;
  requesterLocationId: number;
  qtyNeeded: number;
  actorUserId: number | null;
  note?: string | null;
  /**
   * 0052 — optional batch group id. When set, every line created in one
   * /batch call shares it so the central warehouse can accept/reject the
   * whole basket as one grouped order. NULL = legacy / individual request.
   */
  batchId?: number | null;
  /**
   * 0065 / cross-dept-flow §8 — request-tree links. A resolver-emitted
   * sub-request passes the parent it was raised for; `rootRequestId` /
   * `depth` are derived from the parent when omitted (root = parent's root ??
   * parent id; the caller normally passes both, but the derivation keeps a
   * lone `parentRequestId` correct). `origin` records how the request was born
   * (default 'manual' — the legacy value). depth is capped at 12.
   */
  parentRequestId?: number | null;
  rootRequestId?: number | null;
  depth?: number;
  origin?: RequestOrigin;
}): Promise<ReplenishmentRow> {
  if (!Number.isFinite(opts.qtyNeeded) || opts.qtyNeeded <= 0) {
    throw AppError.validation('qty_needed must be a number greater than zero.');
  }

  const parentRequestId = opts.parentRequestId ?? null;
  const depth = opts.depth ?? 0;
  // Defence in depth — the DB CHECK is the last line, but a >12 chain is a
  // recipe-cycle / runaway-tree smell the caller should hear about loudly.
  if (!Number.isInteger(depth) || depth < 0 || depth > 12) {
    throw AppError.validation('depth must be an integer between 0 and 12.');
  }
  const origin = opts.origin ?? 'manual';

  try {
    return await withTransaction((tx) =>
      createRequestInTx(tx, { ...opts, parentRequestId, depth, origin }),
    );
  } catch (err) {
    // 23505 is the PostgreSQL unique-violation SQLSTATE — only our partial
    // index can fire here. Surface the spec-defined OPEN_REQUEST_EXISTS code.
    if (isUniqueViolation(err)) {
      throw new AppError(
        'OPEN_REQUEST_EXISTS',
        'An open replenishment request already exists for this (product, location).',
      );
    }
    throw err;
  }
}

/**
 * tx-scoped core of `createRequest` — the actual INSERT + transition + audit +
 * created-notification, running inside the CALLER's transaction.
 *
 * `createRequest` (above) wraps this in its own `withTransaction` and maps the
 * 23505 unique-violation to the friendly `OPEN_REQUEST_EXISTS` code. A caller
 * that already owns a transaction and wants the SAME insert to be part of its
 * all-or-nothing unit (cross-dept-flow F-B: `createCrossDeptRequestInTx`, the
 * "Manba reja" resolver's `'order'` action) calls THIS directly so the new
 * row, the producer-target pin, and the rest of the resolver commit together.
 *
 * Validation (qty/depth) is done by `createRequest`; this core assumes its
 * inputs are already normalised (parentRequestId/depth/origin resolved to their
 * final values). It does NOT translate 23505 — the raw unique violation bubbles
 * up so the in-tx caller can branch on it (waiter-link, §8) WITHOUT the friendly
 * AppError wrapping that would lose the "which open child" context.
 */
export async function createRequestInTx(
  tx: TxClient,
  opts: {
    productId: number;
    requesterLocationId: number;
    qtyNeeded: number;
    actorUserId: number | null;
    note?: string | null;
    batchId?: number | null;
    parentRequestId: number | null;
    depth: number;
    origin: RequestOrigin;
    rootRequestId?: number | null;
  },
): Promise<ReplenishmentRow> {
  const parentRequestId = opts.parentRequestId;
  const depth = opts.depth;
  const origin = opts.origin;
  // Root derivation: an explicit rootRequestId wins; otherwise, when a
  // parent is given, the root is the parent's own root (or the parent
  // itself when the parent is a root). A bare request (no parent) keeps a
  // NULL root — it IS its own root, surfaced by the tree reader as self.
  let rootRequestId = opts.rootRequestId ?? null;
  if (rootRequestId === null && parentRequestId !== null) {
    const { rows: parentRows } = await tx.query<{ root_request_id: number | null }>(
      'SELECT root_request_id FROM replenishment_requests WHERE id = $1',
      [parentRequestId],
    );
    const parent = parentRows[0];
    if (parent === undefined) {
      throw AppError.validation(`parent_request_id ${parentRequestId} does not exist.`);
    }
    rootRequestId =
      parent.root_request_id === null ? parentRequestId : Number(parent.root_request_id);
  }

  const { rows } = await tx.query<ReplenishmentRow>(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, qty_needed, status, note, created_by, batch_id,
        parent_request_id, root_request_id, depth, origin)
     VALUES ($1, $2, $3, 'NEW', $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${REPLENISHMENT_COLUMNS}`,
    [
      opts.productId,
      opts.requesterLocationId,
      opts.qtyNeeded,
      opts.note ?? null,
      opts.actorUserId,
      opts.batchId ?? null,
      parentRequestId,
      rootRequestId,
      depth,
      origin,
    ],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.internal('Replenishment insert returned no row.');
  }
  await recordTransition(tx, row.id, null, 'NEW', 'created', opts.actorUserId);
  await writeAudit(tx, {
    actorUserId: opts.actorUserId,
    action: 'replenishment.create',
    entity: 'replenishment_requests',
    entityId: row.id,
    payload: {
      product_id: opts.productId,
      requester_location_id: opts.requesterLocationId,
      qty_needed: opts.qtyNeeded,
      // 0065 — record the tree placement + origin in the audit trail.
      parent_request_id: parentRequestId,
      root_request_id: rootRequestId,
      depth,
      origin,
    },
  });
  // M9 — replenishment_created notification (spec §7). The requester
  // location manager is the primary owner of the request; the target
  // location is not yet resolved here (NEW state — `advanceNew` fills
  // `target_location_id`), so the target manager nudge is sent at the
  // first transition (CHECK_STORE_SUPPLIER). The optional `actorUserId`
  // is also notified when it is NOT the location manager (a `pm` raising
  // a manual request gets visibility on it).
  await notifyReplenishmentCreated(tx, row, opts.actorUserId);
  return row;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === '23505'
  );
}

/**
 * 0066 / cross-dept-flow §3 — stamp the fulfiller acceptance (who + when) on a
 * request, but ONLY when it is still NULL: the FIRST accept wins, so a later
 * re-accept (or a fulfill that follows an accept) never overwrites the original
 * "Tasdiqlandi" moment the Kanban shows. The `WHERE … IS NULL` guard makes this
 * naturally idempotent — a second call on an already-stamped row updates 0 rows.
 *
 * tx-scoped: runs inside the caller's accept transaction so the stamp and the
 * status flip / ship commit together (all-or-nothing). The audit note is left to
 * the caller — the existing accept_* audit row already records the action.
 */
async function stampFulfillerAccept(
  tx: TxClient,
  requestId: number,
  actorUserId: number | null,
): Promise<void> {
  await tx.query(
    `UPDATE replenishment_requests
        SET fulfiller_accepted_at = now(),
            fulfiller_accepted_by = $2
      WHERE id = $1 AND fulfiller_accepted_at IS NULL`,
    [requestId, actorUserId],
  );
}

// -----------------------------------------------------------------------------
// 0065 / cross-dept-flow §8 — request-tree waiters + pre-accept qty top-up
// -----------------------------------------------------------------------------

/**
 * Attach `waiterRequestId` (a root) to `childRequestId` (a shared open child) in
 * `request_waiters` — invariant-2 coexistence (§8). When two roots both need the
 * same semi from the same producer, the SECOND root must NOT open a duplicate
 * (invariant 2 forbids it); it links here instead, so the child closing later
 * fans out to EVERY waiter (F-D), not just its single `parent_request_id`.
 *
 * Idempotent — `ON CONFLICT DO NOTHING` on the (child, waiter) PK, so a re-run
 * (e.g. the same execute() retried) never errors. A self-wait (child == waiter)
 * is refused by the table CHECK; we skip it here too so the caller need not.
 * tx-scoped: the caller owns the transaction (one execute() stays atomic).
 *
 * @returns true when a NEW waiter row was inserted (false on conflict / skip).
 */
export async function linkWaiter(
  tx: TxClient,
  childRequestId: number,
  waiterRequestId: number,
): Promise<boolean> {
  if (childRequestId === waiterRequestId) {
    // A root never waits on itself — nothing to record.
    return false;
  }
  const { rowCount } = await tx.query(
    `INSERT INTO request_waiters (child_request_id, waiter_request_id)
     VALUES ($1, $2)
     ON CONFLICT (child_request_id, waiter_request_id) DO NOTHING`,
    [childRequestId, waiterRequestId],
  );
  return rowCount > 0;
}

/**
 * Increase a child request's `qty_needed` by `extraQty` — but ONLY while it is
 * still `status='NEW'` (decision #9: top-up is allowed only BEFORE the fulfiller
 * accepts; once accepted/advanced the qty is frozen and a shortfall becomes a
 * follow-up request instead). Used when a second root attaches to an already-open
 * child (`linkWaiter`) and needs MORE than the child currently asks for.
 *
 * Atomic + race-safe: the `WHERE id=$1 AND status='NEW'` guard means a
 * concurrent advance that flips the child out of NEW makes this a no-op (0 rows)
 * — no lost-update, no top-up after accept. Writes an audit row when it applies.
 * tx-scoped: shares the caller's transaction.
 *
 * @returns true when the qty was topped up; false when the child was no longer
 *          NEW (caller then opens a follow-up after the child closes — §8).
 */
export async function topUpQtyIfPreAccept(
  tx: TxClient,
  childRequestId: number,
  extraQty: number,
  actorUserId: number | null,
): Promise<boolean> {
  if (!Number.isFinite(extraQty) || extraQty <= 0) {
    // Nothing to add — not an error (the caller may have computed a 0 shortfall).
    return false;
  }
  const { rows } = await tx.query<{ qty_needed: string }>(
    `UPDATE replenishment_requests
        SET qty_needed = qty_needed + $2
      WHERE id = $1 AND status = 'NEW'
      RETURNING qty_needed`,
    [childRequestId, extraQty],
  );
  const updated = rows[0];
  if (updated === undefined) {
    // Child is no longer NEW (accepted / advanced / terminal) — qty frozen (#9).
    return false;
  }
  await writeAudit(tx, {
    actorUserId,
    action: 'replenishment.qty_top_up',
    entity: 'replenishment_requests',
    entityId: childRequestId,
    payload: { extra_qty: extraQty, new_qty_needed: Number(updated.qty_needed) },
  });
  return true;
}

/**
 * Flip any non-terminal request to CANCELLED. Idempotent on already-cancelled.
 *
 * 0024 — `closureReason` defaults to `'cancelled_by_requester'`. The
 * fulfiller-side cancel (sklad/sex bekor qiladi) uses
 * `cancelRequestByFulfiller`, which sets `'cancelled_by_fulfiller'`.
 * The argument is open (typed as the union) so an internal/system actor
 * can substitute another reason without a second helper.
 */
export async function cancelRequest(
  requestId: number,
  actorUserId: number | null,
  reason: string,
  closureReason: ReplenishmentClosureReason = 'cancelled_by_requester',
): Promise<ReplenishmentRow> {
  // `wasOpen` gates the post-commit cascade/chain: an idempotent re-cancel of an
  // already-terminal row must NOT re-fire them.
  let wasOpen = false;
  const updated = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, requestId);
    if (order.status === 'CANCELLED' || order.status === 'CLOSED') {
      return order;
    }
    wasOpen = true;
    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET status = 'CANCELLED',
             closed_at = now(),
             closure_reason = $2
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [requestId, closureReason],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.internal('Replenishment cancel returned no row.');
    }
    await recordTransition(tx, requestId, order.status, 'CANCELLED', reason, actorUserId);
    await writeAudit(tx, {
      actorUserId,
      action: 'replenishment.cancel',
      entity: 'replenishment_requests',
      entityId: requestId,
      payload: { from: order.status, reason, closure_reason: closureReason },
    });
    // F-D / #10 — cancel cascade: a requester-side cancel of a ROOT also cancels
    // its orphan early-stage children (NEW / CHECK_STORE_SUPPLIER) that no OTHER
    // open root still waits on, in this SAME transaction. Runs only on a
    // requester-side cancel; a fulfiller reject uses cancelRequestByFulfiller.
    if (closureReason === 'cancelled_by_requester') {
      await cancelOrphanChildrenInTx(tx, requestId, actorUserId);
    }
    return row;
  });
  // F-D — when THIS request (as a child) reached terminal, fan out to its waiting
  // roots. Post-commit, best-effort. Skipped on an idempotent re-cancel.
  if (wasOpen) {
    await fireWaiterChain(updated, actorUserId);
  }
  return updated;
}

/**
 * F-D / decision #10 — cancel cascade. When a requester cancels a ROOT request,
 * its EARLY-STAGE orphan children are auto-cancelled in the SAME transaction.
 *
 * "Orphan" = a child whose ONLY open waiter is this root: another open root still
 * waiting on the child (a `request_waiters` row with a DIFFERENT, still-open
 * waiter) spares it. "Early-stage" = `status IN ('NEW','CHECK_STORE_SUPPLIER')`.
 *
 * Why deeper-status children (CHECK_PRODUCTION_INPUT and beyond) are NOT
 * auto-cancelled: by that point the producing отдел may ALREADY have transferred
 * raw/semi inputs into production or started a production order (the engine's
 * CHECK_PRODUCTION_INPUT step moves components + creates the PO). Cancelling
 * there would strand committed stock movements / a running zayafka. Those
 * children are left to finish (or be cancelled by hand by the fulfiller); the
 * surviving child simply loses THIS root as a waiter (the waiter rows for the
 * root are deleted below), so when it later closes it no longer fans out here.
 *
 * Runs INSIDE the caller's (`cancelRequest`) transaction so the root cancel and
 * the child cancels are one all-or-nothing unit. Each cancelled child gets a
 * transition (note 'root cancelled') + an audit row.
 */
async function cancelOrphanChildrenInTx(
  tx: TxClient,
  rootId: number,
  actorUserId: number | null,
): Promise<void> {
  // Lock + read the early-stage children of this root whose only open waiter is
  // the root itself (NO OTHER still-open waiter on the child). `FOR UPDATE`
  // serialises against a concurrent advance trying to move the child forward.
  const { rows: orphans } = await tx.query<{ id: number; status: ReplenishmentStatus }>(
    `SELECT c.id, c.status
       FROM replenishment_requests c
      WHERE c.parent_request_id = $1
        AND c.status IN ('NEW', 'CHECK_STORE_SUPPLIER')
        AND NOT EXISTS (
          SELECT 1 FROM request_waiters w
           JOIN replenishment_requests wr ON wr.id = w.waiter_request_id
          WHERE w.child_request_id = c.id
            AND w.waiter_request_id <> $1
            AND wr.status NOT IN ('CLOSED', 'CANCELLED')
        )
      FOR UPDATE`,
    [rootId],
  );

  for (const child of orphans) {
    const { rows } = await tx.query<{ id: number }>(
      `UPDATE replenishment_requests
          SET status = 'CANCELLED',
              closed_at = now(),
              closure_reason = 'cancelled_by_requester'
        WHERE id = $1 AND status IN ('NEW', 'CHECK_STORE_SUPPLIER')
        RETURNING id`,
      [child.id],
    );
    if (rows[0] === undefined) {
      // A concurrent advance moved it out of an early stage between our locked
      // read and the UPDATE — skip it (it is no longer a safe orphan to cancel).
      continue;
    }
    await recordTransition(tx, child.id, child.status, 'CANCELLED', 'root cancelled', actorUserId);
    await writeAudit(tx, {
      actorUserId,
      action: 'replenishment.cancel_cascade',
      entity: 'replenishment_requests',
      entityId: child.id,
      payload: { root_request_id: rootId, from: child.status, closure_reason: 'cancelled_by_requester' },
    });
  }

  // Surviving children (spared because another open root still waits on them, or
  // because they are past the early stage) simply LOSE this root as a waiter, so
  // when they later close they no longer fan out to this (now cancelled) root.
  await tx.query('DELETE FROM request_waiters WHERE waiter_request_id = $1', [rootId]);
}

/**
 * 0024 — `cancel-by-fulfiller`: the sklad/sex tom oqimi (target side)
 * bekor qiladi to'gri so'rovni — only while the shipment has NOT yet
 * happened (status is still pre-ship). The wait-states + the pre-ship
 * states are accepted; SHIP_TO_REQUESTER is REFUSED (use accept/reject
 * after the shipment instead). This is an INVARIANT_VIOLATION (409).
 */
export async function cancelRequestByFulfiller(
  requestId: number,
  actorUserId: number | null,
  reason: string,
): Promise<ReplenishmentRow> {
  const allowedPreShipStates: readonly ReplenishmentStatus[] = [
    'NEW',
    'CHECK_STORE_SUPPLIER',
    'CHECK_PRODUCTION_INPUT',
    'CREATE_PURCHASE_ORDER',
    'CREATE_PRODUCTION_ORDER',
    'PRODUCING',
    'DONE_TO_WAREHOUSE',
  ];
  let wasOpen = false;
  const updated = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, requestId);
    if (order.status === 'CANCELLED' || order.status === 'CLOSED') {
      return order;
    }
    if (!allowedPreShipStates.includes(order.status)) {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot cancel-by-fulfiller in status ${order.status} — use reject or return after the shipment.`,
      );
    }
    wasOpen = true;
    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET status = 'CANCELLED',
             closed_at = now(),
             closure_reason = 'cancelled_by_fulfiller'
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [requestId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw AppError.internal('Replenishment cancel returned no row.');
    }
    await recordTransition(tx, requestId, order.status, 'CANCELLED', reason, actorUserId);
    await writeAudit(tx, {
      actorUserId,
      action: 'replenishment.cancel_by_fulfiller',
      entity: 'replenishment_requests',
      entityId: requestId,
      payload: { from: order.status, reason },
    });
    return row;
  });
  // F-D — fan out to waiting roots when this (child) request reached terminal.
  // A fulfiller reject does NOT cascade to children (#10 cascade is requester-
  // side only — cancelRequest); it only chains UPWARD to its waiting roots.
  if (wasOpen) {
    await fireWaiterChain(updated, actorUserId);
  }
  return updated;
}

// -----------------------------------------------------------------------------
// 0024 — accept / reject / return (recipient-side closure recording)
// -----------------------------------------------------------------------------

/**
 * Stock invariant — Variant 2 (chosen 2026-05-28):
 *   * `SHIP_TO_REQUESTER -> CLOSED` already moved the full `shipQty` from
 *     `target_location_id` to `requester_location_id` (see
 *     `advanceShipToRequester`).
 *   * accept_full      => no counter-movement (recipient kept everything).
 *   * accept_partial   => counter-move `(qty_needed - qty_accepted)` from
 *                         requester back to target, reason='transfer'.
 *   * reject           => counter-move the full `shipment` qty back.
 *   * return (post-accept) => counter-move `qty_returned` back.
 *
 * Each helper is atomic — the closure_reason flip + the counter-movement
 * + the audit + the transition entry run inside ONE withTransaction.
 *
 * Idempotency: a second call on a request that already has `closure_reason`
 * set returns the row unchanged, so a double-tap from the UI cannot create
 * two counter-movements.
 */

/**
 * Accept the shipment (fully or partially).
 *
 * `qtyAccepted` is bounded by the request's `qty_needed` (or its
 * `shipment` qty when the request was partially shipped — Phase 2). When
 * `qtyAccepted === qty_needed` the closure_reason is `accepted_full`;
 * any value strictly less is `accepted_partial`, and the difference is
 * counter-shipped back to the target_location_id (so the ledger stays
 * net-zero against the original ship).
 */
export async function acceptShipment(opts: {
  requestId: number;
  qtyAccepted: number;
  note?: string | null;
  actorUserId: number | null;
}): Promise<ReplenishmentRow> {
  if (!Number.isFinite(opts.qtyAccepted) || opts.qtyAccepted < 0) {
    throw AppError.validation('qty_accepted must be a number >= 0.');
  }
  let freshlyClosed = false;
  const result = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (order.closure_reason !== null) {
      // Already finalised — second tap is a no-op (idempotent).
      return order;
    }
    freshlyClosed = true;
    if (order.status !== 'CLOSED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot accept a shipment for a request in status ${order.status} — wait for SHIP_TO_REQUESTER to land.`,
      );
    }
    const qtyNeeded = Number(order.qty_needed);
    if (opts.qtyAccepted > qtyNeeded) {
      throw AppError.validation(
        `qty_accepted (${opts.qtyAccepted}) cannot exceed qty_needed (${qtyNeeded}).`,
      );
    }
    if (order.target_location_id === null) {
      throw AppError.internal('Cannot accept — request has no target_location_id.');
    }
    const remainder = qtyNeeded - opts.qtyAccepted;
    const closureReason: ReplenishmentClosureReason =
      remainder === 0 ? 'accepted_full' : 'accepted_partial';

    let qtyReturned: number | null = null;
    if (remainder > 0) {
      // Counter-ship the unaccepted remainder back to the target. The
      // requester's stock was credited by the SHIP step, so this UPDATE
      // succeeds as long as the recipient still holds at least the
      // remainder — which they do unless they have sold it before
      // confirming acceptance (an edge case the operator can resolve via
      // a manual stock adjustment).
      await applyMovement(
        {
          productId: order.product_id,
          fromLocationId: order.requester_location_id,
          toLocationId: order.target_location_id,
          qty: remainder,
          reason: 'transfer',
          actorUserId: opts.actorUserId,
          replenishmentId: order.id,
          note: 'partial accept — remainder returned',
        },
        tx,
      );
      qtyReturned = remainder;
    }

    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET qty_accepted   = $2,
             qty_returned   = $3,
             accept_note    = $4,
             closure_reason = $5
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [opts.requestId, opts.qtyAccepted, qtyReturned, opts.note ?? null, closureReason],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment accept returned no row.');
    }
    await recordTransition(
      tx,
      opts.requestId,
      'CLOSED',
      'CLOSED',
      `accept:${closureReason} qty=${opts.qtyAccepted}`,
      opts.actorUserId,
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.accept',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        closure_reason: closureReason,
        qty_accepted: opts.qtyAccepted,
        qty_returned: qtyReturned,
      },
    });
    return updated;
  });
  // F-D — the request is now fully terminal (closure_reason set); fan out to its
  // waiting roots. Post-commit, best-effort; skipped on the idempotent no-op.
  if (freshlyClosed) {
    await fireWaiterChain(result, opts.actorUserId);
  }
  return result;
}

/**
 * Reject the entire shipment — the recipient refuses it. Counter-ships
 * the full shipped qty back to the target_location_id and stamps
 * `closure_reason='rejected'` + `reject_reason`. Requires the request
 * to be in CLOSED state (i.e. the SHIP step has already run) and not
 * already finalised.
 */
export async function rejectShipment(opts: {
  requestId: number;
  reason: string;
  actorUserId: number | null;
}): Promise<ReplenishmentRow> {
  const reasonClean = opts.reason.trim();
  if (reasonClean === '') {
    throw AppError.validation('reject reason must be a non-empty string.');
  }
  let freshlyClosed = false;
  const result = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (order.closure_reason !== null) {
      return order;
    }
    if (order.status !== 'CLOSED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot reject a shipment for a request in status ${order.status} — wait for SHIP_TO_REQUESTER to land.`,
      );
    }
    freshlyClosed = true;
    if (order.target_location_id === null) {
      throw AppError.internal('Cannot reject — request has no target_location_id.');
    }
    const qtyNeeded = Number(order.qty_needed);
    await applyMovement(
      {
        productId: order.product_id,
        fromLocationId: order.requester_location_id,
        toLocationId: order.target_location_id,
        qty: qtyNeeded,
        reason: 'transfer',
        actorUserId: opts.actorUserId,
        replenishmentId: order.id,
        note: `reject: ${reasonClean}`,
      },
      tx,
    );
    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET qty_accepted   = 0,
             qty_returned   = $2,
             reject_reason  = $3,
             closure_reason = 'rejected'
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [opts.requestId, qtyNeeded, reasonClean],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment reject returned no row.');
    }
    await recordTransition(
      tx,
      opts.requestId,
      'CLOSED',
      'CLOSED',
      `reject:${reasonClean}`,
      opts.actorUserId,
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.reject',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: { closure_reason: 'rejected', reason: reasonClean, qty_returned: qtyNeeded },
    });
    return updated;
  });
  // F-D — fan out to waiting roots (post-commit, best-effort).
  if (freshlyClosed) {
    await fireWaiterChain(result, opts.actorUserId);
  }
  return result;
}

/**
 * Return-after-accept: the recipient accepted the shipment earlier and
 * now wants to send `qtyReturned` back (e.g. a spoiled box). The request
 * must have been accepted (closure_reason in {accepted_full,
 * accepted_partial}) — a fresh request goes via accept/reject instead.
 *
 * The post-accept return is additive: `qty_accepted` shrinks by
 * `qtyReturned`, `qty_returned` grows. The closure_reason flips to
 * `'returned'` only when the cumulative qty_accepted reaches zero;
 * otherwise it stays at `accepted_partial` (a partial return on top of
 * a partial accept).
 */
export async function returnShipment(opts: {
  requestId: number;
  qtyReturned: number;
  reason: string;
  actorUserId: number | null;
}): Promise<ReplenishmentRow> {
  if (!Number.isFinite(opts.qtyReturned) || opts.qtyReturned <= 0) {
    throw AppError.validation('qty_returned must be a number greater than zero.');
  }
  const reasonClean = opts.reason.trim();
  if (reasonClean === '') {
    throw AppError.validation('return reason must be a non-empty string.');
  }
  const result = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (order.status !== 'CLOSED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot return a shipment for a request in status ${order.status}.`,
      );
    }
    if (
      order.closure_reason !== 'accepted_full' &&
      order.closure_reason !== 'accepted_partial'
    ) {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot return — request was not accepted (closure_reason=${order.closure_reason}).`,
      );
    }
    if (order.target_location_id === null) {
      throw AppError.internal('Cannot return — request has no target_location_id.');
    }
    const currentAccepted = Number(order.qty_accepted ?? 0);
    if (opts.qtyReturned > currentAccepted) {
      throw AppError.validation(
        `qty_returned (${opts.qtyReturned}) cannot exceed currently-accepted qty (${currentAccepted}).`,
      );
    }
    await applyMovement(
      {
        productId: order.product_id,
        fromLocationId: order.requester_location_id,
        toLocationId: order.target_location_id,
        qty: opts.qtyReturned,
        reason: 'transfer',
        actorUserId: opts.actorUserId,
        replenishmentId: order.id,
        note: `return: ${reasonClean}`,
      },
      tx,
    );
    const newAccepted = currentAccepted - opts.qtyReturned;
    const previousReturned = Number(order.qty_returned ?? 0);
    const totalReturned = previousReturned + opts.qtyReturned;
    const newClosure: ReplenishmentClosureReason =
      newAccepted === 0 ? 'returned' : 'accepted_partial';

    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET qty_accepted   = $2,
             qty_returned   = $3,
             reject_reason  = COALESCE(reject_reason, $4),
             closure_reason = $5
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [opts.requestId, newAccepted, totalReturned, reasonClean, newClosure],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment return returned no row.');
    }
    await recordTransition(
      tx,
      opts.requestId,
      'CLOSED',
      'CLOSED',
      `return:${reasonClean} qty=${opts.qtyReturned}`,
      opts.actorUserId,
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.return',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        closure_reason: newClosure,
        qty_returned: opts.qtyReturned,
        cumulative_qty_returned: totalReturned,
        remaining_qty_accepted: newAccepted,
      },
    });
    return updated;
  });
  // F-D — the request is terminal (CLOSED) and its closure_reason may have moved
  // to 'returned'; re-notify any waiting roots of the updated outcome (post-
  // commit, best-effort). The advance is idempotent.
  await fireWaiterChain(result, opts.actorUserId);
  return result;
}

/**
 * 0045 — Receive a shipment with an optional `brak` (defect) split.
 *
 * Model (consistent with the existing accept flow — Variant 2):
 *   `SHIP_TO_REQUESTER -> CLOSED` already credited the FULL shipped qty into
 *   the requester store's stock and set status=CLOSED. `receiveShipment` is the
 *   physical-receipt confirmation the requester operator performs:
 *
 *     * `received_qty`  — the GOOD qty the store keeps as sellable stock. It is
 *                          already in the store's stock (the SHIP step put it
 *                          there), so no movement is applied for it.
 *     * `brak_qty`      — the DEFECTIVE qty. It must NOT remain in sellable
 *                          stock, so it is counter-shipped back to the
 *                          target_location_id (reason='transfer') and recorded
 *                          in `brak_qty` / `brak_reason`.
 *     * any remainder   — `shipped - received_qty - brak_qty` (e.g. a short
 *                          delivery) is ALSO counter-shipped back to target so
 *                          the store ends up holding exactly `received_qty`.
 *
 * The shipped qty is `qty_needed` (single-ship MVP). `received_qty + brak_qty`
 * may not exceed it. The closure_reason is `accepted_full` when the store keeps
 * the whole shipment with zero brak, else `accepted_partial`.
 *
 * Idempotent: a second call on a request that already has `closure_reason`
 * set returns the row unchanged — a double-tap cannot double-move stock.
 */
export async function receiveShipment(opts: {
  requestId: number;
  receivedQty: number;
  brakQty?: number;
  brakReason?: string | null;
  actorUserId: number | null;
}): Promise<ReplenishmentRow> {
  const brakQty = opts.brakQty ?? 0;
  if (!Number.isFinite(opts.receivedQty) || opts.receivedQty < 0) {
    throw AppError.validation('received_qty must be a number >= 0.');
  }
  if (!Number.isFinite(brakQty) || brakQty < 0) {
    throw AppError.validation('brak_qty must be a number >= 0.');
  }
  const brakReasonClean =
    typeof opts.brakReason === 'string' && opts.brakReason.trim() !== ''
      ? opts.brakReason.trim()
      : null;
  if (brakQty > 0 && brakReasonClean === null) {
    throw AppError.validation('brak_reason is required when brak_qty > 0.');
  }
  let freshlyClosed = false;
  const result = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (order.closure_reason !== null) {
      // Already finalised — second tap is a no-op (idempotent).
      return order;
    }
    if (order.status !== 'CLOSED') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot receive a shipment for a request in status ${order.status} — wait for SHIP_TO_REQUESTER to land.`,
      );
    }
    freshlyClosed = true;
    if (order.target_location_id === null) {
      throw AppError.internal('Cannot receive — request has no target_location_id.');
    }
    const shippedQty = Number(order.qty_needed);
    if (opts.receivedQty + brakQty > shippedQty) {
      throw AppError.validation(
        `received_qty (${opts.receivedQty}) + brak_qty (${brakQty}) cannot exceed shipped qty (${shippedQty}).`,
      );
    }
    // Everything the store does NOT keep as good stock is counter-shipped back
    // to the target: the brak AND any un-received remainder. The store's stock
    // (credited in full by the SHIP step) thereby settles to exactly
    // `received_qty`.
    const returnToTarget = shippedQty - opts.receivedQty;
    if (returnToTarget > 0) {
      await applyMovement(
        {
          productId: order.product_id,
          fromLocationId: order.requester_location_id,
          toLocationId: order.target_location_id,
          qty: returnToTarget,
          reason: 'transfer',
          actorUserId: opts.actorUserId,
          replenishmentId: order.id,
          note:
            brakQty > 0
              ? `receive: brak ${brakQty} (${brakReasonClean}); remainder ${returnToTarget - brakQty}`
              : 'receive: un-received remainder',
        },
        tx,
      );
    }
    const closureReason: ReplenishmentClosureReason =
      returnToTarget === 0 ? 'accepted_full' : 'accepted_partial';

    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET qty_accepted   = $2,
             qty_returned   = $3,
             brak_qty       = $4,
             brak_reason    = $5,
             closure_reason = $6
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [
        opts.requestId,
        opts.receivedQty,
        returnToTarget > 0 ? returnToTarget : null,
        brakQty,
        brakReasonClean,
        closureReason,
      ],
    );
    const updated = rows[0];
    if (updated === undefined) {
      throw AppError.internal('Replenishment receive returned no row.');
    }
    await recordTransition(
      tx,
      opts.requestId,
      'CLOSED',
      'CLOSED',
      `receive:${closureReason} received=${opts.receivedQty} brak=${brakQty}`,
      opts.actorUserId,
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.receive',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        closure_reason: closureReason,
        received_qty: opts.receivedQty,
        brak_qty: brakQty,
        brak_reason: brakReasonClean,
        returned_to_target: returnToTarget,
      },
    });
    return updated;
  });
  // F-D — fan out to waiting roots (post-commit, best-effort; skip the no-op).
  if (freshlyClosed) {
    await fireWaiterChain(result, opts.actorUserId);
  }
  return result;
}

// -----------------------------------------------------------------------------
// advance() — the heart of the state machine (SM-2..SM-6)
// -----------------------------------------------------------------------------

/**
 * Advance one replenishment request by one step.
 *
 * The whole step (lock, guard check, document creation, stock movement,
 * status flip, transition row, audit row) runs inside ONE `withTransaction`,
 * which keeps the request consistent under concurrent calls (cron worker +
 * a user button) — `SELECT ... FOR UPDATE` serializes them (SM-6).
 *
 * Returns `{ advanced: false }` for:
 *   - terminal states (SM-5), and
 *   - wait states whose external guard has not yet fired (SM-4).
 *
 * Pass `tx` when an outer transaction is open (e.g. `finishProductionOrder`
 * commits the order flip and the request advance together — AC5.3, AC6.3);
 * the inner step then re-uses the outer tx instead of opening a nested one.
 *
 * Skip-state chaining (SM-7): when a single hop leaves the request in a
 * state whose next guard is also satisfied (e.g. `CREATE_PRODUCTION_ORDER`
 * after a `new -> done` jump on the production order), the engine chains
 * forward inside the same transaction. Each chained hop appends its own
 * `replenishment_transitions` row.
 */
export async function advance(
  requestId: number,
  actorUserId: number | null,
  tx?: TxClient,
): Promise<AdvanceResult> {
  const run = async (client: TxClient): Promise<AdvanceResult> => {
    const initial = await lockRequest(client, requestId);

    // SM-5: terminal states never advance.
    if (TERMINAL_STATUSES.includes(initial.status)) {
      return { advanced: false, request: initial, reason: 'terminal' };
    }

    let result = await advanceOne(client, initial, actorUserId);

    // SM-7 — chain forward inside the SAME transaction while the new state
    // is chain-eligible and the next guard is satisfied. The loop is bounded
    // by the forward state graph (CREATE_PRODUCTION_ORDER -> PRODUCING ->
    // DONE_TO_WAREHOUSE) so it terminates quickly; the safety counter is a
    // belt-and-braces against an unexpected cycle.
    let safety = 5;
    while (
      result.advanced &&
      !TERMINAL_STATUSES.includes(result.request.status) &&
      CHAINABLE_AFTER[result.request.status] &&
      safety > 0
    ) {
      safety -= 1;
      const next = await advanceOne(client, result.request, actorUserId);
      if (!next.advanced) {
        break;
      }
      result = next;
    }
    return result;
  };

  // When the caller passes its OWN `tx`, it owns the post-commit lifecycle (and
  // must fire the waiter chain itself, after ITS transaction commits) — firing
  // here would run mid-transaction, not post-commit. So the F-D chain hook is
  // attached ONLY to the own-transaction branch.
  if (tx !== undefined) {
    return run(tx);
  }
  const result = await withTransaction(run);
  // F-D — if this advance closed the request (the SHIP_TO_REQUESTER -> CLOSED
  // internal close), fan out to its waiting roots. Post-commit, best-effort; the
  // chain itself re-advances each root once (idempotent), recursing UP the tree.
  await fireWaiterChain(result.request, actorUserId);
  return result;
}

/** Dispatch one step against the current status. */
async function advanceOne(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  switch (request.status) {
    case 'NEW':
      return advanceNew(tx, request, actorUserId);
    case 'CHECK_STORE_SUPPLIER':
      return advanceCheckStoreSupplier(tx, request, actorUserId);
    case 'SHIP_TO_REQUESTER':
      return advanceShipToRequester(tx, request, actorUserId);
    case 'CHECK_PRODUCTION_INPUT':
      return advanceCheckProductionInput(tx, request, actorUserId);
    case 'CREATE_PURCHASE_ORDER':
      return advanceWaitingForPurchase(tx, request, actorUserId);
    case 'CREATE_PRODUCTION_ORDER':
      return advanceCreateProductionOrder(tx, request, actorUserId);
    case 'PRODUCING':
      return advanceWaitingForProduction(tx, request, actorUserId);
    case 'DONE_TO_WAREHOUSE':
      return advanceDoneToWarehouse(tx, request, actorUserId);
    default:
      return { advanced: false, request, reason: 'unknown' };
  }
}

// -----------------------------------------------------------------------------
// Per-state advance handlers
// -----------------------------------------------------------------------------

/**
 * NEW -> CHECK_STORE_SUPPLIER. Guard: the chain rooted at the requester
 * contains a `type='central_warehouse'` location — that one becomes the
 * `target_location_id` (ADR-0001 §9). `parent_id` is NOT used directly:
 * with multi-hop chains (store -> supply -> central) the immediate parent
 * may not be the warehouse, but the SHIP_TO_REQUESTER step always pulls
 * from the central warehouse.
 */
async function advanceNew(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  const topology = await resolveTopology(tx, request.requester_location_id);
  if (topology.centralWarehouseLocationId === null) {
    return { advanced: false, request, reason: 'no central_warehouse in chain' };
  }
  const next = await transitionStatus(
    tx,
    request,
    'CHECK_STORE_SUPPLIER',
    'central warehouse resolved',
    actorUserId,
    { targetLocationId: topology.centralWarehouseLocationId },
  );
  // C1 (Sprint 3 audit) — spec §7 says `replenishment_created` is delivered
  // to BOTH the requester manager (already done at createRequest time, when
  // the target was not yet known) AND the target location manager. The
  // target is filled in by `advanceNew`, so this is the one place where the
  // target manager can be addressed. Dedupe key keeps re-runs idempotent.
  await notifyReplenishmentTargetSet(tx, next, actorUserId);
  return { advanced: true, request: next, reason: 'central warehouse resolved' };
}

/**
 * CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER (enough at target) OR
 *                        CHECK_PRODUCTION_INPUT (not enough).
 * Guard reads `target.stock.qty >= qty_needed` (spec section 3.3).
 */
async function advanceCheckStoreSupplier(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.target_location_id === null) {
    return { advanced: false, request, reason: 'target_location_id is null' };
  }
  const qtyNeeded = Number(request.qty_needed);
  const targetQty = await readStockQty(tx, request.target_location_id, request.product_id);
  if (targetQty >= qtyNeeded) {
    const next = await transitionStatus(
      tx,
      request,
      'SHIP_TO_REQUESTER',
      `target has ${targetQty} >= needed ${qtyNeeded}`,
      actorUserId,
    );
    return { advanced: true, request: next, reason: 'enough at target' };
  }
  // F-G — a `raw_warehouse` target has NO production below it (it IS the root of
  // the supply chain). The shortfall is covered by the raw manager's Поставка in
  // Poster, which `posterStockSync` lands LATER. So instead of cascading into
  // CHECK_PRODUCTION_INPUT (which would try to make the product — wrong for raw),
  // we HOLD here: stay at CHECK_STORE_SUPPLIER and return a no-op. The cron re-
  // runs every cycle; once the synced qty covers `qty_needed` the branch above
  // ships exactly like today (SHIP_TO_REQUESTER -> CLOSED).
  const targetType = await readLocationType(tx, request.target_location_id);
  if (targetType === 'raw_warehouse') {
    return { advanced: false, request, reason: 'waiting for Poster supply (postavka)' };
  }
  const next = await transitionStatus(
    tx,
    request,
    'CHECK_PRODUCTION_INPUT',
    `target has ${targetQty} < needed ${qtyNeeded}`,
    actorUserId,
  );
  return { advanced: true, request: next, reason: 'not enough at target' };
}

/**
 * CHECK_PRODUCTION_INPUT -> CREATE_PRODUCTION_ORDER (BOM raw is sufficient)
 *                        OR CREATE_PURCHASE_ORDER (a raw is short).
 *
 * The "production location" and "raw warehouse" are resolved from the
 * seeded topology: production = first ancestor of the requester whose
 * `type='production'`; raw warehouse = parent of that production location.
 * If they cannot be resolved the request is held (returns `advanced:false`).
 */
async function advanceCheckProductionInput(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  const topology = await resolveTopology(tx, request.requester_location_id);

  // 0054 / 0055 — prefer the product's explicit workshop link
  // (`products.workshop_location_id`, seeded from the matched Poster dish's
  // Цех) as the production target sex. Fall back to the topology-resolved
  // production location only when the product has no workshop link. This is
  // what makes a manually-routed store request (POST /:id/to-production) land
  // at the CORRECT workshop even though the store chain itself may resolve a
  // different / no production ancestor.
  const workshopLocationId = await resolveWorkshopLocationId(tx, request.product_id);
  const productionLocationId = workshopLocationId ?? topology.productionLocationId;

  if (productionLocationId === null) {
    return { advanced: false, request, reason: 'no production location resolved (workshop/chain)' };
  }
  if (topology.rawWarehouseLocationId === null) {
    return { advanced: false, request, reason: 'no raw warehouse in chain' };
  }

  // What does the BOM call for, given this request's qty?
  //
  // ADR-0016 / R3 — read ONLY the FINAL (decoration) lines for a finished
  // product whose recipe has been split into base/decoration. The base
  // (hamir) is produced separately as a zagatovka sub-order and arrives in
  // sex_storage as the `semi` component (consumed via the check-first loop
  // below). Reading base here too would transfer the hamir components twice.
  // A legacy flat recipe (all-base, no decoration) returns every line, so the
  // old single-pass behaviour is unchanged.
  const bom = await readFinalBom(tx, request.product_id);
  if (bom.length === 0) {
    // No recipe -> we cannot produce, so the only path is purchase the
    // finished product itself. Spec section 3 assumes recipes exist; we
    // hold the request rather than guess.
    return { advanced: false, request, reason: 'product has no BOM' };
  }
  const qtyNeeded = Number(request.qty_needed);

  // ADR-0015 / sub-task #4 — "sex storage check-first":
  // For every BOM component, BEFORE we hit the raw warehouse we first
  // look in the production sex's own sex_storage (the buffer of half-
  // finished goods that lives next to the sex floor). Whatever sits
  // there is consumed first; only the SHORTFALL is sourced from the
  // raw warehouse. This matches how bakers actually work — krem / hamr
  // produced earlier and parked in the sex skladi is used before fresh
  // raw is touched.
  //
  // Per-line accounting (sex_storage take + raw_warehouse need):
  //   sexTake = min(sexHave, need)          -- always >= 0
  //   rawNeed = need - sexTake              -- 0 if sex covered it all
  // The shortage list is now built from `rawNeed > rawHave`.
  type PerLine = {
    componentId: number;
    need: number;
    sexTake: number;
    rawNeed: number;
    rawHave: number;
  };
  const perLine: PerLine[] = [];
  for (const line of bom) {
    const need = Number(line.qty_per_unit) * qtyNeeded;
    const sexHave =
      topology.sexStorageLocationId !== null
        ? await readStockQty(tx, topology.sexStorageLocationId, line.component_product_id)
        : 0;
    const sexTake = Math.min(sexHave, need);
    const rawNeed = need - sexTake;
    const rawHave =
      rawNeed > 0
        ? await readStockQty(tx, topology.rawWarehouseLocationId, line.component_product_id)
        : 0;
    perLine.push({
      componentId: line.component_product_id,
      need,
      sexTake,
      rawNeed,
      rawHave,
    });
  }
  const shortages = perLine
    .filter((l) => l.rawNeed > l.rawHave)
    .map((l) => ({ componentId: l.componentId, need: l.rawNeed, have: l.rawHave }));

  if (shortages.length === 0) {
    // ADR-0001 §7 — every BOM component is transferred INTO the production
    // location BEFORE the production order is created. Without this step
    // the later `finishProductionOrder` flow would find an empty production
    // location and fail with INSUFFICIENT_STOCK. All transfers + PO insert
    // run inside the SAME transaction; one transfer failure rolls every
    // earlier transfer back.
    // ADR-0015 — when the sex_storage covered some / all of the need, we
    // first move FROM sex_storage TO production (reason='transfer'),
    // then move the remainder FROM raw_warehouse TO production.
    // ADR-0001 §9 — production output always lands in the central warehouse,
    // which is the request's `target_location_id` (filled at NEW).
    const targetLocationId =
      request.target_location_id ?? topology.centralWarehouseLocationId;
    for (const line of perLine) {
      if (line.sexTake > 0 && topology.sexStorageLocationId !== null) {
        await applyMovement(
          {
            productId: line.componentId,
            fromLocationId: topology.sexStorageLocationId,
            toLocationId: productionLocationId,
            qty: line.sexTake,
            reason: 'transfer',
            actorUserId,
            replenishmentId: request.id,
            note: 'sex_storage first',
          },
          tx,
        );
      }
      if (line.rawNeed > 0) {
        await applyMovement(
          {
            productId: line.componentId,
            fromLocationId: topology.rawWarehouseLocationId,
            toLocationId: productionLocationId,
            qty: line.rawNeed,
            reason: 'transfer',
            actorUserId,
            replenishmentId: request.id,
          },
          tx,
        );
      }
    }
    const productionOrderId = await createProductionOrderRow(tx, {
      productId: request.product_id,
      qty: qtyNeeded,
      locationId: productionLocationId,
      targetLocationId,
      replenishmentId: request.id,
      actorUserId,
    });
    const reasonText =
      request.status === 'CREATE_PURCHASE_ORDER'
        ? 'create_purchase -> recheck production input -> raw sufficient'
        : 'raw inputs sufficient';
    const next = await transitionStatus(
      tx,
      request,
      'CREATE_PRODUCTION_ORDER',
      reasonText,
      actorUserId,
      { productionOrderId },
    );
    return { advanced: true, request: next, reason: 'raw sufficient -> production order' };
  }

  // One or more raws short. Create ONE purchase order for the FIRST shortage
  // (spec section 3.3 — purchase order created for missing component). When
  // multiple components are short, repeated `advance()` calls after each
  // purchase_received will create the next one if still short.
  // F2.3 (Phase-2) — the M:N `replenishment_purchase_orders` table is the
  // permanent home for every PO ever attached to this request, so the
  // earlier "unlink the previous PO before creating the next" step is no
  // longer necessary: `createPurchaseOrderRow` appends to the M:N table,
  // `transitionStatus` overwrites the deprecated single-FK column with the
  // latest PO id, and the full history stays queryable via the join table.
  const firstShortage = shortages[0];
  if (firstShortage === undefined) {
    throw AppError.internal('shortages array unexpectedly empty.');
  }
  const purchaseOrderId = await createPurchaseOrderRow(tx, {
    productId: firstShortage.componentId,
    qty: firstShortage.need - firstShortage.have, // purchase exactly the shortfall
    targetLocationId: topology.rawWarehouseLocationId,
    replenishmentId: request.id,
    actorUserId,
  });
  const next = await transitionStatus(
    tx,
    request,
    'CREATE_PURCHASE_ORDER',
    `raw component ${firstShortage.componentId} short`,
    actorUserId,
    { purchaseOrderId },
  );
  return { advanced: true, request: next, reason: 'raw short -> purchase order' };
}

/**
 * CREATE_PURCHASE_ORDER is a WAIT state (SM-4). It advances to
 * CREATE_PRODUCTION_ORDER only when the linked purchase order is `received`.
 * If still pending, returns `{ advanced: false }` — no error.
 */
async function advanceWaitingForPurchase(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.purchase_order_id === null) {
    return { advanced: false, request, reason: 'no linked purchase order' };
  }
  const { rows } = await tx.query<{ status: string }>(
    'SELECT status FROM purchase_orders WHERE id = $1',
    [request.purchase_order_id],
  );
  const poStatus = rows[0]?.status;
  if (poStatus !== 'received') {
    return { advanced: false, request, reason: `purchase order still ${poStatus ?? 'missing'}` };
  }
  // Raw is now in the warehouse — re-run the production-input check, which
  // will (usually) now succeed and create the production order. The next
  // transition logged is CREATE_PURCHASE_ORDER -> CREATE_PRODUCTION_ORDER
  // (or back to CREATE_PURCHASE_ORDER if another component is still short).
  // The reason text in the transition row will already be carried by the
  // inner `transitionStatus` call; this comment merely flags the from-state.
  return advanceCheckProductionInput(tx, request, actorUserId);
}

/**
 * CREATE_PRODUCTION_ORDER -> PRODUCING when the linked production order has
 * been flipped to `in_progress` (the production manager started it).
 */
async function advanceCreateProductionOrder(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.production_order_id === null) {
    return { advanced: false, request, reason: 'no linked production order' };
  }
  const { rows } = await tx.query<{ status: string }>(
    'SELECT status FROM production_orders WHERE id = $1',
    [request.production_order_id],
  );
  const poStatus = rows[0]?.status;
  if (poStatus === 'in_progress' || poStatus === 'done') {
    const next = await transitionStatus(
      tx,
      request,
      'PRODUCING',
      `production order is ${poStatus}`,
      actorUserId,
    );
    return { advanced: true, request: next, reason: 'production started' };
  }
  return { advanced: false, request, reason: `production order is ${poStatus ?? 'missing'}` };
}

/**
 * PRODUCING is a WAIT state. Advances to DONE_TO_WAREHOUSE only when the
 * linked production order is `done` — by that point the production_order
 * service already moved BOM out and finished goods INTO the target location.
 */
async function advanceWaitingForProduction(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.production_order_id === null) {
    return { advanced: false, request, reason: 'no linked production order' };
  }
  const { rows } = await tx.query<{ status: string }>(
    'SELECT status FROM production_orders WHERE id = $1',
    [request.production_order_id],
  );
  const poStatus = rows[0]?.status;
  if (poStatus === 'done') {
    const next = await transitionStatus(
      tx,
      request,
      'DONE_TO_WAREHOUSE',
      'production complete',
      actorUserId,
    );
    return { advanced: true, request: next, reason: 'production done' };
  }
  return { advanced: false, request, reason: `production order is ${poStatus ?? 'missing'}` };
}

/**
 * DONE_TO_WAREHOUSE -> SHIP_TO_REQUESTER (the goods are now at target).
 *
 * 0055 — MANUAL gate: a STORE request that the central warehouse manager
 * explicitly routed to production (`route_to_production_manual = TRUE`) must
 * STOP here and WAIT. It only moves forward once the manager has explicitly
 * confirmed receipt at the central warehouse (`received_from_production_at`
 * set by `receiveFromProduction`). Until then this is a no-op wait state, so
 * neither the generic `advance()` / `POST /:id/advance` nor any chaining can
 * auto-ship the produced goods to the store. Direct-ship and internal
 * auto-replenishment requests (flag FALSE) keep flowing through unchanged.
 */
async function advanceDoneToWarehouse(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.route_to_production_manual && request.received_from_production_at === null) {
    return {
      advanced: false,
      request,
      reason: 'awaiting manual receive at central (receive-from-production)',
    };
  }
  const next = await transitionStatus(
    tx,
    request,
    'SHIP_TO_REQUESTER',
    'output landed in warehouse',
    actorUserId,
  );
  return { advanced: true, request: next, reason: 'ready to ship' };
}

/**
 * SHIP_TO_REQUESTER -> CLOSED. Atomic transfer of
 * `min(qty_needed, target.qty)` from `target_location_id` to
 * `requester_location_id`. The request is then closed.
 */
async function advanceShipToRequester(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<AdvanceResult> {
  if (request.target_location_id === null) {
    return { advanced: false, request, reason: 'no target location' };
  }
  const qtyNeeded = Number(request.qty_needed);
  const targetQty = await readStockQty(tx, request.target_location_id, request.product_id);
  if (targetQty <= 0) {
    return { advanced: false, request, reason: 'target has no stock to ship' };
  }
  const shipQty = Math.min(qtyNeeded, targetQty);

  const { movementId } = await applyMovement(
    {
      productId: request.product_id,
      fromLocationId: request.target_location_id,
      toLocationId: request.requester_location_id,
      qty: shipQty,
      reason: 'transfer',
      actorUserId,
      replenishmentId: request.id,
    },
    tx,
  );

  const { rows } = await tx.query<ReplenishmentRow>(
    `UPDATE replenishment_requests
     SET status = 'CLOSED', shipment_movement_id = $2, closed_at = now()
     WHERE id = $1
     RETURNING ${REPLENISHMENT_COLUMNS}`,
    [request.id, movementId],
  );
  const updated = rows[0];
  if (updated === undefined) {
    throw AppError.internal('Replenishment close returned no row.');
  }
  await recordTransition(
    tx,
    request.id,
    'SHIP_TO_REQUESTER',
    'CLOSED',
    `shipped ${shipQty}`,
    actorUserId,
  );
  await writeAudit(tx, {
    actorUserId,
    action: 'replenishment.closed',
    entity: 'replenishment_requests',
    entityId: request.id,
    payload: { shipped_qty: shipQty, movement_id: movementId },
  });
  // M9 — shipment_created notification (spec §7). The shipment IS the
  // CLOSED transition, so this is the moment the requester location's
  // manager needs to know "your goods have left the warehouse". Best-effort
  // — a notification failure must not block the transfer.
  await notifyShipmentCreated(tx, request, shipQty, movementId);
  return { advanced: true, request: updated, reason: 'shipped' };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/** SELECT ... FOR UPDATE on the request — serializes concurrent advances. */
async function lockRequest(tx: TxClient, requestId: number): Promise<ReplenishmentRow> {
  const { rows } = await tx.query<ReplenishmentRow>(
    `SELECT ${REPLENISHMENT_COLUMNS} FROM replenishment_requests WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  const row = rows[0];
  if (row === undefined) {
    throw AppError.notFound('Replenishment request not found.');
  }
  return row;
}

async function readStockQty(
  tx: TxClient,
  locationId: number,
  productId: number,
): Promise<number> {
  const { rows } = await tx.query<{ qty: number }>(
    'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2',
    [locationId, productId],
  );
  const raw = rows[0]?.qty;
  return raw === undefined ? 0 : Number(raw);
}

/**
 * Apply a status flip + optional linked-document updates + the audit/transition
 * pair, then re-read the row. SM-2 is enforced here: the target status MUST
 * be reachable from the current one — else INVALID_TRANSITION.
 */
async function transitionStatus(
  tx: TxClient,
  request: ReplenishmentRow,
  to: ReplenishmentStatus,
  reason: string,
  actorUserId: number | null,
  links: {
    targetLocationId?: number;
    productionOrderId?: number;
    purchaseOrderId?: number;
  } = {},
): Promise<ReplenishmentRow> {
  if (!canTransition(request.status, to)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `Cannot transition replenishment ${request.id} from ${request.status} to ${to}.`,
    );
  }
  // SM-2 — DB-level guard. The expected-status `WHERE` clause makes the row
  // refuse the flip if another transaction has already moved it. Combined
  // with `lockRequest`'s `FOR UPDATE` this is belt-and-braces against
  // concurrent advances; without the application lock it is the sole guard.
  const sets: string[] = ['status = $3'];
  const params: (string | number | null)[] = [request.id, request.status, to];
  if (links.targetLocationId !== undefined) {
    params.push(links.targetLocationId);
    sets.push(`target_location_id = $${params.length}`);
  }
  if (links.productionOrderId !== undefined) {
    params.push(links.productionOrderId);
    sets.push(`production_order_id = $${params.length}`);
  }
  if (links.purchaseOrderId !== undefined) {
    params.push(links.purchaseOrderId);
    sets.push(`purchase_order_id = $${params.length}`);
  }
  const { rows, rowCount } = await tx.query<ReplenishmentRow>(
    `UPDATE replenishment_requests SET ${sets.join(', ')}
     WHERE id = $1 AND status = $2
     RETURNING ${REPLENISHMENT_COLUMNS}`,
    params,
  );
  if (rowCount === 0) {
    throw new AppError(
      'INVALID_TRANSITION',
      `Replenishment ${request.id} is no longer in ${request.status}; concurrent change blocked the transition.`,
    );
  }
  const updated = rows[0];
  if (updated === undefined) {
    throw AppError.internal('Replenishment status update returned no row.');
  }
  await recordTransition(tx, request.id, request.status, to, reason, actorUserId);
  return updated;
}

/** Append one row to `replenishment_transitions` (SM-1). */
async function recordTransition(
  tx: TxClient,
  replenishmentId: number,
  from: ReplenishmentStatus | null,
  to: ReplenishmentStatus,
  reason: string,
  actorUserId: number | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO replenishment_transitions
       (replenishment_id, from_status, to_status, reason, actor_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [replenishmentId, from, to, reason, actorUserId],
  );
}

/**
 * 0054 / 0055 — resolve the production workshop (sex) that makes a product
 * from its explicit `products.workshop_location_id` link (seeded from the
 * matched Poster dish's Цех). Returns the workshop location id ONLY when the
 * linked location actually exists and is a `production` location; otherwise
 * `null` so the caller falls back to the topology-resolved production location.
 */
async function resolveWorkshopLocationId(
  tx: TxClient,
  productId: number,
): Promise<number | null> {
  const { rows } = await tx.query<{ id: number }>(
    `SELECT l.id
       FROM products p
       JOIN locations l ON l.id = p.workshop_location_id
      WHERE p.id = $1 AND l.type = 'production'::location_type`,
    [productId],
  );
  return rows[0] === undefined ? null : Number(rows[0].id);
}

/**
 * Resolve the chain topology starting at `requesterLocationId` by walking
 * `parent_id` until we hit either a `production` location (and then its
 * parent — the raw warehouse) or run out of parents. Pure SQL recursion via
 * a CTE so it is a single round trip.
 */
async function resolveTopology(
  tx: TxClient,
  requesterLocationId: number,
): Promise<{
  productionLocationId: number | null;
  rawWarehouseLocationId: number | null;
  centralWarehouseLocationId: number | null;
  /**
   * ADR-0015 — the sex_storage row that buffers half-finished goods and
   * ready-batch output between the production sex and the central
   * warehouse. Per migration 0022, every sex_storage's `parent_id`
   * points to the production sex floor that owns it; this field is
   * therefore the CHILD of `productionLocationId`. NULL when the chain
   * has no sex_storage (legacy chains still use raw_warehouse directly).
   */
  sexStorageLocationId: number | null;
}> {
  const { rows } = await tx.query<{ id: number; type: string; depth: number }>(
    `WITH RECURSIVE chain AS (
       SELECT id, type, parent_id, 0 AS depth FROM locations WHERE id = $1
       UNION ALL
       SELECT l.id, l.type, l.parent_id, c.depth + 1
       FROM locations l JOIN chain c ON l.id = c.parent_id
     )
     SELECT id, type, depth FROM chain ORDER BY depth`,
    [requesterLocationId],
  );

  let productionLocationId: number | null = null;
  let rawWarehouseLocationId: number | null = null;
  let centralWarehouseLocationId: number | null = null;
  for (const row of rows) {
    if (centralWarehouseLocationId === null && row.type === 'central_warehouse') {
      centralWarehouseLocationId = row.id;
    }
    if (productionLocationId === null && row.type === 'production') {
      productionLocationId = row.id;
    }
    if (rawWarehouseLocationId === null && row.type === 'raw_warehouse') {
      rawWarehouseLocationId = row.id;
    }
  }

  // ADR-0015 — find the sex_storage CHILD of the production location. The
  // chain walk above goes UPWARD (requester -> raw_warehouse) and never
  // reaches the sex_storage (which is a sibling/child, not an ancestor).
  // We do a single targeted lookup. If the production sex has more than
  // one sex_storage child (rare but allowed by schema), we pick the
  // lowest id deterministically — the operator can rotate to a specific
  // buffer via the manual create endpoint.
  let sexStorageLocationId: number | null = null;
  if (productionLocationId !== null) {
    const { rows: sexRows } = await tx.query<{ id: number }>(
      `SELECT id FROM locations
        WHERE parent_id = $1 AND type = 'sex_storage'::location_type
        ORDER BY id LIMIT 1`,
      [productionLocationId],
    );
    if (sexRows[0] !== undefined) {
      sexStorageLocationId = Number(sexRows[0].id);
    }
  }

  return {
    productionLocationId,
    rawWarehouseLocationId,
    centralWarehouseLocationId,
    sexStorageLocationId,
  };
}

/** Create a `production_orders` row linked back to the request. */
async function createProductionOrderRow(
  tx: TxClient,
  opts: {
    productId: number;
    qty: number;
    locationId: number;
    targetLocationId: number | null;
    replenishmentId: number;
    actorUserId: number | null;
  },
): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO production_orders
       (product_id, qty, location_id, target_location_id, status, replenishment_id, created_by)
     VALUES ($1, $2, $3, $4, 'new', $5, $6)
     RETURNING id`,
    [
      opts.productId,
      opts.qty,
      opts.locationId,
      opts.targetLocationId,
      opts.replenishmentId,
      opts.actorUserId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw AppError.internal('Production order insert returned no row.');
  }
  await writeAudit(tx, {
    actorUserId: opts.actorUserId,
    action: 'production_order.create',
    entity: 'production_orders',
    entityId: id,
    payload: { product_id: opts.productId, qty: opts.qty, replenishment_id: opts.replenishmentId },
  });
  return id;
}

/**
 * Create a `purchase_orders` row in `draft` status linked back to the
 * request. Phase-2 (F2.3) — every PO is ALSO mirrored into the
 * `replenishment_purchase_orders` M:N join table. The legacy
 * `replenishment_requests.purchase_order_id` column keeps tracking the
 * latest PO during the transition (it is deprecated and dropped in
 * Phase-3); the M:N row is the permanent record so a request with several
 * shortages (and therefore several POs) keeps its full history.
 *
 * `ON CONFLICT DO NOTHING` on the M:N insert is a belt-and-braces against
 * the unusual case where this helper is called twice with the same PO id
 * within a single transaction — the PK guards the table either way.
 */
async function createPurchaseOrderRow(
  tx: TxClient,
  opts: {
    productId: number;
    qty: number;
    targetLocationId: number;
    replenishmentId: number;
    actorUserId: number | null;
  },
): Promise<number> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO purchase_orders
       (product_id, qty, target_location_id, status, replenishment_id, created_by)
     VALUES ($1, $2, $3, 'draft', $4, $5)
     RETURNING id`,
    [
      opts.productId,
      opts.qty,
      opts.targetLocationId,
      opts.replenishmentId,
      opts.actorUserId,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw AppError.internal('Purchase order insert returned no row.');
  }
  // F2.3 — dual-write to the M:N join table. The legacy column
  // (`replenishment_requests.purchase_order_id`) is updated by the caller
  // (transitionStatus links.purchaseOrderId); we keep the historical link
  // here so even after the deprecated column is removed (Phase-3) the
  // full PO list per request is reachable.
  await tx.query(
    `INSERT INTO replenishment_purchase_orders (replenishment_id, purchase_order_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [opts.replenishmentId, id],
  );
  await writeAudit(tx, {
    actorUserId: opts.actorUserId,
    action: 'purchase_order.create',
    entity: 'purchase_orders',
    entityId: id,
    payload: { product_id: opts.productId, qty: opts.qty, replenishment_id: opts.replenishmentId },
  });
  return id;
}

// -----------------------------------------------------------------------------
// Store workflow — AI proposals + central accept/reject (2026-06-05)
// -----------------------------------------------------------------------------

/** One AI top-up proposal for a below-min product at a store. */
export type ReplenishmentProposal = {
  product_id: number;
  product_name: string;
  unit: string;
  current_qty: number;
  min_level: number;
  max_level: number;
  /** The AI top-up = max_level - current_qty (always > 0). */
  suggested_qty: number;
};

/**
 * Build the AI auto-request proposals for one store: every below-min product
 * (qty <= min_level, max_level > 0) that does NOT already have an open
 * replenishment request (invariant 2 debounce). `suggested_qty` tops the store
 * back up to `max_level`.
 */
export async function getProposalsForLocation(
  locationId: number,
): Promise<ReplenishmentProposal[]> {
  const { rows } = await query<{
    product_id: number;
    product_name: string;
    unit: string;
    current_qty: string;
    min_level: string;
    max_level: string;
  }>(
    `SELECT s.product_id,
            p.name AS product_name,
            p.unit AS unit,
            s.qty       AS current_qty,
            s.min_level AS min_level,
            s.max_level AS max_level
       FROM stock s
       JOIN products p ON p.id = s.product_id
      WHERE s.location_id = $1
        AND s.qty <= s.min_level
        AND s.max_level > 0
        AND (s.max_level - s.qty) > 0
        -- invariant 2 debounce: skip products with an open request here.
        AND NOT EXISTS (
          SELECT 1 FROM replenishment_requests r
           WHERE r.requester_location_id = s.location_id
             AND r.product_id = s.product_id
             AND r.status NOT IN ('CLOSED', 'CANCELLED')
        )
      ORDER BY (s.min_level - s.qty) DESC, p.name ASC`,
    [locationId],
  );
  return rows.map((r) => {
    const currentQty = Number(r.current_qty);
    const maxLevel = Number(r.max_level);
    return {
      product_id: Number(r.product_id),
      product_name: r.product_name,
      unit: r.unit,
      current_qty: currentQty,
      min_level: Number(r.min_level),
      max_level: maxLevel,
      suggested_qty: maxLevel - currentQty,
    };
  });
}

/**
 * Central-warehouse ACCEPT of an incoming store request.
 *
 * The store requests (status NEW / CHECK_STORE_SUPPLIER) are accepted by the
 * central warehouse manager: we (a) pin the request's `target_location_id` to
 * the acting central warehouse if it is not already set, then (b) drive the
 * engine forward so it ships from the central warehouse to the store
 * (SHIP_TO_REQUESTER -> CLOSED), reusing `advance()` / `applyMovement` — all
 * invariants (atomic, audit, no negative stock) are preserved by the engine.
 *
 * Returns the advanced request plus a flag indicating whether the ship landed.
 *
 * 0055 — MANUAL flow: accept-central ONLY ships when the central warehouse
 * already holds enough stock. If the central is SHORT it HOLDS the request at
 * CHECK_STORE_SUPPLIER and returns `shipped=false` — it no longer cascades
 * into the production/purchase chain. Routing a short request to production is
 * now a DELIBERATE, separate action (`sendToProduction` via POST
 * /:id/to-production), so the manager explicitly decides to make the goods.
 */
export async function acceptByCentral(opts: {
  requestId: number;
  centralLocationId: number;
  actorUserId: number | null;
}): Promise<{ request: ReplenishmentRow; shipped: boolean; reason: string }> {
  // Pin the target + ship (when stock allows) in ONE transaction so the pin and
  // the transfer are atomic.
  const outcome = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (TERMINAL_STATUSES.includes(order.status)) {
      return { request: order, shipped: false, reason: `request already ${order.status}` };
    }

    // Pin / verify the target. If a target is already set it must be the
    // acting central warehouse (the manager can only accept requests bound for
    // their own warehouse — the route enforces this too).
    let current = order;
    if (current.target_location_id === null) {
      const { rows } = await tx.query<ReplenishmentRow>(
        `UPDATE replenishment_requests
            SET target_location_id = $2
          WHERE id = $1
          RETURNING ${REPLENISHMENT_COLUMNS}`,
        [opts.requestId, opts.centralLocationId],
      );
      const pinned = rows[0];
      if (pinned === undefined) {
        throw AppError.internal('Accept-by-central: target pin returned no row.');
      }
      current = pinned;
    } else if (Number(current.target_location_id) !== opts.centralLocationId) {
      throw AppError.forbidden(
        'This request targets a different warehouse; you may only accept requests bound for your own.',
      );
    }

    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.accept_by_central',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        central_location_id: opts.centralLocationId,
        from_status: current.status,
      },
    });

    // 0066 — stamp the acceptance (first accept wins), then re-read so every
    // downstream branch (including an early "held — short stock" return) carries
    // the fresh fulfiller_accepted_* on the row it returns.
    await stampFulfillerAccept(tx, opts.requestId, opts.actorUserId);
    current = await lockRequest(tx, opts.requestId);

    // NEW -> CHECK_STORE_SUPPLIER (target is pinned; bypass the topology-based
    // central resolution in `advanceNew`).
    if (current.status === 'NEW') {
      current = await transitionStatus(
        tx,
        current,
        'CHECK_STORE_SUPPLIER',
        'accepted by central — target pinned',
        opts.actorUserId,
      );
    }

    // Ship ONLY if the central already has stock. If short, HOLD at
    // CHECK_STORE_SUPPLIER — do NOT cascade into production/purchase. The
    // manager decides whether to route to production via POST /:id/to-production.
    if (current.status === 'CHECK_STORE_SUPPLIER') {
      const qtyNeeded = Number(current.qty_needed);
      const targetQty = await readStockQty(tx, opts.centralLocationId, current.product_id);
      if (targetQty < qtyNeeded) {
        return {
          request: current,
          shipped: false,
          reason:
            targetQty <= 0
              ? 'central has no stock — route to production or restock'
              : `central has ${targetQty} < needed ${qtyNeeded} — route to production or restock`,
        };
      }
      const toShip = await transitionStatus(
        tx,
        current,
        'SHIP_TO_REQUESTER',
        `central has ${targetQty} >= needed ${qtyNeeded}`,
        opts.actorUserId,
      );
      const result = await advanceShipToRequester(tx, toShip, opts.actorUserId);
      current = result.request;
    }

    const shipped = current.status === 'CLOSED';
    return {
      request: current,
      shipped,
      reason: shipped ? 'shipped to store' : `held at ${current.status}`,
    };
  });
  // F-D — if the accept closed the request (shipped to the store), fan out to its
  // waiting roots. Post-commit, best-effort.
  await fireWaiterChain(outcome.request, opts.actorUserId);
  return outcome;
}

/**
 * Generic fulfiller ACCEPT — for a NON-central target (sex → its sklad,
 * central → production, ...). A cross-department request's target is the
 * requester's topology parent, which is NOT always a central warehouse.
 * `acceptByCentral` forces the central code path (and would, on a stock-short
 * target, cascade into the central production/purchase chain rooted at the
 * requester — the wrong chain for a sex→sklad ask). This function instead
 * applies the simple, target-type-agnostic semantics the owner expects from
 * any fulfilling manager:
 *
 *   - pin the request's target to the accepting location;
 *   - if that location has stock, ship from it (CHECK_STORE_SUPPLIER ->
 *     SHIP_TO_REQUESTER -> CLOSED), reusing `advanceShipToRequester`
 *     (atomic movement + audit + no negative stock);
 *   - if it does NOT have enough stock, HOLD the request at
 *     CHECK_STORE_SUPPLIER (do not auto-trigger the central production chain).
 *     The manager restocks then re-accepts.
 *
 * The central-warehouse case keeps using `acceptByCentral`, which deliberately
 * cascades into production/purchase when the central is short.
 */
export async function acceptByFulfiller(opts: {
  requestId: number;
  fulfillerLocationId: number;
  actorUserId: number | null;
}): Promise<{ request: ReplenishmentRow; shipped: boolean; reason: string }> {
  const outcome = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (TERMINAL_STATUSES.includes(order.status)) {
      return { request: order, shipped: false, reason: `request already ${order.status}` };
    }

    // Pin / verify the target to the accepting (fulfiller) location.
    let current = order;
    if (current.target_location_id === null) {
      const { rows } = await tx.query<ReplenishmentRow>(
        `UPDATE replenishment_requests
            SET target_location_id = $2
          WHERE id = $1
          RETURNING ${REPLENISHMENT_COLUMNS}`,
        [opts.requestId, opts.fulfillerLocationId],
      );
      const pinned = rows[0];
      if (pinned === undefined) {
        throw AppError.internal('Accept-by-fulfiller: target pin returned no row.');
      }
      current = pinned;
    } else if (Number(current.target_location_id) !== opts.fulfillerLocationId) {
      throw AppError.forbidden(
        'This request targets a different location; you may only accept requests bound for your own.',
      );
    }

    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.accept_by_fulfiller',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        fulfiller_location_id: opts.fulfillerLocationId,
        from_status: current.status,
      },
    });

    // 0066 — stamp the acceptance (first accept wins), then re-read so the row
    // returned on EVERY branch (ship or hold) reflects fulfiller_accepted_*.
    await stampFulfillerAccept(tx, opts.requestId, opts.actorUserId);
    current = await lockRequest(tx, opts.requestId);

    // NEW -> CHECK_STORE_SUPPLIER (target is pinned; bypass the topology-based
    // central resolution in `advanceNew`).
    if (current.status === 'NEW') {
      current = await transitionStatus(
        tx,
        current,
        'CHECK_STORE_SUPPLIER',
        'accepted by fulfiller — target pinned',
        opts.actorUserId,
      );
    }

    // Ship only if the fulfiller has stock. If it does not, HOLD here — do NOT
    // fall through to the central production/purchase chain.
    if (current.status === 'CHECK_STORE_SUPPLIER') {
      const qtyNeeded = Number(current.qty_needed);
      const targetQty = await readStockQty(
        tx,
        opts.fulfillerLocationId,
        current.product_id,
      );
      if (targetQty <= 0) {
        return {
          request: current,
          shipped: false,
          reason: 'fulfiller has no stock to ship — restock then re-accept',
        };
      }
      const toShip = await transitionStatus(
        tx,
        current,
        'SHIP_TO_REQUESTER',
        `fulfiller has ${targetQty} (needed ${qtyNeeded})`,
        opts.actorUserId,
      );
      const result = await advanceShipToRequester(tx, toShip, opts.actorUserId);
      current = result.request;
    }

    const shipped = current.status === 'CLOSED';
    return {
      request: current,
      shipped,
      reason: shipped ? 'shipped to requester' : `held at ${current.status}`,
    };
  });
  // F-D — a producer-override fulfiller accept (e.g. cream → the requesting sex)
  // that closed the request is the COMMON case a waiting root waits on; fan out
  // to its waiting roots. Post-commit, best-effort.
  await fireWaiterChain(outcome.request, opts.actorUserId);
  return outcome;
}

// -----------------------------------------------------------------------------
// F-C / decision #8 — internal accept-gate for buffer (B-cycle) requests
// -----------------------------------------------------------------------------

/** The location type for one location id, or `null` when it does not exist. */
async function readLocationType(tx: TxClient, locationId: number): Promise<string | null> {
  const { rows } = await tx.query<{ type: string }>(
    'SELECT type::text AS type FROM locations WHERE id = $1',
    [locationId],
  );
  return rows[0]?.type ?? null;
}

/**
 * INTERNAL ACCEPT (F-C / #8) — the producing отдел boss accepts a B-cycle buffer
 * refill request (a `sex_storage` requester that fell below min — origin scan/
 * buffer). With the cron gate in place (`runEngineCycle`), such a NEW request
 * just SITS as a "tavsiya karta" until the boss explicitly accepts it; this is
 * that accept.
 *
 * Semantics (mirrors `acceptByFulfiller`'s shape, but it only OPENS the gate —
 * it does NOT ship): lock FOR UPDATE, require `status='NEW'` AND the requester
 * is a `sex_storage`, then drive exactly ONE advance step
 * (NEW -> CHECK_STORE_SUPPLIER) so the request enters the normal internal flow
 * (the cron then carries it forward — production-input check, etc.). The single
 * step is logged with note 'internal accept'.
 *
 * Idempotent: a re-call once the request is already past NEW (someone accepted
 * it first, or the cron advanced it) returns the row unchanged with
 * `accepted=false` and a friendly reason — a double-tap is a harmless no-op.
 */
export async function acceptInternal(opts: {
  requestId: number;
  actorUserId: number | null;
}): Promise<{ request: ReplenishmentRow; accepted: boolean; reason: string }> {
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (TERMINAL_STATUSES.includes(order.status)) {
      return { request: order, accepted: false, reason: `request already ${order.status}` };
    }
    // Idempotent no-op: already advanced past NEW (the gate is already open).
    if (order.status !== 'NEW') {
      return {
        request: order,
        accepted: false,
        reason: `already accepted (status ${order.status})`,
      };
    }
    // Gate scope: ONLY a sex_storage-requester buffer refill is internally
    // accepted here. A non-sex_storage requester is a different flow (store ->
    // central accept, cross-dept producer-override, …) and must not use this.
    const requesterType = await readLocationType(tx, order.requester_location_id);
    if (requesterType !== 'sex_storage') {
      throw new AppError(
        'INVALID_TRANSITION',
        `accept-internal is only for a sex_storage buffer request; requester is '${requesterType ?? 'unknown'}'.`,
      );
    }

    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.accept_internal',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: { from_status: order.status, requester_location_id: order.requester_location_id },
    });

    // 0066 — stamp the acceptance (first accept wins) BEFORE the transition so
    // the `next` row (RETURNING ...) already carries fulfiller_accepted_*.
    await stampFulfillerAccept(tx, opts.requestId, opts.actorUserId);

    // Drive exactly ONE step (NEW -> CHECK_STORE_SUPPLIER). `advanceNew`
    // resolves the upward central target as usual; the note records the gate.
    const next = await transitionStatus(
      tx,
      order,
      'CHECK_STORE_SUPPLIER',
      'internal accept',
      opts.actorUserId,
      ...(await resolveBufferTargetLink(tx, order)),
    );
    return { request: next, accepted: true, reason: 'internal accept — gate opened' };
  });
}

/**
 * Resolve the optional `targetLocationId` link for an internal-accept transition.
 * When the buffer request has no pinned target we resolve the upward central
 * warehouse (the same one `advanceNew` would), so the request enters
 * CHECK_STORE_SUPPLIER already pointing at a real fulfiller. When a target is
 * already pinned we leave it alone (return no link). Returns a single-element
 * tuple suitable for spreading into `transitionStatus`'s variadic `links` arg.
 */
async function resolveBufferTargetLink(
  tx: TxClient,
  order: ReplenishmentRow,
): Promise<[{ targetLocationId: number }] | []> {
  if (order.target_location_id !== null) {
    return [];
  }
  const topology = await resolveTopology(tx, order.requester_location_id);
  if (topology.centralWarehouseLocationId === null) {
    return [];
  }
  return [{ targetLocationId: topology.centralWarehouseLocationId }];
}

/**
 * INTERNAL REJECT (F-C / #8) — the producing отдел boss refuses a B-cycle buffer
 * refill request. Cancels it with `closure_reason='cancelled_by_fulfiller'` and
 * the boss's reason recorded on the transition. Thin wrapper over `cancelRequest`
 * (which is FOR-UPDATE + idempotent on already-terminal), so a double-tap is a
 * harmless no-op.
 */
export async function rejectInternal(opts: {
  requestId: number;
  actorUserId: number | null;
  reason?: string | null;
}): Promise<ReplenishmentRow> {
  const reason =
    typeof opts.reason === 'string' && opts.reason.trim() !== ''
      ? opts.reason.trim()
      : 'internal reject';
  return cancelRequest(opts.requestId, opts.actorUserId, reason, 'cancelled_by_fulfiller');
}

// -----------------------------------------------------------------------------
// F-L / cross-dept-flow — PRODUCTION accept-gate (gate class d)
// -----------------------------------------------------------------------------
// When the central manager routes a store shortfall to production, the request
// is parked at CHECK_PRODUCTION_INPUT with its PRODUCTION assigned to the отдел
// (`COALESCE(po.location_id, p.workshop_location_id)`). Owner's round-2 finding:
// the cron used to auto-run `advanceCheckProductionInput` on the NEXT pass —
// consuming зг, transferring raw, creating the production order / raw POs — WITHOUT
// the отдел manager ever accepting. The required flow: the row WAITS at the отдел
// (Kutuvda) until the отдел manager ACCEPTS; only then does the engine proceed
// (the existing `advanceCheckProductionInput` semantics, driven by the next cron
// pass). The `runEngineCycle` gate (class d) implements the WAIT; this is the
// ACCEPT that unblocks it.

/**
 * Resolve the PRODUCTION location of a request — the SAME source the cron gate
 * and the F-J workshop-visibility joins use: the linked production order's
 * `location_id` when one exists, else the product's `workshop_location_id`. NULL
 * when neither resolves (no production order and the product has no отдел). The
 * route's RBAC reads this so it can require the отдел's operator.
 *
 * tx-scoped so `acceptProduction` resolves it under the same FOR UPDATE lock.
 */
async function resolveProductionLocationIdTx(
  tx: TxClient,
  request: ReplenishmentRow,
): Promise<number | null> {
  if (request.production_order_id !== null) {
    const { rows } = await tx.query<{ location_id: number }>(
      'SELECT location_id FROM production_orders WHERE id = $1',
      [request.production_order_id],
    );
    if (rows[0] !== undefined) {
      return Number(rows[0].location_id);
    }
  }
  // No production order yet — fall back to the product's assigned отдел.
  return resolveWorkshopLocationId(tx, request.product_id);
}

/** Non-tx convenience for the route's RBAC pre-check (own connection). */
export async function resolveProductionLocationId(requestId: number): Promise<{
  request: ReplenishmentRow;
  productionLocationId: number | null;
} | null> {
  return withTransaction(async (tx) => {
    const { rows } = await tx.query<ReplenishmentRow>(
      `SELECT ${REPLENISHMENT_COLUMNS} FROM replenishment_requests WHERE id = $1`,
      [requestId],
    );
    const request = rows[0];
    if (request === undefined) {
      return null;
    }
    const productionLocationId = await resolveProductionLocationIdTx(tx, request);
    return { request, productionLocationId };
  });
}

/**
 * PRODUCTION ACCEPT (F-L / gate class d) — the отдел manager accepts a request
 * that the central manager routed to production and that is now parked at
 * CHECK_PRODUCTION_INPUT. This is a PURE STAMP: it sets `fulfiller_accepted_at/by`
 * (first-accept-wins, via `stampFulfillerAccept`) and changes NO status. The
 * stamp itself is the unblock — the `runEngineCycle` gate (class d) skips a
 * CHECK_PRODUCTION_INPUT row WHILE `fulfiller_accepted_at IS NULL`; once stamped,
 * the very next cron pass runs `advanceCheckProductionInput` exactly as before
 * (зг buffer first, transfers, production order, raw POs as needed). No transition
 * row is written here precisely because there is no status change — the accept is
 * recorded by the audit row + the `fulfiller_accepted_*` stamp the Kanban reads.
 *
 * Guards (FOR UPDATE): `status='CHECK_PRODUCTION_INPUT'` AND a production location
 * resolves (otherwise the gate could never have held it). Idempotent: a re-call on
 * an already-stamped row updates 0 rows and returns `{ accepted:false,
 * reason:'already accepted' }`; a terminal / wrong-status row returns a friendly
 * no-op so a double-tap is harmless. The row is re-read so the response carries the
 * stamp.
 */
export async function acceptProduction(opts: {
  requestId: number;
  actorUserId: number | null;
}): Promise<{ request: ReplenishmentRow; accepted: boolean; reason: string }> {
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (TERMINAL_STATUSES.includes(order.status)) {
      return { request: order, accepted: false, reason: `request already ${order.status}` };
    }
    // Gate scope: only a CHECK_PRODUCTION_INPUT row can be production-accepted
    // (that is the only state the class-d cron gate holds). Any other status is a
    // wrong-status 409 at the route — surfaced here as INVALID_TRANSITION.
    if (order.status !== 'CHECK_PRODUCTION_INPUT') {
      throw new AppError(
        'INVALID_TRANSITION',
        `accept-production is only valid at CHECK_PRODUCTION_INPUT; request is ${order.status}.`,
      );
    }
    const productionLocationId = await resolveProductionLocationIdTx(tx, order);
    if (productionLocationId === null) {
      throw new AppError(
        'INVALID_TRANSITION',
        'accept-production requires a resolvable production location (production order or product workshop).',
      );
    }
    // Idempotent no-op: already accepted (the gate is already open). The re-read
    // below still returns the stamped row so the caller sees who/when.
    if (order.fulfiller_accepted_at !== null) {
      return { request: order, accepted: false, reason: 'already accepted' };
    }

    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.accept_production',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        production_location_id: productionLocationId,
        from_status: order.status,
      },
    });

    // The STAMP is the unblock…
    await stampFulfillerAccept(tx, opts.requestId, opts.actorUserId);
    let updated = await lockRequest(tx, opts.requestId);
    // …and the accept itself DRIVES the first hop. STORE-requester rows are
    // excluded from the cron loop entirely (the F-C central gate), so waiting
    // for "the next pass" would wait forever for the owner's main scenario
    // (store shortfall routed to production). Running the BOM/raw check here —
    // in the SAME transaction as the stamp — also gives the отдел manager
    // instant feedback: qabul → зг tekshiruv → zayafka/xarid darhol.
    const advanced = await advanceCheckProductionInput(tx, updated, opts.actorUserId);
    updated = advanced.request;
    return {
      request: updated,
      accepted: true,
      reason: `production accepted — ${advanced.reason}`,
    };
  });
}

/**
 * PRODUCTION REJECT (F-L / gate class d) — the отдел manager refuses a request
 * routed to production. Cancels it with `closure_reason='cancelled_by_fulfiller'`
 * (the отдел is the fulfilling side), the reason recorded on the transition. Thin
 * wrapper over `cancelRequestByFulfiller` — which is FOR-UPDATE, idempotent on an
 * already-terminal row, and ALREADY fires the post-commit `fireWaiterChain` on
 * every terminal — so a double-tap is a harmless no-op and any waiting roots are
 * notified exactly as on any other fulfiller cancel.
 */
export async function rejectProduction(opts: {
  requestId: number;
  actorUserId: number | null;
  reason?: string | null;
}): Promise<ReplenishmentRow> {
  const reason =
    typeof opts.reason === 'string' && opts.reason.trim() !== ''
      ? opts.reason.trim()
      : 'production reject';
  return cancelRequestByFulfiller(opts.requestId, opts.actorUserId, reason);
}

// -----------------------------------------------------------------------------
// F-D / cross-dept-flow §8 — waiter chaining when a sub-request goes terminal
// -----------------------------------------------------------------------------

/**
 * Fan out from a just-terminal sub-request (`request`) to EVERY open root that
 * was waiting on it, re-advance each once, and tell its requester-location
 * manager the child resolved (`sub_request_closed`).
 *
 * Called POST-COMMIT, best-effort (engine-style try/catch by the CALLER) from
 * every path where a request reaches CLOSED / CANCELLED (receive/accept/reject/
 * return shipment, cancelRequest, cancelRequestByFulfiller, rejectInternal, and
 * the advance() internal close). The child has already committed to its terminal
 * state, so this opens its OWN transactions and never participates in the
 * caller's unit — a failure here must NOT roll the (already-final) close back.
 *
 * Open roots = `parent_request_id` ∪ `request_waiters.waiter_request_id` (the
 * F-B note: a child fans out via BOTH links, not the parent alone), de-duped,
 * each filtered to still-open (a root that already closed is skipped). For each:
 *   - `advance(root)` once (idempotent — the root's own guard decides whether it
 *     actually moves; a wait-state that is still not satisfied is a harmless
 *     no-op);
 *   - one `sub_request_closed` notification to the root's requester-location
 *     manager with {root_request_id, child_request_id, product_id, child_outcome}.
 *
 * `child_outcome` is the child's terminal kind: 'CANCELLED', or for CLOSED the
 * closure_reason when set (accepted_full / rejected / …) else 'closed'.
 */
/**
 * Best-effort, post-commit wrapper around `chainWaitersAfterTerminal`. Fires the
 * waiter chain ONLY when `row` actually reached a terminal state, and swallows
 * every error (engine-style) so a fan-out failure never rolls the (already
 * committed) close back. This is the single hook the public terminal paths call
 * AFTER their `withTransaction` resolves.
 */
async function fireWaiterChain(
  row: ReplenishmentRow,
  actorUserId: number | null,
): Promise<void> {
  if (!TERMINAL_STATUSES.includes(row.status)) {
    return;
  }
  try {
    await chainWaitersAfterTerminal(row, actorUserId);
  } catch (err) {
    console.error(
      `[replenishment-engine] chainWaitersAfterTerminal(${row.id}) failed:`,
      (err as Error).message,
    );
  }
}

export async function chainWaitersAfterTerminal(
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<void> {
  // Collect candidate roots: the immediate parent + every waiter on this child.
  const rootIds = new Set<number>();
  if (request.parent_request_id !== null) {
    rootIds.add(Number(request.parent_request_id));
  }
  const { rows: waiterRows } = await query<{ waiter_request_id: number }>(
    'SELECT waiter_request_id FROM request_waiters WHERE child_request_id = $1',
    [request.id],
  );
  for (const w of waiterRows) {
    rootIds.add(Number(w.waiter_request_id));
  }
  if (rootIds.size === 0) {
    return;
  }

  // The child's terminal outcome label (for the notification payload).
  const childOutcome =
    request.status === 'CANCELLED'
      ? 'CANCELLED'
      : request.closure_reason ?? 'closed';

  for (const rootId of rootIds) {
    // Skip a root that is itself already terminal (nothing to chain into).
    const { rows: rootRows } = await query<{
      status: ReplenishmentStatus;
      requester_location_id: number;
    }>(
      'SELECT status, requester_location_id FROM replenishment_requests WHERE id = $1',
      [rootId],
    );
    const root = rootRows[0];
    if (root === undefined || TERMINAL_STATUSES.includes(root.status)) {
      continue;
    }

    // Re-advance the waiting root once (idempotent; its own guard decides).
    await advance(rootId, actorUserId);

    // Notify the root's requester-location manager that the child resolved.
    await withTransaction(async (tx) => {
      const managerId = await getLocationManager(tx, Number(root.requester_location_id));
      if (managerId === null) return;
      await createNotification(tx, {
        recipientUserId: managerId,
        type: 'sub_request_closed',
        title: `Quyi so'rov yakunlandi #${request.id}`,
        body:
          `So'rov #${rootId} kutgan quyi so'rov #${request.id} ` +
          `yakunlandi (${childOutcome}). Asosiy so'rov davom etadi.`,
        payload: {
          root_request_id: rootId,
          child_request_id: request.id,
          product_id: request.product_id,
          child_outcome: childOutcome,
        },
      });
    });
  }
}

// -----------------------------------------------------------------------------
// 0055 — Manual central -> production flow (store requests)
// -----------------------------------------------------------------------------

/**
 * MANUAL "Ishlab chiqarishga yuborish" — the central warehouse manager
 * explicitly routes a SHORT store request to production.
 *
 * Pins the request's target to the acting central warehouse, marks it as a
 * manual production route (`route_to_production_manual = TRUE` — so it will
 * STOP at DONE_TO_WAREHOUSE and never auto-ship), then runs the existing
 * production-input logic (`advanceCheckProductionInput`): sex_storage-first BOM
 * sourcing, a purchase order on a raw shortage, else the production_order
 * (target = central, workshop resolved via `products.workshop_location_id` →
 * else topology). All of it commits in ONE transaction.
 *
 * Allowed from NEW / CHECK_STORE_SUPPLIER (the pre-fulfilment states) and from
 * CHECK_PRODUCTION_INPUT — re-routing a request that stalled there (e.g. an
 * earlier attempt before the topology was wired) re-runs the BOM/raw check. A
 * request already in production / shipped / terminal is refused.
 */
export async function sendToProduction(opts: {
  requestId: number;
  centralLocationId: number;
  actorUserId: number | null;
}): Promise<{ request: ReplenishmentRow; advanced: boolean; reason: string }> {
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    return sendToProductionTx(tx, order, opts.centralLocationId, opts.actorUserId);
  });
}

/**
 * 0058 — tx-internal core of `sendToProduction`. Routes an already-locked
 * request to production within the CALLER's transaction (so the partial-fulfill
 * flow can ship the available portion AND route the shortfall to production in
 * ONE atomic unit). The public `sendToProduction` is a thin lock + wrapper; the
 * partial-fulfill path calls this directly on a freshly-created shortfall row.
 *
 * `order` MUST already be locked (`lockRequest` / `FOR UPDATE`) by the caller.
 */
async function sendToProductionTx(
  tx: TxClient,
  order: ReplenishmentRow,
  centralLocationId: number,
  actorUserId: number | null,
): Promise<{ request: ReplenishmentRow; advanced: boolean; reason: string }> {
  {
    if (TERMINAL_STATUSES.includes(order.status)) {
      return { request: order, advanced: false, reason: `request already ${order.status}` };
    }
    if (
      order.status !== 'NEW' &&
      order.status !== 'CHECK_STORE_SUPPLIER' &&
      order.status !== 'CHECK_PRODUCTION_INPUT'
    ) {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot route to production from status ${order.status} — only NEW / CHECK_STORE_SUPPLIER / CHECK_PRODUCTION_INPUT are allowed.`,
      );
    }
    const opts = { requestId: order.id, centralLocationId, actorUserId };

    // Pin / verify the target to the acting central warehouse and stamp the
    // manual-route marker in the SAME UPDATE.
    let current = order;
    if (current.target_location_id === null) {
      const { rows } = await tx.query<ReplenishmentRow>(
        `UPDATE replenishment_requests
            SET target_location_id = $2,
                route_to_production_manual = TRUE
          WHERE id = $1
          RETURNING ${REPLENISHMENT_COLUMNS}`,
        [opts.requestId, opts.centralLocationId],
      );
      const pinned = rows[0];
      if (pinned === undefined) {
        throw AppError.internal('Send-to-production: target pin returned no row.');
      }
      current = pinned;
    } else if (Number(current.target_location_id) !== opts.centralLocationId) {
      throw AppError.forbidden(
        'This request targets a different warehouse; you may only route requests bound for your own.',
      );
    } else {
      const { rows } = await tx.query<ReplenishmentRow>(
        `UPDATE replenishment_requests
            SET route_to_production_manual = TRUE
          WHERE id = $1
          RETURNING ${REPLENISHMENT_COLUMNS}`,
        [opts.requestId],
      );
      const marked = rows[0];
      if (marked === undefined) {
        throw AppError.internal('Send-to-production: marker update returned no row.');
      }
      current = marked;
    }

    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.send_to_production',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        central_location_id: opts.centralLocationId,
        from_status: order.status,
      },
    });

    // NEW -> CHECK_STORE_SUPPLIER (target is pinned).
    if (current.status === 'NEW') {
      current = await transitionStatus(
        tx,
        current,
        'CHECK_STORE_SUPPLIER',
        'routed to production — target pinned',
        opts.actorUserId,
      );
    }
    // CHECK_STORE_SUPPLIER -> CHECK_PRODUCTION_INPUT (skip the central-has-stock
    // branch — the manager has DECIDED to produce regardless of central stock).
    if (current.status === 'CHECK_STORE_SUPPLIER') {
      current = await transitionStatus(
        tx,
        current,
        'CHECK_PRODUCTION_INPUT',
        'routed to production (manual)',
        opts.actorUserId,
      );
    }

    // F-L owner gate — when the product has a producing отдел, the routed
    // request must WAIT here (Kutuvda at the отдел) until that отдел's manager
    // presses «Qabul qilish» (accept-production stamps fulfiller_accepted_at;
    // the next cron pass then runs the BOM/raw check). Running the check
    // synchronously here made the зг consumption + raw POs fire BEFORE the
    // отдел ever saw the job — the exact bug the owner hit on round-2 E2E
    // (store shortfall #35074). Products with no resolvable production
    // location (no workshop link, no order) keep the legacy synchronous hop —
    // there is nobody to ask.
    const gateLocationId = await resolveProductionLocationIdTx(tx, current);
    if (gateLocationId !== null && current.fulfiller_accepted_at === null) {
      return {
        request: current,
        advanced: false,
        reason: 'waiting for production accept (otdel gate)',
      };
    }

    // Run the BOM/raw check -> creates the production order (or a purchase order
    // on a raw shortage). Reuses every invariant (atomic transfers, no negative
    // stock, audit) from the auto-replenishment path.
    const result = await advanceCheckProductionInput(tx, current, opts.actorUserId);
    return {
      request: result.request,
      advanced: result.advanced,
      reason: result.reason,
    };
  }
}

/**
 * MANUAL "Qabul qildim" — the central warehouse manager confirms receipt of
 * the produced goods at the central warehouse, with an optional brak (defect)
 * split. The request must be at DONE_TO_WAREHOUSE (production finished, the
 * `production_output` already placed `qty_needed` into the central warehouse).
 *
 * Stock model (NO double-count — the production_output already credited the
 * central warehouse):
 *   * brak_qty == 0 — pure acknowledgement; no movement.
 *   * brak_qty  > 0 — the defective qty is written OFF the central warehouse
 *                     (reason='adjust' — it must not be forwarded to the store
 *                     nor double-counted). Recorded in `brak_qty` / `brak_reason`.
 *
 * On success the request moves DONE_TO_WAREHOUSE -> SHIP_TO_REQUESTER (it is
 * now "received at central, ready to forward") and stamps
 * `received_from_production_at`. It does NOT ship — forwarding is the separate
 * `shipToStore` action. Idempotent: a second call once `received_from_production_at`
 * is set returns the row unchanged (no double write-off).
 */
export async function receiveFromProduction(opts: {
  requestId: number;
  brakQty?: number;
  brakReason?: string | null;
  actorUserId: number | null;
}): Promise<ReplenishmentRow> {
  const brakQty = opts.brakQty ?? 0;
  if (!Number.isFinite(brakQty) || brakQty < 0) {
    throw AppError.validation('brak_qty must be a number >= 0.');
  }
  const brakReasonClean =
    typeof opts.brakReason === 'string' && opts.brakReason.trim() !== ''
      ? opts.brakReason.trim()
      : null;
  if (brakQty > 0 && brakReasonClean === null) {
    throw AppError.validation('brak_reason is required when brak_qty > 0.');
  }
  return withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (order.received_from_production_at !== null) {
      // Already received — idempotent no-op (a double-tap cannot double-write-off).
      return order;
    }
    if (order.status !== 'DONE_TO_WAREHOUSE') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot receive-from-production in status ${order.status} — wait for the production order to finish (DONE_TO_WAREHOUSE).`,
      );
    }
    if (order.target_location_id === null) {
      throw AppError.internal('Cannot receive — request has no target_location_id.');
    }
    const qtyNeeded = Number(order.qty_needed);
    if (brakQty > qtyNeeded) {
      throw AppError.validation(
        `brak_qty (${brakQty}) cannot exceed the produced qty (${qtyNeeded}).`,
      );
    }

    // Write off the defective qty from the central warehouse so it is neither
    // forwarded nor double-counted. The good remainder stays at central for the
    // forward step. `applyMovement` keeps the guarded decrement + ledger + audit
    // (invariant 1, no negative stock).
    if (brakQty > 0) {
      await applyMovement(
        {
          productId: order.product_id,
          fromLocationId: order.target_location_id,
          toLocationId: null,
          qty: brakQty,
          reason: 'adjust',
          actorUserId: opts.actorUserId,
          replenishmentId: order.id,
          note: `receive-from-production brak: ${brakReasonClean}`,
        },
        tx,
      );
    }

    // Stamp the receipt + brak, then move DONE_TO_WAREHOUSE -> SHIP_TO_REQUESTER
    // (received at central, ready to forward — but NOT shipped yet).
    const { rows } = await tx.query<ReplenishmentRow>(
      `UPDATE replenishment_requests
         SET brak_qty = $2,
             brak_reason = $3,
             received_from_production_at = now()
       WHERE id = $1
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [opts.requestId, brakQty, brakReasonClean],
    );
    const stamped = rows[0];
    if (stamped === undefined) {
      throw AppError.internal('Replenishment receive-from-production returned no row.');
    }
    const next = await transitionStatus(
      tx,
      stamped,
      'SHIP_TO_REQUESTER',
      `received at central (brak ${brakQty})`,
      opts.actorUserId,
    );
    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.receive_from_production',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: { brak_qty: brakQty, brak_reason: brakReasonClean },
    });
    return next;
  });
}

/**
 * MANUAL "Do'konga yuborish" — the central warehouse manager forwards the
 * received goods from the central warehouse to the requesting store. The
 * request must be at SHIP_TO_REQUESTER AND (for a manual production route) have
 * been received first (`received_from_production_at` set). Reuses
 * `advanceShipToRequester`: an atomic central -> store transfer, then CLOSED.
 *
 * Ships `min(qty_needed, central.qty)` — after a brak write-off the central
 * holds `qty_needed - brak`, so exactly the good qty is forwarded.
 */
export async function shipToStore(opts: {
  requestId: number;
  actorUserId: number | null;
}): Promise<{ request: ReplenishmentRow; shipped: boolean; reason: string }> {
  const outcome = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (TERMINAL_STATUSES.includes(order.status)) {
      return { request: order, shipped: false, reason: `request already ${order.status}` };
    }
    if (order.status !== 'SHIP_TO_REQUESTER') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot ship-to-store in status ${order.status} — receive the production output first.`,
      );
    }
    if (order.route_to_production_manual && order.received_from_production_at === null) {
      throw new AppError(
        'INVALID_TRANSITION',
        'Cannot ship-to-store — confirm receipt at central first (receive-from-production).',
      );
    }
    const result = await advanceShipToRequester(tx, order, opts.actorUserId);
    return {
      request: result.request,
      shipped: result.request.status === 'CLOSED',
      reason: result.reason,
    };
  });
  // F-D — forwarding central -> store closed the request; fan out to waiting
  // roots. Post-commit, best-effort.
  await fireWaiterChain(outcome.request, opts.actorUserId);
  return outcome;
}

// -----------------------------------------------------------------------------
// 0058 — PARTIAL FULFILLMENT (central -> store, ship-available + produce-rest)
// -----------------------------------------------------------------------------

/** Result of `fulfillStoreRequest`. */
export type FulfillResult = {
  /** Qty actually shipped to the store now (0 when the central was empty). */
  readonly shippedQty: number;
  /** Remaining qty routed to production (0 when the central covered it all). */
  readonly shortfallQty: number;
  /**
   * The id of the request that carries the shortfall to production. For a real
   * partial (some shipped) this is a NEW grouped request; when nothing was
   * shipped it is the ORIGINAL request id (routed in place). Absent when there
   * was no shortfall.
   */
  readonly productionRequestId: number | null;
  /** The ORIGINAL request row after the ship (enriched downstream). */
  readonly request: ReplenishmentRow;
};

/**
 * Ship an EXACT qty from the central (target) to the requester store, then close
 * the request — the partial-fulfill controlled ship. Unlike
 * `advanceShipToRequester` (which ships `min(qty_needed, targetQty)`), this ships
 * precisely `shipQty` (already validated `0 < shipQty <= central on-hand` and
 * `<= qty_needed` by the caller), so a deliberately-smaller partial honours the
 * operator's chosen amount. The request is flipped to SHIP_TO_REQUESTER first
 * (so the SM-2 transition guard accepts the CLOSED hop), then closed with the
 * shipment movement linked. closure_reason stays NULL -> pipeline `yuborilgan`.
 */
async function shipPortionToStore(
  tx: TxClient,
  request: ReplenishmentRow,
  shipQty: number,
  actorUserId: number | null,
): Promise<ReplenishmentRow> {
  if (request.target_location_id === null) {
    throw AppError.internal('Cannot ship portion — request has no target_location_id.');
  }
  // Flip NEW -> CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER so the final CLOSED
  // transition is reachable in the SM-2 graph.
  let current = request;
  if (current.status === 'NEW') {
    current = await transitionStatus(
      tx,
      current,
      'CHECK_STORE_SUPPLIER',
      'fulfill — target pinned',
      actorUserId,
    );
  }
  if (current.status === 'CHECK_STORE_SUPPLIER') {
    current = await transitionStatus(
      tx,
      current,
      'SHIP_TO_REQUESTER',
      `fulfill — shipping ${shipQty} of ${current.qty_needed}`,
      actorUserId,
    );
  }
  if (current.status !== 'SHIP_TO_REQUESTER') {
    throw new AppError(
      'INVALID_TRANSITION',
      `Cannot ship portion from status ${current.status}.`,
    );
  }

  const { movementId } = await applyMovement(
    {
      productId: current.product_id,
      fromLocationId: current.target_location_id,
      toLocationId: current.requester_location_id,
      qty: shipQty,
      reason: 'transfer',
      actorUserId,
      replenishmentId: current.id,
      note: 'partial fulfill — available portion',
    },
    tx,
  );

  const { rows } = await tx.query<ReplenishmentRow>(
    `UPDATE replenishment_requests
       SET status = 'CLOSED', shipment_movement_id = $2, closed_at = now()
     WHERE id = $1 AND status = 'SHIP_TO_REQUESTER'
     RETURNING ${REPLENISHMENT_COLUMNS}`,
    [current.id, movementId],
  );
  const updated = rows[0];
  if (updated === undefined) {
    throw AppError.internal('Partial fulfill close returned no row.');
  }
  await recordTransition(
    tx,
    current.id,
    'SHIP_TO_REQUESTER',
    'CLOSED',
    `partial fulfill — shipped ${shipQty}`,
    actorUserId,
  );
  await writeAudit(tx, {
    actorUserId,
    action: 'replenishment.fulfill_ship',
    entity: 'replenishment_requests',
    entityId: current.id,
    payload: { shipped_qty: shipQty, movement_id: movementId },
  });
  await notifyShipmentCreated(tx, updated, shipQty, movementId);
  return updated;
}

/**
 * PARTIAL FULFILLMENT — the central warehouse manager fulfils a store request
 * with whatever is on hand and routes the rest to production, in ONE atomic
 * transaction (owner-corrected 2026-06-08). This replaces the old
 * all-or-nothing accept for the modal flow (`acceptByCentral` stays for
 * backward-compat).
 *
 * Behaviour (store request bound for the acting central):
 *   available = central on-hand(product)
 *   shipQty   = clamp(opts.shipQty ?? available, 0, min(qty_needed, available))
 *   shortfall = qty_needed - shipQty
 *
 *   (a) if shipQty > 0 — ship exactly `shipQty` central -> store and CLOSE the
 *       request (pipeline `yuborilgan` — the store has not accepted yet).
 *   (b) if shortfall > 0 — produce the rest:
 *         * shipQty > 0 (real partial) — create a NEW grouped production request
 *           (requester = same store, qty = shortfall, same batch_id) and route
 *           it to production via the shared `sendToProductionTx` path
 *           (pipeline `soralgan`). Allowed because the original is now CLOSED
 *           (terminal), so the partial-unique index permits the new open row.
 *         * shipQty = 0 (central empty) — route the ORIGINAL request to
 *           production in place; `productionRequestId = original id`.
 *
 * All invariants hold: invariant 1 (atomic movement + audit), invariant 2 (the
 * original is closed BEFORE the shortfall row is created), invariant 3 (guarded
 * `applyMovement` — no negative stock), audit on every change.
 */
export async function fulfillStoreRequest(opts: {
  requestId: number;
  centralLocationId: number;
  shipQty?: number;
  note?: string | null;
  actorUserId: number | null;
}): Promise<FulfillResult> {
  if (
    opts.shipQty !== undefined &&
    (!Number.isFinite(opts.shipQty) || opts.shipQty < 0)
  ) {
    throw AppError.validation('ship_qty must be a number >= 0.');
  }
  const fulfillResult = await withTransaction(async (tx) => {
    const order = await lockRequest(tx, opts.requestId);
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot fulfill a request already ${order.status}.`,
      );
    }
    // Only the pre-fulfilment store states are eligible (mirrors the accept /
    // to-production guards). A request already in production / shipped is refused.
    if (order.status !== 'NEW' && order.status !== 'CHECK_STORE_SUPPLIER') {
      throw new AppError(
        'INVALID_TRANSITION',
        `Cannot fulfill from status ${order.status} — only NEW / CHECK_STORE_SUPPLIER are allowed.`,
      );
    }

    // Pin / verify the target to the acting central warehouse.
    let current = order;
    if (current.target_location_id === null) {
      const { rows } = await tx.query<ReplenishmentRow>(
        `UPDATE replenishment_requests SET target_location_id = $2
          WHERE id = $1 RETURNING ${REPLENISHMENT_COLUMNS}`,
        [opts.requestId, opts.centralLocationId],
      );
      const pinned = rows[0];
      if (pinned === undefined) {
        throw AppError.internal('Fulfill: target pin returned no row.');
      }
      current = pinned;
    } else if (Number(current.target_location_id) !== opts.centralLocationId) {
      throw AppError.forbidden(
        'This request targets a different warehouse; you may only fulfill requests bound for your own.',
      );
    }

    const qtyNeeded = Number(current.qty_needed);
    const available = await readStockQty(tx, opts.centralLocationId, current.product_id);
    const cap = Math.min(qtyNeeded, Math.max(available, 0));
    // Default ship = everything we can; a provided ship_qty is capped at `cap`.
    const shipQty = opts.shipQty === undefined ? cap : Math.min(opts.shipQty, cap);
    const shortfall = qtyNeeded - shipQty;

    await writeAudit(tx, {
      actorUserId: opts.actorUserId,
      action: 'replenishment.fulfill',
      entity: 'replenishment_requests',
      entityId: opts.requestId,
      payload: {
        central_location_id: opts.centralLocationId,
        qty_needed: qtyNeeded,
        available,
        ship_qty: shipQty,
        shortfall_qty: shortfall,
        note: opts.note ?? null,
      },
    });

    // 0066 — fulfilling IS an acceptance: stamp it (first accept wins) BEFORE the
    // ship/route steps so their RETURNING rows carry fulfiller_accepted_*. When a
    // real partial spawns a NEW shortfall row, only the ORIGINAL is stamped here
    // (the shortfall is a fresh request that gets its own accept downstream).
    await stampFulfillerAccept(tx, opts.requestId, opts.actorUserId);
    current = await lockRequest(tx, opts.requestId);

    // (a) Ship the available portion (when any) and close the original request.
    let originalAfter = current;
    if (shipQty > 0) {
      originalAfter = await shipPortionToStore(tx, current, shipQty, opts.actorUserId);
    }

    // (b) Route the shortfall to production (when any).
    let productionRequestId: number | null = null;
    if (shortfall > 0) {
      if (shipQty > 0) {
        // Real partial — the original is CLOSED; create a NEW grouped request
        // for the shortfall, then route IT to production within this same tx.
        const shortfallRow = await insertShortfallRequest(tx, {
          productId: current.product_id,
          requesterLocationId: current.requester_location_id,
          qtyNeeded: shortfall,
          actorUserId: opts.actorUserId,
          batchId: current.batch_id,
          note: opts.note ?? null,
        });
        const routed = await sendToProductionTx(
          tx,
          shortfallRow,
          opts.centralLocationId,
          opts.actorUserId,
        );
        productionRequestId = routed.request.id;
      } else {
        // Central empty — route the ORIGINAL request to production in place.
        const routed = await sendToProductionTx(
          tx,
          current,
          opts.centralLocationId,
          opts.actorUserId,
        );
        originalAfter = routed.request;
        productionRequestId = routed.request.id;
      }
    }

    return {
      shippedQty: shipQty,
      shortfallQty: shortfall,
      productionRequestId,
      request: originalAfter,
    };
  });
  // F-D — if the (original) request closed via the partial ship, fan out to any
  // waiting roots. Post-commit, best-effort. (A store request is normally a root
  // with no waiters — a harmless no-op — but a linked child would chain here.)
  await fireWaiterChain(fulfillResult.request, opts.actorUserId);
  return fulfillResult;
}

/**
 * Insert + lock a fresh replenishment request for the partial-fulfill shortfall.
 * Bypasses the public `createRequest` (which opens its own transaction and fires
 * the requester notification) — here the row must be created AND immediately
 * `FOR UPDATE`-locked inside the caller's transaction so `sendToProductionTx`
 * can route it. The partial-unique index still guards invariant 2; a conflict
 * (an unrelated open request already exists for this product+store) surfaces as
 * OPEN_REQUEST_EXISTS, rolling the whole fulfill back.
 */
async function insertShortfallRequest(
  tx: TxClient,
  opts: {
    productId: number;
    requesterLocationId: number;
    qtyNeeded: number;
    actorUserId: number | null;
    batchId: number | null;
    note: string | null;
  },
): Promise<ReplenishmentRow> {
  let row: ReplenishmentRow;
  try {
    const { rows } = await tx.query<ReplenishmentRow>(
      // 0065 — origin='shortfall': this row is the leftover of a partial fulfil
      // routed to production (it is a fresh root, so parent/root stay NULL).
      `INSERT INTO replenishment_requests
         (product_id, requester_location_id, qty_needed, status, note, created_by, batch_id, origin)
       VALUES ($1, $2, $3, 'NEW', $4, $5, $6, 'shortfall')
       RETURNING ${REPLENISHMENT_COLUMNS}`,
      [
        opts.productId,
        opts.requesterLocationId,
        opts.qtyNeeded,
        opts.note,
        opts.actorUserId,
        opts.batchId,
      ],
    );
    const inserted = rows[0];
    if (inserted === undefined) {
      throw AppError.internal('Shortfall request insert returned no row.');
    }
    row = inserted;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        'OPEN_REQUEST_EXISTS',
        'An open replenishment request already exists for this (product, location) — cannot create the shortfall request.',
      );
    }
    throw err;
  }
  await recordTransition(tx, row.id, null, 'NEW', 'created (fulfill shortfall)', opts.actorUserId);
  await writeAudit(tx, {
    actorUserId: opts.actorUserId,
    action: 'replenishment.create',
    entity: 'replenishment_requests',
    entityId: row.id,
    payload: {
      product_id: opts.productId,
      requester_location_id: opts.requesterLocationId,
      qty_needed: opts.qtyNeeded,
      source: 'fulfill_shortfall',
    },
  });
  // Re-read FOR UPDATE so the row is locked for the rest of this transaction.
  return lockRequest(tx, row.id);
}

// -----------------------------------------------------------------------------
// Scan worker
// -----------------------------------------------------------------------------

/** One row produced by the below-min scan. */
export type BelowMinRow = {
  location_id: number;
  product_id: number;
  qty: number;
  min_level: number;
  max_level: number;
  /**
   * 0065 — the requester location's type, carried so `runEngineCycle` can stamp
   * the correct origin without a second query: a `sex_storage` below-min is the
   * B-cycle buffer top-up (`origin='buffer'`); every other internal layer is a
   * plain scan (`origin='scan'`). Cheap — the scan already JOINs `locations`.
   */
  location_type: string;
};

/** All `(location, product)` rows where `qty <= min_level` and `max > 0`. */
export async function scanBelowMin(): Promise<BelowMinRow[]> {
  const { rows } = await query<{
    location_id: number;
    product_id: number;
    qty: number;
    min_level: number;
    max_level: number;
    location_type: string;
  }>(
    // STORES are EXCLUDED from auto-creation: per owner spec the store flow is
    // AI-propose → boss-approve (GET /proposals + POST /proposals/approve), so a
    // store never auto-raises a replenishment request. Internal layers
    // (production sex_storage, central warehouse, raw) keep auto-replenishment.
    `SELECT s.location_id, s.product_id, s.qty, s.min_level, s.max_level,
            l.type::text AS location_type
     FROM stock s
     JOIN locations l ON l.id = s.location_id
     WHERE s.qty <= s.min_level AND s.max_level > 0
       AND l.type <> 'store'::location_type`,
  );
  return rows.map((r) => ({
    location_id: r.location_id,
    product_id: r.product_id,
    qty: Number(r.qty),
    min_level: Number(r.min_level),
    max_level: Number(r.max_level),
    location_type: r.location_type,
  }));
}

/**
 * Run one cycle of the engine:
 *   1. scan for `qty <= min_level` rows;
 *   2. for each row, ensure an open request exists (create if missing); the
 *      partial UNIQUE index plus the OPEN_REQUEST_EXISTS catch makes this
 *      idempotent — a duplicate scan never creates a duplicate request;
 *   3. step every NON-terminal open request forward once (`advance`).
 *
 * Returns a summary suitable for logging.
 */
export async function runEngineCycle(opts: { actorUserId?: number | null } = {}): Promise<{
  scanned: number;
  created: number;
  advanced: number;
}> {
  const actor = opts.actorUserId ?? null;
  const below = await scanBelowMin();
  let created = 0;
  for (const row of below) {
    // M9 — stock_below_min notification (spec §7). Fired for EVERY scan row,
    // not just rows that created a request: a long-running open request is
    // still a "below min" signal the location manager needs to see. The 24h
    // dedupe (`createNotification`'s `dedupeKey`) keeps the noise down.
    try {
      await withTransaction((tx) =>
        notifyStockBelowMin(tx, {
          productId: row.product_id,
          locationId: row.location_id,
          qty: row.qty,
          minLevel: row.min_level,
        }),
      );
    } catch (err) {
      // Notification failures must never block engine work — log and move on.
      console.error(
        '[replenishment-engine] stock_below_min notify failed:',
        (err as Error).message,
      );
    }

    const qtyNeeded = row.max_level - row.qty;
    if (qtyNeeded <= 0) {
      continue;
    }
    try {
      const createdRow = await createRequest({
        productId: row.product_id,
        requesterLocationId: row.location_id,
        qtyNeeded,
        actorUserId: actor,
        // 0065 — a sex_storage below-min is the B-cycle buffer top-up; every
        // other internal layer (central / raw / production) is a plain scan.
        origin: row.location_type === 'sex_storage' ? 'buffer' : 'scan',
      });
      created += 1;
      // F-C / decision #8 — for a sex_storage buffer refill, nudge the PRODUCING
      // отдел boss (the requester's parent workshop manager) with the actionable
      // ireq:accept / ireq:reject inline buttons so the "tavsiya karta" can be
      // accepted/rejected straight from Telegram. Best-effort — a notify failure
      // must never block the cron.
      if (row.location_type === 'sex_storage') {
        try {
          await withTransaction((tx) => notifyBufferRequestToWorkshop(tx, createdRow));
        } catch (err) {
          console.error(
            '[replenishment-engine] buffer-request workshop notify failed:',
            (err as Error).message,
          );
        }
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'OPEN_REQUEST_EXISTS') {
        // Expected — the previous scan already raised a request for this row.
        continue;
      }
      throw err;
    }
  }

  // Step every non-terminal request once. A failure on one row must not stop
  // the whole cycle — the cron pass runs every five minutes, so an isolated
  // error stays visible in the log but the rest of the queue keeps moving.
  //
  // CRITICAL — the central accept/reject gate (the owner's "to'g'ri connection").
  // A request raised by a STORE must WAIT for an explicit central-manager accept
  // (POST /:id/accept-central, bot xreq:accept -> acceptByCentral) before it
  // ships. If the cron auto-advanced such a request it would resolve the central
  // target, ship to the store, and CLOSE it — making the manager's accept/reject
  // purely cosmetic. So the auto-advance LOOP skips store-requester requests
  // entirely; they advance ONLY via the central accept path. Internal-layer
  // requests (production / sex_storage / central / raw) keep auto-advancing.
  // The manual `advance()` function itself is unchanged — acceptByCentral and
  // the tests still drive store requests through it directly.
  //
  // F-C / decision #8 — INTERNAL accept-gates. Two NEW-only classes ALSO wait
  // for an explicit internal accept before the cron may touch them (the skip
  // predicate is `status='NEW'` only — past NEW both flow normally; the store
  // skip above is unconditional and untouched):
  //   (a) a request PINNED to a `sex_storage` OR `raw_warehouse` target. For
  //       `sex_storage` it is the producer-override / Qaymoq case; for
  //       `raw_warehouse` it is the F-G mahsulot-ombori supply (a sex asking the
  //       raw manager). In BOTH, `advanceNew` would CLOBBER that pinned target
  //       with the central warehouse and ship without the fulfilling manager's
  //       accept — exactly the bug this gate closes. `acceptByFulfiller` (driven
  //       by the xreq buttons / the web accept-fulfiller route) is the only
  //       forward path for them.
  //   (b) a `sex_storage` REQUESTER (the B-cycle buffer refill — the "tavsiya
  //       karta"). It waits for an explicit internal accept (`acceptInternal`,
  //       ireq buttons) so the producing отдел boss confirms the buffer top-up.
  // NOTE: `tl.type` is NULL for an untargeted request (LEFT JOIN). `COALESCE(…,
  // FALSE)` keeps the predicate two-valued — without it `NOT (NEW AND (NULL OR
  // …))` evaluates to NULL, which a WHERE treats as FALSE and would wrongly DROP
  // every untargeted NEW internal row from the auto-advance loop.
  //
  // F-L / gate class (d) — the PRODUCTION accept-gate. A request parked at
  // CHECK_PRODUCTION_INPUT whose PRODUCTION resolves to an отдел
  // (`COALESCE(po.location_id, p.workshop_location_id)` — the production order's
  // location, else the product's `workshop_location_id`) must NOT be auto-advanced
  // by the cron while the отдел has not yet accepted (`fulfiller_accepted_at IS
  // NULL`). Without this the next cron pass runs `advanceCheckProductionInput`
  // (зг consume, raw transfer, PO / zayafka) BEFORE the отдел manager accepts —
  // the owner's round-2 bug. `acceptProduction` stamps `fulfiller_accepted_at`,
  // which clears this skip so the very next pass advances exactly as today. The
  // fulfill-shortfall fresh row's stamp is NULL (only the ORIGINAL is stamped at
  // fulfil), so the discriminator never re-gates an already-accepted request. Same
  // `COALESCE(…, FALSE)` three-valued guard: `po.location_id`/`p.workshop_location_id`
  // are NULL for a row with no production order and a product with no отдел, so the
  // bare `IS NOT NULL` is already two-valued — the wrapping COALESCE keeps the
  // whole `NOT (… AND …)` predicate FALSE-safe for consistency with class (a)/(b).
  const { rows: open } = await query<{ id: number }>(
    `SELECT r.id
       FROM replenishment_requests r
       JOIN locations rl ON rl.id = r.requester_location_id
       JOIN products p ON p.id = r.product_id
       LEFT JOIN locations tl ON tl.id = r.target_location_id
       LEFT JOIN production_orders po ON po.id = r.production_order_id
      WHERE r.status NOT IN ('CLOSED','CANCELLED')
        AND rl.type <> 'store'::location_type
        AND NOT (
          r.status = 'NEW'
          AND (
            COALESCE(tl.type IN ('sex_storage'::location_type, 'raw_warehouse'::location_type), FALSE)
            OR rl.type = 'sex_storage'::location_type
          )
        )
        AND NOT (
          r.status = 'CHECK_PRODUCTION_INPUT'
          AND COALESCE(po.location_id, p.workshop_location_id) IS NOT NULL
          AND r.fulfiller_accepted_at IS NULL
        )`,
  );
  let advanced = 0;
  for (const r of open) {
    try {
      const result = await advance(r.id, actor);
      if (result.advanced) {
        advanced += 1;
      }
    } catch (err) {
      console.error(
        `[replenishment-engine] advance(${r.id}) failed:`,
        (err as Error).message,
      );
    }
  }
  return { scanned: below.length, created, advanced };
}


// -----------------------------------------------------------------------------
// M9 — Notification helpers (spec §7)
// -----------------------------------------------------------------------------

/**
 * Fetch the product name + unit + the location name for one (product, location)
 * pair. Used by every notification message in this file.
 */
async function fetchProductAndLocation(
  tx: TxClient,
  productId: number,
  locationId: number,
): Promise<{
  productName: string;
  productUnit: string;
  locationName: string;
}> {
  const { rows } = await tx.query<{
    product_name: string;
    product_unit: string;
    location_name: string;
  }>(
    `SELECT p.name AS product_name, p.unit AS product_unit, l.name AS location_name
       FROM products p, locations l
      WHERE p.id = $1 AND l.id = $2`,
    [productId, locationId],
  );
  const row = rows[0];
  if (row === undefined) {
    return { productName: `#${productId}`, productUnit: '', locationName: `#${locationId}` };
  }
  return {
    productName: row.product_name,
    productUnit: row.product_unit,
    locationName: row.location_name,
  };
}

/**
 * Send a `stock_below_min` notification — once per (product, location) per
 * 24h (the dedupe key). The location manager is the recipient; if no
 * manager is set on the location the notification is skipped.
 */
async function notifyStockBelowMin(
  tx: TxClient,
  opts: {
    productId: number;
    locationId: number;
    qty: number;
    minLevel: number;
  },
): Promise<void> {
  const managerId = await getLocationManager(tx, opts.locationId);
  if (managerId === null) return;
  const { productName, productUnit, locationName } = await fetchProductAndLocation(
    tx,
    opts.productId,
    opts.locationId,
  );
  await createNotification(tx, {
    recipientUserId: managerId,
    type: 'stock_below_min',
    title: 'Ostatka min dan tushdi',
    body:
      `${productName} (${locationName}) — ${opts.qty} ${productUnit}, ` +
      `min: ${opts.minLevel} ${productUnit}.`,
    payload: {
      product_id: opts.productId,
      location_id: opts.locationId,
      qty: opts.qty,
      min_level: opts.minLevel,
    },
    // One Telegram per (product, location) per 24h (spec §2.9). The dedupe
    // key includes 'stock_below_min' so it never collides with another type.
    dedupeKey: `stock_below_min:${opts.productId}:${opts.locationId}`,
    dedupeWindowMinutes: 24 * 60,
  });
}

/**
 * `replenishment_created` notification at NEW (createRequest) time.
 *
 * Two DISTINCT audiences with DIFFERENT framing (owner feedback 2026-06-08):
 *
 *   1. Requester manager (e.g. a do'konchi who raised a store→central request,
 *      typically by voice) + the actor when different. They do NOT fulfil their
 *      own outgoing request, so they get a "sent to the central warehouse,
 *      awaiting receipt" card with ONLY a "Ko'rish" button — NO "Tezda
 *      bajarish". Advancing/fulfilling is the fulfiller's job, and a pending-
 *      looking action button on one's own request is exactly the confusion the
 *      owner reported.
 *
 *   2. The FULFILLING manager — the manager of the request's target location.
 *      For a bare store request the target is not yet pinned at NEW (the cron
 *      gates store requests at NEW; `advanceNew` only runs on the central
 *      accept path), so we resolve the central warehouse from the requester's
 *      chain topology. THAT manager gets the actionable "Tezda bajarish"
 *      (`fast:req`) nudge. We reuse the SAME dedupe key as
 *      `notifyReplenishmentTargetSet` (`replenishment_created:target:<id>`) so
 *      the central manager is nudged at most once, whether the request was
 *      created here or later advanced past NEW.
 *
 * Best-effort: if the central warehouse / its manager cannot be resolved we
 * simply skip the fulfiller nudge (the central pipeline UI still shows it).
 */
async function notifyReplenishmentCreated(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<void> {
  const requesterManagerId = await getLocationManager(tx, request.requester_location_id);
  const requesterRecipients: number[] = [];
  if (requesterManagerId !== null) requesterRecipients.push(requesterManagerId);
  if (actorUserId !== null && !requesterRecipients.includes(actorUserId)) {
    requesterRecipients.push(actorUserId);
  }

  const { productName, productUnit, locationName } = await fetchProductAndLocation(
    tx,
    request.product_id,
    request.requester_location_id,
  );

  // 1. Requester-side card — informational only (no actionable button). The
  //    requester's request has been SENT; it now waits on the central wh.
  if (requesterRecipients.length > 0) {
    await createNotificationsForRecipients(tx, requesterRecipients, {
      type: 'replenishment_created',
      title: `So'rovingiz yuborildi #${request.id}`,
      body:
        `So'rov #${request.id}: ${productName} ${request.qty_needed} ${productUnit} ` +
        `— ${locationName} uchun markaziy skladga yuborildi. ` +
        `Markaziy sklad qabul qilishini kuting.`,
      payload: {
        replenishment_id: request.id,
        product_id: request.product_id,
        qty_needed: request.qty_needed,
        requester_location_id: request.requester_location_id,
        role: 'requester',
      },
      // "Ko'rish" only — the requester must NOT advance their own request.
      inlineCallback: {
        buttons: [[{ text: "📋 Ko'rish", data: `view:req:${request.id}` }]],
      },
    });
  }

  // 2. Fulfiller-side nudge — the manager of the TARGET location gets the
  //    actionable "Tezda bajarish". Resolve the central warehouse when the
  //    target is not yet pinned (bare store request at NEW).
  let fulfillerLocationId = request.target_location_id;
  if (fulfillerLocationId === null) {
    const topology = await resolveTopology(tx, request.requester_location_id);
    fulfillerLocationId = topology.centralWarehouseLocationId;
  }
  if (fulfillerLocationId === null) return;
  const fulfillerManagerId = await getLocationManager(tx, fulfillerLocationId);
  if (fulfillerManagerId === null) return;
  // Skip if the fulfiller manager is also a requester recipient (small chain) —
  // they already got the requester-side card.
  if (requesterRecipients.includes(fulfillerManagerId)) return;

  await createNotification(tx, {
    recipientUserId: fulfillerManagerId,
    type: 'replenishment_created',
    title: `Yangi to'ldirish so'rovi #${request.id}`,
    body:
      `Sizning omborga so'rov #${request.id}: ${productName} ${request.qty_needed} ${productUnit} ` +
      `— ${locationName} uchun.`,
    payload: {
      replenishment_id: request.id,
      product_id: request.product_id,
      qty_needed: request.qty_needed,
      requester_location_id: request.requester_location_id,
      target_location_id: fulfillerLocationId,
      role: 'target',
    },
    // Same dedupe key as notifyReplenishmentTargetSet so the central manager is
    // nudged at most once across create + first advance.
    dedupeKey: `replenishment_created:target:${request.id}`,
    dedupeWindowMinutes: 24 * 60,
    // F3.3 / ADR-0011 — "Tezda bajarish" advances the request one hop. The
    // dispatcher re-checks RBAC (pm or target-loc manager) at press time.
    inlineCallback: {
      buttons: [
        [
          { text: "🔄 Tezda bajarish", data: `fast:req:${request.id}` },
          { text: "📋 Ko'rish", data: `view:req:${request.id}` },
        ],
      ],
    },
  });
}

/**
 * C1 (Sprint 3 audit) — `replenishment_created` for the TARGET location
 * manager, fired right after `advanceNew` resolves the target. Spec §7
 * mandates that both managers see the request:
 *   - requester manager is notified at `createRequest` (target unknown);
 *   - target manager is notified here (the first hop that fills it).
 *
 * Dedupe key (`replenishment_created:target:<id>`) makes a re-advance of
 * the same row a no-op. The actor receives only the requester-side nudge.
 */
async function notifyReplenishmentTargetSet(
  tx: TxClient,
  request: ReplenishmentRow,
  actorUserId: number | null,
): Promise<void> {
  if (request.target_location_id === null) return;
  const targetManagerId = await getLocationManager(tx, request.target_location_id);
  if (targetManagerId === null) return;
  // Spec §7 says "requester AND target manager"; if they happen to be the
  // same person (small chain), the dedupeKey on the requester-side nudge
  // already covers them — but here we suppress regardless to avoid two
  // pings landing on one person.
  const requesterManagerId = await getLocationManager(tx, request.requester_location_id);
  if (requesterManagerId === targetManagerId) return;
  const { productName, productUnit, locationName: requesterName } = await fetchProductAndLocation(
    tx,
    request.product_id,
    request.requester_location_id,
  );
  await createNotification(tx, {
    recipientUserId: targetManagerId,
    type: 'replenishment_created',
    title: `Yangi to'ldirish so'rovi #${request.id}`,
    body:
      `Sizning omborga so'rov #${request.id}: ${productName} ${request.qty_needed} ${productUnit} ` +
      `— ${requesterName} uchun jo'natiladi.`,
    payload: {
      replenishment_id: request.id,
      product_id: request.product_id,
      qty_needed: request.qty_needed,
      target_location_id: request.target_location_id,
      requester_location_id: request.requester_location_id,
      role: 'target',
      actor_user_id: actorUserId,
    },
    dedupeKey: `replenishment_created:target:${request.id}`,
    dedupeWindowMinutes: 24 * 60,
    // F3.3 — same inline buttons as the requester-side nudge: the target
    // manager is exactly the person allowed to fast-advance the request.
    inlineCallback: {
      buttons: [
        [
          { text: "🔄 Tezda bajarish", data: `fast:req:${request.id}` },
          { text: "📋 Ko'rish", data: `view:req:${request.id}` },
        ],
      ],
    },
  });
}

/**
 * F-C / decision #8 — notify the PRODUCING отдел boss about a NEW B-cycle buffer
 * refill request (a `sex_storage` requester) with the actionable ireq:accept /
 * ireq:reject inline buttons. The producing workshop is the requester
 * sex_storage's PARENT (per migration 0022); its manager is the recipient.
 *
 * Reuses the exact `createNotification` inlineCallback shape `crossDeptRequest`
 * uses for xreq buttons, so the outbox worker renders them identically. The
 * dedupe key keeps a re-scan from double-nudging while the request stays open.
 * Best-effort — the caller wraps this in try/catch.
 */
async function notifyBufferRequestToWorkshop(
  tx: TxClient,
  request: ReplenishmentRow,
): Promise<void> {
  // The producing workshop = the requester sex_storage's parent.
  const { rows } = await tx.query<{ id: number; name: string }>(
    `SELECT w.id, w.name
       FROM locations s
       JOIN locations w ON w.id = s.parent_id
      WHERE s.id = $1 AND s.type = 'sex_storage'::location_type
        AND w.type = 'production'::location_type`,
    [request.requester_location_id],
  );
  const workshop = rows[0];
  if (workshop === undefined) return;
  const managerId = await getLocationManager(tx, Number(workshop.id));
  if (managerId === null) return;
  const { productName, productUnit, locationName } = await fetchProductAndLocation(
    tx,
    request.product_id,
    request.requester_location_id,
  );
  await createNotification(tx, {
    recipientUserId: managerId,
    type: 'replenishment_created',
    title: `Bufer to'ldirish — ${locationName}`,
    body:
      `${productName} × ${request.qty_needed} ${productUnit}\n` +
      `Bufer so'rovi #${request.id}: ostatka min dan tushdi. Ishlab chiqaramizmi?`,
    payload: {
      replenishment_id: request.id,
      requester_location_id: request.requester_location_id,
      workshop_location_id: Number(workshop.id),
      product_id: request.product_id,
      qty: request.qty_needed,
      origin: 'buffer',
    },
    // One nudge per (request) — a re-scan before the boss acts must not re-ping.
    dedupeKey: `buffer_request:${request.id}`,
    dedupeWindowMinutes: 24 * 60,
    inlineCallback: {
      buttons: [
        [
          { text: '✅ Ishlab chiqarish', data: `ireq:accept:${request.id}` },
          { text: '❌ Rad', data: `ireq:reject:${request.id}` },
        ],
      ],
    },
  });
}

/**
 * Send a `shipment_created` notification to the requester's manager (the
 * goods have left the central warehouse). Best-effort.
 */
async function notifyShipmentCreated(
  tx: TxClient,
  request: ReplenishmentRow,
  shippedQty: number,
  movementId: number,
): Promise<void> {
  const requesterManagerId = await getLocationManager(tx, request.requester_location_id);
  if (requesterManagerId === null) return;
  const { productName, productUnit, locationName } = await fetchProductAndLocation(
    tx,
    request.product_id,
    request.requester_location_id,
  );
  await createNotification(tx, {
    recipientUserId: requesterManagerId,
    type: 'shipment_created',
    title: `Jo'natma yo'lda #${request.id}`,
    body:
      `Jo'natma: ${productName} ${shippedQty} ${productUnit} ` +
      `— ${locationName} uchun yo'lga chiqdi.`,
    payload: {
      replenishment_id: request.id,
      product_id: request.product_id,
      qty: shippedQty,
      movement_id: movementId,
    },
  });
}
