/**
 * cross-dept-flow §4/§6 — workshop-linkage visibility (list + single + tree).
 *
 * A request whose PRODUCTION is assigned to a workshop (отдел) — via the
 * product's `workshop_location_id` before a production order exists, or the
 * production order's `location_id` once one does — must be VISIBLE to that
 * workshop's manager while the request is production-bound, even though the
 * workshop is neither the requester nor the (pinned) target.
 *
 *   GET /api/replenishment            — list: the workshop sees the row;
 *   GET /api/replenishment/:id        — single: the workshop may read it;
 *   GET /api/replenishment/:id/tree   — tree:   the workshop may read it.
 *
 * The SAME row stays INVISIBLE to an unrelated sex manager. Store/central
 * scoping is unchanged (asserted by the existing suites). `production_location_id`
 * is the pinned field: = workshop id when no production order, = po.location_id
 * once one exists.
 *
 * Live repro this models: request #34811 — product 2252 (НАПОЛЕОН ЦЕЛЫЙ,
 * workshop = Наполеон отдел), requester=Кукча, target=central, status
 * CREATE_PURCHASE_ORDER. The Наполеон отдел manager (pm-ws-14) got NOTHING.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import { createRequest } from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/**
 * The #34811-shaped chain: raw -> central -> workshop(production). A `finished`
 * product is produced at the workshop (workshop_location_id pinned). A store
 * requests it; the request is parked in a production-bound state (target=central,
 * status CREATE_PURCHASE_ORDER) — the workshop is neither requester nor target,
 * only the production owner. Returns ids + a workshop manager + a store.
 */
async function buildChain(): Promise<{
  rawWh: number;
  central: number;
  workshop: number;
  store: number;
  product: number;
  requestId: number;
  workshopMgrToken: string;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
  const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
  const store = await makeLocation(ctx.db, { type: 'store', parentId: central });

  const product = await makeProduct(ctx.db, { type: 'finished' });
  // The отдел produces this product (the production binding the workshop sees by).
  await ctx.db.query('UPDATE products SET workshop_location_id = $2 WHERE id = $1', [
    product,
    workshop,
  ]);

  // A store request, parked in a production-bound state with target=central
  // (mirrors #34811: requester=store, target=central, status CREATE_PURCHASE_ORDER).
  const row = await createRequest({
    productId: product,
    requesterLocationId: store,
    qtyNeeded: 10,
    actorUserId: null,
  });
  await ctx.db.query(
    `UPDATE replenishment_requests
        SET status = 'CREATE_PURCHASE_ORDER', target_location_id = $2
      WHERE id = $1`,
    [row.id, central],
  );

  const mgr = await makeUser(ctx.db, { role: 'production_manager', locationId: workshop });
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [mgr.id, workshop]);

  return {
    rawWh,
    central,
    workshop,
    store,
    product,
    requestId: row.id,
    workshopMgrToken: mgr.token,
  };
}

describe('workshop-linkage visibility — GET /api/replenishment (list)', () => {
  it('the workshop manager sees a #34811-shaped row + production_location_id = workshop id', async () => {
    const c = await buildChain();
    const res = await request(ctx.app)
      .get('/api/replenishment')
      .set('Authorization', `Bearer ${c.workshopMgrToken}`);
    expect(res.status).toBe(200);

    const found = res.body.find((r: { id: number }) => Number(r.id) === c.requestId);
    expect(found).toBeDefined();
    // pinned field present + equals the workshop id (no production order yet).
    expect(Number(found.production_location_id)).toBe(c.workshop);
    expect(found.production_location_name).toBeDefined();
  });

  it('the SAME row is INVISIBLE to an unrelated sex manager', async () => {
    const c = await buildChain();
    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });
    const res = await request(ctx.app)
      .get('/api/replenishment')
      .set('Authorization', `Bearer ${foreign.token}`);
    expect(res.status).toBe(200);
    const found = res.body.find((r: { id: number }) => Number(r.id) === c.requestId);
    expect(found).toBeUndefined();
  });

  it('a closed (store-side) row stays INVISIBLE to the workshop (production-bound states only)', async () => {
    const c = await buildChain();
    // Flip the row out of the production-bound set — CLOSED is store-side terminal.
    await ctx.db.query(
      `UPDATE replenishment_requests SET status = 'CLOSED' WHERE id = $1`,
      [c.requestId],
    );
    const res = await request(ctx.app)
      .get('/api/replenishment')
      .set('Authorization', `Bearer ${c.workshopMgrToken}`);
    expect(res.status).toBe(200);
    const found = res.body.find((r: { id: number }) => Number(r.id) === c.requestId);
    expect(found).toBeUndefined();
  });

  it('production_location_id = po.location_id once a production order exists', async () => {
    const c = await buildChain();
    // A production order at the workshop, linked to the request.
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO production_orders (product_id, qty, location_id, target_location_id, status, replenishment_id)
         VALUES ($1, 10, $2, $3, 'new', $4) RETURNING id`,
      [c.product, c.workshop, c.central, c.requestId],
    );
    const poId = Number(rows[0]?.id);
    await ctx.db.query(
      `UPDATE replenishment_requests SET production_order_id = $2 WHERE id = $1`,
      [c.requestId, poId],
    );

    const res = await request(ctx.app)
      .get('/api/replenishment')
      .set('Authorization', `Bearer ${c.workshopMgrToken}`);
    expect(res.status).toBe(200);
    const found = res.body.find((r: { id: number }) => Number(r.id) === c.requestId);
    expect(found).toBeDefined();
    // The COALESCE prefers po.location_id (still the workshop here, but resolved
    // from the production order, not the product binding).
    expect(Number(found.production_location_id)).toBe(c.workshop);
  });
});

describe('workshop-linkage visibility — GET /api/replenishment/:id (single)', () => {
  it('the workshop manager may READ the row; an unrelated sex manager is 403', async () => {
    const c = await buildChain();

    const ok = await request(ctx.app)
      .get(`/api/replenishment/${c.requestId}`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`);
    expect(ok.status).toBe(200);
    expect(Number(ok.body.request.id)).toBe(c.requestId);
    expect(Number(ok.body.request.production_location_id)).toBe(c.workshop);

    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });
    const forbidden = await request(ctx.app)
      .get(`/api/replenishment/${c.requestId}`)
      .set('Authorization', `Bearer ${foreign.token}`);
    expect(forbidden.status).toBe(403);
  });

  it('the workshop CANNOT read a closed (store-side) row', async () => {
    const c = await buildChain();
    await ctx.db.query(
      `UPDATE replenishment_requests SET status = 'CLOSED' WHERE id = $1`,
      [c.requestId],
    );
    const res = await request(ctx.app)
      .get(`/api/replenishment/${c.requestId}`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`);
    expect(res.status).toBe(403);
  });
});

describe('workshop-linkage visibility — GET /api/replenishment/:id/tree', () => {
  it('the workshop manager may READ the tree; an unrelated sex manager is 403', async () => {
    const c = await buildChain();

    const ok = await request(ctx.app)
      .get(`/api/replenishment/${c.requestId}/tree`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`);
    expect(ok.status).toBe(200);
    expect(Number(ok.body.root.id)).toBe(c.requestId);
    expect(Number(ok.body.root.production_location_id)).toBe(c.workshop);

    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });
    const forbidden = await request(ctx.app)
      .get(`/api/replenishment/${c.requestId}/tree`)
      .set('Authorization', `Bearer ${foreign.token}`);
    expect(forbidden.status).toBe(403);
  });
});
