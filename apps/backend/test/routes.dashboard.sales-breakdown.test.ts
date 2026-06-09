/**
 * GET /api/dashboard/sales-breakdown integration.
 *
 * Per-time-bucket itemised breakdown that powers the Yandex-style tooltip on
 * the hourly/daily sales charts. Two dimensions:
 *
 *   - by=product : local `sales` JOIN `products`, grouped (bucket, product),
 *     line amount = sum(s.qty * s.price). After the 2026-06-08 ingest fix
 *     `sales.price` is a TRUE per-unit price, so `qty * price` = the Poster
 *     line total — the SAME formula /stores top_products and reports use, so
 *     the two endpoints agree. Each bucket returns the top-N products by amount
 *     + a rolled-up "Boshqa" remainder.
 *   - by=payment : Poster transactions bucketed by hour/date and payment
 *     method (cash/card/payme/click + named customs). Poster is mocked here —
 *     the test never hits live Poster.
 *
 * Bucket granularity matches the ecosystem chart: hourly for range=today
 * (key = `hour`), daily otherwise (key = `date`). Hours are bucketed in LOCAL
 * Asia/Tashkent time so they align with the chart's `data_hourly` index — a
 * sale at 08:11+05 must land in hour 8 (NOT UTC hour 3).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
  type PosterTransactionSummary,
  type PosterPaymentMethod,
} from '../src/integrations/poster/client.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
  setPosterClientForTests(undefined);
  resetPosterClientCache();
});

beforeEach(async () => {
  setPosterClientForTests(undefined);
  // Isolate sales/products between tests so amounts are deterministic.
  await ctx.db.query('DELETE FROM sales');
});

const ADIA_METHODS: PosterPaymentMethod[] = [
  { payment_method_id: '1', title: 'Наличные' },
  { payment_method_id: '2', title: 'Карта' },
  { payment_method_id: '19', title: 'Payme' },
  { payment_method_id: '20', title: 'Click' },
];

/** Install a stub Poster client serving getPaymentMethods + getTransactions. */
function stubPoster(opts: {
  methods?: PosterPaymentMethod[];
  transactions?: PosterTransactionSummary[];
}): void {
  const methods = opts.methods ?? ADIA_METHODS;
  const transactions = opts.transactions ?? [];
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      paymentMethodsTtlMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        if (m === 'settings.getPaymentMethods') {
          return Promise.resolve(
            new Response(JSON.stringify({ response: methods }), { status: 200 }),
          );
        }
        if (m === 'dash.getTransactions') {
          const offset = Number(u.searchParams.get('offset') ?? '0');
          const num = Number(u.searchParams.get('num') ?? '1000');
          const page = transactions.slice(offset, offset + num);
          return Promise.resolve(
            new Response(JSON.stringify({ response: page }), { status: 200 }),
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

/** Today's calendar date in Asia/Tashkent as YYYY-MM-DD (matches BUSINESS_TZ). */
function tashkentTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Closed Poster transaction factory (tiyin strings). */
function txn(over: Partial<PosterTransactionSummary>): PosterTransactionSummary {
  return {
    transaction_id: '1',
    spot_id: '1',
    pay_type: '1',
    payment_method_id: '0',
    payed_cash: '0',
    payed_card: '0',
    payed_third_party: '0',
    payed_ewallet: '0',
    payed_bonus: '0',
    payed_sum: '0',
    ...over,
  };
}

/**
 * Insert one local sale line. `lineTotalSom` is the LINE TOTAL in so'm. After
 * the 2026-06-08 ingest fix `sales.price` is a TRUE per-unit price, so we store
 * `price = lineTotalSom / qty` and the breakdown's revenue is `sum(qty*price)`
 * = the line total — the SAME formula every other revenue query uses.
 */
let saleSeq = 0;
async function insertSale(opts: {
  storeId: number;
  productId: number;
  qty: number;
  lineTotalSom: number;
  soldAt: string; // ISO timestamptz (zone-explicit)
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
      opts.lineTotalSom / opts.qty, // per-unit price (post-fix convention)
      opts.soldAt,
      900000 + saleSeq,
      saleSeq,
    ],
  );
}

describe('GET /api/dashboard/sales-breakdown', () => {
  it('by=product hourly: local-TZ hour buckets + sum(qty*price) revenue + Boshqa rollup (PM scope)', async () => {
    const store = await makeLocation(ctx.db, { type: 'store', name: 'S1' });
    const cake = await makeProduct(ctx.db, { name: 'Tort', unit: 'pcs' });
    const bun = await makeProduct(ctx.db, { name: 'Bulochka', unit: 'pcs' });
    const pie = await makeProduct(ctx.db, { name: 'Pirog', unit: 'pcs' });

    // Anchor on the TASHKENT calendar day (the today path filters by local
    // date). Build sales with explicit +05:00 timestamps so the local hour is
    // unambiguous: 08:xx+05 must bucket into hour 8, NOT UTC hour 3.
    const tashToday = tashkentTodayIso();
    const at = (h: number, m = 0): string =>
      `${tashToday}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:00`;

    // Hour 8: 3 products. limit=2 -> top 2 by amount + Boshqa(remainder).
    // `price` is per-unit; qty is units sold. amount = sum(qty*price) = line total.
    //   cake: line total 200000 (qty 2)  (top 1)
    //   bun : line total 150000 (qty 3)  (top 2)
    //   pie : line total  40000 (qty 1)  (-> Boshqa)
    await insertSale({ storeId: store, productId: cake, qty: 2, lineTotalSom: 200000, soldAt: at(8, 11) });
    await insertSale({ storeId: store, productId: bun, qty: 3, lineTotalSom: 150000, soldAt: at(8, 30) });
    await insertSale({ storeId: store, productId: pie, qty: 1, lineTotalSom: 40000, soldAt: at(8, 45) });
    // Hour 9: a single product (no Boshqa expected).
    await insertSale({ storeId: store, productId: cake, qty: 1, lineTotalSom: 100000, soldAt: at(9) });

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/sales-breakdown?range=today&by=product&limit=2')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe('hour');
    expect(res.body.by).toBe('product');

    const buckets = res.body.buckets as Array<{
      hour: number;
      total_qty: number;
      total_amount: number;
      items: Array<{ name: string; qty: number; amount: number }>;
    }>;

    // Local-TZ bucketing: the 08:xx+05 sales land in hour 8 (not UTC hour 3).
    expect(buckets.some((b) => b.hour === 3)).toBe(false);

    const h8 = buckets.find((b) => b.hour === 8);
    expect(h8).toBeDefined();
    if (h8 === undefined) throw new Error('missing hour-8 bucket');
    expect(h8.total_qty).toBe(6); // 2 + 3 + 1 units
    // amount = sum(qty*price) = LINE TOTALS (price is now per-unit).
    expect(h8.total_amount).toBe(390000); // 200000 + 150000 + 40000
    // top 2 by amount, then a single rolled-up "Boshqa".
    expect(h8.items).toEqual([
      { name: 'Tort', qty: 2, amount: 200000 },
      { name: 'Bulochka', qty: 3, amount: 150000 },
      { name: 'Boshqa', qty: 1, amount: 40000 },
    ]);

    const h9 = buckets.find((b) => b.hour === 9);
    expect(h9).toBeDefined();
    if (h9 === undefined) throw new Error('missing hour-9 bucket');
    expect(h9.total_qty).toBe(1);
    expect(h9.total_amount).toBe(100000);
    expect(h9.items).toEqual([{ name: 'Tort', qty: 1, amount: 100000 }]);
  });

  it('by=product respects store scoping (manager sees only their store)', async () => {
    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'A' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'B' });
    const cake = await makeProduct(ctx.db, { name: 'Tort', unit: 'pcs' });

    const tashToday = tashkentTodayIso();
    const at = (h: number): string => `${tashToday}T${String(h).padStart(2, '0')}:00:00+05:00`;
    await insertSale({ storeId: storeA, productId: cake, qty: 1, lineTotalSom: 100000, soldAt: at(10) });
    await insertSale({ storeId: storeB, productId: cake, qty: 9, lineTotalSom: 100000, soldAt: at(10) });

    const manager = await makeUser(ctx.db, { role: 'store_manager', locationId: storeA });
    const res = await request(ctx.app)
      .get('/api/dashboard/sales-breakdown?range=today&by=product')
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    const h10 = (res.body.buckets as Array<{ hour: number; total_qty: number }>).find(
      (b) => b.hour === 10,
    );
    expect(h10).toBeDefined();
    // Only store A's single unit is visible, not store B's nine.
    expect(h10?.total_qty).toBe(1);
  });

  it('by=payment hourly: methods per bucket from mocked transactions', async () => {
    // `date_close` is a zoneless "YYYY-MM-DD HH:mm:ss" string in the Poster
    // account's LOCAL Tashkent time — its hour is read verbatim as the local
    // bucket hour (08:05 -> hour 8).
    const tashToday = tashkentTodayIso();
    const closeAt = (h: number, mm = 0): string =>
      `${tashToday} ${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

    // Hour 8: 2 cash receipts + 1 Payme receipt.
    // Hour 9: 1 card receipt.
    const transactions: PosterTransactionSummary[] = [
      txn({ transaction_id: '1', pay_type: '1', payment_method_id: '0', payed_cash: '500000', payed_sum: '500000', date_close: closeAt(8, 5) }),
      txn({ transaction_id: '2', pay_type: '1', payment_method_id: '0', payed_cash: '300000', payed_sum: '300000', date_close: closeAt(8, 40) }),
      txn({ transaction_id: '3', pay_type: '2', payment_method_id: '19', payed_card: '900000', payed_sum: '900000', date_close: closeAt(8, 55) }),
      txn({ transaction_id: '4', pay_type: '2', payment_method_id: '0', payed_card: '700000', payed_sum: '700000', date_close: closeAt(9, 15) }),
      // open -> excluded entirely.
      txn({ transaction_id: '5', pay_type: '0', payment_method_id: '0', payed_sum: '9999999', date_close: closeAt(8, 1) }),
    ];
    stubPoster({ transactions });
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/sales-breakdown?range=today&by=payment')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body.granularity).toBe('hour');
    expect(res.body.by).toBe('payment');

    const buckets = res.body.buckets as Array<{
      hour: number;
      total_qty: number;
      total_amount: number;
      items: Array<{ name: string; qty: number; amount: number }>;
    }>;

    const h8 = buckets.find((b) => b.hour === 8);
    expect(h8).toBeDefined();
    if (h8 === undefined) throw new Error('missing hour-8 bucket');
    // total_qty = receipt count (excludes the open txn).
    expect(h8.total_qty).toBe(3);
    expect(h8.total_amount).toBe(17000); // (500000 + 300000 + 900000) tiyin -> so'm
    // Payme is the largest single method -> first; cash (2 receipts) second.
    expect(h8.items).toEqual([
      { name: 'Payme', qty: 1, amount: 9000 },
      { name: 'Naqd', qty: 2, amount: 8000 },
    ]);

    const h9 = buckets.find((b) => b.hour === 9);
    expect(h9).toBeDefined();
    expect(h9?.total_qty).toBe(1);
    expect(h9?.total_amount).toBe(7000);
    expect(h9?.items).toEqual([{ name: 'Karta', qty: 1, amount: 7000 }]);
  });

  it('by=payment auto-scopes a store_manager to their own store spot', async () => {
    const tashToday = tashkentTodayIso();
    const closeAt = (h: number, mm = 0): string =>
      `${tashToday} ${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`;

    const myStore = await makeLocation(ctx.db, { type: 'store', name: 'Kukcha' });
    await ctx.db.query(`UPDATE locations SET poster_spot_id = $1 WHERE id = $2`, [
      1,
      myStore,
    ]);

    // spot 1 = manager's store; spot 2 = another store that MUST be excluded.
    const transactions: PosterTransactionSummary[] = [
      txn({ transaction_id: '1', spot_id: '1', pay_type: '1', payment_method_id: '0', payed_cash: '500000', payed_sum: '500000', date_close: closeAt(8) }),
      txn({ transaction_id: '2', spot_id: '2', pay_type: '1', payment_method_id: '0', payed_cash: '900000', payed_sum: '900000', date_close: closeAt(8) }),
    ];
    // Spot-aware stub so the filter genuinely drops other stores' rows.
    setPosterClientForTests(
      new PosterClient({
        token: 'acc:test',
        minIntervalMs: 0,
        paymentMethodsTtlMs: 0,
        fetcher: ((url: string | URL) => {
          const u = typeof url === 'string' ? new URL(url) : url;
          const m = u.pathname.split('/').pop();
          if (m === 'settings.getPaymentMethods') {
            return Promise.resolve(
              new Response(JSON.stringify({ response: ADIA_METHODS }), { status: 200 }),
            );
          }
          if (m === 'dash.getTransactions') {
            const spot = u.searchParams.get('spot_id');
            const offset = Number(u.searchParams.get('offset') ?? '0');
            const num = Number(u.searchParams.get('num') ?? '1000');
            const filtered =
              spot === null
                ? transactions
                : transactions.filter((t) => String(t.spot_id) === spot);
            return Promise.resolve(
              new Response(
                JSON.stringify({ response: filtered.slice(offset, offset + num) }),
                { status: 200 },
              ),
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
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    const manager = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: myStore,
    });
    const res = await request(ctx.app)
      .get('/api/dashboard/sales-breakdown?range=today&by=payment')
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    const h8 = (
      res.body.buckets as Array<{ hour: number; total_qty: number; total_amount: number }>
    ).find((b) => b.hour === 8);
    expect(h8).toBeDefined();
    // Only the manager's own store (5000 so'm), NOT the other store's 9000.
    expect(h8?.total_qty).toBe(1);
    expect(h8?.total_amount).toBe(5000);
  });

  it('by=payment returns empty for a store_manager whose store has no Poster spot', async () => {
    const tashToday = tashkentTodayIso();
    const closeAt = (h: number): string => `${tashToday} ${String(h).padStart(2, '0')}:00:00`;
    stubPoster({
      transactions: [
        txn({ pay_type: '1', payment_method_id: '0', payed_cash: '900000', payed_sum: '900000', date_close: closeAt(8) }),
      ],
    });
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    const store = await makeLocation(ctx.db, { type: 'store', name: 'NoSpot' });
    const manager = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: store,
    });

    const res = await request(ctx.app)
      .get('/api/dashboard/sales-breakdown?range=today&by=payment')
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.buckets).toEqual([]);
  });

  it('rejects a malformed range with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/sales-breakdown?range=custom&from=not-a-date&to=2026-01-01')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
  });
});
