/**
 * F-F — GET /api/purchase-orders/signals ("Xarid signallari").
 *
 * The raw-warehouse "buy needed" surface (spec §12/§14/§17 row F-F). Poster
 * stays read-only; this endpoint only SIGNALS below-min raw stock so the
 * raw-warehouse keeper can raise a PO draft from it.
 *
 * Coverage:
 *   - a below-min raw row surfaces with the right suggested_qty (max - qty);
 *   - an above-min raw row is ABSENT;
 *   - a max_level=0 raw row is ABSENT (unconfigured product);
 *   - an open (draft/approved) PO for the product sets open_purchase_order_id;
 *     a received PO leaves it null again;
 *   - an open replenishment for (product, raw location) sets open_request_id;
 *   - non-raw locations (store / sex_storage) below min NEVER appear;
 *   - the pinned response shape (numeric fields, both poster ids);
 *   - ordering: most-starved (qty/min_level) first, then name;
 *   - RBAC: a scoped raw_warehouse_manager sees only its own location; PM sees
 *     all; an out-of-list role is 403; no token is 401.
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

type Signal = {
  product_id: number;
  name: string;
  unit: string;
  location_id: number;
  location_name: string;
  qty: number;
  min_level: number;
  max_level: number;
  suggested_qty: number;
  poster_product_id: number | null;
  poster_ingredient_id: number | null;
  open_purchase_order_id: number | null;
  open_request_id: number | null;
};

/**
 * Insert a purchase order in a given status; returns its id. An `approved`
 * (or `received`) row must satisfy `chk_po_approved_consistency` — BOTH
 * `*_approved_by` columns set — so we stamp a created_by actor on those.
 */
async function makePO(
  productId: number,
  rawWh: number,
  status: 'draft' | 'approved' | 'received',
): Promise<number> {
  let approver: number | null = null;
  if (status !== 'draft') {
    const actor = await makeUser(ctx.db, { role: 'pm' });
    approver = actor.id;
  }
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO purchase_orders
       (product_id, qty, target_location_id, status,
        manager_approved_by, keeper_approved_by)
     VALUES ($1, 10, $2, $3, $4, $4) RETURNING id`,
    [productId, rawWh, status, approver],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('makePO: insert returned no id');
  }
  return Number(id);
}

/** Open a replenishment request with the raw warehouse as the requester. */
async function makeRequest(productId: number, rawWh: number): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, qty_needed, status)
     VALUES ($1, $2, 5, 'NEW') RETURNING id`,
    [productId, rawWh],
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error('makeRequest: insert returned no id');
  }
  return Number(id);
}

// ---------------------------------------------------------------------------
// Core semantics — which rows surface, and the suggested_qty
// ---------------------------------------------------------------------------
describe('GET /api/purchase-orders/signals — which rows surface', () => {
  it('a below-min raw row surfaces with suggested_qty = max - qty', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 4, minLevel: 10, maxLevel: 50 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);

    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    expect(row).toBeDefined();
    expect(row?.qty).toBe(4);
    expect(row?.min_level).toBe(10);
    expect(row?.max_level).toBe(50);
    expect(row?.suggested_qty).toBe(46); // 50 - 4
    expect(row?.name).toBe('Un');
    expect(row?.unit).toBe('kg');
    expect(row?.location_id).toBe(rawWh);
    expect(row?.open_purchase_order_id).toBe(null);
    expect(row?.open_request_id).toBe(null);
  });

  it('an above-min raw row is absent', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    // qty (20) > min (10) — comfortably stocked.
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 20, minLevel: 10, maxLevel: 50 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const signals = res.body.signals as Signal[];
    expect(signals.find((s) => s.product_id === product && s.location_id === rawWh)).toBeUndefined();
  });

  it('a qty == min_level boundary row surfaces (<= is inclusive)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 10, minLevel: 10, maxLevel: 40 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    expect(row).toBeDefined();
    expect(row?.suggested_qty).toBe(30); // 40 - 10
  });

  it('a max_level=0 row is absent (unconfigured product)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    // qty 0 <= min 0 holds, but max_level 0 means "not configured" -> no signal.
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 0, minLevel: 0, maxLevel: 0 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    expect(signals.find((s) => s.product_id === product && s.location_id === rawWh)).toBeUndefined();
  });

  it('a min_level=0 starved raw row (qty 0, max > 0) still surfaces', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    // qty 0 <= min 0 AND max 25 > 0 -> a real, maximally-starved signal.
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 0, minLevel: 0, maxLevel: 25 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    expect(row).toBeDefined();
    expect(row?.suggested_qty).toBe(25); // 25 - 0
  });
});

// ---------------------------------------------------------------------------
// Non-raw locations NEVER appear
// ---------------------------------------------------------------------------
describe('GET /api/purchase-orders/signals — only raw warehouses', () => {
  it('a store below min never appears', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: store, productId: product, qty: 1, minLevel: 10, maxLevel: 50 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    expect(signals.find((s) => s.location_id === store)).toBeUndefined();
  });

  it('a sex_storage below min never appears', async () => {
    const sex = await makeLocation(ctx.db, { type: 'sex_storage' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    await setStock(ctx.db, { locationId: sex, productId: product, qty: 1, minLevel: 10, maxLevel: 50 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    expect(signals.find((s) => s.location_id === sex)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// open_purchase_order_id debounce
// ---------------------------------------------------------------------------
describe('GET /api/purchase-orders/signals — open_purchase_order_id', () => {
  it('a draft PO for the product sets open_purchase_order_id (row still returned)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 2, minLevel: 10, maxLevel: 30 });
    const poId = await makePO(product, rawWh, 'draft');

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    // Still surfaced (UI greys it) — NOT filtered out.
    expect(row).toBeDefined();
    expect(row?.open_purchase_order_id).toBe(poId);
  });

  it('an approved PO also counts as open', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 2, minLevel: 10, maxLevel: 30 });
    const poId = await makePO(product, rawWh, 'approved');

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    expect(row?.open_purchase_order_id).toBe(poId);
  });

  it('a received PO leaves open_purchase_order_id null', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 2, minLevel: 10, maxLevel: 30 });
    await makePO(product, rawWh, 'received');

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    expect(row).toBeDefined();
    expect(row?.open_purchase_order_id).toBe(null);
  });

  it('a PO for the same product at a DIFFERENT raw warehouse does not leak', async () => {
    const rawA = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const rawB = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawA, productId: product, qty: 2, minLevel: 10, maxLevel: 30 });
    // open PO targets rawB, not rawA — must not grey rawA's signal.
    await makePO(product, rawB, 'draft');

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const rowA = signals.find((s) => s.product_id === product && s.location_id === rawA);
    expect(rowA?.open_purchase_order_id).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// open_request_id debounce
// ---------------------------------------------------------------------------
describe('GET /api/purchase-orders/signals — open_request_id', () => {
  it('an open replenishment for (product, raw location) sets open_request_id', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 2, minLevel: 10, maxLevel: 30 });
    const reqId = await makeRequest(product, rawWh);

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    expect(row?.open_request_id).toBe(reqId);
  });

  it('a CLOSED replenishment leaves open_request_id null', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 2, minLevel: 10, maxLevel: 30 });
    const reqId = await makeRequest(product, rawWh);
    await ctx.db.query(`UPDATE replenishment_requests SET status = 'CLOSED' WHERE id = $1`, [reqId]);

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    expect(row).toBeDefined();
    expect(row?.open_request_id).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Response shape + ordering
// ---------------------------------------------------------------------------
describe('GET /api/purchase-orders/signals — shape + ordering', () => {
  it('exposes the pinned shape with poster ids and numeric fields', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Shakar' });
    // Stamp Poster ids so the optional fields are non-null in the shape.
    await ctx.db.query(
      `UPDATE products SET poster_ingredient_id = 7777, poster_product_id = 8888 WHERE id = $1`,
      [product],
    );
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 3, minLevel: 10, maxLevel: 30 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = res.body.signals as Signal[];
    const row = signals.find((s) => s.product_id === product && s.location_id === rawWh);
    expect(row).toEqual({
      product_id: product,
      name: 'Shakar',
      unit: 'kg',
      location_id: rawWh,
      location_name: expect.any(String),
      qty: 3,
      min_level: 10,
      max_level: 30,
      suggested_qty: 27,
      poster_product_id: 8888,
      poster_ingredient_id: 7777,
      open_purchase_order_id: null,
      open_request_id: null,
    });
    // Numeric, not string.
    expect(typeof row?.qty).toBe('number');
    expect(typeof row?.suggested_qty).toBe('number');
  });

  it('orders most-starved (qty/min_level) first', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const starved = await makeProduct(ctx.db, { type: 'raw', name: 'ZZZ-starved' });
    const mild = await makeProduct(ctx.db, { type: 'raw', name: 'AAA-mild' });
    // starved ratio 1/10 = 0.1 ; mild ratio 8/10 = 0.8 -> starved first despite
    // its name sorting AFTER mild's (proving ratio dominates the name tiebreak).
    await setStock(ctx.db, { locationId: rawWh, productId: starved, qty: 1, minLevel: 10, maxLevel: 50 });
    await setStock(ctx.db, { locationId: rawWh, productId: mild, qty: 8, minLevel: 10, maxLevel: 50 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    const signals = (res.body.signals as Signal[]).filter((s) => s.location_id === rawWh);
    const starvedIdx = signals.findIndex((s) => s.product_id === starved);
    const mildIdx = signals.findIndex((s) => s.product_id === mild);
    expect(starvedIdx).toBeGreaterThanOrEqual(0);
    expect(mildIdx).toBeGreaterThanOrEqual(0);
    expect(starvedIdx).toBeLessThan(mildIdx);
  });
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------
describe('GET /api/purchase-orders/signals — RBAC', () => {
  it('a scoped raw_warehouse_manager sees only its own location signals', async () => {
    const mine = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const other = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const pMine = await makeProduct(ctx.db, { type: 'raw' });
    const pOther = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: mine, productId: pMine, qty: 1, minLevel: 10, maxLevel: 30 });
    await setStock(ctx.db, { locationId: other, productId: pOther, qty: 1, minLevel: 10, maxLevel: 30 });

    const keeper = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: mine });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${keeper.token}`);
    expect(res.status).toBe(200);
    const signals = res.body.signals as Signal[];
    expect(signals.some((s) => s.location_id === mine)).toBe(true);
    expect(signals.some((s) => s.location_id === other)).toBe(false);
  });

  it('an ai_assistant (chain-wide, NULL location) sees signals across raw warehouses', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 1, minLevel: 10, maxLevel: 30 });

    const ai = await makeUser(ctx.db, { role: 'ai_assistant', locationId: null });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${ai.token}`);
    expect(res.status).toBe(200);
    const signals = res.body.signals as Signal[];
    expect(signals.some((s) => s.location_id === rawWh && s.product_id === product)).toBe(true);
  });

  it('PM sees signals across every raw warehouse', async () => {
    const rawA = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const rawB = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const pA = await makeProduct(ctx.db, { type: 'raw' });
    const pB = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawA, productId: pA, qty: 1, minLevel: 10, maxLevel: 30 });
    await setStock(ctx.db, { locationId: rawB, productId: pB, qty: 1, minLevel: 10, maxLevel: 30 });

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const signals = res.body.signals as Signal[];
    expect(signals.some((s) => s.location_id === rawA && s.product_id === pA)).toBe(true);
    expect(signals.some((s) => s.location_id === rawB && s.product_id === pB)).toBe(true);
  });

  it('a central_warehouse_manager is chain-wide (sees all raw warehouses, no clamp)', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const product = await makeProduct(ctx.db, { type: 'raw' });
    await setStock(ctx.db, { locationId: rawWh, productId: product, qty: 1, minLevel: 10, maxLevel: 30 });

    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${cwm.token}`);
    expect(res.status).toBe(200);
    const signals = res.body.signals as Signal[];
    expect(signals.some((s) => s.location_id === rawWh && s.product_id === product)).toBe(true);
  });

  it('a store_manager is forbidden (403 — not in the read allow-list)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${sm.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('a supply_manager is forbidden (403 — buyer, not the raw-warehouse audience)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, { role: 'supply_manager', locationId: supplyLoc });
    const res = await request(ctx.app)
      .get('/api/purchase-orders/signals')
      .set('Authorization', `Bearer ${supplyMgr.token}`);
    expect(res.status).toBe(403);
  });

  it('no token is 401', async () => {
    const res = await request(ctx.app).get('/api/purchase-orders/signals');
    expect(res.status).toBe(401);
  });
});
