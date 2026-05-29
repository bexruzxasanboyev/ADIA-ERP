/**
 * EPIC 8.4 — nakladnoy HTTP route tests.
 *
 *   - POST generates a sectioned document for the operator's own location;
 *   - GET /:id returns header + lines, scoped to the operator's location;
 *   - PM (read-only) is blocked from POST (write) but may read;
 *   - a foreign-location operator is 403 on read of someone else's doc.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function recipe(p: number, c: number, q: number, stage: string): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, $3, $4::recipe_stage)`,
    [p, c, q, stage],
  );
}

describe('POST /api/nakladnoy', () => {
  it('generates a sectioned nakladnoy for the operator location', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const op = await makeUser(ctx.db, { role: 'production_manager', locationId: loc });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg', name: 'Un-r' });
    const cake = await makeProduct(ctx.db, { type: 'finished', unit: 'pcs', name: 'Tort-r' });
    await recipe(cake, flour, 0.5, 'base');

    const res = await request(ctx.app)
      .post('/api/nakladnoy')
      .set('Authorization', `Bearer ${op.token}`)
      .send({ product_id: cake, qty: 4, location_id: loc, source: 'sale' });

    expect(res.status).toBe(201);
    expect(res.body.header.qty).toBe(4);
    expect(res.body.header.source).toBe('sale');
    const hamir = res.body.lines.find(
      (l: { section: string; component_product_id: number }) =>
        l.section === 'hamir' && l.component_product_id === flour,
    );
    expect(hamir.qty).toBe(2);
  });

  it('blocks PM from generating (write = read-and-recommend)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const cake = await makeProduct(ctx.db, { type: 'finished' });

    const res = await request(ctx.app)
      .post('/api/nakladnoy')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ product_id: cake, qty: 1, location_id: loc });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/nakladnoy/:id', () => {
  it('forbids reading another location nakladnoy', async () => {
    const locA = await makeLocation(ctx.db, { type: 'production' });
    const locB = await makeLocation(ctx.db, { type: 'production' });
    const opA = await makeUser(ctx.db, { role: 'production_manager', locationId: locA });
    const opB = await makeUser(ctx.db, { role: 'production_manager', locationId: locB });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await recipe(cake, flour, 1, 'base');

    const created = await request(ctx.app)
      .post('/api/nakladnoy')
      .set('Authorization', `Bearer ${opA.token}`)
      .send({ product_id: cake, qty: 1, location_id: locA });
    expect(created.status).toBe(201);
    const id = created.body.header.id;

    const own = await request(ctx.app)
      .get(`/api/nakladnoy/${id}`)
      .set('Authorization', `Bearer ${opA.token}`);
    expect(own.status).toBe(200);

    const foreign = await request(ctx.app)
      .get(`/api/nakladnoy/${id}`)
      .set('Authorization', `Bearer ${opB.token}`);
    expect(foreign.status).toBe(403);
  });
});
