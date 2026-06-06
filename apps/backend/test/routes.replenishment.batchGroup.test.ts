/**
 * 0052 — Grouped basket (batch) backend.
 *
 * A store confirms a basket of below-min products in ONE /batch call; every
 * created line shares a `batch_id`. The central warehouse accepts or rejects
 * the WHOLE basket as one grouped order.
 *
 * Coverage:
 *   /batch                          — returns a batch_id; all created rows share it.
 *   /batch/:id/accept-central       — accepts EVERY still-open line; summary counts.
 *   /batch/:id/reject-central       — cancels EVERY still-open line (rejected).
 *   incoming                        — exposes batch_id so the UI can group rows.
 *   partial failure                 — a failing line is reported, not thrown.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { getQty, makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function storeAndCentral(): Promise<{ store: number; central: number }> {
  const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
  const store = await makeLocation(ctx.db, { type: 'store' });
  return { store, central };
}

describe('POST /api/replenishment/batch — grouped basket', () => {
  it('returns a batch_id and every created row shares it', async () => {
    const { store } = await storeAndCentral();
    const p1 = await makeProduct(ctx.db, { unit: 'pcs' });
    const p2 = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p1, qty: 0, minLevel: 5, maxLevel: 10 });
    await setStock(ctx.db, { locationId: store, productId: p2, qty: 0, minLevel: 5, maxLevel: 10 });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ items: [{ product_id: p1, qty_needed: 10 }, { product_id: p2, qty_needed: 8 }] });

    expect(res.status).toBe(200);
    expect(typeof res.body.batch_id).toBe('number');
    expect(res.body.batch_id).toBeGreaterThan(0);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results.every((r: { status: string }) => r.status === 'created')).toBe(true);

    const batchId = res.body.batch_id as number;
    const { rows } = await ctx.db.query<{ batch_id: string | null }>(
      'SELECT batch_id FROM replenishment_requests WHERE requester_location_id = $1',
      [store],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => Number(r.batch_id) === batchId)).toBe(true);
  });

  it('each /batch call gets a distinct batch_id', async () => {
    const { store } = await storeAndCentral();
    const p1 = await makeProduct(ctx.db, { unit: 'pcs' });
    const p2 = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p1, qty: 0, minLevel: 5, maxLevel: 10 });
    await setStock(ctx.db, { locationId: store, productId: p2, qty: 0, minLevel: 5, maxLevel: 10 });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const a = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ items: [{ product_id: p1, qty_needed: 10 }] });
    const b = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ items: [{ product_id: p2, qty_needed: 8 }] });

    expect(a.body.batch_id).not.toBe(b.body.batch_id);
  });

  it('a duplicate open line is reported as exists, not thrown', async () => {
    const { store } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ items: [{ product_id: p, qty_needed: 10 }] });

    const second = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ items: [{ product_id: p, qty_needed: 10 }] });
    expect(second.status).toBe(200);
    expect(second.body.results[0].status).toBe('exists');
  });
});

describe('POST /api/replenishment/batch/:batch_id/accept-central', () => {
  it('accepts and ships every open line of the basket', async () => {
    const { store, central } = await storeAndCentral();
    const p1 = await makeProduct(ctx.db, { unit: 'pcs' });
    const p2 = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p1, qty: 0, minLevel: 5, maxLevel: 10 });
    await setStock(ctx.db, { locationId: store, productId: p2, qty: 0, minLevel: 5, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: p1, qty: 50 });
    await setStock(ctx.db, { locationId: central, productId: p2, qty: 50 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });

    const batch = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ items: [{ product_id: p1, qty_needed: 10 }, { product_id: p2, qty_needed: 8 }] });
    const batchId = batch.body.batch_id as number;

    const accept = await request(ctx.app)
      .post(`/api/replenishment/batch/${batchId}/accept-central`)
      .set('Authorization', `Bearer ${centralMgr.token}`)
      .send({ location_id: central });

    expect(accept.status).toBe(200);
    expect(accept.body.batch_id).toBe(batchId);
    expect(accept.body.accepted).toBe(2);
    expect(accept.body.shipped).toBe(2);
    expect(accept.body.failed).toHaveLength(0);

    // Stock moved for both lines.
    expect(await getQty(ctx.db, store, p1)).toBe(10);
    expect(await getQty(ctx.db, store, p2)).toBe(8);
  });

  it('reports a per-line failure instead of aborting the batch', async () => {
    const { store, central } = await storeAndCentral();
    const p1 = await makeProduct(ctx.db, { unit: 'pcs' });
    const p2 = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p1, qty: 0, minLevel: 5, maxLevel: 10 });
    await setStock(ctx.db, { locationId: store, productId: p2, qty: 0, minLevel: 5, maxLevel: 10 });
    // central can fulfil p1 but NOT p2 (no stock, no production chain).
    await setStock(ctx.db, { locationId: central, productId: p1, qty: 50 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });

    const batch = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ items: [{ product_id: p1, qty_needed: 10 }, { product_id: p2, qty_needed: 8 }] });
    const batchId = batch.body.batch_id as number;

    const accept = await request(ctx.app)
      .post(`/api/replenishment/batch/${batchId}/accept-central`)
      .set('Authorization', `Bearer ${centralMgr.token}`)
      .send({ location_id: central });

    // The whole call still returns 200; p1 ships, p2 holds (not shipped).
    expect(accept.status).toBe(200);
    expect(accept.body.accepted).toBe(2);
    expect(accept.body.shipped).toBe(1);
    expect(await getQty(ctx.db, store, p1)).toBe(10);
  });

  it('404 when the batch has no open lines', async () => {
    const { central } = await storeAndCentral();
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });
    const res = await request(ctx.app)
      .post('/api/replenishment/batch/99999999/accept-central')
      .set('Authorization', `Bearer ${centralMgr.token}`)
      .send({ location_id: central });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/replenishment/batch/:batch_id/reject-central', () => {
  it('cancels every open line of the basket', async () => {
    const { store, central } = await storeAndCentral();
    const p1 = await makeProduct(ctx.db, { unit: 'pcs' });
    const p2 = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p1, qty: 0, minLevel: 5, maxLevel: 10 });
    await setStock(ctx.db, { locationId: store, productId: p2, qty: 0, minLevel: 5, maxLevel: 10 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });

    const batch = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ items: [{ product_id: p1, qty_needed: 10 }, { product_id: p2, qty_needed: 8 }] });
    const batchId = batch.body.batch_id as number;

    const reject = await request(ctx.app)
      .post(`/api/replenishment/batch/${batchId}/reject-central`)
      .set('Authorization', `Bearer ${centralMgr.token}`)
      .send({ reason: 'cannot fulfil this basket' });

    expect(reject.status).toBe(200);
    expect(reject.body.batch_id).toBe(batchId);
    expect(reject.body.cancelled).toBe(2);

    const { rows } = await ctx.db.query<{ status: string; closure_reason: string }>(
      'SELECT status, closure_reason FROM replenishment_requests WHERE batch_id = $1',
      [batchId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'CANCELLED')).toBe(true);
    expect(rows.every((r) => r.closure_reason === 'rejected')).toBe(true);
  });

  it('requires a reason', async () => {
    const { store, central } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });
    const batch = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ items: [{ product_id: p, qty_needed: 10 }] });
    const batchId = batch.body.batch_id as number;
    const res = await request(ctx.app)
      .post(`/api/replenishment/batch/${batchId}/reject-central`)
      .set('Authorization', `Bearer ${centralMgr.token}`)
      .send({});
    expect(res.status).toBe(422);
  });
});

describe('GET /api/replenishment/incoming — batch_id exposed', () => {
  it('includes batch_id on grouped basket rows', async () => {
    const { store, central } = await storeAndCentral();
    const p = await makeProduct(ctx.db, { unit: 'pcs' });
    await setStock(ctx.db, { locationId: store, productId: p, qty: 0, minLevel: 5, maxLevel: 10 });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const centralMgr = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: central,
    });

    const batch = await request(ctx.app)
      .post('/api/replenishment/batch')
      .set('Authorization', `Bearer ${storeMgr.token}`)
      .send({ items: [{ product_id: p, qty_needed: 10 }] });
    const batchId = batch.body.batch_id as number;
    const reqId = batch.body.results[0].request_id as number;

    const incoming = await request(ctx.app)
      .get(`/api/replenishment/incoming?location_id=${central}`)
      .set('Authorization', `Bearer ${centralMgr.token}`);
    expect(incoming.status).toBe(200);
    const item = incoming.body.items.find((x: { id: number }) => x.id === reqId);
    expect(item).toBeTruthy();
    expect(item.batch_id).toBe(batchId);
  });
});
