/**
 * F-G — raw-warehouse (mahsulot ombori) supply flow THROUGH POSTER.
 *
 * A sex sends a request to the raw-warehouse manager; the manager ACCEPTS it; he
 * then adds the Поставка in Poster himself; `posterStockSync` later lands the
 * stock at the raw warehouse; the system AUTO-SHIPS to the requester and
 * completes the request.
 *
 * Covered here (service layer):
 *   1. 0066 — fulfiller_accepted_* columns exist; each accept path stamps them
 *      (and only ONCE — first accept wins).
 *   2. crossDept parent-path to a raw_warehouse parent PINS target;
 *      producer_store pin unchanged; a central parent is NOT pinned.
 *   3. the cron gate skips a NEW row pinned to a raw_warehouse target.
 *   4. the raw "waiting for Poster supply" hold + the sync-arrival auto-ship loop.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock, getQty } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/index.js';
import {
  acceptByCentral,
  acceptByFulfiller,
  acceptInternal,
  createRequest,
  fulfillStoreRequest,
  runEngineCycle,
} from '../src/services/replenishment.js';
import {
  createCrossDeptRequest,
  createCrossDeptRequestInTx,
} from '../src/services/crossDeptRequest.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function readRow(id: number): Promise<{
  status: string;
  target_location_id: number | null;
  fulfiller_accepted_at: Date | null;
  fulfiller_accepted_by: number | null;
}> {
  const { rows } = await ctx.db.query<{
    status: string;
    target_location_id: number | null;
    fulfiller_accepted_at: Date | null;
    fulfiller_accepted_by: string | null;
  }>(
    `SELECT status, target_location_id, fulfiller_accepted_at, fulfiller_accepted_by
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
  };
}

/** Set products.workshop_location_id directly (the fixture has no such field). */
async function setWorkshop(productId: number, workshopId: number | null): Promise<void> {
  await ctx.db.query('UPDATE products SET workshop_location_id = $2 WHERE id = $1', [
    productId,
    workshopId,
  ]);
}

// -----------------------------------------------------------------------------
// 1. 0066 columns + acceptance stamps
// -----------------------------------------------------------------------------

describe('0066 — fulfiller_accepted_* columns + stamps', () => {
  it('the two columns exist (and default NULL on a fresh request)', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const req = await createRequest({
      productId: cake,
      requesterLocationId: store,
      qtyNeeded: 5,
      actorUserId: null,
    });
    const after = await readRow(req.id);
    expect(after.fulfiller_accepted_at).toBeNull();
    expect(after.fulfiller_accepted_by).toBeNull();
  });

  it('acceptByCentral stamps fulfiller_accepted_* (who + when)', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 100 });
    const actor = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    const req = await createRequest({
      productId: cake,
      requesterLocationId: store,
      qtyNeeded: 5,
      actorUserId: null,
    });
    const result = await acceptByCentral({
      requestId: req.id,
      centralLocationId: central,
      actorUserId: actor.id,
    });
    // The service's returned row also carries the stamp.
    expect(result.request.fulfiller_accepted_at).not.toBeNull();
    expect(Number(result.request.fulfiller_accepted_by)).toBe(actor.id);
    const after = await readRow(req.id);
    expect(after.fulfiller_accepted_at).not.toBeNull();
    expect(after.fulfiller_accepted_by).toBe(actor.id);
  });

  it('acceptByFulfiller stamps fulfiller_accepted_* even when it HOLDS (no stock)', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const producerStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: workshop });
    const requesterSex = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const cream = await makeProduct(ctx.db, { type: 'semi' });
    const actor = await makeUser(ctx.db, { role: 'supply_manager', locationId: producerStorage });

    const req = await createRequest({
      productId: cream,
      requesterLocationId: requesterSex,
      qtyNeeded: 10,
      actorUserId: null,
    });
    // No stock at the producer storage -> the accept HOLDS (does not ship).
    const result = await acceptByFulfiller({
      requestId: req.id,
      fulfillerLocationId: producerStorage,
      actorUserId: actor.id,
    });
    expect(result.shipped).toBe(false);
    expect(result.request.fulfiller_accepted_at).not.toBeNull();
    const after = await readRow(req.id);
    expect(after.fulfiller_accepted_at).not.toBeNull();
    expect(after.fulfiller_accepted_by).toBe(actor.id);
  });

  it('acceptInternal stamps fulfiller_accepted_*', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const bufferStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: workshop });
    const cream = await makeProduct(ctx.db, { type: 'semi' });
    const actor = await makeUser(ctx.db, { role: 'production_manager', locationId: workshop });

    const req = await createRequest({
      productId: cream,
      requesterLocationId: bufferStorage,
      qtyNeeded: 8,
      actorUserId: null,
      origin: 'buffer',
    });
    const result = await acceptInternal({ requestId: req.id, actorUserId: actor.id });
    expect(result.accepted).toBe(true);
    expect(result.request.fulfiller_accepted_at).not.toBeNull();
    const after = await readRow(req.id);
    expect(after.fulfiller_accepted_by).toBe(actor.id);
  });

  it('fulfillStoreRequest stamps fulfiller_accepted_* (fulfilling implies acceptance)', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 100 });
    const actor = await makeUser(ctx.db, { role: 'central_warehouse_manager', locationId: central });

    const req = await createRequest({
      productId: cake,
      requesterLocationId: store,
      qtyNeeded: 5,
      actorUserId: null,
    });
    const result = await fulfillStoreRequest({
      requestId: req.id,
      centralLocationId: central,
      actorUserId: actor.id,
    });
    expect(result.shippedQty).toBe(5);
    expect(result.request.fulfiller_accepted_at).not.toBeNull();
    const after = await readRow(req.id);
    expect(after.fulfiller_accepted_by).toBe(actor.id);
  });

  it('first accept WINS — a later accept never overwrites the stamp', async () => {
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const producerStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: workshop });
    const requesterSex = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const cream = await makeProduct(ctx.db, { type: 'semi' });
    const first = await makeUser(ctx.db, { role: 'supply_manager', locationId: producerStorage });
    const second = await makeUser(ctx.db, { role: 'supply_manager', locationId: producerStorage });

    const req = await createRequest({
      productId: cream,
      requesterLocationId: requesterSex,
      qtyNeeded: 10,
      actorUserId: null,
    });
    // First accept (held — no stock) stamps `first`.
    await acceptByFulfiller({
      requestId: req.id,
      fulfillerLocationId: producerStorage,
      actorUserId: first.id,
    });
    const afterFirst = await readRow(req.id);
    const stampedAt = afterFirst.fulfiller_accepted_at;
    expect(stampedAt).not.toBeNull();
    expect(afterFirst.fulfiller_accepted_by).toBe(first.id);

    // Second accept (still held) must NOT overwrite who/when.
    await acceptByFulfiller({
      requestId: req.id,
      fulfillerLocationId: producerStorage,
      actorUserId: second.id,
    });
    const afterSecond = await readRow(req.id);
    expect(afterSecond.fulfiller_accepted_by).toBe(first.id); // unchanged
    expect(afterSecond.fulfiller_accepted_at).toEqual(stampedAt); // unchanged
  });
});

// -----------------------------------------------------------------------------
// 2. crossDept parent-path raw_warehouse pin
// -----------------------------------------------------------------------------

describe('crossDept — raw_warehouse parent pin (point 3)', () => {
  it('PINS target when the parent-path target is a raw_warehouse', async () => {
    // A sex whose topology parent IS the raw warehouse (sex asks the mahsulot
    // ombori for a raw material). The default parent path resolves the raw
    // warehouse; it must be PINNED so advanceNew does not clobber it.
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse', name: 'Mahsulot ombori' });
    const sex = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const mgr = await makeUser(ctx.db, { role: 'production_manager', locationId: sex });

    const res = await createCrossDeptRequest({
      productId: flour,
      productName: 'Un',
      unit: 'kg',
      requesterLocationId: sex,
      qty: 20,
      actorUserId: mgr.id,
    });
    expect(res.target.locationId).toBe(rawWh);
    expect(res.target.via).toBe('parent');
    expect(res.target.type).toBe('raw_warehouse');
    // PINNED (in the returned row and in the DB).
    expect(Number(res.request.target_location_id)).toBe(rawWh);
    const after = await readRow(res.request.id);
    expect(after.target_location_id).toBe(rawWh);
  });

  it('does NOT pin when the parent-path target is a central_warehouse', async () => {
    // A store asking central — the engine must resolve + ship from central
    // itself, so target stays NULL (no pin).
    const central = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });
    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: store });

    const res = await createCrossDeptRequest({
      productId: cake,
      productName: 'Tort',
      unit: 'pcs',
      requesterLocationId: store,
      qty: 5,
      actorUserId: mgr.id,
    });
    expect(res.target.locationId).toBe(central);
    expect(res.target.via).toBe('parent');
    expect(res.request.target_location_id).toBeNull();
    const after = await readRow(res.request.id);
    expect(after.target_location_id).toBeNull();
  });

  it('producer_store pin still works (unchanged)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const prodRoot = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
    const qaymoqSexi = await makeLocation(ctx.db, { type: 'production', parentId: prodRoot });
    const qaymoqSkladi = await makeLocation(ctx.db, { type: 'sex_storage', parentId: qaymoqSexi });
    const tortSexi = await makeLocation(ctx.db, { type: 'production', parentId: prodRoot });
    const cream = await makeProduct(ctx.db, { type: 'semi', unit: 'kg' });
    await setWorkshop(cream, qaymoqSexi);
    const mgr = await makeUser(ctx.db, { role: 'production_manager', locationId: tortSexi });

    const res = await createCrossDeptRequest({
      productId: cream,
      productName: 'Qaymoq krem',
      unit: 'kg',
      requesterLocationId: tortSexi,
      qty: 5,
      actorUserId: mgr.id,
    });
    expect(res.target.via).toBe('producer_store');
    expect(Number(res.request.target_location_id)).toBe(qaymoqSkladi);
  });

  it('InTx variant ALSO pins a raw_warehouse parent target', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const sex = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });

    const result = await withTransaction((tx) =>
      createCrossDeptRequestInTx(tx, {
        productId: flour,
        requesterLocationId: sex,
        qty: 15,
        actorUserId: null,
        parentRequestId: null,
        rootRequestId: null,
        depth: 0,
        origin: 'dialog',
      }),
    );
    expect(result.kind).toBe('created');
    if (result.kind === 'created') {
      expect(Number(result.request.target_location_id)).toBe(rawWh);
    }
  });
});

// -----------------------------------------------------------------------------
// 3. gate — pinned-raw NEW row skipped by the cycle
// -----------------------------------------------------------------------------

describe('runEngineCycle — gate skips a NEW raw_warehouse-pinned row (point 4)', () => {
  it('leaves a NEW request pinned to a raw_warehouse target UNTOUCHED (no clobber)', async () => {
    // The chain still contains a central warehouse so, absent the gate,
    // `advanceNew` WOULD resolve it and clobber the raw pin.
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const sex = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    // Raw holds plenty so an (erroneous) auto-advance would actually ship.
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 500 });

    const req = await createRequest({
      productId: flour,
      requesterLocationId: sex,
      qtyNeeded: 20,
      actorUserId: null,
      origin: 'dialog',
    });
    await ctx.db.query(
      'UPDATE replenishment_requests SET target_location_id = $2 WHERE id = $1',
      [req.id, rawWh],
    );

    await runEngineCycle();

    const after = await readRow(req.id);
    expect(after.status).toBe('NEW'); // untouched
    expect(after.target_location_id).toBe(rawWh); // pin NOT clobbered
  });
});

// -----------------------------------------------------------------------------
// 4. raw hold + sync-arrival auto-ship loop (point 5)
// -----------------------------------------------------------------------------

describe('raw supply — hold then auto-ship on Poster sync (point 5)', () => {
  it('pinned raw request: accept holds, then a stock bump auto-ships to CLOSED', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const sex = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
    const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
    const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
    // Raw starts EMPTY (the Поставка has not been added in Poster yet).
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 0 });
    await setStock(ctx.db, { locationId: sex, productId: flour, qty: 0 });

    // The sex asks the raw warehouse (parent path -> pinned raw, per point 3).
    const created = await createCrossDeptRequest({
      productId: flour,
      productName: 'Un',
      unit: 'kg',
      requesterLocationId: sex,
      qty: 30,
      actorUserId: rawMgr.id,
    });
    expect(Number(created.request.target_location_id)).toBe(rawWh);
    const reqId = created.request.id;

    // The raw manager ACCEPTS — but raw is empty, so it HOLDS (no ship).
    const accept = await acceptByFulfiller({
      requestId: reqId,
      fulfillerLocationId: rawWh,
      actorUserId: rawMgr.id,
    });
    expect(accept.shipped).toBe(false);
    let after = await readRow(reqId);
    expect(after.status).toBe('CHECK_STORE_SUPPLIER'); // held at the gate
    expect(after.fulfiller_accepted_at).not.toBeNull(); // accepted (Tasdiqlandi)

    // The cron runs (no stock yet) — the raw hold keeps it at CHECK_STORE_SUPPLIER
    // (advanced:false; it does NOT cascade into CHECK_PRODUCTION_INPUT).
    await runEngineCycle();
    after = await readRow(reqId);
    expect(after.status).toBe('CHECK_STORE_SUPPLIER');
    expect(after.target_location_id).toBe(rawWh);

    // Simulate `posterStockSync` landing the Поставка at the raw warehouse.
    await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: 30 });

    // The cron re-runs every cycle. Once raw covers the need the request advances
    // CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER -> CLOSED. The engine takes ONE
    // logical step per row per pass (SHIP_TO_REQUESTER is a non-chainable hop), so
    // a couple of passes close it — exactly how the 5-minute cron behaves.
    for (let i = 0; i < 5 && after.status !== 'CLOSED'; i += 1) {
      await runEngineCycle();
      after = await readRow(reqId);
    }
    expect(after.status).toBe('CLOSED');

    // The stock physically moved raw(30 -> 0) to sex(0 -> 30).
    expect(await getQty(ctx.db, rawWh, flour)).toBe(0);
    expect(await getQty(ctx.db, sex, flour)).toBe(30);

    // A shipment movement was recorded against the request.
    const { rows: mv } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM stock_movements
        WHERE replenishment_id = $1 AND from_location_id = $2 AND to_location_id = $3`,
      [reqId, rawWh, sex],
    );
    expect(Number(mv[0]!.n)).toBeGreaterThanOrEqual(1);
  });
});
