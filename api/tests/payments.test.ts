import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import type { PaymentProvider } from '../src/provider/types.js';
import { bearer } from './helpers/auth.js';
import { createTestWorld, resetDb, type TestWorld } from './helpers/db.js';

const app = createApp(undefined, { provider: null }); // no provider registration: these tests cover our own API
let world: TestWorld;

beforeEach(async () => {
  await resetDb();
  world = await createTestWorld();
});

function createAs(user: TestWorld['admin'], body: unknown, idempotencyKey: string | null = randomUUID()) {
  const req = request(app).post('/api/payments').set(bearer(user));
  if (idempotencyKey !== null) req.set('Idempotency-Key', idempotencyKey);
  return req.send(body as object);
}

async function countPayments(merchantId: string, idempotencyKey: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM payments WHERE merchant_id = $1 AND idempotency_key = $2',
    [merchantId, idempotencyKey],
  );
  return rows[0]!.n;
}

describe('POST /api/payments: creation', () => {
  it('creates a PENDING payment with an audit row null -> PENDING (201)', async () => {
    const res = await createAs(world.merchantA.user, {
      amountPaise: 125_050,
      description: 'Order #1001',
      customerEmail: 'Buyer@Example.test',
    }).expect(201);

    expect(res.headers['idempotent-replayed']).toBeUndefined();
    expect(res.body.payment).toMatchObject({
      merchantId: world.merchantA.id,
      amountPaise: 125_050,
      currency: 'INR',
      status: 'PENDING',
      description: 'Order #1001',
      customerEmail: 'buyer@example.test',
      needsReconciliation: false,
    });
    expect(res.body.payment.reference).toMatch(/^PAY_[0-9A-Z]{26}$/);
    expect(res.body.payment).not.toHaveProperty('requestHash');
    expect(res.body.payment).not.toHaveProperty('idempotencyKey');

    const audit = await pool.query('SELECT from_status, to_status, source, actor FROM payment_audit_log WHERE payment_id = $1', [
      res.body.payment.id,
    ]);
    expect(audit.rows).toEqual([{ from_status: null, to_status: 'PENDING', source: 'api', actor: world.merchantA.user.id }]);
  });

  it('ignores a merchantId in the body: the payment belongs to the merchant in the JWT', async () => {
    const res = await createAs(world.merchantA.user, { amountPaise: 500, merchantId: world.merchantB.id }).expect(201);
    expect(res.body.payment.merchantId).toBe(world.merchantA.id);
  });

  it('forbids admins from creating payments (403)', async () => {
    const res = await createAs(world.admin, { amountPaise: 500 }).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requires authentication (401)', async () => {
    await request(app).post('/api/payments').set('Idempotency-Key', randomUUID()).send({ amountPaise: 500 }).expect(401);
  });
});

// Test 11, 12, 13
describe('POST /api/payments: idempotency', () => {
  it('test 11: same key + same body twice -> one row; the replay returns 200 with the original payment', async () => {
    const key = randomUUID();
    const body = { amountPaise: 10_000, description: 'Same order' };
    const first = await createAs(world.merchantA.user, body, key).expect(201);
    // Same content, different key order and explicit default currency: still the same request.
    const second = await createAs(world.merchantA.user, { currency: 'INR', description: 'Same order', amountPaise: 10_000 }, key).expect(200);

    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.payment.id).toBe(first.body.payment.id);
    expect(second.body.payment.reference).toBe(first.body.payment.reference);
    expect(await countPayments(world.merchantA.id, key)).toBe(1);

    const audit = await pool.query('SELECT 1 FROM payment_audit_log WHERE payment_id = $1', [first.body.payment.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('test 12: same key + different body -> 409 IDEMPOTENCY_KEY_REUSED, original unchanged', async () => {
    const key = randomUUID();
    await createAs(world.merchantA.user, { amountPaise: 10_000 }, key).expect(201);
    const res = await createAs(world.merchantA.user, { amountPaise: 20_000 }, key).expect(409);

    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const { rows } = await pool.query('SELECT amount_paise FROM payments WHERE idempotency_key = $1', [key]);
    expect(rows).toEqual([{ amount_paise: 10_000 }]);
  });

  it('test 13: same key sent 5 times concurrently -> exactly one row, one 201 and four replays', async () => {
    const key = randomUUID();
    const body = { amountPaise: 77_700 };
    const responses = await Promise.all(Array.from({ length: 5 }, () => createAs(world.merchantA.user, body, key)));

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(responses.map((r) => r.body.payment.id)).size).toBe(1);
    expect(await countPayments(world.merchantA.id, key)).toBe(1);

    const audit = await pool.query('SELECT 1 FROM payment_audit_log WHERE payment_id = $1', [responses[0]!.body.payment.id]);
    expect(audit.rowCount).toBe(1);
  });

  it('scopes keys per merchant: two merchants may use the same key independently', async () => {
    const key = randomUUID();
    const a = await createAs(world.merchantA.user, { amountPaise: 100 }, key).expect(201);
    const b = await createAs(world.merchantB.user, { amountPaise: 999 }, key).expect(201);
    expect(a.body.payment.id).not.toBe(b.body.payment.id);
  });
});

// Test 14
describe('POST /api/payments: validation', () => {
  it.each([
    ['negative', { amountPaise: -100 }],
    ['zero', { amountPaise: 0 }],
    ['decimal', { amountPaise: 100.5 }],
    ['missing', {}],
    ['a numeric string', { amountPaise: '100' }],
    ['above the ₹1 crore cap', { amountPaise: 1_000_000_001 }],
    ['beyond the safe-integer range', { amountPaise: 2 ** 53 }],
  ])('test 14: rejects a %s amount with 422', async (_label, body) => {
    const res = await createAs(world.merchantA.user, body).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'amountPaise' })]));
  });

  it('rejects a non-INR currency, a long description and a bad email with 422', async () => {
    for (const body of [
      { amountPaise: 100, currency: 'USD' },
      { amountPaise: 100, description: 'x'.repeat(141) },
      { amountPaise: 100, customerEmail: 'not-an-email' },
    ]) {
      await createAs(world.merchantA.user, body).expect(422);
    }
  });

  it('accepts the cap exactly (₹1 crore)', async () => {
    await createAs(world.merchantA.user, { amountPaise: 1_000_000_000 }).expect(201);
  });

  it('test 14: a missing Idempotency-Key -> 400, and nothing is stored', async () => {
    const res = await createAs(world.merchantA.user, { amountPaise: 100 }, null).expect(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM payments');
    expect(rows[0]!.n).toBe(0);
  });

  it('rejects an Idempotency-Key that is too short or contains spaces with 400', async () => {
    for (const key of ['short', 'has spaces in it', 'k'.repeat(129)]) {
      const res = await createAs(world.merchantA.user, { amountPaise: 100 }, key).expect(400);
      expect(res.body.error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    }
  });
});

describe('POST /api/payments: provider registration', () => {
  it('stores the provider payment id when registration succeeds', async () => {
    const provider: PaymentProvider = {
      registerPayment: ({ reference }) => Promise.resolve({ kind: 'ok', value: { providerPaymentId: `prov_${reference}` } }),
    };
    const res = await request(createApp(undefined, { provider }))
      .post('/api/payments')
      .set(bearer(world.merchantA.user))
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise: 5_000 })
      .expect(201);
    expect(res.body.payment.providerPaymentId).toBe(`prov_${res.body.payment.reference}`);
    expect(res.body.payment.needsReconciliation).toBe(false);
  });

  it('keeps the payment PENDING and flags it for reconciliation when the provider times out', async () => {
    const provider: PaymentProvider = {
      registerPayment: () => Promise.resolve({ kind: 'timeout', message: 'no response within 3000ms' }),
    };
    const res = await request(createApp(undefined, { provider }))
      .post('/api/payments')
      .set(bearer(world.merchantA.user))
      .set('Idempotency-Key', randomUUID())
      .send({ amountPaise: 5_000 })
      .expect(201);
    expect(res.body.payment).toMatchObject({
      status: 'PENDING',
      needsReconciliation: true,
      lastProviderError: 'timeout: no response within 3000ms',
      providerPaymentId: null,
    });
  });
});
