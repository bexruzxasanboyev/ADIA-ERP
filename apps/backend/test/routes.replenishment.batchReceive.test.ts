/**
 * 0045 — store-driven request backend: batch create + receive-with-brak.
 *
 *   Batch create:
 *     - store_manager creates several requests in one call; requester is
 *       FORCED to their own store (body location ignored);
 *     - a duplicate open `(product, location)` (invariant 2) is reported as
 *       `status: 'exists'`, NOT a hard failure — the batch keeps going;
 *     - one bad item does not abort the rest.
 *
 *   Receive with brak:
 *     - received_qty stays in the store's sellable stock;
 *     - brak_qty + any un-received remainder is counter-shipped back to the
 *       target (central warehouse) and recorded in brak_qty / brak_reason;
 *     - brak is NOT added to sellable stock.
 *
 * Tests drive the engine through `runEngineCycle` + `advance` so a request
 * reaches CLOSED (status) before the store receives — mirroring live flow.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { getQty, makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { advance, createRequest, runEngineCycle } from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Build the chain: raw_wh -> production -> supply -> central -> store. */
async function chain(): Promise<{ central: number; store: number }> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const production = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const supply = await makeLocation(ctx.db, { type: 'supply', parentId: production });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: supply });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
  return { central, store };
}

/**
 * Drive a fresh request to CLOSED (status). Store starts at `initialQtyStore`,
 * shipped qty = qty_needed, central seeded with `centralStock`.
 */
async function makeClosedRequest(opts: {
  store: number;
  central: number;
  product: number;
  initialQtyStore: number;
  qtyNeeded: number;
  centralStock: number;
}): Promise<number> {
  await setStock(ctx.db, {
    locationId: opts.store,
    productId: opts.product,
    qty: opts.initialQtyStore,
    minLevel: opts.initialQtyStore + 1,
    maxLevel: opts.initialQtyStore + opts.qtyNeeded,
  });
  await setStock(ctx.db, {
    locationId: opts.central,
    productId: opts.product,
    qty: opts.centralStock,
  });
  // Stores no longer auto-raise via scanBelowMin (AI-propose -> boss-approve).
  // Create the store request EXPLICITLY with the qty the scan would have
  // computed (max - qty = (initialQtyStore + qtyNeeded) - initialQtyStore),
  // then drive the engine cycle from there.
  const created = await createRequest({
    productId: opts.product,
    requesterLocationId: opts.store,
    qtyNeeded: opts.qtyNeeded,
    actorUserId: null,
  });
  await runEngineCycle();
  const reqId = created.id;
  for (let i = 0; i < 6; i++) {
    const r = await advance(reqId, null);
    if (r.request.status === 'CLOSED' || r.request.status === 'CANCELLED') break;
    if (!r.advanced) break;
  }
  return reqId;
}

// ---------------------------------------------------------------------------
// Batch create
// ---------------------------------------------------------------------------
describe('POST /api/replenishment/batch', () => {
  it('store_manager creates one request per item (requester forced to own store)', async () => {
    const { store } = await chain();
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const p1 = await makeProduct(ctx.db, { type: 'finished' });
    const p2 = await makeProduct(ctx.db, { type: 'finished' });

    const res = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      // A bogus requester_location_id in the body must be IGNORED for a store_manager.
      .send({
        requester_location_id: 999999,
        items: [
          { product_id: p1, qty_needed: 5 },
          { product_id: p2, qty_needed: 3 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results.every((r: { status: string }) => r.status === 'created')).toBe(true);

    // Both rows landed against the store, not the bogus body location.
    const { rows } = await ctx.db.query<{ requester_location_id: number; product_id: number }>(
      'SELECT requester_location_id, product_id FROM replenishment_requests ORDER BY id',
    );
    expect(rows.every((r) => Number(r.requester_location_id) === store)).toBe(true);
    expect(rows.map((r) => Number(r.product_id)).sort()).toEqual([p1, p2].sort());
  });

  it('a duplicate open request is reported as "exists", not a hard fail', async () => {
    const { store } = await chain();
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const dup = await makeProduct(ctx.db, { type: 'finished' });
    const fresh = await makeProduct(ctx.db, { type: 'finished' });

    // First batch opens a request for `dup`.
    const first = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ items: [{ product_id: dup, qty_needed: 4 }] });
    expect(first.status).toBe(200);
    expect(first.body.results[0].status).toBe('created');

    // Second batch: `dup` is a duplicate (still open) -> 'exists'; `fresh` -> 'created'.
    const second = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({
        items: [
          { product_id: dup, qty_needed: 4 },
          { product_id: fresh, qty_needed: 2 },
        ],
      });
    expect(second.status).toBe(200);
    const byProduct = Object.fromEntries(
      second.body.results.map((r: { product_id: number; status: string }) => [r.product_id, r.status]),
    );
    expect(byProduct[dup]).toBe('exists');
    expect(byProduct[fresh]).toBe('created');
  });

  it('one bad item does not abort the batch (per-item error)', async () => {
    const { store } = await chain();
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const good = await makeProduct(ctx.db, { type: 'finished' });

    const res = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({
        items: [
          { product_id: good, qty_needed: 5 },
          { product_id: good, qty_needed: -1 }, // invalid qty -> per-item error
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('created');
    expect(res.body.results[1].status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Receive with brak (defect)
// ---------------------------------------------------------------------------
describe('POST /api/replenishment/:id/receive', () => {
  it('received_qty stays in store; brak counter-shipped back, not sellable', async () => {
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const reqId = await makeClosedRequest({
      store,
      central,
      product,
      initialQtyStore: 0,
      qtyNeeded: 10,
      centralStock: 50,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    // SHIP moved the full 10 into the store; central = 40.
    expect(await getQty(ctx.db, store, product)).toBe(10);
    expect(await getQty(ctx.db, central, product)).toBe(40);

    // Receive 7 good, 3 brak.
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ received_qty: 7, brak_qty: 3, brak_reason: 'crushed boxes' });

    expect(res.status).toBe(200);
    expect(res.body.request.closure_reason).toBe('accepted_partial');
    expect(Number(res.body.request.qty_accepted)).toBe(7);
    expect(Number(res.body.request.brak_qty)).toBe(3);
    expect(res.body.request.brak_reason).toBe('crushed boxes');

    // Sellable stock = 7 (brak NOT added); brak counter-shipped to central.
    expect(await getQty(ctx.db, store, product)).toBe(7);
    expect(await getQty(ctx.db, central, product)).toBe(43);
  });

  it('full receive with zero brak -> accepted_full, store keeps everything', async () => {
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const reqId = await makeClosedRequest({
      store,
      central,
      product,
      initialQtyStore: 0,
      qtyNeeded: 8,
      centralStock: 20,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ received_qty: 8 });

    expect(res.status).toBe(200);
    expect(res.body.request.closure_reason).toBe('accepted_full');
    expect(Number(res.body.request.brak_qty)).toBe(0);
    // Store keeps all 8; central stays at 20 - 8 = 12 (no counter-movement).
    expect(await getQty(ctx.db, store, product)).toBe(8);
    expect(await getQty(ctx.db, central, product)).toBe(12);
  });

  it('brak_qty without brak_reason -> 422', async () => {
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const reqId = await makeClosedRequest({
      store,
      central,
      product,
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 20,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ received_qty: 3, brak_qty: 2 });
    expect(res.status).toBe(422);
  });

  it('received + brak exceeding shipped qty -> 422', async () => {
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const reqId = await makeClosedRequest({
      store,
      central,
      product,
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 20,
    });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive`)
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ received_qty: 4, brak_qty: 3, brak_reason: 'x' });
    expect(res.status).toBe(422);
  });

  it('a foreign store_manager cannot receive (403)', async () => {
    const { central, store } = await chain();
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const reqId = await makeClosedRequest({
      store,
      central,
      product,
      initialQtyStore: 0,
      qtyNeeded: 5,
      centralStock: 20,
    });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const foreign = await makeUser(ctx.db, { role: 'store_manager', locationId: otherStore });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/receive`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({ received_qty: 5 });
    expect(res.status).toBe(403);
  });
});
