import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { signPayload } from '../src/lib/hmac.js';
import { createTestWorld, insertPayment, resetDb, type TestWorld } from './helpers/db.js';
import { countWebhookEvents, duplicateDeliveries, paymentState, sendWebhook, WEBHOOK_PATH, webhookEvent } from './helpers/webhooks.js';

const app = createApp();
let world: TestWorld;
let payment: { id: string; reference: string };

beforeEach(async () => {
  await resetDb();
  world = await createTestWorld();
  payment = await insertPayment(world.merchantA.id, { status: 'PENDING', amountPaise: 49_900 });
});

describe('signature verification', () => {
  it('test 1: a validly signed SUCCESS event -> 200, payment SUCCESS, exactly 1 ledger entry', async () => {
    const res = await sendWebhook(app, webhookEvent(payment.reference, 'SUCCESS', { providerPaymentId: 'prov_abc' })).expect(200);
    expect(res.body).toEqual({ received: true, applied: true, status: 'SUCCESS' });

    const state = await paymentState(payment.id);
    expect(state).toMatchObject({ status: 'SUCCESS', ledgerEntries: 1, successAuditRows: 1, needsReconciliation: false });
    const ledger = await pool.query('SELECT merchant_id, entry_type, amount_paise FROM ledger_entries WHERE payment_id = $1', [payment.id]);
    expect(ledger.rows).toEqual([{ merchant_id: world.merchantA.id, entry_type: 'CAPTURE', amount_paise: 49_900 }]);
    const stored = await pool.query('SELECT provider_payment_id FROM payments WHERE id = $1', [payment.id]);
    expect(stored.rows[0].provider_payment_id).toBe('prov_abc');
  });

  it('test 2: an invalid signature -> 401 INVALID_SIGNATURE and NO webhook_events row', async () => {
    const event = webhookEvent(payment.reference, 'SUCCESS');
    const res = await sendWebhook(app, event, { signature: signPayload(JSON.stringify(event), 'not-the-real-secret-0123456789abcdef') }).expect(401);
    expect(res.body).toEqual({ error: { code: 'INVALID_SIGNATURE', message: 'Missing or invalid webhook signature' } });
    expect(await countWebhookEvents()).toBe(0);
    expect((await paymentState(payment.id)).status).toBe('PENDING');
  });

  it('test 3: a missing signature -> 401, nothing stored', async () => {
    await sendWebhook(app, webhookEvent(payment.reference, 'SUCCESS'), { signature: null }).expect(401);
    expect(await countWebhookEvents()).toBe(0);
  });

  it('test 4: body altered after signing -> 401 (verification uses the raw bytes)', async () => {
    const original = JSON.stringify(webhookEvent(payment.reference, 'FAILED'));
    const signature = signPayload(original, config.PROVIDER_WEBHOOK_SECRET);
    const tampered = original.replace('"FAILED"', '"SUCCESS"');
    await sendWebhook(app, tampered, { signature }).expect(401);

    // Even a semantically identical body with different bytes (extra whitespace) fails: raw bytes are what count.
    await sendWebhook(app, original.replace(':', ': '), { signature }).expect(401);
    expect(await countWebhookEvents()).toBe(0);
  });

  it('rejects malformed signature headers (wrong length, non-hex) with 401 without throwing', async () => {
    for (const signature of ['abc', 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(128)]) {
      await sendWebhook(app, webhookEvent(payment.reference, 'SUCCESS'), { signature }).expect(401);
    }
    expect(await countWebhookEvents()).toBe(0);
  });

  it('validates the payload only after verifying it: signed but invalid -> 422, nothing stored', async () => {
    await sendWebhook(app, JSON.stringify({ eventId: 'evt_x', status: 'DONE' })).expect(422);
    await sendWebhook(app, '{not json').expect(422);
    expect(await countWebhookEvents()).toBe(0);
  });

  it('rejects non-JSON content types with 415', async () => {
    await request(app).post(WEBHOOK_PATH).set('Content-Type', 'text/plain').send('hello').expect(415);
  });

  it('returns 404 UNKNOWN_PAYMENT for an unknown reference and keeps the event (outcome unknown_payment)', async () => {
    const event = webhookEvent('PAY_DOES_NOT_EXIST', 'SUCCESS');
    const res = await sendWebhook(app, event).expect(404);
    expect(res.body.error.code).toBe('UNKNOWN_PAYMENT');
    const { rows } = await pool.query('SELECT outcome, payment_id FROM webhook_events WHERE provider_event_id = $1', [event.eventId]);
    expect(rows).toEqual([{ outcome: 'unknown_payment', payment_id: null }]);
  });
});

describe('duplicate and concurrent delivery (mandatory)', () => {
  it('test 5: the same SUCCESS event x5 sequentially -> status changes once, 1 ledger entry, 1 audit row, 4 duplicates', async () => {
    const event = webhookEvent(payment.reference, 'SUCCESS');
    const bodies = [];
    for (let i = 0; i < 5; i++) bodies.push((await sendWebhook(app, event).expect(200)).body);

    expect(bodies[0]).toEqual({ received: true, applied: true, status: 'SUCCESS' });
    expect(bodies.slice(1)).toEqual(Array(4).fill({ received: true, duplicate: true }));

    const state = await paymentState(payment.id);
    expect(state).toMatchObject({ status: 'SUCCESS', ledgerEntries: 1, successAuditRows: 1 });
    expect(state.webhookEvents).toEqual([{ eventId: event.eventId, outcome: 'applied' }]);
    // The 4 repeats are counted on the one stored event, for the dashboard; they moved no money.
    expect(await duplicateDeliveries(event.eventId)).toBe(4);

    // A bad-signature copy is rejected before the database and is not counted.
    await sendWebhook(app, event, { signature: 'f'.repeat(64) }).expect(401);
    expect(await duplicateDeliveries(event.eventId)).toBe(4);
    expect(await paymentState(payment.id)).toMatchObject({ ledgerEntries: 1 });
  });

  it('test 6: the same SUCCESS event x5 concurrently -> exactly one applied, 1 ledger entry, 1 audit row', async () => {
    const event = webhookEvent(payment.reference, 'SUCCESS');
    const responses = await Promise.all(Array.from({ length: 5 }, () => sendWebhook(app, event)));

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const applied = responses.filter((r) => r.body.applied === true);
    const notApplied = responses.filter((r) => r.body.applied !== true);
    expect(applied).toHaveLength(1);
    // The losers are rejected by guard #1 (duplicate); "stale" would also be acceptable, but never a second apply.
    for (const r of notApplied) expect(r.body.duplicate === true || r.body.reason === 'STALE_EVENT').toBe(true);

    const state = await paymentState(payment.id);
    expect(state).toMatchObject({ status: 'SUCCESS', ledgerEntries: 1, successAuditRows: 1 });
    expect(state.webhookEvents).toHaveLength(1);
    expect(await duplicateDeliveries(event.eventId)).toBe(4);
  }, 60_000);

  it('test 7: two DIFFERENT event ids, both SUCCESS, concurrently -> still exactly 1 ledger entry', async () => {
    const first = webhookEvent(payment.reference, 'SUCCESS');
    const second = webhookEvent(payment.reference, 'SUCCESS');
    const responses = await Promise.all([sendWebhook(app, first), sendWebhook(app, second)]);

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses.map((r) => r.body.applied).sort()).toEqual([false, true]);
    expect(responses.find((r) => r.body.applied === false)!.body.reason).toBe('STALE_EVENT');

    const state = await paymentState(payment.id);
    expect(state).toMatchObject({ status: 'SUCCESS', ledgerEntries: 1, successAuditRows: 1 });
    expect(state.webhookEvents.map((e) => e.outcome).sort()).toEqual(['applied', 'stale']);
  }, 60_000);

  it('a re-sent SUCCESS with a new event id after SUCCESS -> stale, no second ledger entry', async () => {
    await sendWebhook(app, webhookEvent(payment.reference, 'SUCCESS')).expect(200);
    const res = await sendWebhook(app, webhookEvent(payment.reference, 'SUCCESS')).expect(200);
    expect(res.body).toEqual({ received: true, applied: false, reason: 'STALE_EVENT' });
    expect(await paymentState(payment.id)).toMatchObject({ ledgerEntries: 1, successAuditRows: 1 });
  });
});

describe('out-of-order and contradictory events', () => {
  it('test 8: FAILED then SUCCESS -> 409, stays FAILED, no ledger entry, flagged for reconciliation', async () => {
    await sendWebhook(app, webhookEvent(payment.reference, 'FAILED')).expect(200);
    const success = webhookEvent(payment.reference, 'SUCCESS');
    const res = await sendWebhook(app, success).expect(409);
    expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    const state = await paymentState(payment.id);
    expect(state).toMatchObject({ status: 'FAILED', ledgerEntries: 0, successAuditRows: 0, failedAuditRows: 1, needsReconciliation: true });
    expect(state.webhookEvents.at(-1)).toEqual({ eventId: success.eventId, outcome: 'invalid_transition' });
  });

  it('SUCCESS then FAILED -> 409, stays SUCCESS with its single ledger entry', async () => {
    await sendWebhook(app, webhookEvent(payment.reference, 'SUCCESS')).expect(200);
    await sendWebhook(app, webhookEvent(payment.reference, 'FAILED')).expect(409);
    expect(await paymentState(payment.id)).toMatchObject({ status: 'SUCCESS', ledgerEntries: 1, needsReconciliation: true });
  });

  it('test 9: a late PENDING after SUCCESS -> 200 stale, status unchanged', async () => {
    await sendWebhook(app, webhookEvent(payment.reference, 'SUCCESS')).expect(200);
    const late = webhookEvent(payment.reference, 'PENDING', { occurredAt: new Date(Date.now() - 60_000).toISOString() });
    const res = await sendWebhook(app, late).expect(200);
    expect(res.body).toEqual({ received: true, applied: false, reason: 'STALE_EVENT' });

    const state = await paymentState(payment.id);
    expect(state).toMatchObject({ status: 'SUCCESS', ledgerEntries: 1, successAuditRows: 1 });
    expect(state.webhookEvents.at(-1)).toEqual({ eventId: late.eventId, outcome: 'stale' });
  });

  it('PENDING while already PENDING -> stale, nothing changes', async () => {
    const res = await sendWebhook(app, webhookEvent(payment.reference, 'PENDING')).expect(200);
    expect(res.body.reason).toBe('STALE_EVENT');
    expect(await paymentState(payment.id)).toMatchObject({ status: 'PENDING', ledgerEntries: 0 });
  });

  it('FAILED from PENDING -> applied, no ledger entry', async () => {
    const res = await sendWebhook(app, webhookEvent(payment.reference, 'FAILED')).expect(200);
    expect(res.body).toEqual({ received: true, applied: true, status: 'FAILED' });
    expect(await paymentState(payment.id)).toMatchObject({ status: 'FAILED', ledgerEntries: 0, failedAuditRows: 1 });
  });
});

describe('what is stored', () => {
  it('stores the parsed body but never the signature header', async () => {
    const event = webhookEvent(payment.reference, 'SUCCESS');
    const raw = JSON.stringify(event);
    const signature = signPayload(raw, config.PROVIDER_WEBHOOK_SECRET);
    await sendWebhook(app, raw, { signature }).expect(200);
    const { rows } = await pool.query('SELECT payload::text AS payload FROM webhook_events WHERE provider_event_id = $1', [event.eventId]);
    expect(JSON.parse(rows[0].payload)).toEqual(event);
    expect(rows[0].payload).not.toContain(signature);
  });
});
