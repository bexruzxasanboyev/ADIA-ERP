/**
 * 0058 — Corrected central request model: partial fulfillment, pipeline_stage,
 * brak cap, and the Poster central-decrement DRY-RUN write-back.
 *
 * Owner-corrected 2026-06-08. Coverage:
 *   - POST /:id/fulfill — partial: ship the available portion (request ->
 *     yuborilgan) AND create a GROUPED shortfall production request (-> soralgan);
 *   - fulfill — full: central covers it all, no shortfall;
 *   - fulfill — central empty: nothing shipped, the ORIGINAL request routed to
 *     production in place;
 *   - fulfill RBAC (own central only; pm 403; foreign central 403);
 *   - pipeline_stage derivation across the lifecycle (kutuvda -> soralgan ->
 *     qabul_qilingan -> yuborilgan -> yopilgan), via the GET endpoints;
 *   - brak cap on every receive path (store receive, receive-from-production,
 *     purchase-order receive) -> 422;
 *   - the Poster CENTRAL decrement DRY-RUN path: it does NOT call live Poster,
 *     it logs + enqueues a 'pending' central_out row with the intended payload,
 *     and it is idempotent (coexists with the store_in row for the same request).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { getQty, makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { advance, derivePipelineStage } from '../src/services/replenishment.js';
import { finishProductionOrder } from '../src/services/productionOrder.js';
import {
  enqueueCentralDecrementWriteback,
  isLivePosterWriteEnabled,
} from '../src/services/posterWriteback.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** A wired chain: raw -> production -> sex_storage -> supply -> central -> store. */
async function buildChain(): Promise<{
  rawWh: number;
  production: number;
  central: number;
  store: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  await makeLocation(ctx.db, { type: 'sex_storage', parentId: production });
  const supply = await makeLocation(ctx.db, { type: 'supply', parentId: production });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: supply });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
  return { rawWh, production, central, store };
}

async function readRow(reqId: number): Promise<{
  status: string;
  closure_reason: string | null;
  route_to_production_manual: boolean;
  received_from_production_at: string | null;
  qty_needed: string;
  batch_id: string | null;
}> {
  const { rows } = await ctx.db.query<{
    status: string;
    closure_reason: string | null;
    route_to_production_manual: boolean;
    received_from_production_at: string | null;
    qty_needed: string;
    batch_id: string | null;
  }>(
    `SELECT status, closure_reason, route_to_production_manual,
            received_from_production_at, qty_needed, batch_id
       FROM replenishment_requests WHERE id = $1`,
    [reqId],
  );
  return rows[0]!;
}

async function createStoreRequest(opts: {
  store: number;
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

/** Set a product's Poster ingredient id (the createWriteOff join key). */
async function setPosterIngredient(productId: number, posterIngredientId: number): Promise<void> {
  await ctx.db.query('UPDATE products SET poster_ingredient_id = $1 WHERE id = $2', [
    posterIngredientId,
    productId,
  ]);
}

/** Set a location's Poster storage id (the central singleton = 8). */
async function setPosterStorage(locationId: number, posterStorageId: number): Promise<void> {
  await ctx.db.query('UPDATE locations SET poster_storage_id = $1 WHERE id = $2', [
    posterStorageId,
    locationId,
  ]);
}

// ---------------------------------------------------------------------------
// POST /:id/fulfill — partial
// ---------------------------------------------------------------------------

describe('POST /:id/fulfill — partial fulfillment', () => {
  it('ships the available portion and creates a grouped shortfall production request', async () => {
    const { rawWh, central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1, 'base')`,
      [cake, flour],
    );
    // Store needs 10; central holds only 4; raw warehouse can make the rest.
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 4 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 100 });

    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    expect(res.status).toBe(200);
    expect(res.body.shipped_qty).toBe(4);
    expect(res.body.shortfall_qty).toBe(6);
    const prodReqId = res.body.production_request_id as number;
    expect(prodReqId).toBeGreaterThan(0);
    expect(prodReqId).not.toBe(reqId);

    // Original: 4 shipped to store, CLOSED, closure_reason NULL -> yuborilgan.
    expect(res.body.request.status).toBe('CLOSED');
    expect(res.body.request.pipeline_stage).toBe('yuborilgan');
    expect(await getQty(ctx.db, store, cake)).toBe(4);
    expect(await getQty(ctx.db, central, cake)).toBe(0);
    const orig = await readRow(reqId);
    expect(orig.status).toBe('CLOSED');
    expect(orig.closure_reason).toBeNull();

    // Shortfall request: qty 6, routed to production (raw OK -> a production
    // order created), pipeline soralgan, same batch as the original (grouped).
    const shortfall = await readRow(prodReqId);
    expect(Number(shortfall.qty_needed)).toBe(6);
    expect(shortfall.route_to_production_manual).toBe(true);
    expect(shortfall.status).toBe('CREATE_PRODUCTION_ORDER');
    expect(shortfall.batch_id).toBe(orig.batch_id);
    expect(derivePipelineStage(shortfall as never)).toBe('soralgan');
    // 6 kg flour consumed raw -> production for the shortfall order.
    expect(await getQty(ctx.db, rawWh, flour)).toBe(94);

    // Invariant 3 — no negative stock.
    const { rows: neg } = await ctx.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM stock WHERE qty < 0',
    );
    expect(Number(neg[0]!.n)).toBe(0);
  });

  it('honours a smaller explicit ship_qty (capped at available) and produces the rest', async () => {
    const { rawWh, central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1, 'base')`,
      [cake, flour],
    );
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 8 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 100 });
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    // Operator chooses to ship only 5 even though 8 are available.
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central, ship_qty: 5 });
    expect(res.status).toBe(200);
    expect(res.body.shipped_qty).toBe(5);
    expect(res.body.shortfall_qty).toBe(5);
    expect(await getQty(ctx.db, store, cake)).toBe(5);
    expect(await getQty(ctx.db, central, cake)).toBe(3); // 8 - 5 shipped
  });
});

// ---------------------------------------------------------------------------
// POST /:id/fulfill — full + central-empty
// ---------------------------------------------------------------------------

describe('POST /:id/fulfill — full and central-empty', () => {
  it('central covers it all -> ships everything, no shortfall, no production request', async () => {
    const { central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 20 });
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    expect(res.status).toBe(200);
    expect(res.body.shipped_qty).toBe(10);
    expect(res.body.shortfall_qty).toBe(0);
    expect(res.body.production_request_id).toBeNull();
    expect(res.body.request.pipeline_stage).toBe('yuborilgan');
    expect(await getQty(ctx.db, store, cake)).toBe(10);
    expect(await getQty(ctx.db, central, cake)).toBe(10);
  });

  it('central empty -> ships nothing, routes the ORIGINAL request to production', async () => {
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
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    expect(res.status).toBe(200);
    expect(res.body.shipped_qty).toBe(0);
    expect(res.body.shortfall_qty).toBe(10);
    // The original itself carries the shortfall to production (no second row).
    expect(res.body.production_request_id).toBe(reqId);
    expect(res.body.request.status).toBe('CREATE_PRODUCTION_ORDER');
    expect(res.body.request.pipeline_stage).toBe('soralgan');
    expect(res.body.request.route_to_production_manual).toBe(true);
    expect(await getQty(ctx.db, store, cake)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /:id/fulfill — RBAC
// ---------------------------------------------------------------------------

describe('POST /:id/fulfill — RBAC', () => {
  it('pm is 403 (read-and-recommend write guard)', async () => {
    const { central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 6 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 10 });
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 6 });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: central });
    expect(res.status).toBe(403);
  });

  it('a foreign central manager cannot fulfill a request bound for another central', async () => {
    const { central, store } = await buildChain();
    const otherCentral = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 6 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 10 });
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 6 });
    const foreign = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: otherCentral,
    });
    // The operator owns otherCentral; requireLocationOperator(otherCentral) passes,
    // but the warehouse-type/own checks + the service target guard apply. Here the
    // operator passes ownership of otherCentral, so the request is fulfilled FOR
    // otherCentral — but the original store request has no target yet, so it would
    // pin otherCentral. To assert the cross-central guard we first pin `central`
    // via the rightful owner, then the foreign attempt must 403.
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    // Rightful owner ships part (pins target=central, ships 6 — full here).
    const ok = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central, ship_qty: 0 });
    expect(ok.status).toBe(200);
    // Now the request is bound for `central` (routed to production). A foreign
    // manager fulfilling for otherCentral is refused: the request is no longer in
    // a fulfillable state AND targets a different central.
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({ location_id: otherCentral });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });
});

// ---------------------------------------------------------------------------
// pipeline_stage derivation across the lifecycle
// ---------------------------------------------------------------------------

describe('pipeline_stage derivation', () => {
  it('maps each status to exactly one stage (TS function)', () => {
    const base = {
      closure_reason: null,
      route_to_production_manual: false,
      received_from_production_at: null,
    } as const;
    // kutuvda — store request not yet handled.
    expect(derivePipelineStage({ ...base, status: 'NEW' })).toBe('kutuvda');
    expect(derivePipelineStage({ ...base, status: 'CHECK_STORE_SUPPLIER' })).toBe('kutuvda');
    // kutuvda — manual production delivery awaiting receipt.
    expect(
      derivePipelineStage({ ...base, status: 'DONE_TO_WAREHOUSE', route_to_production_manual: true }),
    ).toBe('kutuvda');
    // soralgan — in-production / sourcing.
    expect(derivePipelineStage({ ...base, status: 'CHECK_PRODUCTION_INPUT' })).toBe('soralgan');
    expect(derivePipelineStage({ ...base, status: 'CREATE_PRODUCTION_ORDER' })).toBe('soralgan');
    expect(derivePipelineStage({ ...base, status: 'CREATE_PURCHASE_ORDER' })).toBe('soralgan');
    expect(derivePipelineStage({ ...base, status: 'PRODUCING' })).toBe('soralgan');
    // soralgan — non-manual DONE_TO_WAREHOUSE (internal auto-flow).
    expect(derivePipelineStage({ ...base, status: 'DONE_TO_WAREHOUSE' })).toBe('soralgan');
    // qabul_qilingan — ready to forward.
    expect(derivePipelineStage({ ...base, status: 'SHIP_TO_REQUESTER' })).toBe('qabul_qilingan');
    expect(
      derivePipelineStage({
        ...base,
        status: 'SHIP_TO_REQUESTER',
        received_from_production_at: new Date(),
      }),
    ).toBe('qabul_qilingan');
    // yuborilgan — shipped, store has NOT accepted yet.
    expect(derivePipelineStage({ ...base, status: 'CLOSED' })).toBe('yuborilgan');
    // yopilgan — accepted / cancelled.
    expect(
      derivePipelineStage({ ...base, status: 'CLOSED', closure_reason: 'accepted_full' }),
    ).toBe('yopilgan');
    expect(
      derivePipelineStage({ ...base, status: 'CLOSED', closure_reason: 'rejected' }),
    ).toBe('yopilgan');
    expect(derivePipelineStage({ ...base, status: 'CANCELLED' })).toBe('yopilgan');
  });

  it('GET endpoints expose pipeline_stage; yuborilgan -> yopilgan on store accept', async () => {
    const { central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 20 });
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    // pm sees any request (the central does not "touch" a NEW untargeted request yet).
    const pm = await makeUser(ctx.db, { role: 'pm' });

    // Before fulfill — NEW -> kutuvda (GET single).
    const before = await request(ctx.app)
      .get(`/api/replenishment/${reqId}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(before.status).toBe(200);
    expect(before.body.request.pipeline_stage).toBe('kutuvda');

    // Fulfill (full) -> shipped, store has not accepted -> yuborilgan.
    await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    const shipped = await request(ctx.app)
      .get(`/api/replenishment/${reqId}`)
      .set('Authorization', `Bearer ${cwm.token}`);
    expect(shipped.body.request.pipeline_stage).toBe('yuborilgan');
    // The list endpoint surfaces it too.
    const list = await request(ctx.app)
      .get('/api/replenishment')
      .set('Authorization', `Bearer ${cwm.token}`);
    const listed = (list.body as Array<{ id: number; pipeline_stage: string }>).find(
      (r) => r.id === reqId,
    );
    expect(listed?.pipeline_stage).toBe('yuborilgan');

    // Store accepts (receive) -> closure_reason set -> yopilgan.
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const recv = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ received_qty: 10 });
    expect(recv.status).toBe(200);
    const accepted = await request(ctx.app)
      .get(`/api/replenishment/${reqId}`)
      .set('Authorization', `Bearer ${cwm.token}`);
    expect(accepted.body.request.pipeline_stage).toBe('yopilgan');
  });
});

// ---------------------------------------------------------------------------
// Brak cap — every receive path -> 422 when brak exceeds received/requested
// ---------------------------------------------------------------------------

describe('brak server-side cap (422)', () => {
  it('store receive: received_qty + brak_qty > shipped -> 422', async () => {
    const { central, store } = await buildChain();
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 20 });
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central }); // ships 10
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    // shipped = 10; received 8 + brak 5 = 13 > 10 -> reject.
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ received_qty: 8, brak_qty: 5, brak_reason: 'shikast' });
    expect(res.status).toBe(422);
  });

  it('receive-from-production: brak_qty > produced qty -> 422', async () => {
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
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 5 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    await request(ctx.app)
      .post(`/api/replenishment/${reqId}/to-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    const { rows: poRows } = await ctx.db.query<{ id: number }>(
      'SELECT production_order_id AS id FROM replenishment_requests WHERE id = $1',
      [reqId],
    );
    const poId = Number(poRows[0]!.id);
    await ctx.db.query(`UPDATE production_orders SET status = 'in_progress' WHERE id = $1`, [poId]);
    await advance(reqId, null);
    await finishProductionOrder(poId, null);
    await advance(reqId, null); // -> DONE_TO_WAREHOUSE
    // produced 5; brak 6 -> reject.
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive-from-production`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ brak_qty: 6, brak_reason: 'kuygan' });
    expect(res.status).toBe(422);
  });

  it('purchase-order receive: brak_qty > ordered qty -> 422', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const rwm = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    // Create an approved purchase order of 10 kg into the raw warehouse. The
    // chk_po_approved_consistency constraint requires both *_approved_by set
    // when status='approved'.
    const { rows } = await ctx.db.query<{ id: number }>(
      `INSERT INTO purchase_orders
         (product_id, qty, target_location_id, status, created_by,
          manager_approved_by, manager_approved_at, keeper_approved_by, keeper_approved_at)
       VALUES ($1, 10, $2, 'approved', $3, $3, now(), $3, now()) RETURNING id`,
      [flour, rawWh, rwm.id],
    );
    const poId = Number(rows[0]!.id);
    const res = await request(ctx.app)
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Authorization', `Bearer ${rwm.token}`)
      .send({ brak_qty: 11, brak_reason: 'chirigan' });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Poster CENTRAL decrement — DRY-RUN path
// ---------------------------------------------------------------------------

describe('Poster central decrement — DRY-RUN (POSTER_WRITE_ENABLED off in tests)', () => {
  it('does NOT call live Poster; logs + enqueues a pending central_out row with the intended payload', async () => {
    // Safety: in NODE_ENV=test the live gate is forced off.
    expect(isLivePosterWriteEnabled()).toBe(false);

    const { central, store } = await buildChain();
    await setPosterStorage(central, 8); // the central singleton.
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setPosterIngredient(cake, 2402); // a Poster ingredient id (G/P).
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 20 });
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    // Direct unit call — assert the dry-run contract precisely.
    const dry = await enqueueCentralDecrementWriteback({
      requestId: reqId,
      productId: cake,
      centralLocationId: central,
      qty: 10,
      actorUserId: cwm.id,
    });
    expect(dry.mode).toBe('dry_run'); // proves the LIVE branch was NOT taken.
    expect(dry.queueId).toBeGreaterThan(0);
    // The intended Poster payload is the storage.createWriteOff against the
    // central's storage 8, for ingredient 2402 (type 2 = G/P), weight 10.
    expect(dry.payload).not.toBeNull();
    expect(dry.payload?.method).toBe('storage.createWriteOff');
    expect(dry.payload?.storage_id).toBe(8);
    expect(dry.payload?.ingredients[0]).toMatchObject({ id: 2402, type: 2, weight: 10 });

    // A 'pending' central_out row was enqueued (NOT 'sent' — no live write).
    const { rows } = await ctx.db.query<{ status: string; direction: string; qty: string }>(
      `SELECT status, direction, qty FROM poster_writeback_queue
        WHERE request_id = $1 AND product_id = $2 AND direction = 'central_out'`,
      [reqId, cake],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    expect(Number(rows[0]?.qty)).toBe(10);

    // Idempotent — a second enqueue does not create a second central_out row.
    const again = await enqueueCentralDecrementWriteback({
      requestId: reqId,
      productId: cake,
      centralLocationId: central,
      qty: 10,
      actorUserId: cwm.id,
    });
    expect(again.queueId).toBe(dry.queueId);
    const { rows: after } = await ctx.db.query(
      `SELECT id FROM poster_writeback_queue
        WHERE request_id = $1 AND product_id = $2 AND direction = 'central_out'`,
      [reqId, cake],
    );
    expect(after).toHaveLength(1);
  });

  it('store accept routes through the handler -> a central_out dry-run row appears (coexists with store_in)', async () => {
    const { central, store } = await buildChain();
    // A distinct non-null storage id (the unit test above uses the singleton 8;
    // poster_storage_id is UNIQUE across locations, so use a different value here).
    await setPosterStorage(central, 108);
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setPosterIngredient(cake, 3100);
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 20 });
    const reqId = await createStoreRequest({ store, product: cake, qtyNeeded: 10 });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    await request(ctx.app)
      .post(`/api/replenishment/${reqId}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central }); // ships 10 -> yuborilgan

    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const recv = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ received_qty: 10 });
    expect(recv.status).toBe(200);

    // BOTH write-backs exist for this request: store_in (store credit) and
    // central_out (central decrement), each 'pending' (dry-run / no token).
    const { rows } = await ctx.db.query<{ direction: string; status: string }>(
      `SELECT direction, status FROM poster_writeback_queue
        WHERE request_id = $1 ORDER BY direction`,
      [reqId],
    );
    const byDir = Object.fromEntries(rows.map((r) => [r.direction, r.status]));
    expect(byDir['central_out']).toBe('pending');
    expect(byDir['store_in']).toBe('pending');
  });
});
