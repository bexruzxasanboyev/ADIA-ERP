/**
 * F4.9 — Delivery module integration tests.
 *
 * Coverage:
 *   - GET /api/delivery/tasks returns only replenishment_requests in
 *     delivery-relevant statuses (NEW, CHECK_STORE_SUPPLIER, SHIP_TO_REQUESTER).
 *   - `?status=` filter narrows to a single status.
 *   - `?assigned_to=<id>` filters to one user; `?assigned_to=unassigned`
 *     filters to nulls.
 *   - PATCH /api/delivery/tasks/:id/assign updates `assigned_to_user_id`
 *     and writes an audit log entry.
 *   - Assigning to null clears the assignment.
 *   - 422 on assigning a task that is in a non-delivery status.
 *   - RBAC: store_manager scoped; PM chain-wide.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import {
  makeLocation,
  makeProduct,
  makeUser,
  type SeededUser,
} from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

type World = {
  storeA: number;
  storeB: number;
  central: number;
  productCake: number;
  pm: SeededUser;
  managerA: SeededUser;
  managerB: SeededUser;
  courier: SeededUser;
  // Replenishment ids.
  reqNew: number;
  reqShip: number;
  reqCheckProd: number; // out-of-delivery status
  reqClosed: number;
};

async function seedWorld(): Promise<World> {
  const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'Store A' });
  const storeB = await makeLocation(ctx.db, { type: 'store', name: 'Store B' });
  // One product per replenishment_request — the `uq_replenishment_one_open`
  // partial unique index forbids two open requests on the same
  // (product, requester_location).
  const productCake = await makeProduct(ctx.db, { type: 'finished', name: 'Cake' });
  const productBread = await makeProduct(ctx.db, { type: 'finished', name: 'Bread' });
  const productJuice = await makeProduct(ctx.db, { type: 'finished', name: 'Juice' });
  const productMilk = await makeProduct(ctx.db, { type: 'finished', name: 'Milk' });

  const pm = await makeUser(ctx.db, { role: 'pm' });
  const managerA = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeA,
  });
  const managerB = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeB,
  });
  // The "courier" is just another store_manager in this fixture — what matters
  // for PATCH /assign is that the user row exists and is_active.
  const courier = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeA,
  });

  const insert = async (
    status: string,
    requester: number,
    product: number,
  ): Promise<number> => {
    const { rows } = await ctx.db.query<{ id: string }>(
      `INSERT INTO replenishment_requests
         (product_id, requester_location_id, target_location_id, qty_needed,
          status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [product, requester, central, 10, status, pm.id],
    );
    return Number(rows[0]?.id);
  };

  const reqNew = await insert('NEW', storeA, productCake);
  const reqShip = await insert('SHIP_TO_REQUESTER', storeB, productCake);
  const reqCheckProd = await insert('CHECK_PRODUCTION_INPUT', storeA, productBread);
  const reqClosed = await insert('CLOSED', storeA, productJuice);
  // Discriminate productMilk so makeProduct value isn't flagged unused.
  void productMilk;

  return {
    storeA,
    storeB,
    central,
    productCake,
    pm,
    managerA,
    managerB,
    courier,
    reqNew,
    reqShip,
    reqCheckProd,
    reqClosed,
  };
}

describe('GET /api/delivery/tasks', () => {
  it('returns only delivery-relevant statuses (PM chain-wide)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/delivery/tasks')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => Number(r.id));
    expect(ids).toContain(w.reqNew);
    expect(ids).toContain(w.reqShip);
    expect(ids).not.toContain(w.reqCheckProd);
    expect(ids).not.toContain(w.reqClosed);
  });

  it('?status=NEW filters to NEW rows only', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/delivery/tasks?status=NEW')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    // The seeded NEW row is present; ship/check-prod/closed rows from this
    // seed are absent. Other tests in the file may have left earlier NEW rows.
    const ids = res.body.map((r: { id: number }) => Number(r.id));
    const statuses: string[] = res.body.map((r: { status: string }) => r.status);
    expect(ids).toContain(w.reqNew);
    expect(ids).not.toContain(w.reqShip);
    expect(ids).not.toContain(w.reqCheckProd);
    expect(ids).not.toContain(w.reqClosed);
    for (const s of statuses) {
      expect(s).toBe('NEW');
    }
  });

  it('?status=CHECK_PRODUCTION_INPUT (non-delivery) returns 422', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .get('/api/delivery/tasks?status=CHECK_PRODUCTION_INPUT')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(422);
  });

  it('store_manager scoped — sees only tasks touching its store', async () => {
    const w = await seedWorld();
    const aRes = await request(ctx.app)
      .get('/api/delivery/tasks')
      .set('Authorization', `Bearer ${w.managerA.token}`);
    expect(aRes.status).toBe(200);
    const aIds = aRes.body.map((r: { id: number }) => Number(r.id));
    expect(aIds).toContain(w.reqNew); // storeA
    expect(aIds).not.toContain(w.reqShip); // storeB

    const bRes = await request(ctx.app)
      .get('/api/delivery/tasks')
      .set('Authorization', `Bearer ${w.managerB.token}`);
    expect(bRes.status).toBe(200);
    const bIds = bRes.body.map((r: { id: number }) => Number(r.id));
    expect(bIds).toContain(w.reqShip);
    expect(bIds).not.toContain(w.reqNew);
  });

  it('?assigned_to=unassigned shows only NULL rows', async () => {
    const w = await seedWorld();
    // Assign reqNew to the courier; reqShip stays unassigned.
    await ctx.db.query(
      `UPDATE replenishment_requests SET assigned_to_user_id = $1 WHERE id = $2`,
      [w.courier.id, w.reqNew],
    );
    const res = await request(ctx.app)
      .get('/api/delivery/tasks?assigned_to=unassigned')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: { id: number }) => Number(r.id));
    expect(ids).toContain(w.reqShip);
    expect(ids).not.toContain(w.reqNew);
  });
});

describe('PATCH /api/delivery/tasks/:id/assign', () => {
  it('assigns a user, persists the change and audit-logs it', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .patch(`/api/delivery/tasks/${w.reqNew}/assign`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ user_id: w.courier.id });
    expect(res.status).toBe(200);
    expect(Number(res.body.task.assigned_to_user_id)).toBe(w.courier.id);

    const fresh = await ctx.db.query<{ assigned_to_user_id: string | null }>(
      `SELECT assigned_to_user_id FROM replenishment_requests WHERE id = $1`,
      [w.reqNew],
    );
    expect(Number(fresh.rows[0]?.assigned_to_user_id)).toBe(w.courier.id);

    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE action = 'delivery.assign' AND entity_id = $1`,
      [w.reqNew],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('user_id=null clears the assignment', async () => {
    const w = await seedWorld();
    // Pre-assign.
    await ctx.db.query(
      `UPDATE replenishment_requests SET assigned_to_user_id = $1 WHERE id = $2`,
      [w.courier.id, w.reqNew],
    );
    const res = await request(ctx.app)
      .patch(`/api/delivery/tasks/${w.reqNew}/assign`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ user_id: null });
    expect(res.status).toBe(200);
    expect(res.body.task.assigned_to_user_id).toBeNull();
  });

  it('refuses to assign a task in a non-delivery status (422)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .patch(`/api/delivery/tasks/${w.reqClosed}/assign`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ user_id: w.courier.id });
    expect(res.status).toBe(422);
  });

  it('store_manager cannot assign a task on another store (403)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .patch(`/api/delivery/tasks/${w.reqShip}/assign`)
      .set('Authorization', `Bearer ${w.managerA.token}`)
      .send({ user_id: w.courier.id });
    expect(res.status).toBe(403);
  });

  it('rejects a non-existent user with 422', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .patch(`/api/delivery/tasks/${w.reqNew}/assign`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ user_id: 9_999_999 });
    expect(res.status).toBe(422);
  });
});
