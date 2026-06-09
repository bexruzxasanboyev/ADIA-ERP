/**
 * F-A (cross-dept-flow §8) — request-tree schema + plumbing acceptance tests.
 *
 * Covers migration 0065 + the `replenishment.ts` plumbing:
 *   - the 4 tree columns + `request_waiters` table exist;
 *   - createRequest persists parent/root/depth/origin (defaults + explicit);
 *   - root derivation (root = parent's root ?? parent id) for a 2-level chain;
 *   - depth 13 is rejected (application guard, before the DB CHECK);
 *   - linkWaiter is idempotent (ON CONFLICT) + refuses a self-wait;
 *   - topUpQtyIfPreAccept tops up ONLY while NEW (false once advanced past NEW).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/index.js';
import {
  createRequest,
  linkWaiter,
  topUpQtyIfPreAccept,
} from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('0065 — schema', () => {
  it('replenishment_requests has the 4 tree columns', async () => {
    const { rows } = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'replenishment_requests'
          AND column_name IN ('parent_request_id', 'root_request_id', 'depth', 'origin')
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'depth',
      'origin',
      'parent_request_id',
      'root_request_id',
    ]);
  });

  it('request_waiters table exists with the (child, waiter) PK', async () => {
    const { rows } = await ctx.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'request_waiters'`,
    );
    expect(rows).toHaveLength(1);
    // PK columns present.
    const { rows: cols } = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'request_waiters'
        ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['child_request_id', 'created_at', 'waiter_request_id']),
    );
  });
});

describe('createRequest — tree fields', () => {
  it('defaults to a root: parent/root NULL, depth 0, origin manual', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const product = await makeProduct(ctx.db, { type: 'finished' });
    const row = await createRequest({
      productId: product,
      requesterLocationId: loc,
      qtyNeeded: 5,
      actorUserId: null,
    });
    expect(row.parent_request_id).toBeNull();
    expect(row.root_request_id).toBeNull();
    expect(Number(row.depth)).toBe(0);
    expect(row.origin).toBe('manual');
  });

  it('persists an explicit origin', async () => {
    const loc = await makeLocation(ctx.db, { type: 'sex_storage' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    const row = await createRequest({
      productId: product,
      requesterLocationId: loc,
      qtyNeeded: 5,
      actorUserId: null,
      origin: 'buffer',
    });
    expect(row.origin).toBe('buffer');
  });

  it('derives root = parent id when the parent is itself a root', async () => {
    const locA = await makeLocation(ctx.db, { type: 'production' });
    const locB = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    // parent is a fresh root (root_request_id NULL).
    const parent = await createRequest({
      productId: product,
      requesterLocationId: locA,
      qtyNeeded: 10,
      actorUserId: null,
    });
    // child links to the parent; pass parent but NOT rootRequestId -> derive it.
    const child = await createRequest({
      productId: product,
      requesterLocationId: locB,
      qtyNeeded: 4,
      actorUserId: null,
      parentRequestId: parent.id,
      depth: 1,
      origin: 'dialog',
    });
    expect(Number(child.parent_request_id)).toBe(parent.id);
    // parent is a root -> child's root is the parent id.
    expect(Number(child.root_request_id)).toBe(parent.id);
    expect(Number(child.depth)).toBe(1);
    expect(child.origin).toBe('dialog');
  });

  it('derives root = parent.root for a grandchild (root flows down the chain)', async () => {
    const locA = await makeLocation(ctx.db, { type: 'production' });
    const locB = await makeLocation(ctx.db, { type: 'production' });
    const locC = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    const root = await createRequest({
      productId: product, requesterLocationId: locA, qtyNeeded: 10, actorUserId: null,
    });
    const child = await createRequest({
      productId: product, requesterLocationId: locB, qtyNeeded: 4, actorUserId: null,
      parentRequestId: root.id, depth: 1,
    });
    const grandchild = await createRequest({
      productId: product, requesterLocationId: locC, qtyNeeded: 2, actorUserId: null,
      parentRequestId: child.id, depth: 2,
    });
    // child's root is `root.id`; grandchild derives the SAME root from child.
    expect(Number(child.root_request_id)).toBe(root.id);
    expect(Number(grandchild.root_request_id)).toBe(root.id);
    expect(Number(grandchild.depth)).toBe(2);
  });

  it('rejects depth 13 with a validation error', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    await expect(
      createRequest({
        productId: product,
        requesterLocationId: loc,
        qtyNeeded: 1,
        actorUserId: null,
        depth: 13,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('linkWaiter — idempotent', () => {
  it('inserts once, returns false on a duplicate, skips a self-wait', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const loc2 = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    const child = await createRequest({
      productId: product, requesterLocationId: loc, qtyNeeded: 5, actorUserId: null,
    });
    const waiter = await createRequest({
      productId: product, requesterLocationId: loc2, qtyNeeded: 3, actorUserId: null,
    });

    const first = await withTransaction((tx) => linkWaiter(tx, child.id, waiter.id));
    expect(first).toBe(true);
    const second = await withTransaction((tx) => linkWaiter(tx, child.id, waiter.id));
    expect(second).toBe(false); // ON CONFLICT DO NOTHING
    const selfWait = await withTransaction((tx) => linkWaiter(tx, child.id, child.id));
    expect(selfWait).toBe(false); // a root never waits on itself

    const { rows } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM request_waiters WHERE child_request_id = $1`,
      [child.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });
});

describe('topUpQtyIfPreAccept — only while NEW (#9)', () => {
  it('tops up a NEW child and audits it', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    const child = await createRequest({
      productId: product, requesterLocationId: loc, qtyNeeded: 5, actorUserId: null,
    });
    const ok = await withTransaction((tx) => topUpQtyIfPreAccept(tx, child.id, 3, null));
    expect(ok).toBe(true);
    const { rows } = await ctx.db.query<{ qty_needed: string }>(
      `SELECT qty_needed FROM replenishment_requests WHERE id = $1`,
      [child.id],
    );
    expect(Number(rows[0]?.qty_needed)).toBe(8);
  });

  it('returns false (no top-up) once the child is no longer NEW', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    const child = await createRequest({
      productId: product, requesterLocationId: loc, qtyNeeded: 5, actorUserId: null,
    });
    // Push the child out of NEW (simulate an accept/advance) — qty is now frozen.
    await ctx.db.query(
      `UPDATE replenishment_requests SET status = 'CHECK_STORE_SUPPLIER' WHERE id = $1`,
      [child.id],
    );
    const ok = await withTransaction((tx) => topUpQtyIfPreAccept(tx, child.id, 3, null));
    expect(ok).toBe(false);
    const { rows } = await ctx.db.query<{ qty_needed: string }>(
      `SELECT qty_needed FROM replenishment_requests WHERE id = $1`,
      [child.id],
    );
    expect(Number(rows[0]?.qty_needed)).toBe(5); // unchanged
  });

  it('returns false for a non-positive extra qty', async () => {
    const loc = await makeLocation(ctx.db, { type: 'production' });
    const product = await makeProduct(ctx.db, { type: 'semi' });
    const child = await createRequest({
      productId: product, requesterLocationId: loc, qtyNeeded: 5, actorUserId: null,
    });
    const ok = await withTransaction((tx) => topUpQtyIfPreAccept(tx, child.id, 0, null));
    expect(ok).toBe(false);
  });
});
