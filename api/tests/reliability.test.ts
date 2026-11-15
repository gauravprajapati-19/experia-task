import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createProviderClient } from '../src/provider/providerClient.js';
import { findProviderPayment } from '../src/provider/mockProviderStore.js';
import { bearer } from './helpers/auth.js';
import { createTestWorld, resetDb, type TestWorld } from './helpers/db.js';
import { listen, type RunningServer } from './helpers/server.js';

// Payment creation against a REAL mock provider over HTTP, with its behaviour injected
// deterministically (rate 1 = always), so the provider client's real timeout path is exercised.

let healthy: RunningServer;
let hanging: RunningServer;
let failing: RunningServer;

beforeAll(async () => {
  healthy = await listen(createApp(undefined, { provider: null }));
  hanging = await listen(createApp(undefined, { provider: null, mockProvider: { timeoutRate: 1, hangMs: 10_000 } }));
  failing = await listen(createApp(undefined, { provider: null, mockProvider: { errorRate: 1 } }));
});

afterAll(async () => {
  await Promise.all([healthy.close(), hanging.close(), failing.close()]);
});

let world: TestWorld;
beforeEach(async () => {
  await resetDb();
  world = await createTestWorld();
});

function apiUsing(providerServer: RunningServer, sleeps: number[] = []) {
  const provider = createProviderClient({
    baseUrl: `${providerServer.url}/mock-provider`,
    timeoutMs: 300,
    random: () => 0.5,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return createApp(undefined, { provider });
}

function createPayment(app: ReturnType<typeof createApp>, amountPaise: number) {
  return request(app)
    .post('/api/payments')
    .set(bearer(world.merchantA.user))
    .set('Idempotency-Key', randomUUID())
    .send({ amountPaise });
}

async function dbState(paymentId: string) {
  const { rows } = await pool.query<{ status: string; ledger: number; audit: string[] }>(
    `SELECT p.status,
            (SELECT count(*)::int FROM ledger_entries l WHERE l.payment_id = p.id) AS ledger,
            (SELECT array_agg(coalesce(a.from_status, 'null') || '->' || a.to_status ORDER BY a.id)
               FROM payment_audit_log a WHERE a.payment_id = p.id) AS audit
     FROM payments p WHERE p.id = $1`,
    [paymentId],
  );
  return rows[0]!;
}

describe('payment creation with a real provider', () => {
  it('stores the provider payment id when the provider answers', async () => {
    const res = await createPayment(apiUsing(healthy), 12_000).expect(201);
    expect(res.body.payment).toMatchObject({ status: 'PENDING', needsReconciliation: false, lastProviderError: null });
    const provider = await findProviderPayment(res.body.payment.reference);
    expect(res.body.payment.providerPaymentId).toBe(provider!.providerPaymentId);
  });

  it('test 15: provider timeout on create -> 201, stays PENDING, needs_reconciliation = true, never FAILED', async () => {
    const sleeps: number[] = [];
    const started = Date.now();
    const res = await createPayment(apiUsing(hanging, sleeps), 75_000).expect(201);

    expect(res.body.payment).toMatchObject({
      status: 'PENDING',
      needsReconciliation: true,
      providerPaymentId: null,
      lastProviderError: 'timeout: no response within 300ms after 3 attempts',
    });
    expect(sleeps).toEqual([100, 200]); // retried twice with backoff + full jitter
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * 300);

    expect(await dbState(res.body.payment.id)).toEqual({ status: 'PENDING', ledger: 0, audit: ['null->PENDING'] });
    // The provider DID register it (only the response was lost): this is why a timeout means "unknown".
    expect((await findProviderPayment(res.body.payment.reference))?.status).toBe('PENDING');
  }, 30_000);

  it('provider errors (503) are retried, then the payment is flagged, not failed', async () => {
    const res = await createPayment(apiUsing(failing), 8_000).expect(201);
    expect(res.body.payment).toMatchObject({
      status: 'PENDING',
      needsReconciliation: true,
      lastProviderError: 'error: provider answered HTTP 503 after 3 attempts',
    });
  });

  it('an idempotent replay does not call the provider again', async () => {
    const app = apiUsing(healthy);
    const key = randomUUID();
    const send = () => request(app).post('/api/payments').set(bearer(world.merchantA.user)).set('Idempotency-Key', key).send({ amountPaise: 4_000 });
    const first = await send().expect(201);
    const replay = await send().expect(200);
    expect(replay.body.payment.id).toBe(first.body.payment.id);
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM mock_provider_payments');
    expect(rows[0]!.n).toBe(1);
  });
});
