/**
 * M1 — Auth integration tests (spec section 4.1).
 *
 *   POST /api/auth/login   — credentials -> token + user
 *   GET  /api/auth/me      — current principal
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
  it('returns a token and the public user for valid credentials', async () => {
    await makeUser(ctx.db, { role: 'pm', email: 'login-ok@test.local', password: 'secret-pass' });

    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'login-ok@test.local', password: 'secret-pass' });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.user).toMatchObject({ email: 'login-ok@test.local', role: 'pm' });
    // The password hash must never be exposed.
    expect(res.body.user).not.toHaveProperty('password_hash');
  });

  it('rejects a wrong password with a generic 401', async () => {
    await makeUser(ctx.db, { role: 'pm', email: 'login-bad@test.local', password: 'right-pass' });
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'login-bad@test.local', password: 'wrong-pass' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unknown email with the same generic 401 (no enumeration)', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: 'whatever' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed body with a 422', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ email: 'x@test.local' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid token', async () => {
    const user = await makeUser(ctx.db, { role: 'pm', email: 'me@test.local' });
    const res = await request(ctx.app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, email: 'me@test.local' });
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
