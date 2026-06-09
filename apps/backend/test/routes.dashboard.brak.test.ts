/**
 * GET /api/dashboard/brak-summary integration tests.
 *
 * The endpoint aggregates defective ("brak") qty captured on goods-receipt
 * across the chain for the selected `?range`, from two authoritative sources:
 *   - purchase_orders.brak_qty      (raw-warehouse PO receive; good = ordered qty)
 *   - replenishment_requests.brak_qty (shipment receive; good = qty_accepted)
 *
 * Coverage:
 *   - aggregates both sources, computes ratio = brak / (good + brak).
 *   - by_source splits brak by origin; top is ordered by brak qty desc.
 *   - no brak data -> all zeros, empty top (never 500).
 *   - location scoping: a scoped manager only sees brak at their location.
 *   - PM sees the whole chain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query(`DELETE FROM replenishment_purchase_orders`);
  await ctx.db.query(`DELETE FROM purchase_orders`);
  await ctx.db.query(`DELETE FROM replenishment_requests`);
  await ctx.db.query(`DELETE FROM stock_movements`);
  await ctx.db.query(`DELETE FROM stock`);
  await ctx.db.query(`DELETE FROM user_locations`);
  await ctx.db.query(`DELETE FROM users`);
  await ctx.db.query(`DELETE FROM products`);
});

/** Insert a `received` purchase order with brak, stamped `updated_at` today. */
async function seedReceivedPo(opts: {
  productId: number;
  targetLocationId: number;
  qty: number;
  brakQty: number;
  brakReason: string | null;
  createdBy: number;
}): Promise<void> {
  await ctx.db.query(
    `INSERT INTO purchase_orders
       (product_id, qty, target_location_id, status, brak_qty, brak_reason,
        created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'received', $4, $5, $6, now(), now())`,
    [
      opts.productId,
      opts.qty,
      opts.targetLocationId,
      opts.brakQty,
      opts.brakReason,
      opts.createdBy,
    ],
  );
}

/** Insert a CLOSED replenishment request with brak, `closed_at` today. */
async function seedClosedReplenishment(opts: {
  productId: number;
  requesterLocationId: number;
  qtyNeeded: number;
  qtyAccepted: number;
  brakQty: number;
  brakReason: string | null;
  createdBy: number;
}): Promise<void> {
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, qty_needed, status, qty_accepted,
        brak_qty, brak_reason, created_by, created_at, updated_at, closed_at)
     VALUES ($1, $2, $3, 'CLOSED', $4, $5, $6, $7, now(), now(), now())`,
    [
      opts.productId,
      opts.requesterLocationId,
      opts.qtyNeeded,
      opts.qtyAccepted,
      opts.brakQty,
      opts.brakReason,
      opts.createdBy,
    ],
  );
}

describe('GET /api/dashboard/brak-summary', () => {
  it('aggregates purchase + replenishment brak and computes the ratio', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawWarehouse = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store' });

    const flour = await makeProduct(ctx.db, { name: 'Un', type: 'raw', unit: 'kg' });
    const napoleon = await makeProduct(ctx.db, {
      name: 'Napoleon',
      type: 'finished',
      unit: 'pcs',
    });

    // Purchase brak: ordered 100 kg, 10 defective.
    await seedReceivedPo({
      productId: flour,
      targetLocationId: rawWarehouse,
      qty: 100,
      brakQty: 10,
      brakReason: 'namlangan',
      createdBy: pm.id,
    });
    // Replenishment brak: accepted 40 pcs, 5 defective.
    await seedClosedReplenishment({
      productId: napoleon,
      requesterLocationId: store,
      qtyNeeded: 50,
      qtyAccepted: 40,
      brakQty: 5,
      brakReason: 'singan',
      createdBy: pm.id,
    });

    const res = await request(ctx.app)
      .get('/api/dashboard/brak-summary?range=today')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body as {
      total_received_qty: number;
      total_brak_qty: number;
      brak_ratio: number;
      by_source: { purchase: number; replenishment: number };
      top: Array<{ product_id: number; brak_qty: number; reason: string | null }>;
    };

    // good = 100 + 40 = 140; brak = 10 + 5 = 15.
    expect(body.total_received_qty).toBe(140);
    expect(body.total_brak_qty).toBe(15);
    expect(body.brak_ratio).toBeCloseTo(15 / 155, 4);
    expect(body.by_source.purchase).toBe(10);
    expect(body.by_source.replenishment).toBe(5);

    // Top ordered by brak qty desc — flour (10) before napoleon (5).
    expect(body.top).toHaveLength(2);
    expect(body.top[0]!.product_id).toBe(flour);
    expect(body.top[0]!.brak_qty).toBe(10);
    expect(body.top[0]!.reason).toBe('namlangan');
    expect(body.top[1]!.product_id).toBe(napoleon);
  });

  it('returns zeros and an empty top when there is no brak data', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const res = await request(ctx.app)
      .get('/api/dashboard/brak-summary?range=today')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body.total_received_qty).toBe(0);
    expect(res.body.total_brak_qty).toBe(0);
    expect(res.body.brak_ratio).toBe(0);
    expect(res.body.by_source).toEqual({ purchase: 0, replenishment: 0 });
    expect(res.body.top).toEqual([]);
  });

  it('scopes a store manager to brak recorded at their own location', async () => {
    const myStore = await makeLocation(ctx.db, { type: 'store', name: 'Mine' });
    const otherStore = await makeLocation(ctx.db, { type: 'store', name: 'Other' });
    const me = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: myStore,
    });

    const cake = await makeProduct(ctx.db, {
      name: 'Tort',
      type: 'finished',
      unit: 'pcs',
    });

    await seedClosedReplenishment({
      productId: cake,
      requesterLocationId: myStore,
      qtyNeeded: 20,
      qtyAccepted: 18,
      brakQty: 2,
      brakReason: 'mine',
      createdBy: me.id,
    });
    await seedClosedReplenishment({
      productId: cake,
      requesterLocationId: otherStore,
      qtyNeeded: 20,
      qtyAccepted: 15,
      brakQty: 9,
      brakReason: 'other',
      createdBy: me.id,
    });

    const res = await request(ctx.app)
      .get('/api/dashboard/brak-summary?range=today')
      .set('Authorization', `Bearer ${me.token}`);

    expect(res.status).toBe(200);
    // Only my store's brak (2) — not the other store's 9.
    expect(res.body.total_brak_qty).toBe(2);
    expect(res.body.by_source.replenishment).toBe(2);
    expect(res.body.top).toHaveLength(1);
    expect(res.body.top[0].reason).toBe('mine');
  });
});
