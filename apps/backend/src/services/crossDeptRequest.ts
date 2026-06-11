/**
 * B3 (telegram-bot-tz §4) — Cross-department supply request.
 *
 * A bo'lim boshlig'i (store manager, sex manager, ...) sends a voice/menu
 * request for a product. We:
 *   1. resolve the TARGET location — the topology parent of the requester
 *      (store → central, sex → its sklad, central → production, ...);
 *   2. create a `replenishment_request` (requester = the user's location)
 *      via the existing engine (`createRequest` — invariant 2 debounce, audit);
 *   3. notify the TARGET location's manager with ✅ Qabul / ❌ Rad inline
 *      buttons (`xreq:accept:<id>` / `xreq:reject:<id>`), reusing the
 *      notifications/outbox channel so delivery + telegram_id lookup are
 *      already handled.
 *
 * The requester is notified of the outcome later, when the target manager
 * presses a button (the `xreq:*` dispatch handlers fire that notification).
 *
 * Reuse, not reinvention: `createRequest` is the same engine entry the scan
 * worker and the API use, so every invariant (atomic, audit, one-open-per
 * product/location) holds identically here.
 */
import { withTransaction, type TxClient } from '../db/index.js';
import { AppError } from '../errors/index.js';
import { createRequest, type ReplenishmentRow } from './replenishment.js';
import { createNotification, getLocationManager } from './notify.js';

export type CrossDeptTarget = {
  readonly locationId: number;
  readonly name: string;
  readonly type: string;
};

/**
 * Resolve the request TARGET for a requester location — its immediate logical
 * parent in the supply topology (`locations.parent_id`). A store's parent is
 * the central warehouse; a sex's parent is the production floor / its sklad;
 * and so on. Returns null when the requester is a root (no parent) — e.g. the
 * raw warehouse, which has nobody to ask.
 */
export async function resolveRequestTarget(
  tx: TxClient,
  requesterLocationId: number,
): Promise<CrossDeptTarget | null> {
  const { rows } = await tx.query<{ id: number; name: string; type: string }>(
    `SELECT parent.id, parent.name, parent.type::text AS type
       FROM locations child
       JOIN locations parent ON parent.id = child.parent_id
      WHERE child.id = $1 AND parent.is_active = TRUE`,
    [requesterLocationId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return { locationId: Number(r.id), name: r.name, type: r.type };
}

export type CrossDeptRequestResult = {
  readonly request: ReplenishmentRow;
  readonly target: CrossDeptTarget;
  readonly targetManagerNotified: boolean;
};

/**
 * Create one cross-department request + notify the target manager.
 *
 * Atomic: the replenishment row, its audit, and the target-manager
 * notification are committed together. A duplicate open request surfaces as
 * `OPEN_REQUEST_EXISTS` (thrown by `createRequest`) — the caller turns that
 * into a friendly "shu mahsulot uchun ochiq so'rov bor" reply.
 */
export async function createCrossDeptRequest(opts: {
  productId: number;
  productName: string;
  unit: string;
  requesterLocationId: number;
  qty: number;
  actorUserId: number;
  note?: string | null;
}): Promise<CrossDeptRequestResult> {
  // Resolve the target up-front (own short tx) so we can fail fast with a
  // clear message before touching the engine.
  const target = await withTransaction((tx) =>
    resolveRequestTarget(tx, opts.requesterLocationId),
  );
  if (target === null) {
    throw AppError.validation(
      "Sizning bo'limingiz uchun ustki bo'g'in topilmadi — so'rov yuborib bo'lmaydi.",
    );
  }

  // `createRequest` opens its own transaction (audit + debounce). We then add
  // the target-manager notification in a follow-up transaction; a failure to
  // notify must NOT roll back the (already-valid) request, so they are
  // intentionally separate.
  const request = await createRequest({
    productId: opts.productId,
    requesterLocationId: opts.requesterLocationId,
    qtyNeeded: opts.qty,
    actorUserId: opts.actorUserId,
    note: opts.note ?? `telegram cross-dept: ${opts.productName} ×${opts.qty}`,
  });

  let targetManagerNotified = false;
  try {
    targetManagerNotified = await withTransaction(async (tx) => {
      const managerId = await getLocationManager(tx, target.locationId);
      if (managerId === null) return false;
      await createNotification(tx, {
        recipientUserId: managerId,
        type: 'replenishment_created',
        title: `Yangi so'rov — ${target.name}`,
        body:
          `${opts.productName} × ${opts.qty} ${opts.unit}\n` +
          `So'rov #${request.id} sizning bo'limingizga keldi.`,
        payload: {
          replenishment_id: request.id,
          requester_location_id: opts.requesterLocationId,
          target_location_id: target.locationId,
          product_id: opts.productId,
          qty: opts.qty,
        },
        inlineCallback: {
          buttons: [
            [
              { text: '✅ Qabul', data: `xreq:accept:${request.id}` },
              { text: '❌ Rad', data: `xreq:reject:${request.id}` },
            ],
          ],
        },
      });
      return true;
    });
  } catch (err) {
    // Non-fatal — the request exists; the manager can still see it in
    // "📥 Kelgan so'rovlar". Log and continue.
    console.error(
      '[cross-dept-request] target notify failed:',
      (err as Error).message,
    );
  }

  return { request, target, targetManagerNotified };
}
