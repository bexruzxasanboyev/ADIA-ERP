/**
 * B3 + B4 (telegram-bot-tz §4) — cross-department request flow.
 *
 * Covers:
 *   - createCrossDeptRequest resolves the topology PARENT as target and
 *     notifies the target manager with xreq:accept / xreq:reject buttons;
 *   - parseCallbackData parses `xreq:accept:<id>` / `xreq:reject:<id>`;
 *   - dispatchCallback RBAC: only the target manager (or central_warehouse_
 *     manager / pm) may accept/reject — an outsider gets `rbac`;
 *   - accept ships from the central warehouse; reject cancels the request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { createCrossDeptRequest } from '../src/services/crossDeptRequest.js';
import {
  parseCallbackData,
  dispatchCallback,
  type CallbackPrincipal,
} from '../src/integrations/telegram/dispatch.js';

let ctx: TestContext;
let centralId: number;
let storeId: number;
let productId: number;
let centralManager: number;
let storeManager: number;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  centralId = await makeLocation(ctx.db, {
    type: 'central_warehouse',
    name: `Central ${Math.random().toString(36).slice(2, 6)}`,
  });
  storeId = await makeLocation(ctx.db, {
    type: 'store',
    name: `Store ${Math.random().toString(36).slice(2, 6)}`,
    parentId: centralId,
  });
  productId = await makeProduct(ctx.db, { name: 'НАПОЛЕОН', unit: 'pcs' });

  const cwm = await makeUser(ctx.db, {
    role: 'central_warehouse_manager',
    locationId: centralId,
  });
  centralManager = cwm.id;
  const sm = await makeUser(ctx.db, { role: 'store_manager', locationId: storeId });
  storeManager = sm.id;
  // Assign managers to their locations (D6).
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
    centralManager,
    centralId,
  ]);
  await ctx.db.query(`UPDATE locations SET manager_user_id = $1 WHERE id = $2`, [
    storeManager,
    storeId,
  ]);
});

function cp(userId: number, role: CallbackPrincipal['role'], locationId: number | null): CallbackPrincipal {
  return { userId, role, locationId };
}

describe('createCrossDeptRequest (B3)', () => {
  it('targets the topology parent and notifies the target manager with xreq buttons', async () => {
    const res = await createCrossDeptRequest({
      productId,
      productName: 'НАПОЛЕОН',
      unit: 'pcs',
      requesterLocationId: storeId,
      qty: 20,
      actorUserId: storeManager,
    });

    expect(res.target.locationId).toBe(centralId);
    expect(res.targetManagerNotified).toBe(true);
    expect(Number(res.request.requester_location_id)).toBe(storeId);

    const { rows } = await ctx.db.query<{
      recipient_user_id: string;
      inline_callback: { buttons: { text: string; data: string }[][] } | null;
    }>(
      `SELECT recipient_user_id, inline_callback FROM notifications
        WHERE recipient_user_id = $1 ORDER BY id DESC LIMIT 1`,
      [centralManager],
    );
    expect(rows).toHaveLength(1);
    const data = (rows[0]?.inline_callback?.buttons ?? []).flat().map((b) => b.data);
    expect(data).toContain(`xreq:accept:${res.request.id}`);
    expect(data).toContain(`xreq:reject:${res.request.id}`);
  });

  it('debounces a duplicate open request (OPEN_REQUEST_EXISTS)', async () => {
    await createCrossDeptRequest({
      productId,
      productName: 'НАПОЛЕОН',
      unit: 'pcs',
      requesterLocationId: storeId,
      qty: 10,
      actorUserId: storeManager,
    });
    await expect(
      createCrossDeptRequest({
        productId,
        productName: 'НАПОЛЕОН',
        unit: 'pcs',
        requesterLocationId: storeId,
        qty: 5,
        actorUserId: storeManager,
      }),
    ).rejects.toMatchObject({ code: 'OPEN_REQUEST_EXISTS' });
  });
});

describe('parseCallbackData — xreq verbs (B4)', () => {
  it('parses xreq:accept:<id>', () => {
    const parsed = parseCallbackData('xreq:accept:42');
    expect(parsed).toMatchObject({ verb: 'xreq', entity: 'req', id: 42, subAction: 'accept' });
  });
  it('parses xreq:reject:<id>', () => {
    const parsed = parseCallbackData('xreq:reject:7');
    expect(parsed).toMatchObject({ verb: 'xreq', subAction: 'reject', id: 7 });
  });
  it('rejects a bad sub-action', () => {
    expect(parseCallbackData('xreq:frob:7')).toBeNull();
  });
  it('rejects a non-numeric id', () => {
    expect(parseCallbackData('xreq:accept:abc')).toBeNull();
  });
});

describe('dispatchCallback — xreq RBAC (B4)', () => {
  it('rejects an outsider (not the target manager)', async () => {
    const res = await createCrossDeptRequest({
      productId,
      productName: 'НАПОЛЕОН',
      unit: 'pcs',
      requesterLocationId: storeId,
      qty: 5,
      actorUserId: storeManager,
    });
    const parsed = parseCallbackData(`xreq:accept:${res.request.id}`)!;
    // The store manager is the REQUESTER, not the target — must be denied.
    const outcome = await dispatchCallback(parsed, cp(storeManager, 'store_manager', storeId));
    expect(outcome.kind).toBe('rbac');
  });

  it('central warehouse manager accepts → ships from the central warehouse', async () => {
    // Stock the central warehouse so the engine can ship.
    await setStock(ctx.db, { locationId: centralId, productId, qty: 100, minLevel: 0, maxLevel: 0 });
    await setStock(ctx.db, { locationId: storeId, productId, qty: 0, minLevel: 0, maxLevel: 0 });

    const res = await createCrossDeptRequest({
      productId,
      productName: 'НАПОЛЕОН',
      unit: 'pcs',
      requesterLocationId: storeId,
      qty: 20,
      actorUserId: storeManager,
    });
    const parsed = parseCallbackData(`xreq:accept:${res.request.id}`)!;
    const outcome = await dispatchCallback(
      parsed,
      cp(centralManager, 'central_warehouse_manager', centralId),
    );
    expect(outcome.kind).toBe('ok');

    // The request reached CLOSED and the store received 20.
    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM replenishment_requests WHERE id = $1`,
      [res.request.id],
    );
    expect(rows[0]?.status).toBe('CLOSED');
    const { rows: stk } = await ctx.db.query<{ qty: string }>(
      `SELECT qty FROM stock WHERE location_id = $1 AND product_id = $2`,
      [storeId, productId],
    );
    expect(Number(stk[0]?.qty)).toBe(20);
  });

  it('target manager rejects → request CANCELLED + requester notified', async () => {
    const res = await createCrossDeptRequest({
      productId,
      productName: 'НАПОЛЕОН',
      unit: 'pcs',
      requesterLocationId: storeId,
      qty: 8,
      actorUserId: storeManager,
    });
    const parsed = parseCallbackData(`xreq:reject:${res.request.id}`)!;
    const outcome = await dispatchCallback(
      parsed,
      cp(centralManager, 'central_warehouse_manager', centralId),
    );
    expect(outcome.kind).toBe('ok');

    const { rows } = await ctx.db.query<{ status: string }>(
      `SELECT status FROM replenishment_requests WHERE id = $1`,
      [res.request.id],
    );
    expect(rows[0]?.status).toBe('CANCELLED');

    // Requester manager got an outcome notification.
    const { rows: notif } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM notifications WHERE recipient_user_id = $1`,
      [storeManager],
    );
    expect(Number(notif[0]?.n)).toBeGreaterThan(0);
  });
});
