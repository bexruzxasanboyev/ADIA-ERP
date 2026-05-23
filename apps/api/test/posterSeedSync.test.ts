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
  syncSpots,
  syncStorages,
  syncIngredients,
  syncPrepacks,
  syncMenuProducts,
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

describe('Poster seedSync — storages', () => {
  it('upserts storages and keeps existing type on re-run', async () => {
    const client = clientForResponses({
      'storage.getStorages': [
        { storage_id: '3', storage_name: 'Склад Кукча' },
        { storage_id: '20', storage_name: 'Производственный Цех' },
      ],
    });
    await syncStorages(client);
    // PM reclassifies the second storage as a `production` location.
    await ctx.db.query(`UPDATE locations SET type='production' WHERE poster_storage_id=20`);

    // Second run must NOT overwrite the PM's classification.
    await syncStorages(client);
    const { rows } = await ctx.db.query<{ type: string; poster_storage_id: number }>(
      `SELECT type, poster_storage_id FROM locations ORDER BY poster_storage_id`,
    );
    expect(rows.find((r) => r.poster_storage_id === 20)?.type).toBe('production');
    expect(rows.find((r) => r.poster_storage_id === 3)?.type).toBe('central_warehouse');
  });
});

describe('Poster seedSync — ingredients + prepacks (BOM)', () => {
  it('imports ingredients, then a prepack with its BOM (`out`-normalised)', async () => {
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
          out: 2000, // 2000 units per batch
          ingredients: [
            {
              structure_id: 's1',
              ingredient_id: '100',
              structure_unit: 'g',
              structure_type: '1',
              structure_brutto: 1000, // 1000g per batch -> 0.5 kg per batch -> 0.5/2000 kg per unit
              ingredient_name: 'Flour',
              ingredient_unit: 'kg',
            },
            {
              structure_id: 's2',
              ingredient_id: '101',
              structure_unit: 'kg',
              structure_type: '1',
              structure_brutto: 0.4, // 0.4 kg/batch -> 0.4/2000 kg per unit
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

    const { rows: recipes } = await ctx.db.query<{ qty_per_unit: number; component_product_id: number }>(
      `SELECT qty_per_unit, component_product_id FROM recipes ORDER BY component_product_id`,
    );
    expect(recipes).toHaveLength(2);
    // Flour: 1000 g (-> 1 kg) / 2000 out = 0.0005 kg per unit
    expect(recipes[0]?.qty_per_unit).toBeCloseTo(0.0005, 6);
    // Sugar: 0.4 kg / 2000 = 0.0002 kg per unit
    expect(recipes[1]?.qty_per_unit).toBeCloseTo(0.0002, 6);
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

describe('Poster seedSync — menu products + BOM import', () => {
  it('imports type=2 products with BOM and skips type=3 products', async () => {
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
        if (method === 'menu.getProduct') {
          const pid = u.searchParams.get('product_id');
          if (pid === '800') {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  response: {
                    product_id: '800',
                    product_name: 'Cake',
                    type: '2',
                    ingredient_id: '1500',
                    ingredients: [
                      {
                        structure_id: 's1',
                        ingredient_id: '1000',
                        structure_unit: 'g',
                        structure_type: '1',
                        structure_brutto: 200,
                        ingredient_name: 'Cocoa',
                        ingredient_unit: 'kg',
                      },
                    ],
                  },
                }),
                { status: 200 },
              ),
            );
          }
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
    expect(r.recordsApplied).toBe(2);

    const { rows: products } = await ctx.db.query<{ poster_product_id: number; type: string }>(
      `SELECT poster_product_id, type FROM products WHERE poster_product_id IS NOT NULL ORDER BY poster_product_id`,
    );
    expect(products).toHaveLength(2);

    const { rows: recipes } = await ctx.db.query<{ qty_per_unit: number; product_id: number; component_product_id: number }>(
      `SELECT qty_per_unit, product_id, component_product_id FROM recipes`,
    );
    expect(recipes).toHaveLength(1);
    // 200 g of cocoa converted to kg -> 0.2 kg per unit.
    expect(recipes[0]?.qty_per_unit).toBeCloseTo(0.2, 6);
  });
});
