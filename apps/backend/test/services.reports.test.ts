/**
 * Reports service — the SQL aggregations must return the right numbers on
 * seeded data, and RBAC scoping must confine a store_manager to their own
 * store. Integration tests against an isolated schema (the standard harness).
 *
 * The payment-type report reads Poster (the only source of method splits); a
 * stub PosterClient serves a fixed legacy per-method row array so the bucket
 * math is deterministic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct } from './helpers/fixtures.js';
import {
  getBelowMinReport,
  getPaymentTypeReport,
  getSalesReport,
  getTrendProducts,
} from '../src/services/reports.js';
import {
  PosterClient,
  resetPosterClientCache,
  setPosterClientForTests,
} from '../src/integrations/poster/client.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});
beforeEach(async () => {
  await ctx.db.query('DELETE FROM sales');
  await ctx.db.query('DELETE FROM stock');
  resetPosterClientCache();
  setPosterClientForTests(undefined);
});

/** Insert a sale line at `sold_at` (default: now). */
async function addSale(opts: {
  storeId: number;
  productId: number;
  qty: number;
  price: number;
  txId: number;
  lineId?: number;
  soldAt?: Date;
}): Promise<void> {
  await ctx.db.query(
    `INSERT INTO sales (store_id, product_id, qty, price, sold_at, poster_transaction_id, poster_line_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      opts.storeId,
      opts.productId,
      opts.qty,
      opts.price,
      opts.soldAt ?? new Date(),
      opts.txId,
      opts.lineId ?? opts.txId,
    ],
  );
}

describe('getSalesReport', () => {
  it('totals revenue + receipts and breaks down per store (pm scope)', async () => {
    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'Do\'kon A' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'Do\'kon B' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });

    // Store A: 2 receipts (tx 100, 101); revenue 10*2 + 10*3 = 50.
    await addSale({ storeId: storeA, productId: cake, qty: 2, price: 10, txId: 100, lineId: 1 });
    await addSale({ storeId: storeA, productId: cake, qty: 3, price: 10, txId: 101, lineId: 2 });
    // Store B: 1 receipt (tx 200); revenue 5*4 = 20.
    await addSale({ storeId: storeB, productId: cake, qty: 4, price: 5, txId: 200, lineId: 3 });

    const report = await getSalesReport('bugun', { kind: 'all' });
    const overview = report.sections[0]!;
    expect(overview.rows[0]).toEqual(['Umumiy tushum', "70 so'm"]);
    expect(overview.rows[1]).toEqual(['Cheklar soni', '3']);

    const breakdown = report.sections[1]!;
    // Sorted by revenue DESC — A (50) before B (20).
    expect(breakdown.rows[0]![0]).toBe("Do'kon A");
    expect(breakdown.rows[0]![1]).toBe("50 so'm");
    expect(breakdown.rows[0]![2]).toBe('2');
    expect(breakdown.rows[1]![0]).toBe("Do'kon B");
    expect(breakdown.total).toEqual(['Jami', "70 so'm", '3']);
  });

  it('scopes a store_manager to their own store only', async () => {
    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'Do\'kon A' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'Do\'kon B' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    await addSale({ storeId: storeA, productId: cake, qty: 2, price: 10, txId: 100, lineId: 1 });
    await addSale({ storeId: storeB, productId: cake, qty: 4, price: 5, txId: 200, lineId: 2 });

    const report = await getSalesReport('bugun', { kind: 'store', storeId: storeA });
    const breakdown = report.sections[1]!;
    expect(breakdown.rows).toHaveLength(1);
    expect(breakdown.rows[0]![0]).toBe("Do'kon A");
    // Only store A's 20 so'm is counted.
    expect(report.sections[0]!.rows[0]).toEqual(['Umumiy tushum', "20 so'm"]);
  });

  it('excludes sales outside the period window', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    await addSale({ storeId: store, productId: cake, qty: 1, price: 100, txId: 1, lineId: 1, soldAt: old });
    await addSale({ storeId: store, productId: cake, qty: 1, price: 50, txId: 2, lineId: 2 });

    // 'bugun' = today only -> only the 50 so'm sale.
    const today = await getSalesReport('bugun', { kind: 'all' });
    expect(today.sections[0]!.rows[0]).toEqual(['Umumiy tushum', "50 so'm"]);
    // 'oy' = last 30 days -> both (150 so'm).
    const month = await getSalesReport('oy', { kind: 'all' });
    expect(month.sections[0]!.rows[0]).toEqual(['Umumiy tushum', "150 so'm"]);
  });
});

describe('getTrendProducts', () => {
  it('ranks products by revenue and totals qty + revenue', async () => {
    const store = await makeLocation(ctx.db, { type: 'store' });
    const napoleon = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Napoleon' });
    const eclair = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Eclair' });

    // Napoleon: qty 5, revenue 5*100 = 500.
    await addSale({ storeId: store, productId: napoleon, qty: 5, price: 100, txId: 1, lineId: 1 });
    // Eclair: qty 10, revenue 10*30 = 300.
    await addSale({ storeId: store, productId: eclair, qty: 10, price: 30, txId: 2, lineId: 2 });

    const report = await getTrendProducts('bugun', { kind: 'all' });
    const sec = report.sections[0]!;
    // Napoleon (500) ranks above Eclair (300).
    expect(sec.rows[0]![1]).toBe('Napoleon');
    expect(sec.rows[0]![2]).toBe('5 pcs');
    expect(sec.rows[0]![3]).toBe("500 so'm");
    expect(sec.rows[1]![1]).toBe('Eclair');
    // Total: qty 15, revenue 800.
    expect(sec.total).toEqual(['', 'Jami', '15', "800 so'm"]);
  });
});

describe('getBelowMinReport', () => {
  it('lists products at or under min with location + shortfall', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'Markaz' });
    const low = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Tort' });
    const ok = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Bulochka' });
    // low: qty 2 <= min 5 -> below min (shortfall 3).
    await ctx.db.query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level) VALUES ($1,$2,2,5,20)`,
      [store, low],
    );
    // ok: qty 30 > min 5 -> not below.
    await ctx.db.query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level) VALUES ($1,$2,30,5,40)`,
      [store, ok],
    );

    const report = await getBelowMinReport({ kind: 'all' });
    const sec = report.sections[0]!;
    expect(sec.rows).toHaveLength(1);
    expect(sec.rows[0]![0]).toBe('Markaz');
    expect(sec.rows[0]![1]).toBe('Tort');
    expect(sec.rows[0]![2]).toBe('2 pcs');
    expect(sec.rows[0]![3]).toBe('5 pcs');
    expect(sec.rows[0]![4]).toBe('-3 pcs');
  });

  it('scopes below-min to a single store for a store_manager', async () => {
    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'A' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'B' });
    const p = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    await ctx.db.query(
      `INSERT INTO stock (location_id, product_id, qty, min_level, max_level) VALUES ($1,$2,1,5,20),($3,$2,1,5,20)`,
      [storeA, p, storeB],
    );
    const report = await getBelowMinReport({ kind: 'store', storeId: storeA });
    expect(report.sections[0]!.rows).toHaveLength(1);
    expect(report.sections[0]!.rows[0]![0]).toBe('A');
  });
});

describe('getPaymentTypeReport', () => {
  it('buckets the Poster payment report by method with percentages', async () => {
    // Legacy per-method row array (one of the two shapes Poster emits).
    // Sums are in TIYIN -> tiyinToSom divides by 100.
    setPosterClientForTests(
      new PosterClient({
        token: 'acc:test',
        minIntervalMs: 0,
        fetcher: ((url: string | URL) => {
          const u = typeof url === 'string' ? new URL(url) : url;
          const m = u.pathname.split('/').pop();
          if (m === 'dash.getPaymentsReport') {
            const payload = {
              response: [
                { payment_id: 1, payment_title: 'Naqd', payment_count: 3, payment_sum: 600_000 },
                { payment_id: 2, payment_title: 'Bank kartasi', payment_count: 2, payment_sum: 400_000 },
              ],
            };
            return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
          }
          return Promise.resolve(
            new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
          );
        }) as unknown as typeof fetch,
      }),
    );

    const report = await getPaymentTypeReport('bugun', { kind: 'all' });
    const sec = report.sections[0]!;
    // 600000 tiyin = 6000 so'm cash; 400000 tiyin = 4000 so'm card; total 10000.
    const cash = sec.rows.find((r) => r[0] === 'Naqd');
    const card = sec.rows.find((r) => r[0] === 'Karta');
    expect(cash?.[1]).toBe("6 000 so'm");
    expect(cash?.[2]).toBe('60.0%');
    expect(card?.[1]).toBe("4 000 so'm");
    expect(card?.[2]).toBe('40.0%');
    expect(sec.total).toEqual(['Jami', "10 000 so'm", '100.0%']);
  });
});
