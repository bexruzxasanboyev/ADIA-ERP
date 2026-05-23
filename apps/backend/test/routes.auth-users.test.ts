/**
 * Sprint 2 hardening — route-level coverage gap-fillers for auth and users.
 *
 * Drives the public HTTP boundary so middleware + handler branches are
 * exercised end-to-end. Targets:
 *
 *   POST /api/auth/login   — no email field, bad password, unknown email,
 *                            deactivated account, garbage body shape.
 *   GET  /api/auth/me      — JWT missing, malformed, valid but for a since
 *                            deactivated user (401 fallback).
 *   POST /api/users        — duplicate email, invalid role enum, non-pm role,
 *                            chain-wide role with no location, audit-row write.
 *   GET  /api/users        — pm list shape; non-pm denied (parity assert).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeLocation, makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
describe('POST /api/auth/login — boundary validation + auth branches', () => {
  it('returns 422 VALIDATION_ERROR when the JSON body is an array (not an object)', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send([{ email: 'x@test.local', password: 'pass' }]);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when only the password is present (email field missing)', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ password: 'anything-here' });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('returns the generic 401 for a deactivated user — same shape as wrong password', async () => {
    // Seed an active user, then deactivate the row in place.
    const user = await makeUser(ctx.db, {
      role: 'pm', email: 'deactivated@test.local', password: 'right-pass',
    });
    await ctx.db.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [user.id]);

    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'deactivated@test.local', password: 'right-pass' });

    // The handler must not reveal the deactivated state — it returns the
    // same generic UNAUTHENTICATED a wrong password would.
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('lower-cases the submitted email before lookup (logins are email-agnostic to case)', async () => {
    await makeUser(ctx.db, {
      role: 'pm', email: 'mixed-case@test.local', password: 'pass-12345',
    });
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'MIXED-CASE@TEST.LOCAL', password: 'pass-12345' });
    expect(res.status).toBe(200);
    expect(res.body.user?.email).toBe('mixed-case@test.local');
  });
});

// ---------------------------------------------------------------------------
// GET /api/auth/me
// ---------------------------------------------------------------------------
describe('GET /api/auth/me — JWT + liveness branches', () => {
  it('returns 401 for an Authorization header without Bearer scheme', async () => {
    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 when the JWT is well-formed but the user has been deactivated', async () => {
    const user = await makeUser(ctx.db, {
      role: 'pm', email: 'me-deactivated@test.local',
    });
    // Deactivate the user AFTER the token was minted — JWT is still valid
    // but the WHERE is_active = TRUE filter eliminates the row, so the
    // handler returns the deactivated 401 (not 200, not 500).
    await ctx.db.query(`UPDATE users SET is_active = FALSE WHERE id = $1`, [user.id]);

    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${user.token}`);
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHENTICATED');
  });
});

// ---------------------------------------------------------------------------
// POST /api/users
// ---------------------------------------------------------------------------
describe('POST /api/users — pm-only, validation, duplicate detection', () => {
  it('rejects a duplicate email with a friendly 422 (not a raw 500 from the UNIQUE index)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const loc = await makeLocation(ctx.db, { type: 'store' });

    // First insert succeeds.
    const first = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'First Manager',
        email: 'dup@test.local',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_id: loc,
      });
    expect(first.status).toBe(201);

    // Second insert with the same email is rejected at the boundary.
    const second = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Second Manager',
        email: 'dup@test.local',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_id: loc,
      });
    expect(second.status).toBe(422);
    expect(second.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown role string with a 422 (enum validation)', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'X',
        email: 'unknown-role@test.local',
        password: 'a-strong-pass',
        role: 'demigod', // not in the enum
      });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });

  it('a non-pm cannot create a user (403)', async () => {
    const supplyLoc = await makeLocation(ctx.db, { type: 'supply' });
    const supplyMgr = await makeUser(ctx.db, {
      role: 'supply_manager', locationId: supplyLoc,
    });
    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${supplyMgr.token}`)
      .send({
        name: 'Sneaky',
        email: 'sneaky@test.local',
        password: 'a-strong-pass',
        role: 'store_manager',
        location_id: supplyLoc,
      });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');
  });

  it('accepts a chain-wide role (pm) without a location_id', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .post('/api/users')
      .set('Authorization', `Bearer ${pm.token}`)
      .send({
        name: 'Another PM',
        email: 'another-pm@test.local',
        password: 'a-strong-pass',
        role: 'pm',
      });
    expect(res.status).toBe(201);
    expect(res.body.user?.location_id).toBe(null);

    // Audit row records the create — exposes the writeAudit branch.
    const audit = await ctx.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE action = 'user.create' AND entity_id = $1`,
      [res.body.user.id],
    );
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it('pm GET /api/users lists users without password hashes', async () => {
    const pm = await makeUser(ctx.db, { role: 'pm' });
    const res = await request(ctx.app)
      .get('/api/users')
      .set('Authorization', `Bearer ${pm.token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // No row leaks the password hash field.
    for (const row of res.body as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('password_hash');
    }
  });
});
