/**
 * M6 — Purchase order service (spec section 2.6, decision D5).
 *
 * A purchase order ("Yetkazib berishga so'rov") is the two-step approval
 * supply request. Status path:
 *   draft -> (manager + keeper approvals) -> approved -> received
 *   draft -> rejected
 *
 * Two-step approval (D5, OS-5):
 *   - the `manager` step is taken by `supply_manager`;
 *   - the `keeper`  step is taken by `raw_warehouse_manager`;
 *   - `pm` may take either step (super-admin).
 * The order only becomes `approved` when BOTH `*_approved_by` columns are
 * filled (AC6.1, AC6.2) — the DB `chk_po_approved_consistency` CHECK is the
 * last line of defence; this service is the application guard.
 *
 * On `received` the purchased goods enter the raw warehouse as one atomic
 * `purchase` movement (AC6.3, invariant 1) via `applyMovement`.
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { writeAudit } from '../lib/audit.js';
import { applyMovement } from './stockMovement.js';
import {
  createNotificationsForRecipients,
  getLocationManager,
  getUsersByRole,
} from './notify.js';

export type PurchaseOrderRow = {
  id: number;
  product_id: number;
  qty: number;
  supplier_id: number | null;
  target_location_id: number;
  status: string;
  replenishment_id: number | null;
  manager_approved_by: number | null;
  manager_approved_at: Date | null;
  keeper_approved_by: number | null;
  keeper_approved_at: Date | null;
  received_movement_id: number | null;
  note: string | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
};

export const PURCHASE_ORDER_COLUMNS = `id, product_id, qty, supplier_id,
  target_location_id, status, replenishment_id, manager_approved_by,
  manager_approved_at, keeper_approved_by, keeper_approved_at,
  received_movement_id, note, created_by, created_at, updated_at`;

/** Which approval step is being taken. */
export type ApprovalStep = 'manager' | 'keeper';

/**
 * Apply one approval step. Locks the order, records the approver on the
 * matching `*_approved_by` column, and — once BOTH steps are present —
 * flips the status to `approved`. Idempotent per step: re-applying the same
 * step that is already recorded is a no-op (the order is returned unchanged).
 */
export async function approvePurchaseOrder(
  orderId: number,
  step: ApprovalStep,
  actorUserId: number | null,
  tx?: TxClient,
): Promise<PurchaseOrderRow> {
  // An approval is always taken by a human — system/cron cannot approve.
  // `manager_approved_by IS NOT NULL` is how the service detects "already
  // approved", so a null actor here would also break idempotency.
  if (actorUserId === null) {
    throw AppError.validation('A purchase order approval requires an authenticated user.');
  }
  const run = async (client: TxClient): Promise<PurchaseOrderRow> => {
    const { rows } = await client.query<PurchaseOrderRow>(
      `SELECT ${PURCHASE_ORDER_COLUMNS} FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = rows[0];
    if (order === undefined) {
      throw AppError.notFound('Purchase order not found.');
    }
    if (order.status !== 'draft' && order.status !== 'approved') {
      // Only a draft (collecting approvals) or an already-approved order
      // (idempotent re-approve) is a valid target.
      throw AppError.validation(
        `Cannot approve a purchase order in status "${order.status}".`,
      );
    }

    const alreadyManager = order.manager_approved_by !== null;
    const alreadyKeeper = order.keeper_approved_by !== null;
    if (step === 'manager' && alreadyManager) {
      return order; // idempotent
    }
    if (step === 'keeper' && alreadyKeeper) {
      return order; // idempotent
    }

    // Record this step; recompute whether both are now present.
    // This call IS the step we are taking, so the matching side counts as
    // already-approved; the other side must already be on file.
    const bothApproved = step === 'manager' ? alreadyKeeper : alreadyManager;
    const column = step === 'manager' ? 'manager' : 'keeper';
    const nextStatus = bothApproved ? 'approved' : 'draft';

    const { rows: updated } = await client.query<PurchaseOrderRow>(
      `UPDATE purchase_orders
       SET ${column}_approved_by = $2, ${column}_approved_at = now(), status = $3
       WHERE id = $1
       RETURNING ${PURCHASE_ORDER_COLUMNS}`,
      [orderId, actorUserId, nextStatus],
    );
    const result = updated[0];
    if (result === undefined) {
      throw AppError.internal('Purchase order approve update returned no row.');
    }

    await writeAudit(client, {
      actorUserId,
      action: bothApproved ? 'purchase_order.approved' : 'purchase_order.approve_step',
      entity: 'purchase_orders',
      entityId: orderId,
      payload: { step, status: nextStatus },
    });

    // M9 — purchase_request_approved notification (spec §7). Fires only when
    // BOTH approval steps have been recorded and the status flipped to
    // `approved`. Recipients: every raw_warehouse_manager (they need to
    // expect the goods) + the target location's manager + every `pm`.
    if (bothApproved) {
      const rawMgrs = await getUsersByRole(client, 'raw_warehouse_manager');
      const locationMgr = await getLocationManager(client, Number(result.target_location_id));
      const pms = await getUsersByRole(client, 'pm');
      const recipients: number[] = [];
      for (const id of [...rawMgrs, ...pms]) {
        if (!recipients.includes(id)) recipients.push(id);
      }
      if (locationMgr !== null && !recipients.includes(locationMgr)) {
        recipients.push(locationMgr);
      }
      if (recipients.length > 0) {
        const { rows: ctx } = await client.query<{
          product_name: string;
          product_unit: string;
        }>(
          `SELECT name AS product_name, unit AS product_unit
             FROM products WHERE id = $1`,
          [result.product_id],
        );
        const productName = ctx[0]?.product_name ?? `#${result.product_id}`;
        const productUnit = ctx[0]?.product_unit ?? '';
        await createNotificationsForRecipients(client, recipients, {
          type: 'purchase_request_approved',
          title: `Ta'minot tasdiqlandi #${orderId}`,
          body:
            `Ta'minot #${orderId}: ${Number(result.qty)} ${productUnit} ` +
            `${productName} — tasdiqlandi, qabul kutilmoqda.`,
          payload: {
            purchase_order_id: orderId,
            product_id: result.product_id,
            qty: Number(result.qty),
            target_location_id: result.target_location_id,
          },
        });
      }
    }

    return result;
  };

  return tx !== undefined ? run(tx) : withTransaction(run);
}

/**
 * Receive a purchase order: `approved -> received`. The purchased qty enters
 * the raw warehouse (`target_location_id`) as one atomic `purchase` movement
 * (AC6.3). Idempotent — a `received` order is returned unchanged.
 */
export async function receivePurchaseOrder(
  orderId: number,
  actorUserId: number | null,
  tx?: TxClient,
): Promise<PurchaseOrderRow> {
  const run = async (client: TxClient): Promise<PurchaseOrderRow> => {
    const { rows } = await client.query<PurchaseOrderRow>(
      `SELECT ${PURCHASE_ORDER_COLUMNS} FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const order = rows[0];
    if (order === undefined) {
      throw AppError.notFound('Purchase order not found.');
    }
    if (order.status === 'received') {
      return order; // idempotent
    }
    if (order.status !== 'approved') {
      throw AppError.validation(
        `A purchase order must be "approved" before it can be received (current: "${order.status}").`,
      );
    }

    // The purchased goods enter the raw warehouse — one atomic movement.
    const { movementId } = await applyMovement(
      {
        productId: order.product_id,
        fromLocationId: null,
        toLocationId: order.target_location_id,
        qty: Number(order.qty),
        reason: 'purchase',
        actorUserId,
        purchaseOrderId: order.id,
      },
      client,
    );

    const { rows: updated } = await client.query<PurchaseOrderRow>(
      `UPDATE purchase_orders SET status = 'received', received_movement_id = $2
       WHERE id = $1
       RETURNING ${PURCHASE_ORDER_COLUMNS}`,
      [orderId, movementId],
    );
    const result = updated[0];
    if (result === undefined) {
      throw AppError.internal('Purchase order receive update returned no row.');
    }

    await writeAudit(client, {
      actorUserId,
      action: 'purchase_order.received',
      entity: 'purchase_orders',
      entityId: orderId,
      payload: { product_id: order.product_id, qty: Number(order.qty) },
    });

    return result;
  };

  return tx !== undefined ? run(tx) : withTransaction(run);
}
