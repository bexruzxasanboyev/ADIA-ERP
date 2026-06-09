/**
 * TZ M9 — `services/salesDiscrepancy.ts` upsert + dedupe behaviour.
 *
 *   - recordWrongKeyedDiscrepancy: inserts one row; a replay of the SAME
 *     (transaction, product) is a no-op (ON CONFLICT DO NOTHING) — a check line
 *     is a one-time fact.
 *   - recordNegativeStockDiscrepancy: inserts one row per (location, product,
 *     day); a re-run keeps the WORST shortfall and refreshes detected_at, but
 *     never clobbers a human's status/note/resolved_*.
 *   - both are NON-FATAL — a bad client never throws out of the recorder.
 *
 * Runs against the per-suite isolated schema (every migration, incl. 0059).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { withTransaction } from '../src/db/index.js';
import {
  recordNegativeStockDiscrepancy,
  recordWrongKeyedDiscrepancy,
} from '../src/services/salesDiscrepancy.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM sales_discrepancies');
  await ctx.db.query('UPDATE locations SET manager_user_id = NULL');
  await ctx.db.query('DELETE FROM user_locations');
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM locations');
});

async function seedStoreAndProduct(): Promise<{ storeId: number; productId: number }> {
  const { rows: s } = await ctx.db.query<{ id: number }>(
    `INSERT INTO locations (name, type) VALUES ('Store','store') RETURNING id`,
  );
  const { rows: p } = await ctx.db.query<{ id: number }>(
    `INSERT INTO products (name, type, unit) VALUES ('Cake','finished','pcs') RETURNING id`,
  );
  return { storeId: Number(s[0]!.id), productId: Number(p[0]!.id) };
}

describe('recordWrongKeyedDiscrepancy', () => {
  it('inserts an open row with sold/had/shortfall and the poster tx id', async () => {
    const { storeId, productId } = await seedStoreAndProduct();
    await withTransaction((tx) =>
      recordWrongKeyedDiscrepancy(tx, {
        storeId,
        productId,
        transactionId: 5001,
        sold: 10,
        had: 3,
        shortfall: 7,
      }),
    );
    const { rows } = await ctx.db.query<{
      kind: string;
      location_id: string;
      product_id: string;
      poster_transaction_id: string;
      sold_qty: string;
      had_qty: string;
      shortfall: string;
      status: string;
      dedupe_key: string;
    }>(`SELECT * FROM sales_discrepancies`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('wrong_keyed');
    expect(Number(rows[0]!.location_id)).toBe(storeId);
    expect(Number(rows[0]!.product_id)).toBe(productId);
    expect(rows[0]!.poster_transaction_id).toBe('5001');
    expect(Number(rows[0]!.sold_qty)).toBeCloseTo(10, 3);
    expect(Number(rows[0]!.had_qty)).toBeCloseTo(3, 3);
    expect(Number(rows[0]!.shortfall)).toBeCloseTo(7, 3);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.dedupe_key).toBe(`wrong_keyed:5001:${productId}`);
  });

  it('is idempotent — replaying the same (tx, product) line is a no-op', async () => {
    const { storeId, productId } = await seedStoreAndProduct();
    const line = { storeId, productId, transactionId: 42, sold: 5, had: 0, shortfall: 5 };
    await withTransaction((tx) => recordWrongKeyedDiscrepancy(tx, line));
    await withTransaction((tx) => recordWrongKeyedDiscrepancy(tx, line)); // replay
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sales_discrepancies`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('does NOT overwrite a triaged row on a replay (DO NOTHING)', async () => {
    const { storeId, productId } = await seedStoreAndProduct();
    const line = { storeId, productId, transactionId: 7, sold: 9, had: 1, shortfall: 8 };
    await withTransaction((tx) => recordWrongKeyedDiscrepancy(tx, line));
    // A human acknowledges it.
    await ctx.db.query(
      `UPDATE sales_discrepancies SET status = 'acknowledged', note = 'looking' WHERE dedupe_key = $1`,
      [`wrong_keyed:7:${productId}`],
    );
    await withTransaction((tx) => recordWrongKeyedDiscrepancy(tx, line)); // replay
    const { rows } = await ctx.db.query<{ status: string; note: string }>(
      `SELECT status, note FROM sales_discrepancies`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('acknowledged'); // untouched
    expect(rows[0]!.note).toBe('looking');
  });
});

describe('recordNegativeStockDiscrepancy', () => {
  it('inserts an open row; shortfall is the magnitude (no transaction id)', async () => {
    const { storeId, productId } = await seedStoreAndProduct();
    const date = new Date('2026-06-09T08:00:00.000Z');
    await withTransaction((tx) =>
      recordNegativeStockDiscrepancy(tx, { locationId: storeId, productId, shortfall: 4, date }),
    );
    const { rows } = await ctx.db.query<{
      kind: string;
      poster_transaction_id: string | null;
      sold_qty: string | null;
      had_qty: string | null;
      shortfall: string;
      status: string;
      dedupe_key: string;
    }>(`SELECT * FROM sales_discrepancies`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('negative_stock');
    expect(rows[0]!.poster_transaction_id).toBeNull();
    expect(rows[0]!.sold_qty).toBeNull();
    expect(rows[0]!.had_qty).toBeNull();
    expect(Number(rows[0]!.shortfall)).toBeCloseTo(4, 3);
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.dedupe_key).toBe(`negative_stock:${storeId}:${productId}:2026-06-09`);
  });

  it('keeps the WORST shortfall on a same-day conflict (GREATEST)', async () => {
    const { storeId, productId } = await seedStoreAndProduct();
    const date = new Date('2026-06-09T08:00:00.000Z');
    await withTransaction((tx) =>
      recordNegativeStockDiscrepancy(tx, { locationId: storeId, productId, shortfall: 3, date }),
    );
    // A later scan the same day finds a worse (bigger) shortfall.
    await withTransaction((tx) =>
      recordNegativeStockDiscrepancy(tx, { locationId: storeId, productId, shortfall: 9, date }),
    );
    // An even later scan finds a smaller one — the worst (9) must survive.
    await withTransaction((tx) =>
      recordNegativeStockDiscrepancy(tx, { locationId: storeId, productId, shortfall: 5, date }),
    );
    const { rows } = await ctx.db.query<{ n: string; shortfall: string }>(
      `SELECT count(*) AS n, max(shortfall) AS shortfall FROM sales_discrepancies`,
    );
    expect(Number(rows[0]!.n)).toBe(1); // one row per (location, product, day)
    expect(Number(rows[0]!.shortfall)).toBeCloseTo(9, 3);
  });

  it('does NOT touch status/note/resolved_* on a same-day conflict', async () => {
    const { storeId, productId } = await seedStoreAndProduct();
    const date = new Date('2026-06-09T08:00:00.000Z');
    await withTransaction((tx) =>
      recordNegativeStockDiscrepancy(tx, { locationId: storeId, productId, shortfall: 3, date }),
    );
    await ctx.db.query(
      `UPDATE sales_discrepancies SET status='resolved', note='fixed', resolved_at=now()`,
    );
    await withTransaction((tx) =>
      recordNegativeStockDiscrepancy(tx, { locationId: storeId, productId, shortfall: 9, date }),
    );
    const { rows } = await ctx.db.query<{ status: string; note: string; shortfall: string }>(
      `SELECT status, note, shortfall FROM sales_discrepancies`,
    );
    expect(rows[0]!.status).toBe('resolved'); // triage preserved
    expect(rows[0]!.note).toBe('fixed');
    expect(Number(rows[0]!.shortfall)).toBeCloseTo(9, 3); // shortfall still updated
  });

  it('creates a SEPARATE row on a different day for the same (location, product)', async () => {
    const { storeId, productId } = await seedStoreAndProduct();
    await withTransaction((tx) =>
      recordNegativeStockDiscrepancy(tx, {
        locationId: storeId,
        productId,
        shortfall: 2,
        date: new Date('2026-06-09T08:00:00.000Z'),
      }),
    );
    await withTransaction((tx) =>
      recordNegativeStockDiscrepancy(tx, {
        locationId: storeId,
        productId,
        shortfall: 2,
        date: new Date('2026-06-10T08:00:00.000Z'),
      }),
    );
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sales_discrepancies`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

describe('non-fatal contract', () => {
  it('recordWrongKeyedDiscrepancy never throws when the insert fails', async () => {
    // A FK violation (product 999999 does not exist) would normally throw; the
    // recorder must swallow it (the sync must keep going). Run on the pool —
    // a real failing INSERT, caught inside the recorder.
    const { storeId } = await seedStoreAndProduct();
    const { query } = await import('../src/db/index.js');
    await expect(
      recordWrongKeyedDiscrepancy(
        { query },
        { storeId, productId: 999999, transactionId: 1, sold: 1, had: 0, shortfall: 1 },
      ),
    ).resolves.toBeUndefined();
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sales_discrepancies`,
    );
    expect(Number(rows[0]!.n)).toBe(0); // nothing inserted, but no throw
  });
});
