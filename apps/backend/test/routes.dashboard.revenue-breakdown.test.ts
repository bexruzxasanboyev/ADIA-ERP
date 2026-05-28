/**
 * Sub-task #7 — GET /api/dashboard/revenue-breakdown integration tests.
 *
 * The endpoint hits `dash.getPaymentsReport` and aggregates per method
 * (cash / card / payme / click / other). We stub the Poster client with a
 * synthetic fetcher so the route runs end-to-end without network access.
 *
 * Coverage:
 *   - PM gets a chain-wide aggregate for today.
 *   - `?date=` is forwarded to Poster as YYYYMMDD.
 *   - the method classifier handles built-in ids (1/2) AND custom titles
 *     (Payme, Click) AND unknowns (other).
 *   - 422 on a malformed date.
 *   - 403 when a store_manager asks for a spot outside their assigned
 *     stores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
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

/**
 * Install a stub Poster client whose `dash.getPaymentsReport` returns the
 * given rows and remembers the last URL it was called with (for assertion).
 */
function stubPosterPayments(
  rows: Array<{
    payment_id: number | string;
    payment_title: string;
    payment_sum: number | string;
    payment_count?: number | string;
  }>,
): { lastUrl: () => string | undefined } {
  let lastUrl: string | undefined;
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        lastUrl = u.toString();
        if (m === 'dash.getPaymentsReport') {
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
  // The route checks config.poster.token != ''; set a non-empty value.
  process.env.POSTER_TOKEN = 'acc:test';
  return { lastUrl: () => lastUrl };
}

describe('GET /api/dashboard/revenue-breakdown', () => {
  it('aggregates per method and sums to total (PM scope)', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();

    stubPosterPayments([
      // Built-in cash + card by id.
      { payment_id: 1, payment_title: 'Naqd', payment_sum: '100000' },
      { payment_id: 2, payment_title: 'Karta', payment_sum: '250000' },
      // Custom titles -> payme / click.
      { payment_id: 7, payment_title: 'Payme', payment_sum: '500000' },
      { payment_id: 8, payment_title: 'Click', payment_sum: '300000' },
      // Unknown method -> other.
      { payment_id: 99, payment_title: 'Crypto USDT', payment_sum: '50000' },
    ]);

    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?date=2026-05-27')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      date: '2026-05-27',
      spot_id: null,
      total: 1_200_000,
      by_method: {
        cash: 100_000,
        card: 250_000,
        payme: 500_000,
        click: 300_000,
        other: 50_000,
      },
    });
  });

  it('forwards the date to Poster as YYYYMMDD', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    const handle = stubPosterPayments([]);
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });

    await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?date=2026-01-15')
      .set('Authorization', `Bearer ${pm.token}`);

    const url = handle.lastUrl();
    expect(url).toBeDefined();
    const params = new URL(url!).searchParams;
    expect(params.get('dateFrom')).toBe('20260115');
    expect(params.get('dateTo')).toBe('20260115');
  });

  it('rejects a malformed date with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .get('/api/dashboard/revenue-breakdown?date=not-a-date')
      .set('Authorization', `Bearer ${pm.token}`);

    expect(res.status).toBe(422);
  });

  it('rejects a store_manager asking for a spot outside their stores', async () => {
    const { resetConfigCache } = await import('../src/config/index.js');
    resetConfigCache();
    stubPosterPayments([]);

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
