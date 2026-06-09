/**
 * cross-dept-flow §6.4 / F-B — the "Manba reja" HTTP route.
 *
 *   GET  /api/production-plan?product_id&qty&location_id   — analyze (read)
 *   POST /api/production-plan/execute                      — execute (write)
 *
 * RBAC mirrors the production dialog route: the sex's own production_manager
 * reads + executes; a foreign manager is 403; PM may READ (analyze) but is
 * blocked from the EXECUTE write (read-and-recommend rule).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

let raw: number;
let prodRoot: number;
let tortSexi: number;
let qaymoqSexi: number;
let qaymoqSkladi: number;
let cake: number;
let cream: number;
let mastika: number;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

async function addRecipe(productId: number, componentId: number, qty: number): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, $3, 'decoration'::recipe_stage)`,
    [productId, componentId, qty],
  );
}

beforeEach(async () => {
  const sfx = Math.random().toString(36).slice(2, 6);
  raw = await makeLocation(ctx.db, { type: 'raw_warehouse', name: `Raw ${sfx}` });
  prodRoot = await makeLocation(ctx.db, { type: 'production', name: `Prod ${sfx}`, parentId: raw });
  tortSexi = await makeLocation(ctx.db, { type: 'production', name: `Tort ${sfx}`, parentId: prodRoot });
  await makeLocation(ctx.db, { type: 'sex_storage', name: `Tort skladi ${sfx}`, parentId: tortSexi });
  qaymoqSexi = await makeLocation(ctx.db, { type: 'production', name: `Qaymoq ${sfx}`, parentId: prodRoot });
  qaymoqSkladi = await makeLocation(ctx.db, { type: 'sex_storage', name: `Qaymoq skladi ${sfx}`, parentId: qaymoqSexi });

  cake = await makeProduct(ctx.db, { name: `Napoleon ${sfx}`, type: 'finished', unit: 'pcs' });
  cream = await makeProduct(ctx.db, { name: `Krem ${sfx}`, type: 'semi', unit: 'kg' });
  mastika = await makeProduct(ctx.db, { name: `Mastika ${sfx}`, type: 'raw', unit: 'kg' });
  await ctx.db.query('UPDATE products SET workshop_location_id = $2 WHERE id = $1', [cream, qaymoqSexi]);
  await addRecipe(cake, cream, 1);
  await addRecipe(cake, mastika, 2);

  await setStock(ctx.db, { locationId: qaymoqSkladi, productId: cream, qty: 50 });
  await setStock(ctx.db, { locationId: raw, productId: mastika, qty: 500 });
});

describe('GET /api/production-plan', () => {
  it('returns the per-line plan for the sex operator', async () => {
    const tortMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: tortSexi });
    const res = await request(ctx.app)
      .get(`/api/production-plan?product_id=${cake}&qty=10&location_id=${tortSexi}`)
      .set('Authorization', `Bearer ${tortMgr.token}`);
    expect(res.status).toBe(200);
    expect(res.body.product_id).toBe(cake);
    expect(res.body.lines).toHaveLength(2);
    const creamLine = res.body.lines.find((l: { component_product_id: number }) => l.component_product_id === cream);
    expect(creamLine.kind).toBe('semi_producer');
    expect(creamLine.suggested).toBe('use_ready');
  });

  it('pm may read the plan (read-and-recommend)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get(`/api/production-plan?product_id=${cake}&qty=2&location_id=${tortSexi}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
  });

  it('403 for a foreign-location manager', async () => {
    const other = await makeLocation(ctx.db, { type: 'production' });
    const otherMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: other });
    const res = await request(ctx.app)
      .get(`/api/production-plan?product_id=${cake}&qty=2&location_id=${tortSexi}`)
      .set('Authorization', `Bearer ${otherMgr.token}`);
    expect(res.status).toBe(403);
  });

  it('401 without a token; 422 on a bad qty', async () => {
    const noTok = await request(ctx.app).get(`/api/production-plan?product_id=${cake}&qty=2&location_id=${tortSexi}`);
    expect(noTok.status).toBe(401);
    const tortMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: tortSexi });
    const badQty = await request(ctx.app)
      .get(`/api/production-plan?product_id=${cake}&qty=0&location_id=${tortSexi}`)
      .set('Authorization', `Bearer ${tortMgr.token}`);
    expect(badQty.status).toBe(422);
  });
});

describe('POST /api/production-plan/execute', () => {
  it('the sex operator executes the plan (reserve transfer applied)', async () => {
    const tortMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: tortSexi });
    const res = await request(ctx.app)
      .post('/api/production-plan/execute')
      .set('Authorization', `Bearer ${tortMgr.token}`)
      .send({
        product_id: cake,
        qty: 10,
        location_id: tortSexi,
        decisions: [
          { component_product_id: mastika, action: 'transfer' },
          { component_product_id: cream, action: 'use_ready' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.executed).toHaveLength(2);
    // mastika reserved: raw 500 → 480.
    const { rows } = await ctx.db.query<{ qty: string }>(
      `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
      [raw, mastika],
    );
    expect(Number(rows[0]?.qty)).toBe(480);
  });

  it('blocks PM from executing (write — read-and-recommend)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post('/api/production-plan/execute')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        product_id: cake,
        qty: 10,
        location_id: tortSexi,
        decisions: [{ component_product_id: mastika, action: 'transfer' }],
      });
    expect(res.status).toBe(403);
  });

  it('422 on an empty decisions array', async () => {
    const tortMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: tortSexi });
    const res = await request(ctx.app)
      .post('/api/production-plan/execute')
      .set('Authorization', `Bearer ${tortMgr.token}`)
      .send({ product_id: cake, qty: 10, location_id: tortSexi, decisions: [] });
    expect(res.status).toBe(422);
  });
});
