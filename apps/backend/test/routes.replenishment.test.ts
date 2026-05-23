/**
 * Sprint 2 hardening — route-level coverage for replenishment endpoints.
 *
 *   GET   /api/replenishment           — invalid ?status (422),
 *                                          location-bound role with no
 *                                          locationId returns [].
 *   GET   /api/replenishment/:id       — 404, 403 from a foreign manager,
 *                                          purchase_order linkage path of
 *                                          `requestTouchesLocation`.
 *   POST  /api/replenishment           — non-pm/non-central 403, missing
 *                                          required fields (422), bad
 *                                          qty_needed (422).
 *   POST  /api/replenishment/:id/cancel — pm cancels OPEN; idempotent on a
 *                                          terminal CANCELLED; non-pm 403.
 *   POST  /api/replenishment/:id/advance — invalid id 422, pm advance on
 *                                          NEW transitions to next state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  createRequest,
  cancelRequest,
  runEngineCycle,
  advance,
} from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Build the full chain topology. */
async function chain(): Promise<{
  rawWh: number; production: number; supply: number; central: number; store: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const supply = await makeLocation(ctx.db, { type: 'supply', parentId: production });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: supply });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
  return { rawWh, production, supply, central, store };
}

// ---------------------------------------------------------------------------
// GET /api/replenishment
// ---------------------------------------------------------------------------
describe('GET /api/replenishment — filter + scope branches', () => {
  it('rejects an unknown ?status= with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/replenishment?status=spaceship')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('filters list by an explicit ?status= (NEW)', async () => {
    const { store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 5, actorUserId: pm.id,
    });
    const res = await request(ctx.app)
      .get('/api/replenishment?status=NEW')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect((res.body as { status: string }[]).every((r) => r.status === 'NEW')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/replenishment/:id
// ---------------------------------------------------------------------------
describe('GET /api/replenishment/:id — RBAC + linkage branches', () => {
  it('returns 404 NOT_FOUND for an unknown id (pm scope short-circuits the join)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/replenishment/9999999')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('returns 403 for a manager whose location does not touch the request', async () => {
    const { store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 3, actorUserId: null,
    });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const intruder = await makeUser(ctx.db, { role: 'store_manager', locationId: otherStore });

    const res = await request(ctx.app)
      .get(`/api/replenishment/${created.id}`)
      .set('Authorization', `Bearer ${intruder.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('grants access via the linked purchase_order to a raw_warehouse_manager', async () => {
    // Build a request that reaches CREATE_PURCHASE_ORDER, so the linked PO's
    // target_location_id (= rawWh) satisfies the rwm's location join.
    const { rawWh, store } = await chain();
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 1)`,
      [finished, raw],
    );
    await setStock(ctx.db, {
      locationId: store, productId: finished, qty: 0, minLevel: 4, maxLevel: 6,
    });
    // Raw warehouse short — engine will raise a PO.
    await setStock(ctx.db, { locationId: rawWh, productId: raw, qty: 1 });

    await runEngineCycle();
    const { rows } = await ctx.db.query<{ id: number }>(
      `SELECT id FROM replenishment_requests
       WHERE product_id = $1 AND requester_location_id = $2`,
      [finished, store],
    );
    const reqId = Number(rows[0]?.id);
    await advance(reqId, null); // -> CHECK_PRODUCTION_INPUT
    await advance(reqId, null); // -> CREATE_PURCHASE_ORDER

    const rwm = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    const res = await request(ctx.app)
      .get(`/api/replenishment/${reqId}`)
      .set('Authorization', `Bearer ${rwm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.request).toBeDefined();
  });

  it('grants access via the linked production_order to a production_manager', async () => {
    const { rawWh, production, store } = await chain();
    const finished = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 1)`,
      [finished, raw],
    );
    await setStock(ctx.db, {
      locationId: store, productId: finished, qty: 0, minLevel: 1, maxLevel: 3,
    });
    await setStock(ctx.db, { locationId: rawWh, productId: raw, qty: 50 });

    await runEngineCycle();
    const { rows } = await ctx.db.query<{ id: number }>(
      `SELECT id FROM replenishment_requests
       WHERE product_id = $1 AND requester_location_id = $2`,
      [finished, store],
    );
    const reqId = Number(rows[0]?.id);
    await advance(reqId, null); // -> CHECK_PRODUCTION_INPUT
    await advance(reqId, null); // -> CREATE_PRODUCTION_ORDER (links a PO at `production`)

    const pmgr = await makeUser(ctx.db, {
      role: 'production_manager', locationId: production,
    });
    const res = await request(ctx.app)
      .get(`/api/replenishment/${reqId}`)
      .set('Authorization', `Bearer ${pmgr.token}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /api/replenishment
// ---------------------------------------------------------------------------
describe('POST /api/replenishment — validation + RBAC', () => {
  it('rejects a missing product_id (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const { store } = await chain();
    const res = await request(ctx.app)
      .post('/api/replenishment')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ requester_location_id: store, qty_needed: 5 });
    expect(res.status).toBe(422);
  });

  it('rejects qty_needed <= 0 (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const { store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/replenishment')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, requester_location_id: store, qty_needed: 0 });
    expect(res.status).toBe(422);
  });

  it('a store_manager cannot create a request (403 — pm + central_warehouse_manager only)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/replenishment')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ product_id: product, requester_location_id: store, qty_needed: 5 });
    expect(res.status).toBe(403);
  });

  it('central_warehouse_manager may create a request (allowed role)', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: central,
    });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const res = await request(ctx.app)
      .post('/api/replenishment')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, requester_location_id: central, qty_needed: 5 });
    expect(res.status).toBe(201);
    expect(res.body.request?.status).toBe('NEW');
  });

  it('returns 409 OPEN_REQUEST_EXISTS when a duplicate is attempted via HTTP', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const { store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });

    const first = await request(ctx.app)
      .post('/api/replenishment')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, requester_location_id: store, qty_needed: 3 });
    expect(first.status).toBe(201);

    const second = await request(ctx.app)
      .post('/api/replenishment')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, requester_location_id: store, qty_needed: 3 });
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('OPEN_REQUEST_EXISTS');
  });
});

// ---------------------------------------------------------------------------
// POST /api/replenishment/:id/cancel
// ---------------------------------------------------------------------------
describe('POST /api/replenishment/:id/cancel', () => {
  it('pm cancels an OPEN request and the row turns CANCELLED', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const { store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 5, actorUserId: pm.id,
    });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/cancel`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ reason: 'product discontinued' });
    expect(res.status).toBe(200);
    expect(res.body.request?.status).toBe('CANCELLED');
  });

  it('cancel is idempotent on an already-cancelled request (200, no error)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const { store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 5, actorUserId: pm.id,
    });
    await cancelRequest(created.id, pm.id, 'first cancel');

    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/cancel`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ reason: 'second cancel' });
    expect(res.status).toBe(200);
    expect(res.body.request?.status).toBe('CANCELLED');
  });

  it('a non-pm cannot cancel (403)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 5, actorUserId: null,
    });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/cancel`)
      .set('Authorization', `Bearer ${storeMgr.token}`);
    expect(res.status).toBe(403);
  });

  it('cancel falls back to a default reason when none is provided (no body)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const { store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const created = await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 5, actorUserId: pm.id,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/cancel`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.request?.status).toBe('CANCELLED');

    const { rows } = await ctx.db.query<{ reason: string | null }>(
      `SELECT reason FROM replenishment_transitions
       WHERE replenishment_id = $1 AND to_status = 'CANCELLED'
       ORDER BY id DESC LIMIT 1`,
      [created.id],
    );
    expect(rows[0]?.reason).toBe('manual cancel');
  });
});

// ---------------------------------------------------------------------------
// POST /api/replenishment/:id/advance — pm super-admin happy path
// ---------------------------------------------------------------------------
describe('POST /api/replenishment/:id/advance — pm super-admin path', () => {
  it('rejects a non-numeric :id with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post('/api/replenishment/abc/advance')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
  });

  it('pm advances NEW -> CHECK_STORE_SUPPLIER and the response envelope is populated', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    // Need stock at the target so the engine has a route forward.
    await setStock(ctx.db, { locationId: central, productId: product, qty: 20 });
    const created = await createRequest({
      productId: product, requesterLocationId: store, qtyNeeded: 5, actorUserId: pm.id,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${created.id}/advance`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.advanced).toBe(true);
    expect(res.body.status).toBe('CHECK_STORE_SUPPLIER');
    expect(res.body.request).toBeDefined();
  });
});

