/**
 * Integration tests for the sales sync (M7, ADR-0002 §3).
 *
 *   - `ingestTransaction` writes one `sales` row per check line, decrements
 *     the store stock, and is idempotent on re-run;
 *   - `processPendingWebhookEvents` drains `poster_webhook_events` rows;
 *   - line product_id is resolved via `products.poster_product_id`
 *     (the menu side — NOT `poster_ingredient_id`, ADR-0002 §1).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { createTestContext, type TestContext } from './helpers/context.js';
import { PosterClient } from '../src/integrations/poster/client.js';
import {
  ingestTransaction,
  processPendingWebhookEvents,
  emitWrongKeyedDigests,
} from '../src/integrations/poster/salesSync.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await ctx.db.query('DELETE FROM notifications');
  await ctx.db.query('DELETE FROM sales');
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  // M9 — the sales sync now persists wrong-keyed discrepancies; clear them
  // before products/locations (FK).
  await ctx.db.query('DELETE FROM sales_discrepancies');
  // users reference locations (manager_user_id / location_id) — clear first.
  await ctx.db.query('UPDATE locations SET manager_user_id = NULL');
  await ctx.db.query('DELETE FROM user_locations');
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query('DELETE FROM poster_webhook_events');
  await ctx.db.query('DELETE FROM poster_sync_log');
  await ctx.db.query('DELETE FROM audit_log');
});

async function seedStoreAndMenuProduct(): Promise<{ storeId: number; productId: number }> {
  const { rows: s } = await ctx.db.query<{ id: number }>(
    `INSERT INTO locations (name, type, poster_spot_id) VALUES ('S','store',2) RETURNING id`,
  );
  const { rows: p } = await ctx.db.query<{ id: number }>(
    `INSERT INTO products (name, type, unit, poster_product_id) VALUES ('Cake','finished','pcs',440) RETURNING id`,
  );
  return { storeId: s[0]!.id, productId: p[0]!.id };
}

describe('ingestTransaction', () => {
  it('writes a sales row, decrements stock, and is idempotent on re-run', async () => {
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,5)`, [
      storeId,
      productId,
    ]);
    const payload = {
      transaction_id: '12345',
      spot_id: '2',
      date_close: '1779521920864',
      products: [{ product_id: '440', modification_id: '0', num: '2', product_price: '19200000' }],
    };
    const r1 = await ingestTransaction(payload);
    expect(r1.linesInserted).toBe(1);
    expect(r1.movementsApplied).toBe(1);
    const { rows: sales } = await ctx.db.query<{ qty: number; price: number }>(`SELECT qty, price FROM sales`);
    expect(sales).toHaveLength(1);
    expect(sales[0]?.qty).toBeCloseTo(2, 4);
    // MONEY (2026-06-08 root-cause fix): Poster `product_price` is the LINE
    // TOTAL in TIYIN (not per-unit). 19_200_000 tiyin = 192_000 so'm for the
    // whole line of 2. `price` is now a TRUE per-unit = lineTotalSom / num =
    // 192_000 / 2 = 96_000, so `qty * price` = 192_000 = the line total — which
    // is exactly what every revenue query (`sum(qty*price)`) reconciles to.
    expect(Number(sales[0]?.price)).toBeCloseTo(96_000, 2);
    expect(Number(sales[0]?.qty) * Number(sales[0]?.price)).toBeCloseTo(192_000, 2);
    const { rows: stock } = await ctx.db.query<{ qty: number }>(`SELECT qty FROM stock`);
    expect(stock[0]?.qty).toBeCloseTo(3, 4);

    // Replay — UNIQUE indexes must protect us.
    const r2 = await ingestTransaction(payload);
    expect(r2.linesInserted).toBe(0);
    expect(r2.movementsApplied).toBe(0);
    const { rows: stock2 } = await ctx.db.query<{ qty: number }>(`SELECT qty FROM stock`);
    expect(stock2[0]?.qty).toBeCloseTo(3, 4); // unchanged
    const { rows: moves } = await ctx.db.query<{ id: number }>(`SELECT id FROM stock_movements`);
    expect(moves).toHaveLength(1);
  });

  it('resolves a check line via poster_menu_product_map (a menu id != poster_product_id)', async () => {
    // The 2026-06-08 root-cause fix: a sale check line carries a `menu.getProducts`
    // id that does NOT equal the product's `poster_product_id`. The
    // `poster_menu_product_map` alias must resolve it (here menu id 900 -> the
    // prepack whose poster_product_id is 440), so the sale lands in `sales`.
    const { rows: s } = await ctx.db.query<{ id: number }>(
      `INSERT INTO locations (name, type, poster_spot_id) VALUES ('S','store',2) RETURNING id`,
    );
    const { rows: p } = await ctx.db.query<{ id: number }>(
      `INSERT INTO products (name, type, unit, poster_product_id)
       VALUES ('Pirog','finished','pcs',440) RETURNING id`,
    );
    const storeId = s[0]!.id;
    const productId = p[0]!.id;
    await ctx.db.query(
      `INSERT INTO poster_menu_product_map (poster_menu_product_id, product_id) VALUES (900, $1)`,
      [productId],
    );
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,4)`, [
      storeId,
      productId,
    ]);
    const r = await ingestTransaction({
      transaction_id: '5500',
      spot_id: '2',
      date_close: '1779521920864',
      products: [{ product_id: '900', num: '2', product_price: '100' }], // menu id, NOT 440
    });
    expect(r.linesInserted).toBe(1);
    const { rows: sales } = await ctx.db.query<{ product_id: number; qty: number }>(
      `SELECT product_id, qty FROM sales`,
    );
    expect(sales).toHaveLength(1);
    expect(Number(sales[0]?.product_id)).toBe(productId);
    expect(Number(sales[0]?.qty)).toBeCloseTo(2, 4);
  });

  it('weighted "КГ" line: qty*price equals the Poster line total (no Nx inflation)', async () => {
    // Real "САМСА С МЯСОМ КГ" line shape (live `adia` TX 794507, 2026-06-08):
    // num is the WEIGHT (170), product_price/payed_sum is the LINE TOTAL in
    // tiyin (2_040_000 = 20_400 so'm). The OLD bug stored price=product_price/100
    // = 20_400 and qty=170 → qty*price = 3.46M (170x inflated for ONE samsa
    // line). The fix derives price = lineTotalSom / num so qty*price = 20_400.
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,500)`, [
      storeId,
      productId,
    ]);
    const r = await ingestTransaction({
      transaction_id: '794507',
      spot_id: '2',
      date_close: '1779521920864',
      products: [
        { product_id: '440', modification_id: '0', num: '170', product_price: '2040000', payed_sum: '2040000' },
      ],
    });
    expect(r.linesInserted).toBe(1);
    const { rows } = await ctx.db.query<{ qty: number; price: number }>(`SELECT qty, price FROM sales`);
    expect(Number(rows[0]?.qty)).toBeCloseTo(170, 4);
    // qty * price MUST equal the line total (20_400 so'm) — NOT 170x that.
    expect(Number(rows[0]?.qty) * Number(rows[0]?.price)).toBeCloseTo(20_400, 2);
    // sanity: per-unit price is small (20_400 / 170 = 120), never the 20_400 the
    // old bug produced.
    expect(Number(rows[0]?.price)).toBeCloseTo(120, 4);
  });

  it('parses a thousands-separator "num"/payed_sum (Poster sends "3,000.00" for bulk lines)', async () => {
    // Live `adia` TX 794490 (2026-06-08): a weighted line arrives with a comma
    // thousands separator — num="3,000.0000000", payed_sum="34500000". A bare
    // Number("3,000.00") is NaN, which the qty guard DROPPED — losing the
    // line's 345_000 so'm. Must parse comma-tolerantly and ingest the line.
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,10000)`, [
      storeId,
      productId,
    ]);
    const r = await ingestTransaction({
      transaction_id: '794490',
      spot_id: '2',
      date_close: '1779521920864',
      products: [
        { product_id: '440', num: '3,000.0000000', product_price: '34500000', payed_sum: '34500000' },
      ],
    });
    expect(r.linesInserted).toBe(1); // NOT dropped
    const { rows } = await ctx.db.query<{ qty: number; price: number }>(`SELECT qty, price FROM sales`);
    expect(Number(rows[0]?.qty)).toBeCloseTo(3000, 4);
    // line total = 34_500_000 tiyin = 345_000 so'm → qty*price = 345_000.
    expect(Number(rows[0]?.qty) * Number(rows[0]?.price)).toBeCloseTo(345_000, 2);
  });

  it('weighted (weight_flag) menu line: num is GRAMS — stored qty is kg, price per kg', async () => {
    // ROOT-CAUSE (2026-06-10, verified live against `adia`): for a menu product
    // with weight_flag=1 Poster reports `num` in GRAMS. The old sync stored the
    // grams directly: НАРЫН С ГОВЯДИНОЙ num="770.0000000", payed_sum=10_010_000
    // tiyin landed as qty=770 (units!) @ price=130 — 1000x-inflating units_sold
    // and the sale stock decrement. With the menu map's weight_flag the sync
    // must store qty=0.77 kg @ 130_000 so'm/kg (line total unchanged).
    const { rows: s } = await ctx.db.query<{ id: number }>(
      `INSERT INTO locations (name, type, poster_spot_id) VALUES ('S','store',2) RETURNING id`,
    );
    const { rows: p } = await ctx.db.query<{ id: number }>(
      `INSERT INTO products (name, type, unit, poster_product_id)
       VALUES ('Naryn','finished','kg',440) RETURNING id`,
    );
    const storeId = s[0]!.id;
    const productId = p[0]!.id;
    await ctx.db.query(
      `INSERT INTO poster_menu_product_map (poster_menu_product_id, product_id, weight_flag)
       VALUES (1047, $1, TRUE)`,
      [productId],
    );
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,5)`, [
      storeId,
      productId,
    ]);
    const r = await ingestTransaction({
      transaction_id: '795001',
      spot_id: '2',
      date_close: '1779521920864',
      products: [
        { product_id: '1047', num: '770.0000000', product_price: '10010000', payed_sum: '10010000' },
      ],
    });
    expect(r.linesInserted).toBe(1);
    const { rows } = await ctx.db.query<{ qty: string; price: string }>(
      `SELECT qty, price FROM sales`,
    );
    expect(Number(rows[0]?.qty)).toBeCloseTo(0.77, 4); // kg, NOT grams
    expect(Number(rows[0]?.price)).toBeCloseTo(130_000, 2); // so'm per kg
    // Line revenue is EXACTLY the Poster payed_sum (100_100 so'm).
    expect(Number(rows[0]?.qty) * Number(rows[0]?.price)).toBeCloseTo(100_100, 2);
    // Stock decremented by the kg quantity (0.77), never by the gram value.
    const { rows: st } = await ctx.db.query<{ qty: string }>(
      `SELECT qty FROM stock WHERE location_id=$1 AND product_id=$2`,
      [storeId, productId],
    );
    expect(Number(st[0]?.qty)).toBeCloseTo(4.23, 4);
  });

  it('weighted line with a comma-grouped grams num ("3,000.0000000" -> 3 kg)', async () => {
    // Live TX 794490: ПЕЛЬМЕНИ weight_flag=1, num="3,000.0000000" (3000 g),
    // payed_sum=34_500_000 tiyin (345_000 so'm) -> 3 kg @ 115_000 so'm/kg.
    const { rows: s } = await ctx.db.query<{ id: number }>(
      `INSERT INTO locations (name, type, poster_spot_id) VALUES ('S','store',2) RETURNING id`,
    );
    const { rows: p } = await ctx.db.query<{ id: number }>(
      `INSERT INTO products (name, type, unit, poster_product_id)
       VALUES ('Pelmeni','finished','kg',440) RETURNING id`,
    );
    await ctx.db.query(
      `INSERT INTO poster_menu_product_map (poster_menu_product_id, product_id, weight_flag)
       VALUES (358, $1, TRUE)`,
      [p[0]!.id],
    );
    const r = await ingestTransaction({
      transaction_id: '794490',
      spot_id: '2',
      date_close: '1779521920864',
      products: [
        { product_id: '358', num: '3,000.0000000', product_price: '34500000', payed_sum: '34500000' },
      ],
    });
    expect(r.linesInserted).toBe(1);
    const { rows } = await ctx.db.query<{ qty: string; price: string }>(
      `SELECT qty, price FROM sales`,
    );
    expect(Number(rows[0]?.qty)).toBeCloseTo(3, 4);
    expect(Number(rows[0]?.price)).toBeCloseTo(115_000, 2);
  });

  it('prefers payed_sum (net) over product_price (gross) as the line total', async () => {
    // A discounted line: gross product_price = 1000 tiyin but payed_sum = 800
    // tiyin (after a discount). The authoritative money is the NET payed_sum,
    // which is what reconciles to the Poster revenue-breakdown.
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,10)`, [
      storeId,
      productId,
    ]);
    const r = await ingestTransaction({
      transaction_id: '900900',
      spot_id: '2',
      date_close: '1779521920864',
      products: [{ product_id: '440', num: '2', product_price: '1000', payed_sum: '800' }],
    });
    expect(r.linesInserted).toBe(1);
    const { rows } = await ctx.db.query<{ qty: number; price: number }>(`SELECT qty, price FROM sales`);
    // line total = payed_sum 800 tiyin = 8 so'm → qty*price = 8 (NOT the gross 10).
    expect(Number(rows[0]?.qty) * Number(rows[0]?.price)).toBeCloseTo(8, 2);
  });

  it('falls back to product_price when payed_sum is absent', async () => {
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,10)`, [
      storeId,
      productId,
    ]);
    const r = await ingestTransaction({
      transaction_id: '900901',
      spot_id: '2',
      date_close: '1779521920864',
      products: [{ product_id: '440', num: '4', product_price: '2000' }], // no payed_sum
    });
    expect(r.linesInserted).toBe(1);
    const { rows } = await ctx.db.query<{ qty: number; price: number }>(`SELECT qty, price FROM sales`);
    // 2000 tiyin = 20 so'm line total → qty*price = 20.
    expect(Number(rows[0]?.qty) * Number(rows[0]?.price)).toBeCloseTo(20, 2);
  });

  it('skips a line whose product is not seeded (menu-only items)', async () => {
    // Seed only the store; no product mapping.
    await ctx.db.query(
      `INSERT INTO locations (name, type, poster_spot_id) VALUES ('S','store',2)`,
    );
    const r = await ingestTransaction({
      transaction_id: '7',
      spot_id: '2',
      products: [{ product_id: '404', modification_id: '0', num: '1', product_price: '0' }],
    });
    expect(r.linesInserted).toBe(0);
    expect(r.storeFound).toBe(true);
  });

  it('reports storeFound=false when the spot has no ADIA location', async () => {
    const r = await ingestTransaction({
      transaction_id: '8',
      spot_id: '999',
      products: [{ product_id: '440', num: '1', product_price: '0' }],
    });
    expect(r.storeFound).toBe(false);
    expect(r.linesInserted).toBe(0);
  });

  it('clamps the decrement when ADIA has less stock than the sale qty (never goes negative)', async () => {
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,1)`, [
      storeId,
      productId,
    ]);
    const r = await ingestTransaction({
      transaction_id: '9',
      spot_id: '2',
      date_close: '1779521920864', // a real close date — un-closed checks are skipped
      products: [{ product_id: '440', num: '3', product_price: '100' }], // sells more than stock
    });
    expect(r.linesInserted).toBe(1);
    const { rows: stock } = await ctx.db.query<{ qty: number }>(`SELECT qty FROM stock`);
    expect(stock[0]?.qty).toBeCloseTo(0, 4); // clamped
  });

  it('skips an un-closed check (placeholder/epoch date_close) — no fake 2000-01-01 sale', async () => {
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,5)`, [
      storeId,
      productId,
    ]);
    // Poster returns "2000-01-01 00:00:00" / "0" for checks that were never
    // actually closed. These must NOT become sales rows (root-cause guard).
    for (const badDate of ['2000-01-01 00:00:00', '0', '']) {
      const r = await ingestTransaction({
        transaction_id: `placeholder-${badDate || 'empty'}`,
        spot_id: '2',
        date_close: badDate,
        products: [{ product_id: '440', num: '2', product_price: '19200000' }],
      });
      expect(r.linesInserted).toBe(0);
      expect(r.movementsApplied).toBe(0);
    }
    const { rows: sales } = await ctx.db.query<{ id: number }>(`SELECT id FROM sales`);
    expect(sales).toHaveLength(0); // nothing inserted
    const { rows: stock } = await ctx.db.query<{ qty: number }>(`SELECT qty FROM stock`);
    expect(stock[0]?.qty).toBeCloseTo(5, 4); // stock untouched
  });
});

describe('processPendingWebhookEvents', () => {
  it('drains queued events, fetches the full check, and marks processed', async () => {
    const { storeId, productId } = await seedStoreAndMenuProduct();
    await ctx.db.query(`INSERT INTO stock (location_id, product_id, qty) VALUES ($1,$2,5)`, [
      storeId,
      productId,
    ]);
    await ctx.db.query(
      `INSERT INTO poster_webhook_events (event_type, poster_object_id, payload)
       VALUES ('transaction.close', $1, $2)`,
      [101, JSON.stringify({ raw: true })],
    );

    const client = new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        if (u.pathname.endsWith('dash.getTransaction')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                response: {
                  transaction_id: '101',
                  spot_id: '2',
                  date_close: '1779521920864',
                  products: [{ product_id: '440', num: '1', product_price: '500' }],
                },
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'NA' } }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    });

    const summary = await processPendingWebhookEvents(client, 50);
    expect(summary.eventsScanned).toBe(1);
    expect(summary.eventsApplied).toBe(1);
    expect(summary.linesInserted).toBe(1);
    const { rows: events } = await ctx.db.query<{ processed: boolean }>(
      `SELECT processed FROM poster_webhook_events`,
    );
    expect(events[0]?.processed).toBe(true);
  });
});

describe('emitWrongKeyedDigests (consolidated wrong-keyed alert)', () => {
  it('sends ONE digest per store (not N per product) with resolved names', async () => {
    // One store with a manager, plus a global PM → 2 recipients.
    const { rows: loc } = await ctx.db.query<{ id: number }>(
      `INSERT INTO locations (name, type, poster_spot_id) VALUES ('Chilonzor do''koni','store',2) RETURNING id`,
    );
    const storeId = loc[0]!.id;
    const pwd = await bcrypt.hash('x', 6);
    const { rows: mgr } = await ctx.db.query<{ id: number }>(
      `INSERT INTO users (name, username, password_hash, role, location_id)
       VALUES ('Mgr','mgr_wk',$1,'store_manager',$2) RETURNING id`,
      [pwd, storeId],
    );
    const managerId = mgr[0]!.id;
    await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [managerId, storeId]);
    await ctx.db.query(
      `INSERT INTO users (name, username, password_hash, role) VALUES ('PM','pm_wk',$1,'pm')`,
      [pwd],
    );

    // Seed several over-sold products for THIS store (the flood scenario).
    const products = ['Napoleon', 'Medovik', 'Tiramisu', 'Cheesecake', 'Eclair', 'Macaron', 'Brownie'];
    const details: { storeId: number; productId: number; transactionId: number; sold: number; had: number; shortfall: number }[] = [];
    for (let i = 0; i < products.length; i += 1) {
      const { rows: p } = await ctx.db.query<{ id: number }>(
        `INSERT INTO products (name, type, unit, poster_product_id)
         VALUES ($1,'finished','pcs',$2) RETURNING id`,
        [products[i], 1000 + i],
      );
      details.push({
        storeId,
        productId: p[0]!.id,
        transactionId: 5000 + i,
        sold: 10 + i,
        had: 0,
        shortfall: products.length - i, // descending shortfalls
      });
    }

    await emitWrongKeyedDigests(details);

    const { rows: notes } = await ctx.db.query<{
      recipient_user_id: number;
      title: string;
      body: string;
      type: string;
    }>(`SELECT recipient_user_id, title, body, type FROM notifications ORDER BY id`);

    // EXACTLY one digest per recipient (PM + store manager) — NOT 7 per product.
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.type).toBe('wrong_keyed_check');
      // Store NAME, not "do'kon 7".
      expect(n.title).toContain('Chilonzor do\'koni');
      expect(n.title).not.toMatch(/do'kon \d/);
      // Top-5 product NAMES listed (sorted by shortfall desc), rest collapsed.
      expect(n.body).toContain('Napoleon');
      expect(n.body).toContain('• ');
      expect(n.body).toContain('…va yana 2 ta mahsulot.');
      // No raw "mahsulot <id>" leakage.
      expect(n.body).not.toMatch(/mahsulot #?\d/);
      // Total + check count summary present.
      expect(n.body).toContain('7 ta chekda');
    }

    // M9 — the digest also PERSISTS one discrepancy row per over-sold line
    // (kind='wrong_keyed', open) so the log/report API can surface them.
    const { rows: disc } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM sales_discrepancies
        WHERE kind = 'wrong_keyed' AND status = 'open' AND location_id = $1`,
      [storeId],
    );
    expect(Number(disc[0]!.n)).toBe(7);
  });

  it('dedupes at the STORE-DIGEST level — a second run in-window does not re-flood', async () => {
    const { rows: loc } = await ctx.db.query<{ id: number }>(
      `INSERT INTO locations (name, type, poster_spot_id) VALUES ('S2','store',3) RETURNING id`,
    );
    const storeId = loc[0]!.id;
    const pwd = await bcrypt.hash('x', 6);
    await ctx.db.query(
      `INSERT INTO users (name, username, password_hash, role) VALUES ('PM2','pm_wk2',$1,'pm')`,
      [pwd],
    );
    const { rows: p } = await ctx.db.query<{ id: number }>(
      `INSERT INTO products (name, type, unit, poster_product_id)
       VALUES ('Napoleon','finished','pcs',2000) RETURNING id`,
    );
    const detail = [{ storeId, productId: p[0]!.id, transactionId: 1, sold: 5, had: 0, shortfall: 5 }];

    await emitWrongKeyedDigests(detail);
    await emitWrongKeyedDigests(detail); // immediate re-run

    const { rows: notes } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM notifications`,
    );
    expect(Number(notes[0]!.n)).toBe(1); // deduped — only the PM's first digest
  });
});
