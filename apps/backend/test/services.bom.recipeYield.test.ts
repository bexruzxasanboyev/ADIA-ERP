/**
 * readRecipeTree — recipe_yield (TZ-3 batch→per-unit) integration test.
 *
 * A finished recipe imported "for the batch" carries qty_per_unit / brutto
 * figures for the whole batch. `recipe_yield` (how many units one recipe makes)
 * must divide every line so the cost + quantities read per ONE piece.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeProduct } from './helpers/fixtures.js';
import { readRecipeTree } from '../src/services/bom.js';

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

describe('readRecipeTree — recipe_yield', () => {
  it('divides cost + quantities by the product recipe_yield', async () => {
    // Raw flour at 10 so'm per kg — set via the MANUAL price, since the
    // catalog-price roll-up uses manual_cost_per_unit ALONE (no Poster fallback).
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query(`UPDATE products SET manual_cost_per_unit = 10 WHERE id = $1`, [
      flour,
    ]);
    // Finished item; recipe (as imported "for the batch") needs 5 kg flour.
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, brutto, netto, stage)
       VALUES ($1, $2, 5, 5000, 5000, 'base')`,
      [cake, flour],
    );

    // yield = 1 (default): the whole batch — 5 kg × 10 = 50.
    const atOne = await readRecipeTree(ctx.db, cake);
    expect(atOne.total_cost).toBeCloseTo(50, 4);
    expect(atOne.nodes[0]!.qty_per_unit).toBeCloseTo(5, 4);
    expect(atOne.nodes[0]!.brutto).toBeCloseTo(5000, 4);

    // yield = 20: one piece of a 20-piece batch — everything ÷ 20.
    await ctx.db.query(`UPDATE products SET recipe_yield = 20 WHERE id = $1`, [
      cake,
    ]);
    const atTwenty = await readRecipeTree(ctx.db, cake);
    expect(atTwenty.total_cost).toBeCloseTo(2.5, 4); // 50 / 20
    expect(atTwenty.nodes[0]!.qty_per_unit).toBeCloseTo(0.25, 4); // 5 / 20
    expect(atTwenty.nodes[0]!.brutto).toBeCloseTo(250, 4); // 5000 / 20
    expect(atTwenty.nodes[0]!.line_cost).toBeCloseTo(2.5, 4);
  });
});
