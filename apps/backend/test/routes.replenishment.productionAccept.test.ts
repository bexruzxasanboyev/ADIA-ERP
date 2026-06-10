/**
 * F-L / cross-dept-flow — PRODUCTION accept-gate (gate class d) + shipped_qty.
 *
 * Owner's round-2 E2E finding: when a request is routed to production and parked
 * at CHECK_PRODUCTION_INPUT with its PRODUCTION assigned to an отдел
 * (`COALESCE(po.location_id, p.workshop_location_id)`), the cron USED to auto-run
 * `advanceCheckProductionInput` on the next pass — consuming зг, transferring raw,
 * creating the production order / raw POs — WITHOUT the отдел manager accepting.
 *
 * Required flow: the row WAITS at the отдел (Kutuvda) until the отдел manager
 * ACCEPTS (POST /:id/accept-production, a pure fulfiller_accepted_at stamp); only
 * THEN does the next cron pass run advanceCheckProductionInput exactly as before.
 *
 * The discriminator is `fulfiller_accepted_at IS NULL`: a fresh routed row is
 * unstamped, so the gate holds it; the stamp clears the gate.
 *
 * shipped_qty: cards must show the ACTUALLY-shipped qty (a partial fulfil ships 4
 * of 10) — the linked shipment movement's qty — not qty_needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { createRequest, runEngineCycle } from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/**
 * The #35074-shaped production-bound chain that the cron drives to
 * CHECK_PRODUCTION_INPUT: raw -> central -> отдел(production) + its sex_storage,
 * plus an INTERNAL (non-store) requester hanging off central. A `finished` product
 * is produced at the отдел (workshop_location_id pinned) with a 1:1 raw BOM. The
 * requester needs it; central is EMPTY, so the cron parks the request at
 * CHECK_PRODUCTION_INPUT (production assigned to the отдел, fulfiller_accepted_at
 * NULL — the gated state).
 *
 * A NON-store requester is used on purpose: the pre-existing `rl.type <> 'store'`
 * cron exclusion keeps store-requester rows out of the auto-advance loop entirely,
 * so the class-d gate is exercised by an internal requester whose CHECK_STORE_
 * SUPPLIER -> CHECK_PRODUCTION_INPUT hop the cron performs.
 */
async function buildProductionBoundChain(opts: { rawQty?: number } = {}): Promise<{
  rawWh: number;
  central: number;
  workshop: number;
  sexStorage: number;
  requester: number;
  product: number;
  flour: number;
  requestId: number;
  workshopMgrToken: string;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
  const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
  const sexStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: workshop });
  // An internal supply dept off central (NOT a store) — the requester.
  const requester = await makeLocation(ctx.db, { type: 'supply', parentId: central });

  const product = await makeProduct(ctx.db, { type: 'finished' });
  const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
  // The отдел produces this product (the production binding the gate sees by).
  await ctx.db.query('UPDATE products SET workshop_location_id = $2 WHERE id = $1', [
    product,
    workshop,
  ]);
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
     VALUES ($1, $2, 1, 'base')`,
    [product, flour],
  );
  // Central EMPTY -> the request cannot ship and falls to CHECK_PRODUCTION_INPUT.
  await setStock(ctx.db, { locationId: central, productId: product, qty: 0 });
  await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: opts.rawQty ?? 100 });

  const row = await createRequest({
    productId: product,
    requesterLocationId: requester,
    qtyNeeded: 10,
    actorUserId: null,
    origin: 'scan',
  });

  const mgr = await makeUser(ctx.db, { role: 'production_manager', locationId: workshop });
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [mgr.id, workshop]);

  return {
    rawWh,
    central,
    workshop,
    sexStorage,
    requester,
    product,
    flour,
    requestId: row.id,
    workshopMgrToken: mgr.token,
  };
}

/** Drive cron cycles until the request reaches CHECK_PRODUCTION_INPUT (or give up). */
async function parkAtCheckProductionInput(requestId: number): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await runEngineCycle();
    if ((await readRow(requestId)).status === 'CHECK_PRODUCTION_INPUT') {
      return;
    }
  }
}

async function readRow(id: number): Promise<{
  status: string;
  target_location_id: number | null;
  fulfiller_accepted_at: Date | null;
  fulfiller_accepted_by: number | null;
  production_order_id: number | null;
  purchase_order_id: number | null;
  closure_reason: string | null;
}> {
  const { rows } = await ctx.db.query<{
    status: string;
    target_location_id: string | null;
    fulfiller_accepted_at: Date | null;
    fulfiller_accepted_by: string | null;
    production_order_id: string | null;
    purchase_order_id: string | null;
    closure_reason: string | null;
  }>(
    `SELECT status, target_location_id, fulfiller_accepted_at, fulfiller_accepted_by,
            production_order_id, purchase_order_id, closure_reason
       FROM replenishment_requests WHERE id = $1`,
    [id],
  );
  const r = rows[0]!;
  return {
    status: r.status,
    target_location_id: r.target_location_id === null ? null : Number(r.target_location_id),
    fulfiller_accepted_at: r.fulfiller_accepted_at,
    fulfiller_accepted_by:
      r.fulfiller_accepted_by === null ? null : Number(r.fulfiller_accepted_by),
    production_order_id: r.production_order_id === null ? null : Number(r.production_order_id),
    purchase_order_id: r.purchase_order_id === null ? null : Number(r.purchase_order_id),
    closure_reason: r.closure_reason,
  };
}

async function getQty(locationId: number, productId: number): Promise<number | null> {
  const { rows } = await ctx.db.query<{ qty: string }>(
    'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2',
    [locationId, productId],
  );
  return rows[0] ? Number(rows[0].qty) : null;
}

// ---------------------------------------------------------------------------
// 1. Cron gate (class d) — the WAIT
// ---------------------------------------------------------------------------
describe('runEngineCycle — production accept-gate (class d)', () => {
  it('leaves a CHECK_PRODUCTION_INPUT row (production-bound, unaccepted) UNTOUCHED', async () => {
    const c = await buildProductionBoundChain();
    await parkAtCheckProductionInput(c.requestId);

    const parked = await readRow(c.requestId);
    expect(parked.status).toBe('CHECK_PRODUCTION_INPUT');
    expect(parked.fulfiller_accepted_at).toBeNull();
    // Raw NOT yet consumed at the park point.
    expect(await getQty(c.rawWh, c.flour)).toBe(100);

    // Another full cron pass MUST NOT advance it (the gate holds it) — status +
    // target unchanged, raw still 100, no production / purchase order created.
    await runEngineCycle();
    const after = await readRow(c.requestId);
    expect(after.status).toBe('CHECK_PRODUCTION_INPUT'); // untouched
    expect(after.target_location_id).toBe(c.central); // target unchanged
    expect(after.production_order_id).toBeNull();
    expect(after.purchase_order_id).toBeNull();
    expect(await getQty(c.rawWh, c.flour)).toBe(100); // зг/raw NOT consumed
  });
});

// ---------------------------------------------------------------------------
// 2. accept-production — happy path + idempotent no-op
// ---------------------------------------------------------------------------
describe('POST /:id/accept-production', () => {
  it('stamps fulfiller_accepted_* AND drives the first hop; a re-call is 409', async () => {
    const c = await buildProductionBoundChain();
    await parkAtCheckProductionInput(c.requestId);
    const mgrId = (await readRow(c.requestId)).fulfiller_accepted_by; // null pre-accept
    expect(mgrId).toBeNull();

    const res = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/accept-production`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    // F-L v2: the accept itself RUNS the BOM/raw check in the same transaction
    // (store-requester rows never ride the cron, and the отдел gets instant
    // feedback) — so the row leaves CHECK_PRODUCTION_INPUT right here.
    expect(['CREATE_PRODUCTION_ORDER', 'CREATE_PURCHASE_ORDER']).toContain(
      res.body.request.status,
    );
    expect(res.body.request.fulfiller_accepted_at).not.toBeNull();

    const afterFirst = await readRow(c.requestId);
    expect(afterFirst.fulfiller_accepted_at).not.toBeNull();
    expect(afterFirst.fulfiller_accepted_by).not.toBeNull();
    const stampedBy = afterFirst.fulfiller_accepted_by;
    const stampedAt = afterFirst.fulfiller_accepted_at;

    // Second call — the row is past CHECK_PRODUCTION_INPUT now, so the gate
    // endpoint answers wrong-status 409; the stamp stays first-accept-wins.
    const res2 = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/accept-production`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`)
      .send({});
    expect(res2.status).toBe(409);
    const afterSecond = await readRow(c.requestId);
    expect(afterSecond.fulfiller_accepted_by).toBe(stampedBy); // unchanged
    expect(afterSecond.fulfiller_accepted_at).toEqual(stampedAt); // unchanged
  });
});

// ---------------------------------------------------------------------------
// 3. RBAC trio — foreign отдел 403, PM 403, отдел operator OK
// ---------------------------------------------------------------------------
describe('POST /:id/accept-production — RBAC', () => {
  it('the отдел operator may accept (OK)', async () => {
    const c = await buildProductionBoundChain();
    await parkAtCheckProductionInput(c.requestId);
    const ok = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/accept-production`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`)
      .send({});
    expect(ok.status).toBe(200);
  });

  it('an operator of a FOREIGN отдел is 403', async () => {
    const c = await buildProductionBoundChain();
    await parkAtCheckProductionInput(c.requestId);
    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/accept-production`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('PM is 403 (read-and-recommend write guard)', async () => {
    const c = await buildProductionBoundChain();
    await parkAtCheckProductionInput(c.requestId);
    const pm = await makeUser(ctx.db, { role: 'pm', locationId: null });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/accept-production`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('an unknown id is 404', async () => {
    // Any valid operator hits the not-found 404 BEFORE the RBAC location check
    // (resolveProductionLocationId returns null for an unknown id).
    const someWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const op = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: someWorkshop,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/99999999/accept-production`)
      .set('Authorization', `Bearer ${op.token}`)
      .send({});
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 4. wrong-status 409
// ---------------------------------------------------------------------------
describe('POST /:id/accept-production — wrong status', () => {
  it('returns 409 when the request is not at CHECK_PRODUCTION_INPUT', async () => {
    const c = await buildProductionBoundChain();
    // Force the row to a non-gated status while keeping the отдел binding (the
    // product still carries workshop_location_id, so RBAC resolves the отдел and
    // passes — the 409 must come from the status guard, not RBAC).
    await ctx.db.query(
      `UPDATE replenishment_requests SET status = 'CREATE_PRODUCTION_ORDER', target_location_id = $2 WHERE id = $1`,
      [c.requestId, c.central],
    );
    const res = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/accept-production`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`)
      .send({});
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 5. reject-production — cancels with closure_reason
// ---------------------------------------------------------------------------
describe('POST /:id/reject-production', () => {
  it('cancels the request with closure_reason=cancelled_by_fulfiller', async () => {
    const c = await buildProductionBoundChain();
    await parkAtCheckProductionInput(c.requestId);
    const res = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/reject-production`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`)
      .send({ reason: 'нет сырья' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('CANCELLED');
    expect(res.body.request.closure_reason).toBe('cancelled_by_fulfiller');

    const after = await readRow(c.requestId);
    expect(after.status).toBe('CANCELLED');
    expect(after.closure_reason).toBe('cancelled_by_fulfiller');
  });

  it('a FOREIGN отдел operator cannot reject (403)', async () => {
    const c = await buildProductionBoundChain();
    await parkAtCheckProductionInput(c.requestId);
    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/reject-production`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({ reason: 'x' });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 6. accept -> next cycle advances (the full loop — owner's required flow)
// ---------------------------------------------------------------------------
describe('production accept-gate — full loop', () => {
  it('gated row untouched by a cycle -> accept-production -> next cycle advances (raw sufficient -> production order)', async () => {
    const c = await buildProductionBoundChain({ rawQty: 100 });
    await parkAtCheckProductionInput(c.requestId);

    // A cycle leaves the gated row untouched (no production order, raw intact).
    await runEngineCycle();
    let row = await readRow(c.requestId);
    expect(row.status).toBe('CHECK_PRODUCTION_INPUT');
    expect(row.production_order_id).toBeNull();
    expect(await getQty(c.rawWh, c.flour)).toBe(100);

    // The отдел manager accepts (pure stamp).
    const accept = await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/accept-production`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`)
      .send({});
    expect(accept.status).toBe(200);
    expect(accept.body.accepted).toBe(true);

    // The NEXT cron pass now runs advanceCheckProductionInput exactly as before:
    // raw sufficient -> a production order is created, raw is transferred into
    // production (100 -> 90 for the 10-unit 1:1 BOM).
    await runEngineCycle();
    row = await readRow(c.requestId);
    expect(row.status).toBe('CREATE_PRODUCTION_ORDER');
    expect(row.production_order_id).not.toBeNull();
    expect(await getQty(c.rawWh, c.flour)).toBe(90);
  });

  it('raw SHORT -> accept -> next cycle creates a PURCHASE order', async () => {
    // Only 3 kg of flour but the BOM needs 10 -> a raw shortage -> purchase order.
    const c = await buildProductionBoundChain({ rawQty: 3 });
    await parkAtCheckProductionInput(c.requestId);

    await request(ctx.app)
      .post(`/api/replenishment/${c.requestId}/accept-production`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`)
      .send({});

    await runEngineCycle();
    const row = await readRow(c.requestId);
    expect(row.status).toBe('CREATE_PURCHASE_ORDER');
    expect(row.purchase_order_id).not.toBeNull();
    // Raw untouched (nothing transferred — we are buying the shortfall).
    expect(await getQty(c.rawWh, c.flour)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 7. shipped_qty on list / single / tree rows
// ---------------------------------------------------------------------------
describe('shipped_qty — list / single / tree', () => {
  /**
   * A partial fulfil: a store needs 10, central holds 4. The central manager
   * fulfils -> 4 shipped to the store (the original closes), the row carries
   * shipped_qty=4 while qty_needed stays 10.
   */
  async function buildPartialFulfil(): Promise<{
    central: number;
    store: number;
    requestId: number;
    cwmToken: string;
    storeMgrToken: string;
  }> {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });

    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    await ctx.db.query('UPDATE products SET workshop_location_id = $2 WHERE id = $1', [
      cake,
      workshop,
    ]);
    await ctx.db.query(
      `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, 1, 'base')`,
      [cake, flour],
    );
    await setStock(ctx.db, { locationId: store, productId: cake, qty: 0, minLevel: 3, maxLevel: 10 });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 4 });
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 100 });

    const row = await createRequest({
      productId: cake,
      requesterLocationId: store,
      qtyNeeded: 10,
      actorUserId: null,
    });
    const cwm = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });
    const storeMgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });
    await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [storeMgr.id, store]);

    // Partial fulfil: ships 4 of 10 -> the original closes carrying the shipment.
    const fulfil = await request(ctx.app)
      .post(`/api/replenishment/${row.id}/fulfill`)
      .set('Authorization', `Bearer ${cwm.token}`)
      .send({ location_id: central });
    expect(fulfil.status).toBe(200);
    expect(fulfil.body.shipped_qty).toBe(4);

    return { central, store, requestId: row.id, cwmToken: cwm.token, storeMgrToken: storeMgr.token };
  }

  it('list: the row carries shipped_qty=4 while qty_needed stays 10', async () => {
    const c = await buildPartialFulfil();
    const res = await request(ctx.app)
      .get('/api/replenishment')
      .set('Authorization', `Bearer ${c.storeMgrToken}`);
    expect(res.status).toBe(200);
    const found = res.body.find((r: { id: number }) => Number(r.id) === c.requestId);
    expect(found).toBeDefined();
    expect(Number(found.shipped_qty)).toBe(4);
    expect(Number(found.qty_needed)).toBe(10);
  });

  it('single: the row carries shipped_qty=4', async () => {
    const c = await buildPartialFulfil();
    const res = await request(ctx.app)
      .get(`/api/replenishment/${c.requestId}`)
      .set('Authorization', `Bearer ${c.storeMgrToken}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.request.shipped_qty)).toBe(4);
    expect(Number(res.body.request.qty_needed)).toBe(10);
  });

  it('tree: the root carries shipped_qty=4', async () => {
    const c = await buildPartialFulfil();
    const res = await request(ctx.app)
      .get(`/api/replenishment/${c.requestId}/tree`)
      .set('Authorization', `Bearer ${c.storeMgrToken}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.root.shipped_qty)).toBe(4);
  });

  it('a never-shipped request carries shipped_qty = null', async () => {
    const c = await buildProductionBoundChain();
    await parkAtCheckProductionInput(c.requestId);
    const res = await request(ctx.app)
      .get(`/api/replenishment/${c.requestId}`)
      .set('Authorization', `Bearer ${c.workshopMgrToken}`);
    expect(res.status).toBe(200);
    expect(res.body.request.shipped_qty).toBeNull();
  });
});
