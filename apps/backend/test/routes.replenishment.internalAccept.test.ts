/**
 * F-C / decision #8 — internal accept-gate routes for buffer (B-cycle) requests.
 *
 *   POST /api/replenishment/:id/accept-internal — the producing отдел boss
 *       accepts a sex_storage buffer refill: NEW -> CHECK_STORE_SUPPLIER (the
 *       gate opens). Idempotent. Audit row written.
 *   POST /api/replenishment/:id/reject-internal — the boss refuses it: CANCELLED
 *       (closure_reason='cancelled_by_fulfiller'). Requester manager notified.
 *
 * RBAC: the producing workshop is the requester sex_storage's PARENT. Only the
 * operator who manages THAT workshop may act; another sex's manager is 403; PM
 * is 403 (read-and-recommend write guard).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser } from './helpers/fixtures.js';
import { createRequest } from '../src/services/replenishment.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/**
 * A producing отдел: raw -> central -> workshop(production) -> its sex_storage
 * buffer. The workshop is the buffer's parent (the RBAC scope). Returns the ids
 * plus a workshop manager seeded onto the workshop location.
 */
async function buildOtdel(): Promise<{
  rawWh: number;
  central: number;
  workshop: number;
  bufferStorage: number;
  workshopMgrToken: string;
  workshopMgrId: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
  const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
  const bufferStorage = await makeLocation(ctx.db, { type: 'sex_storage', parentId: workshop });
  const mgr = await makeUser(ctx.db, { role: 'production_manager', locationId: workshop });
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [mgr.id, workshop]);
  return {
    rawWh,
    central,
    workshop,
    bufferStorage,
    workshopMgrToken: mgr.token,
    workshopMgrId: mgr.id,
  };
}

async function makeBufferRequest(bufferStorage: number): Promise<number> {
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

async function readStatus(id: number): Promise<string> {
  const { rows } = await ctx.db.query<{ status: string }>(
    'SELECT status FROM replenishment_requests WHERE id = $1',
    [id],
  );
  return rows[0]!.status;
}

describe('POST /:id/accept-internal', () => {
  it('advances exactly one step (NEW -> CHECK_STORE_SUPPLIER) + writes an audit row', async () => {
    const otdel = await buildOtdel();
    const reqId = await makeBufferRequest(otdel.bufferStorage);

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept-internal`)
      .set('Authorization', `Bearer ${otdel.workshopMgrToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.request.status).toBe('CHECK_STORE_SUPPLIER');
    // The upward central warehouse was resolved as the target.
    expect(Number(res.body.request.target_location_id)).toBe(otdel.central);

    // Exactly ONE forward step — did not chain past CHECK_STORE_SUPPLIER.
    expect(await readStatus(reqId)).toBe('CHECK_STORE_SUPPLIER');

    // Audit row for the internal accept exists.
    const { rows: audit } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE entity = 'replenishment_requests' AND entity_id = $1
          AND action = 'replenishment.accept_internal'`,
      [reqId],
    );
    expect(Number(audit[0]!.n)).toBe(1);

    // And a transition row carries the 'internal accept' note.
    const { rows: trans } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM replenishment_transitions
        WHERE replenishment_id = $1 AND reason = 'internal accept'`,
      [reqId],
    );
    expect(Number(trans[0]!.n)).toBe(1);
  });

  it('is idempotent — a second accept is a friendly no-op (accepted=false)', async () => {
    const otdel = await buildOtdel();
    const reqId = await makeBufferRequest(otdel.bufferStorage);

    const first = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept-internal`)
      .set('Authorization', `Bearer ${otdel.workshopMgrToken}`)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(true);

    const second = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept-internal`)
      .set('Authorization', `Bearer ${otdel.workshopMgrToken}`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.accepted).toBe(false);
    // Status unchanged by the second tap.
    expect(second.body.request.status).toBe('CHECK_STORE_SUPPLIER');

    // Only ONE accept-internal audit row (the no-op did not double-write).
    const { rows: audit } = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log
        WHERE entity = 'replenishment_requests' AND entity_id = $1
          AND action = 'replenishment.accept_internal'`,
      [reqId],
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('409 — the requester is NOT a sex_storage (wrong type, INVALID_TRANSITION)', async () => {
    // A non-sex_storage requester whose parent IS a production location, so the
    // RBAC scope resolves and we reach the service's type guard (422), not 403.
    const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const central = await makeLocation(ctx.db, { type: 'central_warehouse', parentId: rawWh });
    const workshop = await makeLocation(ctx.db, { type: 'production', parentId: central });
    // The requester is a SUPPLY location parented to the workshop (not a sex_storage).
    const supply = await makeLocation(ctx.db, { type: 'supply', parentId: workshop });
    const mgr = await makeUser(ctx.db, { role: 'production_manager', locationId: workshop });
    const semi = await makeProduct(ctx.db, { type: 'semi' });
    const row = await createRequest({
      productId: semi,
      requesterLocationId: supply,
      qtyNeeded: 5,
      actorUserId: null,
      origin: 'scan',
    });

    const res = await request(ctx.app)
      .post(`/api/replenishment/${row.id}/accept-internal`)
      .set('Authorization', `Bearer ${mgr.token}`)
      .send({});
    // INVALID_TRANSITION (409): accept-internal is only for a sex_storage requester.
    expect(res.status).toBe(409);
    // Untouched.
    expect(await readStatus(row.id)).toBe('NEW');
  });

  it('404 — unknown request id', async () => {
    const otdel = await buildOtdel();
    const res = await request(ctx.app)
      .post(`/api/replenishment/99999999/accept-internal`)
      .set('Authorization', `Bearer ${otdel.workshopMgrToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('RBAC — a manager of ANOTHER sex/workshop is 403', async () => {
    const otdel = await buildOtdel();
    const reqId = await makeBufferRequest(otdel.bufferStorage);
    // A different production manager assigned to an unrelated workshop.
    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept-internal`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(await readStatus(reqId)).toBe('NEW');
  });

  it('RBAC — PM is 403 (write guard)', async () => {
    const otdel = await buildOtdel();
    const reqId = await makeBufferRequest(otdel.bufferStorage);
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/accept-internal`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(await readStatus(reqId)).toBe('NEW');
  });
});

describe('POST /:id/reject-internal', () => {
  it('cancels with closure_reason=cancelled_by_fulfiller + fires a requester notification', async () => {
    const otdel = await buildOtdel();
    // Assign a manager to the buffer storage so the requester-side notification
    // (cancelRequest does not notify, but we assert the cancel itself; the
    // outcome notification for internal reject is the requester manager's).
    const bufMgr = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otdel.bufferStorage,
    });
    await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [
      bufMgr.id,
      otdel.bufferStorage,
    ]);
    const reqId = await makeBufferRequest(otdel.bufferStorage);

    const res = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/reject-internal`)
      .set('Authorization', `Bearer ${otdel.workshopMgrToken}`)
      .send({ reason: 'hozircha kerak emas' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('CANCELLED');
    expect(res.body.request.closure_reason).toBe('cancelled_by_fulfiller');

    // The reason landed on a transition row.
    const { rows: trans } = await ctx.db.query<{ reason: string }>(
      `SELECT reason FROM replenishment_transitions
        WHERE replenishment_id = $1 AND to_status = 'CANCELLED' ORDER BY id DESC LIMIT 1`,
      [reqId],
    );
    expect(trans[0]?.reason).toBe('hozircha kerak emas');
  });

  it('RBAC — a foreign workshop manager is 403; PM is 403', async () => {
    const otdel = await buildOtdel();
    const reqId = await makeBufferRequest(otdel.bufferStorage);
    const otherWorkshop = await makeLocation(ctx.db, { type: 'production' });
    const foreign = await makeUser(ctx.db, {
      role: 'production_manager',
      locationId: otherWorkshop,
    });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const r1 = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/reject-internal`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({ reason: 'x' });
    expect(r1.status).toBe(403);
    const r2 = await request(ctx.app)
      .post(`/api/replenishment/${reqId}/reject-internal`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ reason: 'x' });
    expect(r2.status).toBe(403);
    expect(await readStatus(reqId)).toBe('NEW');
  });
});
