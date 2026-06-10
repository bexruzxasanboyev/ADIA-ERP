/**
 * Sprint 2 hardening — route-level coverage for stock endpoints.
 *
 * Targets:
 *   POST  /api/stock/movement   — neither endpoint, missing qty, qty=0, same
 *                                 from/to location (422), upsert path of
 *                                 INSERT-into-empty-stock when destination
 *                                 has no row.
 *   PATCH /api/stock/minmax     — negative levels, missing fields, creates
 *                                 a fresh stock row when none exists.
 *   GET   /api/stock?location_id= — invalid id_param (422); ai_assistant can
 *                                   pass an explicit filter; null location
 *                                   manager returns an empty list.
 *   GET   /api/stock/movements  — clamp branches (limit too big -> capped;
 *                                 limit non-int -> default; offset; product
 *                                 filter; ai_assistant unfiltered list).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// POST /api/stock/movement — extra validation branches
// ---------------------------------------------------------------------------
describe('POST /api/stock/movement — validation edge cases', () => {
  it('rejects a movement with neither from nor to (422)', async () => {
    // PM is read-only on movements (owner-approved 2026-05-28) — use an
    // operator whose locationIds cover the endpoint locations involved.
    const loc = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: loc,
    });
    const product = await makeProduct(ctx.db);
    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, qty: 1, reason: 'adjust' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a missing qty (422)', async () => {
    const product = await makeProduct(ctx.db);
    const loc = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: loc,
    });
    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, to_location_id: loc });
    expect(res.status).toBe(422);
  });

  it('rejects qty <= 0 (422)', async () => {
    const product = await makeProduct(ctx.db);
    const loc = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: loc,
    });
    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, to_location_id: loc, qty: 0 });
    expect(res.status).toBe(422);
  });

  it('PM is read-only — movement is 403 (no super-admin bypass)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const product = await makeProduct(ctx.db);
    const res = await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: product, to_location_id: loc, qty: 5 });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/stock/minmax — branches
// ---------------------------------------------------------------------------
describe('PATCH /api/stock/minmax — boundary branches', () => {
  // minmax is gated by authorizeWrite (owner 2026-06-06: pm is operational
  // view-only), so these branch tests drive it as the location's own manager.
  it('rejects a negative min_level (422)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const product = await makeProduct(ctx.db);
    const res = await request(ctx.app)
      .patch('/api/stock/minmax')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: loc, product_id: product, min_level: -1, max_level: 5 });
    expect(res.status).toBe(422);
  });

  it('rejects a missing required field (location_id) with 422', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const product = await makeProduct(ctx.db);
    const res = await request(ctx.app)
      .patch('/api/stock/minmax')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ product_id: product, min_level: 0, max_level: 5 });
    expect(res.status).toBe(422);
  });

  it('creates a fresh stock row when (location, product) had none (upsert insert branch)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const product = await makeProduct(ctx.db);
    const res = await request(ctx.app)
      .patch('/api/stock/minmax')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ location_id: loc, product_id: product, min_level: 1, max_level: 8 });
    expect(res.status).toBe(200);
    expect(Number(res.body.stock?.qty)).toBe(0); // freshly inserted at qty=0
    expect(Number(res.body.stock?.min_level)).toBe(1);
    expect(Number(res.body.stock?.max_level)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// GET /api/stock — extra branches
// ---------------------------------------------------------------------------
describe('GET /api/stock — query + RBAC branches', () => {
  it('rejects a non-integer location_id query (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/stock?location_id=abc')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('ai_assistant may pass an explicit location_id filter', async () => {
    const ai = await makeUser(ctx.db, { role: 'ai_assistant' });
    const wh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: wh, productId: product, qty: 7 });

    const res = await request(ctx.app)
      .get(`/api/stock?location_id=${wh}`)
      .set('Authorization', `Bearer ${ai.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(
      (res.body as { location_id: number }[]).every((r) => Number(r.location_id) === wh),
    ).toBe(true);
  });

  // F-J — catalog=finished: the STORE products view shows the WHOLE finished
  // catalogue, with synthetic qty/min/max = 0 rows for products that have no
  // stock row at the location yet (the НАПОЛЕОН-(ЦЕЛЫЙ)-invisible-at-Кукча bug).
  it('catalog=finished returns finished products without a stock row (qty 0)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const stocked = await makeProduct(ctx.db, { type: 'finished' });
    const unstocked = await makeProduct(ctx.db, { type: 'finished' });
    const raw = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, {
      locationId: store, productId: stocked, qty: 5, minLevel: 1, maxLevel: 9,
    });

    const res = await request(ctx.app)
      .get(`/api/stock?location_id=${store}&catalog=finished`)
      .set('Authorization', `Bearer ${sm.token}`);
    expect(res.status).toBe(200);
    const rows = res.body as {
      product_id: number; qty: string | number;
      min_level: string | number; max_level: string | number;
      updated_at: string | null;
    }[];
    const stockedRow = rows.find((r) => Number(r.product_id) === stocked);
    const unstockedRow = rows.find((r) => Number(r.product_id) === unstocked);
    // The real row keeps its numbers; the catalog-only row synthesises zeros.
    expect(Number(stockedRow?.qty)).toBe(5);
    expect(Number(stockedRow?.max_level)).toBe(9);
    expect(unstockedRow).toBeDefined();
    expect(Number(unstockedRow?.qty)).toBe(0);
    expect(Number(unstockedRow?.min_level)).toBe(0);
    expect(Number(unstockedRow?.max_level)).toBe(0);
    expect(unstockedRow?.updated_at).toBeNull();
    // Non-finished products never appear in the catalogue view.
    expect(rows.some((r) => Number(r.product_id) === raw)).toBe(false);
  });

  it('catalog=finished without location_id is rejected (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/stock?catalog=finished')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// GET /api/stock/movements — pagination + filter branches
// ---------------------------------------------------------------------------
describe('GET /api/stock/movements — pagination + filter branches', () => {
  it('clamps an oversize limit down to the page-size cap', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/stock/movements?limit=9999')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    // Cap is 100 per the route module.
    expect(res.body.limit).toBeLessThanOrEqual(100);
  });

  it('falls back to the default page size when limit is not an integer', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/stock/movements?limit=banana')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    // The default exposed by the route is 50.
    expect(res.body.limit).toBe(50);
  });

  it('clamps a negative limit up to the floor (>= 1) and a negative offset to 0', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/stock/movements?limit=-5&offset=-9')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBeGreaterThanOrEqual(1);
    expect(res.body.offset).toBe(0);
  });

  it('supports a product_id filter — only matching movements come back', async () => {
    const from = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const to = await makeLocation(ctx.db, { type: 'store' });
    // The operator must own at least one endpoint of each movement — the
    // central warehouse manager owns `from`.
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager', locationId: from,
    });
    const productA = await makeProduct(ctx.db);
    const productB = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: from, productId: productA, qty: 10 });
    await setStock(ctx.db, { locationId: from, productId: productB, qty: 10 });

    // Produce one movement per product.
    await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: productA, from_location_id: from, to_location_id: to,
        qty: 1, reason: 'transfer',
      });
    await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({
        product_id: productB, from_location_id: from, to_location_id: to,
        qty: 1, reason: 'transfer',
      });

    // PM may still read the movements list (read-and-recommend).
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get(`/api/stock/movements?product_id=${productA}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(
      (res.body.items as { product_id: number }[]).every(
        (m) => Number(m.product_id) === productA,
      ),
    ).toBe(true);
    // Direction-chip contract: each row exposes BOTH location ids (alongside
    // the names), so the Tranzaksiyalar list can derive Kirish / Chiqish /
    // Ko‘chirish without a second round-trip. Here both endpoints are set.
    const rowA = (
      res.body.items as { from_location_id: number | null; to_location_id: number | null }[]
    )[0];
    expect(rowA).toBeDefined();
    expect(rowA?.from_location_id).toBe(from);
    expect(rowA?.to_location_id).toBe(to);
  });

  it('exposes from_location_id / to_location_id for every direction (Kirish / Chiqish / Ko‘chirish)', async () => {
    // The Tranzaksiyalar list derives a direction chip purely from these two
    // ids: from=null -> Kirish (receipt), to=null -> Chiqish (issue), both set
    // -> Ko‘chirish (transfer). Pin all three shapes on the response items.
    const wh = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store' });
    const cwm = await makeUser(ctx.db, {
      role: 'central_warehouse_manager',
      locationId: wh,
    });
    const product = await makeProduct(ctx.db);
    await setStock(ctx.db, { locationId: wh, productId: product, qty: 100 });

    // Ko‘chirish: wh -> store (both endpoints).
    await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, from_location_id: wh, to_location_id: store, qty: 5, reason: 'transfer' });
    // Chiqish: wh -> (none) — an adjust-out the warehouse manager owns.
    await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, from_location_id: wh, qty: 2, reason: 'adjust' });
    // Kirish: (none) -> wh — an adjust-in the warehouse manager owns.
    await request(ctx.app)
      .post('/api/stock/movement')
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ product_id: product, to_location_id: wh, qty: 3, reason: 'adjust' });

    const res = await request(ctx.app)
      .get(`/api/stock/movements?product_id=${product}`)
      .set('Authorization', `Bearer ${cwm.token}`);
    expect(res.status).toBe(200);

    type Row = { from_location_id: number | null; to_location_id: number | null };
    const items = res.body.items as Row[];
    expect(items.length).toBe(3);
    // Every row carries both keys (nullable) — the contract the chip relies on.
    for (const m of items) {
      expect(m).toHaveProperty('from_location_id');
      expect(m).toHaveProperty('to_location_id');
    }
    const transfer = items.find((m) => m.from_location_id === wh && m.to_location_id === store);
    const chiqish = items.find((m) => m.from_location_id === wh && m.to_location_id === null);
    const kirish = items.find((m) => m.from_location_id === null && m.to_location_id === wh);
    expect(transfer).toBeDefined(); // Ko‘chirish
    expect(chiqish).toBeDefined(); // Chiqish
    expect(kirish).toBeDefined(); // Kirish
  });

  it('a scoped manager asking for another location is forbidden (403)', async () => {
    const own = await makeLocation(ctx.db, { type: 'store' });
    const other = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: own });
    const res = await request(ctx.app)
      .get(`/api/stock/movements?location_id=${other}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });
});
