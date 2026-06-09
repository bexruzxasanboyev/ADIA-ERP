/**
 * F-C / decision #8 — internal accept-gate: the cron must NOT auto-advance two
 * NEW-only classes of internal request.
 *
 *   (a) a request PINNED to a `sex_storage` target (producer-override / Qaymoq):
 *       `runEngineCycle` must leave it UNTOUCHED — status stays NEW, the pinned
 *       target is NOT clobbered with the central warehouse (the bug this gate
 *       closes). It advances only via `acceptByFulfiller` (the xreq buttons).
 *   (b) a `sex_storage` REQUESTER (B-cycle buffer refill): the cron leaves it at
 *       NEW; it waits for an explicit internal accept (`acceptInternal`).
 *
 * Plus the two negatives that prove the gate is narrow:
 *   - the existing STORE-requester skip still holds (cron never advances it);
 *   - a NORMAL internal request (central requester, no sex_storage anywhere)
 *     STILL auto-advances — the gate did not over-reach.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, setStock } from './helpers/fixtures.js';
import { createRequest, runEngineCycle } from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

async function readRow(id: number): Promise<{ status: string; target_location_id: number | null }> {
  const { rows } = await ctx.db.query<{ status: string; target_location_id: number | null }>(
    'SELECT status, target_location_id FROM replenishment_requests WHERE id = $1',
    [id],
  );
  const r = rows[0]!;
  return {
    status: r.status,
    target_location_id: r.target_location_id === null ? null : Number(r.target_location_id),
  };
}

describe('runEngineCycle — internal accept-gate (#8)', () => {
  it('leaves a NEW request PINNED to a sex_storage target UNTOUCHED (no clobber, no ship)', async () => {
    // A producing отдел: workshop (production) + its sex_storage buffer; a second
    // sex (the requester) that needs the отдел's semi. The request is PINNED to
    // the producer's sex_storage (the cross-dept producer-override pin). A
    // central warehouse exists in the chain so, absent the gate, `advanceNew`
    // WOULD resolve it and clobber the pin.
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const producerStorage = await makeLocation(ctx.db, {
      type: 'sex_storage',
      parentId: workshop,
    });
    // The requesting sex floor (a different production location) -> its chain
    // climbs to the central warehouse.
    const requesterSex = await makeLocation(ctx.db, { type: 'production', parentId: central });

    const cream = await makeProduct(ctx.db, { type: 'semi' });
    // Producer holds plenty so an (erroneous) auto-advance would actually ship.
    await setStock(ctx.db, { locationId: producerStorage, productId: cream, qty: 100 });

    const req = await createRequest({
      productId: cream,
      requesterLocationId: requesterSex,
      qtyNeeded: 10,
      actorUserId: null,
      origin: 'dialog',
    });
    // Pin the producer storage as the target (mirrors the producer-override pin).
    await ctx.db.query(
      'UPDATE replenishment_requests SET target_location_id = $2 WHERE id = $1',
      [req.id, producerStorage],
    );

    await runEngineCycle();

    const after = await readRow(req.id);
    expect(after.status).toBe('NEW'); // untouched
    expect(after.target_location_id).toBe(producerStorage); // pin NOT clobbered
  });

  it('leaves a NEW sex_storage-REQUESTER (buffer refill) untouched', async () => {
    // A sex_storage that fell below min — the B-cycle buffer top-up. The cron
    // must not advance it; it waits for an explicit internal accept.
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const bufferStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: workshop });

    const cream = await makeProduct(ctx.db, { type: 'semi' });
    const req = await createRequest({
      productId: cream,
      requesterLocationId: bufferStorage,
      qtyNeeded: 8,
      actorUserId: null,
      origin: 'buffer',
    });

    await runEngineCycle();

    const after = await readRow(req.id);
    expect(after.status).toBe('NEW');
  });

  it('still skips a STORE-requester NEW request (the pre-existing gate)', async () => {
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const store = await makeLocation(ctx.db, { type: 'store', parentId: central });

    const cake = await makeProduct(ctx.db, { type: 'finished' });
    await setStock(ctx.db, { locationId: central, productId: cake, qty: 100 });

    const req = await createRequest({
      productId: cake,
      requesterLocationId: store,
      qtyNeeded: 5,
      actorUserId: null,
    });

    await runEngineCycle();

    const after = await readRow(req.id);
    expect(after.status).toBe('NEW'); // store gate — cron never advances it
    expect(after.target_location_id).toBeNull();
  });

  it('STILL auto-advances a normal internal request (no sex_storage involved)', async () => {
    // A plain `production`-requester (NOT a store, NOT a sex_storage, and NOT
    // pinned to a sex_storage target) whose chain climbs to a central warehouse.
    // The gate must NOT touch it: the cron advances NEW -> CHECK_STORE_SUPPLIER
    // (target = the central warehouse resolved upward by `advanceNew`).
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const requester = await makeLocation(ctx.db, { type: 'production', parentId: central });

    const cake = await makeProduct(ctx.db, { type: 'finished' });
    const req = await createRequest({
      productId: cake,
      requesterLocationId: requester,
      qtyNeeded: 5,
      actorUserId: null,
      origin: 'scan',
    });

    await runEngineCycle();

    const after = await readRow(req.id);
    // The normal internal request was advanced out of NEW by the cron.
    expect(after.status).not.toBe('NEW');
    // And its target was resolved to the central warehouse (proof of forward
    // progress, not just a status flip).
    expect(after.target_location_id).toBe(central);
  });
});
