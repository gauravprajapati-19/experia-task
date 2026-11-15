import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signSessionToken } from '../src/auth/jwt.js';
import { config } from '../src/config.js';
import { tokenFor } from './helpers/auth.js';
import { createTestWorld, resetDb, TEST_PASSWORD, type TestWorld } from './helpers/db.js';

const app = createApp(config);
let world: TestWorld;

beforeEach(async () => {
  await resetDb();
  world = await createTestWorld();
});

function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('session='));
  if (!cookie) throw new Error('no session cookie set');
  return cookie;
}

describe('POST /api/auth/login', () => {
  it('returns a token and user, and sets an httpOnly SameSite=Lax session cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: world.merchantA.user.email, password: TEST_PASSWORD })
      .expect(200);

    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.user).toEqual({
      id: world.merchantA.user.id,
      email: world.merchantA.user.email,
      role: 'merchant',
      merchantId: world.merchantA.id,
      merchantName: 'Test Merchant A',
    });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('normalises email case and whitespace', async () => {
    await request(app)
      .post('/api/auth/login')
      .send({ email: `  ${world.admin.email.toUpperCase()} `, password: TEST_PASSWORD })
      .expect(200);
  });

  it('gives the same generic error for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: world.merchantA.user.email, password: 'not-the-password' })
      .expect(401);
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: TEST_PASSWORD })
      .expect(401);

    const expected = { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } };
    expect(wrongPassword.body).toEqual(expected);
    expect(unknownEmail.body).toEqual(expected);
  });

  it('rejects an invalid body with 422 and the standard error shape', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'password' })]));
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rate-limits repeated login attempts per IP', async () => {
    const limitedApp = createApp({ ...config, LOGIN_RATE_LIMIT_PER_MIN: 3 });
    const attempt = () => request(limitedApp).post('/api/auth/login').send({ email: 'x@test.local', password: 'wrong' });

    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('GET /api/auth/me', () => {
  it('accepts a Bearer token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenFor(world.admin)}`)
      .expect(200);
    expect(res.body.user).toMatchObject({ id: world.admin.id, role: 'admin', merchantId: null });
  });

  it('accepts the session cookie set by login', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: world.merchantB.user.email, password: TEST_PASSWORD })
      .expect(200);
    const res = await request(app).get('/api/auth/me').set('Cookie', sessionCookie(login).split(';')[0]!).expect(200);
    expect(res.body.user).toMatchObject({ id: world.merchantB.user.id, merchantId: world.merchantB.id });
  });

  it('returns 401 without credentials', async () => {
    const res = await request(app).get('/api/auth/me').expect(401);
    expect(res.body).toEqual({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
  });

  it('returns 401 for a token signed with another secret', async () => {
    const forged = signSessionToken(
      { userId: world.admin.id, role: 'admin', merchantId: null },
      'some-other-secret-that-is-at-least-32-chars-long',
    );
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
  });

  it('returns 401 for an unsigned (alg=none) token', async () => {
    const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: world.admin.id, role: 'admin', merchantId: null })}.`;
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${unsigned}`).expect(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await request(app).post('/api/auth/logout').expect(204);
    expect(sessionCookie(res)).toMatch(/session=;/);
  });
});
