/**
 * computeAllProductCosts — batched roll-up cross-check against readRecipeTree.
 *
 * The LIST endpoint cannot afford to call readRecipeTree once per product, so
 * computeAllProductCosts does the whole catalogue in two queries + an in-memory
 * memoized roll-up. This suite builds a small product+recipe graph (raw leaves,
 * a nested semi/prepack, a finished product, a recipe_yield case, and a
 * null-propagation case) and asserts the batched map agrees EXACTLY with
 * readRecipeTree(...).total_cost for the same products.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeProduct } from './helpers/fixtures.js';
import { readRecipeTree } from '../src/services/bom.js';
import { computeAllProductCosts } from '../src/services/costRollup.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});
beforeEach(async () => {
  await ctx.db.query('DELETE FROM recipes');
});

/** Assert the batched cost for `id` equals readRecipeTree(...).total_cost. */
async function expectAgrees(id: number, costs: Map<number, number | null>): Promise<void> {
  const tree = await readRecipeTree(ctx.db, id);
  expect(costs.get(id)).toBe(tree.total_cost);
}

describe('computeAllProductCosts', () => {
  it('agrees with readRecipeTree across raw / semi / finished + recipe_yield + null', async () => {
    // --- Raw leaves -----------------------------------------------------------
    // Flour @ 10 so'm/kg (synced), Sugar @ 4 so'm/kg with a MANUAL override of 6
    // (manual must win), Cocoa with NO cost at all (null propagation source).
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const sugar = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const cocoa = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query('UPDATE products SET cost_per_unit = 10 WHERE id = $1', [flour]);
    await ctx.db.query(
      'UPDATE products SET cost_per_unit = 4, manual_cost_per_unit = 6 WHERE id = $1',
      [sugar],
    );
    // cocoa: both costs NULL.

    // --- Semi (prepack) — krem: 2 kg sugar per 1 unit -> 2 × 6 = 12 ----------
    const krem = await makeProduct(ctx.db, { type: 'semi', unit: 'kg' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 2)`,
      [krem, sugar],
    );

    // --- Finished — cake: 3 kg flour + 1 unit krem, recipe_yield = 6 ---------
    // Per batch: 3×10 + 1×12 = 42; per piece (÷6) = 7.
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    await ctx.db.query('UPDATE products SET recipe_yield = 6 WHERE id = $1', [cake]);
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 3)`,
      [cake, flour],
    );
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 1)`,
      [cake, krem],
    );

    // --- Finished with a null leg — biscuit: 1 kg cocoa (no cost) -> null ----
    const biscuit = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 1)`,
      [biscuit, cocoa],
    );

    const costs = await computeAllProductCosts(ctx.db);

    // Concrete expected values (the contract).
    expect(costs.get(flour)).toBe(10); // raw, synced
    expect(costs.get(sugar)).toBe(6); // raw, manual override wins over 4
    expect(costs.get(cocoa)).toBe(null); // raw, no cost -> null (not 0)
    expect(costs.get(krem)).toBe(12); // semi: 2 × 6
    expect(costs.get(cake)).toBe(7); // finished: (3×10 + 1×12) / 6
    expect(costs.get(biscuit)).toBe(null); // null propagates up

    // Cross-check: for products that HAVE a recipe, the batched roll-up must
    // equal readRecipeTree(...).total_cost exactly — same recipe_yield division,
    // same null propagation. (readRecipeTree only sums a product's OWN top-level
    // lines, so for a raw LEAF it returns null, not the leaf cost; the leaf-cost
    // semantics are asserted directly above. The roll-up logic the two share is
    // the recipe path, checked here.)
    for (const id of [krem, cake, biscuit]) {
      await expectAgrees(id, costs);
    }
  });
});
