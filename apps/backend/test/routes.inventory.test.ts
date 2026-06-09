/**
 * TZ Module 11 — inventory routes integration tests.
 *
 * Covers (against the real per-suite schema, via supertest):
 *   - PATCH /api/products/:id/whole-piece — set / clear coefficients + RBAC +
 *     validation;
 *   - GET  /api/inventory/end-of-day — decomposition, only whole-and-sliced
 *     products with stock>0, RBAC scoping;
 *   - POST /api/inventory/count — counted_qty conversion, diff up/down, the
 *     atomic 'adjust' movement reconciles stock, the never-negative guard,
 *     idempotency on a same-day re-count (NO double adjust), RBAC;
 *   - GET  /api/inventory/counts — history newest-first, RBAC scoping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser, makeLocation, makeProduct, setStock, getQty } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

/** Set the whole↔piece coefficients on a product directly (test shortcut). */
async function setCoefficients(
  productId: number,
  weightPerWhole: number | null,
  piecesPerWhole: number | null,
): Promise<void> {
  await ctx.db.query(
    'UPDATE products SET weight_per_whole = $2, pieces_per_whole = $3 WHERE id = $1',
    [productId, weightPerWhole, piecesPerWhole],
  );
}

/** Count rows in inventory_counts for a (location, product). */
async function countRows(locationId: number, productId: number): Promise<number> {
  const { rows } = await ctx.db.query<{ n: string }>(
    'SELECT count(*) AS n FROM inventory_counts WHERE location_id = $1 AND product_id = $2',
    [locationId, productId],
  );
  return Number(rows[0]?.n);
}

/** Count adjust movements that touch a (location, product). */
async function adjustMovementCount(locationId: number, productId: number): Promise<number> {
  const { rows } = await ctx.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM stock_movements
      WHERE product_id = $2 AND reason = 'adjust'
        AND (from_location_id = $1 OR to_location_id = $1)`,
    [locationId, productId],
  );
  return Number(rows[0]?.n);
}

describe('PATCH /api/products/:id/whole-piece', () => {
  it('pm sets both coefficients and they surface on the product + list', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });

    const res = await request(ctx.app)
      .patch(`/api/products/${product}/whole-piece`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ weight_per_whole: 1.0, pieces_per_whole: 8 });
    expect(res.status).toBe(200);
    expect(res.body.product.weight_per_whole).toBe(1.0);
    expect(res.body.product.pieces_per_whole).toBe(8);

    const list = await request(ctx.app)
      .get('/api/products')
      .set('Authorization', `Bearer ${pm.token}`);
    const row = (list.body as { id: number; weight_per_whole: number | null }[]).find(
      (p) => Number(p.id) === product,
    );
    expect(row?.weight_per_whole).toBe(1.0);
  });

  it('clears a coefficient with null (either side independently)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(product, 1.0, 8);

    const res = await request(ctx.app)
      .patch(`/api/products/${product}/whole-piece`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ weight_per_whole: null, pieces_per_whole: null });
    expect(res.status).toBe(200);
    expect(res.body.product.weight_per_whole).toBeNull();
    expect(res.body.product.pieces_per_whole).toBeNull();
  });

  it('production_manager may set coefficients', async () => {
    const pmgr = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: await makeLocation(ctx.db, { type: 'production' }),
    });
    const product = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    const res = await request(ctx.app)
      .patch(`/api/products/${product}/whole-piece`)
      .set('Authorization', `Bearer ${pmgr.token}`)
      .send({ weight_per_whole: 1.6, pieces_per_whole: 10 });
    expect(res.status).toBe(200);
    expect(res.body.product.pieces_per_whole).toBe(10);
  });

  it('a store manager cannot set coefficients (403)', async () => {
    const mgr = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: await makeLocation(ctx.db, { type: 'store' }),
    });
    const product = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    const res = await request(ctx.app)
      .patch(`/api/products/${product}/whole-piece`)
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ weight_per_whole: 1.0, pieces_per_whole: 8 });
    expect(res.status).toBe(403);
  });

  it('rejects a non-positive coefficient (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const product = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    const res = await request(ctx.app)
      .patch(`/api/products/${product}/whole-piece`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ weight_per_whole: 0, pieces_per_whole: 8 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('404 for a missing product', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .patch(`/api/products/99999999/whole-piece`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ weight_per_whole: 1.0, pieces_per_whole: 8 });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/inventory/end-of-day', () => {
  it('decomposes system qty into whole/pieces for whole-and-sliced products', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8); // slice = 0.125 kg
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 2.5 });

    const res = await request(ctx.app)
      .get(`/api/inventory/end-of-day?location_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const item = (res.body.items as { product_id: number; whole: number; pieces: number }[]).find(
      (i) => i.product_id === cake,
    );
    expect(item).toBeDefined();
    expect(item?.whole).toBe(2);
    expect(item?.pieces).toBe(4); // 0.5 kg tail / 0.125 = 4 slices
  });

  it('skips products without coefficients and products with zero stock', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const sliced = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    const loose = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    const slicedNoStock = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(sliced, 1.0, 8);
    await setCoefficients(slicedNoStock, 1.0, 8);
    // `loose` has no coefficients.
    await setStock(ctx.db, { locationId: store, productId: sliced, qty: 3 });
    await setStock(ctx.db, { locationId: store, productId: loose, qty: 5 });
    await setStock(ctx.db, { locationId: store, productId: slicedNoStock, qty: 0 });

    const res = await request(ctx.app)
      .get(`/api/inventory/end-of-day?location_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = (res.body.items as { product_id: number }[]).map((i) => i.product_id);
    expect(ids).toContain(sliced);
    expect(ids).not.toContain(loose);
    expect(ids).not.toContain(slicedNoStock);
  });

  it('defaults date to today when omitted', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const res = await request(ctx.app)
      .get(`/api/inventory/end-of-day?location_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('requires location_id (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/inventory/end-of-day')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
  });

  it('a store manager sees its own location but not another (403)', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });

    const own = await request(ctx.app)
      .get(`/api/inventory/end-of-day?location_id=${ownStore}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(own.status).toBe(200);

    const foreign = await request(ctx.app)
      .get(`/api/inventory/end-of-day?location_id=${otherStore}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(foreign.status).toBe(403);
  });
});

describe('POST /api/inventory/count', () => {
  it('records a count with NO diff (counted matches system) — no movement', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 2.5 });

    // 2 whole + 4 slices = 2.5 kg → matches system 2.5.
    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: ownStore,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 2,
        counted_pieces: 4,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(201);
    expect(res.body.count.counted_qty).toBeCloseTo(2.5, 4);
    expect(res.body.count.diff_qty).toBeCloseTo(0, 4);
    expect(res.body.count.adjustment_movement_id).toBeNull();
    expect(await getQty(ctx.db, ownStore, cake)).toBeCloseTo(2.5, 4);
    expect(await adjustMovementCount(ownStore, cake)).toBe(0);
  });

  it('a SHORTAGE count (counted < system) issues an adjust DOWN to counted', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 3.0 });

    // Counted 2 whole + 0 slices = 2.0 kg; system 3.0 → diff -1.0.
    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: ownStore,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 2,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(201);
    expect(res.body.count.diff_qty).toBeCloseTo(-1.0, 4);
    expect(res.body.count.adjustment_movement_id).not.toBeNull();
    // Stock reconciled DOWN to exactly the counted qty.
    expect(await getQty(ctx.db, ownStore, cake)).toBeCloseTo(2.0, 4);
  });

  it('a SURPLUS count (counted > system) receives an adjust UP to counted', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 1.0 });

    // Counted 3 whole = 3.0 kg; system 1.0 → diff +2.0.
    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: ownStore,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 3,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(201);
    expect(res.body.count.diff_qty).toBeCloseTo(2.0, 4);
    expect(await getQty(ctx.db, ownStore, cake)).toBeCloseTo(3.0, 4);
  });

  it('is IDEMPOTENT on a same-day re-count with identical figures — no double adjust', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 3.0 });

    const body = {
      location_id: ownStore,
      product_id: cake,
      count_date: '2026-06-09',
      counted_whole: 2,
      counted_pieces: 4, // 2.5 kg
      counted_remnant_kg: 0,
    };

    // First count: system 3.0 → 2.5, diff -0.5, ONE adjust movement.
    const first = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.count.diff_qty).toBeCloseTo(-0.5, 4);
    expect(await getQty(ctx.db, ownStore, cake)).toBeCloseTo(2.5, 4);
    expect(await adjustMovementCount(ownStore, cake)).toBe(1);

    // Re-count the SAME figures: stock is already 2.5, so diff 0 → NO new
    // movement, and the inventory_counts row is REPLACED (still exactly one).
    const second = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body.count.diff_qty).toBeCloseTo(0, 4);
    expect(second.body.count.adjustment_movement_id).toBeNull();
    // Stock NOT double-adjusted; still exactly one adjust movement; one row.
    expect(await getQty(ctx.db, ownStore, cake)).toBeCloseTo(2.5, 4);
    expect(await adjustMovementCount(ownStore, cake)).toBe(1);
    expect(await countRows(ownStore, cake)).toBe(1);
  });

  it('a CORRECTED same-day re-count re-baselines against current stock (no double count)', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 3.0 });

    // First count says 2.0 → stock becomes 2.0 (diff -1.0).
    await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: ownStore,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 2,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(await getQty(ctx.db, ownStore, cake)).toBeCloseTo(2.0, 4);

    // Operator realises they miscounted: it is actually 4.0. Re-count → stock
    // re-baselined from 2.0 to 4.0 (NOT 3.0→4.0, NOT 2.0+4.0), exactly 4.0.
    const corrected = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: ownStore,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 4,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(corrected.status).toBe(201);
    expect(corrected.body.count.system_qty).toBeCloseTo(2.0, 4); // re-baselined
    expect(corrected.body.count.diff_qty).toBeCloseTo(2.0, 4);
    expect(corrected.body.count.counted_qty).toBeCloseTo(4.0, 4);
    expect(await getQty(ctx.db, ownStore, cake)).toBeCloseTo(4.0, 4);
    expect(await countRows(ownStore, cake)).toBe(1);
  });

  it('never drives stock negative: a count to 0 with existing stock is a clean adjust DOWN', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 2.0 });

    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: ownStore,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 0,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(201);
    expect(res.body.count.counted_qty).toBeCloseTo(0, 4);
    expect(res.body.count.diff_qty).toBeCloseTo(-2.0, 4);
    expect(await getQty(ctx.db, ownStore, cake)).toBeCloseTo(0, 4);
  });

  it('the count + adjust are ATOMIC and audit-logged in one transaction', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 1.0 });

    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: ownStore,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 2,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(201);
    const movementId = res.body.count.adjustment_movement_id as number;
    // The movement row, the stock change, the count row and the audit row all
    // landed together.
    const mv = await ctx.db.query<{ reason: string; to_location_id: string | null }>(
      'SELECT reason, to_location_id FROM stock_movements WHERE id = $1',
      [movementId],
    );
    expect(mv.rows[0]?.reason).toBe('adjust');
    expect(Number(mv.rows[0]?.to_location_id)).toBe(ownStore);
    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'inventory.count' AND entity = 'inventory_counts'
          AND entity_id = $1`,
      [res.body.count.id],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('pm may post a count (TZ-11 contract: pm or the location manager)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 2.0 });

    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        location_id: store,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 1,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(201);
    expect(await getQty(ctx.db, store, cake)).toBeCloseTo(1.0, 4);
  });

  it("a store manager cannot count another store's stock (403)", async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: otherStore, productId: cake, qty: 2.0 });

    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: otherStore,
        product_id: cake,
        count_date: '2026-06-09',
        counted_whole: 1,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(403);
    // Other store's stock untouched.
    expect(await getQty(ctx.db, otherStore, cake)).toBeCloseTo(2.0, 4);
  });

  it('rejects a count for a product without coefficients (422)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const loose = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setStock(ctx.db, { locationId: store, productId: loose, qty: 2.0 });

    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: store,
        product_id: loose,
        count_date: '2026-06-09',
        counted_whole: 1,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(422);
  });

  it('rejects a malformed count_date (422)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 2.0 });

    const res = await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({
        location_id: store,
        product_id: cake,
        count_date: '09-06-2026',
        counted_whole: 1,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/inventory/counts', () => {
  it('returns history newest-first, RBAC-scoped to the manager location', async () => {
    const ownStore = await makeLocation(ctx.db, { type: 'store' });
    const otherStore = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: ownStore });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: ownStore, productId: cake, qty: 5.0 });
    await setStock(ctx.db, { locationId: otherStore, productId: cake, qty: 5.0 });

    // Two counts on the manager's store on different days.
    for (const [day, whole] of [
      ['2026-06-07', 4],
      ['2026-06-08', 3],
    ] as const) {
      await request(ctx.app)
        .post('/api/inventory/count')
        .set('Authorization', `Bearer ${mgr.token}`)
        .send({
          location_id: ownStore,
          product_id: cake,
          count_date: day,
          counted_whole: whole,
          counted_pieces: 0,
          counted_remnant_kg: 0,
        });
    }
    // A count on the OTHER store (by pm) — must NOT appear in the manager view.
    await request(ctx.app)
      .post('/api/inventory/count')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        location_id: otherStore,
        product_id: cake,
        count_date: '2026-06-08',
        counted_whole: 1,
        counted_pieces: 0,
        counted_remnant_kg: 0,
      });

    const res = await request(ctx.app)
      .get('/api/inventory/counts')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    const items = res.body.items as { location_id: number; count_date: string }[];
    // Only the manager's own store.
    expect(items.every((i) => i.location_id === ownStore)).toBe(true);
    // Newest first.
    expect(items[0]?.count_date).toBe('2026-06-08');
    expect(items[1]?.count_date).toBe('2026-06-07');
  });

  it('filters by from/to date window', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'kg' });
    await setCoefficients(cake, 1.0, 8);
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 9.0 });

    for (const day of ['2026-05-01', '2026-05-15', '2026-05-31']) {
      await request(ctx.app)
        .post('/api/inventory/count')
        .set('Authorization', `Bearer ${pm.token}`)
        .send({
          location_id: store,
          product_id: cake,
          count_date: day,
          counted_whole: 1,
          counted_pieces: 0,
          counted_remnant_kg: 0,
        });
    }

    const res = await request(ctx.app)
      .get(`/api/inventory/counts?location_id=${store}&from=2026-05-10&to=2026-05-20`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const days = (res.body.items as { count_date: string }[]).map((i) => i.count_date);
    expect(days).toEqual(['2026-05-15']);
  });
});
