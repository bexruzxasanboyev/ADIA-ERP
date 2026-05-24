/**
 * F4.4 — GET /api/dashboard/ecosystem integration tests (spec §2.4).
 *
 * Coverage:
 *   - PM (chain-wide) sees the full Poster status, every link of the
 *     supply chain (chain_flow ordered by type), the latest 20 alerts
 *     and the 30-day sales series.
 *   - store_manager sees only its own location in chain_flow AND
 *     sales_chart restricted to that location.
 *   - poster_status.sync_errors_24h counts only `failed` rows from the
 *     last 24h (older failed rows are ignored).
 *   - alerts_feed orders by created_at DESC and carries a derived
 *     `severity` per spec routing.
 *   - empty alerts -> [] (not null).
 *   - unauthenticated -> 401.
 *   - response time < 1s budget on a seeded fixture (AC4.4.6 — P95
 *     < 1000ms; here we cap at 1s).
 *
 * The existing `routes.dashboard.test.ts` (M8 overview) MUST keep
 * passing — this file adds a sibling endpoint, it does not change
 * the M8 surface.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  setStock,
  type SeededUser,
} from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

type World = {
  rawWh: number;
  central: number;
  production: number;
  supply: number;
  storeA: number;
  storeB: number;
  productFlour: number;
  productCake: number;
  pm: SeededUser;
  storeAManager: SeededUser;
};

async function seedWorld(): Promise<World> {
  // Locations — one per type so chain_flow ordering can be asserted.
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse', name: 'Raw WH' });
  const production = await makeLocation(ctx.db, { type: 'production', name: 'Prod' });
  const supply = await makeLocation(ctx.db, { type: 'supply', name: 'Supply' });
  const central = await makeLocation(ctx.db, {
    type: 'central_warehouse',
    name: 'Central WH',
  });
  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'Store A' });
  const storeB = await makeLocation(ctx.db, { type: 'store', name: 'Store B' });

  const productFlour = await makeProduct(ctx.db, { name: 'Flour', type: 'raw', unit: 'kg' });
  const productCake = await makeProduct(ctx.db, {
    name: 'Cake',
    type: 'finished',
    unit: 'pcs',
  });

  // storeA cake — below min, storeB cake — healthy, rawWh flour — below min.
  await setStock(ctx.db, {
    locationId: storeA,
    productId: productCake,
    qty: 1,
    minLevel: 5,
    maxLevel: 20,
  });
  await setStock(ctx.db, {
    locationId: storeB,
    productId: productCake,
    qty: 15,
    minLevel: 5,
    maxLevel: 20,
  });
  await setStock(ctx.db, {
    locationId: rawWh,
    productId: productFlour,
    qty: 2,
    minLevel: 10,
    maxLevel: 50,
  });
  await setStock(ctx.db, {
    locationId: central,
    productId: productCake,
    qty: 30,
    minLevel: 10,
    maxLevel: 100,
  });

  const pm = await makeUser(ctx.db, { role: 'pm' });
  const storeAManager = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeA,
  });

  // Open replenishment requests — one touches storeA, one touches rawWh.
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, target_location_id, qty_needed, status, created_by)
     VALUES ($1, $2, $3, $4, 'NEW', $5)`,
    [productCake, storeA, central, 19, pm.id],
  );
  await ctx.db.query(
    `INSERT INTO replenishment_requests
       (product_id, requester_location_id, target_location_id, qty_needed, status, created_by)
     VALUES ($1, $2, $3, $4, 'SHIP_TO_REQUESTER', $5)`,
    [productFlour, rawWh, central, 48, pm.id],
  );

  // Poster sync log — two recent runs (one ok latest, one failed within 24h)
  // and one ANCIENT failed run to confirm it is NOT counted in the 24h window.
  await ctx.db.query(
    `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied,
       started_at, finished_at)
     VALUES ('transactions','ok','poll',10,10, now() - interval '5 minutes', now() - interval '4 minutes')`,
  );
  await ctx.db.query(
    `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied,
       started_at, finished_at, error_detail)
     VALUES ('leftovers','failed','poll',0,0, now() - interval '1 hour', now() - interval '1 hour', 'boom')`,
  );
  await ctx.db.query(
    `INSERT INTO poster_sync_log (entity, status, trigger, records_in, records_applied,
       started_at, finished_at, error_detail)
     VALUES ('leftovers','failed','poll',0,0, now() - interval '5 days', now() - interval '5 days', 'old')`,
  );

  // Sales today — three lines, total qty = 9.
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, $3, $4, now(), $5, $6)`,
    [storeA, productCake, 3, 1000, 1001, 1],
  );
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, $3, $4, now(), $5, $6)`,
    [storeA, productCake, 2, 1000, 1001, 2],
  );
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at,
       poster_transaction_id, poster_line_id)
     VALUES ($1, $2, $3, $4, now(), $5, $6)`,
    [storeB, productCake, 4, 1000, 1002, 1],
  );

  // sales_stats_daily — last 5 days for both stores.
  for (let i = 0; i < 5; i++) {
    await ctx.db.query(
      `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
       VALUES ($1, $2, CURRENT_DATE - $3::int, $4)`,
      [storeA, productCake, i, 5 + i],
    );
    await ctx.db.query(
      `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
       VALUES ($1, $2, CURRENT_DATE - $3::int, $4)`,
      [storeB, productCake, i, 3 + i],
    );
  }
  // One row outside the 30d window — must NOT appear in sales_chart.
  await ctx.db.query(
    `INSERT INTO sales_stats_daily (location_id, product_id, stat_date, qty_sold)
     VALUES ($1, $2, CURRENT_DATE - 45, 99)`,
    [storeA, productCake],
  );

  // Notifications — three rows of mixed types/severities.
  await ctx.db.query(
    `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
     VALUES ($1,'stock_below_min','Cake low','Cake@StoreA below min',
       $2::jsonb, now() - interval '1 minute')`,
    [pm.id, JSON.stringify({ location_id: storeA })],
  );
  await ctx.db.query(
    `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
     VALUES ($1,'poster_sync_failed','Sync failed','leftovers boom',
       $2::jsonb, now() - interval '30 seconds')`,
    [pm.id, JSON.stringify({ entity: 'leftovers' })],
  );
  await ctx.db.query(
    `INSERT INTO notifications (recipient_user_id, type, title, body, payload, created_at)
     VALUES ($1,'replenishment_created','Replenishment','For storeA',
       $2::jsonb, now())`,
    [pm.id, JSON.stringify({ location_id: storeA })],
  );

  return {
    rawWh,
    central,
    production,
    supply,
    storeA,
    storeB,
    productFlour,
    productCake,
    pm,
    storeAManager,
  };
}

describe('GET /api/dashboard/ecosystem', () => {
  it('returns the chain-wide ecosystem snapshot for pm', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    const body = res.body;

    // poster_status — last_sync_status is the most recent row (ok), and the
    // 24h failed counter sees the recent failure but NOT the 5-day-old one.
    expect(body.poster_status.last_sync_status).toBe('ok');
    expect(typeof body.poster_status.last_sync_at).toBe('string');
    expect(body.poster_status.sync_errors_24h).toBe(1);
    expect(body.poster_status.sales_today_count).toBe(3);
    expect(body.poster_status.sales_today_sum).toBe(9);

    // chain_flow — one row per location, ordered by type:
    // raw_warehouse, production, supply, central_warehouse, store, store.
    expect(body.chain_flow).toHaveLength(6);
    expect(body.chain_flow.map((r: { location_type: string }) => r.location_type)).toEqual([
      'raw_warehouse',
      'production',
      'supply',
      'central_warehouse',
      'store',
      'store',
    ]);

    const flowRaw = body.chain_flow.find(
      (r: { location_id: number }) => r.location_id === w.rawWh,
    );
    expect(flowRaw).toMatchObject({
      location_name: 'Raw WH',
      below_min_count: 1, // flour
      open_requests_count: 1, // flour shipment
      total_products: 1,
    });

    const flowStoreA = body.chain_flow.find(
      (r: { location_id: number }) => r.location_id === w.storeA,
    );
    expect(flowStoreA).toMatchObject({
      below_min_count: 1, // cake
      open_requests_count: 1, // cake replenishment
      total_products: 1,
    });

    const flowStoreB = body.chain_flow.find(
      (r: { location_id: number }) => r.location_id === w.storeB,
    );
    expect(flowStoreB.below_min_count).toBe(0);

    // alerts_feed — 3 rows, sorted DESC by created_at, with derived severity.
    expect(body.alerts_feed).toHaveLength(3);
    expect(body.alerts_feed[0].type).toBe('replenishment_created'); // most recent
    const sev: Record<string, string> = {};
    for (const a of body.alerts_feed as Array<{ type: string; severity: string }>) {
      sev[a.type] = a.severity;
    }
    expect(sev.stock_below_min).toBe('warning');
    expect(sev.poster_sync_failed).toBe('danger');
    expect(sev.replenishment_created).toBe('info');

    // sales_chart — last 30 days. Five distinct dates were seeded; the 45-day
    // outlier MUST NOT appear. days[i].qty is the sum across both stores.
    const days = body.sales_chart.days;
    expect(Array.isArray(days)).toBe(true);
    expect(days.length).toBe(5);
    // qty_sold seeded as storeA(5..9 = 35) + storeB(3..7 = 25) = 60 total.
    const totalQty = days.reduce(
      (acc: number, d: { qty: number }) => acc + Number(d.qty),
      0,
    );
    expect(totalQty).toBe(60);
  });

  it('scopes a store_manager to its own store (chain_flow + sales_chart)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);

    expect(res.status).toBe(200);
    const body = res.body;

    // chain_flow — only storeA appears.
    expect(body.chain_flow).toHaveLength(1);
    expect(body.chain_flow[0]).toMatchObject({
      location_id: w.storeA,
      location_type: 'store',
      below_min_count: 1,
      open_requests_count: 1,
    });

    // sales_today_sum — only storeA sales (3 + 2 = 5).
    expect(body.poster_status.sales_today_sum).toBe(5);
    expect(body.poster_status.sales_today_count).toBe(2);

    // sales_chart — only storeA's qty (5..9 = 35).
    const totalQty = body.sales_chart.days.reduce(
      (acc: number, d: { qty: number }) => acc + Number(d.qty),
      0,
    );
    expect(totalQty).toBe(35);
  });

  it('returns an empty alerts feed when no notifications exist', async () => {
    // Fresh world — but truncate notifications added by seedWorld.
    const w = await seedWorld();
    await ctx.db.query('DELETE FROM notifications');
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.alerts_feed).toEqual([]);
  });

  it('responds under the 1s budget on a seeded fixture (AC4.4.6)', async () => {
    const w = await seedWorld();
    const t0 = Date.now();
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(ctx.app).get('/api/dashboard/ecosystem');
    expect(res.status).toBe(401);
  });

  it('returns nulls in poster_status when no sync runs exist', async () => {
    const w = await seedWorld();
    await ctx.db.query('DELETE FROM poster_sync_log');
    await ctx.db.query('DELETE FROM sales');
    const res = await request(ctx.app)
      .get('/api/dashboard/ecosystem')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.poster_status.last_sync_at).toBeNull();
    expect(res.body.poster_status.last_sync_status).toBeNull();
    expect(res.body.poster_status.sync_errors_24h).toBe(0);
    expect(res.body.poster_status.sales_today_count).toBe(0);
    expect(res.body.poster_status.sales_today_sum).toBe(0);
  });
});
