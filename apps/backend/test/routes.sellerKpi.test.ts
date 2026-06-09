/**
 * TZ Module 8 "Do'kon KPI" (SELLER-level, Variant B) — integration tests.
 *
 *   GET  /api/seller-kpi?month=YYYY-MM&store_id=  — seller leaderboard.
 *   PUT  /api/seller-kpi/plan                     — upsert one seller's plan (pm).
 *   POST /api/seller-kpi/sync                      — sync Poster waiters -> sellers.
 *
 * ACTUAL revenue is read LIVE from Poster `dash.getWaitersSales`; the Poster
 * client is stubbed (a fetcher keyed by the `spot_id` query param) so a waiter's
 * per-spot revenue maps onto the right ADIA store. Coverage:
 *   - aggregation: tiyin->so'm, per-(seller,store) revenue, achievement_pct,
 *     growth_pct_mom (current vs previous month), rank, sellers auto-upsert.
 *   - a waiter who sells at TWO stores yields TWO rows (store_id disambiguates).
 *   - RBAC: store_manager sees ONLY its own store; foreign store_id -> 403;
 *     unauthenticated -> 401; a wrong role -> 403.
 *   - PUT /plan: upsert creates then overwrites the SAME row; pm-only; a
 *     non-existent seller -> 404; a negative target -> 422.
 *   - graceful degradation: a method-level PosterApiError (HTTP 405 / code 30)
 *     yields 200 empty leaderboard instead of 500.
 *   - POST /sync: pm-only; upserts seller identities.
 *
 * Revenue figures are in TIYIN in the stub (Poster's real unit); the asserted
 * so'm values are the tiyin/100. A FIXED past month keeps the math independent
 * of the wall clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
} from '../src/integrations/poster/client.js';
import { buildSellerMonthWindow } from '../src/services/sellerKpi.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
  setPosterClientForTests(undefined);
  resetPosterClientCache();
});

beforeEach(() => {
  setPosterClientForTests(undefined);
});

const MONTH = '2026-03';
const PREV_MONTH = '2026-02';

/** Create a store carrying a Poster spot_id; returns the store id. */
async function makeStoreWithSpot(spotId: number, name: string): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, poster_spot_id) VALUES ($1, 'store', $2) RETURNING id`,
    [name, spotId],
  );
  return Number(rows[0]!.id);
}

/** A single waiter-sales row (revenue in TIYIN, as Poster returns it). */
type WaiterRow = { user_id: string; name: string; revenue: string };

/**
 * Stub the Poster client so `dash.getWaitersSales` returns rows that depend on
 * the requested `spot_id` AND the date window. `bySpot` maps
 * spotId -> { [monthLabel]: WaiterRow[] } where monthLabel is 'YYYY-MM'. The
 * fetcher derives the month from the `dateFrom=YYYYMMDD` query param.
 */
function stubWaiterSales(bySpot: Record<number, Record<string, WaiterRow[]>>): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const method = u.pathname.split('/').pop();
        if (method !== 'dash.getWaitersSales') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
          );
        }
        const spotId = Number(u.searchParams.get('spot_id'));
        const dateFrom = u.searchParams.get('dateFrom') ?? ''; // YYYYMMDD
        const monthLabel = `${dateFrom.slice(0, 4)}-${dateFrom.slice(4, 6)}`;
        const rows = bySpot[spotId]?.[monthLabel] ?? [];
        return Promise.resolve(
          new Response(JSON.stringify({ response: rows }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    }),
  );
  process.env.POSTER_TOKEN = 'acc:test';
}

/** Stub a Poster client whose waiter-sales call fails like an unavailable method. */
function stubWaiterSalesUnavailable(mode: 'http405' | 'envelope30'): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: (() => {
        if (mode === 'http405') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 30, message: 'Method Not Allowed' } }), {
              status: 405,
              statusText: 'Method Not Allowed',
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'Method Not Allowed' } }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    }),
  );
  process.env.POSTER_TOKEN = 'acc:test';
}

/** Read a seller's local id by its poster_waiter_id (after a sync/read). */
async function sellerIdByWaiter(waiterId: string): Promise<number | undefined> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM sellers WHERE poster_waiter_id = $1`,
    [waiterId],
  );
  return rows[0] === undefined ? undefined : Number(rows[0].id);
}

// ---------------------------------------------------------------------------
// Pure unit — buildSellerMonthWindow
// ---------------------------------------------------------------------------

describe('buildSellerMonthWindow (pure)', () => {
  it('builds the current + previous month YYYYMMDD bounds', () => {
    const w = buildSellerMonthWindow('2026-03');
    expect(w.label).toBe('2026-03');
    expect(w.prevLabel).toBe('2026-02');
    expect(w.curFrom).toBe('20260301');
    expect(w.curTo).toBe('20260331'); // March has 31 days.
    expect(w.prevFrom).toBe('20260201');
    expect(w.prevTo).toBe('20260228'); // Feb 2026 has 28 days.
  });

  it('rolls the year over for January', () => {
    const w = buildSellerMonthWindow('2026-01');
    expect(w.prevLabel).toBe('2025-12');
    expect(w.prevFrom).toBe('20251201');
    expect(w.prevTo).toBe('20251231');
  });
});

// ---------------------------------------------------------------------------
// GET /api/seller-kpi — aggregation + RBAC + graceful degrade
// ---------------------------------------------------------------------------

describe('GET /api/seller-kpi', () => {
  it('aggregates per-seller revenue (tiyin->so\'m), achievement %, MoM, rank', async () => {
    const storeA = await makeStoreWithSpot(9101, 'KPI Store A');
    const pm = await makeUser(ctx.db, { role: 'pm' });

    // Waiter 8001: this month 5,000,000 tiyin (=50,000 so'm), last month
    // 4,000,000 tiyin (=40,000). Waiter 8002: this month 2,000,000 (=20,000),
    // no last-month baseline.
    stubWaiterSales({
      9101: {
        [MONTH]: [
          { user_id: '8001', name: 'Ali', revenue: '5000000' },
          { user_id: '8002', name: 'Vali', revenue: '2000000' },
        ],
        [PREV_MONTH]: [{ user_id: '8001', name: 'Ali', revenue: '4000000' }],
      },
    });

    const res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}&store_id=${storeA}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.month).toBe(MONTH);
    expect(res.body.items).toHaveLength(2);

    // Ranked by actual_sum DESC -> Ali (50k) first, Vali (20k) second.
    const ali = res.body.items[0];
    expect(ali.poster_waiter_id).toBe('8001');
    expect(ali.name).toBe('Ali');
    expect(ali.store_id).toBe(storeA);
    expect(ali.store_name).toBe('KPI Store A');
    expect(ali.actual_sum).toBe(50000);
    expect(ali.prev_month_actual).toBe(40000);
    // MoM = (50000-40000)/40000 = +25%.
    expect(ali.growth_pct_mom).toBe(25);
    expect(ali.target_sum).toBeNull();
    expect(ali.achievement_pct).toBeNull();
    expect(ali.rank).toBe(1);

    const vali = res.body.items[1];
    expect(vali.poster_waiter_id).toBe('8002');
    expect(vali.actual_sum).toBe(20000);
    expect(vali.prev_month_actual).toBe(0);
    expect(vali.growth_pct_mom).toBeNull(); // no prior baseline.
    expect(vali.rank).toBe(2);

    // summary — no targets set yet.
    expect(res.body.summary.total_actual).toBe(70000);
    expect(res.body.summary.total_target).toBe(0);
    expect(res.body.summary.achievement_pct).toBeNull();

    // sellers were auto-upserted by the read.
    expect(await sellerIdByWaiter('8001')).toBeGreaterThan(0);
    expect(await sellerIdByWaiter('8002')).toBeGreaterThan(0);
  });

  it('joins a plan -> achievement_pct + summary', async () => {
    const store = await makeStoreWithSpot(9102, 'KPI Store B');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubWaiterSales({
      9102: { [MONTH]: [{ user_id: '8101', name: 'Salim', revenue: '6000000' }] }, // 60,000 so'm
    });

    // First read upserts the seller; capture its id, then set a plan.
    let res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}&store_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const sellerId = res.body.items[0].seller_id as number;

    const put = await request(ctx.app)
      .put('/api/seller-kpi/plan')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ seller_id: sellerId, month: MONTH, target_sum: 50000 });
    expect(put.status).toBe(200);

    res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}&store_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.target_sum).toBe(50000);
    // achievement = 60000 / 50000 = 120%.
    expect(item.achievement_pct).toBe(120);
    expect(res.body.summary.total_target).toBe(50000);
    expect(res.body.summary.achievement_pct).toBe(120);
  });

  it('a waiter selling at TWO stores yields TWO rows (one per store)', async () => {
    const storeX = await makeStoreWithSpot(9201, 'Multi X');
    const storeY = await makeStoreWithSpot(9202, 'Multi Y');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubWaiterSales({
      9201: { [MONTH]: [{ user_id: '8300', name: 'Roamer', revenue: '3000000' }] }, // 30,000
      9202: { [MONTH]: [{ user_id: '8300', name: 'Roamer', revenue: '1000000' }] }, // 10,000
    });

    const res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const roamerRows = res.body.items.filter(
      (i: { poster_waiter_id: string }) => i.poster_waiter_id === '8300',
    );
    expect(roamerRows).toHaveLength(2);
    const byStore = Object.fromEntries(
      roamerRows.map((r: { store_id: number; actual_sum: number }) => [r.store_id, r.actual_sum]),
    );
    expect(byStore[storeX]).toBe(30000);
    expect(byStore[storeY]).toBe(10000);
    // Same underlying seller identity.
    const sellerIds = new Set(roamerRows.map((r: { seller_id: number }) => r.seller_id));
    expect(sellerIds.size).toBe(1);
  });

  it('drops a waiter with zero revenue at a spot (not a seller there)', async () => {
    const store = await makeStoreWithSpot(9203, 'Zero Store');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubWaiterSales({
      9203: {
        [MONTH]: [
          { user_id: '8400', name: 'Active', revenue: '1000000' },
          { user_id: '8401', name: 'Idle', revenue: '0' },
        ],
      },
    });
    const res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}&store_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { poster_waiter_id: string }) => i.poster_waiter_id);
    expect(ids).toContain('8400');
    expect(ids).not.toContain('8401');
  });

  it('store_manager sees ONLY its own store', async () => {
    const myStore = await makeStoreWithSpot(9301, 'Mine');
    const otherStore = await makeStoreWithSpot(9302, 'Theirs');
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: myStore });
    stubWaiterSales({
      9301: { [MONTH]: [{ user_id: '8500', name: 'Mine S', revenue: '1000000' }] },
      9302: { [MONTH]: [{ user_id: '8501', name: 'Their S', revenue: '9000000' }] },
    });
    const res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    const stores = new Set(res.body.items.map((i: { store_id: number }) => i.store_id));
    expect(stores.has(myStore)).toBe(true);
    expect(stores.has(otherStore)).toBe(false);
    const ids = res.body.items.map((i: { poster_waiter_id: string }) => i.poster_waiter_id);
    expect(ids).toContain('8500');
    expect(ids).not.toContain('8501');
  });

  it('store_manager requesting a foreign store_id -> 403', async () => {
    const myStore = await makeStoreWithSpot(9303, 'Mine2');
    const otherStore = await makeStoreWithSpot(9304, 'Theirs2');
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: myStore });
    stubWaiterSales({});
    const res = await request(ctx.app)
      .get(`/api/seller-kpi?store_id=${otherStore}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });

  it('store_manager whose store has no Poster spot -> empty leaderboard', async () => {
    // A store_manager MUST have a location (DB CHECK), but a store with no
    // `poster_spot_id` maps to no Poster spot — so the leaderboard is empty.
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO locations (name, type) VALUES ('No Spot Store', 'store') RETURNING id`,
    );
    const noSpotStore = Number(rows[0]!.id);
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: noSpotStore });
    stubWaiterSales({});
    const res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('unauthenticated -> 401', async () => {
    const res = await request(ctx.app).get('/api/seller-kpi');
    expect(res.status).toBe(401);
  });

  it('a wrong role -> 403', async () => {
    const rawLoc = await makeStoreWithSpot(9350, 'Raw Mgr Loc');
    const raw = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawLoc });
    const res = await request(ctx.app)
      .get('/api/seller-kpi')
      .set('Authorization', `Bearer ${raw.token}`);
    expect(res.status).toBe(403);
  });

  it('rejects a malformed month with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/seller-kpi?month=2026-13')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
  });

  it('degrades to 200 empty when Poster returns HTTP 405', async () => {
    const store = await makeStoreWithSpot(9401, 'Degrade Store');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubWaiterSalesUnavailable('http405');
    const res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}&store_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.summary.total_actual).toBe(0);
  });

  it('degrades to 200 empty on a Poster {code:30} envelope', async () => {
    const store = await makeStoreWithSpot(9402, 'Degrade Store 2');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubWaiterSalesUnavailable('envelope30');
    const res = await request(ctx.app)
      .get(`/api/seller-kpi?month=${MONTH}&store_id=${store}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/seller-kpi/plan
// ---------------------------------------------------------------------------

describe('PUT /api/seller-kpi/plan', () => {
  /** Insert a seller directly; returns its id. */
  async function makeSeller(waiterId: string, name: string): Promise<number> {
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO sellers (poster_waiter_id, name) VALUES ($1, $2)
       ON CONFLICT (poster_waiter_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [waiterId, name],
    );
    return Number(rows[0]!.id);
  }

  it('upsert creates then overwrites the SAME row (unique seller_id, month)', async () => {
    const sellerId = await makeSeller('7001', 'Plan Seller');
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const first = await request(ctx.app)
      .put('/api/seller-kpi/plan')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ seller_id: sellerId, month: MONTH, target_sum: 100000 });
    expect(first.status).toBe(200);
    expect(first.body.target_sum).toBe(100000);
    const planId = first.body.id;

    const second = await request(ctx.app)
      .put('/api/seller-kpi/plan')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ seller_id: sellerId, month: MONTH, target_sum: 250000 });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(planId); // SAME row.
    expect(second.body.target_sum).toBe(250000);

    // Exactly one row for (seller, month).
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM seller_sales_plan WHERE seller_id = $1 AND month = $2`,
      [sellerId, MONTH],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('a non-pm role -> 403', async () => {
    const sellerId = await makeSeller('7002', 'S2');
    const loc = await makeStoreWithSpot(9601, 'Plan Mgr Loc');
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const res = await request(ctx.app)
      .put('/api/seller-kpi/plan')
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({ seller_id: sellerId, month: MONTH, target_sum: 1000 });
    expect(res.status).toBe(403);
  });

  it('a non-existent seller -> 404', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .put('/api/seller-kpi/plan')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ seller_id: 999999, month: MONTH, target_sum: 1000 });
    expect(res.status).toBe(404);
  });

  it('a negative target -> 422', async () => {
    const sellerId = await makeSeller('7003', 'S3');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .put('/api/seller-kpi/plan')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ seller_id: sellerId, month: MONTH, target_sum: -5 });
    expect(res.status).toBe(422);
  });

  it('unauthenticated -> 401', async () => {
    const res = await request(ctx.app)
      .put('/api/seller-kpi/plan')
      .send({ seller_id: 1, month: MONTH, target_sum: 1 });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /api/seller-kpi/sync
// ---------------------------------------------------------------------------

describe('POST /api/seller-kpi/sync', () => {
  it('pm syncs Poster waiters -> sellers', async () => {
    await makeStoreWithSpot(9501, 'Sync Store');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubWaiterSales({
      9501: { [MONTH]: [{ user_id: '7700', name: 'Synced One', revenue: '1000000' }] },
    });
    const res = await request(ctx.app)
      .post(`/api/seller-kpi/sync?month=${MONTH}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.synced).toBeGreaterThanOrEqual(1);
    expect(await sellerIdByWaiter('7700')).toBeGreaterThan(0);
  });

  it('a non-pm role -> 403', async () => {
    const loc = await makeStoreWithSpot(9602, 'Sync Mgr Loc');
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const res = await request(ctx.app)
      .post('/api/seller-kpi/sync')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });
});
