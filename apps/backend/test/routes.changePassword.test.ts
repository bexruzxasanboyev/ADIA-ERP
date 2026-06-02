/**
 * Sprint — self-service change-password tests (spec section 4.1).
 *
 *   POST /api/auth/change-password — { current_password, new_password }
 *     - requires authentication; operates on the CURRENT user only,
 *     - wrong current password           -> 401,
 *     - too-short new password           -> 422 (validation),
 *     - missing field / malformed body   -> 422,
 *     - success                          -> 204; new password logs in,
 *       old password is rejected.
 *
 * The password hash lives in `users.password_hash`; the endpoint never
 * accepts a target userId, so a user can only change their own password.
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

describe('POST /api/auth/change-password', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/change-password')
      .send({ current_password: 'old-pass-123', new_password: 'new-pass-123' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a wrong current password with 401', async () => {
    const user = await makeUser(ctx.db, {
      role: 'pm',
      username: 'cp-wrong',
      password: 'correct-current',
    });
    const res = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ current_password: 'not-the-current', new_password: 'brand-new-pass' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.message).toBe("Joriy parol noto'g'ri.");
  });

  it('rejects a too-short new password with 422', async () => {
    const user = await makeUser(ctx.db, {
      role: 'pm',
      username: 'cp-short',
      password: 'correct-current',
    });
    const res = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ current_password: 'correct-current', new_password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed body (missing new_password) with 422', async () => {
    const user = await makeUser(ctx.db, {
      role: 'pm',
      username: 'cp-missing',
      password: 'correct-current',
    });
    const res = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ current_password: 'correct-current' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('changes the password on success: new password logs in, old one fails', async () => {
    const user = await makeUser(ctx.db, {
      role: 'pm',
      username: 'cp-success',
      password: 'old-password-1',
    });

    // Sanity: the old password works before the change.
    const before = await request(ctx.app)
      .post('/api/auth/login')
      .send({ login: 'cp-success', password: 'old-password-1' });
    expect(before.status).toBe(200);

    const change = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ current_password: 'old-password-1', new_password: 'new-password-2' });
    expect(change.status).toBe(204);

    // The NEW password now logs in.
    const withNew = await request(ctx.app)
      .post('/api/auth/login')
      .send({ login: 'cp-success', password: 'new-password-2' });
    expect(withNew.status).toBe(200);
    expect(withNew.body.user).toMatchObject({ username: 'cp-success' });

    // The OLD password is now rejected with the generic 401.
    const withOld = await request(ctx.app)
      .post('/api/auth/login')
      .send({ login: 'cp-success', password: 'old-password-1' });
    expect(withOld.status).toBe(401);
    expect(withOld.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('revokes the user\'s existing refresh tokens after a change', async () => {
    const user = await makeUser(ctx.db, {
      role: 'pm',
      username: 'cp-revoke',
      password: 'old-password-1',
    });
    // Obtain a refresh token via a real login.
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ login: 'cp-revoke', password: 'old-password-1' });
    const refreshToken = login.body.refresh_token as string;
    expect(typeof refreshToken).toBe('string');

    const change = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ current_password: 'old-password-1', new_password: 'new-password-2' });
    expect(change.status).toBe(204);

    // The pre-change refresh token can no longer be rotated.
    const refresh = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refresh_token: refreshToken });
    expect(refresh.status).toBe(401);
  });
});
