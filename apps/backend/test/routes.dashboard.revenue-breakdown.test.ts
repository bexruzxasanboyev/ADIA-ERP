/**
 * Money-fix (2026-06-06) — GET /api/dashboard/revenue-breakdown integration.
 *
 * The endpoint now derives the breakdown from per-transaction Poster data
 * (`dash.getTransactions` + `settings.getPaymentMethods`) so Payme and Click
 * are separated out of `card` — `dash.getPaymentsReport` folds them into
 * `payed_card_sum` and CANNOT split them (verified live against `adia`).
 * `dash.getAnalytics` revenue is fetched only as a reconciliation cross-check.
 *
 * Coverage:
 *   - PM gets a chain-wide aggregate with payme/click carved out of card.
 *   - buckets sum back to total (internal consistency).
 *   - a window with no transactions yields a zero breakdown.
 *   - 422 on a malformed date.
 *   - 403 when a store_manager asks for a spot outside their assigned stores.
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

/** The `adia` payment-method map (Payme=19, Click=20; verified live). */
const ADIA_METHODS: PosterPaymentMethod[] = [
  { payment_method_id: '1', title: 'Наличные' },
  { payment_method_id: '2', title: 'Карта' },
  { payment_method_id: '14', title: 'Доверительный платеж' },
  { payment_method_id: '17', title: 'Карта|Абдулқодир ака' },
  { payment_method_id: '19', title: 'Payme' },
  { payment_method_id: '20', title: 'Click' },
];

/**
 * Install a stub Poster client that serves the three endpoints the route now
 * uses: `settings.getPaymentMethods`, `dash.getTransactions` (offset paged) and
 * `dash.getAnalytics`. Records the transaction URLs hit (for assertion).
 */
function stubPoster(opts: {
  methods?: PosterPaymentMethod[];
  transactions?: PosterTransactionSummary[];
  analyticsRevenue?: number;
}): { txUrls: () => string[] } {
  const methods = opts.methods ?? ADIA_METHODS;
  const transactions = opts.transactions ?? [];
  const txUrls: string[] = [];
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      paymentMethodsTtlMs: 0, // no caching between tests
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        if (m === 'settings.getPaymentMethods') {
          return Promise.resolve(
            new Response(JSON.stringify({ response: methods }), { status: 200 }),
          );
        }
        if (m === 'dash.getTransactions') {
          txUrls.push(u.toString());
          // Honour pagination: slice by offset/num so the loop terminates.
          const offset = Number(u.searchParams.get('offset') ?? '0');
          const num = Number(u.searchParams.get('num') ?? '1000');
          const page = transactions.slice(offset, offset + num);
          return Promise.resolve(
            new Response(JSON.stringify({ response: page }), { status: 200 }),
          );
        }
        if (m === 'dash.getAnalytics') {
          const revenue = opts.analyticsRevenue;
          const counters =
            revenue === undefined ? {} : { revenue: String(revenue) };
          return Promise.resolve(
            new Response(JSON.stringify({ response: { data: [], counters } }), {
              status: 200,
            }),
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
  // The route checks config.poster.token != ''; set a non-empty value.
  process.env.POSTER_TOKEN = 'acc:test';
  return { txUrls: () => txUrls };
}

/** Closed transaction factory (tiyin strings, as Poster emits). */
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

describe('GET /api/dashboard/revenue-breakdown', () => {
  it('shows every named method by name and carves payme/click out of card (PM scope)', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    // 2026-06-06 live shape: cash + card defaults, Payme(19), Click(20), plus
    // two named custom methods: id 14 "Доверительный платеж" and id 17
    // "Карта|Абдулқодир ака" — the latter must NOT fold into `card`.
    const transactions: PosterTransactionSummary[] = [
      txn({ pay_type: '1', payment_method_id: '0', payed_cash: '1077369100', payed_sum: '1077369100' }),
      txn({ pay_type: '2', payment_method_id: '0', payed_card: '733211000', payed_sum: '733211000' }),
      txn({ pay_type: '2', payment_method_id: '19', payed_card: '122350000', payed_sum: '122350000' }),
      txn({ pay_type: '2', payment_method_id: '20', payed_card: '91350000', payed_sum: '91350000' }),
      txn({ pay_type: '2', payment_method_id: '14', payed_card: '198383600', payed_sum: '198383600' }),
      txn({ pay_type: '2', payment_method_id: '17', payed_card: '31640000', payed_sum: '31640000' }),
      // open -> excluded
      txn({ pay_type: '0', payment_method_id: '0', payed_sum: '5000000000' }),
    ];
    const expectedTotal =
      10_773_691 + 7_332_110 + 1_223_500 + 913_500 + 1_983_836 + 316_400;
    stubPoster({ transactions, analyticsRevenue: expectedTotal });

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?range=custom&from=2026-06-06&to=2026-06-06')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      from: '2026-06-06',
      to: '2026-06-06',
      spot_id: null,
      total: expectedTotal,
      count: 6,
      byMethod: {
        cash: 10_773_691,
        // card EXCLUDES id 17 -> only the genuine default-split card.
        card: 7_332_110,
        payme: 1_223_500,
        click: 913_500,
        other: 0,
      },
      methods: [
        { key: 'cash', label: 'Naqd', amount: 10_773_691 },
        { key: 'card', label: 'Karta', amount: 7_332_110 },
        { key: 'payme', label: 'Payme', amount: 1_223_500 },
        { key: 'click', label: 'Click', amount: 913_500 },
        // Named customs follow, amount desc.
        { key: 'pm_14', label: 'Доверительный платеж', amount: 1_983_836 },
        { key: 'pm_17', label: 'Карта|Абдулқодир ака', amount: 316_400 },
      ],
    });
    // Reconciliation: methods sum back to the reported total.
    const sumOfMethods = (res.body.methods as { amount: number }[]).reduce(
      (s, m) => s + m.amount,
      0,
    );
    expect(sumOfMethods).toBe(res.body.total);
  });

  it('returns a zero breakdown when Poster reports no transactions', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    stubPoster({ transactions: [], analyticsRevenue: 0 });
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });

    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?range=custom&from=2019-01-15&to=2019-01-15')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      from: '2019-01-15',
      to: '2019-01-15',
      spot_id: null,
      total: 0,
      count: 0,
      byMethod: { cash: 0, card: 0, payme: 0, click: 0, other: 0 },
      // Core 4 always present even at zero; no `other` row when residual is 0.
      methods: [
        { key: 'cash', label: 'Naqd', amount: 0 },
        { key: 'card', label: 'Karta', amount: 0 },
        { key: 'payme', label: 'Payme', amount: 0 },
        { key: 'click', label: 'Click', amount: 0 },
      ],
    });
  });

  it('rejects a malformed range with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?range=custom&from=not-a-date&to=2026-01-01')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(422);
  });

  it('rejects a store_manager asking for a spot outside their stores', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    stubPoster({ transactions: [] });

    // Two stores; the manager only owns store A. Spot id 999 maps to neither.
    const storeA = await makeLocation(ctx.db, { type: 'store', name: 'A' });
    const storeB = await makeLocation(ctx.db, { type: 'store', name: 'B' });
    // Map a poster_spot_id onto storeB so the principal's spot check has a
    // real row to find (and reject).
    await ctx.db.query(`UPDATE locations SET poster_spot_id = $1 WHERE id = $2`, [
      99,
      storeB,
    ]);
    const manager = await makeUser(ctx.db, {
      role: 'store_manager',
      locationId: storeA,
    });

    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?spotId=99')
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(403);
  });
});
