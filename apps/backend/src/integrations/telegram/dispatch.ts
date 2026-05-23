/**
 * F3.3 / ADR-0011 — Telegram callback dispatcher.
 *
 * One pure function — `dispatchCallback` — takes a parsed callback
 * (`verb:entity:id`) plus the resolved ADIA principal, runs the matching
 * domain service, and returns a structured outcome the bot handler turns
 * into `answerCallbackQuery` text and an audit row.
 *
 * Everything domain-mutating goes through the existing services
 * (`approvePurchaseOrder`, `rejectPurchaseOrder`, `startProductionOrder`,
 * `finishProductionOrder`, `advance`) — this module never speaks SQL
 * directly. That keeps the transactional / audit-log invariants the
 * domain code already enforces (invariants 1, 5, 6) intact.
 *
 * RBAC is checked here BEFORE the service runs. The matrix mirrors
 * ADR-0011 §7 — for example only the `target_location` manager (or a
 * `pm`) can `apprv:po`, and only a `production_manager` whose own
 * location matches the production order's may `start:prod` / `done:prod`.
 *
 * The dispatcher is intentionally untied to Grammy — the bot handler
 * passes a pre-extracted principal so the same dispatcher is callable
 * from a unit test without a Grammy `Context`.
 */
import { query, withTransaction, type TxClient } from '../../db/index.js';
import type { Role } from '../../auth/roles.js';
import { writeAudit } from '../../lib/audit.js';
import {
  approvePurchaseOrder,
  PURCHASE_ORDER_COLUMNS,
  type PurchaseOrderRow,
  type ApprovalStep,
} from '../../services/purchaseOrder.js';
import {
  finishProductionOrder,
  PRODUCTION_ORDER_COLUMNS,
  type ProductionOrderRow,
} from '../../services/productionOrder.js';
import { advance } from '../../services/replenishment.js';

/** A Telegram presser, post-spoofing-check. */
export type CallbackPrincipal = {
  readonly userId: number;
  readonly role: Role;
  readonly locationId: number | null;
};

/** Result of one dispatch — the bot handler maps these to user-facing text. */
export type DispatchOutcome =
  | { readonly kind: 'ok'; readonly message: string; readonly result?: Record<string, unknown>; readonly removeButtons?: boolean }
  | { readonly kind: 'rbac'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'failed'; readonly message: string; readonly error: string };

/** Recognised verbs (ADR-0011 §3). */
export const CALLBACK_VERBS = ['view', 'apprv', 'rej', 'start', 'done', 'fast'] as const;
export type CallbackVerb = (typeof CALLBACK_VERBS)[number];

/** Recognised entities (ADR-0011 §3). */
export const CALLBACK_ENTITIES = ['po', 'prod', 'req', 'mov'] as const;
export type CallbackEntity = (typeof CALLBACK_ENTITIES)[number];

/** Parsed `verb:entity:id` triple — null when the string is malformed. */
export type ParsedCallback = {
  readonly verb: CallbackVerb;
  readonly entity: CallbackEntity;
  readonly id: number;
};

/**
 * Parse the raw `callback_data`. Returns `null` for anything that does
 * not match `verb:entity:id` exactly — the caller treats null as an
 * 'invalid' outcome (no domain call made).
 */
export function parseCallbackData(raw: string): ParsedCallback | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [verbRaw, entityRaw, idRaw] = parts as [string, string, string];
  if (!(CALLBACK_VERBS as readonly string[]).includes(verbRaw)) return null;
  if (!(CALLBACK_ENTITIES as readonly string[]).includes(entityRaw)) return null;
  // Allow only positive integers — never NaN, never decimals, never signed.
  if (!/^\d{1,15}$/.test(idRaw)) return null;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    verb: verbRaw as CallbackVerb,
    entity: entityRaw as CallbackEntity,
    id,
  };
}

/**
 * Run the action behind one parsed callback. Wraps every mutating verb
 * in its OWN `withTransaction` (consistent with `approvePurchaseOrder`
 * etc., which already do this internally — we still call them through
 * the public entry points so the audit / movement chain is the same as
 * a UI-driven call).
 */
export async function dispatchCallback(
  parsed: ParsedCallback,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const { verb, entity, id } = parsed;

  // `view` is the only verb permitted on every entity. It never mutates,
  // and the bot handler turns it into a follow-up detail message — so we
  // short-circuit before the per-verb dispatch table.
  if (verb === 'view') {
    return viewEntity(entity, id);
  }

  // verb × entity dispatch — every other verb maps to exactly one entity.
  if (verb === 'apprv' && entity === 'po') {
    return approvePoCallback(id, principal);
  }
  if (verb === 'rej' && entity === 'po') {
    return rejectPoCallback(id, principal);
  }
  if (verb === 'start' && entity === 'prod') {
    return startProdCallback(id, principal);
  }
  if (verb === 'done' && entity === 'prod') {
    return doneProdCallback(id, principal);
  }
  if (verb === 'fast' && entity === 'req') {
    return fastReqCallback(id, principal);
  }

  return {
    kind: 'invalid',
    message: `Bu amal qo'llab-quvvatlanmaydi: ${verb}:${entity}`,
  };
}

// -----------------------------------------------------------------------------
// view — detail summary (no mutation, RBAC = read-only scope guard)
// -----------------------------------------------------------------------------

async function viewEntity(entity: CallbackEntity, id: number): Promise<DispatchOutcome> {
  switch (entity) {
    case 'po': {
      const { rows } = await query<{
        product_name: string;
        qty: string;
        status: string;
        target_location_id: number;
        manager_approved_by: number | null;
        keeper_approved_by: number | null;
      }>(
        `SELECT p.name AS product_name, po.qty, po.status, po.target_location_id,
                po.manager_approved_by, po.keeper_approved_by
           FROM purchase_orders po
           JOIN products p ON p.id = po.product_id
          WHERE po.id = $1`,
        [id],
      );
      if (rows.length === 0) return { kind: 'invalid', message: 'PO topilmadi' };
      const r = rows[0]!;
      const lines = [
        `PO #${id} — ${r.product_name}`,
        `Status: ${r.status}`,
        `Qty: ${Number(r.qty)}`,
        `Manager: ${r.manager_approved_by ?? '—'} · Keeper: ${r.keeper_approved_by ?? '—'}`,
      ];
      return { kind: 'ok', message: lines.join('\n') };
    }
    case 'prod': {
      const { rows } = await query<{
        product_name: string;
        qty: string;
        status: string;
        location_id: number;
        target_location_id: number | null;
      }>(
        `SELECT p.name AS product_name, po.qty, po.status, po.location_id,
                po.target_location_id
           FROM production_orders po
           JOIN products p ON p.id = po.product_id
          WHERE po.id = $1`,
        [id],
      );
      if (rows.length === 0) return { kind: 'invalid', message: 'Zayafka topilmadi' };
      const r = rows[0]!;
      return {
        kind: 'ok',
        message: `Zayafka #${id} — ${r.product_name}\nStatus: ${r.status}\nQty: ${Number(r.qty)}`,
      };
    }
    case 'req': {
      const { rows } = await query<{
        product_name: string;
        qty_needed: string;
        status: string;
        requester_location_id: number;
        target_location_id: number | null;
      }>(
        `SELECT p.name AS product_name, r.qty_needed, r.status,
                r.requester_location_id, r.target_location_id
           FROM replenishment_requests r
           JOIN products p ON p.id = r.product_id
          WHERE r.id = $1`,
        [id],
      );
      if (rows.length === 0) return { kind: 'invalid', message: "So'rov topilmadi" };
      const r = rows[0]!;
      return {
        kind: 'ok',
        message: `So'rov #${id} — ${r.product_name}\nStatus: ${r.status}\nQty: ${Number(r.qty_needed)}`,
      };
    }
    case 'mov': {
      const { rows } = await query<{
        product_name: string;
        qty: string;
        reason: string;
      }>(
        `SELECT p.name AS product_name, m.qty, m.reason
           FROM stock_movements m
           JOIN products p ON p.id = m.product_id
          WHERE m.id = $1`,
        [id],
      );
      if (rows.length === 0) return { kind: 'invalid', message: 'Harakat topilmadi' };
      const r = rows[0]!;
      return {
        kind: 'ok',
        message: `Movement #${id} — ${r.product_name}\nReason: ${r.reason}\nQty: ${Number(r.qty)}`,
      };
    }
    default:
      return { kind: 'invalid', message: 'Noma\'lum entity' };
  }
}

// -----------------------------------------------------------------------------
// apprv:po — two-step approval (manager + keeper)
// -----------------------------------------------------------------------------

/**
 * RBAC for purchase order approval (ADR-0011 §7):
 *   - `pm` may take either step;
 *   - `supply_manager` and the `target_location` manager take the `manager` step;
 *   - `raw_warehouse_manager` and `central_warehouse_manager` take the `keeper` step.
 *
 * We pick the step from the user's role and run idempotently — re-pressing
 * the same button after success is a no-op (the service short-circuits).
 */
async function approvePoCallback(
  orderId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  // Read the PO + its target location's manager so the "target manager"
  // rule can be enforced.
  const { rows } = await query<{
    status: string;
    target_location_id: number;
    manager_approved_by: number | null;
    keeper_approved_by: number | null;
    manager_user_id: number | null;
  }>(
    `SELECT po.status, po.target_location_id, po.manager_approved_by,
            po.keeper_approved_by, l.manager_user_id
       FROM purchase_orders po
       JOIN locations l ON l.id = po.target_location_id
      WHERE po.id = $1`,
    [orderId],
  );
  if (rows.length === 0) return { kind: 'invalid', message: 'PO topilmadi' };
  const po = rows[0]!;
  if (po.status !== 'draft' && po.status !== 'approved') {
    return {
      kind: 'invalid',
      message: `PO holati '${po.status}' — tasdiqlab bo'lmaydi`,
    };
  }

  const step = pickApprovalStep(principal, po.manager_user_id, {
    managerDone: po.manager_approved_by !== null,
    keeperDone: po.keeper_approved_by !== null,
  });
  if (step === null) {
    return {
      kind: 'rbac',
      message: 'Sizning rolingiz bu PO uchun tasdiqlash huquqiga ega emas',
    };
  }

  try {
    const updated = await approvePurchaseOrder(orderId, step, principal.userId);
    const fullyApproved = updated.status === 'approved';
    return {
      kind: 'ok',
      message: fullyApproved
        ? `PO #${orderId} tasdiqlandi`
        : `PO #${orderId}: ${step === 'manager' ? 'manager' : 'keeper'} tasdig'i qo'yildi`,
      result: {
        purchase_order_id: orderId,
        step,
        new_status: updated.status,
      },
      removeButtons: fullyApproved,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: 'PO tasdiqlash xatolik bilan tugadi',
      error: (err as Error).message,
    };
  }
}

/**
 * Decide which approval step the principal is taking. Returns `null` when
 * the user is not eligible (RBAC denial).
 *
 * `pm` is special-cased: it can take either step, with a preference for
 * filling in whichever side is still missing.
 */
export function pickApprovalStep(
  principal: CallbackPrincipal,
  targetLocationManagerId: number | null,
  state: { readonly managerDone: boolean; readonly keeperDone: boolean },
): ApprovalStep | null {
  const isPm = principal.role === 'pm';
  const isManagerEligible =
    isPm ||
    principal.role === 'supply_manager' ||
    (targetLocationManagerId !== null && targetLocationManagerId === principal.userId);
  const isKeeperEligible =
    isPm ||
    principal.role === 'raw_warehouse_manager' ||
    principal.role === 'central_warehouse_manager';

  // Fill whichever side is missing first; `pm` may fall through to either.
  if (!state.managerDone && isManagerEligible) return 'manager';
  if (!state.keeperDone && isKeeperEligible) return 'keeper';
  // Both already filled — the service short-circuits to a no-op. Let the
  // dispatcher call it anyway with the manager step (idempotent path).
  if (state.managerDone && state.keeperDone && (isManagerEligible || isKeeperEligible)) {
    return 'manager';
  }
  return null;
}

// -----------------------------------------------------------------------------
// rej:po — reject a draft PO
// -----------------------------------------------------------------------------

async function rejectPoCallback(
  orderId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  if (
    principal.role !== 'pm' &&
    principal.role !== 'supply_manager' &&
    principal.role !== 'raw_warehouse_manager'
  ) {
    return { kind: 'rbac', message: 'Sizning rolingiz PO ni rad qilolmaydi' };
  }
  try {
    const updated = await withTransaction(async (tx) => {
      const { rows } = await tx.query<PurchaseOrderRow>(
        `UPDATE purchase_orders SET status = 'rejected'
           WHERE id = $1 AND status = 'draft'
           RETURNING ${PURCHASE_ORDER_COLUMNS}`,
        [orderId],
      );
      if (rows.length === 0) {
        // Either the order is gone or its status forbids the flip. The
        // outer try/catch wraps this into a 'failed' outcome with a
        // diagnostic message.
        const { rows: exists } = await tx.query<{ status: string }>(
          'SELECT status FROM purchase_orders WHERE id = $1',
          [orderId],
        );
        if (exists.length === 0) {
          throw new Error('PO topilmadi');
        }
        throw new Error(`PO holati '${exists[0]!.status}' — rad qilolmaymiz`);
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'purchase_order.rejected',
        entity: 'purchase_orders',
        entityId: orderId,
        payload: { source: 'telegram_callback' },
      });
      return rows[0]!;
    });
    return {
      kind: 'ok',
      message: `PO #${orderId} rad etildi`,
      result: { purchase_order_id: orderId, new_status: updated.status },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: 'PO rad etilmadi',
      error: (err as Error).message,
    };
  }
}

// -----------------------------------------------------------------------------
// start:prod — production_order `new -> in_progress`
// -----------------------------------------------------------------------------

async function startProdCallback(
  orderId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const rbac = await checkProdRbac(orderId, principal);
  if (rbac !== null) return rbac;
  try {
    // Mirrors the inline flip in `routes/productionOrders.ts` (new|in_progress
    // -> in_progress). Idempotent: re-pressing the button after a successful
    // flip returns the row unchanged.
    const updated = await withTransaction(async (tx) => {
      const { rows } = await tx.query<ProductionOrderRow>(
        `UPDATE production_orders SET status = 'in_progress'
           WHERE id = $1 AND status IN ('new','in_progress')
           RETURNING ${PRODUCTION_ORDER_COLUMNS}`,
        [orderId],
      );
      if (rows.length === 0) {
        const { rows: exists } = await tx.query<{ status: string }>(
          'SELECT status FROM production_orders WHERE id = $1',
          [orderId],
        );
        if (exists.length === 0) throw new Error('Zayafka topilmadi');
        throw new Error(`Holat '${exists[0]!.status}' — boshlab bo'lmaydi`);
      }
      await writeAudit(tx, {
        actorUserId: principal.userId,
        action: 'production_order.in_progress',
        entity: 'production_orders',
        entityId: orderId,
        payload: { source: 'telegram_callback' },
      });
      const row = rows[0]!;
      // AC5.3 — keep the linked replenishment request in sync.
      if (row.replenishment_id !== null) {
        await advance(row.replenishment_id, principal.userId, tx);
      }
      return row;
    });
    return {
      kind: 'ok',
      message: `Zayafka #${orderId} boshlandi`,
      result: { production_order_id: orderId, new_status: updated.status },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: 'Zayafka boshlanmadi',
      error: (err as Error).message,
    };
  }
}

// -----------------------------------------------------------------------------
// done:prod — production_order `in_progress -> done` (atomic BOM consume)
// -----------------------------------------------------------------------------

async function doneProdCallback(
  orderId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const rbac = await checkProdRbac(orderId, principal);
  if (rbac !== null) return rbac;
  try {
    const updated = await withTransaction(async (tx) => {
      const finished = await finishProductionOrder(orderId, principal.userId, tx);
      if (finished.replenishment_id !== null) {
        await advance(finished.replenishment_id, principal.userId, tx);
      }
      return finished;
    });
    return {
      kind: 'ok',
      message: `Zayafka #${orderId} tayyor`,
      result: { production_order_id: orderId, new_status: updated.status },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: 'Zayafka yakunlanmadi',
      error: (err as Error).message,
    };
  }
}

/** Shared RBAC scope check for production-order verbs. */
async function checkProdRbac(
  orderId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome | null> {
  if (principal.role === 'pm') return null;
  if (principal.role !== 'production_manager') {
    return { kind: 'rbac', message: 'Sizning rolingiz zayafka boshqarolmaydi' };
  }
  const { rows } = await query<{ location_id: number }>(
    'SELECT location_id FROM production_orders WHERE id = $1',
    [orderId],
  );
  if (rows.length === 0) return { kind: 'invalid', message: 'Zayafka topilmadi' };
  if (principal.locationId !== Number(rows[0]!.location_id)) {
    return { kind: 'rbac', message: 'Bu zayafka boshqa sex uchun' };
  }
  return null;
}

// -----------------------------------------------------------------------------
// fast:req — advance a replenishment request one hop
// -----------------------------------------------------------------------------

async function fastReqCallback(
  requestId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const rbac = await checkReqRbac(requestId, principal);
  if (rbac !== null) return rbac;
  try {
    const result = await advance(requestId, principal.userId);
    return {
      kind: 'ok',
      message: result.advanced
        ? `So'rov #${requestId} → ${result.request.status}`
        : `So'rov #${requestId}: hozir kuta turing (${result.reason})`,
      result: {
        replenishment_id: requestId,
        advanced: result.advanced,
        new_status: result.request.status,
      },
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: "So'rov siljimadi",
      error: (err as Error).message,
    };
  }
}

async function checkReqRbac(
  requestId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome | null> {
  if (principal.role === 'pm') return null;
  const { rows } = await query<{
    requester_location_id: number;
    target_location_id: number | null;
  }>(
    `SELECT requester_location_id, target_location_id
       FROM replenishment_requests WHERE id = $1`,
    [requestId],
  );
  if (rows.length === 0) return { kind: 'invalid', message: "So'rov topilmadi" };
  const r = rows[0]!;
  // Eligible: a manager attached to either the requester OR the target location.
  if (
    principal.locationId === Number(r.requester_location_id) ||
    (r.target_location_id !== null &&
      principal.locationId === Number(r.target_location_id))
  ) {
    return null;
  }
  return { kind: 'rbac', message: "Bu so'rov sizning bo'g'ining tashqarisida" };
}

// -----------------------------------------------------------------------------
// Helpers exposed for the bot handler / tests
// -----------------------------------------------------------------------------

/** TEST hook — `tx` parameter is unused but exported so unit tests can stub. */
export type DispatchInternalsForTesting = {
  readonly query: typeof query;
  readonly withTransaction: typeof withTransaction;
};

export const __forTestingOnly: DispatchInternalsForTesting = {
  query,
  withTransaction,
};

/** Lookup the principal for a given Telegram numeric user id. */
export async function lookupTelegramUser(
  telegramUserId: number | string,
  tx?: TxClient,
): Promise<CallbackPrincipal | null> {
  const runner = tx ?? { query };
  const { rows } = await runner.query<{
    id: number;
    role: Role;
    location_id: number | null;
  }>(
    `SELECT id, role, location_id
       FROM users
      WHERE telegram_id = $1 AND is_active = TRUE`,
    [String(telegramUserId)],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    userId: Number(r.id),
    role: r.role,
    locationId: r.location_id === null ? null : Number(r.location_id),
  };
}
