/**
 * TZ §6 — migration 0060 (Qaymoq cream workshop seed) correctness + idempotency.
 *
 * The runner already applied 0060 against this suite's schema at setup, but it
 * was a no-op there (a bare test schema has no production root, so the DO block
 * RETURNs early — exactly like migrations 0016/0019). This test hand-rolls the
 * minimal pre-state (a production root + the consuming sexes + a central wh),
 * applies the SQL, asserts the structure, then re-applies it to prove a re-run
 * is a no-op.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext, type TestContext } from './helpers/context.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = resolve(HERE, '../migrations/0060_qaymoq_cream_workshop_seed.sql');

let ctx: TestContext;
let sql: string;

beforeAll(async () => {
  ctx = await createTestContext();
  sql = await readFile(SQL_PATH, 'utf8');
});
afterAll(async () => {
  await ctx.dispose();
});

/** A clean chain with the production root + the two consuming sexes + central. */
async function seedChain(): Promise<void> {
  await ctx.db.query('DELETE FROM location_flows');
  await ctx.db.query("DELETE FROM products WHERE name IN ('Qaymoq krem')");
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query(
    `INSERT INTO locations (name, type) VALUES
       ('Ishlab chiqarish sexi', 'production'),
       ('Tort sexi',             'production'),
       ('Perojniy sexi',         'production'),
       ('Markaziy Sklad',        'central_warehouse')`,
  );
}

type LocRow = {
  id: string;
  name: string;
  type: string;
  parent_id: string | null;
  is_active: boolean;
  poster_workshop_id: number | null;
};

async function loc(name: string): Promise<LocRow | undefined> {
  const { rows } = await ctx.db.query<LocRow>(
    'SELECT id, name, type, parent_id, is_active, poster_workshop_id FROM locations WHERE name = $1',
    [name],
  );
  return rows[0];
}

async function flowExists(fromName: string, toName: string, flowType: string): Promise<boolean> {
  const { rows } = await ctx.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM location_flows f
       JOIN locations a ON a.id = f.from_location_id
       JOIN locations b ON b.id = f.to_location_id
      WHERE a.name = $1 AND b.name = $2 AND f.flow_type = $3`,
    [fromName, toName, flowType],
  );
  return Number(rows[0]?.n) > 0;
}

describe('migration 0060 — Qaymoq cream workshop', () => {
  beforeEach(async () => {
    await seedChain();
  });

  it('creates Qaymoq sexi (production, app-owned) under the production root', async () => {
    await ctx.db.query(sql);
    const sexi = await loc('Qaymoq sexi');
    const root = await loc('Ishlab chiqarish sexi');
    expect(sexi).toBeDefined();
    expect(sexi?.type).toBe('production');
    expect(sexi?.is_active).toBe(true);
    expect(sexi?.poster_workshop_id).toBeNull(); // app-owned, not Poster-synced
    expect(sexi?.parent_id).toBe(root?.id);
  });

  it('creates Qaymoq skladi (sex_storage) parented to Qaymoq sexi', async () => {
    await ctx.db.query(sql);
    const skladi = await loc('Qaymoq skladi');
    const sexi = await loc('Qaymoq sexi');
    expect(skladi).toBeDefined();
    expect(skladi?.type).toBe('sex_storage');
    expect(skladi?.parent_id).toBe(sexi?.id);
  });

  it('creates the cream semi product and assigns it to Qaymoq sexi', async () => {
    await ctx.db.query(sql);
    const sexi = await loc('Qaymoq sexi');
    const { rows } = await ctx.db.query<{
      type: string;
      unit: string;
      workshop_location_id: string | null;
    }>("SELECT type, unit, workshop_location_id FROM products WHERE name = 'Qaymoq krem'");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('semi');
    expect(rows[0]?.unit).toBe('kg');
    expect(rows[0]?.workshop_location_id).toBe(sexi?.id);
  });

  it('wires the flows: production_output to its sklad + bom_input to consuming sexes', async () => {
    await ctx.db.query(sql);
    expect(await flowExists('Qaymoq sexi', 'Qaymoq skladi', 'production_output')).toBe(true);
    expect(await flowExists('Qaymoq skladi', 'Tort sexi', 'bom_input')).toBe(true);
    expect(await flowExists('Qaymoq skladi', 'Perojniy sexi', 'bom_input')).toBe(true);
    expect(await flowExists('Qaymoq skladi', 'Markaziy Sklad', 'forward')).toBe(true);
  });

  it('adopts an EXISTING cream semi instead of creating a duplicate', async () => {
    // A Poster-synced cream prepack already in the catalogue.
    const existing = await ctx.db.query<{ id: string }>(
      `INSERT INTO products (name, type, unit, sku)
       VALUES ('Сливки взбитые', 'semi', 'kg', 'EXISTING-CREAM') RETURNING id`,
    );
    const existingId = existing.rows[0]!.id;

    await ctx.db.query(sql);

    const sexi = await loc('Qaymoq sexi');
    // The existing cream was adopted (workshop set), and no "Qaymoq krem" was created.
    const adopted = await ctx.db.query<{ workshop_location_id: string | null }>(
      'SELECT workshop_location_id FROM products WHERE id = $1',
      [existingId],
    );
    expect(adopted.rows[0]?.workshop_location_id).toBe(sexi?.id);
    const created = await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM products WHERE name = 'Qaymoq krem'",
    );
    expect(Number(created.rows[0]?.n)).toBe(0);

    // cleanup so the next test's seedChain product-delete is unaffected.
    await ctx.db.query('DELETE FROM products WHERE id = $1', [existingId]);
  });

  it('is idempotent — re-running adds no duplicate location, product, or flow', async () => {
    await ctx.db.query(sql);
    await ctx.db.query(sql);
    await ctx.db.query(sql);

    const sexiCount = await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM locations WHERE name = 'Qaymoq sexi'",
    );
    const skladiCount = await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM locations WHERE name = 'Qaymoq skladi'",
    );
    const creamCount = await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM products WHERE name = 'Qaymoq krem'",
    );
    const flowCount = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM location_flows f
         JOIN locations a ON a.id = f.from_location_id
        WHERE a.name IN ('Qaymoq sexi', 'Qaymoq skladi')`,
    );
    expect(Number(sexiCount.rows[0]?.n)).toBe(1);
    expect(Number(skladiCount.rows[0]?.n)).toBe(1);
    expect(Number(creamCount.rows[0]?.n)).toBe(1);
    // 1 production_output + 2 bom_input + 1 forward = 4 edges, stable across re-runs.
    expect(Number(flowCount.rows[0]?.n)).toBe(4);
  });

  it('skips cleanly when there is no production root', async () => {
    await ctx.db.query('DELETE FROM location_flows');
    await ctx.db.query("DELETE FROM products WHERE name = 'Qaymoq krem'");
    await ctx.db.query('DELETE FROM locations');
    // Only a central warehouse — NO production location at all.
    await ctx.db.query(
      "INSERT INTO locations (name, type) VALUES ('Markaziy Sklad', 'central_warehouse')",
    );
    await ctx.db.query(sql); // must not throw
    const sexi = await loc('Qaymoq sexi');
    expect(sexi).toBeUndefined();
    const cream = await ctx.db.query<{ n: string }>(
      "SELECT count(*) AS n FROM products WHERE name = 'Qaymoq krem'",
    );
    expect(Number(cream.rows[0]?.n)).toBe(0);
  });
});
