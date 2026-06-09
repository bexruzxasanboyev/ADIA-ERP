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
import { writeAudit, poolRunner } from '../../lib/audit.js';
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
import {
  advance,
  acceptByCentral,
  acceptByFulfiller,
  cancelRequestByFulfiller,
} from '../../services/replenishment.js';
import {
  confirmAction,
  rejectAction,
} from '../../services/assistantActions.js';
import {
  answerDialog,
  cancelDialog,
  getDialog,
} from '../../services/productionDialog.js';
import { generateNakladnoyFromVoice } from '../../services/voiceNakladnoy.js';
import {
  createNotification,
  getPmRecipients,
  getLocationManager,
} from '../../services/notify.js';
import type { AuthPrincipal } from '../../auth/jwt.js';

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

/** Recognised verbs (ADR-0011 §3 + F4.3 / ADR-0014). */
export const CALLBACK_VERBS = [
  'view',
  'apprv',
  'rej',
  'start',
  'done',
  'fast',
  // F4.3 — voice flow.
  'apprv_all',
  'rej_all',
  'clarify',
  // EPIC 8.6 — voice → nakladnoy (do'kon FINISHED mahsulot oldi).
  'nakl',
  // EPIC 5 / ADR-0016 — production dialog answer/cancel.
  'dlg',
  'dlgx',
  // B4 (telegram-bot-tz §4) — cross-department request accept / reject. The
  // callback data is `xreq:accept:<id>` / `xreq:reject:<id>` — the second
  // segment carries the sub-action (accept|reject) rather than an entity, so
  // these are parsed by a dedicated branch in `parseCallbackData`.
  'xreq',
] as const;
export type CallbackVerb = (typeof CALLBACK_VERBS)[number];

/** Recognised entities (ADR-0011 §3 + F4.3 / ADR-0014). */
export const CALLBACK_ENTITIES = [
  'po',
  'prod',
  'req',
  'mov',
  // F4.3 — `act` (assistant_action), `vmsg` (voice_message).
  'act',
  'vmsg',
  // EPIC 5 / ADR-0016 — `pdlg` (production_dialog_session).
  'pdlg',
] as const;
export type CallbackEntity = (typeof CALLBACK_ENTITIES)[number];

/**
 * Parsed callback data. Standard `verb:entity:id` triple plus optional
 * `extraId` for 4-segment payloads (e.g. `clarify:vmsg:<voiceId>:<productId>`).
 */
export type ParsedCallback = {
  readonly verb: CallbackVerb;
  readonly entity: CallbackEntity;
  readonly id: number;
  readonly extraId: number | null;
  /**
   * B4 — for the `xreq` verb the second segment is a STRING sub-action
   * (`accept` | `reject`), not a numeric entity. It is parsed here and the
   * `entity` field is set to the synthetic `req` so the rest of the pipeline
   * (RBAC scope, audit) keeps working with a real entity.
   */
  readonly subAction?: 'accept' | 'reject';
};

/**
 * Parse the raw `callback_data`. Accepts:
 *   - `verb:entity:id`               — 3 segments (standard).
 *   - `verb:entity:id:extraId`       — 4 segments (e.g. `clarify:vmsg:42:7`).
 *
 * Returns `null` for anything else.
 */
export function parseCallbackData(raw: string): ParsedCallback | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 64) return null;
  const parts = raw.split(':');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const verbRaw = parts[0]!;
  const entityRaw = parts[1]!;
  const idRaw = parts[2]!;

  // B4 — `xreq:accept:<id>` / `xreq:reject:<id>` — the 2nd segment is a string
  // sub-action. Validate it here and synthesize a `req`-entity ParsedCallback.
  if (verbRaw === 'xreq') {
    if (parts.length !== 3) return null;
    if (entityRaw !== 'accept' && entityRaw !== 'reject') return null;
    if (!/^\d{1,15}$/.test(idRaw)) return null;
    const reqId = Number(idRaw);
    if (!Number.isInteger(reqId) || reqId <= 0) return null;
    return {
      verb: 'xreq',
      entity: 'req',
      id: reqId,
      extraId: null,
      subAction: entityRaw,
    };
  }

  const extraRaw = parts[3];
  if (!(CALLBACK_VERBS as readonly string[]).includes(verbRaw)) return null;
  if (!(CALLBACK_ENTITIES as readonly string[]).includes(entityRaw)) return null;
  if (!/^\d{1,15}$/.test(idRaw)) return null;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return null;
  let extraId: number | null = null;
  if (extraRaw !== undefined) {
    if (!/^\d{1,15}$/.test(extraRaw)) return null;
    const n = Number(extraRaw);
    if (!Number.isInteger(n) || n <= 0) return null;
    extraId = n;
  }
  // 4-segment formati `clarify` (voice) va `dlg` (production dialog answer)
  // verblari uchun — `dlg:pdlg:<id>:<optionCode>`.
  if (parts.length === 4 && verbRaw !== 'clarify' && verbRaw !== 'dlg') return null;
  return {
    verb: verbRaw as CallbackVerb,
    entity: entityRaw as CallbackEntity,
    id,
    extraId,
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

  // ---- F4.3 / ADR-0014 — voice flow batch + clarify verbs --------------
  if (verb === 'apprv' && entity === 'act') {
    return apprvActCallback(id, principal);
  }
  if (verb === 'rej' && entity === 'act') {
    return rejActCallback(id, principal);
  }
  if (verb === 'apprv_all' && entity === 'vmsg') {
    return apprvAllVoiceCallback(id, principal);
  }
  if (verb === 'rej_all' && entity === 'vmsg') {
    return rejAllVoiceCallback(id, principal);
  }
  if (verb === 'clarify' && entity === 'vmsg' && parsed.extraId !== null) {
    return clarifyVoiceCallback(id, parsed.extraId, principal);
  }
  if (verb === 'nakl' && entity === 'act') {
    return naklActCallback(id, principal);
  }

  // ---- EPIC 5 / ADR-0016 — production dialog answer / cancel ------------
  if (verb === 'dlg' && entity === 'pdlg' && parsed.extraId !== null) {
    return answerDialogCallback(id, parsed.extraId, principal);
  }
  if (verb === 'dlgx' && entity === 'pdlg') {
    return cancelDialogCallback(id, principal);
  }

  // ---- B4 (telegram-bot-tz §4) — cross-department request accept / reject -
  if (verb === 'xreq' && parsed.subAction === 'accept') {
    return xreqAcceptCallback(id, principal);
  }
  if (verb === 'xreq' && parsed.subAction === 'reject') {
    return xreqRejectCallback(id, principal);
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
        message:
          `So'rov #${id} — ${r.product_name}\n` +
          `Holat: ${describeRequestStatus(r.status)}\n` +
          `Miqdor: ${Number(r.qty_needed)}`,
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

/**
 * Human, requester-facing label for a replenishment status. The raw machine
 * status (`NEW`, `CHECK_STORE_SUPPLIER`, …) is meaningless to a do'konchi —
 * what they need to know is "where is my request in the pipeline". A do'konchi
 * who taps "Ko'rish" on their just-sent request should read "Markaziy sklad
 * qabul qilishini kutmoqda", not a bare "NEW".
 */
function describeRequestStatus(status: string): string {
  switch (status) {
    case 'NEW':
    case 'CHECK_STORE_SUPPLIER':
      return 'Markaziy sklad qabul qilishini kutmoqda';
    case 'CHECK_PRODUCTION_INPUT':
    case 'CREATE_PURCHASE_ORDER':
    case 'CREATE_PRODUCTION_ORDER':
    case 'PRODUCING':
      return 'Ishlab chiqarilmoqda / tayyorlanmoqda';
    case 'DONE_TO_WAREHOUSE':
      return 'Markaziy skladda — jo\'natishga tayyor';
    case 'SHIP_TO_REQUESTER':
      return 'Sizga jo\'natilmoqda';
    case 'CLOSED':
      return 'Yakunlandi';
    case 'CANCELLED':
      return 'Bekor qilindi';
    default:
      return status;
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
// B4 (telegram-bot-tz §4) — cross-department request accept / reject
// -----------------------------------------------------------------------------

/**
 * RBAC for an `xreq:*` press: only the TARGET location's manager OR a
 * `central_warehouse_manager` (the default fulfiller) — or `pm` — may act.
 *
 * The target may still be unresolved (a store request that has not yet been
 * advanced past NEW). In that case we resolve the topology PARENT of the
 * requester (the same parent the notification was addressed to) and check the
 * presser against ITS manager, so the intended fulfiller can act before the
 * engine pins the central warehouse.
 */
async function checkXreqRbac(
  requestId: number,
  principal: CallbackPrincipal,
): Promise<{ ok: true; target: { id: number | null } } | { ok: false; outcome: DispatchOutcome }> {
  if (principal.role === 'pm') return { ok: true, target: { id: null } };

  const { rows } = await query<{
    requester_location_id: number;
    target_location_id: number | null;
    status: string;
  }>(
    `SELECT requester_location_id, target_location_id, status
       FROM replenishment_requests WHERE id = $1`,
    [requestId],
  );
  if (rows.length === 0) {
    return { ok: false, outcome: { kind: 'invalid', message: "So'rov topilmadi" } };
  }
  const r = rows[0]!;

  // central_warehouse_manager is always an eligible fulfiller (default target).
  if (principal.role === 'central_warehouse_manager') {
    return { ok: true, target: { id: r.target_location_id } };
  }

  // Otherwise the presser must manage the target location. Resolve the
  // effective target: the pinned one, else the requester's topology parent.
  let targetLocationId = r.target_location_id;
  if (targetLocationId === null) {
    const { rows: prows } = await query<{ parent_id: number | null }>(
      `SELECT parent_id FROM locations WHERE id = $1`,
      [r.requester_location_id],
    );
    targetLocationId = prows[0]?.parent_id ?? null;
  }
  if (
    targetLocationId !== null &&
    principal.locationId !== null &&
    principal.locationId === Number(targetLocationId)
  ) {
    return { ok: true, target: { id: targetLocationId } };
  }
  return {
    ok: false,
    outcome: {
      kind: 'rbac',
      message: "Bu so'rovni faqat maqsad bo'lim boshlig'i qabul/rad qila oladi",
    },
  };
}

/** Notify the requester location manager of the xreq outcome (best-effort). */
async function notifyRequesterOfOutcome(
  requestId: number,
  outcome: 'accepted' | 'rejected',
  detail: string,
): Promise<void> {
  try {
    await withTransaction(async (tx) => {
      const { rows } = await tx.query<{
        requester_location_id: number;
        product_id: number;
      }>(
        `SELECT requester_location_id, product_id
           FROM replenishment_requests WHERE id = $1`,
        [requestId],
      );
      const r = rows[0];
      if (r === undefined) return;
      const managerId = await getLocationManager(tx, Number(r.requester_location_id));
      if (managerId === null) return;
      const title =
        outcome === 'accepted' ? "So'rov qabul qilindi" : "So'rov rad etildi";
      await createNotification(tx, {
        recipientUserId: managerId,
        type: outcome === 'accepted' ? 'shipment_created' : 'replenishment_created',
        title,
        body: `So'rov #${requestId}: ${detail}`,
        payload: { replenishment_id: requestId, outcome },
      });
    });
  } catch (err) {
    console.error('[xreq] requester notify failed:', (err as Error).message);
  }
}

/** xreq:accept:<id> — the target manager accepts → engine ships to requester. */
async function xreqAcceptCallback(
  requestId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const rbac = await checkXreqRbac(requestId, principal);
  if (!rbac.ok) return rbac.outcome;

  // The acting location is the presser's own location (the target). For `pm`
  // (no location) or central_warehouse_manager we fall back to the request's
  // pinned target / topology parent so `acceptByCentral` has a warehouse to
  // ship from.
  let centralLocationId = principal.locationId ?? rbac.target.id;
  if (centralLocationId === null) {
    const { rows } = await query<{
      target_location_id: number | null;
      requester_location_id: number;
    }>(
      `SELECT target_location_id, requester_location_id
         FROM replenishment_requests WHERE id = $1`,
      [requestId],
    );
    const r = rows[0];
    if (r !== undefined) {
      if (r.target_location_id !== null) {
        centralLocationId = Number(r.target_location_id);
      } else {
        const { rows: prows } = await query<{ parent_id: number | null }>(
          `SELECT parent_id FROM locations WHERE id = $1`,
          [r.requester_location_id],
        );
        centralLocationId = prows[0]?.parent_id ?? null;
      }
    }
  }
  if (centralLocationId === null) {
    return {
      kind: 'invalid',
      message: "Maqsad bo'lim aniqlanmadi — so'rovni qabul qilib bo'lmadi",
    };
  }

  // IMPORTANT-4 — branch on the target location TYPE. A cross-dept request can
  // target a NON-central parent (sex -> its sklad, central -> production).
  // `acceptByCentral` forces the central code path (and cascades into the
  // central production/purchase chain on a short target), which is wrong for a
  // non-central fulfiller. So: central_warehouse -> acceptByCentral; anything
  // else -> the generic acceptByFulfiller (ship from the fulfiller's own stock,
  // else hold — no central-only assumptions).
  let targetType: string | null = null;
  {
    const { rows } = await query<{ type: string }>(
      `SELECT type::text AS type FROM locations WHERE id = $1`,
      [centralLocationId],
    );
    targetType = rows[0]?.type ?? null;
  }

  try {
    const result =
      targetType === 'central_warehouse'
        ? await acceptByCentral({
            requestId,
            centralLocationId,
            actorUserId: principal.userId,
          })
        : await acceptByFulfiller({
            requestId,
            fulfillerLocationId: centralLocationId,
            actorUserId: principal.userId,
          });
    const msg = result.shipped
      ? `So'rov #${requestId} qabul qilindi va jo'natildi`
      : `So'rov #${requestId} qabul qilindi (jo'natish kutilmoqda: ${result.reason})`;
    await notifyRequesterOfOutcome(
      requestId,
      'accepted',
      result.shipped ? 'qabul qilindi va jo\'natildi' : 'qabul qilindi',
    );
    return {
      kind: 'ok',
      message: msg,
      result: {
        replenishment_id: requestId,
        shipped: result.shipped,
        new_status: result.request.status,
      },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: "So'rovni qabul qilib bo'lmadi",
      error: (err as Error).message,
    };
  }
}

/** xreq:reject:<id> — the target manager refuses → request CANCELLED. */
async function xreqRejectCallback(
  requestId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const rbac = await checkXreqRbac(requestId, principal);
  if (!rbac.ok) return rbac.outcome;
  try {
    const updated = await cancelRequestByFulfiller(
      requestId,
      principal.userId,
      'Telegram: target manager rejected',
    );
    await notifyRequesterOfOutcome(requestId, 'rejected', 'rad etildi');
    return {
      kind: 'ok',
      message: `So'rov #${requestId} rad etildi`,
      result: { replenishment_id: requestId, new_status: updated.status },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: "So'rovni rad etib bo'lmadi",
      error: (err as Error).message,
    };
  }
}

// -----------------------------------------------------------------------------
// F4.3 / ADR-0014 — voice flow callback handlers
// -----------------------------------------------------------------------------

/**
 * Telegram `CallbackPrincipal` ni `AuthPrincipal` ga aylantirish (voice flow).
 * `assistantActions.confirmAction/rejectAction` to'liq AuthPrincipal kutadi.
 * locationIds DB dan o'qiladi (M:N).
 */
async function toAuthPrincipal(
  cp: CallbackPrincipal,
): Promise<AuthPrincipal> {
  const { rows } = await query<{ location_id: number }>(
    `SELECT location_id FROM user_locations WHERE user_id = $1`,
    [cp.userId],
  );
  const locationIds =
    rows.length > 0
      ? rows.map((r) => Number(r.location_id))
      : cp.locationId === null
        ? []
        : [cp.locationId];
  return {
    userId: cp.userId,
    role: cp.role,
    locationId: cp.locationId,
    locationIds,
    activeLocationId: cp.locationId,
  };
}

/** Single action confirm (apprv:act:<id>). */
async function apprvActCallback(
  actionId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  try {
    const auth = await toAuthPrincipal(principal);
    const { action } = await confirmAction(actionId, auth);
    // Domain-clear post-confirm reply. A `create_replenishment_request`
    // confirmed by a store manager (do'konchi) is an OUTGOING request to the
    // central warehouse — the requester does NOT fulfil it, so the reply must
    // read "sent to the central warehouse", not a generic "Bajarildi". Other
    // tool types keep their own success phrasing.
    const message =
      action.tool_name === 'create_replenishment_request'
        ? `✅ So'rovingiz markaziy skladga yuborildi.\n${action.summary}`
        : `✅ Bajarildi: ${action.summary}`;
    return {
      kind: 'ok',
      message,
      result: {
        assistant_action_id: actionId,
        tool_name: action.tool_name,
        result: action.result,
      },
      removeButtons: true,
    };
  } catch (err) {
    const message = (err as Error).message;
    return {
      kind: 'failed',
      message: `Bajarib bo'lmadi`,
      error: message,
    };
  }
}

/** Single action reject (rej:act:<id>). */
async function rejActCallback(
  actionId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  try {
    const auth = await toAuthPrincipal(principal);
    const row = await rejectAction(actionId, auth);
    return {
      kind: 'ok',
      message: `❌ Rad etildi: ${row.summary}`,
      result: { assistant_action_id: actionId },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: 'Rad etib bo\'lmadi',
      error: (err as Error).message,
    };
  }
}

/**
 * "Hammasi tasdiq" — voice message ga bog'liq barcha pending action'larni
 * topib, har birini alohida tranzaksiyada `confirmAction` orqali bajarish.
 * Bitta action xato bo'lsa ham qolganlarini bajaramiz (per-action atomar).
 */
async function apprvAllVoiceCallback(
  voiceId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const { rows } = await query<{ id: string; summary: string }>(
    `SELECT id, summary FROM assistant_actions
      WHERE voice_message_id = $1 AND status = 'pending' AND user_id = $2`,
    [voiceId, principal.userId],
  );
  if (rows.length === 0) {
    return {
      kind: 'invalid',
      message: "Bajariladigan amallar topilmadi (allaqachon yopilgan).",
    };
  }
  const auth = await toAuthPrincipal(principal);
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const r of rows) {
    try {
      await confirmAction(Number(r.id), auth);
      ok += 1;
    } catch (err) {
      failed += 1;
      errors.push(`#${r.id}: ${(err as Error).message}`);
    }
  }
  await markVoiceExecutedIfDone(voiceId);
  const tail = errors.length === 0 ? '' : `\nXatolar:\n${errors.join('\n').slice(0, 300)}`;
  return {
    kind: 'ok',
    message: `${ok} ta bajarildi${failed > 0 ? `, ${failed} ta rad/xato` : ''}.${tail}`,
    result: { voice_message_id: voiceId, ok, failed },
    removeButtons: true,
  };
}

/** "Hammasi rad" — barcha pending'larni rad etish. */
async function rejAllVoiceCallback(
  voiceId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM assistant_actions
      WHERE voice_message_id = $1 AND status = 'pending' AND user_id = $2`,
    [voiceId, principal.userId],
  );
  if (rows.length === 0) {
    return {
      kind: 'invalid',
      message: 'Bekor qilinadigan amallar topilmadi.',
    };
  }
  const auth = await toAuthPrincipal(principal);
  let rejected = 0;
  for (const r of rows) {
    try {
      await rejectAction(Number(r.id), auth);
      rejected += 1;
    } catch {
      // Already non-pending; skip.
    }
  }
  await markVoiceExecutedIfDone(voiceId);
  return {
    kind: 'ok',
    message: `${rejected} ta amal rad etildi.`,
    result: { voice_message_id: voiceId, rejected },
    removeButtons: true,
  };
}

/**
 * Clarify — voice message clarifying flow.
 * Foydalanuvchi tanlagan productId asosida shu voice'dagi clarification
 * action(lar) ni yangi pending `adjust_stock` ga aylantiradi.
 *
 * MVP yondashuvi: shu voice'da pending `clarify_product` qatorlari yo'q —
 * clarification voice ichida product topilmaganda **action yaratilmagan**
 * edi. Shuning uchun bu callback foydalanuvchi tanlovini audit ga yozadi
 * va `voice_messages.intent_parse_result` ga tanlangan productId ni qo'shadi.
 * Pending action keyingi voice xabarda yoki UI da yaratiladi (kelajak iter).
 */
async function clarifyVoiceCallback(
  voiceId: number,
  productId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const { rows } = await query<{ id: string; user_id: string; transcript: string | null }>(
    `SELECT id, user_id, transcript FROM voice_messages WHERE id = $1`,
    [voiceId],
  );
  const vm = rows[0];
  if (vm === undefined) {
    return { kind: 'invalid', message: 'Voice xabar topilmadi.' };
  }
  if (Number(vm.user_id) !== principal.userId && principal.role !== 'pm') {
    return { kind: 'rbac', message: 'Bu voice xabar siznikiga tegishli emas.' };
  }
  // Mahsulot mavjudligini tasdiqlash.
  const { rows: prodRows } = await query<{ id: string; name: string; unit: string }>(
    `SELECT id, name, unit::text AS unit FROM products WHERE id = $1 AND is_active = TRUE`,
    [productId],
  );
  if (prodRows[0] === undefined) {
    return { kind: 'invalid', message: 'Mahsulot topilmadi.' };
  }
  await writeAudit(poolRunner, {
    actorUserId: principal.userId,
    action: 'voice_message.clarify',
    entity: 'voice_messages',
    entityId: voiceId,
    payload: { selected_product_id: productId, transcript: vm.transcript },
  });
  return {
    kind: 'ok',
    message: `Tanlovingiz qabul qilindi: ${prodRows[0].name}. Iltimos, ovoz xabarini takrorlang yoki UI orqali harakat yarating.`,
    result: { voice_message_id: voiceId, product_id: productId },
    removeButtons: false,
  };
}

/**
 * EPIC 8.6 — nakl:act:<actionId> — do'kon ovozli xabaridan kelgan FINISHED
 * mahsulot kirimi uchun `voice` material nakladnoy yaratish.
 *
 * Staged action (`assistant_actions`) ning `args` JSONB'idan product_id + qty +
 * maqsad lokatsiyani o'qiymiz (adjust_stock yoki transfer_stock). Mahsulot
 * `finished` va lokatsiya `store` bo'lishini qayta tekshiramiz (button stale
 * bo'lishi mumkin), so'ng `generateNakladnoyFromVoice` (8.4 BOM expansion'ni
 * reuse qiladi). Stock O'ZGARMAYDI — bu faqat hujjat (egasi qarori). PM +
 * do'kon manageriga bildirishnoma.
 *
 * RBAC: action egasi (`user_id`) yoki pm. Idempotent emas — har bosishda yangi
 * hujjat; lekin tugma `removeButtons` bilan olib tashlanadi.
 */
async function naklActCallback(
  actionId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const { rows } = await query<{
    user_id: string;
    tool_name: string;
    args: Record<string, unknown>;
    voice_message_id: string | null;
  }>(
    `SELECT user_id, tool_name, args, voice_message_id
       FROM assistant_actions WHERE id = $1`,
    [actionId],
  );
  const act = rows[0];
  if (act === undefined) return { kind: 'invalid', message: 'Amal topilmadi' };
  if (Number(act.user_id) !== principal.userId && principal.role !== 'pm') {
    return { kind: 'rbac', message: 'Bu amal sizga tegishli emas' };
  }

  const args = act.args ?? {};
  const productId = toPositiveInt(args.product_id);
  // adjust_stock → location_id + delta(>0); transfer_stock → to_location_id + qty.
  const locationId =
    toPositiveInt(args.location_id) ?? toPositiveInt(args.to_location_id);
  const qty =
    act.tool_name === 'transfer_stock'
      ? toPositiveNumber(args.qty)
      : toPositiveNumber(args.delta);

  if (productId === null || locationId === null || qty === null) {
    return {
      kind: 'invalid',
      message: 'Nakladnoy uchun mahsulot/miqdor/lokatsiya aniq emas',
    };
  }

  // Stale-button guard — mahsulot finished va lokatsiya store ekanini qayta
  // tasdiqlaymiz.
  const { rows: chk } = await query<{ ptype: string; ltype: string }>(
    `SELECT p.type::text AS ptype, l.type::text AS ltype
       FROM products p, locations l
      WHERE p.id = $1 AND l.id = $2`,
    [productId, locationId],
  );
  const meta = chk[0];
  if (meta === undefined || meta.ptype !== 'finished' || meta.ltype !== 'store') {
    return {
      kind: 'invalid',
      message: 'Nakladnoy faqat do\'kon oladigan tayyor mahsulot uchun',
    };
  }

  try {
    const result = await withTransaction(async (tx) => {
      const nak = await generateNakladnoyFromVoice(
        {
          voiceMessageId:
            act.voice_message_id === null ? actionId : Number(act.voice_message_id),
          productId,
          qty,
          locationId,
          actorUserId: principal.userId,
          note: `voice→nakladnoy (action ${actionId})`,
        },
        tx,
      );
      // PM + do'kon manageriga bildirishnoma.
      const recipients = new Set<number>([principal.userId]);
      for (const pm of await getPmRecipients(tx)) recipients.add(pm);
      const manager = await getLocationManager(tx, locationId);
      if (manager !== null) recipients.add(manager);
      const body =
        `Mahsulot #${productId} — ${qty} ${nak.lines[0]?.unit ?? ''}\n` +
        `Nakladnoy #${nak.header.id} (ovozli xabardan).`;
      for (const userId of recipients) {
        await createNotification(tx, {
          recipientUserId: userId,
          type: 'nakladnoy_created',
          title: 'Yangi nakladnoy (ovozli)',
          body,
          payload: { nakladnoy_id: nak.header.id, location_id: locationId },
        });
      }
      return nak;
    });
    return {
      kind: 'ok',
      message: `📄 Nakladnoy #${result.header.id} yaratildi`,
      result: { nakladnoy_id: result.header.id, line_count: result.lines.length },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: 'Nakladnoy yaratib bo\'lmadi',
      error: (err as Error).message,
    };
  }
}

function toPositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toPositiveNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function markVoiceExecutedIfDone(voiceId: number): Promise<void> {
  const { rows } = await query<{ remaining: string }>(
    `SELECT count(*) AS remaining FROM assistant_actions
      WHERE voice_message_id = $1 AND status = 'pending'`,
    [voiceId],
  );
  const remaining = Number(rows[0]?.remaining ?? '0');
  if (remaining > 0) return;
  await query(
    `UPDATE voice_messages SET status = 'executed', processed_at = now()
      WHERE id = $1 AND status = 'actions_pending'`,
    [voiceId],
  );
}

// -----------------------------------------------------------------------------
// EPIC 5 / ADR-0016 — production dialog callbacks
// -----------------------------------------------------------------------------

/**
 * Option codes for the production dialog inline buttons. Telegram callback
 * data is numeric-only (`dlg:pdlg:<id>:<code>`), so the option STRINGS used by
 * the service are mapped to short numeric codes here and back. The outbox
 * worker that renders the dialog buttons MUST use the same mapping.
 */
const DIALOG_OPTION_BY_CODE: Readonly<Record<number, string>> = {
  1: 'ready',
  2: 'zero',
  3: 'mixed',
  4: 'make',
  5: 'buy',
};
export const DIALOG_CODE_BY_OPTION: Readonly<Record<string, number>> = {
  ready: 1,
  zero: 2,
  mixed: 3,
  make: 4,
  buy: 5,
};

/**
 * Shared RBAC scope check for production dialog verbs — the presser must be
 * `pm` OR the production_manager whose location owns the dialog.
 */
async function checkDialogRbac(
  dialogId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome | null> {
  const session = await getDialog(dialogId);
  if (session === null) return { kind: 'invalid', message: 'Dialog topilmadi' };
  if (principal.role === 'pm') return null;
  if (principal.role !== 'production_manager') {
    return { kind: 'rbac', message: 'Sizning rolingiz bu dialogga javob berolmaydi' };
  }
  if (principal.locationId !== session.location_id) {
    return { kind: 'rbac', message: 'Bu dialog boshqa sex uchun' };
  }
  return null;
}

/** dlg:pdlg:<id>:<optionCode> — answer one production dialog question. */
async function answerDialogCallback(
  dialogId: number,
  optionCode: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const optionId = DIALOG_OPTION_BY_CODE[optionCode];
  if (optionId === undefined) {
    return { kind: 'invalid', message: "Noto'g'ri tanlov kodi" };
  }
  const rbac = await checkDialogRbac(dialogId, principal);
  if (rbac !== null) return rbac;
  try {
    const result = await answerDialog({
      dialogId,
      optionId,
      actorUserId: principal.userId,
    });
    const docs = result.created_requests.length;
    const docNote = docs > 0 ? ` (${docs} ta so'rovnoma/buyurtma yaratildi)` : '';
    if (result.resolved) {
      return {
        kind: 'ok',
        message: `Dialog #${dialogId} yakunlandi${docNote}`,
        result: { dialog_id: dialogId, resolved: true, created: docs },
        removeButtons: true,
      };
    }
    // Q2 — the bot's next nudge (with the new options) is delivered by the
    // outbox worker; here we just confirm Q1 was recorded and strip Q1's
    // buttons so the user does not re-answer the same question.
    return {
      kind: 'ok',
      message: `Qabul qilindi${docNote}. Keyingi savol yuboriladi.`,
      result: {
        dialog_id: dialogId,
        resolved: false,
        next_state: result.session.state,
        created: docs,
      },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: 'Dialogga javob berib bo\'lmadi',
      error: (err as Error).message,
    };
  }
}

/** dlgx:pdlg:<id> — cancel an open production dialog. */
async function cancelDialogCallback(
  dialogId: number,
  principal: CallbackPrincipal,
): Promise<DispatchOutcome> {
  const rbac = await checkDialogRbac(dialogId, principal);
  if (rbac !== null) return rbac;
  try {
    const updated = await cancelDialog({ dialogId, actorUserId: principal.userId });
    return {
      kind: 'ok',
      message: `Dialog #${dialogId} bekor qilindi`,
      result: { dialog_id: dialogId, new_state: updated.state },
      removeButtons: true,
    };
  } catch (err) {
    return {
      kind: 'failed',
      message: 'Dialog bekor qilinmadi',
      error: (err as Error).message,
    };
  }
}

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
