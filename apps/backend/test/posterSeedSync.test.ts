/**
 * Integration tests for the Poster seed/bootstrap sync (M7).
 *
 * The Poster client is mocked through `fetcher` — every test feeds a synthetic
 * Poster response and asserts that ADIA `locations`, `products`, `recipes`,
 * and `poster_sync_log` end up in the expected state.
 *
 * Idempotency is verified by running the sync twice in the same test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { PosterClient } from '../src/integrations/poster/client.js';
import {
  syncCategories,
  syncIngredientCategories,
  syncSpots,
  syncStorages,
  syncIngredients,
  syncPrepacks,
  syncMenuProducts,
  syncWorkshops,
} from '../src/integrations/poster/seedSync.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  // Wipe everything M7 writes between tests.
  await ctx.db.query('DELETE FROM stock_movements');
  await ctx.db.query('DELETE FROM stock');
  await ctx.db.query('DELETE FROM recipes');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM categories');
  await ctx.db.query('DELETE FROM locations');
  await ctx.db.query('DELETE FROM poster_sync_log');
});

/**
 * Build a `PosterClient` whose fetcher returns a static map of method ->
 * response payload. Unknown methods produce a Poster error envelope so a
 * missing setup surfaces clearly.
 */
function clientForResponses(map: Record<string, unknown>): PosterClient {
  return new PosterClient({
    token: 'acc:test-token',
    minIntervalMs: 0,
    fetcher: ((url: string | URL) => {
      const u = typeof url === 'string' ? new URL(url) : url;
      const method = u.pathname.split('/').pop() ?? '';
      if (method in map) {
        return Promise.resolve(
          new Response(JSON.stringify({ response: map[method] }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 30, message: 'Method Not Allowed' } }), {
          status: 200,
        }),
      );
    }) as unknown as typeof fetch,
  });
}

describe('Poster seedSync — spots', () => {
  it('upserts spots into locations(type=store) and is idempotent', async () => {
    const client = clientForResponses({
      'access.getSpots': [
        { spot_id: '1', name: 'Кукча', spot_name: 'Кукча' },
        { spot_id: '2', name: 'Рабочий', spot_name: 'Рабочий' },
      ],
    });

    const r1 = await syncSpots(client);
    expect(r1.status).toBe('ok');
    expect(r1.recordsApplied).toBe(2);

    const { rows: first } = await ctx.db.query<{ id: number; name: string; type: string; poster_spot_id: number }>(
      `SELECT id, name, type, poster_spot_id FROM locations ORDER BY poster_spot_id`,
    );
    expect(first).toHaveLength(2);
    expect(first[0]?.type).toBe('store');
    expect(first[0]?.poster_spot_id).toBe(1);

    // Second run — same Poster payload, no new rows, name update wins.
    const r2 = await syncSpots(client);
    expect(r2.status).toBe('ok');
    const { rows: second } = await ctx.db.query<{ id: number }>(`SELECT id FROM locations`);
    expect(second).toHaveLength(2);

    // sync log row exists for both runs.
    const { rows: logs } = await ctx.db.query<{ status: string; records_applied: number; entity: string }>(
      `SELECT status, records_applied, entity FROM poster_sync_log WHERE entity='spots' ORDER BY id`,
    );
    expect(logs).toHaveLength(2);
    expect(logs[0]?.status).toBe('ok');
  });

  it('records failed status when the Poster call errors', async () => {
    const client = clientForResponses({}); // empty -> error 30
    const r = await syncSpots(client);
    expect(r.status).toBe('failed');
    expect(r.errorDetail).toContain('Method Not Allowed');
    const { rows } = await ctx.db.query<{ status: string; error_detail: string }>(
      `SELECT status, error_detail FROM poster_sync_log WHERE entity='spots'`,
    );
    expect(rows[0]?.status).toBe('failed');
  });
});

describe('Poster seedSync — storages (ADR-0017 classification)', () => {
  it('classifies storages at insert time and keeps a PM reclassification on re-run', async () => {
    const client = clientForResponses({
      'storage.getStorages': [
        { storage_id: '2', storage_name: 'Основной склад' }, // raw_warehouse
        { storage_id: '8', storage_name: 'Склад Центральный' }, // central_warehouse
        { storage_id: '20', storage_name: 'Производственный Цех' }, // production
        { storage_id: '19', storage_name: 'Склад Тортов' }, // sex_storage
        { storage_id: '777', storage_name: 'Склад Новый' }, // unknown -> default sex_storage
      ],
    });
    await syncStorages(client);

    const { rows: first } = await ctx.db.query<{ type: string; poster_storage_id: number }>(
      `SELECT type, poster_storage_id FROM locations ORDER BY poster_storage_id`,
    );
    expect(first.find((r) => r.poster_storage_id === 2)?.type).toBe('raw_warehouse');
    expect(first.find((r) => r.poster_storage_id === 8)?.type).toBe('central_warehouse');
    expect(first.find((r) => r.poster_storage_id === 20)?.type).toBe('production');
    expect(first.find((r) => r.poster_storage_id === 19)?.type).toBe('sex_storage');
    // Unknown id falls back to the safe default.
    expect(first.find((r) => r.poster_storage_id === 777)?.type).toBe('sex_storage');

    // PM reclassifies storage 19 as a `central_warehouse` by mistake-fix.
    await ctx.db.query(`UPDATE locations SET type='raw_warehouse' WHERE poster_storage_id=19`);

    // Second run must NOT overwrite the PM's classification — only name updates.
    await syncStorages(client);
    const { rows: second } = await ctx.db.query<{ type: string; poster_storage_id: number }>(
      `SELECT type, poster_storage_id FROM locations ORDER BY poster_storage_id`,
    );
    expect(second.find((r) => r.poster_storage_id === 19)?.type).toBe('raw_warehouse');
    // No duplicate rows on re-run.
    expect(second.filter((r) => r.poster_storage_id === 19)).toHaveLength(1);
  });

  it('merges store-backing storages (3/4/5) onto their POS spot rows (P2)', async () => {
    // Spots first (runSeedSync order), then storages.
    const client = clientForResponses({
      'access.getSpots': [
        { spot_id: '1', spot_name: 'Кукча' },
        { spot_id: '2', spot_name: 'Рабочий' },
        { spot_id: '3', spot_name: 'Чигатай' },
      ],
      'storage.getStorages': [
        { storage_id: '3', storage_name: 'Склад Кукча' },
        { storage_id: '4', storage_name: 'Склад Рабочий' },
        { storage_id: '5', storage_name: 'Склад Чигатай' },
      ],
    });
    await syncSpots(client);
    await syncStorages(client);

    const { rows } = await ctx.db.query<{
      type: string;
      poster_spot_id: number | null;
      poster_storage_id: number | null;
    }>(`SELECT type, poster_spot_id, poster_storage_id FROM locations ORDER BY poster_spot_id`);

    // No standalone storage rows were created — exactly the 3 spot rows exist.
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.type === 'store')).toBe(true);
    // Each spot now carries its backing storage id (sales + stock co-located).
    expect(rows.find((r) => r.poster_spot_id === 1)?.poster_storage_id).toBe(3);
    expect(rows.find((r) => r.poster_spot_id === 2)?.poster_storage_id).toBe(4);
    expect(rows.find((r) => r.poster_spot_id === 3)?.poster_storage_id).toBe(5);
  });

  it('store-backing merge is idempotent and survives a spot re-sync', async () => {
    const client = clientForResponses({
      'access.getSpots': [{ spot_id: '1', spot_name: 'Кукча' }],
      'storage.getStorages': [{ storage_id: '3', storage_name: 'Склад Кукча' }],
    });
    await syncSpots(client);
    await syncStorages(client);
    // Re-run both in either order — still one row, storage id intact.
    await syncStorages(client);
    await syncSpots(client);

    const { rows } = await ctx.db.query<{
      poster_spot_id: number | null;
      poster_storage_id: number | null;
    }>(`SELECT poster_spot_id, poster_storage_id FROM locations`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.poster_spot_id).toBe(1);
    expect(rows[0]?.poster_storage_id).toBe(3);
  });
});

describe('Poster seedSync — ingredients_type filter (C5)', () => {
  // Sprint 3 audit: `menu.getIngredients` returns BOTH raw ingredients
  // (ingredients_type=1) AND semi-finished prepacks (ingredients_type=2).
  // syncIngredients must skip type=2 — otherwise it would create a
  // `products(type='raw')` row that later collides with `syncPrepacks` on
  // the partial UNIQUE on `poster_ingredient_id` and crash the seed.
  it('imports only ingredients_type=1; type=2 prepacks land via syncPrepacks without collision', async () => {
    const client = clientForResponses({
      // Mixed list — one raw (type=1), one prepack (type=2). Real Poster
      // payload is what surfaced this bug.
      'menu.getIngredients': [
        { ingredient_id: 100, ingredient_name: 'Flour', ingredient_unit: 'kg', ingredients_type: 1 },
        { ingredient_id: 600, ingredient_name: 'Dough base', ingredient_unit: 'kg', ingredients_type: 2 },
      ],
      // The matching prepack — `ingredient_id=600` collides with the row
      // skipped above so syncPrepacks can claim it safely.
      'menu.getPrepacks': [
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Dough base',
          out: 1,
          ingredients: [
            {
              structure_id: 's1',
              ingredient_id: '100',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 0.5,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
          ],
        },
      ],
    });

    const rIng = await syncIngredients(client);
    expect(rIng.status).toBe('ok');
    // Only Flour was imported as raw; the type=2 row was skipped.
    expect(rIng.recordsApplied).toBe(1);
    const { rows: rawProducts } = await ctx.db.query<{
      id: number;
      type: string;
      poster_ingredient_id: number;
    }>(`SELECT id, type, poster_ingredient_id FROM products`);
    expect(rawProducts).toHaveLength(1);
    expect(rawProducts[0]?.type).toBe('raw');
    expect(rawProducts[0]?.poster_ingredient_id).toBe(100);

    // The prepack now lands as `type='semi'`. No UNIQUE-violation crash.
    const rPre = await syncPrepacks(client);
    expect(rPre.status).toBe('ok');
    expect(rPre.recordsApplied).toBe(1);

    const { rows: allProducts } = await ctx.db.query<{
      type: string;
      poster_product_id: number | null;
      poster_ingredient_id: number | null;
    }>(`SELECT type, poster_product_id, poster_ingredient_id FROM products ORDER BY id`);
    const prepack = allProducts.find((p) => p.poster_product_id === 500);
    expect(prepack?.type).toBe('semi');
    expect(prepack?.poster_ingredient_id).toBe(600);
  });

  it('upsertPrepack does not crash when a raw row already holds the same poster_ingredient_id', async () => {
    // Pre-seed a raw row that ALREADY occupies `poster_ingredient_id=600`.
    // This is the worst-case version of the bug above — what happens when
    // the seed is run on a database that was once filled by the buggy
    // version that imported type=2 as raw. The new upsertPrepack must
    // upgrade the existing row (raw -> semi) rather than try to INSERT a
    // duplicate that violates the partial UNIQUE.
    await ctx.db.query(
      `INSERT INTO products (name, type, unit, poster_ingredient_id)
       VALUES ('Dough base (legacy)', 'raw', 'kg', 600)`,
    );
    const client = clientForResponses({
      'menu.getPrepacks': [
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Dough base',
          out: 1,
          ingredients: [], // BOM doesn't matter for this test.
        },
      ],
    });
    const r = await syncPrepacks(client);
    expect(r.status).toBe('ok');
    const { rows } = await ctx.db.query<{
      id: number;
      type: string;
      poster_product_id: number | null;
      poster_ingredient_id: number | null;
    }>(`SELECT id, type, poster_product_id, poster_ingredient_id FROM products`);
    expect(rows).toHaveLength(1);
    // Same row, upgraded from raw -> semi, with poster_product_id now filled.
    expect(rows[0]?.type).toBe('semi');
    expect(rows[0]?.poster_product_id).toBe(500);
    expect(rows[0]?.poster_ingredient_id).toBe(600);
  });
});

describe('Poster seedSync — ingredients + prepacks (BOM)', () => {
  it('imports ingredients, then a prepack with its BOM (`out`-normalised to the prepack unit)', async () => {
    // Mirrors real Poster prepack shape: lines are in GRAMS (structure_unit
    // 'g'), `out` is the batch yield in grams, the prepack is stocked in kg.
    // qty_per_unit must mean "component qty (kg) per 1 kg of the prepack's
    // output" — so BOTH the brutto AND `out` normalise g->kg before dividing.
    // This is the 2026-05-30 fix: previously `out` stayed in grams while the
    // brutto was already kg, making every qty_per_unit ~1000x too small.
    const client = clientForResponses({
      'menu.getIngredients': [
        { ingredient_id: 100, ingredient_name: 'Flour', ingredient_unit: 'kg' },
        { ingredient_id: 101, ingredient_name: 'Sugar', ingredient_unit: 'kg' },
      ],
      'menu.getPrepacks': [
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Dough base',
          out: 2000, // 2000 g batch yield -> 2 kg of output
          ingredients: [
            {
              structure_id: 's1',
              ingredient_id: '100',
              structure_unit: 'g',
              structure_type: '1',
              structure_brutto: 1000, // 1000 g -> 1 kg; / 2 kg out = 0.5 kg/kg
              structure_netto: 950,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
            {
              structure_id: 's2',
              ingredient_id: '101',
              structure_unit: 'g',
              structure_type: '1',
              structure_brutto: 400, // 400 g -> 0.4 kg; / 2 kg out = 0.2 kg/kg
              structure_netto: 400,
              ingredient_name: 'Sugar',
              ingredient_unit: 'kg',
            },
          ],
        },
      ],
    });

    const rIng = await syncIngredients(client);
    expect(rIng.status).toBe('ok');
    expect(rIng.recordsApplied).toBe(2);

    const rPre = await syncPrepacks(client);
    expect(rPre.status).toBe('ok');
    expect(rPre.recordsApplied).toBe(1);

    const { rows: prods } = await ctx.db.query<{ id: number; type: string; poster_ingredient_id: number | null; poster_product_id: number | null }>(
      `SELECT id, type, poster_ingredient_id, poster_product_id FROM products ORDER BY id`,
    );
    expect(prods.find((p) => p.poster_ingredient_id === 100)?.type).toBe('raw');
    expect(prods.find((p) => p.poster_product_id === 500)?.type).toBe('semi');

    const { rows: recipes } = await ctx.db.query<{
      qty_per_unit: number;
      component_product_id: number;
      brutto: string | null;
      netto: string | null;
    }>(
      `SELECT qty_per_unit, component_product_id, brutto, netto
         FROM recipes ORDER BY component_product_id`,
    );
    expect(recipes).toHaveLength(2);
    // Flour: 1000 g (-> 1 kg) / 2 kg out = 0.5 kg per kg of output.
    expect(Number(recipes[0]?.qty_per_unit)).toBeCloseTo(0.5, 6);
    // Sugar: 400 g (-> 0.4 kg) / 2 kg out = 0.2 kg per kg of output.
    expect(Number(recipes[1]?.qty_per_unit)).toBeCloseTo(0.2, 6);
    // Brutto/netto stored RAW in the line's structure_unit (grams here).
    expect(Number(recipes[0]?.brutto)).toBeCloseTo(1000, 4);
    expect(Number(recipes[0]?.netto)).toBeCloseTo(950, 4);
    expect(Number(recipes[1]?.brutto)).toBeCloseTo(400, 4);
    expect(Number(recipes[1]?.netto)).toBeCloseTo(400, 4);
  });

  it('isolates per-prepack failures so one bad row does NOT poison the rest (Prove-It regression)', async () => {
    // Sprint 3 audit P1: against a real Poster account 1121 prepacks came
    // down the wire but only ~109 landed — every prepack AFTER the first
    // failure surfaced as "current transaction is aborted, commands ignored
    // until end of transaction block". Root cause: an inner `try/catch`
    // around `INSERT INTO recipes` inside `withTransaction` silently
    // swallowed the error message but left the tx aborted (Postgres only
    // allows a mid-tx recovery via SAVEPOINT). After the fix:
    //   - per-row SAVEPOINT inside `replaceRecipe` so a single bad recipe
    //     row does not abort the prepack's whole BOM;
    //   - per-prepack `try/catch` in `syncPrepacks` so a hard upsert
    //     failure on one prepack does not abort the loop;
    //   - `failedItems` captured and surfaced as `partial` + `errorDetail`.
    //
    // We engineer a hard failure on prepack #2 by forcing a NUMERIC(14,4)
    // overflow on `qty_per_unit` — `structure_brutto = 1e18`. The recipe
    // INSERT raises a numeric_value_out_of_range (22003) inside the
    // SAVEPOINT and is rolled back; the prepack itself still gets the
    // upsert (no BOM rows survive), so `recordsApplied` counts prepacks
    // attempted, but `failedItems` collects nothing for this case because
    // SAVEPOINT swallows the recipe row failure cleanly. To prove the
    // OUTER per-prepack catch we also force a true upsert failure on
    // prepack #3 by pre-seeding a row that collides on the partial UNIQUE
    // via a path the two-phase upsert CANNOT recover from.
    //
    // Pragmatic version: drive prepack #2 with a `qty_per_unit` overflow
    // that fails inside replaceRecipe's SAVEPOINT (proves SAVEPOINT fix),
    // and assert that prepack #1 AND prepack #3 BOTH land with recipes —
    // before the fix prepack #3 would have surfaced "transaction is
    // aborted" from prepack #2's poisoned outer tx.

    const client = clientForResponses({
      'menu.getIngredients': [
        { ingredient_id: 100, ingredient_name: 'Flour', ingredient_unit: 'kg' },
      ],
      'menu.getPrepacks': [
        // 1. clean prepack — must land with its recipe.
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Good prepack A',
          out: 1,
          ingredients: [
            {
              structure_id: 's1',
              ingredient_id: '100',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 0.5,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
          ],
        },
        // 2. poisoned prepack — `structure_brutto = 1e18` overflows
        // NUMERIC(14,4). Without SAVEPOINT, this aborts the whole tx and
        // prepack #3 below would surface "transaction is aborted".
        {
          product_id: '502',
          ingredient_id: '602',
          product_name: 'Overflow prepack',
          out: 1,
          ingredients: [
            {
              structure_id: 's2',
              ingredient_id: '100',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 1e18,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
          ],
        },
        // 3. clean prepack — REGRESSION ASSERTION: this must land. Before
        // the fix prepack #2's aborted tx poisoned this whole iteration.
        {
          product_id: '503',
          ingredient_id: '603',
          product_name: 'Good prepack B',
          out: 2,
          ingredients: [
            {
              structure_id: 's3',
              ingredient_id: '100',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 1,
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
          ],
        },
      ],
    });

    await syncIngredients(client);
    const r = await syncPrepacks(client);
    // All three prepacks were ATTEMPTED — none threw out to the outer
    // catch (SAVEPOINT contained the failure). recordsApplied counts
    // prepacks that finished their loop body.
    expect(r.recordsApplied).toBe(3);

    // All three prepack rows are in the DB (the upsert happens before
    // replaceRecipe).
    const { rows: prepacks } = await ctx.db.query<{ poster_product_id: number; type: string }>(
      `SELECT poster_product_id, type FROM products
        WHERE poster_product_id IN (500, 502, 503) ORDER BY poster_product_id`,
    );
    expect(prepacks.map((p) => p.poster_product_id)).toEqual([500, 502, 503]);
    expect(prepacks.every((p) => p.type === 'semi')).toBe(true);

    // The CRITICAL regression assertion: prepack #3's BOM landed. Before
    // the SAVEPOINT fix, prepack #2's overflow aborted the recipe tx and
    // prepack #3 surfaced "current transaction is aborted, commands
    // ignored until end of transaction block". After the fix, prepack #3
    // has its recipe row.
    const { rows: recipes } = await ctx.db.query<{
      product_id: number;
      qty_per_unit: string;
    }>(
      `SELECT r.product_id, r.qty_per_unit::text AS qty_per_unit
         FROM recipes r
         JOIN products p ON p.id = r.product_id
        WHERE p.poster_product_id IN (500, 503)
        ORDER BY p.poster_product_id`,
    );
    expect(recipes.length).toBe(2);
    // Prepack #1 — 0.5 kg per 1 out = 0.5
    expect(Number(recipes[0]?.qty_per_unit)).toBeCloseTo(0.5, 4);
    // Prepack #3 — 1 kg per 2 out = 0.5
    expect(Number(recipes[1]?.qty_per_unit)).toBeCloseTo(0.5, 4);

    // Prepack #2 has NO recipe (the row failed inside its SAVEPOINT and
    // was rolled back). This proves the SAVEPOINT scoping.
    const { rows: badRecipes } = await ctx.db.query<{ product_id: number }>(
      `SELECT r.product_id FROM recipes r
         JOIN products p ON p.id = r.product_id
        WHERE p.poster_product_id = 502`,
    );
    expect(badRecipes).toHaveLength(0);
  });

  it('skips a prepack component whose ingredient is not yet seeded', async () => {
    const client = clientForResponses({
      'menu.getIngredients': [
        { ingredient_id: 100, ingredient_name: 'Flour', ingredient_unit: 'kg' },
      ],
      'menu.getPrepacks': [
        {
          product_id: '500',
          ingredient_id: '600',
          product_name: 'Dough',
          out: 1,
          ingredients: [
            { structure_id: 's1', ingredient_id: '100', structure_unit: 'kg', structure_type: '1', structure_brutto: 0.5, ingredient_name: 'Flour', ingredient_unit: 'kg' },
            { structure_id: 's2', ingredient_id: '999', structure_unit: 'kg', structure_type: '1', structure_brutto: 0.2, ingredient_name: 'Missing', ingredient_unit: 'kg' },
          ],
        },
      ],
    });
    await syncIngredients(client);
    await syncPrepacks(client);
    const { rows } = await ctx.db.query<{ qty_per_unit: number }>(`SELECT qty_per_unit FROM recipes`);
    // Only the resolvable component lands.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qty_per_unit).toBeCloseTo(0.5, 6);
  });
});

describe('Poster seedSync — nested BOM (structure_type) + cost', () => {
  it('resolves a prepack-in-prepack child by poster_product_id (structure_type=2) and syncs raw unit cost', async () => {
    // НАПОЛЕОН-shaped tree: prepack 281 -> [ун raw 310g, крем prepack(562)].
    // Prepack 562 appears AFTER 281 in the list — phase-1/phase-2 must still
    // link them (the bug was: type=2 children resolved by poster_ingredient_id
    // -> always missing -> silently dropped).
    const client = clientForResponses({
      'menu.getIngredients': [
        { ingredient_id: 708, ingredient_name: 'ун', ingredient_unit: 'kg', ingredients_type: 1 },
        { ingredient_id: 703, ingredient_name: 'Молоко белый', ingredient_unit: 'kg', ingredients_type: 1 },
      ],
      'menu.getPrepacks': [
        {
          product_id: '281',
          ingredient_id: '0', // stockless prepack — must still import
          product_name: 'Г/П НАПОЛЕОН (ЦЕЛЫЙ)',
          out: 1000,
          ingredients: [
            { structure_id: 's1', ingredient_id: '708', structure_type: '1', structure_unit: 'g', structure_brutto: '310.00', structure_netto: 310, structure_selfprice: '232518', ingredient_name: 'ун', ingredient_unit: 'kg' },
            { structure_id: 's2', ingredient_id: '562', structure_type: '2', structure_unit: 'g', structure_brutto: '3350.00', structure_netto: 3350, structure_selfprice: '7966096', ingredient_name: 'крем наполеон', ingredient_unit: 'kg' },
          ],
        },
        {
          product_id: '562',
          ingredient_id: '0',
          product_name: 'крем наполеон',
          out: 33500,
          ingredients: [
            { structure_id: 's3', ingredient_id: '703', structure_type: '1', structure_unit: 'g', structure_brutto: '15000.00', structure_netto: 15000, structure_selfprice: '27000000', ingredient_name: 'Молоко белый', ingredient_unit: 'kg' },
          ],
        },
      ],
    });

    await syncIngredients(client);
    const r = await syncPrepacks(client);
    expect(r.status).toBe('ok');
    expect(r.recordsApplied).toBe(2);

    // Both prepacks imported (281 with ingredient_id=0 too). 281 is a «Г/П…»
    // ready prepack -> finished; 562 is a plain prepack -> semi.
    const { rows: prepacks } = await ctx.db.query<{ poster_product_id: number; type: string; poster_ingredient_id: number | null }>(
      `SELECT poster_product_id, type, poster_ingredient_id FROM products
        WHERE type IN ('semi','finished') ORDER BY poster_product_id`,
    );
    expect(prepacks.map((p) => p.poster_product_id)).toEqual([281, 562]);
    expect(prepacks[0]?.type).toBe('finished'); // 281 «Г/П…»
    expect(prepacks[0]?.poster_ingredient_id).toBeNull(); // 281 stockless
    expect(prepacks[1]?.type).toBe('semi'); // 562 plain prepack

    // 281's BOM has BOTH the raw (ун) AND the prepack child (крем = 562).
    const { rows: bom281 } = await ctx.db.query<{ component_type: string; qty: string }>(
      `SELECT cp.type AS component_type, r.qty_per_unit::text AS qty
         FROM recipes r
         JOIN products parent ON parent.id = r.product_id AND parent.poster_product_id = 281
         JOIN products cp ON cp.id = r.component_product_id
        ORDER BY cp.type`,
    );
    // raw (ун) + semi (крем) — TWO lines (the prepack child is no longer dropped).
    expect(bom281).toHaveLength(2);
    expect(bom281.map((b) => b.component_type).sort()).toEqual(['raw', 'semi']);

    // Raw unit cost synced from structure_selfprice: ун = 232518 tiyin / 0.310 kg
    // / 100 = 7500.58 so'm/kg.
    const { rows: cost } = await ctx.db.query<{ cost_per_unit: string }>(
      `SELECT cost_per_unit::text FROM products WHERE poster_ingredient_id = 708`,
    );
    expect(Number(cost[0]?.cost_per_unit)).toBeCloseTo(7500.58, 1);
  });

  it('classifies a «Г/П» prepack as finished and a plain prepack as semi', async () => {
    // Owner rework (2026-06-08): the Г/П ready-prefix marks a finished
    // (sale-ready) product; everything else stays semi.
    const client = clientForResponses({
      'menu.getPrepacks': [
        { product_id: '281', ingredient_id: '0', product_name: 'Г/П НАПОЛЕОН (ЦЕЛЫЙ)', out: 1000, ingredients: [] },
        { product_id: '282', ingredient_id: '0', product_name: 'НАПОЛЕОН ун', out: 1000, ingredients: [] },
      ],
    });

    const r = await syncPrepacks(client);
    expect(r.status).toBe('ok');

    const { rows } = await ctx.db.query<{ poster_product_id: number; type: string }>(
      `SELECT poster_product_id, type FROM products
        WHERE poster_product_id IN (281, 282) ORDER BY poster_product_id`,
    );
    expect(rows).toEqual([
      { poster_product_id: 281, type: 'finished' },
      { poster_product_id: 282, type: 'semi' },
    ]);
  });
});

describe('Poster seedSync — dish enrichment + sales resolution map', () => {
  it('materialises every unmatched menu product as a resale row + alias', async () => {
    // Drive `menu.getProduct?product_id=...` per id via URL inspection.
    const client = new PosterClient({
      token: 'acc:test',
      minIntervalMs: 0,
      fetcher: ((url: string | URL) => {
        const u = typeof url === 'string' ? new URL(url) : url;
        const method = u.pathname.split('/').pop() ?? '';
        if (method === 'menu.getIngredients') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                response: [
                  { ingredient_id: 1000, ingredient_name: 'Cocoa', ingredient_unit: 'kg' },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        if (method === 'menu.getProducts') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                response: [
                  { product_id: '800', product_name: 'Cake', type: '2', ingredient_id: '1500' },
                  { product_id: '801', product_name: 'Adia', type: '3', ingredient_id: '1600' },
                ],
              }),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 30, message: 'not allowed' } }), {
            status: 200,
          }),
        );
      }) as unknown as typeof fetch,
    });

    await syncIngredients(client);
    const r = await syncMenuProducts(client);
    expect(r.status).toBe('ok');

    // Neither menu product name-matches a prepack -> BOTH become `resale`
    // products keyed by their menu product_id, each with a map alias so a sale
    // check line resolves. The raw ingredient is untouched (no menu match).
    const { rows: resale } = await ctx.db.query<{ poster_product_id: number; name: string; type: string }>(
      `SELECT poster_product_id, name, type FROM products
        WHERE type = 'resale' ORDER BY poster_product_id`,
    );
    expect(resale).toEqual([
      { poster_product_id: 800, name: 'Cake', type: 'resale' },
      { poster_product_id: 801, name: 'Adia', type: 'resale' },
    ]);

    // The map aliases the menu ids (800, 801) to those resale rows.
    const { rows: map } = await ctx.db.query<{ poster_menu_product_id: number; product_id: number }>(
      `SELECT m.poster_menu_product_id, m.product_id
         FROM poster_menu_product_map m
         JOIN products p ON p.id = m.product_id
        WHERE p.type = 'resale' ORDER BY m.poster_menu_product_id`,
    );
    expect(map.map((x) => x.poster_menu_product_id)).toEqual([800, 801]);
  });

  it('enriches a matching prepack + maps its menu id, and materialises the товар as resale', async () => {
    // A Г/П prepack «Г/П ПИРОГ С ТВОРОГОМ (ЦЕЛЫЙ)» matches the dish
    // «ПИРОГ С ТВОРОГОМ» by normalised name -> inherits category Пироги,
    // photo, and workshop «Пирог отдел» (a production location), AND the menu id
    // (537) is aliased to that prepack. The товар «Coca Cola» (37) matches no
    // prepack -> becomes a `resale` product + alias so its sales still land.
    const client = clientForResponses({
      'menu.getWorkshops': [
        { workshop_id: '9', workshop_name: 'Пирог отдел', delete: '0' },
        { workshop_id: '27', workshop_name: 'холодные напитки', delete: '0' },
      ],
      'menu.getCategories': [{ category_id: '9', category_name: 'Пироги' }],
      'menu.getPrepacks': [
        {
          product_id: '978',
          ingredient_id: '2402',
          product_name: 'Г/П ПИРОГ С ТВОРОГОМ (ЦЕЛЫЙ)',
          out: 1000,
          ingredients: [],
        },
      ],
      'menu.getProducts': [
        {
          product_id: '537',
          product_name: 'ПИРОГ С ТВОРОГОМ',
          type: '2',
          menu_category_id: '9',
          workshop: '9',
          photo: '/upload/menu/pirog.jpg',
        },
        // A товар — matches no prepack -> materialised as a `resale` product.
        {
          product_id: '37',
          product_name: 'Coca Cola',
          type: '3',
          menu_category_id: '4',
          workshop: '27',
          photo: '/upload/menu/cola.jpg',
        },
      ],
    });

    await syncWorkshops(client);
    await syncCategories(client);
    await syncPrepacks(client);
    const r = await syncMenuProducts(client);
    expect(r.status).toBe('ok');

    // The Г/П prepack is enriched.
    const { rows } = await ctx.db.query<{
      type: string;
      image_url: string | null;
      category_name: string | null;
      workshop_name: string | null;
      workshop_type: string | null;
    }>(
      `SELECT p.type, p.image_url, c.name AS category_name,
              w.name AS workshop_name, w.type::text AS workshop_type
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN locations w ON w.id = p.workshop_location_id
        WHERE p.poster_product_id = 978`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe('finished');
    expect(rows[0]?.image_url).toBe('/upload/menu/pirog.jpg');
    expect(rows[0]?.category_name).toBe('Пироги');
    expect(rows[0]?.workshop_name).toBe('Пирог отдел');
    expect(rows[0]?.workshop_type).toBe('production');

    // The dish's menu id (537) is aliased to the prepack (#978), NOT a new row —
    // a sale check line for 537 resolves to the prepack.
    const { rows: pirogMap } = await ctx.db.query<{ same: boolean }>(
      `SELECT (m.product_id = p.id) AS same
         FROM poster_menu_product_map m
         JOIN products p ON p.poster_product_id = 978
        WHERE m.poster_menu_product_id = 537`,
    );
    expect(pirogMap).toHaveLength(1);
    expect(pirogMap[0]?.same).toBe(true);

    // The товар «Coca Cola» (37) is a `resale` product (NOT dropped), aliased.
    const { rows: cola } = await ctx.db.query<{
      type: string;
      name: string;
      mapped: number;
    }>(
      `SELECT p.type, p.name, m.product_id AS mapped
         FROM products p
         JOIN poster_menu_product_map m ON m.poster_menu_product_id = 37
        WHERE p.poster_product_id = 37`,
    );
    expect(cola).toHaveLength(1);
    expect(cola[0]?.type).toBe('resale');
    expect(cola[0]?.name).toBe('Coca Cola');

    // The excluded «холодные напитки» workshop was NOT seeded as a location.
    const { rows: ws } = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM locations WHERE poster_workshop_id = 27`,
    );
    expect(ws[0]?.n).toBe('0');
  });
});

describe('Poster seedSync — categories (menu.getCategories)', () => {
  it('upserts categories and enriches a matching prepack with its menu category', async () => {
    // The category is carried by a dish and lands on the prepack it matches by
    // normalised name (enrichment). A dish that matches nothing changes no row.
    const client = clientForResponses({
      'menu.getCategories': [
        { category_id: '3', category_name: 'Пирожные' },
        { category_id: '7', category_name: 'Торты' },
      ],
      'menu.getPrepacks': [
        { product_id: '900', ingredient_id: '0', product_name: 'Г/П ЭКЛЕР (ЦЕЛЫЙ)', out: 1000, ingredients: [] },
        { product_id: '901', ingredient_id: '0', product_name: 'Г/П МЕДОВИК (ЦЕЛЫЙ)', out: 1000, ingredients: [] },
        { product_id: '903', ingredient_id: '0', product_name: 'БЕЗ ПАРЫ', out: 1000, ingredients: [] },
      ],
      'menu.getProducts': [
        { product_id: '800', product_name: 'ЭКЛЕР', type: '3', menu_category_id: '3' },
        { product_id: '801', product_name: 'МЕДОВИК', type: '3', menu_category_id: '7' },
        // matches no prepack -> ignored.
        { product_id: '802', product_name: 'Без категории', type: '3' },
      ],
    });

    const cat = await syncCategories(client);
    expect(cat.status).toBe('ok');
    expect(cat.recordsApplied).toBe(2);

    await syncPrepacks(client);
    const prod = await syncMenuProducts(client);
    expect(prod.status).toBe('ok');

    const { rows } = await ctx.db.query<{
      poster_product_id: number;
      category_name: string | null;
    }>(
      `SELECT p.poster_product_id, c.name AS category_name
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.poster_product_id IN (900, 901, 903)
        ORDER BY p.poster_product_id`,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.category_name).toBe('Пирожные'); // 900 ЭКЛЕР -> cat 3
    expect(rows[1]?.category_name).toBe('Торты'); // 901 МЕДОВИК -> cat 7
    expect(rows[2]?.category_name).toBeNull(); // 903 unmatched -> no category

    // Idempotent: a second category run renames in place, no duplicate rows.
    const cat2 = await syncCategories(
      clientForResponses({
        'menu.getCategories': [{ category_id: '3', category_name: 'Пирожные (нов.)' }],
      }),
    );
    expect(cat2.status).toBe('ok');
    const { rows: catCount } = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM categories`,
    );
    expect(catCount[0]?.n).toBe('2');
  });
});

describe('Poster seedSync — ingredient categories (menu.getCategoriesIngredients)', () => {
  it('upserts ingredient categories and maps raw category_id -> products.category_id', async () => {
    const client = clientForResponses({
      'menu.getCategoriesIngredients': [
        { category_id: '1', name: 'Молочные продукты' },
        { category_id: '15', name: 'Тесто' },
      ],
      'menu.getIngredients': [
        { ingredient_id: '500', ingredient_name: 'Молоко', ingredient_unit: 'l', ingredients_type: 1, category_id: 1 },
        { ingredient_id: '501', ingredient_name: 'Тесто слоёное', ingredient_unit: 'kg', ingredients_type: 1, category_id: 15 },
        // category_id 0 -> uncategorised -> category_id stays NULL.
        { ingredient_id: '502', ingredient_name: 'Без категории', ingredient_unit: 'p', ingredients_type: 1, category_id: 0 },
      ],
    });

    const cat = await syncIngredientCategories(client);
    expect(cat.status).toBe('ok');
    expect(cat.recordsApplied).toBe(2);

    const ing = await syncIngredients(client);
    expect(ing.status).toBe('ok');
    expect(ing.recordsApplied).toBe(3);

    const { rows } = await ctx.db.query<{
      poster_ingredient_id: number;
      type: string;
      category_name: string | null;
    }>(
      `SELECT p.poster_ingredient_id, p.type, c.name AS category_name
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.type = 'raw'
        ORDER BY p.poster_ingredient_id`,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]?.category_name).toBe('Молочные продукты'); // 500 -> cat 1
    expect(rows[1]?.category_name).toBe('Тесто'); // 501 -> cat 15
    expect(rows[2]?.category_name).toBeNull(); // 502 -> uncategorised

    // The ingredient categories land under kind='ingredient'.
    const { rows: kindRows } = await ctx.db.query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM categories GROUP BY kind ORDER BY kind`,
    );
    expect(kindRows).toEqual([{ kind: 'ingredient', n: '2' }]);
  });

  it('keeps menu and ingredient namespaces separate even when ids collide', async () => {
    // Poster id=4 means "Овощи" as a menu category but "Картонные упаковки" as
    // an ingredient category — the composite (kind, poster_category_id) key
    // must keep both rows distinct.
    const client = clientForResponses({
      'menu.getCategories': [{ category_id: '4', category_name: 'Овощи (menu)' }],
      'menu.getCategoriesIngredients': [{ category_id: '4', name: 'Картонные упаковки' }],
      'menu.getIngredients': [
        { ingredient_id: '700', ingredient_name: 'Коробка', ingredient_unit: 'p', ingredients_type: 1, category_id: 4 },
      ],
      // A prepack «Г/П САЛАТ (ЦЕЛЫЙ)» matched by the dish «САЛАТ» -> menu cat.
      'menu.getPrepacks': [
        { product_id: '950', ingredient_id: '0', product_name: 'Г/П САЛАТ (ЦЕЛЫЙ)', out: 1000, ingredients: [] },
      ],
      'menu.getProducts': [
        { product_id: '800', product_name: 'САЛАТ', type: '3', menu_category_id: '4' },
      ],
    });

    await syncCategories(client);
    await syncIngredientCategories(client);
    await syncIngredients(client);
    await syncPrepacks(client);
    await syncMenuProducts(client);

    const { rows: cats } = await ctx.db.query<{ kind: string; name: string }>(
      `SELECT kind, name FROM categories WHERE poster_category_id = 4 ORDER BY kind`,
    );
    expect(cats).toEqual([
      { kind: 'ingredient', name: 'Картонные упаковки' },
      { kind: 'menu', name: 'Овощи (menu)' },
    ]);

    // The raw ingredient resolves to the INGREDIENT-kind category, the enriched
    // prepack to the MENU-kind one — no cross-contamination.
    const { rows } = await ctx.db.query<{ type: string; category_name: string | null }>(
      `SELECT p.type, c.name AS category_name
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.poster_ingredient_id = 700 OR p.poster_product_id = 950
        ORDER BY p.type`,
    );
    const byType = Object.fromEntries(rows.map((r) => [r.type, r.category_name]));
    expect(byType.raw).toBe('Картонные упаковки');
    expect(byType.finished).toBe('Овощи (menu)');
  });
});
