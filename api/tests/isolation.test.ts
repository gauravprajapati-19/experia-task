import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resolveMerchantScope } from '../src/auth/merchantScope.js';
import { createRequireAuth, getAuth, requireRole } from '../src/auth/middleware.js';
import type { AuthContext } from '../src/auth/types.js';
import { config } from '../src/config.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { bearer, tokenFor } from './helpers/auth.js';
import { createTestWorld, insertPayment, resetDb, type TestUser, type TestWorld } from './helpers/db.js';

// Test 10: merchant isolation (CLAUDE.md 6.1). Unit tests for the scope rule, then the real routes.

const merchantA: AuthContext = { userId: 'u-a', role: 'merchant', merchantId: 'merchant-a' };
const admin: AuthContext = { userId: 'u-admin', role: 'admin', merchantId: null };

describe('resolveMerchantScope', () => {
  it('pins a merchant user to the merchant in their JWT, ignoring any requested merchant', () => {
    expect(resolveMerchantScope(merchantA)).toBe('merchant-a');
    expect(resolveMerchantScope(merchantA, 'merchant-b')).toBe('merchant-a');
  });

  it('lets an admin see all merchants or filter to one', () => {
    expect(resolveMerchantScope(admin)).toBeNull();
    expect(resolveMerchantScope(admin, 'merchant-b')).toBe('merchant-b');
  });
});

describe('requireAuth + requireRole', () => {
  const probe = express();
  probe.get('/admin-only', createRequireAuth(config.JWT_SECRET), requireRole('admin'), (req, res) => {
    res.json({ role: getAuth(req).role });
  });
  probe.use(errorHandler);

  const users: Record<string, TestUser> = {
    merchant: { id: crypto.randomUUID(), email: 'm@test.local', role: 'merchant', merchantId: crypto.randomUUID() },
    admin: { id: crypto.randomUUID(), email: 'a@test.local', role: 'admin', merchantId: null },
  };

  it('returns 401 without a token', async () => {
    await request(probe).get('/admin-only').expect(401);
  });

  it('returns 403 for a merchant on an admin-only route', async () => {
    const res = await request(probe).get('/admin-only').set('Authorization', `Bearer ${tokenFor(users.merchant!)}`).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('allows an admin', async () => {
    const res = await request(probe).get('/admin-only').set('Authorization', `Bearer ${tokenFor(users.admin!)}`).expect(200);
    expect(res.body).toEqual({ role: 'admin' });
  });
});

describe('test 10: merchant isolation on the payment routes', () => {
  const app = createApp(undefined, { provider: null });
  let world: TestWorld;
  let paymentA: { id: string; reference: string };
  let paymentB: { id: string; reference: string };

  beforeEach(async () => {
    await resetDb();
    world = await createTestWorld();
    paymentA = await insertPayment(world.merchantA.id, { status: 'SUCCESS', amountPaise: 1_000 });
    paymentB = await insertPayment(world.merchantB.id, { status: 'SUCCESS', amountPaise: 9_000 });
  });

  it("returns 404 (not 403) when Merchant A reads Merchant B's payment", async () => {
    const res = await request(app).get(`/api/payments/${paymentB.id}`).set(bearer(world.merchantA.user)).expect(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Payment not found' });
    await request(app).get(`/api/payments/${paymentA.id}`).set(bearer(world.merchantA.user)).expect(200);
  });

  it("lists only the caller's own payments, even when another merchantId is requested", async () => {
    for (const qs of ['', `?merchantId=${world.merchantB.id}`, `?q=${paymentB.reference}`]) {
      const res = await request(app).get(`/api/payments${qs}`).set(bearer(world.merchantA.user)).expect(200);
      expect(res.body.items.map((p: { id: string }) => p.id)).toEqual(qs.includes('q=') ? [] : [paymentA.id]);
    }
  });

  it("scopes the summary to the caller's merchant", async () => {
    const res = await request(app)
      .get(`/api/payments/summary?merchantId=${world.merchantB.id}`)
      .set(bearer(world.merchantA.user))
      .expect(200);
    expect(res.body).toMatchObject({ totalCount: 1, totalAmountPaise: 1_000 });
  });

  it('lets an admin read every merchant, filter by merchantId, and open any payment', async () => {
    const all = await request(app).get('/api/payments').set(bearer(world.admin)).expect(200);
    expect(all.body.total).toBe(2);

    const onlyB = await request(app).get(`/api/payments?merchantId=${world.merchantB.id}`).set(bearer(world.admin)).expect(200);
    expect(onlyB.body.items.map((p: { id: string }) => p.id)).toEqual([paymentB.id]);

    const summaryB = await request(app).get(`/api/payments/summary?merchantId=${world.merchantB.id}`).set(bearer(world.admin)).expect(200);
    expect(summaryB.body).toMatchObject({ totalCount: 1, totalAmountPaise: 9_000 });

    await request(app).get(`/api/payments/${paymentB.id}`).set(bearer(world.admin)).expect(200);
  });

  it('forbids merchants from calling /api/admin/* (403)', async () => {
    for (const path of ['/api/admin/merchants', '/api/admin/reconcile', '/api/admin/reconciliation-runs']) {
      const method = path.endsWith('/reconcile') ? 'post' : 'get';
      const res = await request(app)[method](path).set(bearer(world.merchantA.user)).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('requires authentication before any scoping happens', async () => {
    await request(app).get(`/api/payments?merchantId=${world.merchantB.id}`).expect(401);
    await request(app).get(`/api/payments/${randomUUID()}`).expect(401);
  });
});
