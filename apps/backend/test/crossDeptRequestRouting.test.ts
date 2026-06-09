/**
 * TZ §6 — cross-department request ROUTING refinement.
 *
 * The producer override: when a requested product is `type='semi'` (yarim
 * tayyor / зг) with a non-null `workshop_location_id`, `createCrossDeptRequest`
 * routes the request TARGET to that producing отдел's `sex_storage` buffer
 * (e.g. a sex asking the Qaymoq отдел for cream → "Qaymoq skladi"), instead of
 * the requester's topology parent. It also PINS `target_location_id` so the
 * RBAC check + the accept handler agree on the cream sklad as the fulfiller.
 *
 * Covered:
 *   - a semi WITH a workshop  → target = the workshop's sex_storage, pinned,
 *     producer-store manager notified, and the accept ships from THAT sklad;
 *   - a non-semi product      → target = the topology parent (UNCHANGED), no pin;
 *   - a semi WITHOUT a workshop → target = the topology parent (UNCHANGED), no pin.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { createCrossDeptRequest } from '../src/services/crossDeptRequest.js';
import { parseCallbackData, dispatchCallback } from '../src/integrations/telegram/dispatch.js';

let ctx: TestContext;
let prodRoot: number;
let qaymoqSexi: number;
let qaymoqSkladi: number;
let tortSexi: number;
let central: number;
let creamId: number;
let qaymoqStoreManager: number;
let tortManager: number;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

/** Set products.workshop_location_id directly (the fixture has no such field). */
async function setWorkshop(productId: number, workshopId: number | null): Promise<void> {
  await ctx.db.query('UPDATE products SET workshop_location_id = $2 WHERE id = $1', [
    productId,
    workshopId,
  ]);
}

beforeEach(async () => {
  const suffix = Math.random().toString(36).slice(2, 6);
  // raw -> production root -> { Qaymoq sexi -> Qaymoq skladi, Tort sexi } -> central.
  const raw = await makeLocation(ctx.db, { type: 'raw_warehouse', name: `Raw ${suffix}` });
  prodRoot = await makeLocation(ctx.db, {
    type: 'production',
    name: `Ishlab chiqarish ${suffix}`,
    parentId: raw,
  });
  qaymoqSexi = await makeLocation(ctx.db, {
    type: 'production',
    name: `Qaymoq sexi ${suffix}`,
    parentId: prodRoot,
  });
  qaymoqSkladi = await makeLocation(ctx.db, {
    type: 'sex_storage',
    name: `Qaymoq skladi ${suffix}`,
    parentId: qaymoqSexi,
  });
  tortSexi = await makeLocation(ctx.db, {
    type: 'production',
    name: `Tort sexi ${suffix}`,
    parentId: prodRoot,
  });
  central = await makeLocation(ctx.db, {
    type: 'central_warehouse',
    name: `Central ${suffix}`,
  });

  // The cream semi, produced by Qaymoq sexi.
  creamId = await makeProduct(ctx.db, { name: 'Qaymoq krem', type: 'semi', unit: 'kg' });
  await setWorkshop(creamId, qaymoqSexi);

  // Managers (D6): the Qaymoq SKLADI manager is the fulfiller; the Tort sexi
  // manager is the requester.
  const qsm = await makeUser(ctx.db, { role: 'supply_manager', locationId: qaymoqSkladi });
  qaymoqStoreManager = qsm.id;
  const tm = await makeUser(ctx.db, { role: 'production_manager', locationId: tortSexi });
  tortManager = tm.id;
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [
    qaymoqStoreManager,
    qaymoqSkladi,
  ]);
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [
    tortManager,
    tortSexi,
  ]);
});

describe('createCrossDeptRequest — TZ §6 producer override', () => {
  it('routes a semi-with-workshop to the producing отдел sklad, pins it, notifies that manager', async () => {
    const res = await createCrossDeptRequest({
      productId: creamId,
      productName: 'Qaymoq krem',
      unit: 'kg',
      requesterLocationId: tortSexi,
      qty: 5,
      actorUserId: tortManager,
    });

    // Target is the Qaymoq skladi (NOT the topology parent prodRoot).
    expect(res.target.locationId).toBe(qaymoqSkladi);
    expect(res.target.via).toBe('producer_store');
    expect(res.targetManagerNotified).toBe(true);
    expect(Number(res.request.requester_location_id)).toBe(tortSexi);

    // target_location_id is PINNED on the request (in DB and in the returned row).
    expect(Number(res.request.target_location_id)).toBe(qaymoqSkladi);
    const { rows } = await ctx.db.query<{ target_location_id: string | null }>(
      'SELECT target_location_id FROM replenishment_requests WHERE id = $1',
      [res.request.id],
    );
    expect(Number(rows[0]?.target_location_id)).toBe(qaymoqSkladi);

    // The Qaymoq skladi manager (NOT the prodRoot manager) got the xreq buttons.
    const { rows: notif } = await ctx.db.query<{
      inline_callback: { buttons: { text: string; data: string }[][] } | null;
    }>(
      `SELECT inline_callback FROM notifications
        WHERE recipient_user_id = $1 ORDER BY id DESC LIMIT 1`,
      [qaymoqStoreManager],
    );
    const data = (notif[0]?.inline_callback?.buttons ?? []).flat().map((b) => b.data);
    expect(data).toContain(`xreq:accept:${res.request.id}`);
  });

  it('accept by the producing sklad manager ships from THAT sklad (no regression)', async () => {
    // Stock the Qaymoq skladi so it can fulfil; requester starts empty.
    await setStock(ctx.db, { locationId: qaymoqSkladi, productId: creamId, qty: 50 });
    await setStock(ctx.db, { locationId: tortSexi, productId: creamId, qty: 0 });

    const res = await createCrossDeptRequest({
      productId: creamId,
      productName: 'Qaymoq krem',
      unit: 'kg',
      requesterLocationId: tortSexi,
      qty: 8,
      actorUserId: tortManager,
    });

    const parsed = parseCallbackData(`xreq:accept:${res.request.id}`)!;
    const outcome = await dispatchCallback(parsed, {
      userId: qaymoqStoreManager,
      role: 'supply_manager',
      locationId: qaymoqSkladi,
    });
    expect(outcome.kind).toBe('ok');

    // Request CLOSED; cream moved from the sklad (50 → 42) to the requester (0 → 8).
    const { rows: req } = await ctx.db.query<{ status: string }>(
      'SELECT status FROM replenishment_requests WHERE id = $1',
      [res.request.id],
    );
    expect(req[0]?.status).toBe('CLOSED');
    const { rows: skladStock } = await ctx.db.query<{ qty: string }>(
      'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2',
      [qaymoqSkladi, creamId],
    );
    expect(Number(skladStock[0]?.qty)).toBe(42);
    const { rows: tortStock } = await ctx.db.query<{ qty: string }>(
      'SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2',
      [tortSexi, creamId],
    );
    expect(Number(tortStock[0]?.qty)).toBe(8);
  });

  it('leaves a NON-semi product on the topology-parent path (unchanged, no pin)', async () => {
    const finished = await makeProduct(ctx.db, {
      name: 'Tort Napoleon',
      type: 'finished',
      unit: 'pcs',
    });
    // Even if (wrongly) given a workshop, a finished product must NOT be rerouted.
    await setWorkshop(finished, qaymoqSexi);

    const res = await createCrossDeptRequest({
      productId: finished,
      productName: 'Tort Napoleon',
      unit: 'pcs',
      requesterLocationId: tortSexi,
      qty: 3,
      actorUserId: tortManager,
    });

    // Target is the topology parent (prodRoot), NOT the cream sklad.
    expect(res.target.locationId).toBe(prodRoot);
    expect(res.target.via).toBe('parent');
    // No pin — the engine resolves the target itself at advanceNew.
    expect(res.request.target_location_id).toBeNull();
    const { rows } = await ctx.db.query<{ target_location_id: string | null }>(
      'SELECT target_location_id FROM replenishment_requests WHERE id = $1',
      [res.request.id],
    );
    expect(rows[0]?.target_location_id).toBeNull();
  });

  it('leaves a semi WITHOUT a workshop on the topology-parent path (unchanged)', async () => {
    const orphanSemi = await makeProduct(ctx.db, {
      name: 'Biskvit zagotovka',
      type: 'semi',
      unit: 'pcs',
    });
    // workshop_location_id stays NULL → no producer override.

    const res = await createCrossDeptRequest({
      productId: orphanSemi,
      productName: 'Biskvit zagotovka',
      unit: 'pcs',
      requesterLocationId: tortSexi,
      qty: 4,
      actorUserId: tortManager,
    });

    expect(res.target.locationId).toBe(prodRoot);
    expect(res.target.via).toBe('parent');
    expect(res.request.target_location_id).toBeNull();
  });
});
