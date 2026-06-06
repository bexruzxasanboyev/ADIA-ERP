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
    // Poster `product_price` is in TIYIN — it must be stored as so'm (÷100)
    // so `qty * price` agrees with the Poster payments report. 19_200_000
    // tiyin = 192_000 so'm.
    expect(Number(sales[0]?.price)).toBeCloseTo(192_000, 2);
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
