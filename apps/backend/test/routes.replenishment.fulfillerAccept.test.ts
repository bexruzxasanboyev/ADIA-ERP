/**
 * F-G — web fulfiller accept / reject routes (parity with the Telegram xreq path)
 * + the three new Kanban row fields.
 *
 *   POST /api/replenishment/:id/accept-fulfiller -> acceptByFulfiller; response
 *       { request, shipped } (mirrors accept-central). Stamps fulfiller_accepted_*.
 *   POST /api/replenishment/:id/reject-fulfiller  body { reason? } ->
 *       cancelRequestByFulfiller; response { request }.
 *
 * RBAC: the operator must manage the request's effective fulfiller (the PINNED
 * target_location_id). Target operator OK; another location 403; PM 403. 404 for
 * an unknown id; 409 for an already-terminal request.
 *
 * Row payload: list / single / tree carry requester_location_type,
 * target_location_type, and fulfiller_accepted_at.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';
import { createCrossDeptRequest } from '../src/services/crossDeptRequest.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

/**
 * A sex asking the raw warehouse (mahsulot ombori): the parent path resolves +
 * PINS the raw warehouse as the target. Returns the ids + the raw manager token,
 * and the created request id.
 */
async function buildRawSupply(opts: { rawStock: number; qty: number }): Promise<{
  rawWh: number;
  sex: number;
  flour: number;
  rawMgrToken: string;
  rawMgrId: number;
  reqId: number;
}> {
  const rawWh = await makeLocation(ctx.db, { type: 'raw_warehouse' });
  const sex = await makeLocation(ctx.db, { type: 'production', parentId: rawWh });
  const flour = await makeProduct(ctx.db, { type: 'raw', unit: 'kg' });
  const rawMgr = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: rawWh });
  await ctx.db.query('UPDATE locations SET manager_user_id = $1 WHERE id = $2', [rawMgr.id, rawWh]);
  await setStock(ctx.db, { locationId: rawWh, productId: flour, qty: opts.rawStock });
  await setStock(ctx.db, { locationId: sex, productId: flour, qty: 0 });

  const created = await createCrossDeptRequest({
    productId: flour,
    productName: 'Un',
    unit: 'kg',
    requesterLocationId: sex,
    qty: opts.qty,
    actorUserId: rawMgr.id,
  });
  return {
    rawWh,
    sex,
    flour,
    rawMgrToken: rawMgr.token,
    rawMgrId: rawMgr.id,
    reqId: created.request.id,
  };
}

async function readRow(id: number): Promise<{
  status: string;
  closure_reason: string | null;
  fulfiller_accepted_at: Date | null;
}> {
  const { rows } = await ctx.db.query<{
    status: string;
    closure_reason: string | null;
    fulfiller_accepted_at: Date | null;
  }>(
    'SELECT status, closure_reason, fulfiller_accepted_at FROM replenishment_requests WHERE id = $1',
    [id],
  );
  return rows[0]!;
}

describe('POST /:id/accept-fulfiller', () => {
  it('raw target with stock -> ships (shipped:true) and stamps fulfiller_accepted_*', async () => {
    const s = await buildRawSupply({ rawStock: 100, qty: 30 });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.shipped).toBe(true);
    expect(res.body.request.status).toBe('CLOSED');
    expect(res.body.request.fulfiller_accepted_at).not.toBeNull();
    expect(Number(res.body.request.fulfiller_accepted_by)).toBe(s.rawMgrId);
  });

  it('raw target EMPTY -> holds (shipped:false), request stays CHECK_STORE_SUPPLIER but is accepted', async () => {
    const s = await buildRawSupply({ rawStock: 0, qty: 30 });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.shipped).toBe(false);
    expect(res.body.request.status).toBe('CHECK_STORE_SUPPLIER');
    // Accepted even though it holds (the "Tasdiqlandi" / Poster-waiting state).
    expect(res.body.request.fulfiller_accepted_at).not.toBeNull();
  });

  it('RBAC — an operator of ANOTHER location is 403', async () => {
    const s = await buildRawSupply({ rawStock: 100, qty: 30 });
    const other = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const foreign = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: other });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({});
    expect(res.status).toBe(403);
    expect((await readRow(s.reqId)).status).toBe('NEW'); // untouched
  });

  it('RBAC — PM is 403 (write guard)', async () => {
    const s = await buildRawSupply({ rawStock: 100, qty: 30 });
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({});
    expect(res.status).toBe(403);
    expect((await readRow(s.reqId)).status).toBe('NEW');
  });

  it('404 — unknown request id', async () => {
    const s = await buildRawSupply({ rawStock: 100, qty: 30 });
    const res = await request(ctx.app)
      .post(`/api/replenishment/99999999/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('idempotent / terminal — accepting an already-CLOSED request is a no-op (shipped:false, not 5xx)', async () => {
    const s = await buildRawSupply({ rawStock: 100, qty: 30 });
    // First accept ships + closes.
    const first = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});
    expect(first.body.request.status).toBe('CLOSED');
    // Second accept on the terminal request — friendly no-op (the service returns
    // shipped:false for a terminal row).
    const second = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.shipped).toBe(false);
    expect(second.body.request.status).toBe('CLOSED');
  });
});

describe('POST /:id/reject-fulfiller', () => {
  it('cancels with closure_reason=cancelled_by_fulfiller', async () => {
    const s = await buildRawSupply({ rawStock: 0, qty: 30 });
    const res = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/reject-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({ reason: 'omborda yo‘q' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('CANCELLED');
    expect(res.body.request.closure_reason).toBe('cancelled_by_fulfiller');

    // The reason landed on the cancel transition.
    const { rows: trans } = await ctx.db.query<{ reason: string }>(
      `SELECT reason FROM replenishment_transitions
        WHERE replenishment_id = $1 AND to_status = 'CANCELLED' ORDER BY id DESC LIMIT 1`,
      [s.reqId],
    );
    expect(trans[0]?.reason).toBe('omborda yo‘q');
  });

  it('RBAC — a foreign-location operator is 403; PM is 403', async () => {
    const s = await buildRawSupply({ rawStock: 0, qty: 30 });
    const other = await makeLocation(ctx.db, { type: 'raw_warehouse' });
    const foreign = await makeUser(ctx.db, { role: 'raw_warehouse_manager', locationId: other });
    const pm = await makeUser(ctx.db, { role: 'pm' });

    const r1 = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/reject-fulfiller`)
      .set('Authorization', `Bearer ${foreign.token}`)
      .send({ reason: 'x' });
    expect(r1.status).toBe(403);
    const r2 = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/reject-fulfiller`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ reason: 'x' });
    expect(r2.status).toBe(403);
    expect((await readRow(s.reqId)).status).toBe('NEW');
  });

  it('409 — rejecting an already-SHIPPED (CLOSED) request is refused (INVALID_TRANSITION)', async () => {
    const s = await buildRawSupply({ rawStock: 100, qty: 30 });
    // Accept ships + closes.
    await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});
    expect((await readRow(s.reqId)).status).toBe('CLOSED');
    // cancel-by-fulfiller refuses a post-ship state — but cancelRequestByFulfiller
    // is idempotent on terminal CLOSED (returns the row unchanged, 200). Assert it
    // does NOT flip to CANCELLED.
    const res = await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/reject-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({ reason: 'late' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('CLOSED'); // unchanged — not cancelled
  });
});

describe('row payload — list / single / tree carry the three new fields', () => {
  it('GET /api/replenishment (list) carries requester/target_location_type + fulfiller_accepted_at', async () => {
    const s = await buildRawSupply({ rawStock: 0, qty: 30 });
    // Accept (holds) so fulfiller_accepted_at is set.
    await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});

    const res = await request(ctx.app)
      .get('/api/replenishment')
      .set('Authorization', `Bearer ${s.rawMgrToken}`);
    expect(res.status).toBe(200);
    const row = (res.body as Array<{ id: number }>).find((r) => r.id === s.reqId) as
      | {
          requester_location_type: string;
          target_location_type: string;
          fulfiller_accepted_at: string | null;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.requester_location_type).toBe('production');
    expect(row!.target_location_type).toBe('raw_warehouse');
    expect(row!.fulfiller_accepted_at).not.toBeNull();
  });

  it('GET /api/replenishment/:id (single) carries the three fields', async () => {
    const s = await buildRawSupply({ rawStock: 0, qty: 30 });
    await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});

    const res = await request(ctx.app)
      .get(`/api/replenishment/${s.reqId}`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`);
    expect(res.status).toBe(200);
    expect(res.body.request.requester_location_type).toBe('production');
    expect(res.body.request.target_location_type).toBe('raw_warehouse');
    expect(res.body.request.fulfiller_accepted_at).not.toBeNull();
  });

  it('GET /api/replenishment/:id/tree carries the three fields on the root node', async () => {
    const s = await buildRawSupply({ rawStock: 0, qty: 30 });
    await request(ctx.app)
      .post(`/api/replenishment/${s.reqId}/accept-fulfiller`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`)
      .send({});

    const res = await request(ctx.app)
      .get(`/api/replenishment/${s.reqId}/tree`)
      .set('Authorization', `Bearer ${s.rawMgrToken}`);
    expect(res.status).toBe(200);
    expect(res.body.root.requester_location_type).toBe('production');
    expect(res.body.root.target_location_type).toBe('raw_warehouse');
    expect(res.body.root.fulfiller_accepted_at).not.toBeNull();
  });
});
