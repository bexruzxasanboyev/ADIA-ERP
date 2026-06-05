/**
 * Store workflow backend (2026-06-05) — AI proposals + approve, central
 * incoming + accept / reject, and the Poster write-back queue insert.
 *
 * Coverage:
 *   proposals       — below-min products surfaced; open-request debounce;
 *                     suggested_qty = max - qty; RBAC (own store only).
 *   approve         — creates requests; duplicate -> status:'exists'; RBAC.
 *   incoming        — central sees store requests targeting it / untargeted.
 *   accept-central  — pins target, ships from central to store (engine reuse).
 *   reject-central  — request -> CANCELLED with closure_reason='rejected'.
 *   writeback queue — enqueuePosterReceiveWriteback inserts a 'pending' row
 *                     (no write token), idempotent per (request, product).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { getQty, makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  acceptByCentral,
  getProposalsForLocation,
} from '../src/services/replenishment.js';
import { enqueuePosterReceiveWriteback } from '../src/services/posterWriteback.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** A store + a central warehouse (no parent link — mirrors live stores). */
async function storeAndCentral(): Promise<{ store: number; central: number }> {
  const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
  const store = await makeLocation(ctx.db, { type: 'store' });
  return { store, central };
}

// ---------------------------------------------------------------------------
// proposals
// ---------------------------------------------------------------------------

describe('GET /api/replenishment/proposals', () => {
  it('surfaces below-min products with suggested_qty = max - qty', async () => {
    const { store } = await storeAndCentral();
    const p1 = await makeProduct(ctx.db, { unit: 'pcs' });
    const p2 = await makeProduct(ctx.db, { unit: 'pcs' });
    // p1 below min, p2 above min (not flagged).
    await setStock(ctx.db, { locationId: store, productId: p1, qty: 2, minLevel: 5, maxLevel: 12 });
    await setStock(ctx.db, { locationId: store, productId: p2, qty: 20, minLevel: 5, maxLevel: 12 });

    const proposals = await getProposalsForLocation(store);
    const ids = proposals.map((p) => p.product_id);
    expect(ids).toContain(p1);
    expect(ids).not.toContain(p2);
    const prop = proposals.find((p) => p.product_id === p1);
    expect(prop?.suggested_qty).toBe(10); // 12 - 2
  });

  it('debounces products that already have an open request', async () => {
    const { store, central } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 1, minLevel: 5, maxLevel: 10 });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    // Approve once -> creates an open request.
    const approve = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: store, items: [{ product_id: p, qty: 9 }] });
    expect(approve.status).toBe(200);
    expect(approve.body.results[0].status).toBe('created');

    // Now the proposal must NOT list it (open request exists).
    const proposals = await getProposalsForLocation(store);
    expect(proposals.map((x) => x.product_id)).not.toContain(p);
    void central;
  });

  it('RBAC: a store manager cannot read another store proposals', async () => {
    const a = await storeAndCentral();
    const b = await storeAndCentral();
    const mgrA = await makeUser(ctx.db, { role: 'store_manager', locationId: a.store });
    const res = await request(ctx.app)
      .get(`/api/replenishment/proposals?location_id=${b.store}`)
      .set('Authorization', `Bearer ${mgrA.token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

describe('POST /api/replenishment/proposals/approve', () => {
  it('creates a request per item; a duplicate is reported as exists', async () => {
    const { store } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const first = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: store, items: [{ product_id: p, qty: 10 }] });
    expect(first.status).toBe(200);
    expect(first.body.results[0].status).toBe('created');
    expect(first.body.results[0].request_id).toBeGreaterThan(0);

    const dup = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: store, items: [{ product_id: p, qty: 10 }] });
    expect(dup.status).toBe(200);
    expect(dup.body.results[0].status).toBe('exists');
  });

  it('RBAC: a store manager cannot approve for another store', async () => {
    const a = await storeAndCentral();
    const b = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: b.store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    const mgrA = await makeUser(ctx.db, { role: 'store_manager', locationId: a.store });
    const res = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${mgrA.token}`)
      .send({ location_id: b.store, items: [{ product_id: p, qty: 10 }] });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// incoming + accept / reject (central)
// ---------------------------------------------------------------------------

describe('central incoming / accept / reject', () => {
  it('incoming lists an untargeted store request; accept-central ships it', async () => {
    const { store, central } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: p, qty: 50 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });

    // Store raises the request via approve.
    const approve = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ location_id: store, items: [{ product_id: p, qty: 10 }] });
    const reqId = approve.body.results[0].request_id as number;

    // Central sees it in its incoming queue (untargeted store request).
    const incoming = await request(ctx.app)
      .get(`/api/replenishment/incoming?location_id=${central}`)
      .set('Authorization', `Bearer ${centralMgr.token}`);
    expect(incoming.status).toBe(200);
    const item = incoming.body.items.find((x: { id: number }) => x.id === reqId);
    expect(item).toBeTruthy();
    expect(item.requester_location_name).toBeTruthy();
    expect(item.qty_needed).toBe(10);

    // Central accepts -> ships from central to store.
    const accept = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept-central`)
      .set('Authorization', `Bearer ${centralMgr.token}`)
      .send({ location_id: central });
    expect(accept.status).toBe(200);
    expect(accept.body.shipped).toBe(true);
    expect(accept.body.request.status).toBe('CLOSED');

    // Stock moved: store credited, central debited.
    expect(await getQty(ctx.db, store, p)).toBe(10);
    expect(await getQty(ctx.db, central, p)).toBe(40);
  });

  it('reject-central -> CANCELLED with closure_reason=rejected', async () => {
    const { store, central } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });

    const approve = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ location_id: store, items: [{ product_id: p, qty: 10 }] });
    const reqId = approve.body.results[0].request_id as number;

    const reject = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/reject-central`)
      .set('Authorization', `Bearer ${centralMgr.token}`)
      .send({ reason: 'out of stock, cannot fulfil' });
    expect(reject.status).toBe(200);
    expect(reject.body.request.status).toBe('CANCELLED');
    expect(reject.body.request.closure_reason).toBe('rejected');
  });

  it('reject-central requires a reason', async () => {
    const { store, central } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });
    const approve = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ location_id: store, items: [{ product_id: p, qty: 10 }] });
    const reqId = approve.body.results[0].request_id as number;
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/reject-central`)
      .set('Authorization', `Bearer ${centralMgr.token}`)
      .send({});
    expect(res.status).toBe(422);
  });

  it('acceptByCentral holds at SHIP when central has no stock', async () => {
    const { store, central } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    // Central has NO stock for p.
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const approve = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ location_id: store, items: [{ product_id: p, qty: 10 }] });
    const reqId = approve.body.results[0].request_id as number;

    const result = await acceptByCentral({
      requestId: reqId,
      centralLocationId: central,
      actorUserId: null,
    });
    expect(result.shipped).toBe(false);
    // No central stock + no production chain -> the engine cannot ship.
    expect(result.request.status).not.toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
// Poster write-back queue
// ---------------------------------------------------------------------------

describe('enqueuePosterReceiveWriteback', () => {
  it('queues a pending row (no write token) and is idempotent', async () => {
    const { store, central } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const approve = await request(ctx.app)
      .post('/api/replenishment/proposals/approve')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ location_id: store, items: [{ product_id: p, qty: 10 }] });
    const reqId = approve.body.results[0].request_id as number;

    const first = await enqueuePosterReceiveWriteback({
      requestId: reqId,
      productId: p,
      locationId: store,
      qty: 7,
      actorUserId: storeMgr.id,
    });
    expect(first.mode).toBe('queued');
    expect(first.queueId).toBeGreaterThan(0);

    const { rows } = await ctx.db.query<{ status: string; qty: string }>(
      'SELECT status, qty FROM poster_writeback_queue WHERE request_id = $1 AND product_id = $2',
      [reqId, p],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    expect(Number(rows[0]?.qty)).toBe(7);

    // Idempotent — second enqueue does not create a second row.
    const second = await enqueuePosterReceiveWriteback({
      requestId: reqId,
      productId: p,
      locationId: store,
      qty: 7,
      actorUserId: storeMgr.id,
    });
    expect(second.queueId).toBe(first.queueId);
    const { rows: after } = await ctx.db.query(
      'SELECT id FROM poster_writeback_queue WHERE request_id = $1 AND product_id = $2',
      [reqId, p],
    );
    expect(after).toHaveLength(1);

    void central;
  });

  it('skips when qty <= 0', async () => {
    const { store } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    const r = await enqueuePosterReceiveWriteback({
      requestId: 999999,
      productId: p,
      locationId: store,
      qty: 0,
      actorUserId: null,
    });
    expect(r.mode).toBe('skipped');
    expect(r.queueId).toBeNull();
  });
});
