/**
 * F-C / decision #8 — internal buffer-gate Telegram callbacks (ireq:*) +
 * the runEngineCycle buffer-request workshop notification.
 *
 * Covers:
 *   - parseCallbackData parses `ireq:accept:<id>` / `ireq:reject:<id>`;
 *   - dispatchCallback RBAC: only the producing workshop boss (or pm) may act —
 *     the sex_storage requester manager (an outsider here) gets `rbac`;
 *   - accept opens the gate (NEW -> CHECK_STORE_SUPPLIER) + notifies requester;
 *   - reject cancels (cancelled_by_fulfiller) + notifies requester;
 *   - runEngineCycle attaches ireq buttons to the workshop manager's nudge for a
 *     sex_storage buffer refill.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { createRequest, runEngineCycle } from '../src/services/replenishment.js';
import {
  parseCallbackData,
  dispatchCallback,
  type CallbackPrincipal,
} from '../src/integrations/telegram/dispatch.js';

let ctx: TestContext;
let rawWh: number;
let central: number;
let workshop: number;
let bufferStorage: number;
let workshopManagerId: number;
let bufferManagerId: number;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
  workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
  bufferStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: workshop });

  const wm = await makeUser(ctx.db, { role: 'production_manager', locationId: workshop });
  workshopManagerId = wm.id;
  const bm = await makeUser(ctx.db, { role: 'production_manager', locationId: bufferStorage });
  bufferManagerId = bm.id;
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [
    workshopManagerId,
    workshop,
  ]);
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [
    bufferManagerId,
    bufferStorage,
  ]);
});

function cp(
  userId: number,
  role: CallbackPrincipal['role'],
  locationId: number | null,
): CallbackPrincipal {
  return { userId, role, locationId };
}

async function makeBufferRequest(): Promise<number> {
  const semi = await makeProduct(ctx.db, { type: 'semi' });
  const row = await createRequest({
    productId: semi,
    requesterLocationId: bufferStorage,
    qtyNeeded: 8,
    actorUserId: null,
    origin: 'buffer',
  });
  return row.id;
}

describe('parseCallbackData — ireq verbs', () => {
  it('parses ireq:accept:<id>', () => {
    expect(parseCallbackData('ireq:accept:42')).toMatchObject({
      verb: 'ireq',
      entity: 'req',
      id: 42,
      subAction: 'accept',
    });
  });
  it('parses ireq:reject:<id>', () => {
    expect(parseCallbackData('ireq:reject:7')).toMatchObject({
      verb: 'ireq',
      subAction: 'reject',
      id: 7,
    });
  });
  it('rejects a bad sub-action / non-numeric id', () => {
    expect(parseCallbackData('ireq:frob:7')).toBeNull();
    expect(parseCallbackData('ireq:accept:abc')).toBeNull();
  });
});

describe('dispatchCallback — ireq RBAC + outcomes', () => {
  it('rejects an outsider (the sex_storage requester manager, not the workshop boss)', async () => {
    const reqId = await makeBufferRequest();
    const parsed = parseCallbackData(`ireq:accept:${reqId}`)!;
    // The buffer (requester) manager is NOT the producing workshop boss.
    const outcome = await dispatchCallback(
      parsed,
      cp(bufferManagerId, 'production_manager', bufferStorage),
    );
    expect(outcome.kind).toBe('rbac');
  });

  it('the workshop boss accepts → gate opens (NEW -> CHECK_STORE_SUPPLIER)', async () => {
    const reqId = await makeBufferRequest();
    const parsed = parseCallbackData(`ireq:accept:${reqId}`)!;
    const outcome = await dispatchCallback(
      parsed,
      cp(workshopManagerId, 'production_manager', workshop),
    );
    expect(outcome.kind).toBe('ok');

    const { rows } = await ctx.db.query<{ status: string; target_location_id: number | null }>(
      'SELECT status, target_location_id FROM replenishment_requests WHERE id = $1',
      [reqId],
    );
    expect(rows[0]?.status).toBe('CHECK_STORE_SUPPLIER');
    expect(Number(rows[0]?.target_location_id)).toBe(central);

    // The requester-side manager got an outcome notification.
    const { rows: notif } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM notifications WHERE recipient_user_id = $1`,
      [bufferManagerId],
    );
    expect(Number(notif[0]?.n)).toBeGreaterThan(0);
  });

  it('the workshop boss rejects → CANCELLED (cancelled_by_fulfiller)', async () => {
    const reqId = await makeBufferRequest();
    const parsed = parseCallbackData(`ireq:reject:${reqId}`)!;
    const outcome = await dispatchCallback(
      parsed,
      cp(workshopManagerId, 'production_manager', workshop),
    );
    expect(outcome.kind).toBe('ok');

    const { rows } = await ctx.db.query<{ status: string; closure_reason: string | null }>(
      'SELECT status, closure_reason FROM replenishment_requests WHERE id = $1',
      [reqId],
    );
    expect(rows[0]?.status).toBe('CANCELLED');
    expect(rows[0]?.closure_reason).toBe('cancelled_by_fulfiller');
  });

  it('pm may accept (no location scope)', async () => {
    const reqId = await makeBufferRequest();
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const parsed = parseCallbackData(`ireq:accept:${reqId}`)!;
    const outcome = await dispatchCallback(parsed, cp(pm.id, 'pm', null));
    expect(outcome.kind).toBe('ok');
    const { rows } = await ctx.db.query<{ status: string }>(
      'SELECT status FROM replenishment_requests WHERE id = $1',
      [reqId],
    );
    expect(rows[0]?.status).toBe('CHECK_STORE_SUPPLIER');
  });
});

describe('runEngineCycle — buffer-request workshop nudge carries ireq buttons', () => {
  it('a sex_storage below-min raises a request and nudges the workshop boss with ireq buttons', async () => {
    // Below-min buffer stock -> the scan creates a buffer request and notifies
    // the workshop manager with the actionable ireq:accept / ireq:reject buttons.
    const semi = await makeProduct(ctx.db, { type: 'semi' });
    await setStock(ctx.db, {
      locationId: bufferStorage,
      productId: semi,
      qty: 1,
      minLevel: 5,
      maxLevel: 20,
    });

    await runEngineCycle();

    // The request was created (origin buffer).
    const { rows: reqRows } = await ctx.db.query<{ id: number; origin: string }>(
      `SELECT id, origin FROM replenishment_requests
        WHERE requester_location_id = $1 AND product_id = $2`,
      [bufferStorage, semi],
    );
    expect(reqRows).toHaveLength(1);
    expect(reqRows[0]?.origin).toBe('buffer');
    const reqId = Number(reqRows[0]!.id);

    // The workshop manager got a nudge with ireq buttons.
    const { rows } = await ctx.db.query<{
      inline_callback: { buttons: { text: string; data: string }[][] } | null;
    }>(
      `SELECT inline_callback FROM notifications
        WHERE recipient_user_id = $1 ORDER BY id DESC LIMIT 1`,
      [workshopManagerId],
    );
    const data = (rows[0]?.inline_callback?.buttons ?? []).flat().map((b) => b.data);
    expect(data).toContain(`ireq:accept:${reqId}`);
    expect(data).toContain(`ireq:reject:${reqId}`);
  });
});
