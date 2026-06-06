/**
 * GET /api/dashboard/top-products integration.
 *
 * The endpoint sources the top-selling products from Poster
 * `dash.getProductsSales` (one row per product+modification), aggregates by
 * `product_id`, sorts by revenue desc, takes the top N, and computes each
 * product's `share` of the FULL period revenue.
 *
 * Coverage:
 *   - aggregation by product_id across two modifications of the same product;
 *   - revenue-desc ordering and tiyin->som conversion;
 *   - top-N limit (default 5, ?limit clamp);
 *   - share reconciliation (shares of the top N <= 1; full-revenue denominator);
 *   - per-product unit derivation: weight_flag=1 -> 'kg' (qty in kg),
 *     weight_flag=0 -> 'dona' (qty in pieces), summed correctly per type;
 *   - 403 when a store_manager asks for a spot outside their assigned stores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
  type PosterProductSalesRow,
} from '../src/integrations/poster/client.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeUser } from './helpers/fixtures.js';

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

/** Install a stub Poster client serving `dash.getProductsSales`. */
function stubPoster(rows: PosterProductSalesRow[]): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        if (m === 'dash.getProductsSales') {
          return Promise.resolve(
            new Response(JSON.stringify({ response: rows }), { status: 200 }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    }),
  );
  process.env.POSTER_TOKEN = 'acc:test';
}

/** Product-sales row factory (tiyin strings, as Poster emits). */
function row(over: Partial<PosterProductSalesRow>): PosterProductSalesRow {
  return {
    product_id: '1',
    product_name: 'Tort',
    count: '1',
    payed_sum: '100000',
    unit: 'p',
    weight_flag: '0',
    ...over,
  };
}

describe('GET /api/dashboard/top-products', () => {
  it('aggregates modifications by product_id, sorts by revenue desc, converts tiyin->som', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    // Product 10 sells under two modifications -> must aggregate into one row.
    //   10: 46200000 + 13800000 tiyin = 600,000 so'm ; qty 7 + 3 = 10
    //   20: 30000000 tiyin = 300,000 so'm ; qty 5
    //   30: 10000000 tiyin = 100,000 so'm ; qty 2
    const rows: PosterProductSalesRow[] = [
      row({ product_id: '10', product_name: 'Napoleon', modificator_name: 'CELYY', count: '7', payed_sum: '46200000', unit: 'p' }),
      row({ product_id: '10', product_name: 'Napoleon', modificator_name: 'KUSOK', count: '3', payed_sum: '13800000', unit: 'p' }),
      row({ product_id: '20', product_name: 'Medovik', count: '5', payed_sum: '30000000', unit: 'p' }),
      row({ product_id: '30', product_name: 'Eclair', count: '2', payed_sum: '10000000', unit: 'p' }),
    ];
    stubPoster(rows);

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/top-products?range=custom&from=2026-06-06&to=2026-06-06')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body.from).toBe('2026-06-06');
    expect(res.body.to).toBe('2026-06-06');
    expect(res.body.spot_id).toBeNull();

    const products = res.body.products as Array<{
      product_id: number;
      name: string;
      qty: number;
      unit: string;
      revenue: number;
      share: number;
    }>;
    // Three distinct products (two modifications of 10 collapsed into one).
    expect(products).toHaveLength(3);
    // Sorted by revenue desc: 10 (600k) > 20 (300k) > 30 (100k).
    expect(products.map((p) => p.product_id)).toEqual([10, 20, 30]);

    const napoleon = products[0];
    expect(napoleon.name).toBe('Napoleon');
    expect(napoleon.qty).toBe(10); // 7 + 3
    expect(napoleon.revenue).toBe(600_000); // (46200000 + 13800000)/100
    expect(napoleon.unit).toBe('dona'); // weight_flag=0 -> piece/dona

    // Total period revenue = 1,000,000 so'm -> shares 0.6 / 0.3 / 0.1.
    expect(napoleon.share).toBe(0.6);
    expect(products[1].share).toBe(0.3);
    expect(products[2].share).toBe(0.1);
    // Shares of the full set reconcile to 1.
    const shareSum = products.reduce((s, p) => s + p.share, 0);
    expect(shareSum).toBeCloseTo(1, 6);
  });

  it('applies the top-N limit and keeps share against the full revenue', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    // Five products; ask for top 2. Shares must still divide by the FULL total.
    const rows: PosterProductSalesRow[] = [
      row({ product_id: '1', product_name: 'P1', count: '1', payed_sum: '50000000' }), // 500k
      row({ product_id: '2', product_name: 'P2', count: '1', payed_sum: '30000000' }), // 300k
      row({ product_id: '3', product_name: 'P3', count: '1', payed_sum: '10000000' }), // 100k
      row({ product_id: '4', product_name: 'P4', count: '1', payed_sum: '6000000' }), // 60k
      row({ product_id: '5', product_name: 'P5', count: '1', payed_sum: '4000000' }), // 40k
    ];
    stubPoster(rows);

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/top-products?range=custom&from=2026-06-06&to=2026-06-06&limit=2')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    const products = res.body.products as Array<{ product_id: number; share: number }>;
    expect(products).toHaveLength(2);
    expect(products.map((p) => p.product_id)).toEqual([1, 2]);
    // Full total = 1,000,000 so'm. Top-2 shares are 0.5 and 0.3 (NOT renormalised).
    expect(products[0].share).toBe(0.5);
    expect(products[1].share).toBe(0.3);
  });

  it('clamps an out-of-range limit to the 1..200 bounds', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    // 250 distinct products; ask for limit=999. It must clamp to the 200 max.
    const rows: PosterProductSalesRow[] = Array.from({ length: 250 }, (_, i) =>
      row({ product_id: String(i + 1), product_name: `P${i + 1}`, payed_sum: String((250 - i) * 100000) }),
    );
    stubPoster(rows);

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/top-products?range=custom&from=2026-06-06&to=2026-06-06&limit=999')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    // 999 clamps to the 200 max.
    expect(res.body.products).toHaveLength(200);
  });

  it('honors a large limit up to the 200 cap (full-ranking detail view)', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    // The "full ranking" sheet requests the whole list. With 200 products and
    // limit=200, every product is returned (no truncation below the cap), and
    // the shares of the full set reconcile to 1.
    const rows: PosterProductSalesRow[] = Array.from({ length: 200 }, (_, i) =>
      row({ product_id: String(i + 1), product_name: `P${i + 1}`, payed_sum: String((200 - i) * 100000) }),
    );
    stubPoster(rows);

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/top-products?range=custom&from=2026-06-06&to=2026-06-06&limit=200')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    const products = res.body.products as Array<{ product_id: number; revenue: number; share: number }>;
    // limit=200 is honored exactly — all 200 products returned, not clamped down.
    expect(products).toHaveLength(200);
    // Still revenue-desc (product 1 has the highest payed_sum).
    expect(products[0].product_id).toBe(1);
    expect(products[199].product_id).toBe(200);
    for (let i = 1; i < products.length; i++) {
      expect(products[i - 1].revenue).toBeGreaterThanOrEqual(products[i].revenue);
    }
    // Share denominator is the FULL total across ALL products, so the complete
    // returned set sums to 1.
    const shareSum = products.reduce((s, p) => s + p.share, 0);
    expect(shareSum).toBeCloseTo(1, 4);
  });

  it('returns an empty list when Poster reports no product sales', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    stubPoster([]);

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/top-products?range=custom&from=2019-01-15&to=2019-01-15')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it('derives qty/unit per product type: weight_flag=1 -> kg, weight_flag=0 -> dona', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    // A weight-sold product (SAMSA, sold by kg) and a piece-sold product
    // (TARTALETKA, sold by piece). The kg product sells under two
    // modifications whose fractional `count` weights must SUM in kg.
    //   SAMSA  (100): 9.295 kg + 3.838 kg = 13.133 kg ; 1,115,400 + 383,800 so'm
    //   TART   (200): 66 dona                          ; 462,000 so'm
    const rows: PosterProductSalesRow[] = [
      row({
        product_id: '100',
        product_name: 'Samsa',
        modificator_name: 'GOʻSHTLI',
        count: '9.2950000',
        payed_sum: '111540000',
        unit: 'kg',
        weight_flag: '1',
      }),
      row({
        product_id: '100',
        product_name: 'Samsa',
        modificator_name: 'QOVOQLI',
        count: '3.8380000',
        payed_sum: '38380000',
        unit: 'kg',
        weight_flag: '1',
      }),
      row({
        product_id: '200',
        product_name: 'Tartaletka',
        count: '66',
        payed_sum: '46200000',
        unit: 'p',
        weight_flag: '0',
      }),
    ];
    stubPoster(rows);

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/top-products?range=custom&from=2026-06-06&to=2026-06-06')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    const products = res.body.products as Array<{
      product_id: number;
      qty: number;
      unit: string;
      revenue: number;
    }>;
    expect(products).toHaveLength(2);
    // Revenue-desc ordering: Samsa (1,499,200) > Tartaletka (462,000).
    expect(products.map((p) => p.product_id)).toEqual([100, 200]);

    const samsa = products[0];
    expect(samsa.unit).toBe('kg'); // weight_flag=1 -> kg
    expect(samsa.qty).toBe(13.133); // 9.295 + 3.838, summed in kg
    expect(samsa.revenue).toBe(1_499_200); // (111540000 + 38380000)/100

    const tartaletka = products[1];
    expect(tartaletka.unit).toBe('dona'); // weight_flag=0 -> dona
    expect(tartaletka.qty).toBe(66);
    expect(tartaletka.revenue).toBe(462_000);
  });

  it('rejects a store_manager asking for a spot outside their stores', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    stubPoster([]);

    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'TPA' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'TPB' });
    await ctx.db.query(`UPDATE locations SET poster_spot_id = $1 WHERE id = $2`, [
      99,
      storeB,
    ]);
    const manager = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: storeA,
    });

    const res = await request(ctx.app)
      .get('/api/dashboard/top-products?spotId=99')
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(403);
  });
});
