/**
 * EPIC 8.5 — GET /api/cash-shifts integration tests + mapper unit tests.
 *
 * Coverage:
 *   - mapCashShift: tiyin->so'm, closing_balance + kniжный/факт discrepancy.
 *   - route maps Poster finance.getCashShifts onto the CashShift contract,
 *     resolves spot_id -> ADIA store, returns { items: [...] }.
 *   - RBAC: store_manager sees only its own store; foreign store_id -> 403.
 *   - unauthenticated -> 401.
 *   - graceful degradation: a method-level PosterApiError (HTTP 405 / Poster
 *     code 30) yields 200 {items:[]} instead of 500.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  PosterClient,
  setPosterClientForTests,
  resetPosterClientCache,
} from '../src/integrations/poster/client.js';
import { mapCashShift } from '../src/services/cashShift.js';
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

/** Create a store carrying a Poster spot_id and return both ids. */
async function makeStoreWithSpot(spotId: number, name: string): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, poster_spot_id) VALUES ($1, 'store', $2) RETURNING id`,
    [name, spotId],
  );
  return Number(rows[0]!.id);
}

/** Stub the Poster client so finance.getCashShifts returns `shifts`. */
function stubCashShifts(shifts: unknown[]): void {
  setPosterClientForTests(
    new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const m = u.pathname.split('/').pop();
        // Poster's real method is case-sensitive `finance.getCashShifts`.
        if (m === 'finance.getCashShifts') {
          return Promise.resolve(
            new Response(JSON.stringify({ response: shifts }), { status: 200 }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    }),
  );
  process.env.POSTER_TOKEN = 'acc:test';
}

/**
 * Stub a Poster client whose cash-shift call fails like a real unavailable
 * method. `mode` selects the failure shape:
 *   - 'http405' — HTTP 405 (what the lowercase method used to return);
 *   - 'envelope30' — HTTP 200 with `{error:{code:30,...}}` (Poster style).
 */
function stubCashShiftsUnavailable(mode: 'http405' | 'envelope30'): void {
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
          new Response(
            JSON.stringify({ error: { code: 30, message: 'Method Not Allowed' } }),
            { status: 200 },
          ),
        );
      }) as unknown as typeof fetch,
    }),
  );
  process.env.POSTER_TOKEN = 'acc:test';
}

describe('mapCashShift (pure)', () => {
  it('converts tiyin->so\'m and derives closing balance + discrepancy', () => {
    // amounts in tiyin: start 100000(=1000), cash 500000(=5000),
    // card 200000(=2000), debit 50000(=500), collection 300000(=3000),
    // end 120000(=1200 factual).
    const dto = mapCashShift(
      {
        cash_shift_id: 7,
        spot_id: 1,
        amount_start: 100000,
        amount_end: 120000,
        amount_sell_cash: 500000,
        amount_sell_card: 200000,
        amount_debit: 50000,
        amount_collection: 300000,
        date_start: '2026-05-29 08:00:00',
        date_end: '2026-05-29 20:00:00',
        user_id: 42,
      },
      { id: 9, name: 'Do\'kon-1' },
    );
    expect(dto.id).toBe(7);
    expect(dto.store_id).toBe(9);
    expect(dto.status).toBe('closed');
    expect(dto.cash_amount).toBe(5000);
    expect(dto.card_amount).toBe(2000);
    expect(dto.total_sales).toBe(7000);
    expect(dto.expense_amount).toBe(500);
    expect(dto.collected_amount).toBe(3000);
    // closing = 1000 + 5000 - 500 - 3000 = 2500.
    expect(dto.closing_balance).toBe(2500);
    // discrepancy = 2500 - 1200 (factual end) = 1300.
    expect(dto.balance_discrepancy).toBe(1300);
  });

  it('open shift (no date_end) has status open and zero discrepancy', () => {
    const dto = mapCashShift(
      { cash_shift_id: 1, amount_sell_cash: 100000, date_start: '2026-05-29 08:00:00' },
      { id: 5, name: 'S' },
    );
    expect(dto.status).toBe('open');
    expect(dto.balance_discrepancy).toBe(0);
  });
});

describe('GET /api/cash-shifts', () => {
  it('PM sees mapped shifts for stores with a resolved spot', async () => {
    const store = await makeStoreWithSpot(501, 'Spot Store A');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubCashShifts([
      {
        cash_shift_id: 1001,
        spot_id: 501,
        amount_sell_cash: 400000,
        amount_sell_card: 100000,
        date_start: '2026-05-29 08:00:00',
        date_end: '2026-05-29 20:00:00',
      },
      // A shift for an unmapped spot — must be dropped.
      { cash_shift_id: 1002, spot_id: 99999, amount_sell_cash: 1 },
    ]);

    const res = await request(ctx.app)
      .get('/api/cash-shifts?range=today')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((s: { id: number }) => s.id);
    expect(ids).toContain(1001);
    expect(ids).not.toContain(1002);
    const shift = res.body.items.find((s: { id: number }) => s.id === 1001);
    expect(shift.store_id).toBe(store);
    expect(shift.total_sales).toBe(5000);
  });

  it('store_manager requesting a foreign store_id -> 403', async () => {
    const storeB = await makeStoreWithSpot(502, 'Spot Store B');
    const otherStore = await makeStoreWithSpot(503, 'Spot Store C');
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: storeB });
    stubCashShifts([]);
    const res = await request(ctx.app)
      .get(`/api/cash-shifts?store_id=${otherStore}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });

  it('unauthenticated -> 401', async () => {
    const res = await request(ctx.app).get('/api/cash-shifts');
    expect(res.status).toBe(401);
  });

  it('degrades to 200 {items:[]} when Poster returns HTTP 405 (method unavailable)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubCashShiftsUnavailable('http405');
    const res = await request(ctx.app)
      .get('/api/cash-shifts?range=today')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('degrades to 200 {items:[]} on Poster {code:30} envelope (method not allowed)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    stubCashShiftsUnavailable('envelope30');
    const res = await request(ctx.app)
      .get('/api/cash-shifts?range=today')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TZ Module 15 — GET /api/cash-shifts/reconciliations
// ---------------------------------------------------------------------------

/** Insert a cash_shift_reconciliation row directly; returns its id. */
async function makeReconciliation(opts: {
  locationId: number;
  shiftDate: string; // YYYY-MM-DD
  status: 'matched' | 'discrepancy' | 'no_poster_data';
  posterCashShiftId?: string | null;
}): Promise<{ id: number; nakladnoyId: number }> {
  const { rows: nak } = await ctx.db.query<{ id: string }>(
    `INSERT INTO nakladnoy (source, source_ref, qty, location_id, total_amount)
     VALUES ('cash_shift', $1, 0, $2, 0) RETURNING id`,
    [`loc:${opts.locationId}`, opts.locationId],
  );
  const nakladnoyId = Number(nak[0]!.id);
  const hasPoster = opts.status !== 'no_poster_data';
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO cash_shift_reconciliation
       (nakladnoy_id, location_id, shift_date, poster_cash_shift_id,
        submitted_cash, submitted_card, submitted_expense,
        poster_cash, poster_card, poster_expense, poster_safe_balance,
        cash_diff, card_diff, expense_diff, status)
     VALUES ($1, $2, $3::date, $4,
             3000000, 2000000, 500000,
             $5, $6, $7, $8,
             $9, $10, $11, $12)
     RETURNING id`,
    [
      nakladnoyId,
      opts.locationId,
      opts.shiftDate,
      opts.posterCashShiftId ?? (hasPoster ? '9000' : null),
      hasPoster ? 2000000 : null,
      hasPoster ? 2000000 : null,
      hasPoster ? 500000 : null,
      hasPoster ? 3400 : null,
      hasPoster ? 1000000 : null,
      hasPoster ? 0 : null,
      hasPoster ? 0 : null,
      opts.status,
    ],
  );
  return { id: Number(rows[0]!.id), nakladnoyId };
}

describe('GET /api/cash-shifts/reconciliations', () => {
  it('PM sees all reconciliations joined with location_name + nakladnoy id, newest first', async () => {
    const storeA = await makeStoreWithSpot(801, 'Recon Store A');
    const storeB = await makeStoreWithSpot(802, 'Recon Store B');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const older = await makeReconciliation({ locationId: storeA, shiftDate: '2026-06-01', status: 'matched' });
    const newer = await makeReconciliation({ locationId: storeB, shiftDate: '2026-06-08', status: 'discrepancy' });

    // Scope to storeB so the "newest first" assertion is deterministic even as
    // other tests in this no-cleanup suite leave reconciliation rows behind.
    const res = await request(ctx.app)
      .get(`/api/cash-shifts/reconciliations?location_id=${storeB}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: { id: number }) => r.id);
    expect(ids).toContain(newer.id);
    expect(ids).not.toContain(older.id); // older belongs to storeA — filtered out.
    // Newest (created last) first within storeB.
    expect(res.body.items[0].id).toBe(newer.id);
    const top = res.body.items[0];
    expect(top.location_id).toBe(storeB);
    expect(top.location_name).toBe('Recon Store B');
    expect(top.nakladnoy_id).toBe(newer.nakladnoyId);
    expect(top.status).toBe('discrepancy');
    expect(top.shift_date).toBe('2026-06-08');
    // Numeric fields are numbers, not strings.
    expect(typeof top.submitted_cash).toBe('number');
    expect(typeof top.cash_diff).toBe('number');
  });

  it('no_poster_data row carries null poster_* fields', async () => {
    const store = await makeStoreWithSpot(803, 'Recon Store C');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await makeReconciliation({ locationId: store, shiftDate: '2026-06-05', status: 'no_poster_data' });
    const res = await request(ctx.app)
      .get('/api/cash-shifts/reconciliations?status=no_poster_data')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.poster_cash).toBeNull();
    expect(item.cash_diff).toBeNull();
    expect(item.poster_cash_shift_id).toBeNull();
  });

  it('store_manager sees ONLY its own location reconciliations', async () => {
    const myStore = await makeStoreWithSpot(804, 'Mine');
    const otherStore = await makeStoreWithSpot(805, 'Theirs');
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: myStore });
    const mine = await makeReconciliation({ locationId: myStore, shiftDate: '2026-06-07', status: 'matched' });
    await makeReconciliation({ locationId: otherStore, shiftDate: '2026-06-07', status: 'matched' });

    const res = await request(ctx.app)
      .get('/api/cash-shifts/reconciliations')
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: { id: number }) => r.id);
    expect(ids).toEqual([mine.id]);
  });

  it('store_manager requesting a foreign location_id -> 403', async () => {
    const myStore = await makeStoreWithSpot(806, 'Mine2');
    const otherStore = await makeStoreWithSpot(807, 'Theirs2');
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: myStore });
    const res = await request(ctx.app)
      .get(`/api/cash-shifts/reconciliations?location_id=${otherStore}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });

  it('filters by status and date window', async () => {
    const store = await makeStoreWithSpot(808, 'Filter Store');
    const pm = await makeUser(ctx.db, { role: 'pm' });
    await makeReconciliation({ locationId: store, shiftDate: '2026-05-01', status: 'matched' });
    const wanted = await makeReconciliation({ locationId: store, shiftDate: '2026-06-08', status: 'discrepancy' });

    // Scope to this store (unique) so other suites' rows don't leak in.
    const res = await request(ctx.app)
      .get(`/api/cash-shifts/reconciliations?location_id=${store}&status=discrepancy&from=2026-06-01&to=2026-06-30`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((r: { id: number }) => r.id);
    expect(ids).toEqual([wanted.id]);
  });

  it('rejects an unknown status filter with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/cash-shifts/reconciliations?status=bogus')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(422);
  });

  it('unauthenticated -> 401', async () => {
    const res = await request(ctx.app).get('/api/cash-shifts/reconciliations');
    expect(res.status).toBe(401);
  });
});
