/**
 * F-D (cross-dept-flow §8) — GET /api/replenishment/:id/tree.
 *
 * The frontend builds against a PINNED shape:
 *   { root: {...row, pipeline_stage}, nodes: [{...row, pipeline_stage,
 *     waiters_count}], waiters: [{child_request_id, waiter_request_id}] }
 *
 * Covers:
 *   - a 3-level fixture (root + dialog child + grandchild) returns the root +
 *     a FLAT `nodes` list (descendants), ordered by depth then id, each enriched
 *     with pipeline_stage + waiters_count; `waiters` lists the tree's waiter rows;
 *   - calling /tree on ANY node resolves the same tree root;
 *   - access control: a foreign location operator is 403; the root requester's
 *     operator + pm may read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import { createRequest, linkWaiter } from '../src/services/replenishment.js';
import { withTransaction } from '../src/db/index.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/**
 * A 3-level tree:
 *   root (sexR) -> child (sexC, dialog, depth 1) -> grandchild (sexG, depth 2)
 * plus a separate waiter root that links onto the child. Returns the ids + a
 * manager assigned to the ROOT requester location (for RBAC).
 */
async function buildTree(): Promise<{
  rootId: number;
  childId: number;
  grandchildId: number;
  waiterRootId: number;
  sexR: number;
  rootMgrToken: string;
}> {
  const sexR = await makeLocation(ctx.db, { type: 'production' });
  const sexC = await makeLocation(ctx.db, { type: 'production' });
  const sexG = await makeLocation(ctx.db, { type: 'production' });
  const sexW = await makeLocation(ctx.db, { type: 'production' });
  const product = await makeProduct(ctx.db, { type: 'semi' });

  const root = await createRequest({
    productId: product, requesterLocationId: sexR, qtyNeeded: 10, actorUserId: null,
  });
  const child = await createRequest({
    productId: product, requesterLocationId: sexC, qtyNeeded: 4, actorUserId: null,
    parentRequestId: root.id, depth: 1, origin: 'dialog',
  });
  const grandchild = await createRequest({
    productId: product, requesterLocationId: sexG, qtyNeeded: 2, actorUserId: null,
    parentRequestId: child.id, depth: 2, origin: 'dialog',
  });
  // A separate root that waits on the child (request_waiters).
  const waiterRoot = await createRequest({
    productId: product, requesterLocationId: sexW, qtyNeeded: 3, actorUserId: null,
  });
  await withTransaction((tx) => linkWaiter(tx, child.id, waiterRoot.id));

  const rootMgr = await makeUser(ctx.db, { role: 'production_manager', locationId: sexR });
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [rootMgr.id, sexR]);

  return {
    rootId: root.id,
    childId: child.id,
    grandchildId: grandchild.id,
    waiterRootId: waiterRoot.id,
    sexR,
    rootMgrToken: rootMgr.token,
  };
}

describe('GET /api/replenishment/:id/tree', () => {
  it('returns the pinned { root, nodes, waiters } shape for a 3-level tree', async () => {
    const t = await buildTree();
    const res = await request(ctx.app)
      .get(`/api/replenishment/${t.rootId}/tree`)
      .set('Authorization', `Bearer ${t.rootMgrToken}`);
    expect(res.status).toBe(200);

    // root is the root row, enriched with pipeline_stage.
    expect(Number(res.body.root.id)).toBe(t.rootId);
    expect(res.body.root.pipeline_stage).toBe('kutuvda'); // NEW -> kutuvda
    expect(res.body.root.product_name).toBeDefined();

    // nodes = the descendants (child + grandchild), FLAT, ordered depth then id.
    const nodeIds = res.body.nodes.map((n: { id: number }) => Number(n.id));
    expect(nodeIds).toEqual([t.childId, t.grandchildId]);
    // The root itself is NOT in nodes (it is `root`).
    expect(nodeIds).not.toContain(t.rootId);

    // Each node carries pipeline_stage + waiters_count.
    const child = res.body.nodes.find((n: { id: number }) => Number(n.id) === t.childId);
    expect(child.pipeline_stage).toBe('kutuvda');
    expect(Number(child.waiters_count)).toBe(1); // the waiter root waits on it
    const grandchild = res.body.nodes.find(
      (n: { id: number }) => Number(n.id) === t.grandchildId,
    );
    expect(Number(grandchild.waiters_count)).toBe(0);
    expect(Number(grandchild.parent_request_id)).toBe(t.childId); // nest key present

    // waiters = the request_waiters rows in the tree.
    expect(res.body.waiters).toEqual([
      { child_request_id: t.childId, waiter_request_id: t.waiterRootId },
    ]);
  });

  it('resolves the SAME tree root when called on a descendant (grandchild)', async () => {
    const t = await buildTree();
    const res = await request(ctx.app)
      .get(`/api/replenishment/${t.grandchildId}/tree`)
      .set('Authorization', `Bearer ${t.rootMgrToken}`);
    expect(res.status).toBe(200);
    // The root resolved from the grandchild is the tree root.
    expect(Number(res.body.root.id)).toBe(t.rootId);
    const nodeIds = res.body.nodes.map((n: { id: number }) => Number(n.id));
    expect(nodeIds).toEqual([t.childId, t.grandchildId]);
  });

  it('404 for an unknown id', async () => {
    const t = await buildTree();
    const res = await request(ctx.app)
      .get(`/api/replenishment/99999999/tree`)
      .set('Authorization', `Bearer ${t.rootMgrToken}`);
    expect(res.status).toBe(404);
  });

  it('access control: a foreign location operator is 403; pm may read', async () => {
    const t = await buildTree();
    // A manager of an unrelated location does NOT touch the root.
    const foreignLoc = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: foreignLoc,
    });
    const forbidden = await request(ctx.app)
      .get(`/api/replenishment/${t.rootId}/tree`)
      .set('Authorization', `Bearer ${foreign.token}`);
    expect(forbidden.status).toBe(403);

    const pm = await makeUser(ctx.db, { role: 'pm' });
    const ok = await request(ctx.app)
      .get(`/api/replenishment/${t.rootId}/tree`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(ok.status).toBe(200);
    expect(Number(ok.body.root.id)).toBe(t.rootId);
  });
});
