/**
 * TZ Module 15 — kassir bot reconciliation (solishtiruv) tests.
 *
 * Two layers:
 *   1. PURE — `computeReconciliation` status logic (matched / discrepancy /
 *      no_poster_data) + the tolerance boundary, and `aggregatePosterShifts`
 *      (TIYIN→so'm, multi-shift sum). No DB / no network.
 *   2. INTEGRATION (real schema, stubbed Poster) — `reconcileCashShift`:
 *      - persists a row with the right field-mapping + status,
 *      - stamps nakladnoy.source_ref with the Poster cash_shift_id,
 *      - notifies PM + manager on a discrepancy,
 *      - NON-FATAL GUARANTEE: a Poster outage still inserts a `no_poster_data`
 *        row and never throws.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  computeReconciliation,
  aggregatePosterShifts,
  reconcileCashShift,
} from '../src/services/cashShiftReconciliation.js';
import { PosterClient } from '../src/integrations/poster/client.js';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';

// ---------------------------------------------------------------------------
// 1. Pure logic
// ---------------------------------------------------------------------------

describe('computeReconciliation (pure)', () => {
  const submitted = { cash: 3_000_000, card: 2_000_000, expense: 500_000 };

  it('returns no_poster_data with null poster fields when Poster gave nothing', () => {
    const r = computeReconciliation(submitted, null, null);
    expect(r.status).toBe('no_poster_data');
    expect(r.posterCash).toBeNull();
    expect(r.cashDiff).toBeNull();
    expect(r.cardDiff).toBeNull();
    expect(r.expenseDiff).toBeNull();
    // submitted side is still echoed.
    expect(r.submittedCash).toBe(3_000_000);
    expect(r.submittedCard).toBe(2_000_000);
    expect(r.submittedExpense).toBe(500_000);
  });

  it('is "matched" when every diff is within tolerance', () => {
    const r = computeReconciliation(
      submitted,
      { cashShiftId: '9001', cash: 3_000_500, card: 1_999_500, expense: 500_000 },
      26_249_000,
      1000,
    );
    expect(r.status).toBe('matched');
    expect(r.posterCashShiftId).toBe('9001');
    expect(r.cashDiff).toBe(-500); // 3_000_000 − 3_000_500
    expect(r.cardDiff).toBe(500); // 2_000_000 − 1_999_500
    expect(r.expenseDiff).toBe(0);
    expect(r.posterSafeBalance).toBe(26_249_000);
  });

  it('is "discrepancy" when any one diff exceeds tolerance', () => {
    const r = computeReconciliation(
      submitted,
      { cashShiftId: '9002', cash: 2_900_000, card: 2_000_000, expense: 500_000 },
      null,
      1000,
    );
    expect(r.status).toBe('discrepancy');
    expect(r.cashDiff).toBe(100_000); // cashier reported 100k MORE than Poster
    expect(r.cardDiff).toBe(0);
    expect(r.expenseDiff).toBe(0);
  });

  it('treats a diff exactly at the tolerance as matched (≤ boundary)', () => {
    const r = computeReconciliation(
      { cash: 1_001_000, card: 0, expense: 0 },
      { cashShiftId: '9003', cash: 1_000_000, card: 0, expense: 0 },
      null,
      1000,
    );
    expect(r.cashDiff).toBe(1000);
    expect(r.status).toBe('matched');
  });

  it('safe balance never changes the status (informational only)', () => {
    const r = computeReconciliation(
      { cash: 0, card: 0, expense: 0 },
      { cashShiftId: '9004', cash: 0, card: 0, expense: 0 },
      -50_000_000, // wildly negative safe — irrelevant to the match
      1000,
    );
    expect(r.status).toBe('matched');
    expect(r.posterSafeBalance).toBe(-50_000_000);
  });
});

describe('aggregatePosterShifts (pure)', () => {
  it('returns null for an empty list', () => {
    expect(aggregatePosterShifts([])).toBeNull();
  });

  it('sums cash/card/expense across shifts and converts TIYIN→so\'m', () => {
    const agg = aggregatePosterShifts([
      { cash_shift_id: 11, amount_sell_cash: 100_000, amount_sell_card: 50_000, amount_debit: 10_000 },
      { cash_shift_id: 12, amount_sell_cash: 200_000, amount_sell_card: 0, amount_debit: 5_000 },
    ]);
    // (100000+200000)/100 = 3000 ; (50000)/100 = 500 ; (15000)/100 = 150
    expect(agg).not.toBeNull();
    expect(agg?.cash).toBe(3000);
    expect(agg?.card).toBe(500);
    expect(agg?.expense).toBe(150);
    expect(agg?.cashShiftId).toBe('11'); // first row's id is the forensic ref
  });
});

// ---------------------------------------------------------------------------
// 2. Integration (real schema, stubbed Poster client)
// ---------------------------------------------------------------------------

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM cash_shift_reconciliation');
  await ctx.db.query('DELETE FROM notifications');
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('DELETE FROM nakladnoy_lines');
  await ctx.db.query('DELETE FROM nakladnoy');
  await ctx.db.query(`UPDATE locations SET manager_user_id = NULL`);
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM locations');
});

/** A store carrying a Poster spot id. */
async function makeStoreWithSpot(spotId: number, name: string): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO locations (name, type, poster_spot_id) VALUES ($1, 'store', $2) RETURNING id`,
    [name, spotId],
  );
  return Number(rows[0]!.id);
}

/** A bare cash_shift nakladnoy header for `locationId`; returns its id. */
async function makeCashShiftNakladnoy(locationId: number, createdBy: number): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO nakladnoy (source, source_ref, qty, location_id, total_amount, created_by)
     VALUES ('cash_shift', $1, 0, $2, 0, $3) RETURNING id`,
    [`loc:${locationId}`, locationId, createdBy],
  );
  return Number(rows[0]!.id);
}

/**
 * A Poster client whose `finance.getCashShifts` returns `shifts` and whose
 * `finance.getAccounts` returns `accounts`. Any other method → empty.
 */
function stubPoster(shifts: unknown[], accounts: unknown[] = []): PosterClient {
  return new PosterClient({
    token: 'acc:test',
    minIntervalMs: 0,
    fetcher: ((url: string | URL) => {
      const u = typeof url === 'string' ? new URL(url) : url;
      const m = u.pathname.split('/').pop();
      if (m === 'finance.getCashShifts') {
        return Promise.resolve(new Response(JSON.stringify({ response: shifts }), { status: 200 }));
      }
      if (m === 'finance.getAccounts') {
        return Promise.resolve(new Response(JSON.stringify({ response: accounts }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ response: [] }), { status: 200 }));
    }) as unknown as typeof fetch,
  });
}

/** A Poster client whose every finance call HTTP-405s (method unavailable). */
function stubPosterUnavailable(): PosterClient {
  return new PosterClient({
    token: 'acc:test',
    minIntervalMs: 0,
    transientRetries: 0,
    fetcher: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 30, message: 'Method Not Allowed' } }), {
          status: 405,
          statusText: 'Method Not Allowed',
        }),
      )) as unknown as typeof fetch,
  });
}

describe('reconcileCashShift (integration)', () => {
  it('persists a matched row and stamps nakladnoy.source_ref with the Poster shift id', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeStoreWithSpot(701, 'Spot A');
    const nakladnoyId = await makeCashShiftNakladnoy(store, pm.id);

    const poster = stubPoster([
      {
        cash_shift_id: '5555',
        spot_id: 701,
        amount_sell_cash: 300_000_000, // 3 000 000 so'm
        amount_sell_card: 200_000_000, // 2 000 000 so'm
        amount_debit: 50_000_000, // 500 000 so'm
      },
    ]);

    const outcome = await reconcileCashShift(poster, {
      nakladnoyId,
      locationId: store,
      submittedCash: 3_000_000,
      submittedCard: 2_000_000,
      submittedExpense: 500_000,
      shiftDate: new Date('2026-06-09T12:00:00Z'),
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.result.status).toBe('matched');
    expect(outcome?.shiftDate).toBe('2026-06-09');

    const { rows } = await ctx.db.query<{
      status: string;
      poster_cash_shift_id: string | null;
      submitted_cash: string;
      poster_cash: string | null;
      cash_diff: string | null;
    }>(
      `SELECT status, poster_cash_shift_id, submitted_cash, poster_cash, cash_diff
         FROM cash_shift_reconciliation WHERE nakladnoy_id = $1`,
      [nakladnoyId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('matched');
    expect(rows[0]!.poster_cash_shift_id).toBe('5555');
    expect(Number(rows[0]!.submitted_cash)).toBe(3_000_000);
    expect(Number(rows[0]!.poster_cash)).toBe(3_000_000);
    expect(Number(rows[0]!.cash_diff)).toBe(0);

    // nakladnoy.source_ref enriched with the Poster shift id.
    const { rows: nak } = await ctx.db.query<{ source_ref: string | null }>(
      `SELECT source_ref FROM nakladnoy WHERE id = $1`,
      [nakladnoyId],
    );
    expect(nak[0]!.source_ref).toBe('cash_shift:5555');
  });

  it('discrepancy notifies PM + the location manager', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeStoreWithSpot(702, 'Spot B');
    const manager = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
      manager.id,
      store,
    ]);
    const nakladnoyId = await makeCashShiftNakladnoy(store, manager.id);

    // Poster cash is 1 000 000 LESS than what the cashier reported → discrepancy.
    const poster = stubPoster([
      {
        cash_shift_id: '6001',
        spot_id: 702,
        amount_sell_cash: 200_000_000, // 2 000 000 so'm
        amount_sell_card: 200_000_000, // 2 000 000 so'm
        amount_debit: 0,
      },
    ]);

    const outcome = await reconcileCashShift(poster, {
      nakladnoyId,
      locationId: store,
      submittedCash: 3_000_000,
      submittedCard: 2_000_000,
      submittedExpense: 0,
    });
    expect(outcome?.result.status).toBe('discrepancy');
    expect(outcome?.result.cashDiff).toBe(1_000_000);

    const { rows } = await ctx.db.query<{ recipient_user_id: string; type: string }>(
      `SELECT recipient_user_id, type FROM notifications WHERE type = 'cash_shift_submitted'`,
    );
    const recipients = rows.map((r) => Number(r.recipient_user_id)).sort((a, b) => a - b);
    expect(recipients).toContain(pm.id);
    expect(recipients).toContain(manager.id);
  });

  it('matched submission raises NO discrepancy notification', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeStoreWithSpot(703, 'Spot C');
    const nakladnoyId = await makeCashShiftNakladnoy(store, pm.id);
    const poster = stubPoster([
      { cash_shift_id: '7001', spot_id: 703, amount_sell_cash: 100_000_000, amount_sell_card: 0, amount_debit: 0 },
    ]);
    await reconcileCashShift(poster, {
      nakladnoyId,
      locationId: store,
      submittedCash: 1_000_000,
      submittedCard: 0,
      submittedExpense: 0,
    });
    const { rows } = await ctx.db.query(`SELECT 1 FROM notifications`);
    expect(rows).toHaveLength(0);
  });

  it('NON-FATAL: a Poster outage still inserts a no_poster_data row and never throws', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeStoreWithSpot(704, 'Spot D');
    const nakladnoyId = await makeCashShiftNakladnoy(store, pm.id);

    const poster = stubPosterUnavailable();
    const outcome = await reconcileCashShift(poster, {
      nakladnoyId,
      locationId: store,
      submittedCash: 3_000_000,
      submittedCard: 2_000_000,
      submittedExpense: 500_000,
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.result.status).toBe('no_poster_data');

    const { rows } = await ctx.db.query<{ status: string; poster_cash: string | null }>(
      `SELECT status, poster_cash FROM cash_shift_reconciliation WHERE nakladnoy_id = $1`,
      [nakladnoyId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('no_poster_data');
    expect(rows[0]!.poster_cash).toBeNull();

    // source_ref stays the original 'loc:<id>' (no Poster shift to stamp).
    const { rows: nak } = await ctx.db.query<{ source_ref: string | null }>(
      `SELECT source_ref FROM nakladnoy WHERE id = $1`,
      [nakladnoyId],
    );
    expect(nak[0]!.source_ref).toBe(`loc:${store}`);
  });

  it('resolves the store safe balance from finance.getAccounts (spots[].account_cash)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const store = await makeStoreWithSpot(705, 'Spot E');
    const nakladnoyId = await makeCashShiftNakladnoy(store, pm.id);

    // account_id=3 is the cash box for spot 705 (account_cash=3) → balance 340000 tiyin = 3400 so'm.
    const accounts = [
      { account_id: '2', name: 'Сейф', type: '3', balance: '2624900000', spots: [] },
      {
        account_id: '3',
        name: 'Денежный ящик E',
        type: '3',
        balance: '340000',
        spots: [{ spot_id: 705, account_cash: 3, account_bank: 90, account_collection: 2 }],
      },
    ];
    const poster = stubPoster(
      [{ cash_shift_id: '8001', spot_id: 705, amount_sell_cash: 0, amount_sell_card: 0, amount_debit: 0 }],
      accounts,
    );
    await reconcileCashShift(poster, {
      nakladnoyId,
      locationId: store,
      submittedCash: 0,
      submittedCard: 0,
      submittedExpense: 0,
    });

    const { rows } = await ctx.db.query<{ poster_safe_balance: string | null }>(
      `SELECT poster_safe_balance FROM cash_shift_reconciliation WHERE nakladnoy_id = $1`,
      [nakladnoyId],
    );
    expect(Number(rows[0]!.poster_safe_balance)).toBe(3400);
  });
});
