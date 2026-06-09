/**
 * TZ Module 8 "Do'kon KPI" (store-level) — integration tests for:
 *
 *   GET /api/store-kpi?month=YYYY-MM         — leaderboard.
 *   PUT /api/store-kpi/plan                  — upsert one store's plan (pm).
 *   GET /api/store-kpi/:locationId/trend     — monthly actual series.
 *
 * Coverage:
 *   - PUT /plan: upsert creates then overwrites the SAME row (uniqueness on
 *     (location_id, month)); pm-only RBAC; rejects a non-store target.
 *   - GET: target / actual / achievement_pct / growth_pct_mom / rank computed
 *     from a seeded store + sales + plan; `actual_sum` reconciles with the
 *     dashboard's sum(qty*price).
 *   - RBAC: a store_manager sees ONLY their own store; unauthenticated -> 401;
 *     a wrong role -> 403.
 *   - trend: oldest -> newest series, zero-filled empty months, RBAC-scoped.
 *
 * Sales are seeded with explicit zone-qualified timestamps in a FIXED past
 * month so the "current month" default never interferes with assertions, and
 * the `qty * price` line totals are exact round numbers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, type SeededUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// A fixed historical month + its predecessor — keeps the leaderboard math
// independent of the wall clock.
const MONTH = '2026-03';
const PREV_MONTH = '2026-02';

let saleSeq = 0;
/** Insert one sale line. `lineTotalSom` is the LINE TOTAL; price is per-unit. */
async function insertSale(opts: {
  storeId: number;
  productId: number;
  qty: number;
  lineTotalSom: number;
  soldAt: string; // ISO timestamptz, zone-explicit
}): Promise<void> {
  saleSeq += 1;
  await ctx.db.query(
    `INSERT INTO sales
       (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      opts.storeId,
      opts.productId,
      opts.qty,
      opts.lineTotalSom / opts.qty,
      opts.soldAt,
      800000 + saleSeq,
      saleSeq,
    ],
  );
}

type World = {
  storeA: number;
  storeB: number;
  product: number;
  pm: SeededUser;
  storeAManager: SeededUser;
  storeBManager: SeededUser;
};

async function seedWorld(): Promise<World> {
  await ctx.db.query('TRUNCATE TABLE store_sales_plan CASCADE');
  await ctx.db.query('TRUNCATE TABLE sales CASCADE');
  await ctx.db.query('TRUNCATE TABLE audit_log CASCADE');
  await ctx.db.query('TRUNCATE TABLE user_locations CASCADE');
  await ctx.db.query('TRUNCATE TABLE users CASCADE');
  await ctx.db.query('TRUNCATE TABLE locations CASCADE');
  await ctx.db.query('TRUNCATE TABLE products CASCADE');
  saleSeq = 0;

  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'StoreA' });
  const storeB = await makeLocation(ctx.db, { type: 'store', name: 'StoreB' });
  const product = await makeProduct(ctx.db, { name: 'Tort', type: 'finished', unit: 'pcs' });

  const pm = await makeUser(ctx.db, { role: 'pm' });
  const storeAManager = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeA,
  });
  const storeBManager = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeB,
  });

  return { storeA, storeB, product, pm, storeAManager, storeBManager };
}

describe('PUT /api/store-kpi/plan', () => {
  beforeEach(async () => {
    await seedWorld();
  });

  it('upserts: creates then overwrites the SAME row (unique on location+month)', async () => {
    const w = await seedWorld();

    const first = await request(ctx.app)
      .put('/api/store-kpi/plan')
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ location_id: w.storeA, month: MONTH, target_sum: 1_000_000 });
    expect(first.status).toBe(200);
    expect(first.body.location_id).toBe(w.storeA);
    expect(first.body.month).toBe(MONTH);
    expect(first.body.target_sum).toBe(1_000_000);
    expect(first.body.created_by).toBe(w.pm.id);
    const firstId = first.body.id;

    const second = await request(ctx.app)
      .put('/api/store-kpi/plan')
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ location_id: w.storeA, month: MONTH, target_sum: 2_500_000 });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(firstId); // SAME row — upsert, not insert.
    expect(second.body.target_sum).toBe(2_500_000);

    // Exactly one row in the table for that (store, month).
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM store_sales_plan WHERE location_id = $1 AND month = $2`,
      [w.storeA, MONTH],
    );
    expect(Number(rows[0]?.n)).toBe(1);

    // Audit row written.
    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'store_sales_plan.upsert'`,
    );
    expect(Number(audit.rows[0]?.n)).toBe(2);
  });

  it('rejects a non-pm role with 403 (store_manager cannot set a plan)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .put('/api/store-kpi/plan')
      .set('Authorization', `Bearer ${w.storeAManager.token}`)
      .send({ location_id: w.storeA, month: MONTH, target_sum: 1_000 });
    expect(res.status).toBe(403);
  });

  it('rejects a plan targeting a non-store location (validation)', async () => {
    const w = await seedWorld();
    const wh = await makeLocation(ctx.db, { type: 'central_warehouse', name: 'C' });
    const res = await request(ctx.app)
      .put('/api/store-kpi/plan')
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ location_id: wh, month: MONTH, target_sum: 1_000 });
    expect(res.status).toBe(422); // AppError.validation -> 422
  });

  it('rejects a malformed body (negative target / bad month)', async () => {
    const w = await seedWorld();
    const neg = await request(ctx.app)
      .put('/api/store-kpi/plan')
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ location_id: w.storeA, month: MONTH, target_sum: -5 });
    expect(neg.status).toBe(422); // AppError.validation -> 422

    const badMonth = await request(ctx.app)
      .put('/api/store-kpi/plan')
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ location_id: w.storeA, month: '2026-13', target_sum: 5 });
    expect(badMonth.status).toBe(422); // AppError.validation -> 422
  });
});

describe('GET /api/store-kpi', () => {
  it('computes target/actual/achievement/growth/rank + reconciles actual_sum', async () => {
    const w = await seedWorld();

    // StoreA: target 1,000,000; actual this month 800,000; prev month 400,000.
    //   -> achievement 80%, growth +100% MoM.
    await request(ctx.app)
      .put('/api/store-kpi/plan')
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ location_id: w.storeA, month: MONTH, target_sum: 1_000_000 });
    await insertSale({
      storeId: w.storeA,
      productId: w.product,
      qty: 8,
      lineTotalSom: 800_000,
      soldAt: `${MONTH}-15T10:00:00+05:00`,
    });
    await insertSale({
      storeId: w.storeA,
      productId: w.product,
      qty: 4,
      lineTotalSom: 400_000,
      soldAt: `${PREV_MONTH}-15T10:00:00+05:00`,
    });

    // StoreB: NO plan; actual this month 1,200,000; no prev-month sales.
    //   -> target null, achievement null, growth null (prev=0). Ranks #1.
    await insertSale({
      storeId: w.storeB,
      productId: w.product,
      qty: 12,
      lineTotalSom: 1_200_000,
      soldAt: `${MONTH}-20T12:00:00+05:00`,
    });

    const res = await request(ctx.app)
      .get(`/api/store-kpi?month=${MONTH}`)
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.month).toBe(MONTH);
    expect(res.body.items).toHaveLength(2);

    // Rank by actual DESC -> StoreB (1.2M) is #1, StoreA (0.8M) is #2.
    const [first, secondItem] = res.body.items;
    expect(first.location_id).toBe(w.storeB);
    expect(first.rank).toBe(1);
    expect(first.actual_sum).toBe(1_200_000);
    expect(first.target_sum).toBeNull();
    expect(first.achievement_pct).toBeNull();
    expect(first.growth_pct_mom).toBeNull(); // prev month = 0

    expect(secondItem.location_id).toBe(w.storeA);
    expect(secondItem.rank).toBe(2);
    expect(secondItem.actual_sum).toBe(800_000);
    expect(secondItem.target_sum).toBe(1_000_000);
    expect(secondItem.achievement_pct).toBe(80);
    expect(secondItem.prev_month_actual).toBe(400_000);
    expect(secondItem.growth_pct_mom).toBe(100);

    // Summary: total target only counts stores WITH a target (StoreA).
    expect(res.body.summary.total_target).toBe(1_000_000);
    expect(res.body.summary.total_actual).toBe(2_000_000);
    expect(res.body.summary.achievement_pct).toBe(200);

    // Reconcile: actual_sum equals the dashboard's sum(qty*price) for the month.
    const recon = await ctx.db.query<{ s: string | null }>(
      `SELECT sum(qty * price) AS s FROM sales
        WHERE store_id = $1 AND sold_at >= $2 AND sold_at < $3`,
      [w.storeA, `${MONTH}-01`, `${MONTH.slice(0, 4)}-04-01`],
    );
    expect(Number(recon.rows[0]?.s)).toBe(800_000);
  });

  it('RBAC: a store_manager sees ONLY their own store', async () => {
    const w = await seedWorld();
    await insertSale({
      storeId: w.storeA,
      productId: w.product,
      qty: 1,
      lineTotalSom: 100_000,
      soldAt: `${MONTH}-10T10:00:00+05:00`,
    });
    await insertSale({
      storeId: w.storeB,
      productId: w.product,
      qty: 1,
      lineTotalSom: 999_000,
      soldAt: `${MONTH}-10T10:00:00+05:00`,
    });

    const res = await request(ctx.app)
      .get(`/api/store-kpi?month=${MONTH}`)
      .set('Authorization', `Bearer ${w.storeAManager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].location_id).toBe(w.storeA);
    expect(res.body.items[0].actual_sum).toBe(100_000);
    expect(res.body.items[0].rank).toBe(1); // ranked within the visible set
  });

  it('rejects unauthenticated (401) and a wrong role (403)', async () => {
    await seedWorld();
    const noAuth = await request(ctx.app).get(`/api/store-kpi?month=${MONTH}`);
    expect(noAuth.status).toBe(401);

    // raw_warehouse_manager requires a location (chk_users_location_required);
    // the role gate rejects it before any scoping runs.
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse', name: 'RW' });
    const wrongRole = await makeUser(ctx.db, {
      role: 'raw_warehouse_manager',
      locationId: rawWh,
    });
    const res = await request(ctx.app)
      .get(`/api/store-kpi?month=${MONTH}`)
      .set('Authorization', `Bearer ${wrongRole.token}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/store-kpi/:locationId/trend', () => {
  it('returns an oldest->newest monthly series, zero-filling empty months', async () => {
    const w = await seedWorld();
    // Two sales in the CURRENT month so they fall inside the trailing window.
    const now = new Date();
    const curMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await insertSale({
      storeId: w.storeA,
      productId: w.product,
      qty: 5,
      lineTotalSom: 500_000,
      soldAt: `${curMonth}-05T10:00:00+05:00`,
    });

    const res = await request(ctx.app)
      .get(`/api/store-kpi/${w.storeA}/trend?months=3`)
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.location_id).toBe(w.storeA);
    expect(res.body.months).toBe(3);
    expect(res.body.series).toHaveLength(3);
    // Newest bucket is the current month and carries the seeded revenue.
    const newest = res.body.series[res.body.series.length - 1];
    expect(newest.month).toBe(curMonth);
    expect(newest.actual_sum).toBe(500_000);
    // Older buckets are zero-filled.
    expect(res.body.series[0].actual_sum).toBe(0);
  });

  it('RBAC: a store_manager cannot read another store trend (403)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get(`/api/store-kpi/${w.storeB}/trend`)
      .set('Authorization', `Bearer ${w.storeAManager.token}`);
    expect(res.status).toBe(403);
  });
});
