/**
 * GET /api/products/yarim-tayyor — отдел зг (yarim tayyor) derivation.
 *
 * Asserts the TZ §6 refinement: a отдел's зг set is seeded from BOTH the
 * finished products it makes (whose BOM is walked) AND any зг it DIRECTLY
 * produces (`semi.workshop_location_id = отдел`). The cream отдел (Qaymoq sexi)
 * makes a semi but no finished product, so without the direct-semi seed its зг
 * tab would be empty.
 *
 * Driven as `pm` with `?workshop_location_id=` (the per-отдел scope) so the test
 * does not depend on the X-Active-Location plumbing.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;
let pmToken: string;
let qaymoqSexi: number;
let tortSexi: number;
let creamId: number;
let spongeId: number;
let cakeId: number;

beforeAll(async () => {
  ctx = await createTestContext();
  const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
  pmToken = pm.token;
});
afterAll(async () => {
  await ctx.dispose();
});

async function setWorkshop(productId: number, workshopId: number): Promise<void> {
  await ctx.db.query('UPDATE products SET workshop_location_id = $2 WHERE id = $1', [
    productId,
    workshopId,
  ]);
}

beforeEach(async () => {
  const suffix = Math.random().toString(36).slice(2, 6);
  const root = await makeLocation(ctx.db, { type: 'production', name: `Root ${suffix}` });
  // A real Poster workshop needs poster_workshop_id; the cream отдел is app-owned.
  qaymoqSexi = await makeLocation(ctx.db, {
    type: 'production',
    name: `Qaymoq sexi ${suffix}`,
    parentId: root,
  });
  tortSexi = await makeLocation(ctx.db, {
    type: 'production',
    name: `Tort sexi ${suffix}`,
    parentId: root,
    posterWorkshopId: 9000 + Math.floor(Math.random() * 1000),
  });

  // Cream: a semi DIRECTLY produced by Qaymoq sexi (no finished product there).
  creamId = await makeProduct(ctx.db, { name: 'Qaymoq krem', type: 'semi', unit: 'kg' });
  await setWorkshop(creamId, qaymoqSexi);

  // Sponge: a semi reachable via a finished cake made in Tort sexi.
  spongeId = await makeProduct(ctx.db, { name: 'Biskvit zagotovka', type: 'semi', unit: 'pcs' });
  cakeId = await makeProduct(ctx.db, { name: 'Tort', type: 'finished', unit: 'pcs' });
  await setWorkshop(cakeId, tortSexi);
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit) VALUES ($1, $2, 1)`,
    [cakeId, spongeId],
  );
});

describe('GET /api/products/yarim-tayyor — отдел derivation', () => {
  it('returns a DIRECTLY-produced semi for the cream отдел (TZ §6)', async () => {
    const res = await request(ctx.app)
      .get(`/api/products/yarim-tayyor?workshop_location_id=${qaymoqSexi}`)
      .set('Authorization', `Bearer ${pmToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((p) => Number(p.id));
    expect(ids).toContain(creamId);
    // The cream отдел makes no finished product, so the sponge must NOT leak in.
    expect(ids).not.toContain(spongeId);
  });

  it('still returns a BOM-reachable semi for a отдел with finished products', async () => {
    const res = await request(ctx.app)
      .get(`/api/products/yarim-tayyor?workshop_location_id=${tortSexi}`)
      .set('Authorization', `Bearer ${pmToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((p) => Number(p.id));
    expect(ids).toContain(spongeId); // reachable via the cake's BOM
    expect(ids).not.toContain(creamId); // cream belongs to the other отдел
  });

  it('PM with no filter returns every type=semi product (cream + sponge)', async () => {
    const res = await request(ctx.app)
      .get('/api/products/yarim-tayyor')
      .set('Authorization', `Bearer ${pmToken}`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((p) => Number(p.id));
    expect(ids).toEqual(expect.arrayContaining([creamId, spongeId]));
  });
});
