/**
 * F-D (cross-dept-flow §8) — waiter chaining + cancel cascade.
 *
 *   chainWaitersAfterTerminal: a child reaching terminal fans out to EVERY open
 *     root waiting on it — via BOTH `parent_request_id` AND `request_waiters`
 *     (waiter links) — re-advancing each + a `sub_request_closed` notification.
 *     Closed roots are skipped; a notify failure never breaks the close.
 *
 *   cancel cascade (#10): a requester-side cancel of a ROOT also cancels its
 *     orphan early-stage children (NEW / CHECK_STORE_SUPPLIER) that no OTHER open
 *     root waits on; spares a child with another open waiter; spares a deeper
 *     (CHECK_PRODUCTION_INPUT+) child; the root's waiter rows are removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/index.js';
import {
  advance,
  cancelRequest,
  cancelRequestByFulfiller,
  createRequest,
  linkWaiter,
} from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/** Set a location's manager (so notifications have a recipient). */
async function setManager(locationId: number, role: 'production_manager'): Promise<number> {
  const mgr = await makeUser(ctx.db, { role, locationId });
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [mgr.id, locationId]);
  return mgr.id;
}

async function readStatus(id: number): Promise<string> {
  const { rows } = await ctx.db.query<{ status: string }>(
    'SELECT status FROM replenishment_requests WHERE id = $1',
    [id],
  );
  return rows[0]!.status;
}

async function countSubClosed(recipientUserId: number, childId: number): Promise<number> {
  const { rows } = await ctx.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM notifications
      WHERE recipient_user_id = $1
        AND type = 'sub_request_closed'
        AND (payload->>'child_request_id')::bigint = $2`,
    [recipientUserId, childId],
  );
  return Number(rows[0]!.n);
}

describe('chainWaitersAfterTerminal — fan out via parent AND waiter links', () => {
  it('a closed child notifies BOTH the parent-linked root and a waiter-linked root', async () => {
    // Two roots in two different sexes; each has a manager. A shared child in a
    // third sex links to rootA via parent_request_id and to rootB via a waiter.
    const sexA = await makeLocation(ctx.db, { type: 'production' });
    const sexB = await makeLocation(ctx.db, { type: 'production' });
    const childSex = await makeLocation(ctx.db, { type: 'production' });
    const mgrA = await setManager(sexA, 'production_manager');
    const mgrB = await setManager(sexB, 'production_manager');
    const product = await makeProduct(ctx.db, { type: 'semi' });

    const rootA = await createRequest({
      productId: product, requesterLocationId: sexA, qtyNeeded: 10, actorUserId: null,
    });
    const rootB = await createRequest({
      productId: product, requesterLocationId: sexB, qtyNeeded: 6, actorUserId: null,
    });
    const child = await createRequest({
      productId: product, requesterLocationId: childSex, qtyNeeded: 4, actorUserId: null,
      parentRequestId: rootA.id, depth: 1, origin: 'dialog',
    });
    // rootB ALSO waits on the same child (the invariant-2 coexistence case).
    await withTransaction((tx) => linkWaiter(tx, child.id, rootB.id));

    // Close the child (fulfiller reject -> CANCELLED) -> fires the waiter chain.
    await cancelRequestByFulfiller(child.id, null, 'producer cannot make it');

    // BOTH roots' managers got a sub_request_closed notification for this child.
    expect(await countSubClosed(mgrA, child.id)).toBe(1);
    expect(await countSubClosed(mgrB, child.id)).toBe(1);
  });

  it('skips a root that is itself already terminal (no notification)', async () => {
    const sexA = await makeLocation(ctx.db, { type: 'production' });
    const childSex = await makeLocation(ctx.db, { type: 'production' });
    const mgrA = await setManager(sexA, 'production_manager');
    const product = await makeProduct(ctx.db, { type: 'semi' });

    const rootA = await createRequest({
      productId: product, requesterLocationId: sexA, qtyNeeded: 10, actorUserId: null,
    });
    const child = await createRequest({
      productId: product, requesterLocationId: childSex, qtyNeeded: 4, actorUserId: null,
      parentRequestId: rootA.id, depth: 1, origin: 'dialog',
    });
    // Cancel the ROOT first (terminal). NOTE: this also cascade-cancels the
    // orphan child (#10) — so the child's own chain will run, but rootA is now
    // terminal and must be SKIPPED (no sub_request_closed addressed FROM the
    // child TO rootA).
    await cancelRequest(rootA.id, null, 'root gone');

    // The child was cascade-cancelled; rootA is terminal -> no sub_request_closed
    // notification to mgrA for this child (the root cannot proceed).
    expect(await countSubClosed(mgrA, child.id)).toBe(0);
  });

  it('actually RE-ADVANCES the waiting root (child CLOSED -> root ships)', async () => {
    // A root parked at CHECK_STORE_SUPPLIER whose central target HAS stock. When
    // the child it waits on reaches terminal, the chain re-advances the root,
    // which now ships (CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER -> CLOSED).
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const rootSex = await makeLocation(ctx.db, { type: 'production', parentId: central });
    const childSex = await makeLocation(ctx.db, { type: 'production' });
    const semi = await makeProduct(ctx.db, { type: 'semi' });

    const root = await createRequest({
      productId: semi, requesterLocationId: rootSex, qtyNeeded: 5, actorUserId: null,
    });
    // Park the root at CHECK_STORE_SUPPLIER pinned to `central`, with central
    // stock to satisfy it (so the next advance ships).
    await advance(root.id, null); // NEW -> CHECK_STORE_SUPPLIER (pins central)
    expect(await readStatus(root.id)).toBe('CHECK_STORE_SUPPLIER');
    await setStock(ctx.db, { locationId: central, productId: semi, qty: 100 });

    const child = await createRequest({
      productId: semi, requesterLocationId: childSex, qtyNeeded: 2, actorUserId: null,
      parentRequestId: root.id, depth: 1, origin: 'dialog',
    });

    // Close the child -> the chain calls advance(root) ONCE (per spec). That one
    // hop moves CHECK_STORE_SUPPLIER -> SHIP_TO_REQUESTER (the engine advances a
    // single step; it does not skip-chain from CHECK_STORE_SUPPLIER). The status
    // change is the proof the waiting root was actually re-advanced.
    expect(await readStatus(root.id)).toBe('CHECK_STORE_SUPPLIER'); // before
    await cancelRequestByFulfiller(child.id, null, 'producer reject');
    expect(await readStatus(root.id)).toBe('SHIP_TO_REQUESTER'); // re-advanced one hop
  });

  it('a notify failure never breaks the close (root with NO manager)', async () => {
    // rootA has NO manager set -> getLocationManager returns null -> the notify
    // is skipped, but the child close still succeeds.
    const sexA = await makeLocation(ctx.db, { type: 'production' });
    const childSex = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });

    const rootA = await createRequest({
      productId: product, requesterLocationId: sexA, qtyNeeded: 10, actorUserId: null,
    });
    const child = await createRequest({
      productId: product, requesterLocationId: childSex, qtyNeeded: 4, actorUserId: null,
      parentRequestId: rootA.id, depth: 1, origin: 'dialog',
    });
    await cancelRequestByFulfiller(child.id, null, 'no manager case');
    expect(await readStatus(child.id)).toBe('CANCELLED'); // close succeeded
  });
});

describe('cancel cascade (#10) — requester-side root cancel', () => {
  it('cancels a NEW orphan child, spares a child with another open waiter, spares a deeper child', async () => {
    const rootSex = await makeLocation(ctx.db, { type: 'production' });
    const otherRootSex = await makeLocation(ctx.db, { type: 'production' });
    const childSex1 = await makeLocation(ctx.db, { type: 'production' });
    const childSex2 = await makeLocation(ctx.db, { type: 'production' });
    const childSex3 = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });

    const root = await createRequest({
      productId: product, requesterLocationId: rootSex, qtyNeeded: 20, actorUserId: null,
    });
    // A second, independent OPEN root that will keep one child alive.
    const otherRoot = await createRequest({
      productId: product, requesterLocationId: otherRootSex, qtyNeeded: 5, actorUserId: null,
    });

    // child1 — a plain NEW orphan of `root` (only waiter is root) -> CANCELLED.
    const child1 = await createRequest({
      productId: product, requesterLocationId: childSex1, qtyNeeded: 4, actorUserId: null,
      parentRequestId: root.id, depth: 1, origin: 'dialog',
    });
    // child2 — NEW, parent=root, BUT otherRoot ALSO waits on it -> SPARED.
    const child2 = await createRequest({
      productId: product, requesterLocationId: childSex2, qtyNeeded: 3, actorUserId: null,
      parentRequestId: root.id, depth: 1, origin: 'dialog',
    });
    await withTransaction((tx) => linkWaiter(tx, child2.id, otherRoot.id));
    // child3 — parent=root but DEEPER (CHECK_PRODUCTION_INPUT) -> SPARED.
    const child3 = await createRequest({
      productId: product, requesterLocationId: childSex3, qtyNeeded: 2, actorUserId: null,
      parentRequestId: root.id, depth: 1, origin: 'dialog',
    });
    await ctx.db.query(
      `UPDATE replenishment_requests SET status = 'CHECK_PRODUCTION_INPUT' WHERE id = $1`,
      [child3.id],
    );

    // Cancel the root (requester-side).
    await cancelRequest(root.id, null, 'requester changed plans');

    expect(await readStatus(root.id)).toBe('CANCELLED');
    expect(await readStatus(child1.id)).toBe('CANCELLED'); // orphan -> cascaded
    expect(await readStatus(child2.id)).not.toBe('CANCELLED'); // other waiter -> spared
    expect(await readStatus(child3.id)).toBe('CHECK_PRODUCTION_INPUT'); // deeper -> spared

    // child1's cascade transition carries the 'root cancelled' note.
    const { rows: trans } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM replenishment_transitions
        WHERE replenishment_id = $1 AND to_status = 'CANCELLED' AND reason = 'root cancelled'`,
      [child1.id],
    );
    expect(Number(trans[0]!.n)).toBe(1);

    // The root's waiter rows were removed (child2 lost `root` as a waiter, but
    // KEEPS otherRoot).
    const { rows: rootWaiterRows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM request_waiters WHERE waiter_request_id = $1`,
      [root.id],
    );
    expect(Number(rootWaiterRows[0]!.n)).toBe(0);
    const { rows: child2Waiters } = await ctx.db.query<{ waiter_request_id: string }>(
      `SELECT waiter_request_id FROM request_waiters WHERE child_request_id = $1`,
      [child2.id],
    );
    expect(child2Waiters.map((r) => Number(r.waiter_request_id))).toEqual([otherRoot.id]);
  });
});
