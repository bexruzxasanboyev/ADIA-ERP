/**
 * cross-dept-flow §6.4 / F-B — the N-component "Manba reja" resolver tests.
 *
 * Fixture: a finished cake (Napoleon) whose DECORATION BOM has THREE lines:
 *   - крем каймак (semi, producer = Qaymoq sexi, a FOREIGN producer);
 *   - biskvit z/g  (semi, producer = the Tort sexi itself — semi_own);
 *   - mastika      (raw — bezak).
 *
 * Topology (mirrors crossDeptRequestRouting.test.ts):
 *   raw_warehouse → prodRoot → { Tort sexi → Tort skladi, Qaymoq sexi → Qaymoq skladi }.
 *
 * Covers:
 *   - analyze: kinds (semi_producer / semi_own / raw), producer-storage
 *     availability (the v2 fix — a foreign semi is read at the PRODUCER's sklad),
 *     suggested actions, and open_request_id surfacing;
 *   - execute happy path: reserve movement + zagatovka sub-order + producer
 *     sub-request, all emitted in ONE atomic transaction;
 *   - execute rollback: an INSUFFICIENT_STOCK on a later line rolls back EVERY
 *     earlier document;
 *   - execute OPEN_REQUEST_EXISTS: a producer `'order'` collides with an open
 *     child → links a waiter + tops the qty up (and does NOT top up once the
 *     child has advanced past NEW — decision #9).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import {
  analyzeProductionPlan,
  executeProductionPlan,
} from '../src/services/productionPlan.js';
import { createRequest } from '../src/services/replenishment.js';
import { poolRunner } from '../src/lib/audit.js';

let ctx: TestContext;

// Topology + product handles, rebuilt per test for isolation.
let raw: number;
let prodRoot: number;
let tortSexi: number;
let tortSkladi: number;
let qaymoqSexi: number;
let qaymoqSkladi: number;
let central: number;
let cake: number;
let cream: number; // semi, foreign producer (Qaymoq)
let biskvit: number; // semi, own producer (Tort)
let mastika: number; // raw (bezak)
let qaymoqSkladiManager: number;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

async function setWorkshop(productId: number, workshopId: number | null): Promise<void> {
  await ctx.db.query('UPDATE products SET workshop_location_id = $2 WHERE id = $1', [
    productId,
    workshopId,
  ]);
}

async function addRecipe(
  productId: number,
  componentId: number,
  qtyPerUnit: number,
  stage: 'base' | 'decoration' | 'assembly',
): Promise<void> {
  await ctx.db.query(
    `INSERT INTO recipes (product_id, component_product_id, qty_per_unit, stage)
       VALUES ($1, $2, $3, $4::recipe_stage)`,
    [productId, componentId, qtyPerUnit, stage],
  );
}

beforeEach(async () => {
  const sfx = Math.random().toString(36).slice(2, 6);
  raw = await makeLocation(ctx.db, { type: 'raw_warehouse', name: `Raw ${sfx}` });
  prodRoot = await makeLocation(ctx.db, { type: 'production', name: `Prod ${sfx}`, parentId: raw });
  tortSexi = await makeLocation(ctx.db, {
    type: 'production',
    name: `Tort sexi ${sfx}`,
    parentId: prodRoot,
  });
  tortSkladi = await makeLocation(ctx.db, {
    type: 'sex_storage',
    name: `Tort skladi ${sfx}`,
    parentId: tortSexi,
  });
  qaymoqSexi = await makeLocation(ctx.db, {
    type: 'production',
    name: `Qaymoq sexi ${sfx}`,
    parentId: prodRoot,
  });
  qaymoqSkladi = await makeLocation(ctx.db, {
    type: 'sex_storage',
    name: `Qaymoq skladi ${sfx}`,
    parentId: qaymoqSexi,
  });
  central = await makeLocation(ctx.db, { type: 'central_warehouse', name: `Central ${sfx}`, parentId: prodRoot });

  cake = await makeProduct(ctx.db, { name: `Napoleon ${sfx}`, type: 'finished', unit: 'pcs' });
  cream = await makeProduct(ctx.db, { name: `Krem kaymak ${sfx}`, type: 'semi', unit: 'kg' });
  biskvit = await makeProduct(ctx.db, { name: `Biskvit zg ${sfx}`, type: 'semi', unit: 'pcs' });
  mastika = await makeProduct(ctx.db, { name: `Mastika ${sfx}`, type: 'raw', unit: 'kg' });

  await setWorkshop(cream, qaymoqSexi); // foreign producer
  await setWorkshop(biskvit, tortSexi); // own producer

  // The Qaymoq SKLADI manager — the fulfiller of a cream sub-request (§11).
  const qsm = await makeUser(ctx.db, { role: 'supply_manager', locationId: qaymoqSkladi });
  qaymoqSkladiManager = qsm.id;
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [
    qaymoqSkladiManager,
    qaymoqSkladi,
  ]);

  // Decoration BOM: 1 cream + 1 biskvit + 2 mastika per cake.
  await addRecipe(cake, cream, 1, 'decoration');
  await addRecipe(cake, biskvit, 1, 'decoration');
  await addRecipe(cake, mastika, 2, 'decoration');
});

describe('analyzeProductionPlan — classification + producer-aware availability', () => {
  it('classifies the three kinds and reads a foreign semi at the PRODUCER sklad', async () => {
    // Cream ready at the Qaymoq sklad (the producer's storage), NOT at Tort's.
    await setStock(ctx.db, { locationId: qaymoqSkladi, productId: cream, qty: 20 });
    await setStock(ctx.db, { locationId: tortSkladi, productId: cream, qty: 999 }); // must be IGNORED
    // Biskvit (own) short everywhere → suggested 'make'.
    await setStock(ctx.db, { locationId: tortSkladi, productId: biskvit, qty: 3 });
    // Mastika (raw) plenty at the raw warehouse → suggested 'transfer'.
    await setStock(ctx.db, { locationId: raw, productId: mastika, qty: 500 });

    const plan = await analyzeProductionPlan(poolRunner, {
      productId: cake,
      qty: 10,
      sexLocationId: tortSexi,
    });
    expect(plan.product_id).toBe(cake);
    expect(plan.qty).toBe(10);
    expect(plan.location_id).toBe(tortSexi);
    expect(plan.lines).toHaveLength(3);

    const creamLine = plan.lines.find((l) => l.component_product_id === cream)!;
    expect(creamLine.kind).toBe('semi_producer');
    expect(creamLine.producer?.location_id).toBe(qaymoqSexi);
    expect(creamLine.producer?.storage_location_id).toBe(qaymoqSkladi);
    // need = 1 × 10 = 10; cream sklad holds 20 ⇒ at_source 20, covers it.
    expect(creamLine.need).toBe(10);
    expect(creamLine.available.at_source).toBe(20); // the PRODUCER's sklad, not Tort's 999
    expect(creamLine.available.at_raw).toBeNull();
    expect(creamLine.qty_ready).toBe(10);
    expect(creamLine.suggested).toBe('use_ready');

    const biskvitLine = plan.lines.find((l) => l.component_product_id === biskvit)!;
    expect(biskvitLine.kind).toBe('semi_own');
    expect(biskvitLine.producer?.location_id).toBe(tortSexi);
    // need 10, own sklad holds 3 ⇒ short ⇒ make.
    expect(biskvitLine.available.at_source).toBe(3);
    expect(biskvitLine.qty_ready).toBe(3);
    expect(biskvitLine.suggested).toBe('make');

    const mastikaLine = plan.lines.find((l) => l.component_product_id === mastika)!;
    expect(mastikaLine.kind).toBe('raw');
    expect(mastikaLine.producer).toBeNull();
    // need = 2 × 10 = 20; raw warehouse holds 500 ⇒ transfer.
    expect(mastikaLine.need).toBe(20);
    expect(mastikaLine.available.at_raw).toBe(500);
    expect(mastikaLine.qty_ready).toBe(20);
    expect(mastikaLine.suggested).toBe('transfer');
  });

  it('suggests "order" for a short foreign semi and surfaces an open request', async () => {
    // Cream short at the producer sklad → suggested 'order'.
    await setStock(ctx.db, { locationId: qaymoqSkladi, productId: cream, qty: 1 });
    // Pre-existing OPEN request PINNED to the Qaymoq sklad for cream.
    const open = await createRequest({
      productId: cream,
      requesterLocationId: tortSexi,
      qtyNeeded: 4,
      actorUserId: null,
    });
    await ctx.db.query(
      `UPDATE replenishment_requests SET target_location_id = $2 WHERE id = $1`,
      [open.id, qaymoqSkladi],
    );

    const plan = await analyzeProductionPlan(poolRunner, {
      productId: cake,
      qty: 5,
      sexLocationId: tortSexi,
    });
    const creamLine = plan.lines.find((l) => l.component_product_id === cream)!;
    expect(creamLine.suggested).toBe('order');
    expect(creamLine.open_request_id).toBe(open.id);
  });

  it('classifies a semi with NO producer as semi_inplace', async () => {
    await setWorkshop(biskvit, null); // strip the producer link
    const plan = await analyzeProductionPlan(poolRunner, {
      productId: cake,
      qty: 2,
      sexLocationId: tortSexi,
    });
    const biskvitLine = plan.lines.find((l) => l.component_product_id === biskvit)!;
    expect(biskvitLine.kind).toBe('semi_inplace');
    expect(biskvitLine.producer).toBeNull();
    expect(biskvitLine.suggested).toBe('make');
  });
});

describe('executeProductionPlan — atomic document emission', () => {
  it('happy path: reserve movement + zagatovka + producer sub-request, all linked', async () => {
    await setStock(ctx.db, { locationId: qaymoqSkladi, productId: cream, qty: 0 }); // order
    await setStock(ctx.db, { locationId: raw, productId: mastika, qty: 500 }); // transfer
    // root request the plan hangs off (a Tort production request).
    const root = await createRequest({
      productId: cake,
      requesterLocationId: tortSexi,
      qtyNeeded: 10,
      actorUserId: null,
    });

    const res = await executeProductionPlan({
      requestId: root.id,
      productId: cake,
      qty: 10,
      sexLocationId: tortSexi,
      decisions: [
        { component_product_id: mastika, action: 'transfer' },
        { component_product_id: biskvit, action: 'make' },
        { component_product_id: cream, action: 'order' },
      ],
      actorUserId: null,
    });

    expect(res.executed).toHaveLength(3);
    const mastikaEx = res.executed.find((e) => e.component_product_id === mastika)!;
    expect(mastikaEx.action).toBe('transfer');
    expect(mastikaEx.movement_id).toBeGreaterThan(0);
    const biskvitEx = res.executed.find((e) => e.component_product_id === biskvit)!;
    expect(biskvitEx.production_order_id).toBeGreaterThan(0);
    const creamEx = res.executed.find((e) => e.component_product_id === cream)!;
    expect(creamEx.request_id).toBeGreaterThan(0);

    // Reserve transfer landed: 20 mastika moved raw(500→480) → Tort sexi(0→20).
    const { rows: rawStock } = await ctx.db.query<{ qty: string }>(
      `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
      [raw, mastika],
    );
    expect(Number(rawStock[0]?.qty)).toBe(480);
    const { rows: sexStock } = await ctx.db.query<{ qty: string }>(
      `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
      [tortSexi, mastika],
    );
    expect(Number(sexStock[0]?.qty)).toBe(20);
    // The reserve movement carries note='reserve' + the root replenishment id.
    const { rows: mv } = await ctx.db.query<{ note: string | null; replenishment_id: string | null }>(
      `SELECT note, replenishment_id FROM stock_movements WHERE id = $1`,
      [mastikaEx.movement_id],
    );
    expect(mv[0]?.note).toBe('reserve');
    expect(Number(mv[0]?.replenishment_id)).toBe(root.id);

    // The zagatovka sub-order: stage_role + target = Tort skladi + parent NULL.
    const { rows: zg } = await ctx.db.query<{
      stage_role: string;
      target_location_id: string;
      qty: string;
    }>(
      `SELECT stage_role, target_location_id, qty FROM production_orders WHERE id = $1`,
      [biskvitEx.production_order_id],
    );
    expect(zg[0]?.stage_role).toBe('zagatovka');
    expect(Number(zg[0]?.target_location_id)).toBe(tortSkladi);
    expect(Number(zg[0]?.qty)).toBe(10);

    // The producer sub-request: linked into the tree, pinned to the Qaymoq sklad.
    const { rows: sub } = await ctx.db.query<{
      requester_location_id: string;
      target_location_id: string | null;
      parent_request_id: string | null;
      root_request_id: string | null;
      depth: number;
      origin: string;
    }>(
      `SELECT requester_location_id, target_location_id, parent_request_id,
              root_request_id, depth, origin
         FROM replenishment_requests WHERE id = $1`,
      [creamEx.request_id],
    );
    expect(Number(sub[0]?.requester_location_id)).toBe(tortSexi);
    expect(Number(sub[0]?.target_location_id)).toBe(qaymoqSkladi); // pinned (producer override)
    expect(Number(sub[0]?.parent_request_id)).toBe(root.id);
    expect(Number(sub[0]?.root_request_id)).toBe(root.id); // root is a root ⇒ self
    expect(Number(sub[0]?.depth)).toBe(1);
    expect(sub[0]?.origin).toBe('dialog');

    // The root is NOT advanced — it waits (§7-A). Still NEW.
    const { rows: rootRow } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM replenishment_requests WHERE id = $1`,
      [root.id],
    );
    expect(rootRow[0]?.status).toBe('NEW');

    // §11 — the Qaymoq sklad manager got the producer sub-request with xreq buttons
    // (post-commit, best-effort).
    const { rows: notif } = await ctx.db.query<{
      inline_callback: { buttons: { text: string; data: string }[][] } | null;
    }>(
      `SELECT inline_callback FROM notifications WHERE recipient_user_id = $1 ORDER BY id DESC LIMIT 1`,
      [qaymoqSkladiManager],
    );
    const data = (notif[0]?.inline_callback?.buttons ?? []).flat().map((b) => b.data);
    expect(data).toContain(`xreq:accept:${creamEx.request_id}`);
  });

  it('rolls back EVERYTHING when a later line fails (INSUFFICIENT_STOCK)', async () => {
    // Mastika reserve will succeed; the cream `use_ready` will FAIL (nothing at
    // the Qaymoq sklad to reserve) — the whole transaction must roll back, so the
    // mastika movement must NOT persist.
    await setStock(ctx.db, { locationId: raw, productId: mastika, qty: 500 });
    await setStock(ctx.db, { locationId: qaymoqSkladi, productId: cream, qty: 0 });
    const root = await createRequest({
      productId: cake,
      requesterLocationId: tortSexi,
      qtyNeeded: 10,
      actorUserId: null,
    });

    await expect(
      executeProductionPlan({
        requestId: root.id,
        productId: cake,
        qty: 10,
        sexLocationId: tortSexi,
        decisions: [
          { component_product_id: mastika, action: 'transfer' }, // would succeed
          { component_product_id: cream, action: 'use_ready' }, // FAILS — no stock
        ],
        actorUserId: null,
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    // Mastika raw stock is UNCHANGED (the reserve transfer rolled back).
    const { rows } = await ctx.db.query<{ qty: string }>(
      `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
      [raw, mastika],
    );
    expect(Number(rows[0]?.qty)).toBe(500);
    // No movement, no sub-order, no sub-request survived.
    const { rows: mv } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM stock_movements WHERE product_id = $1`,
      [mastika],
    );
    expect(Number(mv[0]?.n)).toBe(0);
    const { rows: subs } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM replenishment_requests WHERE product_id = $1 AND parent_request_id = $2`,
      [cream, root.id],
    );
    expect(Number(subs[0]?.n)).toBe(0);
  });

  it('OPEN_REQUEST_EXISTS: links a waiter + tops up qty (then NOT once advanced)', async () => {
    await setStock(ctx.db, { locationId: qaymoqSkladi, productId: cream, qty: 0 });

    // Root A orders cream from Qaymoq → opens the child sub-request.
    const rootA = await createRequest({
      productId: cake, requesterLocationId: tortSexi, qtyNeeded: 6, actorUserId: null,
    });
    const resA = await executeProductionPlan({
      requestId: rootA.id, productId: cake, qty: 6, sexLocationId: tortSexi,
      decisions: [{ component_product_id: cream, action: 'order' }],
      actorUserId: null,
    });
    const childId = resA.executed[0]!.request_id!;
    expect(childId).toBeGreaterThan(0);
    expect(resA.executed[0]!.waiter_linked).toBeUndefined(); // brand-new child

    // Root B (a DIFFERENT root) orders cream too → invariant 2 fires; instead of
    // a duplicate it links a waiter and tops up the child's qty (still NEW).
    // Root B requests from a SECOND sex floor so its OWN requester-location
    // debounce does not collide; the collision is on the pinned producer target.
    const rootB = await createRequest({
      productId: cake, requesterLocationId: qaymoqSexi, qtyNeeded: 4, actorUserId: null,
    });
    const resB = await executeProductionPlan({
      requestId: rootB.id, productId: cake, qty: 4, sexLocationId: tortSexi,
      decisions: [{ component_product_id: cream, action: 'order', qty_ready: 4 }],
      actorUserId: null,
    });
    const exB = resB.executed[0]!;
    expect(exB.request_id).toBe(childId); // reused, NOT a new request
    expect(exB.waiter_linked).toBe(true);
    expect(exB.qty_topped_up).toBe(true);

    // The child's qty grew by 4 (6 → 10) and a waiter row links rootB.
    const { rows: child } = await ctx.db.query<{ qty_needed: string }>(
      `SELECT qty_needed FROM replenishment_requests WHERE id = $1`,
      [childId],
    );
    expect(Number(child[0]?.qty_needed)).toBe(10);
    const { rows: waiters } = await ctx.db.query<{ waiter_request_id: string }>(
      `SELECT waiter_request_id FROM request_waiters WHERE child_request_id = $1`,
      [childId],
    );
    expect(waiters.map((w) => Number(w.waiter_request_id))).toContain(rootB.id);

    // Now ADVANCE the child past NEW — a third root must NOT top its qty up (#9).
    await ctx.db.query(
      `UPDATE replenishment_requests SET status = 'CHECK_STORE_SUPPLIER' WHERE id = $1`,
      [childId],
    );
    const rootC = await createRequest({
      productId: cake, requesterLocationId: central, qtyNeeded: 3, actorUserId: null,
    });
    const resC = await executeProductionPlan({
      requestId: rootC.id, productId: cake, qty: 3, sexLocationId: tortSexi,
      decisions: [{ component_product_id: cream, action: 'order', qty_ready: 3 }],
      actorUserId: null,
    });
    const exC = resC.executed[0]!;
    expect(exC.request_id).toBe(childId);
    expect(exC.waiter_linked).toBe(true);
    expect(exC.qty_topped_up).toBe(false); // frozen — child no longer NEW
    const { rows: childAfter } = await ctx.db.query<{ qty_needed: string }>(
      `SELECT qty_needed FROM replenishment_requests WHERE id = $1`,
      [childId],
    );
    expect(Number(childAfter[0]?.qty_needed)).toBe(10); // unchanged
  });
});
