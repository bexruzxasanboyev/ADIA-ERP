/**
 * PM admin: editing/deleting employees (users) and departments (locations).
 *
 * Covers the new write surface:
 *   PATCH  /api/users/:id     — pm may change role + is_active (+ reactivate)
 *   DELETE /api/users/:id     — soft-delete; guards: self, last-active-pm
 *   DELETE /api/locations/:id — guarded hard delete (409 with dependents)
 *
 * Integration-style — drives the HTTP boundary against the per-suite schema,
 * exactly like the sibling route suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeProduct, makeUser, setStock } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// PATCH /api/users/:id — role + is_active (pm only)
// ---------------------------------------------------------------------------
describe('PATCH /api/users/:id — role and is_active (pm only)', () => {
  it('pm changes a user role and the public row reflects it', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const target = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ role: 'central_warehouse_manager' });

    expect(res.status).toBe(200);
    expect(res.body.user?.role).toBe('central_warehouse_manager');

    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'user.update' AND entity_id = $1`,
      [target.id],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('rejects an unknown role with 422', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const target = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ role: 'demigod' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('a non-pm cannot change role/is_active even on its own row (403)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const self = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .patch(`/api/users/${self.id}`)
      .set('Authorization', `Bearer ${self.token}`)
      .send({ role: 'pm' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('a non-pm may still rename its own name/username', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const self = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .patch(`/api/users/${self.id}`)
      .set('Authorization', `Bearer ${self.token}`)
      .send({ name: 'Renamed Self' });
    expect(res.status).toBe(200);
    expect(res.body.user?.name).toBe('Renamed Self');
  });

  it('rejects demoting a chain-wide user with no location to an operational role (422)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    // ai_assistant has NULL location — demoting to store_manager would violate
    // chk_users_location_required; we surface a clean 422 instead of a 500.
    const ai = await makeUser(ctx.db, { role: 'ai_assistant', locationId: null });

    const res = await request(ctx.app)
      .patch(`/api/users/${ai.id}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ role: 'store_manager' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('reactivates a deactivated user via is_active=true', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const target = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    await ctx.db.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [target.id]);

    const res = await request(ctx.app)
      .patch(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${pm.token}`)
      .send({ is_active: true });
    expect(res.status).toBe(200);
    expect(res.body.user?.is_active).toBe(true);
  });

  it('refuses to deactivate the last active pm via PATCH (409)', async () => {
    // This suite shares a schema; the seed migration leaves no pm, so the only
    // active pm here is the one we create. Demoting/deactivating it must fail.
    const onlyPm = await makeUser(ctx.db, { role: 'pm' });
    // Ensure it is genuinely the lone active pm.
    await ctx.db.query(
      `UPDATE users SET is_active = FALSE WHERE role = 'pm' AND id <> $1`,
      [onlyPm.id],
    );

    const res = await request(ctx.app)
      .patch(`/api/users/${onlyPm.id}`)
      .set('Authorization', `Bearer ${onlyPm.token}`)
      .send({ is_active: false });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('CONFLICT');

    // Re-activate the pms we parked so later tests still have a usable pm.
    await ctx.db.query(`UPDATE users SET is_active = TRUE WHERE role = 'pm'`);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/users/:id — soft delete + guards
// ---------------------------------------------------------------------------
describe('DELETE /api/users/:id — soft delete', () => {
  it('deactivates a user (is_active=false), keeps the row', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const target = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .delete(`/api/users/${target.id}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user?.is_active).toBe(false);

    // Row still exists (soft delete, not hard).
    const still = await ctx.db.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [target.id],
    );
    expect(still.rows.length).toBe(1);

    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'user.deactivate' AND entity_id = $1`,
      [target.id],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('a pm cannot deactivate itself (409)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .delete(`/api/users/${pm.id}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('CONFLICT');
  });

  it('allows one pm to deactivate another while a second active pm remains (200)', async () => {
    const pmA = await makeUser(ctx.db, { role: 'pm' });
    const pmB = await makeUser(ctx.db, { role: 'pm' });
    // Park everyone else so exactly pmA + pmB are active pms.
    await ctx.db.query(
      `UPDATE users SET is_active = FALSE
         WHERE role = 'pm' AND id NOT IN ($1, $2)`,
      [pmA.id, pmB.id],
    );

    const res = await request(ctx.app)
      .delete(`/api/users/${pmB.id}`)
      .set('Authorization', `Bearer ${pmA.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user?.is_active).toBe(false);

    await ctx.db.query(`UPDATE users SET is_active = TRUE WHERE role = 'pm'`);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/locations/:id — guarded hard delete
// ---------------------------------------------------------------------------
describe('DELETE /api/locations/:id — guarded hard delete', () => {
  it('hard-deletes a location with no dependents (204)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });

    const res = await request(ctx.app)
      .delete(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(204);

    const gone = await ctx.db.query<{ id: string }>(
      `SELECT id FROM locations WHERE id = $1`,
      [loc],
    );
    expect(gone.rows.length).toBe(0);

    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'location.delete' AND entity_id = $1`,
      [loc],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('returns 404 for a missing location', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .delete('/api/locations/999999')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(404);
  });

  it('refuses to delete a location that has an assigned user (409)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });
    // makeUser wires both users.location_id and user_locations.
    await makeUser(ctx.db, { role: 'store_manager', locationId: loc });

    const res = await request(ctx.app)
      .delete(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('CONFLICT');
    expect(String(res.body.error?.message)).toContain('arxiv');

    // Still present — refused, not removed.
    const still = await ctx.db.query<{ id: string }>(
      `SELECT id FROM locations WHERE id = $1`,
      [loc],
    );
    expect(still.rows.length).toBe(1);
  });

  it('refuses to delete a location that has stock rows (409)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'central_warehouse' });
    const product = await makeProduct(ctx.db, {});
    await setStock(ctx.db, { locationId: loc, productId: product, qty: 5 });

    const res = await request(ctx.app)
      .delete(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('CONFLICT');
  });

  it('refuses to delete a parent that has child locations (409)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const parent = await makeLocation(ctx.db, { type: 'production' });
    await makeLocation(ctx.db, { type: 'production', parentId: parent });

    const res = await request(ctx.app)
      .delete(`/api/locations/${parent}`)
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('CONFLICT');
  });

  it('a non-pm cannot delete a location (403)', async () => {
    const loc = await makeLocation(ctx.db, { type: 'store' });
    const mgr = await makeUser(ctx.db, { role: 'store_manager', locationId: loc });
    const res = await request(ctx.app)
      .delete(`/api/locations/${loc}`)
      .set('Authorization', `Bearer ${mgr.token}`);
    expect(res.status).toBe(403);
  });
});
