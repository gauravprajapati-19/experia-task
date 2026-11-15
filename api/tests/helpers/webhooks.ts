import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { config } from '../../src/config.js';
import { pool } from '../../src/db/pool.js';
import { signPayload } from '../../src/lib/hmac.js';
import type { PaymentStatus } from '../../src/payments/types.js';
import type { WebhookEvent } from '../../src/webhooks/schema.js';

export const WEBHOOK_PATH = '/api/webhooks/payment-provider';

export function webhookEvent(paymentReference: string, status: PaymentStatus, overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    eventId: `evt_test_${randomUUID()}`,
    paymentReference,
    status,
    providerPaymentId: 'prov_test_1',
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Posts a webhook exactly as the provider would: the signature covers the raw bytes sent.
 * `signature: null` omits the header; a string overrides it.
 */
export function sendWebhook(app: Express, body: WebhookEvent | string, options: { signature?: string | null } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = request(app).post(WEBHOOK_PATH).set('Content-Type', 'application/json');
  const signature = options.signature === undefined ? signPayload(raw, config.PROVIDER_WEBHOOK_SECRET) : options.signature;
  if (signature !== null) req.set('X-Provider-Signature', signature);
  return req.send(raw);
}

export interface PaymentState {
  status: PaymentStatus;
  needsReconciliation: boolean;
  ledgerEntries: number;
  successAuditRows: number;
  failedAuditRows: number;
  webhookEvents: { eventId: string; outcome: string }[];
}

/** Reads the payment's financial state straight from the database (the source of truth for the guards). */
export async function paymentState(paymentId: string): Promise<PaymentState> {
  const [payment, ledger, audit, events] = await Promise.all([
    pool.query<{ status: PaymentStatus; needs_reconciliation: boolean }>(
      'SELECT status, needs_reconciliation FROM payments WHERE id = $1',
      [paymentId],
    ),
    pool.query<{ n: number }>('SELECT count(*)::int AS n FROM ledger_entries WHERE payment_id = $1', [paymentId]),
    pool.query<{ to_status: PaymentStatus; n: number }>(
      'SELECT to_status, count(*)::int AS n FROM payment_audit_log WHERE payment_id = $1 GROUP BY to_status',
      [paymentId],
    ),
    pool.query<{ eventId: string; outcome: string }>(
      'SELECT provider_event_id AS "eventId", outcome FROM webhook_events WHERE payment_id = $1 ORDER BY received_at, id',
      [paymentId],
    ),
  ]);
  const auditCount = (status: PaymentStatus) => audit.rows.find((r) => r.to_status === status)?.n ?? 0;
  return {
    status: payment.rows[0]!.status,
    needsReconciliation: payment.rows[0]!.needs_reconciliation,
    ledgerEntries: ledger.rows[0]!.n,
    successAuditRows: auditCount('SUCCESS'),
    failedAuditRows: auditCount('FAILED'),
    webhookEvents: events.rows,
  };
}

/** The repeat-delivery counter on one stored event (0 when it was only delivered once). */
export async function duplicateDeliveries(eventId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT duplicate_deliveries AS n FROM webhook_events WHERE provider_event_id = $1',
    [eventId],
  );
  return rows[0]!.n;
}

export async function countWebhookEvents(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM webhook_events');
  return rows[0]!.n;
}
