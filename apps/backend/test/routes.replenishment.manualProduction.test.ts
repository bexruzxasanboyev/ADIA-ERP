/**
 * 0055 — Manual central -> production replenishment flow (store requests).
 *
 * Owner-approved 2026-06-08: when a STORE request targets the central warehouse
 * and the central is SHORT, the central warehouse manager must EXPLICITLY:
 *   1. POST /:id/to-production            — route to production (creates a PO at
 *                                           the workshop; request marked manual).
 *   2. (production order new -> in_progress -> done)
 *   3. POST /:id/receive-from-production  — confirm receipt at central (+brak),
 *                                           request must STOP and not auto-ship.
 *   4. POST /:id/ship-to-store            — forward central -> store -> CLOSED.
 *
 * Coverage:
 *   - happy path end-to-end (status path + stock ledger);
 *   - the NO-AUTO-SHIP gate (after the PO is done the request waits at
 *     DONE_TO_WAREHOUSE; a generic advance does NOT ship);
 *   - brak split on receive (defective qty written off, not forwarded);
 *   - workshop resolution via products.workshop_location_id;
 *   - RBAC (only the owning central_warehouse_manager; pm 403; foreign 403);
 *   - state guards (cannot receive before DONE_TO_WAREHOUSE; cannot ship before
 *     receive).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { getQty, makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { advance, runEngineCycle } from '../src/services/replenishment.js';
import { finishProductionOrder } from '../src/services/productionOrder.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/**
 * A wired chain: raw -> production -> sex_storage / supply -> central -> store.
 * The store request resolves a central warehouse (target) and a production
 * location (workshop) via the topology walk.
 */
async function buildChain(): Promise<{
  rawWh: number;
  production: number;
  sexStorage: number;
  supply: number;
  central: number;
  store: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const sexStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: production });
  const supply = await makeLocation(ctx.db, { type: 'supply', parentId: production });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: supply });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
  return { rawWh, production, sexStorage, supply, central, store };
}

async function readStatus(reqId: number): Promise<string> {
  const { rows } = await ctx.db.query<{ status: string }>(
    'SELECT status FROM replenishment_requests WHERE id = $1',
    [reqId],
  );
  return rows[0]!.status;
}

async function linkedPoId(reqId: number): Promise<number> {
  const { rows } = await ctx.db.query<{ id: number }>(
    'SELECT production_order_id AS id FROM replenishment_requests WHERE id = $1',
    [reqId],
  );
  return Number(rows[0]!.id);
}

/** Create a store request (boss-approve path) for an out-of-stock product. */
async function createStoreRequest(opts: {
  store: number;
  central: number;
  product: number;
  qtyNeeded: number;
}): Promise<number> {
  const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: opts.store });
  const approve = await request(ctx.app)
    .post('/api/replenishment/proposals/approve')
    .set('Authorization', `Bearer ${storeMgr.token}`)
    .send({ location_id: opts.store, items: [{ product_id: opts.product, qty: opts.qtyNeeded }] });
  expect(approve.status).toBe(200);
  return approve.body.results[0].request_id as number;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('manual central -> production: happy path', () => {
  it('route -> produce -> receive -> ship -> CLOSED, ledger correct', async () => {
    const { rawWh, central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 2, 'base')`,
      [cake, flour],
    );
    // Store below min; central EMPTY; raw warehouse has plenty.
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 100 });

    const reqId = await createStoreRequest({ store, central, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    // 1) Route to production (manual). Raw OK -> CREATE_PRODUCTION_ORDER.
    const toProd = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/to-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    expect(toProd.status).toBe(200);
    expect(toProd.body.status).toBe('CREATE_PRODUCTION_ORDER');
    expect(toProd.body.request.route_to_production_manual).toBe(true);
    expect(toProd.body.request.target_location_id).toBe(central);
    // 20 kg flour transferred raw -> production.
    expect(await getQty(ctx.db, rawWh, flour)).toBe(80);

    // 2) Drive the production order new -> in_progress -> done.
    const poId = await linkedPoId(reqId);
    await ctx.db.query(`UPDATE production_orders SET status = 'in_progress' WHERE id = $1`, [poId]);
    await advance(reqId, null); // CREATE_PRODUCTION_ORDER -> PRODUCING
    expect(await readStatus(reqId)).toBe('PRODUCING');
    await finishProductionOrder(poId, null);
    // production_output landed 10 cakes at central.
    expect(await getQty(ctx.db, central, cake)).toBe(10);
    await advance(reqId, null); // PRODUCING -> DONE_TO_WAREHOUSE (and STOPS)
    expect(await readStatus(reqId)).toBe('DONE_TO_WAREHOUSE');

    // 3) Receive at central (no brak) -> SHIP_TO_REQUESTER, NOT shipped yet.
    const receive = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive-from-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({});
    expect(receive.status).toBe(200);
    expect(receive.body.request.status).toBe('SHIP_TO_REQUESTER');
    expect(receive.body.request.received_from_production_at).not.toBe(null);
    // Still at central — store not credited yet.
    expect(await getQty(ctx.db, central, cake)).toBe(10);
    expect(await getQty(ctx.db, store, cake)).toBe(0);

    // 4) Forward central -> store -> CLOSED.
    const ship = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/ship-to-store`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({});
    expect(ship.status).toBe(200);
    expect(ship.body.shipped).toBe(true);
    expect(ship.body.request.status).toBe('CLOSED');
    expect(await getQty(ctx.db, store, cake)).toBe(10);
    expect(await getQty(ctx.db, central, cake)).toBe(0);

    // Invariant 3 — no negative stock anywhere.
    const { rows: neg } = await ctx.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stock WHERE qty < 0',
    );
    expect(Number(neg[0]!.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No-auto-ship gate
// ---------------------------------------------------------------------------

describe('manual central -> production: NO-auto-ship gate', () => {
  it('after PO done, a generic advance does NOT ship — it waits for receive', async () => {
    const { rawWh, central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1, 'base')`,
      [cake, flour],
    );
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 8 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 100 });

    const reqId = await createStoreRequest({ store, central, product: cake, qtyNeeded: 8 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    await request(ctx.app)
      .post(`/api/replenishment/${reqId}/to-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    const poId = await linkedPoId(reqId);
    await ctx.db.query(`UPDATE production_orders SET status = 'in_progress' WHERE id = $1`, [poId]);
    await advance(reqId, null); // -> PRODUCING
    await finishProductionOrder(poId, null); // 8 cakes into central
    await advance(reqId, null); // -> DONE_TO_WAREHOUSE
    expect(await readStatus(reqId)).toBe('DONE_TO_WAREHOUSE');

    // A generic advance MUST NOT ship — the manual gate holds it.
    const r1 = await advance(reqId, null);
    expect(r1.advanced).toBe(false);
    expect(await readStatus(reqId)).toBe('DONE_TO_WAREHOUSE');
    // Store still empty, central still holds the produced goods.
    expect(await getQty(ctx.db, store, cake)).toBe(0);
    expect(await getQty(ctx.db, central, cake)).toBe(8);

    // ship-to-store before receive is refused (409).
    const earlyShip = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/ship-to-store`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({});
    expect(earlyShip.status).toBe(409);
    expect(await readStatus(reqId)).toBe('DONE_TO_WAREHOUSE');
  });
});

// ---------------------------------------------------------------------------
// Brak split on receive
// ---------------------------------------------------------------------------

describe('manual central -> production: brak split on receive', () => {
  it('defective qty is written off central and not forwarded', async () => {
    const { rawWh, central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1, 'base')`,
      [cake, flour],
    );
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 100 });

    const reqId = await createStoreRequest({ store, central, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    await request(ctx.app)
      .post(`/api/replenishment/${reqId}/to-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    const poId = await linkedPoId(reqId);
    await ctx.db.query(`UPDATE production_orders SET status = 'in_progress' WHERE id = $1`, [poId]);
    await advance(reqId, null);
    await finishProductionOrder(poId, null); // 10 cakes into central
    await advance(reqId, null); // -> DONE_TO_WAREHOUSE

    // Receive with 3 brak.
    const receive = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive-from-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ brak_qty: 3, brak_reason: 'kuyib ketgan' });
    expect(receive.status).toBe(200);
    expect(Number(receive.body.request.brak_qty)).toBe(3);
    expect(receive.body.request.brak_reason).toBe('kuyib ketgan');
    // 3 written off -> central holds 7.
    expect(await getQty(ctx.db, central, cake)).toBe(7);

    // Forward -> only the 7 good ones reach the store.
    const ship = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/ship-to-store`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({});
    expect(ship.status).toBe(200);
    expect(ship.body.request.status).toBe('CLOSED');
    expect(await getQty(ctx.db, store, cake)).toBe(7);
    expect(await getQty(ctx.db, central, cake)).toBe(0);
  });

  it('brak_qty > 0 requires a brak_reason (422)', async () => {
    const { rawWh, central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1, 'base')`,
      [cake, flour],
    );
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 5 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 50 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    const reqId = await createStoreRequest({ store, central, product: cake, qtyNeeded: 5 });
    await request(ctx.app)
      .post(`/api/replenishment/${reqId}/to-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    const poId = await linkedPoId(reqId);
    await ctx.db.query(`UPDATE production_orders SET status = 'in_progress' WHERE id = $1`, [poId]);
    await advance(reqId, null);
    await finishProductionOrder(poId, null);
    await advance(reqId, null); // -> DONE_TO_WAREHOUSE
    const badBrak = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive-from-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ brak_qty: 2 });
    expect(badBrak.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Workshop resolution via products.workshop_location_id
// ---------------------------------------------------------------------------

describe('manual central -> production: workshop resolution', () => {
  it('uses products.workshop_location_id as the production target sex', async () => {
    // Raw is still sourced from the requester chain's raw warehouse (the
    // workshop link only redirects WHERE the goods are MADE, not where the BOM
    // raw comes from). So put the flour in the chain's rawWh, and assert the
    // production order's location_id is the linked workshop (not the chain's
    // own production location).
    const { rawWh, production: chainProduction, central, store } = await buildChain();
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });

    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1, 'base')`,
      [cake, flour],
    );
    // Link the product to the dedicated workshop (NOT the chain's production loc).
    await ctx.db.query('UPDATE products SET workshop_location_id = $1 WHERE id = $2', [
      workshop,
      cake,
    ]);
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 6 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 50 });

    const reqId = await createStoreRequest({ store, central, product: cake, qtyNeeded: 6 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    const toProd = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/to-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    expect(toProd.status).toBe(200);
    // F-L owner gate: a workshop-linked product now WAITS at
    // CHECK_PRODUCTION_INPUT until the отдел manager accepts — the synchronous
    // hop only remains for products with no resolvable production location.
    expect(toProd.body.status).toBe('CHECK_PRODUCTION_INPUT');

    // The отдел manager accepts — the accept itself DRIVES the BOM/raw check
    // (store-requester rows never ride the cron), so the production order
    // exists the moment the accept returns.
    const wsManager = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: workshop,
    });
    const accept = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept-production`)
      .set('Authorization', `Bearer ${wsManager.token}`)
      .send({});
    expect(accept.status).toBe(200);
    expect(accept.body.accepted).toBe(true);
    expect(accept.body.request.status).toBe('CREATE_PRODUCTION_ORDER');

    // The production order's location_id must be the linked WORKSHOP, NOT the
    // chain's own production location.
    const poId = await linkedPoId(reqId);
    const { rows } = await ctx.db.query<{ location_id: number; target_location_id: number }>(
      'SELECT location_id, target_location_id FROM production_orders WHERE id = $1',
      [poId],
    );
    expect(Number(rows[0]!.location_id)).toBe(workshop);
    expect(Number(rows[0]!.location_id)).not.toBe(chainProduction);
    expect(Number(rows[0]!.target_location_id)).toBe(central);
    // 6 kg flour consumed from the chain raw warehouse, transferred into the workshop.
    expect(await getQty(ctx.db, rawWh, flour)).toBe(44);
    expect(await getQty(ctx.db, workshop, flour)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe('manual central -> production: RBAC', () => {
  it('a foreign central manager cannot receive / ship a request targeting another central', async () => {
    const { rawWh, central, store } = await buildChain();
    const otherCentral = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1, 'base')`,
      [cake, flour],
    );
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 6 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 50 });

    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    const foreign = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: otherCentral,
    });

    // Rightful owner routes it (pins target = central), then drives production.
    const reqId = await createStoreRequest({ store, central, product: cake, qtyNeeded: 6 });
    const routed = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/to-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    expect(routed.status).toBe(200);
    const poId = await linkedPoId(reqId);
    await ctx.db.query(`UPDATE production_orders SET status = 'in_progress' WHERE id = $1`, [poId]);
    await advance(reqId, null);
    await finishProductionOrder(poId, null);
    await advance(reqId, null); // -> DONE_TO_WAREHOUSE

    // A foreign manager cannot receive a request targeting `central` (403 —
    // they do not own the target warehouse). requireLocationOperator on the
    // request's target_location_id is the guard.
    const foreignReceive = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive-from-production`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({});
    expect(foreignReceive.status).toBe(403);

    // The rightful owner receives, then a foreign manager cannot ship it either.
    const receive = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive-from-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({});
    expect(receive.status).toBe(200);
    const foreignShip = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/ship-to-store`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({});
    expect(foreignShip.status).toBe(403);
  });

  it('pm is 403 on all three (read-and-recommend write guard)', async () => {
    const { central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 6 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    const reqId = await createStoreRequest({ store, central, product: cake, qtyNeeded: 6 });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    for (const path of ['to-production', 'receive-from-production', 'ship-to-store']) {
      const res = await request(ctx.app)
        .post(`/api/replenishment/${reqId}/${path}`)
        .set('Authorization', `Bearer ${pm.token}`)
        .send({ location_id: central });
      expect(res.status).toBe(403);
    }
  });

  it('a store manager is 403 (not an allowed role)', async () => {
    const { central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 6 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 0 });
    const reqId = await createStoreRequest({ store, central, product: cake, qtyNeeded: 6 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/to-production`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ location_id: central });
    expect(res.status).toBe(403);
  });
});
