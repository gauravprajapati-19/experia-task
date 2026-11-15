import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createTestWorld, insertPayment, resetDb, type TestWorld } from './helpers/db.js';
import { paymentState } from './helpers/webhooks.js';

// A real HTTP server on a random port, so the provider's signed webhooks travel over the network
// back into the API exactly as they would in the demo.
let server: Server;
let baseUrl = '';
const app = createApp(undefined, { mockProvider: { webhookUrl: () => `${baseUrl}/api/webhooks/payment-provider` } });

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let world: TestWorld;
beforeEach(async () => {
  await resetDb();
  world = await createTestWorld();
});

describe('mock provider: register and read', () => {
  it('registers a payment idempotently by reference', async () => {
    const first = await request(app).post('/mock-provider/payments').send({ reference: 'PAY_MOCK_1', amountPaise: 1_000 }).expect(201);
    expect(first.body).toMatchObject({ reference: 'PAY_MOCK_1', amountPaise: 1_000, status: 'PENDING' });
    expect(first.body.providerPaymentId).toMatch(/^prov_/);

    const again = await request(app).post('/mock-provider/payments').send({ reference: 'PAY_MOCK_1', amountPaise: 1_000 }).expect(200);
    expect(again.body.providerPaymentId).toBe(first.body.providerPaymentId);

    await request(app).post('/mock-provider/payments').send({ reference: 'PAY_MOCK_1', amountPaise: 2_000 }).expect(409);
  });

  it('returns the provider status, or 404 when it has no record', async () => {
    await request(app).post('/mock-provider/payments').send({ reference: 'PAY_MOCK_2', amountPaise: 500 }).expect(201);
    const found = await request(app).get('/mock-provider/payments/PAY_MOCK_2').expect(200);
    expect(found.body.status).toBe('PENDING');
    await request(app).get('/mock-provider/payments/PAY_UNKNOWN').expect(404);
  });
});

describe('mock provider: simulated failures (deterministic)', () => {
  it('answers 503 when the error rate is 1', async () => {
    const failing = createApp(undefined, { mockProvider: { errorRate: 1 } });
    const res = await request(failing).post('/mock-provider/payments').send({ reference: 'PAY_X', amountPaise: 100 }).expect(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('holds the request open when the timeout rate is 1 (the client must give up)', async () => {
    const hanging = createApp(undefined, { mockProvider: { timeoutRate: 1, hangMs: 200 } });
    const started = Date.now();
    const res = await request(hanging).get('/mock-provider/payments/PAY_X').expect(504);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(res.body.error.code).toBe('PROVIDER_TIMEOUT');
  });

  it('applies the configured delay', async () => {
    const slow = createApp(undefined, { mockProvider: { delayMs: 150 } });
    const started = Date.now();
    await request(slow).get('/mock-provider/payments/PAY_X').expect(404);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});

describe('mock provider: settle fires signed webhooks', () => {
  async function registeredPayment() {
    const payment = await insertPayment(world.merchantA.id, { status: 'PENDING', amountPaise: 2_500 });
    await request(app).post('/mock-provider/payments').send({ reference: payment.reference, amountPaise: 2_500 }).expect(201);
    return payment;
  }

  it('settles SUCCESS and the signed webhook moves the payment to SUCCESS', async () => {
    const payment = await registeredPayment();
    const res = await request(app).post(`/mock-provider/payments/${payment.reference}/settle`).send({ status: 'SUCCESS' }).expect(200);
    expect(res.body.payment.status).toBe('SUCCESS');
    expect(res.body.webhook.deliveries).toEqual([{ status: 200, body: { received: true, applied: true, status: 'SUCCESS' } }]);
    expect(await paymentState(payment.id)).toMatchObject({ status: 'SUCCESS', ledgerEntries: 1, successAuditRows: 1 });
  });

  it('sends the same event 5 times concurrently and the money moves once', async () => {
    const payment = await registeredPayment();
    const res = await request(app)
      .post(`/mock-provider/payments/${payment.reference}/settle`)
      .send({ status: 'SUCCESS', duplicates: 5, concurrent: true })
      .expect(200);
    const deliveries = res.body.webhook.deliveries as { status: number; body: { applied?: boolean } }[];
    expect(deliveries).toHaveLength(5);
    expect(deliveries.filter((d) => d.body.applied === true)).toHaveLength(1);
    expect(await paymentState(payment.id)).toMatchObject({ status: 'SUCCESS', ledgerEntries: 1, successAuditRows: 1 });
  }, 60_000);

  it('can update only the provider side, without a webhook (used for lost-webhook scenarios)', async () => {
    const payment = await registeredPayment();
    const res = await request(app)
      .post(`/mock-provider/payments/${payment.reference}/settle`)
      .send({ status: 'SUCCESS', sendWebhook: false })
      .expect(200);
    expect(res.body.webhook).toBeNull();
    expect((await paymentState(payment.id)).status).toBe('PENDING');
  });

  it('returns 202 and delivers later when a delay is requested', async () => {
    const payment = await registeredPayment();
    const res = await request(app)
      .post(`/mock-provider/payments/${payment.reference}/settle`)
      .send({ status: 'FAILED', webhookDelayMs: 300 })
      .expect(202);
    expect(res.body.webhook.scheduledInMs).toBe(300);
    expect((await paymentState(payment.id)).status).toBe('PENDING');

    const deadline = Date.now() + 15_000;
    while ((await paymentState(payment.id)).status === 'PENDING' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(await paymentState(payment.id)).toMatchObject({ status: 'FAILED', ledgerEntries: 0 });
  }, 30_000);

  it('returns 404 when settling an unknown reference and 422 for an invalid status', async () => {
    await request(app).post('/mock-provider/payments/PAY_NOPE/settle').send({ status: 'SUCCESS' }).expect(404);
    const payment = await registeredPayment();
    await request(app).post(`/mock-provider/payments/${payment.reference}/settle`).send({ status: 'DONE' }).expect(422);
  });
});

describe('mock provider: disabled', () => {
  it('mounts none of its routes, including /control, when MOCK_PROVIDER_ENABLED=false', async () => {
    const disabled = createApp({ ...config, MOCK_PROVIDER_ENABLED: false });
    await request(disabled).get('/mock-provider/control').expect(404);
    await request(disabled).post('/mock-provider/control').send({ timeoutRate: 1 }).expect(404);
    await request(disabled).post('/mock-provider/payments').send({ reference: 'PAY_OFF', amountPaise: 100 }).expect(404);
  });
});
