/**
 * cross-dept-flow F-Q — отдел manager's two needs on the production board:
 *
 *   1. GET /api/replenishment/:id is ENRICHED with the linked production order
 *      (`production_order`) and every linked purchase order (`purchase_orders`)
 *      so the detail page can show "qanday Tayyorga o'tkazaman?" (which zayafka
 *      to finish) and "mahsulot ombori so'rovini qanday kontrol qilaman?" (the
 *      raw purchases its зг is waiting on).
 *   2. PATCH /api/production-orders/:id lets the production_manager who OPERATES
 *      the order's location move new -> in_progress -> done; the `done` flip
 *      atomically consumes the BOM, outputs the goods AND advances the linked
 *      replenishment. A foreign отдел / PM is 403; an invalid transition is 409.
 *
 * The PATCH route was ALREADY wired for exactly this (authorizeWrite(
 * 'production_manager') + requireLocationOperator on the order's location_id +
 * the atomic done branch). These tests prove that contract end-to-end; only the
 * GET /:id enrichment is new code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { advance, createRequest } from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// 1. GET /api/replenishment/:id — production_order + purchase_orders blocks
// ---------------------------------------------------------------------------
describe('GET /api/replenishment/:id — enrich (production_order + purchase_orders)', () => {
  it('returns the linked production order, plus the deduped union of the direct FK + M:N purchases', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });

    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'крем наполеон' });
    const sugar = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'сахар' });

    // A store request, parked production-bound, with target=central.
    const req = await createRequest({
      productId: cake,
      requesterLocationId: store,
      qtyNeeded: 10,
      actorUserId: null,
    });
    await ctx.db.query(
      `UPDATE replenishment_requests
          SET status = 'CREATE_PURCHASE_ORDER', target_location_id = $2
        WHERE id = $1`,
      [req.id, central],
    );

    // A linked production order at the workshop.
    const { rows: poRows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status, replenishment_id)
         VALUES ($1, 6, $2, $3, 'new', $4) RETURNING id`,
      [cake, workshop, central, req.id],
    );
    const prodOrderId = Number(poRows[0]!.id);
    await ctx.db.query(`UPDATE replenishment_requests SET production_order_id = $2 WHERE id = $1`, [
      req.id,
      prodOrderId,
    ]);

    // Two purchase orders for the two short raws.
    const { rows: po1Rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status)
         VALUES ($1, 20.1, $2, 'draft') RETURNING id`,
      [flour, rawWh],
    );
    const po1 = Number(po1Rows[0]!.id);
    // 'received' (not 'approved') — `approved` needs both approval columns set
    // (chk_po_approved_consistency); a distinct status is all this test needs.
    const { rows: po2Rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO purchase_orders (product_id, qty, target_location_id, status)
         VALUES ($1, 5, $2, 'received') RETURNING id`,
      [sugar, rawWh],
    );
    const po2 = Number(po2Rows[0]!.id);

    // Link BOTH via the M:N table; ALSO set the legacy direct FK to po1 — so po1
    // is reachable via BOTH paths and MUST be deduped (appear once).
    await ctx.db.query(
      `INSERT INTO replenishment_purchase_orders (replenishment_id, purchase_order_id)
         VALUES ($1, $2), ($1, $3)`,
      [req.id, po1, po2],
    );
    await ctx.db.query(`UPDATE replenishment_requests SET purchase_order_id = $2 WHERE id = $1`, [
      req.id,
      po1,
    ]);

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get(`/api/replenishment/${req.id}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);

    // production_order block.
    expect(res.body.production_order).not.toBeNull();
    expect(res.body.production_order.id).toBe(prodOrderId);
    expect(res.body.production_order.status).toBe('new');
    expect(res.body.production_order.qty).toBe(6);
    expect(res.body.production_order.location_id).toBe(workshop);

    // purchase_orders block — both POs, deduped (po1 once), newest first.
    const pos = res.body.purchase_orders as Array<{
      id: number;
      status: string;
      qty: number;
      product_id: number;
      product_name: string;
      product_unit: string;
    }>;
    expect(pos).toHaveLength(2);
    const ids = pos.map((p) => p.id).sort((a, b) => a - b);
    expect(ids).toEqual([po1, po2].sort((a, b) => a - b));
    // Newest first: po2 was inserted after po1 → po2 leads.
    expect(pos[0]!.id).toBe(po2);
    // Numeric coercion + joined product name/unit.
    const po1Row = pos.find((p) => p.id === po1)!;
    expect(po1Row.qty).toBe(20.1);
    expect(po1Row.product_id).toBe(flour);
    expect(po1Row.product_name).toBe('крем наполеон');
    expect(po1Row.product_unit).toBe('kg');
  });

  it('returns production_order=null and purchase_orders=[] for a bare request', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });

    const req = await createRequest({
      productId: cake,
      requesterLocationId: store,
      qtyNeeded: 4,
      actorUserId: null,
    });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get(`/api/replenishment/${req.id}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.production_order).toBeNull();
    expect(res.body.purchase_orders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. PATCH /api/production-orders/:id — отдел operator finish path
// ---------------------------------------------------------------------------

/**
 * Build a #35074-shaped AUTO chain and drive the real engine to PRODUCING:
 * raw -> production -> central -> store, a finished cake with a raw BOM, raw
 * plentiful, central empty. Returns the request id, the linked production order
 * id, the workshop (production) location, and a token for its operator.
 */
async function buildToProducing(): Promise<{
  requestId: number;
  productionOrderId: number;
  workshop: number;
  operatorToken: string;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const workshop = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: workshop });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });

  const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
  const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 2)`,
    [cake, flour],
  );
  await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 5, maxLevel: 10 });
  await setStock(ctx.db, { locationId: central, productId: cake, qty: 0, minLevel: 0, maxLevel: 0 });
  await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 1000, minLevel: 0, maxLevel: 0 });

  const req = await createRequest({
    productId: cake,
    requesterLocationId: store,
    qtyNeeded: 10,
    actorUserId: null,
  });
  await advance(req.id, null); // NEW -> CHECK_STORE_SUPPLIER
  await advance(req.id, null); // -> CHECK_PRODUCTION_INPUT
  await advance(req.id, null); // -> CREATE_PRODUCTION_ORDER (BOM transferred in, po created)
  await advance(req.id, null); // -> PRODUCING (chains as far as it can)

  const { rows } = await ctx.db.query<{
    production_order_id: string;
    status: string;
  }>(
    `SELECT production_order_id, status FROM replenishment_requests WHERE id = $1`,
    [req.id],
  );
  const productionOrderId = Number(rows[0]!.production_order_id);
  // The engine output the BOM into a production order at the workshop.
  const { rows: locRows } = await ctx.db.query<{ location_id: string }>(
    `SELECT location_id FROM production_orders WHERE id = $1`,
    [productionOrderId],
  );
  const operator = await makeUser(ctx.db, {
    role: 'production_manager',
    locationId: Number(locRows[0]!.location_id),
  });
  return { requestId: req.id, productionOrderId, workshop, operatorToken: operator.token };
}

describe('PATCH /api/production-orders/:id — отдел finish path', () => {
  it('operator new -> in_progress -> done: 200 + the linked request advances to DONE_TO_WAREHOUSE', async () => {
    const c = await buildToProducing();

    // First a forward flip to in_progress (idempotent on a PRODUCING-linked
    // order — the order itself is still 'new' until done).
    const inProg = await request(ctx.app)
      .patch(`/api/production-orders/${c.productionOrderId}`)
      .set('Authorization', `Bearer ${c.operatorToken}`)
      .send({ status: 'in_progress' });
    expect(inProg.status).toBe(200);
    expect(inProg.body.production_order.status).toBe('in_progress');

    // Then done — the atomic BOM-consume + output + linked-request advance.
    const done = await request(ctx.app)
      .patch(`/api/production-orders/${c.productionOrderId}`)
      .set('Authorization', `Bearer ${c.operatorToken}`)
      .send({ status: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.production_order.status).toBe('done');

    // REGRESSION: finishing the final order advanced the linked replenishment
    // off PRODUCING. On the AUTO path a single advance lands it at
    // DONE_TO_WAREHOUSE (the goods are now at central; a separate ship hop
    // forwards them). This is the owner's #35074-shaped flow once produced.
    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM replenishment_requests WHERE id = $1`,
      [c.requestId],
    );
    expect(rows[0]!.status).toBe('DONE_TO_WAREHOUSE');
  });

  it('a foreign отдел manager (right role, wrong location) is 403', async () => {
    const c = await buildToProducing();
    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });
    const res = await request(ctx.app)
      .patch(`/api/production-orders/${c.productionOrderId}`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({ status: 'in_progress' });
    expect(res.status).toBe(403);
    // requireLocationOperator throws AppError.forbidden for a foreign location;
    // the audit action is 'foreign_location' but the wire error code is FORBIDDEN.
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('PM is read-and-recommend — PATCH is 403 (no super-admin bypass)', async () => {
    const c = await buildToProducing();
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .patch(`/api/production-orders/${c.productionOrderId}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ status: 'done' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('an invalid transition off a done order is 409 (cancel-after-done = INVALID_TRANSITION)', async () => {
    const c = await buildToProducing();
    // Finish it once.
    const first = await request(ctx.app)
      .patch(`/api/production-orders/${c.productionOrderId}`)
      .set('Authorization', `Bearer ${c.operatorToken}`)
      .send({ status: 'done' });
    expect(first.status).toBe(200);

    // A SECOND done is idempotent (finishProductionOrder returns the already-done
    // order without re-consuming the BOM) — 200, not an error. Pin that contract.
    const secondDone = await request(ctx.app)
      .patch(`/api/production-orders/${c.productionOrderId}`)
      .set('Authorization', `Bearer ${c.operatorToken}`)
      .send({ status: 'done' });
    expect(secondDone.status).toBe(200);
    expect(secondDone.body.production_order.status).toBe('done');

    // But cancelling a DONE order is a genuine invalid transition → 409. `done`
    // already applied the stock movements, so it can never be cancelled.
    const cancel = await request(ctx.app)
      .patch(`/api/production-orders/${c.productionOrderId}`)
      .set('Authorization', `Bearer ${c.operatorToken}`)
      .send({ status: 'cancelled' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error?.code).toBe('INVALID_TRANSITION');
  });
});
