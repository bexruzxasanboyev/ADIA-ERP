/**
 * M1 — Auth integration tests (spec section 4.1).
 *
 *   POST /api/auth/login   — credentials -> token + user
 *   GET  /api/auth/me      — current principal
 *
 * Login is username-only (email was removed from the identity model entirely).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers/context.js';
import { makeUser } from './helpers/fixtures.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.dispose();
});

describe('POST /api/auth/login', () => {
  it('returns access + refresh tokens and the public user for valid credentials', async () => {
    await makeUser(ctx.db, { role: 'pm', username: 'login-ok', password: 'secret-pass' });

    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ login: 'login-ok', password: 'secret-pass' });

    expect(res.status).toBe(200);
    // Sprint-3 (ADR-0005) — login now returns BOTH tokens.
    expect(typeof res.body.access_token).toBe('string');
    expect(typeof res.body.refresh_token).toBe('string');
    expect(res.body.refresh_token).toHaveLength(64); // 32 bytes -> 64 hex chars
    // Backward-compat alias retained for one release.
    expect(res.body.token).toBe(res.body.access_token);
    expect(res.body.user).toMatchObject({ username: 'login-ok', role: 'pm' });
    // Email was removed from the identity model entirely.
    expect(res.body.user).not.toHaveProperty('email');
    // The password hash must never be exposed.
    expect(res.body.user).not.toHaveProperty('password_hash');
  });

  it('rejects a wrong password with a generic 401', async () => {
    await makeUser(ctx.db, { role: 'pm', username: 'login-bad', password: 'right-pass' });
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ login: 'login-bad', password: 'wrong-pass' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unknown login with the same generic 401 (no enumeration)', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ login: 'nobody', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('matches the username case-insensitively', async () => {
    await makeUser(ctx.db, { role: 'pm', username: 'mixed-case', password: 'pass-12345' });
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ login: 'MIXED-CASE', password: 'pass-12345' });
    expect(res.status).toBe(200);
    expect(res.body.user?.username).toBe('mixed-case');
  });

  it('rejects a malformed body with a 422', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ login: 'x-user' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid token', async () => {
    const user = await makeUser(ctx.db, { role: 'pm', username: 'me-user' });
    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, username: 'me-user' });
    expect(res.body.user).not.toHaveProperty('email');
  });

  it('rejects a missing token with 401', async () => {
    const res = await request(ctx.app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a garbage token with 401', async () => {
    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(401);
  });
});
