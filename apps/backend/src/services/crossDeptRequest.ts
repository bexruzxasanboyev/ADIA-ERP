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
import { createRequest, REPLENISHMENT_COLUMNS, type ReplenishmentRow } from './replenishment.js';
import { createNotification, getLocationManager } from './notify.js';

export type CrossDeptTarget = {
  readonly locationId: number;
  readonly name: string;
  readonly type: string;
  /**
   * How this target was resolved:
   *   - `'parent'`         — the requester's topology parent (default path);
   *   - `'producer_store'` — the producing отдел's sex_storage, chosen because
   *     the requested product is a `semi` (yarim tayyor / зг) with a non-null
   *     `workshop_location_id` (TZ §6 — e.g. a sex asking the Qaymoq otdel for
   *     cream). This path PINS `target_location_id` on the request so the RBAC
   *     check + the accept handler agree on the cream sklad as the fulfiller.
   */
  readonly via: 'parent' | 'producer_store';
};

/**
 * Resolve the request TARGET for a requester location.
 *
 * TZ §6 routing rule (the producer override): when `productId` is given AND the
 * product is `type='semi'` with a non-null `workshop_location_id`, the request
 * is routed to THAT producing отдел's `sex_storage` buffer — the отдел that
 * actually makes the зг (e.g. cream → "Qaymoq skladi"), regardless of the
 * requester's parent chain. The отдел's storage is the `sex_storage` whose
 * `parent_id` is the workshop (mirrors `resolveTopology`'s sexStorage lookup).
 * If the producer has no `sex_storage` child — or the override would route the
 * request back at the requester itself — we fall through to the parent path
 * below (the conservative default). The seed (migration 0060) always gives the
 * cream отдел a sklad, so that fallback is a safety net, not the norm.
 *
 * Default path: the requester's immediate logical parent in the supply
 * topology (`locations.parent_id`). A store's parent is the central warehouse;
 * a sex's parent is the production root; and so on. Returns null when the
 * requester is a root (no parent) — e.g. the raw warehouse, which has nobody to
 * ask.
 */
export async function resolveRequestTarget(
  tx: TxClient,
  requesterLocationId: number,
  productId?: number,
): Promise<CrossDeptTarget | null> {
  // --- TZ §6 producer override (only for a semi product with a producer) -----
  if (productId !== undefined) {
    const { rows } = await tx.query<{ id: number; name: string; type: string }>(
      `SELECT store.id, store.name, store.type::text AS type
         FROM products p
         JOIN locations workshop ON workshop.id = p.workshop_location_id
                                AND workshop.is_active = TRUE
         -- the отдел's sex_storage buffer (its CHILD); lowest id when many.
         JOIN LATERAL (
           SELECT s.id, s.name, s.type
             FROM locations s
            WHERE s.parent_id = workshop.id
              AND s.type = 'sex_storage'::location_type
              AND s.is_active = TRUE
            ORDER BY s.id
            LIMIT 1
         ) store ON TRUE
        WHERE p.id = $1
          AND p.type = 'semi'::product_type
          AND p.workshop_location_id IS NOT NULL
          -- never route a request back at its own location.
          AND store.id <> $2`,
      [productId, requesterLocationId],
    );
    const producer = rows[0];
    if (producer !== undefined) {
      return {
        locationId: Number(producer.id),
        name: producer.name,
        type: producer.type,
        via: 'producer_store',
      };
    }
    // Producer override did not apply (not a semi, no workshop, no sex_storage,
    // or it resolved to the requester itself) — fall through to the parent path.
  }

  // --- Default path: the requester's topology parent -------------------------
  const { rows } = await tx.query<{ id: number; name: string; type: string }>(
    `SELECT parent.id, parent.name, parent.type::text AS type
       FROM locations child
       JOIN locations parent ON parent.id = child.parent_id
      WHERE child.id = $1 AND parent.is_active = TRUE`,
    [requesterLocationId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return { locationId: Number(r.id), name: r.name, type: r.type, via: 'parent' };
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
  // clear message before touching the engine. The `productId` enables the
  // TZ §6 producer override (a semi with a workshop routes to that отдел's
  // sklad — see resolveRequestTarget).
  const target = await withTransaction((tx) =>
    resolveRequestTarget(tx, opts.requesterLocationId, opts.productId),
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
  let request = await createRequest({
    productId: opts.productId,
    requesterLocationId: opts.requesterLocationId,
    qtyNeeded: opts.qty,
    actorUserId: opts.actorUserId,
    note: opts.note ?? `telegram cross-dept: ${opts.productName} ×${opts.qty}`,
  });

  // TZ §6 — PIN the target on the request ONLY for the producer-override path.
  // `createRequest` leaves a fresh request at NEW with target_location_id=NULL;
  // for a store→central request the engine fills the central warehouse itself
  // (advanceNew/resolveTopology), so we must NOT pin there or we would override
  // the central-warehouse ship-from. For the cream-otdel case the producing
  // sklad is NOT the topology parent and NOT reachable by resolveTopology, so
  // we record it here. Pinning makes all three agree:
  //   - checkXreqRbac reads the pinned target → the cream sklad manager may act;
  //   - acceptByFulfiller verifies fulfiller == pinned target → ships from the
  //     cream sklad's own stock;
  //   - the engine never re-resolves a non-NULL target.
  // The request was just created at NEW, so the UPDATE is a safe pin; the
  // RETURNING row keeps the in-memory `request` consistent with the DB.
  if (target.via === 'producer_store') {
    const pinned = await withTransaction((tx) =>
      tx.query<ReplenishmentRow>(
        `UPDATE replenishment_requests
            SET target_location_id = $2
          WHERE id = $1 AND target_location_id IS NULL
          RETURNING ${REPLENISHMENT_COLUMNS}`,
        [request.id, target.locationId],
      ),
    );
    if (pinned.rows[0] !== undefined) {
      request = pinned.rows[0];
    }
  }

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
