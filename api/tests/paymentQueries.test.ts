import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { bearer } from './helpers/auth.js';
import { createTestWorld, insertPayment, resetDb, type TestWorld } from './helpers/db.js';

const app = createApp(undefined, { provider: null }); // no provider registration: these tests cover our own API
let world: TestWorld;

beforeEach(async () => {
  await resetDb();
  world = await createTestWorld();
});

/** n payments for one merchant, one minute apart (newest last), so ordering is deterministic. */
async function insertSeries(merchantId: string, n: number, status: 'PENDING' | 'SUCCESS' | 'FAILED' = 'PENDING') {
  const base = Date.now() - n * 60_000;
  const created = [];
  for (let i = 0; i < n; i++) {
    created.push(await insertPayment(merchantId, { status, amountPaise: 100 * (i + 1), createdAt: new Date(base + i * 60_000) }));
  }
  return created;
}

describe('GET /api/payments: pagination, filters, search', () => {
  it('paginates newest first and reports totals', async () => {
    const created = await insertSeries(world.merchantA.id, 12);

    const page1 = await request(app).get('/api/payments?page=1&pageSize=5').set(bearer(world.merchantA.user)).expect(200);
    expect(page1.body).toMatchObject({ page: 1, pageSize: 5, total: 12, totalPages: 3 });
    expect(page1.body.items).toHaveLength(5);
    expect(page1.body.items[0].id).toBe(created[11]!.id);

    const page3 = await request(app).get('/api/payments?page=3&pageSize=5').set(bearer(world.merchantA.user)).expect(200);
    expect(page3.body.items.map((p: { id: string }) => p.id)).toEqual([created[1]!.id, created[0]!.id]);
  });

  it('defaults to page 1 with 10 per page, and returns an empty page past the end', async () => {
    await insertSeries(world.merchantA.id, 3);
    const res = await request(app).get('/api/payments').set(bearer(world.merchantA.user)).expect(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 10, total: 3, totalPages: 1 });

    const past = await request(app).get('/api/payments?page=9').set(bearer(world.merchantA.user)).expect(200);
    expect(past.body).toMatchObject({ items: [], total: 3 });
  });

  it('filters by status', async () => {
    await insertSeries(world.merchantA.id, 2, 'SUCCESS');
    await insertSeries(world.merchantA.id, 3, 'FAILED');
    const res = await request(app).get('/api/payments?status=FAILED').set(bearer(world.merchantA.user)).expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.items.every((p: { status: string }) => p.status === 'FAILED')).toBe(true);
  });

  it('searches by reference or provider payment id (case-insensitive, wildcards literal)', async () => {
    const target = await insertPayment(world.merchantA.id, { reference: 'PAY_FINDME_0001', providerPaymentId: 'prov_ABC_123' });
    await insertPayment(world.merchantA.id, { reference: 'PAY_OTHER_0002' });

    const byRef = await request(app).get('/api/payments?q=findme').set(bearer(world.merchantA.user)).expect(200);
    expect(byRef.body.items.map((p: { id: string }) => p.id)).toEqual([target.id]);

    const byProvider = await request(app).get('/api/payments?q=prov_abc').set(bearer(world.merchantA.user)).expect(200);
    expect(byProvider.body.items.map((p: { id: string }) => p.id)).toEqual([target.id]);

    // "%" must not act as a wildcard that matches everything.
    const wildcard = await request(app).get('/api/payments?q=%25').set(bearer(world.merchantA.user)).expect(200);
    expect(wildcard.body.total).toBe(0);
  });

  it('rejects invalid query parameters with 422', async () => {
    for (const qs of ['page=0', 'pageSize=101', 'pageSize=abc', 'status=REFUNDED', 'merchantId=not-a-uuid']) {
      const res = await request(app).get(`/api/payments?${qs}`).set(bearer(world.admin)).expect(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('GET /api/payments/summary', () => {
  it('returns counts and amounts per status, with zeros for missing statuses', async () => {
    await insertPayment(world.merchantA.id, { status: 'SUCCESS', amountPaise: 1_000 });
    await insertPayment(world.merchantA.id, { status: 'SUCCESS', amountPaise: 2_500 });
    await insertPayment(world.merchantA.id, { status: 'PENDING', amountPaise: 700 });

    const res = await request(app).get('/api/payments/summary').set(bearer(world.merchantA.user)).expect(200);
    expect(res.body).toEqual({
      totalCount: 3,
      totalAmountPaise: 4_200,
      byStatus: {
        PENDING: { count: 1, amountPaise: 700 },
        SUCCESS: { count: 2, amountPaise: 3_500 },
        FAILED: { count: 0, amountPaise: 0 },
      },
    });
  });
});

describe('GET /api/payments/:id', () => {
  it('returns the payment with its audit timeline and webhook events (no payload)', async () => {
    const created = await request(app)
      .post('/api/payments')
      .set(bearer(world.merchantA.user))
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise: 4_200 })
      .expect(201);
    const { id, reference } = created.body.payment;
    await pool.query(
      `INSERT INTO webhook_events (provider_event_id, payment_reference, payment_id, event_status, occurred_at, payload, outcome)
       VALUES ('evt_test_1', $1, $2, 'SUCCESS', now(), '{"note":"payload must not be returned"}', 'applied')`,
      [reference, id],
    );

    const res = await request(app).get(`/api/payments/${id}`).set(bearer(world.merchantA.user)).expect(200);
    expect(res.body.payment).toMatchObject({ id, reference, amountPaise: 4_200, status: 'PENDING' });
    expect(res.body.auditTimeline).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'PENDING', source: 'api' }),
    ]);
    expect(res.body.webhookEvents).toEqual([
      expect.objectContaining({ eventId: 'evt_test_1', status: 'SUCCESS', outcome: 'applied', duplicateDeliveries: 0 }),
    ]);
    expect(JSON.stringify(res.body)).not.toContain('payload must not be returned');
  });

  it('returns 404 for an unknown id and for a malformed id', async () => {
    await request(app).get(`/api/payments/${randomUUID()}`).set(bearer(world.merchantA.user)).expect(404);
    const res = await request(app).get('/api/payments/not-a-uuid').set(bearer(world.merchantA.user)).expect(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Payment not found' });
  });
});
