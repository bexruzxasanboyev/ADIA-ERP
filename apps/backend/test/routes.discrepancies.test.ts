/**
 * TZ M9 — `/api/discrepancies` integration tests (RBAC scoping + triage).
 *
 *   GET   /api/discrepancies      — list + summary, filterable, RBAC-scoped.
 *   PATCH /api/discrepancies/:id  — acknowledge / resolve (pm or the location's
 *                                   manager; ai_assistant is read-only → 403).
 *
 * Focus: RBAC scoping (a store_manager sees ONLY their store), filters, the
 * summary spanning all statuses, and the PATCH triage + audit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, type SeededUser } from './helpers/fixtures.js';

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
  cake: number;
  bread: number;
  pm: SeededUser;
  ai: SeededUser;
  storeAManager: SeededUser;
  storeBManager: SeededUser;
  centralManager: SeededUser;
};

/** dedupe_key must be unique — a tiny counter keeps seed rows distinct. */
let seedCounter = 0;

async function insertDiscrepancy(opts: {
  kind: 'wrong_keyed' | 'negative_stock';
  locationId: number;
  productId: number;
  shortfall: number;
  status?: 'open' | 'acknowledged' | 'resolved';
  detectedAt?: string;
  txId?: number | null;
  sold?: number | null;
  had?: number | null;
}): Promise<number> {
  seedCounter += 1;
  const dedupeKey = `seed:${opts.kind}:${opts.locationId}:${opts.productId}:${seedCounter}`;
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO sales_discrepancies
       (kind, location_id, product_id, poster_transaction_id, sold_qty, had_qty,
        shortfall, status, detected_at, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()), $10)
     RETURNING id`,
    [
      opts.kind,
      opts.locationId,
      opts.productId,
      opts.txId === undefined ? null : opts.txId === null ? null : String(opts.txId),
      opts.sold ?? null,
      opts.had ?? null,
      opts.shortfall,
      opts.status ?? 'open',
      opts.detectedAt ?? null,
      dedupeKey,
    ],
  );
  return Number(rows[0]!.id);
}

async function seedWorld(): Promise<World> {
  await ctx.db.query('DELETE FROM sales_discrepancies');
  await ctx.db.query('DELETE FROM audit_log');
  await ctx.db.query('UPDATE locations SET manager_user_id = NULL');
  await ctx.db.query('DELETE FROM user_locations');
  await ctx.db.query('DELETE FROM users');
  await ctx.db.query('DELETE FROM products');
  await ctx.db.query('DELETE FROM locations');
  seedCounter = 0;

  const storeA = await makeLocation(ctx.db, { type: 'store', name: 'StoreA' });
  const storeB = await makeLocation(ctx.db, { type: 'store', name: 'StoreB' });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', name: 'Central' });
  const cake = await makeProduct(ctx.db, { name: 'Cake', type: 'finished', unit: 'pcs' });
  const bread = await makeProduct(ctx.db, { name: 'Bread', type: 'finished', unit: 'pcs' });

  const uniq = () => Math.random().toString(36).slice(2, 10);
  const pm = await makeUser(ctx.db, { role: 'pm', username: `pm_${uniq()}` });
  const ai = await makeUser(ctx.db, { role: 'ai_assistant', username: `ai_${uniq()}` });
  const storeAManager = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeA,
    username: `sa_${uniq()}`,
  });
  const storeBManager = await makeUser(ctx.db, {
    role: 'store_manager',
    locationId: storeB,
    username: `sb_${uniq()}`,
  });
  const centralManager = await makeUser(ctx.db, {
    role: 'central_warehouse_manager',
    locationId: central,
    username: `cm_${uniq()}`,
  });
  // Wire managers onto their locations (D6).
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [storeAManager.id, storeA]);
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [storeBManager.id, storeB]);
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [centralManager.id, central]);

  return { storeA, storeB, central, cake, bread, pm, ai, storeAManager, storeBManager, centralManager };
}

describe('GET /api/discrepancies — RBAC scoping', () => {
  it('pm sees every location; summary spans all statuses', async () => {
    const w = await seedWorld();
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 7, status: 'open', txId: 100, sold: 10, had: 3 });
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeB, productId: w.bread, shortfall: 2, status: 'acknowledged', txId: 101 });
    await insertDiscrepancy({ kind: 'negative_stock', locationId: w.central, productId: w.cake, shortfall: 4, status: 'resolved' });

    const res = await request(ctx.app)
      .get('/api/discrepancies')
      .set('Authorization', `Bearer ${w.pm.token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.summary).toEqual({
      open: 1,
      acknowledged: 1,
      resolved: 1,
      wrong_keyed: 2,
      negative_stock: 1,
    });
    // Embedded names (no second round trip on the client).
    const a = res.body.items.find((i: { location_id: number }) => i.location_id === w.storeA);
    expect(a.location_name).toBe('StoreA');
    expect(a.product_name).toBe('Cake');
    expect(a.poster_transaction_id).toBe('100');
    expect(a.sold_qty).toBe(10);
    expect(a.had_qty).toBe(3);
    expect(a.shortfall).toBe(7);
  });

  it('ai_assistant sees every location (read-only chain-wide)', async () => {
    const w = await seedWorld();
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, txId: 1 });
    await insertDiscrepancy({ kind: 'negative_stock', locationId: w.central, productId: w.cake, shortfall: 1 });
    const res = await request(ctx.app)
      .get('/api/discrepancies')
      .set('Authorization', `Bearer ${w.ai.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('store_manager sees ONLY their own store', async () => {
    const w = await seedWorld();
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 7, txId: 200 });
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeB, productId: w.bread, shortfall: 2, txId: 201 });
    await insertDiscrepancy({ kind: 'negative_stock', locationId: w.central, productId: w.cake, shortfall: 4 });

    const res = await request(ctx.app)
      .get('/api/discrepancies')
      .set('Authorization', `Bearer ${w.storeAManager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].location_id).toBe(w.storeA);
    // The summary is also scoped to storeA only.
    expect(res.body.summary.wrong_keyed).toBe(1);
    expect(res.body.summary.negative_stock).toBe(0);
  });

  it('rejects unauthenticated requests with 401', async () => {
    await seedWorld();
    const res = await request(ctx.app).get('/api/discrepancies');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/discrepancies — filters + pagination', () => {
  it('filters by kind (summary still spans every status of the filtered kind)', async () => {
    const w = await seedWorld();
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, status: 'open', txId: 1 });
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.bread, shortfall: 1, status: 'resolved', txId: 2 });
    await insertDiscrepancy({ kind: 'negative_stock', locationId: w.storeA, productId: w.cake, shortfall: 1, status: 'open' });

    const res = await request(ctx.app)
      .get('/api/discrepancies?kind=wrong_keyed')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.items.every((i: { kind: string }) => i.kind === 'wrong_keyed')).toBe(true);
    expect(res.body.summary).toEqual({
      open: 1,
      acknowledged: 0,
      resolved: 1,
      wrong_keyed: 2,
      negative_stock: 0,
    });
  });

  it('filters the items by status but keeps summary across all statuses', async () => {
    const w = await seedWorld();
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, status: 'open', txId: 1 });
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.bread, shortfall: 1, status: 'resolved', txId: 2 });

    const res = await request(ctx.app)
      .get('/api/discrepancies?status=open')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    // items filtered to open …
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe('open');
    // … but total + summary still span both statuses.
    expect(res.body.total).toBe(2);
    expect(res.body.summary.open).toBe(1);
    expect(res.body.summary.resolved).toBe(1);
  });

  it('filters by from/to date window (inclusive of the to-day)', async () => {
    const w = await seedWorld();
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, txId: 1, detectedAt: '2026-06-01T10:00:00Z' });
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.bread, shortfall: 1, txId: 2, detectedAt: '2026-06-05T10:00:00Z' });
    await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, txId: 3, detectedAt: '2026-06-09T10:00:00Z' });

    const res = await request(ctx.app)
      .get('/api/discrepancies?from=2026-06-02&to=2026-06-05')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1); // only the 06-05 row
  });

  it('paginates with limit/offset, newest first', async () => {
    const w = await seedWorld();
    for (let i = 0; i < 5; i += 1) {
      await insertDiscrepancy({
        kind: 'wrong_keyed',
        locationId: w.storeA,
        productId: w.cake,
        shortfall: 1,
        txId: 300 + i,
        detectedAt: `2026-06-0${i + 1}T10:00:00Z`,
      });
    }
    const page1 = await request(ctx.app)
      .get('/api/discrepancies?limit=2&offset=0')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(5);
    expect(page1.body.items).toHaveLength(2);
    // Newest first — 06-05 then 06-04.
    expect(page1.body.items[0].detected_at).toContain('2026-06-05');

    const page2 = await request(ctx.app)
      .get('/api/discrepancies?limit=2&offset=2')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.items[0].detected_at).toContain('2026-06-03');
  });

  it('rejects an unknown kind / status / malformed date with 422', async () => {
    const w = await seedWorld();
    const badKind = await request(ctx.app)
      .get('/api/discrepancies?kind=nope')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(badKind.status).toBe(422);
    const badStatus = await request(ctx.app)
      .get('/api/discrepancies?status=done')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(badStatus.status).toBe(422);
    const badDate = await request(ctx.app)
      .get('/api/discrepancies?from=2026-6-1')
      .set('Authorization', `Bearer ${w.pm.token}`);
    expect(badDate.status).toBe(422);
  });
});

describe('PATCH /api/discrepancies/:id — triage', () => {
  it('pm resolves a row: stamps resolved_by + resolved_at and writes an audit row', async () => {
    const w = await seedWorld();
    const id = await insertDiscrepancy({
      kind: 'wrong_keyed',
      locationId: w.storeA,
      productId: w.cake,
      shortfall: 7,
      txId: 100,
      sold: 10,
      had: 3,
    });
    const res = await request(ctx.app)
      .patch(`/api/discrepancies/${id}`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ status: 'resolved', note: 'reconciled with Poster' });

    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('resolved');
    expect(res.body.item.resolved_by).toBe(w.pm.id);
    expect(res.body.item.resolved_by_name).toBeTruthy();
    expect(res.body.item.resolved_at).toBeTruthy();
    expect(res.body.item.note).toBe('reconciled with Poster');
    // Item shape parity with the list (joined names present).
    expect(res.body.item.location_name).toBe('StoreA');
    expect(res.body.item.product_name).toBe('Cake');

    const { rows } = await ctx.db.query<{ action: string; entity: string; entity_id: string }>(
      `SELECT action, entity, entity_id FROM audit_log WHERE entity = 'sales_discrepancies'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('sales_discrepancy.update');
    expect(Number(rows[0]!.entity_id)).toBe(id);
  });

  it('acknowledge does NOT stamp a resolver; re-open clears it', async () => {
    const w = await seedWorld();
    const id = await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, txId: 1 });
    const ack = await request(ctx.app)
      .patch(`/api/discrepancies/${id}`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ status: 'acknowledged' });
    expect(ack.status).toBe(200);
    expect(ack.body.item.status).toBe('acknowledged');
    expect(ack.body.item.resolved_by).toBeNull();
    expect(ack.body.item.resolved_at).toBeNull();

    // resolve then re-open → resolver cleared.
    await request(ctx.app)
      .patch(`/api/discrepancies/${id}`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ status: 'resolved' });
    const reopen = await request(ctx.app)
      .patch(`/api/discrepancies/${id}`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ status: 'open' });
    expect(reopen.body.item.status).toBe('open');
    expect(reopen.body.item.resolved_by).toBeNull();
    expect(reopen.body.item.resolved_at).toBeNull();
  });

  it('the location manager may triage their own location row', async () => {
    const w = await seedWorld();
    const id = await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, txId: 1 });
    const res = await request(ctx.app)
      .patch(`/api/discrepancies/${id}`)
      .set('Authorization', `Bearer ${w.storeAManager.token}`)
      .send({ status: 'acknowledged' });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('acknowledged');
  });

  it('a manager of ANOTHER location is 403', async () => {
    const w = await seedWorld();
    const id = await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, txId: 1 });
    const res = await request(ctx.app)
      .patch(`/api/discrepancies/${id}`)
      .set('Authorization', `Bearer ${w.storeBManager.token}`)
      .send({ status: 'resolved' });
    expect(res.status).toBe(403);
  });

  it('ai_assistant is read-only — PATCH is 403', async () => {
    const w = await seedWorld();
    const id = await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, txId: 1 });
    const res = await request(ctx.app)
      .patch(`/api/discrepancies/${id}`)
      .set('Authorization', `Bearer ${w.ai.token}`)
      .send({ status: 'resolved' });
    expect(res.status).toBe(403);
  });

  it('an unknown id is 404 (never an ownership leak)', async () => {
    const w = await seedWorld();
    const res = await request(ctx.app)
      .patch('/api/discrepancies/999999')
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ status: 'resolved' });
    expect(res.status).toBe(404);
  });

  it('an invalid status body is 422', async () => {
    const w = await seedWorld();
    const id = await insertDiscrepancy({ kind: 'wrong_keyed', locationId: w.storeA, productId: w.cake, shortfall: 1, txId: 1 });
    const res = await request(ctx.app)
      .patch(`/api/discrepancies/${id}`)
      .set('Authorization', `Bearer ${w.pm.token}`)
      .send({ status: 'done' });
    expect(res.status).toBe(422);
  });
});
