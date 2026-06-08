/**
 * FEATURE A — editable MANUAL product price (manual_cost_per_unit).
 *
 * Proves the override semantics end-to-end:
 *   1. with a manual price set, the cost roll-up (readRecipeTree) uses the
 *      MANUAL price, not the Poster-synced cost_per_unit;
 *   2. a sync-style UPDATE to cost_per_unit does NOT change the effective cost
 *      while a manual price is pinned (the manual price SURVIVES re-sync);
 *   3. clearing the override (manual_cost_per_unit = NULL) falls back to the
 *      synced cost_per_unit;
 *   4. the PATCH /api/products/:id/cost endpoint (RBAC + null-to-clear) and the
 *      GET /api/products list both surface the two cost fields.
 *
 * The cost roll-up is driven through `readRecipeTree`: a finished product with
 * one RAW leaf so the leaf unit cost IS the recipe's line/total cost.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser, makeProduct, makeLocation } from './helpers/fixtures.js';
import { readRecipeTree } from '../src/services/bom.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** A finished product with one RAW leaf at qty 1 — total_cost === leaf cost. */
async function makeFinishedWithRawLeaf(): Promise<{
  finishedId: number;
  rawId: number;
}> {
  const finishedId = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });
  const rawId = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit)
     VALUES ($1, $2, 1)`,
    [finishedId, rawId],
  );
  return { finishedId, rawId };
}

describe('FEATURE A — manual product cost override', () => {
  it('manual price wins, survives a sync-style cost_per_unit update, clears to fallback', async () => {
    const { finishedId, rawId } = await makeFinishedWithRawLeaf();

    // Poster-synced cost = 100 so'm/kg → roll-up total = 100.
    await ctx.db.query('UPDATE products SET cost_per_unit = 100 WHERE id = $1', [rawId]);
    let tree = await readRecipeTree(ctx.db, finishedId);
    expect(tree.total_cost).toBe(100);

    // Pin a MANUAL price of 250 → roll-up now uses 250, not 100.
    await ctx.db.query('UPDATE products SET manual_cost_per_unit = 250 WHERE id = $1', [rawId]);
    tree = await readRecipeTree(ctx.db, finishedId);
    expect(tree.total_cost).toBe(250);

    // A sync-style UPDATE to cost_per_unit must NOT change the effective cost
    // while the manual price is pinned (manual SURVIVES re-sync).
    await ctx.db.query('UPDATE products SET cost_per_unit = 999 WHERE id = $1', [rawId]);
    tree = await readRecipeTree(ctx.db, finishedId);
    expect(tree.total_cost).toBe(250);

    // Clear the override (NULL) → fall back to the synced cost_per_unit (999).
    await ctx.db.query('UPDATE products SET manual_cost_per_unit = NULL WHERE id = $1', [rawId]);
    tree = await readRecipeTree(ctx.db, finishedId);
    expect(tree.total_cost).toBe(999);
  });

  it('PATCH /api/products/:id/cost pins, returns the contract, then clears with null', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawId = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query('UPDATE products SET cost_per_unit = 50 WHERE id = $1', [rawId]);

    // Pin a manual price.
    const set = await request(ctx.app)
      .patch(`/api/products/${rawId}/cost`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ cost_per_unit: 320 });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      id: rawId,
      manual_cost_per_unit: 320,
      cost_per_unit: 50,
    });

    // The list response surfaces both cost fields.
    const list = await request(ctx.app)
      .get('/api/products?type=raw')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(list.status).toBe(200);
    const row = (list.body as { id: number; manual_cost_per_unit: unknown; cost_per_unit: unknown }[]).find(
      (p) => p.id === rawId,
    );
    expect(row).toBeDefined();
    expect(Number(row!.manual_cost_per_unit)).toBe(320);
    expect(Number(row!.cost_per_unit)).toBe(50);

    // Clear the override with null → back to the Poster cost.
    const clear = await request(ctx.app)
      .patch(`/api/products/${rawId}/cost`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ cost_per_unit: null });
    expect(clear.status).toBe(200);
    expect(clear.body).toEqual({
      id: rawId,
      manual_cost_per_unit: null,
      cost_per_unit: 50,
    });
  });

  it('PATCH allows editing a RAW price but rejects semi/finished (computed)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const rawId = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const semiId = await makeProduct(ctx.db, { type: 'semi', unit: 'kg' });
    const finishedId = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs' });

    // Raw — editing succeeds (manual override set), exactly as before.
    const raw = await request(ctx.app)
      .patch(`/api/products/${rawId}/cost`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ cost_per_unit: 150 });
    expect(raw.status).toBe(200);
    expect(raw.body.manual_cost_per_unit).toBe(150);

    // Semi — rejected (derived price is computed from the recipe).
    const semi = await request(ctx.app)
      .patch(`/api/products/${semiId}/cost`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ cost_per_unit: 150 });
    expect(semi.status).toBe(409);
    expect(semi.body.error.code).toBe('CONFLICT');

    // Finished — rejected for the same reason.
    const finished = await request(ctx.app)
      .patch(`/api/products/${finishedId}/cost`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ cost_per_unit: 150 });
    expect(finished.status).toBe(409);

    // The rejected products keep a NULL manual override (no write happened).
    const after = await ctx.db.query<{ manual_cost_per_unit: string | null }>(
      'SELECT manual_cost_per_unit FROM products WHERE id = ANY($1::bigint[])',
      [[semiId, finishedId]],
    );
    for (const r of after.rows) {
      expect(r.manual_cost_per_unit).toBeNull();
    }
  });

  it('PATCH rejects a zero/negative price and a non-pm role', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const storeLoc = await makeLocation(ctx.db, { type: 'store' });
    const store = await makeUser(ctx.db, { role: 'store_manager', locationId: storeLoc });
    const rawId = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    // 0 is rejected — clearing is done with null, not 0.
    const zero = await request(ctx.app)
      .patch(`/api/products/${rawId}/cost`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ cost_per_unit: 0 });
    expect(zero.status).toBe(422);

    // A store_manager is not authorized.
    const forbidden = await request(ctx.app)
      .patch(`/api/products/${rawId}/cost`)
      .set('Authorization', `Bearer ${store.token}`)
      .send({ cost_per_unit: 100 });
    expect(forbidden.status).toBe(403);
  });
});
