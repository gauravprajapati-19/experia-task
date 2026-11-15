import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bearer } from './helpers/auth.js';
import { createTestWorld, resetDb, type TestWorld } from './helpers/db.js';

const app = createApp();
let world: TestWorld;

beforeEach(async () => {
  await resetDb();
  world = await createTestWorld();
});

describe('GET /api/admin/merchants', () => {
  it('lists every merchant (id + name only) for an admin', async () => {
    const res = await request(app).get('/api/admin/merchants').set(bearer(world.admin)).expect(200);
    expect(res.body).toEqual({
      items: [
        { id: world.merchantA.id, name: 'Test Merchant A' },
        { id: world.merchantB.id, name: 'Test Merchant B' },
      ],
    });
  });

  it('returns 403 for a merchant user', async () => {
    const res = await request(app).get('/api/admin/merchants').set(bearer(world.merchantA.user)).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 401 without credentials', async () => {
    await request(app).get('/api/admin/merchants').expect(401);
  });
});
