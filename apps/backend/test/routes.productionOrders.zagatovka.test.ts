/**
 * cross-dept-flow §6 — POST /api/production-orders/zagatovka.
 *
 * A workshop self-fills its OWN yarim-tayyor (зг) buffer: produce `qty` of a
 * `semi` product AT the workshop, output into the workshop's lowest-id active
 * sex_storage child. Reuses `insertZagatovkaOrder` (stage_role='zagatovka',
 * location=workshop, target=sex_storage child).
 *
 * RBAC mirrors plan/execute: only the workshop's `production_manager` may act;
 * a foreign отдел manager is 403; PM is 403 (read-and-recommend write guard).
 * 422 when the product is not `semi`, or the workshop has no sex_storage child.
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

/**
 * A workshop with its own sex_storage child + a manager. raw -> central ->
 * workshop(production) -> sex_storage. Returns the ids + the manager token.
 */
async function buildWorkshop(opts: { withStorage?: boolean } = {}): Promise<{
  workshop: number;
  sexStorage: number | null;
  mgrToken: string;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
  const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
  let sexStorage: number | null = null;
  if (opts.withStorage !== false) {
    sexStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: workshop });
  }
  const mgr = await makeUser(ctx.db, { role: 'production_manager', locationId: workshop });
  return { workshop, sexStorage, mgrToken: mgr.token };
}

describe('POST /api/production-orders/zagatovka', () => {
  it('happy path — creates a stage_role=zagatovka order targeting the sex_storage child', async () => {
    const w = await buildWorkshop();
    const semi = await makeProduct(ctx.db, { type: 'semi' });

    const res = await request(ctx.app)
      .post('/api/production-orders/zagatovka')
      .set('Authorization', `Bearer ${w.mgrToken}`)
      .send({ location_id: w.workshop, product_id: semi, qty: 8 });

    expect(res.status).toBe(201);
    const po = res.body.production_order;
    expect(po).toBeDefined();
    expect(Number(po.product_id)).toBe(semi);
    expect(Number(po.qty)).toBe(8);
    expect(Number(po.location_id)).toBe(w.workshop);
    // target = the workshop's sex_storage child; stage_role = zagatovka; status new.
    expect(Number(po.target_location_id)).toBe(w.sexStorage);
    expect(po.stage_role).toBe('zagatovka');
    expect(po.status).toBe('new');
    expect(po.parent_production_order_id).toBeNull();

    // Audit row for the self-fill exists.
    const { rows: audit } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE entity = 'production_orders' AND entity_id = $1
          AND action = 'production_order.zagatovka_selffill'`,
      [Number(po.id)],
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('foreign отдел manager is 403', async () => {
    const w = await buildWorkshop();
    const semi = await makeProduct(ctx.db, { type: 'semi' });
    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });

    const res = await request(ctx.app)
      .post('/api/production-orders/zagatovka')
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({ location_id: w.workshop, product_id: semi, qty: 8 });
    expect(res.status).toBe(403);
  });

  it('PM is 403 (read-and-recommend write guard)', async () => {
    const w = await buildWorkshop();
    const semi = await makeProduct(ctx.db, { type: 'semi' });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const res = await request(ctx.app)
      .post('/api/production-orders/zagatovka')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ location_id: w.workshop, product_id: semi, qty: 8 });
    expect(res.status).toBe(403);
  });

  it('422 — the product is not a semi', async () => {
    const w = await buildWorkshop();
    const finished = await makeProduct(ctx.db, { type: 'finished' });

    const res = await request(ctx.app)
      .post('/api/production-orders/zagatovka')
      .set('Authorization', `Bearer ${w.mgrToken}`)
      .send({ location_id: w.workshop, product_id: finished, qty: 8 });
    expect(res.status).toBe(422);
    // Nothing created.
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM production_orders WHERE location_id = $1`,
      [w.workshop],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('422 — the workshop has no sex_storage child', async () => {
    const w = await buildWorkshop({ withStorage: false });
    const semi = await makeProduct(ctx.db, { type: 'semi' });

    const res = await request(ctx.app)
      .post('/api/production-orders/zagatovka')
      .set('Authorization', `Bearer ${w.mgrToken}`)
      .send({ location_id: w.workshop, product_id: semi, qty: 8 });
    expect(res.status).toBe(422);
    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM production_orders WHERE location_id = $1`,
      [w.workshop],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('422 on a non-positive qty (boundary validation)', async () => {
    const w = await buildWorkshop();
    const semi = await makeProduct(ctx.db, { type: 'semi' });
    const res = await request(ctx.app)
      .post('/api/production-orders/zagatovka')
      .set('Authorization', `Bearer ${w.mgrToken}`)
      .send({ location_id: w.workshop, product_id: semi, qty: 0 });
    expect(res.status).toBe(422);
  });
});
